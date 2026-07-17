/**
 * Single GPU compositor (Method 3, Phase 1) — `SceneCompositor`.
 *
 * Today the web preview lays every per-clip graded `<canvas>` out as a separate DOM sibling and lets
 * the browser composite them (CSS mask-image / mix-blend-mode), while the local export composites the
 * same graded canvases onto a canvas2D. Both are the SAME composite expressed two ways — the #1
 * parity-bug source. `SceneCompositor` collapses that composite into ONE WebGL2 pass: each
 * already-graded media canvas becomes a texture, object-fit + clip mask + transform + blend mode are
 * applied in-shader, and the result is one output canvas (preview draws it to screen; export will read
 * it back in a later phase).
 *
 * Phase 1 deliberately does NOT change how clips are graded: callers keep producing graded canvases
 * with the existing per-clip `MediaWebGLRenderer` and pass them in here. Uploading an already-graded
 * canvas as a texture is the proven `TransitionCompositor` pattern, so the unified pass stays
 * pixel-aligned with the per-clip path without a cross-context FBO refactor. Text/shape layers stay
 * DOM overlays on top of this canvas (handled by the caller); they fold into the GPU pass in Phase 4.
 *
 * Geometry mirrors the canvas2D export's 2D path EXACTLY (translate→rotate→scale about the layer
 * center, object-fit centered in the comp box) so the two renderers agree; the only difference is the
 * final composite happens on the GPU. 3D-tilted layers are not handled here yet — the caller falls
 * back to the DOM renderer for those comps (Phase 4 brings tilt + text/shape into this pass).
 */

import { BLEND_GLSL, blendModeIndex } from "./blend";
import {
  FULLSCREEN_TRI_VS,
  RenderTarget,
  compileShader,
  createFullscreenVao,
  createGl,
  getTexImageSourceProducerInfo,
  linkProgram,
  releaseContextIfDetached,
  type AnyCanvas,
} from "./gl-context";
import {
  buildTransitionFragmentShader,
  resolveTransitionParams,
  type TransitionDefinition,
  type TransitionParam,
} from "./transitions/registry";
import { PipelineAssembler } from "./transitions/pipeline-assembler";
import {
  buildFragmentEffectShader,
  resolveFragmentEffectParams,
  type FragmentEffectDefinition,
  type FragmentEffectParam,
} from "./fragment-effects/registry";
import type { BlendMode } from "../types";
import type { ColorPipeline } from "./types";
import { MediaWebGLRenderer } from "./media-renderer";

export type ObjectFit = "cover" | "contain" | "fill";

/**
 * A layer source that is ALREADY a GPU texture living in THIS compositor's WebGL2 context (Method 3, Phase 2)
 * — e.g. a `MediaWebGLRenderer` shared-context `RenderTarget` output. The compositor samples it DIRECTLY (no
 * `texImage2D` upload), which removes the cross-context canvas→texture upload that fails in the export Worker.
 * Orientation matches the canvas-upload path: `uploadSource` flips canvases (top-origin) to framebuffer-native
 * bottom-origin, which is exactly what a render-target texture already is — so it's a drop-in (validated by
 * the `export:worker-scene` parity gate).
 */
export interface SceneTextureSource {
  /** A texture created on this `SceneCompositor`'s context (the caller owns its lifetime). */
  texture: WebGLTexture;
  /** Natural pixel size (used for object-fit, same as `sourceWidth`/`sourceHeight`). */
  width: number;
  height: number;
  /** Diagnostic-only backing target metadata for single-context export probes. */
  debugTarget?: { width: number; height: number; framebufferStatus?: string; framebufferComplete?: boolean } | undefined;
}

/** True when a layer source is a same-context GPU texture (sample directly) vs an uploadable `TexImageSource`. */
export function isSceneTextureSource(s: TexImageSource | SceneTextureSource): s is SceneTextureSource {
  return (s as SceneTextureSource).texture !== undefined && typeof (s as SceneTextureSource).width === "number";
}

export interface SceneLayerTransform {
  /** Layer center, percent of comp (0..100). */
  x: number;
  y: number;
  scale: number;
  /** In-plane rotation, degrees (clockwise, matching canvas2D). */
  rotation: number;
  /** 0..100. */
  opacity: number;
}

/**
 * One region-effect pass (the After Effects model — see todo.md "Region-effect model"): applied to the
 * layer's RUNNING composited image inside a per-layer nest, masked to its own region. Exactly one of:
 *   - `blurPx`: gaussian-blur the running nest image, composite it back masked — a region blur combines
 *     with whatever is already on the layer (base grade, earlier passes).
 *   - `pipeline`: grade the running nest image with this ONE effect's color pipeline (in-compositor,
 *     shared-context MediaWebGLRenderer) and composite it back masked — region color combines the same way.
 * `mask` is the comp-space alpha matte of `clip ∩ region`. Passes are generic {effect params, mask} — no
 * per-effect-type logic beyond "blur is a kernel, color is a pipeline" (todo.md P3).
 */
export interface SceneRegionPass {
  /** Stable id for the pass (drives the per-effect grade renderer/LUT cache). */
  effectKey: string;
  /** Comp-sized alpha matte (comp space, pre-transform); `.a` is coverage of the pass region. */
  mask: TexImageSource;
  maskVersion?: number | undefined;
  /** Gaussian blur radius (σ, backing px) applied to the RUNNING nest image. */
  blurPx?: number | undefined;
  /** Color pipeline of the ONE region effect, applied to the RUNNING nest image. */
  pipeline?: ColorPipeline | null | undefined;
}

export interface SceneLayerDraw {
  /** Diagnostic-only source layer id. Ignored by the renderer. */
  debugLayerId?: string | undefined;
  /**
   * Already-graded, straight-alpha source: either a `TexImageSource` to upload (a `MediaWebGLRenderer` canvas,
   * raster, etc.) OR a `SceneTextureSource` already on this compositor's context (sampled directly — Phase 2
   * single-context export). Both behave identically per-pixel; the texture path just skips the upload.
   */
  source: TexImageSource | SceneTextureSource;
  /** Natural pixel size of `source`, for object-fit. (Comp-sized sources pass comp w/h + fit:"fill".) */
  sourceWidth: number;
  sourceHeight: number;
  fit: ObjectFit;
  transform: SceneLayerTransform;
  blendMode: BlendMode;
  /** Optional comp-sized alpha matte (clip mask), in comp space, pre-transform. Its `.a` is coverage. */
  mask?: TexImageSource | null;
  /**
   * Source-within-frame transform (media only): `scale` zooms the source inside the frame (folded into the
   * object-fit), `pan` shifts it (frame-space, -0.5..0.5 per axis), `crop` trims the frame edges
   * (left,right,top,bottom fractions). Omitted = identity. See `LayerContentTransform`.
   */
  content?: { scale: number; pan: [number, number]; crop: [number, number, number, number] } | null | undefined;
  /** Gaussian blur radius in comp px (σ). 0/undefined = none. The GPU sibling of `filter: blur()`. */
  blurPx?: number | undefined;
  /**
   * Whole-clip glow. `color` is straight-alpha rgb 0..1. `mode` "edge" = drop-shadow of the alpha silhouette
   * (text/cutouts); "highlights" = luminance bloom (bright areas glow outward — for opaque footage). `threshold`
   * (0..1) + `strength` apply to highlights mode only. Omitted mode defaults to "edge" (back-compat).
   */
  glow?:
    | { radiusPx: number; color: [number, number, number]; mode?: "edge" | "highlights"; threshold?: number; strength?: number }
    | null
    | undefined;
  /**
   * Content version of `source` for the texture cache. When it matches the last uploaded version the
   * GPU texture is reused as-is (no re-upload) — the win for static text/shape rasters. `undefined`
   * means "always re-upload" (media: the graded canvas changes every frame). Re-uploads use
   * `texSubImage2D` (no realloc) when the size is unchanged, so even media never churns GPU storage.
   */
  sourceVersion?: number | undefined;
  /** Content version of `mask` (same semantics as `sourceVersion`); `undefined` = always re-upload. */
  maskVersion?: number | undefined;
  /**
   * Element-box half-extents in comp px (unscaled). Media's element IS the comp, so omit it (defaults
   * to comp/2). Text/shape content rasters pass their tight box so the composite quad places + tilts the
   * box about the layer center (the 3D-tilt translate(-50%,-50%) term needs the real box).
   */
  box?: { halfW: number; halfH: number } | undefined;
  /** 3D tilt (Phase 4.1). Default 0 → the quad reduces to the 2D affine path, byte-identical. */
  rotateX?: number | undefined;
  rotateY?: number | undefined;
  /** CSS perspective px (0 = none). */
  perspective?: number | undefined;
  /** translateZ px. */
  z?: number | undefined;
  /**
   * Ordered region-effect passes (flag-gated pass model). When present, the layer renders into its own
   * nest: base draw first, then each pass applied to the running nest image masked to its region, and the
   * finished nest composites once with the layer's blend/opacity. Replaces stacked `__rfx_` clone draws.
   */
  regionPasses?: SceneRegionPass[] | undefined;
  /**
   * Ordered plugin fragment-shader passes (real user GLSL "Custom Shader" effects, Task 1.3). Each
   * applies to the layer's RUNNING nest image, same precompose model as `regionPasses` — run inside
   * the SAME nest, after any region passes, in `layer.effects` index order (the caller is responsible
   * for ordering). A pass with no `mask` covers the whole layer.
   */
  fragmentPasses?: SceneFragmentPass[] | undefined;
  /**
   * Track matte key (D1): `draw` is the matte SOURCE's own full draw (a layer, or a compound-clip
   * group), pre-composed into a comp-sized RTT whose alpha (`mode: "alpha"`) or luminance×alpha
   * (`mode: "luma"`) multiplies this layer's coverage — applied at the FINAL composite (after
   * blur/glow/region/fragment passes, the AE order), in comp space alongside the clip mask.
   * `draw: null` means the layer asked for a matte but no source exists at this time: an EMPTY matte
   * (layer invisible; fully visible when `invert`). The source never also draws normally —
   * `build-scene-draws` excludes it. Chained mattes work (depth-indexed RTT pool).
   */
  matteFrom?: { draw: SceneLayerDraw | SceneGroupDraw | null; mode: "alpha" | "luma"; invert?: boolean | undefined } | null | undefined;
}

/**
 * One plugin fragment-shader pass — a real user GLSL `vec4 effect(vec2 uv)` body applied to the
 * layer's running nest image (see `fragment-effects/registry.ts`). Mirrors `SceneRegionPass`'s
 * precompose model: `intensity` mixes the effect against the running image (baked into the shader's
 * own `main()`), `mask` (optional) limits it to a region — omitted = whole layer.
 */
export interface SceneFragmentPass {
  /** Stable id for the pass (drives the compiled-program cache — this is the fragment def's id). */
  effectKey: string;
  def: FragmentEffectDefinition;
  params: Record<string, number | number[] | boolean>;
  /** 0..1 mix of the effect against the running image. */
  intensity: number;
  timeSeconds: number;
  mask?: TexImageSource | null | undefined;
  maskVersion?: number | undefined;
}

/**
 * A junction transition, folded INTO the compositor (Method 3 — transition effects fix). The two sides are
 * FULL layer draws (grade + content + blur + glow + mask + transform), so every per-clip effect is present
 * DURING the transition — not just after it. The compositor renders each side to its own RTT, then mixes
 * them with the transition shader in this same context (no separate `TransitionCompositor` / cross-context).
 * Placed at the incoming clip's z-slot; `from` is the outgoing clip, `to` the incoming.
 */
export interface SceneTransitionDraw {
  kind: "transition";
  /** Diagnostic-only source layer ids. Ignored by the renderer. */
  debugFromId?: string | undefined;
  debugToId?: string | undefined;
  /** Outgoing/incoming clip GROUPS: each is the clip's base + its region-expansion (`__rfx_`) layers in
   *  back-to-front order. The compositor composites each group into its side RTT (so every per-clip effect —
   *  region blur/colour, future plugin region effects — renders THROUGH the transition), then mixes the two. */
  from: SceneLayerDraw[];
  to: SceneLayerDraw[];
  def: TransitionDefinition;
  /** EASED progress 0..1 (caller applies the definition's easing). */
  progress: number;
  params?: Record<string, number | number[] | boolean> | undefined;
}

/**
 * A compound-clip (nested sequence) GROUP draw (NESTING.md Phase C). `children` are the nest's own
 * layers (back-to-front, ALREADY mapped/built against the NESTED comp's coordinate space by
 * `build-scene-draws.ts` — see `buildLayerDraw`'s `{w,h}` override), pre-composed into an RTT the size
 * of the nested comp, then that RTT becomes the source of a normal layer draw carrying the compound
 * clip's own transform/effects/masks/blend (`shell`) — the same "pre-compose / nest" pattern
 * `precomposeGroup` already uses for transition sides and region-effect passes.
 */
export interface SceneGroupDraw {
  kind: "group";
  /** Diagnostic-only source group id. Ignored by the renderer (matches debugLayerId/debugFromId/
   *  debugToId convention) — NOT used as a cache key; see `renderGroupInto`'s depth-indexed pool. */
  debugGroupId?: string | undefined;
  /** Children back-to-front. Their draws were built against the NESTED comp's logical size. A child
   *  may itself be a `SceneGroupDraw` (nests-in-nests). */
  children: SceneDraw[];
  /**
   * Nested comp size IN BACKING PIXELS (i.e. already `logicalNestSize × renderScale` — the caller,
   * `build-scene-draws.ts`, bakes renderScale in exactly like it does for `SceneLayerDraw.box`/
   * `blurPx`/`perspective`/`z`, since renderScale never crosses into this file otherwise). The RTT
   * `children` render into is exactly this size, cleared TRANSPARENT (NESTING.md §5 — alpha survives
   * to the parent composite; the nested comp's own backgroundColor is never drawn here).
   */
  nestWidth: number;
  nestHeight: number;
  /** The compound clip's own presentation, applied to the composited RTT as if it were a media source:
   *  everything a SceneLayerDraw has EXCEPT source/sourceWidth/sourceHeight/sourceVersion. */
  shell: Omit<SceneLayerDraw, "source" | "sourceWidth" | "sourceHeight" | "sourceVersion">;
}

/** A compositor draw entry: a normal layer, a folded transition between two full layer draws, or a
 *  compound-clip group (nested sequence pre-composed as one unit). */
export type SceneDraw = SceneLayerDraw | SceneTransitionDraw | SceneGroupDraw;

function isTransitionDraw(d: SceneDraw): d is SceneTransitionDraw {
  return (d as SceneTransitionDraw).kind === "transition";
}

function isGroupDraw(d: SceneDraw): d is SceneGroupDraw {
  return (d as SceneGroupDraw).kind === "group";
}

