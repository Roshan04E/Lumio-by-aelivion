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

import { frameProfiler } from "./frame-profiler";

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
let nextGlContextId = 1;

/**
 * Preview WebGL context budget (todo.md Phase 2). `target` is the count we try to stay at or below; `hardCap`
 * is the ceiling above which the governor evicts the least-valuable idle context before allowing another
 * allocation. Kept well under the browser's ~16 cap so preview never triggers a browser-side force-loss of the
 * OLDEST context (which is how large timelines silently drop the GPU scene to the DOM path today).
 */
const DEFAULT_PREVIEW_CONTEXT_TARGET = 3;
const DEFAULT_PREVIEW_CONTEXT_HARD_CAP = 4;
/**
 * Live budget. The conservative defaults are kept for the unit test's pinned scenarios; the WEB APP
 * sets a realistic budget at startup (VideoPreview module scope, next to the governor flag): a real
 * multi-track timeline legitimately holds 8–11 live per-layer grade contexts (2026-07-03 soak hit
 * GL ctx 15 — ONE clip from Chromium's ~16 force-loss, which kills the OLDEST context, possibly the
 * scene compositor). The budget must sit safely under 16 while not evicting genuinely live layers.
 */
let previewContextTarget = DEFAULT_PREVIEW_CONTEXT_TARGET;
let previewContextHardCap = DEFAULT_PREVIEW_CONTEXT_HARD_CAP;

/** Set the preview context budget (target ≤ hardCap enforced; hardCap clamped under the browser's ~16). */
export function setGlContextBudget(target: number, hardCap: number): void {
  previewContextHardCap = Math.max(2, Math.min(14, Math.floor(hardCap)));
  previewContextTarget = Math.max(1, Math.min(previewContextHardCap, Math.floor(target)));
}
/** Kinds the governor may evict — never the persistent root `scene-compositor`. */
const EVICTABLE_KINDS: ReadonlySet<GlContextOwnerInfo["kind"]> = new Set(["media-renderer", "transition-compositor", "webgl-applicator"]);
/**
 * A context is only evictable once it has gone IDLE this long (no `touchContext` = not drawn). This is the
 * safety that keeps a legitimately multi-track composition intact: every currently-VISIBLE layer is touched
 * each frame, so only genuinely abandoned contexts (a clip scrolled out of the active window, a stale preload)
 * are reclaimed. If everything on screen is active we simply run transiently over the cap — still far under
 * the browser's ~16 — rather than evict a live layer and flash it black.
 */
const EVICT_IDLE_MS = 200;

/**
 * ENFORCEMENT gate. Telemetry (owner labels, `__rfGlContextBudget`, the active count) is ALWAYS live; the
 * governor only *acts* (evicts on `requestContextSlot`) when this is on. The web app sets it once at startup
 * from `getGlGovernorEnabled()` so this shared, framework-free module never reads a query param / localStorage.
 */
let governorEnabled = false;
/** Disposers registered by evictable renderers so the governor can actually free an evicted context. */
const glDisposers = new Map<number, () => void>();

/** Enable/disable governor ENFORCEMENT (allocation eviction). Default off; telemetry is unaffected. */
export function setGlGovernorEnabled(enabled: boolean): void {
  governorEnabled = enabled;
}

export function isGlGovernorEnabled(): boolean {
  return governorEnabled;
}

/** True when the live context count is at/over the soft target — used to pause background cache generation. */
export function isGlBudgetOverTarget(): boolean {
  return activeGlContexts >= previewContextTarget;
}

export interface GlContextOwnerInfo {
  id: number;
  label: string;
  kind: "scene-compositor" | "media-renderer" | "transition-compositor" | "webgl-applicator" | "unknown";
  createdAt: number;
  /** Last frame this context was drawn with (`touchContext`); drives least-recently-used eviction. */
  lastUsedAt: number;
  disposedAt?: number;
  canvasConnected?: boolean | undefined;
  contextLost?: boolean | undefined;
}

export interface GlContextCreateOptions {
  label?: string;
  kind?: GlContextOwnerInfo["kind"];
}

export interface TexImageSourceProducerInfo {
  label: string;
  disposed: boolean;
  contextLost: boolean;
  width: number;
  height: number;
  updatedAt: number;
}

