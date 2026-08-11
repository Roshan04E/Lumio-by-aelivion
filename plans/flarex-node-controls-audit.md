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
| Length, Angle | `amount`, `angle` | present; range raised to 20% of frame width on 2026-08-11 (§3.6) |
| Glow | **missing** | not wanted — niche |
| Blend | **missing** | wanted (as above) |

### radialBlur → Fusion **Radial Blur** (which is zoom **and** spin)

| Fusion | Flarex | Verdict |
|---|---|---|
| Type: zoom vs rotation | **missing — only one behaviour exists** | **wanted.** Spin blur is half of what people reach for this tool for; today it is unreachable. |
| Centre X/Y | present, ~~working~~ | Centre **Y** was broken from the day it was written and fixed on 2026-08-11 (§3.6); Centre X was always fine |
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

> **REACH FIXED 2026-08-11 — see §3.7.** Everything below describes the node as audited. The
> plateau is gone (8.89% → 42.50% of frame width); the **colour space is not** and glow still hazes
> rather than blooms.

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

> **FIXED 2026-08-11 — see §3.6 below for what was measured and what changed.** The section is kept
> as written because two of its claims were wrong and the correction is the useful part.

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

### §3.6 — the two blurs, measured and fixed (2026-08-11)

Same instrument as glow: a white square on black rendered through the real renderer, profiled off
the returned PNG (`apps/worker/tmp/blur-range-measure.ts`). Reach is the distance past the square's
**geometric** edge at which the added light is still ≥ 1/255.

#### It is NOT the same shape of defect as glow

This was the first thing to establish and it settles how the fix has to work. Glow's ceiling is a
kernel truncation: past radius 32 the reach stops moving. Neither blur plateaus. Measured before any
change, on a 1080-wide frame:

| node amount | 0.1 | 0.25 | 0.4 | 0.6 | 0.8 | **1.0** |
|---|---|---|---|---|---|---|
| directionalBlur reach | 2 | 7 | 11 | 17 | 23 | **29 px (2.69%)** |
| radialBlur reach | 2 | 6 | 9 | 13 | 17 | **22 px (2.04%)** |

Linear to the top of the slider in both cases, and the directional figure matches the shader
arithmetic exactly (a 60 px span is ±30 px). **The parameter range was never the constraint and the
tap count was never the constraint — the scale constants were simply small.** So the fix is raising
them, and the tap count is what decides how far they can honestly be raised.

#### What §3.5 got wrong

- *"16 discrete ghosts rather than a smooth streak"* — **wrong, and wrong for an instructive reason.**
  The old streak measured **0 ripples**: 60 px over 16 taps is 4 px apart, and a blur that short
  cannot ghost because the ghosts overlap. The prediction was arithmetic reasoning about a picture I
  had not yet rendered. Ghosting was a risk of the **fix**, not a symptom of the defect.
- *"~32 px at the frame edge"* for radial — the right order, but derived from a shader line that was
  itself broken (below).

#### A defect that fell out of the measurement: Center Y has never worked

The radial numbers disagreed with the arithmetic — a 30% sweep should have thrown ~81 px along the
frame's own centre row and threw ~10 — and the picture showed everything smearing *upward* from a
centre that was clearly not in the frame. The cause is one line, present since the effect was
written in the 2026-07-14 batch:

```glsl
vec2 center = vec2(centerX, 1.0 - centerY) / 100.0;   // centerY is a PERCENT
```

`centerY` arrives as 0..100, so the default 50 gives `(1 - 50)/100 = -0.49` — the blur centre sits
about half a frame **below** the picture, at every setting of the control. Fixed to `100.0 - centerY`.

Worth noting how it survived: the pixel gate **cannot** see this. Both renderers share the shader, so
both were wrong in the same way and any parity fixture would have read 0.000%. This is DEBT-017's
first axis exactly — a differential instrument is blind to a defect the two sides share — and it is
the second time in a week that the thing that actually found the bug was rendering a known input and
checking the answer against arithmetic.

#### After

