/**
 * Viewer Stats HUD (P0 instrumentation). Small read-only overlay showing real playback health:
 * FPS, dropped-frame ratio, frame/composite times, the effective render scale (incl. the adaptive
 * cap), and live WebGL context count (`__rfActiveGlContexts`). Subscribes to the throttled
 * frame-stats store (~2Hz), so it costs nothing per frame and only exists while toggled on from the
 * preview toolbar. Premiere's dropped-frame indicator / Resolve's GPU status, Kimera-style.
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
  return (
    <div className="preview-stats-overlay" aria-hidden="true">
      <div className={`preview-stats-row ${fpsClass}`}>
        <span>FPS</span>
        <span>{stats.playing && hasSamples ? stats.fps.toFixed(0) : "—"}</span>
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
