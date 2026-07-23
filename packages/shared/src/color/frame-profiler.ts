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

  private print(snap: CompositorProfilerSnapshot | null): void {
    const fmtMs = (ms: number) => `${ms.toFixed(2)} ms`;
    const gpuMs = this.lastGpuMs;
    const buildMs = this.t("evaluator.build");
    const hashMs = this.t("evaluator.hash");
    const compositorMs = this.t("compositor.render");
    const cpuMs = this.t("frame.cpu");

    // Top costs across the big buckets (real measured values only; unavailable ones excluded).
    const costCandidates: [string, number][] = [
      ["GPU rendering", gpuMs ?? Number.NaN],
      ["Compositor (CPU submit)", compositorMs],
      ["Evaluator (build draw list)", buildMs],
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
    lines.push(`Time building draw list . ${fmtMs(buildMs)}`);
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
