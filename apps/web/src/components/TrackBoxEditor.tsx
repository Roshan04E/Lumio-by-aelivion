import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { TrackingPathArtifactData } from "@kimera-by-aelivion/shared";
import type { TrackPointPercent } from "../tools/local-tracking";
import { estimateTrackability, type GrayImage } from "../tools/tracking-core";

/** Patch radius (px) the live trackability estimate samples - matches the tracker's own FULL_PATCH_RADIUS so the indicator reflects what the tracker actually sees. */
const TRACKABILITY_PATCH_RADIUS = 7;

export interface TrackBoxEditorTarget {
  id: string;
  label: string;
  /** Auto-detect targets show a center marker instead of a guessed point until the first track runs. */
  auto?: boolean | undefined;
  /** Undefined until the target has either been manually placed or tracked at least once - no fake pre-positioned point. */
  point?: TrackPointPercent | undefined;
  trackingPath?: TrackingPathArtifactData | undefined;
}

/** Percent-space offset of the drag handle from the actual tracked point, so the cursor/handle never covers the point or the magnifier centered on it. */
const HANDLE_OFFSET = 6;
const MAGNIFIER_SIZE = 120;
const MAGNIFIER_ZOOM = 4;

/**
 * Real (non-schematic) manual track editor: shows the actual source video
 * frame with a draggable crosshair per target (DaVinci-style point tracker)
 * and the resulting track path (colored by per-frame confidence) overlaid on
 * top, so the user can see and correct exactly what the tracker is doing.
 * Multiple targets render simultaneously for multi-target tracking.
 *
 * Each point renders as a small crosshair plus a separate grab handle offset
 * to one side - dragging the handle moves the point without the cursor (or
 * the precision magnifier loupe shown while dragging) ever covering the
 * point itself.
 */