| | before | after | change |
|---|---|---|---|
| `directionalBlur` streak at max | 60 px total (5.6% of width) | **216 px (20% of width)** | reach 29 px → **109 px (10.09%)** |
| `radialBlur` sweep at max | 6% | **30%** | reach 22 px → **144 px (13.33%)** |
| taps | fixed 16 | **demand-driven, ~1 per 3 px, cap 96** | 72 taps at the 1080-wide maximum |
| response curve | linear | **quadratic** | amount 0.4 goes 24 px → 35 px, so existing projects shift much less than the 3.6× a linear remap would have imposed |
| tap phase | fixed | **per-pixel jitter, ±½ tap** | dithers the ladder a wide tap spacing would otherwise leave |

Sample spacing, the number that decides whether a longer blur is actually a *better* one:

| | at the old maximum | at the new maximum |
|---|---|---|
| `directionalBlur` | 60 px / 16 taps = **4.0 px** | 216 px / 72 taps = **3.0 px** |
| `radialBlur` (corner) | ~66 px / 16 taps = **4.4 px** | 330 px / 96 taps = **3.4 px** |

The spacing got *tighter* while the reach grew 3.6×, which is the whole point: the taps were raised
with the range rather than stretched across it. Verified by eye and by profile — both maxima fall
monotonically from the edge to zero with no ghost copies.

**Where this stops being free.** The 96-tap cap covers 288 px at the 3 px target. That is the entire
range on a 1080-wide frame and most of it at 1920 (384 px → 4.0 px). At 3840 the top of the slider
samples ~8 px apart and the jitter is carrying it. Past that the honest fix is a reduced-resolution
prefilter — **the same change glow needs** — and it was not done in this round.

#### The colour-space question, answered: it is the stage, not the node

Glow is **not** special. The entire fragment-effect stage runs on display-encoded values, and this is
deliberate and written down: `color/fragment-effects/registry.ts` states as a hard rule that bodies
*"operate in the renderer's sRGB OUTPUT space … do not add pow(2.2) linear round-trips, or preview
and export diverge"* — and the transition harness carries the same rule. The managed pipeline is a
**closed linear segment inside the grade stage only**: `color/cpu.ts` decodes to Rec.709 linear,
grades, and encodes back before the stage ends. `compile-flarex.ts`'s stage order then runs
`PIPELINE(1) → REGION(2) → FRAGMENT(3) → TRANSFORM(4) → BLUR(5) → GLOW(6) → MASK(7)`, so every
fragment effect, the Gaussian blur, the glow, and the merges all receive gamma-encoded pixels. Glow's
measured 1.68 white:grey ratio is therefore not a glow bug — it is what the stage guarantees.

That makes "fix glow in linear light" a **larger and more delicate change than it looked**, and it
should not be attempted node-by-node: the rule exists because a linear round-trip inside one body
diverges preview from export, so the conversion has to move to the stage boundary, where it changes
every spatial filter's look at once. Recommended fix #3 below is re-scoped accordingly.

---

### §3.7 — the bloom pyramid (2026-08-11)

The founder's original report, fixed. Same chart and same instrument as the measurements above.

#### Reach

| radius | before | after |
|---:|---:|---:|
| 0 | 0 | 0 |
| 24 *(node default)* | 65 px (6.02%) | **65 px (6.02%)** — unchanged |
| 32 | 87 px (8.06%) | **87 px (8.06%)** — unchanged |
| 33 | — | 91 px (8.43%) |
| 64 | 96 px (8.89%) | **175 px (16.20%)** |
| 65 | — | 179 px (16.57%) |
| 120 | 96 px (8.89%) | **327 px (30.28%)** |
| **200 (max)** | **96 px (8.89%)** | **459 px (42.50%)** |

Target was ≥25% of frame width, chosen before building because it had to plainly exceed the blurs'
new 10.09% and 13.33% — a glow that bleeds less far than a blur is the wrong answer. Met at 42.50%.

#### How, and why not the obvious way

`MAX_BLUR_RADIUS = 96` clamps the kernel's half-width but not its sigma, and `BLUR_FS` normalises by
the *surviving* weights — so past sigma 32 the Gaussian stopped widening and flattened into a box
average inside a fixed 96 px window. Raising the constant would have bought a 1201-tap kernel, twice,
per glowing layer. Instead the blur runs on a reduced-resolution copy where the same 96 taps cover
2^n times the distance.

