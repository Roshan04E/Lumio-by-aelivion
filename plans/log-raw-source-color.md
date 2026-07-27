# Log / 10-bit / RAW source support

Status: Stage 0 + Stage 1 in progress (2026-07-27). Stages 2–4 planned, not started.

## The problem, stated correctly

"We only support generic footage" is three unrelated problems wearing one coat. Separating them is
most of the work, because they have wildly different costs and help wildly different numbers of users.

| # | Problem | Real status | Cost to fix |
|---|---------|-------------|-------------|
| 1 | Container (`.mov`) | **Mostly already works.** QuickTime `.mov` is ISOBMFF, same base format as MP4; `webcodecs-decoder.ts` demuxes with mp4box and already reads `avcC`/`hvcC`/`vpcC`/`av1C`. A H.264/HEVC `.mov` decodes today. | ~0 |
| 2 | Codec (ProRes, RAW) | **Hard browser blocker.** ProRes is not a WebCodecs codec and appears in no codec registry. No browser exposes a decoder. Nothing in the renderer can change this. | High (Stage 4) |
| 3 | Colour (log, 10-bit, HDR) | **Decodes fine, renders wrong.** Already detected — `sourceColorWarnings()` emits `unsupported-log`. The picture is flat because nothing applies log→linear. | Moderate (Stages 0–3) |

### The finding that sets the priority

**Apple Log on iPhone is HEVC 10-bit, not only ProRes.** Apple Log spans iPhone 15 Pro → 17 Pro, and
outside the ProRes path it is H.265 at 10-bit (~200 MB/min at 4K30). Samsung Pro Video records 10-bit
4K log likewise.

So **most "pro phone log footage" already decodes in this app.** It just looks wrong. The expensive
work (ProRes) helps fewer users than the cheap work (colour transforms) — which is why Stage 4 is last
despite being the thing people ask for by name.

### Decode reach (WebCodecs, 1.1M sessions, Jan–Mar 2026)

- H.264 — 99.94% decode. Universal.
- AV1 — ~91.5% decode.
- HEVC — ~85.1% decode, but *"universal on Safari and nearly absent on Edge and Firefox"*.
  Chrome-on-Windows 81%, Edge-on-Windows 56%.
- ProRes — absent from every dataset. Not a WebCodecs codec.

HEVC's uneven reach matters: 10-bit log on Firefox/Edge will not decode at all, so Stage 1 must report
capability honestly rather than fail obscurely.

## What already exists (do not rebuild)

`packages/shared/src/color/color-management.ts` was written for this and deliberately deferred:

- `SourceColorMetadata` — primaries / transfer / matrix / fullRange / bitDepth / `detectedFrom` /
  `confidence`. `detectedFrom: "detected"` is already a legal value nothing produces yet.
- `ColorTransfer` already includes `"log" | "pq" | "hlg"`.
- `sourceColorWarnings()` already emits `unsupported-log`, `unsupported-hdr`,
  `unsupported-wide-gamut`, `assumed-rec709`.

Missing: **nothing reads `VideoFrame.colorSpace`.** `VideoColorSpace` appears only in
`video-encoder.ts` (export tagging, P2). Source detection is the pending P3.

## The load-bearing constraint: the pipeline is 8-bit

The entire GPU path is RGBA8:

- `gl-context.ts:434` / `:452` — render targets allocated `gl.RGBA, gl.UNSIGNED_BYTE`
- `media-renderer.ts:353` / `:355` — frame upload `gl.UNSIGNED_BYTE`
- `media-renderer.ts:566` — readback `gl.UNSIGNED_BYTE`

Log is *designed* to be stretched in the grade. Doing that through 8-bit intermediates bands visibly.
Shipping log support on an 8-bit pipeline would technically "work" and look bad — worse than the
honest warning shown today. **Hence Stage 0 is a prerequisite, not an optimisation.**

---

## Stage 0 — 10-bit precision (prerequisite)

**Goal:** float render targets so a log→linear stretch has headroom, without regressing the 8-bit path.

1. `RenderTarget` gains a precision option: `RGBA16F` + `HALF_FLOAT` when available
   (`EXT_color_buffer_half_float` / WebGL2 core), falling back to RGBA8.
2. Frame upload stays `UNSIGNED_BYTE` for 8-bit sources (nothing to gain); 10-bit sources upload at
   half-float once Stage 1 can identify them.
3. Flag `?hdrPipeline=0|1` → `localStorage orreris.hdrPipeline` → `VITE_HDR_PIPELINE` → **default
   OFF**, matching the `singleCtxPreview` / `glGovernor` resolution order exactly.
