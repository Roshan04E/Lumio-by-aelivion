# Pull-model feasibility study — ~100 MediaIn nodes in a browser

Repo: Orreris Pro, branch `method-3-gpu-compositor`, measured at **680ddfc**, in an isolated
worktree (NOT `.claude/worktrees/impl-tip`, which is pinned at a stale 62a1184).

**VERDICT: no — not at ~100 simultaneously-decoding MediaIn nodes. Three of the five
pre-registered falsifiers fired.** ~100 *nodes* is feasible; ~100 *live video sources* is not.
The pull seam itself is vindicated and is not what stops us.

Machine: AMD Radeon Vega 8 (integrated), real Chrome, real WebCodecs, real WebGL2. An integrated
GPU is the right place to measure this — it is the target class, not a handicap.

---

## 0. Pre-registered falsifier — WRITTEN BEFORE ANY MEASUREMENT

Recorded before running anything so it could not be retro-fitted to the results.

### The budgets, and where they come from

| Regime | Frame budget | At N=100, per-source budget |
|---|---|---|
| Interactive scrub (10fps) | 100 ms | **1.0 ms** |
| Playback 24fps | 41.6 ms | **0.42 ms** |
| Playback 30fps | 33.3 ms | **0.33 ms** |

33.3ms is the budget `flarex:perf` already asserts for the 100-node comp, so this study is held to
a bar the repo committed to publicly.

| # | Falsifier | Threshold | Result |
|---|---|---|---|
| F1 | Random-access `getFrame` p95, with an **all-intra** proxy | > 1.0 ms/source | **FIRED — 116.4 ms (116×)** |
| F2 | Superlinearity in N | cost(100) > 2.5 × cost(50) | did not fire — linear |
| F3 | Resident memory at N=100 | > ~2 GB | **FIRED — 2546 MB** |
| F4 | Scrub-one-frame invalidation | > 50% of nodes | **FIRED — 100%** |
| F5 | All-intra size premium | > 6× | did not fire — 1.55–1.80× |

I predicted in advance that F1 would fire and said so. It did, by two orders of magnitude. What I
did **not** predict is *why* — see Part 3b, which overturns the intra-frame premise.

---

## Part 1 — how does pull scale?

Drives the **existing** export pull path (`SceneFrameCompositor.gradeMediaLayer` →
`await source.getFrame(t)`) over a real Flarex comp with N asset-source MediaIn nodes on N distinct
1280×720 GOP-12 files built to the shipped proxy recipe. Composition, virtual loaders and providers
are all built by the same shared helpers `export-core.ts` uses. 8 frames per rung, sequential time.

**Decode/composite separation.** Every provider handed to the compositor is wrapped, timestamping
entry/exit of each `getFrame`. `renderFrame` awaits its media layers with `Promise.all`, so calls
overlap and summing per-call durations would double-count badly at N=100. So `decode wall` =
`max(exit) − min(entry)` over the frame's calls (true wall-clock span in decode), `decode sum` =
the serialized-equivalent total, and `composite` = `total − decode wall`.

| N | create (ms) | cold (ms) | warm total | decode wall | decode sum | composite | per-src | luma |
|---|---|---|---|---|---|---|---|---|
| 1 | 94 | 139.2 | **23.7** | 2.8 | 0.1 | 20.9 | 23.70 | 126.6 |
| 5 | 368 | 109.1 | **79.1** | 3.0 | 0.5 | 76.1 | 15.82 | 126.9 |
| 10 | 601 | 155.4 | **154.1** | 4.7 | 1.4 | 149.4 | 15.41 | 127.7 |
| 25 | 1831 | 394.9 | **325.1** | 5.4 | 7.3 | 319.7 | 13.00 | 128.2 |
| 50 | 3984 | 2222.4 | **864.2** | 9.0 | 22.9 | 855.2 | 17.28 | 126.0 |
| 100 | 23815 | 7452.5 | **2080.4** | **1139.5** | 2371.2 | 940.9 | 20.80 | 126.0 |

`luma` is the mean of the composited canvas — non-zero at every rung, so the probe measured a real
picture and not a black frame.

**Is it linear?** Yes. Per-source cost is flat at 13–24 ms across the whole ladder, and
cost(100)=2080 ms < 2.5 × cost(50)=2160 ms. **F2 does not fire.** The model degrades predictably
rather than falling off a cliff — which is the good news in this report.

**Where the cost actually is, and this is the finding that matters.** Up to N=50 the pull seam is
nearly free: decode wall is **2.8–9.0 ms** while composite is **20.9–855.2 ms**. The pull is not
the bottleneck; the compositor's per-source passes are. My topology funnels N sources through N−1
merge nodes, so composite is O(N) full-frame RTT passes — a real N-source comp must combine its
sources somehow, so this is representative, but the number is a property of *pass count*, not of
*pulling*.

