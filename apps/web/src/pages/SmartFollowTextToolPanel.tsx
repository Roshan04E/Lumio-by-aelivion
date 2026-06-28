import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Info, Pause, Play, PaintBucket, Upload, WandSparkles } from "lucide-react";
import {
  applySmartFollowTextComposition,
  applyStabilizationComposition,
  createDefaultComposition,
  type ProjectGraph,
  type SourceAsset,
  type TimelineComposition,
  type ToolCapabilityDefinition,
  type TrackingPathArtifactData
} from "@reelforge/shared";
import { AiActivityIndicator } from "../components/AiActivityIndicator";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { ColorControl } from "../components/ColorControl";
import { CreditBadge } from "../components/CreditBadge";
import { TrackBoxEditor } from "../components/TrackBoxEditor";
import { VideoPreview } from "../components/VideoPreview";
import { ThemedSelect } from "../editor/inspector/controls/ThemedSelect";
import { addEffect, createProject, patchProject } from "../lib/api";
import { defaultColorPalette, extractPaletteFromAsset } from "../lib/colorPalette";
import { averageTrackConfidence, trackPositionAtTime, type SavedTrack } from "../lib/trackLibrary";
import {
  AUTO_TARGET_ID,
  trackTargetsPlanar3D,
  type NamedTrackingResult,
  type TrackPointPercent,
  type TrackQuality,
  type TrackTargetInput
} from "../tools/local-tracking";
import { refineTrackingPath } from "../tools/track-cleanup";
import { resolveToolMediaUrl } from "../tools/tool-media";

interface FollowTarget {
  id: string;
  label: string;
  /** True while this target should be (re-)seeded by AI subject detection. Cleared the moment the user drags its point - a manual placement always wins over auto-detect. */
  auto: boolean;
  /** Undefined until manually placed or tracked at least once - no fake pre-positioned point for the auto target. */
  point?: TrackPointPercent | undefined;
  /** Per-target text override; falls back to the panel's shared follow text when blank. */
  customText?: string | undefined;
  trackingPath?: TrackingPathArtifactData | undefined;
}

let nextManualTargetId = 1;

function clampPercent(value: number) {
  return Math.min(100, Math.max(0, value));
}

/**
 * Turns a base composition into the Smart Follow Text result - the exact transform
 * logic Apply uses. Shared by the real Apply path and the in-tool result preview so
 * the preview can never drift from what actually gets applied.
 */
function buildFollowResultComposition(
  baseComposition: TimelineComposition,
  input: {
    asset: { id: string } | undefined;
    mode: "follow" | "stabilize";
    targets: FollowTarget[];
    text: string;
    textColor: string;
    smoothing: number;
    depth: number;
    offset: { x: number; y: number };
    stabilizeStrength: number;
    selectedTargetId: string;
  }
): { composition: TimelineComposition; primaryTrackingPath: TrackingPathArtifactData } | undefined {
  const trackedTargets = input.targets.filter((target): target is FollowTarget & { trackingPath: TrackingPathArtifactData } =>
    Boolean(target.trackingPath)
  );
  const primaryTrackingPath = trackedTargets.find((target) => target.id === input.selectedTargetId)?.trackingPath ?? trackedTargets[0]?.trackingPath;
  if (!primaryTrackingPath) {
    return undefined;
  }
  const composition =
    input.mode === "stabilize"
      ? applyStabilizationComposition(baseComposition, {
          trackingPath: primaryTrackingPath,
          smoothing: input.smoothing,
          strength: input.stabilizeStrength,
          sourceAssetId: input.asset?.id
        })
      : trackedTargets.reduce(
          (acc, target) =>
            applySmartFollowTextComposition(acc, {
              text: target.customText?.trim() || input.text,
              textColor: input.textColor,
              trackingPath: target.trackingPath,
              smoothing: input.smoothing,
              depthStrength: input.depth,
              key: target.id,
              offset: input.offset
              // Position-only point tracker: omit `channels`, the apply function already
              // skips scale/rotation/perspective whenever the track isn't 3D (it never is here).
            }),
          baseComposition
        );
  return { composition, primaryTrackingPath };
}

/**
 * Saves every tracked target as a named entry in the project's track library
 * (`editableFields.trackLibrary`), so the exact same tracked motion can later be
 * attached to any OTHER layer - including ones added after this Apply - via the
 * existing "Attach track" control in the editor's layer inspector
 * (`EditorPage.handleAttachSavedTrack`), with no re-tracking. Re-applying with the
 * same target ids overwrites the matching library entry instead of duplicating it.
 */
function buildSavedTracksFromTargets(
  targets: FollowTarget[],
  toolName: string,
  options?: { idFor?: (target: FollowTarget) => string; labelFor?: (target: FollowTarget) => string }
): SavedTrack[] {
  return targets
    .filter((target): target is FollowTarget & { trackingPath: TrackingPathArtifactData } => Boolean(target.trackingPath))
    .map((target) => ({
      id: options?.idFor ? options.idFor(target) : `smart_follow_${target.id}`,
      label: options?.labelFor ? options.labelFor(target) : target.customText?.trim() || `${toolName}: ${target.label}`,
      trackingPath: target.trackingPath
    }));
}

export interface SmartFollowTextToolPanelProps {
  tool: ToolCapabilityDefinition;
  assets: SourceAsset[];
  selectedAssetId: string;
  onSelectAsset: (id: string) => void;
  onUploadAsset: (file: File | null) => void | Promise<void>;
  /**
   * Locks the workspace to this asset and hides the upload/select UI - used by the
   * editor's Effects-tab modal, where the clip is already the selected timeline layer's
   * media and re-picking would be confusing.
   */
  preselectedAsset?: SourceAsset | undefined;
  /**
   * When set, Apply merges the tracked result directly into this live composition (the
   * editor's real composition) and calls `onApplyToComposition` instead of creating a new
   * project and navigating - the editor modal path. Omit both for the standalone tool page,
   * which creates a fresh project on Apply.
   */
  liveComposition?: TimelineComposition | undefined;
  /**
   * `savedTracks` carries every tracked target as a `SavedTrack` for the caller to merge
   * into the project's `editableFields.trackLibrary`, so the same tracked motion can be
   * attached to any other layer afterward via the editor's existing "Attach track" control.
   */
  onApplyToComposition?:
    | ((nextComposition: TimelineComposition, primaryTrackingPath: TrackingPathArtifactData, savedTracks: SavedTrack[]) => void)
    | undefined;
  /** Compact chrome (no page header/back link) for the modal context. */
  compact?: boolean | undefined;
  /**
   * Reuses this same full workspace (auto-select, add tracker, track all/re-track,
   * clean & smooth, live preview) as a pure "Track a new point" tool: hides the
   * follow-text Style tab, and Apply just saves the tracked target(s) into
   * editableFields.trackLibrary (via `onApplyToComposition`'s savedTracks arg) without
   * inserting any follow-text/stabilize layers into the composition. Lets the editor's
   * "Track a new point..." button offer the exact same tracking controls Smart Follow
   * Text has, instead of the older single-target TrackEffectModal.
   */
  trackOnly?: boolean | undefined;
  /** When set in trackOnly mode, seeds the workspace with this already-saved track for editing/retracking instead of starting fresh. */
  initialTrack?: SavedTrack | undefined;
}

