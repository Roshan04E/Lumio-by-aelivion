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

## The working colour space (was missing; review 2026-08-03)

Every stage below says "log → linear". **Linear in which primaries?** That was never stated, and
without it Stage 2b is undefined — a gamut matrix has to have a destination.

**Orreris's internal working space is linear Rec.709, D65** — already the code's answer
(`ColorWorkingSpace = "rec709-linear"`, `DEFAULT_PROJECT_COLOR_SETTINGS`), never the plan's. Every IDT
maps into that space: transfer to linear, then primaries to Rec.709. Transfer and primaries are
separate concerns and are applied as separate steps (2a and 2b).

**The honest caveat, which nobody raised:** Rec.709 is a *narrow* working gamut, and it is a poor one
for grading log. S-Gamut3, ARRI Wide Gamut and BT.2020 all contain colours Rec.709 cannot represent, so
converting into Rec.709 linear **clips them permanently** — before the grade, where a colourist would
have wanted to pull them back. A scene-referred wide working space (ACEScg, or linear BT.2020) is the
correct long-term answer for log footage.

Not changing it now: the working space is a project-wide decision that touches the grade math, the LUT
baker, export tagging and every saved project, and it deserves its own ADR rather than being smuggled in
under a source-format plan. `ColorWorkingSpace` is already a union type with one member, which is the
extension point. **Stage 2b must not be read as "log is now colour-accurate" — it is "log is now
correctly interpreted, then clipped to Rec.709."** That distinction belongs in the UI copy too.

## The load-bearing constraint: the pipeline is 8-bit

The entire GPU path is RGBA8:

- `gl-context.ts:434` / `:452` — render targets allocated `gl.RGBA, gl.UNSIGNED_BYTE`
- `media-renderer.ts:353` / `:355` — frame upload `gl.UNSIGNED_BYTE`
- `media-renderer.ts:566` — readback `gl.UNSIGNED_BYTE`

Log is *designed* to be stretched in the grade. Doing that through 8-bit intermediates bands visibly.
Shipping log support on an 8-bit pipeline would technically "work" and look bad — worse than the
honest warning shown today. **Hence Stage 0 is a prerequisite, not an optimisation.**

---

## Stage 0 — working precision (prerequisite)

**Renamed from "10-bit precision" — the old title claimed something this stage does not deliver.**

> **Stage 0 preserves precision DURING PROCESSING. It does not preserve SOURCE precision.**
> Every contributor who reads "10-bit pipeline" assumes the opposite, including the person who wrote
> that title. See the correction below before building on this stage.

**Goal:** float render targets so a log→linear stretch has headroom, without regressing the 8-bit path.

**Correction (review 2026-08-03): Stage 0 does NOT preserve source bit depth, and the plan should never
have implied it would.** Frames reach the GPU through `texImage2D(…, gl.RGBA, gl.UNSIGNED_BYTE, source)`
(`media-renderer.ts:353`/`:355`) into an RGBA8 texture. A 10-bit HEVC `VideoFrame` is therefore already
truncated to 8 bits *before* any render target sees it. Half-float accumulators cannot recover
information that was discarded one step earlier.

What Stage 0 actually buys — still worth having, and still a genuine Stage 2 prerequisite — is
**headroom through the grade chain**: no re-quantisation between stacked operations, and no clipping of
super-white/sub-black between them. A log→linear stretch amplifies exactly the errors 8-bit intermediates
introduce, so this is the difference between a log workflow that bands and one that doesn't. It is
"working precision", not "10-bit input".

Getting true 10-bit *input* is a separate, unproven piece of work: either `texImage2D` with an
`RGBA16F` internal format from a `VideoFrame` (browser conversion behaviour is implementation-defined —
would need measuring, not assuming), or `VideoFrame.copyTo()` at `P010` plus a YUV→RGB shader, which is a
real ingest redesign. **Neither is in this plan.** It gets its own stage when someone has measured
whether the browser preserves the bits at all.

1. `RenderTarget` gains a precision option: `RGBA16F` + `HALF_FLOAT` when available
   (`EXT_color_buffer_half_float` / WebGL2 core), falling back to RGBA8.
2. **Frame upload stays `UNSIGNED_BYTE`, unconditionally.** Not a staging decision — the browser already
   does YUV→RGB internally, so a CPU-side convert-then-upload adds bandwidth and a copy to reach a
   precision the decode path did not hand us in the first place. Revisit only if browsers expose a
   native float upload from `VideoFrame`.
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