export function TrackBoxEditor({
  videoUrl,
  aspectRatio,
  scrubTimeSeconds,
  targets,
  selectedTargetId,
  textPlacement,
  fixMarker,
  isPlaying,
  onChangePoint,
  onMoveTextPlacement,
  onMoveFixMarker,
  onSelectTarget,
  onTimeUpdate,
  onPlaybackEnded
}: {
  videoUrl: string;
  aspectRatio: number;
  scrubTimeSeconds: number;
  targets: TrackBoxEditorTarget[];
  selectedTargetId: string;
  /** Optional draggable "where the follow text sits" ghost overlaid on the frame. */
  textPlacement?: { point: TrackPointPercent; text: string } | undefined;
  /** Optional draggable "fix from here" marker for the segmented re-track flow. */
  fixMarker?: { timeSeconds: number; point: TrackPointPercent } | undefined;
  /** When true, the video plays natively instead of just seeking to scrubTimeSeconds - lets the user watch the tracked clip play back in this same window to spot where it drifts. */
  isPlaying?: boolean | undefined;
  onChangePoint: (id: string, point: TrackPointPercent) => void;
  onMoveTextPlacement?: ((point: TrackPointPercent) => void) | undefined;
  onMoveFixMarker?: ((point: TrackPointPercent) => void) | undefined;
  onSelectTarget: (id: string) => void;
  /** Reports the video's live currentTime while playing, so the parent's scrub position (and the playhead overlay) track real playback. */
  onTimeUpdate?: ((timeSeconds: number) => void) | undefined;
  onPlaybackEnded?: (() => void) | undefined;
}) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const sampleCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const magnifierCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<{ targetId: string; pointerId: number; startPoint: TrackPointPercent; startPercent: TrackPointPercent } | undefined>(undefined);
  const textDragRef = useRef<{ pointerId: number; grabDelta: TrackPointPercent } | undefined>(undefined);
  const fixDragRef = useRef<{ pointerId: number; startPoint: TrackPointPercent; startPercent: TrackPointPercent } | undefined>(undefined);
  const [magnifierAt, setMagnifierAt] = useState<TrackPointPercent | undefined>(undefined);
  // Indicative "will this point actually track" score per target, 0..1, read live
  // from the current frame's local image structure (see estimateTrackability) - has
  // nothing to do with any tracking run, it's a heads-up before the user commits.
  const [trackability, setTrackability] = useState<Record<string, number>>({});

  // Crops a small window (not the whole frame) around a point and converts only that
  // to grayscale - cheap enough to call on every drag-move event, unlike a full-frame
  // getImageData which would lag the UI on a 720p+ source at drag-event rate.
  const trackabilityCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const sampleCropGray = useCallback((point: TrackPointPercent): { image: GrayImage; px: number; py: number } | undefined => {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) {
      return undefined;
    }
    trackabilityCanvasRef.current ??= document.createElement("canvas");
    const canvas = trackabilityCanvasRef.current;
    const margin = TRACKABILITY_PATCH_RADIUS + 4;
    const cropSize = margin * 2 + 1;
    canvas.width = cropSize;
    canvas.height = cropSize;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      return undefined;
    }
    const srcX = (point.x / 100) * video.videoWidth;
    const srcY = (point.y / 100) * video.videoHeight;
    const sx = Math.max(0, Math.min(video.videoWidth - cropSize, Math.round(srcX - margin)));
    const sy = Math.max(0, Math.min(video.videoHeight - cropSize, Math.round(srcY - margin)));
    ctx.drawImage(video, sx, sy, cropSize, cropSize, 0, 0, cropSize, cropSize);
    // getImageData throws SecurityError if the canvas got tainted (e.g. a cross-origin
    // video source loaded without CORS) - this indicator is purely a nice-to-have, so
    // failing to read pixels should silently turn it off rather than ever crash the tool.
    let imageData: ImageData;
    try {
      imageData = ctx.getImageData(0, 0, cropSize, cropSize);
    } catch {
      return undefined;
    }
    const { data, width, height } = imageData;
    const gray = new Float32Array(width * height);
    for (let i = 0; i < width * height; i += 1) {
      gray[i] = 0.299 * (data[i * 4] ?? 0) + 0.587 * (data[i * 4 + 1] ?? 0) + 0.114 * (data[i * 4 + 2] ?? 0);
    }
    return { image: { data: gray, width, height }, px: srcX - sx, py: srcY - sy };
  }, []);

  const scoreTrackability = useCallback(
    (id: string, point: TrackPointPercent) => {
      const sample = sampleCropGray(point);
      if (!sample) {
        return;
      }
      const score = estimateTrackability(sample.image, sample.px, sample.py, TRACKABILITY_PATCH_RADIUS);
      setTrackability((current) => (current[id] === score ? current : { ...current, [id]: score }));
    },
    [sampleCropGray]
  );

  // Recompute every placed target's score whenever the visible frame changes
  // (new clip, seek) so the indicator never reflects a stale frame.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    const rescoreAll = () => {
      for (const target of targets) {
        if (target.point) {
          scoreTrackability(target.id, target.point);
        }
      }
    };
    video.addEventListener("seeked", rescoreAll);
    if (video.readyState >= 2) {
      rescoreAll();
    }
    return () => video.removeEventListener("seeked", rescoreAll);
  }, [videoUrl, scrubTimeSeconds, scoreTrackability]);

  // Points can also change from outside a drag (auto-detect, re-detect, programmatic
  // placement) - track each target's last-scored point and rescore on change so the
  // indicator never goes stale for those paths either.
  const lastScoredPointsRef = useRef<Record<string, string>>({});
  useEffect(() => {
    for (const target of targets) {
      if (!target.point) {
        continue;
      }
      const signature = `${target.point.x.toFixed(2)},${target.point.y.toFixed(2)}`;
      if (lastScoredPointsRef.current[target.id] !== signature) {
        lastScoredPointsRef.current[target.id] = signature;
        scoreTrackability(target.id, target.point);
      }
    }
  }, [targets, scoreTrackability]);

  // Native playback for "watch the tracked clip play in this window". Separate from
  // the seek effect below: while playing, the video drives its own currentTime and
  // we only listen, we don't also try to force-seek it every scrub-state update
  // (that would fight the native playback and stutter it).
  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    if (isPlaying) {
      void video.play().catch(() => undefined);
    } else {
      video.pause();
    }
  }, [isPlaying]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !onTimeUpdate) {
      return;
    }
    const handleTimeUpdate = () => onTimeUpdate(video.currentTime);
    video.addEventListener("timeupdate", handleTimeUpdate);
    return () => video.removeEventListener("timeupdate", handleTimeUpdate);
  }, [onTimeUpdate]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !onPlaybackEnded) {
      return;
    }
    video.addEventListener("ended", onPlaybackEnded);
    return () => video.removeEventListener("ended", onPlaybackEnded);
  }, [onPlaybackEnded]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || isPlaying) {
      return;
    }
    const seek = () => {
      const next = Math.max(0, Math.min(video.duration || scrubTimeSeconds, scrubTimeSeconds));
      if (Number.isFinite(next)) {
        video.currentTime = next;
      }
    };
    if (video.readyState >= 1) {
      seek();
    } else {
      video.onloadedmetadata = seek;
    }
  }, [scrubTimeSeconds, videoUrl, isPlaying]);

  function percentFromClient(clientX: number, clientY: number) {
    const bounds = frameRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width === 0 || bounds.height === 0) {
      return { x: 0, y: 0 };
    }
    return {
      x: clamp(((clientX - bounds.left) / bounds.width) * 100, 0, 100),
      y: clamp(((clientY - bounds.top) / bounds.height) * 100, 0, 100)
    };
  }

  function percentFromEvent(event: ReactPointerEvent) {
    return percentFromClient(event.clientX, event.clientY);
  }

  function startTextMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!textPlacement || !onMoveTextPlacement) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const cursor = percentFromEvent(event);
    textDragRef.current = { pointerId: event.pointerId, grabDelta: { x: textPlacement.point.x - cursor.x, y: textPlacement.point.y - cursor.y } };
  }

  function handleTextMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = textDragRef.current;
    if (!drag || event.pointerId !== drag.pointerId || !onMoveTextPlacement) {
      return;
    }
    event.preventDefault();
    const cursor = percentFromEvent(event);
    onMoveTextPlacement({ x: clamp(cursor.x + drag.grabDelta.x, 0, 100), y: clamp(cursor.y + drag.grabDelta.y, 0, 100) });
  }

  function handleTextUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (textDragRef.current?.pointerId === event.pointerId) {
      textDragRef.current = undefined;
    }
  }

  function drawMagnifier(point: TrackPointPercent) {
    const video = videoRef.current;
    const canvas = magnifierCanvasRef.current;
    if (!video || !canvas || !video.videoWidth || !video.videoHeight) {
      return;
    }
    sampleCanvasRef.current ??= document.createElement("canvas");
    const sample = sampleCanvasRef.current;
    sample.width = video.videoWidth;
    sample.height = video.videoHeight;
    const sctx = sample.getContext("2d");
    const ctx = canvas.getContext("2d");
    if (!sctx || !ctx) {
      return;
    }
    sctx.drawImage(video, 0, 0, sample.width, sample.height);

    const px = (point.x / 100) * video.videoWidth;
    const py = (point.y / 100) * video.videoHeight;
    const sourceRadius = MAGNIFIER_SIZE / 2 / MAGNIFIER_ZOOM;

    ctx.clearRect(0, 0, MAGNIFIER_SIZE, MAGNIFIER_SIZE);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(sample, px - sourceRadius, py - sourceRadius, sourceRadius * 2, sourceRadius * 2, 0, 0, MAGNIFIER_SIZE, MAGNIFIER_SIZE);

    ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(MAGNIFIER_SIZE / 2, MAGNIFIER_SIZE / 2 - 7);
    ctx.lineTo(MAGNIFIER_SIZE / 2, MAGNIFIER_SIZE / 2 + 7);
    ctx.moveTo(MAGNIFIER_SIZE / 2 - 7, MAGNIFIER_SIZE / 2);
    ctx.lineTo(MAGNIFIER_SIZE / 2 + 7, MAGNIFIER_SIZE / 2);
    ctx.stroke();
    ctx.strokeStyle = getComputedStyle(ctx.canvas).getPropertyValue("--nle-accent").trim() || "rgba(77, 159, 255, 0.95)";
    ctx.beginPath();
    ctx.arc(MAGNIFIER_SIZE / 2, MAGNIFIER_SIZE / 2, 3, 0, Math.PI * 2);
    ctx.stroke();
  }

  function startMove(event: ReactPointerEvent<Element>, target: TrackBoxEditorTarget) {
    if (!target.point) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    onSelectTarget(target.id);
    dragRef.current = { targetId: target.id, pointerId: event.pointerId, startPoint: target.point, startPercent: percentFromEvent(event) };
    setMagnifierAt(target.point);
    drawMagnifier(target.point);
  }

  function startFixMove(event: ReactPointerEvent<Element>) {
    if (!fixMarker || !onMoveFixMarker) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    fixDragRef.current = { pointerId: event.pointerId, startPoint: fixMarker.point, startPercent: percentFromEvent(event) };
    setMagnifierAt(fixMarker.point);
    drawMagnifier(fixMarker.point);
  }

  function handlePointerMove(event: ReactPointerEvent) {
    const drag = dragRef.current;
    if (drag && event.pointerId === drag.pointerId) {
      event.preventDefault();
      const current = percentFromEvent(event);
      const dx = current.x - drag.startPercent.x;
      const dy = current.y - drag.startPercent.y;
      const nextPoint = { x: clamp(drag.startPoint.x + dx, 0, 100), y: clamp(drag.startPoint.y + dy, 0, 100) };
      onChangePoint(drag.targetId, nextPoint);
      setMagnifierAt(nextPoint);
      drawMagnifier(nextPoint);
      scoreTrackability(drag.targetId, nextPoint);
      return;
    }
    const fixDrag = fixDragRef.current;
    if (fixDrag && event.pointerId === fixDrag.pointerId && onMoveFixMarker) {
      event.preventDefault();
      const current = percentFromEvent(event);
      const dx = current.x - fixDrag.startPercent.x;
      const dy = current.y - fixDrag.startPercent.y;
      const nextPoint = { x: clamp(fixDrag.startPoint.x + dx, 0, 100), y: clamp(fixDrag.startPoint.y + dy, 0, 100) };
      onMoveFixMarker(nextPoint);
      setMagnifierAt(nextPoint);
      drawMagnifier(nextPoint);
    }
  }

  function handlePointerUp(event: ReactPointerEvent) {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = undefined;
      setMagnifierAt(undefined);
      return;
    }
    if (fixDragRef.current?.pointerId === event.pointerId) {
      fixDragRef.current = undefined;
      setMagnifierAt(undefined);
    }
  }

  function handleFrameClick(event: ReactPointerEvent) {
    if (dragRef.current) {
      return;
    }
    const point = percentFromEvent(event);
    onChangePoint(selectedTargetId, point);
    scoreTrackability(selectedTargetId, point);
  }

  return (
    <div className="track-box-editor-frame" ref={frameRef} style={{ aspectRatio }}>
      <video crossOrigin="anonymous" muted playsInline preload="auto" ref={videoRef} src={videoUrl} />
      {/* Dedicated hit layer for placing a point on empty space. It sits BELOW the
          text ghost and the SVG markers so those paint on top and stay legible, while
          the SVG overlay itself is pointer-events:none (its interactive children opt
          back in) - this is what keeps the tracker point/label/confidence clearly
          above the draggable text pill. */}
      <div className="track-box-editor-hitlayer" onPointerDown={handleFrameClick} />
      <svg
        className="track-box-editor-overlay"
        preserveAspectRatio="none"
        viewBox="0 0 100 100"
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        {targets.map((target) => (
          <g key={target.id}>
            {target.trackingPath ? <TrackPathOverlay trackingPath={target.trackingPath} /> : null}
            {target.trackingPath ? <TrackPlayhead trackingPath={target.trackingPath} timeSeconds={scrubTimeSeconds} /> : null}
            {target.point ? (
              <PointMarker
                isActive={target.id === selectedTargetId}
                point={target.point}
                target={target}
                trackability={trackability[target.id]}
                onSelectTarget={onSelectTarget}
                onStartMove={startMove}
              />
            ) : target.auto ? (
              <g
                className={`track-box-auto-marker${target.id === selectedTargetId ? " is-active" : ""}`}
                onClick={() => onSelectTarget(target.id)}
              >
                <circle cx={50} cy={50} r={6} vectorEffect="non-scaling-stroke" />
                <line vectorEffect="non-scaling-stroke" x1={44} x2={56} y1={50} y2={50} />
                <line vectorEffect="non-scaling-stroke" x1={50} x2={50} y1={44} y2={56} />
                <text x={50} y={60}>
                  {target.label} (auto-detect on Track)
                </text>
              </g>
            ) : null}
          </g>
        ))}
        {fixMarker ? <FixMarker point={fixMarker.point} onStartMove={startFixMove} /> : null}
      </svg>
      {magnifierAt ? (
        <div
          className="track-magnifier"
          style={{
            left: `${clamp(magnifierAt.x, 18, 82)}%`,
            top: `${clamp(magnifierAt.y, 18, 82)}%`,
            transform: magnifierAt.y < 30 ? "translate(-50%, 28px)" : "translate(-50%, calc(-100% - 28px))"
          }}
        >
          <canvas height={MAGNIFIER_SIZE} ref={magnifierCanvasRef} width={MAGNIFIER_SIZE} />
        </div>
      ) : null}
      {textPlacement ? (
        <div
          className="track-text-ghost"
          style={{ left: `${textPlacement.point.x}%`, top: `${textPlacement.point.y}%` }}
          onPointerDown={startTextMove}
          onPointerMove={handleTextMove}
          onPointerUp={handleTextUp}
          onPointerCancel={handleTextUp}
        >
          {textPlacement.text}
        </div>
      ) : null}
    </div>
  );
}