export interface SceneFrameSpec {
  width: number;
  height: number;
  backgroundColor: string;
  /** Visible draws, back-to-front (first drawn = bottom). A draw is a layer or a folded transition. */
  layers: SceneDraw[];
  /** Diagnostic-only preview/export time for upload tracing. */
  debugFrameTime?: number | undefined;
}

export const SCENE_COMPOSITOR_CONTEXT_LOST = "SCENE_COMPOSITOR_CONTEXT_LOST";

export interface SceneCompositorDebugSnapshot {
  width: number;
  height: number;
  canvasWidth: number;
  canvasHeight: number;
  contextLost: boolean;
  viewport: number[];
  scissorBox: number[];
  scissorTest: boolean;
  lastPresentViewport: number[] | null;
  framebufferBinding: "null" | "bound";
  texture2dBinding: "null" | "bound";
  glError: number;
  targets: Record<string, { width: number; height: number; framebufferStatus: string; framebufferComplete: boolean }>;
}

/**
 * One compiled pass of a multi-pass transition pipeline (assembled by `PipelineAssembler`). `uSrc` is
 * the ping-pong input (previous pass output; the outgoing side on pass 0); `extra` holds locations for
 * BOTH the definition's params and the pass's own static param overrides, looked up by name.
 */
interface CompiledPipelinePass {
  program: WebGLProgram;
  uSrc: WebGLUniformLocation | null;
  uFrom: WebGLUniformLocation | null;
  uTo: WebGLUniformLocation | null;
  uProgress: WebGLUniformLocation | null;
  uResolution: WebGLUniformLocation | null;
  uRatio: WebGLUniformLocation | null;
  uFromFit: WebGLUniformLocation | null;
  uToFit: WebGLUniformLocation | null;
  extra: { name: string; location: WebGLUniformLocation | null }[];
  /** Pass-level static param values (override resolved def params for this pass only). */
  passParams: Record<string, number | number[] | boolean>;
}

/** A compiled per-transition program + its uniform locations (mirrors TransitionCompositor's cache).
 *  Either a single monolith program (`program` set) or a multi-pass pipeline (`pipelinePasses` set). */
interface CompiledTransition {
  program: WebGLProgram | null;
  uFrom: WebGLUniformLocation | null;
  uTo: WebGLUniformLocation | null;
  uProgress: WebGLUniformLocation | null;
  uResolution: WebGLUniformLocation | null;
  uRatio: WebGLUniformLocation | null;
  uFromFit: WebGLUniformLocation | null;
  uToFit: WebGLUniformLocation | null;
  params: { param: TransitionParam; location: WebGLUniformLocation | null }[];
  pipelinePasses: CompiledPipelinePass[] | null;
}

/** A compiled per-fragment-effect program + its uniform locations (mirrors CompiledTransition). */
interface CompiledFragmentEffect {
  program: WebGLProgram;
  uSrc: WebGLUniformLocation | null;
  uResolution: WebGLUniformLocation | null;
  uIntensity: WebGLUniformLocation | null;
  uTime: WebGLUniformLocation | null;
  params: { param: FragmentEffectParam; location: WebGLUniformLocation | null }[];
  lastFrame: number;
}

const COMPOSITE_VS = `#version 300 es
in vec3 a_posw;     // NDC corner (xy) + projective w (z) for perspective tilt
in vec2 a_uv;       // source/plate uv, bottom-left origin
out vec2 v_uv;
void main(){
  v_uv = a_uv;
  float w = a_posw.z;
  // Pre-multiply by w so the GPU's perspective divide restores NDC and interpolates v_uv
  // perspective-correctly across a tilted quad. w == 1 for the 2D path → gl_Position = (xy, 0, 1).
  gl_Position = vec4(a_posw.xy * w, 0.0, w);
}`;

const COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D uSrc;
uniform sampler2D uMask;
uniform sampler2D uDest;
uniform sampler2D uTrackMatte;
uniform bool uHasMask;
uniform bool uHasTrackMatte;
uniform bool uTrackMatteLuma;
uniform bool uTrackMatteInvert;
uniform vec2 uResolution;
uniform float uOpacity;
uniform int uBlend;
uniform vec2 uFitScale; // comp/draw per axis (object-fit, content zoom folded in); (1,1) = fill
uniform vec2 uContentPan; // pan the source within the frame (frame space)
uniform vec4 uCrop;       // edge insets: left, right, top, bottom (fractions of the frame)
out vec4 fragColor;
${BLEND_GLSL}
void main(){
  // Crop trims the frame edges → the trimmed area reads transparent (the backdrop shows through).
  if (v_uv.x < uCrop.x || v_uv.x > 1.0 - uCrop.y || v_uv.y > 1.0 - uCrop.z || v_uv.y < uCrop.w) {
    fragColor = texture(uDest, gl_FragCoord.xy / uResolution);
    return;
  }
  // Object-fit + content pan/zoom: map plate uv -> media uv about the comp center.
  vec2 mediaUv = (v_uv - 0.5 - uContentPan) * uFitScale + 0.5;
  vec4 src = vec4(0.0);
  if (all(greaterThanEqual(mediaUv, vec2(0.0))) && all(lessThanEqual(mediaUv, vec2(1.0)))) {
    src = texture(uSrc, mediaUv);
  }
  if (uHasMask) {
    // The clip-mask matte is COMP-space; sample it at the fragment's comp position, not v_uv. For a
    // comp-filling quad the two coincide, but for an element-box (text/shape) or tilted quad v_uv is
    // box-local, so v_uv would mis-place the matte. gl_FragCoord/uResolution is always comp space.
    src.a *= texture(uMask, gl_FragCoord.xy / uResolution).a;
  }
  if (uHasTrackMatte) {
    // Track matte (D1) is comp-space like the clip mask. Luma mode uses Rec.709 weights on the
    // straight rgb, gated by the matte's own alpha — transparent areas read as BLACK (the
    // Premiere/AE convention), so an alpha-less luma source and a cutout both behave.
    vec4 tm = texture(uTrackMatte, gl_FragCoord.xy / uResolution);
    float cov = uTrackMatteLuma ? dot(tm.rgb, vec3(0.2126, 0.7152, 0.0722)) * tm.a : tm.a;
    src.a *= uTrackMatteInvert ? 1.0 - cov : cov;
  }
  src.a *= uOpacity;
  vec4 dst = texture(uDest, gl_FragCoord.xy / uResolution);
  fragColor = blendCompose(uBlend, dst, src);
}`;

// Passthrough present: sample the final accumulator and write it to the default framebuffer.
const PRESENT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D uTex;
out vec4 fragColor;
void main(){ fragColor = texture(uTex, v_uv); }`;

// Plate pass: object-fit + clip mask into a comp-sized RTT (the COMPOSITE_FS sampling minus blend/dest).
// Used only for blur/glow layers, which need an intermediate texture to run effect passes on.
const PLATE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D uSrc;
uniform sampler2D uMask;
uniform bool uHasMask;
uniform vec2 uFitScale;     // object-fit, with content zoom folded in by JS
uniform vec2 uContentPan;   // pan the source within the frame (frame space)
uniform vec4 uCrop;         // edge insets: left, right, top, bottom (fractions of the frame)
out vec4 fragColor;
void main(){
  // Crop trims the frame edges → the trimmed area reads transparent (shows what's below).
  if (v_uv.x < uCrop.x || v_uv.x > 1.0 - uCrop.y || v_uv.y > 1.0 - uCrop.z || v_uv.y < uCrop.w) { fragColor = vec4(0.0); return; }
  vec2 mediaUv = (v_uv - 0.5 - uContentPan) * uFitScale + 0.5;
  vec4 src = vec4(0.0);
  if (all(greaterThanEqual(mediaUv, vec2(0.0))) && all(lessThanEqual(mediaUv, vec2(1.0)))) {
    src = texture(uSrc, mediaUv);
  }
  if (uHasMask) src.a *= texture(uMask, v_uv).a;
  fragColor = src; // opacity is already baked into uSrc
}`;

// Separable Gaussian blur (one axis per pass) in PREMULTIPLIED alpha — matches Chrome's filter:blur()
// and avoids dark halos at edges. uPremultIn converts a straight-alpha input on read; uUnpremultOut
// converts back to straight on write, so a H(premult-in)→V(unpremult-out) pair takes straight→straight.
const BLUR_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D uTex;
uniform vec2 uStep;     // texel step along the blur axis (1/size in that axis)
uniform int uRadius;    // half-width in taps
uniform float uSigma;
uniform bool uPremultIn;
uniform bool uUnpremultOut;
out vec4 fragColor;
void main(){
  float twoSigma2 = max(2.0 * uSigma * uSigma, 1e-4);
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (int i = -uRadius; i <= uRadius; i++) {
    float fi = float(i);
    float wt = exp(-(fi * fi) / twoSigma2);
    vec2 suv = v_uv + uStep * fi;
    // Samples beyond the plate read as TRANSPARENT, not CLAMP_TO_EDGE — otherwise edge texels smear
    // into the comp corners/edges (the leak). Still divide by the full Gaussian weight so the edge
    // fades out smoothly instead of brightening.
    vec4 t = (any(lessThan(suv, vec2(0.0))) || any(greaterThan(suv, vec2(1.0)))) ? vec4(0.0) : texture(uTex, suv);
    if (uPremultIn) t.rgb *= t.a;
    acc += t * wt;
    wsum += wt;
  }
  acc /= max(wsum, 1e-6);
  // Guard the un-premultiply: in near-zero-alpha regions dividing by a tiny alpha injects garbage
  // color (visible fringe). Below a floor, leave it fully transparent.
  if (uUnpremultOut) acc.rgb = acc.a > 1e-4 ? acc.rgb / acc.a : vec3(0.0);
  fragColor = acc;
}`;

// Glow = drop-shadow(0 0 r color): the plate's blurred alpha silhouette, tinted, composited UNDER the
// plate (straight-alpha src-over). uGlow's .a is the blurred silhouette; uPlate sits on top.
const GLOW_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D uPlate;
uniform sampler2D uGlow;
uniform vec3 uGlowColor;
out vec4 fragColor;
void main(){
  vec4 plate = texture(uPlate, v_uv);
  float ga = texture(uGlow, v_uv).a;
  float ao = plate.a + ga * (1.0 - plate.a);
  vec3 co = plate.rgb * plate.a + uGlowColor * ga * (1.0 - plate.a);
  fragColor = vec4(ao > 0.0 ? co / ao : vec3(0.0), ao);
}`;

// Bloom brightpass: keep only the plate's BRIGHT pixels (luminance above the threshold, soft knee), in
// straight alpha with the brightness weight folded into alpha. Blurring this (premultiplied) then spreads
// the bright energy outward — the basis of a highlight bloom (vs the edge glow, which blooms the silhouette).
const BLOOM_BRIGHT_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D uSrc;
uniform float uThreshold;
out vec4 fragColor;
void main(){
  vec4 c = texture(uSrc, v_uv);
  float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
  float w = smoothstep(uThreshold, min(1.0, uThreshold + 0.25), l) * c.a;
  fragColor = vec4(c.rgb, w);
}`;

