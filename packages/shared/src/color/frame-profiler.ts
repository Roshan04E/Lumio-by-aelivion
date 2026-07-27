/**
 * Flarex FRAME PROFILER — debug-only, instrumentation ONLY (no optimizations, no behavior changes).
 *
 * Purpose: for ONE playback frame, expose exactly where time is spent across the three subsystems the
 * Flarex preview runs every frame — the EVALUATOR (`buildSceneDraws` → `compileFlarexComp` +
 * `computeFlarexContentHashes`), the COMPOSITOR (`SceneCompositor.renderFrame`), and the GPU itself.
 *
 * Every counter corresponds to REAL engine work — nothing is estimated:
 *   - GPU-command counters (draw calls, program switches, framebuffer/texture binds, texture uploads,
 *     texture/framebuffer creations) come from PATCHING the live WebGL2 context methods, so they count
 *     the actual calls the compositor issues regardless of which code path issued them (the Spector.js
 *     approach). The patch is installed ONLY when the flag is on and simply increments a counter before
 *     delegating to the original method — zero behavior change.
 *   - Evaluator counters (nodes evaluated/skipped, content hashes computed, materializations) are bumped
 *     at the real evaluation/hash sites in the compiler.
 *   - CPU timings use `performance.now()`; GPU time uses `EXT_disjoint_timer_query_webgl2` when the
 *     browser exposes it (1-frame latency, non-blocking), else reported as unavailable.
 *
 * PRODUCTION: the whole thing is inert unless `?flarexProfile=1` (or `localStorage.orreris_flarex_profile
 * = "1"`) is set. With the flag off, `enabled()` short-circuits, `beginFrame` is never called, no context
 * is ever patched, and every `bump`/`time` call returns immediately — the profiler disappears completely.
 *
 * This module is framework-free (imported by the shared compositor + evaluator AND the web preview), so
 * it reads the flag straight off `globalThis` like `sceneGlDebugEnabled()` does.
 */

/** Cheap, semantically-grouped counter buckets — a flat map keyed by a dotted name. */
type Counters = Record<string, number>;

/** A snapshot of compositor-owned cache/VRAM state at frame end (supplied by the caller — see
 *  `SceneCompositor.profilerSnapshot`). Purely informational; the compositor computes it from sizes it
 *  already tracks, so it is real, not estimated. */
export interface CompositorProfilerSnapshot {
  /** Live per-source GPU textures (the persistent media/mask texture cache). */
  srcTextureEntries: number;
  srcTextureVramBytes: number;
  /** Live render targets (accumulators, plate/scratch/blur, transition sides, group/matte/pass pools). */
  renderTargetCount: number;
  renderTargetVramBytes: number;
  /** Compiled program caches (transition + fragment-effect). */
  transitionPrograms: number;
  fragmentPrograms: number;
  passGraphTargets: number;
}

function readFlag(): boolean {
  try {
    const g = globalThis as {
      location?: { search?: string };
      localStorage?: { getItem: (k: string) => string | null };
    };
    const params = new URLSearchParams(g.location?.search ?? "");
    if (params.get("flarexProfile") === "1") return true;
    return g.localStorage?.getItem("orreris_flarex_profile") === "1";
  } catch {
    return false;
  }
}

function now(): number {
  try {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
  } catch {
    return Date.now();
  }
}

/** Classify a `TexImageSource` for upload attribution — no `instanceof` chain hard-fails in workers. */
function classifyUpload(source: unknown): "video" | "image" | "canvas" | "bitmap" | "other" {
  const s = source as {
    videoWidth?: number;
    naturalWidth?: number;
    displayWidth?: number;
    width?: number;
  } | null;
  if (!s || typeof s !== "object") return "other";
  if (typeof s.videoWidth === "number") return "video";
  if (typeof s.naturalWidth === "number") return "image";
  if (typeof s.displayWidth === "number") return "bitmap";
  if (typeof s.width === "number") return "canvas";
  return "other";
}

/** One node the evaluator visited this frame (evaluated fresh, or reused from the memo). */
interface EvalRecord {
  id: string;
  type: string;
}

/** One node's content-hash detail this frame — enough to classify it vs. the previous frame and, when
 *  it changed, say WHY (its own resolved params changed vs. an upstream child's hash changed). */
interface HashRecord {
  id: string;
  type: string;
  /** Full node content hash (folds upstream). */
  hash: string;
  /** LOCAL token = this node's own type/enabled/resolved-params, WITHOUT upstream — so a hash change
   *  with an unchanged local token means the invalidation propagated from a child, not from here. */
  localToken: string;
}

class FrameProfiler {
  private _enabled: boolean | null = null;
  /** True only between `beginFrame` and `endFrame` — every counter/timer bump guards on it, so stray GL
   *  calls outside a measured frame are never attributed to one. */
  recording = false;
  private frameNo = 0;
  private counters: Counters = {};
  private timers: Counters = {};
  private previewRenders = 0;
  private readonly patched = new WeakSet<WebGL2RenderingContext>();

  // ── Attribution state (reset each frame) ────────────────────────────────────────────────────────
  /** Active render-role scope stack; draw calls + transient RTT allocs attribute to the innermost. */
  private scopeStack: string[] = [];
  /** Draw calls attributed per render role (e.g. "composite", "blur", "group-precompose", "present"). */
  private drawByScope: Counters = {};
  /** Labels of the transient RTTs allocated this frame (persistent ones are allocated once, off-frame). */
  private rttTransient: string[] = [];
  /** Nodes the evaluator actually lowered this frame. */
  private evaluated: EvalRecord[] = [];
  /** Nodes served from the evaluator's per-frame memo (shared fan-out — not re-lowered). */
  private skipped: EvalRecord[] = [];
  /** This frame's per-node content-hash detail (for the computed/reused/changed diff). */
  private hashes: HashRecord[] = [];
  /** Previous frame's per-node hash detail, keyed by node id — the invalidation baseline. */
  private prevHashes = new Map<string, HashRecord>();
  /** Live evaluator recursion depth (reset per frame); peak/avg fold into counters as it moves. */
  private evalDepth = 0;