function PointMarker({
  point,
  target,
  isActive,
  trackability,
  onSelectTarget,
  onStartMove
}: {
  point: TrackPointPercent;
  target: TrackBoxEditorTarget;
  isActive: boolean;
  /** Indicative "will this point track well" score, 0..1, or undefined while it hasn't been scored yet. */
  trackability: number | undefined;
  onSelectTarget: (id: string) => void;
  onStartMove: (event: ReactPointerEvent<Element>, target: TrackBoxEditorTarget) => void;
}) {
  const handleDx = point.x + HANDLE_OFFSET > 96 ? -HANDLE_OFFSET : HANDLE_OFFSET;
  const handleDy = point.y - HANDLE_OFFSET < 4 ? HANDLE_OFFSET : -HANDLE_OFFSET;
  const handleX = point.x + handleDx;
  const handleY = point.y + handleDy;
  const trackabilityTier = trackability === undefined ? undefined : trackabilityClass(trackability);

  return (
    <g className={`track-point-marker${isActive ? " is-active" : ""}`}>
      <line className="track-point-leader" vectorEffect="non-scaling-stroke" x1={point.x} y1={point.y} x2={handleX} y2={handleY} />
      <g className="track-point-crosshair" onClick={() => onSelectTarget(target.id)}>
        <circle cx={point.x} cy={point.y} r={1.4} vectorEffect="non-scaling-stroke" />
        <line vectorEffect="non-scaling-stroke" x1={point.x - 2.4} y1={point.y} x2={point.x + 2.4} y2={point.y} />
        <line vectorEffect="non-scaling-stroke" x1={point.x} y1={point.y - 2.4} x2={point.x} y2={point.y + 2.4} />
      </g>
      <circle className="track-point-handle" cx={handleX} cy={handleY} r={1.7} vectorEffect="non-scaling-stroke" onPointerDown={(event) => onStartMove(event, target)} />
      <text className="track-point-label" x={point.x} y={Math.max(3, point.y - 4)}>
        {target.label}
      </text>
      {trackabilityTier ? (
        <g className={`track-point-trackability ${trackabilityTier}`}>
          <rect x={point.x + 2.6} y={point.y - 1.6} width={9.5} height={3.2} rx={1} vectorEffect="non-scaling-stroke" />
          <text x={point.x + 7.35} y={point.y + 0.65}>
            {Math.round(trackability! * 100)}%
          </text>
          {trackabilityTier === "is-untrackable" ? (
            <text className="track-point-trackability-hint" x={point.x + 2.6} y={point.y + 4.6}>
              Flat area - pick a textured spot
            </text>
          ) : null}
        </g>
      ) : null}
    </g>
  );
}