const glOwners = new WeakMap<WebGL2RenderingContext, GlContextOwnerInfo>();
const glOwnerRecords = new Map<number, GlContextOwnerInfo>();
const producerBySource = new WeakMap<TexImageSource, TexImageSourceProducerInfo>();

function nowMs(): number {
  try {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
  } catch {
    return Date.now();
  }
}

function publishActiveGlContextCount(): void {
  try {
    const global = globalThis as { __rfActiveGlContexts?: number; __rfGlContextBudget?: unknown; __rfDumpGlDebug?: () => unknown; __rfLastSceneUpload?: unknown; __rfLastSceneUploadFailure?: unknown };
    global.__rfActiveGlContexts = activeGlContexts;
    global.__rfGlContextBudget = getGlContextBudgetSnapshot();
    global.__rfDumpGlDebug = () => ({
      activeGlContexts,
      budget: getGlContextBudgetSnapshot(),
      lastSceneUpload: global.__rfLastSceneUpload,
      lastSceneUploadFailure: global.__rfLastSceneUploadFailure,
    });
  } catch {
    /* ignore */
  }
}

export function noteGlContextCreated(gl?: WebGL2RenderingContext, options: GlContextCreateOptions = {}): void {
  if (gl) {
    const existing = glOwners.get(gl);
    if (existing && existing.disposedAt == null) {
      existing.label = options.label ?? existing.label;
      existing.kind = options.kind ?? existing.kind;
      existing.canvasConnected = (gl.canvas as { isConnected?: boolean }).isConnected;
      existing.contextLost = gl.isContextLost();
      publishActiveGlContextCount();
      return;
    }
  }
  activeGlContexts += 1;
  if (gl) {
    const created = nowMs();
    const owner = {
      id: nextGlContextId++,
      label: options.label ?? options.kind ?? "unknown",
      kind: options.kind ?? "unknown",
      createdAt: created,
      lastUsedAt: created,
      canvasConnected: (gl.canvas as { isConnected?: boolean }).isConnected,
      contextLost: gl.isContextLost(),
    };
    glOwners.set(gl, owner);
    glOwnerRecords.set(owner.id, owner);
  }
  publishActiveGlContextCount();
}

/**
 * Mark a context as used THIS frame so least-recently-used eviction targets genuinely idle contexts (e.g. a
 * clip that scrolled out of the active window and stopped drawing) rather than the one being composited now.
 * Cheap (a timestamp write); renderers call it per draw. No-op for an unknown/disposed context.
 */
export function touchContext(gl: WebGL2RenderingContext): void {
  const owner = glOwners.get(gl);
  if (owner && owner.disposedAt == null) {
    owner.lastUsedAt = nowMs();
  }
}

/**
 * Register the disposer an evictable renderer runs when the governor reclaims its context. The disposer MUST
 * fully tear the renderer down (its own `dispose()` → `releaseContextIfDetached` → `noteGlContextDisposed`),
 * and leave the owner able to lazily re-create later. Keyed by the context's owner id; cleared on disposal.
 */
export function registerContextDisposer(gl: WebGL2RenderingContext, dispose: () => void): void {
  const owner = glOwners.get(gl);
  if (owner) {
    glDisposers.set(owner.id, dispose);
  }
}

/**
 * Reserve room for ONE new preview context. When the governor is enabled and we're at the hard cap, evict the
 * least-recently-used EVICTABLE context (never the root `scene-compositor`) via its registered disposer,
 * repeating until under the cap or nothing evictable remains. No-op when the governor is disabled — telemetry
 * stays accurate either way. Call this immediately BEFORE creating a per-layer context.
 */
export function requestContextSlot(): void {
  if (!governorEnabled) return;
  let guard = 0;
  while (activeGlContexts >= previewContextHardCap && guard < 16) {
    guard += 1;
    const idleBefore = nowMs() - EVICT_IDLE_MS;
    const victim = [...glOwnerRecords.values()]
      .filter(
        (owner) =>
          owner.disposedAt == null &&
          EVICTABLE_KINDS.has(owner.kind) &&
          glDisposers.has(owner.id) &&
          owner.lastUsedAt <= idleBefore
      )
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
    // Nothing IDLE enough to reclaim → everything live is genuinely on screen. Allow the allocation and run
    // briefly over the cap (still far under the browser's ceiling) rather than evict a visible layer.
    if (!victim) break;
    const dispose = glDisposers.get(victim.id);
    glDisposers.delete(victim.id);
    try {
      dispose?.();
    } catch {
      /* a failed disposer must not block allocation */
    }
  }
}

