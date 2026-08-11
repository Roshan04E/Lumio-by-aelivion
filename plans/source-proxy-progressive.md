# Progressive source-proxy delivery — design

Repo: Orreris Pro, branch `method-3-gpu-compositor`, read at **08ac7cc**. **Design only — no
implementation in this round.**

Goal: stop the user waiting for 100% of a proxy build they can only ever watch the start of. A
145s/141MB clip takes ~61.6s end to end; the user sits on the original (or a stalling original)
for all of it, then gets everything at once.

---

## 0. What is already established, and not re-derived here

Measured in the 2026-08-09/10 rounds, phase sum matched loop wall time to 158ms:

| phase | ms | % of loop |
|---|---:|---:|
| decode (software, deliberate) | 4,973 | 8.9% |
| scale (`drawImage`) | 8,925 | 16.0% |
| encode call | 998 | 1.8% |
| encode backpressure | 40,563 | 72.9% |
| **loop wall** | **55,617** | 100% |

The encoder is at its silicon ceiling (~107 fps at 1280×720, AMD VCN, cross-validated decode-free
to within 1% of the real build). `latencyMode`, `prefer-hardware` and all-intra were each measured
and each sat inside run-to-run noise; `prefer-software` produced a different, non-deterministic,
21%-larger bitstream, which is what proved the default is already hardware. **The encoder is not
revisited anywhere in this plan.**

---

## 0b. MEASUREMENT HAZARDS — read this before benchmarking anything in this pipeline

Two traps, both found the expensive way. Neither is about segmentation; both are properties of the
pipeline itself and were true before any slice of this plan was built.

### Trap 1 — the muxed file's digest is not stable, even for unchanged code

`mp4-muxer` stamps creation/modification times into `mvhd`/`tkhd`, so a digest over the whole muxed
file is **non-deterministic**: two runs of *unchanged* code produce identical byte lengths and
different digests. That reads exactly like "my change altered the output" and will send you chasing
a phantom. Digest the **encoded bitstream** in the encoder's `output` callback instead
(`chunk.copyTo` into a buffer, hash that).

### Trap 2 — the ENCODED BITSTREAM is not deterministic under system load

This is the more dangerous one, because Trap 1's fix looks like it closes the question and it does
not. On a loaded machine, three runs at **identical configuration** produced **three different
bitstream digests and three different file sizes at identical frame counts**
(86,009 / 122,001 / 82,879 ms wall, decode 22.5 / 57.5 / 23.1 s). Same config, varying output —
which rules out any config variable as the cause and points at the hardware VBR encoder responding
to *frame-delivery timing*: when frames arrive late and irregularly, rate control makes different
decisions, and those decisions are in the bytes.

Consequences, stated plainly:

- **Byte-identity is only a valid check on a quiet machine.** A digest mismatch on a loaded box is
  not evidence of a regression, and a match is not evidence of correctness.
- **This is a property of the pipeline, not of segmentation.** It predates Slice 1. Do not attribute
  it to whatever you are currently changing.
- Any future benchmark or identity check **must control machine state or it is measuring noise**.
  State whether the machine was quiet, every time you report a number. A run taken while another
  build, a browser soak, or a parallel session's work is running is void.

### Consequence: the segment-duration sweep is UNFINISHED

Slice 1 shipped `PROXY_SEGMENT_FRAMES = 300`, and that constant does **not** rest on a completed
measurement. What actually exists:

| segFrames | build wall | decode | machine |
|---:|---:|---:|---|
| (none — baseline) | 61,099 ms | ~5.0 s | quiet |
| 300 | 63,297 ms | 5,989 ms | quiet |
| 120 | 69,190 ms | 8,056 ms | quiet |
| 600 / 1200 | never completed inside the timeout | — | degraded |

Two clean single runs, no repeats, no spread. The **~+3.6 %** implied by 300-vs-baseline is
**indicative, not measured** — do not quote it as a measured figure. Everything collected after the
machine degraded is contaminated per Trap 2 and was discarded. 300 was chosen on that clean
300-vs-120 comparison plus the structural argument that the cache costs ~0.5 % in header overhead at
any of these lengths. **A proper sweep on a quiet machine is still owed.** The constant is a
one-line change in `sourceProxyEngine.ts` if that sweep says otherwise.

