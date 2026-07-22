import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { Eraser, PaintBucket, Pause, Play, Sparkles, WandSparkles } from "lucide-react";
import {
  applyRemoveBackgroundComposition,
  createDefaultComposition,
  REMOVE_BACKGROUND_DEFAULT_PLATE,
  type MaskSequenceArtifactData,
  type ProjectGraph,
  type SourceAsset,
  type TimelineComposition,
  type ToolCapabilityDefinition
} from "@orreris/shared";
import { AiActivityIndicator } from "../components/AiActivityIndicator";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { ColorControl } from "../components/ColorControl";
import { CreditBadge } from "../components/CreditBadge";
import { ModelEngineControl } from "../components/ModelEngineControl";
import { VideoPreview } from "../components/VideoPreview";
import { ThemedSelect } from "../editor/inspector/controls/ThemedSelect";
import { addEffect, createProject, patchProject } from "../lib/api";
import { resolveGraphMattes } from "../export/matte-resolve";
import { getLayerToolEffectHandler } from "../tools/layer-effect-handlers";
import { assertToolRunnable } from "../tools/useLayerToolEffectRunner";

type OutputMode = "timelineMask" | "greenScreen";

/** Blue-screen / broadcast-green / common brand-fill plate suggestions for the colour picker. */
const PLATE_SWATCHES = ["#00B140", "#0047FF", "#000000", "#FFFFFF", "#FF00FF"];

export interface RemoveBackgroundToolPanelProps {
  tool: ToolCapabilityDefinition;
  assets: SourceAsset[];
  selectedAssetId: string;
  onSelectAsset: (id: string) => void;
  onUploadAsset: (file: File | null) => void | Promise<void>;
  /** Locks the workspace to this clip and hides the picker — the editor modal path. */
  preselectedAsset?: SourceAsset | undefined;
  /**
   * When set, Apply merges the removal into this live composition and calls
   * `onApplyToComposition` instead of creating a new project + navigating. The editor
   * modal supplies both; the standalone /tools page omits them.
   */
  liveComposition?: TimelineComposition | undefined;
  onApplyToComposition?:
    | ((nextComposition: TimelineComposition, editableFieldsPatch?: Record<string, unknown>) => void)
    | undefined;
  /** Durable per-project artifacts, so an already-extracted matte is reused instead of re-segmenting. */
  editableFields?: Record<string, unknown> | undefined;
  /**
   * The timeline clip's used slice of its source (editor path): `sourceInSeconds` is the in-point,
   * `usedDurationSeconds` the source seconds actually consumed (duration × speed). Lets the Range
   * control offer "Used in timeline" so a 10-second cut of a 10-minute source needn't segment the
   * whole file. Absent on the standalone /tools page (no timeline context).
   */
  clipRange?: { sourceInSeconds: number; usedDurationSeconds: number } | undefined;
  /** Compact chrome (no page header/back link) for the modal context. */
  compact?: boolean | undefined;
}

type RangeMode = "whole" | "used" | "custom";

function formatClock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Full Remove Background workspace: pick media, choose the real segmentation quality tier and
 * the output (transparent matte vs a solid colour plate you can recolour), generate a REAL
 * matte in the browser (the same `remove-background` layer-effect handler the editor's one-click
 * flow drives), preview the composited result through the same renderer the editor uses, then
 * Apply. Self-contained so it serves both `/tools/remove-background` and the editor's Effects-tab
 * modal (asset preselected, Apply targets the live composition) with no divergence — the preview
 * is literally `applyRemoveBackgroundComposition`, so it can never drift from what Apply produces.
 */
