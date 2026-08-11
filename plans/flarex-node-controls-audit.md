# Flarex node controls & behaviour — audit against Fusion

**2026-08-11 · audit, no code.** Two halves: what parameters exist (cheap, mechanical), and what the
nodes actually DO across their range (the half that matters, and the half nobody runs).

Scope is fixed and not reopened here: **2D/2.5D only** — no 3D geometry, lights, materials, mesh or
particles. Target users are YouTubers and small creators through to professionals doing **titles,
cleanup, screen replacement and beauty work**, not feature-film VFX. Every recommendation below is
filtered through that: *a control no target user would ever touch is not a gap*, and it is marked so.

Nodes under active maturation in `plans/flarex-node-maturity.md` — masks, tracker, keyer — are
skipped except where a control gap is obvious in passing.

## What is measured here, and what is not

**Measured, on this machine, through the real renderer.** Every glow number in §3 comes from
rendering a synthetic chart through `renderManifestStill` — the Remotion path, which consumes the
same shared `SceneCompositor` the web preview does. The charts are in `apps/worker/tmp/glow-measure.ts`
and `glow-measure2.ts`; the frames are in `apps/worker/tmp/glow/`. Numbers are 8-bit code values on a
1080×1920 frame at `renderScale` 1.

**NOT measured: everything on the Fusion side.** DaVinci Resolve does not run on this machine and was
not run. Every claim about what Fusion does is marked **[Fusion: documented]** — from the tool
reference and standard behaviour — and never presented as a measurement. Where the comparison needs a
number I do not have, it says so rather than inventing one. A confident comparison against a number
nobody took is worse than a stated gap.

---

## Part 1 — inventory, all 39 nodes

Maturity verdict is one word: **solid** (does its job across its range), **thin** (works, but the
range or the feature set falls short of the reference), **broken** (does not do what its name
implies), **stub** (declared, not implemented).

| Node | Does | Parameters | Verdict |
|---|---|---|---|
| `mediaIn` | Source: host clip or a media-pool asset | sourceAssetId, sourceInSeconds, freeze | solid |
| `mediaOut` | Comp output | — | solid |
| `merge` | Composite fg over bg | blend (17 modes), opacity | **thin** — no Apply Mode/operator, no fg/bg transform |
| `transform` | Pan/scale/rotate, anchor | x, y, scale, rotation, anchorX, anchorY | **thin** — uniform scale only, no flip, no edge mode |
| `crop` | Trim edges with a soft edge | left, right, top, bottom, softness | solid |
| `channelBoolean` | Rewire R/G/B/A from any channel | red, green, blue, alpha, invertRgb | solid |
| `color` | The all-in-one grade | 25 params (exposure…grainSize) | solid |
| `colorCorrect` | Primary grade | exposure, contrast, highlights, shadows, whites, blacks, saturation, vibrance, temperature, tint | solid |
| `colorCurves` | Custom curves | curves (JSON) | solid |
| `hueSat` | Hue-vs-hue/sat/lum curves | hueCurves (JSON) | solid |
| `colorWheels` | Lift/gamma/gain/offset wheels | wheels (JSON) | solid |
| `hslQualifier` | HSL secondary | secondary (JSON) | **thin** — grades in place; cannot emit a matte (§0 of the maturity audit) |
| `lut` | Apply a 3D LUT | lut, intensity | solid |
| `look` | Creative look preset | look, intensity | solid |
| `vignette` | Vignette | amount, size, feather, roundness, highlights | solid |
| `grain` | Film grain | amount, size | **thin** — no per-channel grain, no response curve |
| `blur` | Gaussian blur | sigma (0..200) | **broken above σ≈32** — see §3; reach hard-caps at 96 px |
| `directionalBlur` | Motion/streak blur | amount, angle | thin — no "glow"/centre-bias controls |
| `radialBlur` | Zoom/spin blur | amount, centerX, centerY | **thin** — no zoom-vs-spin mode switch |
| `glow` | Highlight bloom | radius (0..200), intensity (0..2), threshold (0..1) | **broken above radius≈32** — §3, the founder's report |
| `sharpen` | Unsharp | amount | thin — no radius, no threshold |
| `pixelate` | Mosaic | blockSize | solid |
| `prism` | Chromatic aberration | amount, angle | solid |
| `filter` | Escape hatch to any registry fragment effect | effectId, intensity, effectParams | solid |
| `rectMask` | Rectangle matte | centre/size/feather/invert/corner + track attach | solid |
| `ellipseMask` | Ellipse matte | centre/size/feather/invert + track attach | solid |
| `polygonMask` | Polygon matte | points, shapeKeyframes, feather, expansion, invert + track attach | solid *(slices 1–2)* |
| `bezierMask` | Bezier matte | as polygon | solid *(slices 1–2)* |
| `matteControl` | Boolean combine mattes | operation, invert, feather | thin — no garbage/holdout inputs |
| `chromaKey` | Colour-difference keyer | 10 params | thin *(slice 3)* — no screen sampling, no matte out |
| `lumaKey` | Luma keyer | low, high, softness, invert, matteOnly | solid for what it is |
| `text` | Text generator | content, font, size, weight, colour, align, x, y | **thin** — no tracking/leading, no stroke, no shadow, no per-character layout |
| `background` | Solid generator | color, opacity | **thin** — solid only; no gradient |
| `aiMatte` | AI matte | artifactId, feather, invert | **stub** — lowers to `degrade("node-unimplemented")` |
| `backdrop` | Canvas grouping frame | title, color, w, h | solid (editor-only) |
| `group` | Collapse a selection | title, members, collapsed | solid (editor-only) |
| `reroute` | Wire tidy | — | solid |
| `timeSpeed` | Retime a subtree | speed, offset | solid |
| `tracker` | Match-move / stabilize | trackingPathId, trackingPathData, smoothing, mode | solid *(slice 2)* |

