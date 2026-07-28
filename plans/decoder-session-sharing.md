# Decoder session sharing — one decode per source, many consumers

## The problem

A Flarex comp can read the same file through two doors: the host clip's `MediaIn` (empty
`sourceAssetId` → the host timeline layer) and a pool-asset `MediaIn` pointing at that same file.
Confirmed live on 2026-07-28: asset `65ff9c00` decoded twice, `wc-hw` for the host and `wc-sw` for
node `n_mrzuss81_mszw`, and those two were the ONLY stale sources in the comp (427ms / 394ms) while
the two sources that owned their asset sat at staleness 0.

Both nodes read at `Source In Seconds 0.0` with `Freeze: Off` — identical file, identical timestamp,
identical pixels. It is not two reads; it is one read decoded twice.

The cost is a whole session out of `MAX_WC_TOTAL_SESSIONS = 4`. Nothing registers as a cap miss
(`capMisses: 0`) because four consumers fit exactly — there is simply no headroom left, and one of
the four slots is pure duplication.

This must be fixed in the engine, not in user education. A person editing a video should not have to
know that pointing two nodes at one file costs two hardware decoders.

## Why the obvious version does not work

`preview-frame-pool.ts:310-317` is explicit that a provider match is `(url, software)`, not `url`:

> The host is lag-intolerant by design, so a software decode of a full-res source pushed it past
> `WC_HOLD_LAG_S` → freeze-hold → sustained-hold bail → `wcBailedSources` → native `<video>` for the
> rest of the session: the host frozen while the loaders played (2026-07-27).

A URL-keyed share therefore refuses exactly the case above (host `wc-hw` + loader `wc-sw`), and
delivers nothing. Sharing has to cross the mode boundary to be worth building.

**Crossing it is safe in one direction only, and the asymmetry is the whole design.** The 2026-07-27
rule exists because N sessions contend for one hardware block. A single SHARED session is not
contention — it is one decode feeding two consumers. So:

- Attaching to a **hardware** session is allowed for any consumer. The loader gets hardware-quality
  frames; the host keeps the hardware session it needs; total sessions drop by one.
- Attaching to a **software** session is allowed **only** for a consumer that asked for software.
  This preserves the host's guarantee byte-for-byte: a lag-intolerant consumer can never be handed a
  software decode it did not ask for. That is the 2026-07-27 bug, and it stays fixed.

Ordering caveat, accepted: if a software loader mounts FIRST and a hardware consumer arrives second,
the second cannot attach and creates its own session — the status quo, no regression. In practice
the host mounts first. Not worth an upgrade path in v1.

## Frame ownership — the constraint that shapes everything

`FrameProvider.getFrame` documents its result as *"Provider-owned; valid until the next call/dispose."*
With two consumers on one provider, consumer B's call would invalidate the frame consumer A is still
holding. Silently. That is the failure mode that would make this change look fine and corrupt
playback intermittently.

What makes it tractable: consumers already clone. `WebglMediaLayer.setWcHeldFrame`
(`WebglMediaLayer.tsx:506-518`) holds *"a clone WE own (refcounted handle, no pixel copy)"* and closes
that clone on replace/teardown — it never closes the provider's frame.

So the fix is to reproduce the existing contract **per consumer** rather than per provider: each
attached lease gets a thin wrapper owning exactly one outstanding clone, closed when the next call
supersedes it and on release. Every consumer then sees precisely the semantics it sees today —
"provider-owned, valid until my next call" — and no consumer can invalidate another's frame.

Clone only what is consumable: `VideoFrame` → `.clone()`. An `ImageBitmap`/element/canvas source from
a fallback provider is not consumed by drawing and passes through untouched.

## Divergence — the way this makes things worse if unguarded

The premise is that both consumers want the same timestamp. If they diverge — different
`Source In Seconds`, `Freeze` on one, a speed ramp — a single seek-on-demand decoder would be dragged
back and forth every frame. Two decoders thrash far less than one decoder serving two playheads.
A shared session must therefore be able to give up.

Track per-lease requested time on the shared session. When two attached leases request times more
than the divergence tolerance apart for `SHARE_DIVERGENCE_STRIKES` consecutive frames, detach the
LATER-joined lease: it releases its attachment and re-acquires its own session (falling back to
`<video>` if the pool is full — the same path it takes today when refused). Hysteresis via strikes,
not a single sample, so one stray frame during a seek cannot split a healthy share.

**The tolerance is measured in FRAMES, not milliseconds.** A fixed 100ms means ~2.4 frames at 24fps
and ~12 at 120fps — the same number would be strict on one source and meaningless on another, and the
question being asked ("are these two consumers on the same picture?") is inherently a frame-count
question. Derive it from the provider's `nominalFps`:

