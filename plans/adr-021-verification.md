# ADR-021 instrument verification — Findings 1 and 2

Measured at **39893e2** in a fresh worktree. `webcodecs-decoder.ts` and `scene-frame-compositor.ts`
are **byte-identical between 680ddfc and 39893e2** (`git diff --stat` empty), so the earlier numbers
remain comparable. Same machine: AMD Radeon Vega 8 (integrated), real Chrome, real WebCodecs.

**Headline: my mechanism claim was wrong, my conclusion survives for a different reason, and the
Finding-2 challenge is correct — the ADR's playback claim must be replaced.**

---

## Finding 1 — the intra arm is VALID. The mechanism I published was not.

### The cheapest question first: is the file actually all-intra?

| file | `stss` box | sync samples (ffprobe) | size |
|---|---|---|---|
| p3-gop12.mp4 | present | 50 / 600 = **8.3%** | 31.2 MB |
| p3-gop2.mp4 | present | 300 / 600 = **50.0%** | 83.6 MB |
| p3-intra.mp4 | **absent** | 600 / 600 = **100.0%** | 48.3 MB |

**The file is genuinely all-intra.** One correction to the brief's premise: these were encoded with
**ffmpeg** (`-g 1 -keyint_min 1`) in `pull-media-gen.sh`, not via WebCodecs, so the
"encoder may ignore `keyFrameIntervalSeconds`" concern doesn't apply here.

### Then the real risk: does *our stack* see those keyframes?

`p3-intra.mp4` has **no `stss` box**, which per ISO 14496-12 is the correct way to say "every sample
is sync" — and is exactly the inversion `gop-probe.ts`'s docstring warns about. The decoder even has
a fallback for it (`webcodecs-decoder.ts:271-281`): when `syncCount === 0`, only sample 0 is marked
key, which would collapse `keyIndices` to `[0]` and disable the forward re-seek entirely.

That was my hypothesis. **It is refuted.** Running our own parser (`probeGopProfile`, same mp4box
the export demuxer uses) over the actual bytes:

| file | samples | keyframes seen | maxGap | p95Gap |
|---|---|---|---|---|
| p3-gop12.mp4 | 600 | **50** | 12 | 12 |
| p3-intra.mp4 | 600 | **600** | 1 | 1 |

mp4box synthesises `is_sync = true` for every sample when `stss` is absent. So `syncCount` is 600,
the fallback never fires, `keyIndices` has all 600 entries, and `keyAtOrBefore(i) === i`.
**The intra arm tested intra. F1 and F5 stand.**

*(`p3-gop2.mp4` returns `null` from `probeGopProfile` — it is 83.6 MB, over that probe's own
`MAX_PROBE_BYTES = 64 MB` guard. Expected, not a failure.)*

### So where does the cost come from? Counted, not inferred.

`wcDecoderResetStats.hardReset` is exported, so resets can be counted per request without touching
production code. 25 samples per pattern:

| jump | gop12 resets/req | gop12 p50 | gop2 resets/req | gop2 p50 | intra resets/req | intra p50 |
|---|---|---|---|---|---|---|
| +1f | 0.00 | 0.0 | 0.00 | 0.1 | 0.00 | 0.2 |
| +4f | 0.00 | 5.6 | 0.00 | 10.8 | 0.00 | 8.1 |
| +12f | 0.00 | 16.3 | 0.00 | 34.6 | 0.24 | 19.7 |
| +30f | **1.00** | 44.9 | **1.00** | 43.9 | **1.00** | 33.7 |
| +90f | **1.00** | 47.5 | **1.00** | 47.8 | **1.00** | 39.8 |
| −1f | 0.16 | 0.0 | 0.52 | 45.0 | 1.00 | 45.3 |

**My published mechanism ("forward jumps never re-seek") is false.** The forward path at
`webcodecs-decoder.ts:818-821` re-seeks exactly as the brief says, and the counter proves it fires:
1.00 resets/request at +30f and +90f on all three encodings.

