# Moving the fragment-effect stage into linear light

**2026-08-11 · scoping, no code.** Follows `plans/flarex-node-controls-audit.md` §3.6, which measured the
cause of the founder's *"Glow doesn't produce enough glow like DaVinci"* report: a white patch and a 60%
grey patch throw light in a **1.68 ratio** where linear light predicts **3.24**. It is not the glow node.
The whole fragment-effect stage is display-encoded, deliberately and in writing.

**The decision is made and is not reopened here:** the conversion moves to the **stage boundary**, so every
effect gets linear input uniformly in both renderers, and it is gated by a **project-level setting, on by
default for NEW projects, off for existing ones**. This document scopes how.

---

## Read this paragraph before scheduling anything

**The precision question does not make this bigger. It nearly makes it smaller — and that is the single
most useful finding in this document.** The expected answer was "8-bit linear bands in shadows, so this
needs half-float render targets, so the whole change is dominated by GPU memory and bandwidth on
integrated GPUs." The banding is real (arithmetic in §2.1: **the bottom ~16 display code values collapse
onto 2 code values in an 8-bit linear buffer**), but the fix is not necessarily half-float. WebGL2 has a
renderable `SRGB8_ALPHA8` format that keeps **8-bit perceptual storage** while the GPU does the
linear↔display conversion in fixed function on every sample and every write. Same bytes, same bandwidth,
no banding. If that format probes clean on the target hardware, the precision cost of this change is
approximately **zero**, and half-float becomes a separate, later, optional win (super-white bloom
headroom) rather than a prerequisite.

That said, the change is still **not the half-day the audit originally estimated for "glow in linear
light"**, and it is not one change. Honest total: **4–6 weeks across four slices**, of which the largest
single cost is not shaders and not precision — it is **re-tuning the stylize effects whose luma
thresholds were authored against display-encoded values** (§3.4), and the founder look-reviews that
cannot be delegated to a gate.

Two things this repo already has that shorten the work, both found by reading rather than assumed:

- **Half-float render targets are already built and already threaded.** `RenderTargetPrecision`
  (`packages/shared/src/color/gl-context.ts:430`), the `EXT_color_buffer_half_float` capability probe
  with a silent RGBA8 fallback, `bytesPerPixel` in the cache budget, and `this.precision` passed to
  every plate/nest/group/bloom target in `scene-compositor.ts`. Dormant behind the parked log/RAW work.
- **A latent divergence that must be closed first, whatever we decide.** Precision is passed **only** by
  the web preview (`apps/web/src/components/ScenePreviewCanvas.tsx:999`, behind `getHdrPipelineEnabled()`).
  The browser export (`apps/web/src/export/scene-frame-compositor.ts:185`) and the Remotion renderer
  (`apps/worker/src/remotion/SceneStage.tsx:229`) construct the compositor with the default. **Turning on
  half-float today would silently give preview and export different intermediate precision** — the exact
  class of bug `render:compare:pixels` exists to prevent, in a knob the gate has never exercised. This is
  shipped, currently-off code; per the standing rule it is flagged here for the founder rather than
  quietly fixed, but any slice that touches precision must close it.

*Working-tree note: `scene-compositor.ts` currently carries the uncommitted bloom pyramid
(`BLOOM_DOWN_FS`/`BLOOM_UP_FS`, `MAX_BLOOM_REDUCTION`) — recommended fix #1 from the audit. Everything
below sits on top of that, not instead of it. The two fixes are independent: the pyramid buys **reach**,
this buys **the right light**.*

---

## 1. Where exactly the boundary goes

### 1.1 The shape of the decision

There are two candidate boundaries, and they are not alternatives — they are stages of the same move.

**(A) The layer/nest boundary.** Decode once when the layer's image enters its own effect nest; run the
light-mixing operations (blur, glow, bloom, fragment effects, region blur) in linear; encode once before
the finished nest composites into the scene. Merges between layers stay display-encoded.

**(B) The scene accumulator.** The accumulator itself is linear; sources decode on entry, and the only
encode is at present/readback. Merges, opacity ramps, feathered mask edges and transitions all become
light-correct too.

**Recommendation: A first, B in slice 3.** A is where the founder's report lives and is self-contained
inside `renderLayerInto`. B changes every dissolve, every opacity keyframe and every feather in the
product and needs its own fixture rebaseline and its own look-review. Shipping them together produces
one enormous unreviewable diff whose regressions cannot be attributed.

### 1.2 The named sites

All in `packages/shared/src/color/scene-compositor.ts` unless stated.

**Entry/exit — plate path** (`renderLayerInto`, the `blurPx > 0 || glow` branch, ~2740–2815):