```ts
divergenceToleranceSeconds(nominalFps) = SHARE_DIVERGENCE_FRAMES / (nominalFps || 30)
```

with `SHARE_DIVERGENCE_FRAMES = 2` (one frame of legitimate quantization skew, plus one of slack).
The `|| 30` fallback covers providers that cannot report a rate — the same defensive default the
coherence gate uses. This mirrors the reasoning that made `PROXY_KEYFRAME_EVERY_N_FRAMES` a frame
count after 1-second GOPs froze 60fps proxies: cadence-relative quantities must be expressed in
frames or they silently mean different things per source.

## Implementation

All in `apps/web/src/playback/preview-frame-pool.ts` unless noted.

### 0. Invariant, stated once and relied on everywhere

> **Exactly one `SharedSession` owns a `FrameProvider`. Every lease merely leases access.**

Disposal, session accounting (`bumpActive`), parking and preemption are the owner's business alone.
A lease may close only the clones it made. Every rule below is a consequence of this one.

### 1. Shared session registry

```ts
interface SharedSession {
  /**
   * DECODER IDENTITY — not merely a URL.
   *
   * Today a decoder is fully described by its URL, so the key IS the url. It is named `key` rather
   * than `url` because that equivalence is a property of today's `createFrameProvider` options, not
   * a law: the moment a consumer can ask for a different colour space, alpha mode, bit depth or
   * rotation handling, two consumers of one URL stop being interchangeable and this key must grow to
   * include those. Sharing incompatible sessions would be silent and would look like a cache hit.
   */
  key: string;
  software: boolean;          // what the session ACTUALLY is, not what anyone asked for
  provider: FrameProvider;    // the serialized provider (existing wrapper)
  refCount: number;
  members: Set<SharedMember>; // per-lease requested-time tracking, for divergence
  /**
   * DUPLICATE-CALL ELIMINATOR — NOT a frame cache. Exactly one entry, deliberately.
   *
   * Its only job is to collapse two consumers asking for the SAME timestamp in the same frame into
   * one decode. It is not a seek cache and must never grow into one: every retained entry pins a
   * `VideoFrame`, which is a hard-limited resource, and a decoder starved of frame slots stalls
   * outright. If a future change wants real caching, that is a different mechanism with a different
   * budget — not this field with a bigger number.
   */
  lastServed: { time: number; frame: CanvasImageSource | null } | null;
}
```

Keyed by decoder identity (see above). Only sessions with a live provider are attachable (a session
still initializing is not — the second acquirer waits on the same `ready` promise instead, see 3).

### 2. Attach predicate (PURE, exported, tested)

```ts
export function canAttachToSession(sessionSoftware: boolean, wantSoftware: boolean): boolean {
  return sessionSoftware === false || wantSoftware === true;
}
```

Hardware sessions accept anyone; software sessions accept only software-preferring consumers. This
one function is the entire 2026-07-27 guarantee, which is why it is pure and directly asserted rather
than buried in `acquire`.

### 3. `acquirePreviewFrameProvider` — attach before reserving

Order becomes: **warm idle reuse → attach to live shared session → reserve a new session**. Attach
sits second because a warm park is already a paid-for session with no sharing complexity; only when
there is no park do we prefer sharing a live one over spending a new slot.

On attach: `refCount += 1`, no `reserveSession`, no `bumpActive` — the session is already counted.
Return a lease whose `ready` resolves to a per-consumer wrapper (4). Bump a new `shared` counter in
`__rfWcPool`.

If the session is still initializing, the new acquirer chains the same `ready` promise. This is the
common case — two layers mounting in the same tick — and without it the dedupe would miss the exact
scenario it exists for.

### 4. Per-consumer wrapper

Wraps the shared provider:

- `getFrame(t)`: if the session's `lastServed.time` matches `t` within half a frame period
  (`nominalFps`), reuse the canonical frame with no decode. Otherwise call through the shared
  serialized provider and update `lastServed`. Either way, clone for this consumer, close this
  consumer's previous clone, return the clone.
- Forwards `width`/`height`/`lastFrameLagSeconds`/`nominalFps`/`decodableEndSeconds` — the file already
  warns twice that a wrapper dropping a field is a silent, expensive bug (`lastFrameLagSeconds` made
  the catch-up hold never engage; `nominalFps` would make every source read stale).
- `dispose()`: closes this consumer's outstanding clone and detaches; it must NOT dispose the shared
  provider unless it is the last reference.

