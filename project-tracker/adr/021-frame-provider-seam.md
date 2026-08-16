# ADR-021 — The frame-provider seam: sources are pulled, not bridged into fake timeline clips

- Status: **Accepted** (normative). The DECISION (§2) and the seam (§4) are accepted and not
  provisional. The MEASURED LIMITS (§3) were "Provisional until step 2 ships"; **step 2 shipped
  2026-08-15** and they are now **tested at N=12 on real footage in a real tab, untested above it** —
  the lift is partial and scoped, see **§8.1**, which also records what the gate did NOT license.
- Date drafted: 2026-08-10
- Date accepted: 2026-08-10
- Governed by: `FLAREX_IMPLEMENTATION_GOVERNANCE.md`

```
Depends on:  ADR-007 (compiler contract), ADR-008/009/010 (evaluation engine — NOT reopened),
             ADR-012 (the kernel is the runtime), ADR-013 + ADR-020 (media acquisition)
Supersedes:  nothing
Amends:      nothing
Evidence base: plans/adr-021-pull-model-feasibility.md       (measured at 680ddfc, 2026-08-10)
               plans/adr-021-verification.md                 (measured at 39893e2, 2026-08-10)
Corrections:  §3.2(c), §3.3 and §6 step 3 were corrected on 2026-08-10 after instrument
              verification. Superseded text is retained in place, marked, with the reason.
Related debt: DEBT-013 clause (a), DEBT-019 (whole-file source residency)
```

