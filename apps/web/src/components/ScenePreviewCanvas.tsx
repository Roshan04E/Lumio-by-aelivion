/**
 * Single GPU compositor preview surface (Method 3, Phases 1-4).
 *
 * Renders ONE `<canvas>` that the shared `SceneCompositor` composites every visual layer into — the
 * GPU replacement for laying each per-clip graded canvas out as a separate DOM sibling. MEDIA layers'
 * grading is unchanged: the caller mounts their `WebglMediaLayer`s (hidden) so they grade into
 * `gradedRef`; this component reads those graded canvases as textures (object-fit + clip mask +
 * transform + blend + blur/glow in the GPU pass). TEXT/SHAPE layers (Phase 4) are rasterized via the
 * export's `drawTextLayer`/`drawShapeLayer` (cached in `SceneTextRasterizer`) and composited as
 * `fit:"fill"` identity layers, so they interleave with media by z-order and pick up GPU blend +
 * blur/glow for free. Only selection/motion/mask **handles** stay DOM (the caller renders them).
 *
 * Opacity + transform are baked into each source (graded canvas for media, mode-"full" raster for
 * text/shape), so the compositor draws media at full opacity and text/shape with an identity transform.
 *
 * This whole surface only mounts when the `compositor=scene` flag is on AND the comp is scene-eligible
 * (see `VideoPreview`); otherwise the shipped DOM path renders unchanged.
 */

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  SceneCompositor,
  SCENE_COMPOSITOR_CONTEXT_LOST,
  MEDIA_RENDERER_CONTEXT_LOST,
  GL_CONTEXT_LOST,
  MediaWebGLRenderer,
  RenderTarget,
  getCompositionFilterEffects,
  getTexImageSourceProducerInfo,
  getTransition,
  SceneMaskMatteCache,
  SceneTextRasterizer,
  buildSceneDraws,
  type FlarexCompProxyFrame,
  frameProfiler,
  FlarexSourceDrawCache,
  beginFrame,
  colorPipelineCacheKey,
  defaultSession,
  endFrame,
  forgetResource,
  kernelDiagnostics,
  noteHeld,
  notePresent,
  recordFlarexDegradation,
  registerResource,
  servedTime,
  touchResource,
  type ServedTime,
  type ColorPipeline,
  type FrameOutcome,
  type FlarexComp,
  type NestedGroupSpec,
  type SceneFrameSpec,
  type SceneTextureSource,
  type TimelineLayer,
  type ScenePreviewTransition,
  isSceneTextureSource,
  sceneTexture,
  activeFrame,
  type ResourceHandle,
} from "@orreris/shared";
import { isPreviewSuspendedForExport } from "../export/export-preview-suspend";
import { KERNEL_FLAGS, readKernelFlag } from "../playback/kernel-flags";
import {
  abortIncrementalFrame,
  beginIncrementalFrame,
  commitIncrementalFrame,
} from "../playback/incremental-evaluation";
import {
  gradeResourceKey,
  gradeScopeOf,
  mediaResourceKey,
  pruneDepartedSceneResources,
  releaseScratchSceneResources,
  sweepIdleSceneResources,
} from "../playback/scene-resource-orchestration";
import { advanceBlockingClock, decideSceneReadiness } from "../playback/scene-readiness";
import { runLiveFrameScope } from "../playback/scene-frame-scope";
import { recordPlaybackFrame } from "../editor/performance/frame-stats";
import { markHotSpot } from "../lib/perfDiagnostics";
import { getHdrPipelineEnabled, getRegionPassesEnabled } from "../color/render-engine";
import type { ScenePreviewMediaSource } from "./scene-media-source";
import {
  STALE_HOLD_MAX_MS,
  getCoherenceHoldEnabled,
  isStale,
  getCoherenceUnifiedEnabled,
} from "../playback/temporal-coherence";
import { decideFullResRendezvous } from "../playback/full-res-rendezvous";
import { getFrameCompletionEnabled, getKernelResourcesEnabled } from "../playback/frame-completion";
import { isReadaheadProbeEnabled, noteReadaheadComposite, type ReadaheadSample } from "../playback/readahead-probe";

export type { ScenePreviewTransition } from "@orreris/shared";

/**
 * Label a producer's raw served-time reading as a kernel {@link ServedTime} (ADR-012 T5, slice S4.2).
 *
 * This grade stage is where the value crossed from "a number the media layer happens to know" into the
 * scene graph, and it is exactly where it used to be dropped — the texture was modelled as pixels
 * rather than as pixels-at-a-moment, so everything downstream had to infer coherence from a monotonic
 * publish counter that structurally cannot answer "is this the texture for the frame I am about to
 * present?".
 *
 * Returns a SPREADABLE partial rather than a bare value so that "the path cannot say" stays *absent*
 * instead of becoming `servedTime: undefined`. Under `exactOptionalPropertyTypes` those are different
 * things, and the distinction is load-bearing: absent means unknowable (a still, a generator raster),
 * and it must never be readable as "assume it is current".
 */
function servedTimeOf(seconds: number | null): { servedTime?: ServedTime } {
  return seconds == null || !Number.isFinite(seconds) ? {} : { servedTime: servedTime(seconds) };
}

/** Soak telemetry (__rf* convention) for the single-ctx preview: `grades` = in-context media grades that
 *  actually ran, `skips` = frames a media layer's cached RenderTarget was reused (unchanged frame + grade).
 *  A nonzero `grades` proves the GPU-first path is engaged (window.__rfSingleCtxPreview). */
function recordSingleCtx(kind: "grades" | "skips" | "fullResSwaps" | "fullResHatch"): void {
  if (typeof window === "undefined") return;
  const w = window as { __rfSingleCtxPreview?: Record<string, number> };
  const s = (w.__rfSingleCtxPreview ??= { grades: 0, skips: 0, fullResSwaps: 0, fullResHatch: 0 });
  s[kind] = (s[kind] ?? 0) + 1;
}


/**
 * TEMPORAL-COHERENCE probe (`window.__flarexCoherence`, the `__rf` / `__flarex` debug-global convention).
 *
 * Separate from `frameProfiler` on purpose: the profiler records only while the transport is PLAYING
 * (see FLAREX_PROFILER.md), and every number this work is judged on — time to a coherent frame after a
 * scrub, average and worst-case convergence latency — is a PAUSED measurement. Always on, because it is
 * a handful of numbers per composite with no allocation on the coherent path; the per-composite sample
 * ring is only kept when `?flarexProfile=1` is set.
 *
 * Read it with `__flarexCoherence.report()` for a formatted summary, or inspect the object directly.
 * `holdStreaks` counts CONVERGENCE EVENTS (one per scrub that had to wait), so `avgHoldMs` is
 * per-scrub, not per-frame.
 *
 * The number to watch is `escapeHatches`. A coherent frame that arrived by WAITING is the mechanism
 * working; one that arrived because a hatch fired is a mixed-generation frame that reached the screen
 * anyway. A healthy session has escapeHatches ≈ 0 — if it climbs, the barrier is being overridden and
 * the staleness is a real convergence failure, not a scheduling artifact.
 */
interface CoherenceStats {
  /** Composites that reached the gate. */
  composites: number;
  /** Composites withheld because a source was showing the wrong time. */
  heldComposites: number;
  /** Distinct hold episodes (a scrub that had to wait for convergence). */
  holdStreaks: number;
  /** Wall ms the most recent episode spent waiting — "time to coherent frame after a scrub". */
  lastHoldMs: number;
  maxHoldMs: number;
  avgHoldMs: number;
  /** Worst single-source staleness observed, seconds. */
  maxStalenessSeconds: number;
  /**
   * Composites in which each source read stale. Accumulated whether or not the frame was HELD —
   * with the hold flag off nothing ever holds, and attributing only held frames left the instrument
   * naming no source at all on exactly the runs it exists to explain (2026-07-28).
   */
  offenders: Record<string, number>;
  /** Worst staleness per source, ms. Distinguishes "a few frames behind" from "not decoding at all". */
  staleWorstMs: Record<string, number>;
  /** Presents that went out WITH stale sources — the barrier overridden. Should stay ~0. */
  escapeHatches: number;
  /** ...of which: the contiguous hold hit STALE_HOLD_MAX_MS (sources were still converging). */
  escapeHatchEpisode: number;
  /** ...of which: every stale source was written off (something is not converging at all). */
  escapeHatchWriteOff: number;
  samples?: { t: number; staleIds: string[]; maxStalenessSeconds: number; heldMs: number }[];
  /**
   * PER-COMPOSITE TRACE (2026-07-28). The aggregate counters above answer "how often" and cannot
   * answer "what happened across ONE ruler click" — which is the remaining question: the viewer shows
   * one picture, then a second, correct one. Arm with `__flarexCoherence.trace()`, click once, then
   * `__flarexCoherence.traceReport()`.
   *
   * Records EVERY media source each composite, not just the stale ones, because the interesting row
   * is the one that reads coherent while showing the wrong picture — a source missing from the stale
   * list is evidence, not noise.
   */
  traceFrames?: { t: number; held: boolean; reason: string; staleness: Record<string, number | null> }[];
  traceRemaining?: number;
  /** Arm the per-composite trace for the next `frames` composites. */
  trace(frames?: number): void;
  /** Print the armed trace as a timeline. */
  traceReport(): void;
  /** Formatted console summary — the manual-verification readout. */
  report(): void;
  /** Zero the counters (call before each measured scrub run). */
  reset(): void;
}
function createCoherenceStats(): CoherenceStats {
  const s: CoherenceStats = {
    composites: 0,
    heldComposites: 0,
    holdStreaks: 0,
    lastHoldMs: 0,
    maxHoldMs: 0,
    avgHoldMs: 0,
    maxStalenessSeconds: 0,
    offenders: {},
    staleWorstMs: {},
    escapeHatches: 0,
    escapeHatchEpisode: 0,
    escapeHatchWriteOff: 0,
    trace(frames = 150) {
      s.traceFrames = [];
      s.traceRemaining = frames;
      console.log(`[coherence] tracing the next ${frames} composites — click the ruler ONCE, then __flarexCoherence.traceReport()`);
    },
    traceReport() {
      const rows = s.traceFrames ?? [];
      if (rows.length === 0) {
        console.warn("[coherence] nothing traced — call __flarexCoherence.trace() first, then interact");
        return;
      }
      const ids = [...new Set(rows.flatMap((r) => Object.keys(r.staleness)))];
      const t0 = rows[0]!.t;
      console.group(`%c[coherence] ${rows.length} composites over ${Math.round(rows[rows.length - 1]!.t - t0)}ms`, "font-weight:bold");
      console.table(
        rows.map((r) => {
          const row: Record<string, string | number> = { ms: Math.round(r.t - t0), present: r.held ? "HELD" : "shown", why: r.reason };
          for (const id of ids) {
            const v = r.staleness[id];
            // Short tail of the id: the long flarex source keys are unreadable in a table.
            // "—" = time-invariant (still/generator). "WAIT" = a video with no decode for this time,
            // which is the case that used to read "—" and silently present the previous picture.
            row[id.slice(-14)] = v == null ? "—" : !Number.isFinite(v) ? "WAIT" : Number((v * 1000).toFixed(0));
          }
          return row;
        })
      );
      console.log("staleness in ms; '—' = time-invariant; 'WAIT' = video with no decode yet. A 'shown' row with a large number or WAIT is a wrong-picture present.");
      console.groupEnd();
    },
    reset() {
      Object.assign(s, {
        composites: 0,
        heldComposites: 0,
        holdStreaks: 0,
        lastHoldMs: 0,
        maxHoldMs: 0,
        avgHoldMs: 0,
        maxStalenessSeconds: 0,
        offenders: {},
        staleWorstMs: {},
        escapeHatches: 0,
        escapeHatchEpisode: 0,
        escapeHatchWriteOff: 0,
      });
      if (s.samples) s.samples.length = 0;
      console.log("[coherence] counters reset — scrub now, then call __flarexCoherence.report()");
    },
    report() {
      const ms = (n: number) => `${n.toFixed(1)}ms`;
      console.group("%c[coherence] temporal coherence", "font-weight:bold");
      console.log(`composites          ${s.composites}  (${s.heldComposites} withheld)`);
      console.log(`convergence events  ${s.holdStreaks}   ← one per scrub that had to wait`);
      console.log(`time to coherent    last ${ms(s.lastHoldMs)} · avg ${ms(s.avgHoldMs)} · worst ${ms(s.maxHoldMs)}`);
      console.log(`worst staleness     ${(s.maxStalenessSeconds * 1000).toFixed(1)}ms beyond one frame`);
      // The SAME counter means two different things depending on whether the barrier was armed, and
      // reporting it as "barrier overridden" with the flag off was actively misleading (2026-07-28:
      // 1174 "escape hatches" in a run where nothing could ever hold). With the hold disabled this is
      // simply the incoherent-frame RATE — the Track B baseline, not a failure of anything.
      const armed = getCoherenceHoldEnabled();
      const pct = s.composites > 0 ? ((s.escapeHatches / s.composites) * 100).toFixed(1) : "0.0";
      if (s.escapeHatches === 0) {
        console.log("%cincoherent frames   0  ✓ every presented frame was temporally coherent", "color:#3c3");
      } else if (armed) {
        console.log(
          `%cescape hatches      ${s.escapeHatches}  ✗ mixed-generation frames reached the screen ` +
            `(${s.escapeHatchEpisode} episode-cap, ${s.escapeHatchWriteOff} write-off)`,
          "color:#e55"
        );
      } else {
        console.log(
          `%cincoherent frames   ${s.escapeHatches} of ${s.composites} (${pct}%)  — barrier DISABLED, ` +
            "this is the baseline rate, not an override (?flarexCoherence=1 to arm it)",
          "color:#e90"
        );
      }
      const offenders = Object.entries(s.offenders).sort((a, b) => b[1] - a[1]);
      if (offenders.length > 0) {
        console.log(armed ? "stale sources (most first):" : "stale sources — worst offender is the one to chase:");
        for (const [id, n] of offenders.slice(0, 8)) {
          const worst = s.staleWorstMs[id] ?? 0;
          // Seconds of staleness is the tell: a few frames behind is latency, 20s+ is a source that
          // is not decoding at all and will never converge on its own.
          const verdict = worst >= 5000 ? "  ← NOT CONVERGING" : worst >= 500 ? "  ← lagging" : "";
          console.log(`   ${n.toString().padStart(5)}  ${id}   worst ${worst.toFixed(0)}ms${verdict}`);
        }
      }
      console.groupEnd();
    },
  };
  return s;
}