**Reduction factor: adaptive, the smallest power of two that fits the whole Gaussian.** sigma ≤ 32 →
**1×**; ≤ 64 → 2×; ≤ 128 → 4×; else 8×. Halving twice is not automatically better than halving once,
so it halves exactly as many times as the sigma requires and no more.

Two consequences worth stating plainly:

- **At 1× the function *is* the old code path.** Every project at radius ≤ 32 — which is every
  project that was not already stuck on the plateau, including the default of 24 — renders
  byte-identically. **There is no response curve and no remap**, because below the plateau nothing
  changed and above it the old behaviour was a defect. (This is the opposite call from the blurs,
  where the range genuinely was linear all the way up and a remap was needed to protect existing
  looks. Here the range above 32 produced nothing, so nothing is being taken away.)
- **8× is the floor, not a default.** At 8× a 1080×1920 comp's smallest level is 135×240, so a
  highlight a handful of pixels across still covers more than one texel. Below that a moving
  highlight starts popping between texels rather than sliding.

#### It is also much cheaper, which was not the goal

*Arithmetic on texture-fetch counts, not a measured frame time.* At radius 200 on a 1080×1920 comp the
old path ran two full-resolution blur passes of 193 taps each: ~800 M fetches. The pyramid runs three
downsamples (13 taps over ¼ + 1/16 + 1/64 of the frame), two blur passes of ~75 taps at 1/64
resolution, and one 9-tap magnification: **~33 M**. Roughly **24× fewer fetches while reaching 4.8×
further** — the old path was paying full-resolution prices for a blur it then threw away by
truncating. At radius ≤ 32 the cost is identical to before, because the code path is.

The seams measure ≤ **1 code value** at every sampled distance (radius 32 vs 33: 74/68/59/41/16
against 73/67/58/42/17; same at 64 vs 65), so an animated radius crossing a boundary does not step.

#### The temporal check, which is the one that mattered

Downsampling to buy reach fails temporally: a small bright highlight that moves lands on different
low-res texels each frame and the halo crawls or pops. It is invisible in a still and **invisible to
`render:compare:pixels`**, which compares two renderers on one frame — both would shimmer identically
and the gate would read 0.000%.

Method: an 8%-of-frame highlight slid **1.5 px per frame** (a fifth of a texel at 8×) across 8 frames,
the halo resampled at fixed distances *from the highlight's sub-pixel centroid*, and the frame-to-frame
variation aggregated over the +70..340 px band.

| arm | reduction | peak frame-to-frame delta | RMS |
|---|---|---|---|
| radius 32 *(control)* | 1× — **cannot** shimmer from downsampling | 1.00 code | 1.280 |
| radius 120 | 4× | 1.00 code | 0.966 |
| radius 200 | 8× | 1.00 code | 0.868 |

**No shimmer above the 8-bit quantisation floor.** Every arm's peak variation is one code value, and
the pyramid arms' absolute RMS is *lower* than the un-downsampled control's. The filters are doing
their job: a 13-tap Jimenez/COD kernel on the way down (a much better low-pass than a naive halving
for the same fetch budget) and a 3×3 tent on the way up.

Two instrument failures on the way there, both caught before they were believed:

1. The first run returned **0.00 on every arm including the control**. That is not a result: a 2.5%
   highlight spread over sigma 200 leaves a 1–3 code halo, and in an 8-bit render everything below
   half a code quantises to the same number. The instrument could not have told a shimmering glow
   from a stable one. Fixed by making the highlight and intensity big enough to put the halo in the
   20–90 code range.
2. The band then started at +30 px, which is **inside the bright core** — its edge is a near-vertical
   step, where a hundredth of a pixel of centroid error yields tens of code values. It reported an
   RMS of 6.5 while the peak delta at every sampled distance was 1.0, which is arithmetically
   impossible for one signal and was the tell. Band moved to +70 px, clear of the core.

#### What got worse

