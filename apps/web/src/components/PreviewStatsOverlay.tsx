/**
 * Viewer Stats HUD (P0 instrumentation). Small read-only overlay showing real playback health:
 * FPS, dropped-frame ratio, frame/composite times, the effective render scale (incl. the adaptive
 * cap), and live WebGL context count (`__rfActiveGlContexts`). Subscribes to the throttled
 * frame-stats store (~2Hz), so it costs nothing per frame and only exists while toggled on from the
 * preview toolbar. Premiere's dropped-frame indicator / Resolve's GPU status, Orreris-style.
 */

import { useSyncExternalStore } from "react";
import { getFrameStatsSnapshot, subscribeFrameStats } from "../editor/performance/frame-stats";
import { getAdaptiveQualityEnabled, getAdaptiveScaleCap, subscribeAdaptiveScaleCap } from "../editor/performance/adaptive-quality";
import { getVideoPoolStats, subscribeVideoPoolStats } from "../lib/video-element-pool";
import { getAudioClockDriftMs } from "../playback/audio-clock";

function scaleLabel(scale: number): string {
  if (scale >= 1) return "Full";
  if (scale >= 0.5) return "1/2";
  return "1/4";
}

export function PreviewStatsOverlay() {
  const stats = useSyncExternalStore(subscribeFrameStats, getFrameStatsSnapshot, getFrameStatsSnapshot);
  const adaptiveCap = useSyncExternalStore(subscribeAdaptiveScaleCap, getAdaptiveScaleCap, getAdaptiveScaleCap);
  const pool = useSyncExternalStore(subscribeVideoPoolStats, getVideoPoolStats, getVideoPoolStats);
  const glContexts = typeof window !== "undefined" ? (window as { __rfActiveGlContexts?: unknown }).__rfActiveGlContexts : undefined;
  const hasSamples = stats.sampleCount > 0;
  const droppedPct = Math.round(stats.droppedRatio * 100);
  const fpsClass = !stats.playing || !hasSamples ? "" : droppedPct > 20 ? "is-bad" : droppedPct > 5 ? "is-warn" : "is-good";
  // The 2026-08-17 clean-room finding, quantified: FPS read 62 (compositor repaint — healthy) over a
  // picture that was frozen ~95% of the time, because the old "Media" row SUMMED per-layer delivery —
  // 6 layers averaging 12.5fps sums to the same headline number as one layer at 75fps. `minMediaFps`
  // is the worst layer, which is what "is playback actually healthy" needs — a layer stalled at 0
  // cannot hide behind five others still delivering. `mediaCollapsed` names the exact failure this
  // was blind to: the compositor repaint rate reads fine while real motion delivery has stopped.
  const hasMediaLayers = stats.playing && stats.activeMediaLayers > 0 && stats.minMediaFps != null;
  const mediaCollapsed = hasMediaLayers && stats.minMediaFps! < 5 && hasSamples && stats.fps >= 24;
  const mediaClass = !hasMediaLayers ? "" : mediaCollapsed ? "is-bad" : stats.minMediaFps! < 15 ? "is-warn" : "is-good";
  return (
    <div className="preview-stats-overlay" aria-hidden="true">
      <div className={`preview-stats-row ${fpsClass}`}>
        <span>FPS</span>
        <span>{stats.playing && hasSamples ? stats.fps.toFixed(0) : "—"}</span>
      </div>
      {/* The WORST per-layer motion-delivery rate (rVFC), not a sum — see the block comment above.
          FPS above is the compositor repaint rate (display refresh) and happily redraws an unchanged
          frame, so a stalled layer under a healthy FPS reading is exactly the case this row exists to
          catch: mediaCollapsed drives `is-bad` and the "STALLED" label specifically for that gap,
          distinct from a merely low rate (`is-warn`) or ordinary "nothing playing" ("—"). */}
      <div className={`preview-stats-row ${mediaClass}`}>
        <span>Media</span>
        <span>
          {hasMediaLayers
            ? `${stats.minMediaFps!.toFixed(0)}${mediaCollapsed ? " STALLED" : ""} · ${stats.activeMediaLayers}x`
            : "—"}
        </span>
      </div>
      <div className="preview-stats-row">
        <span>Dropped</span>
        <span>{stats.playing && hasSamples ? `${droppedPct}%` : "—"}</span>
      </div>
      <div className="preview-stats-row">
        <span>Frame</span>
        <span>{hasSamples ? `${stats.avgFrameMs.toFixed(1)}ms` : "—"}</span>
      </div>
      <div className="preview-stats-row">
        <span>Composite</span>
        <span>{hasSamples ? `${stats.avgDrawMs.toFixed(1)}ms` : "—"}</span>
      </div>
      <div className="preview-stats-row">
        <span>Res</span>
        <span>
          {scaleLabel(stats.renderScale)}
          {getAdaptiveQualityEnabled() && adaptiveCap < 1 ? " (auto)" : ""}
        </span>
      </div>
      <div className="preview-stats-row">
        <span>Decoders</span>
        <span>{`${pool.active}+${pool.idle}`}</span>
      </div>
      {(() => {
        // Read on each throttled stats re-render (~2Hz) — no extra subscription needed.
        const driftMs = getAudioClockDriftMs();
        const driftClass = driftMs == null ? "" : Math.abs(driftMs) > 80 ? "is-bad" : Math.abs(driftMs) > 30 ? "is-warn" : "is-good";
        return (
          <div className={`preview-stats-row ${driftClass}`}>
            <span>A/V drift</span>
            <span>{driftMs == null ? "—" : `${driftMs >= 0 ? "+" : ""}${driftMs.toFixed(0)}ms`}</span>
          </div>
        );
      })()}
      {typeof glContexts === "number" ? (
        <div className="preview-stats-row">
          <span>GL ctx</span>
          <span>{glContexts}</span>
        </div>
      ) : null}
    </div>
  );
}