export function noteGlContextDisposed(gl?: WebGL2RenderingContext): void {
  if (gl) {
    const owner = glOwners.get(gl);
    if (owner) {
      if (owner.disposedAt != null) {
        publishActiveGlContextCount();
        return;
      }
      owner.disposedAt = nowMs();
      owner.canvasConnected = (gl.canvas as { isConnected?: boolean }).isConnected;
      owner.contextLost = gl.isContextLost();
      glDisposers.delete(owner.id);
    }
  }
  activeGlContexts = Math.max(0, activeGlContexts - 1);
  publishActiveGlContextCount();
}

export function getActiveGlContextCount(): number {
  return activeGlContexts;
}

export function getGlContextOwnerInfo(gl: WebGL2RenderingContext): GlContextOwnerInfo | null {
  const owner = glOwners.get(gl);
  if (!owner) return null;
  owner.canvasConnected = (gl.canvas as { isConnected?: boolean }).isConnected;
  owner.contextLost = gl.isContextLost();
  return { ...owner };
}

export function getGlContextBudgetSnapshot(): { active: number; target: number; hardCap: number; owners: GlContextOwnerInfo[] } {
  return {
    active: activeGlContexts,
    target: previewContextTarget,
    hardCap: previewContextHardCap,
    owners: Array.from(glOwnerRecords.values())
      .filter((owner) => owner.disposedAt == null)
      .map((owner) => ({ ...owner })),
  };
}

export function markTexImageSourceProducer(source: TexImageSource, info: TexImageSourceProducerInfo): void {
  producerBySource.set(source, { ...info, updatedAt: nowMs() });
}

export function getTexImageSourceProducerInfo(source: TexImageSource): TexImageSourceProducerInfo | null {
  const info = producerBySource.get(source);
  return info ? { ...info } : null;
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
  if (gl.isContextLost()) {
    noteGlContextDisposed(gl);
    return;
  }
  const connected = (gl.canvas as { isConnected?: boolean }).isConnected;
  if (connected === true) return; // still in the DOM → will be reused; a lost context can't be re-acquired
  try {
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    noteGlContextDisposed(gl);
  } catch {
    /* ignore */
  }
}

export function createGl(canvas: AnyCanvas, options: GlContextCreateOptions = {}): WebGL2RenderingContext {
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
  noteGlContextCreated(gl, options);
  return gl;
}

/**
 * Sentinel for "this GL failure is really a lost context". Compile/link on a lost context fails
 * with an EMPTY info log ("unknown"), which callers used to misread as a real shader error and
 * latch into permanent fallbacks — a rebuild-on-fresh-context would have succeeded (2026-07-06:
 * ScenePreviewCanvas printed "controlled rebuild 1/3", then the rebuild's compile-on-still-lost-
 * context hard-failed to the DOM path instead of continuing the retry ladder).
 */
export const GL_CONTEXT_LOST = "gl-context: context lost";

export function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error(gl.isContextLost() ? GL_CONTEXT_LOST : "gl-context: createShader failed");
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    if (gl.isContextLost()) throw new Error(GL_CONTEXT_LOST);
    throw new Error(`gl-context: shader compile failed: ${log ?? "unknown"}`);
  }
  return shader;
}

/** Compile + link a vertex/fragment program. `a_position` is bound to attribute location 0. */
export function linkProgram(gl: WebGL2RenderingContext, vsSource: string, fsSource: string): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSource);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource);
  const program = gl.createProgram();
  if (!program) {
    throw new Error(gl.isContextLost() ? GL_CONTEXT_LOST : "gl-context: createProgram failed");
  }
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.bindAttribLocation(program, 0, "a_position");
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    if (gl.isContextLost()) throw new Error(GL_CONTEXT_LOST);
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
 * Render-target precision (plans/log-raw-source-color.md, Stage 0).
 *
 * `rgba8` is the shipped path and stays the default everywhere. `rgba16f` exists because log footage
 * is DESIGNED to be stretched in the grade, and stretching it through 8-bit intermediates bands
 * visibly — so log support on an 8-bit pipeline would technically work and look bad, which is worse
 * than the honest "not transformed yet" warning we show today. This is a prerequisite for the input
 * transforms, not an optimisation.
 */