/** Mirrors apps/web/src/tools/local-tracking.ts's MIN_CONFIDENCE / typical loss thresholds, so the live indicator's "good/risky/bad" bands match what the real tracker would actually do with this point. */
function trackabilityClass(score: number) {
  if (score >= 0.55) return "is-trackable";
  if (score >= 0.25) return "is-risky";
  return "is-untrackable";
}

/** The draggable "re-track from here" marker - distinct (warm) styling so it reads as a correction point, not a tracker. */
function FixMarker({ point, onStartMove }: { point: TrackPointPercent; onStartMove: (event: ReactPointerEvent<Element>) => void }) {
  return (
    <g className="track-fix-marker">
      <circle className="track-fix-marker-ring" cx={point.x} cy={point.y} r={3.4} vectorEffect="non-scaling-stroke" />
      <line vectorEffect="non-scaling-stroke" x1={point.x - 4} y1={point.y} x2={point.x + 4} y2={point.y} />
      <line vectorEffect="non-scaling-stroke" x1={point.x} y1={point.y - 4} x2={point.x} y2={point.y + 4} />
      <circle className="track-fix-marker-grab" cx={point.x} cy={point.y} r={2} vectorEffect="non-scaling-stroke" onPointerDown={onStartMove} />
      <text className="track-fix-marker-label" x={point.x} y={Math.min(98, point.y + 6.5)}>
        Re-track point
      </text>
    </g>
  );
}