/**
 * SCOPE: the hold clock is passed in by the caller, never held here, because coherence is scoped to
 * ONE viewer's present. A present is atomic per canvas, so the barrier's unit is the graph that canvas
 * evaluated; independent viewers (tool pages, fixtures, proxy capture) each mount their own
 * `ScenePreviewCanvas` with their own transport and must never be able to block each other. Only the
 * aggregate counters below are process-wide, and those are read-only telemetry.
 */
function noteCoherence(
  holdStart: { current: number | null },
  t: number,
  staleIds: string[],
  maxStalenessSeconds: number,
  held: boolean,
  staleBySource: Record<string, number>,
  allStaleness: Record<string, number | null>,
  reason: string
): void {
  if (typeof window === "undefined") return;
  const w = window as { __flarexCoherence?: CoherenceStats };
  const s = (w.__flarexCoherence ??= createCoherenceStats());
  // HIDDEN TAB (2026-07-28). The browser suspends media decode in a background tab, so no source can
  // converge and every composite would score as a write-off — measured 6153 of them across a session
  // containing a 29.7s hidden stretch. Counting that is not a measurement of the barrier, it is a
  // measurement of the tab being in the background. Same error the stall watchdog had; different
  // instrument.
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  s.composites += 1;
  if (s.traceRemaining && s.traceRemaining > 0) {
    s.traceRemaining -= 1;
    (s.traceFrames ??= []).push({ t: performance.now(), held, reason, staleness: { ...allStaleness } });
  }
  if (maxStalenessSeconds > s.maxStalenessSeconds) s.maxStalenessSeconds = maxStalenessSeconds;
  // Attribution runs on BOTH paths: with the barrier disabled no frame is ever held, and attributing
  // only held frames left `offenders` empty on precisely the runs that needed explaining.
  for (const id of staleIds) {
    s.offenders[id] = (s.offenders[id] ?? 0) + 1;
    const ms = (staleBySource[id] ?? 0) * 1000;
    if (ms > (s.staleWorstMs[id] ?? 0)) s.staleWorstMs[id] = ms;
  }
  const now = performance.now();
  if (held) {
    s.heldComposites += 1;
    if (holdStart.current === null) {
      holdStart.current = now;
      s.holdStreaks += 1;
    }
    return;
  }
  // Presenting WITH stale sources means a hatch fired — the barrier was overridden and a
  // mixed-generation frame is going to the screen. Attribute it, because the two hatches mean
  // different things for Track B: an episode-cap hit says sources were still converging and just ran
  // out of time (a LATENCY problem), while a write-off says something is not converging at all (a
  // decoder problem — check `offenders` and `__rfWcMode` for that source).
  if (staleIds.length > 0) {
    s.escapeHatches += 1;
    const episodeExpired = holdStart.current !== null && now - holdStart.current >= STALE_HOLD_MAX_MS;
    if (episodeExpired) s.escapeHatchEpisode += 1;
    else s.escapeHatchWriteOff += 1;
  }
  // A present after a hold CLOSES the episode: this wall delta is the convergence latency.
  if (holdStart.current !== null) {
    const heldMs = now - holdStart.current;
    holdStart.current = null;
    s.lastHoldMs = heldMs;
    if (heldMs > s.maxHoldMs) s.maxHoldMs = heldMs;
    s.avgHoldMs = s.avgHoldMs + (heldMs - s.avgHoldMs) / Math.max(1, s.holdStreaks);
    if (frameProfiler.enabled()) {
      (s.samples ??= []).push({ t, staleIds: [...staleIds], maxStalenessSeconds, heldMs });
      if (s.samples.length > 240) s.samples.shift();
    }
  }
}

/**
 * Viewer-capture handle (todo.md Phase 6B P1a — "the proxy IS the viewer"). Lets the background proxy
 * generator render arbitrary timeline times through THIS preview's own SceneCompositor instance — same
 * texture caches, text rasterizer, matte cache, draw builder, and flags as the visible frame — WITHOUT
 * presenting, so the on-screen canvas keeps its last frame. The caller supplies its own media sources
 * (pooled `<video>` decode + shared-context grade); everything else is the live viewer.
 */
export interface SceneViewerCaptureHandle {
  /** Compositor's shared GL context for caller-owned grade renderers (null when lost/unavailable). */
  getSharedGl(): WebGL2RenderingContext | null;
  /** Rasterize text/shape layers for `timeSeconds` (async; cached — cheap after the first frame). */
  ensureTextRasters(layers: TimelineLayer[], timeSeconds: number): Promise<void>;
  /**
   * Build the frame's draw list at `timeSeconds` with caller-provided media and composite it offscreen.
   * Returns top-origin RGBA pixels at the current backing size, or null when the compositor is unavailable.
   */
  renderOffscreen(input: {
    layers: TimelineLayer[];
    timeSeconds: number;
    transitions: ScenePreviewTransition[];
    getMediaGraded: (id: string) => HTMLCanvasElement | SceneTextureSource | null;
    buffer?: Uint8Array | undefined;
  }): { pixels: Uint8Array; width: number; height: number } | null;
  /**
   * Render ONE Flarex node's output as a small thumbnail (Slice 6), through this viewer's own
   * compositor, caches and media textures — the same "the preview IS the renderer" mechanism the comp
   * proxy uses, so no second GL context is allocated and the context governor sees no new pressure.
   *
   * The comp is re-rooted at `nodeId` via `flarexPreviewRootNodeId`, which takes precedence over the
   * comp's persisted view dot WITHOUT mutating it — rendering thumbnails can never move the user's own
   * view-dot selection.
   *
   * Returns null (caller: "not ready, try later") whenever the picture would be wrong or the cost would
   * land in the wrong place — while PLAYING, before the first frame has composited, or when the host
   * clip is not among the layers currently on screen.
   */
  renderFlarexNodeThumbnail(input: {
    /** The clip carrying the comp. Must be one of the viewer's current layers. */
    hostLayerId: string;
    nodeId: string;
    targetWidth: number;
    targetHeight: number;
    buffer?: Uint8Array | undefined;
  }): { pixels: Uint8Array; width: number; height: number } | null;
  /**
   * Downsample the RETAINED composite (last presented frame) into a small top-origin RGBA thumbnail
   * for the color scopes — no re-composite, no dependence on the on-screen canvas. Null when the
   * compositor is unavailable this frame (caller falls back to a DOM-element sample).
   */
  readCompositeThumbnail(
    targetW: number,
    targetH: number,
    buffer?: Uint8Array
  ): { pixels: Uint8Array; width: number; height: number } | null;
  /** Dispose the capture-scoped text-grade renderers (call when a capture run finishes). */
  releaseCaptureResources(): void;
}

// After any change (scrub/seek/mount) keep compositing for this long so async work — a clip's graded
// frame, a text raster — lands on screen. While PLAYING we composite every frame regardless.
const SCENE_SETTLE_MS = 600;

// The not-ready hold caps now live with the gate that applies them, in `playback/scene-readiness.ts`.

// TEMPORAL COHERENCE (2026-07-28): the not-ready gate above asks "does this layer have a texture",
// which is presentation BATCHING, not temporal synchronization — see `playback/temporal-coherence.ts`
// for the invariant, the reasoning, and the (pure, testable) decision functions this file drives.

// Bounded GPU recovery. On a WebGL context loss the preview used to latch PERMANENTLY to the DOM path — which
// is NOT pixel-identical to the scene compositor, so a transient GPU eviction meant a lasting fidelity + quality
// regression. Instead we rebuild the compositor on a fresh context up to MAX_SCENE_REBUILDS times (backoff
// below), keeping the EXACT GPU scene; only after the budget is exhausted do we degrade to DOM, once, quietly.
// The context governor (getGlGovernorEnabled) keeps large timelines under the browser cap so a loss is rare in
// the first place; this is the safety net for when one still happens.
const MAX_SCENE_REBUILDS = 3;
const RECOVERY_BACKOFF_MS = [150, 300, 600];
// A sustained run of clean frames after a rebuild resets the attempt budget, so a later unrelated loss gets a
// fresh set of retries instead of immediately falling to DOM.
const HEALTHY_FRAMES_TO_RESET = 120;

export interface ScenePreviewCanvasProps {
  /** ALL scene-eligible visual layers (media + text/shape) in back-to-front (z) order. Includes the two
   *  clips of an active transition, so the mix can be placed at the incoming clip's z-slot. */
  layers: TimelineLayer[];
  width: number;
  height: number;
  backgroundColor: string;
  currentTime: number;
  isPlaying: boolean;
  /** Live map of each layer's graded canvas, populated by the hidden WebglMediaLayers. */
  gradedRef: React.MutableRefObject<Record<string, HTMLCanvasElement | null>>;
  /**
   * Single-context GPU-first preview (Phase 5, `orreris.singleCtxPreview`). When true, media layers do NOT
   * grade into `gradedRef`; instead each publishes a raw frame-source descriptor into `mediaSourcesRef`,
   * and THIS component grades the frame in-context through a shared-context `MediaWebGLRenderer` +
   * `RenderTarget` on the SceneCompositor's own WebGL2 context (one upload/layer/frame, zero per-clip GL
   * contexts). Mirrors the single-context EXPORT path. Off (default) = the shipped per-clip-canvas path.
   */
  singleCtxMedia?: boolean | undefined;
  /** Single-ctx: live map of each media layer's raw frame-source descriptor (see `singleCtxMedia`). */
  mediaSourcesRef?: React.MutableRefObject<Record<string, ScenePreviewMediaSource | null>> | undefined;
  /** Called if the GPU compositor can't init/draw — the caller falls back to the DOM path. */
  onFailure?: () => void;
  /**
   * Populated with this canvas's `requestDraw` so the caller can re-arm a recomposite imperatively (no
   * React re-render) when a MEDIA layer re-grades while paused — the analog of the text rasterizer's
   * `onReady`. Without it a paused re-grade only lands via the `layers`-change settle window (a timing
   * heuristic), which can leave the viewer showing a stale frame after an edit.
   */
  redrawRef?: React.MutableRefObject<(() => void) | null>;
  /**
   * Playback render-resolution scale (1 = Full, 0.5 = Half, 0.25 = Quarter). The GPU BACKING renders at
   * `comp × renderScale` while the canvas CSS display size stays logical comp (the browser upscales) — so
   * every GPU pass rasterizes `renderScale²` the fragments. Logical comp (text layout, transforms, masks)
   * is unchanged; only the element-box quad half-extents scale with it. Caller passes 1 when paused.
   */
  renderScale?: number;
  /** Active junction transitions at `currentTime` — the scene pass mixes them in (Phase 4.2). */
  transitions?: ScenePreviewTransition[];
  /** Called after the scene compositor successfully renders a frame. Used by live preview proxy coverage. */
  onFrameRendered?: ((timeSeconds: number) => void) | undefined;
  /**
   * Region-blur clone → base layer id. A region-mask blur expands a media layer into [base, blurred-region
   * clone]; the clone's decoded+graded media source is IDENTICAL to its base (blur is a GPU pass here, not
   * baked into the grade), so the caller does NOT mount the clone's own `WebglMediaLayer` — this maps the
   * clone's id to the base whose graded canvas it reads. Saves a `<video>` decoder + GL context per clone
   * (the "too many WebGL contexts" eviction) and keeps the clone frame-synced to the base.
   */
  mediaSourceAlias?: Map<string, string>;
  /** Compound-clip group specs from `expandNestedCompositions` (NESTING.md Phase C) — `layers` above is
   *  already the FULLY EXPANDED list (nested children present as ordinary layers); this is consulted only
   *  to fold them back into a `SceneGroupDraw` per compound-clip instance. Undefined/empty = no nesting. */
  nestedGroups?: ReadonlyMap<string, NestedGroupSpec> | undefined;
  /** Flarex node comps (`ProjectGraph.flarexComps`, FLAREX.md) — buildSceneDraws lowers `flarexCompId`
   *  clips through the shared compiler. Undefined = comp'd clips render plain. */
  flarexComps?: Record<string, FlarexComp> | undefined;
  /** Live per-comp view dots (`compId → nodeId`) as RUNTIME input — ADR-012 §0.5, slice S1.2. The
   *  compiler no longer reads the persisted `comp.previewNodeId`, so this is the only channel by which
   *  a view dot reaches the viewer. Export and the worker pass nothing and root at MediaOut (I-26). */
  flarexPreviewRoots?: Readonly<Record<string, string>> | undefined;
  /** Flarex asset-source MediaIn virtual loaders (FLAREX.md Phase 2, Fusion model): synthetic
   *  off-timeline media layers whose graded canvases the caller ALSO publishes into `gradedRef`
   *  (by virtual id), consulted only by the Flarex compiler's `resolveSourceDraw`. Undefined = no
   *  asset-source MediaIns; every MediaIn resolves to its host clip. */
  flarexVirtualLayers?: TimelineLayer[] | undefined;
  /**
   * Pre-rendered comp frames by comp id (plans/flarex-comp-proxy.md, S2). A comp with an entry draws
   * that frame instead of lowering its graph — the playback win. A REF, not a prop value: the frames
   * are refreshed by their own decoder between renders, and the draw loop must read the latest.
   * The owner (`useFlarexCompProxies`) is responsible for only publishing frames whose stored key still
   * matches the comp, and only for comps where an opaque stand-in is safe.
   */
  flarexCompProxiesRef?: React.MutableRefObject<Record<string, FlarexCompProxyFrame>> | undefined;
  /** Populated with the viewer-capture handle (background proxy generation renders through THIS preview). */
  captureRef?: React.MutableRefObject<SceneViewerCaptureHandle | null> | undefined;
  /**
   * Every shader-transition id the composition uses (not just the active ones) — pre-warmed
   * (compiled + cached) during idle so the first frame of a cut never pays a compile stall.
   */
  prewarmTransitionIds?: readonly string[] | undefined;
}