---

## 1. How playback consumes a proxy today

The full path, as it is:

1. **Build.** `EditorPage` walks the open project's *placed* assets (`collectGraphAssetIds` +
   Flarex `mediaIn.sourceAssetId`; the media bin is deliberately excluded — the 2026-07-24
   library-scope fix) and calls `ensureSourceProxy(asset, onReady)`.
   `sourceProxyEngine` queues one build at a time, `sourceProxy.worker.ts` runs
   decode→scale→encode off-thread.
2. **Seal.** The worker returns ONE `ArrayBuffer` for the whole file. `saveSourceProxy(record, blob)`
   writes `orreris-source-proxies/<assetId>.mp4`, appends one `SourceProxyRecord` to `index.json`,
   and returns a session `URL.createObjectURL(blob)`.
3. **Adopt — deferred.** `onReady` does **not** patch state directly. It stages the URL in
   `pendingProxyUrlsRef`, and only calls `applySourceProxyPatches()` when `isPlayingRef.current`
   is false; a second effect flushes on the `isPlaying` falling edge. So a `src` swap can never
   land mid-playback. (`EditorPage.tsx:1365-1411`)
4. **Route.** The patch sets `asset.proxyUrl`. `resolvePlaybackUrl` (`VideoPreview.tsx:6325`) is the
   only routing decision: `proxyUrl ?? previewUrl ?? fileUrl`, inverted to
   `fileUrl ?? previewUrl ?? proxyUrl` when `ingestProxyPlaybackEnabled` is false (quality "1" =
   full, which bypasses proxies entirely).
5. **Decode.** The resolved URL becomes `mediaUrl` in `WebglMediaLayer`, which either leases a
   WebCodecs session from the pool or takes the `<video>` element path. Note
   `preferNativeDecode` is literally `mediaUrl !== proxyUrl` — **the routing decision and the
   decode-path decision are the same expression today.**
6. **`requestLiveReprime`** (`WebglMediaLayer.tsx:126-134`) is a global bus, and it is **not** part
   of the ingest-proxy handoff. It belongs to the *span* proxy overlay (`ProxyPlaybackLayer`): when
   the overlay covering the picture exits coverage, live layers underneath have been decoding
   unobserved and may have silently wedged, so this forces every mounted layer to heal/re-seek at
   the reveal instead of waiting for the 500ms watchdog. **It is exactly the primitive a coverage
   boundary needs**, and it already exists, already tested, for the other cache.

**Fail-open is already the shipped behaviour.** No proxy → `proxyUrl` is undefined → the original
plays. `FlarexSourceViewer`'s header documents this explicitly. Nothing in this plan may weaken it.

---

## 2. Is a partially-built proxy playable? **No. Segments are mandatory.** (the decisive finding)

`MediaEncoder` muxes with **`fastStart: "in-memory"`** (`video-encoder.ts:151`). That mode buffers
every chunk and writes the `moov` (the sample table — offsets, sizes, sync flags, timescale)
**only in `finalize()`**. Until finalize runs, the `ArrayBufferTarget` holds no readable movie
header at all.

The consumer side confirms this is fatal rather than merely degraded. `demuxIndex`
(`webcodecs-decoder.ts:181-295`) drives mp4box until `onReady` fires, and `onReady` requires a
parsed `moov`. Its loop is `while (!readyInfo && !parseError && pos < blob.size ...)` — on a
header-less prefix it walks to EOF, never gets `onReady`, and returns `null`. A `null` index means
no provider: `createFrameProvider` falls through to the `<video>` fallback, which will fail on the
same bytes for the same reason.

So: **a truncated in-memory-fastStart MP4 is not "partially playable", it is a non-file.** There is
no seek-to-what-exists behaviour to lean on. This rules out the naive shape — "keep writing into
one blob and let playback read the prefix" — completely.

### The two real options, and why one is disqualified

**Option A — `fastStart: 'fragmented'`.** mp4-muxer supports it (verified in the installed
`mp4-muxer@5.2.2` typings, alongside `minFragmentDuration`). It emits `moof`+`mdat` fragments
progressively, so a truncated file *is* parseable up to the last complete fragment. `demuxIndex`
even has a fragmented branch already.