**One thing the table makes obvious.** The *colour* family is genuinely complete — wheels, curves,
hue curves, LUT, look, vignette, grain, and a 25-param all-in-one. Somebody finished that job. The
*filter* family is where the range problems are, and the two most-used nodes in it (blur, glow) are
both broken at the top of their declared range by the same 12-character constant.

---

## Part 2 — deep comparison, the working set

### glow → Fusion **Glow** / **Soft Glow**

| Fusion parameter | Flarex | Verdict for these users |
|---|---|---|
| Glow Size | `radius` 0..200 | present, but only the first ~16% of the range does anything (§3) |
| Gain / Glow | `intensity` 0..2 | present |
| Threshold | `threshold` 0..1 | present and **measured working** (§3) |
| RGB gain (per-channel glow) | **missing** | **wanted.** Tinted bloom is a standard look grade; the shader already has a `uTint` uniform hardcoded to white by the lowering. Cheap. |
| Blend (glow vs original mix) | **missing** | wanted — "how much of the glowed version" is how colourists dial bloom |
| Filter type (box/Bartlett/Gaussian/multi-box) | **missing** | **not wanted.** Nobody in the target set picks a blur kernel by name. |
| Alpha/Mask channel selection | **missing** | not wanted here — the node already takes a matte input |

### blur → Fusion **Blur**

| Fusion parameter | Flarex | Verdict |
|---|---|---|
| Blur Size | `sigma` 0..200 | present, **capped at 96 px of reach** — same defect as glow |
| Red/Green/Blue/Alpha channel toggles | **missing** | **wanted, cheap.** Blurring alpha only (to soften a matte edge) is a daily cleanup operation, and today it needs a Channel Boolean detour. |
| Blend | **missing** | wanted — mixing a blur back is how "diffusion"/beauty softening is done |
| Filter type | **missing** | not wanted (as above) |
| Lock X/Y + separate X/Y sizes | **missing** | **wanted for beauty work** — a slight vertical-only blur is a standard skin trick. Small. |

### directionalBlur → Fusion **Directional Blur**

