/**
 * Shared WebGL2 plumbing for the single GPU compositor (Method 3, Phase 1).
 *
 * The existing GPU bricks (`MediaWebGLRenderer`, `TransitionCompositor`) each re-implement the same
 * boilerplate: context creation with
 * `premultipliedAlpha:false`, a shader `compile()` helper, a `make2dTexture()`, and a fullscreen
 * triangle. This module centralizes that, and adds the new piece Phase 1 needs that none of them
 * have: **render-to-texture targets** (`RenderTarget`) so the compositor can ping-pong an
 * accumulator and blend each layer against the running result in-shader.
 *
 * Context attributes mirror the bricks exactly (`premultipliedAlpha:false`, straight-alpha sRGB)
 * so a texture uploaded here is byte-identical to one uploaded by `MediaWebGLRenderer` — that
 * sameness is what keeps the unified pass pixel-aligned with the per-clip path it replaces.
 */

/** A 2D off-screen canvas (DOM `<canvas>` on the main thread, `OffscreenCanvas` in a worker). */
export type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

/**
 * Live WebGL2 context budget telemetry.
 *
 * Browsers cap concurrent WebGL contexts (~16) and evict the OLDEST when exceeded, which during a
 * main-thread scene export surfaces as "Can't upload from a lost WebGL context" spam + a degraded preview.
 * This approximate live count lets the export budget (the media-renderer pool + threshold warn + the stress
 * gate) reason about how close we are to the cap. Contexts are created at two sites — `createGl` (the scene
 * compositor) and `MediaWebGLRenderer`'s direct `getContext` — both of which call `noteGlContextCreated`;
 * the single free choke point `releaseContextIfDetached` calls `noteGlContextDisposed` when it actually loses
 * a context. The count is approximate: a still-connected DOM canvas reused across a compositor rebuild
 * over-counts (its context genuinely persists), which is fine — every export context is a throwaway
 * `OffscreenCanvas` that IS freed via `loseContext`, so the export-time count is accurate.
 */
let activeGlContexts = 0;

export function noteGlContextCreated(): void {
  activeGlContexts += 1;
}

export function noteGlContextDisposed(): void {
  activeGlContexts = Math.max(0, activeGlContexts - 1);
}

export function getActiveGlContextCount(): number {
  return activeGlContexts;
}

/**
 * Fullscreen-triangle vertex shader: positions come from a single oversized triangle and `v_uv`
 * runs (0,0) bottom-left … (1,1) top-left, which is the convention every brick uses after a
 * `UNPACK_FLIP_Y` upload (see `transition-compositor.ts` VERTEX_SHADER comment).
 */
export const FULLSCREEN_TRI_VS = `#version 300 es
in vec2 a_position;
out vec2 v_uv;
void main(){
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

/** The 3 clip-space vertices of the oversized fullscreen triangle. */
export const FULLSCREEN_TRI_VERTS = new Float32Array([-1, -1, 3, -1, -1, 3]);

/**
 * Release a WebGL2 context on teardown — but ONLY when its canvas is being discarded.
 *
 * Browsers cap live WebGL contexts (~16) and reclaim a dropped one only on GC, so a per-instance renderer
 * (one per media layer, region clone, pooled grade/transition) that doesn't free its context leaks one on
 * every unmount; past the cap the browser force-loses the OLDEST context → a frozen/blank graded canvas
 * (the stale region-blur frame). `loseContext()` frees it immediately.
 *
 * BUT `loseContext()` is PERMANENT: once lost, `canvas.getContext("webgl2")` keeps returning the dead
 * context. A persistent DOM canvas that's merely being RECREATED (e.g. `ScenePreviewCanvas` rebuilding the
 * compositor on a comp-size change) or hot-reloaded stays in the DOM and is reused — losing its context
 * then breaks the next construction ("shader compile failed"). So only release when the canvas is DETACHED
 * (`isConnected === false` → truly unmounted). An `OffscreenCanvas` (export / pooled scratch) has no
 * `isConnected` and is always throwaway → release it too.
 */
export function releaseContextIfDetached(gl: WebGL2RenderingContext): void {
  const connected = (gl.canvas as { isConnected?: boolean }).isConnected;
  if (connected === true) return; // still in the DOM → will be reused; a lost context can't be re-acquired
  try {
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    noteGlContextDisposed();
  } catch {
    /* ignore */
  }
}

export function createGl(canvas: AnyCanvas): WebGL2RenderingContext {
  const gl = canvas.getContext("webgl2", {
    premultipliedAlpha: false,
    alpha: true,
    preserveDrawingBuffer: true,
    // antialias:false keeps the default framebuffer SINGLE-sample. With the default (true) it is
    // multisampled, and blitting a single-sample RTT into it is an illegal blit — irrelevant now that
    // we present via a textured quad, but it also avoids a needless MSAA resolve on the canvas.
    antialias: false,
  }) as WebGL2RenderingContext | null;
  if (!gl) throw new Error("gl-context: WebGL2 unavailable");
  noteGlContextCreated();
  return gl;
}

export function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("gl-context: createShader failed");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`gl-context: shader compile failed: ${log ?? "unknown"}`);
  }
  return shader;
}

/** Compile + link a vertex/fragment program. `a_position` is bound to attribute location 0. */
export function linkProgram(gl: WebGL2RenderingContext, vsSource: string, fsSource: string): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSource);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource);
  const program = gl.createProgram();
  if (!program) throw new Error("gl-context: createProgram failed");
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.bindAttribLocation(program, 0, "a_position");
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`gl-context: link failed: ${log ?? "unknown"}`);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return program;
}

/** A VAO bound to the shared fullscreen triangle on attribute location 0. */
export function createFullscreenVao(gl: WebGL2RenderingContext): WebGLVertexArrayObject {
  const vao = gl.createVertexArray();
  const vbo = gl.createBuffer();
  if (!vao || !vbo) throw new Error("gl-context: VAO alloc failed");
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, FULLSCREEN_TRI_VERTS, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return vao;
}

/** A CLAMP_TO_EDGE, LINEAR-filtered RGBA texture — the standard sampling texture for frames/mattes. */
export function make2dTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error("gl-context: texture alloc failed");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return tex;
}

/**
 * A render-to-texture target: an RGBA8 color texture backed by a framebuffer. The compositor keeps
 * two of these as a ping-pong accumulator so it can blend each layer against the previous result
 * without read/write feedback (read target A as a texture while drawing into target B).
 */
export class RenderTarget {
  readonly tex: WebGLTexture;
  readonly fbo: WebGLFramebuffer;
  private disposed = false;

  constructor(private readonly gl: WebGL2RenderingContext, public width: number, public height: number) {
    const tex = make2dTexture(gl);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fbo = gl.createFramebuffer();
    if (!fbo) throw new Error("gl-context: framebuffer alloc failed");
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.tex = tex;
    this.fbo = fbo;
  }

  /** Resize the backing texture if the composition size changed. */
  resize(width: number, height: number): void {
    if (this.disposed || (this.width === width && this.height === height)) return;
    this.width = width;
    this.height = height;
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.tex);
    this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, width, height, 0, this.gl.RGBA, this.gl.UNSIGNED_BYTE, null);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.gl.deleteTexture(this.tex);
    this.gl.deleteFramebuffer(this.fbo);
  }
}