**But this repo has been burned by exactly this file shape, twice, and the scars are load-bearing:**
`SOURCE_PROXY_VERSION` v4's comment records that fragmented MP4s (Pexels/CMAF) were indexed only to
their **first** fragment, the decoder clamped past it, and proxies shipped with a **frozen tail baked
in** — invisible to the frozen-tail guard, because a clamped frame is not null. The fix was to keep
following mp4box's parse positions to EOF. That fix works on a *complete* file. On a *deliberately
incomplete* one, "the index ends early" stops being a bug signature and becomes the normal state —
which means the repo would lose its ability to tell a truncation from a corruption. Adopting
fragmented output would also change the container for every proxy (a `SOURCE_PROXY_VERSION` bump,
i.e. a full rebuild of everyone's cache) to serve a feature that only matters during the first 60s
of a build. **Rejected — the cost lands on the steady state to buy something only the transient
needs.**

**Option B — segments: N independent, individually-finalized, complete MP4s.** Each segment is a
normal `fastStart: "in-memory"` file that `demuxIndex` already handles perfectly, with its own
complete `moov`. Nothing about the decode path changes. The container recipe, the GOP law, the
frozen-tail guard, the v4 fragment walk — all unchanged and still meaningful. The cost moves
entirely into the *store* and the *routing*, which is where new behaviour belongs.

**Recommendation: segments.** And note there is already a working precedent in-tree for the store
shape: `proxyMediaStore.ts` persists per-span blobs with `startSeconds`/`endSeconds` on each record
and rehydrates coverage across reloads. That is the *span* cache, a different cache with different
invalidation — but its record shape and coverage bookkeeping are the pattern to copy rather than
invent.

### AMENDMENT (2026-08-11): Slice 1 shipped Option B′, not Option B — chunks, not MP4s

Option B as written above was **not** built, and the deviation is load-bearing for everything after
it. What shipped (`sourceProxySegments.ts`) is **one continuous encoder, tapped at chunk boundaries**,
persisting raw encoded chunks per segment rather than N finalized MP4s. Why:

- **Option B needs one ENCODER per segment.** Each encoder starts with fresh rate-control state, so
  the encoded bitstream necessarily differs from today's single continuous encode. Option B would
  therefore have changed the output of **every** build, including uninterrupted ones — a
  steady-state change to buy a transient feature, which is the exact objection that disqualified
  Option A above.
- **Tapping one encoder keeps uninterrupted builds byte-identical.** Verified: `chunkDigest`
  1807211703 / 57,315,028 bitstream bytes / 60,845,662 file bytes, the pre-change baseline, on two
  separate quiet runs. Only a genuinely **resumed** build diverges, and only after the resume point
  — unavoidable in any design, because encoder state cannot be persisted.
- **It removes the N× `moov` overhead** §4 named as Slice 1's main cost: a segment carries no
  container at all, just a JSON header and the chunk payloads.

The trade: **segments are not independently playable.** §4's Slice 3 is rewritten below to account
for that.

---

## 3. What the store and routing would have to learn

**Store.** `SourceProxyRecord` is one-blob-per-asset (`<assetId>.mp4` + one index row). It needs:
segment blobs (`<assetId>.seg<k>.mp4`), a per-segment `[startSeconds, endSeconds)` range, and a
notion of a record being *partial* — valid and usable, but not covering everything. The
`sourceByteSize` + `SOURCE_PROXY_VERSION` guards stay exactly as they are; they answer "is this
proxy for these bytes, from this recipe", which is orthogonal to "how much of it exists".

**Routing.** This is the harder half and the reason the slices below are ordered as they are.
`resolvePlaybackUrl` is a *pure function of the asset*, returning *one URL*, called during render.
Coverage makes the answer time-dependent — and `preferNativeDecode`'s `mediaUrl !== proxyUrl`
identity means a naive edit changes decode-path selection as a side effect. Any design that makes
`resolvePlaybackUrl` take a time argument must deal with that coupling deliberately, not
incidentally.

**Uncovered time = today's behaviour, exactly.** Not a black frame, not a hold, not a wait — the
original, via the same expression that runs today when no proxy exists. This is the one
non-negotiable constraint.

**ADR-021 note.** Nothing here touches the fake-layer bridge, and segments do not deepen it: a
segment is still a URL handed to the existing routing, so the eventual frame-provider seam sees the
same shape it sees now. The one thing that *would* make ADR-021 harder is putting coverage logic
inside `WebglMediaLayer` — that pushes source-selection knowledge into the layer component, which
is precisely what the provider seam is meant to remove. **Coverage must live in the store/routing
layer, never in the layer component.**

---

## 4. Slices

Each ships a user-visible win on its own and is independently revertable.

### ~~Slice 0 — Pipelining~~ — **SUPERSEDED 2026-08-11. Built, measured, reverted. It does not work.**

*The original proposal is kept below rather than deleted, because the reason it failed is the
useful part.*

> Overlap decode+scale (13,898ms of CPU) with the encoder's backpressure wait (41,561ms, during
> which the worker thread is genuinely idle on a `setTimeout(0)` poll). Floor:
> `max(13898, 41561) = 41,561ms`, i.e. **~61.6s → ~47.5s, −23%**, cross-checked against the
> encoder's own 107fps ceiling (4352 frames ÷ 107 = 40.7s — the two routes agree).

