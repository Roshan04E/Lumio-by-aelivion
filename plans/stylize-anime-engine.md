# Stylize Engine — photoreal footage → illustrated / anime / comic-print motion

Status: **RESEARCH + PLAN (2026-07-18). Not started. Do not execute until the plan is
approved.** Reference brief: user wants a Spider-Verse-class stylization of real footage —
an advanced effect no mainstream browser editor ships. "Best effects, no hurry."

---

## 1. Research findings

### 1.1 What Spider-Verse actually is (and is not)

Sony Imageworks' pipeline (fxguide/Foundry breakdowns) is **not** generative AI. It is CG
renders + a stack of deliberate print-craft operations in comp:

- **Halftone dots + hatch lines** ("Hatcher"/"Thresher" comp tools) — color as dot fields,
  gradients as dot-size ramps, shadows as hatching. Straight from screen-printed comics.
- **CMYK offset misregistration** — misaligned color plates as a *pseudo-focus* cue:
  offset grows with defocus/depth instead of lens blur. This is the signature fringe.
- **Ink lines** — their one ML component: artists drew training lines, a model learned to
  place them across angles/expressions. Procedural toon outlines alone were rejected as
  too sterile. (Lesson for us: line QUALITY is where the style lives — our line pass
  deserves the most engineering.)
- **Animation on twos** — 12 distinct images/sec held 2 frames while camera/sims run at
  24. The single strongest "this is animated, not filtered" signal.
- No motion blur; smears/multiples drawn instead (out of scope for v1).

**The distinction that frames this whole project**: OpenAI-style img2anime *redraws* the
image generatively (geometry changes, faces become anime faces). That is server-side
diffusion, seconds/frame, and temporally incoherent on video (per-frame boil). Not
buildable client-side in 2026. What IS buildable client-side — at real-time-ish speed,
deterministically, with excellent temporal stability — is the **NPR (non-photorealistic
rendering) stack** that produces the Spider-Verse / painted / cel / manga family: the
footage keeps its geometry and becomes a *painted-and-inked version of itself*. That is
exactly what the user's reference image is (real proportions, illustrated surfaces).
A future generative tier slots in later as a `cloud` adapter priced as COGS
(monetization doctrine), and browser fast-neural-style is a possible mid tier
(onnxruntime-web WebGPU runs tiny style nets at 16–20fps @ 720p on an RTX3070 — real but
quality-limited; deferred, see §6).

### 1.2 The four load-bearing techniques (literature)

1. **Anisotropic Kuwahara filtering** (Kyprianidis et al., PG 2009 + GPU Pro) — THE
   painterly abstraction filter. Generalizes Kuwahara with a kernel that rotates/stretches
   along the local structure tensor: flat "brushed" color regions, hard feature edges, no
   box artifacts. Two properties matter to us specifically:
   - **Temporally coherent on video by construction** — the paper demonstrates video
     abstraction with no extra inter-frame processing (deterministic per-frame math over
     smoothly-varying input ⇒ smoothly-varying output; no optical flow needed).
   - **Real-time on GPU since 2009 hardware** — comfortably in our WebGL2 budget at a
     downsampled working resolution.
   - Multi-scale variant (NPAR 2011) exists if we later want coarse-to-fine painting.
   - Practical WebGL pipeline (Heckel 2024 writeup): 3 passes — Sobel structure tensor →
     smoothed tensor + eigen-orientation → oriented 8-sector Kuwahara; polynomial sector
     weights `[(x+ζ)−ηy²]²` instead of per-tap Gaussians is the key perf trick.

2. **ETF + FDoG line extraction** (Kang et al., "Coherent Line Drawing" NPAR 2007) —
   lines an order of magnitude better than Sobel/toon outlines: build an **Edge Tangent
   Flow** field (smoothed, edge-aligned vector field), then run a 1-D DoG *perpendicular*
   to the flow and accumulate the response *along* the flow. Coherent strokes, junk edges
   suppressed — the closest procedural cousin to Imageworks' drawn ink lines. GPU-friendly
   (separable 1-D passes over a flow texture; we already compute the structure tensor —
   ETF is its minor eigenvector, nearly free).

3. **XDoG stylization** (Winnemöller/Kyprianidis/Olsen, C&G 2012) — the extended DoG
   with threshold/softness controls (`ε`, `φ`, `p`) that turns the same line machinery
   into whole STYLES: pencil hatching, charcoal, woodcut, negative edges, two-tone
   posters. One formula, several presets — very high style-per-line-of-code.

