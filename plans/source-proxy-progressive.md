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

**MEASUREMENT TRAP, for whoever benchmarks this next.** `mp4-muxer` stamps creation/modification
times into `mvhd`/`tkhd`, so a digest over the whole muxed file is **non-deterministic** — two runs
of *unchanged* code produce identical byte lengths and different digests. That reads exactly like
"my change altered the output" and will send you chasing a phantom. Digest the **encoded bitstream**
in the encoder's `output` callback instead (`chunk.copyTo` into a buffer, hash that); it is
deterministic and was identical across all six runs of both arms.

### Slice 1 — Segmented build + store, still adopted whole

Build to N segments, finalize each, persist each. **Do not change routing yet** — adopt only when
the last segment lands, reassembling coverage into the same single-`proxyUrl` patch.

- **Win on its own:** genuinely the smallest of the slices — it is a de-risking step, and worth
  saying so plainly. What it buys is that a build interrupted at 80% (tab close, crash, quota) no
  longer throws away 100% of the work; on the next open, 80% is already on disk. Today an
  interrupted build leaves nothing.
- **Excludes:** all coverage routing. Playback behaviour is byte-identical to today.
- **Decides:** segment duration. Not guessed here — it is a real tradeoff (more segments = finer
  coverage granularity and faster first-adoption, but N× the `moov` overhead and N× the OPFS
  writes) and should be measured in this slice, using the same phase instrumentation the
  2026-08-09 round used.

### Slice 2 — Playhead-first build order

Build segments outward from the current playhead rather than from t=0. Resolve and Premiere both
prioritise what you are looking at; the measurement rounds confirmed builds already suspend during
playback, so the playhead is *stationary* whenever a build is running — this is a genuinely cheap
signal to read, not a moving target to chase.

- **Win on its own:** yes, even with Slice 1's adopt-whole routing, because a user parked at 2:00 of
  a 2:25 clip currently waits for 0:00–2:00 to encode before anything near them exists. Combined
  with Slice 3 it is the difference between "useful in 5s" and "useful in 50s".
- **Excludes:** coverage routing (still adopt-whole until Slice 3).
- **Watch:** ordering must not break the frozen-tail guard's assumption that it is walking forward
  through the source, nor `decodableEndSeconds` clamping. The guard is about the *decoder* failing
  mid-file; out-of-order building means "the decoder stopped producing frames" needs re-stating in
  terms of a segment, not the file.

### Slice 3 — Coverage-aware routing (the actual feature)

Playback consults coverage: covered time plays the proxy segment, uncovered time plays the original
via today's expression. Reuse `requestLiveReprime` at boundary crossings — it exists for exactly
this, in the span cache.

- **Win:** the headline one. The user stops waiting.
- **Excludes:** audio. The current proxy carries a full AAC track muxed from one pre-decoded PCM
  buffer; segmenting audio is a separate problem (gapless concatenation across segment boundaries is
  its own class of bug) and should be scoped separately. **Until then, segments should be
  video-only and the original keeps supplying audio** — state this explicitly rather than
  discovering it.
- **Excludes:** the quality-toggle interaction. `ingestProxyPlaybackEnabled=false` must bypass
  coverage entirely, not consult it.
- **Hardest part, named:** decoupling `preferNativeDecode`'s `mediaUrl !== proxyUrl` identity from
  routing, so that crossing a coverage boundary doesn't silently move a source between the pool and
  the element path. Per the comment at `WebglMediaLayer.tsx:896-908`, moving loaders onto elements
  en masse hits the browser's ~16 hardware-decode-context cap — "a slow source is a degradation; a
  capped one is an outage."

### Slice 4 — Progressive adoption UI

Surface coverage (a build bar on the clip, like Premiere's render bar). The `onProgress` channel
already exists and already reports per-build percent into the notice line.

- **Win:** the wait becomes legible.
- **Excludes:** any behaviour change.

---

## 5. Recommendation: ship Slice 1 (segmented build + store) first

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