Banding. A 20-code gradient now spread over 450 px shows concentric contours on a flat dark
background at maximum. Measured, they are **single-code steps widening from 8 px to 32 px apart as
the gradient flattens** — 8-bit quantisation, not a pyramid artefact (they do not follow the low-res
texel grid; a 4× render bands at 1–7 px spacing, an 8× at 8–32 px, both tracking the gradient rather
than the reduction). Invisible over textured footage, visible over a flat plate. The fix is dither at
the composite's quantisation point or `rgba16f` intermediates; deliberately not bolted onto this
change.

#### What did NOT change

**Colour space.** Glow still computes on display-encoded values, because §3.6 established that is the
whole fragment-effect stage, by design and in writing. Glow still hazes rather than blooms. It now
hazes far enough.

---

### §3.8 — the Gaussian blur joins the pyramid (2026-08-11)

The palette's last timid maximum. Same defect, same mechanism, same fix — `gaussianBlur` truncated at
96 taps while keeping the requested sigma, and `BLUR_FS` normalises by the surviving weights, so past
σ 32 the kernel stopped widening and redistributed energy inside a fixed window instead.

| σ | before | after |
|---:|---:|---:|
| 4 | 10 px (0.93%) | **10 px — identical** |
| 8 | 21 px (1.94%) | **21 px — identical** |
| 16 | 43 px (3.98%) | **43 px — identical** |
| 32 | 86 px (7.96%) | **86 px — identical** |
| 33 | 87 px (8.06%) | 90 px (8.33%) |
| 48 | 94 px (8.70%) | 130 px (12.04%) |
| 64 | 95 px | 174 px (16.11%) |
| 96 | 95 px | 262 px (24.26%) |
| 128 | 95 px | 347 px (32.13%) |
| **200 (max)** | **95 px (8.80%)** | **474 px (43.89%)** |

The plateau is visible in the *before* column as a number that stops moving: identical at 95 px for
σ 64, 96, 128 and 200 — 68% of the slider doing nothing. The falloff told the same story from the
other side: at +60 px the value crept 31 → 40 → 43 → 46 across those four settings, which is energy
being redistributed inside the 96 px window rather than the window growing.

Two call sites moved, the layer-wide blur and the region/masked blur, because they are the same node
with a mask on it and a masked blur that ran out of reach where an unmasked one did not would be
worse than either. `bloomBlur` is renamed `pyramidBlur` now that it has two consumers.

#### The byte-identity property, confirmed rather than assumed

This is what makes the change safe, and it is provable from the code before it is measured: the old
path truncates exactly when `ceil(3σ) > 96`, and the reduction loop leaves the factor at 1 in
precisely the complementary case. At σ 32, `ceil(96) = 96` is not `> 96` — neither truncates. At
σ 32.01, `ceil(96.03) = 97` — both change together. **The set of sigmas that render byte-identically
is exactly the set the old path rendered correctly**, with no gap on either side.

Measured: σ 4, 16 and 32 render with **zero differing samples** before and after.

**`render:compare:pixels` cannot establish this.** It compares two renderers, so a change that
shifted both identically reads 0.000% — DEBT-017's first axis, the blind spot that hid radialBlur's
broken Center Y. Byte-identity needs the *same* renderer before and after.