| Fusion parameter | Flarex | Verdict |
|---|---|---|
| Length, Angle | `amount`, `angle` | present |
| Glow | **missing** | not wanted — niche |
| Blend | **missing** | wanted (as above) |

### radialBlur → Fusion **Radial Blur** (which is zoom **and** spin)

| Fusion | Flarex | Verdict |
|---|---|---|
| Type: zoom vs rotation | **missing — only one behaviour exists** | **wanted.** Spin blur is half of what people reach for this tool for; today it is unreachable. |
| Centre X/Y | present | — |
| Blend | missing | wanted |

### colorCorrect / colorWheels / colorCurves / hueSat / lut / look

These are **the strongest part of the palette** and need nothing for the target user. `colorCorrect`
covers Fusion's Color Corrector primaries; `colorWheels` covers lift/gamma/gain/offset; `hueSat`
covers the six hue-vs-* curves. Missing versus Fusion: per-channel (R/G/B) *ranges*, the Suppress
panel, and histogram-matching — all **film-facility apparatus, not wanted here**.

One real gap, shared across the family: **no Blend/mix parameter.** Fusion puts one on every tool.
For a grade node it is the difference between "dial this look back to 40%" and rebuilding it. Small,
and it would apply uniformly.

### merge → Fusion **Merge**

| Fusion | Flarex | Verdict |
|---|---|---|
| Blend modes | 17 modes | present, good coverage |
| Apply Mode / Operator (Over, In, Held Out, Atop, XOr) | **missing** | **wanted, and the omission bites.** "Held Out" and "In" are how you use one element to cut another without a separate matte path. Fusion users reach for this constantly. |
| Foreground/Background X/Y, Size, Angle | **missing** | not wanted — Flarex has a Transform node and a node graph; Fusion bundles them for convenience |
| Additive/Subtractive slider | **missing** | not wanted — a premultiply subtlety these users will never diagnose |
| Alpha Gain / Burn In | **missing** | not wanted |

### transform → Fusion **Transform**

| Fusion | Flarex | Verdict |
|---|---|---|
| Centre, Angle, Size | present (`x`,`y`,`rotation`,`scale`) | — |
| Pivot separate from Centre | `anchorX`/`anchorY` | present |
| **Aspect / separate X and Y size** | **missing — `scale` is uniform** | **wanted.** Non-uniform scale is routine for fitting a screen replacement or squashing a title. |
| Flip horizontal / vertical | **missing** | **wanted and trivial** — negative scale is not reachable (`scale` has min 0) |
| Edges: black / wrap / duplicate / mirror | **missing** | mildly wanted — "duplicate" saves a shot when a stabilize pushes the frame off. Low priority. |
| Filter method (nearest…Catmull-Rom) | **missing** | not wanted |

### crop, channelBoolean, pixelate, prism

Solid and complete for these users. `crop` even has the soft edge Fusion's Crop lacks.

### chromaKey / lumaKey / matteControl

Under slice 3; not re-audited. One control gap visible in passing and worth recording: **`lumaKey`
has no matte-blur/erode**, so a luma key on noisy footage has no cleanup path at all inside the node.

### text → Fusion **Text+**

This is the largest control gap in the palette, and it is called "Text+" after Fusion's tool while
having roughly a tenth of it.

| Fusion Text+ | Flarex | Verdict |
|---|---|---|
| Font, size, colour, alignment | present | — |
| **Tracking / letter spacing** | **missing** | **wanted.** Tracking is the single most-used typographic control in titles. |
| **Line spacing / leading** | **missing** | **wanted**, for any multi-line title |
| **Stroke / outline** | **missing** | **wanted.** Captions over footage need an outline to stay readable — this is the #1 reason a creator's text looks amateur. |
| **Drop shadow** | **missing** | **wanted**, same reason |
| Vertical anchor / baseline | partially (`y` only) | wanted |
| Per-character animation, layout on a path, 3D extrusion | **missing** | **not wanted** — out of scope (3D) and film apparatus |
| Multiple styled runs in one block | **missing** | not wanted at node level — the timeline's caption system already does rich text |