4. Telemetry `window.__rfHdrPipeline` — `{ targets, halfFloat, fallbacks }` — always on regardless of
   the flag, so engagement is provable before any flip (the `__rfSingleCtxPreview` doctrine).

**Cost risk (the reason this is flagged):** RGBA16F doubles GPU memory per target. The compositor's
artifact budget in `scene-compositor.ts:806` is denominated in `w × h × 4` bytes and must become
precision-aware or it will silently over-commit on the integrated-GPU target (Iris Xe class) this
product aims at.

**Flip ladder (same shape as singleCtxPreview):** `render:compare:pixels` 23/23 at 0.000% in BOTH flag
states → engagement probe non-zero on / untouched off → user soak. Not flipped in this pass.

## Stage 1 — Source colour detection

**Correction to an earlier draft of this plan: most of this already existed.** `source-color.ts`
already parses the container `colr` box via mp4box, maps the ISO 23091-2 code points to
`SourceColorMetadata`, sets `detectedFrom: "detected"`, and is already called at ingest from
`EditorPage`. The plan originally listed all of it as missing. Check before scoping.

**The one gap that actually mattered — bit depth was inferred, not read.** It was
`transfer === "pq" || transfer === "hlg" ? 10 : 8`, which is right for broadcast HDR and wrong for
precisely the footage this project is about: **Apple Log is HEVC 10-bit and is not tagged with an HDR
transfer**, so every 10-bit log clip reported itself as 8-bit. Bit depth is the field that identifies
a 10-bit source, drives the HDR warning, and decides whether a frame deserves a half-float upload —
inferring it from a different field cannot answer any of those.

Now read from the codec configuration (`readBitDepth`):

- **HEVC** — `hvcC.bit_depth_luma_minus8 + 8`. Stated directly. Verified mp4box 0.5.4 parses it.
- **H.264** — bit depth lives in the SPS, not `avcC`, so `AVCProfileIndication` is the honest proxy:
  110 (High 10), 122 (High 4:2:2), 244 (High 4:4:4) → 10; any other stated profile → 8.
- **Neither** — `undefined`, falling back to the old inference so this can only be more accurate than
  before, never less. Confidence drops to `medium` when the depth was inferred rather than read: a
  reading and a guess must not claim the same confidence.

**Still open in Stage 1** (deliberately deferred, low value relative to cost):

- `VideoFrame.colorSpace` as a second evidence source. Only helps containers mp4box cannot parse
  (WebM) — phone footage is MP4/MOV, which the `colr` path already covers.
- **Log transfer is still never detected.** H.273 has no code point for camera log curves, and Apple
  Log / S-Log3 / V-Log clips are typically tagged `bt709` or unspecified. This is not a bug to fix —
  it is structural, and it is the reason **Stage 3 (manual override) is mandatory, not optional.**

**Explicitly NOT in Stage 1:** applying any transform. Detection only, so the stage is pixel-neutral —
`render:compare:pixels` must stay 23/23 at 0.000% after it.

## Stage 2 — Input transform (IDT)

Log→linear curves + gamut matrices, alongside `rec709CodeToLinear` in `color-management.ts`, applied
per-source before the working space. Apple Log, S-Log3, V-Log, LogC3/LogC4, D-Log, F-Log, HLG, PQ.

All are published analytic formulas — no LUT files, and each is testable against known code values in
the existing pixel-gate harness (e.g. Apple Log 0.0 / 0.5 / 1.0 → known linear values).

Depends on Stage 0 (banding) and Stage 1 (knowing which curve).

## Stage 3 — Manual "Input Color Space" override

Per-clip dropdown; detection sets the default, user overrides. **Not a nicety** — camera log is
frequently untagged or mistagged, and every professional tool has this control for exactly that
reason. Stage 2 without Stage 3 is unshippable.

## Stage 4 — ProRes / RAW reach

Cannot decode in-browser, so transcode on import. This fits the existing architecture rather than
adding a new one: `sourceProxy.worker.ts` already does off-thread transcode to proxies with originals
kept for export. Add a WASM ffmpeg decode path there for ProRes.

Biggest lift, fewest users helped, and it does not block anything else. Last.

---

## Sources

- WebCodecs codec support dataset — https://webcodecsfundamentals.org/datasets/codec-support/
- Codec analysis 2026 (1.1M sessions) — https://webcodecsfundamentals.org/datasets/codec-analysis-2026/
- Apple Log on iPhone — https://dblabsapps.com/blog/apple-log-video-iphone/
- Apple ProRes — https://en.wikipedia.org/wiki/Apple_ProRes
