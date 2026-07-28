# Flarex temporal coherence — verification & Track B measurement log

Track A (correctness) is code-complete and gate-verified but **NOT browser-verified**. The
implementation is only complete once the original symptom is gone on the low-end machine.

Track B does not begin until section 1 is filled in.

---

## 0. Setup

```
pnpm dev                      # web :5173
```

Open the 3-`MediaIn` Flarex composition. No flags needed — the coherence probe is always on
(`?flarexProfile=1` additionally keeps a 240-entry per-composite sample ring, useful only if a number
looks wrong and you want to see individual episodes).

Console helpers:

```js
__flarexCoherence.reset()     // zero the counters — call immediately before each measured run
__flarexCoherence.report()    // formatted readout
__flarexCoherence.offenders   // which sources held the frame, most first
```

Cross-check globals when a number looks off: `__rfWcMode` (per source: `wc-hw` / `wc-sw` /
`element`), `__rfWcPool` (`active`, `activeSoftware`, `capMisses`), `__rfWcStaleTime`,
`__rfFlarexProxy`.

---

## 1. Track A verification — MANDATORY, blocks Track B

### 1a. The original symptom

Scrub repeatedly through the 3-`MediaIn` comp (10–15 scrubs, varied distances, including long jumps).

- [ ] All three MediaIns update **atomically** — the comp changes as one picture.
- [ ] **No visible staggered fill-in** (the reported symptom: media 1, then 2, then 3).
- [ ] The viewer never goes black or flashes a partial composite.
- [ ] Scrubbing does not feel *frozen*. Holding the previous frame is expected and correct; a viewer
      that stops updating for over ~1.5s is not (that is the escape-hatch ceiling, and hitting it
      means something is failing to converge — check `offenders`).

### 1b. Metrics — `__flarexCoherence.reset()` first, scrub, then `.report()`

**RESULT — 2026-07-28, low-end machine, dev build with `?flarexProfile=1`. Track A FAILED this test.**

| Metric | Value | Notes |
|---|---|---|
| Time to first coherent frame (`lastHoldMs`) | 171.7ms | |
| Average hold time (`avgHoldMs`) | **518.2ms** | half a second of added scrub latency |
| Worst hold time (`maxHoldMs`) | **1509.9ms** | pinned at the escape-hatch ceiling |
| Convergence events (`holdStreaks`) | 33 | 957 of 2769 composites withheld |
| **Escape-hatch activations** | **47** | should be ~0 |
| ...episode-cap | 3 | |
| ...write-off | **44** | sources not converging at all |
| Worst staleness | **24 300ms** | 24.3 SECONDS, not a convergence lag |

Observed: sources **still fill in one at a time**; scrubbing noticeably slower; playback smooth but
FPS dropped in the live comp (40–41 fps); parameter edits update everything together.

Offenders — the host clip is among them, which it should never be:
```
883  flarexsrc:…:n_mrzuss81_mszw
702  layer_1784952747004_1_1          ← the HOST clip
368  flarexsrc:…:n_mrzusqg4_99w3
```

Same session, the actual bottleneck named itself:
```
[perf] MAIN THREAD BLOCKED ~2.6s
   77×  getFrame (playback/preview-frame-pool.ts) < requestWcFrame (components/WebglMediaLayer.tsx)
   69×  requestWcFrame (components/WebglMediaLayer.tsx)
```

**Verdict.** The barrier logic is correct (5655 unit assertions pass) but its PREMISE is false. It was
built on the 2026-07-27 "PAUSED = COHERENT" finding — that paused, every loader converges on the exact
requested time, so waiting costs a few hundred ms. Measured reality: sources routinely never converge
inside their 1.5s budget (44 write-offs), and one was 24.3s adrift. So the barrier withholds for up to
1.5s, gives up, writes the slow source off — and a written-off source no longer blocks, so the others
resume presenting as they arrive and the staggered fill-in returns exactly as before. It bought 518ms
of average scrub latency and removed nothing.

**Waiting is only useful when the thing you are waiting for arrives.** Convergence has to be bounded
before withholding a frame is a sensible act.

**Action taken:** the hold is now behind `?flarexCoherence=1` / `orreris.flarexCoherence`, default
**OFF** — no regression ships. Staleness is still measured and reported with the flag off, which is
what makes `__flarexCoherence` the Track B instrument. Re-enable and re-measure once Track B bounds
convergence.