Worth being blunt: the timeline's own text/caption pipeline (`composition-style.ts`,
`captions.ts`) **already has** stroke, shadow, and rich styling. The Flarex `text` node is the poor
relation, and closing the gap is mostly about routing to machinery that already exists rather than
building it.

### background → Fusion **Background**

`color` + `opacity` only. Fusion's Background does **four-corner and linear/radial gradients**, which
is how you make a lower-third bar, a vignette plate, or a sky fix. **Wanted, and small** — the
gradient rasterizer already exists for shapes/frames.

---

## Part 3 — GLOW, the worked example

The founder's report was *"Glow doesn't produce enough glow like DaVinci."* That is a behaviour
complaint, and it is correct. Here is exactly what the node does.

### What the implementation is

Three passes in `packages/shared/src/color/scene-compositor.ts`:

1. **Brightpass** (`BLOOM_BRIGHT_FS`): `w = smoothstep(threshold, threshold+0.25, luma) * alpha`,
   with luma = Rec.709 weights. The bright weight rides in alpha; RGB passes through.
2. **Blur** (`gaussianBlur` → `BLUR_FS`): separable Gaussian, premultiply in / unpremultiply out,
   samples outside the plate read as transparent, weights normalised by their own sum.
3. **Composite** (`BLOOM_ADD_FS`): `add = bloom.rgb * bloom.a * strength * tint`, added over the
   premultiplied plate; alpha grows so the bloom can extend past the content edge.

The node lowers (`compile-flarex.ts` `case "glow"`) to `radiusPx = radius * renderScale`,
`strength = intensity`, `threshold`, `color = [1,1,1]` **hardcoded**, `mode = "highlights"`.

### The measurements

Chart: a white square (15% of frame width) on black, both from generator nodes, glow applied after
the merge. 1080×1920, `renderScale` 1. *Reach* = the last pixel past the square's edge whose added
luma is ≥ 1 code value, i.e. still visible.

| radius | intensity | threshold | reach (px) | % of frame width | falloff at +1 / +20 / +40 / +80 / +120 px |
|---:|---:|---:|---:|---:|---|
| 0 | 0.6 | 0.7 | 0 | 0.00% | — |
| 24 *(default)* | 0.6 | 0.7 | **65** | 6.02% | 76 / 47 / 20 / 0 / 0 |
| 32 | 0.6 | 0.7 | **87** | 8.06% | 76 / 53 / 30 / 2 / 0 |
| 64 | 0.6 | 0.7 | **96** | 8.89% | 76 / 55 / 36 / 7 / 0 |
| 120 | 0.6 | 0.7 | **96** | 8.89% | 76 / 59 / 43 / 11 / 0 |
| **200 *(max)*** | 0.6 | 0.7 | **96** | **8.89%** | 76 / 61 / 44 / 13 / 0 |
| 200 | **2.0 (max)** | 0.7 | — | — | 198 / 148 / 94 / 0 / 0 |

### The diagnosis — which of the five candidate causes it actually is

**1. The parameter's maximum is too low — NO, and this is the trap.** The slider already goes to 200.
The *shader* caps the kernel:

```ts
const MAX_BLUR_RADIUS = 96;                                    // scene-compositor.ts
const radius = Math.min(MAX_BLUR_RADIUS, Math.max(1, Math.ceil(sigma * 3)));
```

`ceil(3σ)` reaches 96 at **σ = 32**. Above that the kernel stops growing while σ keeps widening the
weights, and because the shader normalises by `wsum` — *the sum of the surviving, truncated weights* —
the result is not a wider Gaussian but an increasingly **flat box average over a fixed 96-pixel
window**. That is exactly what the table shows: identical 96 px reach at radius 64, 120 and 200, with
only the interior falloff flattening. **From radius 32 to radius 200 — 84% of the control's range —
the glow does not get any bigger.** The measured falloff confirms the mechanism: at radius 200 the
value is still 13/255 at +80 px and hits 0 by +120 px, a hard cut, where a true σ=200 Gaussian would
still be near its peak at +80 px and reach past 600 px.