**The exception is N=100**, where decode wall jumps 9.0 → 1139.5 ms. 100 concurrent WebCodecs
decoders thrash. There is a decoder-count ceiling somewhere between 50 and 100 that is independent
of everything else in this report.

**Per-source `getFrame`, cold vs warm.** Cold (provider construction: fetch, demux, index build)
is 94–238 ms per source, and it serializes: 23.8 s to build 100 providers. Warm sequential is
**~0.03–0.1 ms per source** (decode sum ÷ N) — essentially free, because sequential pull streams
forward and never re-seeks.

### Memory (F3)

`performance.memory` cannot answer this — a decoded `VideoFrame` is not on the JS heap. Measured
instead as the sum of all `chrome.exe` working sets from the OS, with a **fresh browser per rung**
and a baseline taken in that same browser before providers exist (so no rung inherits the previous
high-water mark).

| N | baseline | held | delta | per-source | JS heap |
|---|---|---|---|---|---|
| 1 | 445 MB | 551 MB | 106 MB | 106.4 MB | 20.1 MB |
| 25 | 444 MB | 1061 MB | 617 MB | 24.7 MB | 113.6 MB |
| 50 | 447 MB | 1339 MB | 892 MB | 17.8 MB | 71.4 MB |
| 100 | 445 MB | **2991 MB** | **2546 MB** | 25.5 MB | 36.5 MB |

**F3 FIRES.** ~25 MB per live source, ~3 GB total at N=100 — into the range where a browser tab
dies, and this is with 3-second clips. Real footage would be worse: `fetchSourceBlob` holds the
whole file in RAM, so per-source residency scales with clip length, not just resolution. **Memory,
not latency, is the first hard wall.**

---

## Part 2 — what does the cache actually buy?

Pure, no browser. Drives the **real** shipped invalidation machinery
(`kernel/dependency-graph.ts` — `declareNode`/`markDirty`/`markAxisDirty`/`dirtyClosure`) exactly as
`incremental-evaluation.ts` drives it, over a 121-node graph with 24 sources.

Measuring the real closure matters, because the answer does **not** live in the content hash.
`content-hash.ts` deliberately excludes frame time (ADR-009: time is a separate axis, not content);
only 24/121 hashes move between t=0 and t=1.234, and those are the keyframed nodes' cones. The
scrub answer is decided entirely by the dirty-axis policy.

| Mutation | all-video (shipped) | all-video (narrowed) | 1-in-3 generator (narrowed) |
|---|---|---|---|
| (a) drag one param | **7.4%** | 7.4% | 7.4% |
| (b) **scrub one frame** | **100.0%** | 99.2% | 74.4% |
| (c) rewire one edge | **5.0%** | 5.0% | 5.0% |
| (d) change one source | **8.3%** | 8.3% | 8.3% |

*shipped* = every node declares the `time` axis, which is what `incremental-evaluation.ts:224-227`
actually does today ("deliberately NOT narrowed"). *narrowed* = `time` declared only by nodes with
a keyframed param or a time-varying source upstream — not an invention, it is how
`dependency-graph.ts`'s own header defines the axis.

**F4 FIRES, and narrowing does not rescue it.** In an all-video comp, narrowing moves 100% → 99.2%,
because every node genuinely *is* downstream of a source whose picture changes with t. This is not
a policy bug that can be tuned away; it is a true statement about the graph. Only genuinely
time-invariant subtrees can be saved, and they only exist when sources are stills/generators
(1-in-3 generators → 74.4%).

**So the cache is excellent for editing and useless for scrubbing.** Editing invalidates 5–8% —
a 92–95% hit rate, which is exactly the "a compositor feels fast by not recomputing" claim, and it
holds. Playback-from-cache does not follow from it.

---

## Part 3 — the random-access cost

One clip, encoded both ways, **CRF-matched not bitrate-matched** (encoding intra at the same
bitrate would pay for intra with quality and understate its price). 80 random seeks over 20s.

### File size (F5)

| Content | GOP-12 | all-intra | ratio |
|---|---|---|---|
| High-entropy (noise) | 32.68 MB | 50.67 MB | **1.55×** |
| Clean (testsrc2) | 10.61 MB | 19.08 MB | **1.80×** |

**F5 does not fire** — 1.55–1.80×, well under both my 2–4× estimate and the 6× threshold. *Caveat,
stated because it cuts against the result:* synthetic content with constant motion is
unrepresentative of real footage. Static camera shots compress far better inter-frame, so real
media would push this ratio **up**, plausibly to 2–3×. Still nowhere near unaffordable.

