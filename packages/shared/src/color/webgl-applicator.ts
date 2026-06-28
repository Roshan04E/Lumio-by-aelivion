/**
 * Professional Color System (Phase 3) — WebGL2 color applicator (the high-end engine).
 * Shared by both renderers (both are Chromium) so the program is byte-identical →
 * parity by construction. Uploads a baked 3D LUT as a float `sampler3D` and draws a
 * source frame (image / video / canvas) through the shader to an output canvas. Uses
 * manual trilinear (texelFetch) so it needs no float-linear filtering extension.
 *
 * The renderer creates one applicator per color-graded layer, calls `setLut()` when the
 * grade changes, and `draw()` per frame; if `isWebgl2ColorSupported()` is false it should
 * fall back to the SVG filter path (same pipeline, lower fidelity).
 */

import { COLOR_FRAGMENT_SHADER, COLOR_VERTEX_SHADER, lut3dToRgbaFloat } from "./shader";
import type { Lut3d } from "./lut3d";

export type ColorCanvas = HTMLCanvasElement | OffscreenCanvas;

/** Cheap feature probe — true when a WebGL2 context with float textures is creatable. */
export function isWebgl2ColorSupported(): boolean {
  try {
    if (typeof document === "undefined") return false;
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2");
    return Boolean(gl);
  } catch {
    return false;
  }
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("color: failed to create shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`color: shader compile failed: ${log ?? "unknown"}`);
  }
  return shader;
}

export class WebglColorApplicator {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly frameTex: WebGLTexture;
  private readonly lutTex: WebGLTexture;
  private readonly vao: WebGLVertexArrayObject;
  private readonly uFrame: WebGLUniformLocation | null;
  private readonly uLut: WebGLUniformLocation | null;
  private readonly uLutSize: WebGLUniformLocation | null;
  private readonly uAmount: WebGLUniformLocation | null;
  private lutSize = 0;
  private disposed = false;

  constructor(private readonly canvas: ColorCanvas) {
    // preserveDrawingBuffer: retain the last frame between draws so a skipped/late draw never flashes
    // transparent (the one-frame flicker at clip transitions). Each draw still clears+redraws.
    const gl = (canvas.getContext("webgl2", { premultipliedAlpha: false, alpha: true, preserveDrawingBuffer: true }) as WebGL2RenderingContext | null);
    if (!gl) throw new Error("color: WebGL2 unavailable");
    this.gl = gl;

    const vs = compile(gl, gl.VERTEX_SHADER, COLOR_VERTEX_SHADER);
    const fs = compile(gl, gl.FRAGMENT_SHADER, COLOR_FRAGMENT_SHADER);
    const program = gl.createProgram();
    if (!program) throw new Error("color: failed to create program");
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      throw new Error(`color: program link failed: ${log ?? "unknown"}`);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    this.program = program;

    this.uFrame = gl.getUniformLocation(program, "u_frame");
    this.uLut = gl.getUniformLocation(program, "u_lut");
    this.uLutSize = gl.getUniformLocation(program, "u_lutSize");
    this.uAmount = gl.getUniformLocation(program, "u_amount");

    // Fullscreen triangle/quad.
    const vao = gl.createVertexArray();
    if (!vao) throw new Error("color: failed to create VAO");
    this.vao = vao;
    gl.bindVertexArray(vao);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, "a_position");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.frameTex = this.makeTexture();
    this.lutTex = gl.createTexture()!;
  }

  private makeTexture(): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture();
    if (!tex) throw new Error("color: failed to create texture");
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return tex;
  }

  /** Upload a baked LUT as a float 3D texture (NEAREST — trilinear is done in-shader). */
  setLut(lut: Lut3d): void {
    const gl = this.gl;
    this.lutSize = lut.size;
    gl.bindTexture(gl.TEXTURE_3D, this.lutTex);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    // ArrayBufferView uploads must not have FLIP_Y / PREMULTIPLY set (INVALID_OPERATION,
    // upload dropped → black). draw() sets FLIP_Y true for the DOM frame; force it off here.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA32F, lut.size, lut.size, lut.size, 0, gl.RGBA, gl.FLOAT, lut3dToRgbaFloat(lut));
  }

  /** Draw `source` through the LUT to the canvas. `amount` (0..1) blends toward the grade. */
  draw(source: TexImageSource, width: number, height: number, amount = 1): void {
    if (this.disposed || this.lutSize === 0) return;
    const gl = this.gl;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.frameTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.uniform1i(this.uFrame, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, this.lutTex);
    gl.uniform1i(this.uLut, 1);
    gl.uniform1f(this.uLutSize, this.lutSize);
    gl.uniform1f(this.uAmount, Math.max(0, Math.min(1, amount)));

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    gl.deleteTexture(this.frameTex);
    gl.deleteTexture(this.lutTex);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.program);
  }
}
