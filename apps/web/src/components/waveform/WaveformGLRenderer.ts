/**
 * WaveformGLRenderer (Phase 2B) — an imperative WebGL2 surface that draws every visible audio
 * clip's waveform in a handful of instanced draw calls (one per distinct source texture), instead
 * of one <canvas> per clip. Textures are uploaded once per source and reused across frames
 * (GPU buffer reuse); only viewport-visible clips are handed in (culling happens in the caller).
 *
 * Visual output mirrors the frozen Phase-1 Canvas renderer (see waveformGL.glsl.ts). This is
 * flag-gated (default off) with the Canvas path as the permanent fallback, so it never affects
 * production unless explicitly enabled.
 */

import type { HiresPeaks } from "../../lib/audioPeaks";
import { WAVEFORM_FRAG, WAVEFORM_VERT } from "./waveformGL.glsl";

export type WaveInstance = {
  sourceId: string;
  x: number; // viewport px (content x - scrollLeft)
  width: number; // px
  laneTop: number; // canvas-space px
  laneHeight: number; // px
  inFrac: number;
  outFrac: number;
  tint: [number, number, number]; // 0..1
  stateAlpha: number;
};

type SourceTexture = { tex: WebGLTexture; width: number; lastUsed: number };

const FLOATS_PER_INSTANCE = 10; // aRect(4) + aTrim(2) + aTint(3) + aState(1)
const MAX_SOURCE_TEXTURES = 64;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("waveform-gl: createShader failed");
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`waveform-gl: shader compile failed: ${log ?? "unknown"}`);
  }
  return shader;
}