| # | Site | Action |
|---|---|---|
| S1 | `this.fullscreenPass(plate)` (~2754), the `PLATE_FS` write | **DECODE.** Fold a `uToLinear` uniform into `PLATE_FS` rather than adding a pass — the effect path is already 3–5 full-screen passes on an integrated GPU and an extra one is a real cost. |
| S2 | `gaussianBlur(plate, plate, s1, blurPx)` (~2756) | Runs linear. No shader change: `BLUR_FS` is space-agnostic arithmetic. |
| S3 | `BLOOM_BRIGHT_FS` (~2762) | **The threshold must stay display-referred** — see §3.5. This is the one shader that needs real thought, not a uniform. |
| S4 | `bloomBlur` / `BLOOM_DOWN_FS` / `BLOOM_UP_FS` (~2768) | Run linear. Space-agnostic. |
| S5 | `BLOOM_ADD_FS` (~2769) / `GLOW_FS` (~2785) | Run linear — this is the whole point; the add is now an addition of light. |
| S6 | `compositeTexture(plate.tex, …)` (~2802) | **ENCODE.** Fold a `uFromLinear` uniform into `COMPOSITE_FS`'s `uSrc` read. Set per-draw, so the fast path (~2736) is untouched and stays byte-identical. |

**Entry/exit — nest path** (`renderLayerWithRegionPasses`, ~2827–2969):