**This also resets Track B's target.** The number to beat is not the assumed 200–300ms stagger; it is
multi-second non-convergence with a 2.6s main-thread block in the decode path. B1/B2 may well be too
small to matter against that — in which case, per the standing instruction, document the bottleneck
rather than inventing architecture around it.

`escapeHatches` is the one that matters. A coherent frame that arrived by WAITING is the mechanism
working; one that arrived because a hatch fired is a mixed-generation frame that reached the screen
anyway. Non-zero here means Track A is masking a convergence failure rather than fixing a scheduling
artifact — investigate before proceeding.

### 1c. Playback is unchanged

- [ ] Play the same comp. Sources still update smoothly (each advancing at its own rate under
      contention) — this is `tolerateLag`, deliberately preserved.
- [ ] `escapeHatches` does **not** climb while playing (the gate returns false when playing, so it
      cannot fire — if it does, the paused/playing scoping is broken).
- [ ] Playback FPS unchanged vs before this work.

### 1d. Parameter edits while paused

- [ ] Edit a node parameter (any grade/transform control) with the transport paused. The comp updates
      as one picture — no source visibly lagging behind the others.
- [ ] Editing feels responsive. A param edit does not move the playhead, so no source becomes stale
      and the barrier should never engage: expect `holdStreaks` not to increase. If it does, staleness
      is being reported for a non-time reason and needs investigating.

---

## 1e. Diagnosis of the 2.6s block (2026-07-28) — read before Track B

### Is `getFrame` blocking the main thread?

**No.** Nothing here holds the thread for 2.6s. Three facts settle it:

1. `frameBudgetMs: 24` (`preview-frame-pool.ts`) — one `getFrame` is time-boxed to 24ms.
2. The decode loop `await`s `yieldTask()` (MessageChannel) or `sleepMs(2)` **every round**, so it is a
   chain of short macrotasks, never one long task.
3. The sample distribution is the giveaway. Of ~310 possible samples in the window:

   | samples | frame | what it is |
   |---|---|---|
   | 77 | `getFrame` (`preview-frame-pool.ts`) | the `serializeFrameProvider` wrapper — 3 lines of promise plumbing |
   | 69 | `requestWcFrame` (`WebglMediaLayer.tsx`) | the request kickoff — a few property reads |
   | 6 | `(anonymous/native)` | |
   | 3 | `getFrame` (`webcodecs-decoder.ts`) | **the actual decode body** |

   The two cheapest functions in the path own ~47% of samples; the decoder body owns 1%. That is the
   signature of an extremely high CALL RATE, not expensive work. If decoding were the cost, samples
   would sit in `consumeDecodedUpTo` / `win.ensure` / native decode.

**The main thread is not blocked — it is saturated.** An unbounded zero-delay retry chain floods the
loop with MessageChannel tasks, which outrank timers, so the 500ms heartbeat lands 2.6s late and the
detector reports "BLOCKED". Same visible symptom as a long task, opposite cause, opposite fix.

### Where the time actually goes

| Category | Verdict |
|---|---|
| Decode | ~1% of samples. Not the cost. |
| Frame upload | **Not in this path at all** — upload is `texImage2D` in the compositor's `gradeMediaInContext`, a different stack. |
| Synchronisation / locking | `serializeFrameProvider`'s promise chain, and `wcBusyRef`. Cheap individually; dominant by frequency. |
| React / UI | Present but separate — the *first* stall (1146ms) is pure React dev-mode (`commitPassiveMountOnFiber` 29×, `updateVirtualChildrenRecursively` 10×). Dev-build overhead, not this bug. |
| Synchronous main-thread work | None of consequence. The cost is scheduling pressure. |
| **Call frequency** | **The actual cost.** |

### Why the retry chain has no floor

Every branch that sets `wcRerequestRef.current = true` (`WebglMediaLayer.tsx` ~1790, ~1799, ~1813) is
consumed at the end of the *same* `.then()` and calls `requestWcFrameRef.current()` immediately. Zero
delay, by construction.

Tracker v30b already identified and fixed this recursion — but only for the `tolerateLag` stale-bail
and the null-frame branch (`scheduleTolerantRetry`, 100ms doubling to 1s). **The three
`wcRerequestRef` hold branches were never given a floor.**

### Why paused media never converge — the tail-overshoot trap

This is the root cause, and it is not Flarex-specific.