export class WaveformGLRenderer {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private quadBuffer: WebGLBuffer;
  private instanceBuffer: WebGLBuffer;
  private vao: WebGLVertexArrayObject;
  private uViewport: WebGLUniformLocation | null;
  private uSampler: WebGLUniformLocation | null;
  private uTexWidth: WebGLUniformLocation | null;
  private textures = new Map<string, SourceTexture>();
  private instances: WaveInstance[] = [];
  private useCounter = 0;
  private lost = false;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: false, antialias: false, depth: false });
    if (!gl) throw new Error("waveform-gl: webgl2 unavailable");
    this.gl = gl;

    canvas.addEventListener("webglcontextlost", this.onContextLost);
    canvas.addEventListener("webglcontextrestored", this.onContextRestored);

    const program = gl.createProgram();
    if (!program) throw new Error("waveform-gl: createProgram failed");
    const vs = compile(gl, gl.VERTEX_SHADER, WAVEFORM_VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, WAVEFORM_FRAG);
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`waveform-gl: link failed: ${gl.getProgramInfoLog(program) ?? "unknown"}`);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    this.program = program;
    this.uViewport = gl.getUniformLocation(program, "uViewport");
    this.uSampler = gl.getUniformLocation(program, "uSampler");
    this.uTexWidth = gl.getUniformLocation(program, "uTexWidth");

    const quad = gl.createBuffer();
    const instance = gl.createBuffer();
    const vao = gl.createVertexArray();
    if (!quad || !instance || !vao) throw new Error("waveform-gl: buffer/vao alloc failed");
    this.quadBuffer = quad;
    this.instanceBuffer = instance;
    this.vao = vao;

    gl.bindVertexArray(vao);
    // Unit quad (triangle strip): (0,0) (1,0) (0,1) (1,1)
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // Instance buffer layout (stride = 10 floats)
    const stride = FLOATS_PER_INSTANCE * 4;
    gl.bindBuffer(gl.ARRAY_BUFFER, instance);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 0); // aRect
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 16); // aTrim
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 3, gl.FLOAT, false, stride, 24); // aTint
    gl.vertexAttribDivisor(3, 1);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 1, gl.FLOAT, false, stride, 36); // aState
    gl.vertexAttribDivisor(4, 1);
    gl.bindVertexArray(null);
  }

  get maxTextureSize(): number {
    return this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) as number;
  }

  hasSource(id: string): boolean {
    return this.textures.has(id);
  }

  /** Upload (or refresh) a source's min/max/rms level into a 1×N RGBA8 texture (R=max, G=rms,
   * B=|min| — the negative excursion magnitude). Idempotent per id. */
  uploadSource(id: string, level: HiresPeaks): void {
    if (this.lost) return;
    const gl = this.gl;
    const existing = this.textures.get(id);
    if (existing && existing.width === level.max.length) {
      existing.lastUsed = ++this.useCounter;
      return;
    }
    const width = level.max.length;
    const data = new Uint8Array(width * 4);
    for (let i = 0; i < width; i += 1) {
      data[i * 4] = Math.max(0, Math.min(255, Math.round((level.max[i] ?? 0) * 255)));
      data[i * 4 + 1] = Math.max(0, Math.min(255, Math.round((level.rms[i] ?? 0) * 255)));
      data[i * 4 + 2] = Math.max(0, Math.min(255, Math.round(-(level.min[i] ?? 0) * 255)));
      data[i * 4 + 3] = 255;
    }
    const tex = existing?.tex ?? gl.createTexture();
    if (!tex) return;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    // NEAREST, not LINEAR: the fragment shader does its own MAX over each pixel's texel span, so it
    // needs the RAW texel values. LINEAR pre-blended neighbouring texels, so the MAX only ever saw
    // already-averaged samples — peaks got smoothed away and the waveform read softer/blurrier than
    // the Canvas path (which MAXes raw Float32 samples). NEAREST preserves extrema, matching Canvas.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.textures.set(id, { tex, width, lastUsed: ++this.useCounter });
    this.evictTextures();
  }

  private evictTextures(): void {
    while (this.textures.size > MAX_SOURCE_TEXTURES) {
      let oldestKey: string | null = null;
      let oldest = Infinity;
      for (const [key, value] of this.textures) {
        if (value.lastUsed < oldest) {
          oldest = value.lastUsed;
          oldestKey = key;
        }
      }
      if (!oldestKey) break;
      const victim = this.textures.get(oldestKey);
      if (victim) this.gl.deleteTexture(victim.tex);
      this.textures.delete(oldestKey);
    }
  }

  setInstances(items: WaveInstance[]): void {
    this.instances = items;
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    const w = Math.max(1, Math.round(cssWidth * dpr));
    const h = Math.max(1, Math.round(cssHeight * dpr));
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
  }

  /** Draw all visible instances. `scissorLeftPx`/`gutter` clips out the sticky track-label gutter. */
  render(gutterLeftCss: number, dpr: number): void {
    if (this.lost) return;
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (this.instances.length === 0) return;

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    // Scissor out the sticky label gutter (viewport-left band).
    const gutterPx = Math.max(0, Math.round(gutterLeftCss * dpr));
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(gutterPx, 0, Math.max(0, this.canvas.width - gutterPx), this.canvas.height);

    gl.useProgram(this.program);
    gl.uniform2f(this.uViewport, this.canvas.width, this.canvas.height);
    gl.uniform1i(this.uSampler, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(this.vao);

    // Group instances by source so each distinct texture is bound once.
    const bySource = new Map<string, WaveInstance[]>();
    for (const inst of this.instances) {
      const arr = bySource.get(inst.sourceId);
      if (arr) arr.push(inst);
      else bySource.set(inst.sourceId, [inst]);
    }

    for (const [sourceId, group] of bySource) {
      const texture = this.textures.get(sourceId);
      if (!texture) continue;
      texture.lastUsed = ++this.useCounter;
      gl.bindTexture(gl.TEXTURE_2D, texture.tex);
      gl.uniform1f(this.uTexWidth, texture.width);

      const data = new Float32Array(group.length * FLOATS_PER_INSTANCE);
      for (let i = 0; i < group.length; i += 1) {
        const g = group[i]!;
        const o = i * FLOATS_PER_INSTANCE;
        data[o] = g.x * dpr;
        data[o + 1] = g.width * dpr;
        data[o + 2] = g.laneTop * dpr;
        data[o + 3] = g.laneHeight * dpr;
        data[o + 4] = g.inFrac;
        data[o + 5] = g.outFrac;
        data[o + 6] = g.tint[0];
        data[o + 7] = g.tint[1];
        data[o + 8] = g.tint[2];
        data[o + 9] = g.stateAlpha;
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, group.length);
    }

    gl.bindVertexArray(null);
    gl.disable(gl.SCISSOR_TEST);
  }

  private onContextLost = (event: Event) => {
    event.preventDefault();
    this.lost = true;
    this.textures.clear();
  };

  private onContextRestored = () => {
    // Callers re-upload sources on the next frame via uploadSource(); just clear the lost flag.
    this.lost = false;
  };

  dispose(): void {
    const gl = this.gl;
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
    for (const { tex } of this.textures.values()) gl.deleteTexture(tex);
    this.textures.clear();
    gl.deleteBuffer(this.quadBuffer);
    gl.deleteBuffer(this.instanceBuffer);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.program);
  }
}