**Confidence model — revised by review 2026-08-03.** `high | medium | low` is a summary with no stated
basis, and it collides with `detectedFrom`, which is already the evidence axis. The two collapse into one
ordered ladder naming *what the claim rests on*:

```
authoritative  — the user said so (Stage 3 override). Beats everything; never overwritten by detection.
detected       — read from the bitstream: colr box, hvcC bit depth, VideoFrame.colorSpace.
inferred       — derived from a different field (the old "pq||hlg ⇒ 10-bit" guess).
assumed        — the Rec.709 default, i.e. nothing was known.
```

Confidence stops being hand-set and becomes a function of the strongest evidence present, so a reading and
a guess can no longer claim the same standing. `SourceColorMetadata` is **persisted in saved projects**, so
this is a migration, not a rename: `normalizeSourceColorMetadata` already coerces unknown values to
defaults, which is the seam — map legacy `high→detected`, `medium→inferred`, `low→assumed` there, and old
projects keep loading.

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

### Stage 2 design (2026-08-03) — READ THE RISK SECTION BEFORE APPROVING

**Split into 2a (transfer) and 2b (gamut).** These are independent corrections and 2a is where the
visible win is: a log clip looks flat/washed because the TRANSFER curve is wrong, and fixing it alone
restores normal contrast and black level. Gamut is a secondary accuracy correction (saturation and hue
of strongly-coloured objects). Shipping 2a first is a coherent increment; shipping 2b first would be
nearly invisible. **This pass is 2a only.**

**New file:** `packages/shared/src/color/input-transform.ts`. Deliberately a NEW file rather than an
extension of `color-management.ts`, and deliberately in `packages/shared/src/color/` — that directory
currently has zero uncommitted sibling edits, whereas ADR-012 work is live in `ScenePreviewCanvas.tsx`,
`WebglMediaLayer.tsx`, `scene-media-source.ts` and the playback clock. Stage 2a touches none of those.

**Shape** — a registry, one entry per camera encoding:

```ts
export type InputColorSpace =
  | "auto" | "rec709" | "srgb"
  | "apple-log" | "slog3" | "vlog" | "logc3" | "logc4" | "dlog" | "flog"
  | "hlg" | "pq";

interface InputTransferDefinition {
  id: InputColorSpace;
  label: string;               // "Apple Log", "Sony S-Log3" — the Stage 3 dropdown reads this
  toLinear(code: number): number;     // 0..1 code → the ENCODING's own linear quantity
  fromLinear(linear: number): number; // exact inverse; only exists so the tests can prove round-trip
  nativeGamut: string;                // recorded now, CONSUMED in 2b
  // Two axes, not one. "verified" alone was overloaded — it could mean implemented, reviewed, spec-
  // checked or tested, and those come apart: a curve can be implemented and tested (round-trip, no
  // kinks) while its CONSTANTS remain unchecked against the vendor document, which is exactly the
  // state Stage 2a lands in.
  implementation: "stub" | "implemented";
  verification: TransferVerification;
}

// "unverified" was the wrong word — it reads as "probably wrong", when the real state is "implemented,
// internally tested, awaiting comparison against the authoritative document". Provenance is part of the
// SHAPE rather than a convention: you cannot claim spec-checked without naming the document and its
// revision, because in five years someone will ask why a constant is 0.241514 and not 0.24151, and the
// answer has to be traceable to a specific revision or they will re-audit it from scratch.
type TransferVerification =
  | { status: "spec-pending" }
  | { status: "spec-checked"; document: string; revision: string; checkedBy: string };
```

`fromLinear` is not needed by the renderer. It exists because a round-trip test is the only check that
catches a transcription error in a piecewise function without a reference implementation to diff
against — the same reason `cpu.ts` is the ground truth for the LUT baker.

**Scene-referred normalisation — REVISED (review 2026-08-03).** The earlier draft folded a 203-nit
diffuse-white mapping into the PQ transfer function itself. That was wrong, and the reviewer's reasoning
is right: **a transfer function should represent the ENCODING, not editor policy.** PQ decodes to
absolute cd/m²; that is what PQ means. Deciding that 203 nits is "white" is a working-space question, and
burying it inside the decode makes HDR export harder later — the export path would have to un-apply a
normalisation it never asked for, and there would be no single place to change the reference.

So the two responsibilities split:

```
decode transfer  →  the encoding's own reference   (PQ: cd/m², HLG: scene 0..1, log: scene-linear)
        ↓
working-space normalisation  →  diffuse white = 1.0 in linear Rec.709
```

`toLinear()` returns the encoding's native quantity. A separate, explicitly-named
`normalizeToWorkingSpace(space, value)` applies the diffuse-white policy (BT.2408's 203 nits for PQ,
E'=0.75 for HLG, 1.0 for scene-referred log, which is a no-op). One policy, one place, and HDR export can
choose not to call it.

**Semantic IDs** are already the design — `id: "apple-log"` is the stored value, `label: "Apple Log"` is
display-only. Stage 3 persists the id, never the label, so localisation stays free.

### The risk you should decide on

**The formula CONSTANTS are being written from memory, not transcribed from the vendor PDFs in front of
me.** The structure of each curve I am confident about; the specific coefficients (`0.24151`, `5.367655`,
`47.28711236`, …) are exactly the kind of thing that is easy to get subtly wrong, and a wrong constant
does not crash — it produces a picture that is plausibly wrong, which is the worst failure mode for a
colour tool.

What the tests CAN prove without the source documents: round-trip exactness, monotonicity, continuity
across each piecewise join (a transcription slip usually shows up as a visible kink), 0→0, and correct
ordering between formats. What they CANNOT prove: that the constants are the vendor's constants. A test
written from the same memory as the code is not an independent check.

So Stage 2a lands as **`verified: "unverified"`** on every camera-log entry, and the flip to `"spec"` is
a separate human pass against the vendor documents:

| Format | Source document to check against |
|---|---|
| Apple Log | Apple, *Apple Log Profile White Paper* (2023) |
| S-Log3 | Sony, *S-Log3 / S-Gamut3 Technical Summary* |
| V-Log | Panasonic, *V-Log/V-Gamut Reference Manual* |
| LogC3 | ARRI, *ALEXA LogC Curve — Usage in VFX* |
| LogC4 | ARRI, *LogC4 Logarithmic Colour Aware Curve* (2022) |
| D-Log | DJI, *D-Log Decoding Guide* |
| F-Log | Fujifilm, *F-Log Data Sheet* |
| HLG / PQ | ITU-R BT.2100, SMPTE ST 2084 — standards, highest confidence |

This is safe to land unverified **only because nothing consumes it yet**: no renderer call site, and the
whole feature sits behind Stage 3's override plus the `hdrPipeline` flag. It is dead code with tests
until someone wires it. That is the point — the math gets to be reviewed before it can affect a frame.

**Alternative if you would rather not carry unverified constants at all:** do HLG and PQ only this pass
(both are open standards I am confident in and can state exactly), and hold the camera-log formats until
the vendor PDFs can be checked. Smaller, fully trustworthy, but it covers the *least* interesting case —
Apple Log on an iPhone is the footage this whole plan exists for.

### Stage 2a — SHIPPED 2026-08-03 (`input-transform.ts`, `idt:test`)

Landed dormant as designed: exported from the color barrel so Stage 3 can find it, **zero renderer call
sites**, 7 of 11 spaces at `verification: "spec-pending"`.

**The continuity test paid for itself immediately.** It is not a structural check — these curves are
published as a toe and a log segment *fitted to meet*, so a mistyped coefficient makes the branches part
at the join. Results:

| Format | Relative jump at join | Reading |
|---|---|---|
| Apple Log | 1.19e-8 | branches meet — constants mutually consistent |
| S-Log3 | 3.04e-8 | ” |
| LogC4 | 1.26e-8 | ” |
| HLG | 6.12e-9 | ” |
| LogC3 | 4.44e-6 | ” |
| V-Log | 5.59e-6 | ” |
| D-Log | 4.33e-5 | ” |
| **F-Log** | **1.34e-2** | **branches DISAGREE — at least one constant is wrong** |

**F-Log is the one real finding.** Its published inverse cut is `0.100537775`, but `e·cut1 + f` computes
`0.1006387` from the constants as written here. Those must be the same number. So one of `{e, f, cut1}`
is wrong, and **F-Log is the first format to check against its data sheet.** The curve is still usable —
the error is confined to a sliver either side of near-black — but it is knowingly imperfect and the test
says so on every run rather than hiding behind a widened tolerance.

**Independent corroboration for three formats.** 18% grey was derived from each curve, then compared to
the greys those formats are *known* to publish: **S-Log3 0.4106** (Sony states code 420/1023 = 0.41056 —
exact), **V-Log 0.4233** (Panasonic publishes 42.3% IRE), **LogC3 0.3910** (ARRI publishes ~39.1%). Three
constants sets landing on their published grey points is real evidence, arrived at from the curve rather
than asserted. It does not clear them for wiring, but it moves them from "memory" to "corroborated".

**Two test bugs found and fixed, both worth recording** — they were wrong *assumptions about log*, not
slips:

1. *"A log curve decodes code 0.5 to below 0.5."* False. LogC3 gives 0.5134 and LogC4 gives 2.2050, both
   correct: where code 0.5 sits relative to 18% grey is per-format (LogC3 puts grey at 0.391, LogC4 at
   0.278), so a format with more range above grey legitimately decodes 0.5 higher. **Scene-linear above
   1.0 is the expected result of a log decode, not a bug** — that headroom is what log buys. Replaced
   with the actual signature: highlights above diffuse white (code 1.0 → 7× to 470×), and convexity
   above grey.
2. *PQ was asserted continuous "at its join".* ST 2084 has no join — it is one smooth expression. The
   test was measuring the curve's own slope across its sampling interval, i.e. its own step size.

### Verification ladder + dashboard (added by review, 2026-08-03)

A binary verified/unverified flag lost the distinction that turned out to matter most: a curve whose
coefficients are unread but which *independently reproduces a published operating point* is in a
materially better state than one never compared to anything. Four statuses, each carrying the evidence
its own claim requires — so none can be granted by editing one word:

| Status | Means | Requires |
|---|---|---|
| `spec-checked` | compared against the authoritative document | `revision`, `checkedBy` |
| `corroborated` | reproduces published behaviour at a known operating point | `evidence` |
| `spec-pending` | implemented, internally consistent, externally uncompared | `document` |
| `known-inconsistent` | a defect is located | `issue` |

**Only `spec-checked` clears a space for wiring** (`spacesAwaitingVerification()`). Corroborated is
explicitly NOT sufficient: a matching grey point is evidence about one operating point, not about the
coefficient set, and the gate is "someone read the document".

Current state — **4 / 11 cleared**: Rec.709, sRGB, HLG, PQ. Corroborated: S-Log3, V-Log, LogC3.
Pending: Apple Log, LogC4, D-Log. Inconsistent: F-Log.

Because the stage is dormant there is no UI to read this from, so **`idt:test` prints the whole ladder on
every run** and is the colour-science progress tracker. Reviewers read the test output, not the registry.

### Not in Stage 2a

- **Gamut matrices (2b).** S-Gamut3.Cine / V-Gamut / ARRI Wide Gamut 3 / 4 / D-Gamut / F-Gamut → Rec.709.
  Same constant-transcription risk, larger number sets, less visible payoff. `nativeGamut` is recorded
  now so 2b is a pure addition.
- **Any renderer wiring.** Stage 2a must be pixel-neutral: `render:compare:pixels` unchanged, because
  nothing calls it.
- **Shader implementation.** The transforms have to run per-pixel on the GPU eventually. The CPU form
  lands first because it is the testable ground truth the LUT baker already consumes — same pattern as
  `applyPipelineToRgb` → `bakePipelineToLut3d`.

## Agreed order of work (settled 2026-08-03 — Stage 2a architecture is CLOSED)

Design is done; what remains is verification and integration, not architecture. Do not reopen 2a's shape.

1. **Wait for the editor files to stabilise.** `EditorPage.tsx` and the inspector are live with ADR-012
   sibling work. Three performance measurements were already voided today by hot-reloads of half-edited
   render code; do not interleave.
2. **Vendor-document verification pass.** Order: **F-Log first** (only format with a localised,
   reproducible defect), then Apple Log, S-Log3, V-Log, LogC3, LogC4, D-Log.
3. **Promote verified spaces to `spec-checked`**, with `revision` and `checkedBy` filled in.
4. **Stage 3 — offering ONLY `spec-checked` entries.**
5. **Stage 2b — gamut matrices**, once a user can actually select an input space.

**The step that actually gates Stage 3 is (2), not the UI.** Today `spacesAwaitingVerification()` would
hide 7 of 11 — including Apple Log, the format this entire plan exists to serve. A dropdown built before
the verification pass would ship with nothing worth selecting in it. Budget the reading, not the widget.

## Stage 2.5 — Display transform (ODT), added by review 2026-08-03

Accepted as a distinct concept. An IDT gets footage *into* the working space; a **display transform** gets
the working space *onto a screen*, and it is not the same thing as export. Everything below belongs to it
and has nowhere else sensible to live:

- SDR preview of HDR material (tone mapping)
- display/monitor LUTs and calibration
- the viewer's own transform, which may legitimately differ from the export's

Naming the boundary now costs nothing and stops display concerns from leaking into IDTs later — which is
precisely the mistake the PQ normalisation above was making. Not scheduled; recorded as the correct home
for that class of work.

## Stage 3 — Manual "Input Color Space" override

Per-clip dropdown; detection sets the default, user overrides. **Not a nicety** — camera log is
frequently untagged or mistagged, and every professional tool has this control for exactly that
reason. Stage 2 without Stage 3 is unshippable.

## Stage 4 — Unsupported acquisition codecs (broadened by review 2026-08-03)

Was "ProRes / RAW". Renamed because the capability is codec-independent and naming it after two formats
invites a second implementation when the third arrives. The bucket is: **anything the browser cannot
decode but a professional acquires in** — ProRes, CineForm, DNxHR/DNxHD, REDCODE, BRAW, Canon RAW,
X-OCN. Architecturally one feature: detect an undecodable codec at ingest, transcode, keep the original.

Cannot decode in-browser, so transcode on import. This fits the existing architecture rather than
adding a new one: `sourceProxy.worker.ts` already does off-thread transcode to proxies with originals
kept for export. Add a WASM ffmpeg decode path there.

Biggest lift, fewest users helped, and it does not block anything else. Last.

---

## Review response — 2026-08-03

Points accepted and folded in above: no half-float uploads (Stage 0.2, and the stronger correction that
there is no 10-bit to preserve at that point anyway); format-driven artifact budget; richer confidence
model (Stage 1); split `implementation` / `verification` status (Stage 2a); PQ/HLG normalisation moved out
of the transfer functions; Stage 2.5 display transform; Stage 4 broadened; **working colour space stated
explicitly**, which was a real omission that left Stage 2b undefined.

Two points NOT taken as given, with reasons:

**"Abstract precision into `WorkingPrecision` / `RenderTargetConfig`."** Agreed on naming, but the stated
benefit — easier WebGPU/Vulkan migration — is already banked and does not depend on the rename. Every GL
enum is confined to `RenderTarget.allocate()`; `RenderTargetPrecision` is already the abstraction
boundary, and callers pass `this.precision` without touching a GL constant. What actually leaks is that
the *token values* read as GL formats (`"rgba8"`), which is a clarity problem, not a portability one.
Renaming a shipped union used across ~20 call sites, while a sibling agent is mid-flight in the same
package, buys clarity at the cost of conflict risk. **Deferred to whenever a second backend actually
lands**, when the rename can be driven by a real second implementation instead of a guess at one.

**"Budget should be `w × h × bytesPerPixel(format) × samples`."** The format half shipped in `a30a0fc`.
The `samples` factor is declined: there is not one multisampled render target in the compositor, and
`presentFrame` explicitly avoids blitting to a multisampled default framebuffer. A factor that is always
1 is untested by construction and reads as though MSAA is supported when it is not. Add it with the
first multisampled target, not before.

Two things the review did not catch, now recorded above:

1. **Stage 0 never delivered "10-bit".** Uploads are RGBA8, so source precision is gone before any render
   target exists. The stage title was making a claim the code cannot support. Retitled, rescoped, and the
   real 10-bit-input work called out as separate and unproven.
2. **Rec.709 linear clips wide-gamut log.** Choosing it as the working space means S-Gamut3 / ARRI Wide
   Gamut / BT.2020 colours are destroyed on the way in, before the grade. Stage 2b makes log *correctly
   interpreted*, not *colour-accurate*, and the plan now says so rather than letting the UI imply
   otherwise.

---

## Sources

- WebCodecs codec support dataset — https://webcodecsfundamentals.org/datasets/codec-support/
- Codec analysis 2026 (1.1M sessions) — https://webcodecsfundamentals.org/datasets/codec-analysis-2026/
- Apple Log on iPhone — https://dblabsapps.com/blog/apple-log-video-iphone/
- Apple ProRes — https://en.wikipedia.org/wiki/Apple_ProRes