**Result: +0.3%. 61,099ms → 61,278ms.** Three clean runs each way, same 145s/141.4MB clip, real
Chrome. Serial spread was 61,035/61,260/61,002 (258ms); pipelined 63,074/59,481 plus one 77,906
decode-variance outlier reported separately.

**The pipeline itself worked exactly as designed** — this was not an implementation failure:
`maxQueueDepth` sat at 4 (always full), `queueFullWaitMs` ≈ 39–46s (producer blocked on space, as
predicted for a ~3× faster producer), and crucially `queueEmptyWaitMs` was only ~550ms out of ~55s,
meaning the consumer was essentially never starved and the overlap genuinely happened.

**Why it bought nothing:** `encodeBackpressureMs` grew **40,705 → 54,370ms, +13,665ms** — almost
exactly the ~13,500ms of decode+scale now running inside that window. The encoder's queue does not
drain at a rate independent of the worker thread: its `output` callback (`chunk.copyTo` +
`muxer.addVideoChunk`) runs on that thread, and so does frame submission. So the "genuinely idle"
poll time was never spare capacity — spending it delays the encoder's own servicing one-for-one.
**`max(a, b)` was the wrong model; on a single thread it is still a sum.**

**A deeper queue cannot rescue this.** `queueEmptyWaitMs` ≈ 0 means the consumer never waited, so
depth 4 was not the constraint and no larger number would change the outcome.

**What real overlap would take:** decode+scale on a SECOND worker thread, with frames transferred
across the boundary. That is materially bigger than this slice scoped, and its payoff is now
**unproven rather than certain** — the one-thread result gives no evidence about how much of the
encoder's cost is thread-servicing (which a second worker would relieve) versus GPU time (which it
would not). Anyone attempting it should measure that split first.

**MEASUREMENT TRAPS** found by this round are recorded in **§0b** — the `mvhd`/`tkhd` timestamp trap
(which this round hit) and the load-dependent bitstream non-determinism (which the next round hit).
Read §0b before benchmarking anything here.

### Slice 1 — Segmented build + store, still adopted whole — **SHIPPED 2026-08-11 (`7ecfa80`)**

Build to N segments, finalize each, persist each. **Do not change routing yet** — adopt only when
the last segment lands, reassembling coverage into the same single-`proxyUrl` patch.

- **Win on its own:** genuinely the smallest of the slices — it is a de-risking step, and worth
  saying so plainly. What it buys is that a build interrupted at 80% (tab close, crash, quota) no
  longer throws away 100% of the work; on the next open, 80% is already on disk. Today an
  interrupted build leaves nothing.
- **Excludes:** all coverage routing. Playback behaviour is byte-identical to today.
- **Decides:** segment duration. **Shipped at 300 frames on an UNFINISHED sweep — see §0b.** The
  `moov`-overhead half of the tradeoff evaporated with the Option B′ deviation (segments carry no
  container); what remains is N× OPFS writes and ~0.5 % header overhead.
