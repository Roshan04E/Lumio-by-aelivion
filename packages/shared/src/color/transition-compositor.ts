/**
 * Unified GPU transition engine — the two-texture mix compositor.
 *
 * A standalone WebGL2 program that consumes two ALREADY-GRADED frames (each a `MediaWebGLRenderer` canvas,
 * or any TexImageSource) and
 * runs a per-transition fragment shader to produce the blended result. One instance is reused across
 * windows/transitions; programs are compiled once per transition id and cached.
 *
 * CONSUMERS (2026-07): only the editor's DOM-fallback `TransitionOverlay` (TransitionLayer.tsx) still
 * instantiates this class. The scene-compositor path — default preview, browser export, and Remotion —
 * compiles the SAME assembled shaders (`buildTransitionFragmentShader`) inside `SceneCompositor`
 * (`drawTransition`, sides nest-pre-composed with full transforms), which is what keeps the renderers
 * pixel-identical. The fallback overlay pre-bakes each side's transform before calling `draw`.
 *
 * Context attributes / unpack flags mirror `MediaWebGLRenderer` exactly (premultipliedAlpha:false,
 * UNPACK_FLIP_Y=true, no premultiply) so the mix operates on the same straight-alpha sRGB pixels the
 * per-clip path already produces.
 */

import {
  buildTransitionFragmentShader,
  resolveTransitionParams,
  type TransitionDefinition,
  type TransitionParam
} from "./transitions/registry";
import { releaseContextIfDetached } from "./gl-context";