`getFrame` clamps any request past the last sample (`chunkIndexForMicros`) and serves the final frame,
reporting `lag = requested − lastSampleTimestamp`. In that region the lag **can never fall**, because
the frame it is holding already IS the last frame. There is nothing to converge to.

`WC_HOLD_LAG_S = 0.35`. So any source parked more than 350ms past its true decodable end holds
permanently → re-requests at zero delay → `getFrame` returns almost instantly (`fed >= chunkCount` →
`decoder.flush()` → break) → holds again. **A spin loop issuing a native decoder flush per iteration.**
After `WC_HOLD_MAX_MS` (5000ms) it falls to the "stay degraded" branch, which *also* sets
`wcRerequestRef` — so the spin continues, just presenting as well.

The overshoot is structural. The preview clamps with **container duration metadata**:

- host clip: `resolveSourceSeconds` → `asset.durationSeconds - 0.05`
- Flarex loader: `holdEnd` → `startSeconds + (srcDur - sourceIn) - 1/240`

and `webcodecs-decoder.ts` documents that container duration "routinely OVERSHOOTS [the decodable end]
by a frame to ~1s". A 50ms margin does not cover a ~1s overshoot. The provider already exposes the
true value as `decodableEndSeconds` — **and nothing in the live preview path reads it.** Only the proxy
worker, the proxy engine and the *export* compositor do. (The preview pool erased it entirely until it
was forwarded on 2026-07-28 for the coherence work.)

That also explains **24.3s staleness**: a Flarex loader with unknown `srcDur` gets `holdEnd = Infinity`
(no clamp at all), so the request tracks the comp playhead arbitrarily far past the source's end.

### Why the host clip is affected

Because the mechanism has nothing to do with Flarex. The host uses the same container-duration clamp
and the same hold branch. Any clip parked near its tail spins — the host is simply lag-INtolerant, so
it takes the hold path unconditionally. This is very likely a long-standing cause of "the editor gets
sluggish near the end of a clip" independent of node comps.

### Confidence and the one check that would confirm it

Mechanism traced end-to-end in code; **not yet confirmed on the machine.** One run settles it:

```
open with ?exportDecodeDebug=1
park the playhead near the end of a clip / comp, paused
```

- Expect repeated `[frozen-tail] getFrame(…) is past media end … clamping to last sample (overshoot Ns)`.
  The overshoot value is the predicted lag.
- `window.__rfWcHolds` should climb continuously while parked and doing nothing.
- `__flarexCoherence.offenders` should name the same sources, and `escapeHatchWriteOff` should rise.

If `[frozen-tail]` does **not** appear, the tail-overshoot hypothesis is wrong and the remaining
candidate is scrub-driven `resetTo` thrash (every direction change re-seeks, so a moving target
restarts the catch-up) — which the same retry-floor absence would amplify identically.

### 1e-bis. RETRACTION + confirmed root-cause class (browser run, 2026-07-28)

The stationary/scrub run **falsified both hypotheses above** and identified the real mechanism.

**Stationary, 30s untouched:** `__rfWcHolds` never even initialised (zero holds). `__rfWcPool.created`
frozen at 6. Nothing happens at rest.

- ❌ **Frozen-tail spin: WRONG.** The log fires, but overshoot is **0.013s** against a
  `WC_HOLD_LAG_S = 0.35s` threshold — 27× too small to trigger a hold. The existing `-0.05` clamp
  margin already covers it. The prediction was ~1s of container overshoot; this asset has 13ms.
- ❌ **Idle provider churn: WRONG.** `created` does not move at rest.

**Scrubbing, 30s:**
```
created   6 → 38      (+32 providers in 30s)
reused    0 → 16      (only ~30% warm-reuse)
capMisses 4 · preemptions 0 · initFailures 0
__rfWcHolds  0 → 90
```
plus, three times:
```
[export] decoder.decode() threw → failed. state=closed qsize=0 fed=720/791 outputs=12
         InvalidStateError: Cannot call 'decode' on a closed codec
[export] getFrame → null. failed=true … micros=24100000
```

**Confirmed root-cause class: scrub-driven provider churn with a use-after-dispose race.**