**2. The falloff is wrong — yes, but as a symptom of (1), not independently.** Below σ=32 the
falloff is a correct normalised Gaussian. Above it, the shape degrades toward a box because of the
truncation. There is no separate falloff bug to fix.

**3. It glows in the wrong colour space — YES, and measured, not assumed.** Chart 2 puts a 100% white
patch and a 60% grey patch on the same field and compares the light each throws with the threshold at
0 so both bloom:

```
white throws 119.00, grey throws 71.00 → ratio 1.68
expected ≈1.67 if computed on GAMMA-ENCODED values; ≈3.24 if computed in LINEAR light
```

1.68 against a prediction of 1.67. The glow is computed on **display-encoded** values. The project's
managed pipeline is *Rec.709-linear working / Rec.709 SDR output*, so by the time the plate reaches
the bloom passes the grade has already re-encoded to display gamma, and there is no linearisation
anywhere in `BLOOM_BRIGHT_FS`, `BLUR_FS` or `BLOOM_ADD_FS`. This is precisely why bright areas *wash*
rather than *bloom*: in linear light a specular highlight throws ~3× the energy of a midtone, and here
it throws 1.7×, so the glow spreads a flat grey haze over everything above the threshold instead of
concentrating around the genuinely bright bits.

**4. Under-sampled — same root cause as (1).** Not a separate defect. Note the direction, though: the
kernel is not *too coarse*, it is *too short*. Every tap inside 96 px is taken; there are simply no
taps beyond it.

**5. There is no threshold — NO. Measured working.** At threshold 0.70 the 60%-luma patch throws
**exactly 0.00**; at threshold 0.00 the same patch throws 71.00. The brightpass gates correctly, and
this hypothesis can be struck.

*(Chart 1 — pure white on pure black — could not have answered #5 or #3: with no midtones present,
every threshold below 1.0 passes the white and rejects the black, and threshold 0.0 and 0.7 rendered
byte-identically. That is why chart 2 exists. Recording it because a sweep that produces identical
frames at two settings looks like a broken control and is actually a blind chart.)*

### Against Fusion **[Fusion: documented, NOT measured]**

Fusion's Glow has no equivalent hard reach ceiling — Glow Size scales with the image and is
routinely pushed until the bloom crosses a large fraction of the frame; Resolve's implementation
blurs at reduced resolution so a large size costs roughly what a small one does. Fusion also composites
its glow with per-channel RGB gain, and Resolve's colour-page Bloom operates on the timeline's working
(scene-linear-capable) data. I cannot put a number on any of that here.

What I *can* say without Resolve: **8.89% of frame width is the entire dynamic range of this control**,
and a bloom that cannot exceed ~96 px on a 1080-wide frame will read as timid against any reference
whatsoever. The founder's complaint is reproducible from first principles and does not need Resolve to
confirm it.

### Is it a one-line fix? No — and the founder should know why

Raising `MAX_BLUR_RADIUS` **is** one line, and it is the wrong line. The shader loops `2R+1` taps per
pass; at R=600 (what σ=200 actually needs) that is 1201 taps × 2 passes × every glowing layer, on the
integrated-GPU target this product is aimed at. It would trade a timid glow for an unusable frame rate.

The correct fix is the standard one and is **moderate, not trivial**: run the bloom blur at reduced
resolution. Downsample the brightpass result by 4 before blurring and the existing 96-tap kernel covers
384 px of reach at a quarter of the cost, and the upsample hides the coarser sampling because a bloom
is low-frequency by nature. The RTT plumbing (`effectTargets`) already exists. Estimate: **1–2 days**,
including a pixel fixture at a large radius.

The linear-light fix is separable and smaller: linearise in `BLOOM_BRIGHT_FS`, blur and add in linear,
re-encode in `BLOOM_ADD_FS`. **Estimate: half a day**, and it changes the look of every existing glow —
which needs the founder's sign-off, not just a green gate.