- **As built:** see the Option B′ amendment in §2. One encoder, chunk tap, byte-identical
  uninterrupted output, resume verified end to end (interrupted at 1500/4352 frames → replayed 5
  segments without re-encoding, encoded 2,852 new frames, complete file, 34.8 s vs ~55 s).

### Slice 2 — Playhead-first build order — **SHIPPED 2026-08-11**

Build segments outward from the current playhead rather than from t=0. Resolve and Premiere both
prioritise what you are looking at; the measurement rounds confirmed builds already suspend during
playback, so the playhead is *stationary* whenever a build is running — this is a genuinely cheap
signal to read, not a moving target to chase.

- **Win on its own:** yes, even with Slice 1's adopt-whole routing, because a user parked at 2:00 of
  a 2:25 clip currently waits for 0:00–2:00 to encode before anything near them exists. Combined
  with Slice 3 it is the difference between "useful in 5s" and "useful in 50s".
- **Excludes:** coverage routing (still adopt-whole until Slice 3).

**As built.**

- **Forward-then-wrap, not strictly outward.** Order is `[playhead segment … last]` then
  `[0 … playhead-1]`. A proxy exists because its SOURCE is expensive to seek, so every backward jump
  costs a full GOP grind on the original; forward-wrap pays that **once**, alternating outward would
  pay it once per segment. Degenerate case worth knowing: a playhead in the LAST segment gives only
  one segment "ahead" before the wrap.
- **The playhead is resolved by the editor, not the engine.** `setSourceProxyPlayheadResolver` hands
  the engine a callback; `EditorPage` maps timeline time through the placed clip's own
  speed/`sourceIn` with `layerSourceTimeSeconds` — the same evaluator the preview and renderers use,
  rather than a second copy inside the proxy engine. Null (no clip under the playhead, no resolver)
  means build from 0, i.e. exactly the previous order.
- **Out-of-order encoding needs an encoder restart, not a timestamp gamble.** WebCodecs takes frame
  timestamps as monotonically increasing, and jumping back to segment 0 breaks that. Rather than bet
  on how one hardware encoder reacts, each non-contiguous run flushes, resets and reconfigures with
  the identical config (same SPS/PPS) and opens on a forced IDR. Muxing is therefore **deferred**:
  the muxer is fed once at the end in logical order. Not a memory regression — the bytes sit in the
  segment map instead of the muxer's buffer and are released as they are muxed.
- **The resume cache became a SET, not a prefix.** Slice 1 walked 0,1,2… and stopped at the first
  gap; playhead-first leaves gaps by design, so the store now enumerates indices
  (`listSourceProxySegmentIndices`) and the worker encodes whatever is missing.