1. Scrubbing causes lease release/acquire cycles.
2. `parkOrDispose` evicts past `MAX_IDLE = 2` → `disposeQuietly` → `provider.dispose()` closes the
   decoder **while a `getFrame` is still awaiting inside its loop**. `serializeFrameProvider` has no
   cancellation — its header already documents in-flight `getFrame` surviving `release()` (it fixed
   the "key frame is required" variant); the DISPOSE variant was never covered.
3. The in-flight loop calls `decoder.decode()` on the closed codec → `failed = true` → returns null.
4. Null → the layer re-acquires → **a fresh provider re-parses a 14–16MB moov on the main thread**
   (ten such parses in one page load; dozens during a scrub).
5. A fresh provider has `lastMicros < 0` → keyframe re-seek → genuinely far behind → `lag > 0.35s`
   → hold branch → **zero-delay re-request** (confirmed live in the stack, 3 nested levels).
6. That pressure slows the next parse, so more scrub events land mid-catch-up. Self-reinforcing.

`micros=24100000` (24.1s) in one failure is the same event that read as **24.3s staleness** in §1b.
Not a decoder that is 24s behind — a decoder that was destroyed and restarted from zero.

**Cap pressure is NOT the driver** (`capMisses 4`, `preemptions 0` against 32 creations), which
weakens B2's rationale as well.

**Still unknown — the initiator.** What starts each release/acquire cycle during a scrub. `mediaUrl`
is `resolvePlaybackUrl(asset)`, independent of `currentTime`, and it is the layer's React `key` — so a
URL change is a full remount. The index log shows **two different byte sizes with an identical
791-sample/66-sync signature** (16,889,885B and 16,434,845B), i.e. two encodes of the same source —
consistent with an original↔proxy swap remounting the layer mid-gesture. Unconfirmed.

### 1e-ter. THE MEASUREMENT ENVIRONMENT IS CONFOUNDED (2026-07-28)

Every number in §1b and §1e-bis was taken from a **dev build with React StrictMode on**
(`main.tsx` wraps the app in `<StrictMode>`). The provider-trace run caught it directly:

```
[frozen-tail] getFrame(16.146s) …
  getFrame @ preview-frame-pool.ts
  (anonymous) @ WebglMediaLayer.tsx:708    ← lease effect's ready.then
  (anonymous) @ WebglMediaLayer.tsx:696    ← THE LEASE EFFECT
  commitHookLayoutEffects
  reappearLayoutEffects
  doubleInvokeEffectsOnFiber                ← React StrictMode
  recursivelyTraverseAndDoubleInvokeEffectsInDEV
  commitDoubleInvokeEffectsInDEV
```

React 19 StrictMode intentionally mounts → unmounts → remounts effects. The lease effect is where a
decoder provider is acquired, so **every layer mount acquires, releases and re-acquires a provider by
design in dev**. Consequences for everything measured so far:

- `created: 6 → 38` over a 30s scrub is inflated by at least 2×, possibly entirely explained.
- The ten 14–16MB moov re-parses are at least doubled.
- Two of the three stall traces were dominated by `commitPassiveMountOnFiber` /
  `recursivelyTraverseAndDoubleInvokeEffectsInDEV` — pure dev-mode React, not decode.
- `40–41 fps` is a dev figure with the DevTools hook (`installHook.js`) attached.

**This does not make the churn imaginary.** StrictMode doubles mounts; it does not create 16 of them.
Something is still remounting layers during a scrub, and the use-after-dispose race
(`Cannot call 'decode' on a closed codec`) is a genuine ordering bug that dev mode only makes more
frequent. But the MAGNITUDE of every number is unusable, and magnitude is exactly what decides
whether B1/B2 are worth anything.

**No further conclusions from dev-build numbers.** The provider trace must be run against a
production build first:

```
pnpm --filter @orreris/web build
pnpm --filter @orreris/web preview        # then open with ?providerTrace=1
```

Production has no StrictMode double-invoke, no React DevTools hook, and no dev-only effect
double-traversal. The trace flag is a runtime check, so it works there unchanged.

### What this means for B1 / B2

Both are aimed at the wrong quantity.

- **B1 (`preferSoftwareDecode`)** changes which engine decodes. Decoding is 1% of the samples. It
  cannot fix a retry-rate problem.
- **B2 (paused comp proxies)** reduces decoder *count*, which would reduce the number of spinning
  sources — genuinely helpful, but it treats the symptom and does nothing for the host clip, which is
  outside any comp.

Neither addresses the absent retry floor or the container-duration overshoot. Recommend deferring both
until the above is confirmed.

