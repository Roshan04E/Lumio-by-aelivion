/**
 * Professional Color System — unified WebGL media renderer.
 *
 * `MediaWebGLRenderer` replaces the three separate legacy paths:
 *   - `WebglColorApplicator` (color-only, no matte)
 *   - Canvas-2D `MaskedVideoLayer` / `MaskedVideo` (matte-only, no WebGL color)
 *
 * It composes both in a **single WebGL2 pass**:
 *   1. Uploads source frame (video / image / ImageBitmap) to `u_frame`.
 *   2. If a `ColorPipeline` is set, bakes it to a 3D LUT and samples it per-pixel.
 *   3. If a luma-matte frame is provided, samples it and multiplies into alpha.
 *   4. Multiplies layer opacity into alpha.
 *
 * Object-fit, CSS transforms, and warp overlay remain CSS/DOM concerns.
 * One `MediaWebGLRenderer` per canvas element; call `setPipeline()` when the
 * color grade changes, `draw()` per frame, `dispose()` on unmount.
 */

import { bakeMatteLut3d, bakePipelineToLut3d } from "./lut3d";
import {
  markTexImageSourceProducer,
  noteGlContextCreated,
  releaseContextIfDetached,
  requestContextSlot,
  touchContext,
  type GlContextCreateOptions,
  type RenderTarget,
} from "./gl-context";
import { MEDIA_FRAGMENT_SHADER, MEDIA_VERTEX_SHADER, mediaLut3dToRgbaFloat } from "./media-shader";
import type { ColorPipeline, MediaEffects } from "./types";

export interface MediaRendererDrawParams {
  /** Decoded video frame, image element, or ImageBitmap — the graded source. Omit when `sourceTexture` is set. */
  source?: TexImageSource | undefined;
  /**
   * Shared-context mode ONLY: grade an EXISTING texture on the shared context (bottom-origin,
   * e.g. a `SceneCompositor` render-target — the region-pass "grade the running image" path)
   * instead of uploading a `TexImageSource`. Orientation matches the upload path (uploads are
   * flip-Y'd to bottom-origin), so the two are drop-in equivalents.
   */
  sourceTexture?: WebGLTexture | null | undefined;
  sourceWidth: number;
  sourceHeight: number;
  /** Optional grayscale luma-matte frame (same natural dimensions as source). */
  matte?: TexImageSource | null;
  matteWidth?: number;
  matteHeight?: number;
  /** Invert the matte (subject removal vs background removal). Default false. */
  matteInvert?: boolean;
  /** Extra matte opacity multiplier (0-1). Default 1. */
  matteOpacity?: number;
  /** Color grade pipeline; null = no grading (passthrough). */
  pipeline: ColorPipeline | null;
  /** Grade intensity 0..1 blended toward graded result. Default 1. */
  amount?: number;
  /** Layer opacity 0..1 multiplied into alpha. Default 1. */
  opacity?: number;
  /** When true, draw the grayscale HSL-secondary matte preview instead of the grade. */
  showMatte?: boolean;
  /** Pro stylize effects (vignette / grain / chroma key) applied in-shader. Null = none. */
  mediaEffects?: MediaEffects | null;
  /**
   * GPU transition reveal (wipe / iris) on this incoming clip's alpha. Null = no transition. Driven by
   * the shared `getCompositionTransition` so all three renderers mask identically.
   */
  transition?: MediaTransition | null;
  /**
   * Shared-context mode ONLY: the caller-owned `RenderTarget` to render the graded result into (instead of the
   * renderer's own canvas). Required when the renderer was constructed with `{ sharedGl }`; the renderer resizes
   * it to the source dimensions (same auto-size behavior as own-canvas mode). Ignored in own-canvas mode.
   */
  target?: RenderTarget | null;
}

export const MEDIA_RENDERER_CONTEXT_LOST = "MEDIA_RENDERER_CONTEXT_LOST";

export interface MediaWebGLRendererOptions extends GlContextCreateOptions {}