### Latency (F1)

| File | min | p50 | p90 | p95 | p99 | max |
|---|---|---|---|---|---|---|
| p3-gop12 | 0.0 | 57.7 | 104.8 | 124.1 | **5375.3** | 5375.3 |
| p3-intra | 2.8 | 63.5 | 95.5 | **100.4** | 115.8 | 115.8 |
| p3c-gop12 | 0.0 | 49.8 | 93.5 | 126.1 | **5375.4** | 5375.4 |
| p3c-intra | 9.9 | 49.2 | 80.2 | 87.9 | 102.1 | 102.1 |

**F1 FIRES by ~116×.** Intra p95 is 100.4 ms against a 1.0 ms budget. Interactive scrub at 100
live-decoding sources is arithmetically impossible, and no compositor engineering recovers it.

Note also the **5.4-second p99 on both GOP-12 files**, absent on intra (max 115.8 ms).

---

## Part 3b — WHY random access is expensive (the premise overturned)

Part 3 showed intra ≈ GOP-12 at the median, which contradicts the intra-frame thesis. So I swept
seek distance to separate "cost is the GOP walk" from "cost is a fixed per-seek reset".

*(First run of this sweep was VOID: it reused one provider and let `+12f`/`+30f` walk past the 20s
end, after which the decoder sits in its frozen-tail clamp and returns a cached frame in 0.0 ms —
every later pattern read as free. Fixed with a fresh provider per pattern and in-bounds wrapping.)*

30 samples per pattern, ms:

| pattern | gop12 p50 | gop12 p95 | gop12 max | intra p50 | intra p95 | intra max |
|---|---|---|---|---|---|---|
| seq +1f | 0.0 | 3.2 | 4.6 | 0.0 | 4.5 | 5.4 |
| fwd +4f | 5.4 | 8.7 | 12.8 | 7.4 | 12.1 | 23.6 |
| fwd +11f | 17.1 | 25.0 | 41.8 | 22.4 | 29.5 | 39.6 |
| fwd +12f | 17.6 | 20.2 | 21.0 | 16.1 | 65.5 | 65.6 |
| fwd +30f | 42.2 | 50.4 | 53.3 | 39.5 | 63.2 | 70.3 |
| **back −1f** | 0.0 | **5354.8** | 5361.2 | 60.0 | **166.1** | 172.3 |
| random | 47.5 | 61.1 | 5360.9 | 52.5 | 116.4 | 170.7 |

Two conclusions, and the first was verified **in the code**, not inferred from timings:

**1. Forward seeks never use keyframes, so intra cannot help them.** At
[`webcodecs-decoder.ts:779-782`](../../apps/web/src/export/webcodecs-decoder.ts) a keyframe re-seek
happens only on the first call (`lastMicros < 0`) or a **backward** jump (`micros + 1000 <
lastMicros`). A forward jump falls through and decodes every intermediate frame. That is exactly
what the table shows: cost rises linearly with forward distance (~1.4 ms/frame) at the *same rate
on both encodings*. **The random-access cost is a property of our decoder's forward-walk, not of
the media.** An all-intra proxy — the deferred supporting item — buys close to nothing for forward
access until that path learns to jump to the nearest sync sample.

**2. Where intra *does* pay is the tail.** Backward-seek p95 is **5354.8 ms on GOP-12 vs 166.1 ms
on intra** — a 32× improvement, and the 5.4s stalls are the same ones in the Part 3 p99. That is
`chunkIndexForMicros` falling back to a full rescan from j=0 on backward seeks, a cost the code
comments already acknowledge ("backward seeks fall back to a full rescan — today's cost").

So the intra-frame answer, as inherited from ProRes/DNxHD practice, **is not the lever it was
assumed to be here**. The levers, in order of measured value: fix the forward-seek path to seek to
the nearest sync sample; fix the backward-seek rescan; then the cache; then, and only then,
consider intra media for its tail behaviour.

---

## What this means

**~100 simultaneously-decoding MediaIn nodes in a browser: no.** Memory alone (3 GB at N=100) ends
it, before the 116× random-access overrun and the 100% scrub invalidation are considered.

**But the pull seam is the right change and is not what fails.** Decode wall is 2.8–9.0 ms up to
N=50 while composite is 20.9–855.2 ms. Sequential pull is nearly free, has no session cap, and no
starvation. Every measured wall is somewhere else: compositor pass count, decoder-count thrash
above ~50, per-source memory residency, and a decoder whose forward seek doesn't use keyframes.

**The honest target is not 100 live sources.** It is ~100 *nodes* with a bounded number of live
video sources — the graph shape Part 2 measured (121 nodes / 24 sources), where editing
invalidates 5–8% and the cache does its job.
