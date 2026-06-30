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
import type { BlendMode } from "../types";

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
  from: SceneLayerDraw;
  to: SceneLayerDraw;
  def: TransitionDefinition;
  /** EASED progress 0..1 (caller applies the definition's easing). */
  progress: number;
  params?: Record<string, number | number[] | boolean> | undefined;
}

/** A compositor draw entry: a normal layer, or a folded transition between two full layer draws. */
export type SceneDraw = SceneLayerDraw | SceneTransitionDraw;

function isTransitionDraw(d: SceneDraw): d is SceneTransitionDraw {
  return (d as SceneTransitionDraw).kind === "transition";
}

export interface SceneFrameSpec {
  width: number;
  height: number;
  backgroundColor: string;
  /** Visible draws, back-to-front (first drawn = bottom). A draw is a layer or a folded transition. */
  layers: SceneDraw[];
}

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

/** A compiled per-transition program + its uniform locations (mirrors TransitionCompositor's cache). */
interface CompiledTransition {
  program: WebGLProgram;
  uFrom: WebGLUniformLocation | null;
  uTo: WebGLUniformLocation | null;
  uProgress: WebGLUniformLocation | null;
  uResolution: WebGLUniformLocation | null;
  uRatio: WebGLUniformLocation | null;
  uFromFit: WebGLUniformLocation | null;
  uToFit: WebGLUniformLocation | null;
  params: { param: TransitionParam; location: WebGLUniformLocation | null }[];
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
uniform bool uHasMask;
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
  // Present pass: a textured fullscreen triangle that copies the final accumulator to the canvas.
  private readonly presentProgram: WebGLProgram;
  private readonly presentVao: WebGLVertexArrayObject;
  private readonly uPresentTex: WebGLUniformLocation | null;
  // Effect passes (blur/glow). Programs are cheap to compile up front; the comp-sized RTTs they need
  // are allocated LAZILY on first blur/glow use and pooled thereafter — comps with no blur/glow pay
  // zero extra VRAM, and effect comps allocate the 3 targets once (not per-layer/per-frame).
  private readonly plateProgram: WebGLProgram;
  private readonly blurProgram: WebGLProgram;
  private readonly glowProgram: WebGLProgram;
  private readonly bloomBrightProgram: WebGLProgram;
  private readonly bloomAddProgram: WebGLProgram;
  private readonly uPlateSrc: WebGLUniformLocation | null;
  private readonly uPlateMask: WebGLUniformLocation | null;
  private readonly uPlateHasMask: WebGLUniformLocation | null;
  private readonly uPlateFitScale: WebGLUniformLocation | null;
  private readonly uPlateContentPan: WebGLUniformLocation | null;
  private readonly uPlateCrop: WebGLUniformLocation | null;
  private readonly uBlurTex: WebGLUniformLocation | null;
  private readonly uBlurStep: WebGLUniformLocation | null;
  private readonly uBlurRadius: WebGLUniformLocation | null;
  private readonly uBlurSigma: WebGLUniformLocation | null;
  private readonly uBlurPremultIn: WebGLUniformLocation | null;
  private readonly uBlurUnpremultOut: WebGLUniformLocation | null;
  private readonly uGlowPlate: WebGLUniformLocation | null;
  private readonly uGlowTex: WebGLUniformLocation | null;
  private readonly uGlowColor: WebGLUniformLocation | null;
  private readonly uBloomBrightSrc: WebGLUniformLocation | null;
  private readonly uBloomBrightThreshold: WebGLUniformLocation | null;
  private readonly uBloomAddPlate: WebGLUniformLocation | null;
  private readonly uBloomAddTex: WebGLUniformLocation | null;
  private readonly uBloomAddTint: WebGLUniformLocation | null;
  private readonly uBloomAddStrength: WebGLUniformLocation | null;
  private plateRT: RenderTarget | null = null;
  private scratch1: RenderTarget | null = null;
  private scratch2: RenderTarget | null = null;
  // Per-transition-side RTTs (each side rendered fully — effects + transform — over transparent, then
  // mixed). Lazily allocated; comps with no transition pay zero VRAM.
  private sideA: RenderTarget | null = null;
  private sideB: RenderTarget | null = null;
  // Per-transition-def compiled program cache (the SAME shaders TransitionCompositor uses, compiled in
  // THIS context so the mix runs without a second GL context).
  private readonly transitionPrograms = new Map<string, CompiledTransition>();
  private accumA: RenderTarget;
  private accumB: RenderTarget;
  private width = 0;
  private height = 0;
  private disposed = false;
  private lastPresentViewport: number[] | null = null;