export interface MediaTransition {
  kind: "wipe" | "iris" | "dip";
  /** 0 concealed → 1 revealed. */
  progress: number;
  direction: "left" | "right" | "up" | "down";
  mode: "in" | "out";
  softness: number;
  /** Dip-through colour (rgb 0..1), only for `dip`. */
  color?: [number, number, number] | undefined;
}

const TRANSITION_DIR_INDEX: Record<MediaTransition["direction"], number> = { left: 0, right: 1, up: 2, down: 3 };
const TRANSITION_KIND_INDEX: Record<MediaTransition["kind"], number> = { wipe: 1, iris: 2, dip: 3 };

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error(gl.isContextLost() ? MEDIA_RENDERER_CONTEXT_LOST : "media-renderer: failed to create shader");
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    // Compile on a LOST context fails with an empty log — surface it as context loss so callers'
    // recovery ladders keep retrying instead of latching a permanent "shader broken" fallback.
    if (gl.isContextLost()) throw new Error(MEDIA_RENDERER_CONTEXT_LOST);
    throw new Error(`media-renderer: shader compile failed: ${log ?? "unknown"}`);
  }
  return shader;
}

function make2dTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error("media-renderer: failed to create texture");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return tex;
}

export class MediaWebGLRenderer {
  private readonly _canvas: HTMLCanvasElement | OffscreenCanvas | null;
  /**
   * Own-canvas mode: the canvas this renderer grades into (read by `SceneFrameCompositor` / `buildSceneDraws`
   * as a `TexImageSource`). Public type is unchanged (non-null) so every existing own-canvas
   * caller compiles untouched; it throws only if read in shared-context mode (where there is no canvas — sample
   * the `RenderTarget` you pass to `draw()` instead).
   */
  get canvas(): HTMLCanvasElement | OffscreenCanvas {
    if (!this._canvas) throw new Error("media-renderer: .canvas is unavailable in shared-context mode (use the RenderTarget output)");
    return this._canvas;
  }
  /** True when constructed against an external (shared) WebGL2 context — renders into a caller `RenderTarget`. */
  private readonly shared: boolean;
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly frameTex: WebGLTexture;
  private readonly matteTex: WebGLTexture;
  private readonly lutTex: WebGLTexture;
  private readonly ownerLabel: string;
  private readonly maxTextureSize: number;
  /** Last-allocated size per texture, so same-size per-frame uploads can use texSubImage2D. */
  private readonly uploadedTexSizes = new Map<WebGLTexture, { width: number; height: number }>();

  // Uniform locations
  private readonly uFrame: WebGLUniformLocation | null;
  private readonly uLut: WebGLUniformLocation | null;
  private readonly uLutSize: WebGLUniformLocation | null;
  private readonly uAmount: WebGLUniformLocation | null;
  private readonly uHasLut: WebGLUniformLocation | null;
  private readonly uMatte: WebGLUniformLocation | null;
  private readonly uHasMatte: WebGLUniformLocation | null;
  private readonly uMatteInvert: WebGLUniformLocation | null;
  private readonly uMatteOpacity: WebGLUniformLocation | null;
  private readonly uOpacity: WebGLUniformLocation | null;
  private readonly uHasVignette: WebGLUniformLocation | null;
  private readonly uVigAmount: WebGLUniformLocation | null;
  private readonly uVigSize: WebGLUniformLocation | null;
  private readonly uVigFeather: WebGLUniformLocation | null;
  private readonly uVigRound: WebGLUniformLocation | null;
  private readonly uVigHighlights: WebGLUniformLocation | null;
  private readonly uAspect: WebGLUniformLocation | null;
  private readonly uHasGrain: WebGLUniformLocation | null;
  private readonly uGrainAmount: WebGLUniformLocation | null;
  private readonly uGrainSize: WebGLUniformLocation | null;
  private readonly uTime: WebGLUniformLocation | null;
  private readonly uHasChroma: WebGLUniformLocation | null;
  private readonly uChromaColor: WebGLUniformLocation | null;
  private readonly uChromaTol: WebGLUniformLocation | null;
  private readonly uChromaSoft: WebGLUniformLocation | null;
  private readonly uChromaDespill: WebGLUniformLocation | null;
  private readonly uChromaChoke: WebGLUniformLocation | null;
  private readonly uChromaMatteView: WebGLUniformLocation | null;
  private readonly uTransitionKind: WebGLUniformLocation | null;
  private readonly uTransitionProgress: WebGLUniformLocation | null;
  private readonly uTransitionDir: WebGLUniformLocation | null;
  private readonly uTransitionMode: WebGLUniformLocation | null;
  private readonly uTransitionSoft: WebGLUniformLocation | null;
  private readonly uTransitionColor: WebGLUniformLocation | null;