/** Small dot at the tracked position for the currently scrubbed frame, so the user can scrub and see exactly where the tracker sits each frame (and spot where it drifts off the subject). */
function TrackPlayhead({ trackingPath, timeSeconds }: { trackingPath: TrackingPathArtifactData; timeSeconds: number }) {
  const position = interpolateTrackPosition(trackingPath.points, timeSeconds);
  if (!position) {
    return null;
  }
  return <circle className="track-playhead" cx={position.x} cy={position.y} r={1.9} vectorEffect="non-scaling-stroke" />;
}

function interpolateTrackPosition(points: TrackingPathArtifactData["points"], timeSeconds: number): TrackPointPercent | undefined {
  if (!points.length) {
    return undefined;
  }
  const first = points[0]!;
  if (timeSeconds <= first.timeSeconds) {
    return { x: first.position.x, y: first.position.y };
  }
  const last = points[points.length - 1]!;
  if (timeSeconds >= last.timeSeconds) {
    return { x: last.position.x, y: last.position.y };
  }
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (timeSeconds <= b.timeSeconds) {
      const span = b.timeSeconds - a.timeSeconds || 1;
      const f = (timeSeconds - a.timeSeconds) / span;
      return { x: a.position.x + (b.position.x - a.position.x) * f, y: a.position.y + (b.position.y - a.position.y) * f };
    }
  }
  return { x: last.position.x, y: last.position.y };
}

function TrackPathOverlay({ trackingPath }: { trackingPath: TrackingPathArtifactData }) {
  const points = trackingPath.points;
  if (!points.length) {
    return null;
  }
  const pathPoints = points.map((point) => `${point.position.x},${point.position.y}`).join(" ");
  return (
    <>
      <polyline className="track-box-path" points={pathPoints} vectorEffect="non-scaling-stroke" />
      {points.map((point, index) => (
        <circle
          className={`track-box-point ${confidenceClass(point.confidence)}`}
          cx={point.position.x}
          cy={point.position.y}
          key={`${point.timeSeconds}_${index}`}
          r={0.8}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </>
  );
}

function confidenceClass(confidence: number) {
  if (confidence >= 0.7) return "is-confident";
  if (confidence >= 0.4) return "is-uncertain";
  return "is-lost";
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