4. **Comic print synthesis** (standard shader craft, no papers needed): screen-space
   rotated halftone grids per channel (classic 15/45/75° CMY angles), luminance-driven
   dot radius, shadow hatching, per-channel UV offset for CMYK misprint (optionally
   driven by a depth/defocus proxy later), paper grain. All single-pass friendly.

### 1.3 Temporal behavior (the thing that kills naive video filters)

- Per-frame deterministic filters (our whole stack) cannot "boil" on a static shot —
  noise/flicker only enters via source noise. Mitigations: the pre-smoothing inherent in
  Kuwahara; a luma-dither on the cel-quantize threshold (stops band-crawl on gradients);
  ETF smoothing radius keeps lines from popping.
- Optical-flow-guided stylization (research SOTA for stroke-based looks) is explicitly
  **out of scope** — wrong cost/benefit in a browser, and Kuwahara+FDoG's inherent
  coherence is the reason we chose them.
- **"On twos" is a TIME feature, not a shader**: quantize the *source time* each frame
  samples (12fps holds inside a 30fps timeline). It must live in the render manifest
  (deterministic `sourceTime → heldSourceTime` mapping) so preview, browser export, and
  Remotion hold IDENTICAL frames. Line-boil (optional) = re-seed the line pass's noise
  from the QUANTIZED time — wobble on twos, still deterministic, export == preview.

### 1.4 What we already own (repo reality — this is why the project is tractable)

- **`packages/shared/src/color/fragment-effects/`** — a registry+harness where an effect
  is a GLSL body compiled into ONE assembled shader consumed by all three renderers (web
  preview scene-compositor, browser export, Remotion) → **pixel parity by construction**.
  Stylize passes written here land everywhere at once. Guarded by `render:compare:pixels`.
- **Scene-compositor pass loop** (`renderLayerWithRegionPasses`) — per-effect FBO
  ping-pong, per-pass MASKS already supported (region passes use them today). A future
  person-segmentation mask drops straight into this existing slot.
- **Registry-driven effect params** (`effects.ts` + `timelineEffectRegistry`) — schema
  params → auto UI controls + keyframable via the shared evaluator + AI-addressable
  through the same `addEffect`/`updateEffect` seam (the dedupe rule applies for free).
- **Browser-ML loader pattern** (`face-detection.ts` / `local-transcription.ts`) — the
  exact template for MediaPipe selfie/person segmentation when we get to Phase 4.
- **Doctrine already enforced**: pro-grade real shaders (never CSS fakes), effect-agnostic
  registry plumbing, capability gates for heavy paths, editor free / charge only COGS.

### 1.5 The one real engineering gap

The fragment-effect harness is **single-pass, single-input** (`vec4 effect(vec2 uv)` over
`uSrc`). The stylize stack needs a **pass GRAPH**: ordered passes where later passes
sample EARLIER outputs *and* the original source (Kuwahara needs the tensor texture +
src; FDoG needs the ETF texture + src; composite needs paint + lines). Plus per-pass
working scale (tensor/paint at ½ res, lines at full res). That extension —
`StylizePassGraph` — is the core new infrastructure, and it must keep the
"same assembled GLSL everywhere" law.

---

## 2. Product shape

**One first-class effect: `stylize`** (category Stylize), with a `style` preset param and
the full parameter set exposed under it. Presets are DATA rows over the same graph:

| Preset | Passes active | Character |
|---|---|---|
| **Painterly** | tensor → Kuwahara → tone | brushed oil/gouache flat-color regions (the reference image's surfaces) |
| **Anime Cel** | + luma posterize (N bands, dithered) + palette push + FDoG ink | clean cel shading, crisp dark lines |
| **Comic Print** | + halftone + CMYK misprint + paper grain + shadow hatching | the Spider-Verse print look |
| **Manga** | Kuwahara(light) + XDoG two-tone + screen-tone dots, desaturated | B&W tones + ink |
| **Sketch** | XDoG hatching mode only, paper tint | pencil/charcoal |

Naming note: presets must NOT use "Spider-Verse"/"Ghibli" (trademark + taste); the look
names above stand on their own. Marketing copy can say "comic-film style" at most.

Key params (all keyframable): `style`, `paintRadius`, `paintSharpness`, `celBands`,
`palettePunch`, `inkStrength`, `inkThickness`, `inkThreshold`, `halftoneScale`,
`halftoneAngle`, `misprintPx`, `paperAmount`, `boil` (0 = off), plus the standard
`uIntensity` mix. AI seam: "make clip 2 look like a comic" → `addEffect stylize` with a
preset — the mood/hypothesis planner can later register these as look rows.

**Time pass ("on twos")** ships as a SEPARATE small feature — `posterizeTime` on the
layer (12/8/6 fps holds) — because it lives in source-time mapping (grabbers on all
renderers), not in the shader stack. The two combine into the full anime feel but must
not be coupled in implementation.

Honesty line for users (docs/AI answers): this styles the footage — real geometry,
illustrated rendering, stable on video. It does not re-draw people as anime characters;
that's a future cloud-generative feature with per-use cost.

---

## 3. Architecture

### 3.1 StylizePassGraph (shared, `color/fragment-effects/`)

```ts
interface StylizePass {
  id: string;                     // "tensor" | "etf" | "paint" | "ink" | "print" | ...
  inputs: Array<"src" | `pass:${string}`>;  // bound as uSrc, uPass0, uPass1...
  scale?: number;                 // working-res factor (0.5 = half comp res), default 1
  glsl: string;                   // vec4 effect(vec2 uv) — same harness contract
}
interface StylizeGraphDefinition { id; name; params; passes: StylizePass[] }
```

- Assembler wraps each pass in the existing `#version 300 es` harness (+ extra sampler
  uniforms) — memoized per (graph, pass). Compositor runs passes in order through the
  existing RenderTarget pool; only the FINAL pass composites back through the existing
  masked `compositeTexture` path (so per-pass masks, opacity, blend, nesting all keep
  working unchanged).
- Single-pass fragment effects remain exactly as they are (a graph of one pass).
- Registered like everything else; a future plugin can register a graph (PLUGIN_ARCH
  alignment), but v1 keeps the API internal.

### 3.2 The passes (v1 full graph, ~7 passes)

1. `tensor` (½ res) — Sobel → (E, F, G) structure tensor, packed RGBA.
2. `tensorBlur` (½ res) — small Gaussian on the tensor (this IS the ETF smoothing too;
   minor eigenvector = flow direction, computed in consumers).
3. `paint` (½ res) — anisotropic Kuwahara, 8 sectors, polynomial weights; radius clamp
   ≤ 6 at preview scale (perf), ≤ 12 at export.
4. `ink1` (full res) — 1-D DoG perpendicular to flow (reads tensorBlur + src).
5. `ink2` (full res) — accumulate along flow + XDoG threshold (`ε/φ/p` = the
   Anime/Manga/Sketch personality knobs).
6. `tone` — upsample paint, luma posterize with blue-noise dither, palette punch
   (sat/temperature), optional shadow-hatch mixed by luma band.
7. `print+composite` — halftone grids, CMYK misprint offsets, paper grain, then
   `color × ink` composite → out.

Presets = which passes are identity and the param defaults; the graph is always the same
(simpler caching, simpler parity fixtures).

### 3.3 Performance budget

- Preview: stylize working res capped (≈1280w), paint half-res: target ≤ 4ms/frame on a
  mid iGPU for Painterly/Anime Cel; Comic Print ≤ 6ms. Kernel radii clamp by
  resolution. If the frame budget trips the existing degradation ladder, stylize
  falls to intensity-crossfaded lower radius before anything else stutters.
- Export: full res, full radii — offline, so cost is fine; browser-export path uses the
  identical graph (assembled-GLSL law).
- WebGL2 only, no WebGPU requirement, no wasm: works everywhere the editor works. (If
  WebGPU is present we get it for free later via the compositor, not via this effect.)

### 3.4 Determinism & parity

- No `uTime`-driven randomness by default; `boil > 0` uses hash(quantizedSourceTime) —
  still pure function of manifest data.
- New `render:compare:pixels` fixtures: one per preset over the standard test clip +
  1 keyframed-param fixture + 1 masked fixture. Gate stays 0.000%-class like the color
  pipeline.

---

## 4. Phases (each independently shippable, eval/pixel-gated)

- **P1 — Pass-graph infra + Painterly.** StylizePassGraph in the compositor (all three
  renderers), tensor/tensorBlur/paint/tone passes, `stylize` effect registered with the
  Painterly preset. Pixel fixtures. *This is the highest-risk, highest-value slice; when
  it's green the rest is shader-writing, not architecture.*
- **P2 — Ink + Anime Cel + Sketch/Manga.** ETF-FDoG ink passes, XDoG modes, posterize +
  dither + palette. Presets wired, controls + keyframing verified.
- **P3 — Comic Print.** Halftone, CMYK misprint, paper, hatching. The flagship preset.
- **P4 — Time.** `posterizeTime` (on-twos/threes) in the manifest + all grabbers
  (web preview `resolveSourceSeconds` seam, worker `SceneStage` remap, export
  compositor) + optional line boil. Ships separately; `render:manifest` visual QA
  mandatory (frame-hold parity is exactly the class of bug the repo has been bitten by).
- **P5 — Subject-aware styling.** MediaPipe person segmentation via the browser-ML
  loader pattern → mask feeding the EXISTING pass-mask slot: subject vs background get
  different ink/paint weights (the reference image's figure-vs-city separation).
  Capability-gated; declines to uniform styling when the model can't load.
- **P6 (unscheduled research) — generative tier.** Cloud diffusion adapter (true
  anime re-drawing, per-use COGS pricing) and/or browser fast-neural-style as a
  WebGPU-gated middle tier. Explicitly NOT part of the current effort.

Order of work inside each phase: shader in shared → controls → AI/action seam →
fixtures/evals → architecture.md entry.

## 5. Risks

| Risk | Mitigation |
|---|---|
| Multi-pass graph breaks the parity law somewhere subtle | assembled-GLSL law + per-preset pixel fixtures from day one of P1 |
| Kuwahara cost on weak iGPUs | working-res cap + radius clamp + degradation ladder hook |
| Cel banding crawls on gradients in motion | blue-noise dithered quantize thresholds (P2 acceptance row) |
| Ink flicker on noisy footage | ETF smoothing radius + XDoG soft threshold; acceptance = static-shot fixture diffs ≤ noise floor |
| On-twos interacts with speed ramps / transitions | P4 defines mapping order explicitly (ramp → hold → transition sampling); render:manifest QA before flip |
| Preset names inviting trademark trouble | neutral names (Comic Print, Anime Cel, Manga, Painterly, Sketch) |

## 6. Deferred/rejected alternatives (recorded so we don't re-litigate)

- **Per-frame diffusion img2anime in browser** — rejected: seconds/frame server-class
  compute + temporal boil; belongs to a future cloud adapter.
- **Browser neural style transfer (onnx WebGPU)** — deferred: runs (16–20fps @ 720p on
  a desktop GPU with a tiny model) but quality < the NPR stack for this target look,
  and it adds a model download + WebGPU gate for less control. Revisit for
  "style from reference image" later.
- **Optical-flow temporal regularization** — rejected for v1: our chosen filters are
  inherently coherent; flow adds huge cost for marginal gain here.
- **CSS/canvas2d filter fakes** — banned by standing doctrine.

## 7. Sources

- Kyprianidis et al., Anisotropic Kuwahara (PG 2009): https://www.kyprianidis.com/p/pg2009/ · GPU chapter: https://www.kyprianidis.com/p/gpupro/ · multi-scale: https://www.kyprianidis.com/p/npar2011/
- Kang et al., Coherent Line Drawing (NPAR 2007): https://cg.postech.ac.kr/papers/kang_npar07_hi.pdf
- Winnemöller et al., XDoG (C&G 2012): https://users.cs.northwestern.edu/~sco590/winnemoeller-cag2012.pdf · demo repo: https://github.com/jkyprian/xdog-demo
- fxguide — Spider-Verse ink lines & ML: https://www.fxguide.com/fxfeatured/ink-lines-and-machine-learning/ · visual breakdown: https://www.fxguide.com/fxfeatured/why-spider-verse-has-the-most-inventive-visuals-youll-see-this-year/
- Foundry — Spider-Verse comp (halftone/offset tools): https://www.foundry.com/insights/film-tv/graphic-look-in-comp-spiderman
- Heckel, painterly shaders in WebGL (practical passes/params): https://blog.maximeheckel.com/posts/on-crafting-painterly-shaders/
- onnxruntime-web WebGPU style transfer datapoint: https://github.com/joshbrew/onnxruntime-web-fast-style-transfer