**The same cap applies to the `blur` node** (`sigma` 0..200, same `gaussianBlur`, same 96 px ceiling).
Fixing the pyramid fixes both. Nobody has reported blur because a 96 px blur still *looks* blurred; a
96 px glow visibly fails to reach.

### §3.5 — glow is not alone: the filter family has a systemic timid-maximum pattern

Having found one, I checked the rest. Two more nodes have the same shape of defect, and unlike glow
these genuinely **are** near-one-line fixes.

*Derived by arithmetic from the shader constants in
`packages/shared/src/color/fragment-effects/builtins.ts`, not measured — the constants are exact and
the node's `amount` 0..1 maps to the builtin's 0..100, so the node maximum does reach the builtin
maximum (`compile-flarex.ts` `FLAREX_FILTER_NODES`).*

| Node | At the node's MAXIMUM | Taps | Consequence |
|---|---|---|---|
| `directionalBlur` | `lengthPx = (amount/100) * 60.0` → a **60 px total** streak (±30 px) = **5.6% of a 1080-wide frame** | 16 | Too short to read as motion blur, and 4 px between taps on a hard edge gives 16 discrete ghosts rather than a smooth streak |
| `radialBlur` | `strength = (amount/100) * 0.06` → the sample sweeps **6%** of the distance to the centre; ~32 px at the frame edge on 1080 | 16 | A zoom-blur that barely reads at maximum |

**[Fusion: documented]** Fusion's Directional Blur length is expressed as a fraction of image width
and is routinely pushed well past 10% for a motion effect; its Radial Blur likewise. I have not
measured either.

These two are cheap: raise `60.0` and `0.06`, and raise `TAPS` from 16 to something that keeps the
tap spacing near a pixel at the new maximum (a tap count that scales with the requested length is
better than a bigger constant, or the extra length just buys more visible ghosts). **Estimate: half a
day for both**, including a fixture at maximum.

**The pattern is the finding.** Three of the five filter nodes with a spatial extent stop responding —
or never had much range — well below their declared maximum, and in every case the control's slider
says otherwise. That is why the checklist in Part 4 opens its general section with *"the node's
maximum produces a visibly stronger result than 80% of maximum"*: it is the single check that would
have caught all three, and no gate in the repo performs it.

---

## Part 4 — the behaviour checklist

The deliverable that outlives the audit. Every entry is checkable **by looking at a rendered frame**.
Numbers are for a 1080-wide frame at `renderScale` 1; percentages are of frame width. Entries marked
*(estimate)* are judgement, not measurement, and should be tightened when someone measures them.

### GLOW
- [ ] at maximum radius, a bright highlight bleeds **at least 25% of frame width** *(estimate — chosen
      because Fusion users routinely push a bloom across a quarter of frame; current: **8.89%**)*
- [ ] increasing the radius increases the reach **across the whole slider** — no plateau
- [ ] falloff is smooth to zero with no visible banding and no hard cut at maximum radius
- [ ] only highlights above the threshold glow; a 60%-luma midtone at threshold 0.7 contributes
      **zero** ✅ *currently passes*
- [ ] glow is computed in linear light: a 100% patch throws **≈3×** the light of a 60% patch, not 1.7×
- [ ] doubling `intensity` roughly doubles the bloom's brightness and does **not** change its reach
      ✅ *currently passes — measured, total extent identical at intensity 0.6 and 2.0*
- [ ] a glow tint other than white is reachable from the node

### BLUR
- [ ] at maximum sigma the blur is unrecognisably soft — a 96 px feature is fully dissolved
- [ ] reach increases across the whole slider — no plateau *(currently plateaus at σ≈32)*
- [ ] no ringing or edge darkening against a transparent surround
- [ ] a blur applied to a masked region does not bleed outside the mask edge ✅ *(fixture-covered)*