  // 6 vertices (2 triangles) × (ndcX, ndcY, projective w, u, v).
  private readonly quad = new Float32Array(6 * 5);

  // Uniform locations
  private readonly uSrc: WebGLUniformLocation | null;
  private readonly uMask: WebGLUniformLocation | null;
  private readonly uDest: WebGLUniformLocation | null;
  private readonly uHasMask: WebGLUniformLocation | null;
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
    const gl = createGl(canvas);
    this.gl = gl;

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
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    this.accumA = new RenderTarget(gl, width, height);
    this.accumB = new RenderTarget(gl, width, height);

    this.presentProgram = linkProgram(gl, FULLSCREEN_TRI_VS, PRESENT_FS);
    this.presentVao = createFullscreenVao(gl);
    this.uPresentTex = gl.getUniformLocation(this.presentProgram, "uTex");

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

    this.uSrc = gl.getUniformLocation(program, "uSrc");
    this.uMask = gl.getUniformLocation(program, "uMask");
    this.uDest = gl.getUniformLocation(program, "uDest");
    this.uHasMask = gl.getUniformLocation(program, "uHasMask");
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
    this.sideB?.resize(width, height);
  }

  /** Lazily allocate the comp-sized RTTs the blur/glow passes need (pooled across layers/frames). */
  private effectTargets(): { plate: RenderTarget; s1: RenderTarget; s2: RenderTarget } {
    const gl = this.gl;
    this.plateRT ??= new RenderTarget(gl, this.width, this.height);
    this.scratch1 ??= new RenderTarget(gl, this.width, this.height);
    this.scratch2 ??= new RenderTarget(gl, this.width, this.height);
    return { plate: this.plateRT, s1: this.scratch1, s2: this.scratch2 };
  }

  /** Lazily allocate the two per-side RTTs a folded transition renders its full sides into. */
  private transitionTargets(): { sideA: RenderTarget; sideB: RenderTarget } {
    const gl = this.gl;
    this.sideA ??= new RenderTarget(gl, this.width, this.height);
    this.sideB ??= new RenderTarget(gl, this.width, this.height);
    return { sideA: this.sideA, sideB: this.sideB };
  }

  /** Compile + cache the program for a transition definition (the same shaders TransitionCompositor uses). */
  private prepareTransition(def: TransitionDefinition): CompiledTransition {
    const existing = this.transitionPrograms.get(def.id);
    if (existing) return existing;
    const gl = this.gl;
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
    };
    this.transitionPrograms.set(def.id, compiled);
    return compiled;
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
  private uploadSource(source: TexImageSource, version: number | undefined): WebGLTexture {
    const gl = this.gl;
    const [sw, sh] = srcDims(source);
    let entry = this.srcTextures.get(source);
    const needAlloc = !entry || entry.w !== sw || entry.h !== sh;
    if (!entry) {
      entry = { tex: this.makeTex(), w: sw, h: sh, version: Number.NaN, lastFrame: this.frameCounter };
      this.srcTextures.set(source, entry);
    }
    entry.lastFrame = this.frameCounter;
    // Unchanged content (a versioned source whose version + size match the last upload) → reuse as-is.
    if (version !== undefined && !needAlloc && entry.version === version) return entry.tex;
    gl.bindTexture(gl.TEXTURE_2D, entry.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    if (needAlloc) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      entry.w = sw;
      entry.h = sh;
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
    }
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
    // A transition side is rendered in isolation over transparent → force normal blend (its blend-with-below
    // applies when the MIX lands on the accumulator); the normal path keeps the layer's blend mode.
    const blend: BlendMode = dest ? "normal" : layer.blendMode;
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
      : this.uploadSource(layer.source, layer.sourceVersion);
    const maskTex = layer.mask ? this.uploadSource(layer.mask, layer.maskVersion) : null;

    // Content transform (media only): zoom folds into the object-fit (smaller sampled window), pan shifts
    // the window, crop trims the frame edges. Identity (no `content`) → unchanged object-fit.
    const content = layer.content ?? null;
    const baseFit = fitScale(sw, sh, w, h, layer.fit);
    const fitVec: [number, number] = content ? [baseFit[0] / content.scale, baseFit[1] / content.scale] : baseFit;
    const contentPan: [number, number] = content ? content.pan : [0, 0];
    const crop: [number, number, number, number] = content ? content.crop : [0, 0, 0, 0];

    if (blurPx <= 0 && !glow) {
      // Fast path (Phase 1): object-fit + content pan/zoom/crop + mask + transform + blend in one draw.
      this.compositeTexture(srcTex, maskTex, fitVec, hasMask, opacity, blend, layer.transform, geom, contentPan, crop, dest);
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
    );
  }

  /**
   * Render a folded transition: render each side as a FULL layer (all effects) into its own RTT, mix the two
   * with the transition shader, then composite the mix into the main accumulator at the incoming z-slot.
   */
  private renderTransition(draw: SceneTransitionDraw): void {
    const gl = this.gl;
    const w = this.width;
    const h = this.height;
    const { sideA, sideB } = this.transitionTargets();

    gl.bindFramebuffer(gl.FRAMEBUFFER, sideA.fbo);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.renderLayerInto(draw.from, sideA);

    gl.bindFramebuffer(gl.FRAMEBUFFER, sideB.fbo);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.renderLayerInto(draw.to, sideB);

    // Mix into the plate RTT (free now that both sides are rendered), then composite that into the accumulator
    // as a comp-filling, identity-transform layer (the same z-slot the incoming clip would occupy).
    const { plate } = this.effectTargets();
    this.drawTransition(draw.def, sideA.tex, sideB.tex, draw.progress, draw.params, plate);
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
    if (this.disposed) return;
    const gl = this.gl;
    // If the browser evicted this context ("Too many active WebGL contexts. Oldest context will be lost."),
    // every upload/draw below is a no-op that floods the console. A lost context is PERMANENT, so bail loudly
    // ONCE — ScenePreviewCanvas catches this and falls back to the DOM path instead of spamming every frame.
    if (gl.isContextLost()) throw new Error("scene-compositor: WebGL context lost (evicted)");
    this.frameCounter += 1;
    this.ensureSize(spec.width, spec.height);
    const w = this.width;
    const h = this.height;
    if (w <= 0 || h <= 0) return;

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
      } else {
        this.renderLayerInto(draw, null);
      }
    }

    this.pruneTextures();
    gl.bindVertexArray(null);

    // Present: draw the final accumulator A onto the output canvas (default framebuffer) with a
    // textured fullscreen triangle. NOT blitFramebuffer-to-default — that is an illegal blit when the
    // default framebuffer is multisampled, and it was failing silently (transparent canvas).
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
    this.sideA?.dispose();
    this.sideB?.dispose();
    for (const compiled of this.transitionPrograms.values()) gl.deleteProgram(compiled.program);
    this.transitionPrograms.clear();
    gl.deleteBuffer(this.vbo);
    gl.deleteVertexArray(this.vao);
    gl.deleteVertexArray(this.presentVao);
    gl.deleteProgram(this.presentProgram);
    gl.deleteProgram(this.plateProgram);
    gl.deleteProgram(this.blurProgram);
    gl.deleteProgram(this.glowProgram);
    gl.deleteProgram(this.bloomBrightProgram);
    gl.deleteProgram(this.bloomAddProgram);
    gl.deleteProgram(this.program);
    releaseContextIfDetached(gl);
  }
}
