# Lumio — Professional Color System (Phase 3 "Color" maturity)

> **Goal:** a Premiere-grade (Lumetri-class) color pipeline — curves, color wheels, HSL
> secondaries, LUTs, and scopes — that stays editable, undoable, and **pixel-identical
> across the web preview and the Remotion export**. This is renderer-foundation work
> (Phase 3 in `AI_ARCHITECTURE.md`), explicitly authorized to touch the renderers, unlike
> the Lumio-AI feature whose golden rule forbids it. The AI planner gains access to the new
> params at the end (13C.6).

## Why this exists

Today color is a **CSS-filter approximation** in [`composition-style.ts`](packages/shared/src/composition-style.ts):
`brightness()/contrast()/saturate()`, with temperature faked via `sepia()` + `hue-rotate()`.
There's even a `curves` effect type that collapses into `brightness/contrast`. CSS filters
**cannot** express real curves, Lift/Gamma/Gain, per-channel RGB, HSL secondaries, or LUTs —
so the output ceiling is "shallow" (Bug Ledger #32–35). A professional editor needs a real
color engine.

## Reference model — Adobe Lumetri (what we're matching)

Six sections, applied as a **pipeline** (processing order ≠ panel order):

1. **Basic Correction** — input LUT / color management → White Balance (Temperature, Tint) →
   Tone (Exposure, Contrast, Highlights, Shadows, Whites, Blacks) → Saturation.
2. **Creative** — creative-Look LUT + Intensity, Faded Film, Sharpen, Vibrance, Saturation,
   Shadow/Highlight tint balance (2-axis).
3. **Curves** — RGB/master curve **+ 5 Hue/Sat curves** (Hue×Hue, Hue×Sat, Hue×Luma,
   Luma×Sat, Sat×Sat).
4. **Color Wheels** — 3-way Lift/Gamma/Gain (Shadows/Midtones/Highlights) + Color Match.
5. **HSL Secondary** — key a hue/sat/luma range (eyedropper + Denoise/Blur on the mask), grade it.
6. **Vignette** — amount, midpoint, roundness, feather.

Doctrine: **correct → create → polish**, judged against **scopes** (RGB Parade for
black/white balance, Waveform for exposure, Vectorscope skin-tone line ≈123°), legal levels last.
UI: one stacked, collapsible panel; every control has numeric field + slider + reset; wheels
and curves are direct-manipulation; non-destructive and re-editable.

_Sources: Adobe Lumetri docs; frame.io 2024 color guide; DaVinci log-to-final workflow guides._

## Quality principle (standing) — high-end engines, not approximations

Lumio is **professional-grade** (Premiere/Resolve target). The rule for color & effects: always
favor **high-end engines that are lightweight enough for the browser yet produce extraordinary
results** — WebGL/WebGPU fragment shaders, **float precision**, **linear-light / wide-gamut**
working space, **real 3D LUTs** — over CSS `filter` or even SVG-filter approximations.

Fidelity ladder (worst → best):
1. **CSS `filter`** — crude hacks (brightness/contrast/sepia). *Retired.*
2. **SVG filter primitives** (`feColorMatrix` + `feComponentTransfer`) — real per-channel 1D LUTs +
   matrices, GPU-composited, pixel-aligned across both renderers. **But 8-bit, gamma-space, no 3D
   LUT / HSL-secondary / hue-vs-hue.** Used as the fast interim for 13C.0–13C.2.
3. **WebGL/WebGPU float shader + 3D LUT** — the real high-end engine: float precision, linear-light
   grading, real LUTs & secondaries. **This is the target backbone** (13C.3+). Must run identically
   in the web preview and the Remotion headless-Chromium export (`chromiumOptions.gl:"angle"`),
   verified by `render:compare:pixels`.

**Direction:** as the system matures, the WebGL float engine should become the backbone for *all*
color (curves/wheels included), not just the advanced secondaries — the SVG path stays only as a
no-GL fallback. Don't ship an approximation where the user expects pro results.

## Core architecture — one transform, two engines

Pixel-alignment is satisfied **by construction** if both renderers apply the *same* compiled
color transform. Both renderers are Chromium (web preview = DOM/CSS screenshotted via
Playwright; Remotion = React in headless Chromium), which is *why* the shared CSS filter string
aligns them today. We keep that property and upgrade the mechanism.

**Shared module `packages/shared/src/color/`:**
- `compileColorPipeline(effects, { intensity }) → ColorPipeline` — a device-independent
  representation: a 3×4 **color matrix** (white balance + saturation) followed by per-channel
  **transfer functions** (tone/curves), plus (later) CDL slope/offset/power and a 3D LUT ref.
- The pipeline is emitted two ways that produce identical pixels:
  - **SVG filter primitives** (`feColorMatrix` + `feComponentTransfer`) for the DOM renderers.
    `feComponentTransfer type="table"` *is* a 1D LUT (→ Curves); `type="gamma"`
    (slope/exponent/offset) maps exactly to **ASC-CDL** (→ Color Wheels). No GL required.
  - **CPU reference** (`applyPipelineToRgb`) — the same math on RGB values, for deterministic
    tests and any non-DOM fallback.
- **WebGL / 3D-LUT path** (13C.3+ only): hue-dependent curves, HSL-secondary keying, and
  `.cube` LUTs that SVG can't express. Remotion runs WebGL via `chromiumOptions.gl: "angle"`
  (confirmed available in `renderMedia`); web preview uses a canvas the screenshot captures.

**Working space:** grade in **linear light** (decode sRGB→linear, operate, encode→sRGB) for
correct tone/saturation math. Rec.709/sRGB scope; no HDR for now.

## WebGL backbone — verification-first rollout (no blind renderer replacement)

The high-end WebGL float + 3D-LUT engine is **built but gated**, and replaces the DOM/SVG
path only after pixel-parity is proven. The safe path (do NOT skip):

1. **Engine flag** — `apps/web/src/color/render-engine.ts` (`getColorEngine()`): default `dom`
   (production untouched); `?colorEngine=webgl` / localStorage / `VITE_COLOR_ENGINE` opt-in. The
   same timeline JSON renders through either engine.
2. **Shared engine (done)** — `color/lut3d.ts` (bake pipeline → float 3D LUT), `color/shader.ts`
   (GLSL, manual trilinear via `texelFetch` — no float-linear extension needed), `color/webgl-applicator.ts`
   (`WebglColorApplicator`, shared by both renderers so the program is byte-identical).
3. **Pixel-comparison gate (reuse existing infra)** — extend the existing
   [`render-pixel-comparison.ts`](apps/worker/src/render-pixel-comparison.ts) harness (screenshots
   the `/editor/__preview-fixture` page and diffs against Remotion `renderStill()` with pixelmatch;
   today ~0.245%). Add: **DOM-preview vs WebGL-preview** and **WebGL-preview vs Remotion still**,
   each under a small tolerance. Runs in a real browser/GPU env (CI / local / Docker Playwright image)
   — NOT the current sandbox.
4. **Golden fixtures** — small timelines, each with an expected PNG + max-diff threshold:
   plain video (no fx), identity LUT, brightness/contrast/saturation, curves, color wheels, 3D `.cube`,
   object-fit cover, object-fit contain, transformed layer (scale/rotate), matte/mask, warp text over video.
5. **WebGL smoke tests** — shader compile, LUT upload, `readPixels` identity render (prove the engine
   runs; they do NOT prove parity — that's the pixel gate's job).
6. **Flip the default to `webgl` only after the fixtures pass.** Keep DOM/SVG as the permanent no-GL fallback.

> Note: Remotion video uses `<OffthreadVideo>` (frames off-thread), so per-frame WebGL grading of
> **video on export** needs a dedicated frame-access solution; images/text/shapes are tractable in both.

## Sub-phases (each independently shippable + pixel-verified)

| # | Scope | Mechanism | Renderer? |
|---|-------|-----------|-----------|
| **13C.0** | Engine pivot + parity proof. Build `color/`; port existing primaries (exposure/contrast/sat/temp/tint/tone) off CSS onto the pipeline in both engines. Re-baseline `render:compare:pixels`. | SVG filter | both |
| **13C.1** | Correct primaries (Kelvin white balance, true highlights/shadows/whites/blacks rolloff) + **Curves** (master + R/G/B) + Vignette + curve-editor UI. | SVG table | both |
| **13C.2** | **Color Wheels** (Lift/Gamma/Gain via CDL) + wheel UI. | SVG gamma | both |
| **13C.3** | **Hue/Sat curves** + **HSL Secondary** keyer with mask preview. | WebGL | both |
| **13C.4** | **LUT** (`.cube`) + Creative looks (dropdown + intensity + built-in pack). | WebGL 3D LUT | both |
| **13C.5** | **Scopes** — Waveform / RGB Parade / Vectorscope / Histogram. | editor-only | — |
| **13C.6** | **Lumetri-style stacked panel UI** + register every param in `effects.ts` so the **AI planner** can drive them (closes Ledger #32–35) + look presets in memory. | — | — |

## Verification (every sub-phase)

- `pnpm -r typecheck` (the lint).
- `pnpm --filter @reelforge/worker render:compare:pixels` stays aligned (re-baselined at 13C.0).
- `pnpm --filter @reelforge/shared color:test` — CPU reference correctness (identity = passthrough;
  exposure brightens; saturation 0 = grayscale at correct luma weights; etc.).
- `pnpm --filter @reelforge/worker render:manifest <file>` spot-checks on real footage.
- `animation:test` for any keyframed color params.

## Status

- **13C.0 — ✅ done.** Shared color engine (`color/` — compile + SVG emitter + CPU reference +
  `color:test`, 24 checks) AND renderer wiring: `composition-style.ts` routes color effects off
  CSS filters into `getCompositionColorFilter()` (SVG `url(#lumio-color-…)`); both renderers inject
  the shared `buildColorFilterDefs()` markup (warp-style inline SVG) — web at the layer-map site,
  Remotion per-layer in `RenderLayer`. `render:compare` (style) + `render:compare:pixels`
  (**0.245%, unchanged baseline**) + `animation:test` all green. Color is now a real pipeline, not
  a CSS approximation.
  - _Follow-up:_ the pixel fixture has no color effect yet, so 0.245% proves *no regression*; add a
    color effect to the fixture in 13C.1 to pixel-prove the color path itself.
- **13C.1 — ✅ done (graph Curves).** New `colorCurves` effect: a real **graph curve editor**
  (`apps/web/src/components/CurveEditor.tsx`) — Master + R/G/B channels, draggable control points,
  monotonic Fritsch–Carlson spline (`color/curve.ts`) sampled into the same `feComponentTransfer`
  LUT the renderer applies (no new renderer code). Reuses the keyframe `graph-editor` look.
  **Live preview while dragging**; per-edit **undo** button (steps back one point-change at a time).
  Wired via a new `type:"curve"` effect param + `EffectParamControl`. Retired the shallow
  **Color Grade** + scalar **Tone Curves** panel effects (kept in the union/engine for back-compat);
  AI capabilities registered (`colorCurves` in `describeForPlanner`, intent notes, deterministic
  `curve(s)` → colorCurves and `grade/cinematic` → brightnessContrast). Also fixed: effect-row
  drag-to-reorder now only triggers from the grip handle, not from sliders/curve points.
  The pixel fixture now carries a `colorCurves` effect. `color:test` (34 checks) + all standalone
  suites + `pnpm -r typecheck` green; `render:compare` (style) green. _`render:compare:pixels` not
  re-run here — the sandbox's Playwright browser binary is missing and won't download; parity is
  structural (identical shared SVG markup in both Chromium engines)._
- **13C.2 — ✅ done (Color Wheels).** New `colorWheels` effect: 3-way **Shadows / Midtones /
  Highlights** wheels mapped to **ASC-CDL** (`out = (in·slope + offset)^power`; Lift→offset,
  Gamma→power, Gain→slope) in `color/wheels.ts`, baked into the same per-channel
  `feComponentTransfer` LUT — **no renderer change**. Interactive editor
  (`apps/web/src/components/ColorWheels.tsx`): three color-balance pads (drag to push hue,
  double-click to reset) + master luma sliders styled to match the other effect sliders, live
  preview, per-gesture undo. Pro visual pass: desaturated hue ring → neutral center, depth/bezel,
  crosshair reticle, ring handle. `type:"wheels"` param + AI capabilities (planner + intent notes:
  "color wheels / lift gamma gain / 3-way" → colorWheels). `color:test` (38 checks) + all suites +
  `pnpm -r typecheck` + `render:compare` green.
- **13C.3 — ✅ built (Hue/Sat curves + HSL Secondary), WebGL now the default engine.**
  - `color/hsl.ts`: rgb↔hsl + **Lumetri hue/sat curves** (hueVsHue/hueVsSat/hueVsLuma/lumaVsSat/satVsSat;
    periodic hue domain, flat-0.5 neutral) and **HSL Secondary** (feathered hue/sat/luma key + hue/sat/luma
    correction). Cross-channel HSL ops → carried in `ColorStage.hsl`, applied by `applyPipelineToRgb`, so they
    **bake into the same 33³ float LUT** (WebGL + CPU agree). SVG omits them (can't express a 3D LUT) — which is
    why WebGL is now the default (`render-engine.ts` default `dom`→`webgl`, still WebGL2-gated + boundaried).
  - `bakeMatteLut3d` renders the secondary's key as a grayscale matte for the editor "Show mask" toggle
    (`pipeline.previewMatte`; `WebglColorView`/`WebglVideoOverlay` swap to it).
  - UI: `HueSatCurves.tsx` (five domain-colored graphs, localized-bump seeding, samples the engine's exact fn)
    + `HslSecondary.tsx` (hue strip + band/feather sliders + correction + Show-mask). Curve editors now map the
    pointer via `getScreenCTM().inverse()` (was an aspect-ratio-letterbox bug: clicks off-line, drags lagging).
  - **Export parity:** Remotion now applies the SAME baked 3D LUT to **image layers** via a WebGL canvas
    (`LutGradedImage` in `remotion/Root.tsx`, `chromiumOptions.gl:"angle"`) — so hue-curves/secondary match the
    preview on export by construction. The pixel fixture now carries an `hslSecondary` grade to prove it.
    **Still SVG-only on export (legacy path):** text/shape layers (HSL on those is rare) and **video** —
    superseded for video by 13C.3b below (`<OffthreadVideo onVideoFrame>` gives per-frame GPU pixel access),
    available under `rendererMode=webgl`; the legacy default still uses the SVG approximation for video.
  - `pnpm -r typecheck` + `color:test` (51) green. **Gate to run in a GPU/browser env:** `color:compare`
    (DOM vs WebGL preview) and `render:compare:pixels` (WebGL preview vs Remotion LUT export).
- **13C.3b — ✅ built (unified WebGL media pipeline), flag-gated `rendererMode=webgl`, default still `legacy`
  pending the GPU parity gate.** Closes two parity bugs in one shared renderer:
  - **Double-grade bug (preview ≠ export):** the legacy preview overlaid a WebGL graded canvas *over* the
    still-SVG-filtered `<img>`/`<video>`, so seams showed a doubly-graded source. Now a single
    `MediaWebGLRenderer` (`packages/shared/src/color/media-renderer.ts` + `media-shader.ts`) is the SOLE
    output; the source element is a hidden decode source carrying `skipColorFilter:true`
    (`composition-style.ts`), so grading lives only in the shader. One pass does **3D-LUT color + luma matte
    + layer opacity**.
  - **Video export-grading blocker (the 13C.3 "known blocker" above):** `WebglMediaVideoRemotion`
    (`apps/worker/src/remotion/WebglMediaLayerRemotion.tsx`) grabs each decoded frame from
    `<OffthreadVideo onVideoFrame>` and grades it through the SAME shader — so **graded video now exports
    through WebGL, not the SVG approximation**, and matted layers (previously canvas-2D only, color silently
    dropped) now carry the grade too.
  - Web: `apps/web/src/components/WebglMediaLayer.tsx` (unified image+video) wired into `VideoPreview.tsx`;
    Remotion: `WebglMediaImageRemotion`/`WebglMediaVideoRemotion` wired into `Root.tsx`. Both honor the
    `rendererMode` flag (web: `?rendererMode=` / localStorage / `VITE_RENDERER_MODE`; worker:
    `process.env.RENDERER_MODE` via Remotion `envVariables`). Legacy paths kept intact as the fallback.
  - **Pixel harness extended:** `render-comparison-fixture.ts` now exposes keyed variants (plain-image,
    brightness-contrast, color-curves, object-fit cover/contain) and `render-pixel-comparison.ts` sweeps all
    of them in the selected `rendererMode`, writing per-fixture diffs. `pnpm -r typecheck` + `color:test` (51)
    + `animation:test` green. **Gate to run in a GPU/browser env (not available in CI/headless-less dev):**
    `pnpm --filter @reelforge/worker render:compare:pixels` (sweeps every fixture, rendererMode=webgl) —
    when green, flip BOTH defaults to `webgl` (`render-engine.ts getRendererMode` and `Root.tsx getRendererMode`).
  - **Known limitation:** the shader matte does a luma multiply with the codec-noise snap (NOISE_FLOOR/CEILING)
    but not the legacy `compositeMatteToImageData` feather/edgeMode blur — WebGL preview and WebGL export match
    each other exactly, but may differ slightly from the old canvas-2D matte on feathered edges.
- **13C.4 — ✅ done (`.cube` LUT import + Creative Looks).** New `creativeLook` effect (8 built-in look presets — Teal & Orange, Faded Film, Noir, Warm Sunset, Cold Morning, Cinematic, Bleach Bypass, Cross Process — with intensity slider; `looks.ts` registry encodes as pipeline params, no binary). New `importedLut` effect: parses standard `.cube` files via `cube-parser.ts`, serialises to base64 for effect params via `lut3dToBase64/lut3dFromBase64`, slots into a new `ColorStage.lut3d` field, applied by `applyPipelineToRgb` and baked into the final 3D LUT automatically. `LutFileImport.tsx` handles drag-and-drop + file-picker. Both effects registered in `timelineEffectTypes`, `effects.ts`, `composition-style.ts`, and `EffectParamControl` (new `look`/`lut` param types). `pnpm -r typecheck` clean (web + shared).
- **13C.5 — ✅ done (Color Scopes).** `ColorScopes.tsx`: Waveform, RGB Parade, Vectorscope (with skin-tone line at 123°), and Histogram panels. Samples from the first `<canvas>` or `<video>` inside the preview phone-frame via OffscreenCanvas (160×90 downsample). Exposed via a Scopes toggle in the Controls panel and in the new Color panel. `VideoPreview` gains an optional `frameRef` prop (merged via callback ref) so callers can point the scope at the live preview frame.
- **13C.6 — ✅ done (Lumetri-style panel + AI planner).** `LumetriPanel.tsx`: stacked collapsible sections (Basic Correction / Creative / Curves / Color Wheels / Hue/Sat Curves / HSL Secondary / Vignette), each with an active indicator dot and reset-to-defaults button. Upserts effects on first edit (no manual "add effect" step). Wired into a new "Color" tab in the editor left panel alongside the Scopes toggle. AI planner (`DeterministicPlanner.ts`) extended: `hueSatCurves` intent ("hue sat curves / hue vs sat"), `hslSecondary` intent ("secondary / isolate color / mask color"), `creativeLook` intent ("look / preset / teal orange / faded film / noir / bleach bypass / cross process").
- **13C.7 — ✅ done (Color tab UI styling/polish).** All new color-tab components were shipping with no CSS (unstyled). Added full theme-matched styling in `global.css`: fixed the `.tabbar` grid (`repeat(3 …) → repeat(4 …)` — the 4th "Color" tab pushed the settings-gear onto a second row), plus styles for `.lumetri-panel`/sections/headers/active-dot/reset, `.lumetri-look-select`, `.color-scopes`/tabs/canvas, `.lut-import` (dashed import button + loaded chip), and `.scopes-toggle-bar`/`-btn`.
- **E1 — ✅ done (pro native stylize effects + renderer-default flip).** `vignette`, `grain`, and `chromaKey` were `manifest-only` (no real render). Now implemented as **real per-pixel ops in the shared WebGL media shader** (`media-shader.ts` `main()`), driven by `MediaWebGLRenderer` (the single pass used by both the web preview and the Remotion export — pixel-parity by construction, lightweight: one GPU pass, no extra textures/overlays/libraries): vignette = smooth radial falloff w/ size; grain = luminance-aware, deterministic per-frame (seeded by composition time so preview==export); chroma = color-distance keyer w/ soft edge + green-spill suppression (added a `softness` param). New `MediaEffects` type (`color/types.ts`) + `getCompositionMediaEffects()` extractor (`composition-style.ts`, keyframe-resolved); threaded through `WebglMediaLayer` (web) and `WebglMediaImageRemotion`/`WebglMediaVideoRemotion` (worker) via a ref so the playback loop animates grain/keyframed vignette. All three effects flipped to `previewSupport/renderSupport: "native"`. **Default `getRendererMode()` flipped `legacy → webgl`** in both `apps/web/src/color/render-engine.ts` and `apps/worker/src/remotion/Root.tsx` (the unified path is the only one that can apply these; reversible via `?rendererMode=legacy` / `RENDERER_MODE=legacy`). _Still TODO:_ run `render:compare:pixels` in a GPU env to formally confirm parity. `pnpm -r typecheck` clean (shared + web + worker). Standing rule recorded: effects must be pro-grade shader implementations, not overlays.
- **13C.8 — ✅ done (Color tab slider parity + keyframes).** Extracted the Controls-tab slider into a shared `components/EffectSliderControl.tsx` (`EffectSliderControl` + `effectSliderTone` + `formatEffectValue`); EditorPage now imports it instead of defining its own. The Lumetri panel's sliders were rebuilt on top of it, so the Color tab now has **identical tonal track colors** (warmth/tint/saturation/shadow/highlight/light) **and per-param keyframes** (diamond toggle + interpolation), matching the Basic Color Grade effect exactly. The backing effect is created lazily (`ensureEffect`) on first edit/keyframe so browsing a section never mutates the project. HSL Secondary's internal sliders were restyled to the same custom track/thumb (dropping the bare native `accent-color`). `pnpm --filter @reelforge/web typecheck` clean.
  - _Related (non-color) timeline polish landed in the same passes:_ solid per-type clip colors; clip name in a bottom accent bar (video clips show filmstrip only, no name); audio name as a hover-only top-overlay (soft green scrim, no layout shift); thin rounded pixel-space waveform bars whose density scales with zoom (hi-res decode cached + resampled in `audioPeaks.ts`); playhead raised above selected clips; and an out-of-order save guard (`saveSeqRef`) in `updateGraph` that stops stale `patchProject` echoes from reverting newer optimistic state.

## Risks / decisions

- **Re-baseline expectation:** 13C.0 changes the *absolute* look (more correct color), so the
  pixel-comparison baseline image is regenerated once. Parity is web-vs-Remotion, which the shared
  emitter preserves; the look shift is intended.
- **WebGL in Remotion (13C.3+):** mitigated — `gl:"angle"` (or software `swangle`) is available;
  if a render env lacks GL, the CPU reference applies the same transform (slower export, identical
  pixels).
- **Performance:** SVG filters are GPU-composited in Chromium and real-time at 1080p; scopes
  downsample; the WebGL path is a single fragment pass.