### TRANSFORM
- [ ] a negative or flipped scale mirrors the image *(currently unreachable — `scale` min is 0)*
- [ ] X and Y can be scaled independently *(currently uniform only)*
- [ ] rotating about a moved anchor pivots about that anchor, and the image does not translate
- [ ] a scaled-up image resamples smoothly, with no visible nearest-neighbour blocking

### MERGE
- [ ] all 17 blend modes visibly differ from `normal` on a mid-grey/mid-colour pair
- [ ] `opacity` 0 shows the background exactly; `opacity` 1 shows the foreground exactly
- [ ] a foreground with soft alpha composites without a dark or light fringe at the edge
- [ ] "held out" / "in" style operators exist so one element can cut another *(currently missing)*

### COLOR / COLORCORRECT / COLORWHEELS / CURVES
- [ ] every parameter at its extreme produces a visible, non-clipped change on a test ramp
- [ ] a neutral grey stays neutral when only exposure/contrast move
- [ ] the grade is invertible where it should be: +50 then −50 returns the original within 1 code value
- [ ] each node has a mix/blend control so the whole effect can be dialled back *(currently missing)*

### CROP
- [ ] the cropped area is fully transparent, not black
- [ ] `softness` produces a smooth edge with no stair-stepping at maximum

### TEXT
- [ ] text renders identically in preview and export at the same size *(fixture-covered)*
- [ ] an outline/stroke is reachable and stays readable over busy footage *(currently missing)*
- [ ] letter spacing and line spacing are adjustable *(currently missing)*
- [ ] text at maximum size stays crisp — rasterised at display resolution, not upscaled

### BACKGROUND
- [ ] a linear and a radial gradient are reachable *(currently solid only)*
- [ ] a solid at opacity 0.5 composites to exactly half over black

### RADIAL BLUR
- [ ] both zoom and spin behaviours are reachable *(currently zoom only)*
- [ ] the blur is zero at the centre point and increases outward
- [ ] at maximum, the streak at the frame edge is unmistakable — **at least 10% of frame width**
      *(estimate; currently ≈3%)*
- [ ] no discrete ghost copies visible at maximum — taps are dense enough for the streak length

### DIRECTIONAL BLUR
- [ ] at maximum, the streak is **at least 15% of frame width** *(estimate; currently 5.6%)*
- [ ] no discrete ghost copies at maximum on a hard edge *(currently 16 taps over 60 px)*
- [ ] `angle` sweeps the streak through a full 360° with no flip or discontinuity

### VIGNETTE / GRAIN
- [ ] vignette at maximum darkens the corners without a visible ring or banding
- [ ] grain is visible at 100% zoom at default and does not crawl unnaturally between frames
- [ ] grain size changes the *scale* of the noise, not just its amount

### SHARPEN
- [ ] at maximum, edges gain definition without a white halo more than ~2 px wide

### GENERAL — applies to every node
- [ ] the node's maximum parameter value produces a visibly stronger result than 80% of maximum
      *(the rule the glow failure would have caught — a plateau anywhere is a defect)*