  // ── Media-supply attribution (per source frame delivery) ─────────────────────────────────────────
  /** Cross-frame per-source decode state — persists across `beginFrame` resets (like `prevHashes`).
   *  A freeze IS a source whose `frameVersion` stops advancing while the clock (recording) runs. */
  private mediaState = new Map<string, { lastVersion: number; lastAdvanceAt: number; heldFrames: number; noFrameFrames: number; noFrameStartAt: number; everAdvanced: boolean; everHadFrame: boolean; stallWarned: boolean }>();
  /** Sources observed THIS frame (reset each frame) — snapshot of their delivery state for the report. */
  private mediaSeen: { id: string; version: number; hasFrame: boolean; heldFrames: number; heldMs: number; everAdvanced: boolean }[] = [];

  // GPU timing (EXT_disjoint_timer_query_webgl2). One-slot pipeline: the query started this frame is
  // harvested next frame (non-blocking), so `lastGpuMs` trails by one frame — fine for a steady report.
  private timerGl: WebGL2RenderingContext | null = null;
  private timerExt: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null = null;
  private inFlightQuery: WebGLQuery | null = null;
  private lastGpuMs: number | null = null;

  enabled(): boolean {
    if (this._enabled === null) this._enabled = readFlag();
    return this._enabled;
  }

  /** Count one React render of the preview surface (called from the component body). Reported at frame
   *  end to confirm the viewer updates via rAF, not React re-render, during playback. */
  notePreviewRender(): void {
    if (this.enabled()) this.previewRenders += 1;
  }

  bump(key: string, n = 1): void {
    if (this.recording) this.counters[key] = (this.counters[key] ?? 0) + n;
  }
  private max(key: string, val: number): void {
    if (this.recording) this.counters[key] = Math.max(this.counters[key] ?? 0, val);
  }

  // ── Evaluator recursion + retained-cache attribution (compile-flarex / eval-cache) ───────────────
  /** Entered `evalNode` recursion one level deeper — tracks peak + average descent depth. */
  enterEval(): void {
    if (!this.recording) return;
    this.evalDepth += 1;
    this.max("eval.peakDepth", this.evalDepth);
    this.bump("eval.depthSum", this.evalDepth);
    this.bump("eval.depthSamples");
  }
  exitEval(): void {
    if (this.recording && this.evalDepth > 0) this.evalDepth -= 1;
  }
  /** Retained evaluator-cache decision. `hit` reused a lowered plan (skipping `subtreeSize` descendants);
   *  a miss re-lowered. Wired now so the counters exist; reads zero until the cache lands (Step 1). */
  noteEvalCache(hit: boolean, subtreeSize = 0): void {
    if (!this.recording) return;
    if (hit) {
      this.bump("eval.cacheHits");
      this.bump("eval.drawListsReused");
      this.bump("eval.subgraphsSkipped");
      this.bump("eval.skippedSubtreeSum", subtreeSize);
      this.max("eval.skippedSubtreeMax", subtreeSize);
      this.bump("eval.skippedSubtreeCount");
    } else {
      this.bump("eval.cacheMisses");
      this.bump("eval.drawListsRebuilt");
    }
  }
  /** Time spent in a cache lookup (folds into `eval.cacheLookup`). */
  noteCacheLookup(ms: number): void {
    this.time("eval.cacheLookup", ms);
  }

  // ── Render-role scopes (compositor) ─────────────────────────────────────────────────────────────
  /** Run `fn` under a named render role so its draw calls + transient RTT allocs are attributed to it. */
  scoped<T>(label: string, fn: () => T): T {
    if (!this.recording) return fn();
    this.scopeStack.push(label);
    try {
      return fn();
    } finally {
      this.scopeStack.pop();
    }
  }
  private activeScope(): string {
    return this.scopeStack.length ? this.scopeStack[this.scopeStack.length - 1]! : "composite";
  }

  /** A new render target was allocated (see `RenderTarget` ctor). Attributed to the active role. */
  noteRttAlloc(label?: string): void {
    if (!this.recording) return;
    this.bump("rtt.alloc");
    this.rttTransient.push(label ?? this.activeScope());
  }
  noteRttResize(): void {
    this.bump("rtt.resize");
  }

  // ── Evaluator node attribution (compiler) ───────────────────────────────────────────────────────
  noteEval(id: string, type: string, kind: "evaluated" | "skipped"): void {
    if (!this.recording) return;
    (kind === "evaluated" ? this.evaluated : this.skipped).push({ id, type });
    this.bump(kind === "evaluated" ? "eval.nodesEvaluated" : "eval.nodesSkipped");
  }
  noteMaterialize(): void {
    this.bump("eval.materializations");
  }

  // ── Content-hash attribution (content-hash) ─────────────────────────────────────────────────────
  noteHashNode(id: string, type: string, hash: string, localToken: string): void {
    if (!this.recording) return;
    this.hashes.push({ id, type, hash, localToken });
    this.bump("eval.hashesComputed");
  }

  time(key: string, ms: number): void {
    if (this.recording) this.timers[key] = (this.timers[key] ?? 0) + ms;
  }

  /** Time a synchronous section into `key`. Returns the callback's result. */
  measure<T>(key: string, fn: () => T): T {
    if (!this.recording) return fn();
    const t0 = now();
    try {
      return fn();
    } finally {
      this.time(key, now() - t0);
    }
  }

  /** A texture upload the compositor's per-source cache classified — for the Media section. */
  noteUpload(source: unknown, op: "texImage2D" | "texSubImage2D"): void {
    if (!this.recording) return;
    this.bump(`upload.${classifyUpload(source)}`);
    this.bump(`upload.op.${op}`);
    this.bump("upload.total");
  }

  /** Persistent per-source texture cache decision (see `SceneCompositor.uploadSource`). */
  noteTextureCache(hit: boolean): void {
    this.bump(hit ? "texCache.hit" : "texCache.miss");
  }