// Bloom composite: ADD the blurred bright bloom (tinted) on top of the plate. The bloom can also light up
// the just-outside-edge neighborhood (ao grows with the bloom weight), so highlights glow OUTWARD.
const BLOOM_ADD_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D uPlate;
uniform sampler2D uBloom;
uniform vec3 uTint;
uniform float uStrength;
out vec4 fragColor;
void main(){
  vec4 plate = texture(uPlate, v_uv);
  vec4 bloom = texture(uBloom, v_uv);
  float w = bloom.a * uStrength;
  vec3 add = bloom.rgb * w * uTint;          // bright bloom color, tinted by the glow color
  float ao = clamp(plate.a + w, 0.0, 1.0);   // bloom can extend just past the content edge
  vec3 co = plate.rgb * plate.a + add;       // additive light over the premultiplied base
  fragColor = vec4(ao > 0.0 ? co / ao : vec3(0.0), ao);
}`;

const DEG = Math.PI / 180;
const MAX_BLUR_RADIUS = 96;

/** GLSL declaration types for transition params (mirrors registry.ts's private GLSL_TYPE). */
const GLSL_PARAM_TYPE: Record<TransitionParam["type"], string> = {
  float: "float",
  vec2: "vec2",
  vec3: "vec3",
  bool: "bool",
};

/** Set a uniform whose GLSL type is inferred from the JS value shape (pipeline pass params). */
function setUniformByValue(
  gl: WebGL2RenderingContext,
  location: WebGLUniformLocation,
  value: number | number[] | boolean,
): void {
  if (typeof value === "number") gl.uniform1f(location, value);
  else if (typeof value === "boolean") gl.uniform1i(location, value ? 1 : 0);
  else if (Array.isArray(value)) {
    if (value.length === 2) gl.uniform2f(location, value[0] ?? 0, value[1] ?? 0);
    else if (value.length === 3) gl.uniform3f(location, value[0] ?? 0, value[1] ?? 0, value[2] ?? 0);
    else if (value.length === 4) gl.uniform4f(location, value[0] ?? 0, value[1] ?? 0, value[2] ?? 0, value[3] ?? 0);
  }
}

/** Parse `#rgb` / `#rrggbb` (or fall back to black) into 0..1 rgb. */
function parseColor(hex: string): [number, number, number] {
  const h = (hex || "").trim().replace(/^#/, "");
  if (h.length === 3) {
    const r = h.slice(0, 1);
    const g = h.slice(1, 2);
    const b = h.slice(2, 3);
    return [parseInt(r + r, 16) / 255, parseInt(g + g, 16) / 255, parseInt(b + b, 16) / 255];
  }
  if (h.length === 6) {
    return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
  }
  return [0, 0, 0];
}

/** Intrinsic pixel size of a texture source (canvas/bitmap/video/image), without `instanceof`. */
function srcDims(s: TexImageSource): [number, number] {
  const a = s as { videoWidth?: number; naturalWidth?: number; width?: number; displayWidth?: number; videoHeight?: number; naturalHeight?: number; height?: number; displayHeight?: number };
  const w = a.videoWidth || a.naturalWidth || a.width || a.displayWidth || 0;
  const h = a.videoHeight || a.naturalHeight || a.height || a.displayHeight || 0;
  return [w, h];
}

type UploadRole = "source" | "mask" | "empty";

interface UploadDebugMeta {
  layerId?: string | undefined;
  role: UploadRole;
  frameTime?: number | undefined;
}

interface UploadDebugSnapshot extends UploadDebugMeta {
  sourceKind: string;
  width: number;
  height: number;
  textureState: "new" | "resize" | "existing";
  op?: "texImage2D" | "texSubImage2D" | undefined;
  contextLostBefore: boolean;
  producer?: { label: string; disposed: boolean; contextLost: boolean; width: number; height: number } | undefined;
  glErrorAfter?: number | undefined;
  reason?: string | undefined;
}

function sceneGlDebugEnabled(): boolean {
  try {
    const global = globalThis as {
      location?: { search?: string };
      localStorage?: { getItem: (key: string) => string | null };
    };
    const params = new URLSearchParams(global.location?.search ?? "");
    return params.get("debugGl") === "1" || global.localStorage?.getItem("kimera_debug_gl") === "1";
  } catch {
    return false;
  }
}

function sourceKind(source: TexImageSource): string {
  if (typeof HTMLVideoElement !== "undefined" && source instanceof HTMLVideoElement) return "HTMLVideoElement";
  if (typeof HTMLImageElement !== "undefined" && source instanceof HTMLImageElement) return "HTMLImageElement";
  if (typeof HTMLCanvasElement !== "undefined" && source instanceof HTMLCanvasElement) return "HTMLCanvasElement";
  if (typeof OffscreenCanvas !== "undefined" && source instanceof OffscreenCanvas) return "OffscreenCanvas";
  if (typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap) return "ImageBitmap";
  const s = source as { videoWidth?: number; naturalWidth?: number; displayWidth?: number; width?: number };
  if (typeof s.videoWidth === "number") return "HTMLVideoElement";
  if (typeof s.naturalWidth === "number") return "HTMLImageElement";
  if (typeof s.displayWidth === "number") return "ImageBitmap";
  if (typeof s.width === "number") return "canvas";
  return "TexImageSource";
}

/** comp/draw scale per axis for object-fit (inverse of how much the media is scaled to fill the box). */
function fitScale(sw: number, sh: number, cw: number, ch: number, fit: ObjectFit): [number, number] {
  if (fit === "fill" || sw <= 0 || sh <= 0) return [1, 1];
  const scale = fit === "contain" ? Math.min(cw / sw, ch / sh) : Math.max(cw / sw, ch / sh);
  const drawW = sw * scale;
  const drawH = sh * scale;
  return [drawW > 0 ? cw / drawW : 1, drawH > 0 ? ch / drawH : 1];
}

export class SceneCompositor {
  readonly canvas: AnyCanvas;
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly vbo: WebGLBuffer;
  // Per-source GPU texture cache (keyed by the source object). Re-uploading via texSubImage2D instead
  // of texImage2D, and skipping the upload entirely for unchanged sources, removes the per-frame
  // texImage2D realloc churn that caused the periodic playback hitch.
  private readonly srcTextures = new Map<TexImageSource, { tex: WebGLTexture; w: number; h: number; version: number; lastFrame: number }>();
  private frameCounter = 0;
  // 1×1 placeholder bound to the mask sampler when a layer has no mask (the shader won't sample it,
  // but a valid texture must stay bound to the unit).
  private readonly emptyTex: WebGLTexture;
  // Reused 1px scratch for finish()'s materialization readback (export capture sync) — avoids per-frame alloc.
  private readonly captureSyncPixel = new Uint8Array(4);
  // Present pass: a textured fullscreen triangle that copies the final accumulator to the canvas.
  private readonly presentProgram: WebGLProgram;
  private readonly presentVao: WebGLVertexArrayObject;
  private readonly uPresentTex: WebGLUniformLocation | null;
  // Effect passes (plate/blur/glow/bloom). These programs are LINKED LAZILY on first blur/glow use
  // (see ensureEffectPrograms), NOT in the constructor: linking all of them synchronously at mount
  // blocked the main thread ~1s on the GPU driver's shader compile — the "Page Unresponsive" stall
  // (2026-07-14, stall-profiler evidence). Most comps have no blur/glow and now never compile them.
  // The `!` fields stay definitely-typed so the hot-path call sites are byte-identical; the single
  // choke point (ensureEffectPrograms, called from effectTargets) guarantees they're built first.
  // The comp-sized RTTs these passes need are likewise allocated lazily in effectTargets and pooled.
  private effectProgramsBuilt = false;
  private plateProgram!: WebGLProgram;
  private blurProgram!: WebGLProgram;
  private glowProgram!: WebGLProgram;
  private bloomBrightProgram!: WebGLProgram;
  private bloomAddProgram!: WebGLProgram;
  private uPlateSrc!: WebGLUniformLocation | null;
  private uPlateMask!: WebGLUniformLocation | null;
  private uPlateHasMask!: WebGLUniformLocation | null;
  private uPlateFitScale!: WebGLUniformLocation | null;
  private uPlateContentPan!: WebGLUniformLocation | null;
  private uPlateCrop!: WebGLUniformLocation | null;
  private uBlurTex!: WebGLUniformLocation | null;
  private uBlurStep!: WebGLUniformLocation | null;
  private uBlurRadius!: WebGLUniformLocation | null;
  private uBlurSigma!: WebGLUniformLocation | null;
  private uBlurPremultIn!: WebGLUniformLocation | null;
  private uBlurUnpremultOut!: WebGLUniformLocation | null;
  private uGlowPlate!: WebGLUniformLocation | null;
  private uGlowTex!: WebGLUniformLocation | null;
  private uGlowColor!: WebGLUniformLocation | null;
  private uBloomBrightSrc!: WebGLUniformLocation | null;
  private uBloomBrightThreshold!: WebGLUniformLocation | null;
  private uBloomAddPlate!: WebGLUniformLocation | null;
  private uBloomAddTex!: WebGLUniformLocation | null;
  private uBloomAddTint!: WebGLUniformLocation | null;
  private uBloomAddStrength!: WebGLUniformLocation | null;
  private plateRT: RenderTarget | null = null;
  private scratch1: RenderTarget | null = null;
  private scratch2: RenderTarget | null = null;
  // Small pooled target for `readCompositeThumbnail` — the color scopes downsample the RETAINED
  // composite (accumA) into this via a linear blit, so scope sampling never re-composites the frame
  // and never depends on the on-screen canvas (which has no preserveDrawingBuffer). Lazily allocated.
  private scopeThumb: RenderTarget | null = null;
  // Async (PBO + fence) scope readback state (`readCompositeThumbnailAsync`) — the synchronous
  // `gl.readPixels` in `readCompositeThumbnail` stalls the CPU until the GPU drains; the async path reads
  // into a PIXEL_PACK_BUFFER (returns immediately), fences it, and harvests it a frame later with a
  // NON-blocking `clientWaitSync(0)` → `getBufferSubData`. One-slot pipeline (scopes run ≤10Hz), so the
  // returned frame is the previous completed read (a frame of latency the scopes tolerate). Lazily allocated.
  private scopePbo: WebGLBuffer | null = null;
  private scopeFence: WebGLSync | null = null;
  private scopePboBytes = 0;
  private scopePendingWH: { w: number; h: number } | null = null;
  private scopeReady: { pixels: Uint8Array; w: number; h: number } | null = null;
  // Per-transition-side RTT PAIRS. Each side is a clip NEST (base + its region-expansion layers) pre-composed
  // to a finished image, then the two are mixed — the NLE pre-compose/nest model. Each side needs its own
  // ping-pong pair (target + scratch) because the nest is built with the SAME multi-layer accumulator the main
  // scene uses (which reads its previous contents as backdrop). Lazily allocated; comps with no transition pay
  // zero VRAM.
  private sideA: RenderTarget | null = null;
  private sideAScratch: RenderTarget | null = null;
  private sideB: RenderTarget | null = null;
  private sideBScratch: RenderTarget | null = null;
  // Per-LAYER nest ping-pong pair for region-effect passes (dedicated: a regioned layer can render INSIDE a
  // transition side, whose pair is busy). Lazily allocated; comps with no region passes pay zero VRAM.
  private layerNestA: RenderTarget | null = null;
  private layerNestB: RenderTarget | null = null;
  // NEST-REVIEW: plan asked to "pool group RTTs per debugGroupId"; implemented DEPTH-indexed instead —
  // debug*-prefixed fields are documented elsewhere in this file as diagnostic-only / "ignored by the
  // renderer" (debugLayerId, debugFromId/debugToId), so keying a correctness-load-bearing cache off
  // debugGroupId would break that convention. Depth-indexing gives the same no-data-race guarantee
  // (see comment below) without relying on an optional debug field. Flagging for confirmation.
  //
  // Per-NESTING-DEPTH ping-pong pairs for compound-clip GROUP draws (NESTING.md Phase C), indexed by
  // recursion depth (0 = outermost group in the frame). DEPTH-indexed rather than per-group-id: while an
  // outer group's children render, `accumA/accumB` are temporarily the outer group's own pair (see
  // `renderGroupInto`) — an inner group (nest-in-nest) child needs a DIFFERENT physical pair to pre-compose
  // into before its finished texture can be composited back into the still-in-progress outer accumulator,
  // exactly the reason `layerNestA/B` is dedicated apart from the transition-side pair. Groups at the SAME
  // depth never render concurrently (fully sequential, one clip finishes and its texture is consumed before
  // the next starts), so reuse across siblings at one depth is safe — this mirrors `sideA/sideB` being a
  // single reusable pair rather than a map. Bounded by `NEST_MAX_DEPTH` (8), so at most 8 pairs ever exist.
  private readonly groupTargets: { target: RenderTarget; scratch: RenderTarget }[] = [];
  // Depth-indexed RTT pairs for TRACK MATTE source pre-composes (D1) — depth-indexed for the same
  // reason as `groupTargets`: a matte source render can itself hit a matted layer (chained mattes, or
  // a matted child inside a compound clip used as a matte), and the OUTER matte texture must survive
  // until its consumer's composite draw has sampled it. Sized/resized per use to the CURRENT ambient
  // comp size (a nested consumer's matte renders at the nest's size).
  private readonly matteTargets: { target: RenderTarget; scratch: RenderTarget }[] = [];
  private matteDepth = 0;
  // The `groupTargets` depth the NEXT group render may safely use: `renderGroupInto(depth)` holds it
  // at `depth + 1` for its ENTIRE body (children render AND shell composite — the shell composite
  // still reads this depth's pair as its source). `buildTrackMatte` renders a compound-clip matte
  // SOURCE at this depth so it never clobbers a still-in-flight outer group's pair.
  private freeGroupDepth = 0;
  // Per-region-effect grade renderers ON THIS shared context (zero extra GL contexts) — each caches its own
  // baked LUT, keyed by the pass's effectKey so two alternating passes never rebake per frame. Pruned when a
  // pass hasn't drawn for a while (grade toggled off / clip left the window).
  private readonly regionGradeRenderers = new Map<
    string,
    { renderer: MediaWebGLRenderer; target: RenderTarget; pipelineKey: string; lastFrame: number }
  >();
  // While pre-composing a nest, layers composite with NORMAL blend (the clip's own blend mode applies when the
  // MIXED result lands on the main scene, not between the clip's own layers). Set only inside precomposeGroup.
  private nestMode = false;
  // Per-transition-def compiled program cache (the SAME shaders TransitionCompositor uses, compiled in
  // THIS context so the mix runs without a second GL context).
  private readonly transitionPrograms = new Map<string, CompiledTransition>();
  // Per-fragment-effect-def compiled program cache (Task 1.3 render seam) — same "compile once, cache by
  // id" pattern as transitionPrograms. A program that fails to compile is never retried (warned once);
  // the layer keeps its base image instead of going black.
  private readonly fragmentPrograms = new Map<string, CompiledFragmentEffect>();
  private readonly fragmentCompileFailureWarnings = new Set<string>();
  private accumA: RenderTarget;
  private accumB: RenderTarget;
  private width = 0;
  private height = 0;
  private disposed = false;
  private contextLost = false;
  private debugFrameTime: number | undefined;
  /** `gl.MAX_TEXTURE_SIZE`, read once — sources larger than this can't be uploaded (would be an INVALID_VALUE). */
  private readonly maxTextureSize: number;
  private readonly uploadFallbackWarnings = new Set<string>();
  private lastPresentViewport: number[] | null = null;

  // 6 vertices (2 triangles) × (ndcX, ndcY, projective w, u, v).
  private readonly quad = new Float32Array(6 * 5);

  // Uniform locations
  private readonly uSrc: WebGLUniformLocation | null;
  private readonly uMask: WebGLUniformLocation | null;
  private readonly uDest: WebGLUniformLocation | null;
  private readonly uHasMask: WebGLUniformLocation | null;
  private readonly uTrackMatte: WebGLUniformLocation | null;
  private readonly uHasTrackMatte: WebGLUniformLocation | null;
  private readonly uTrackMatteLuma: WebGLUniformLocation | null;
  private readonly uTrackMatteInvert: WebGLUniformLocation | null;
  private readonly uResolution: WebGLUniformLocation | null;
  private readonly uOpacity: WebGLUniformLocation | null;
  private readonly uBlend: WebGLUniformLocation | null;
  private readonly uFitScale: WebGLUniformLocation | null;
  private readonly uContentPan: WebGLUniformLocation | null;
  private readonly uCrop: WebGLUniformLocation | null;

  /**
   * This compositor's WebGL2 context — so the export driver (Phase 2 single-context) can construct shared-mode
   * `MediaWebGLRenderer`s + `RenderTarget`s on the SAME context and feed their outputs back as
   * {@link SceneTextureSource}s (no cross-context upload). Read-only; the compositor owns the context lifetime.
   */
  get sharedGl(): WebGL2RenderingContext {
    return this.gl;
  }

  isContextLost(): boolean {
    return this.contextLost || this.gl.isContextLost();
  }

  private framebufferStatusName(status: number): string {
    const gl = this.gl;
    if (status === gl.FRAMEBUFFER_COMPLETE) return "FRAMEBUFFER_COMPLETE";
    if (status === gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT) return "FRAMEBUFFER_INCOMPLETE_ATTACHMENT";
    if (status === gl.FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT) return "FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT";
    if (status === gl.FRAMEBUFFER_INCOMPLETE_DIMENSIONS) return "FRAMEBUFFER_INCOMPLETE_DIMENSIONS";
    if (status === gl.FRAMEBUFFER_UNSUPPORTED) return "FRAMEBUFFER_UNSUPPORTED";
    if (status === gl.FRAMEBUFFER_INCOMPLETE_MULTISAMPLE) return "FRAMEBUFFER_INCOMPLETE_MULTISAMPLE";
    return `0x${status.toString(16)}`;
  }

  private debugTarget(target: RenderTarget): { width: number; height: number; framebufferStatus: string; framebufferComplete: boolean } {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    return {
      width: target.width,
      height: target.height,
      framebufferStatus: this.framebufferStatusName(status),
      framebufferComplete: status === gl.FRAMEBUFFER_COMPLETE,
    };
  }

  private assertContextAlive(): void {
    if (this.isContextLost()) throw new Error(SCENE_COMPOSITOR_CONTEXT_LOST);
  }

  private publishUploadDebug(snapshot: UploadDebugSnapshot): void {
    if (!sceneGlDebugEnabled()) return;
    try {
      const global = globalThis as { __rfLastSceneUpload?: UploadDebugSnapshot; __rfLastSceneUploadFailure?: UploadDebugSnapshot };
      global.__rfLastSceneUpload = snapshot;
      if (snapshot.reason) global.__rfLastSceneUploadFailure = snapshot;
    } catch {
      /* ignore */
    }
  }

  private warnUploadFallback(snapshot: UploadDebugSnapshot): void {
    const key = `${snapshot.reason ?? "unknown"}:${snapshot.layerId ?? ""}:${snapshot.role}:${snapshot.sourceKind}:${snapshot.width}x${snapshot.height}`;
    if (this.uploadFallbackWarnings.has(key)) return;
    this.uploadFallbackWarnings.add(key);
    this.publishUploadDebug(snapshot);
    if (sceneGlDebugEnabled() || snapshot.reason === "exceeds-max-texture-size") {
      console.warn(
        `SceneCompositor: skipping texture upload reason=${snapshot.reason ?? "unknown"} layer=${snapshot.layerId ?? "unknown"} role=${snapshot.role} source=${snapshot.sourceKind} size=${snapshot.width}x${snapshot.height} producer=${snapshot.producer?.label ?? "none"}`,
        snapshot,
      );
    }
  }

  private failUpload(snapshot: UploadDebugSnapshot, fallbackMessage: string): never {
    this.publishUploadDebug(snapshot);
    if (sceneGlDebugEnabled()) console.warn("SceneCompositor: texture upload failed", snapshot);
    if (snapshot.reason === "context-lost" || snapshot.reason === "context-lost-after-upload" || snapshot.glErrorAfter === this.gl.CONTEXT_LOST_WEBGL || this.isContextLost()) {
      this.contextLost = true;
      throw new Error(SCENE_COMPOSITOR_CONTEXT_LOST);
    }
    throw new Error(fallbackMessage);
  }

  private assertUploadSucceeded(snapshot: UploadDebugSnapshot, debug: boolean): void {
    const gl = this.gl;
    // Cheap, always-on: did the upload reveal/trigger context loss? (the lost-context upload case).
    // gl.isContextLost() is a flag read (no GPU flush), unlike gl.getError().
    if (this.isContextLost()) {
      snapshot.reason = "context-lost-after-upload";
      this.failUpload(snapshot, "scene-compositor: texture upload failed after context loss");
    }
    // gl.getError() forces a synchronous GPU flush, so on the per-frame upload hot path we only pay it
    // when debug tracing is on — the isContextLost() check above already catches the real failure mode.
    if (!debug) return;
    const error = gl.getError();
    snapshot.glErrorAfter = error;
    this.publishUploadDebug(snapshot);
    if (error === gl.NO_ERROR) return;
    if (error === gl.CONTEXT_LOST_WEBGL || this.isContextLost()) {
      snapshot.reason = "context-lost-after-upload";
      this.failUpload(snapshot, "scene-compositor: texture upload failed after context loss");
    }
    snapshot.reason = error === gl.INVALID_OPERATION ? "invalid-operation-after-upload" : "gl-error-after-upload";
    this.failUpload(snapshot, `scene-compositor: texture upload failed: 0x${error.toString(16)}`);
  }

  debugSnapshot(): SceneCompositorDebugSnapshot {
    const gl = this.gl;
    const viewport = Array.from(gl.getParameter(gl.VIEWPORT) as Int32Array | number[]);
    const scissorBox = Array.from(gl.getParameter(gl.SCISSOR_BOX) as Int32Array | number[]);
    const targets: SceneCompositorDebugSnapshot["targets"] = {
      accumA: this.debugTarget(this.accumA),
      accumB: this.debugTarget(this.accumB),
    };
    if (this.plateRT) targets.plate = this.debugTarget(this.plateRT);
    if (this.scratch1) targets.scratch1 = this.debugTarget(this.scratch1);
    if (this.scratch2) targets.scratch2 = this.debugTarget(this.scratch2);
    if (this.sideA) targets.sideA = this.debugTarget(this.sideA);
    if (this.sideB) targets.sideB = this.debugTarget(this.sideB);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return {
      width: this.width,
      height: this.height,
      canvasWidth: this.canvas.width,
      canvasHeight: this.canvas.height,
      contextLost: gl.isContextLost(),
      viewport,
      scissorBox,
      scissorTest: gl.isEnabled(gl.SCISSOR_TEST),
      lastPresentViewport: this.lastPresentViewport,
      framebufferBinding: gl.getParameter(gl.FRAMEBUFFER_BINDING) ? "bound" : "null",
      texture2dBinding: gl.getParameter(gl.TEXTURE_BINDING_2D) ? "bound" : "null",
      glError: gl.getError(),
      targets,
    };
  }

  constructor(canvas: AnyCanvas, width: number, height: number) {
    this.canvas = canvas;
    this.width = width;
    this.height = height;
    canvas.width = width;
    canvas.height = height;
    const gl = createGl(canvas, { kind: "scene-compositor", label: "scene-compositor" });
    this.gl = gl;
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;

    const vs = compileShader(gl, gl.VERTEX_SHADER, COMPOSITE_VS);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, COMPOSITE_FS);
    const program = gl.createProgram();
    if (!program) throw new Error("scene-compositor: createProgram failed");
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.bindAttribLocation(program, 0, "a_posw");
    gl.bindAttribLocation(program, 1, "a_uv");
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`scene-compositor: link failed: ${gl.getProgramInfoLog(program) ?? "unknown"}`);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    this.program = program;

    const vao = gl.createVertexArray();
    const vbo = gl.createBuffer();
    if (!vao || !vbo) throw new Error("scene-compositor: buffer alloc failed");
    this.vao = vao;
    this.vbo = vbo;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.quad.byteLength, gl.DYNAMIC_DRAW);
    const stride = 5 * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0); // a_posw (ndcX, ndcY, w)
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 3 * 4); // a_uv
    gl.bindVertexArray(null);

    this.emptyTex = this.makeTex();
    gl.bindTexture(gl.TEXTURE_2D, this.emptyTex);
    this.assertContextAlive();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    this.assertUploadSucceeded(
      {
        role: "empty",
        sourceKind: "Uint8Array",
        width: 1,
        height: 1,
        textureState: "new",
        op: "texImage2D",
        contextLostBefore: false,
      },
      sceneGlDebugEnabled(),
    );
    this.accumA = new RenderTarget(gl, width, height);
    this.accumB = new RenderTarget(gl, width, height);

    this.presentProgram = linkProgram(gl, FULLSCREEN_TRI_VS, PRESENT_FS);
    this.presentVao = createFullscreenVao(gl);
    this.uPresentTex = gl.getUniformLocation(this.presentProgram, "uTex");

    // NOTE: the plate/blur/glow/bloom programs are NOT linked here — see ensureEffectPrograms(),
    // called lazily from effectTargets() on the first blur/glow use. Present + the main composite
    // program stay eager (both needed on frame 1).

    this.uSrc = gl.getUniformLocation(program, "uSrc");
    this.uMask = gl.getUniformLocation(program, "uMask");
    this.uDest = gl.getUniformLocation(program, "uDest");
    this.uHasMask = gl.getUniformLocation(program, "uHasMask");
    this.uTrackMatte = gl.getUniformLocation(program, "uTrackMatte");
    this.uHasTrackMatte = gl.getUniformLocation(program, "uHasTrackMatte");
    this.uTrackMatteLuma = gl.getUniformLocation(program, "uTrackMatteLuma");
    this.uTrackMatteInvert = gl.getUniformLocation(program, "uTrackMatteInvert");
    this.uResolution = gl.getUniformLocation(program, "uResolution");
    this.uOpacity = gl.getUniformLocation(program, "uOpacity");
    this.uBlend = gl.getUniformLocation(program, "uBlend");
    this.uFitScale = gl.getUniformLocation(program, "uFitScale");
    this.uContentPan = gl.getUniformLocation(program, "uContentPan");
    this.uCrop = gl.getUniformLocation(program, "uCrop");
  }

  private makeTex(): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture();
    if (!tex) throw new Error("scene-compositor: texture alloc failed");
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return tex;
  }

  private ensureSize(width: number, height: number): void {
    if (this.width === width && this.height === height) return;
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    this.accumA.resize(width, height);
    this.accumB.resize(width, height);
    this.plateRT?.resize(width, height);
    this.scratch1?.resize(width, height);
    this.scratch2?.resize(width, height);
    this.sideA?.resize(width, height);
    this.sideAScratch?.resize(width, height);
    this.sideB?.resize(width, height);
    this.sideBScratch?.resize(width, height);
    this.layerNestA?.resize(width, height);
    this.layerNestB?.resize(width, height);
  }

  /**
   * Link the plate/blur/glow/bloom pass programs (once). Deferred out of the constructor so mounting
   * the compositor doesn't block the main thread on the driver's shader compile — comps that never
   * use blur/glow never pay it. Every effect-program USE is preceded by effectTargets() (it allocates
   * the RTTs those passes draw into), so calling this there is the single guaranteed choke point.
   */
  private ensureEffectPrograms(): void {
    if (this.effectProgramsBuilt) return;
    const gl = this.gl;

    this.plateProgram = linkProgram(gl, FULLSCREEN_TRI_VS, PLATE_FS);
    this.uPlateSrc = gl.getUniformLocation(this.plateProgram, "uSrc");
    this.uPlateMask = gl.getUniformLocation(this.plateProgram, "uMask");
    this.uPlateHasMask = gl.getUniformLocation(this.plateProgram, "uHasMask");
    this.uPlateFitScale = gl.getUniformLocation(this.plateProgram, "uFitScale");
    this.uPlateContentPan = gl.getUniformLocation(this.plateProgram, "uContentPan");
    this.uPlateCrop = gl.getUniformLocation(this.plateProgram, "uCrop");

    this.blurProgram = linkProgram(gl, FULLSCREEN_TRI_VS, BLUR_FS);
    this.uBlurTex = gl.getUniformLocation(this.blurProgram, "uTex");
    this.uBlurStep = gl.getUniformLocation(this.blurProgram, "uStep");
    this.uBlurRadius = gl.getUniformLocation(this.blurProgram, "uRadius");
    this.uBlurSigma = gl.getUniformLocation(this.blurProgram, "uSigma");
    this.uBlurPremultIn = gl.getUniformLocation(this.blurProgram, "uPremultIn");
    this.uBlurUnpremultOut = gl.getUniformLocation(this.blurProgram, "uUnpremultOut");

    this.glowProgram = linkProgram(gl, FULLSCREEN_TRI_VS, GLOW_FS);
    this.uGlowPlate = gl.getUniformLocation(this.glowProgram, "uPlate");
    this.uGlowTex = gl.getUniformLocation(this.glowProgram, "uGlow");
    this.uGlowColor = gl.getUniformLocation(this.glowProgram, "uGlowColor");

    this.bloomBrightProgram = linkProgram(gl, FULLSCREEN_TRI_VS, BLOOM_BRIGHT_FS);
    this.uBloomBrightSrc = gl.getUniformLocation(this.bloomBrightProgram, "uSrc");
    this.uBloomBrightThreshold = gl.getUniformLocation(this.bloomBrightProgram, "uThreshold");
    this.bloomAddProgram = linkProgram(gl, FULLSCREEN_TRI_VS, BLOOM_ADD_FS);
    this.uBloomAddPlate = gl.getUniformLocation(this.bloomAddProgram, "uPlate");
    this.uBloomAddTex = gl.getUniformLocation(this.bloomAddProgram, "uBloom");
    this.uBloomAddTint = gl.getUniformLocation(this.bloomAddProgram, "uTint");
    this.uBloomAddStrength = gl.getUniformLocation(this.bloomAddProgram, "uStrength");

    this.effectProgramsBuilt = true;
  }

  /** Lazily allocate the comp-sized RTTs the blur/glow passes need (pooled across layers/frames). */
  private effectTargets(): { plate: RenderTarget; s1: RenderTarget; s2: RenderTarget } {
    const gl = this.gl;
    this.ensureEffectPrograms(); // programs + targets are always needed together — one choke point
    this.plateRT ??= new RenderTarget(gl, this.width, this.height);
    this.scratch1 ??= new RenderTarget(gl, this.width, this.height);
    this.scratch2 ??= new RenderTarget(gl, this.width, this.height);
    return { plate: this.plateRT, s1: this.scratch1, s2: this.scratch2 };
  }

  /** Per-effect region-grade renderer + output RTT on THIS context (lazy; LUT cached via pipelineKey). */
  private regionGradeEntry(effectKey: string): {
    renderer: MediaWebGLRenderer;
    target: RenderTarget;
    pipelineKey: string;
    lastFrame: number;
  } {
    let entry = this.regionGradeRenderers.get(effectKey);
    if (!entry) {
      entry = {
        renderer: new MediaWebGLRenderer({ sharedGl: this.gl }, { label: `scene-region-grade:${effectKey}` }),
        target: new RenderTarget(this.gl, Math.max(1, this.width), Math.max(1, this.height)),
        pipelineKey: "",
        lastFrame: this.frameCounter,
      };
      this.regionGradeRenderers.set(effectKey, entry);
    }
    return entry;
  }

  /** Drop grade renderers whose pass hasn't drawn recently (grade removed / clip left the window). */
  private pruneRegionGradeRenderers(): void {
    if (this.regionGradeRenderers.size === 0) return;
    for (const [key, entry] of this.regionGradeRenderers) {
      if (this.frameCounter - entry.lastFrame > 300) {
        entry.renderer.dispose();
        entry.target.dispose();
        this.regionGradeRenderers.delete(key);
      }
    }
  }

  /** Lazily allocate the two per-side ping-pong PAIRS a folded transition pre-composes each clip nest into. */
  private transitionTargets(): { sideA: RenderTarget; sideAScratch: RenderTarget; sideB: RenderTarget; sideBScratch: RenderTarget } {
    const gl = this.gl;
    this.sideAScratch ??= new RenderTarget(gl, this.width, this.height);
    this.sideBScratch ??= new RenderTarget(gl, this.width, this.height);
    this.sideA ??= new RenderTarget(gl, this.width, this.height);
    this.sideB ??= new RenderTarget(gl, this.width, this.height);
    return { sideA: this.sideA, sideAScratch: this.sideAScratch, sideB: this.sideB, sideBScratch: this.sideBScratch };
  }

  /**
   * Pre-warm (compile + cache) transition programs ahead of playback so the first frame of a cut
   * doesn't pay a 10–50ms shader-compile stall on the main thread. Idempotent; safe to call from
   * requestIdleCallback with every transition kind the composition uses.
   */
  prewarmTransitions(defs: readonly TransitionDefinition[]): void {
    for (const def of defs) {
      try {
        this.prepareTransition(def);
      } catch {
        // A single bad definition (e.g. plugin shader) must not break pre-warm for the rest.
      }
    }
  }

  /** Compile + cache the program(s) for a transition definition (the same shaders TransitionCompositor uses).
   *  A definition with a `pipeline` compiles one program PER PASS (assembled by `PipelineAssembler` — the
   *  same assembled GLSL every renderer compiles, so multi-pass transitions keep pixel parity). */
  private prepareTransition(def: TransitionDefinition): CompiledTransition {
    const existing = this.transitionPrograms.get(def.id);
    if (existing) return existing;
    const gl = this.gl;
    if (def.pipeline && def.pipeline.passes.length > 0) {
      // Every pass declares the def's params as uniforms too, so a pass can read them by name.
      const paramDecls = def.params.map((p) => `${GLSL_PARAM_TYPE[p.type]} ${p.name}`);
      const pipelinePasses: CompiledPipelinePass[] = def.pipeline.passes.map((pass) => {
        const program = linkProgram(gl, FULLSCREEN_TRI_VS, PipelineAssembler.assemblePassShader(pass.moduleId, paramDecls));
        const extraNames = new Set<string>([...def.params.map((p) => p.name), ...Object.keys(pass.params ?? {})]);
        return {
          program,
          uSrc: gl.getUniformLocation(program, "uSrc"),
          uFrom: gl.getUniformLocation(program, "uFrom"),
          uTo: gl.getUniformLocation(program, "uTo"),
          uProgress: gl.getUniformLocation(program, "progress"),
          uResolution: gl.getUniformLocation(program, "resolution"),
          uRatio: gl.getUniformLocation(program, "ratio"),
          uFromFit: gl.getUniformLocation(program, "uFromFit"),
          uToFit: gl.getUniformLocation(program, "uToFit"),
          extra: [...extraNames].map((name) => ({ name, location: gl.getUniformLocation(program, name) })),
          passParams: pass.params ?? {},
        };
      });
      const compiled: CompiledTransition = {
        program: null,
        uFrom: null,
        uTo: null,
        uProgress: null,
        uResolution: null,
        uRatio: null,
        uFromFit: null,
        uToFit: null,
        params: [],
        pipelinePasses,
      };
      this.transitionPrograms.set(def.id, compiled);
      return compiled;
    }
    // FULLSCREEN_TRI_VS produces the same `v_uv` (a_position*0.5+0.5) the transition FS expects, and
    // linkProgram binds a_position→0 (matching presentVao) — so the mix reuses the present triangle.
    const program = linkProgram(gl, FULLSCREEN_TRI_VS, buildTransitionFragmentShader(def));
    const compiled: CompiledTransition = {
      program,
      uFrom: gl.getUniformLocation(program, "uFrom"),
      uTo: gl.getUniformLocation(program, "uTo"),
      uProgress: gl.getUniformLocation(program, "progress"),
      uResolution: gl.getUniformLocation(program, "resolution"),
      uRatio: gl.getUniformLocation(program, "ratio"),
      uFromFit: gl.getUniformLocation(program, "uFromFit"),
      uToFit: gl.getUniformLocation(program, "uToFit"),
      params: def.params.map((param) => ({ param, location: gl.getUniformLocation(program, param.name) })),
      pipelinePasses: null,
    };
    this.transitionPrograms.set(def.id, compiled);
    return compiled;
  }

  /** Compile + cache the program for a fragment-effect definition. Throws on GLSL compile/link failure. */
  private prepareFragmentEffect(def: FragmentEffectDefinition): CompiledFragmentEffect {
    const existing = this.fragmentPrograms.get(def.id);
    if (existing) {
      existing.lastFrame = this.frameCounter;
      return existing;
    }
    const gl = this.gl;
    const program = linkProgram(gl, FULLSCREEN_TRI_VS, buildFragmentEffectShader(def));
    const compiled: CompiledFragmentEffect = {
      program,
      uSrc: gl.getUniformLocation(program, "uSrc"),
      uResolution: gl.getUniformLocation(program, "uResolution"),
      uIntensity: gl.getUniformLocation(program, "uIntensity"),
      uTime: gl.getUniformLocation(program, "uTime"),
      params: def.params.map((param) => ({ param, location: gl.getUniformLocation(program, param.name) })),
      lastFrame: this.frameCounter,
    };
    this.fragmentPrograms.set(def.id, compiled);
    return compiled;
  }

  /**
   * Run one fragment-effect pass: `srcTex` (the layer's running nest image) → `dstRT` (comp-sized).
   * Returns false (no-op, base image preserved) if the def fails to compile — never black-frames.
   */
  private runFragmentPass(srcTex: WebGLTexture, pass: SceneFragmentPass, dstRT: RenderTarget): boolean {
    const gl = this.gl;
    let compiled: CompiledFragmentEffect;
    try {
      compiled = this.prepareFragmentEffect(pass.def);
    } catch (error) {
      if (!this.fragmentCompileFailureWarnings.has(pass.def.id)) {
        this.fragmentCompileFailureWarnings.add(pass.def.id);
        console.warn(`SceneCompositor: fragment effect "${pass.def.id}" failed to compile; skipping pass.`, error);
      }
      return false;
    }
    const resolved = resolveFragmentEffectParams(pass.def, pass.params);
    gl.bindFramebuffer(gl.FRAMEBUFFER, dstRT.fbo);
    gl.viewport(0, 0, this.width, this.height);
    gl.useProgram(compiled.program);
    gl.bindVertexArray(this.presentVao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform1i(compiled.uSrc, 0);
    gl.uniform2f(compiled.uResolution, this.width, this.height);
    gl.uniform1f(compiled.uIntensity, Math.max(0, Math.min(1, pass.intensity)));
    gl.uniform1f(compiled.uTime, pass.timeSeconds);
    for (const { param, location } of compiled.params) {
      if (!location) continue;
      const value = resolved[param.name];
      if (param.type === "float") gl.uniform1f(location, typeof value === "number" ? value : 0);
      else if (param.type === "bool") gl.uniform1i(location, value ? 1 : 0);
      else if (param.type === "vec2" && Array.isArray(value)) gl.uniform2f(location, value[0] ?? 0, value[1] ?? 0);
      else if (param.type === "vec3" && Array.isArray(value)) gl.uniform3f(location, value[0] ?? 0, value[1] ?? 0, value[2] ?? 0);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return true;
  }

  /** Drop fragment-effect programs whose def hasn't drawn recently (mirrors pruneRegionGradeRenderers). */
  private pruneFragmentPrograms(): void {
    if (this.fragmentPrograms.size === 0) return;
    const gl = this.gl;
    for (const [key, entry] of this.fragmentPrograms) {
      if (this.frameCounter - entry.lastFrame > 300) {
        gl.deleteProgram(entry.program);
        this.fragmentPrograms.delete(key);
      }
    }
  }

  /**
   * Mix two already-rendered side textures (`fromTex`/`toTex`, comp-sized, each a full clip incl. effects)
   * with the transition shader into `target`. The sides are comp-pre-fitted, so uFromFit/uToFit = (1,1).
   */
  private drawTransition(
    def: TransitionDefinition,
    fromTex: WebGLTexture,
    toTex: WebGLTexture,
    progress: number,
    params: Record<string, number | number[] | boolean> | undefined,
    target: RenderTarget,
  ): void {
    const gl = this.gl;
    const w = this.width;
    const h = this.height;
    const compiled = this.prepareTransition(def);
    const resolved = resolveTransitionParams(def, params);
    if (compiled.pipelinePasses) {
      this.drawTransitionPipeline(compiled.pipelinePasses, fromTex, toTex, progress, resolved, target);
      return;
    }
    if (!compiled.program) return; // defensive: a def with neither glsl nor pipeline
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(compiled.program);
    gl.bindVertexArray(this.presentVao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, fromTex);
    gl.uniform1i(compiled.uFrom, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, toTex);
    gl.uniform1i(compiled.uTo, 1);
    gl.uniform1f(compiled.uProgress, Math.max(0, Math.min(1, progress)));
    gl.uniform2f(compiled.uResolution, w, h);
    gl.uniform1f(compiled.uRatio, h > 0 ? w / h : 1);
    gl.uniform2f(compiled.uFromFit, 1, 1);
    gl.uniform2f(compiled.uToFit, 1, 1);
    for (const { param, location } of compiled.params) {
      if (!location) continue;
      const value = resolved[param.name];
      switch (param.type) {
        case "float":
          gl.uniform1f(location, typeof value === "number" ? value : Number(value) || 0);
          break;
        case "bool":
          gl.uniform1i(location, value ? 1 : 0);
          break;
        case "vec2": {
          const v = Array.isArray(value) ? value : [0, 0];
          gl.uniform2f(location, v[0] ?? 0, v[1] ?? 0);
          break;
        }
        case "vec3": {
          const v = Array.isArray(value) ? value : [0, 0, 0];
          gl.uniform3f(location, v[0] ?? 0, v[1] ?? 0, v[2] ?? 0);
          break;
        }
      }
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  /**
   * Execute a multi-pass transition pipeline: passes chain through a ping-pong pair (`scratch1`/`scratch2`
   * from the pooled effect targets), each reading the previous pass's output as `uSrc` (pass 0 reads the
   * outgoing side) plus the raw `uFrom`/`uTo` sides, and the LAST pass renders directly into `target`.
   * Uniforms per pass: the standard transition set + the def's resolved params + the pass's own static
   * `params` overrides (pass params win). Sides are comp-pre-fitted, so uFromFit/uToFit = (1,1).
   */
  private drawTransitionPipeline(
    passes: CompiledPipelinePass[],
    fromTex: WebGLTexture,
    toTex: WebGLTexture,
    progress: number,
    resolved: Record<string, number | number[] | boolean>,
    target: RenderTarget,
  ): void {
    const gl = this.gl;
    const w = this.width;
    const h = this.height;
    // Ping-pong intermediates. plate is NOT used — renderTransition mixes INTO plate, so it's the target.
    const { s1, s2 } = this.effectTargets();
    let srcTex = fromTex; // pass 0's "previous output" is the outgoing side
    for (let i = 0; i < passes.length; i++) {
      const pass = passes[i]!;
      const isLast = i === passes.length - 1;
      const dst = isLast ? target : i % 2 === 0 ? s1 : s2;
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(pass.program);
      gl.bindVertexArray(this.presentVao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, srcTex);
      gl.uniform1i(pass.uSrc, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, fromTex);
      gl.uniform1i(pass.uFrom, 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, toTex);
      gl.uniform1i(pass.uTo, 2);
      gl.uniform1f(pass.uProgress, Math.max(0, Math.min(1, progress)));
      gl.uniform2f(pass.uResolution, w, h);
      gl.uniform1f(pass.uRatio, h > 0 ? w / h : 1);
      gl.uniform2f(pass.uFromFit, 1, 1);
      gl.uniform2f(pass.uToFit, 1, 1);
      for (const { name, location } of pass.extra) {
        if (!location) continue;
        const value = pass.passParams[name] !== undefined ? pass.passParams[name] : resolved[name];
        if (value === undefined) continue;
        setUniformByValue(gl, location, value as number | number[] | boolean);
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      srcTex = dst.tex;
    }
    gl.bindVertexArray(null);
  }

  /**
   * Compute the 6 transformed quad vertices (NDC + projective w + uv) for a layer.
   *
   * The CSS-matched 3D-tilt projection: scale → rotateY → rotateX → rotateZ about the layer center, then
   * the CSS translate(-50%,-50%,z) term inside perspective() (using the ELEMENT-box half-extents), then
   * the homogeneous divide. With `rotateX=rotateY=0, perspective=0` and box = comp/2 this reduces
   * EXACTLY to the previous 2D affine quad (w=1, the translate term cancels) — the parity guard.
   */
  private writeQuad(
    t: SceneLayerTransform,
    halfW: number,
    halfH: number,
    rotateX: number,
    rotateY: number,
    perspective: number,
    z: number,
  ): void {
    const w = this.width;
    const h = this.height;
    const cx = (t.x / 100) * w;
    const cy = (t.y / 100) * h;
    const s = t.scale;
    const cyR = Math.cos(rotateY * DEG);
    const syR = Math.sin(rotateY * DEG);
    const cxR = Math.cos(rotateX * DEG);
    const sxR = Math.sin(rotateX * DEG);
    const czR = Math.cos(t.rotation * DEG);
    const szR = Math.sin(t.rotation * DEG);
    const q = this.quad;
    let n = 0;
    // Emit one corner: element-local offset (lx,ly) → 3D rotate → perspective divide → NDC, with uv.
    const put = (lx: number, ly: number, u: number, v: number) => {
      let x = lx * s;
      let y = ly * s;
      let zz = 0;
      // rotateY (about Y), then rotateX (about X), then rotateZ (in-plane) — CSS Rz·Rx·Ry·S order.
      let nx = cyR * x + syR * zz;
      let nz = -syR * x + cyR * zz;
      x = nx; zz = nz;
      const ny2 = cxR * y - sxR * zz;
      nz = sxR * y + cxR * zz;
      y = ny2; zz = nz;
      nx = czR * x - szR * y;
      const ny3 = szR * x + czR * y;
      x = nx; y = ny3;
      // CSS translate3d(-50%,-50%,z) inside perspective(), origin (box center) added back after divide.
      const tx = x - halfW;
      const ty = y - halfH;
      const tz = zz + z;
      const pw = perspective > 0 ? Math.max(1 - tz / perspective, 0.01) : 1;
      const screenX = cx + halfW + tx / pw;
      const screenY = cy + halfH + ty / pw;
      q[n] = (screenX / w) * 2 - 1;
      q[n + 1] = 1 - (screenY / h) * 2;
      q[n + 2] = pw;
      q[n + 3] = u;
      q[n + 4] = v;
      n += 5;
    };
    // Visual corners with uv (bottom-left origin: top row v=1). Tri1: TL,TR,BR — Tri2: TL,BR,BL.
    put(-halfW, -halfH, 0, 1); // TL
    put(halfW, -halfH, 1, 1); // TR
    put(halfW, halfH, 1, 0); // BR
    put(-halfW, -halfH, 0, 1); // TL
    put(halfW, halfH, 1, 0); // BR
    put(-halfW, halfH, 0, 0); // BL
  }

  /**
   * Upload (or reuse) a straight-alpha source into its cached GPU texture, flipped, no premultiply.
   * Reuses storage via `texSubImage2D` when the size is unchanged (no realloc → no driver churn), and
   * skips the upload entirely when `version` matches the last upload (static text/shape rasters).
   */
  private uploadSource(source: TexImageSource, version: number | undefined, meta: UploadDebugMeta): WebGLTexture {
    const gl = this.gl;
    const debug = sceneGlDebugEnabled();
    // Hard guard: a lost context is permanent — bail BEFORE touching it (no INVALID_OPERATION spam).
    this.assertContextAlive();

    const [sw, sh] = srcDims(source);
    const kind = sourceKind(source);

    // Guard: a source with no pixels (e.g. a <video> that hasn't decoded its first frame yet) would
    // make texImage2D throw/INVALID_OPERATION. Skip safely — the layer draws transparent this frame and
    // the settle window recomposites once the real frame lands.
    if (sw <= 0 || sh <= 0) {
      this.warnUploadFallback({ ...meta, sourceKind: kind, width: sw, height: sh, textureState: "new", contextLostBefore: false, reason: "zero-dimensions" });
      return this.emptyTex;
    }
    // Guard: a source larger than the GPU's max texture size can't be uploaded (INVALID_VALUE). Skip
    // safely with a controlled, deduped warning rather than letting the driver error every frame.
    if (sw > this.maxTextureSize || sh > this.maxTextureSize) {
      this.warnUploadFallback({ ...meta, sourceKind: kind, width: sw, height: sh, textureState: "new", contextLostBefore: false, reason: "exceeds-max-texture-size" });
      return this.emptyTex;
    }

    let entry = this.srcTextures.get(source);
    const producer = getTexImageSourceProducerInfo(source);
    if (producer?.disposed || producer?.contextLost) {
      this.warnUploadFallback({
        ...meta,
        sourceKind: kind,
        width: sw,
        height: sh,
        textureState: entry ? "existing" : "new",
        contextLostBefore: false,
        producer: {
          label: producer.label,
          disposed: producer.disposed,
          contextLost: producer.contextLost,
          width: producer.width,
          height: producer.height,
        },
        reason: producer.contextLost ? "producer-context-lost" : "producer-disposed",
      });
      return entry?.tex ?? this.emptyTex;
    }
    const needAlloc = !entry || entry.w !== sw || entry.h !== sh;
    const textureState: UploadDebugSnapshot["textureState"] = !entry ? "new" : needAlloc ? "resize" : "existing";
    if (!entry) {
      entry = { tex: this.makeTex(), w: sw, h: sh, version: Number.NaN, lastFrame: this.frameCounter };
      this.srcTextures.set(source, entry);
    }
    entry.lastFrame = this.frameCounter;
    // Unchanged content (a versioned source whose version + size match the last upload) → reuse as-is.
    if (version !== undefined && !needAlloc && entry.version === version) {
      if (debug) this.publishUploadDebug({ ...meta, sourceKind: kind, width: sw, height: sh, textureState: "existing", contextLostBefore: false, reason: "reused-unchanged" });
      return entry.tex;
    }

    const snapshot: UploadDebugSnapshot = {
      ...meta,
      sourceKind: kind,
      width: sw,
      height: sh,
      textureState,
      op: needAlloc ? "texImage2D" : "texSubImage2D",
      contextLostBefore: false,
      producer: producer
        ? {
            label: producer.label,
            disposed: producer.disposed,
            contextLost: producer.contextLost,
            width: producer.width,
            height: producer.height,
          }
        : undefined,
    };

    gl.bindTexture(gl.TEXTURE_2D, entry.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    try {
      if (needAlloc) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
        entry.w = sw;
        entry.h = sh;
      } else {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
      }
    } catch (err) {
      // texImage2D/texSubImage2D can THROW (e.g. a security error, or a lost-context upload in some
      // engines). A lost-context throw becomes SCENE_COMPOSITOR_CONTEXT_LOST (caller falls back to DOM);
      // anything else surfaces as a descriptive upload error.
      snapshot.reason = this.isContextLost() || (err instanceof Error && /CONTEXT_LOST/i.test(err.message)) ? "context-lost" : "upload-threw";
      this.failUpload(snapshot, `scene-compositor: texture upload threw: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.assertUploadSucceeded(snapshot, debug);
    entry.version = version ?? Number.NaN;
    return entry.tex;
  }

  /** Free cached textures for sources not seen for a while (e.g. a layer that left the comp). */
  private pruneTextures(): void {
    const gl = this.gl;
    for (const [source, entry] of this.srcTextures) {
      if (this.frameCounter - entry.lastFrame > 120) {
        gl.deleteTexture(entry.tex);
        this.srcTextures.delete(source);
      }
    }
  }

  /** Bind `target` and run a fullscreen-triangle pass with the currently-bound program. */
  private fullscreenPass(target: RenderTarget): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, this.width, this.height);
    gl.bindVertexArray(this.presentVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Separable Gaussian blur of `src` into `dst` (via `scratch`), σ = sigma px, premultiplied. */
  private gaussianBlur(src: RenderTarget, dst: RenderTarget, scratch: RenderTarget, sigma: number): void {
    const gl = this.gl;
    const radius = Math.min(MAX_BLUR_RADIUS, Math.max(1, Math.ceil(sigma * 3)));
    gl.useProgram(this.blurProgram);
    gl.uniform1i(this.uBlurTex, 0);
    gl.uniform1i(this.uBlurRadius, radius);
    gl.uniform1f(this.uBlurSigma, sigma);
    // Horizontal: straight → premultiplied, src → scratch.
    gl.uniform2f(this.uBlurStep, 1 / this.width, 0);
    gl.uniform1i(this.uBlurPremultIn, 1);
    gl.uniform1i(this.uBlurUnpremultOut, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    this.fullscreenPass(scratch);
    // Vertical: premultiplied → straight, scratch → dst.
    gl.uniform2f(this.uBlurStep, 0, 1 / this.height);
    gl.uniform1i(this.uBlurPremultIn, 0);
    gl.uniform1i(this.uBlurUnpremultOut, 1);
    gl.bindTexture(gl.TEXTURE_2D, scratch.tex);
    this.fullscreenPass(dst);
  }

  /**
   * Composite `tex` with the layer transform + blend. Default (`dest=null`): into the main accumulator,
   * reading accumA as backdrop (ping-pong A↔B). `dest` set: into that RTT reading TRANSPARENT (the
   * `emptyTex`) as backdrop and NO ping-pong — used to render ONE clip in isolation over transparent for a
   * transition side. The caller must pre-clear `dest`; areas the quad doesn't cover keep its cleared value.
   */
  private compositeTexture(
    tex: WebGLTexture,
    maskTex: WebGLTexture | null,
    fitVec: [number, number],
    hasMask: boolean,
    opacity: number,
    blend: BlendMode,
    transform: SceneLayerTransform,
    geom: { halfW: number; halfH: number; rotateX: number; rotateY: number; perspective: number; z: number },
    contentPan: [number, number] = [0, 0],
    crop: [number, number, number, number] = [0, 0, 0, 0],
    dest: RenderTarget | null = null,
    trackMatte: { tex: WebGLTexture; luma: boolean; invert: boolean } | null = null,
  ): void {
    const gl = this.gl;
    const w = this.width;
    const h = this.height;
    if (!dest) {
      // Main accumulator: copy A → B so areas the quad doesn't cover keep the backdrop, then draw into B
      // reading A as uDest.
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.accumA.fbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.accumB.fbo);
      gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.accumB.fbo);
    } else {
      // Side target: draw straight into it; uDest = transparent (emptyTex) so there's no read/write feedback.
      gl.bindFramebuffer(gl.FRAMEBUFFER, dest.fbo);
    }
    gl.viewport(0, 0, w, h);

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(this.uSrc, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, hasMask && maskTex ? maskTex : this.emptyTex);
    gl.uniform1i(this.uMask, 1);
    gl.uniform1i(this.uHasMask, hasMask ? 1 : 0);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, trackMatte ? trackMatte.tex : this.emptyTex);
    gl.uniform1i(this.uTrackMatte, 3);
    gl.uniform1i(this.uHasTrackMatte, trackMatte ? 1 : 0);
    gl.uniform1i(this.uTrackMatteLuma, trackMatte?.luma ? 1 : 0);
    gl.uniform1i(this.uTrackMatteInvert, trackMatte?.invert ? 1 : 0);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, dest ? this.emptyTex : this.accumA.tex);
    gl.uniform1i(this.uDest, 2);
    gl.uniform2f(this.uResolution, w, h);
    gl.uniform1f(this.uOpacity, Math.max(0, Math.min(1, opacity)));
    gl.uniform1i(this.uBlend, blendModeIndex(blend));
    gl.uniform2f(this.uFitScale, fitVec[0], fitVec[1]);
    gl.uniform2f(this.uContentPan, contentPan[0], contentPan[1]);
    gl.uniform4f(this.uCrop, crop[0], crop[1], crop[2], crop[3]);

    this.writeQuad(transform, geom.halfW, geom.halfH, geom.rotateX, geom.rotateY, geom.perspective, geom.z);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.quad);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    if (!dest) {
      const tmp = this.accumA;
      this.accumA = this.accumB;
      this.accumB = tmp;
    }
  }

  /**
   * Render ONE layer (object-fit + content + blur + glow + mask + transform + blend). `dest=null` composites
   * into the main accumulator (the normal path). A `dest` RTT renders the clip ALONE over transparent (forced
   * normal blend) — used to build a transition side so every per-clip effect is present during the transition.
   */
  private renderLayerInto(layer: SceneLayerDraw, dest: RenderTarget | null): void {
    // Track matte (D1) resolves FIRST — into its own depth-indexed RTT, so it survives whatever the
    // layer's own render uses (plate/scratch/nest pairs) — and applies ONCE at the final composite
    // (after blur/glow/region/fragment passes, the AE order), alongside the clip mask.
    const trackMatte = layer.matteFrom ? this.buildTrackMatte(layer.matteFrom) : null;
    if ((layer.regionPasses && layer.regionPasses.length > 0) || (layer.fragmentPasses && layer.fragmentPasses.length > 0)) {
      this.renderLayerWithRegionPasses(layer, dest, trackMatte);
      return;
    }
    const gl = this.gl;
    const w = this.width;
    const h = this.height;
    const sw = layer.sourceWidth;
    const sh = layer.sourceHeight;
    if (sw <= 0 || sh <= 0) return;

    const hasMask = Boolean(layer.mask);
    const blurPx = layer.blurPx ?? 0;
    const glow = layer.glow ?? null;
    const opacity = layer.transform.opacity / 100;
    // Within a pre-composed nest (or the isolated `dest` path), layers composite NORMAL — the clip's own blend
    // mode applies when the MIXED transition result lands on the main scene, not between the clip's own layers.
    // The ordinary main-scene path keeps the layer's blend mode.
    const blend: BlendMode = dest || this.nestMode ? "normal" : layer.blendMode;
    // Composite geometry: element box (default = comp) + 3D tilt (default = none → 2D affine quad).
    const geom = {
      halfW: layer.box ? layer.box.halfW : w / 2,
      halfH: layer.box ? layer.box.halfH : h / 2,
      rotateX: layer.rotateX ?? 0,
      rotateY: layer.rotateY ?? 0,
      perspective: layer.perspective ?? 0,
      z: layer.z ?? 0,
    };

    // Source: a same-context texture is sampled DIRECTLY (no upload — the single-context export path); any
    // other source uploads via the per-source cache (texSubImage2D / skip-unchanged, no realloc). The mask
    // matte stays a 2D canvas (CPU raster) → always the upload path.
    const srcTex = isSceneTextureSource(layer.source)
      ? layer.source.texture
      : this.uploadSource(layer.source, layer.sourceVersion, { layerId: layer.debugLayerId, role: "source", frameTime: this.debugFrameTime });
    const maskTex = layer.mask
      ? this.uploadSource(layer.mask, layer.maskVersion, { layerId: layer.debugLayerId, role: "mask", frameTime: this.debugFrameTime })
      : null;

    // Content transform (media only): zoom folds into the object-fit (smaller sampled window), pan shifts
    // the window, crop trims the frame edges. Identity (no `content`) → unchanged object-fit.
    const content = layer.content ?? null;
    const baseFit = fitScale(sw, sh, w, h, layer.fit);
    const fitVec: [number, number] = content ? [baseFit[0] / content.scale, baseFit[1] / content.scale] : baseFit;
    const contentPan: [number, number] = content ? content.pan : [0, 0];
    const crop: [number, number, number, number] = content ? content.crop : [0, 0, 0, 0];

    if (blurPx <= 0 && !glow) {
      // Fast path (Phase 1): object-fit + content pan/zoom/crop + mask + transform + blend in one draw.
      this.compositeTexture(srcTex, maskTex, fitVec, hasMask, opacity, blend, layer.transform, geom, contentPan, crop, dest, trackMatte);
      return;
    }

    // Effect path: build a comp-sized plate (object-fit ONLY — NO mask), run blur/glow on it, then
    // composite the plate (fill) applying the mask AFTER the effects. CSS order is filter → clip →
    // mask, so the blur/glow must NOT be clipped to the mask before they run — masking first would
    // let the blur bleed the masked edge outward (the corner/halo leak). Masking in the composite
    // (COMPOSITE_FS samples uMask at v_uv) clips the blurred result to a sharp edge, matching DOM/export.
    const { plate, s1, s2 } = this.effectTargets();
    gl.useProgram(this.plateProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform1i(this.uPlateSrc, 0);
    gl.uniform1i(this.uPlateHasMask, 0); // mask is applied later, in the composite
    gl.uniform2f(this.uPlateFitScale, fitVec[0], fitVec[1]);
    gl.uniform2f(this.uPlateContentPan, contentPan[0], contentPan[1]);
    gl.uniform4f(this.uPlateCrop, crop[0], crop[1], crop[2], crop[3]);
    this.fullscreenPass(plate);

    if (blurPx > 0) this.gaussianBlur(plate, plate, s1, blurPx); // in-place via s1

    if (glow && glow.mode === "highlights") {
      // Highlight bloom (footage): brightpass the plate → s2, blur it, then ADD it back tinted. Reuses the
      // plate/s1/s2 targets (no extra RTT). On opaque footage this blooms bright areas; on alpha content it
      // also blooms bright pixels, complementing the edge mode.
      gl.useProgram(this.bloomBrightProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, plate.tex);
      gl.uniform1i(this.uBloomBrightSrc, 0);
      gl.uniform1f(this.uBloomBrightThreshold, glow.threshold ?? 0.55);
      this.fullscreenPass(s2); // s2 = bright pixels (straight alpha, weight in .a)
      this.gaussianBlur(s2, s2, s1, glow.radiusPx); // spread the bright energy (in-place via s1)
      gl.useProgram(this.bloomAddProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, plate.tex);
      gl.uniform1i(this.uBloomAddPlate, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, s2.tex);
      gl.uniform1i(this.uBloomAddTex, 1);
      gl.uniform3f(this.uBloomAddTint, glow.color[0], glow.color[1], glow.color[2]);
      gl.uniform1f(this.uBloomAddStrength, glow.strength ?? 1);
      this.fullscreenPass(s1); // bloom result → s1 (can't read+write plate)
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, s1.fbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, plate.fbo);
      gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    } else if (glow) {
      // Edge glow (text/cutouts): blurred silhouette of the (already blurred) plate by the radius → s2.
      this.gaussianBlur(plate, s2, s1, glow.radiusPx);
      gl.useProgram(this.glowProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, plate.tex);
      gl.uniform1i(this.uGlowPlate, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, s2.tex);
      gl.uniform1i(this.uGlowTex, 1);
      gl.uniform3f(this.uGlowColor, glow.color[0], glow.color[1], glow.color[2]);
      this.fullscreenPass(s1); // glow result → s1 (can't read+write plate)
      // Copy s1 → plate.
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, s1.fbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, plate.fbo);
      gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    }

    // Composite the (blurred/glowed) plate with the mask applied here — sharp clip, no edge bleed.
    // The plate is comp-sized, so the composite quad uses the comp box (+ any 3D tilt from `geom`).
    this.compositeTexture(
      plate.tex,
      maskTex,
      [1, 1],
      hasMask,
      opacity,
      blend,
      layer.transform,
      { ...geom, halfW: w / 2, halfH: h / 2 },
      [0, 0],
      [0, 0, 0, 0],
      dest,
      trackMatte,
    );
  }

  /**
   * Render a layer whose region effects are PASSES (the AE model, flag-gated): pre-compose the layer into its
   * own nest — base draw first (full transform + clip mask, NORMAL blend at full opacity), then each pass
   * applied to the RUNNING nest image masked to its region — and composite the finished nest ONCE with the
   * layer's opacity/blend. A blur pass blurs the running image (so it combines with the base grade and earlier
   * passes — the fix the flat `__rfx_` clone-stack model could never express); a source pass composites its
   * region-graded image masked (today's clone draw, isolated to this layer's nest). The nest uses a DEDICATED
   * ping-pong pair because a regioned layer can render inside a transition side, whose pair is busy.
   */
  private renderLayerWithRegionPasses(
    layer: SceneLayerDraw,
    dest: RenderTarget | null,
    trackMatte: { tex: WebGLTexture; luma: boolean; invert: boolean } | null = null,
  ): void {
    const gl = this.gl;
    const passes = layer.regionPasses ?? [];
    const fragmentPasses = layer.fragmentPasses ?? [];
    this.layerNestA ??= new RenderTarget(gl, this.width, this.height);
    this.layerNestB ??= new RenderTarget(gl, this.width, this.height);
    const savedA = this.accumA;
    const savedB = this.accumB;
    const savedNest = this.nestMode;
    this.accumA = this.layerNestA;
    this.accumB = this.layerNestB;
    this.nestMode = true;
    for (const rt of [this.layerNestA, this.layerNestB]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, rt.fbo);
      gl.viewport(0, 0, this.width, this.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    // Base image: the layer without its passes. Opacity/blend are deferred to the final nest composite —
    // inside the nest everything is NORMAL at full opacity (nestMode), the precompose model.
    this.renderLayerInto(
      // `matteFrom` is stripped too — the caller (renderLayerInto) already resolved it into
      // `trackMatte`, applied ONCE at the final nest composite below; leaving it here would render
      // and apply the matte twice.
      { ...layer, regionPasses: undefined, fragmentPasses: undefined, matteFrom: undefined, transform: { ...layer.transform, opacity: 100 } },
      null,
    );
    for (const pass of passes) {
      // Each pass builds its effected frame (blurred / graded RUNNING nest image) into a comp-sized RTT,
      // then composites it back masked — the masked mix IS the ordinary compositeTexture, ping-ponging the
      // nest accumulator.
      let fxTex: WebGLTexture | null = null;
      if (pass.pipeline && !pass.pipeline.identity) {
        // Region color: grade the running nest image with this ONE effect's pipeline, in this same context.
        const entry = this.regionGradeEntry(pass.effectKey);
        const key = JSON.stringify(pass.pipeline);
        if (entry.pipelineKey !== key) {
          entry.renderer.setPipeline(pass.pipeline);
          entry.pipelineKey = key;
        }
        entry.lastFrame = this.frameCounter;
        entry.renderer.draw({
          sourceTexture: this.accumA.tex,
          sourceWidth: this.width,
          sourceHeight: this.height,
          matte: null,
          pipeline: pass.pipeline,
          amount: 1,
          opacity: 1,
          mediaEffects: null,
          target: entry.target,
        });
        fxTex = entry.target.tex;
      } else if ((pass.blurPx ?? 0) > 0) {
        // Region blur: gaussian the running nest image.
        const { s1, s2 } = this.effectTargets();
        this.gaussianBlur(this.accumA, s2, s1, pass.blurPx!);
        fxTex = s2.tex;
      }
      if (!fxTex) continue;
      const maskTex = this.uploadSource(pass.mask, pass.maskVersion, {
        layerId: layer.debugLayerId,
        role: "mask",
        frameTime: this.debugFrameTime,
      });
      this.compositeTexture(
        fxTex,
        maskTex,
        [1, 1],
        true,
        1,
        "normal",
        { x: 50, y: 50, scale: 1, rotation: 0, opacity: 100 },
        { halfW: this.width / 2, halfH: this.height / 2, rotateX: 0, rotateY: 0, perspective: 0, z: 0 },
      );
    }
    // Plugin fragment-shader passes run AFTER region passes, inside the SAME nest (risk #1: never a
    // second nest, or the layer's opacity/blend gets applied twice). A compile failure just skips the
    // pass (runFragmentPass returns false) — the running nest image is left untouched.
    for (const pass of fragmentPasses) {
      const { s2 } = this.effectTargets();
      const ok = this.runFragmentPass(this.accumA.tex, pass, s2);
      if (!ok) continue;
      const maskTex = pass.mask
        ? this.uploadSource(pass.mask, pass.maskVersion, {
            layerId: layer.debugLayerId,
            role: "mask",
            frameTime: this.debugFrameTime,
          })
        : null;
      this.compositeTexture(
        s2.tex,
        maskTex,
        [1, 1],
        Boolean(maskTex),
        1,
        "normal",
        { x: 50, y: 50, scale: 1, rotation: 0, opacity: 100 },
        { halfW: this.width / 2, halfH: this.height / 2, rotateX: 0, rotateY: 0, perspective: 0, z: 0 },
      );
    }
    const nestResult = this.accumA;
    this.accumA = savedA;
    this.accumB = savedB;
    this.nestMode = savedNest;
    // Composite the finished nest once, at the layer's opacity/blend (forced NORMAL inside an outer nest —
    // same rule as every draw). The track matte (if any) applies here — after every pass, the AE order.
    this.compositeTexture(
      nestResult.tex,
      null,
      [1, 1],
      false,
      Math.max(0, Math.min(1, layer.transform.opacity / 100)),
      dest || this.nestMode ? "normal" : layer.blendMode,
      { x: 50, y: 50, scale: 1, rotation: 0, opacity: 100 },
      { halfW: this.width / 2, halfH: this.height / 2, rotateX: 0, rotateY: 0, perspective: 0, z: 0 },
      [0, 0],
      [0, 0, 0, 0],
      dest,
      trackMatte,
    );
  }

  /**
   * Pre-compose a clip's NEST — its group of layers (base + region-expansion layers, which is how a region
   * effect like a masked blur is represented) — into `target`, using the SAME multi-layer accumulator the main
   * scene uses. The isolated single-clip path can only hold ONE layer (it reads a transparent backdrop, so a
   * second layer OVERWRITES the first — the "black except the blurred region" bug); the accumulator reads its
   * previous contents as backdrop, so N layers composite correctly. We temporarily retarget the accumulator to
   * this side's (target, scratch) pair so the main scene's in-progress accumulation is untouched, force NORMAL
   * blend inside the nest, and return whichever RTT the per-layer ping-pong ended on. This is the NLE
   * "pre-compose / nest": the transition then mixes two finished clip images, so any effect (or future plugin)
   * on a clip renders THROUGH the transition with no transition-side knowledge of what the effect is.
   */
  private precomposeGroup(group: SceneLayerDraw[], target: RenderTarget, scratch: RenderTarget): RenderTarget {
    const gl = this.gl;
    const savedA = this.accumA;
    const savedB = this.accumB;
    const savedNest = this.nestMode;
    this.accumA = target;
    this.accumB = scratch;
    this.nestMode = true;
    for (const rt of [target, scratch]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, rt.fbo);
      gl.viewport(0, 0, this.width, this.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    for (const draw of group) this.renderLayerInto(draw, null);
    const result = this.accumA; // the accumulator leaves the latest result in accumA after each layer's swap
    this.accumA = savedA;
    this.accumB = savedB;
    this.nestMode = savedNest;
    return result;
  }

  /**
   * Pre-compose a track-matte SOURCE draw (D1) into a pooled comp-sized RTT and hand back its texture
   * + sampling mode for the consumer's composite. Renders at the CURRENT ambient size — inside a nest
   * that's the nest's size, matching the dims the source draw was built against (same scope as its
   * consumer). A null source draw returns the 1×1 transparent `emptyTex`: coverage 0 everywhere (the
   * "matte clip absent at this time" semantics — consumer invisible, or fully visible when inverted).
   * Depth-indexed pool: a chained matte (the source is itself matted) recurses through
   * `renderLayerInto` → here, and the outer matte must survive until its consumer samples it.
   */
  private buildTrackMatte(spec: NonNullable<SceneLayerDraw["matteFrom"]>): { tex: WebGLTexture; luma: boolean; invert: boolean } {
    const luma = spec.mode === "luma";
    const invert = Boolean(spec.invert);
    if (!spec.draw) return { tex: this.emptyTex, luma, invert };
    const gl = this.gl;
    const depth = this.matteDepth;
    this.matteDepth = depth + 1;
    try {
      while (this.matteTargets.length <= depth) {
        this.matteTargets.push({
          target: new RenderTarget(gl, Math.max(1, this.width), Math.max(1, this.height)),
          scratch: new RenderTarget(gl, Math.max(1, this.width), Math.max(1, this.height)),
        });
      }
      const pair = this.matteTargets[depth]!;
      pair.target.resize(this.width, this.height);
      pair.scratch.resize(this.width, this.height);
      if (isGroupDraw(spec.draw)) {
        // A compound clip as the matte source: clear the destination ourselves (the group's shell
        // composite only covers its own quad — everything else keeps the cleared transparent), then
        // render the whole group into it, one depth past any group currently accumulating.
        gl.bindFramebuffer(gl.FRAMEBUFFER, pair.target.fbo);
        gl.viewport(0, 0, this.width, this.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        this.renderGroupInto(spec.draw, pair.target, this.freeGroupDepth);
        return { tex: pair.target.tex, luma, invert };
      }
      return { tex: this.precomposeGroup([spec.draw], pair.target, pair.scratch).tex, luma, invert };
    } finally {
      this.matteDepth = depth;
    }
  }

  /** Lazily allocate (and resize-to-fit) the dedicated RTT pair for compound-group nesting depth `depth`. */
  private groupTargetsForDepth(depth: number, width: number, height: number): { target: RenderTarget; scratch: RenderTarget } {
    const gl = this.gl;
    while (this.groupTargets.length <= depth) {
      this.groupTargets.push({
        target: new RenderTarget(gl, Math.max(1, width), Math.max(1, height)),
        scratch: new RenderTarget(gl, Math.max(1, width), Math.max(1, height)),
      });
    }
    const pair = this.groupTargets[depth]!;
    pair.target.resize(width, height);
    pair.scratch.resize(width, height);
    return pair;
  }

  /**
   * Render a compound-clip GROUP draw (NESTING.md Phase C): pre-compose `children` (back-to-front, the
   * same "own nest, NORMAL blend, transparent backdrop" pattern as `precomposeGroup`/region passes) into
   * an RTT sized to `nestWidth × nestHeight` (already backing px — see `SceneGroupDraw` doc), then
   * composite that RTT through the ORDINARY layer-draw path using `shell` — so a compound clip's own
   * mask/blur/glow/blend/regionPasses work completely unmodified (they're just another `renderLayerInto`
   * call reading a `SceneTextureSource`).
   *
   * The compositor's AMBIENT `width`/`height` (read by `writeQuad`/`compositeTexture`/`gaussianBlur`/
   * `uResolution` — everywhere geometry and blur radii are computed) are swapped to the NEST's size for
   * the duration of the children render, because a child's `transform.x/y` (0..100%) is a percentage OF
   * THE NEST, not the parent comp — build-scene-draws.ts built these children against the nested comp's
   * `w/h` (Task 2), so the compositor's coordinate space must match. Restored before compositing the
   * shell (which is built in PARENT coordinates).
   */
  private renderGroupInto(draw: SceneGroupDraw, dest: RenderTarget | null, depth: number): void {
    const gl = this.gl;
    const nestW = Math.max(1, Math.round(draw.nestWidth));
    const nestH = Math.max(1, Math.round(draw.nestHeight));
    const { target, scratch } = this.groupTargetsForDepth(depth, nestW, nestH);

    const savedWidth = this.width;
    const savedHeight = this.height;
    const savedA = this.accumA;
    const savedB = this.accumB;
    const savedNest = this.nestMode;
    // Held past the children loop THROUGH the shell composite below — the shell's own draw still
    // reads this depth's pair as its source, so a track-matte group render triggered by the shell
    // must go one deeper (see `freeGroupDepth` field doc).
    const savedFreeGroupDepth = this.freeGroupDepth;
    this.freeGroupDepth = depth + 1;
    this.width = nestW;
    this.height = nestH;
    this.accumA = target;
    this.accumB = scratch;
    this.nestMode = true;
    for (const rt of [target, scratch]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, rt.fbo);
      gl.viewport(0, 0, nestW, nestH);
      gl.clearColor(0, 0, 0, 0); // TRANSPARENT clear — alpha preserved (NESTING.md §5), no background bake
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    for (const child of draw.children) {
      if (isTransitionDraw(child)) this.renderTransition(child);
      else if (isGroupDraw(child)) this.renderGroupInto(child, null, depth + 1);
      else this.renderLayerInto(child, null);
    }
    const resultTex = this.accumA.tex; // ping-pong leaves the latest result in accumA after each child's swap

    this.width = savedWidth;
    this.height = savedHeight;
    this.accumA = savedA;
    this.accumB = savedB;
    this.nestMode = savedNest;

    // Composite the finished nest through the NORMAL layer-draw path: the shell carries the compound
    // clip's fit/transform/mask/blur/glow/blend/regionPasses in PARENT coordinates (this.width/height are
    // already restored above), and the nest RTT is just its source texture — no new composite logic.
    this.renderLayerInto(
      { ...draw.shell, source: { texture: resultTex, width: nestW, height: nestH }, sourceWidth: nestW, sourceHeight: nestH },
      dest,
    );
    // Only now is this depth's pair free to reuse — `resultTex` was read by the shell composite above.
    this.freeGroupDepth = savedFreeGroupDepth;
  }

  /**
   * Render a folded transition: pre-compose each side's clip nest to a finished image, then mix the two with
   * the transition shader and composite the mix into the main accumulator at the incoming z-slot.
   */
  private renderTransition(draw: SceneTransitionDraw): void {
    const w = this.width;
    const h = this.height;
    const { sideA, sideAScratch, sideB, sideBScratch } = this.transitionTargets();
    // Each side is its own ping-pong pair, so the two finished nests live in distinct textures the mix reads
    // simultaneously.
    const fromTex = this.precomposeGroup(draw.from, sideA, sideAScratch).tex;
    const toTex = this.precomposeGroup(draw.to, sideB, sideBScratch).tex;

    // Mix into the plate RTT, then composite that into the accumulator as a comp-filling, identity-transform
    // layer (the same z-slot the incoming clip would occupy).
    const { plate } = this.effectTargets();
    this.drawTransition(draw.def, fromTex, toTex, draw.progress, draw.params, plate);
    this.compositeTexture(
      plate.tex,
      null,
      [1, 1],
      false,
      1,
      "normal",
      { x: 50, y: 50, scale: 1, rotation: 0, opacity: 100 },
      { halfW: w / 2, halfH: h / 2, rotateX: 0, rotateY: 0, perspective: 0, z: 0 },
    );
  }

  /** Render the composition for one frame onto the output canvas. */
  renderFrame(spec: SceneFrameSpec): void {
    try {
      this.renderFrameUnchecked(spec);
    } catch (error) {
      if (error instanceof Error && error.message === SCENE_COMPOSITOR_CONTEXT_LOST) {
        this.contextLost = true;
      }
      throw error;
    }
  }

  private renderFrameUnchecked(spec: SceneFrameSpec): void {
    if (!this.renderFrameCore(spec)) return;
    this.presentFrame();
  }

  /** Composite the frame into the accumulator (everything except the present). False = nothing to draw. */
  private renderFrameCore(spec: SceneFrameSpec): boolean {
    if (this.disposed) return false;
    this.debugFrameTime = spec.debugFrameTime;
    const gl = this.gl;
    // If the browser evicted this context ("Too many active WebGL contexts. Oldest context will be lost."),
    // every upload/draw below is a no-op that floods the console. A lost context is PERMANENT, so bail loudly
    // ONCE — ScenePreviewCanvas catches this and falls back to the DOM path instead of spamming every frame.
    this.assertContextAlive();
    this.frameCounter += 1;
    this.ensureSize(spec.width, spec.height);
    const w = this.width;
    const h = this.height;
    if (w <= 0 || h <= 0) return false;

    // Initialize accumulator A with the (opaque) background.
    const [br, bg, bb] = parseColor(spec.backgroundColor || "#000000");
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.accumA.fbo);
    gl.viewport(0, 0, w, h);
    gl.clearColor(br, bg, bb, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND); // blending is done in-shader against uDest

    for (const draw of spec.layers) {
      if (isTransitionDraw(draw)) {
        this.renderTransition(draw);
      } else if (isGroupDraw(draw)) {
        this.renderGroupInto(draw, null, 0);
      } else {
        this.renderLayerInto(draw, null);
      }
    }

    this.pruneTextures();
    this.pruneRegionGradeRenderers();
    this.pruneFragmentPrograms();
    gl.bindVertexArray(null);
    return true;
  }

  /**
   * Present: draw the final accumulator A onto the output canvas (default framebuffer) with a
   * textured fullscreen triangle. NOT blitFramebuffer-to-default — that is an illegal blit when the
   * default framebuffer is multisampled, and it was failing silently (transparent canvas).
   */
  private presentFrame(): void {
    const gl = this.gl;
    const w = this.width;
    const h = this.height;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    this.lastPresentViewport = Array.from(gl.getParameter(gl.VIEWPORT) as Int32Array | number[]);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.presentProgram);
    gl.bindVertexArray(this.presentVao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.accumA.tex);
    gl.uniform1i(this.uPresentTex, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  /**
   * Render one frame WITHOUT presenting, and read the composited RGBA pixels back (top-origin rows,
   * opaque background baked in). The on-screen canvas keeps its last presented image untouched — this is
   * the viewer-capture primitive for background proxy generation (todo.md Phase 6B P1a: "the proxy IS the
   * viewer") and the P1b parity self-check: the EXACT compositor instance, texture caches, and draw-list
   * builder the visible preview uses, minus the present. Returns null when there is nothing to draw or the
   * context is lost. Pass `buffer` (≥ w*h*4 bytes) to avoid a fresh allocation per frame.
   */
  renderFrameOffscreen(spec: SceneFrameSpec, buffer?: Uint8Array): { pixels: Uint8Array; width: number; height: number } | null {
    let drawn = false;
    try {
      drawn = this.renderFrameCore(spec);
    } catch (error) {
      if (error instanceof Error && error.message === SCENE_COMPOSITOR_CONTEXT_LOST) {
        this.contextLost = true;
      }
      throw error;
    }
    if (!drawn) return null;
    const gl = this.gl;
    const w = this.width;
    const h = this.height;
    const size = w * h * 4;
    const pixels = buffer && buffer.byteLength >= size ? buffer : new Uint8Array(size);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.accumA.fbo);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // FBO rows are bottom-origin; flip in place to top-origin for VideoFrame/ImageData consumers.
    const rowBytes = w * 4;
    const tmp = new Uint8Array(rowBytes);
    for (let y = 0; y < h >> 1; y++) {
      const top = y * rowBytes;
      const bottom = (h - 1 - y) * rowBytes;
      tmp.set(pixels.subarray(top, top + rowBytes));
      pixels.copyWithin(top, bottom, bottom + rowBytes);
      pixels.set(tmp, bottom);
    }
    return { pixels, width: w, height: h };
  }

  /**
   * Downsample the RETAINED composite (the last frame left in `accumA` by `renderFrame`) into a small
   * top-origin RGBA thumbnail — the trustworthy source for the color scopes. This does NOT re-composite
   * (cheap: one linear blit + a tiny readback) and does NOT touch the on-screen canvas, so it is exact
   * regardless of `preserveDrawingBuffer`. Returns null if nothing has been composited yet or the context
   * is lost. `targetW`×`targetH` is the thumbnail size (e.g. 320×180); `buffer` (≥ w*h*4) avoids a per-call
   * allocation.
   */
  readCompositeThumbnail(
    targetW: number,
    targetH: number,
    buffer?: Uint8Array
  ): { pixels: Uint8Array; width: number; height: number } | null {
    if (this.disposed || this.isContextLost() || this.width === 0 || this.height === 0) return null;
    const w = Math.max(1, Math.min(targetW | 0, this.width));
    const h = Math.max(1, Math.min(targetH | 0, this.height));
    const gl = this.gl;
    if (!this.scopeThumb) this.scopeThumb = new RenderTarget(gl, w, h);
    else this.scopeThumb.resize(w, h);
    try {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.accumA.fbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.scopeThumb.fbo);
      gl.blitFramebuffer(0, 0, this.width, this.height, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.LINEAR);
      const size = w * h * 4;
      const pixels = buffer && buffer.byteLength >= size ? buffer : new Uint8Array(size);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.scopeThumb.fbo);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      // FBO rows are bottom-origin; flip to top-origin for ImageData/scope consumers.
      const rowBytes = w * 4;
      const tmp = new Uint8Array(rowBytes);
      for (let y = 0; y < h >> 1; y++) {
        const top = y * rowBytes;
        const bottom = (h - 1 - y) * rowBytes;
        tmp.set(pixels.subarray(top, top + rowBytes));
        pixels.copyWithin(top, bottom, bottom + rowBytes);
        pixels.set(tmp, bottom);
      }
      return { pixels, width: w, height: h };
    } catch {
      return null;
    } finally {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
  }

  /**
   * Async sibling of {@link readCompositeThumbnail} (Phase 5) — the scopes' non-stalling readback path.
   *
   * Same source (the RETAINED composite in `accumA`, linear-blit down to `targetW×targetH`), but instead of
   * a synchronous `gl.readPixels` (which blocks the CPU on a GPU drain — the 30Hz stall this replaces), it:
   *   1. harvests any PRIOR in-flight read whose fence is signaled — `clientWaitSync(…, 0)` is non-blocking,
   *      and the following `getBufferSubData` from the PIXEL_PACK_BUFFER no longer stalls (the GPU is done);
   *   2. kicks a NEW read into the PBO (returns immediately) + inserts a fence;
   *   3. returns the most-recent COMPLETED pixels (top-origin), or null until the first read lands.
   *
   * Result is one scope-tick stale — imperceptible for waveform/vectorscope at ≤10Hz. Falls back to null
   * (caller uses the sync path / DOM sample) on any error or before the first fence completes.
   */
  readCompositeThumbnailAsync(
    targetW: number,
    targetH: number,
    buffer?: Uint8Array
  ): { pixels: Uint8Array; width: number; height: number } | null {
    if (this.disposed || this.isContextLost() || this.width === 0 || this.height === 0) return null;
    const w = Math.max(1, Math.min(targetW | 0, this.width));
    const h = Math.max(1, Math.min(targetH | 0, this.height));
    const gl = this.gl;
    const flipTopOrigin = (pixels: Uint8Array, pw: number, ph: number): void => {
      const rowBytes = pw * 4;
      const tmp = new Uint8Array(rowBytes);
      for (let y = 0; y < ph >> 1; y++) {
        const top = y * rowBytes;
        const bottom = (ph - 1 - y) * rowBytes;
        tmp.set(pixels.subarray(top, top + rowBytes));
        pixels.copyWithin(top, bottom, bottom + rowBytes);
        pixels.set(tmp, bottom);
      }
    };
    try {
      // (1) Harvest a completed prior read (non-blocking).
      if (this.scopeFence && this.scopePendingWH) {
        const status = gl.clientWaitSync(this.scopeFence, 0, 0);
        if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) {
          const { w: pw, h: ph } = this.scopePendingWH;
          const out = new Uint8Array(pw * ph * 4);
          gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.scopePbo);
          gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, out);
          gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
          flipTopOrigin(out, pw, ph); // FBO rows are bottom-origin → flip for ImageData/scope consumers
          this.scopeReady = { pixels: out, w: pw, h: ph };
          gl.deleteSync(this.scopeFence);
          this.scopeFence = null;
          this.scopePendingWH = null;
        } else if (status === gl.WAIT_FAILED) {
          gl.deleteSync(this.scopeFence);
          this.scopeFence = null;
          this.scopePendingWH = null;
        }
        // TIMEOUT_EXPIRED → still in flight; leave it and skip kicking a new read.
      }
      // (2) Kick a new read only when the slot is free (single in-flight read).
      if (!this.scopeFence) {
        if (!this.scopeThumb) this.scopeThumb = new RenderTarget(gl, w, h);
        else this.scopeThumb.resize(w, h);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.accumA.fbo);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.scopeThumb.fbo);
        gl.blitFramebuffer(0, 0, this.width, this.height, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.LINEAR);
        const size = w * h * 4;
        if (!this.scopePbo) this.scopePbo = gl.createBuffer();
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.scopePbo);
        if (this.scopePboBytes !== size) {
          gl.bufferData(gl.PIXEL_PACK_BUFFER, size, gl.STREAM_READ);
          this.scopePboBytes = size;
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.scopeThumb.fbo);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, 0); // async → into the bound PBO at offset 0
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        this.scopeFence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        this.scopePendingWH = { w, h };
        gl.flush(); // make sure the fence + read are actually in the GPU command stream
      }
      // (3) Return the latest completed read (from this or a prior call).
      const ready = this.scopeReady;
      if (!ready) return null;
      const bytes = ready.pixels.byteLength;
      if (buffer && buffer.byteLength >= bytes) {
        buffer.set(ready.pixels.subarray(0, bytes));
        return { pixels: buffer, width: ready.w, height: ready.h };
      }
      return { pixels: ready.pixels, width: ready.w, height: ready.h };
    } catch {
      return null;
    } finally {
      // A bound PIXEL_PACK_BUFFER redirects EVERY later `readPixels(…, ArrayBufferView)` on this shared
      // context into the PBO (INVALID_OPERATION) — renderFrameOffscreen / the sync scope read / finish()
      // would all break. Unbind unconditionally so an exception mid-arm can never leak the binding.
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
  }

  /**
   * Force the output canvas to be fully materialized before the caller snapshots it. Export ONLY: a one-shot
   * export does `new VideoFrame(canvas)` right after `renderFrame`, but WebGL draws are asynchronous. On some
   * drivers `gl.finish()` alone is NOT enough — `VideoFrame(offscreenCanvas)` can still capture an unfinished
   * (black) buffer, intermittently, on later frames under load (the "last clip sometimes black" bug). A tiny
   * `readPixels` from the default framebuffer forces the driver to resolve the presented image (this is what
   * the diagnostic luma readback did — which is why probing always "fixed" it). We keep `finish()` too as the
   * command-completion barrier, then the 1px read as the materialization barrier. The editor preview never
   * captures its canvas, so it never calls this; the render loop stays sync-free.
   */
  finish(): void {
    if (this.disposed) return;
    const gl = this.gl;
    gl.finish();
    try {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.captureSyncPixel);
    } catch {
      /* readback is a best-effort materialization barrier; finish() above is the hard sync */
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    for (const entry of this.srcTextures.values()) gl.deleteTexture(entry.tex);
    this.srcTextures.clear();
    gl.deleteTexture(this.emptyTex);
    this.accumA.dispose();
    this.accumB.dispose();
    this.plateRT?.dispose();
    this.scratch1?.dispose();
    this.scratch2?.dispose();
    this.scopeThumb?.dispose();
    if (this.scopeFence) {
      gl.deleteSync(this.scopeFence);
      this.scopeFence = null;
    }
    if (this.scopePbo) {
      gl.deleteBuffer(this.scopePbo);
      this.scopePbo = null;
    }
    this.scopePendingWH = null;
    this.scopeReady = null;
    this.sideA?.dispose();
    this.sideAScratch?.dispose();
    this.sideB?.dispose();
    this.sideBScratch?.dispose();
    this.layerNestA?.dispose();
    this.layerNestB?.dispose();
    for (const pair of this.groupTargets) {
      pair.target.dispose();
      pair.scratch.dispose();
    }
    this.groupTargets.length = 0;
    for (const pair of this.matteTargets) {
      pair.target.dispose();
      pair.scratch.dispose();
    }
    this.matteTargets.length = 0;
    for (const entry of this.regionGradeRenderers.values()) {
      entry.renderer.dispose();
      entry.target.dispose();
    }
    this.regionGradeRenderers.clear();
    for (const compiled of this.transitionPrograms.values()) {
      if (compiled.program) gl.deleteProgram(compiled.program);
      if (compiled.pipelinePasses) for (const pass of compiled.pipelinePasses) gl.deleteProgram(pass.program);
    }
    this.transitionPrograms.clear();
    for (const compiled of this.fragmentPrograms.values()) gl.deleteProgram(compiled.program);
    this.fragmentPrograms.clear();
    gl.deleteBuffer(this.vbo);
    gl.deleteVertexArray(this.vao);
    gl.deleteVertexArray(this.presentVao);
    gl.deleteProgram(this.presentProgram);
    // Effect programs only exist if a blur/glow pass ran (ensureEffectPrograms).
    if (this.effectProgramsBuilt) {
      gl.deleteProgram(this.plateProgram);
      gl.deleteProgram(this.blurProgram);
      gl.deleteProgram(this.glowProgram);
      gl.deleteProgram(this.bloomBrightProgram);
      gl.deleteProgram(this.bloomAddProgram);
    }
    gl.deleteProgram(this.program);
    releaseContextIfDetached(gl);
  }
}