---

## 2. Track B — convergence latency

**Rules (standing instruction): one variable at a time; measure between each; never combine
optimisations before each has isolated before/after data. If neither B1 nor B2 materially reduces
convergence latency, STOP and document the remaining bottleneck rather than introducing new
architectural changes.**

Track A made the update atomic, not fast. The ~200–300ms convergence is unchanged — it now happens
all at once. Track B attacks that number, and section 1b is its baseline.

Same protocol each time: `reset()` → identical scrub pattern → `report()`. Best of 3 runs
(`flarex-perf-scorecard.ts` records single-run p95 swinging 1.4 → 32.4ms on a box sharing a dev
server, so a single run is not a measurement).

| Run | avg hold | worst hold | escape hatches | playback FPS | CPU | GPU |
|---|---|---|---|---|---|---|
| **Baseline** (Track A only) | | | | | | |
| **B1** — `preferSoftwareDecode` off for virtual loaders | | | | | | |
| **B2** — comp proxies allowed while paused on the Flarex page | | | | | | |

### B1 — re-measure `preferSoftwareDecode`

Flagged "Kept, unproven" in `project-tracker/playback-preview.md` v30: shipped on a contention theory
that was later disproved, and it costs a CPU H.264 decode per loader. Set at
`VideoPreview.tsx` (`preferSoftwareDecode` on Flarex virtual loaders).

Use per-source evidence, not global counters — tracker v29's recorded lesson is that global counters
cannot attribute a stall to one source. `__flarexCoherence.offenders` and
`frameProfiler.noteMediaSource` both name individual sources.

### B2 — comp proxies while paused on the Flarex page

Force-disabled wholesale at `EditorPage.tsx` (`flarexProxyPlayback={editorPage !== "flarex"}`), yet a
proxy is the one mechanism that collapses N decoders into 1, and paused is where convergence is
slowest and a proxy is safest. Must respect the existing `canSubstituteFlarexProxy` safety rule (a
rendered proxy bakes the composition background, so a comp with anything drawn below it must keep
evaluating live).

### B3 — decoder budget (document, do NOT change)

Three loaders + host against `MAX_WC_TOTAL_SESSIONS = 4` / `HARDWARE_RESERVED_SLOTS = 1`
(`preview-frame-pool.ts`) means starvation is structural, not incidental. Record what B1/B2 leave on
the table. Do **not** raise the cap to route around it — tracker v30a: raising concurrency to 7
killed the renderer (white page).

---

## 3. Known-unrelated

`pnpm typecheck` fails in `apps/worker` at `flarex-proxy-parity-gate.ts:160` (an
`ImageData`/`Uint8ClampedArray` overload error). Pre-existing on this branch, unmodified vs HEAD, and
deliberately left alone as a separate change.

---

## 4. ROOT CAUSE FOUND — the production build ships React development

Date: 2026-07-28. This supersedes every magnitude recorded above.

### The measurement that ended the search