export type RenderTargetPrecision = "rgba8" | "rgba16f";

/** `window.__rfHdrPipeline` — always recorded, flag or no flag, so engagement is provable before any
 *  flip (the `__rfSingleCtxPreview` doctrine: telemetry is never gated, only ENFORCEMENT is). */
function noteHdrPipeline(kind: "targets" | "halfFloat" | "fallbacks"): void {
  if (typeof globalThis === "undefined") return;
  const w = globalThis as { __rfHdrPipeline?: { targets: number; halfFloat: number; fallbacks: number } };
  const s = (w.__rfHdrPipeline ??= { targets: 0, halfFloat: 0, fallbacks: 0 });
  s[kind] += 1;
}

const halfFloatColorBufferCache = new WeakMap<WebGL2RenderingContext, boolean>();

/**
 * Can this context actually RENDER to a half-float texture?
 *
 * WebGL2 exposes RGBA16F as a texture format unconditionally, but colour-buffer *attachment* needs
 * `EXT_color_buffer_half_float` (or `EXT_color_buffer_float`). Asking the extension registry is the
 * whole check — allocating and probing FRAMEBUFFER_COMPLETE would cost an alloc per context on a
 * path that runs during preview setup.
 */
export function supportsHalfFloatRenderTarget(gl: WebGL2RenderingContext): boolean {
  const cached = halfFloatColorBufferCache.get(gl);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    ok = Boolean(gl.getExtension("EXT_color_buffer_half_float") ?? gl.getExtension("EXT_color_buffer_float"));
  } catch {
    ok = false;
  }
  halfFloatColorBufferCache.set(gl, ok);
  return ok;
}

/** Bytes per pixel a target of this precision pins — the unit the compositor's GPU budget counts in. */
export function bytesPerPixel(precision: RenderTargetPrecision): number {
  return precision === "rgba16f" ? 8 : 4;
}

/**
 * A render-to-texture colour texture backed by a framebuffer. The compositor keeps two of these as a
 * ping-pong accumulator so it can blend each layer against the previous result without read/write
 * feedback (read target A as a texture while drawing into target B).
 *
 * Precision is requested, not guaranteed: an unsupported context silently falls back to RGBA8 and
 * records it. A half-float target that failed to attach would leave an INCOMPLETE framebuffer and
 * render nothing, so falling back is the only safe answer — and `precision` reports what was actually
 * allocated, never what was asked for.
 */
export class RenderTarget {
  readonly tex: WebGLTexture;
  readonly fbo: WebGLFramebuffer;
  /** What this target ACTUALLY is, after the capability fallback. */
  readonly precision: RenderTargetPrecision;
  private disposed = false;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    public width: number,
    public height: number,
    requested: RenderTargetPrecision = "rgba8"
  ) {
    const half = requested === "rgba16f" && supportsHalfFloatRenderTarget(gl);
    if (requested === "rgba16f" && !half) noteHdrPipeline("fallbacks");
    this.precision = half ? "rgba16f" : "rgba8";
    const tex = make2dTexture(gl);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    this.allocate(tex, width, height);
    const fbo = gl.createFramebuffer();
    if (!fbo) throw new Error("gl-context: framebuffer alloc failed");
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.tex = tex;
    this.fbo = fbo;
    noteHdrPipeline("targets");
    if (this.precision === "rgba16f") noteHdrPipeline("halfFloat");
    frameProfiler.noteRttAlloc();
  }

  private allocate(tex: WebGLTexture, width: number, height: number): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (this.precision === "rgba16f") {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
      return;
    }
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  }

  /** Resize the backing texture if the composition size changed. */
  resize(width: number, height: number): void {
    if (this.disposed || (this.width === width && this.height === height)) return;
    frameProfiler.noteRttResize();
    this.width = width;
    this.height = height;
    this.allocate(this.tex, width, height);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.gl.deleteTexture(this.tex);
    this.gl.deleteFramebuffer(this.fbo);
  }
}