> **ADR-019 is reserved** for the expression contract (ADR-018 §27: "the expression contract moves
> to ADR-019"). This is 021 because 020 is taken; the gap is deliberate, not an error.

---

## 0. What this does NOT reopen

**ADR-008, ADR-009 and ADR-010 froze how a node's picture is computed. They stand, unamended.**
This ADR changes only **what feeds the evaluator**: where a source's pixels come from. The
evaluator stays node-type-blind (ADR-010), the content hash keeps its exact meaning and its
time-invariance (ADR-009), and the lowering compiler remains the parity contract (ADR-007).

Reading "sources become frame providers" as "rewrite the compositor" exceeds this ADR's scope.

Also not reopened: the **2D/2.5D capability boundary** (founder, 2026-08-09). It is settled input
here, not a question.

---

## 1. Context — the defect, and why the fix is smaller than it sounds

Every asset-source `MediaIn` is bridged into playback as a synthetic off-timeline `TimelineLayer`
(`collectFlarexVirtualLayers`) that runs through the timeline's per-layer media pipeline and
acquires a live decoder session. That adapter is why Phase 2 shipped quickly and it is not a
mistake — but it inherits an assumption that is false for a compositor: that a small, fixed number
of sources play at once. The preview pool caps sessions at 4 with one hardware slot reserved
(`MAX_WC_TOTAL_SESSIONS` / `HARDWARE_RESERVED_SLOTS`), so **the loader ceiling is 3 regardless of
host**, and the 4th MediaIn is denied at mount and never re-admitted (DEBT-013 clause (a)).

**The target model already exists in this repo, in the export path.**
`SceneFrameCompositor.gradeMediaLayer` obtains pixels by `await source.getFrame(sourceTime)` — a
pull, per source, per frame, with no session, no cap, no starvation. This is Fusion's and Nuke's
model. The convergence is therefore *make playback consume the interface export already consumes*,
not *write a second engine*. It also collapses a standing bug class: preview and export disagreeing
because they are two machines kept in agreement by gates.

---

## 2. Decision

**Adopt the pull-based frame-provider seam as the media boundary for the Flarex compositor**, with
a content-addressed cache behind it, per the four-step sequence in §6.

**Adopted with the limits in §3, which are measured, not estimated.** The founder's stated target
of Fusion-equivalent capability in ~95% of cases stands; the ~100-node figure does not survive
contact with measurement in the form "100 live video sources", and this ADR records the corrected
target rather than the aspirational one.

---

## 3. What measurement establishes, and what it refuses

Full method and tables: `plans/adr-021-pull-model-feasibility.md`. Measured on an AMD Radeon
Vega 8 (integrated) in real Chrome with real WebCodecs — the target hardware class.

### 3.1 The seam is vindicated (claim: supported)

Driving the real export pull path over N distinct 1280×720 sources, **decode is not the
bottleneck** up to N=50:

| N | warm frame total | decode wall | composite |
|---|---|---|---|
| 1 | 23.7 ms | 2.8 ms | 20.9 ms |
| 10 | 154.1 ms | 4.7 ms | 149.4 ms |
| 50 | 864.2 ms | 9.0 ms | 855.2 ms |
| 100 | 2080.4 ms | 1139.5 ms | 940.9 ms |

Cost is **linear** in N (per-source flat at 13–24 ms; cost(100) < 2.5 × cost(50)). Warm sequential
`getFrame` is ~0.03–0.1 ms per source. A pull model degrades predictably instead of hitting the
session cliff the adapter has today.

### 3.2 The limits, each of which must be designed for

**(a) Memory is the first hard wall.** ~25 MB per live source; **2546 MB delta / 2991 MB total at
N=100**, with 3-second clips. `fetchSourceBlob` holds whole files in RAM, so residency scales with
clip *length* — registered separately as **DEBT-019**, because it is a defect whether or not this
ADR ships. A browser tab does not survive this. **Any implementation must bound live providers by a
memory budget in BYTES, not by a count** — a count is only a proxy for bytes while clip lengths are
similar, and DEBT-019 is precisely why they are not.

**(b) Random access costs ~100× its budget.** Random `getFrame` p95 is **100.4 ms with an all-intra
proxy**, against a 1.0 ms/source budget for 10fps scrub at N=100. Interactive scrub across 100
live-decoding sources is arithmetically impossible.

**(c) A scrub invalidates every NODE OUTPUT.** Measured on the real `dependency-graph.ts` closure
over a 121-node graph: dragging a param dirties **7.4%**, rewiring an edge **5.0%**, changing a
source **8.3%** — but **scrubbing one frame dirties 100%**, and narrowing the `time` axis to genuine
time-dependents only moves it to **99.2%** in an all-video comp, because every node really is
downstream of something that changes with t. Only genuinely time-invariant subtrees (stills,
generators) benefit: a 1-in-3-generator graph drops scrub invalidation to 74.4%.

> ~~**Therefore the cache is an editing accelerator (92–95% hit), not a playback mechanism.** Any
> plan that assumes playback-from-cache is unfunded.~~
>
> **SUPERSEDED 2026-08-10 — this generalised from the wrong cache.** The 100% figure above is
> correct, and it is the right number for a **node-output cache**. It says nothing about playback,
> because the cache that makes playback work is a **different object**: a **frame cache** holding
> the *composited output* at time t, keyed on `(graph content hash, t)` — After Effects' RAM Preview
> and Fusion's render cache. A time change invalidating every node output is exactly what you would
> expect of a node cache and is *orthogonal* to whether a frame cache works. See **(c′)**.

**(c′) The frame cache is a CAPACITY property, not a graph property.** Its behaviour is decided by
residency, not by the dependency closure:

| | 1080p | 720p |
|---|---|---|
| one RGBA8 frame | **7.91 MB** | 3.52 MB |
| one second @30fps | **237 MB** | 106 MB |
| per 1 GB of budget | **~4.3 s (129 frames)** | ~9.7 s (291 frames) |

At a 1 GB / 1080p budget, measured hit rates: **scrub back over ground already played — 100%**, and
**loop a range — 100%**, for ranges inside capacity (2 s and 4 s). A param change and a rewire
invalidate **everything, 0%, by construction** — the graph content hash changes, so every cached
frame's key is stale. That is correct and expected, not a limitation.

Cost to populate it: GPU-side retention (`copyTexSubImage2D`) is **0.10 ms** but spends VRAM, which
on an integrated part is system memory; CPU readback (`readPixels`) is **11.0 ms p50 / 54.1 ms p95**
against a 33.3 ms frame budget, shared with the render that produced the frame.

**So "scrub is cached, not live" IS supported — bounded to a work range of ~4.3 s per GB at 1080p.**
That is the RAM-Preview model: it does not cache a timeline, it caches a work area.

### 3.3 A deferred supporting item is retired on evidence — FOR RANDOM ACCESS ONLY

The deferral entry lists an **all-intra proxy variant** as a supporting item, on the ProRes/DNxHD
reasoning that intra-frame media is what makes a pull model cheap. **Measurement does not support
this for random access.**

> ~~At `webcodecs-decoder.ts:779-782`, a keyframe re-seek happens only on the first call or a
> **backward** jump; a **forward** jump falls through and decodes every intermediate frame. So
> forward-seek cost rises linearly with distance (~1.4 ms/frame) **at the same rate on both
> encodings** — an all-intra proxy cannot help forward access at all until that path learns to seek
> to the nearest sync sample.~~
>
> **SUPERSEDED 2026-08-10 — the mechanism was wrong, twice over.** The cited lines are the
> reclaimed-decoder recreation block, not the forward path. The forward path is
> `webcodecs-decoder.ts:818-821` (`const forwardKey = keyAtOrBefore(chunkIndexForMicros(micros));
> if (forwardKey > fed) resetTo(...)`) and it **already does** re-seek to the nearest sync sample,
> keeping sequential decode only for in-GOP targets, which is correct. Counting
> `wcDecoderResetStats.hardReset` per request confirms it fires: **1.00 resets/request at +30f and
> +90f on all three encodings.** A second hypothesis — that an all-intra file with no `stss` box
> would be misread as having one keyframe via the `syncCount === 0` fallback at lines 271-281 — was
> also **refuted**: our own parser reports `p3-intra.mp4` as **600 samples / 600 keyframes**, so
> mp4box synthesises the flags correctly and the fallback never fires. The intra arm was valid.

**The measured mechanism is a fixed per-reset cost of ~34 ms** — `decoder.reset()` + `configure()` +
re-feed + first-output latency. On an all-intra file a reset means decoding exactly **one** frame,
yet a +30f jump still costs **33.7 ms**. The GOP walk is a smaller term on top: GOP-12's +30f costs
**44.9 ms**, and the ~11 ms difference is ≈11 frames of post-keyframe decode at ~1 ms each.

Against a 1.0 ms/source budget, **33.7 ms and 44.9 ms are the same answer.** Intra buys **~25% of a
random seek**, not an order of magnitude, because the dominant term is a reset the media cannot
influence.

Its price is lower than assumed: **1.55–1.80×** file size at matched CRF, not the estimated 2–4×.
(Caveat against my own result: synthetic constant-motion content understates the ratio; real
static-camera footage would push it toward 2–3×.)

**Decision: an all-intra proxy is NOT a prerequisite for random access, and is demoted from the
programme's front on that basis.** The ordered levers are now:

1. **Reduce the COST of a reset.** Open question, deliberately not measured this round (§9).
2. **Reduce the FREQUENCY of resets** — a frame cache (§3.2(c′)), a scheduler that prefers
   sequential access, and read-ahead so a jump lands inside the already-fed window. The counters
   show this is reachable: at +12f the intra arm resets on only **0.24** of requests, because the
   feed window already ran past the target.
3. Intra media, for its tail behaviour only.

> **SCOPE OF THIS DEMOTION — read it narrowly.** This section demotes all-intra **for random-access
> latency**, which is the only thing measured here. It says **nothing** about all-intra for **encode
> throughput**, a different mechanism: intra encoding skips inter-frame motion estimation, the
> dominant cost in H.264 encoding, which is why professional NLEs proxy to intra codecs (ProRes
> Proxy/LT, DNxHR LB, DNxHD 36). **The proxy codec question is NOT settled by this ADR** and is
> being measured separately.

### 3.4 Note — the 5.4 s backward-seek stall is export-only

Recorded because the number is alarming and the disposition is not obvious.

Backward-seek p95 measures **5359.8 ms** on GOP-12, from
`Promise.race([decoder.flush(), rejectAfter(5000)])` (`webcodecs-decoder.ts:874, 963`) — a 5-second
flush bail-out. The same provider **does** serve live playback (`preview-frame-pool.ts:1240` builds
it with `frameBudgetMs: 24`; `WebglMediaLayer` consumes that pool), so the obvious reading is that
users feel this while scrubbing backwards.

**They do not.** Measured in both modes on the same sweep: with the preview budget, backward-seek
p95 is **28.6 ms with zero calls over 100 ms**. The budget works. The cost is paid as *staleness*
instead — the served frame runs up to **11.9 s behind** the requested time, which is the documented
deliberate behaviour ("HOLD the last frame instead of playing the gap fast-forward").

So: a **note, not a programme**. The 5.4 s stall is real in **export**, which has no frame budget,
and export is forward-only in normal operation. But **11.9 s of lag is worth someone knowing about**
even though it is working as designed — a held picture that takes twelve seconds to catch up is a
user-visible artifact, and a future change to the hold policy should know this number.

### 3.5 The corrected target

**~100 nodes: yes. ~100 concurrently-decoding sources: no.** The supported shape is ~100 nodes with
a bounded live-source set — measured at 121 nodes / 24 sources. There is additionally a
decoder-count ceiling between N=50 and N=100 where concurrent WebCodecs decoders thrash (decode
wall 9.0 → 1139.5 ms).

---

## 4. The seam

Defined precisely enough for two implementers, because **there are two from the start**: the
browser (WebCodecs) and the native runtime at `Documents/orreris` (its own decode path). ADR-012
already requires a kernel usable "from a future native host without behaviour change"; this is the
same property one layer down. The graph, the content-hash cache keys and the resulting pixels are
shared; **only the provider differs.**

The seam is the interface `apps/web/src/export/source-decoder.ts` already defines. It is adopted,
not invented:

```ts
interface FrameProvider {
  readonly width: number;
  readonly height: number;
  /** The picture at `sourceTimeSeconds`. Provider-owned; valid until the next call or dispose. */
  getFrame(sourceTimeSeconds: number): Promise<CanvasImageSource | null>;
  readonly nominalFps?: number | undefined;
  readonly decodableEndSeconds?: number | undefined;
  dispose(): void;
}
```

### 4.1 Normative obligations

**I-P1 — Pull, never push.** A provider never notifies, schedules or renders. It answers
`getFrame(t)` and nothing else. It holds no session, claims no slot, and has no priority. This is
what removes the cap and the starvation.

**I-P2 — Ownership is the provider's.** The returned frame is valid until the next `getFrame` on
that provider or `dispose()`. Callers draw synchronously and must not close it. (Unchanged from
today's contract — stated because a second implementer needs it stated.)

**I-P3 — Time is the only input.** No frame numbers, no rate, no direction hint. A provider must
answer any `t` in range, in any order. Ordering is an optimization the provider may exploit
(today's forward cursor), never a requirement it may impose.

**I-P4 — Never null for an in-range t.** Past `decodableEndSeconds`, clamp to the final frame.
Absence must be distinguishable from "not ready" — this is the DEBT-015 class, where a silent null
shipped a frame with a layer missing.

**I-P5 — `decodableEndSeconds` is authoritative over container metadata.** Container duration
routinely overshoots the true decodable end; a consumer that trusts metadata bakes in a frozen tail.

**I-P6 — Bounded by memory, not by count.** A provider set must be evictable against a byte budget.
§3.2(a) is the reason this is normative rather than advisory: 25 MB per source × an unbounded set
is a dead tab. Eviction is `dispose()` + reconstruct; providers must therefore be **cheap to
recreate and expensive only once** (cold construction is 94–238 ms and serializes — that is the
cost eviction pays, and it is why the budget must evict rarely).

**I-P7 — Caches sit BEHIND the seam, and there are two of them.** A provider is not a cache and must
not become one.
- The **node-output cache** keys on `(ContractVersion, ContextVersion, NodeContentHash)` — unchanged
  from ADR-009. Time is **not** folded into the content hash (§3.2(c)).
- The **frame cache** keys on `(graph content hash, t)` and holds composited output (§3.2(c′)).

They are different objects with different keys and different lifetimes, and a claim proven about one
does not transfer to the other — the correction recorded in §3.2(c) exists because that transfer was
made once already.

**I-P8 — Two implementers, one behaviour.** Any observable difference between the browser and
native providers other than *latency* is a defect. Same `t` → same picture. This is what stops two
compositors from being built.

**I-P9 — Eviction policy is a DECISION, and LRU is disqualified for the frame cache.** Not left to
whoever implements it. Looping a range is one of the two things playback actually *is*, and LRU on a
cyclic access pattern larger than capacity is the textbook worst case: it evicts precisely the frame
needed next. Measured at a 1 GB / 1080p budget (129 frames): an **8 s loop hits 0.0% under LRU and
27.6% under random eviction**; a 20 s loop, 0.0% vs 1.0%. Within capacity both are 100%, so the
policy only shows itself at the cliff — which is exactly where a user with a long work area lives.
**Any frame cache here must use an eviction policy that degrades gracefully on cyclic access**
(random, or a retain-the-work-area policy); LRU is ruled out by measurement, not by taste.

### 4.2 What the seam deliberately does NOT specify

Decode strategy, threading, GOP handling, caching inside the provider, and hardware/software
selection are all implementation. The seam is `t → picture`; everything in §3.3 is a provider-local
optimization that must not leak into it.

---

## 5. Out of scope

Explicitly out, and not deferred-for-later — **out**:

- **3D**: 3D geometry, mesh import (FBX/Alembic), lights/materials, a 3D renderer, particles. In
  scope is 2D and **2.5D**: layers in Z under a camera, parallax, card-based compositing.
- **Deep (EXR deep-pixel) compositing** and heavy multi-channel CG integration at film resolution.
- **OFX plugin ecosystems.**
- **Render-farm distribution.**
- **Feature-film VFX as a target user.** Targets are motion designers, commercial finishers,
  YouTube/social editors, and small studios doing cleanup, screen replacement, beauty work, titles.

The browser's per-tab memory ceiling makes several of these structurally out, not merely
unprioritized — §3.2(a) is the measurement that says so.

Also out of this ADR (deferred, not rejected): **region-of-interest evaluation**, and the
**timeline's** own migration beyond step 4.

---

## 6. Sequence

Each step must ship a **user-visible win on its own** — the standing rule against
finished-but-unused infrastructure. **Explicitly rejected: building the new engine alongside the
old and switching at the end.**

**Step 1 — Name the seam.** A decision, not code: this ADR, §4. Win: the native runtime and the
browser stop being able to diverge silently.

**Step 2 — Move the Flarex page onto it.** Smallest blast radius, and the surface that actually
hurts. Win: **the loader ceiling of 3 disappears** — the 4th MediaIn stops being denied at mount
(DEBT-013 clause (a)). Must ship with the I-P6 memory budget, because §3.2(a) says an unbounded
provider set at N=100 is a dead tab. Provisional status lifts when this ships.

> **SHIPPED 2026-08-15.** Measured 3 → 12 concurrently rendering loaders on one wired comp, 0 denials,
> 0 evictions, 706 MB peak of a 768 MB budget, with the pool arm exhibiting its own ceiling in the same
> run. The I-P6 budget is bytes, never a count, as required. Full result and its limits: **§8.1** — in
> particular, 12 sources acquire but do not stay temporally coherent under playback, which is §7
> behaving as documented and is not a regression.

**Step 3 — The caches behind the seam. There are TWO, and they are different objects.**

- **3a — the node-output cache**, keyed on the ADR-009 hashes that already exist and already drive
  node thumbnails. Win: **editing a big graph stops re-evaluating it** — measured 92–95% reuse for
  param-drag, rewire and source-change. Claimed for **editing only**; §3.2(c) forbids claiming it
  for playback.
- **3b — the frame cache**, holding composited output at t, keyed on `(graph content hash, t)`.
  Win: **scrub-back and loop over a work range become instant** — 100% hit inside capacity. Bounded
  to ~4.3 s per GB at 1080p (§3.2(c′)), and must satisfy **I-P9** on eviction policy.

  Each ships a win alone and 3b does not depend on 3a: a frame cache is keyed on the whole graph's
  hash and needs no per-node reuse.

> **SCOPING FINDING, 2026-08-15 — 3a APPEARS TO BE ALREADY SHIPPED, and this needs a founder ruling
> rather than an implementer's assumption. Recorded, deliberately NOT acted on.**
>
> Scoping 3a after step 2 landed turned up not one but two shipped mechanisms that together look like
> the whole of its stated win, both predating this ADR and both delivered by the evaluation-engine and
> kernel work §0 says this ADR does not reopen:
>
> 1. **The content-addressed materialization cache** (evaluation engine, Slice 2). `compile-flarex.ts`
>    stamps `contentHash` — "the pure NodeContentHash" — on cacheable artifacts and deliberately leaves
>    it unset where a stale hit is possible (unversioned or live-media sources); `scene-compositor.ts`
>    consumes it; `flarex-node-thumbnails.ts` keys on `(ContractVersion, contentHash)`, which is the
>    "hashes that already exist and already drive node thumbnails" this step names as its input.
>    It has its own cross-frame parity gate, `flarex:cache-gate`, which asserts warm-vs-cold pixel
>    identity AND that a static comp actually registers hits ("a cache that never hits is trivially
>    parity-clean and completely worthless").
> 2. **Per-node incremental reuse** (ADR-012 slices S6.4/S6.5/S6.6, `playback/incremental-evaluation.ts`),
>    live and unconditional in `ScenePreviewCanvas`'s composite path, driven by the same
>    `dependency-graph.ts` closure §3.2(c) measured, over content/context/time/source axes.
>
> **So the risk this note exists to prevent is a THIRD cache.** §6 as written sends the next implementer
> to build 3a from scratch; on this evidence the work is to *verify 3a's win against the mechanisms
> already in the tree* and close the step, or to name precisely what they do not cover. What is NOT
> claimed here: that the shipped keys are the ones I-P7 specifies (they are not — the shipped node reuse
> keys on `nodeId@time` with axis invalidation, not on `(ContractVersion, ContextVersion,
> NodeContentHash)`), nor that the 92–95% edit-reuse figure has been re-measured on the live editor.
> Both are cheap to settle and neither was settled tonight.
>
> **3b is unaffected and is genuinely absent** — a search for a composited-output cache finds nothing.
> It remains the real remaining half of step 3, with I-P9's eviction ruling attached.

> **3a CLOSED-OUT 2026-08-16 — no cache is to be built, and the step's CLAIMED WIN does not survive
> measurement. Both halves of the scoping note above are now settled, and one of them the other way.**
>
> **(1) I-P7's key is IMPLEMENTED, verbatim — the scoping note compared it against the wrong object.**
> `SceneCompositor.contentCacheKey` (`scene-compositor.ts:3443`) is
> `` `${CONTENT_CACHE_CONTRACT_VERSION}|${nestW}x${nestH}|r${RENDERER_REVISION}|el:${effectLight}|${draw.contentHash}|${draw.dependencyVersions}` `` —
> ContractVersion, ContextVersion (its own comment: "the SINGLE site that builds the ContextVersion"),
> NodeContentHash, plus the ADR-010 opaque dependency tokens. `content-hash.ts`'s header states the
> formula it implements as "ADR-009: CacheKey = (ContractVersion, ContextVersion, NodeContentHash)".
> The note's caveat measured I-P7 against the *incremental evaluator*, which is a different object.
>
> **(2) The difference IS material anyway, and what breaks is now measured.** The incremental evaluator
> runs FIRST and short-circuits the whole upstream subtree (`compile-flarex.ts:1394`, deliberately
> "placed BEFORE lowering"), so when it reuses, the correct key is never consulted. Its own content
> signature is hand-rolled — `type | enabled | RAW params` (`incremental-evaluation.ts:116`) — and a
> Flarex keyframe lives in `comp.animations`, which that signature does not read. So the stronger key
> is present in the tree and is bypassed by a weaker one sitting above it. Registered as **DEBT-022**;
> falsified both ways by `pnpm --filter @orreris/worker flarex:incremental-gate`.
>
> **(3) The 92–95% figure is NOT reproduced on a real graph with real footage.** Re-measured by
> `flarex:reuse-measure` — a comp built through the product's own import and add-MediaIn flow (12 real
> renders, 61 nodes over 12 asset sources), captured from the live editor, then driven through the real
> `dependency-graph.ts` closure:
>
> | edit | reusable | §3.2(c) said |
> |---|---|---|
> | none (counterweight) | 100.0% | — |
> | param drag @ HEAD source | **75.4%** | 92.6% |
> | param drag @ TAIL source | **91.8%** | 92.6% |
> | rewire one edge | **78.7%** | 95.0% |
> | source change (media epoch) | **0.0%** | 91.7% |
> | slider drag on an ANIMATED param | 100.0% | *should invalidate* — DEBT-022 |
>
> Two corrections follow. **The param figure is a property of graph SHAPE, not a constant**: the same
> edit reuses 75.4% at the head of a merge chain and 91.8% at the tail, because a head edit flows
> through every merge below it. A single number for "param drag" is an artifact of which node the
> harness picked, and §3.2(c)'s synthetic graph picked a kinder one. **And a source change dirties
> EVERYTHING, not 8.3%**: `mediaEpoch` is a SUM over all pool entries, so any one source decoding a new
> picture marks the `source` axis and dirties every `mediaIn` — documented as deliberate conservatism
> ("ANY new picture invalidates every MediaIn"), but it means the 8.3% figure does not describe a comp
> with live video at all.
>
> **(4) In the live editor the mechanism registered ZERO reuse.** `__rfIncremental` after settle:
> `reused=0 · evaluated=7140 · frames=282`, with `dirtyNodes 61/61`; a steady-state delta sampled 8 s
> apart caught exactly one composite, which evaluated all 60 nodes and reused none. That is not a
> broken cache — it is (3) restated: on a video comp the only thing that WAKES the compositor is a
> decode, and a decode invalidates globally. The cache can only pay off on a recomposite triggered by
> an EDIT, which is what the table measures.
>
> **DEBT-022 FIXED 2026-08-16**, by founder decision, before 3b — because 3b sits ON TOP of it: a
> frame cache recomputes on a miss, and the recompute runs through this evaluator, so 3b would have
> inherited the staleness and any stale-picture report would then have had two candidate causes in two
> layers. The compiler now hands its `NodeContentHash` to the host's reuse check (threaded, not
> recomputed — the host cannot compute it correctly, because this compile's time is
> `t − layer.startSeconds` and the host knows only `t`). `flarex:incremental-gate` is green 9/9 and no
> edit class lost reuse; the full before/after table is in DEBT-022's closing update.
>
> **RULING. Do not build a third cache — I-P7's cache exists and is correct.** What §6 called step 3a
> is therefore not construction work; it is two defects and a corrected claim. **§6's "measured 92–95%
> reuse" line should be read as superseded by the table above.** The remaining work is DEBT-022 (an
> invalidation term, not a cache) and, optionally, narrowing the `source` axis from a global sum to
> per-source epochs — which is the only change that would make the live reuse rate non-zero, and which
> is NOT proposed here because it is a behaviour change to shipped ADR-012 code with its own risk.

> ~~Claimed for editing only; §3.2(c) forbids claiming it for playback.~~ — the blanket form of this
> is superseded; it holds for 3a and not for 3b. See §3.2(c′).

> **3b SHIPPED 2026-08-16 — the composited-frame cache, its gate, and its host wiring.**
>
> **The gate was built before the cache**, on founder instruction, and the ordering earned itself
> immediately. A frame cache's characteristic failure is a STALE SERVE, which does not present as a
> caching bug — it presents as a rendering bug, and `render:compare:pixels` is structurally blind to
> it (one frame per fixture is the only case where a frame cache is trivially correct).
> `flarex:frame-cache-gate` renders every scenario WARM (cache on) against COLD (fresh compositor per
> frame, cache off) and compares frame by frame, plus exact predicted HIT COUNTS, the settle gate, and
> eviction. `FRAME_CACHE_SABOTAGE=drop-t|drop-graph` breaks the key on purpose and both must make it
> fail — they do, 16 failures and 2 respectively. The first sabotage run caught a defect in the GATE:
> its edit fixture moved the content hash without moving pixels, so the oracle was comparing two
> identical pictures and could not fail. Fixed; both arms now fire.
>
> **The key is `(graph content hash, t)`, with the graph term taken from the ADR-009 hashes and NOT
> from the draw list** — a draw list is the output of the computation the cache exists to skip.
> `compileFlarexComp` stamps the root `NodeContentHash` onto the draw it emits (`flarexContentToken`,
> transport only); `build-scene-draws` appends the layer's own identity digest, because the graph hash
> is total over the GRAPH and blind to everything the TIMELINE decides — where the clip sits, its trim,
> its wrapping effects. The layer is folded WHOLE rather than field by field: an enumerated list of
> "the fields that matter" is the shape of DEBT-016, and it is memoized on object identity, so an
> immutable layer is serialized once.
>
> **The matte vector/raster tag was CHECKED, not assumed, and needs no term of its own.** Enumerating
> its producers: mask nodes always yield vector; `matteInput` yields raster when the socket is fed by
> an image (topology); `matteControl` degrades to raster only when an input already is one, and its
> feather/invert route reads node params via `num(at, node, …)`. Every term is node type, topology or a
> resolved param — exactly what R1+R3 fold. The one exception is a 2D-context allocation failure, an
> environment degrade rather than a content variable.
>
> **I-P9 is satisfied, and note the inversion.** This cache evicts at RANDOM; its sibling
> `ContentArtifactCache` uses LRU and is right to — access pattern decides, not consistency, because
> node artifacts are intra-frame fan-out while frames are a cycle. On a 20-frame cycle at capacity 8:
> **LRU 0.0%, shipped random 8.3%** in simulation, and the real GL cache measured 5 hits in 60 — 8.3%,
> agreeing with the simulation to the frame.
>
> **SCOPE, and it is narrower than the ADR's framing suggests.** A frame is cacheable only if EVERY
> draw in it carries a content token, and today only the Flarex compiler stamps one. So a frame
> containing a plain clip, a text layer, a transition, or a comp proxy is NOT cacheable and renders
> exactly as before. That is this ADR's own sequencing — step 4 is where the timeline earns the same
> identity — and widening the predicate earlier would mean inventing an identity for draws that do not
> have one, where the failure surfaces as a wrong picture rather than a miss.
>
> **THE HOST WIRING IS VERIFIED AND THE DEFAULT IS ON (2026-08-16).** `compileFlarexComp` stamps the
> token, `build-scene-draws` completes it with the layer's identity digest, `ScenePreviewCanvas`
> declares the key, and `getFrameCacheEnabled()` now returns true. Escape hatch `?frameCache=0`.
>
> **The default was decided by SPLITTING the question, because two questions were tangled in one
> fixture and only one of them is the cache's.** A Flarex comp is eligible because the COMPILER stamps
> a content token — it does not need a MediaIn to be eligible. So "is this host's key COMPLETE" can be
> asked on content with no decode in it: `FIELD_FIXTURE=deterministic` deletes the seeded video clip
> and tiles six SHAPE clips along the timeline, each in its own comp, each stop a different shape.
> Result, four runs: `eligible`, **6 of 6 frames served from cache with 0 misses and 0 declined, every
> one pixel-identical to a fresh render, noise floor 0 against a budget of 0**, and the same six hashes
> across all four runs and across page loads. The probe also re-runs its own comparison SHIFTED by one
> position and requires every shifted pair to differ, so a green run cannot be the report of an
> instrument that could not tell two frames apart in the first place.
>
> **I-P8 over the LIVE MEDIA PATH is a separate, real, registered question — DEBT-027.** Two bypassed
> sweeps in one load over real footage differ at 1–2 of 6 positions, and a longer settle does not
> converge (900→2500 ms helps, 2500→6000 ms does not). Measured with disk free and with the probe's own
> two defects fixed, so these numbers stand — unlike the readings taken on a full disk, which are void
> (DEBT-024, DEBT-025). What that costs is an ORACLE, not this cache: the identical instrument returns a
> zero noise floor on deterministic content through the same host, the same key and the same
> compositor. It does not gate 3b, and it must not be chased from the frame-cache side.
>
> **NOT a playback win, and §7 has not moved:** composite 20.9–855.2 ms against decode's 2.8–9.0 ms at
> every N. A first pass over new ground is all misses. The claim is scrub-back and loop.
>
> **Registered, not built (founder instruction):** narrowing `mediaEpoch` from a global sum to
> per-source epochs. It is the only change that would make the live steady-state reuse rate non-zero,
> and it is a behaviour change to shipped ADR-012 code with its own risk.

**Step 4 — The timeline last**, once the seam is proven on the harder case.

> **Step-4 obligation carried forward from 3b:** the resolved text DIRECTION (ADR-023 D6a) is a
> property of a timeline TEXT LAYER, not of a Flarex text node — it does not exist in `node-defs.ts`.
> It was briefly specified as a 3b key term and withdrawn by founder correction: 3b has no business
> carrying it, and there is no coupling to the parallel ADR-023 programme. When the timeline moves onto
> the seam and its layers earn content tokens, direction must be one of the terms those tokens fold.

> **STEP-4 SCOPING, 2026-08-16. The step has two independent halves and they are NOT equally ready.
> Recorded before implementation, because the second half turns out to be blocked on something that
> reads like a solved problem and is not.**
>
> **(A) Timeline layers earn content tokens** — what widens frame-cache eligibility from "a Flarex comp
> and nothing else" to ordinary frames. `layerIdentityDigest` (`build-scene-draws.ts:323`) already folds
> a `TimelineLayer` WHOLE, memoized on object identity, so the placement half is done and total by
> construction. What a token additionally needs is everything the PICTURE depends on that the layer
> object does not describe.
>
> **(B) Timeline media acquisition moves onto the byte-budgeted provider seam** — the loader-ceiling,
> I-P6 and burst-admission work step 2 did for Flarex, done for the timeline's `preview-frame-pool`.
> This is a decoder-topology change and therefore carries ADR-012's binding rule: **every decoder
> topology change requires a decoder soak, and must be bisectable.** Expect the burst-admission defect
> again — N constructions judged against a budget that starts empty is a property of any admission
> authority, not of the Flarex page.
>
> **THE BLOCKER IN (A), AND IT IS SPECIFIC. A media layer's `sourceVersion` is a WALL CLOCK, not a
> content identity.** `gl-context.ts:278` stamps `updatedAt: nowMs()` on every producer draw, and
> `build-scene-draws.ts:746` reads it as the media draw's version. That is exactly right for what it
> was built for — skip a redundant texture upload when nothing redrew — and it is useless as a cache
> key term: two visits to the same `t` produce two different values, so a token folding it would never
> hit, and a token IGNORING it would serve whatever picture the decoder happened to have. There is no
> third option available today, because the decode path does not report WHICH source time the frame it
> served actually is.
>
> Non-media layers do not have this problem: text and shape carry `rasterizer.versionOf(layer.id)`, a
> real content version (`build-scene-draws.ts:679`), dropped to `undefined` only under a non-identity
> colour pipeline — a correct, conservative refusal that a token can simply honour.
>
> **So the honest sequence is 4a → 4b → (B), and 4b shares an instrument with DEBT-027.** "Which source
> time is this frame" is the same missing fact that makes a re-render oracle unusable over live footage.
> Building it once serves both, and building the frame token on media before it exists would put a
> wrong picture behind a cache key — the one failure mode 3b's whole gate order was arranged to prevent.
>
> - **4a — non-media timeline layers earn content tokens** (text, shape, image/graphic, adjustment),
>   including the D6a direction obligation above. Win on its own: frames whose every layer is non-media
>   — title cards, lower-thirds, motion-graphics sequences — become scrub-and-loop cacheable.
> - **4b — media layers earn tokens**, once a provider can name the served source time.
> - **(B) — timeline acquisition onto the seam**, with a decoder soak and one change per commit.

> **4a SHIPPED 2026-08-16 — a TEXT or SHAPE layer now stamps its own content token, and the D6a
> obligation turned out to be already discharged.**
>
> `stampNonMediaContentToken` (`build-scene-draws.ts`) runs at the same seam `applyFlarex` does — the
> end of `buildLayerDrawWithPasses`, so every consumer path gets it uniformly — and folds
> `layerIdentityDigest(layer)`, the raster's content version, every mask version present, and a track
> matte's own token. **Scoped to `text` and `shape`**, because those are the two whose `sourceVersion`
> is a real content version (`rasterizer.versionOf` bumps on every completed rasterization, and a
> rasterization happens on every change of the raster's own key — so the picture cannot move without
> the version moving). Over-approximate and therefore safe: it costs a miss, never a wrong frame.
>
> **DECLINING IS THE DEFAULT.** No raster version (the graded-overlay path erases it deliberately),
> region-pass clones present, a group draw, a track matte whose source has no token, or a fragment
> pass carrying a mask with no version — each returns no token. The failure modes are not symmetric: a
> missing token loses a cache hit, a wrong token shows the user the wrong picture.
>
> **THE ADR-023 D6a OBLIGATION IS DISCHARGED, WITHOUT A TERM FOR IT, and the reason is the interesting
> part.** `resolveTextDirection(declared, textSource)` is a pure function of `layer.direction` and the
> layer's own text/runs, and `layerIdentityDigest` folds the layer WHOLE. So direction is in the key
> because the fold is total, not because anyone remembered it — which is precisely the argument 3b
> made for whole-object folding over an enumerated field list (the DEBT-016 shape), now paying for
> itself on a term specified two ADRs away.
>
> **Accepted on `FIELD_FIXTURE=timeline`: the same six shape clips as 3b's fixture with NO COMP ON ANY
> OF THEM**, so the only thing that can make a frame eligible is the timeline layer's own token. One
> variable between the two arms and nothing else. Green 3/3 — `eligible`, 6 of 6 served, 0 misses,
> 0 declined, all pixel-identical, noise floor 0 — and **falsified**: with only
> `build-scene-draws.ts` stashed, the same arm reads `eligible=false` with `blockedBy` naming the
> shape layer and 0 hits.

> **THE SERVED-SOURCE-TIME FACT — SHIPPED 2026-08-16, AND IT CORRECTS THE 4b BLOCKER RECORDED ABOVE.**
>
> The scoping note says "there is no third option available today, because the decode path does not
> report WHICH source time the frame it served actually is". **That is wrong, and it was wrong when
> written.** The decode path has reported it since ADR-012 S4.2: `ScenePreviewMediaSnapshot`
> `.servedSourceTime` reaches `SceneTextureSource.servedTime` (`scene-compositor.ts`), whose own doc
> says the thing in as many words — "the producer already knows this, and the grade stage threw it
> away, because a texture was modelled as pixels rather than as pixels-at-a-moment".
>
> What was actually missing is one hop further up, and it is the same mistake one layer higher: the
> **DRAW** threw it away. `buildLayerPreFlarexDraw`'s media branch read `.version` off the texture and
> not `.servedTime`, so every consumer downstream of the scene build — the frame cache's key, any
> probe, any oracle — was reasoning about media with no access to a fact the object in its hand was
> already carrying. Fixed by carrying it: `SceneLayerDraw.servedTime`, spread so that "cannot say"
> stays ABSENT rather than becoming `undefined`, plus the same carry on the comp-proxy draw (T7's "a
> proxy is a source; it carries a time", the half that was still missing at the draw level).
>
> The second correction is narrower but matters for anyone reading the blocker: the wall clock is the
> **legacy** path's value, not the default path's. `sourceVersion` prefers
> `(mediaSource as SceneTextureSource).version` — a real S6.2 content version — whenever the source is
> a same-context texture, which the single-context path (default since 2026-07-07) always produces.
> `getTexImageSourceProducerInfo(...).updatedAt` is the fallback for uploaded canvases only.
>
> **USED TWICE, AS SCOPED, AND ONLY ONE OF THE TWO CLOSED.**
>
> *Use one — DEBT-027 is now attributable, and the answer is not what the debt assumed.* Published as
> `__rfFrameCache.served` beside `targetTime`, the field probe prints, for every position where two
> bypassed renders disagree, whether the served moment MOVED. Over live footage it moves at five of
> six: sweep B tracks the request exactly (`5.0000` for t=5.000 … `16.1000` for t=16.100) while sweep C
> pins at `4.9333` and then reports `-`. **The renderer is deterministic given its input; the decoder
> stopped supplying.** DEBT-027's "a decode whose output differs between two seeks to the same t" is
> falsified — it is a supply failure, which is why no settle length ever converged.
>
> *Use two — 4b is viable and still not acceptable, and the distinction is the point.* `served ==
> requested` to four decimals whenever supply works, so a media token folding `servedTime` would HIT
> across two visits to one `t` rather than being a term that can never repeat. That answers the
> question the wall clock could not. **The token is still not written**, because accepting it requires
> a gate on the media fixture and that fixture VOIDS on supply — and shipping a cache-key term with no
> arm that can accept it is the one thing 3b's whole gate order was arranged against. 4b is now
> blocked on DEBT-027's decoder, not on a missing fact, which is a different and much smaller problem.
>
> Green: shared + web + worker typecheck; `FIELD_FIXTURE=deterministic` unchanged and green (the carry
> is inert where nothing decodes, as designed).

**Not in the sequence, and newly ordered ahead of the all-intra proxy by §3.3:** reducing the cost
and the frequency of decoder resets. Provider-local (§4.2), needs no seam change, and worth more
than the transcode it was assumed to require.

> ~~the forward-seek and backward-seek fixes in `webcodecs-decoder.ts`~~ — **superseded 2026-08-10:
> the forward-seek path is already correct** (§3.3). The work is reset cost and reset frequency, not
> a seek-path fix.

---

## 7. Consequences

**Accepted.** A per-frame pull is more total work than a held streaming session for the *sequential
playback* case; measurement says it is 2.8–9.0 ms up to N=50, which is affordable. Cold provider
construction (94–238 ms, serialized) becomes a visible cost when eviction churns — bounded by
making the budget evict rarely (I-P6).

**Improved.** No session cap, no starvation, no mount-order dependence, and one media interface
across preview and export instead of two machines kept in agreement by gates.

**Still open, and honestly so.** Compositor pass count dominates the frame at every N measured
(composite 20.9–855.2 ms vs decode 2.8–9.0 ms). **This ADR does not address it** and must not be
read as a performance fix for large comps: it fixes *acquisition*, and acquisition was not the
thing that was slow — except at N≥100, where decoder thrash makes it so. Pass-count reduction is a
separate programme against ADR-008/010, which this ADR leaves untouched.

---

## 8. Status

Two things here have different statuses, and a reader must not mistake one for the other.

**The DECISION is ACCEPTED, and is not provisional.** Adopting the pull-based frame-provider seam
(§2) is a founder decision, already recorded in `architecture.md`'s deferral entry. Measurement did
not choose it and cannot un-choose it. The seam's normative obligations (§4.1, I-P1…I-P9) and the
out-of-scope list (§5) are accepted with it.

**The measured LIMITS are PROVISIONAL until step 2 ships.** Specifically §3.1–§3.5: the N-ladder,
the ~25 MB/source memory figure, the ~34 ms reset cost, the frame-cache capacity table and the
eviction cliff. They were measured on one machine (AMD Radeon Vega 8, integrated), on synthetic
media, through the export path rather than a live Flarex page. They are the best evidence available
and they are not yet product evidence.

What would revise them: whether a memory-budgeted provider set holds a **real** comp with **real**
footage inside a browser tab. That is step 2's own gate. If it fails, §3.2(a) and §3.5 change and
the decision does not.

### 8.1 STEP 2 SHIPPED, 2026-08-15 — what the gate returned, and what it does NOT license

**Status of §3.1–§3.5 is now: tested at N=12 on real footage in a real tab, and NOT tested above it.**
The blanket "Provisional" is lifted only as far as the evidence reaches, which is a smaller distance
than "step 2 ships" was originally written to imply. Read each line for its own scope.

Measured by `apps/worker/src/flarex-loader-ceiling-probe.ts`, 12 distinct real project renders bound as
asset-source `MediaIn`s on ONE comp, wired through a Merge chain so every source is reachable from
`MediaOut`, real Chrome (`PIXEL_BROWSER_CHANNEL=chrome`), both arms on the identical fixture:

| arm | rendering | admission | budget |
|---|---|---|---|
| session pool (BEFORE) | **3** of 12 | `capMisses 29`, 9 loaders → `<video>` | n/a |
| byte-budgeted seam (AFTER) | **12** of 12 | 0 denials, 0 element fallbacks | peak **706 MB / 768 MB**, **0 evictions** |

**What this DOES establish.** §3.1's claim that the seam removes the session cliff, at N=12: the pool
arm exhibits its own 3-loader ceiling in the same run, so the comparison is against a measured defect
rather than a quoted constant. DEBT-013 clause (a)'s namesake defect — a 4th MediaIn denied at mount —
is gone at this admission authority, and the budget never had to evict to achieve it.

**What this does NOT establish, stated because the numbers invite the stronger reading.**

- **§3.2(a)'s ~25 MB per live source is UNTESTED by this run.** What held is the budget's own
  *accounting* (`heldBytes` against `budgetBytes`), which is a charge model, not a measurement of the
  tab. No `chrome.exe` working set was sampled here. The residency ladder in
  `plans/adr-021-pull-model-feasibility.md` remains the only evidence for the physical figure, and it
  was taken through the export path.
- **12 sources ACQUIRE; they do not stay COHERENT under playback.** In the playing arm all 12 present a
  picture, but only 3 read `state=ok` — the other 9 read `stale`, up to **1728 ms** behind. Paused, all
  12 are coherent at `staleMs 0`. This is exactly §7's boundary and it is worth restating here because
  a "12 of 12 rendering" headline reads like a throughput result: **the seam fixes acquisition, and
  acquisition was not the slow thing.** Twelve concurrent software 1080p decoders do not hold 24 fps on
  this machine, and nothing in this step claimed they would.
- **§3.5's decoder-count ceiling between N=50 and N=100 is untouched** — N=12 says nothing about it.

**A defect the step FOUND rather than introduced, and its fix ships here.** Removing the admission
ceiling exposed a dropped-request path in the consumer that the ceiling had been hiding: when a layer's
provider is swapped mid-decode (remount, `src` flip to the ingest-proxy variant), `WebglMediaLayer`
correctly discarded the answer and then **re-asked for nothing**, so the loader waited on a request only
the playback rAF loop would ever re-issue. Paused, there is no such loop and the loader stayed dark
permanently. Attributed on a one-line control, paused, single variable:

| | rendering | presented | providerChanged | host substitutions |
|---|---|---|---|---|
| without the re-arm | **1** of 12 | 2 | 22 | 1854 |
| with the re-arm | **12** of 12 | 42 | 18 | 79 |

The path predates this ADR; under the session pool the 9 losing loaders were denied a provider and took
the `<video>` path, so they never reached the race. Fixed on the CONSUMER's path (a paced re-request),
not by exempting the provider from the identity check — the repair DEBT-009 rules out.

---

## 9. Open questions

**OQ1 — Is the ~34 ms reset cost dominated by `configure()` rather than `reset()`?** Not measured
this round, deliberately, and named here so it is not silently assumed either way.
`VideoDecoder.reset()` clears decoder state **without** requiring a reconfigure, yet `resetTo()`
calls `decoder.reset()` **and** `configure()` together. If the 34 ms is mostly reconfigure — plausible,
since reconfigure can rebuild the hardware decode pipeline — then the whole random-access number is
a self-inflicted cost and lever (1) in §3.3 collapses to a one-line change. If it is mostly
first-output latency after a flush, the lever is real work. **This is the single cheapest experiment
that could move §3.3's conclusion**, and it should be run before any effort is spent on lever (2).