export function RemoveBackgroundToolPanel({
  tool,
  assets,
  selectedAssetId,
  onSelectAsset,
  onUploadAsset,
  preselectedAsset,
  liveComposition,
  onApplyToComposition,
  editableFields,
  clipRange,
  compact
}: RemoveBackgroundToolPanelProps) {
  const navigate = useNavigate();
  const selectedAsset = preselectedAsset ?? assets.find((asset) => asset.id === selectedAssetId);

  const [outputMode, setOutputMode] = useState<OutputMode>("timelineMask");
  const [plateColor, setPlateColor] = useState<string>(REMOVE_BACKGROUND_DEFAULT_PLATE);
  const [quality, setQuality] = useState<"fast" | "quality">("fast");
  const [maskSource, setMaskSource] = useState<"auto" | "reanalyze">("auto");
  const [rangeMode, setRangeMode] = useState<RangeMode>(clipRange ? "used" : "whole");
  const [customStart, setCustomStart] = useState(0);
  const [customEnd, setCustomEnd] = useState(0);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [bakedMask, setBakedMask] = useState<MaskSequenceArtifactData | undefined>();

  const cancelledRef = useRef(false);
  const runIdRef = useRef(0);

  const sourceDuration = selectedAsset?.durationSeconds ?? 0;
  const usedRange = useMemo(
    () =>
      clipRange
        ? { start: clipRange.sourceInSeconds, end: Math.min(sourceDuration || Infinity, clipRange.sourceInSeconds + clipRange.usedDurationSeconds) }
        : undefined,
    [clipRange, sourceDuration]
  );

  // A fresh clip invalidates the previously baked matte (it belongs to the old source) and resets the
  // range to a sensible default (the used slice when known, otherwise the whole clip).
  useEffect(() => {
    setBakedMask(undefined);
    setStatus("");
    setRangeMode(usedRange ? "used" : "whole");
    setCustomStart(usedRange?.start ?? 0);
    setCustomEnd(usedRange?.end ?? sourceDuration);
    // usedRange/sourceDuration are derived from selectedAsset — keying on the id is what we want.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAsset?.id]);

  const effectiveRange = useMemo(() => {
    const clampT = (v: number) => Math.min(sourceDuration || v, Math.max(0, v));
    if (rangeMode === "custom") {
      const start = clampT(customStart);
      const end = Math.max(start, clampT(customEnd));
      return { start, end };
    }
    if (rangeMode === "used" && usedRange) {
      return usedRange;
    }
    return { start: 0, end: sourceDuration };
  }, [rangeMode, customStart, customEnd, usedRange, sourceDuration]);

  const rangeLengthSeconds = Math.max(0, effectiveRange.end - effectiveRange.start);
  const sampleFps = quality === "quality" ? 30 : 8;
  const estimatedFrames = Math.max(1, Math.round(rangeLengthSeconds * sampleFps));

  const applyOptions = useMemo(
    () => ({ mode: outputMode, ...(outputMode === "greenScreen" ? { plateColor } : {}) }),
    [outputMode, plateColor]
  );

  // The base the preview (and, in the editor path, Apply) builds onto: the live composition when
  // embedded, otherwise a throwaway one shaped like the source clip (never the real Apply target
  // on the tool page — that creates a fresh project instead).
  const baseComposition = useMemo(() => {
    if (liveComposition) {
      return liveComposition;
    }
    if (!selectedAsset) {
      return undefined;
    }
    const base = createDefaultComposition({
      id: `rbg_preview_${selectedAsset.id}`,
      name: "Remove Background preview",
      durationSeconds: selectedAsset.durationSeconds,
      assetId: selectedAsset.id
    });
    return { ...base, width: selectedAsset.width || base.width, height: selectedAsset.height || base.height };
  }, [liveComposition, selectedAsset]);

  const previewComposition = useMemo(() => {
    if (!bakedMask || !baseComposition || !selectedAsset) {
      return undefined;
    }
    return applyRemoveBackgroundComposition(
      baseComposition,
      { maskId: bakedMask.id, mask: bakedMask, sourceAssetId: selectedAsset.id, ...applyOptions },
      liveComposition ? "insert" : "replace"
    );
  }, [applyOptions, baseComposition, bakedMask, liveComposition, selectedAsset]);

  async function handleGenerate() {
    if (!selectedAsset?.fileUrl) {
      setStatus("Upload or select a video first.");
      return;
    }
    const blocker = assertToolRunnable(tool.slug, tool.name);
    if (blocker) {
      setStatus(blocker);
      return;
    }
    const handler = getLayerToolEffectHandler("remove-background");
    if (!handler) {
      setStatus("Remove Background runner is unavailable.");
      return;
    }

    setBusy(true);
    cancelledRef.current = false;
    const runId = Date.now();
    runIdRef.current = runId;
    setStatus(quality === "quality" ? "Baking a high-quality matte…" : "Extracting a fast preview matte…");
    try {
      const mask = (await handler.run({
        asset: selectedAsset,
        layer: undefined,
        fps: baseComposition?.fps ?? 30,
        composition: liveComposition,
        editableFields,
        // The segmenter windows to this range: only [start,end] of the source is sampled, and the
        // baked matte records `startSeconds` so every renderer re-aligns it to source time.
        options: {
          quality,
          maskSource,
          rangeStartSeconds: String(effectiveRange.start),
          rangeEndSeconds: String(effectiveRange.end)
        },
        onProgress: (message) => {
          if (!cancelledRef.current && runIdRef.current === runId) {
            setStatus(message);
          }
        },
        isCancelled: () => cancelledRef.current
      })) as MaskSequenceArtifactData;
      if (cancelledRef.current || runIdRef.current !== runId) {
        return;
      }
      setBakedMask(mask);
      setStatus(`Matte ready: ${mask.frames.length} frames. Adjust the output, then Apply.`);
    } catch (error) {
      if (cancelledRef.current || runIdRef.current !== runId) {
        return;
      }
      setStatus(error instanceof Error ? error.message : "Background removal failed.");
    } finally {
      if (runIdRef.current === runId) {
        runIdRef.current = 0;
        setBusy(false);
      }
    }
  }

  function handleCancel() {
    cancelledRef.current = true;
    runIdRef.current = 0;
    setBusy(false);
    setStatus("Cancelled.");
  }

  async function handleApply() {
    if (!bakedMask || !selectedAsset) {
      setStatus("Generate a matte first.");
      return;
    }
    const handler = getLayerToolEffectHandler("remove-background");
    if (!handler) {
      return;
    }

    // Editor path: merge into the live composition and hand it (plus the durable matte patch) back.
    if (onApplyToComposition && liveComposition) {
      const applyArgs = {
        composition: liveComposition,
        layer: undefined,
        asset: selectedAsset,
        result: bakedMask,
        options: applyOptions,
        context: "editor" as const
      };
      onApplyToComposition(handler.applyResult(applyArgs), handler.describeEditableFields?.(applyArgs));
      return;
    }

    // Standalone path: create a fresh draft project and open it in the editor.
    setBusy(true);
    try {
      const project = await createProject({ title: `${tool.name} Draft`, sourceAssetId: selectedAsset.id });
      // Use the graph RETURNED by addEffect (current version + any composition it rebuilt), not the
      // stale createProject graph — patching with the pre-addEffect version left the composition
      // unchanged (original clip) on the server path.
      const added = await addEffect(project.id, tool.moduleType);
      const graph = added.project.projectGraph as ProjectGraph;
      const composition = graph.composition;
      if (!composition) {
        navigate(`/editor/${project.id}`);
        return;
      }
      const applyArgs = {
        composition,
        layer: undefined,
        asset: selectedAsset,
        result: bakedMask,
        options: applyOptions,
        context: "standalone" as const
      };
      const nextComposition = handler.applyResult(applyArgs);
      const draftGraph: ProjectGraph = {
        ...graph,
        editableFields: { ...graph.editableFields, ...(handler.describeEditableFields?.(applyArgs) ?? {}) },
        composition: nextComposition,
        version: graph.version + 1
      };
      // Guarantee the matte has a durable, fetchable URL before the fresh editor mounts (recovers
      // blob:/OPFS bytes → uploads). Without it a non-durable matte URI can't load in the new
      // project, so the subject renders as the plain clip instead of the cutout. No-op when durable.
      const { graph: resolvedGraph } = await resolveGraphMattes(draftGraph);
      const updated = await patchProject(project.id, { projectGraph: resolvedGraph });
      navigate(`/editor/${updated.id}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Apply failed.");
    } finally {
      setBusy(false);
    }
  }

  const previewPane = (
    <Card className="tool-preview-panel">
      <div className="tool-preview-top">
        <Badge tone="muted">{bakedMask ? "Composited result" : "Preview"}</Badge>
        <span>{bakedMask ? `${bakedMask.frames.length} frames` : selectedAsset ? "Generate a matte" : "No media"}</span>
      </div>
      <div className="tool-preview-canvas">
        {previewComposition && selectedAsset ? (
          <RemoveBackgroundResultViewer asset={selectedAsset} composition={previewComposition} />
        ) : (
          <div className="toolws-preview-empty">
            <Eraser size={34} />
            <h2>{selectedAsset ? "No matte yet" : "No video selected"}</h2>
            <p>
              {selectedAsset
                ? "Choose your quality and output, then Generate a matte to preview the cut-out."
                : "Upload or pick a clip to start removing its background."}
            </p>
          </div>
        )}
      </div>
    </Card>
  );

  const controlsPane = (
    <Card className="tool-results-panel caption-workspace-panel">
      {!preselectedAsset ? (
        <div className="toolws-field">
          <label className="tool-upload-row">
            <span>Upload a clip</span>
            <input
              accept="video/*"
              type="file"
              onChange={(event) => {
                void onUploadAsset(event.currentTarget.files?.[0] ?? null);
              }}
            />
          </label>
          {assets.length ? (
            <label className="tool-upload-row">
              <span>Or pick existing media</span>
              <ThemedSelect
                ariaLabel="Existing media"
                value={selectedAssetId}
                placeholder="Select media…"
                options={[{ value: "", label: "Select media…" }, ...assets.map((asset) => ({ value: asset.id, label: asset.fileName }))]}
                onChange={(next) => onSelectAsset(next)}
              />
            </label>
          ) : null}
        </div>
      ) : null}

      <div className="toolws-field">
        <span className="toolws-field-label">Output</span>
        <div className="ui-seg">
          <button type="button" className={outputMode === "timelineMask" ? "is-active" : ""} onClick={() => setOutputMode("timelineMask")}>
            <Sparkles size={14} /> Transparent
          </button>
          <button type="button" className={outputMode === "greenScreen" ? "is-active" : ""} onClick={() => setOutputMode("greenScreen")}>
            <PaintBucket size={14} /> Colour plate
          </button>
        </div>
      </div>

      {outputMode === "greenScreen" ? (
        <div className="toolws-field">
          <span className="toolws-field-label">Plate colour</span>
          <ColorControl
            icon={<PaintBucket size={14} />}
            label="Plate colour"
            palette={PLATE_SWATCHES}
            value={plateColor}
            onReset={plateColor !== REMOVE_BACKGROUND_DEFAULT_PLATE ? () => setPlateColor(REMOVE_BACKGROUND_DEFAULT_PLATE) : undefined}
            onChange={setPlateColor}
          />
        </div>
      ) : null}

      <div className="toolws-field">
        <span className="toolws-field-label">Quality</span>
        <div className="ui-seg">
          <button type="button" className={quality === "fast" ? "is-active" : ""} disabled={busy} onClick={() => setQuality("fast")}>
            Fast preview
          </button>
          <button type="button" className={quality === "quality" ? "is-active" : ""} disabled={busy} onClick={() => setQuality("quality")}>
            High quality
          </button>
        </div>
      </div>

      <div className="toolws-field">
        <span className="toolws-field-label">Subject mask</span>
        <div className="ui-seg">
          <button type="button" className={maskSource === "auto" ? "is-active" : ""} disabled={busy} onClick={() => setMaskSource("auto")}>
            Reuse if available
          </button>
          <button type="button" className={maskSource === "reanalyze" ? "is-active" : ""} disabled={busy} onClick={() => setMaskSource("reanalyze")}>
            Re-analyze
          </button>
        </div>
      </div>

      <div className="toolws-field">
        <span className="toolws-field-label">Source range</span>
        <div className="ui-seg">
          <button type="button" className={rangeMode === "whole" ? "is-active" : ""} disabled={busy} onClick={() => setRangeMode("whole")}>
            Whole clip
          </button>
          {usedRange ? (
            <button type="button" className={rangeMode === "used" ? "is-active" : ""} disabled={busy} onClick={() => setRangeMode("used")}>
              Used in timeline
            </button>
          ) : null}
          <button type="button" className={rangeMode === "custom" ? "is-active" : ""} disabled={busy} onClick={() => setRangeMode("custom")}>
            Custom
          </button>
        </div>
        {rangeMode === "custom" ? (
          <div className="toolws-range-inputs">
            <label>
              <span>Start</span>
              <input
                type="number"
                min={0}
                max={sourceDuration}
                step={0.1}
                value={Number(customStart.toFixed(2))}
                disabled={busy}
                onChange={(event) => setCustomStart(Number(event.target.value))}
              />
            </label>
            <label>
              <span>End</span>
              <input
                type="number"
                min={0}
                max={sourceDuration}
                step={0.1}
                value={Number(customEnd.toFixed(2))}
                disabled={busy}
                onChange={(event) => setCustomEnd(Number(event.target.value))}
              />
            </label>
          </div>
        ) : null}
        <p className="toolws-range-readout">
          {formatClock(effectiveRange.start)}–{formatClock(effectiveRange.end)} · {formatClock(rangeLengthSeconds)} of {formatClock(sourceDuration)} · ~{estimatedFrames} frames
        </p>
      </div>

      <div className="toolws-actions">
        <Button disabled={busy || !selectedAsset} icon={<WandSparkles size={15} />} onClick={() => void handleGenerate()}>
          {busy ? "Working…" : bakedMask ? "Regenerate matte" : "Generate matte"}
        </Button>
        {busy ? (
          <Button variant="ghost" onClick={handleCancel}>
            Cancel
          </Button>
        ) : null}
      </div>

      {busy ? <AiActivityIndicator label={status || "Working locally…"} /> : status ? <p className="caption-status-line">{status}</p> : null}

      <ModelEngineControl />

      <div className="caption-apply-footer">
        <Button disabled={busy || !bakedMask} onClick={() => void handleApply()}>
          {busy ? "Working…" : "Apply to timeline"}
        </Button>
        {!bakedMask ? <p className="caption-status-line">Generate a matte first.</p> : null}
      </div>
    </Card>
  );

  if (compact) {
    return (
      <div className="tool-shell tool-shell-captions toolws-shell">
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
      <section className="tool-shell tool-shell-captions toolws-shell">
        {previewPane}
        {controlsPane}
      </section>
    </div>
  );
}

/** Result preview player — renders the composited removal through the same renderer the editor uses. */
function RemoveBackgroundResultViewer({ asset, composition }: { asset: SourceAsset; composition: TimelineComposition }) {
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const playbackStartRef = useRef<{ clockMs: number; timeSeconds: number } | null>(null);
  const currentTimeRef = useRef(0);
  currentTimeRef.current = currentTime;

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

  const graph: ProjectGraph = useMemo(() => ({ projectId: "rbg_preview", effects: [], editableFields: {}, version: 1 }), []);
  const previewAssets = useMemo(() => [asset], [asset]);

  return (
    <div
      className="follow-result-viewer editor-viewer toolws-result-viewer"
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
        viewMode="fit"
        manualScale={1}
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