| # | Site | Action |
|---|---|---|
| S7 | after the base `renderLayerInto(…)` (~2851) fills `this.accumA` | **DECODE** the nest once. |
| S8 | region blur `gaussianBlur(this.accumA, s2, s1, …)` (~2891) | Runs linear. |
| S9 | **`regionGradeEntry(pass.effectKey).renderer.draw(…)` (~2875)** | **The delicate one.** The grade is *already* a closed linear segment that opens and closes itself (`color/cpu.ts` decodes → grades → encodes; `applyPipelineToRgb`'s `flushLinear`). Inside a linear nest it needs an **encode-in / decode-out bracket**, or a linear-in/linear-out mode on `webgl-applicator.ts`. Get this wrong and you get a double transform — a gamma-squared picture that looks like a grading bug, not a colour-space bug. |
| S10 | fragment passes `runFragmentPass(…)` (~2914) and their intra-nest `compositeTexture` calls | Run linear. Requires the harness change in §1.3. |
| S11 | final `compositeTexture(nestResult.tex, …)` (~2955) | **ENCODE.** |

**Group path** (`renderGroupInto`, ~3094+): `SceneGroupDraw.pipeline` (types at :413) is the *only* grade
point for a Flarex colour node — same bracket as S9, same failure mode.

**Slice 3 (option B) sites**, listed now so the shape is visible, not scoped in detail:
`COMPOSITE_FS`'s `blendCompose(uBlend, dst, src)` (:672) and `BLEND_GLSL` in `color/blend.ts`; the
`accumA`/`accumB` allocation; `PRESENT_FS` (:676) becomes the encode point; the readback target at
:3532 that is *deliberately* RGBA8 for scopes/thumbnails needs the encode applied before readback, not
after; `apps/web/src/export/scene-frame-compositor.ts` and `apps/worker/src/remotion/SceneStage.tsx`
capture paths.

### 1.3 What the fragment-effect harness does

The registry's hard rule (`color/fragment-effects/registry.ts:9`) is *"bodies operate in the renderer's
sRGB OUTPUT space — do not add pow(2.2) linear round-trips, or preview and export diverge."* **That rule
stays, and its purpose is preserved:** no body linearizes alone. The harness does it, once, for everyone.

`assembleShader` (registry.ts:122) gains a light-space variant: when the stage is linear, `getSrcColor`
and the final `mix(s, e, uIntensity)` in `main()` are the only lines that change. Bodies are untouched.

**Cache-key consequence, and it is easy to miss:** `buildFragmentEffectShader` memoizes on `def.id`
alone (registry.ts:161) and `buildFragmentEffectPassShader` on `${def.id}#${pass.id}` (:174). Both keys
must gain the light space, or a session that flips the project setting compiles once and reuses the
wrong program for the rest of its life.

### 1.4 What the Flarex compiler does: nothing to the stage order

`compile-flarex.ts`'s `STAGE_PIPELINE(1) → REGION(2) → FRAGMENT(3) → TRANSFORM(4) → BLUR(5) → GLOW(6) →
MASK(7)` (:185–191) is **not reordered**. The boundary is in the compositor, not in the stage order. The
compiler's only job is to carry the setting: the new field lands on `SceneLayerDraw`/`SceneGroupDraw`
alongside `blurPx`/`glow`, set uniformly by `wrapFor()`.

One consequence worth stating because it is a precision argument, not an aesthetic one: with `PIPELINE`
before `FRAGMENT`, the grade **encodes to display and the effect stage immediately decodes again**. That
round trip is free in `SRGB8_ALPHA8` or half-float and lossy in plain RGBA8 — another reason the storage
decision in §2 is not cosmetic.

---

## 2. Precision

### 2.1 8-bit linear banding — the arithmetic, not the folklore

Rec.709/sRGB display code `d` maps to linear `L`. For `d = 17/255 = 0.0667`:

```
L = ((0.0667 + 0.055) / 1.055) ^ 2.4 = 0.1153 ^ 2.4 ≈ 0.0056  →  1.43 steps of an 8-bit linear buffer
```

**So display code values 0 through ~15 land on 8-bit linear code values 0 and 1.** The bottom 6% of the
display range — where a viewer's eye is most sensitive to steps — loses roughly 8× of its resolution.
A gradient, a vignette falloff, a soft glow tail or a feathered matte edge crossing that region will band
visibly. This is the well-known result and it holds here; it is not a reason to abandon the change, it is
a constraint on where linear values are *stored*.

Note what it does **not** say: the arithmetic inside a shader is `highp float` already. The loss happens
only at texture writes. That is why the format of the intermediate targets is the whole question.

### 2.2 Three storage options

| Option | Bytes/px | Banding | >1.0 headroom | Cost on integrated GPU |
|---|---|---|---|---|
| **RGBA8, linear values** | 4 | **Unacceptable** (§2.1) | no | free — and wrong |
| **`SRGB8_ALPHA8`** | 4 | none (perceptual storage, linear math) | no (clamps at 1.0) | **≈ zero** |
| **RGBA16F** | 8 | none | yes | 2× memory and bandwidth on every effect-stage read/write |

**`SRGB8_ALPHA8` is the recommendation, and it is the reason this change is affordable.** In WebGL2 it is
a colour-renderable format: `texture()` on an sRGB texture decodes to linear in fixed function, and
writing to an sRGB colour attachment encodes in fixed function. The shader sees and writes linear floats;
the storage stays 8-bit perceptual. Blur taps, bilinear filtering and the bloom pyramid's downsample all
get correct linear filtering for free — which is a *second* correctness win the current RGBA8 path does
not have.

**It must be probed, not assumed.** Add a capability check next to `supportsHalfFloatRenderTarget`
(gl-context.ts:451) and fall back the same way it does — same pattern, same telemetry-always/enforcement-
gated doctrine. Two specific things to verify before committing to it: (a) that `SwiftShader` (what the
pixel gate runs on unless `PIXEL_BROWSER_CHANNEL=chrome`) implements it identically, or the gate measures
a different pipeline than users get; (b) that alpha is **not** sRGB-transformed (it must not be — the
premultiply/unpremultiply logic in `BLUR_FS` depends on it).

**Half-float is not the prerequisite it looked like, but it is the honest next step.** Its real win is
values above 1.0: a genuinely clipped highlight can carry energy into the bloom instead of being pinned
at white, which is part of why Resolve's bloom reads the way it does. That is **slice 5, optional**, and
it is where the real GPU cost lives:

- Per 1080×1920 target: 16.6 MB vs 8.3 MB. The effect path holds `plate`+`s1`+`s2` (**+25 MB**), the nest
  path holds `layerNestA`/`layerNestB` (**+33 MB**), plus a group pair per nesting depth. The bloom
  pyramid levels are small (all levels together ≈ ⅓ of one full-size target).
- **The content-artifact cache halves.** Its budget counts `bytesPerPixel` and its own comment
  (scene-compositor.ts:998, :1066) sizes the target at *"~12 artifacts at 1080p RGBA8"* and already warns
  that a half-float target pins twice as much. Same budget, ~6 artifacts. That is not a wrong picture —
  it is **more re-renders during playback**, i.e. a frame-rate regression on exactly the integrated GPUs
  this product targets, showing up as stutter that nobody will connect to a colour setting.
- Bandwidth: integrated GPUs (Iris Xe class) are bandwidth-bound; the effect stage doubles its bytes.
  **No number is given here on purpose** — it has to be measured, under §5's precondition, not guessed.

---

## 3. What visibly changes

Everything in this section is the *point* of the change where it is listed as a win, and a **regression
risk** where marked. Both are true of the same pixels.

### 3.1 Glow and bloom — the reported defect

White vs 60% grey contribution goes from **1.68 → ≈3.24**. Highlights concentrate instead of washing.

**Flag: for many existing looks this will read as "the glow got weaker."** A glow that was mostly a flat
haze over everything above the threshold loses the haze; what remains is a tighter, brighter core. That
is correct and it is what was asked for, and it will still be the first comment. The founder should see a
before/after on real footage, not a synthetic chart, before slice 1 is signed off.

### 3.2 Blur — the change most likely to be called a regression

A blur across a hard black/white edge currently puts code **128** at the midpoint. In linear light the
midpoint is linear 0.5, which encodes to code **188**.

- Blurred **light-on-dark** edges get noticeably brighter and appear to bloom — text with a soft shadow,
  a defocused highlight, a feathered light element on a dark plate.
- Blurred **dark-on-light** edges get thinner and lighter — dark text softened against a bright plate
  will look like it lost weight.

This is physically correct and matches Nuke, Resolve and After Effects' "Blend Colors Using 1.0 Gamma".
It is also exactly the change that people describe as "milky" the first week. **Anyone whose beauty-work
softening or drop shadow was dialled by eye will need to re-dial it.** Existing projects do not move —
that is what the setting is for — but the founder should expect this specific complaint from new work.

### 3.3 Merges, feathers, transitions *(slice 3–4)*

Every 50% mix moves from code 128 to code 188:

- Semi-transparent elements over a background — the classic **"the crossfade is brighter in the middle"**,
  which is the correct behaviour and a visible change to every dissolve in the product.
- **Feathered mask edges appear wider and brighter.** A roto edge tuned against the old midpoint will
  look softer.
- `screen`, `add`, `overlay` and the other non-`normal` modes in `blend.ts` change substantially — these
  are light operations and they are currently being done on encoded values.
- Opacity keyframe ramps change their perceived shape (a linear opacity ramp will look like it moves
  faster at the start).

### 3.4 Fragment effects — **where it gets worse before it gets better**

This is the largest re-tuning cost in the whole change and it is not optional.

> **RESOLVED 2026-08-11, and this section's premise was wrong. There was no re-tuning cost.**
>
> The prediction below — new luma constants for ink, comic-print, subject-aware and Kuwahara — assumes
> the problem is *thresholds*. Measured, it is not. Rendering `stylize` in both arms before touching a
> constant produced an olive hillside, blood-red bokeh and a heavily over-saturated ground, and reading
> the code the causes are not thresholds at all:
>
> - `stylize.ts` pivots contrast at `(c - 0.5) * k + 0.5`. **0.5 is middle grey on a display graph;
>   linear middle grey is 0.214.** In linear that pivot crushes and saturates everything below mid.
> - `halftone` returns `mix(vec3(0.97), vec3(0.05), ink)` — authored **paper** and **ink** values.
>   Emitted as linear they are the wrong paper and the wrong ink.
> - the cel-band quantizer bands *luma* into N steps; banding linear luma relocates every band edge,
>   because most of a picture's linear luma sits low.
>
> Converting a threshold cannot fix a pivot, an output constant or a quantizer, and re-authoring all of
> them means re-designing four shipped looks by eye with no reference for what they should become.
>
> **The right answer is the one this section already reaches for grain, applied more widely than it
> expected: these effects are authored in display space end to end, so run them there.** Shipped as
> `displayReferred` on the effect definition (`fragment-effects/registry.ts`), set on `sketch`, `oldTv`,
> `glitchFx`, `halftone`, `posterize` and the `stylize` pass-graph; the harness then neither decodes in
> nor encodes out for them. Grain needs no separate rule — it is the same rule.
>
> Consequence, and it is the correct one rather than a gap: for these effects the display and linear
> arms are **bit-identical**, proven by sha256 (`linear-stylize` == `stylize`, `linear-stylize-print` ==
> `stylize-print`) against a control that must differ and does (`linear-glow` != `glow`). What linear
> light buys is correct light in the operations that MIX it — blur, glow, bloom — none of which are
> fragment effects. **Slice 2's "worse before better" phase does not exist.**

- **Any effect with a hardcoded luma threshold gets a different picture, not just a different look.** The
  harness prelude's `_luma()` (registry.ts:113) is fed encoded values today. Every constant compared
  against it in `fragment-effects/builtins.ts` was chosen against display values. In linear, shadow
  detail collapses toward zero and highlight separation expands, so an edge detector finds **fewer edges
  in the shadows** and more in the highlights.
- Concretely at risk, and each needs a look-review and probably a constant: the **ink** edge pass, the
  **comic-print** halftone threshold, the **subject-aware** stylize weighting, and Kuwahara's variance
  comparison (variance in linear is dominated by highlights).
- **Grain should be excluded from the linear segment.** Film grain is a display-referred phenomenon;
  added in linear it becomes invisible in shadows and coarse in highlights. This is the same argument
  `color/cpu.ts` already makes for curves, wheels, HSL and .cube LUTs — *authored on display graphs, so
  run them on display values*. Keeping grain display-referred is consistent, not an exception.
- Geometric effects (pixelate, prism, glitch displacement) are unaffected except where they average.

### 3.5 The glow threshold control changes meaning — and will erase glows if it is not handled

`BLOOM_BRIGHT_FS` compares `uThreshold` against luma. A threshold of **0.7 in display space is ≈0.45 in
linear**. Feeding the same 0.7 to a linear luma raises the gate dramatically and **most existing glows
would simply stop appearing.**

**Required:** the threshold stays a display-referred control. Either compute the brightpass luma from the
encoded value, or transform the uniform once on the CPU (`rec709CodeToLinear(threshold)` — the function
already exists at `color-management.ts:129`). The second is cheaper and keeps the shader honest. The
same question applies to every 0..1 "amount over a luminance" control in the filter family; enumerate
them in slice 2 rather than discovering them one bug report at a time.

---

## 4. The pixel gate's role

### 4.1 With the setting OFF: the safety proof, and why the existing gate is not it

The claim is *"existing projects render exactly as they do today."* The gate as it stands **cannot make
that claim**, and this is DEBT-017 in its plainest form: `render:compare:pixels` is a **differential**
instrument. It proves the web preview and Remotion agree. If both move together, it reads 0.000% and
passes. Two renderers agreed perfectly about a glow that stopped at 96 pixels for two months.

Two checks, and the second is the one that matters:

1. **Unchanged parity, strictly.** Run the full sweep and require each fixture's `diffRatio` to be
   **equal to its recorded value in `tmp/render-comparison/summary.json`**, not merely under its bar.
   "Under the bar" would hide a change that moved both renderers by the same amount into the slack.
2. **Same-renderer, across-commit.** Render every fixture through `renderManifestStill` at the parent
   commit and at the change, and diff the two PNGs. **Zero differing pixels is the only real proof that
   existing projects are safe, and this check does not exist in the repo today.** It is small — the
   harness already renders these stills — and it should be built in slice 1, because every slice after
   depends on being able to make this claim cheaply.

### 4.2 With the setting ON: staging so green keeps meaning something

**Do not flip the existing fixtures.** Their baselines are the display-referred contract and slice 1 is
not the moment to lose them.

Add a **second arm**. The harness already supports this: `PIXEL_URL_EXTRA` appends raw query params to
the fixture URL specifically so a runtime flag can be measured as its own arm
(`apps/worker/src/render-pixel-comparison.ts`, ~line 170). The linear arm gets its own per-fixture bars
in `fixtureMaxDiffRatio`. Green then means **parity holds in both arms** — which is the only thing the
gate ever proved, now proved twice.

Per the standing rule from the last round of bar-setting: **a linear-arm bar is measured over a multi-run
sweep, never one run.** A single number cannot distinguish a tight fixture from a flaky one (see
`flarex-generators`: 86.895% then 0.000%).

### 4.3 New fixtures — the checks a parity gate structurally cannot make

The instrument that found the glow ratio, and the instrument that found radial blur's dead Centre Y, was
the same one: **render a known input and check the answer against arithmetic.** Promote it from `tmp/`
into the gate. Three assertions, each a number, each independent of the other renderer:

- ~~**Linear-light ratio.** The audit's own chart (`apps/worker/tmp/glow-measure2.ts`): a 100% patch and a
  60% patch, threshold 0. Assert the contribution ratio is **≈3.24, not ≈1.68.**~~
  **STRUCK 2026-08-11 (slice 1): this assertion cannot discriminate.** On a black field the display
  arm's ratio-of-codes is 1/0.6 = 1.67 and the linear arm's ratio-of-**light** is 3.14, which *encodes*
  to 3.14^(1/2.4) ≈ 1.70 — the same number by construction. Measured both arms: **1.68 and 1.71.**
  "1.68 → 3.24" is the same pixels described in two different spaces, not two outcomes. The tell was
  that the absolute values moved hugely (white at +5px: 111 → 176, exactly what a 0.45-coverage tap
  encodes to in each space) while the ratio did not move at all. Do not re-derive this and read it as
  a pass.
- **Blur midpoint — the assertion that replaces it.** A hard black/white edge, blurred. Assert the
  midpoint reads **≈188 in linear and ≈128 in display**: one right answer per space, 60 code values
  apart, with no ratio arithmetic in between. Measured during slice 1 (126.0 / 186.0) and shipped as a
  real gate in slice 2: `pnpm --filter @orreris/worker render:linear-gate`
  (`apps/worker/src/render-linear-gate.ts`), tolerance ±6 codes, both arms asserted so a setting that
  fails to reach a renderer fails the gate. Proven in both directions — forcing the linear arm to stamp
  `display` makes it read 126.0 and fail.
- **Merge midpoint** *(slice 3)*. A 50%-opacity white over black. Same assertion, same number.

Each of these fails loudly if the setting silently fails to reach a renderer — which is precisely the
failure the manifest threading exists to prevent, and which no parity diff can see.

---

## 5. Cache keys, and a measurement precondition

### 5.1 The setting reaches cache keys. Three of them.

**a) The content-addressed artifact cache — `contentCacheKey` (scene-compositor.ts:3075).**

```
`${CONTENT_CACHE_CONTRACT_VERSION}|${nestW}x${nestH}|r${RENDERER_REVISION}|${contentHash}|${dependencyVersions}`
```

The light space is an **ambient/context axis**, not node content — so it folds into the **ContextVersion**
at this single site, which its own comment (:3069) already anticipates: *"new ambient providers (working
space, output transform) fold in HERE."* Without it, flipping the setting mid-session serves
display-referred nests into a linear render. Bump `CONTENT_CACHE_CONTRACT_VERSION` as the coarse escape
hatch if folding turns out to be awkward.

**Latent hole, same site, found while scoping — flagged, not fixed:** `precision` is *not* in that key
either. An artifact rendered at `rgba8` survives a flip to `rgba16f`. Currently unreachable because
nothing flips precision at runtime; it becomes reachable the moment §2 does.

**b) The fragment-effect shader cache** (registry.ts:161/:174) — §1.3. Keyed on `def.id` only. Must gain
the light space.

**c) `regionGradeEntry`'s `pipelineKey`** (scene-compositor.ts:2866) is `JSON.stringify(pass.pipeline)`,
and `ColorPipeline` carries `colorSettings` (`color/types.ts:75`), so adding the field to
`ProjectColorSettings` puts it in this key **automatically**. Verify rather than assume — and note that
this is only true because the setting lives on `ProjectColorSettings`. Putting it anywhere else silently
loses this property.

**d) `apps/web/src/editor/performance/renderCache.ts:714`** already carries
`composition.settings?.color` into its key, so it inherits the field for the same reason. Verify.

### 5.2 DEBT-020: it does not apply here, and the plan must keep it that way

DEBT-020 is the class where `computeFlarexContentHashes`'s `resolveParam` (`content-hash.ts:77`) drops
any param that is not a `number`, so a time-varying non-numeric param hashes identically at every frame —
invisible to every pixel gate, because every consumer is a cache and a cache serving a stale value looks
exactly like a cache working. Three nodes have shipped with it.

`effectLight` is **context, not node content**, so the trap does not apply — *provided it stays there.*
Two rules for this change:

1. **The light space never becomes a node param.** It is a project setting on the context axis. Keep it
   off `FlarexNode.params` entirely.
2. **If a future node gains a per-node light-space override** (a per-effect "blend in linear" toggle,
   which is a reasonable thing to want), it must be a `boolean`/numeric param, or be declared in the
   definition's `trackParams`. A string like `"linear"` in a JSON payload is a fresh instance of
   DEBT-020 the day it is written.

### 5.3 Quiet-machine precondition — binding on every timing measurement in these slices

Three rounds this week produced contaminated timings on a machine at 94% CPU with 4.8 GB of 14 GB free,
and one pipeline's encoded output was **non-deterministic under load**. Any slice that reports a number —
and §2's bandwidth question guarantees at least one will — checks this first. Checkable, not guessed:

**Sample before AND after the run. Either sample failing voids the run.**

| Signal | Threshold | How, on this box |
|---|---|---|
| Free RAM | **≥ 6.0 GB** (of 14 GB) | `os.freemem()` |
| CPU busy | **< 35%**, averaged over a **3-second** sample | Two `os.cpus()` snapshots 3 s apart; busy = 1 − Δidle/Δtotal. **`os.loadavg()` returns `[0,0,0]` on Windows — do not use it.** |
| Competing processes | no other `node`/`chrome`/`ffmpeg` process **> 15%** CPU | `Get-Process`, or `wmic process get` |
| Drift between the two samples | free RAM must not fall **> 1.5 GB** during the run | compare the two samples |

**The rule, and it is the part that gets skipped:** on a failure, print the sample and exit non-zero with
`VOID: machine not quiet`. **Do not report the number.** A voided run is not a slow result — it is not a
result. It is never averaged into a series, never quoted in a summary, and never used to justify a
decision. The failure mode this prevents is not a wrong number; it is a *plausible* wrong number that
survives into a plan.

The same precondition binds **pixel** runs in these slices, for the determinism reason: a fixture whose
`diffRatio` changes between two runs at the same commit is a **void**, not a finding.

---

## 6. Ordered slices

Every slice is gated by the same project setting, so **existing projects are unaffected at every point in
the sequence** — the migration risk does not accumulate across slices.

### Slice 1 — the boundary, and glow + blur *(recommended first; 3–5 days)*

The founder's actual report, answered, with all the machinery the later slices need.

**Includes:** `effectLight: "display" | "linear"` on `ProjectColorSettings` (`color/color-management.ts`);
the legacy/new default split (§7); threading through `TimelineComposition.settings.color` → both renderers;
the `SRGB8_ALPHA8` capability probe and decision (§2); sites **S1–S6** (the plate path); the display-referred
brightpass threshold (§3.5); the ContextVersion fold (§5.1a); the across-commit same-renderer baseline
check (§4.1.2); the linear-ratio and blur-midpoint fixtures (§4.3); closing the preview/export precision
divergence flagged in the opening section.

**Excludes:** the nest path, all fragment effects, region passes, merges, transitions, half-float, any UI
beyond a single project-settings checkbox.

**User-visible win alone:** glow and blur — the timeline layer effects *and* the Flarex `glow`/`blur`
nodes, which both lower to `shell.glow`/`shell.blurPx` and therefore both take the plate path — mix light
correctly. Measurable as the 1.68 → ≈3.24 ratio.

### Slice 2 — the fragment stage *(1–2 weeks; the re-tuning is the cost)*

**Includes:** sites **S7–S11** (the nest path); the grade bracket at S9 and the group-path equivalent —
**the most delicate change in the programme**; the harness light-space variant and its shader cache key
(§1.3); the enumeration and re-tuning of every luma-thresholded builtin (§3.4); grain explicitly excluded
from the linear segment; new linear-arm bars for the stylize fixtures.

**Excludes:** merges, the scene accumulator, transitions.

**User-visible win alone:** stylize and filter effects mix light correctly instead of crushing shadows.
**This is the slice with a "worse before better" phase** — plan a look-review checkpoint before its
fixtures are rebaselined, because a rebaselined fixture makes a bad tuning permanent.

### Slice 3 — merges, opacity and mask edges *(3–5 days plus a large rebaseline)*

> **NOT SHIPPED, and it is now the LAST thing between here and the default flip.** Slices 1, 2 and 4 have
> landed, so the ordering in this document no longer matches the ordering on the branch — this one was
> stepped over. `COMPOSITE_FS` still encodes to display before mask coverage, opacity and the blend (the
> `uFromLinear` line, whose comment already says "slice 3 moves them"), so every merge, opacity ramp,
> feathered matte edge and `screen`/`add`/`overlay` is still a code-value operation.
>
> Nothing may stamp a new project `linear` until this lands: a project stamped today would mix light in
> glow, blur, the nest and transitions and NOT in the composite that assembles them, and would shift again
> the day this ships — the exact harm the LEGACY/NEW split exists to prevent. `createDefaultComposition`
> and the assertion in `color.test.ts` both name this slice as the trigger.

**Includes:** boundary option **B** — the scene accumulator in linear, `COMPOSITE_FS` and `blend.ts`,
`PRESENT_FS` as the encode point, and the readback/export/Remotion capture paths; the merge-midpoint
fixture (§4.3).

**Excludes:** transitions.

**User-visible win alone:** semi-transparent composites, feathered mattes and opacity ramps stop being
dark in the middle; `screen`/`add`/`overlay` become real light operations. Also the Flarex `merge` node,
which is where a compositor user notices it first.

### Slice 4 — transitions *(2–3 days)*

> **SHIPPED 2026-08-11.** Measured at the midpoint of a black→white `crossDissolve`: **display 128.0,
> linear 188.0**, both exact against the arithmetic, 60 codes apart. `render:linear-gate` now carries
> both probes; pinning the transition mix back to display made the crossfade probe fail at 128 while the
> blur probe still read 186, which is why they are two probes and not one.
>
> **The bracket is IN THE SHADER, not in the target pool**, and that is a correction to the plan rather
> than a shortcut. The two sides come from `precomposeGroup`, a full clip-nest composite whose
> `COMPOSITE_FS` reads its own destination for blend modes — sRGB side storage would have moved every
> blend *inside a transition side* to linear while the same clip outside a transition stayed
> display-referred, i.e. slice 3's change, applied to half the timeline, by accident. Decoding at the
> three doorways (`getFromColor`/`getToColor`/`getSrcColor`) and encoding in `main()` keeps the stage's
> output display-referred, so the mix plate, the ping-pong pair and `compositeTexture` are untouched.
> Intermediate pipeline passes therefore round-trip through 8-bit sRGB, which is free — the storage
> stays perceptual, so there is no §2.1 banding — and every module's math still runs on light.
>
> `_luma` stays DISPLAY-referred inside the linear harness. Its callers threshold on it rather than mix
> with it (`luma-mix`'s reveal band, `bokeh-blur`'s `pow(luma,4)` highlight weighting), and those
> constants mean "this brightness" — the rule §3.4 settled. The mix became light-correct; the
> discriminator kept its authored units.
>
> **The default did NOT flip, and slice 4 was not what was blocking it.** See the note under §7 / slice 3.
>
> **FOUND WHILE ADDING COVERAGE, NOT FIXED — a live defect that predates this programme.** Every
> MULTI-PASS transition (`focusPull`, `liquidMorph`, `portal`, and the fourth `pipeline` def) fails to
> compile in `SceneCompositor` and therefore in the shipping preview and both exports:
>
> ```
> gl-context: shader compile failed: ERROR: 0:18: 'uBokehRadius' : redefinition
>                                    ERROR: 0:19: 'uBokehHighlight' : redefinition
> SceneStage: composite failed on frame 14 after 3 retries — refusing to emit an uncomposited frame
> ```
>
> `prepareTransition` passes the definition's params to `assemblePassShader` as `extraUniforms`, and the
> module *also* declares them (`bokeh-blur` lists `uBokehRadius`/`uBokehHighlight`; `curl-noise` and
> `radial-warp` do the same for theirs). `assemblePassShader` dedupes only against
> `STANDARD_UNIFORM_NAMES`, so each collides with itself. Every affected definition names at least one
> param its module also declares, so **no pipeline transition has ever rendered through the scene
> compositor**. The DOM fallback (`TransitionCompositor`) does not crash — it compiles the monolith
> shader, which for a pipeline def has no `glsl` and falls back to a plain dissolve, so those four
> transitions silently render as a cross dissolve there instead.
>
> The fix is one dedupe (name-key the merged uniform list, not just the standard set), but it changes
> what four shipped transitions DO, so it is not being folded into a commit whose claim is "no display
> fixture moved". That is why this slice ships with a single-pass fixture pair only: the intended
> `focusPull` pair (display + linear, the only coverage the per-pass bracket could have) is written and
> was reverted when it hit this, and it should be the first thing added back after the dedupe lands.

**Includes:** the transition harness (`color/transitions/registry.ts`, whose rule at :13 is the same rule
in the same words), the two-side mix, and the transition fixtures' linear-arm bars.

**Excludes:** nothing further in this programme.

**User-visible win alone:** dissolves stop dipping through a dark midpoint.

### Slice 5 — half-float and super-white headroom *(optional, deferred)*

Only relevant if slice 1 chose `SRGB8_ALPHA8`. Revisits RGBA16F for values above 1.0, so a clipped
highlight carries energy into the bloom. **Explicitly parked** until the four slices above have shipped
and the cache-budget cost in §2.2 has been measured on the real target hardware — it is the one part of
this that buys a look rather than a correctness fix, and it is the one part with a real GPU bill.

---

## 7. The setting: storage, defaults, and the one line that decides whether this is safe

**Home:** a new field on `ProjectColorSettings` (`packages/shared/src/color/color-management.ts:19`),
carried on `TimelineCompositionSettings.color` (`packages/shared/src/types.ts:984`), which is persisted in
the `ProjectGraph` JSON blob — **no Prisma migration**, as that field's own comment already states. It
reaches the render manifest by construction, which is the requirement: the manifest is the product
contract and both renderers must agree on it.

**Name:** `effectLight: "display" | "linear"`. Not `linearBlending` (it is not only blending) and not
`gamma` (it is not a gamma value).

**The load-bearing detail.** `normalizeProjectColorSettings` (:65) coerces anything unrecognised to
`DEFAULT_PROJECT_COLOR_SETTINGS`, and that single constant is used for **both** "what a legacy project
means" and "what a new project gets." Those two must now differ, and conflating them is the one mistake
that silently changes every existing project:

- `LEGACY_PROJECT_COLOR_SETTINGS` — `effectLight: "display"`. What an **absent** field normalizes to.
- `DEFAULT_PROJECT_COLOR_SETTINGS` — `effectLight: "linear"`. What **new project creation** stamps,
  explicitly, into the saved settings.

Every existing `?? DEFAULT_PROJECT_COLOR_SETTINGS` fallback must be audited and pointed at the legacy
constant — they are all "I was handed nothing, assume the old contract" sites:
`composition-style.ts:1228`, `color/pipeline.ts:213`, `apps/web/src/export/export-core.ts:477`.
**A fallback left pointing at the new default is exactly the "existing projects shifted under them"
outcome this design exists to prevent, and no gate would catch it** — the fixtures build their own
compositions and would happily stamp the new default themselves. Which is the last fixture requirement:
**every render-comparison fixture stamps `effectLight` explicitly**, so the gate never inherits a default
and never silently changes arm.

**UI:** one checkbox in project settings — *"Blend effects in linear light"* — with a short note that it
changes how existing effects look. Flipping it on an existing project is allowed, warned, and undoable.

---

## Recommended first slice, and an honest size

**Slice 1.** It is the founder's reported defect, it is self-contained in one branch of one function, and
it carries the setting, the threading, the precision decision and the across-commit baseline check that
every later slice needs. **3–5 days**, of which roughly a day is the `SRGB8_ALPHA8` probe and the
preview/export precision divergence, and roughly a day is the baseline check that does not exist yet.

Whole programme: **4–6 weeks** across slices 1–4, plus founder look-reviews at slices 1, 2 and 3 that a
green gate cannot substitute for. The programme is bigger than the audit's original "half a day" by an
order of magnitude — but for the reason the audit itself identified when it re-scoped the fix, not
because of precision. **Precision turned out to be the cheap part.** The expensive parts are re-tuning
effects that were authored against the old space, and rebaselining a gate carefully enough that green
still means something while it happens.