/**
 * Full Smart 3D Follow Text workspace: auto-select/add trackers, drag track points on the
 * real video frame, track/re-track/clean, follow-text vs stabilize mode, and a real result
 * preview using the same renderer as the editor. Self-contained (owns all of its state) so
 * it can be reused unmodified both as the `/tools/smart-3d-follow-text` page and as a large
 * modal from the editor's Effects tab (see `EditorPage.tsx`), where the only difference is
 * the asset is preselected and Apply targets the live composition instead of a new project.
 */
export function SmartFollowTextToolPanel({
  tool,
  assets,
  selectedAssetId,
  onSelectAsset,
  onUploadAsset,
  preselectedAsset,
  liveComposition,
  onApplyToComposition,
  compact,
  trackOnly,
  initialTrack
}: SmartFollowTextToolPanelProps) {
  const navigate = useNavigate();
  const selectedAsset = preselectedAsset ?? assets.find((asset) => asset.id === selectedAssetId);

  const [followText, setFollowText] = useState("TRACKED");
  const [followTextColor, setFollowTextColor] = useState("#4D9FFF");
  const [followSmoothing, setFollowSmoothing] = useState(0.45);
  const [followDepth, setFollowDepth] = useState(0.65);
  const [followQuality, setFollowQuality] = useState<TrackQuality>("fast");
  const [followMode, setFollowMode] = useState<"follow" | "stabilize">("follow");
  const [followStabilizeStrength, setFollowStabilizeStrength] = useState(0.85);
  // Placement of the text relative to the tracked point, in percent of frame. {0,0} = on the point; drag the text ghost in the preview to change it.
  const [followOffset, setFollowOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [trackCleanStatus, setTrackCleanStatus] = useState("");
  const [isCleaningTrack, setIsCleaningTrack] = useState(false);
  const cancelledCleanRef = useRef(false);
  // Snapshot of each target's trackingPath right before the most recent Clean & smooth
  // run, so the result preview can show a Before/After comparison of that run's effect.
  const [followBeforeClean, setFollowBeforeClean] = useState<Record<string, TrackingPathArtifactData> | null>(null);
  const [followPreviewCompare, setFollowPreviewCompare] = useState<"after" | "before">("after");
  const [followPreviewView, setFollowPreviewView] = useState<"tracker" | "result">("tracker");
  // Scrub position (seconds) in the Tracker preview, used to find the frame where the
  // track drifts and to seed a fix marker for the segmented re-track flow.
  const [trackScrubTime, setTrackScrubTime] = useState(0);
  const [fixMarker, setFixMarker] = useState<{ targetId: string; timeSeconds: number; point: { x: number; y: number } } | null>(null);
  const [isRetracking, setIsRetracking] = useState(false);
  const [retrackStatus, setRetrackStatus] = useState("");
  const cancelledRetrackRef = useRef(false);
  const [isTrackerPlaying, setIsTrackerPlaying] = useState(false);
  const [followTargets, setFollowTargets] = useState<FollowTarget[]>(() => {
    if (initialTrack) {
      const firstPosition = initialTrack.trackingPath.points[0]?.position;
      return [
        {
          id: initialTrack.id,
          label: initialTrack.label,
          auto: false,
          point: firstPosition ? { x: firstPosition.x, y: firstPosition.y } : undefined,
          trackingPath: initialTrack.trackingPath
        }
      ];
    }
    if (trackOnly) {
      return [{ id: AUTO_TARGET_ID, label: "Subject", auto: true }];
    }
    return [];
  });
  const [followSelectedTargetId, setFollowSelectedTargetId] = useState(initialTrack?.id ?? AUTO_TARGET_ID);
  const [trackingStatus, setTrackingStatus] = useState("");
  const [trackingRunId, setTrackingRunId] = useState(0);
  const cancelledTrackingRef = useRef(false);
  const activeTrackingRunIdRef = useRef(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setIsTrackerPlaying(false);
    setTrackScrubTime(0);
    setFixMarker(null);
    setRetrackStatus("");
  }, [selectedAsset?.id]);

  const hasAnyFollowTrack = followTargets.some((target) => target.trackingPath);
  // Reference point the follow text is placed relative to: the selected target's
  // point (or its tracked first frame). The text ghost sits at this point + offset;
  // dragging it sets the offset. Undefined until a target has a known point.
  const followGhostReferencePoint = (() => {
    const selected = followTargets.find((target) => target.id === followSelectedTargetId) ?? followTargets[0];
    return selected?.point ?? selected?.trackingPath?.points[0]?.position;
  })();
  const followTextGhost =
    followMode === "follow" && followGhostReferencePoint
      ? {
          point: {
            x: clampPercent(followGhostReferencePoint.x + followOffset.x),
            y: clampPercent(followGhostReferencePoint.y + followOffset.y)
          },
          text: followText.trim() || "TRACKED"
        }
      : undefined;

  // Targets used by the result preview: identical to the live ones, except when the
  // user picked "Before" - then each target's trackingPath is swapped back to its
  // pre-clean snapshot so the player visibly shows what Clean & smooth changed.
  const followPreviewTargets = useMemo(() => {
    if (followPreviewCompare !== "before" || !followBeforeClean) {
      return followTargets;
    }
    return followTargets.map((target) => {
      const before = followBeforeClean[target.id];
      return before ? { ...target, trackingPath: before } : target;
    });
  }, [followBeforeClean, followPreviewCompare, followTargets]);

  // The composition the result preview (and, in the editor-modal path, Apply itself)
  // builds onto: the real live composition when embedded in the editor, otherwise a
  // throwaway one shaped like the source clip - good enough for a standalone preview
  // player, never used as the actual Apply target on the tool page (that creates a
  // fresh project + real composition instead, see handleApply).
  const previewBaseComposition = useMemo(() => {
    if (liveComposition) {
      return liveComposition;
    }
    if (!selectedAsset) {
      return undefined;
    }
    const portrait = createDefaultComposition({
      id: `follow_preview_${selectedAsset.id}`,
      name: "Smart Follow Text preview",
      durationSeconds: selectedAsset.durationSeconds,
      assetId: selectedAsset.id
    });
    return { ...portrait, width: selectedAsset.width || portrait.width, height: selectedAsset.height || portrait.height };
  }, [liveComposition, selectedAsset]);

  const followPreviewComposition = useMemo(() => {
    if (!selectedAsset || !previewBaseComposition) {
      return undefined;
    }
    return buildFollowResultComposition(previewBaseComposition, {
      asset: selectedAsset,
      mode: followMode,
      targets: followPreviewTargets,
      text: followText,
      textColor: followTextColor,
      smoothing: followSmoothing,
      depth: followDepth,
      offset: followOffset,
      stabilizeStrength: followStabilizeStrength,
      selectedTargetId: followSelectedTargetId
    })?.composition;
  }, [
    selectedAsset,
    previewBaseComposition,
    followMode,
    followPreviewTargets,
    followText,
    followTextColor,
    followSmoothing,
    followDepth,
    followOffset,
    followStabilizeStrength,
    followSelectedTargetId
  ]);

  function addManualFollowTarget() {
    const id = `manual_${nextManualTargetId}`;
    nextManualTargetId += 1;
    setFollowTargets((current) => {
      const offset = current.length * 6;
      const point = { x: 46 + offset, y: 46 + offset };
      return [...current, { id, label: `Tracker ${current.length + 1}`, auto: false, point }];
    });
    setFollowSelectedTargetId(id);
  }

  function addAutoFollowTarget() {
    // AUTO_TARGET_ID is a singleton - only one AI auto-detected target at a time.
    setFollowTargets((current) => (current.some((target) => target.id === AUTO_TARGET_ID) ? current : [...current, { id: AUTO_TARGET_ID, label: "Subject", auto: true }]));
    setFollowSelectedTargetId(AUTO_TARGET_ID);
  }

  function removeFollowTarget(id: string) {
    setFollowTargets((current) => current.filter((target) => target.id !== id));
    setFollowSelectedTargetId((current) => (current === id ? AUTO_TARGET_ID : current));
  }

  function updateFollowTargetPoint(id: string, point: TrackPointPercent) {
    // A manual drag always overrides auto-detect - otherwise re-tracking would
    // silently discard the user's correction and re-run AI detection instead.
    setFollowTargets((current) => current.map((target) => (target.id === id ? { ...target, point, auto: false } : target)));
  }

  function resetFollowTargetToAuto(id: string) {
    setFollowTargets((current) =>
      current.map((target) => (target.id === id ? { ...target, auto: true, point: undefined, trackingPath: undefined } : target))
    );
  }

  function updateFollowTargetText(id: string, customText: string) {
    setFollowTargets((current) => current.map((target) => (target.id === id ? { ...target, customText } : target)));
  }

  /** Renames a target's own label - used by the trackOnly "Track name" field, since a saved track's name in the library comes from `label`, not the follow-text override. */
  function renameFollowTarget(id: string, label: string) {
    setFollowTargets((current) => current.map((target) => (target.id === id ? { ...target, label } : target)));
  }

  /**
   * Clones an already-tracked target's motion path onto a brand-new target, with no
   * re-tracking. Lets the same tracked motion drive a second piece of text (or, once
   * non-text follow layers exist, a graphic) with its own label/text override, since
   * `buildFollowResultComposition` already applies one follow-text layer per target.
   */
  function duplicateFollowTarget(id: string) {
    const source = followTargets.find((target) => target.id === id);
    if (!source?.trackingPath) {
      return;
    }
    const newId = `manual_${nextManualTargetId}`;
    nextManualTargetId += 1;
    const clone: FollowTarget = {
      id: newId,
      label: `${source.label} copy`,
      auto: false,
      point: source.point,
      trackingPath: source.trackingPath
    };
    setFollowTargets((current) => [...current, clone]);
    setFollowSelectedTargetId(newId);
  }

  async function handleCleanTracks() {
    const tracked = followTargets.filter((target) => target.trackingPath);
    if (!tracked.length) {
      setTrackCleanStatus("Track a target first, then clean it.");
      return;
    }
    if (!selectedAsset?.fileUrl) {
      setTrackCleanStatus("Select the tracked video first.");
      return;
    }

    const beforeSnapshot: Record<string, TrackingPathArtifactData> = {};
    for (const target of tracked) {
      if (target.trackingPath) {
        beforeSnapshot[target.id] = target.trackingPath;
      }
    }
    setFollowBeforeClean(beforeSnapshot);
    setFollowPreviewCompare("after");
    setFollowPreviewView("result");

    setIsCleaningTrack(true);
    cancelledCleanRef.current = false;
    let correctedFrames = 0;
    let offSubjectFrames = 0;
    let anyStraightened = false;
    let usedGrounding = false;
    try {
      // Process targets sequentially so progress reads cleanly and we don't
      // contend for the video decoder. Each refine re-opens the real frames.
      const refined = new Map<string, TrackingPathArtifactData>();
      for (const target of tracked) {
        if (!target.trackingPath) {
          continue;
        }
        const label = tracked.length > 1 ? `${target.label}: ` : "";
        const result = await refineTrackingPath({
          videoUrl: selectedAsset.fileUrl,
          durationSeconds: selectedAsset.durationSeconds,
          width: selectedAsset.width || 720,
          height: selectedAsset.height || 1280,
          trackingPath: target.trackingPath,
          smoothing: followSmoothing,
          onProgress: (message) => {
            if (!cancelledCleanRef.current) {
              setTrackCleanStatus(`${label}${message}`);
            }
          },
          isCancelled: () => cancelledCleanRef.current
        });
        refined.set(target.id, result.trackingPath);
        correctedFrames += result.diagnostics.correctedFrames;
        offSubjectFrames += result.diagnostics.offSubjectFrames;
        anyStraightened = anyStraightened || result.diagnostics.straightened;
        usedGrounding = usedGrounding || result.diagnostics.usedSubjectGrounding;
      }

      setFollowTargets((current) =>
        current.map((target) => {
          const path = refined.get(target.id);
          return path ? { ...target, trackingPath: path } : target;
        })
      );

      const parts: string[] = [];
      parts.push(anyStraightened ? "straightened the near-straight motion" : "smoothed against the real frames");
      if (correctedFrames) {
        parts.push(`corrected ${correctedFrames} unreliable frame${correctedFrames > 1 ? "s" : ""}`);
      }
      if (usedGrounding && offSubjectFrames) {
        parts.push(`pulled ${offSubjectFrames} off-subject frame${offSubjectFrames > 1 ? "s" : ""} back onto the subject`);
      }
      if (!correctedFrames && (!usedGrounding || !offSubjectFrames)) {
        parts.push("track was already clean");
      }
      setTrackCleanStatus(`Verified ${tracked.length} track${tracked.length > 1 ? "s" : ""}: ${parts.join(", ")}.`);
    } catch (error) {
      if (cancelledCleanRef.current) {
        setTrackCleanStatus("Cleanup cancelled.");
      } else {
        setTrackCleanStatus(error instanceof Error ? `Cleanup failed: ${error.message}` : "Cleanup failed.");
      }
    } finally {
      setIsCleaningTrack(false);
    }
  }

  async function handleTrackAll() {
    if (!selectedAsset?.fileUrl) {
      setTrackingStatus("Upload or select a video first.");
      return;
    }

    const trackableTargets = followTargets.filter((target) => target.auto || target.point);
    if (!trackableTargets.length) {
      setTrackingStatus("Auto select a subject or add a tracker first.");
      return;
    }

    setBusy(true);
    cancelledTrackingRef.current = false;
    const runId = Date.now();
    activeTrackingRunIdRef.current = runId;
    setTrackingRunId(runId);
    setTrackingStatus(`Starting local track (${followQuality}, runs in your browser)...`);
    // A fresh raw track makes any earlier Clean & smooth comparison and fix marker stale.
    setFollowBeforeClean(null);
    setFollowPreviewCompare("after");
    setFixMarker(null);
    setIsTrackerPlaying(false);
    try {
      const targetInputs: TrackTargetInput[] = trackableTargets.map((target) => ({
        id: target.id,
        label: target.label,
        auto: target.auto,
        point: target.auto ? undefined : target.point
      }));
      const results = await trackTargetsPlanar3D({
        videoUrl: selectedAsset.fileUrl,
        durationSeconds: selectedAsset.durationSeconds,
        width: selectedAsset.width || 720,
        height: selectedAsset.height || 1280,
        targets: targetInputs,
        quality: followQuality,
        onProgress: (message) => {
          if (!cancelledTrackingRef.current && activeTrackingRunIdRef.current === runId) {
            setTrackingStatus(message);
          }
        },
        isCancelled: () => cancelledTrackingRef.current
      });
      if (cancelledTrackingRef.current || activeTrackingRunIdRef.current !== runId) {
        setTrackingStatus("Tracking cancelled.");
        return;
      }

      const resultsById = new Map<string, NamedTrackingResult>(results.map((result) => [result.id, result]));
      setFollowTargets((current) =>
        current.map((target) => {
          const result = resultsById.get(target.id);
          if (!result) {
            return target;
          }
          const firstPosition = result.trackingPath.points[0]?.position;
          return {
            ...target,
            trackingPath: result.trackingPath,
            point: target.point ?? (firstPosition ? { x: firstPosition.x, y: firstPosition.y } : target.point)
          };
        })
      );
      setTrackingStatus(`Track ready: ${results.length} target${results.length > 1 ? "s" : ""} tracked locally.`);
    } catch (error) {
      if (cancelledTrackingRef.current || activeTrackingRunIdRef.current !== runId) {
        return;
      }
      setTrackingStatus(error instanceof Error ? error.message : "3D tracking failed.");
    } finally {
      if (activeTrackingRunIdRef.current === runId) {
        activeTrackingRunIdRef.current = 0;
        setTrackingRunId(0);
        setBusy(false);
      }
    }
  }

  function handleDropFixMarker() {
    const target = followTargets.find((item) => item.id === followSelectedTargetId) ?? followTargets.find((item) => item.trackingPath);
    if (!target?.trackingPath) {
      setTrackingStatus("Track a target first, then scrub to the frame where it drifts.");
      return;
    }
    setIsTrackerPlaying(false);
    const markerTime = Math.max(0, Math.min(selectedAsset?.durationSeconds ?? trackScrubTime, trackScrubTime));
    const point = trackPositionAtTime(target.trackingPath, markerTime) ?? target.point ?? { x: 50, y: 50 };
    setFixMarker({ targetId: target.id, timeSeconds: markerTime, point });
    setRetrackStatus("");
    setFollowSelectedTargetId(target.id);
  }

  async function handleRetrackFromMarker() {
    if (!fixMarker || !selectedAsset?.fileUrl) {
      return;
    }
    const target = followTargets.find((item) => item.id === fixMarker.targetId);
    if (!target?.trackingPath) {
      return;
    }
    const markerTime = fixMarker.timeSeconds;
    setIsTrackerPlaying(false);
    setIsRetracking(true);
    cancelledRetrackRef.current = false;
    setRetrackStatus(`Starting re-track from ${markerTime.toFixed(2)}s (${followQuality}, runs in your browser)...`);
    try {
      const results = await trackTargetsPlanar3D({
        videoUrl: selectedAsset.fileUrl,
        durationSeconds: selectedAsset.durationSeconds,
        width: selectedAsset.width || 720,
        height: selectedAsset.height || 1280,
        startTimeSeconds: markerTime,
        targets: [{ id: target.id, label: target.label, auto: false, point: fixMarker.point }],
        quality: followQuality,
        onProgress: (message) => {
          if (!cancelledRetrackRef.current) {
            setRetrackStatus(message);
          }
        },
        isCancelled: () => cancelledRetrackRef.current
      });
      const tail = results[0]?.trackingPath;
      if (!tail) {
        setRetrackStatus("Re-track produced no frames.");
        return;
      }
      // Keep the good earlier portion, replace everything from the marker onward.
      const head = target.trackingPath.points.filter((point) => point.timeSeconds < markerTime - 1e-3);
      const merged = [...head, ...tail.points];
      setFollowTargets((current) =>
        current.map((item) => (item.id === target.id && item.trackingPath ? { ...item, trackingPath: { ...item.trackingPath, points: merged } } : item))
      );
      // The merged path supersedes any earlier Clean & smooth comparison.
      setFollowBeforeClean(null);
      setTrackCleanStatus("");
      setFixMarker(null);
      setRetrackStatus(`Re-tracked from ${markerTime.toFixed(2)}s - kept ${head.length} earlier frame${head.length === 1 ? "" : "s"}, re-tracked ${tail.points.length}.`);
    } catch (error) {
      if (!cancelledRetrackRef.current) {
        setRetrackStatus(error instanceof Error ? `Re-track failed: ${error.message}` : "Re-track failed.");
      }
    } finally {
      setIsRetracking(false);
    }
  }

  async function handleApply() {
    if (!selectedAsset) {
      return;
    }

    // trackOnly path: don't insert any follow-text/stabilize layers - just save the
    // tracked target(s) into the project's track library so they can be attached to
    // any layer afterward via the editor's "Attach track" control.
    if (trackOnly && onApplyToComposition && liveComposition) {
      const primaryTrackingPath = followTargets.find((target) => target.id === followSelectedTargetId)?.trackingPath ?? followTargets.find((target) => target.trackingPath)?.trackingPath;
      if (!primaryTrackingPath) {
        return;
      }
      const savedTracks = buildSavedTracksFromTargets(followTargets, tool.name, {
        idFor: (target) => target.id,
        labelFor: (target) => target.label.trim() || "Tracker"
      });
      onApplyToComposition(liveComposition, primaryTrackingPath, savedTracks);
      return;
    }

    // Editor modal path: merge the result straight into the live composition, no new project.
    if (onApplyToComposition && liveComposition) {
      const built = buildFollowResultComposition(liveComposition, {
        asset: selectedAsset,
        mode: followMode,
        targets: followTargets,
        text: followText,
        textColor: followTextColor,
        smoothing: followSmoothing,
        depth: followDepth,
        offset: followOffset,
        stabilizeStrength: followStabilizeStrength,
        selectedTargetId: followSelectedTargetId
      });
      if (built) {
        onApplyToComposition(built.composition, built.primaryTrackingPath, buildSavedTracksFromTargets(followTargets, tool.name));
      }
      return;
    }

    // Standalone tool page path: create a fresh project around the result.
    setBusy(true);
    try {
      const project = await createProject({ title: `${tool.name} Tool Draft`, sourceAssetId: selectedAsset.id });
      await addEffect(project.id, tool.moduleType);
      const composition = project.projectGraph.composition;
      const built = composition
        ? buildFollowResultComposition(composition, {
            asset: selectedAsset,
            mode: followMode,
            targets: followTargets,
            text: followText,
            textColor: followTextColor,
            smoothing: followSmoothing,
            depth: followDepth,
            offset: followOffset,
            stabilizeStrength: followStabilizeStrength,
            selectedTargetId: followSelectedTargetId
          })
        : undefined;
      if (built) {
        const { composition: nextComposition, primaryTrackingPath } = built;
        const existingTrackLibrary = Array.isArray(project.projectGraph.editableFields.trackLibrary)
          ? (project.projectGraph.editableFields.trackLibrary as SavedTrack[])
          : [];
        const savedTracks = buildSavedTracksFromTargets(followTargets, tool.name);
        const projectWithFollowText = await patchProject(project.id, {
          projectGraph: {
            ...project.projectGraph,
            editableFields: {
              ...project.projectGraph.editableFields,
              trackingPath: primaryTrackingPath,
              followText,
              followTextColor,
              followSmoothing,
              followDepth,
              followMode,
              followQuality,
              followStabilizeStrength,
              followOffset,
              // Seed the project's reusable track library so the same tracked motion can
              // be attached to other layers (added now or later) without re-tracking.
              trackLibrary: [...existingTrackLibrary.filter((item) => !savedTracks.some((next) => next.id === item.id)), ...savedTracks]
            },
            composition: nextComposition,
            version: project.projectGraph.version + 1
          }
        });
        navigate(`/editor/${projectWithFollowText.id}`);
        return;
      }
      navigate(`/editor/${project.id}`);
    } finally {
      setBusy(false);
    }
  }

  const previewPane = (
    <Card className="tool-preview-panel">
      <div className="tool-preview-top">
        <Badge tone="muted">{followPreviewView === "result" ? "Result preview" : "Live track preview"}</Badge>
        <div className="follow-button-toggle follow-preview-view-toggle">
          <button className={followPreviewView === "tracker" ? "is-active" : ""} type="button" onClick={() => setFollowPreviewView("tracker")}>
            Tracker
          </button>
          <button className={followPreviewView === "result" ? "is-active" : ""} type="button" onClick={() => setFollowPreviewView("result")}>
            Result
          </button>
        </div>
      </div>
      <div className="tool-preview-canvas">
        {selectedAsset?.fileUrl ? (
          followPreviewView === "result" ? (
            followPreviewComposition ? (
              <div className="follow-result-preview">
                {followBeforeClean ? (
                  <div className="follow-button-toggle follow-compare-toggle">
                    <button className={followPreviewCompare === "before" ? "is-active" : ""} type="button" onClick={() => setFollowPreviewCompare("before")}>
                      Before
                    </button>
                    <button className={followPreviewCompare === "after" ? "is-active" : ""} type="button" onClick={() => setFollowPreviewCompare("after")}>
                      After clean
                    </button>
                  </div>
                ) : null}
                <FollowResultPreviewPlayer asset={selectedAsset} composition={followPreviewComposition} />
              </div>
            ) : (
              <>
                <WandSparkles size={34} />
                <h2>No tracked target yet</h2>
                <p>Track at least one target on the Track tab to see the real result here - same renderer as the editor.</p>
              </>
            )
          ) : (
            <div className="follow-tracker-stage">
              <TrackBoxEditor
                aspectRatio={(selectedAsset.width || 720) / (selectedAsset.height || 1280)}
                fixMarker={fixMarker?.targetId === followSelectedTargetId ? { timeSeconds: fixMarker.timeSeconds, point: fixMarker.point } : undefined}
                isPlaying={isTrackerPlaying}
                scrubTimeSeconds={trackScrubTime}
                selectedTargetId={followSelectedTargetId}
                targets={followTargets}
                textPlacement={followTextGhost}
                videoUrl={resolveToolMediaUrl(selectedAsset.fileUrl)}
                onChangePoint={updateFollowTargetPoint}
                onMoveFixMarker={(point) => setFixMarker((current) => (current ? { ...current, point } : current))}
                onMoveTextPlacement={(point) => {
                  if (followGhostReferencePoint) {
                    setFollowOffset({ x: point.x - followGhostReferencePoint.x, y: point.y - followGhostReferencePoint.y });
                  }
                }}
                onPlaybackEnded={() => setIsTrackerPlaying(false)}
                onSelectTarget={setFollowSelectedTargetId}
                onTimeUpdate={setTrackScrubTime}
              />
              {hasAnyFollowTrack ? (
                <div className="follow-tracker-controls">
                  <div className="follow-scrub-row">
                    <button
                      className="follow-tracker-playbutton"
                      title={isTrackerPlaying ? "Pause" : "Play"}
                      type="button"
                      onClick={() => setIsTrackerPlaying((value) => !value)}
                    >
                      {isTrackerPlaying ? <Pause size={14} /> : <Play size={14} />}
                    </button>
                    <input
                      aria-label="Scrub tracked frame"
                      max={selectedAsset.durationSeconds}
                      min={0}
                      step={0.01}
                      type="range"
                      value={Math.min(trackScrubTime, selectedAsset.durationSeconds)}
                      onChange={(event) => {
                        setIsTrackerPlaying(false);
                        setTrackScrubTime(Number(event.target.value));
                      }}
                    />
                    <span>{trackScrubTime.toFixed(2)}s</span>
                  </div>
                  {fixMarker ? (
                    <div className="follow-marker-row is-active">
                      <p>
                        Re-tracking from <strong>{fixMarker.timeSeconds.toFixed(2)}s</strong>. Drag the orange marker to correct the point - frames before stay, frames after
                        are re-tracked, then merged.
                      </p>
                      <div className="follow-button-toggle">
                        <button disabled={isRetracking} type="button" onClick={() => void handleRetrackFromMarker()}>
                          {isRetracking ? "Re-tracking..." : "Re-track from here"}
                        </button>
                        <button disabled={isRetracking} type="button" onClick={() => setFixMarker(null)}>
                          Cancel
                        </button>
                      </div>
                      {isRetracking ? (
                        <AiActivityIndicator label={retrackStatus || "Re-tracking locally..."} />
                      ) : retrackStatus ? (
                        <p className="follow-marker-status">{retrackStatus}</p>
                      ) : null}
                    </div>
                  ) : (
                    <div className="follow-marker-row">
                      <button className="follow-drop-marker" type="button" onClick={handleDropFixMarker}>
                        Drop fix marker at {trackScrubTime.toFixed(2)}s
                      </button>
                      <small>Scrub to where the track drifts off the subject, then drop a marker to re-track just that part.</small>
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          )
        ) : (
          <>
            <WandSparkles size={34} />
            <h2>No video selected</h2>
            <p>Upload or pick a clip on the Track tab to start tracking.</p>
          </>
        )}
      </div>
    </Card>
  );

  const controlsPane = (
    <Card className="tool-results-panel caption-workspace-panel">
      <SmartFollowTextPanel
        assets={preselectedAsset ? [] : assets}
        busy={busy}
        color={followTextColor}
        depth={followDepth}
        hideAssetPicker={Boolean(preselectedAsset)}
        isCleaning={isCleaningTrack}
        isTracking={trackingRunId !== 0}
        mode={followMode}
        offsetActive={followOffset.x !== 0 || followOffset.y !== 0}
        quality={followQuality}
        selectedAsset={selectedAsset}
        selectedAssetId={selectedAssetId}
        selectedTargetId={followSelectedTargetId}
        smoothing={followSmoothing}
        stabilizeStrength={followStabilizeStrength}
        targets={followTargets}
        text={followText}
        trackCleanStatus={trackCleanStatus}
        trackingStatus={trackingStatus}
        onAddAutoTarget={addAutoFollowTarget}
        onAddTarget={addManualFollowTarget}
        onChangeColor={setFollowTextColor}
        onChangeDepth={setFollowDepth}
        onChangeMode={setFollowMode}
        onChangeQuality={setFollowQuality}
        onChangeSmoothing={setFollowSmoothing}
        onChangeStabilizeStrength={setFollowStabilizeStrength}
        onChangeTargetText={updateFollowTargetText}
        onChangeText={setFollowText}
        onCleanTracks={() => void handleCleanTracks()}
        onDuplicateTarget={duplicateFollowTarget}
        onRemoveTarget={removeFollowTarget}
        onRenameTarget={renameFollowTarget}
        onResetOffset={() => setFollowOffset({ x: 0, y: 0 })}
        onResetTargetToAuto={resetFollowTargetToAuto}
        onSelectAsset={onSelectAsset}
        onSelectTarget={setFollowSelectedTargetId}
        onTrack={() => void handleTrackAll()}
        onUploadAsset={onUploadAsset}
        trackOnly={Boolean(trackOnly)}
      />

      <div className="caption-apply-footer">
        <Button disabled={busy || !hasAnyFollowTrack} icon={undefined} onClick={() => void handleApply()}>
          {busy ? "Working..." : trackOnly ? "Save to track library" : followMode === "stabilize" ? "Apply stabilization" : "Apply tracking"}
        </Button>
        {!hasAnyFollowTrack ? <p className="caption-status-line">Track at least one target first.</p> : null}
      </div>
    </Card>
  );

  if (compact) {
    return (
      <div className="tool-shell tool-shell-captions">
        {previewPane}
        {controlsPane}
      </div>
    );
  }

  return (
    <div className="page tool-detail-page tool-detail-page-captions">
      <section className="tool-detail-header">
        <div>
          <Badge tone="lime">{tool.category}</Badge>
          <h1>{tool.name}</h1>
          <p>{tool.userDescription}</p>
        </div>
        <CreditBadge value={tool.estimatedCredits ?? 0} />
      </section>
      <section className="tool-shell tool-shell-captions">
        {previewPane}
        {controlsPane}
      </section>
    </div>
  );
}

function SmartFollowTextPanel({
  assets,
  busy,
  color,
  depth,
  hideAssetPicker,
  isCleaning,
  isTracking,
  mode,
  offsetActive,
  quality,
  selectedAsset,
  selectedAssetId,
  selectedTargetId,
  smoothing,
  stabilizeStrength,
  targets,
  text,
  trackCleanStatus,
  trackingStatus,
  onAddAutoTarget,
  onAddTarget,
  onChangeColor,
  onChangeDepth,
  onChangeMode,
  onChangeQuality,
  onChangeSmoothing,
  onChangeStabilizeStrength,
  onChangeTargetText,
  onChangeText,
  onCleanTracks,
  onDuplicateTarget,
  onRemoveTarget,
  onRenameTarget,
  onResetOffset,
  onResetTargetToAuto,
  onSelectAsset,
  onSelectTarget,
  onTrack,
  onUploadAsset,
  trackOnly
}: {
  assets: SourceAsset[];
  busy: boolean;
  color: string;
  depth: number;
  /** True when the workspace was opened with a fixed preselected asset (editor modal) - hides upload/select UI. */
  hideAssetPicker: boolean;
  isCleaning: boolean;
  isTracking: boolean;
  mode: "follow" | "stabilize";
  offsetActive: boolean;
  quality: TrackQuality;
  selectedAsset: SourceAsset | undefined;
  selectedAssetId: string;
  selectedTargetId: string;
  smoothing: number;
  stabilizeStrength: number;
  targets: FollowTarget[];
  text: string;
  trackCleanStatus: string;
  trackingStatus: string;
  onAddAutoTarget: () => void;
  onAddTarget: () => void;
  onChangeColor: (value: string) => void;
  onChangeDepth: (value: number) => void;
  onChangeMode: (value: "follow" | "stabilize") => void;
  onChangeQuality: (value: TrackQuality) => void;
  onChangeSmoothing: (value: number) => void;
  onChangeStabilizeStrength: (value: number) => void;
  onChangeTargetText: (id: string, value: string) => void;
  onChangeText: (value: string) => void;
  onCleanTracks: () => void;
  onDuplicateTarget: (id: string) => void;
  onRemoveTarget: (id: string) => void;
  onRenameTarget: (id: string, label: string) => void;
  onResetOffset: () => void;
  onResetTargetToAuto: (id: string) => void;
  onSelectAsset: (id: string) => void;
  onSelectTarget: (id: string) => void;
  onTrack: () => void;
  onUploadAsset: (file: File | null) => void | Promise<void>;
  /** Pure tracking mode (the editor's "Track a new point..." workspace) - hides the follow-text Style tab entirely, only the Track tab is shown. */
  trackOnly: boolean;
}) {
  const trackedCount = targets.filter((target) => target.trackingPath).length;
  const [activeTab, setActiveTab] = useState<"track" | "style">("track");
  const autoSwitchedRef = useRef(false);
  useEffect(() => {
    if (trackOnly) {
      return;
    }
    if (trackedCount > 0 && !autoSwitchedRef.current) {
      autoSwitchedRef.current = true;
      setActiveTab("style");
    }
  }, [trackOnly, trackedCount]);

  const [imagePalette, setImagePalette] = useState(defaultColorPalette);
  useEffect(() => {
    let alive = true;
    if (!selectedAsset) {
      setImagePalette(defaultColorPalette);
      return;
    }
    extractPaletteFromAsset(selectedAsset)
      .then((palette) => {
        if (alive) {
          setImagePalette(palette.length ? palette : defaultColorPalette);
        }
      })
      .catch(() => {
        if (alive) {
          setImagePalette(defaultColorPalette);
        }
      });
    return () => {
      alive = false;
    };
  }, [selectedAsset]);

  const tabs: Array<{ id: "track" | "style"; label: string; icon: ReactNode }> = [
    { id: "track", label: "Track", icon: <Upload size={14} /> },
    { id: "style", label: "Style", icon: <WandSparkles size={14} /> }
  ];

  return (
    <div className="caption-tool-panel">
      {!trackOnly ? (
        <div className="caption-tabs" role="tablist" aria-label="Smart 3D Follow Text sections">
          {tabs.map((tab) => (
            <button
              aria-selected={activeTab === tab.id}
              className={activeTab === tab.id ? "is-active" : ""}
              key={tab.id}
              role="tab"
              type="button"
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.icon}
              <span>{tab.label}</span>
            </button>
          ))}
        </div>
      ) : null}

      {activeTab === "track" || trackOnly ? (
        <div className="caption-tab-panel mask-tool-panel">
          {trackOnly ? (
            <label className="track-effect-label-field">
              <span>Track name</span>
              <input
                value={targets.find((target) => target.id === selectedTargetId)?.label ?? ""}
                onChange={(event) => onRenameTarget(selectedTargetId, event.target.value)}
              />
            </label>
          ) : null}
          {!hideAssetPicker ? (
            <>
              <div className="caption-input-card">
                <div>
                  <span>Source video</span>
                  <strong>{selectedAsset?.fileName ?? "No video selected"}</strong>
                  <small>
                    {selectedAsset ? `${selectedAsset.fileType} · ${selectedAsset.durationSeconds.toFixed(2)}s` : "Upload a clip to add trackers to."}
                  </small>
                </div>
                <label className="caption-upload-button">
                  <Upload size={14} />
                  {busy ? "Uploading" : "Upload"}
                  <input accept="video/*" disabled={busy} type="file" onChange={(event) => void onUploadAsset(event.currentTarget.files?.[0] ?? null)} />
                </label>
              </div>

              {assets.length ? (
                <label className="caption-media-picker">
                  <span>Or use existing media</span>
                  <ThemedSelect
                    ariaLabel="Existing media"
                    value={selectedAssetId}
                    placeholder="Select media"
                    options={[
                      { value: "", label: "Select media" },
                      ...assets.map((asset) => ({ value: asset.id, label: `${asset.fileName} · ${asset.durationSeconds.toFixed(2)}s` }))
                    ]}
                    onChange={(next) => onSelectAsset(next)}
                  />
                </label>
              ) : null}
            </>
          ) : null}

          <span className="caption-section-label">Track quality</span>
          <div className="follow-button-toggle">
            <button className={quality === "fast" ? "is-active" : ""} title="Single-scale, instant" type="button" onClick={() => onChangeQuality("fast")}>
              Fast
            </button>
            <button
              className={quality === "quality" ? "is-active" : ""}
              title="Multi-scale, handles bigger motion"
              type="button"
              onClick={() => onChangeQuality("quality")}
            >
              Quality
            </button>
          </div>

          <div className="follow-target-list">
            <span>
              Targets ({trackedCount}/{targets.length} tracked)
            </span>
            {targets.length ? (
              targets.map((target) => (
                <div className={`follow-target-row${target.id === selectedTargetId ? " is-active" : ""}`} key={target.id}>
                  <button type="button" onClick={() => onSelectTarget(target.id)}>
                    {target.label}
                    {target.auto ? " (auto-detect)" : ""}
                    {target.trackingPath ? ` ✓ ${Math.round(averageTrackConfidence(target.trackingPath) * 100)}% confidence` : ""}
                  </button>
                  {target.id === AUTO_TARGET_ID && !target.auto ? (
                    <button
                      aria-label={`Re-detect ${target.label} with AI`}
                      className="follow-target-redetect"
                      title="Auto-detection didn't find the right point? Drag it yourself, or click here to let AI try again."
                      type="button"
                      onClick={() => onResetTargetToAuto(target.id)}
                    >
                      Re-detect
                    </button>
                  ) : null}
                  {target.trackingPath ? (
                    <button
                      aria-label={`Reuse ${target.label}'s track for another text or graphic`}
                      className="follow-target-redetect"
                      title="Reuse this exact tracked motion for a second piece of text or graphic, without re-tracking."
                      type="button"
                      onClick={() => onDuplicateTarget(target.id)}
                    >
                      + Reuse track
                    </button>
                  ) : null}
                  <button aria-label={`Remove ${target.label}`} className="follow-target-remove" type="button" onClick={() => onRemoveTarget(target.id)}>
                    &times;
                  </button>
                </div>
              ))
            ) : (
              <p>No trackers yet. Auto select a subject or add a tracker below.</p>
            )}
            <div className="follow-button-toggle">
              <button disabled={targets.some((target) => target.id === AUTO_TARGET_ID)} type="button" onClick={onAddAutoTarget}>
                Auto select
              </button>
              <button type="button" onClick={onAddTarget}>
                + Add tracker
              </button>
            </div>
          </div>

          <div className="caption-local-transcribe">
            <button disabled={busy || !selectedAsset} type="button" onClick={onTrack}>
              {isTracking ? "Tracking..." : trackedCount > 0 ? "Re-track all" : "Track all"}
            </button>
            {isTracking ? (
              <AiActivityIndicator label={trackingStatus || "Tracking locally..."} />
            ) : (
              <p>{trackingStatus || "Runs locally in your browser. Click or drag the handle on the preview to set or correct a tracker."}</p>
            )}
          </div>
        </div>
      ) : null}

      {activeTab === "style" ? (
        <div className="caption-tab-panel">
          <span className="caption-section-label">Mode</span>
          <div className="follow-button-toggle">
            <button className={mode === "follow" ? "is-active" : ""} type="button" onClick={() => onChangeMode("follow")}>
              Follow text
            </button>
            <button className={mode === "stabilize" ? "is-active" : ""} type="button" onClick={() => onChangeMode("stabilize")}>
              Stabilize subject
            </button>
          </div>

          {mode === "follow" ? (
            <>
              <label>
                <span>Follow text (default)</span>
                <input value={text} onChange={(event) => onChangeText(event.target.value)} />
              </label>
              <div className="follow-placement-row">
                <p>
                  Text follows the tracked point. Drag the text in the preview to place it elsewhere (e.g. above the head while tracking the shoe) - it keeps riding the motion from there.
                </p>
                {offsetActive ? (
                  <button className="follow-target-redetect" type="button" onClick={onResetOffset}>
                    Reset to point
                  </button>
                ) : null}
              </div>
              {targets.length > 1 ? (
                <div className="follow-target-list">
                  <span>Per-target text override</span>
                  {targets.map((target) => (
                    <div className="follow-target-row" key={target.id}>
                      <span>{target.label}</span>
                      <input
                        placeholder={text}
                        value={target.customText ?? ""}
                        onChange={(event) => onChangeTargetText(target.id, event.target.value)}
                      />
                    </div>
                  ))}
                </div>
              ) : null}
              <div className="control-grid">
                <ColorControl icon={<PaintBucket size={14} />} label="Text color" palette={imagePalette} value={color} onChange={onChangeColor} />
              </div>
              <label>
                <span>Depth / parallax</span>
                <input min={0} max={1} step={0.05} type="range" value={depth} onChange={(event) => onChangeDepth(Number(event.target.value))} />
              </label>
            </>
          ) : (
            <label>
              <span>Stabilize strength</span>
              <input
                min={0}
                max={1}
                step={0.05}
                type="range"
                value={stabilizeStrength}
                onChange={(event) => onChangeStabilizeStrength(Number(event.target.value))}
              />
            </label>
          )}

          <label>
            <span>Smoothing</span>
            <input min={0} max={0.95} step={0.05} type="range" value={smoothing} onChange={(event) => onChangeSmoothing(Number(event.target.value))} />
          </label>

          {trackedCount ? (
            <div className="follow-clean-track">
              <button disabled={isCleaning} type="button" onClick={onCleanTracks}>
                <WandSparkles size={14} />
                {isCleaning ? "Verifying track..." : "Clean & smooth track"}
              </button>
              {isCleaning ? (
                <AiActivityIndicator label={trackCleanStatus || "Verifying against the real frames..."} />
              ) : (
                <p>
                  {trackCleanStatus ||
                    "Re-checks the track against the real video: re-verifies each frame against the person/object, corrects frames where the tracker slipped, and straightens near-straight motion so the text doesn't distort."}
                </p>
              )}
            </div>
          ) : null}

          {!trackedCount ? (
            <div className="caption-empty-tab-hint">
              <Info size={14} />
              <p>No tracked targets yet. Track at least one target on the Track tab first.</p>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function FollowResultPreviewPlayer({ asset, composition }: { asset: SourceAsset; composition: TimelineComposition }) {
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const currentTimeRef = useRef(0);
  const playbackStartRef = useRef<{ clockMs: number; timeSeconds: number } | null>(null);

  useEffect(() => {
    currentTimeRef.current = currentTime;
  }, [currentTime]);

  useEffect(() => {
    setCurrentTime(0);
    setIsPlaying(false);
  }, [asset.id]);

  useEffect(() => {
    if (!isPlaying) {
      playbackStartRef.current = null;
      return;
    }
    const started = { clockMs: performance.now(), timeSeconds: currentTimeRef.current };
    playbackStartRef.current = started;
    let frame = 0;
    const tick = (clockMs: number) => {
      const start = playbackStartRef.current;
      if (!start) {
        return;
      }
      const nextTime = start.timeSeconds + (clockMs - start.clockMs) / 1000;
      if (nextTime >= composition.durationSeconds) {
        setCurrentTime(composition.durationSeconds);
        setIsPlaying(false);
        return;
      }
      setCurrentTime(nextTime);
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [isPlaying, composition.durationSeconds]);

  const graph: ProjectGraph = useMemo(() => ({ projectId: "follow_text_preview", effects: [], editableFields: {}, version: 1 }), []);
  const previewAssets = useMemo(() => [asset], [asset]);

  return (
    <div
      className="follow-result-viewer editor-viewer"
      style={{ "--follow-result-aspect": `${composition.width} / ${composition.height}` } as CSSProperties}
    >
      <VideoPreview
        assets={previewAssets}
        composition={composition}
        currentTime={Math.min(currentTime, composition.durationSeconds)}
        graph={graph}
        isPlaying={isPlaying}
        previewQuality="quality"
        sourceAsset={asset}
        viewerZoom={1}
        onSelectLayer={() => undefined}
      />
      <div className="viewer-controls follow-result-controls">
        <button title={isPlaying ? "Pause" : "Play"} type="button" onClick={() => setIsPlaying((value) => !value)}>
          {isPlaying ? <Pause size={14} /> : <Play size={14} />}
        </button>
        <input
          max={composition.durationSeconds}
          min={0}
          step={0.01}
          type="range"
          value={Math.min(currentTime, composition.durationSeconds)}
          onChange={(event) => {
            setIsPlaying(false);
            setCurrentTime(Number(event.target.value));
          }}
        />
        <span>{currentTime.toFixed(2)}s</span>
      </div>
    </div>
  );
}