**The true mechanism is a fixed per-reset cost.** On an all-intra file a reset means decoding
*one* frame — yet +30f still costs 33.7 ms. That 33.7 ms is decoder `reset()` + `configure()` +
re-feed + first-output latency, and it is nearly encoding-independent. Decomposing:

- fixed reset+reconfigure: **≈ 34 ms** (intra, 1 frame decoded after the reset)
- GOP walk on top: **≈ 11 ms** on GOP-12 (44.9 − 33.7, ≈ 11 frames × ~1 ms)

Two secondary observations: below the reset threshold cost rises with distance because decode is
sequential and *correctly* so (in-GOP targets); and intra's 0.24 resets/req at +12f shows the feed
window runs ahead of the presented frame, so small jumps land in already-fed territory.

### Verdict on the intra demotion

**The conclusion survives; the reason changes.** All-intra media buys **~25%** of a random seek
(33.7 vs 44.9 ms), not the order of magnitude the ProRes/DNxHD analogy implies, because the
dominant term is the fixed reset the media cannot influence. Against a 1.0 ms/source budget, 33.7 ms
and 44.9 ms are the same answer: no.

So intra stays demoted — but the ADR text must be rewritten. The lever it identified ("teach the
forward path to seek to the nearest sync sample") **does not exist: that code is already correct.**
The real lever is reducing the cost or the frequency of decoder resets.

---

## Finding 2 — you are right. The ADR measured the wrong cache.

100% node-output invalidation on a time change is the correct number for a *node* cache and says
nothing about a *frame* cache. A frame cache's behaviour is a **capacity** property, not a graph
property. Measured accordingly.

### Memory

One 1920×1080 RGBA8 frame = **7.91 MB**. One second at 30fps = **237 MB**.

| budget | 1080p seconds | 1080p frames | 720p seconds | 720p frames |
|---|---|---|---|---|
| 256 MB | 1.1 | 32 | 2.4 | 72 |
| 512 MB | 2.1 | 64 | 4.8 | 145 |
| **1024 MB** | **4.3** | **129** | 9.7 | 291 |
| 2048 MB | 8.6 | 258 | 19.4 | 582 |

### Hit rate, at a 1 GB / 1080p budget (129 frames = 4.3 s)

| scenario | range | LRU | random-evict |
|---|---|---|---|
| (a) play 2s, scrub back over it | 60f | **100.0%** | 100.0% |
| (a) play 4s, scrub back over it | 120f | **100.0%** | 100.0% |
| (a) play 8s, scrub back over it | 240f | 53.8% | 39.2% |
| (a) play 20s, scrub back over it | 600f | 21.5% | 15.7% |
| (b) loop 2s × 4 passes | 60f | **100.0%** | 100.0% |
| (b) loop 4s × 4 passes | 120f | **100.0%** | 100.0% |
| (b) loop 8s × 4 passes | 240f | **0.0%** | 27.6% |
| (b) loop 20s × 4 passes | 600f | **0.0%** | 1.0% |

(c) param change and (d) rewire are **0%** by construction — the graph content hash changes, so
every cached frame's key is stale. Correct and expected, exactly as the brief predicted.

**Within capacity, playback-from-cache is a 100% hit.** That is the AE RAM-Preview / Fusion
render-cache behaviour, and it works.

**One non-obvious result worth designing against:** LRU on a looped range *larger* than capacity is
the textbook cyclic worst case — it evicts precisely the frame needed next, giving **0.0%** where
random eviction still returns 27.6%. Eviction policy is a real decision here, not a detail.

### Cost to populate the cache

| resolution | MB/frame | CPU `readPixels` p50 / p95 | GPU `copyTexSubImage2D` p50 / p95 |
|---|---|---|---|
| 1920×1080 | 7.91 | **11.00 / 54.10 ms** | **0.10 / 0.20 ms** |
| 1280×720 | 3.52 | 5.90 / 9.10 ms | 0.00 / 0.30 ms |

GPU-side retention is effectively free to write (0.10 ms) but spends VRAM — and on this integrated
part VRAM *is* system memory, so 129 frames is 1 GB of the same pool. CPU readback costs 11 ms p50
against a 33.3 ms budget, shared with the render that produced the frame, and has an ugly 54 ms p95
tail because `readPixels` is a pipeline stall.

### Verdict

**"Playback-from-cache is not viable" is wrong and must be struck.** The supported claim is:

> A frame cache keyed on (graph content hash, t) gives 100% hits for scrub-back and looping
> **within a work range of ~4 seconds at 1080p per GB**, which is the AE RAM-Preview model. It does
> not cache a whole timeline, and it correctly drops everything on any graph edit.

That makes **"scrub is cached, not live" a viable interaction model** for a bounded work range —
which changes the ADR's interaction model, as you anticipated.

---

## The cheap question: does the 5.4 s backward stall reach live playback?

**Yes, the code path is shared — but no, users do not see a 5.4 s freeze.**

`preview-frame-pool.ts:1240` builds providers via the same factory with `frameBudgetMs: 24`, and
`WebglMediaLayer.tsx` consumes that pool, so live playback runs this decoder. The 5.36 s constant is
`Promise.race([decoder.flush(), rejectAfter(5000)])` (lines 874, 963) — a 5-second flush bail-out.

Measured both modes on the same backward sweep, 40 samples:

| file | mode | p50 | p95 | max | resets/req | calls >100ms | lag p50 | lag max |
|---|---|---|---|---|---|---|---|---|
| gop12 | export (no budget) | 0.0 | **5359.8** | 5373.6 | 0.13 | **10** | 0.00 s | 0.10 s |
| gop12 | preview (budget 24 ms) | 0.0 | **28.6** | 28.7 | 0.13 | **0** | 0.00 s | **11.90 s** |
| intra | export (no budget) | 42.4 | 66.2 | 69.2 | 1.00 | 0 | 0.00 s | 0.00 s |
| intra | preview (budget 24 ms) | 26.1 | 45.8 | 49.8 | 1.00 | 0 | 11.33 s | 11.97 s |

The preview budget does its job: **no call exceeds ~29 ms and none exceeds 100 ms.** The cost is
paid as *staleness* instead — the served frame runs up to **11.9 s behind** the requested time,
which is the documented deliberate behaviour ("HOLD the last frame instead of playing the gap
fast-forward"). So scrubbing backwards gives a held/stale picture that catches up, not a frozen tab.

**This does not outrank the ADR.** It is a bounded, designed trade-off in preview. The 5.4 s bail is
real in **export**, where there is no budget — worth a note, not a programme, since export is
forward-only in normal operation.

---

## Recorded as a defect, independent of this architecture

`fetchSourceBlob` loads and holds the **entire** source file in memory for the provider's lifetime,
so per-source residency scales with clip *length*, not resolution. Measured at ~25 MB/source with
3-second clips; a 2-minute 1080p source would hold tens of times that. This is why memory is the
first hard wall at N=100 (2546 MB delta). **It is a defect on its own terms and wants a DEBT entry.**
I have not edited `project-tracker/architectural-debt.md` — a sibling session has it modified.

---

## ADR status

**Held Provisional and uncommitted, as instructed.** Two edits are now required and are NOT yet
applied:

1. **§3.3** — the mechanism paragraph is wrong (cites the reclaimed-decoder block; claims forward
   jumps never re-seek). Replace with the fixed-reset decomposition. The intra demotion stands, but
   its stated lever ("teach forward seek to use sync samples") must go — that code is already
   correct.
2. **§3.2(c) and step 3** — "the cache is an editing accelerator, not a playback mechanism" must be
   split into node cache vs frame cache, with the capacity table and the ~4 s/GB work-range model.