const VERTEX_SHADER = `#version 300 es
in vec2 a_position;
out vec2 v_uv;
void main(){
  v_uv = a_position * 0.5 + 0.5;          // (0,0) bottom-left … (1,1) top-left, matches FLIP_Y upload
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

export interface TransitionDrawParams {
  /** Outgoing clip, ALREADY GRADED. */
  from: TexImageSource;
  /** Incoming clip, ALREADY GRADED. */
  to: TexImageSource;
  /** Output (composition) size. */
  width: number;
  height: number;
  /** Transition definition id (selects the cached program). */
  transitionId: string;
  /** EASED progress 0..1 (caller applies the definition's easing curve). */
  progress: number;
  /** Resolved param values keyed by param name. Missing params fall back to the definition default. */
  params?: Record<string, number | number[] | boolean> | undefined;
  /** Object-fit for the outgoing/incoming clip, so the mix matches each clip's normal rendering. Default cover. */
  fromFit?: "cover" | "contain" | "fill" | undefined;
  toFit?: "cover" | "contain" | "fill" | undefined;
}

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

/**
 * Object-fit uv scale: how to scale uv (about centre) so a `sw×sh` source fills a `dw×dh` box with `fit`.
 * cover shrinks the over-long axis (crops; result ≤ 1), contain grows the short axis (letterboxes), fill = [1,1].
 */
function fitScale(sw: number, sh: number, dw: number, dh: number, fit: "cover" | "contain" | "fill"): [number, number] {
  if (fit === "fill" || sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) return [1, 1];
  const srcA = sw / sh;
  const dstA = dw / dh;
  if (fit === "contain") {
    return srcA < dstA ? [dstA / srcA, 1] : [1, srcA / dstA];
  }
  // cover
  return srcA < dstA ? [1, srcA / dstA] : [dstA / srcA, 1];
}

function sourceWidth(s: TexImageSource): number {
  return (s as { width?: number; videoWidth?: number; naturalWidth?: number }).videoWidth
    ?? (s as { naturalWidth?: number }).naturalWidth
    ?? (s as { width?: number }).width
    ?? 0;
}
function sourceHeight(s: TexImageSource): number {
  return (s as { height?: number; videoHeight?: number; naturalHeight?: number }).videoHeight
    ?? (s as { naturalHeight?: number }).naturalHeight
    ?? (s as { height?: number }).height
    ?? 0;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("transition-compositor: createShader failed");
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`transition-compositor: shader compile failed: ${log ?? "unknown"}`);
  }
  return shader;
}

function make2dTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error("transition-compositor: texture alloc failed");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return tex;
}

export class TransitionCompositor {
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  private readonly gl: WebGL2RenderingContext;
  private readonly vao: WebGLVertexArrayObject;
  private readonly vbo: WebGLBuffer;
  private readonly vs: WebGLShader;
  private readonly texFrom: WebGLTexture;
  private readonly texTo: WebGLTexture;
  private readonly programs = new Map<string, CompiledTransition>();
  private disposed = false;

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", { premultipliedAlpha: false, alpha: true }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error("transition-compositor: WebGL2 unavailable");
    this.gl = gl;

    this.vs = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);

    const vao = gl.createVertexArray();
    const vbo = gl.createBuffer();
    if (!vao || !vbo) throw new Error("transition-compositor: buffer alloc failed");
    this.vao = vao;
    this.vbo = vbo;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    // Fullscreen triangle.
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.bindVertexArray(null);

    this.texFrom = make2dTexture(gl);
    this.texTo = make2dTexture(gl);
  }

  /** Compile + cache the program for a definition ahead of time (pre-warm to avoid a hitch at the cut). */
  prepare(def: TransitionDefinition): CompiledTransition {
    const existing = this.programs.get(def.id);
    if (existing) return existing;
    const gl = this.gl;
    const fs = compile(gl, gl.FRAGMENT_SHADER, buildTransitionFragmentShader(def));
    const program = gl.createProgram();
    if (!program) throw new Error("transition-compositor: createProgram failed");
    gl.attachShader(program, this.vs);
    gl.attachShader(program, fs);
    // a_position is location 0 across all transition programs (shared VS).
    gl.bindAttribLocation(program, 0, "a_position");
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      gl.deleteShader(fs);
      throw new Error(`transition-compositor: link failed (${def.id}): ${log ?? "unknown"}`);
    }
    gl.deleteShader(fs);

    const compiled: CompiledTransition = {
      program,
      uFrom: gl.getUniformLocation(program, "uFrom"),
      uTo: gl.getUniformLocation(program, "uTo"),
      uProgress: gl.getUniformLocation(program, "progress"),
      uResolution: gl.getUniformLocation(program, "resolution"),
      uRatio: gl.getUniformLocation(program, "ratio"),
      uFromFit: gl.getUniformLocation(program, "uFromFit"),
      uToFit: gl.getUniformLocation(program, "uToFit"),
      params: def.params.map((param) => ({ param, location: gl.getUniformLocation(program, param.name) }))
    };
    this.programs.set(def.id, compiled);
    return compiled;
  }

  draw(def: TransitionDefinition, params: TransitionDrawParams): void {
    if (this.disposed) return;
    const gl = this.gl;
    const { from, to, width, height, progress } = params;
    if (width <= 0 || height <= 0) return;

    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }

    const compiled = this.prepare(def);
    const resolved = resolveTransitionParams(def, params.params);

    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);

    gl.useProgram(compiled.program);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // texFrom → unit 0, texTo → unit 1.
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texFrom);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, from);
    gl.uniform1i(compiled.uFrom, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.texTo);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, to);
    gl.uniform1i(compiled.uTo, 1);

    gl.uniform1f(compiled.uProgress, Math.max(0, Math.min(1, progress)));
    gl.uniform2f(compiled.uResolution, width, height);
    gl.uniform1f(compiled.uRatio, height > 0 ? width / height : 1);

    // Object-fit uv scale per source so the mix renders each clip exactly as it renders normally.
    const fromS = fitScale(sourceWidth(from), sourceHeight(from), width, height, params.fromFit ?? "cover");
    const toS = fitScale(sourceWidth(to), sourceHeight(to), width, height, params.toFit ?? "cover");
    gl.uniform2f(compiled.uFromFit, fromS[0], fromS[1]);
    gl.uniform2f(compiled.uToFit, toS[0], toS[1]);

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

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    for (const compiled of this.programs.values()) gl.deleteProgram(compiled.program);
    this.programs.clear();
    gl.deleteShader(this.vs);
    gl.deleteTexture(this.texFrom);
    gl.deleteTexture(this.texTo);
    gl.deleteBuffer(this.vbo);
    gl.deleteVertexArray(this.vao);
    releaseContextIfDetached(gl);
  }
}