  private lutSize = 0;
  private disposed = false;
  private contextLost = false;

  constructor(target: HTMLCanvasElement | OffscreenCanvas | { sharedGl: WebGL2RenderingContext }, options: MediaWebGLRendererOptions = {}) {
    let gl: WebGL2RenderingContext;
    this.ownerLabel = options.label ?? (("sharedGl" in target) ? "media-renderer:shared" : "media-renderer");
    if ("sharedGl" in target) {
      // Shared-context mode (additive, Phase 2 Stage 1): borrow an existing WebGL2 context (e.g. the
      // SceneCompositor's) and render the grade into a caller-owned RenderTarget — NO own canvas, NO own
      // context. This is what lets the whole export run on ONE context (Worker-portable). We create no
      // context here, so we deliberately do NOT noteGlContextCreated() and dispose() does NOT lose it.
      this._canvas = null;
      this.shared = true;
      gl = target.sharedGl;
    } else {
      this._canvas = target;
      this.shared = false;
      // Reserve budget room BEFORE creating our own context: when the governor is enabled and we're at the
      // hard cap, this evicts the least-recently-used idle preview context so a large, many-clip timeline
      // never crosses the browser's ~16-context cap (a browser force-loss would drop the GPU scene to DOM).
      // No-op when the governor is disabled. (Shared-context mode borrows a context → no reservation.)
      requestContextSlot();
      // preserveDrawingBuffer keeps the last frame on the canvas between draws. Without it the browser
      // discards the (alpha) buffer after each composite, so a single skipped/late draw — exactly at a
      // clip swap or before the incoming clip's draw loop ticks — flashes transparent for one frame
      // (the flicker). Each draw() still clears+redraws, so output is unchanged when we do draw.
      const ctx = target.getContext("webgl2", { premultipliedAlpha: false, alpha: true, preserveDrawingBuffer: true }) as WebGL2RenderingContext | null;
      if (!ctx) throw new Error("media-renderer: WebGL2 unavailable");
      // Count toward the live WebGL context budget — this is the one creation site that doesn't route through
      // createGl(); `dispose()`'s `releaseContextIfDetached` decrements it. Keeps the export budget accurate.
      noteGlContextCreated(ctx, { kind: options.kind ?? "media-renderer", label: this.ownerLabel });
      gl = ctx;
    }
    this.gl = gl;
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;

    const vs = compile(gl, gl.VERTEX_SHADER, MEDIA_VERTEX_SHADER);
    const fs = compile(gl, gl.FRAGMENT_SHADER, MEDIA_FRAGMENT_SHADER);
    const program = gl.createProgram();
    if (!program) throw new Error("media-renderer: failed to create program");
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      throw new Error(`media-renderer: program link failed: ${log ?? "unknown"}`);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    this.program = program;

    // Uniforms
    this.uFrame = gl.getUniformLocation(program, "u_frame");
    this.uLut = gl.getUniformLocation(program, "u_lut");
    this.uLutSize = gl.getUniformLocation(program, "u_lutSize");
    this.uAmount = gl.getUniformLocation(program, "u_amount");
    this.uHasLut = gl.getUniformLocation(program, "u_hasLut");
    this.uMatte = gl.getUniformLocation(program, "u_matte");
    this.uHasMatte = gl.getUniformLocation(program, "u_hasMatte");
    this.uMatteInvert = gl.getUniformLocation(program, "u_matteInvert");
    this.uMatteOpacity = gl.getUniformLocation(program, "u_matteOpacity");
    this.uOpacity = gl.getUniformLocation(program, "u_opacity");
    this.uHasVignette = gl.getUniformLocation(program, "u_hasVignette");
    this.uVigAmount = gl.getUniformLocation(program, "u_vigAmount");
    this.uVigSize = gl.getUniformLocation(program, "u_vigSize");
    this.uVigFeather = gl.getUniformLocation(program, "u_vigFeather");
    this.uVigRound = gl.getUniformLocation(program, "u_vigRound");
    this.uVigHighlights = gl.getUniformLocation(program, "u_vigHighlights");
    this.uAspect = gl.getUniformLocation(program, "u_aspect");
    this.uHasGrain = gl.getUniformLocation(program, "u_hasGrain");
    this.uGrainAmount = gl.getUniformLocation(program, "u_grainAmount");
    this.uGrainSize = gl.getUniformLocation(program, "u_grainSize");
    this.uTime = gl.getUniformLocation(program, "u_time");
    this.uHasChroma = gl.getUniformLocation(program, "u_hasChroma");
    this.uChromaColor = gl.getUniformLocation(program, "u_chromaColor");
    this.uChromaTol = gl.getUniformLocation(program, "u_chromaTol");
    this.uChromaSoft = gl.getUniformLocation(program, "u_chromaSoft");
    this.uChromaDespill = gl.getUniformLocation(program, "u_chromaDespill");
    this.uChromaChoke = gl.getUniformLocation(program, "u_chromaChoke");
    this.uChromaMatteView = gl.getUniformLocation(program, "u_chromaMatteView");
    this.uTransitionKind = gl.getUniformLocation(program, "u_transitionKind");
    this.uTransitionProgress = gl.getUniformLocation(program, "u_transitionProgress");
    this.uTransitionDir = gl.getUniformLocation(program, "u_transitionDir");
    this.uTransitionMode = gl.getUniformLocation(program, "u_transitionMode");
    this.uTransitionSoft = gl.getUniformLocation(program, "u_transitionSoft");
    this.uTransitionColor = gl.getUniformLocation(program, "u_transitionColor");

    // Fullscreen triangle
    const vao = gl.createVertexArray();
    if (!vao) throw new Error("media-renderer: failed to create VAO");
    this.vao = vao;
    gl.bindVertexArray(vao);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, "a_position");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.frameTex = make2dTexture(gl);
    this.matteTex = make2dTexture(gl);
    this.lutTex = gl.createTexture()!;
    this.publishProducerState();
  }

  isContextLost(): boolean {
    return this.contextLost || this.gl.isContextLost();
  }

  private assertContextAlive(): void {
    if (!this.isContextLost()) return;
    this.contextLost = true;
    this.publishProducerState();
    throw new Error(MEDIA_RENDERER_CONTEXT_LOST);
  }

  private publishProducerState(): void {
    if (this.shared || !this._canvas) return;
    try {
      markTexImageSourceProducer(this._canvas as TexImageSource, {
        label: this.ownerLabel,
        disposed: this.disposed,
        contextLost: this.isContextLost(),
        width: this._canvas.width,
        height: this._canvas.height,
        updatedAt: 0,
      });
    } catch {
      /* ignore */
    }
  }

  private canUpload(width: number, height: number): boolean {
    if (this.disposed) return false;
    this.assertContextAlive();
    if (width <= 0 || height <= 0) return false;
    if (width > this.maxTextureSize || height > this.maxTextureSize) return false;
    return true;
  }

  /** Intrinsic pixel dimensions of a TexImageSource (0×0 when not yet known, e.g. a loading video). */
  private static texSourceDims(source: TexImageSource): { width: number; height: number } {
    const s = source as {
      videoWidth?: number; videoHeight?: number;
      naturalWidth?: number; naturalHeight?: number;
      displayWidth?: number; displayHeight?: number;
      width?: number; height?: number;
    };
    return {
      width: s.videoWidth ?? s.naturalWidth ?? s.displayWidth ?? s.width ?? 0,
      height: s.videoHeight ?? s.naturalHeight ?? s.displayHeight ?? s.height ?? 0
    };
  }

  private uploadTexImage(label: "source" | "matte", tex: WebGLTexture, source: TexImageSource): void {
    const gl = this.gl;
    this.assertContextAlive();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    // texImage2D reallocates GPU storage every call; per-frame video uploads only need the pixels
    // replaced. When the source's intrinsic size matches the texture's last allocation, upload
    // in-place with texSubImage2D (same trick the scene-compositor uses). Any size change — or an
    // unknown size — falls back to a full (re)allocation.
    const { width, height } = MediaWebGLRenderer.texSourceDims(source);
    const last = this.uploadedTexSizes.get(tex);
    const canSubUpload = width > 0 && height > 0 && last !== undefined && last.width === width && last.height === height;
    try {
      if (canSubUpload) {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
      } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
        if (width > 0 && height > 0) this.uploadedTexSizes.set(tex, { width, height });
        else this.uploadedTexSizes.delete(tex);
      }
    } catch (error) {
      this.uploadedTexSizes.delete(tex);
      if (this.isContextLost() || (error instanceof Error && /CONTEXT_LOST/i.test(error.message))) {
        this.contextLost = true;
        this.publishProducerState();
        throw new Error(MEDIA_RENDERER_CONTEXT_LOST);
      }
      throw new Error(`media-renderer: ${label} upload failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (this.isContextLost()) {
      this.contextLost = true;
      this.publishProducerState();
      throw new Error(MEDIA_RENDERER_CONTEXT_LOST);
    }
  }

  /**
   * Bake `pipeline` into a 3D LUT and upload it to the GPU. Call when the grade changes.
   * Pass `null` to disable color grading (passthrough, `u_hasLut = false`).
   * Pass `pipeline` with `previewMatte` to show the HSL-secondary matte preview.
   */
  setPipeline(pipeline: ColorPipeline | null, showMatte = false): void {
    if (this.disposed) return;
    this.assertContextAlive();
    const gl = this.gl;

    if (!pipeline || pipeline.identity) {
      this.lutSize = 0;
      return;
    }

    const lut = showMatte && pipeline.previewMatte
      ? bakeMatteLut3d(pipeline.previewMatte)
      : bakePipelineToLut3d(pipeline);

    this.lutSize = lut.size;
    gl.bindTexture(gl.TEXTURE_3D, this.lutTex);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    // draw() leaves UNPACK_FLIP_Y_WEBGL = true (needed for DOM frame uploads). Uploading
    // an ArrayBufferView with FLIP_Y / PREMULTIPLY set is INVALID_OPERATION and the upload
    // is dropped — leaving an empty LUT that texelFetch reads as (0,0,0,1) → black video.
    // LUT data is pre-laid-out and must not be flipped/premultiplied, so force these off.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage3D(
      gl.TEXTURE_3D, 0, gl.RGBA32F,
      lut.size, lut.size, lut.size,
      0, gl.RGBA, gl.FLOAT,
      mediaLut3dToRgbaFloat(lut)
    );
  }

  /**
   * The OWN WebGL2 context this renderer created (null in shared-context mode, where it borrows another's).
   * Exposed so the owner can register a governor eviction disposer against it (`registerContextDisposer`).
   */
  get governorContext(): WebGL2RenderingContext | null {
    return this.shared ? null : this.gl;
  }

  /** Render one frame. Does nothing if disposed or source has no dimensions. */
  draw(params: MediaRendererDrawParams): void {
    if (this.disposed) return;
    // Mark this context as used THIS frame so the governor's least-recently-used eviction targets genuinely
    // idle contexts (a clip scrolled out of the active window), never the one being composited right now.
    touchContext(this.gl);
    const {
      source, sourceWidth: w, sourceHeight: h,
      matte, matteInvert = false, matteOpacity = 1,
      pipeline, amount = 1, opacity = 1, mediaEffects = null, transition = null
    } = params;
    if (!this.canUpload(w, h)) return;

    const gl = this.gl;

    // lutSize is the authoritative, non-stale record of whether a non-identity LUT is
    // loaded (setPipeline sets it to 0 for identity/null). Do NOT also gate on the passed
    // `pipeline`: during playback the draw loop closes over a stale pipeline from when play
    // started, so the grade would never apply over an adjustment clip until paused.
    const hasLut = this.lutSize > 0;

    const sourceTexture = this.shared ? (params.sourceTexture ?? null) : null;
    if (!sourceTexture) {
      if (!source) return; // nothing to grade
      gl.activeTexture(gl.TEXTURE0);
      this.uploadTexImage("source", this.frameTex, source);
    }

    let hasMatte = false;
    if (matte) {
      const matteSource = matte as { videoWidth?: number; naturalWidth?: number; width?: number; videoHeight?: number; naturalHeight?: number; height?: number };
      const mw = params.matteWidth ?? matteSource.videoWidth ?? matteSource.naturalWidth ?? matteSource.width ?? 0;
      const mh = params.matteHeight ?? matteSource.videoHeight ?? matteSource.naturalHeight ?? matteSource.height ?? 0;
      if (this.canUpload(mw, mh)) {
        gl.activeTexture(gl.TEXTURE2);
        this.uploadTexImage("matte", this.matteTex, matte);
        hasMatte = true;
      }
    }

    if (this.shared) {
      const target = params.target;
      if (!target) throw new Error("media-renderer: shared-context draw() requires params.target");
      target.resize(w, h);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    } else if (this._canvas!.width !== w || this._canvas!.height !== h) {
      this._canvas!.width = w;
      this._canvas!.height = h;
      this.publishProducerState();
    }

    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);

    // Source frame → TEXTURE0 (an existing shared-context texture, or the uploaded frame).
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sourceTexture ?? this.frameTex);
    gl.uniform1i(this.uFrame, 0);

    // 3D LUT → TEXTURE1
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, this.lutTex);
    gl.uniform1i(this.uLut, 1);
    gl.uniform1f(this.uLutSize, this.lutSize);
    gl.uniform1f(this.uAmount, Math.max(0, Math.min(1, amount)));
    gl.uniform1i(this.uHasLut, hasLut ? 1 : 0);

    // Luma matte → TEXTURE2
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.matteTex);
    gl.uniform1i(this.uMatte, 2);
    gl.uniform1i(this.uHasMatte, hasMatte ? 1 : 0);
    gl.uniform1i(this.uMatteInvert, matteInvert ? 1 : 0);
    gl.uniform1f(this.uMatteOpacity, Math.max(0, Math.min(1, matteOpacity)));

    gl.uniform1f(this.uOpacity, Math.max(0, Math.min(1, opacity)));

    // Pro stylize effects — single-pass, branch-gated so identity layers pay nothing.
    // Every uniform is written on EVERY draw (identity values when absent): the program can be
    // shared across many layers on one context, so stale uniforms must never leak between draws.
    const vignette = mediaEffects?.vignette ?? null;
    gl.uniform1i(this.uHasVignette, vignette ? 1 : 0);
    gl.uniform1f(this.uVigAmount, vignette ? Math.max(0, Math.min(1, vignette.amount)) : 0);
    gl.uniform1f(this.uVigSize, vignette ? Math.max(0, Math.min(1, vignette.size)) : 0);
    gl.uniform1f(this.uVigFeather, vignette ? Math.max(0, Math.min(1, vignette.feather)) : 1);
    gl.uniform1f(this.uVigRound, vignette ? Math.max(0, Math.min(1, vignette.roundness)) : 0);
    gl.uniform1f(this.uVigHighlights, vignette ? Math.max(0, Math.min(1, vignette.highlights)) : 0);
    gl.uniform1f(this.uAspect, h > 0 ? w / h : 1);

    const grain = mediaEffects?.grain ?? null;
    gl.uniform1i(this.uHasGrain, grain ? 1 : 0);
    gl.uniform1f(this.uGrainAmount, grain ? Math.max(0, Math.min(1, grain.amount)) : 0);
    gl.uniform1f(this.uGrainSize, grain ? Math.max(0.25, Math.min(4, grain.size)) : 1);
    gl.uniform1f(this.uTime, mediaEffects?.timeSeconds ?? 0);

    const chroma = mediaEffects?.chromaKey ?? null;
    gl.uniform1i(this.uHasChroma, chroma ? 1 : 0);
    if (chroma) {
      gl.uniform3f(this.uChromaColor, chroma.color[0], chroma.color[1], chroma.color[2]);
      gl.uniform1f(this.uChromaTol, Math.max(0, Math.min(2, chroma.tolerance)));
      gl.uniform1f(this.uChromaSoft, Math.max(0, Math.min(1, chroma.softness)));
      gl.uniform1f(this.uChromaDespill, Math.max(0, Math.min(1, chroma.despill)));
      gl.uniform1f(this.uChromaChoke, Math.max(0, Math.min(0.99, chroma.choke)));
      gl.uniform1i(this.uChromaMatteView, chroma.matteView ? 1 : 0);
    } else {
      gl.uniform3f(this.uChromaColor, 0, 0, 0);
      gl.uniform1f(this.uChromaTol, 0);
      gl.uniform1f(this.uChromaSoft, 0);
      gl.uniform1f(this.uChromaDespill, 0);
      gl.uniform1f(this.uChromaChoke, 0);
      gl.uniform1i(this.uChromaMatteView, 0);
    }

    // Transition reveal (wipe / iris / dip) on the incoming clip.
    const transitionKind = transition ? TRANSITION_KIND_INDEX[transition.kind] : 0;
    gl.uniform1i(this.uTransitionKind, transitionKind);
    gl.uniform1f(this.uTransitionProgress, transition ? Math.max(0, Math.min(1, transition.progress)) : 1);
    gl.uniform1i(this.uTransitionDir, transition ? TRANSITION_DIR_INDEX[transition.direction] : 1);
    gl.uniform1i(this.uTransitionMode, transition && transition.mode === "out" ? 1 : 0);
    gl.uniform1f(this.uTransitionSoft, transition ? Math.max(0, Math.min(1, transition.softness)) : 0);
    const dipColor = transition?.color ?? [0, 0, 0];
    gl.uniform3f(this.uTransitionColor, dipColor[0], dipColor[1], dipColor[2]);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.assertContextAlive();
    gl.bindVertexArray(null);
    // Shared mode: restore the default framebuffer so the borrowed context isn't left bound to our target.
    if (this.shared) gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.publishProducerState();
  }

  /**
   * Read this renderer's last-rendered RGBA8 pixels (bottom-left origin, like `gl.readPixels`) into `out`.
   * Own-canvas mode reads the canvas's default framebuffer; shared-context mode reads the provided `target`.
   * Diagnostic/test helper (e.g. the shared-context parity probe) — not used on the render hot path.
   */
  readPixelsInto(out: Uint8Array, width: number, height: number, target?: RenderTarget | null): void {
    if (this.disposed) return;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, out);
    if (target) gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.publishProducerState();
    const gl = this.gl;
    gl.deleteTexture(this.frameTex);
    gl.deleteTexture(this.matteTex);
    gl.deleteTexture(this.lutTex);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.program);
    // Own-canvas mode created the context → release it when its canvas is detached. Shared-context mode borrows
    // the caller's context (shared with the SceneCompositor) → only our GL objects above are ours to delete;
    // losing the context here would break the caller, so we don't.
    if (!this.shared) releaseContextIfDetached(gl);
  }
}
