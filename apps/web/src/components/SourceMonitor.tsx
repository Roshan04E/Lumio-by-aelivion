import { useEffect, useRef, useState, type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Pause, Play, StepBack, StepForward, X } from "lucide-react";
import type { SourceAsset } from "@kimera-by-aelivion/shared";
import { useAudioPeaks } from "../lib/audioPeaks";
import { assetHasAudioStream } from "../lib/assetAudio";

type AssetAddMode = "auto" | "video" | "audio" | "both";
type ThreePointOp = "insert" | "overwrite";

const WAVEFORM_BUCKETS = 200;

export const SOURCE_DRAG_MIME = "application/x-kimera-source-drag";

export type SourceDragPayload = {
  assetId: string;
  sourceInSeconds: number;
  durationSeconds: number;
  mode: AssetAddMode;
};

function formatTimecode(seconds: number): string {
  const total = Math.max(0, seconds);
  const mm = Math.floor(total / 60);
  const ss = Math.floor(total % 60);
  const ff = Math.floor((total - Math.floor(total)) * 100);
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(ff).padStart(2, "0")}`;
}

/**
 * DaVinci-style source monitor: previews ONE source asset (original bytes, plain <video>/<audio> —
 * no shared playback clock, no second WebGL context) with its own In/Out marks for 3-point editing.
 * Insert/Overwrite hand the marked range up to EditorPage, which builds the timeline layer(s) and
 * commits via updateComposition — this component never touches composition state directly.
 */
export function SourceMonitor({
  asset,
  inSeconds,
  outSeconds,
  onSetIn,
  onSetOut,
  onClearMarks,
  onClose,
  onEdit,
  onLoadAssetId
}: {
  asset: SourceAsset;
  inSeconds: number | null;
  outSeconds: number | null;
  onSetIn: (time: number) => void;
  onSetOut: (time: number) => void;
  onClearMarks: () => void;
  onClose: () => void;
  onEdit: (op: ThreePointOp, sourceInSeconds: number, sourceOutSeconds: number, mode: AssetAddMode) => void;
  /** Load a different asset (bin tile dropped onto the monitor), Premiere-style. */
  onLoadAssetId?: ((assetId: string) => void) | undefined;
}) {
  const isAudio = asset.fileType.startsWith("audio/");
  // Only a video asset can lack audio; audio assets and "unknown yet" both stay enabled.
  const noAudio = !isAudio && assetHasAudioStream(asset) === false;
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement>(null);
  const scrubberRef = useRef<HTMLDivElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(asset.durationSeconds || 0);
  const [playing, setPlaying] = useState(false);
  const [mode, setMode] = useState<AssetAddMode>("auto");
  const rafRef = useRef(0);
  const dragMarkRef = useRef<{ pointerId: number; mark: "in" | "out" } | null>(null);
  const dragPreviewRef = useRef<HTMLDivElement>(null);
  const peaks = useAudioPeaks(asset.fileUrl ?? asset.previewUrl, WAVEFORM_BUCKETS);

  // Reset transport state whenever a different asset is loaded into the monitor. A confirmed
  // silent video defaults to "video" (V+A/A are disabled) instead of a mode it can't fulfill.
  useEffect(() => {
    setCurrentTime(0);
    setDuration(asset.durationSeconds || 0);
    setPlaying(false);
    setMode(noAudio ? "video" : "auto");
  }, [asset.id, noAudio]);

  useEffect(() => {
    if (!playing) return;
    let active = true;
    const tick = () => {
      if (!active) return;
      const media = mediaRef.current;
      if (media) setCurrentTime(media.currentTime);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      active = false;
      cancelAnimationFrame(rafRef.current);
    };
  }, [playing]);

  const effectiveIn = inSeconds ?? 0;
  const effectiveOut = outSeconds ?? duration;
  const clampedOut = Math.max(effectiveIn + 0.05, effectiveOut);

  function seekTo(time: number) {
    const media = mediaRef.current;
    const clamped = Math.min(Math.max(0, time), duration || time);
    if (media) media.currentTime = clamped;
    setCurrentTime(clamped);
  }

  function togglePlay() {
    const media = mediaRef.current;
    if (!media) return;
    if (media.paused) void media.play().catch(() => {});
    else media.pause();
  }

  function step(deltaSeconds: number) {
    seekTo(currentTime + deltaSeconds);
  }

  function timeAtClientX(clientX: number): number {
    const rect = scrubberRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return ratio * duration;
  }

  function handleScrub(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragMarkRef.current) return;
    seekTo(timeAtClientX(event.clientX));
  }

  function handleMarkPointerDown(event: ReactPointerEvent<HTMLDivElement>, mark: "in" | "out") {
    event.stopPropagation();
    event.preventDefault();
    dragMarkRef.current = { pointerId: event.pointerId, mark };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleMarkPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragMarkRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const time = timeAtClientX(event.clientX);
    if (drag.mark === "in") {
      onSetIn(Math.min(time, clampedOut - 0.05));
    } else {
      onSetOut(Math.max(time, effectiveIn + 0.05));
    }
  }

  function handleMarkPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragMarkRef.current?.pointerId === event.pointerId) {
      dragMarkRef.current = null;
    }
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    const key = event.key.toLowerCase();
    if (key === "i") {
      event.preventDefault();
      event.stopPropagation();
      onSetIn(currentTime);
    } else if (key === "o") {
      event.preventDefault();
      event.stopPropagation();
      onSetOut(currentTime);
    } else if (key === " ") {
      event.preventDefault();
      event.stopPropagation();
      togglePlay();
    } else if (key === "arrowleft") {
      event.preventDefault();
      event.stopPropagation();
      step(event.shiftKey ? -1 : -1 / 30);
    } else if (key === "arrowright") {
      event.preventDefault();
      event.stopPropagation();
      step(event.shiftKey ? 1 : 1 / 30);
    } else if (key === "j" || key === "k" || key === "l") {
      event.preventDefault();
      event.stopPropagation();
      const media = mediaRef.current;
      if (!media) return;
      if (key === "k") media.pause();
      else {
        media.playbackRate = 1;
        if (key === "j") step(-0.5);
        else void media.play().catch(() => {});
      }
    } else if (key === ",") {
      event.preventDefault();
      event.stopPropagation();
      onEdit("insert", effectiveIn, clampedOut, mode);
    } else if (key === ".") {
      event.preventDefault();
      event.stopPropagation();
      onEdit("overwrite", effectiveIn, clampedOut, mode);
    }
  }

  // Premiere-style drag to the timeline: the video stage drags the currently-picked mode
  // (V+A/V/A), each mode chip drags that SPECIFIC mode regardless of the picked one. The
  // marked In/Out range (or the whole asset, if unmarked) travels with the drag so dropping
  // trims the same way Insert/Overwrite would.
  function handleDragStart(event: ReactDragEvent<HTMLElement>, dragMode: AssetAddMode) {
    const clipDuration = clampedOut - effectiveIn;
    const payload: SourceDragPayload = {
      assetId: asset.id,
      sourceInSeconds: effectiveIn,
      durationSeconds: clipDuration,
      mode: dragMode
    };
    event.dataTransfer.setData(SOURCE_DRAG_MIME, JSON.stringify(payload));
    event.dataTransfer.setData("application/x-kimera-asset", asset.id);
    event.dataTransfer.effectAllowed = "copy";

    // Custom drag ghost: a thin timeline-clip-shaped bar (scaled loosely by duration) instead of
    // the browser's default full-frame screenshot, so the drag reads as "placing a clip" from
    // the first frame, not "dragging a photo".
    const preview = dragPreviewRef.current;
    if (preview) {
      preview.style.width = `${Math.min(220, Math.max(70, clipDuration * 14))}px`;
      preview.textContent = `${dragMode === "audio" ? "♪ " : ""}${asset.originalName ?? asset.fileName} · ${formatTimecode(clipDuration)}`;
      preview.className = `source-drag-preview${dragMode === "audio" ? " is-audio" : ""}`;
      event.dataTransfer.setDragImage(preview, 10, 16);
    }
  }

  const inPct = duration > 0 ? (effectiveIn / duration) * 100 : 0;
  const outPct = duration > 0 ? (clampedOut / duration) * 100 : 100;
  const playheadPct = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <section
      className="source-monitor"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      aria-label="Source monitor"
      onDragOver={(event) => {
        // Accept bin-tile drags only — not our OWN outgoing drags (those carry SOURCE_DRAG_MIME).
        if (onLoadAssetId && event.dataTransfer.types.includes("application/x-kimera-asset") && !event.dataTransfer.types.includes(SOURCE_DRAG_MIME)) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }
      }}
      onDrop={(event) => {
        if (!onLoadAssetId || event.dataTransfer.types.includes(SOURCE_DRAG_MIME)) return;
        const assetId = event.dataTransfer.getData("application/x-kimera-asset");
        if (!assetId) return;
        event.preventDefault();
        onLoadAssetId(assetId);
      }}
    >
      <div ref={dragPreviewRef} className="source-drag-preview" aria-hidden="true" />
      <div className="monitor-caption">
        <span className="monitor-caption-label">Source</span>
        <span className="monitor-caption-name" title={asset.originalName ?? asset.fileName}>
          {asset.originalName ?? asset.fileName}
        </span>
        <span className="monitor-caption-tc">
          {formatTimecode(currentTime)} / {formatTimecode(duration)}
        </span>
        <button type="button" className="monitor-caption-close" onClick={onClose} title="Close source monitor" aria-label="Close source monitor">
          <X size={13} />
        </button>
      </div>
      <div
        className="source-monitor-stage"
        draggable
        onDragStart={(event) => handleDragStart(event, mode)}
        title="Drag to timeline"
      >
        {isAudio ? (
          <audio
            ref={mediaRef as React.RefObject<HTMLAudioElement>}
            src={asset.fileUrl ?? asset.previewUrl}
            onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || asset.durationSeconds || 0)}
            onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
          />
        ) : (
          <video
            ref={mediaRef as React.RefObject<HTMLVideoElement>}
            src={asset.fileUrl ?? asset.previewUrl}
            poster={asset.thumbnailUrl}
            playsInline
            onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || asset.durationSeconds || 0)}
            onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
          />
        )}
      </div>
      <div className="source-waveform" aria-hidden="true">
        {peaks ? (
          <svg viewBox={`0 0 ${peaks.max.length} 100`} preserveAspectRatio="none">
            {peaks.max.map((value, index) => {
              const barW = 0.62;
              const barH = Math.max(barW, Math.min(1, value) * 90);
              return <rect key={index} x={index + (1 - barW) / 2} y={(100 - barH) / 2} width={barW} height={barH} rx={barW / 2} />;
            })}
          </svg>
        ) : null}
      </div>
      <div
        className="source-scrubber"
        ref={scrubberRef}
        onPointerDown={handleScrub}
        onPointerMove={handleMarkPointerMove}
        onPointerUp={handleMarkPointerUp}
      >
        <div className="source-scrubber-range" style={{ left: `${inPct}%`, width: `${Math.max(0, outPct - inPct)}%` }} />
        <div
          className="source-scrubber-mark is-in"
          style={{ left: `${inPct}%` }}
          onPointerDown={(event) => handleMarkPointerDown(event, "in")}
          onPointerMove={handleMarkPointerMove}
          onPointerUp={handleMarkPointerUp}
          title="Drag to adjust In"
        />
        <div
          className="source-scrubber-mark is-out"
          style={{ left: `${outPct}%` }}
          onPointerDown={(event) => handleMarkPointerDown(event, "out")}
          onPointerMove={handleMarkPointerMove}
          onPointerUp={handleMarkPointerUp}
          title="Drag to adjust Out"
        />
        <div className="source-scrubber-playhead" style={{ left: `${playheadPct}%` }} />
      </div>
      <div className="source-monitor-controls">
        <button type="button" title="Mark In (I)" aria-label="Mark In" onClick={() => onSetIn(currentTime)}>
          [
        </button>
        <button type="button" title="Step back" aria-label="Step back" onClick={() => step(-1 / 30)}>
          <StepBack size={13} />
        </button>
        <button type="button" title="Play/Pause (Space)" aria-label="Play or pause" onClick={togglePlay}>
          {playing ? <Pause size={14} /> : <Play size={14} />}
        </button>
        <button type="button" title="Step forward" aria-label="Step forward" onClick={() => step(1 / 30)}>
          <StepForward size={13} />
        </button>
        <button type="button" title="Mark Out (O)" aria-label="Mark Out" onClick={() => onSetOut(currentTime)}>
          ]
        </button>
        {inSeconds !== null || outSeconds !== null ? (
          <button type="button" className="source-clear-marks" title="Clear In/Out" aria-label="Clear marks" onClick={onClearMarks}>
            Clear
          </button>
        ) : null}
        <span className="source-monitor-spacer" />
        {!isAudio ? (
          <div className="source-mode-control" role="group" aria-label="Insert mode (drag a chip to the timeline)">
            <button
              type="button"
              className={mode === "auto" ? "is-active" : ""}
              disabled={noAudio}
              onClick={() => setMode("auto")}
              draggable={!noAudio}
              onDragStart={(event) => handleDragStart(event, "auto")}
              title={noAudio ? "No audio stream in this asset" : "Video + audio — drag to timeline"}
            >
              V+A
            </button>
            <button
              type="button"
              className={mode === "video" ? "is-active" : ""}
              onClick={() => setMode("video")}
              draggable
              onDragStart={(event) => handleDragStart(event, "video")}
              title="Video only — drag to timeline"
            >
              V
            </button>
            <button
              type="button"
              className={mode === "audio" ? "is-active" : ""}
              disabled={noAudio}
              onClick={() => setMode("audio")}
              draggable={!noAudio}
              onDragStart={(event) => handleDragStart(event, "audio")}
              title={noAudio ? "No audio stream in this asset" : "Audio only — drag to timeline"}
            >
              A
            </button>
          </div>
        ) : null}
        <button type="button" className="source-edit-button" title="Insert at playhead (,)" onClick={() => onEdit("insert", effectiveIn, clampedOut, mode)}>
          Insert
        </button>
        <button type="button" className="source-edit-button is-overwrite" title="Overwrite (.)" onClick={() => onEdit("overwrite", effectiveIn, clampedOut, mode)}>
          Overwrite
        </button>
      </div>
    </section>
  );
}