export function ScenePreviewCanvas({
  layers,
  width,
  height,
  backgroundColor,
  currentTime,
  isPlaying,
  gradedRef,
  onFailure,
  redrawRef,
  renderScale = 1,
  transitions = [],
  onFrameRendered,
  mediaSourceAlias,
  nestedGroups,
  flarexComps,
  flarexPreviewRoots,
  flarexVirtualLayers,
  flarexCompProxiesRef,
  captureRef,
  prewarmTransitionIds,
  singleCtxMedia = false,
  mediaSourcesRef,
}: ScenePreviewCanvasProps) {
  // Frame profiler (debug-only, flarexProfile flag): count this component's React renders so the report
  // can confirm the viewer updates via rAF, not React re-render, during playback. No-op when disabled.
  frameProfiler.notePreviewRender();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const compositorRef = useRef<SceneCompositor | null>(null);
  const matteCacheRef = useRef<SceneMaskMatteCache | null>(null);
  // Per-nested-composition matte caches (NESTING.md Phase C), pooled across frames — see the
  // `nestMatteCaches` doc on `BuildSceneDrawsInputs`. Lives independently of `matteCacheRef` (which is
  // fixed to the PARENT comp's size); disposed alongside it on unmount/rebuild.
  const nestMatteCachesRef = useRef<Map<string, SceneMaskMatteCache>>(new Map());
  // Cross-frame cache for Flarex asset-source draws (perf): a bare loader's draw structure is
  // time-invariant, so a hit reuses the immutable template and rebinds only the live media handle,
  // skipping the per-frame `buildLayerPreFlarexDraw` rebuild. Persists across frames like `matteCache`;
  // shared by the live + capture build paths. Plain JS (no GPU resources) → cleared, not disposed.
  const flarexSourceDrawCacheRef = useRef<FlarexSourceDrawCache>(new FlarexSourceDrawCache());
  const rasterizerRef = useRef<SceneTextRasterizer | null>(null);
  /**
   * SCRATCH SCOPE (ADR-012 I-32, slice S2.3) — the caches a thumbnail or capture frame uses instead of
   * the live ones. Built lazily on first scratch frame and disposed with the capture handle, so an
   * editor that never opens a thumbnail pays nothing.
   *
   * The matte cache is dimension-bound (`new SceneMaskMatteCache(w, h)`), so the scratch copy tracks the
   * dimensions it was built for and is rebuilt when they change — the same reason the live one lives in
   * a `[width, height]` effect.
   */
  const scratchMatteCacheRef = useRef<{ cache: SceneMaskMatteCache; width: number; height: number } | null>(null);
  const scratchNestMatteCachesRef = useRef<Map<string, SceneMaskMatteCache>>(new Map());
  const scratchFlarexSourceDrawCacheRef = useRef<FlarexSourceDrawCache>(new FlarexSourceDrawCache());
  // R1 fix: first-blocked timestamp per currently-unready layer id (escape-hatch timer for the
  // hold-previous-frame gate in `drawRef.current` — see `NOT_READY_HOLD_MS`).
  const notReadySinceRef = useRef<Map<string, number>>(new Map());
  // Wall time this viewer's current coherence hold began (null = not holding). Per-instance, not
  // module-level: see the SCOPE note on `noteCoherence`.
  const coherenceHoldStartRef = useRef<number | null>(null);
  /**
   * ATOMIC FULL-RES SWAP (2026-07-28). Has this viewer committed to its sources' full-res settle
   * frames? False = everyone shows their proxy frame; true = everyone who has an upgrade uses it.
   * Because it is one flag for the whole viewer, sources cannot sharpen at different moments —
   * which is the entire point. Per-instance: two viewers of the same media must never be able to
   * force each other's swap.
   */
  const fullResCommittedRef = useRef(false);
  /** Wall time the current "waiting for upgrades" episode began (null = nobody pending). */
  const fullResPendingSinceRef = useRef<number | null>(null);
  /**
   * RETURNING FROM A HIDDEN TAB (2026-07-28) — restart every hold clock, do not resume them.
   *
   * A background tab has its media decode suspended, so time spent hidden is time in which no source
   * COULD converge. Left alone, the per-source write-off clocks and the episode clock keep running
   * across it, so the first composite after you come back finds every budget already spent, fires the
   * escape hatch immediately, and presents the sources independently — the exact symptom the barrier
   * exists to prevent, reappearing precisely when the user looks at the tab again.
   *
   * Elapsed wall time is only a fair budget when it was time the source could have used.
   */
  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      staleSinceRef.current.clear();
      notReadySinceRef.current.clear();
      coherenceHoldStartRef.current = null;
      fullResPendingSinceRef.current = null;
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);
  // Wall time each currently-stale source was first seen stale — the per-source write-off clock.
  // Kept SEPARATE from `notReadySinceRef` even though both are "how long has this blocked": that map
  // is pruned against `notReadyIds` and its caps are chosen per layer TYPE, while this one is pruned
  // against `staleIds` and is uniform. Sharing one map would couple two independent hold policies.
  const staleSinceRef = useRef<Map<string, number>>(new Map());
  // Read once per mount (flag convention: reload to change), like every other engine flag.
  const coherenceHoldEnabledRef = useRef(getCoherenceHoldEnabled());
  /**
   * S4.5 + S4.6's single exclusive flag, resolved ONCE at mount. Re-reading it per frame would let the
   * renderer change policy mid-playback, which is a worse failure than either policy: the fallback
   * would appear and disappear between frames. A ref, not state — nothing re-renders on it.
   */
  const coherenceUnifiedRef = useRef(getCoherenceUnifiedEnabled());
  const rafRef = useRef<number>(0);
  const disposedRef = useRef(false);
  const contextLostRef = useRef(false);
  const [recoveryTick, setRecoveryTick] = useState(0);
  const sharedGradeRenderersRef = useRef<Map<string, { renderer: MediaWebGLRenderer; target: RenderTarget; pipelineKey: string; handle: ResourceHandle }>>(new Map());
  // Per-text/shape-layer color-grade renderers (Phase 4.1c). A graded overlay's UNGRADED raster stays
  // cached (transform/grade-independent — the 4.1b win); the grade is applied as a post-pass through the
  // SAME `MediaWebGLRenderer` the media path + export overlay-grade use, so the result becomes the scene
  // source. Lazily created per layer that actually has a non-identity pipeline; pruned when the layer
  // leaves the draw set so we don't leak WebGL contexts.
  const gradeRenderersRef = useRef<Map<string, { renderer: MediaWebGLRenderer; pipelineKey: string }>>(new Map());
  // Single-ctx preview (Phase 5): per-MEDIA-layer shared-context grade renderer + output RTT, keyed by the
  // RESOLVED source id (a blur clone aliases to its base → base graded once, clone samples the same target).
  // `lastKey` folds the layer's frame version + grade keys so an unchanged media frame skips the re-grade +
  // upload entirely (the static-photo win). Lives on the compositor's context; disposed on rebuild/unmount.
  const sharedMediaRenderersRef = useRef<
    Map<
      string,
      {
        renderer: MediaWebGLRenderer;
        target: RenderTarget;
        pipelineKey: string;
        lastKey: string;
        /**
         * Monotonic content version of the pixels in `target` (S6.2).
         *
         * Bumped exactly when the re-grade actually runs, i.e. when `lastKey` changes — that key
         * already folds frame version, pipeline, effects, amount, opacity, transition and the
         * proxy/full-res choice, so it is precisely "did the pixels change". A number rather than the
         * key itself because the identity travels through `dependencyVersions` as an opaque token and
         * a monotonic counter cannot collide across sources the way a shared key string could.
         */
        version: number;
        lastW: number;
        lastH: number;
        /** Which incarnation of this pool entry the scene draws reference (S5.2). */
        handle: ResourceHandle;
        /**
         * The media time the pixels currently in `target` represent (ADR-012 T5, slice S4.2).
         *
         * Stored on the ENTRY, not read per call, because the entry outlives the frame that filled it.
         * This target is handed back unchanged on the re-grade skip and on the two hold paths, and in
         * every one of those cases the honest answer to "when are these pixels from?" is the moment of
         * the last GRADE — not the moment being asked about. Recomputing it from the live snapshot
         * would make a held texture claim to be current, which is precisely the failure the barrier in
         * S4.4 exists to catch.
         */
        lastServedTime: number | null;
      }
    >
  >(new Map());
  /**
   * Per-comp upload targets for Flarex comp proxies (S5.4).
   *
   * The proxy is the ONLY path that hands a fresh per-frame object to `SceneLayerDraw.source`: it
   * publishes a new `VideoFrame` on every decode, and the compositor's `srcTextures` cache is keyed by
   * OBJECT IDENTITY. So each decoded frame minted a texture that nothing could ever hit again, and they
   * accumulated until a TTL swept them — O(frames) textures for a path that needs O(1). Uploading into
   * one target per comp puts the proxy on the same footing as every other source.
   */
  const proxyUploadsRef = useRef<
    Map<string, { renderer: MediaWebGLRenderer; target: RenderTarget; handle: ResourceHandle; lastVersion: number }>
  >(new Map());
  const kernelResourcesRef = useRef(getKernelResourcesEnabled());
  /** Wall clock of the last idle sweep, so the per-frame cost is one number comparison (risk R1). */
  const lastResourceSweepRef = useRef(0);
  const failedRef = useRef(false);
  // Bounded-recovery bookkeeping (see MAX_SCENE_REBUILDS above).
  const rebuildAttemptsRef = useRef(0);
  const goodFramesRef = useRef(0);
  const recoveryTimerRef = useRef<number | null>(null);
  const onFailureRef = useRef(onFailure);
  onFailureRef.current = onFailure;
  /**
   * RESOURCE MANAGER (ADR-012 3.12, slice S3.4) — who owns a pooled grade renderer.
   *
   * `sharedGradeRenderersRef` holds entries for three different owners: the live frame, the viewer
   * capture handle, and the node-thumbnail pool. Until now the owner was decided by **parsing a prefix
   * off the key** — `startsWith("capture:")` as a skip in the live prune, `startsWith("capture:") ||
   * startsWith("thumb:")` as a select in the capture release. Two predicates, independently maintained,
   * both re-deriving the same fact from a substring; a fourth owner or a typo in either one silently
   * double-disposes a live resource or leaks a scratch one. That is **I-8**.
   *
   * The prefix is still where the answer comes from — it is the caller's existing, correct convention —
   * but it is read **once, here, at registration**, and after that ownership is a field. That makes this
   * change byte-neutral by construction (the same keys land in the same sets) while removing the second
   * and third places that had to agree about it.
   */
  /**
 * The handle a pool entry holds for the instant between construction and registration.
 *
 * Fails CLOSED — an empty key resolves as `missing`, never as live — so if a draw ever did escape with
 * one, it would be counted and drawn empty rather than sampling a texture it has no claim to. A
 * placeholder that validated would be a hole in the check this slice exists to add.
 */