> **A void run on the way, worth recording.** The first before/after pair reported a uniform
> 0.21-luma difference at **every** sigma, including σ 4, which provably runs the identical code path.
> That is not a result — a parallel session was editing `render-comparison-fixture.ts`, `builtins.ts`
> and `virtual-layers.ts` in the same tree between the two measurements, and the pair had measured
> those edits too (the fixture's background moved by 3 in the blue channel). The tell was that the
> difference was uniform and present where the code could not have changed anything. Redone as a
> controlled pair minutes apart — stash the change, measure, restore, measure — the differing-sample
> count is zero. **A before/after pair is only valid if the tree holds still between the halves**,
> which in a repo with concurrent sessions is a precondition to check, not to assume.

#### Known and accepted

Banding at the new maximum, exactly as glow has it: a shallow gradient over hundreds of pixels
quantises to contours in 8 bits. Not fixed here — the only place a dither works is the composite's
quantisation point, which touches every layer.

#### Still truncating: the clip-level glow effect's EDGE mode

Found while confirming which callers were left. `gaussianBlur` now has one remaining caller — the
edge-glow path — and it is **reachable and it is the default**: `composition-style.ts` reads
`stringOr(params.mode, "edge")`, so the clip `glow` effect blooms an alpha silhouette through the
truncated path unless the user switches it to Highlights. Its radius goes to 160, so it plateaus over
roughly the top 40% of its slider.

This narrows a claim made in §3.7's commit. Glow's reach *is* fixed for the Flarex glow **node**,
which lowers to `mode: "highlights"` and is what the founder reported. It was **not** fixed for the
clip-level glow effect in its default mode. Left alone deliberately — it is a glow decision, not a
blur one, and it is one word.

> **Resolved 2026-08-11 in §3.9 below**, and not by the one word. Changing the default would have
> restyled every project that used the effect; the mechanism was fixed instead.

---

### §3.9 — the edge glow joins the pyramid (2026-08-11)

The path §3.8 found and left. It is the one that mattered most quietly: `mode` **defaults** to
`"edge"`, so a timeline user who drops a Glow on a clip and drags Radius gets this path without
choosing anything, and everything past radius 32 landed in the same fixed 96 px window — **80% of a
0..160 slider doing nothing.**

Measured on a white glyph over black, reach past the silhouette edge at ≥ 1/255:

| radius | before | after |
|---:|---:|---:|
| 8 | 22 px (2.04%) | **22 px — identical** |
| 16 | 43 px (3.98%) | **43 px — identical** |
| 32 | 86 px (7.96%) | **86 px — identical** |
| 33 | 87 px (8.06%) | 89 px (8.24%) |
| 48 | 94 px (8.70%) | 127 px (11.76%) |
| 64 | 95 px | 165 px (15.28%) |
| 96 | 95 px | 237 px (21.94%) |
| 128 | 95 px | 308 px (28.52%) |
| **160 (max)** | **95 px (8.80%)** | **369 px (34.17%)** |

The same plateau in the same place, to the pixel: 95 px repeated across radius 64, 96, 128 and 160,
and the identical 86 px at σ 32 the blur node measured — the same kernel, hit the same way. The
reduction seam is invisible: radius 32 vs 33 differ by at most **one code value** at every sampled
distance (96/58/6 against 95/59/7).

**Byte-identity holds, and it was checked the same way as §3.8**: a same-renderer pair with only the
one call line reverted between the halves, minutes apart, `git status --short` captured on both sides
(the only drift was the probe file this session added). Radii 0, 8, 16 and 32 → **zero differing
samples**. The first changed radius, 33, differs by a worst delta of exactly **1 code**, which is what
a boundary crossing should look like; the deltas then grow smoothly with radius (8 / 24 / 54 / 75 / 88
at 48 / 64 / 96 / 128 / 160).

**The default was not touched, and that was the decision.** Switching the default to `"highlights"`
would have "fixed" the reported symptom by silently restyling every existing project that used the
effect — an edge bloom and a luminance bloom are different looks, not different amounts of one look.
Making the control work does not.

#### Known and accepted

Banding at the new maximum, as in §3.7 and §3.8 and for the same reason. Looked at, not assumed: the
radius-160 render puts faint concentric contours on the flat black surround. It is 8-bit quantisation
of a gradient that now spreads ~25 code values over 369 px, not a pyramid artefact — the contours are
smooth ellipses that do not follow the low-res texel grid. The only correct fix is dither at the
composite's quantisation point, which touches every layer and is not this change.

#### Two instrument failures, both of the same family

Neither is incidental; both are the instrument being unable to tell the answers apart, and both were
caught by an arithmetic impossibility rather than by the number looking wrong.

1. **A frame-clipped ruler.** On the fixture's own scale-5 "HI", the glyph edge sits at x 828 of 1080,
   leaving 251 px of headroom. Radius 32 and radius 160 both read **exactly 251 px** — both blooms ran
   off the frame. Fixed by measuring up the 1920-tall axis instead of across the 1080-wide one.
2. **A magnified measuring space.** The effect plate is built *before* the layer transform, so a
   scale-5 text is glowed at 1× and then magnified 5× by the composite: a radius-32 bloom measured
   ~390 px on screen off a 96 px kernel. Not a defect — that is what "blur before transform" means, and
   it matches CSS filter order — but the numbers were in a stretched space and not comparable to frame
   width. Fixed by putting the size in the font (420 px) and leaving `scale` at 1.

3. **The fixture itself, caught by the suspicion rule.** `glow-edge-max` read 0.000% on the full sweep
   and the render carried **no visible glow at all** — it had inherited the text fixture's `textScale: 5`
   and hit failure 2 above, spreading a radius-160 bloom to 2-3 code values. A green gate on a picture
   where nothing happened. Fixed in the fixture (`textFontSize: 420`, scale 1), not in the code; the
   render now puts an unmistakable yellow-green bloom over several hundred pixels of hillside. **This is
   the third pass in a row where looking at the picture behind a 0.000% was the check that mattered**,
   and the first where it caught something.

A further finding fell out of the first attempt, recorded because it is not obvious: **edge glow does
nothing on a Flarex comp host or on a full-frame shape.** The plate is comp-sized and pre-transform, so
a shape scaled to 12% presents an opaque full-frame plate with no interior alpha edges to bloom. Text
rasterises its silhouette *into* the plate, which is why the fixture and the probe both use text — and
why the existing `glow` fixture (media, radius 28) exercises the code path but barely the effect.

---

## Part 4 — the behaviour checklist

The deliverable that outlives the audit. Every entry is checkable **by looking at a rendered frame**.
Numbers are for a 1080-wide frame at `renderScale` 1; percentages are of frame width. Entries marked
*(estimate)* are judgement, not measurement, and should be tightened when someone measures them.

### GLOW
- [x] at maximum radius, a bright highlight bleeds **at least 25% of frame width** — measured
      **42.50%** (459 px on a 1080-wide frame; was 8.89%). Comfortably past both blurs (10.09%,
      13.33%), which was the point: a glow that bleeds less far than a blur is the wrong answer
- [x] increasing the radius increases the reach **across the whole slider** — no plateau
      *(6.02 / 8.06 / 8.43 / 16.20 / 16.57 / 30.28 / 42.50% at radius 24 / 32 / 33 / 64 / 65 / 120 / 200)*
- [x] **the CLIP glow effect's EDGE mode reaches too — its default mode.** Measured **34.17%**
      (369 px; was 8.80%) at its maximum radius of 160, with no plateau: **22 / 43 / 86 / 89 / 127 /
      165 / 237 / 308 / 369 px** at radius 8 / 16 / 32 / 33 / 48 / 64 / 96 / 128 / 160. It previously
      stalled at 95 px for radius 64, 96, 128 and 160 alike — 80% of the slider. Byte-identical at and
      below radius 32 (zero differing samples), so no existing project moved; the default stayed
      `"edge"` deliberately, since changing it would restyle projects rather than fix the control
- [x] the reduction seams are invisible — radius 32 vs 33 and 64 vs 65 differ by at most **one
      code value** at every sampled distance, in the highlight bloom and the edge bloom alike
- [x] **no temporal shimmer.** A moving highlight's halo does not crawl or pop between frames: at the
      deepest reduction the frame-to-frame variation is **≤1 code**, and its absolute RMS (0.868) is
      *lower* than the full-resolution control's (1.280)
- [ ] falloff is smooth to zero with no visible banding and no hard cut at maximum radius —
      **hard cut gone, banding remains and is now more visible.** On a flat dark background at
      maximum, the halo shows concentric contours. Measured, they are **single-code steps that widen
      as the gradient flattens** (8 → 32 px apart), which is 8-bit quantisation of a 20-code gradient
      spread over 450 px, not a pyramid artefact — the bands do not follow the low-res texel grid.
      Inherent to an 8-bit output; the fix is dither at the composite's quantisation point or
      `rgba16f` intermediates, and it is not in the pyramid change
- [ ] only highlights above the threshold glow; a 60%-luma midtone at threshold 0.7 contributes
      **zero** ✅ *currently passes*
- [ ] glow is computed in linear light: a 100% patch throws **≈3×** the light of a 60% patch, not 1.7×
      *(still 1.68 — and §3.6 established this is the whole fragment-effect STAGE, not glow. The
      pyramid did not touch it: glow still hazes rather than blooms, it now hazes far enough)*
- [ ] doubling `intensity` roughly doubles the bloom's brightness and does **not** change its reach
      ✅ *currently passes — measured, total extent identical at intensity 0.6 and 2.0*
- [ ] a glow tint other than white is reachable from the node

### BLUR
- [x] at maximum sigma the blur is unrecognisably soft — a 96 px feature is fully dissolved.
      At σ 200 the whole plate collapses to a colour wash: no landscape, no road, no bokeh, nothing
      recognisable survives
- [x] reach increases across the whole slider — no plateau. Measured smear past a hard edge:
      **10 / 21 / 43 / 86 / 90 / 130 / 174 / 262 / 347 / 474 px** at σ 4 / 8 / 16 / 32 / 33 / 48 / 64 /
      96 / 128 / 200, i.e. **0.93% → 43.89% of frame width**. It previously stalled at **95 px (8.80%)**
      for σ 64, 96, 128 and 200 alike
- [x] **byte-identical at and below the truncation point.** σ 4 / 16 / 32 render with ZERO differing
      samples before and after. This is *not* something `render:compare:pixels` can establish — it
      compares two renderers, so a change shifting both identically still reads 0.000% (DEBT-017's
      first axis). It needs the same renderer before and after, held against an unchanging tree
- [ ] no ringing or edge darkening against a transparent surround — *unverified at the new maximum.
      The pyramid's down chain samples with `CLAMP_TO_EDGE` while `BLUR_FS` treats out-of-frame as
      transparent, and those conventions only meet where content reaches the border. The full-frame
      fixture shows no rim, but a transparent-surround case at σ > 32 has not been measured*
- [x] a blur applied to a masked region does not bleed outside the mask edge ✅ *(fixture-covered)*
- [ ] **banding at maximum**, same as glow and for the same reason: a shallow gradient spread over
      hundreds of pixels quantises to visible contours in 8 bits. Known and accepted; the fix is
      dither at the composite's quantisation point, which touches every layer and is its own change

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
- [x] the blur is zero at the centre point and increases outward
- [x] **Centre X and Centre Y both put the blur's origin where the control says.** Set Centre Y to
      0.2 and to 0.8 and confirm the sweep radiates from the upper and lower thirds respectively
      — *this failed from 2026-07-14 to 2026-08-11 and no parity gate could see it, because both
      renderers ran the same wrong line*
- [x] at maximum, the sweep at the frame edge is unmistakable — **at least 10% of frame width**
      *(measured **13.33%**, 144 px on a 1080-wide frame; was 2.04%)*
- [x] **no visible banding or ghosting at maximum.** The falloff from the object's edge is monotone
      to zero with no ghost copies — measured, and confirmed by looking at the frame. Sample spacing
      at maximum is **3.4 px at the frame corner** (330 px sweep / 96 taps)
- [ ] at 3840 width the top of the range samples ~8 px apart — **known limit**, the fix is a
      reduced-resolution prefilter, not more taps

### DIRECTIONAL BLUR
- [x] at maximum, the streak is **at least 15% of frame width** — the streak **span** is 20% of
      frame width by construction; reach past a hard edge measures **10.09%** (109 px on 1080-wide;
      was 2.69%)
- [x] **no visible banding or ghosting at maximum on a hard edge.** Monotone falloff, no ghost
      copies; sample spacing at maximum is **3.0 px** (216 px / 72 taps), *tighter* than the 4.0 px
      the old 60 px / 16-tap version had
- [x] the streak length is a fraction of frame **width**, so it survives a conform — a 4K render of
      the same project streaks proportionally, not 4× smaller
- [ ] `angle` sweeps the streak through a full 360° with no flip or discontinuity
      *(off-axis 27° is pixel-gated; the full sweep is not)*

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

**1 — Bloom/blur resolution pyramid.** ✅ **DONE 2026-08-11 for GLOW — see §3.7.** Estimated 1–2 days.
Reach 8.89% → **42.50%** of frame width, no plateau anywhere in the slider, no temporal shimmer above
the 8-bit floor, and byte-identical output at radius ≤ 32 so no existing project moved.

> **The `blur` node did NOT come along for free, contrary to this estimate.** The pyramid was scoped
> to the bloom path (`bloomBlur`), and the plain `blur` node still calls `gaussianBlur` and still
> plateaus at the same 96 px. The two are one function call apart and `blur`'s ceiling is now the
> palette's last timid maximum, but changing it moves every existing blurred layer, which is a
> different decision from the one this round was authorised to make.
>
> **Done 2026-08-11, second pass — see §3.8.** It turned out NOT to move every existing blurred
> layer: below the truncation point the render is byte-identical, verified directly. `bloomBlur` is
> now `pyramidBlur` and has two consumers.
>
> **Done 2026-08-11, third pass — see §3.9.** The clip glow effect's EDGE mode, found by asking which
> callers of `gaussianBlur` were left, and the one a timeline user actually hits: it is the effect's
> DEFAULT mode. Reach 8.80% → **34.17%**, byte-identical at and below radius 32, default untouched.
> `pyramidBlur` now has three consumers and every Gaussian in the product goes through it —
> `gaussianBlur` is reachable only via its 1× case.

> **To answer the question as asked: no, glow is not a one-line range change — and the one-line
> version is a trap.** `MAX_BLUR_RADIUS = 96` is a single constant and raising it *would* widen the
> glow. It would also make the shader take `2R+1` taps per pass — 1201 taps at the radius σ=200
> actually needs, twice, per glowing layer, on the integrated GPUs this product targets. The founder
> should know that the thing that feels like a slider limit is really a performance ceiling wearing a
> slider's clothes, and that the standard fix (blur the brightpass at quarter resolution, where the
> existing 96-tap kernel covers 384 px) is a day or two, not an afternoon.