  /**
   * One media source's per-frame delivery state, recorded at the compositor's poll site
   * (`gradeMediaInContext` reads `snapshot()` once per source per frame). `frameVersion` is the
   * source's monotonic new-frame counter. Recording only runs during playback, so a `frameVersion`
   * that HELD across many consecutive recorded frames while `hasFrame` is a stalled decoder — the
   * "video freezes during playback" symptom, named per source. A source that never advanced is either
   * still decoding its first frame or a static still (reported separately, not flagged as a stall).
   */
  noteMediaSource(id: string, frameVersion: number, hasFrame: boolean): void {
    if (!this.recording) return;
    const t = now();
    let st = this.mediaState.get(id);
    if (!st) {
      st = { lastVersion: frameVersion, lastAdvanceAt: t, heldFrames: 0, noFrameFrames: 0, noFrameStartAt: 0, everAdvanced: false, everHadFrame: hasFrame, stallWarned: false };
      this.mediaState.set(id, st);
    } else if (frameVersion !== st.lastVersion) {
      st.lastVersion = frameVersion;
      st.lastAdvanceAt = t;
      st.heldFrames = 0;
      st.everAdvanced = true;
    } else {
      st.heldFrames += 1;
    }
    // No-frame run tracking, separate from the version-held run: a source that delivers NO frame holds
    // its last graded pixels (a visible freeze for exactly this long). A ≤~100ms gap is a benign
    // mid-seek/decode-in-flight null the compositor holds through invisibly — only a longer gap is a
    // real freeze, so LOST SOURCE only fires past the threshold (no more false alarms on seeks).
    if (hasFrame) {
      st.everHadFrame = true;
      if (st.noFrameFrames > 0 || st.stallWarned) {
        if (st.stallWarned) this.warnEdge(`media RECOVERED: ${this.shortId(id)} — after ${st.noFrameFrames > 0 ? `${st.noFrameFrames}f / ${Math.round(t - st.noFrameStartAt)}ms no-frame` : "stall"}`);
        st.noFrameFrames = 0;
        st.stallWarned = false;
      }
    } else {
      if (st.noFrameFrames === 0) st.noFrameStartAt = t;
      st.noFrameFrames += 1;
    }
    this.mediaSeen.push({ id, version: frameVersion, hasFrame, heldFrames: st.heldFrames, heldMs: t - st.lastAdvanceAt, everAdvanced: st.everAdvanced });
    this.bump("media.sources");
    const LOST_FRAMES = 6; // ~100ms at 60fps — beyond a normal seek gap, so a real perceptible freeze.
    if (hasFrame && st.everAdvanced && st.heldFrames >= 20) {
      // Decoder alive but NOT advancing (delivers the same frame version) — a forward-play stall.
      this.bump("media.stalled");
      if (!st.stallWarned) {
        st.stallWarned = true;
        this.warnEdge(`media STALLED: ${this.shortId(id)} — held ${st.heldFrames}f / ${Math.round(t - st.lastAdvanceAt)}ms while playing (decoder not advancing)`);
      }
    } else if (!hasFrame && st.everHadFrame && st.noFrameFrames >= LOST_FRAMES) {
      // Delivered NO frame for a perceptible span — the decoder was dropped/preempted (mode:"none" lane).
      this.bump("media.lostSource");
      if (!st.stallWarned) {
        st.stallWarned = true;
        this.warnEdge(`media LOST SOURCE: ${this.shortId(id)} — no frame for ${st.noFrameFrames}f / ${Math.round(t - st.noFrameStartAt)}ms (decoder dropped/preempted)`);
      }
    } else if (hasFrame && !st.everAdvanced && st.heldFrames >= 20) {
      this.bump("media.neverAdvanced");
    } else if (!hasFrame) {
      this.bump("media.noFrame");
    }
  }

  /** Trim a long virtual-layer id to a readable tail for edge warnings. */
  private shortId(id: string): string {
    return id.length > 44 ? `…${id.slice(-42)}` : id;
  }

  /** One-shot console warning at a freeze edge (guarded — only while the flag is on). */
  private warnEdge(msg: string): void {
    try {
      if (typeof console !== "undefined") console.warn(`[flarexProfile] ${msg} @ frame ${this.frameNo}`);
    } catch {
      /* ignore */
    }
  }

  /**
   * Patch the WebGL2 context's command methods to count real GPU work. Idempotent per context; a no-op
   * when disabled. Each wrapper increments a counter (only while recording) then delegates to the
   * original — so it never changes what the call does, only observes that it happened.
   */
  instrumentGl(gl: WebGL2RenderingContext): void {
    if (!this.enabled() || this.patched.has(gl)) return;
    this.patched.add(gl);
    this.timerGl = gl;
    try {
      const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2") as
        | { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number }
        | null;
      if (ext) this.timerExt = ext;
    } catch {
      /* timer queries unavailable — GPU time reports as n/a */
    }

    const self = this;
    const wrap = <K extends keyof WebGL2RenderingContext>(name: K, counter: string) => {
      const orig = gl[name] as unknown as (...args: unknown[]) => unknown;
      if (typeof orig !== "function") return;
      (gl as unknown as Record<string, unknown>)[name as string] = function (this: unknown, ...args: unknown[]) {
        if (self.recording) self.counters[counter] = (self.counters[counter] ?? 0) + 1;
        return orig.apply(gl, args);
      };
    };

    // Draw calls: total + attributed to the active render role.
    const origDrawArrays = gl.drawArrays.bind(gl) as (...a: unknown[]) => unknown;
    (gl as unknown as Record<string, unknown>).drawArrays = function (...args: unknown[]) {
      if (self.recording) {
        self.counters["gpu.drawCalls"] = (self.counters["gpu.drawCalls"] ?? 0) + 1;
        const s = self.activeScope();
        self.drawByScope[s] = (self.drawByScope[s] ?? 0) + 1;
      }
      return origDrawArrays(...args);
    };
    const origDrawElements = gl.drawElements.bind(gl) as (...a: unknown[]) => unknown;
    (gl as unknown as Record<string, unknown>).drawElements = function (...args: unknown[]) {
      if (self.recording) {
        self.counters["gpu.drawCalls"] = (self.counters["gpu.drawCalls"] ?? 0) + 1;
        const s = self.activeScope();
        self.drawByScope[s] = (self.drawByScope[s] ?? 0) + 1;
      }
      return origDrawElements(...args);
    };
    wrap("bindFramebuffer", "gpu.framebufferBinds");
    wrap("useProgram", "gpu.programSwitches");
    wrap("bindTexture", "gpu.textureBinds");
    wrap("createTexture", "gpu.textureCreations");
    wrap("createFramebuffer", "gpu.framebufferCreations");

    // Uploads need argument inspection (source vs. null storage alloc vs. pixel buffer), so they are
    // wrapped by hand rather than through `wrap`.
    const origTexImage = gl.texImage2D.bind(gl) as (...a: unknown[]) => unknown;
    (gl as unknown as Record<string, unknown>).texImage2D = function (...args: unknown[]) {
      if (self.recording) {
        const last = args[args.length - 1];
        if (last == null) self.counters["gpu.textureStorageAllocs"] = (self.counters["gpu.textureStorageAllocs"] ?? 0) + 1;
        else if (ArrayBuffer.isView(last)) self.counters["gpu.pixelBufferUploads"] = (self.counters["gpu.pixelBufferUploads"] ?? 0) + 1;
        else self.noteUpload(last, "texImage2D");
      }
      return origTexImage(...args);
    };
    const origTexSub = gl.texSubImage2D.bind(gl) as (...a: unknown[]) => unknown;
    (gl as unknown as Record<string, unknown>).texSubImage2D = function (...args: unknown[]) {
      if (self.recording) {
        const last = args[args.length - 1];
        if (ArrayBuffer.isView(last)) self.counters["gpu.pixelBufferUploads"] = (self.counters["gpu.pixelBufferUploads"] ?? 0) + 1;
        else self.noteUpload(last, "texSubImage2D");
      }
      return origTexSub(...args);
    };
  }