Four `markHotSpot` probes were wired into the live single-context draw path (the three pre-existing
probes had been dead since 2026-07-07, sitting behind `WebglMediaLayer.tsx`'s `if (singleCtx) return`).
A build-mode scrub session that produced a **3152 ms** main-thread stall recorded only:

| at | label | ms | detail |
|---|---|---|---|
| 23869 | `scene-draw-build` | 200 | `layers=1` |
| 24070 | `scene-composite` | 107 | `1920x1080 draws=1` |
| 23869 | `scene-draw-total` | 309 | `layers=1` |
| 117212 | `scene-draw-build` | 59 | `layers=2` |
| 136196 | `scene-draw-build` | 52 | `layers=1` |

Seven events across the whole session, worst 309 ms, none coincident with the stall. **The draw
pipeline is not the bottleneck and never was.** Compositing, grading and draw-list build are all
comfortably inside budget.

### Where the 3152 ms actually went

The self-profiler sampled it (unlike the earlier 7493 ms "no JS samples" window). Resolving the
minified frames against `dist/assets` by hand:

- `h_` = `commitPassiveMountOnFiber` — `switch (n.tag)`, `n.mode & Xe` where `Xe = 2` (`ProfileMode`)
- `oo` = `recursivelyTraversePassiveMountEffects` — bails on `n.subtreeFlags & 10256`, **or continues
  anyway when `n.actualDuration !== 0`**

29 of ~62 samples were that mutual recursion: React walking the entire `EditorPage` fiber tree on
commit with the subtree bailout defeated. A further 9 were React DevTools' own mirror walk
(`updateFiberRecursively`), and 3 were `measureHostInstance` → `get scrollX`, i.e. DevTools forcing
synchronous layout. ~66% of the stall is React commit instrumentation. Only ~10 samples are the
application component itself.

### Why: `.env` line 1

`vite.config.ts` sets `envDir: repoRoot` so one `.env` serves web, api and worker. That root `.env`
begins `NODE_ENV=development`. Vite lifts `NODE_ENV` out of env files into `process.env.NODE_ENV`
whenever it is not already set in the shell, so **`pnpm build` produces a bundle with
`isProduction = false`**: the `development` export condition resolves, and `react-dom.development.js`
is bundled and shipped.

Control build, `NODE_ENV=production npx vite build`, same tree, same config:

| marker | shipped | control |
|---|---|---|
| `react.dev/errors` (prod error decoder) | 0 | 1 |
| `unique "key" prop` | 1 | 0 |
| `Cannot update a component` | 1 | 0 |
| `Invalid hook call` | 3 | 0 |
| `createTask` (DEV owner stacks) | 3 | 0 |
| `react_stack_bottom_frame` (DEV only) | 4 | 0 |
| `index` chunk | 999,228 B | 787,555 B (−21%) |
| `EditorPage` chunk | 1,018,160 B | 725,224 B (−29%) |

### What this invalidates

**There was never a control run in this investigation.** The 2026-07-28 "measurement confound"
finding blamed dev-server `<StrictMode>` double-invocation and treated the build as clean. It is not:
a DEV React honours `StrictMode`, so effects double-invoke in the shipped build too, and every
"production" number above — 20596.7 ms worst staleness, 49 escape-hatch activations, 669.1 ms average
convergence, the 7493 ms and 3293 ms stalls — was taken against an instrumented React.

### Causal chain

Multi-second React commit block → every `<video>` element and WebCodecs decoder is frozen for the
duration → sources drift seconds apart → they converge at different wall times → media fills in one
at a time. **The stagger is downstream of the stall, and the stall is not in the media pipeline.**

### Consequences for Track B

B1 (`preferSoftwareDecode`) and B2 (paused comp proxies) target decode contention. The evidence says
decode contention is not the constraint: zero WebCodecs activity in the traced window, zero provider
churn, and a draw path whose worst frame is 309 ms. Per the standing instruction — *"if neither B1
nor B2 materially reduces convergence latency, stop and document the remaining bottleneck"* — Track B
should not start until the build is rebuilt correctly and the symptom is re-measured.

### Fix — APPLIED

1. **`NODE_ENV` removed from the root `.env` AND `.env.local`.** Nothing needed it: the API defaults
   it to `"development"` (`apps/api/src/config/env.ts`), `prisma.ts` and `render-worker.ts` guard on
   `!== "production"`, and `apps/{api,worker}/Dockerfile` set it explicitly for deploys.
2. **A build-mode assertion in `apps/web/vite.config.ts`** (`orreris:assert-production-build`). It
   throws when `command === "build" && mode === "production" && !isProduction` — the exact
   inconsistency an env-file leak produces, while an intentional `vite build --mode development`
   moves both together and passes. This asserts the PROPERTY, not the cause, so any future route to
   the same failure fails loudly at build time.

**The assertion immediately caught a second source I had missed.** `.env.local` — gitignored, so
invisible to `git grep` and to any other machine — also began `NODE_ENV=development`, and vite reads
it at higher precedence than `.env`. Fixing only `.env` would have left the bug fully intact while
looking fixed. Had the fix shipped without the assertion, the next measurement would have been
another confounded run.

Verified: `pnpm --filter @orreris/web build` now emits bytes identical to a forced
`NODE_ENV=production` control build (`index-DUGSzbXT.js`, 787,555 B). All DEV markers 0,
`react.dev/errors` present. Negative control: with `NODE_ENV=development` exported, the build
refuses.

### Second-order finding

This is the third instrument in this investigation to fail silently: the pool erased `nominalFps`,
`__rfHotSpots` measured a code path abandoned on 2026-07-07, and the build shipped DEV React while
being treated as the control. Each one reported health for something it was not measuring. Worth a
dedicated pass over the diagnostic surface once this closes.