- [ ] disabling the node returns the frame byte-identically to bypassing it
- [ ] the node looks identical in the web preview and the export *(what `render:compare:pixels` covers)*
- [ ] the node's editor affordances work on a real playhead, not only at t=0
      *(NOT covered by any gate — see DEBT-017's second axis)*

---

## Part 5 — what to add

Fusion tools with no Flarex equivalent that these users would genuinely reach for. Ranked. Excludes
anything needing 3D, deep pixels, or a plugin ecosystem.

| # | Tool | Why these users need it | Size |
|---|---|---|---|
| 1 | **Text stroke + shadow** (extend `text`, not a new node) | The single biggest visual-quality gap for creators. Captions over footage without an outline read as amateur. The machinery exists in the caption pipeline. | S |
| 2 | **Gradient** (extend `background`) | Lower-third bars, sky fixes, vignette plates, matte ramps. Rasteriser exists. | S |
| 3 | **Blend/mix on every effect node** | Fusion has it on every tool. It is the difference between grading and rebuilding. Uniform, mechanical change. | S |
| 4 | **Displace / Distort** | Heat haze, glass, screen warp — and the one honest "we cannot do that" in the current palette. Needs `SceneFragmentPass.auxInputs` (already fenced in FLAREX.md). | L |
| 5 | **Difference Keyer** | Screen replacement and cleanup on a locked-off shot; often better than chroma. Also needs `auxInputs`. | M |
| 6 | **Erode/Dilate on a matte** | Every roto and key job wants it. Blocked on the image-matte question (§0 of the maturity audit). | M |
| 7 | **Corner Pin** | Screen replacement — a named target job — is barely possible without it. 2D homography only, no 3D. | M |
| 8 | **Glow variants (Soft Glow / Highlight)** | Only worth doing **after** the bloom pyramid in §3; a second glow node on a capped blur inherits the same ceiling. | S (post-§3) |

Deliberately **not** recommended: Optical Flow, Depth tools, Camera Shake (Transform + a noise
modifier covers it), Paint (a genuinely large surface, and its main use here — cleanup — is better
served by roto + a patch), Vector/Bitmap volume tools, and anything in Fusion's Position/Normal/Deep
families.

---

## Recommended first three fixes

**1 — Bloom/blur resolution pyramid.** *1–2 days.* This is the founder's actual report, it is measured
(8.89% of frame width is the entire range of the control, and radius 32→200 changes nothing), and it
fixes the `blur` node's identical ceiling for free.

> **To answer the question as asked: no, glow is not a one-line range change — and the one-line
> version is a trap.** `MAX_BLUR_RADIUS = 96` is a single constant and raising it *would* widen the
> glow. It would also make the shader take `2R+1` taps per pass — 1201 taps at the radius σ=200
> actually needs, twice, per glowing layer, on the integrated GPUs this product targets. The founder
> should know that the thing that feels like a slider limit is really a performance ceiling wearing a
> slider's clothes, and that the standard fix (blur the brightpass at quarter resolution, where the
> existing 96-tap kernel covers 384 px) is a day or two, not an afternoon.

**2 — Directional and radial blur maximums.** *Half a day, both.* Promoted above the linear-light fix
because it is the **cheapest real range increase in the palette** — two constants (`* 60.0`, `* 0.06`)
plus a tap count — and because it is the same complaint the founder already made about glow, waiting
to be made again about two more nodes. Doing it alongside (1) means one round of "the filters actually
reach now" rather than two.

**3 — Glow in linear light.** *Half a day.* Fixes the *character* of the glow rather than its size:
bright things bloom instead of everything hazing. Measured, not guessed — the white:grey contribution
ratio is 1.68 where linear light predicts 3.24. Sequenced third only because it changes how every
existing glow looks and therefore wants the founder's eye before it ships, where (1) and (2) are
unambiguous improvements at every setting.

*Just behind these three: text stroke and shadow (1 day, and mostly routing — the caption pipeline
already has `strokeWidth`/`strokeColor`/`shadowBlur`), then transform flip and non-uniform scale
(hours). Both are larger visible-quality wins for a creator than anything else on the list; they are
below the top three only because the top three are the reported defect and its siblings.*

**The honest summary of this audit.** The colour family is finished and genuinely good — it needs a
mix control and nothing else. Masks, tracker and keyer are already being matured elsewhere. What is
left is one pattern and one omission:

- **A filter family whose spatial nodes stop responding well below their declared maximum.** Glow and
  blur plateau at 16% of their range; directional and radial blur never had much range to begin with.
  In every case the slider keeps moving and the picture does not. None of it is architectural.
- **A `text` node named after Fusion's Text+ that cannot draw an outline** — while the caption system
  three directories away can.

Both are visible in every frame a user renders, and no gate in this repo looks for either. That last
point is the one worth carrying forward: `render:compare:pixels` proves the two renderers agree, and
two renderers agreed perfectly about a glow that stops at 96 pixels for two months.