**The guard, restated (§4's "Watch" item, which was the real risk).**

- `nullRun` now resets **per run**, not per file. "The decoder stopped producing frames" only means
  anything across a contiguous forward walk; a null right after a seek is not a continuation of the
  previous run's last frame. Inside a run the guard is unchanged, which is where a real mid-file
  decoder failure appears.
- The tail-overshoot exit is stated in **absolute source time** (`i/fps > effectiveDuration − 0.25`),
  so it can only ever fire inside the last segment regardless of build order, and it now ends **that
  run** rather than the whole build.
- Its old `decodedAny &&` clause was **removed**, deliberately. It meant "we have seen a real frame
  this session" — true under t=0 order by the time you reach the tail, and false under playhead-first
  when the tail is built FIRST, which turned a legitimate end into a frozen-tail abort purely because
  of build order. The degenerate case it guarded (a source that decodes nothing at all) is caught
  unchanged by the order-independent `!decodedAny` check after the runs.
- A **missing segment** below the tail is now a hard build failure — a proxy with a hole in it is
  precisely what the guard exists to keep off disk.

**Verified** (real product path, real Chrome, AMD Vega 8):

| check | result |
|---|---|
| playhead at 0 | one run `0-15`, no resume — shape identical to before |
| playhead-first order | parked at 150.9 s → `build order: 2 run(s) from segment 15 of 16`; killed mid-build, disk held `[0,1,2,3,4,5,6,15]` — segment 15 exists with a gap below it, which t=0 order cannot produce |
| resume from a sparse set | reused 8 non-contiguous segments (2,129 frames), encoded only run `7-14`, muxed a complete 4,529/4,529-frame file |
| encoder-restart splice | uninterrupted 2-run build (`15-15`, `0-14`) → complete file, `decodableEndSeconds` 150.97 s, decodes at frames 0/299/300/600/1500/1501/4500 |
| suspend during playback | 30 → 30 frozen while playing (`__rfBgGate.reasons: ["playing"]`) → 120 after pause |

**NOT verified: byte-identity, and no timing figures.** Per §0b this machine was not quiet
(CPU 18–100 % throughout, VS Code + Docker + a parallel session). Four alternating builds of the same
clip — two with segmentation disabled, two with it on — produced **four different digests, including
two at identical configuration**, with file sizes spread across 0.13 %. That is §0b Trap 2, not a
regression signal; frame counts were exact (932/932) in every arm. Build wall times ranged 44–259 s
for the same work at 26–97 % CPU and are reported here only to say they are **not measurements**.
Byte-identity and the cost of the extra seek are both **still owed on a quiet machine**.

**A latent bug the verification caught.** The run bounds initially used the segment grid even when
segmentation is disabled (a `segmentFrames` that is not a multiple of the GOP), truncating that
fallback's output to one segment's worth of frames. Found because the baseline arm returned 301
frames instead of 932. Fixed with an explicit `runGridFrames`.

### Slice 3 — Coverage-aware routing — **SHIPPED 2026-08-11**

**What shipped, and the one decision everything else follows from.**

The risk that outranked everything in the design below: **a partial proxy is a TRUNCATED file to the
decoder.** `chunkIndexForMicros` clamps any time past the final sample to the last index entry, so
`getFrame` serves the same frame forever — never null, so nothing heals, nothing falls back, nothing
reports it. That is the frozen tail this repo has already shipped twice (`SOURCE_PROXY_VERSION` v4
and v5).

The answer is structural, not defensive: **a layer may only be routed to a partial proxy when every
source time it can EVER request is already inside coverage.** The clamp region is then unreachable —
not avoided at runtime, not detected and recovered from, simply never addressed.

- **The gate is per LAYER, never per TIME.** A layer's URL is fixed for its whole extent, so there is
  no boundary for playback to cross, no mid-playback `src` swap, and no stall at a crossing. This is
  also what keeps `resolvePlaybackUrl` returning one stable URL per layer.
- **Coverage is the contiguous PREFIX from 0, not the covered run.** Slice 2 can leave a covered run
  starting above zero. A file muxed from `[a, b)` with `a > 0` either keeps timestamps starting at
  `a` — and a request below `a` clamps to the FIRST sample, showing the wrong picture — or is rebased
  to zero, and then every source time is off by `a`. Both are silent wrong-picture bugs. Only a
  prefix preserves the source-time mapping with no offset anywhere.
- **`partialProxyUrl` is its own field, not a reuse of `proxyUrl`.** A truncated file is not a
  substitute for a complete one, and `proxyUrl` has consumers that reasonably assume the whole source
  is present (AI observers, the two-up scrubber, hover previews, thumbnails). Nothing that has not
  opted in can ever see a partial.
- **The invariant is preserved by moving it, not by breaking it.** `mediaUrl !== proxyUrl` was
  written inline at the `preferNativeDecode` site; a partial proxy is equally keyframe-dense and
  equally belongs on the pool, so both sides now read one function, `isIngestProxyUrl`. Routing and
  decode-path remain the same decision — a source that resolved to a proxy is never pushed onto the
  element path.
- **Audio layers are refused outright.** The prefix mux is video-only (no encoded AAC exists in the
  cache — a finished proxy muxes audio from one PCM buffer at the END of the build), so routing an
  audio layer there would silently mute it.
- **No encoder is allocated to mux.** `mp4-muxer` is driven directly from the cached chunks; putting
  a second hardware encoder session against a running build is this repo's recurring contention
  shape.

**THE TENSION WITH SLICE 2, STATED PLAINLY.** Prefix-only coverage and playhead-first build order
pull against each other. A build that starts at segment 15 produces no usable prefix until it wraps
and refills from 0. And the headline scenario in this plan's own opening — a fresh import, one clip
spanning the whole source — **gains nothing from this slice**, because a full-span layer's range is
the whole source and only a complete build covers it. What gains immediately is a TRIMMED clip,
which is what a timeline becomes after any real editing. Unlocking the full-span case needs either a
mid-playback swap (forbidden) or a decoder that returns null past its last sample instead of clamping
(a change to behaviour v5 deliberately relies on) — neither belongs in this slice.

**Verified** (real product path, real Chrome, AMD Vega 8; CPU noted per run):

| check | result |
|---|---|
| frozen-tail probe is LIVE (positive control) | a provider built on the adopted partial, asked for `coverage + 30s`, fires `[frozen-tail]` — so the zeros below mean something |
| covered layer adopts | clip trimmed to 18s, coverage grew 10s → 50s, `fits` flipped true, layer routed to the partial **on the pool** (`preferNativeDecode: false`); **0** frozen-tail warnings across a full-extent scrub (10 seeks, ending on the last frame). CPU 100% at start |
| uncovered layer refuses | full-span 150.97s layer against 90s of published coverage: `fits: false` for every partial, stayed on the original via the element path, **0** frozen-tail warnings scrubbing the whole clip past coverage. CPU 10% |
| reopen is usable immediately | killed at 50s coverage; on reopen the prefix republished and the layer was playable **6.9s** after reload, straight from the persisted segment cache (16.1s before the publish was moved ahead of the GOP/metadata/audio steps). CPU 40% |
| adoption never lands mid-playback | structural: `drainQueue` awaits `waitWhileSuspended()` **before** `buildOne`, so during playback the engine never reaches the publish at all — no partial could be published across 60s of playback, and coverage appeared only after parking. The deferred-adoption guard is therefore belt-and-braces for a publish already in flight when play begins, which a script cannot time. CPU 91–100% |

**Known, pre-existing, not introduced here:** a full asset-list refresh (`setAssets(refreshed…)` on
reconnect/heal paths) drops `partialProxyUrl` just as it already drops a session `proxyUrl`, which
momentarily withdraws coverage. Same shape and same blast radius as today's complete-proxy handling;
left alone rather than quietly widened.

### Original Slice 3 design (rewritten 2026-08-11 for Option B′; superseded by the record above)

*The original text described routing between N independently-playable segment files. Slice 1 does
not produce those (see the §2 amendment), so that design is gone. A plan describing a design the
code abandoned is worse than no plan.*

Playback consults coverage: covered time plays the proxy, uncovered time plays the original via
today's expression. Reuse `requestLiveReprime` at boundary crossings — it exists for exactly this,
in the span cache.

**What "the proxy" now means during a build.** Segments are raw chunk bundles, not files. So
coverage routing means **muxing the covered prefix on demand into ONE playable MP4** — the same
`muxPreEncodedVideoChunk` + `finalize()` path the resume replay already uses, run against segments
`[0, k)` and written to a blob URL. Not N files to route between: **one file, one URL, one
`proxyUrl` patch**, which is the shape `resolvePlaybackUrl` already takes.

Consequences, all of which make this *simpler* than the original design, not harder:

- **Routing does not change shape.** `resolvePlaybackUrl` keeps returning one URL per asset. The
  time-dependence lives in *when the URL is re-minted*, not in the function's signature — so the
  `preferNativeDecode` / `mediaUrl !== proxyUrl` coupling named below is untouched by construction.
- **Coverage is a scalar, not a set**: `coveredUntilFrame`. Playhead-first order (Slice 2) makes
  coverage a *set* of built segments, so Slice 3 muxes the contiguous run containing the playhead
  and reports its bounds — still one file, now `[a, b)` rather than `[0, k)`.
- **The re-mux is not free** and must be rate-limited: it copies the whole covered bitstream through
  the muxer. Re-mint on a coarse trigger (every few segments, or on demand when the playhead lands
  outside coverage), never per segment.
- **Adoption stays deferred exactly as today.** A re-minted URL is a `src` swap; it must go through
  `pendingProxyUrlsRef` and land only when the transport is parked. Never mid-playback.

Unchanged from the original scoping:

- **Excludes:** audio. The current proxy carries a full AAC track muxed from one pre-decoded PCM
  buffer; segmenting audio is a separate problem (gapless concatenation across segment boundaries is
  its own class of bug). **Until then, on-demand prefix muxes should be video-only and the original
  keeps supplying audio** — state this explicitly rather than discovering it.
- **Excludes:** the quality-toggle interaction. `ingestProxyPlaybackEnabled=false` must bypass
  coverage entirely, not consult it.
- **Still the hardest part:** `preferNativeDecode`'s `mediaUrl !== proxyUrl` identity. A partial
  proxy IS a `proxyUrl`, so a source flips onto the pooled decoder the moment the first prefix
  adopts, and back if coverage is ever withdrawn. Per `WebglMediaLayer.tsx:896-908`, mass movement
  between the pool and the element path hits the browser's ~16 hardware-decode-context cap — "a slow
  source is a degradation; a capped one is an outage." Coverage must therefore only ever GROW within
  a session; never withdraw a `proxyUrl` once adopted.

### Slice 4 — Progressive adoption UI

Surface coverage (a build bar on the clip, like Premiere's render bar). The `onProgress` channel
already exists and already reports per-build percent into the notice line.

- **Win:** the wait becomes legible.
- **Excludes:** any behaviour change.

---

## 5. Where this stands (Slices 1, 2 and 3 shipped 2026-08-11)

**The feature works, for trimmed clips.** A build interrupted at any point leaves segments on disk;
they are built where the user was looking; and on reopen the covered range is playable in ~7s
instead of after another full build. The frozen tail that made this dangerous is structurally
unreachable, proven against the repo's own instrumentation with a positive control.

**What it does NOT yet do, and the founder should decide whether to fund it:** a single full-span
clip — the fresh-import case this plan opens with — still waits for the whole build. See the tension
recorded under Slice 3. The two ways out are both bigger than a slice:

1. **A frame-provider seam (ADR-021).** A layer that could be handed a *provider* rather than a URL
   could switch source mid-clip without a `src` swap, which is what prefix-only coverage exists to
   avoid. This is the deferred architectural direction anyway.
2. **Make the demuxer return null past its last sample instead of clamping.** That would let a
   partial proxy fail open per frame. It changes behaviour `SOURCE_PROXY_VERSION` v5 relies on
   (metadata overshoot) and touches every source, so it is a decoder change with its own gate, not a
   proxy change.

**Still owed, on a quiet machine (§0b):** the segment-duration sweep, and a byte-identity check of an
uninterrupted playhead-at-0 build. Neither blocks anything; both are cheap once the box is idle, and
§0b explains why running them on a loaded one is worse than not running them.

### Historical: why Slice 1 went first

*Revised 2026-08-11. The original recommendation was Slice 0, on the strength of a certain −23%.
That number did not survive contact with measurement (see Slice 0 above), and with it goes the
whole argument for doing pipelining first — there is no longer a cheap certain win to bank before
the harder work.*

**Do Slice 1 next.**

- It is the **prerequisite for every remaining slice**. Slices 2, 3 and 4 all assume segments exist;
  none of them can start without it.
- Its own win is **modest but real, and does not depend on a performance prediction**: a build
  interrupted at 80% today discards 100% of the work, and after this it discards none. That is a
  behavioural guarantee, not an arithmetic projection — exactly the property Slice 0 turned out to
  lack.
- It is **still invisible to playback**. Adopt-whole keeps routing, `resolvePlaybackUrl` and
  `preferNativeDecode` untouched, so it cannot regress the preview path.
- The **cost is a real risk to watch, not an assumption**: N× `moov` overhead and N× OPFS writes.
  Segment duration must be picked from measurement, and if total build time rises materially that
  is a price the founder should see stated, not discovered.

The felt win still lives in Slice 3. Slices 1 and 2 are the road to it, and Slice 1 is the part
nothing else can proceed without.

**What I would not build:** `fastStart: 'fragmented'` (Section 2 — a steady-state container change,
and a rebuild of every user's cache, to serve a 60-second transient), segmented audio inside Slice 3
(its own problem), and any coverage logic inside `WebglMediaLayer` (it would deepen exactly the
seam ADR-021 intends to remove).