The memo is what turns "two decodes" into one: with both consumers on the same timestamp, the second
call is a clone of an already-decoded frame.

### 5. Release / preempt

- `release()`: `refCount -= 1`. At zero, the existing behaviour runs unchanged — `bumpActive(-1)`,
  `parkOrDispose`. Above zero, only this consumer's clone is closed.
- `preempt()`: a shared session's preemption must fire `onPreempted` for **every** attached lease and
  free the session once. A preemption that notified only one member would leave the others holding a
  disposed decoder — the "renderer died and loaders could never re-acquire" class of failure.

  **Ordering is part of the contract: every callback fires BEFORE the shared provider is disposed.**
  Notify-then-dispose, never dispose-then-notify. A member reacting to `onPreempted` synchronously
  (switching to `<video>`, clearing a held frame) must never be able to observe a half-torn session,
  and disposing first would make that ordering an accident of implementation rather than a rule.
- Divergence detach (see above) reuses the release path for the detaching member only.

### 6. Telemetry

`__rfWcPool` gains:

| field | meaning |
|---|---|
| `shared` | attaches to an existing session |
| `sharedActive` | sessions currently at `refCount > 1` |
| `shareDetaches` | divergence splits |
| `sharedFramesServed` | `getFrame` calls served through a shared session |
| `sharedFrameHits` | of those, served from `lastServed` with no decode |

The first three say sharing *exists*; only the last two say whether it *saves work*.
`sharedFrameHits / sharedFramesServed` is the real effectiveness number — a share whose members never
land on the same timestamp is a share that costs bookkeeping and returns nothing, and it would be
indistinguishable from a healthy one without this ratio. Same lesson as the mode-mismatched warm reuse
that "looks like a perfectly healthy cache HIT" (`findWarmIdleIndex` doc).

`__rfSourceMap` should show both consumers of a shared session on the same decode mode. That is the
user-visible confirmation: today it reads `wc-hw` + `wc-sw`, after this it should read `wc-hw` twice.

## Verification

1. **`wcpool:test` extended** — pure units: `canAttachToSession` in all four combinations (the
   software→hardware refusal is the load-bearing one); the divergence predicate including hysteresis
   and its fps scaling (2 frames means 83ms at 24fps and 17ms at 120fps); refcount release ordering.
2. **The initialization race gets its own test.** Two acquisitions in the same tick, before any
   provider exists, is the likeliest place for duplicate sessions to creep back in — and it is also
   the single most common real scenario, two layers mounting together:

   ```ts
   const [a, b] = [acquire(url), acquire(url)];
   await Promise.all([a.ready, b.ready]);
   ```

   Assert: exactly ONE provider created, `refCount === 2`, exactly ONE session reserved. A regression
   here would still pass every "does sharing work" test that only exercises sequential acquisition.
3. **A share must actually happen.** Per the standing rule that "a reuse mechanism must assert that it
   actually reuses", assert `shared > 0` in the fixture — a dedupe that never triggers is trivially
   correct and worthless. `sharedFrameHits > 0` too: sharing that never collapses a duplicate call is
   bookkeeping with no payoff.
4. **Regression: the host must never inherit software.** Mount a software loader first, then the host,
   and assert the host got its own hardware session (`canAttachToSession(true, false) === false`).
   This is the 2026-07-27 bug and it gets an explicit test, not just a code comment.
5. **`pnpm typecheck`** across packages.
6. **Manual, the real check** — the user's comp: `console.table(__rfSourceMap)` should show the two
   `forest` rows on one mode with `staleMs 0`, and `__rfWcPool.sharedActive` ≥ 1.
7. **Divergence** — set `Source In Seconds` differently on the two nodes and confirm the share splits
   (`shareDetaches` ≥ 1) instead of thrashing.

## Risk

This is the file that already killed the renderer once (raising concurrency 3 → 7). Mitigations:

- Sharing only ever LOWERS the session count; it cannot raise concurrency. The caps are untouched.
- Fully behind a flag — `?wcShare=0` disables and restores today's behaviour exactly, matching the
  `wcDecode` kill-switch convention.
- No change to `packages/shared`, so export/worker output stays byte-identical.
- `preview-frame-pool.ts` is not in `RENDER_FINGERPRINT_SOURCES`, so no cached proxy is invalidated.

## Out of scope

- Upgrading an existing software session to hardware when a host arrives later.
- Sharing across the export path (its providers are created without a frame budget and block until
  decoded — different contract, no benefit).
- Comp proxies (`useFlarexCompProxies`), which already collapse N decoders into 1 by a different
  mechanism.
