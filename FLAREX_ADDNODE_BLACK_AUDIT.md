# Flarex — "adding a node blacks the viewer / MediaIn shows the host" audit

**2026-08-05 · audit only, no product code changed.** Every claim below is a browser measurement on the
running dev server (Chrome channel, real editor reached through the product's own flow), not a read of
the code. Probe scripts and screenshots are listed at the end.

There are **two independent defects**. They present together and look like one bug.

---

## Defect 1 — a node thumbnail is cached under a key that cannot see whether the picture had arrived

**Status: root-caused, reproduced, and falsified-then-confirmed by a controlled perturbation.**

### What you see

A MediaIn bound to `blast.mp4` draws the **host clip's** picture in its node body. Nodes downstream of
it draw **black**. Neither ever corrects itself, no matter how long you wait.

### The mechanism

`flarex-node-thumbnails.ts` keys its cache on the node's ADR-009 content hash **alone**:

- [flarex-node-thumbnails.ts:139-143](apps/web/src/editor/flarex/flarex-node-thumbnails.ts#L139-L143) — `if (existing && existing.hash === hash) continue;`
- [flarex-node-thumbnails.ts:169](apps/web/src/editor/flarex/flarex-node-thumbnails.ts#L169) — `cache.set(key, { hash, canvas, usedAt: ++clock })`

ADR-009 defines `CacheKey = (ContractVersion, ContextVersion, NodeContentHash)`, and
[content-hash.ts:11-14](packages/shared/src/flarex/content-hash.ts#L11-L14) says so in its own docstring:
the hash *"does NOT read render resolution, frame time, or any environment value — those are the
CONTEXT axis, a SEPARATE component of the cache key … owned by the cache layer"*.

**The thumbnail cache is that cache layer, and it never supplies the context term.** Media readiness —
whether the node's virtual loader exists yet, whether it has decoded — lives entirely on that missing
axis. So the *first* render of a node wins permanently.

That first render happens milliseconds after you create or bind the node, on the next idle callback,
which is reliably **before** `collectFlarexVirtualLayers` has produced a loader for it and long before
that loader decodes. At that instant the compiler does exactly what it is designed to do and
soft-degrades to the host clip
([compile-flarex.ts:1355-1359](packages/shared/src/flarex/compile-flarex.ts#L1355-L1359), reason
`host-substituted:no-loader`). The host frame is then cached under that node's content hash forever.
A node whose inputs produced *nothing* at that instant caches an opaque-black frame the same way.

Nothing invalidates it afterwards, because nothing that changes is in the key. The only escapes are a
param/wiring edit on the node or an upstream one, an *animated* param sampled at a new time (a static
node hashes identically at every playhead position — deliberate, see the module docstring), or
`clearFlarexThumbnails()` at [FlarexNodeCanvas.tsx:321-323](apps/web/src/editor/flarex/FlarexNodeCanvas.tsx#L321-L323),
which fires only on comp change / canvas mount.

### The measurement

Fixture: host clip = talking-heads mp4; bin clip = `beach.mp4` (visually unmistakable); one MediaIn
bound to the beach clip; 12 s settle.

| | node 03 thumbnail |
|---|---|
| **A** — 12 s after binding to `beach.mp4` | **the host clip** (`tmp/thumb-cache/A-after-bind.png`) |
| **B** — after bumping one param (`Source In` 0 → 3) and nothing else | **the beach clip** (`tmp/thumb-cache/B-after-param-bump.png`) |

The param bump changes the node's content hash and nothing else in the world. The picture was never
wrong — it was a cached render from before the loader had decoded.

### Workarounds available today

Nudge any param on the node, or leave the Flarex page and come back (the canvas remount clears the
cache).

---

## Defect 2 — with the view dot on a loader-backed node, adding a node presents a black frame that sticks

**Status: reproduced deterministically and narrowed to three necessary conditions. The last mechanical
link is not closed — see "what is still open".**

### The conditions (each measured, not assumed)

| fixture | add Merge → viewer |
|---|---|
| plain comp (`MediaIn → MediaOut`, host only), no view dot | **never blanks** — 0/4 (`tmp/merge-plain`) |
| asset-source MediaIn present, no view dot | **never blanks** (`black-graphdump` step B) |
| view dot set on the asset-source MediaIn | **blanks 3/3** with thumbnails off, 2/3 with them on |

`Blur`, `Transform` and `Glow` did not blank this fixture; `Merge` did, every time the view dot was set.

### What the black is, and is not

- **It is not composited by a healthy path.** A forced recomposite (one-frame seek) cleared it **5/5**.
  It is the last frame *presented*, after which the settle window closes and nothing repaints — so it
  survives indefinitely at rest, which is why it reads as "the viewer is broken" rather than "one
  frame flickered".
- **It is not the node-thumbnail render leaking into the viewer.** With `Thumbs` toggled **off** it
  reproduced 3/3 — more often, not less.
- **It is not a canvas resize clearing the drawing buffer** (the documented hazard at
  [scene-compositor.ts:3196-3201](packages/shared/src/color/scene-compositor.ts#L3196-L3201)). The
  canvas measured 1080×1920 identically before and after.
- **It is not a change to the graph the compiler reads.** Dumped from persisted project state either
  side of the blank: the added Merge is **fully disconnected**, the edge list is byte-identical
  (`hostMediaIn:out -> mediaOut:in`, one edge), and `previewNodeId` is the same beach MediaIn in both.
  The only difference is `comp.version` **6 → 7**.

### The coupling that makes an unreachable node matter

`comp.version` is not inert. It is the cache key of the Flarex source-draw cache:

- [build-scene-draws.ts:898](packages/shared/src/scene/build-scene-draws.ts#L898) — `cachedPreFlarexDraw(virtual, dims, comp.version ?? 0) ?? "pending"`
- [build-scene-draws.ts:980](packages/shared/src/scene/build-scene-draws.ts#L980) — `FlarexSourceDrawCache.key(virtual.id, compVersion, rScale)`

So **any** node added anywhere in the comp invalidates the cached draw of **every** asset-source
MediaIn for that frame, and a miss that rebuilds to `null` is reported to the compiler as `"pending"`.
When the compile is re-rooted at that MediaIn by the view dot, that node's output *is* the whole frame,
so a single unlucky frame is a fully blank one — and because the viewer is paused, that blank frame is
the one left on screen.

This is the same class as the `host-substituted:pending` / `source-pending-retimed` split the compiler
already documents at [compile-flarex.ts:1320-1352](packages/shared/src/flarex/compile-flarex.ts#L1320-L1352):
an editing action is invalidating a *readiness* cache, and readiness has no business being keyed on a
graph version.

### What is still open

Which branch actually produced the invisible frame. `"pending"` at an un-retimed time is documented to
fall **through** to the host draw, which would have shown the host clip (measured luma ≈ 109), not black
(measured 8.08). So either something upstream of that returned an invisible image, or the present was
skipped after the accumulator had already been cleared. Two specific places to instrument next:

1. `applyFlarex`'s return with the preview root set — log what `compileFlarexComp` returned on the
   blank frame (image / null / the opacity-0 unwired-MediaOut clone at
   [compile-flarex.ts:1817-1821](packages/shared/src/flarex/compile-flarex.ts#L1817-L1821)).
2. The readiness hold in `drawFrameImpl` ([ScenePreviewCanvas.tsx:1519-1523](apps/web/src/components/ScenePreviewCanvas.tsx#L1519-L1523)),
   which "holds the previous canvas contents (skip presenting)" — confirm whether the frame that
   *was* presented came from a compile or from a hold over an already-cleared buffer.

Counters read at the blank were unhelpful and are worth noting so nobody re-reads them: `settleSwaps`
was 2 before and after (no new swap recorded for the black frame), `__rfFrameStats` was all zeros
(paused), and `__rfLiveFreeze` was unchanged.

---

## What is NOT broken

The live viewer, the lowering compiler, and the virtual-loader path are correct for asset-source
MediaIn. With the view dot on the beach-bound MediaIn the viewer renders **the beach clip at full
fidelity** while that same node's cached thumbnail still shows the host — two renders of one node
disagreeing, which is what isolates Defect 1 to the cache rather than to the compiler
(`tmp/viewdot/viewdot.png`). `__rfSourceMap` confirmed the virtual loader decoding `wc-hw`, `state: ok`,
`staleMs: 0`.

The only `__rfFlarexDegradation` reason seen throughout was `host-substituted:no-loader` on the **host**
MediaIn (empty `sourceAssetId`), which is the documented and correct Phase-1 behaviour, not a fault.

---

## Reproduction assets

All throwaway, all under `apps/worker/tmp/` (untracked). Run from `apps/worker` with
`PIXEL_BROWSER_CHANNEL=chrome npx tsx <file>` against a running dev server.

| script | what it establishes |
|---|---|
| `flarex-thumb-cache-probe.ts` | Defect 1 — host thumbnail before a param bump, own picture after (`tmp/thumb-cache/`) |
| `flarex-viewdot-probe.ts` | the viewer is correct while the thumbnail is not (`tmp/viewdot/`) |
| `flarex-black-race.ts` | Defect 2 — blank rate and "cleared by a forced recomposite" (`PROBE_THUMBS=0` for the thumbnails-off arm) |
| `flarex-merge-plain.ts` | Merge alone does not blank a plain comp |
| `flarex-black-graphdump.ts` | the graph either side of the blank — disconnected node, same edges, same `previewNodeId`, `comp.version` +1 |
| `flarex-mediain-repro.ts` | loader health (`__rfSourceMap`, `__rfFlarexDegradation`) |

`PIXEL_BROWSER_CHANNEL=chrome` is required — without it Playwright runs SwiftShader at ~8 fps and none
of the timing-sensitive arms reproduce.

---

## Addendum 2026-08-05 — supervisor questions A/B, measured

Three arms, one fixture (host = talking-heads mp4, second asset = `beach.mp4`), all run with
`?kernelDiagnostics=1` so `admissionDenials` is not structurally zero. Probe:
`apps/worker/tmp/flarex-supervisor-abc.ts`.

| | beach loader `__rfSourceMap` | pool `active` | `wcMode` |
|---|---|---|---|
| **T0** — host only, Flarex never opened | *(absent)* | 1 | host `wc-hw` |
| **Arm 1** — flarex loader, default routing | `decode: wc-sw`, `state: AWAITING`, `why: NO_LEASE`, `wcProvider: false`, `served: null` | **1** | host `wc-hw`, loader `wc-sw` |
| **Arm 2** — same graph, `?flarexSwDecode=0` | `decode: wc-hw`, `state: ok`, `why: null`, `wcProvider: true` | **2** | both `wc-hw` |

`capMisses: 0`, `admissionDenials: 0`, `admissionPreemptions: 0`, borrow ledger `grants: [] refusals: []
misses: 0 blindSplits: 0` — in **every** arm, diagnostics on.

**The routing is the discriminator, not the init.** The same second source, in the same comp, on the
same pool, acquires a session and reaches `state: ok` the moment `preferSoftwareDecode` is forced off.
The predicate is policy-as-identity, verbatim ADR-013 finding (1):

```
// VideoPreview.tsx:3625-3627
preferSoftwareDecode={
  (flarexSwDecodeOverride() ?? true) && isFlarexVirtualLayerId(layer.id) && flarexLoaderRate(layer) <= 1
}
```

Two consequences for the proposed `WebglMediaLayer.tsx` net:

1. It would rescue from a **routing decision**, not from a decoder that cannot initialise. The
   hardware path serves this source correctly today.
2. `?flarexSwDecode=0/1` is already in the tree as the *measurement escape hatch for exactly this
   keep-or-revert decision*, pending since 2026-07-28 and carried by the tracker as "kept, unproven".
   This is the A/B it was built for.

**Mount/cleanup churn is not the discriminating cause.** Provider `created` climbs 2 → 6 across arm 1
while `active` stays 1, so the churn is real — but it is present in **both** arms and only arm 1 fails.
A cause common to the passing arm cannot be the cause of the failure.

**Discrepancy to resolve before anyone edits `WebglMediaLayer.tsx`.** The other session reports "granted
a lease — session count goes 1→2", with the granted lease then suppressing the element fallback. This
fixture measured the opposite: `active` stayed at **1** and the loader reported `why: NO_LEASE`. Same
symptom, incompatible mechanism. One of the two fixtures is not measuring what its write-up says.

**Not measured (declared, not implied).** Arm 3 (plain two-clip timeline, no Flarex) is **VOID** — the
`Add video only` affordance was found and clicked but the clip count stayed at 1, so no second timeline
clip existed. No production-build arm was run; every number here is from the Vite dev server, and this
repo has voided a full measurement round on exactly that before (2026-07-28, `react-dom.development`).

---

## The event trace (`?flarexTrace=1`)

Added `apps/web/src/playback/flarex-trace.ts` plus four call sites (FlarexWorkspace comp write,
VideoPreview loader set + transport, ScenePreviewCanvas per-node degradation). Off by default; the
disabled cost is one boolean read and no timer is created. Console: `__rfFlarexTrace.dump()`.

A verified run - create comp, bind an asset MediaIn, add a Merge, play 6s - is 32 events:

```
      0ms  loaders   set        []                                    <- bare comp: NO loaders exist
  16387ms  node      ..._in     host-substituted:no-loader            <- MediaIn resolves to the HOST draw
  20046ms  comp      v3 nodes:3 types "mediaIn,mediaOut,mediaIn"      <- the asset MediaIn is added
  22538ms  loaders   set        ["n_..:video:asset_local_.."]         <- FIRST loader ever created
  22736ms  route     pool  native:true
  22911ms  source    ..:n_msfksifo_9pns   wc-sw AWAITING NO_LEASE wcProvider:false
  23200ms  pool      created:4 active:1                               <- host holds the only session
  32784ms  comp      v5 nodes:4 types "..,merge"
  36118ms  transport PLAY
  ...      source    project_.._media_1   wc-hw ok  served advancing  <- host decodes fine throughout
```

Which answers the mechanical question directly:

**Why MediaIn -> MediaOut works.** It does no decoding. `createFlarexComp` makes a MediaIn with an
empty `sourceAssetId`, so `collectFlarexVirtualLayers` builds no loader for it (`loaders set []`),
`resolveSourceDraw` returns null, and the compiler soft-degrades to `ctx.hostSourceDraw` - the host
clip's already-built draw from the ordinary timeline pipeline. MediaOut returns its input unchanged.
The comp is an identity pass-through of a clip that was already decoding. The entire Flarex loader and
admission path is dormant.

**What adding a node changes.** Two different stories, and conflating them is what made this look like
"any node breaks it":

- A PROCESSING node (Blur/Transform/Merge) still creates no loader. The only effect is `comp.version`,
  which re-keys `FlarexSourceDrawCache` and the thumbnail cache.
- An ASSET-BOUND MediaIn creates the first virtual loader in the comp's life. That is the first mount,
  the first pool acquire, and the first time `preferSoftwareDecode` is applied - by layer identity.

**Is the node processing working?** Yes. The compiler evaluates correctly and reports its own reason
(`host-substituted:no-loader`) on the node that degraded. Nothing in graph evaluation is broken. The
failure is one level below it: the loader is routed to `wc-sw`, never gets a lease, and never produces
a provider, while `pool.active` stays at 1 and the host keeps decoding at `wc-hw` throughout.

---

## ROOT CAUSE (closed 2026-08-05, from the user's own trace)

The dead resource is `scene-compositor/intra-call`, generation 1 - the compositor's own sentinel handle
for its intra-call textures. Its docstring at `scene-compositor.ts:179-191` says:

> "The one handle that always resolves ... **It is never forgotten, so it is never stale.**"

It is forgotten, roughly ten seconds into every session.

1. `scene-compositor.ts:186` registers the key ONCE at module load.
2. `ephemeralSceneTexture()` (`:175-177`) hands out that handle and **never calls `touchResource`**, so
   the record's `lastUsedAt` is frozen at module-load time forever.
3. `RESOURCE_IDLE_MS = 10_000`. `collectIdleResources` (`resource-manager.ts:285-297`) sweeps **every**
   record older than the TTL - no exemption for a permanent registration.
4. `sweepIdleSceneResources` (`scene-resource-orchestration.ts:90-99`) calls `forgetResource(key)`
   **unconditionally**, and only then looks for a pool entry to dispose. Kind `scene-compositor` has no
   pool, so it is silently forgotten with nothing disposed and nothing reported.
5. Thereafter `resolveSceneTexture` returns `null`, and the draw site is explicit about the result:
   `if (srcTex === null) return;` - the layer draws nothing (`:2468-2478`).

The comment above that early return had already predicted this exact failure:

> "Unreachable today by design: every producer publishes a handle from the same pool entry it reads the
> texture from. It fires when that stops being true, which is exactly the bug I-17 names."

### Why MediaIn -> MediaOut works and ANY added node does not

A bare comp lowers to a **pass-through of the host clip's plain `SceneLayerDraw`** - no wrap group, no
nest, no render target - so `ephemeralSceneTexture` is never reached and the dead handle is never
resolved. Any node that opens a wrap (blur, transform, merge, glow, every colour node) makes the
compiler emit a `SceneGroupDraw` with `nestWidth/nestHeight`; the compositor renders that nest and wraps
the result via `ephemeralSceneTexture(...)` at `:2883` / `:2978`. That resolves to `null`, the shell
draws nothing, and the frame clears to opaque black.

So the handle has been dead since ~10s into the session; the added node is simply the **first consumer**.
That is the whole "adding any node blacks the viewer" symptom.

### The general defect, and the instance

- **Instance:** a permanent sentinel is registered in a table swept by TTL, with no notion of permanence.
- **Class:** `sweepIdleSceneResources` forgets a record BEFORE establishing that anything owns it, so any
  resource kind without a backing pool is reclaimed silently. `staleHandleCount()` documents
  "**Non-zero is the finding** (I-17)" - it is non-zero on every session that runs longer than 10s.

Fix direction (not implemented): exempt the sentinel from idle reclamation - it is not a cache and its
lifetime is the module's. Touching it per call from `ephemeralSceneTexture` would also work but makes a
permanent object masquerade as a hot cache and adds a map write to the draw path.

---

## FIX (2026-08-05, uncommitted)

A permanently-registered sentinel was living in a table swept by TTL with no way to say "permanent".
The fix says it, at the registration site, in a form every reclaimer reads without re-deriving it.

| file | change |
|---|---|
| `kernel/resource-manager.ts` | `ResourceScope` gains `"permanent"`; `collectIdleResources` skips it BEFORE the age test |
| `color/scene-compositor.ts` | the intra-call sentinel registers as `"permanent"`; its docstring's "never forgotten" claim is now true by construction rather than by hope |
| `kernel-conformance.ts` | two new assertions, both directions |

### Verified

- **`kernel:conform` discriminates.** With the sweep exemption removed it reports
  `FAIL [I-17] an untouched PERMANENT resource survives the idle sweep`, while the companion
  `[I-33] ...while an untouched LIVE resource beside it is still reclaimed` still passes - so the
  exemption is not over-broad and did not quietly retire the sweep. Restored: all invariants hold.
- `render:compare:pixels` - **53/53 fixtures at 0.000%**.
- `typecheck` clean across shared, web and worker.

### NOT verified - the browser acceptance is VOID

`apps/worker/tmp/flarex-sentinel-verify.ts` reports zero handle failures both WITH and WITHOUT the fix,
so it cannot tell the two states apart and proves nothing. The reason is a fixture defect, not a result:
it adds nodes with the toolbar palette, which leaves them **unwired** (the comp keeps one edge), and an
unwired node renders no nest - so the intra-call texture is never asked for. The user's failing run
shows `edges` going 1 -> 2 on the node add, i.e. the node was **spliced into the wire** and is in the
render chain.

A real browser acceptance therefore needs a node spliced into `mediaIn -> mediaOut`, plus a session that
outlives `RESOURCE_IDLE_MS` (10s) with real draws in it. Every existing pixel fixture is a single frame,
which is exactly why a ten-second TTL bug was invisible to the whole gate suite.

So: the reclaimed sentinel is fixed and that fix is tested. That the user's black screen is gone is
**expected but unconfirmed**, and confirming it is one instrumented run away.

---

# Defect 3, root-caused: the prune latch (2026-08-05)

Fix A (the diffing `stampFlarexComp`) did not stop the flicker, and it could not have. Reverse-engineering
from the symptom finds a cause one layer below it — one that also explains the ORIGINAL black screen.

## The tell that falsified fix A before it was measured

The user named two triggers from the start: "node moved in canvas **or** playhead in timeline". Dragging the
playhead never calls `stampFlarexComp`. No comp write, no `comp.version`, nothing for a version fix to
prevent. So a fix scoped to the comp-write seam was structurally incapable of covering half the reported
symptom, and "still not solved" was predictable from the fix's own scope rather than from any measurement.
Two triggers with one symptom means the common cause is downstream of both.

## The chain, read backwards from the picture

1. **The host appears where the MediaIn should be.** `build-scene-draws.ts:901` is `return lowered ?? draw`,
   where `draw` is the host layer's own draw. So the "flash of host" is not a second layer showing through —
   it is the SAME layer falling back when the comp fails to lower. (With nothing underneath, the layer draws
   nothing instead and the frame is BLACK. Same cause, two presentations — see below.)
2. **`lowered` is null** because the MediaIn could not produce a source.
3. **The MediaIn could not produce** because `resolveSceneTexture` answered `null`: `checkHandle` failed and
   `noteStaleHandle` fired. The user's trace shows exactly this — `handle-missing` on
   `media/flarexsrc:<comp>:<node>`, with `generation` climbing 1, 2, 3.
4. **A climbing generation means forget → re-register, repeatedly.** Only two callers forget a `media/*`
   resource. `sweepIdleSceneResources` is wall-clock, fires at most once per 10s TTL, and cannot track a
   gesture. `pruneDepartedSceneResources` runs on **every presented frame**. The frequency matches the prune.
5. **The prune infers departure from silence.** Membership in `liveMediaSourceIds` is earned by consumption:
   `getMediaSingleCtx` adds an id when some layer asks for its pixels; everything absent is disposed.

## Why that inference is sound for a clip and unsound for a Flarex loader

For a timeline clip, consumption *is* liveness — a clip nobody sampled has left the window. A Flarex virtual
loader breaks the equivalence. It is **mounted** by the viewer (descriptor, element, decoder lease) but its
pixels are requested through the **compiler**, and the compiler has several legitimate reasons not to ask on
a given frame:

- `resolveSourceDraw` returns `"ended"` once comp-local time passes the loader's clamped duration
- it returns early when the node has no virtual layer
- it is never reached at all while an upstream branch is substituting

None of those mean "departed". Liveness and consumption were conflated, and only for the one consumer whose
non-consumption is routine.

## Why it latches rather than glitching once

Forget the resource → the holder's handle goes stale → `resolveSceneTexture` returns null → the MediaIn
cannot produce → the compiler substitutes and returns null → **and because it substituted, it did not ask
for the source**, so the id is absent again → forgotten again. `forget → stale → substitute → forget`. The
climbing generation is that cycle counting its own revolutions. It breaks only when a frame happens to
re-register cleanly, which is why the user sees a *flicker* rather than a permanent failure.

## The two doors, and which fix closes which

| trigger | how it enters | closed by |
|---|---|---|
| node drag | ui-only comp write → `comp.version` bump → `FlarexSourceDrawCache` miss → a not-ready frame | fix A |
| playhead / replay | never writes the comp; enters via `"ended"` and post-seek not-ready | this fix |

Measured, same fixture, fix A present in both arms:

```
prune fix DISABLED   SCRUB handleFailures +17   DRAG +0   REPLAY +7   (25 total)  FAIL
prune fix ENABLED    SCRUB handleFailures  +0   DRAG +0   REPLAY +0   ( 0 total)  PASS
```

`DRAG +0` in the control arm is fix A doing its job; the scrub and replay columns are the door it never
reached.

## This unifies the original black screen with the flicker

In the control arm the viewer's luma fell to **8.08** during scrub — near black, not the host's 109. This
fixture is a single MediaIn → MediaOut, so there is nothing beneath the failing layer and `if (srcTex ===
null) return;` leaves the frame empty. The user's own comp merges the MediaIn OVER the host, so the same
null resolves to `lowered ?? draw` and shows the host. **One defect, two presentations, decided by topology
alone** — which is why the original report was "black screen" and the later one was "flashes the host".

## Why this is the root and not a patch

The failure class is "the compiler declined to ask this frame", which is open-ended — `"ended"`, substituting,
and any early return nobody has written yet. Enumerating those one at a time is the cosmetic approach. Fixing
*who is declared live* closes all of them at once, including future ones. It cannot leak: a loader that truly
departs leaves `flarexVirtualLayers` and is pruned on the very next composite, and one that lingers unconsumed
is still reclaimed by the wall-clock idle sweep.

It is also the third instance of one pattern, which is the real lesson:

- `scene-compositor/intra-call` — a module-lifetime sentinel reaped by a **usage**-based idle sweep (fixed
  with `scope: "permanent"`)
- media grade entries — touched on ACCESS rather than on successful draw, precisely so a held layer is not
  aged out from under a live consumer (`ScenePreviewCanvas.tsx:1315`)
- Flarex virtual loaders — declared by mount, reaped by a **consumption**-based prune (this fix)

**A resource whose liveness is declared by a mount must not be reclaimed by a reaper that infers liveness
from consumption.**

## Recurrence

`ScenePreviewCanvas.tsx:1320-1324` records the same bug on the timeline-clip path, fixed 2026-07-07: returning
null for a transiently source-less layer "dropped the layer from the draw list for a composite → a black
flicker on every ruler click (11 flickers / 19s of scrubbing)". That fix taught the grade level to hold and
left the reaper above it still inferring departure from silence. Tracker: playback-preview, next version.

## Acceptance — closed

**Confirmed by the founder on their own comp, 2026-08-05.** That was the surface the harness could not
reach: every fixture here is a lone `MediaIn -> MediaOut`, which renders the defect as BLACK, while the
founder's comp merges the MediaIn over the host and renders it as the HOST FLASH. The mechanism A/B was
decisive (25 handle failures -> 0; viewer luma 8.08 during scrub with the retention off), but the
user-visible symptom only ever existed on their topology.

Gates at the time of landing: pixel **53/53 at 0.000%**, `kernel:conform OK`, typecheck clean across
shared/web/worker, and a 30s resource census (`resources 3->3`, `media-renderer 2->2`, `reclaimed 0`,
`scopes[live:2 permanent:1]`) showing the retention fixes hold nothing they should not.

### Still open, deliberately

- **Defect 1 — node thumbnails.** `flarex-node-thumbnails.ts` keys its cache on `NodeContentHash` alone,
  omitting ADR-009's ContextVersion, so the first render (taken before the loader decodes) sticks forever.
  Proven, not fixed, not authorised.
- **Defect 4 — a MediaIn bound MID-SESSION never acquires a lease** (`wc-sw / AWAITING / NO_LEASE`, stable
  to 15s; healthy after a reload). Separate fault, untouched by any commit here. Every acceptance fixture
  reloads specifically to route around it — which means it is routed around, not solved.
- **The ~10-20s periodic hitch** recorded in DEBT-009 instance 3 did not reproduce here across 30s
  spanning three TTLs. If it is real it has a cause not identified in this document.