const PLACEHOLDER_HANDLE: ResourceHandle = { key: "", generation: -1 };


  const stopLoop = () => {
    if (!rafRef.current) return;
    cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
  };
  const disposeResources = () => {
    try {
      compositorRef.current?.dispose();
    } catch {
      /* ignore teardown after context loss */
    }
    compositorRef.current = null;
    try {
      matteCacheRef.current?.dispose();
    } catch {
      /* ignore */
    }
    matteCacheRef.current = null;
    for (const cache of nestMatteCachesRef.current.values()) {
      try {
        cache.dispose();
      } catch {
        /* ignore */
      }
    }
    nestMatteCachesRef.current.clear();
    // Flarex source-draw cache holds only plain JS templates (no GPU resources) — clear so a rebuild
    // starts cold rather than reusing draws keyed against a torn-down comp.
    flarexSourceDrawCacheRef.current.clear();
    // The scratch scope dies with the context too, not only with the capture handle (S2.3). A context
    // loss invalidates its GPU objects exactly as it does the live ones, and a scratch cache holding
    // handles into a dead context is the use-after-dispose S5.2 is meant to make unrepresentable —
    // until then, disposing it here is what keeps it from happening.
    disposeScratchScope();
    try {
      rasterizerRef.current?.dispose();
    } catch {
      /* ignore */
    }
    rasterizerRef.current = null;
    for (const { renderer } of gradeRenderersRef.current.values()) {
      try {
        renderer.dispose();
      } catch {
        /* ignore */
      }
    }
    gradeRenderersRef.current.clear();
    for (const { renderer, target } of sharedMediaRenderersRef.current.values()) {
      try {
        renderer.dispose();
      } catch {
        /* ignore */
      }
      try {
        target.dispose();
      } catch {
        /* ignore */
      }
    }
    for (const id of sharedMediaRenderersRef.current.keys()) forgetResource(defaultSession, mediaResourceKey(id));
    // S5.4 proxy upload targets. Same shape as the pools above: dispose the GL objects, then forget the
    // records — in that order, so a record never outlives the resource it describes.
    for (const [compId, entry] of proxyUploadsRef.current) {
      try {
        entry.renderer.dispose();
        entry.target.dispose();
      } catch {
        /* a dying GPU object must never throw out of teardown */
      }
      forgetResource(defaultSession, `flarex-proxy/${compId}`);
    }
    proxyUploadsRef.current.clear();
    sharedMediaRenderersRef.current.clear();
    for (const { renderer, target } of sharedGradeRenderersRef.current.values()) {
      try {
        renderer.dispose();
      } catch {
        /* ignore */
      }
      try {
        target.dispose();
      } catch {
        /* ignore */
      }
    }
    // Records go with the resources, in the same teardown. A registry that outlived a context loss would
    // hand the sweep ids into pools that no longer contain them — harmless today (the lookup misses) and
    // exactly the kind of drift that makes a ledger stop being evidence.
    for (const id of sharedGradeRenderersRef.current.keys()) forgetResource(defaultSession, gradeResourceKey(id));
    sharedGradeRenderersRef.current.clear();
  };
  const isContextLostError = (error: unknown) =>
    error instanceof Error &&
    (error.message === SCENE_COMPOSITOR_CONTEXT_LOST || error.message === MEDIA_RENDERER_CONTEXT_LOST || error.message === GL_CONTEXT_LOST);
  /**
   * A recoverable GPU context loss happened. Schedule a bounded rebuild of the compositor on a fresh context
   * (backoff) rather than degrading to the DOM path. Only once the retry budget is exhausted do we hand off to
   * DOM — once, quietly. Idempotent while a rebuild is already pending; logs once per loss, not per frame.
   */
  const scheduleSceneRecovery = () => {
    if (disposedRef.current || recoveryTimerRef.current != null) return;
    if (rebuildAttemptsRef.current >= MAX_SCENE_REBUILDS) {
      console.warn("ScenePreviewCanvas: GPU compositor context lost after retries; falling back to DOM path");
      onFailureRef.current?.();
      return;
    }
    const attempt = rebuildAttemptsRef.current;
    rebuildAttemptsRef.current = attempt + 1;
    goodFramesRef.current = 0;
    const delay = RECOVERY_BACKOFF_MS[Math.min(attempt, RECOVERY_BACKOFF_MS.length - 1)] ?? 600;
    console.warn(`ScenePreviewCanvas: GPU compositor context lost; controlled rebuild ${attempt + 1}/${MAX_SCENE_REBUILDS} in ${delay}ms`);
    recoveryTimerRef.current = window.setTimeout(() => {
      recoveryTimerRef.current = null;
      if (disposedRef.current) return;
      // Bumping recoveryTick re-runs the create effect (which clears failed/contextLost flags and rebuilds the
      // compositor on a fresh context) and the rAF-loop effect.
      setRecoveryTick((tick) => tick + 1);
    }, delay);
  };
  const fail = (where: string, error: unknown) => {
    if (failedRef.current) return;
    failedRef.current = true;
    stopLoop();
    disposeResources();
    if (isContextLostError(error)) {
      contextLostRef.current = true;
      // Recoverable — rebuild the exact GPU scene instead of latching to the DOM path.
      scheduleSceneRecovery();
      return;
    }
    console.error(`ScenePreviewCanvas: GPU compositor ${where} failed - falling back to DOM path`, error);
    onFailureRef.current?.();
  };
  // Keep the latest inputs in a ref so the rAF playback loop reads live values without re-subscribing.
  const inputsRef = useRef({ layers, width, height, backgroundColor, currentTime, isPlaying, renderScale, transitions, onFrameRendered, mediaSourceAlias, nestedGroups, flarexComps, flarexPreviewRoots, flarexVirtualLayers });
  inputsRef.current = { layers, width, height, backgroundColor, currentTime, isPlaying, renderScale, transitions, onFrameRendered, mediaSourceAlias, nestedGroups, flarexComps, flarexPreviewRoots, flarexVirtualLayers };
  // Event-driven redraw: composite while playing, or for a settle window after any input change /
  // async raster arrival. Idle (paused, settled) costs ~one cheap timestamp check per frame, not a
  // full recomposite — this is what keeps the timeline + viewer responsive in scene mode.
  const activeUntilRef = useRef(0);
  // ── FRAME COMPLETION (ADR-012 slice S2.2) ────────────────────────────────────────────────────────
  // Did the LAST composite settle (present with nothing outstanding), and has anything re-armed the
  // window since? Together they classify every settle-window composite — see `frame-completion.ts` for
  // why `load-bearing` is the count that decides whether the window can be retired.
  const prevSettledRef = useRef(false);
  const rearmedSinceSettledRef = useRef(true);
  const settledRef = useRef(false);
  // Read once per mount, like every other engine flag in this file.
  const frameCompletionEnabledRef = useRef(getFrameCompletionEnabled());

  /**
   * Upload each comp proxy frame into ITS OWN render target, once per decoded version (S5.4).
   *
   * The identity that matters here is the COMP, not the frame object. Keying the pool by comp id is the
   * whole fix: the same target is reused decode after decode, so texture count is bounded by the number
   * of proxied comps instead of by how long playback has been running.
   *
   * `lastVersion` is the skip: the publisher already bumps `sourceVersion` on every new frame, so an
   * unchanged version means the pixels on the target are still the right ones and the upload can be
   * skipped entirely — the same contract `srcTextures` used, now keyed by something stable.
   *
   * Returns a NEW record rather than mutating the ref: the ref belongs to the publishing hook, and
   * writing a converted source back into it would leave the publisher unable to tell its own frame from
   * ours (and would close over a target it does not own).
   */
  const uploadProxyFrames = (
    frames: Record<string, FlarexCompProxyFrame> | undefined
  ): Record<string, FlarexCompProxyFrame> | undefined => {
    if (!frames) return frames;
    const gl = compositorRef.current?.sharedGl;
    if (!gl) return frames;
    const out: Record<string, FlarexCompProxyFrame> = {};
    for (const [compId, frame] of Object.entries(frames)) {
      // Already a same-context texture (nothing to upload), or a version we cannot reason about.
      if (isSceneTextureSource(frame.source) || frame.sourceVersion === undefined) {
        out[compId] = frame;
        continue;
      }
      const w = Math.max(1, frame.sourceWidth);
      const h = Math.max(1, frame.sourceHeight);
      let entry = proxyUploadsRef.current.get(compId);
      if (!entry) {
        entry = {
          renderer: new MediaWebGLRenderer({ sharedGl: gl }, { label: `flarex-proxy:${compId}` }),
          target: new RenderTarget(gl, w, h),
          handle: PLACEHOLDER_HANDLE,
          lastVersion: Number.NaN,
        };
        entry.handle = registerResource(
          defaultSession,
          `flarex-proxy/${compId}`,
          { scope: "live", kind: "media-renderer", id: compId },
          performance.now()
        );
        proxyUploadsRef.current.set(compId, entry);
      } else {
        touchResource(defaultSession, `flarex-proxy/${compId}`, performance.now());
      }
      if (entry.lastVersion !== frame.sourceVersion) {
        entry.target.resize(w, h);
        entry.renderer.draw({
          source: frame.source as TexImageSource,
          sourceWidth: w,
          sourceHeight: h,
          matte: null,
          // null = passthrough. This pass exists to move pixels onto a stable target, not to grade:
          // the proxy is a pre-rendered frame of the comp and its look is already baked in.
          pipeline: null,
          amount: 1,
          opacity: 1,
          mediaEffects: null,
          target: entry.target,
        });
        entry.lastVersion = frame.sourceVersion;
      }
      const live = entry;
      out[compId] = {
        ...frame,
        source: sceneTexture(live.handle, () => live.target.tex, w, h),
      };
    }
    return out;
  };

  const requestDraw = () => {
    rearmedSinceSettledRef.current = true;
    activeUntilRef.current = (typeof performance !== "undefined" ? performance.now() : Date.now()) + SCENE_SETTLE_MS;
  };
  // Hand `requestDraw` to the caller (imperative, no re-render) so a media re-grade can re-arm a
  // recomposite — `requestDraw` only touches a ref, so assigning it every render is cheap and safe.
  if (redrawRef) redrawRef.current = requestDraw;
  // `flarexPreviewRoots` is here because after S1.2 it is the ONLY channel by which a view dot reaches
  // the compiler. Before, toggling a dot redrew incidentally — it bumped comp.version, which produced a
  // new graph and thus a new `layers` array identity. Relying on that is exactly the coupling the
  // kernel migration is unpicking, and an explicit dependency costs nothing: the memo behind it is
  // keyed on `graph.flarexComps`, so its identity is stable while the dots are.
  useEffect(requestDraw, [layers, width, height, backgroundColor, currentTime, isPlaying, renderScale, transitions, nestedGroups, flarexPreviewRoots]);

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      stopLoop();
      disposeResources();
      if (recoveryTimerRef.current != null) {
        window.clearTimeout(recoveryTimerRef.current);
        recoveryTimerRef.current = null;
      }
      if (redrawRef?.current === requestDraw) redrawRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Create / dispose the compositor with the canvas.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      failedRef.current = false;
      contextLostRef.current = false;
      // Stage 0 (plans/log-raw-source-color.md): the app owns the flag; `packages/shared` never reads
      // `window`, so precision is passed IN — the same shape as `regionPassModel`, which is what lets
      // the cloud renderer flip in lockstep instead of drifting from the preview.
      compositorRef.current = new SceneCompositor(canvas, width, height, {
        precision: getHdrPipelineEnabled() ? "rgba16f" : "rgba8",
      });
      matteCacheRef.current = new SceneMaskMatteCache(width, height);
      // A late async raster (text/font) re-arms the settle window so it lands on screen even when idle.
      rasterizerRef.current = new SceneTextRasterizer(requestDraw);
      // Repaint the current frame after a (re)build — including a recovery rebuild (recoveryTick), so a paused
      // preview immediately shows the restored GPU scene instead of a blank canvas until the next input change.
      requestDraw();
    } catch (error) {
      compositorRef.current = null;
      fail("init", error);
    }
    return () => {
      disposeResources();
    };
    // Re-create only when the comp dimensions change (the compositor sizes its FBOs to them).
  }, [width, height, recoveryTick]);

  // Shader pre-warm (P0 — first-frame-of-cut compile stall): compile every transition program the
  // composition uses during IDLE time, so entering a transition during playback never pays a
  // 10–50ms main-thread shader compile. Idempotent per program; re-runs after a context recovery.
  useEffect(() => {
    if (!prewarmTransitionIds?.length) return undefined;
    const idle =
      typeof requestIdleCallback === "function"
        ? requestIdleCallback
        : (cb: () => void) => window.setTimeout(cb, 200);
    const cancel =
      typeof cancelIdleCallback === "function" ? cancelIdleCallback : window.clearTimeout;
    const handle = idle(() => {
      const compositor = compositorRef.current;
      if (!compositor || contextLostRef.current) return;
      const defs = prewarmTransitionIds
        .map((id) => getTransition(id))
        .filter((def): def is NonNullable<typeof def> => def != null);
      compositor.prewarmTransitions(defs);
    });
    return () => cancel(handle as never);
  }, [prewarmTransitionIds, recoveryTick]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const handleLost = (event: Event) => {
      event.preventDefault();
      if (contextLostRef.current) return;
      contextLostRef.current = true;
      failedRef.current = true;
      stopLoop();
      disposeResources();
      // Rebuild the GPU compositor (bounded) instead of a permanent DOM fallback — keeps the exact scene.
      scheduleSceneRecovery();
    };
    const handleRestored = () => {
      if (disposedRef.current) return;
      // The browser restored the context on its own — a clean recovery, so give it a fresh retry budget.
      rebuildAttemptsRef.current = 0;
      goodFramesRef.current = 0;
      contextLostRef.current = false;
      failedRef.current = false;
      setRecoveryTick((tick) => tick + 1);
      requestDraw();
    };
    canvas.addEventListener("webglcontextlost", handleLost);
    canvas.addEventListener("webglcontextrestored", handleRestored);
    return () => {
      canvas.removeEventListener("webglcontextlost", handleLost);
      canvas.removeEventListener("webglcontextrestored", handleRestored);
    };
    // recoveryTick: the canvas element is keyed on it (remounted per rebuild), so the listeners
    // must re-attach to the NEW element — with [] they'd keep watching the discarded one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recoveryTick]);

  // Text/shape overlay grade through a pooled shared-context MediaWebGLRenderer. `keyPrefix` isolates the
  // viewer-capture path's pool entries ("capture:") from the live frame's — the two grade the same layer at
  // DIFFERENT times, and sharing one entry would rebake the LUT on every alternation.
  const makeGradeOverlayRef = useRef((compositor: SceneCompositor, keyPrefix: string) => {
    return (layerId: string, srcCanvas: HTMLCanvasElement | OffscreenCanvas, pipeline: ColorPipeline): SceneTextureSource | null => {
      if (compositor.isContextLost()) throw new Error(SCENE_COMPOSITOR_CONTEXT_LOST);
      const gl = compositor.sharedGl;
      const targetW = Math.max(1, srcCanvas.width);
      const targetH = Math.max(1, srcCanvas.height);
      const key = `${keyPrefix}${layerId}`;
      let entry = sharedGradeRenderersRef.current.get(key);
      if (!entry) {
        entry = {
          renderer: new MediaWebGLRenderer({ sharedGl: gl }),
          target: new RenderTarget(gl, targetW, targetH),
          pipelineKey: "",
          // Overwritten on the next line by the register call, which is the only thing that can mint a
          // real one. Never observable: the entry is not reachable by a draw until this function returns.
          handle: PLACEHOLDER_HANDLE,
        };
        sharedGradeRenderersRef.current.set(key, entry);
        // The handle is taken from the SAME call that created the entry, so it names this incarnation
        // and no other (S5.2). Storing it on the entry is what keeps that true: re-deriving it later
        // would read whatever the key means then, which is precisely the confusion generations exist
        // to remove.
        entry.handle = registerResource(
          defaultSession,
          gradeResourceKey(key),
          { scope: gradeScopeOf(key), kind: "grade-renderer", id: key },
          performance.now()
        );
      } else {
        // Touched on ACCESS, not on a successful draw: an entry reached and then short-circuited (an
        // unchanged pipeline, a cached target) is still in use, and ageing it out from under a live
        // consumer is the one way a wall-clock sweep could do harm.
        touchResource(defaultSession, gradeResourceKey(key), performance.now());
      }
      const gradeHandle = entry.handle;
      entry.target.resize(targetW, targetH);
      const pipelineKey = colorPipelineCacheKey(pipeline);
      if (entry.pipelineKey !== pipelineKey) {
        entry.renderer.setPipeline(pipeline);
        entry.pipelineKey = pipelineKey;
      }
      entry.renderer.draw({
        source: srcCanvas,
        sourceWidth: targetW,
        sourceHeight: targetH,
        matte: null,
        pipeline,
        amount: 1,
        opacity: 1,
        mediaEffects: null,
        target: entry.target,
      });
      return sceneTexture(gradeHandle, () => entry.target.tex, targetW, targetH);
    };
  });

  /**
   * The media resolver the LAST composited frame used, republished here each frame so the capture
   * handle can reuse it (Flarex node thumbnails). It is the same function either path builds below —
   * `getMediaGradedSource` (graded-canvas lookup) or `getMediaSingleCtx` (in-context grade) — and both
   * are safe to call again while idle: the canvas lookup is pure, and the single-ctx grade short-circuits
   * on an unchanged `frameVersion`, so a thumbnail pass re-uses the textures already on the GPU instead
   * of decoding or grading anything of its own. Null until the first frame composites.
   */
  const liveMediaGradedRef = useRef<((id: string) => HTMLCanvasElement | SceneTextureSource | null) | null>(null);

  // The latest draw closure, kept in a ref so the persistent rAF loop always runs current logic
  // without re-subscribing. Reads live values from `inputsRef` / `gradedRef` (both stable refs).
  const drawRef = useRef<() => void>(() => {});
  // Outcome of the frame currently being built (S2.1) — set at each exit point below, read by the
  // `finally` in `drawRef.current`. A ref rather than a return value because the exit points are
  // spread across early returns that cannot all be funnelled through one.
  const outcomeRef = useRef<FrameOutcome>("abandoned");
  const drawFrameImpl = () => {
    const drawStart = performance.now();
    const compositor = compositorRef.current;
    if (!compositor || compositor.isContextLost() || failedRef.current || contextLostRef.current || disposedRef.current) return;
    const { layers: ls, width: w, height: h, backgroundColor: bg, currentTime: t, isPlaying: playing, renderScale: rScale, transitions: tPairs, onFrameRendered: frameRendered, mediaSourceAlias: alias, nestedGroups: nestGroups, flarexComps: fxComps, flarexPreviewRoots: fxRoots, flarexVirtualLayers: fxVirtual } = inputsRef.current;
    // Logical comp (w/h) drives text layout + the matte; the GPU BACKING renders at comp*renderScale.
    // Element-box half-extents (logical comp px) scale with it; media/mask are scale-invariant/normalized.
    const renderW = Math.max(1, Math.round(w * rScale));
    const renderH = Math.max(1, Math.round(h * rScale));
    const isLiveMediaCanvas = (canvas: HTMLCanvasElement | null | undefined): canvas is HTMLCanvasElement => {
      if (!canvas) return false;
      const producer = getTexImageSourceProducerInfo(canvas);
      return !producer || (!producer.disposed && !producer.contextLost);
    };
    const getMediaGradedSource = (id: string): HTMLCanvasElement | null => {
      let resolvedId = id;
      // Cycle-guard Set only when an alias chain actually starts here — the common no-alias
      // case allocated a Set per media layer per frame for a walk that was a no-op.
      if (alias?.has(resolvedId)) {
        const seen = new Set<string>();
        while (alias.has(resolvedId) && !seen.has(resolvedId)) {
          seen.add(resolvedId);
          resolvedId = alias.get(resolvedId)!;
        }
      }
      const explicit = gradedRef.current[resolvedId];
      if (isLiveMediaCanvas(explicit)) return explicit;

      // User-duplicated region/media layers can carry `_copy_...` ids without an explicit render-effect alias.
      // Prefer the nearest live base canvas over a stale duplicate canvas.
      let copyIdx = id.lastIndexOf("_copy_");
      while (copyIdx > 0) {
        const baseId = id.slice(0, copyIdx);
        const base = gradedRef.current[baseId];
        if (isLiveMediaCanvas(base)) return base;
        copyIdx = baseId.lastIndexOf("_copy_");
      }
      const own = gradedRef.current[id];
      return isLiveMediaCanvas(own) ? own : null;
    };

    // ── SINGLE-CTX PREVIEW (Phase 5): grade the media layer's RAW frame in-context ──────────────────
    // The layer publishes a frame-source descriptor (element / WC VideoFrame / settle / still) instead of
    // grading into a canvas. We upload it ONCE and grade through a shared-context MediaWebGLRenderer +
    // RenderTarget on THIS compositor's WebGL2 context, returning the RTT as a SceneTextureSource the
    // compositor samples directly (no cross-context upload) — the proven single-context export path.
    const liveMediaSourceIds = new Set<string>();
    // TEMPORAL COHERENCE: ids whose held texture is for a DIFFERENT time than the frame being built.
    // Collected here rather than through `buildSceneDraws`'s `onLayerNotReady` on purpose — that hook is
    // documented as "purely an observability out-channel, it never changes what buildSceneDraws returns",
    // and export/worker must stay byte-identical. Only the single-ctx path reports staleness (the legacy
    // per-clip-GL path has no snapshot to ask); that path has been the default since 2026-07-07.
    const staleIds: string[] = [];
    const staleBySource: Record<string, number> = {};
    // EVERY media source's staleness, coherent ones included — the trace needs the rows that read
    // clean, because "showed the wrong picture while reporting coherent" is a different bug from
    // "showed the wrong picture while reporting stale", and only this can tell them apart.
    const allStaleness: Record<string, number | null> = {};
    // READ-AHEAD PROBE (S0, plans/preview-readahead-ring.md). Collected in the SAME walk as staleness
    // because both are per-source facts about this one present, and a second walk could not see the
    // same instant. Inert unless `?previewRing=probe` — the array simply stays empty.
    const readaheadProbeOn = isReadaheadProbeEnabled();
    const readaheadSamples: ReadaheadSample[] = [];
    let maxStalenessSeconds = 0;
    // WHICH source was worst, and what moment it was actually showing. Captured because the staleness
    // NUMBER alone cannot distinguish the two things that produce a large one, and they need opposite
    // fixes: a backward seek leaves a source transiently far ahead of the request (served >> requested,
    // decays as it catches up), while a source whose material has ENDED sits pinned at its last frame
    // while the playhead walks away from it (served constant, staleness growing linearly with
    // targetTime — and if that is what is happening, it is a measurement artifact, not lag, because the
    // last frame IS the right answer past the end).
    let worstStaleId = "";
    let worstStaleServed: number | null = null;
    let worstStaleMediaEnd: number | null = null;
    // ATOMIC FULL-RES SWAP: tallies for this composite. The DECISION for this composite was made from
    // the previous one (`fullResCommittedRef`, resolved after the draw below) — deliberately, because
    // `gradeMediaInContext` is invoked lazily by `buildSceneDraws` as it walks the layers, so there is
    // no point before the draw at which every participant has been seen. Deciding one frame late costs
    // a single extra composite and keeps the swap atomic; deciding mid-walk could not be atomic at all.
    let fullResPendingCount = 0;
    let fullResReadyCount = 0;
    const useFullRes = fullResCommittedRef.current;
    const gradeMediaInContext = (resolvedId: string, source: ScenePreviewMediaSource): SceneTextureSource | null => {
      const snap = source.snapshot();
      // Media-supply probe: record this source's frame-delivery state (advancing vs held/stalled) BEFORE
      // the re-grade skip, so a frozen decoder is named per source. Inert unless ?flarexProfile=1.
      frameProfiler.noteMediaSource(resolvedId, snap.frameVersion, !!snap.frame && snap.frame.width > 0 && snap.frame.height > 0);
      // Is this source showing the frame this composite is FOR? Null staleness = time-invariant or
      // unknowable → coherent by definition. The texture returned below is unchanged either way; this
      // only tells the present gate whether the frame it is about to assemble is a real one.
      // A video still waiting on its decode counts as stale: it is definitely not showing the
      // requested moment, and the held-texture path below would otherwise let it present the previous
      // playhead's picture without either gate noticing. See `awaitingFrame` in scene-media-source.
      const awaiting = snap.awaitingFrame;
      // SOURCE MAP (2026-07-28): node id → asset name + decode path + live supply state. The one
      // lookup that answers "the profiler says node X stalled — what IS X, and which decoder is it
      // on?", which previously required joining two globals keyed on different identities plus a
      // node id the graph UI does not display.
      if (typeof window !== "undefined") {
        const w = window as { __rfSourceMap?: Record<string, unknown> };
        (w.__rfSourceMap ??= {})[resolvedId] = {
          asset: snap.sourceLabel ?? "-",
          decode: snap.decodeMode ?? "-",
          // 0 = this source owns its decoder outright. Two rows on one asset both reading 0 is the
          // duplicate-decode signature; `1` on both means they share one session.
          shared: snap.decodeSharedWith,
          state: snap.awaitingFrame ? "AWAITING" : isStale(snap.stalenessSeconds) ? "stale" : "ok",
          staleMs: snap.stalenessSeconds == null ? null : Math.round(snap.stalenessSeconds * 1000),
          // The clamp's input. `null` beside a large `staleMs` means the clamp never ran and the
          // reading is an artifact of a playhead past the material, not lag anyone can fix.
          mediaEnd: snap.mediaEndSeconds,
          served: snap.servedSourceTime,
          // WHY it is awaiting, and what the backing element was doing at that instant. `state`
          // says a source has no frame; these say whose fault that is — see `awaitReason` and
          // `elementTime` on ScenePreviewMediaSnapshot.
          why: snap.awaitReason,
          elTime: snap.elementTime,
          elReady: snap.elementReadyState,
          elPaused: snap.elementPaused,
          elNetwork: snap.elementNetworkState,
          wcProvider: snap.hasWcProvider,
          wcBusy: snap.wcBusy,
        };
      }
      allStaleness[resolvedId] = awaiting ? Number.POSITIVE_INFINITY : snap.stalenessSeconds;
      if (readaheadProbeOn) {
        readaheadSamples.push({
          id: resolvedId,
          frameVersion: snap.frameVersion,
          stalenessSeconds: snap.stalenessSeconds,
          awaiting,
          decodeMode: snap.decodeMode,
          label: snap.sourceLabel,
          nominalFps: snap.nominalFps,
          servedSourceTime: snap.servedSourceTime,
        });
      }
      if (awaiting || isStale(snap.stalenessSeconds)) {
        staleIds.push(resolvedId);
        // `awaiting` has no measurable distance — there is no served time to compare — so it must not
        // enter the staleness statistics, which are a Track B latency instrument. It gates, it does
        // not measure.
        if (!awaiting) {
          staleBySource[resolvedId] = snap.stalenessSeconds!;
          if (snap.stalenessSeconds! > maxStalenessSeconds) {
            maxStalenessSeconds = snap.stalenessSeconds!;
            worstStaleId = resolvedId;
            worstStaleServed = snap.servedSourceTime;
            worstStaleMediaEnd = snap.mediaEndSeconds;
          }
        }
      }
      // ATOMIC FULL-RES SWAP: tally this participant, then use its upgrade only if the viewer has
      // already committed. `frame` stays the fallback whenever no upgrade exists, so a source that
      // never produces one is unaffected.
      if (snap.fullResPending) fullResPendingCount += 1;
      if (snap.fullResFrame) fullResReadyCount += 1;
      const chosenFrame = useFullRes && snap.fullResFrame ? snap.fullResFrame : snap.frame;
      let entry = sharedMediaRenderersRef.current.get(resolvedId);
      // BEFORE the source-less branch below, deliberately. That branch returns the entry's last graded
      // texture — it is the entry's most important use, not an absence of one — and a transiently
      // source-less layer (element mid-seek, decode in flight) can hold there for a long time. Touching
      // only on a successful grade would let the idle sweep dispose the very target being shown.
      if (entry) touchResource(defaultSession, mediaResourceKey(resolvedId), performance.now());
      if (!chosenFrame || chosenFrame.width <= 0 || chosenFrame.height <= 0) {
        // Transiently source-less: an element mid-seek drops readyState<2 for a few frames, a WC decode
        // is still in flight, a still is decoding. HOLD the last graded frame — the own-canvas path did
        // this implicitly (the graded canvas kept its last pixels through a seek); returning null here
        // dropped the layer from the draw list for a composite → a black flicker on every ruler click
        // (2026-07-07 soak report: 11 flickers / 19s of scrubbing).
        if (entry && entry.lastW > 0) {
          recordSingleCtx("skips");
          // Held pixels carry the time they were graded at, NOT the time being requested. This is the
          // hold the 2026-07-07 anti-flicker fix introduced, and the reason a source that decoded once
          // could read as "ready" forever no matter how stale — the texture had no way to say when it
          // was from. Now it does.
          return sceneTexture(entry.handle, () => entry!.target.tex, entry.lastW, entry.lastH, { ...servedTimeOf(entry.lastServedTime), version: entry.version });
        }
        return null; // never had a frame — same as the old "no canvas yet" (poster covers it)
      }
      const gl = compositor.sharedGl;
      if (!entry) {
        entry = { renderer: new MediaWebGLRenderer({ sharedGl: gl }), target: new RenderTarget(gl, 1, 1), pipelineKey: "", lastKey: "", lastW: 0, lastH: 0, lastServedTime: null, handle: PLACEHOLDER_HANDLE, version: 0 };
        sharedMediaRenderersRef.current.set(resolvedId, entry);
        // Always `live`: this pool is only ever built from the live frame's media set. The capture path
        // reuses the graded textures the live frame already produced rather than making its own, which
        // is why `renderIsolated` can be synchronous at all.
        entry.handle = registerResource(
          defaultSession,
          mediaResourceKey(resolvedId),
          { scope: "live", kind: "media-renderer", id: resolvedId },
          performance.now()
        );
      }
      const w0 = chosenFrame.width;
      const h0 = chosenFrame.height;
      // Re-grade skip: unchanged frame version + grade keys → reuse the cached target (no upload/grade).
      // A matte is a live <video> whose pixels change with no versioned signal → never skip when present.
      //
      // `fr` is load-bearing: the proxy and full-res frames can share a `frameVersion` (the swap is the
      // COMPOSITOR's decision, not a new publish by the producer), so without it the skip would serve
      // the cached proxy-graded texture forever and the upgrade would never appear on screen.
      const key = `${snap.frameVersion}|${snap.pipelineKey}|${snap.mediaEffectsKey}|${snap.amount}|${snap.bakedOpacity}|${snap.transitionKey}|fr${chosenFrame === snap.fullResFrame ? 1 : 0}`;
      if (!snap.matte && entry.lastKey === key && entry.target.width === w0 && entry.target.height === h0) {
        recordSingleCtx("skips");
        // Re-grade skip: same frame version, same grade — so the same pixels, and therefore the same
        // served time. Reading it from the entry rather than the snapshot keeps the skip honest even if
        // the producer's own reading has since moved.
        return sceneTexture(entry.handle, () => entry!.target.tex, w0, h0, { ...servedTimeOf(entry.lastServedTime), version: entry.version });
      }
      if (entry.pipelineKey !== snap.pipelineKey) {
        entry.renderer.setPipeline(snap.pipeline);
        entry.pipelineKey = snap.pipelineKey;
      }
      // HOT SPOT (2026-07-28): this upload+grade is where a `texImage2D` of a live 1080p video frame
      // can block on a GPU sync — and until now it was NOT instrumented. The three existing
      // `markHotSpot` probes (`webgl-draw`, `webgl-renderer-init`, `lut-bake`) all sit in
      // `WebglMediaLayer`'s own-context path, AFTER its `if (singleCtx) return`, so none has fired
      // since single-context preview became the default (2026-07-07). `__rfHotSpots` read as
      // "undefined" — absence of an instrument, not absence of stalls.
      const gradeStart = performance.now();
      entry.renderer.draw({
        source: chosenFrame.source,
        sourceWidth: w0,
        sourceHeight: h0,
        matte: snap.matte?.source ?? null,
        matteInvert: snap.matte?.invert ?? false,
        matteOpacity: snap.matte?.opacity ?? 1,
        pipeline: snap.pipeline,
        amount: snap.amount,
        opacity: snap.bakedOpacity,
        mediaEffects: snap.mediaEffects,
        transition: snap.transition,
        target: entry.target,
      });
      markHotSpot("scene-media-grade", gradeStart, `${resolvedId} ${w0}x${h0}`);
      // The re-grade ran, so these are new pixels: bump BEFORE publishing so the version describes
      // what the target now holds. A matte forces the key empty (re-grade every frame) and the version
      // moves with it, which is correct — a live matte genuinely changes the output each frame.
      entry.version += 1;
      entry.lastKey = snap.matte ? "" : key; // matte present → force a re-grade next frame
      entry.lastW = w0;
      entry.lastH = h0;
      // A real grade just happened, so THESE pixels are the frame the producer reports. The only place
      // the entry's served time is written — every other path reads it back.
      entry.lastServedTime = snap.servedSourceTime;
      recordSingleCtx("grades");
      return sceneTexture(entry.handle, () => entry!.target.tex, w0, h0, { ...servedTimeOf(snap.servedSourceTime), version: entry.version });
    };
    const getMediaSingleCtx = (id: string): SceneTextureSource | null => {
      const sources = mediaSourcesRef?.current;
      if (!sources) return null;
      let resolvedId = id;
      if (alias?.has(resolvedId)) {
        const seen = new Set<string>();
        while (alias.has(resolvedId) && !seen.has(resolvedId)) {
          seen.add(resolvedId);
          resolvedId = alias.get(resolvedId)!;
        }
      }
      let src = sources[resolvedId];
      if (!src) {
        // `_copy_` duplicates without an explicit alias (mirrors the own-canvas fallback).
        let copyIdx = id.lastIndexOf("_copy_");
        while (!src && copyIdx > 0) {
          const baseId = id.slice(0, copyIdx);
          src = sources[baseId] ?? undefined;
          if (src) resolvedId = baseId;
          copyIdx = baseId.lastIndexOf("_copy_");
        }
      }
      if (!src) {
        src = sources[id] ?? undefined;
        if (src) resolvedId = id;
      }
      if (!src) {
        // Descriptor briefly missing — the proxy-arrival REMOUNT unregisters the old layer's source
        // before the new mount registers ITS descriptor (and the new element then needs a moment to
        // decode). Serve the last-graded texture through the gap instead of dropping the layer: the
        // dispose-on-unconsumed prune below otherwise destroyed the held frame on the FIRST gap
        // composite, leaving the follow-up composites nothing to hold (play-start black-flicker
        // lineage, tracker playback-preview v22).
        const held = sharedMediaRenderersRef.current.get(resolvedId);
        if (held && held.lastW > 0) {
          liveMediaSourceIds.add(resolvedId);
          recordSingleCtx("skips");
          // Descriptor-gap hold: the producer is gone entirely, so nothing can report a CURRENT time —
          // the pixels are the last grade's and say so. Of the four hold paths this is the one most
          // likely to persist, because a remount plus a decode is not a sub-frame event.
          return sceneTexture(held.handle, () => held.target.tex, held.lastW, held.lastH, { ...servedTimeOf(held.lastServedTime), version: held.version });
        }
        return null;
      }
      // Present (descriptor registered) → keep its renderer alive even if this frame's source isn't ready
      // yet, so a brief frame gap doesn't dispose+recreate the shared renderer/target.
      liveMediaSourceIds.add(resolvedId);
      return gradeMediaInContext(resolvedId, src);
    };

    const liveMediaGraded = singleCtxMedia ? getMediaSingleCtx : getMediaGradedSource;
    // Republish for the capture handle (node thumbnails) — see `liveMediaGradedRef`.
    liveMediaGradedRef.current = liveMediaGraded;

    const gradeOverlay = makeGradeOverlayRef.current(compositor, "");
    // The draw-list build is shared with the local export (`SceneFrameCompositor`) — see build-scene-draws.
    // The only editor-specific input is the media graded canvas, read here from the hidden WebglMediaLayers.
    let draws: SceneFrameSpec["layers"];
    const notReadyIds: string[] = [];
    // Timed separately from `scene-draw-total` because BOTH hold paths return before that probe: a
    // withheld frame still pays for its build (Flarex compile + rasterizer + source-draw resolve), and
    // a withheld frame is precisely when the stalls under investigation occur.
    const buildStart = performance.now();
    /**
     * INCREMENTAL EVALUATION (S6.4/S6.5/S6.6) — declare the graph and open the two channels.
     *
     * The media epoch is the sum of the pool's content versions: each entry bumps exactly when its
     * re-grade actually runs, so a change here means some decoded picture is new. That is the one axis
     * with no representation in the graph at all — nothing about a comp changes when a frame decodes —
     * and it is summed rather than compared per entry because ANY new picture invalidates every MediaIn
     * conservatively, which is the starting position the completion plan asks for.
     */
    let mediaEpoch = 0;
    for (const entry of sharedMediaRenderersRef.current.values()) mediaEpoch += entry.version;
    const incremental = beginIncrementalFrame({
      comps: fxComps,
      renderScale: rScale,
      width: w,
      height: h,
      frameTimeSeconds: t,
      mediaEpoch,
      frameId: activeFrame()?.id ?? 0,
      nowMs: performance.now(),
    });
    try {
      // Profiler times the whole draw-list build (includes the Flarex evaluator + content hashing).
      draws = frameProfiler.measure("evaluator.build", () => buildSceneDraws({
      layers: ls,
      width: w,
      height: h,
      currentTime: t,
      renderScale: rScale,
      transitions: tPairs,
      rasterizer: rasterizerRef.current,
      matteCache: matteCacheRef.current,
      gradeRenderers: gradeRenderersRef.current,
      // Single-ctx: grade the layer's raw frame in-context (SceneTextureSource); otherwise read its graded
      // canvas. A region-blur clone aliases to its base in BOTH paths (no own decoder/context) — see mediaSourceAlias.
        getMediaGraded: liveMediaGraded,
      gradeOverlay,
      createCanvas: () => document.createElement("canvas"),
      regionPassModel: getRegionPassesEnabled(),
      nestedGroups: nestGroups,
      nestMatteCaches: nestMatteCachesRef.current,
      flarexComps: fxComps,
      flarexPreviewRoots: fxRoots,
      flarexVirtualLayers: fxVirtual,
      // S4.5 — the HOST decides the substitution policy and the compiler is told (I-15: the lowering
      // layer owns no policy). Read from a ref so the live path never re-resolves a flag per frame.
      allowHostSubstitution: !coherenceUnifiedRef.current,
      // Comp proxies (plans/flarex-comp-proxy.md, S2) — read LIVE off the ref at draw time, exactly like
      // `gradedRef`: the frame for each proxied comp is refreshed asynchronously by its decoder, and a
      // prop snapshot would draw the previous one. Undefined/empty ⇒ every comp lowers live as before.
      flarexCompProxies: uploadProxyFrames(flarexCompProxiesRef?.current),
      flarexSourceDrawCache: flarexSourceDrawCacheRef.current,
      onLayerNotReady: (id) => notReadyIds.push(id),
      // Flarex lowering degradations → the kernel diagnostics sink (ADR-012 slice S0.2). Purely an
      // out-channel, exactly like `onLayerNotReady` above it: this cannot change what buildSceneDraws
      // returns, and the pixel gate asserts it (all 17 Flarex fixtures at 0.000% with it attached).
      //
      // This is the call site that makes the numbers REAL. The headless harness proves the channel is
      // correct; only the live viewer can answer how often a node actually shows another shot's pixels,
      // on which nodes, in which projects — the measurement ADR-012 §0.3 / I-27 needs before slice S4.5
      // deletes the host-clip fallback. Read it from the console as `__rfFlarexDegradation`.
      onFlarexDegrade: recordFlarexDegradation,
      // S6.4/S6.6 — absent unless the flag is on, so the default path is byte-identical.
      flarexOnEvaluated: incremental?.onEvaluated,
      flarexReuseValue: incremental?.reuseValue,
      }));
    } catch (error) {
      // A build that threw did not do the work the dirty marks describe, so the dirt must survive.
      abortIncrementalFrame();
      fail("build draw list", error);
      return;
    }
    markHotSpot("scene-draw-build", buildStart, `layers=${ls.length}`);

    // R1 fix: mirror the worker's delayRender gate — while PLAYING, a stacked layer whose source hasn't
    // landed yet must not composite a hole that lets the layer(s) below show through for a frame. Hold the
    // previous canvas contents (skip presenting) until every active layer is ready, with an escape hatch so
    // a permanently-broken source (renamed/missing asset) doesn't freeze the preview forever. Paused seeks
    // are exempt — holding there made scrubbing feel laggy without the flash actually occurring at rest.
    const blockedSince = notReadySinceRef.current;
    const now = performance.now();
    advanceBlockingClock(blockedSince, notReadyIds, now);
    // ── ATOMIC FULL-RES SWAP: resolve the rendezvous now that every participant has been seen ──────
    //
    // The invariant: a paused viewer sharpens ALL of its sources in one composite, or none of them.
    // Commit when nobody is still waiting for an upgrade and at least one exists; withdraw the moment
    // anyone goes pending again (transport moved → every settle frame was just invalidated).
    //
    // ESCAPE HATCH, same doctrine as every other hold here: a source whose original never seeks —
    // wedged element, sparse-GOP 4K, renamed asset — must not keep the whole viewer soft forever.
    // Past the budget we commit with whatever is ready and degrade to the old per-source behaviour.
    {
      const wasCommitted = fullResCommittedRef.current;
      const decision = decideFullResRendezvous({
        pendingCount: fullResPendingCount,
        readyCount: fullResReadyCount,
        pendingSinceMs: fullResPendingSinceRef.current,
        nowMs: now,
      });
      fullResPendingSinceRef.current = decision.pendingSinceMs;
      if (decision.commit !== wasCommitted) {
        fullResCommittedRef.current = decision.commit;
        // The decision is made AFTER this composite was assembled, so it applies to the next one.
        // Without this the swap would wait for an unrelated redraw and could sit soft indefinitely
        // while paused (there is no rAF pump when the transport is parked).
        requestDraw();
        if (decision.commit) recordSingleCtx(decision.viaHatch ? "fullResHatch" : "fullResSwaps");
      }
    }
    // Per-source staleness clock (temporal coherence). A source that converges drops out of `staleIds`
    // and its clock is cleared, so a later stall gets a fresh budget rather than inheriting an old one.
    const staleSince = staleSinceRef.current;
    advanceBlockingClock(staleSince, staleIds, now);
    // v21 (play-start black-flicker lineage): at the play flip a composite can run BEFORE the
    // playing flag propagates, exactly while the media element re-primes (settle/WC → element
    // handoff) with nothing held yet — and when this hold was playing-gated, that composite
    // PRESENTED the hole: a 1–2 frame black flicker at play start.
    // Media layers therefore hold the previous present even while paused; text/shape keep the
    // paused exemption (the R1 scrub-lag rationale — a pending text raster mid-typing must not
    // freeze the whole viewer). Media not-ready while paused is only ever the first-frame or
    // source-handoff case, where holding the last picture is exactly right.
    const isMediaLayerId = (id: string): boolean => {
      const layer = ls.find((item) => item.id === id);
      return layer != null && (layer.type === "video" || layer.type === "image");
    };
    // Record BEFORE the hold decision, so a withheld composite still counts as demand: playback asked
    // for this moment whether or not the viewer got to show it, and a ring would have been read here
    // either way. Counting only presented composites would flatter the demand figure exactly on the
    // frames where the sources were struggling.
    if (readaheadProbeOn) noteReadaheadComposite(readaheadSamples, now, t);

    /**
     * IDLE SWEEP (ADR-012 I-33, slice S3.4) — reclamation that does not depend on a frame presenting.
     *
     * Placed HERE, above every hold gate, because that is the whole point. The set-difference prune far
     * below sits after the coherence-hold `return`, so a held frame reclaims nothing — and a held frame
     * is precisely when memory pressure is building. That is the amplifier both runtime audits named:
     * slow sources → held frames → no reclamation → VRAM climbs → context eviction → every cache
     * destroyed → slow sources. The recovery mechanism feeds the failure.
     *
     * **This sweep can run here and that prune cannot**, and the difference is not a preference. The
     * prune subtracts against `liveMediaSourceIds`, which is populated by the grade pass a hold skips —
     * running it early would compute the difference against an empty set and dispose the held frame's
     * own renderers (the file already carries a comment about that landmine). A wall-clock sweep has no
     * such dependency: an entry touched this frame has age zero, so it is safe on any frame in any
     * outcome, by construction.
     *
     * In a healthy session this reclaims NOTHING — the fast path already disposed everything it would
     * have caught. It bites only in the failure, which is exactly where the old reclamation went quiet.
     * Rate-limited to once per TTL so the per-frame cost is one number comparison (risk R1).
     */
    lastResourceSweepRef.current = sweepIdleSceneResources({
      enabled: kernelResourcesRef.current,
      compositor,
      nowMs: now,
      lastSweepMs: lastResourceSweepRef.current,
      gradePool: sharedGradeRenderersRef.current,
      mediaPool: sharedMediaRenderersRef.current,
    });

    // TEMPORAL COHERENCE (2026-07-28): at a FIXED playhead every media source must represent the same
    // requested time or the frame is not presented — see `playback/temporal-coherence.ts`. The episode
    // clock is `coherenceHoldStartRef`, read here and advanced by `noteCoherence` below, so the gate
    // and the probe agree on what one hold episode is by construction.
    const readiness = decideSceneReadiness({
      playing,
      notReadyIds,
      isMediaLayerId,
      blockedSince,
      staleIds,
      staleSince,
      allStaleness,
      holdStartedMs: coherenceHoldStartRef.current,
      nowMs: now,
      targetTimeSeconds: t,
      coherenceUnified: coherenceUnifiedRef.current,
      coherenceHoldEnabled: coherenceHoldEnabledRef.current,
    });
    if (readiness.hold) {
      noteCoherence(
        coherenceHoldStartRef,
        t,
        staleIds,
        maxStalenessSeconds,
        true,
        staleBySource,
        allStaleness,
        readiness.reason
      );
      // Presented-frame ledger (ADR-012 slice S0.3). A withheld composite is recorded too: the hold
      // RATE is half the picture, because a barrier that reaches coherence by never presenting has not
      // solved anything. Same classification the gate above just made, so the two cannot disagree.
      noteHeld(readiness.reason === "coherence" ? "coherence" : "not-ready", {
        targetTime: t,
        participants: liveMediaSourceIds.size,
        staleIds,
        notReadyIds,
        maxStalenessSeconds,
        worstSourceId: worstStaleId,
        worstSourceServedTime: worstStaleServed,
        worstSourceMediaEnd: worstStaleMediaEnd,
        playing,
      });
      // Keep the settle window open for the duration of a COHERENCE hold. Paused there is no rAF
      // pump, so the loop only composites while `activeUntilRef` is in the future — and re-arming is
      // normally the arriving frame's job (`onFrame` → `requestDraw`). A source that stops delivering
      // mid-hold (bailed to <video>, wedged decoder) would therefore let the window lapse with the
      // frame still withheld, and STALE_HOLD_MAX_MS could never fire because no composite would run
      // to evaluate it — a stall on the previous picture instead of a bounded degrade.
      //
      // Not busy work: each composite during a hold IS the convergence re-check (it re-reads every
      // source's snapshot), and it is bounded by STALE_HOLD_MAX_MS, after which we present regardless.
      if (!playing && staleIds.length > 0) requestDraw();
      outcomeRef.current = "held";
      // A HELD frame never reached the screen, so the nodes it dirtied still need evaluating. Clearing
      // here would drop the only record of that and leave the next frame reusing results for inputs
      // that changed — a stale pixel surviving until something else happens to dirty those nodes again.
      abortIncrementalFrame();
      return;
    }
    noteCoherence(
      coherenceHoldStartRef,
      t,
      staleIds,
      maxStalenessSeconds,
      false,
      staleBySource,
      allStaleness,
      readiness.reason
    );
    pruneDepartedSceneResources({
      liveLayerIds: new Set(ls.map((layer) => layer.id)),
      liveMediaSourceIds,
      gradePool: sharedGradeRenderersRef.current,
      mediaPool: sharedMediaRenderersRef.current,
    });

    const spec: SceneFrameSpec = { width: renderW, height: renderH, backgroundColor: bg, layers: draws, debugFrameTime: t };
    try {
      // HOT SPOT: composite + present (renderFrame ends in presentFrame). Unlike `frameProfiler`,
      // which only records while the transport is PLAYING, this fires whenever the call exceeds 40ms —
      // and the stalls being chased are paused/scrub-time.
      const compositeStart = performance.now();
      frameProfiler.measure("compositor.render", () => compositor.renderFrame(spec));
      markHotSpot("scene-composite", compositeStart, `${renderW}x${renderH} draws=${draws.length}`);
      if (playing) {
        frameRendered?.(t);
      }
      // Recorded AFTER the composite succeeds, so the ledger counts frames that reached the screen
      // rather than frames we intended to show — a throw here is a failure, not a present.
      //
      // `staleIds` non-empty at this point means the frame was presented DESPITE disagreement: while
      // playing the barrier is off by design (`tolerateLag`), and while paused a hold expired through
      // one of its two bounded hatches. Both are honest under today's architecture; the ledger makes
      // them countable, and that count is the baseline slice S4.6 has to beat.
      outcomeRef.current = "presented";
      // SETTLED (S2.2): on screen, and nothing outstanding — no source showing another moment, no layer
      // without its texture. Deliberately stricter than `presented`: during playback the barrier is off,
      // so frames present with stale sources routinely, and a consumer waiting for "the picture is
      // ready" that woke on those would capture the wrong moment. The two predicates are computed from
      // the same two arrays the hold gate just used, so they cannot drift apart.
      settledRef.current = staleIds.length === 0 && notReadyIds.length === 0;
      notePresent({
        targetTime: t,
        participants: liveMediaSourceIds.size,
        staleIds,
        notReadyIds,
        maxStalenessSeconds,
        worstSourceId: worstStaleId,
        worstSourceServedTime: worstStaleServed,
        worstSourceMediaEnd: worstStaleMediaEnd,
        playing,
      });
      // The frame composited and presented — only now is clearing the dirt an honest assertion that
      // the work those marks described was actually done.
      commitIncrementalFrame();
    } catch (error) {
      outcomeRef.current = "failed";
      abortIncrementalFrame();
      fail("render", error);
    }
    // Whole-frame envelope. If this reports ~7500ms while grade+composite are small, the time is in
    // the draw-list build (Flarex compile / rasterizer) — and if ALL THREE stay quiet through a stall,
    // the block is outside our JS entirely (GC / browser-internal), which is what the self-profiler's
    // "no JS samples in window" already suggested and what would send this to DevTools Performance.
    markHotSpot("scene-draw-total", drawStart, `layers=${ls.length}`);
  };

  // FRAME IDENTITY (ADR-012 3.3, slice S2.1) + the settle window's ownership rule, both owned by
  // `playback/scene-frame-scope.ts` since S7.1. The scope wraps the CALL, not the body, because
  // `drawFrameImpl` has a dozen early returns and only that placement cannot miss one.
  drawRef.current = () => {
    runLiveFrameScope({
      refs: {
        outcome: outcomeRef,
        settled: settledRef,
        prevSettled: prevSettledRef,
        rearmedSinceSettled: rearmedSinceSettledRef,
        activeUntil: activeUntilRef,
      },
      targetTimeSeconds: () => inputsRef.current.currentTime,
      isPlaying: () => inputsRef.current.isPlaying,
      frameCompletionEnabled: frameCompletionEnabledRef.current,
      draw: drawFrameImpl,
      profilerSnapshot: () => compositorRef.current?.profilerSnapshot(),
    });
  };

  // rAF loop that only COMPOSITES while playing or inside a settle window (after a change / async raster
  // arrival). When idle it's a single timestamp check + reschedule — no GPU work, no texture uploads —
  // so the scene compositor doesn't steal main-thread/GPU time from the timeline + viewer when paused.
  useEffect(() => {
    let cancelled = false;
    let wasSuspended = false;
    // Edge detection for the settle-window backstop below — we care about the tick the window CLOSES on.
    let wasInWindow = false;
    // Baseline for playback frame-interval telemetry (frame-stats.ts). Reset across pauses/suspends so
    // a pause gap is never counted as a "frame". Measurement only — no effect on the render itself.
    let lastPlayingFrameTs = 0;
    const loop = () => {
      const compositor = compositorRef.current;
      if (cancelled || disposedRef.current || failedRef.current || contextLostRef.current || !compositor || compositor.isContextLost()) {
        if (compositor?.isContextLost() && !failedRef.current) {
          contextLostRef.current = true;
          failedRef.current = true;
          disposeResources();
          scheduleSceneRecovery();
        }
        rafRef.current = 0;
        return;
      }
      // During a main-thread export this compositor must NOT touch its WebGL context: the export's own
      // contexts can evict ours, and rendering through the dead context floods the console. Skip drawing
      // while suspended; on release re-arm a settle window so we repaint the current frame.
      if (isPreviewSuspendedForExport()) {
        wasSuspended = true;
        lastPlayingFrameTs = 0;
      } else {
        if (wasSuspended) {
          wasSuspended = false;
          requestDraw();
        }
        const now = typeof performance !== "undefined" ? performance.now() : Date.now();
        const playingFrame = inputsRef.current.isPlaying;
        const inWindow = now < activeUntilRef.current;
        // DEBT-005's retirement condition (S2.2). The settle window is meant to be a BACKSTOP; this
        // records the only case where it actually acted as one — the window ran out while the picture
        // had still not settled, so the viewer stopped compositing on a frame that was never finished.
        // In steady state this must never fire. While it does, the timer is load-bearing and the debt
        // stands; when a soak produces none, completion is doing the whole job.
        if (wasInWindow && !inWindow && !playingFrame && !prevSettledRef.current && kernelDiagnostics.enabled) {
          kernelDiagnostics.record({
            kind: "transition",
            severity: "warn",
            subject: { kind: "runtime" },
            reason: "settle-backstop-expired",
            detail: { targetTime: Number(inputsRef.current.currentTime.toFixed(4)) },
          });
        }
        wasInWindow = inWindow;
        if (playingFrame || inWindow) {
          drawRef.current();
          // Playback smoothness telemetry: interval between composited playback frames + composite CPU
          // cost. Feeds the Stats HUD and the adaptive quality controller. Skipped for settle-window
          // (paused) draws and after a failed frame, so it only ever measures real playback frames.
          if (playingFrame && !failedRef.current && !contextLostRef.current) {
            const end = typeof performance !== "undefined" ? performance.now() : Date.now();
            if (lastPlayingFrameTs > 0) recordPlaybackFrame(now - lastPlayingFrameTs, end - now);
            lastPlayingFrameTs = now;
          }
          // A sustained run of clean frames after a rebuild restores the full retry budget.
          if (rebuildAttemptsRef.current > 0 && !failedRef.current && !contextLostRef.current) {
            goodFramesRef.current += 1;
            if (goodFramesRef.current >= HEALTHY_FRAMES_TO_RESET) {
              rebuildAttemptsRef.current = 0;
              goodFramesRef.current = 0;
            }
          }
        }
        if (!playingFrame) lastPlayingFrameTs = 0;
      }
      const nextCompositor = compositorRef.current;
      if (cancelled || disposedRef.current || contextLostRef.current || failedRef.current || !nextCompositor || nextCompositor.isContextLost()) {
        if (nextCompositor?.isContextLost() && !failedRef.current) {
          contextLostRef.current = true;
          failedRef.current = true;
          disposeResources();
          scheduleSceneRecovery();
        }
        rafRef.current = 0;
        return;
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    stopLoop();
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      cancelled = true;
      stopLoop();
    };
  }, [recoveryTick]);

  /**
   * The cache bundle a SCRATCH frame (thumbnail / capture) should use — ADR-012 I-32, slice S2.3.
   *
   * One implementation for both scratch call sites: two would be two answers to "which caches does a
   * thumbnail use", which is regression G5 and precisely how the live/scratch distinction got lost in
   * the first place.
   */
  const scratchScopeCaches = () => {
    const { width: w, height: h } = inputsRef.current;
    const existing = scratchMatteCacheRef.current;
    // Rebuilt on a dimension change rather than resized: the live cache is rebuilt for the same reason
    // (its effect is keyed on [width, height]), and a scratch cache holding mattes rasterized for the
    // old comp size would hand back the wrong-sized matte for a key that still looked valid.
    if (!existing || existing.width !== w || existing.height !== h) {
      existing?.cache.dispose();
      scratchMatteCacheRef.current = { cache: new SceneMaskMatteCache(w, h), width: w, height: h };
    }
    return {
      matteCache: scratchMatteCacheRef.current!.cache,
      nestMatteCaches: scratchNestMatteCachesRef.current,
      flarexSourceDrawCache: scratchFlarexSourceDrawCacheRef.current,
    };
  };

  const disposeScratchScope = () => {
    scratchMatteCacheRef.current?.cache.dispose();
    scratchMatteCacheRef.current = null;
    for (const cache of scratchNestMatteCachesRef.current.values()) {
      try {
        cache.dispose();
      } catch {
        /* ignore */
      }
    }
    scratchNestMatteCachesRef.current.clear();
    scratchFlarexSourceDrawCacheRef.current.clear();
  };

  // Publish the viewer-capture handle (todo.md Phase 6B P1a). Methods read live refs, so one stable object
  // stays valid across recoveries — each call re-checks the compositor before touching the GPU.
  useEffect(() => {
    if (!captureRef) return undefined;
    const releaseCaptureResources = () => {
      // The scratch scope's lifetime IS the handle's — the same rule the "capture:"/"thumb:" grade
      // renderers below already follow. S2.3 only generalises it to the caches they were sharing.
      disposeScratchScope();
      releaseScratchSceneResources(sharedGradeRenderersRef.current);
    };
    /**
     * Composite ONE layer of the live scene through this viewer's own compositor, caches and graded
     * textures, and read it back. Backs both the Flarex node thumbnails and the isolated-clip scope
     * source; `rootNodeId` re-roots the clip's comp at a node when present.
     *
     * Synchronous because it reuses `liveMediaGradedRef` — the media the live frame already decoded
     * and graded. That is the whole reason this is cheap and the reason it can be called from a
     * synchronous sampler: resolving media itself (seek, decode, grade) is async and is what the
     * proxy-capture path has to do.
     */
    const renderIsolated = (
      layerId: string,
      rootNodeId: string | undefined,
      targetWidth: number,
      targetHeight: number,
      buffer: Uint8Array | undefined,
      overlayScope: string
    ) => {
      const compositor = compositorRef.current;
      if (!compositor || compositor.isContextLost() || failedRef.current || contextLostRef.current || disposedRef.current) return null;
      // Same rule as renderOffscreen (v24 capture race): playback owns this compositor. These are
      // idle-only affordances, so this is a hard gate, not a best-effort skip.
      if (inputsRef.current.isPlaying) return null;
      const getMediaGraded = liveMediaGradedRef.current;
      // No frame has composited yet — there are no graded textures to sample, and grading a set of
      // our own is exactly the cost this path exists to avoid.
      if (!getMediaGraded) return null;
      const { layers: ls, width: w, height: h, renderScale: rScale, nestedGroups: nestGroups } = inputsRef.current;
      const host = ls.find((layer) => layer.id === layerId);
      if (!host) return null;
      // A thumbnail is a frame with a purpose, not an untracked side errand (S2.1/S2.3). Naming it
      // makes `frame-overlap` meaningful — one rendered inside a live frame is the I-32 violation this
      // scope exists to prevent, and it is now reported rather than invisible.
      beginFrame("thumbnail", inputsRef.current.currentTime);
      let thumbOutcome: FrameOutcome = "abandoned";
      const scoped = scratchScopeCaches();
      try {
        const draws = buildSceneDraws({
          // The clip ALONE: this shows what this layer (or node) OUTPUTS, not what the timeline
          // composites around it. Transitions are dropped for the same reason.
          layers: [host],
          width: w,
          height: h,
          currentTime: inputsRef.current.currentTime,
          renderScale: rScale,
          transitions: [],
          rasterizer: rasterizerRef.current,
          matteCache: scoped.matteCache,
          gradeRenderers: gradeRenderersRef.current,
          getMediaGraded,
          gradeOverlay: makeGradeOverlayRef.current(compositor, overlayScope),
          createCanvas: () => document.createElement("canvas"),
          regionPassModel: getRegionPassesEnabled(),
          nestedGroups: nestGroups,
          nestMatteCaches: scoped.nestMatteCaches,
          flarexComps: inputsRef.current.flarexComps,
          flarexVirtualLayers: inputsRef.current.flarexVirtualLayers,
          flarexSourceDrawCache: scoped.flarexSourceDrawCache,
          // Re-root at this node when asked. Deliberately WITHOUT `flarexCompProxies`: a comp proxy
          // replaces the whole lowering with one pre-rendered frame, so every node would render
          // identically as the comp's final output — the one input that would make this silently wrong.
          ...(rootNodeId ? { flarexPreviewRootNodeId: rootNodeId } : {}),
        });
        // CONTAIN the project aspect inside the requested box: the readback is a straight blit of the
        // whole frame, so asking for a 16:9 target on a 9:16 project would squash it. The caller gets
        // the size actually used and letterboxes with it.
        const aspect = w / Math.max(1, h);
        const boxAspect = targetWidth / Math.max(1, targetHeight);
        const outW = boxAspect > aspect ? Math.max(1, Math.round(targetHeight * aspect)) : targetWidth;
        const outH = boxAspect > aspect ? targetHeight : Math.max(1, Math.round(targetWidth / aspect));
        const rendered = compositor.renderFrameThumbnail(
          {
            width: Math.max(1, Math.round(w * rScale)),
            height: Math.max(1, Math.round(h * rScale)),
            // A frame is always cleared OPAQUE (`renderFrameCore`) — that is the render contract every
            // renderer shares. So a keyed/cropped region reads as this color rather than as
            // transparency; black is both the honest answer (it is what the viewer shows) and a
            // neutral backing.
            backgroundColor: "#000000",
            layers: draws,
            debugFrameTime: inputsRef.current.currentTime,
          },
          outW,
          outH,
          buffer
        );
        // renderFrameThumbnail leaves OUR frame in the retained composite, which is what the color
        // scopes sample. Re-arm the settle window so the live frame is re-composited over it.
        requestDraw();
        thumbOutcome = "presented";
        return rendered;
      } catch {
        thumbOutcome = "failed";
        return null;
      } finally {
        // A thumbnail never claims `settled`: it is a scratch frame for one consumer, and waking a
        // "the picture is ready" listener on it would hand that listener someone else's picture.
        endFrame(thumbOutcome);
      }
    };

    const handle: SceneViewerCaptureHandle = {
      getSharedGl() {
        const compositor = compositorRef.current;
        if (!compositor || compositor.isContextLost() || failedRef.current || contextLostRef.current || disposedRef.current) return null;
        return compositor.sharedGl;
      },
      async ensureTextRasters(ls, timeSeconds) {
        const rasterizer = rasterizerRef.current;
        if (!rasterizer) return;
        const { width: w, height: h } = inputsRef.current;
        await Promise.all(
          ls
            .filter((layer) => layer.type === "text" || layer.type === "shape")
            .map(async (layer) => {
              // boxMode must match buildSceneDraws' own computation (blur/glow → comp-sized raster).
              const fx = getCompositionFilterEffects(layer, { currentTimeSeconds: timeSeconds });
              const boxMode = !(fx.blurPx > 0 || fx.glow);
              await rasterizer.ensure(layer, timeSeconds, w, h, boxMode);
            })
        );
      },
      renderOffscreen({ layers: ls, timeSeconds: t, transitions: tPairs, getMediaGraded, buffer }) {
        const compositor = compositorRef.current;
        if (!compositor || compositor.isContextLost() || failedRef.current || contextLostRef.current || disposedRef.current) return null;
        // v24 (capture race): NEVER render offscreen while playing — playback owns this compositor.
        // An in-flight capture frame landing after play start composited a span-time frame into the
        // shared accumulators and (pre-guard) could resize/clear the on-screen canvas via ensureSize
        // (paused scale 1 vs playing scale 0.5/0.25) — the play-start black flash. The capture loop
        // treats null as not-ready and its abort (fired at the play gesture) lands right after.
        if (inputsRef.current.isPlaying) return null;
        const { width: w, height: h, backgroundColor: bg, renderScale: rScale, nestedGroups: nestGroups } = inputsRef.current;
        const renderW = Math.max(1, Math.round(w * rScale));
        const renderH = Math.max(1, Math.round(h * rScale));
        beginFrame("capture", t);
        let captureOutcome: FrameOutcome = "abandoned";
        const scoped = scratchScopeCaches();
        try {
          const draws = buildSceneDraws({
            layers: ls,
            width: w,
            height: h,
            currentTime: t,
            renderScale: rScale,
            transitions: tPairs,
            rasterizer: rasterizerRef.current,
            matteCache: scoped.matteCache,
            gradeRenderers: gradeRenderersRef.current,
            getMediaGraded,
            gradeOverlay: makeGradeOverlayRef.current(compositor, "capture:"),
            createCanvas: () => document.createElement("canvas"),
            regionPassModel: getRegionPassesEnabled(),
            // Same live composition's groups (this capture renders THIS viewer's own layer set at another
            // time — see the handle's docstring). The matte-cache pool USED to be shared with the live
            // path, and the note here recorded the trade-off honestly: "alternating just re-hashes, never
            // corrupts". Correct about corruption, and that was never the cost — the cost is that every
            // re-hash EVICTS an entry the live frame is about to need, so a capture loop running beside a
            // paused viewer makes the viewer recompute mattes it already had. Under S2.3 a capture gets
            // its own pool and the live frame stops paying for it (I-32).
            nestedGroups: nestGroups,
            nestMatteCaches: scoped.nestMatteCaches,
            flarexComps: inputsRef.current.flarexComps,
            flarexVirtualLayers: inputsRef.current.flarexVirtualLayers,
            flarexSourceDrawCache: scoped.flarexSourceDrawCache,
          });
          const out = compositor.renderFrameOffscreen(
            { width: renderW, height: renderH, backgroundColor: bg, layers: draws, debugFrameTime: t },
            buffer
          );
          captureOutcome = "presented";
          return out;
        } catch {
          // A lost context is detected/recovered by the render loop; the capture caller just retries/fails.
          captureOutcome = "failed";
          return null;
        } finally {
          endFrame(captureOutcome);
        }
      },
      renderFlarexNodeThumbnail({ hostLayerId, nodeId, targetWidth, targetHeight, buffer }) {
        return renderIsolated(hostLayerId, nodeId, targetWidth, targetHeight, buffer, "thumb:");
      },
      readCompositeThumbnail(targetW, targetH, buffer) {
        const compositor = compositorRef.current;
        if (!compositor || compositor.isContextLost() || failedRef.current || contextLostRef.current || disposedRef.current) return null;
        try {
          // Async PBO readback (no GPU-drain stall) is part of the single-ctx preview package and gated with
          // it — with the flag OFF the shipped scopes stay on the EXACT synchronous path, byte-for-byte. When
          // ON, prefer async and fall back to the sync read during warm-up (before the first fence completes).
          if (singleCtxMedia) {
            return (
              compositor.readCompositeThumbnailAsync(targetW, targetH, buffer) ??
              compositor.readCompositeThumbnail(targetW, targetH, buffer)
            );
          }
          return compositor.readCompositeThumbnail(targetW, targetH, buffer);
        } catch {
          return null;
        }
      },
      releaseCaptureResources,
    };
    captureRef.current = handle;
    return () => {
      if (captureRef.current === handle) captureRef.current = null;
      releaseCaptureResources();
    };
  }, [captureRef]);

  // Non-interactive: selection boxes / motion-path handles are separate DOM overlays that must stay
  // clickable above this canvas.
  const style: CSSProperties = { position: "absolute", left: 0, top: 0, width, height, pointerEvents: "none" };
  // key={recoveryTick}: a recovery rebuild REMOUNTS the canvas element. getContext() on a canvas
  // whose context was lost returns the SAME dead context (see releaseContextIfDetached docs), so
  // rebuilding on the old element could only ever work if the browser had already restored it —
  // a fresh element gets a genuinely fresh context on every retry of the recovery ladder.
  return <canvas key={recoveryTick} ref={canvasRef} className="preview-scene-canvas" style={style} aria-hidden="true" />;
}
