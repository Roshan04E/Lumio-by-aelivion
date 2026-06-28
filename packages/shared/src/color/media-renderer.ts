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
import { MEDIA_FRAGMENT_SHADER, MEDIA_VERTEX_SHADER, mediaLut3dToRgbaFloat } from "./media-shader";
import type { ColorPipeline, MediaEffects } from "./types";

export interface MediaRendererDrawParams {
  /** Decoded video frame, image element, or ImageBitmap — the graded source. */
  source: TexImageSource;
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
}

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
  if (!shader) throw new Error("media-renderer: failed to create shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
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
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly frameTex: WebGLTexture;
  private readonly matteTex: WebGLTexture;
  private readonly lutTex: WebGLTexture;

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
  private readonly uHasGrain: WebGLUniformLocation | null;
  private readonly uGrainAmount: WebGLUniformLocation | null;
  private readonly uTime: WebGLUniformLocation | null;
  private readonly uHasChroma: WebGLUniformLocation | null;
  private readonly uChromaColor: WebGLUniformLocation | null;
  private readonly uChromaTol: WebGLUniformLocation | null;
  private readonly uChromaSoft: WebGLUniformLocation | null;
  private readonly uTransitionKind: WebGLUniformLocation | null;
  private readonly uTransitionProgress: WebGLUniformLocation | null;
  private readonly uTransitionDir: WebGLUniformLocation | null;
  private readonly uTransitionMode: WebGLUniformLocation | null;
  private readonly uTransitionSoft: WebGLUniformLocation | null;
  private readonly uTransitionColor: WebGLUniformLocation | null;

  private lutSize = 0;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas) {
    this.canvas = canvas;
    // preserveDrawingBuffer keeps the last frame on the canvas between draws. Without it the browser
    // discards the (alpha) buffer after each composite, so a single skipped/late draw — exactly at a
    // clip swap or before the incoming clip's draw loop ticks — flashes transparent for one frame
    // (the flicker). Each draw() still clears+redraws, so output is unchanged when we do draw.
    const gl = canvas.getContext("webgl2", { premultipliedAlpha: false, alpha: true, preserveDrawingBuffer: true }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error("media-renderer: WebGL2 unavailable");
    this.gl = gl;

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
    this.uHasGrain = gl.getUniformLocation(program, "u_hasGrain");
    this.uGrainAmount = gl.getUniformLocation(program, "u_grainAmount");
    this.uTime = gl.getUniformLocation(program, "u_time");
    this.uHasChroma = gl.getUniformLocation(program, "u_hasChroma");
    this.uChromaColor = gl.getUniformLocation(program, "u_chromaColor");
    this.uChromaTol = gl.getUniformLocation(program, "u_chromaTol");
    this.uChromaSoft = gl.getUniformLocation(program, "u_chromaSoft");
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
  }

  /**
   * Bake `pipeline` into a 3D LUT and upload it to the GPU. Call when the grade changes.
   * Pass `null` to disable color grading (passthrough, `u_hasLut = false`).
   * Pass `pipeline` with `previewMatte` to show the HSL-secondary matte preview.
   */
  setPipeline(pipeline: ColorPipeline | null, showMatte = false): void {
    if (this.disposed) return;
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

  /** Render one frame. Does nothing if disposed or source has no dimensions. */
  draw(params: MediaRendererDrawParams): void {
    if (this.disposed) return;
    const {
      source, sourceWidth: w, sourceHeight: h,
      matte, matteInvert = false, matteOpacity = 1,
      pipeline, amount = 1, opacity = 1, mediaEffects = null, transition = null
    } = params;
    if (w === 0 || h === 0) return;

    const gl = this.gl;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }

    // lutSize is the authoritative, non-stale record of whether a non-identity LUT is
    // loaded (setPipeline sets it to 0 for identity/null). Do NOT also gate on the passed
    // `pipeline`: during playback the draw loop closes over a stale pipeline from when play
    // started, so the grade would never apply over an adjustment clip until paused.
    const hasLut = this.lutSize > 0;

    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);

    // Source frame → TEXTURE0
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.frameTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.uniform1i(this.uFrame, 0);

    // 3D LUT → TEXTURE1
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, this.lutTex);
    gl.uniform1i(this.uLut, 1);
    gl.uniform1f(this.uLutSize, this.lutSize);
    gl.uniform1f(this.uAmount, Math.max(0, Math.min(1, amount)));
    gl.uniform1i(this.uHasLut, hasLut ? 1 : 0);

    // Luma matte → TEXTURE2
    const hasMatte = Boolean(matte);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.matteTex);
    if (matte) {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, matte);
    }
    gl.uniform1i(this.uMatte, 2);
    gl.uniform1i(this.uHasMatte, hasMatte ? 1 : 0);
    gl.uniform1i(this.uMatteInvert, matteInvert ? 1 : 0);
    gl.uniform1f(this.uMatteOpacity, Math.max(0, Math.min(1, matteOpacity)));

    gl.uniform1f(this.uOpacity, Math.max(0, Math.min(1, opacity)));

    // Pro stylize effects — single-pass, branch-gated so identity layers pay nothing.
    const vignette = mediaEffects?.vignette ?? null;
    gl.uniform1i(this.uHasVignette, vignette ? 1 : 0);
    gl.uniform1f(this.uVigAmount, vignette ? Math.max(0, Math.min(1, vignette.amount)) : 0);
    gl.uniform1f(this.uVigSize, vignette ? Math.max(0, Math.min(1, vignette.size)) : 0);

    const grain = mediaEffects?.grain ?? null;
    gl.uniform1i(this.uHasGrain, grain ? 1 : 0);
    gl.uniform1f(this.uGrainAmount, grain ? Math.max(0, Math.min(1, grain.amount)) : 0);
    gl.uniform1f(this.uTime, mediaEffects?.timeSeconds ?? 0);

    const chroma = mediaEffects?.chromaKey ?? null;
    gl.uniform1i(this.uHasChroma, chroma ? 1 : 0);
    if (chroma) {
      gl.uniform3f(this.uChromaColor, chroma.color[0], chroma.color[1], chroma.color[2]);
      gl.uniform1f(this.uChromaTol, Math.max(0, Math.min(1, chroma.tolerance)));
      gl.uniform1f(this.uChromaSoft, Math.max(0, Math.min(1, chroma.softness)));
    } else {
      gl.uniform3f(this.uChromaColor, 0, 0, 0);
      gl.uniform1f(this.uChromaTol, 0);
      gl.uniform1f(this.uChromaSoft, 0);
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
    gl.bindVertexArray(null);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    gl.deleteTexture(this.frameTex);
    gl.deleteTexture(this.matteTex);
    gl.deleteTexture(this.lutTex);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.program);
  }
}