  /** Begin a measured frame: reset per-frame state and (if available) open a GPU timer query. */
  beginFrame(): void {
    if (!this.enabled()) return;
    this.frameNo += 1;
    this.counters = {};
    this.timers = {};
    this.drawByScope = {};
    this.rttTransient = [];
    this.scopeStack = [];
    this.evaluated = [];
    this.skipped = [];
    this.hashes = [];
    this.evalDepth = 0;
    this.mediaSeen = [];
    this.recording = true;
    this.gpuBegin();
  }

  private gpuBegin(): void {
    const gl = this.timerGl;
    const ext = this.timerExt;
    if (!gl || !ext) return;
    try {
      const q = gl.createQuery();
      if (!q) return;
      gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
      // Stash on the instance so gpuEnd can close it and queue it for next-frame harvest.
      this.currentQuery = q;
    } catch {
      /* ignore — GPU time will read n/a */
    }
  }

  private currentQuery: WebGLQuery | null = null;

  private gpuEnd(): void {
    const gl = this.timerGl;
    const ext = this.timerExt;
    if (!gl || !ext) return;
    try {
      if (this.currentQuery) gl.endQuery(ext.TIME_ELAPSED_EXT);
      // Harvest the PREVIOUS frame's query (non-blocking): the GPU has had a frame to finish it.
      if (this.inFlightQuery) {
        const available = gl.getQueryParameter(this.inFlightQuery, gl.QUERY_RESULT_AVAILABLE) as boolean;
        const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT) as boolean;
        if (available && !disjoint) {
          const ns = gl.getQueryParameter(this.inFlightQuery, gl.QUERY_RESULT) as number;
          this.lastGpuMs = ns / 1e6;
        }
        if (available) {
          gl.deleteQuery(this.inFlightQuery);
          this.inFlightQuery = null;
        }
      }
      if (this.currentQuery && !this.inFlightQuery) {
        this.inFlightQuery = this.currentQuery;
        this.currentQuery = null;
      } else if (this.currentQuery) {
        // Previous still pending — drop the new one rather than leak (report keeps last good value).
        gl.deleteQuery(this.currentQuery);
        this.currentQuery = null;
      }
    } catch {
      /* ignore */
    }
  }

  /** End the measured frame and print one collapsed report. `snapshot` is the compositor's cache/VRAM
   *  state (optional — omitted when the compositor was unavailable). */
  endFrame(snapshot?: CompositorProfilerSnapshot | null): void {
    if (!this.recording) return;
    this.gpuEnd();
    this.recording = false;
    this.print(snapshot ?? null);
    this.previewRenders = 0;
    // Roll this frame's hashes forward as next frame's invalidation baseline.
    if (this.hashes.length > 0) {
      this.prevHashes = new Map(this.hashes.map((h) => [h.id, h]));
    }
  }

  private c(key: string): number {
    return this.counters[key] ?? 0;
  }
  private t(key: string): number {
    return this.timers[key] ?? 0;
  }

  /** Read the source-proxy engine's live stats off `globalThis` (populated by `sourceProxyEngine.ts`
   *  independently of this flag). Framework-free, same global-read style as `readFlag`. */
  private readSourceProxyStats(): {
    built: number; failed: number; skipped: number; queued: number; active: string | null;
    recent?: { assetId: string; outcome: string; note?: string }[];
  } | null {
    try {
      const w = globalThis as unknown as { __rfSourceProxy?: {
        built: number; failed: number; skipped: number; queued: number; active: string | null;
        recent?: { assetId: string; outcome: string; note?: string }[];
      } };
      return w.__rfSourceProxy ?? null;
    } catch {
      return null;
    }
  }

  /** Read the media layers' live-freeze watchdog (`__rfLiveFreeze`) + WebCodecs heal counters
   *  (`__rfWcHeals`), both populated by `WebglMediaLayer` independently of this flag. These name a
   *  forward-decode stall's CAUSE (element vs WebCodecs, paused/readyState/ended, decoder busyWedge)
   *  when a source freezes during play but still seeks fine on pause. */
  private readFreezeTelemetry(): {
    freeze: { count: number; worstBehindS: number; recent: Record<string, unknown>[] } | null;
    heals: Record<string, number> | null;
    pool: { active: number; idle: number; reused: number; created: number } | null;
    seeks: Record<string, number>;
  } {
    try {
      const w = globalThis as unknown as Record<string, unknown> & {
        __rfLiveFreeze?: { count: number; worstBehindS: number; recent: Record<string, unknown>[] };
        __rfWcHeals?: Record<string, number>;
        __rfVideoPoolStats?: { active: number; idle: number; reused: number; created: number };
      };
      // Per-event counters WebglMediaLayer bumps whenever it RELOADS or RE-SEEKS an element — each of
      // these drops readyState → a no-frame gap (the ~293ms freeze). A rising count names the culprit.
      const seeks: Record<string, number> = {};
      for (const k of ["__rfSettleSwaps", "__rfElementNudges", "__rfStrictSyncCorrections", "__rfStaleDrawKicks", "__rfWcHolds"] as const) {
        const v = w[k];
        if (typeof v === "number" && v > 0) seeks[k.replace(/^__rf/, "")] = v;
      }
      return { freeze: w.__rfLiveFreeze ?? null, heals: w.__rfWcHeals ?? null, pool: w.__rfVideoPoolStats ?? null, seeks };
    } catch {
      return { freeze: null, heals: null, pool: null, seeks: {} };
    }
  }

  /** Media-supply diagnosis: per-source frame delivery (which decoder stalled while playing) plus the
   *  source-proxy engine's build state, so a frozen source can be correlated to a failed / still-building
   *  proxy. The compositor/evaluator are proven cheap, so a "video freezes during playback" symptom lives
   *  in exactly these two places — this block names it. */
  private appendMediaSupply(lines: string[]): void {
    const seen = this.mediaSeen;
    lines.push("");
    lines.push("  Frame delivery (per source, while playing):");
    if (seen.length === 0) {
      lines.push("    (no media sources polled this frame)");
    } else {
      let advancing = 0, held = 0, stalled = 0, cold = 0;
      for (const s of seen) {
        const shortId = s.id.length > 40 ? `…${s.id.slice(-38)}` : s.id;
        let state: string;
        if (!s.hasFrame) { state = "no frame yet (decoding / not ready)"; cold += 1; }
        else if (s.heldFrames === 0) { state = "advancing"; advancing += 1; }
        else if (s.everAdvanced && s.heldFrames >= 20) { state = `⚠ STALLED — held ${s.heldFrames}f / ${Math.round(s.heldMs)}ms`; stalled += 1; }
        else if (!s.everAdvanced && s.heldFrames >= 20) { state = `held ${s.heldFrames}f (static still, or never started)`; held += 1; }
        else { state = `held ${s.heldFrames}f / ${Math.round(s.heldMs)}ms (normal fps repeat)`; held += 1; }
        lines.push(`    ${shortId.padEnd(40)} v${s.version}  ${state}`);
      }
      lines.push(`    ── ${seen.length} source(s): ${advancing} advancing · ${held} held · ${stalled} STALLED · ${cold} not-ready`);
      if (stalled > 0) lines.push("    ⚠ frozen while playing — decode/network stall, NOT compositor/evaluator (both proven cheap).");
    }
    const proxy = this.readSourceProxyStats();
    if (proxy) {
      lines.push("");
      lines.push("  Source proxy (build state):");
      lines.push(`    built ${proxy.built} · failed ${proxy.failed} · skipped ${proxy.skipped} · queued ${proxy.queued} · active ${proxy.active ?? "idle"}`);
      const fails = (proxy.recent ?? []).filter((r) => r.outcome === "failed" || (r.note != null && /fail|mismatch|error|abort/i.test(r.note)));
      for (const r of fails.slice(-4)) {
        lines.push(`    ✗ ${r.assetId}: ${r.outcome}${r.note ? ` (${r.note})` : ""}`);
      }
    }
    // Live-freeze watchdog + WebCodecs heal counters (WebglMediaLayer). These NAME a forward-decode
    // stall's cause: a frozen source shows up here with its decode mode + element state, and a rising
    // `busyWedge`/`pausedStall` count means decoder contention (Flarex's extra per-source decoders).
    const { freeze, heals, pool, seeks } = this.readFreezeTelemetry();
    if (pool) {
      // active = concurrent <video> decode sessions. Integrated GPUs expose only ~2–3 hardware decoders;
      // active well above that starves elements → LOST SOURCE freezes. Flarex inflates this (extra
      // hidden per-source loaders on top of the timeline). THIS is the number that confirms the cause.
      const warn = pool.active > 3 ? "  ⚠ >3 concurrent decoders — likely exceeds GPU hardware decode sessions" : "";
      lines.push("");
      lines.push(`  Video decoder pool: active ${pool.active} · idle ${pool.idle} · reused ${pool.reused} · created ${pool.created}${warn}`);
    }
    if (freeze && freeze.count > 0) {
      const worst = Number.isFinite(freeze.worstBehindS) ? `${freeze.worstBehindS}s` : "∞ (no-source)";
      lines.push("");
      lines.push(`  Live-freeze watchdog: ${freeze.count} total · worst ${worst} behind`);
      for (const r of freeze.recent.slice(-3)) {
        const mode = String(r.mode ?? "?");
        const behind = Number.isFinite(r.behindS as number) ? `${r.behindS}s` : "∞";
        const hint = mode === "none" ? " (NO decoder — init/preempt gap)" : "";
        const extra = [
          r.paused !== undefined ? `paused=${r.paused}` : null,
          r.readyState !== undefined ? `readyState=${r.readyState}` : null,
          r.ended !== undefined ? `ended=${r.ended}` : null,
          r.phase !== undefined ? `phase=${r.phase}` : null,
          r.playing !== undefined ? `playing=${r.playing}` : null,
        ].filter(Boolean).join(" ");
        lines.push(`    ⚠ ${String(r.src ?? "?")} — ${mode}${hint} ${behind} behind @ t=${r.timelineS ?? "?"}s${extra ? ` · ${extra}` : ""}`);
      }
    }
    if (heals) {
      const entries = Object.entries(heals).filter(([, n]) => n > 0);
      if (entries.length > 0) lines.push(`  WebCodecs heals: ${entries.map(([k, n]) => `${k} ${n}`).join(" · ")}`);
    }
    // Element reload/re-seek events — each drops readyState → a no-frame gap. `SettleSwaps` (proxy↔full-res
    // src swap) is the prime suspect for the ~293ms host-clip freeze; `ElementNudges`/`StrictSyncCorrections`
    // are drift-correction hard-seeks. A count climbing in lockstep with LOST SOURCE warnings names the cause.
    const seekEntries = Object.entries(seeks);
    if (seekEntries.length > 0) {
      lines.push(`  Element reloads/seeks: ${seekEntries.map(([k, n]) => `${k} ${n}`).join(" · ")}`);
    }
  }

  /** Classify each node's content hash vs. the previous frame: reused (unchanged), or changed with a
   *  reason (own resolved params changed vs. an upstream child's hash changed vs. brand-new node). */
  private appendHashDiff(lines: string[]): void {
    if (this.hashes.length === 0) {
      lines.push("(no Flarex comp compiled this frame)");
      return;
    }
    const changed: { rec: HashRecord; reason: string }[] = [];
    let reused = 0;
    for (const rec of this.hashes) {
      const prev = this.prevHashes.get(rec.id);
      if (prev && prev.hash === rec.hash) {
        reused += 1;
        continue;
      }
      let reason: string;
      if (!prev) reason = "new node (no previous frame)";
      else if (prev.localToken !== rec.localToken) reason = "own params/content changed";
      else reason = "upstream child hash changed";
      changed.push({ rec, reason });
    }
    lines.push(`Computed: ${this.hashes.length}`);
    lines.push(`Reused (unchanged vs prev frame): ${reused}`);
    if (this.prevHashes.size === 0) {
      lines.push("(first measured frame — no baseline yet; every node reads as new)");
    }
    if (changed.length > 0) {
      lines.push("Changed:");
      for (const { rec, reason } of changed) {
        lines.push(`    ${rec.type.padEnd(14)} ${rec.id}`);
        lines.push(`      reason: ${reason}`);
      }
    } else if (this.prevHashes.size > 0) {
      lines.push("Changed: none (graph content stable this frame)");
    }
  }

  /** Compile sub-phase breakdown (Step 0.5): where the `evaluator.compile` time goes — phase timers,
   *  emission/allocation counts, and per-node-type visit counts. All read 0/n/a when no Flarex clip
   *  compiled this frame. */
  private appendCompileBreakdown(lines: string[], fmtMs: (ms: number) => string, compileMs: number, hashMs: number): void {
    const lowerMs = this.t("compile.lower");
    if (compileMs <= 0 && lowerMs <= 0) return; // no Flarex compile this frame
    const fxMs = this.t("compile.effectExpansion");
    const calls = this.c("compile.calls");
    // Every ms of compile must belong to a timer: remaining = compile − hashing − lowering. Node ≈ 0;
    // a large browser remaining = work happening INSIDE compileFlarexComp but OUTSIDE the hash/lower
    // timers (setup, closures, or measurement/observer overhead).
    const remainingMs = compileMs - hashMs - lowerMs;
    lines.push("Compile breakdown (evaluator.compile)");
    lines.push("-------------------------------------");
    lines.push(`Total compile ........... ${fmtMs(compileMs)}  (${calls} call${calls === 1 ? "" : "s"} this frame${calls > 0 ? `, ${fmtMs(compileMs / calls)}/call` : ""})`);
    const resolveMs = this.t("compile.resolveSource");
    const pureLowerMs = Math.max(0, lowerMs - resolveMs);
    lines.push(`  ├─ content hashing .... ${fmtMs(hashMs)}`);
    lines.push(`  ├─ lowering (traversal) ${fmtMs(lowerMs)}`);
    lines.push(`  │    ├─ source adapter (resolveSourceDraw) ${fmtMs(resolveMs)} (${this.c("compile.resolveSourceCalls")} MediaIn)  ← browser-only`);
    lines.push(`  │    ├─ effect expansion ................... ${fmtMs(fxMs)} (${this.c("compile.effectExpansions")} calls)`);
    lines.push(`  │    └─ pure lowering (traversal+alloc) .... ${fmtMs(pureLowerMs)}`);
    lines.push(`  └─ remaining (unaccounted) ${fmtMs(remainingMs)}  ${remainingMs > 0.1 * compileMs && compileMs > 0 ? "← investigate" : "(≈0, fully accounted)"}`);
    lines.push("");
    lines.push("  Emission / allocation:");
    lines.push(`    Draw commands emitted . ${this.c("compile.drawCommands")}`);
    lines.push(`    Emitted operations .... ${this.c("compile.operations")}`);
    lines.push(`    Temp objects created .. ${this.c("compile.objects")}  (wraps ${this.c("compile.wraps")}, clones ${this.c("compile.clones")})`);
    lines.push(`    Temp arrays created ... ${this.c("compile.arrays")}`);
    lines.push(`    Temp maps created ..... ${this.c("compile.maps")}`);
    lines.push(`    Param evaluations ..... ${this.c("compile.paramEvals")}`);
    lines.push("");
    lines.push("  Node visits by type:");
    const visits = Object.entries(this.counters)
      .filter(([k]) => k.startsWith("visit."))
      .sort((a, b) => b[1] - a[1]);
    if (visits.length === 0) lines.push("    (none)");
    for (const [k, n] of visits) lines.push(`    ${k.slice("visit.".length).padEnd(14)} ${n}`);
    lines.push("");
  }

  /** Source-draw / grade breakdown (final verification): are the functions under `resolveSourceDraw`
   *  REBUILDING (cache miss → allocate) or looking up cached structures? Reports calls + cache hit-rate
   *  for the grade-pipeline cache (the one existing cache on this path) and per-function call counts. */
  private appendSourceDrawBreakdown(lines: string[], fmtMs: (ms: number) => string): void {
    const pipeCalls = this.c("grade.pipeline.calls");
    const layerDrawCalls = this.c("build.layerDraw.calls");
    if (pipeCalls === 0 && layerDrawCalls === 0) return; // nothing built this frame
    const hits = this.c("grade.pipeline.hits");
    const misses = this.c("grade.pipeline.misses");
    const noEffects = this.c("grade.pipeline.noEffects");
    const withEffects = hits + misses;
    lines.push("Source-draw / grade breakdown");
    lines.push("-----------------------------");
    lines.push(`resolveSourceDraw time .......... ${fmtMs(this.t("compile.resolveSource"))} (${this.c("compile.resolveSourceCalls")} MediaIn) — bounds everything below`);
    // Source-draw cache (build-scene-draws): a hit skips the full rebuild and rebinds only live media.
    const sdHits = this.c("sourceDraw.hits");
    const sdMisses = this.c("sourceDraw.misses");
    const sdLookups = sdHits + sdMisses;
    if (sdLookups > 0 || this.c("sourceDraw.uncached") > 0) {
      lines.push(
        `source-draw cache ............... ${sdHits} hit / ${sdMisses} miss` +
          `${sdLookups > 0 ? ` (${((sdHits / sdLookups) * 100).toFixed(0)}% hit)` : ""}` +
          `${this.c("sourceDraw.hitNotReady") ? `, ${this.c("sourceDraw.hitNotReady")} hit-but-not-ready` : ""}` +
          `${this.c("sourceDraw.uncached") ? `, ${this.c("sourceDraw.uncached")} uncached` : ""}`
      );
      lines.push(`  (a hit skips buildLayerDraw/getCompositionTransform/buildFragmentPasses; rebinds live media only)`);
    }
    lines.push("");
    lines.push("  Function                         Calls   Cache        Pure?");
    const row = (name: string, calls: number, cache: string, pure: string) =>
      lines.push(`    ${name.padEnd(30)} ${String(calls).padStart(4)}   ${cache.padEnd(11)} ${pure}`);
    row("buildLayerPreFlarexDraw", this.c("build.preFlarex.calls"), "—", "yes");
    row("buildLayerDraw", layerDrawCalls, "—", "yes (rebuilds)");
    row("getCompositionColorPipeline", pipeCalls, withEffects > 0 ? `${((hits / withEffects) * 100).toFixed(0)}% hit` : "n/a", "yes (cached)");
    row("getCompositionTransform", this.c("grade.transform.calls"), "none", "yes (rebuilds)");
    row("buildFragmentPasses", this.c("build.fragmentPasses.calls"), "none", "yes (rebuilds)");
    lines.push("");
    lines.push("  Grade-pipeline cache (colorPipelineCache, WeakMap on effects[] identity):");
    lines.push(`    lookups (with effects) . ${withEffects}   (+${noEffects} early-out, no effects)`);
    lines.push(`    hits ................... ${hits}`);
    lines.push(`    misses (REBUILD) ....... ${misses}${misses > 0 ? "   ← full pipeline recompile (stage alloc + tone-curve bake)" : ""}`);
    lines.push(`    hit rate ............... ${withEffects > 0 ? `${((hits / withEffects) * 100).toFixed(0)}%` : "n/a"}`);
    lines.push("");
    lines.push("  Verdict: " + (misses > 0
      ? `REBUILDING grade pipelines (${misses} recompiles/frame) — cacheable work is being redone.`
      : withEffects > 0
        ? "grade pipelines are CACHED hits — cost is traversal + allocation, not pipeline rebuild."
        : "no graded layers — cost is pure draw-structure allocation + traversal."));
    lines.push("");
  }

  private print(snap: CompositorProfilerSnapshot | null): void {
    const fmtMs = (ms: number) => `${ms.toFixed(2)} ms`;
    const gpuMs = this.lastGpuMs;
    const buildMs = this.t("evaluator.build");
    const compileMs = this.t("evaluator.compile");
    const hashMs = this.t("evaluator.hash");
    const compositorMs = this.t("compositor.render");
    const cpuMs = this.t("frame.cpu");

    // Top costs across the big buckets (real measured values only; unavailable ones excluded). Compile-only
    // (`evaluator.compile`, the Flarex lowering) is ranked when present — it localizes the evaluator cost
    // inside the broader `evaluator.build`.
    const costCandidates: [string, number][] = [
      ["GPU rendering", gpuMs ?? Number.NaN],
      ["Compositor (CPU submit)", compositorMs],
      [compileMs > 0 ? "Evaluator (Flarex compile)" : "Evaluator (build draw list)", compileMs > 0 ? compileMs : buildMs],
      ["Content hashing", hashMs],
    ];
    const costs = costCandidates.filter(([, v]) => Number.isFinite(v) && v > 0);
    costs.sort((a, b) => b[1] - a[1]);

    const uploadTotal = this.c("upload.total");
    const drawCalls = this.c("gpu.drawCalls");

    const lines: string[] = [];
    lines.push("========================");
    lines.push("FRAME PROFILER");
    lines.push("========================");
    lines.push("");
    lines.push(`Frame: ${this.frameNo}`);
    lines.push("");
    lines.push("Evaluator");
    lines.push("---------");
    lines.push(`Nodes evaluated ......... ${this.c("eval.nodesEvaluated")}`);
    lines.push(`Nodes skipped (memo) .... ${this.c("eval.nodesSkipped")}`);
    lines.push(`Materializations (seals)  ${this.c("eval.materializations")}`);
    lines.push(`Content hashes computed . ${this.c("eval.hashesComputed")}`);
    lines.push(`Time hashing ............ ${fmtMs(hashMs)}`);
    lines.push(`Time Flarex compile ..... ${compileMs > 0 ? fmtMs(compileMs) : "n/a (no Flarex clip / not timed)"}`);
    lines.push(`Time building draw list . ${fmtMs(buildMs)} (all of buildSceneDraws)`);
    // Recursion / retained-cache signal — the real target is "no recursive descent", not "0 evaluated".
    const depthSamples = this.c("eval.depthSamples");
    const avgDepth = depthSamples > 0 ? this.c("eval.depthSum") / depthSamples : 0;
    lines.push(`Peak recursion depth .... ${this.c("eval.peakDepth")}`);
    lines.push(`Avg recursion depth ..... ${avgDepth.toFixed(1)}  (over ${depthSamples} descents)`);
    lines.push("");
    lines.push("  Retained cache:");
    const hits = this.c("eval.cacheHits");
    const misses = this.c("eval.cacheMisses");
    const lookups = hits + misses;
    lines.push(`    Cache hits / misses ..... ${hits} / ${misses}${lookups > 0 ? `  (${((hits / lookups) * 100).toFixed(0)}% hit)` : ""}`);
    lines.push(`    Draw lists reused ....... ${this.c("eval.drawListsReused")}`);
    lines.push(`    Draw lists rebuilt ...... ${this.c("eval.drawListsRebuilt")}`);
    lines.push(`    Subgraphs skipped ....... ${this.c("eval.subgraphsSkipped")}`);
    const skCount = this.c("eval.skippedSubtreeCount");
    const skAvg = skCount > 0 ? this.c("eval.skippedSubtreeSum") / skCount : 0;
    lines.push(`    Skipped subtree (avg/max) ${skAvg.toFixed(1)} / ${this.c("eval.skippedSubtreeMax")} nodes`);
    lines.push(`    Cache lookup time ....... ${fmtMs(this.t("eval.cacheLookup"))}`);
    if (lookups === 0) lines.push(`    (retained cache not active yet — Step 1 not implemented)`);
    // WHERE the evaluation happened — the node lists, not just counts.
    if (this.evaluated.length > 0) {
      lines.push("");
      lines.push("  Evaluated:");
      for (const n of this.evaluated) lines.push(`    ${n.type.padEnd(14)} ${n.id}`);
    }
    if (this.skipped.length > 0) {
      lines.push("");
      lines.push("  Skipped (reused from memo — shared fan-out):");
      for (const n of this.skipped) lines.push(`    ${n.type.padEnd(14)} ${n.id}`);
    }
    lines.push("");
    // Content-hash invalidation diff (vs. previous frame) — did invalidation propagate correctly?
    lines.push("Content Hashes");
    lines.push("--------------");
    this.appendHashDiff(lines);
    lines.push("");
    this.appendCompileBreakdown(lines, fmtMs, compileMs, hashMs);
    this.appendSourceDrawBreakdown(lines, fmtMs);
    lines.push("Compositor");
    lines.push("----------");
    lines.push(`Draw calls .............. ${drawCalls}`);
    // WHERE the draw calls came from — attributed by render role.
    const scopeEntries = Object.entries(this.drawByScope).sort((a, b) => b[1] - a[1]);
    for (const [role, n] of scopeEntries) lines.push(`    ${role.padEnd(20)} ${n}`);
    lines.push(`Framebuffer binds ....... ${this.c("gpu.framebufferBinds")}`);
    lines.push(`Program switches ........ ${this.c("gpu.programSwitches")}`);
    lines.push(`Texture binds ........... ${this.c("gpu.textureBinds")}`);
    lines.push(`Texture creations ....... ${this.c("gpu.textureCreations")}`);
    lines.push(`Framebuffer creations ... ${this.c("gpu.framebufferCreations")}`);
    lines.push(`Texture storage allocs .. ${this.c("gpu.textureStorageAllocs")}`);
    lines.push(`Persistent cache hits ... ${this.c("texCache.hit")}`);
    lines.push(`Persistent cache misses . ${this.c("texCache.miss")}`);
    lines.push(`Compositor CPU submit ... ${fmtMs(compositorMs)}`);
    // RTT allocations: persistent (live, reused across frames — from the snapshot) vs. transient (new this frame).
    lines.push("");
    lines.push("  RTT allocations:");
    lines.push(`    Persistent (live, reused) . ${snap ? snap.renderTargetCount : "n/a"}`);
    lines.push(`    New this frame ............ ${this.c("rtt.alloc")}${this.c("rtt.resize") ? ` (+${this.c("rtt.resize")} resized)` : ""}`);
    if (this.rttTransient.length > 0) {
      const byLabel = new Map<string, number>();
      for (const l of this.rttTransient) byLabel.set(l, (byLabel.get(l) ?? 0) + 1);
      for (const [label, n] of byLabel) lines.push(`      ${label}${n > 1 ? ` ×${n}` : ""}`);
    }
    lines.push("");
    lines.push("Media");
    lines.push("-----");
    lines.push(`Video texture uploads ... ${this.c("upload.video")}`);
    lines.push(`Image texture uploads ... ${this.c("upload.image")}`);
    lines.push(`Canvas texture uploads .. ${this.c("upload.canvas")}`);
    lines.push(`Bitmap texture uploads .. ${this.c("upload.bitmap")}`);
    lines.push(`Pixel-buffer uploads .... ${this.c("gpu.pixelBufferUploads")}`);
    lines.push(`GPU uploads this frame .. ${uploadTotal}`);
    this.appendMediaSupply(lines);
    lines.push("");
    lines.push("GPU");
    lines.push("---");
    lines.push(`GPU frame time .......... ${gpuMs == null ? "n/a (timer query unavailable / warming up)" : fmtMs(gpuMs)}`);
    lines.push(`CPU frame time .......... ${fmtMs(cpuMs)}`);
    lines.push(`Draw passes ............. ${drawCalls}`);
    lines.push("");
    lines.push("UI");
    lines.push("--");
    lines.push(`Preview React renders ... ${this.previewRenders} (viewer should update via rAF, not React)`);
    lines.push(`Node graph redraws ...... n/a (independent canvas — not instrumented)`);
    lines.push(`Timeline redraws ........ n/a (independent canvas — not instrumented)`);
    lines.push("");
    lines.push("Memory");
    lines.push("------");
    if (snap) {
      lines.push(`Persistent cache entries  ${snap.srcTextureEntries} textures`);
      lines.push(`Render targets (live) ... ${snap.renderTargetCount}`);
      lines.push(`Compiled programs ....... ${snap.transitionPrograms} transition, ${snap.fragmentPrograms} fragment`);
      lines.push(`Pass-graph targets ...... ${snap.passGraphTargets}`);
      lines.push(`VRAM (textures) ......... ${(snap.srcTextureVramBytes / 1048576).toFixed(1)} MB`);
      lines.push(`VRAM (render targets) ... ${(snap.renderTargetVramBytes / 1048576).toFixed(1)} MB`);
      lines.push(`VRAM estimate (total) ... ${((snap.srcTextureVramBytes + snap.renderTargetVramBytes) / 1048576).toFixed(1)} MB`);
    } else {
      lines.push(`(compositor snapshot unavailable this frame)`);
    }
    lines.push("");
    lines.push("Top costs:");
    if (costs.length === 0) {
      lines.push("  (no timed subsystem exceeded 0 ms)");
    } else {
      costs.slice(0, 3).forEach(([label, ms], i) => {
        lines.push(`  ${i + 1}. ${label.padEnd(28, ".")} ${fmtMs(ms)}`);
      });
      const [topLabel] = costs[0]!;
      lines.push("");
      lines.push(`Likely bottleneck: ${topLabel}`);
    }
    lines.push("========================");

    const body = lines.join("\n");
    try {
      // Collapsed group so a playing timeline doesn't drown the console.
      // eslint-disable-next-line no-console
      console.groupCollapsed(`FRAME PROFILER — frame ${this.frameNo} · GPU ${gpuMs == null ? "n/a" : fmtMs(gpuMs)} · CPU ${fmtMs(cpuMs)}`);
      // eslint-disable-next-line no-console
      console.log(body);
      // eslint-disable-next-line no-console
      console.groupEnd();
    } catch {
      /* ignore console failures */
    }
    // Also stash the latest report for headless inspection (window.__flarexProfile).
    try {
      (globalThis as { __flarexProfile?: unknown }).__flarexProfile = {
        frame: this.frameNo,
        gpuMs,
        cpuMs,
        counters: { ...this.counters },
        timers: { ...this.timers },
        snapshot: snap,
        report: body,
      };
    } catch {
      /* ignore */
    }
  }
}

/** Process-wide singleton (one profiler for the app; matches the single preview compositor). */
export const frameProfiler = new FrameProfiler();