**2 — Directional and radial blur maximums.** ✅ **DONE 2026-08-11 — see §3.6.** Estimated half a day
for both and that held. Directional reaches 20% of frame width (was 5.6%) and radial sweeps 30% (was
6%), with the tap count raised alongside so the sample spacing got *tighter* rather than looser. It
also turned up a defect the estimate did not anticipate: radial blur's **Centre Y control had never
worked** — a percent/fraction mix-up put the blur's origin half a frame below the picture at every
setting, invisible to the pixel gate because both renderers shared the wrong line.

**3 — ~~Glow in linear light~~ → the fragment stage in linear light.** *Re-scoped 2026-08-11, and it
is no longer half a day.* The measurement stands — the white:grey contribution ratio is 1.68 where
linear light predicts 3.24 — but glow is not the thing that is wrong. **The whole fragment-effect
stage is display-encoded by design** (§3.6): the managed pipeline opens and closes its linear segment
inside the grade stage, and the effect harness explicitly forbids `pow(2.2)` round-trips in effect
bodies because a body that linearizes on its own diverges preview from export. So this cannot be
fixed one node at a time; the conversion has to move to the stage boundary, and it changes how every
spatial filter looks at once. **Get the founder's eye on it before it is scheduled** — it is now the
largest of the three, not the smallest.

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
  *(Fixed 2026-08-11, in four passes: the two blurs in §3.6, the glow node in §3.7, the Gaussian blur
  in §3.8, the clip glow's EDGE mode in §3.9. **No truncated Gaussian remains** — every one in the
  product now goes through `pyramidBlur`, and `gaussianBlur` is reachable only via its 1× case. Each
  pass found the next one by asking which callers were left, which is why the count went from one node
  to four paths.)*
- **A `text` node named after Fusion's Text+ that cannot draw an outline** — while the caption system
  three directories away can.

Both are visible in every frame a user renders, and no gate in this repo looks for either. That last
point is the one worth carrying forward: `render:compare:pixels` proves the two renderers agree, and
two renderers agreed perfectly about a glow that stops at 96 pixels for two months.
