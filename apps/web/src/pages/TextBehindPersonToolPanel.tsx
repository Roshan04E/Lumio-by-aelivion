import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { Layers, Pause, Play, Type, WandSparkles } from "lucide-react";
import {
  applyTextBehindPersonComposition,
  createDefaultComposition,
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

const TEXT_SWATCHES = ["#FFFFFF", "#111111", "#FFD23F", "#4D9FFF", "#FF4D6D"];
const FONT_OPTIONS = [
  { value: "Arial", label: "Arial" },
  { value: "Inter", label: "Inter" },
  { value: "Impact", label: "Impact" },
  { value: "Georgia", label: "Georgia" },
  { value: "Times New Roman", label: "Times" },
  { value: "Courier New", label: "Courier" }
];

export interface TextBehindPersonToolPanelProps {
  tool: ToolCapabilityDefinition;
  assets: SourceAsset[];
  selectedAssetId: string;
  onSelectAsset: (id: string) => void;
  onUploadAsset: (file: File | null) => void | Promise<void>;
  preselectedAsset?: SourceAsset | undefined;
  liveComposition?: TimelineComposition | undefined;
  onApplyToComposition?:
    | ((nextComposition: TimelineComposition, editableFieldsPatch?: Record<string, unknown>) => void)
    | undefined;
  editableFields?: Record<string, unknown> | undefined;
  /** The timeline clip's used slice of its source (in-point + duration×speed) for the range control. */
  clipRange?: { sourceInSeconds: number; usedDurationSeconds: number } | undefined;
  compact?: boolean | undefined;
}

type RangeMode = "whole" | "used" | "custom";

function formatClock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Full Text Behind Person workspace: type the caption, colour/size/position/font it, choose the real
 * segmentation quality + source range, generate a REAL subject matte (the same `text-behind-person`
 * handler the editor one-click flow drives), and preview the composite (text tucked BEHIND the
 * subject) through the editor's own renderer before Apply. Fixes the long-standing gap where the
 * text/colour were read by the handler but never surfaced (so it was silently always "TEXT" in
 * white). Dual-mode: `/tools/text-behind-person` and the editor Effects-tab modal.
 */
export function TextBehindPersonToolPanel({
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
}: TextBehindPersonToolPanelProps) {
  const navigate = useNavigate();
  const selectedAsset = preselectedAsset ?? assets.find((asset) => asset.id === selectedAssetId);

  const [text, setText] = useState("NEW DROP");
  const [textColor, setTextColor] = useState("#FFFFFF");
  const [fontSize, setFontSize] = useState(118);
  const [fontFamily, setFontFamily] = useState("Arial");
  const [posX, setPosX] = useState(50);
  const [posY, setPosY] = useState(48);
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

  useEffect(() => {
    setBakedMask(undefined);
    setStatus("");
    setRangeMode(usedRange ? "used" : "whole");
    setCustomStart(usedRange?.start ?? 0);
    setCustomEnd(usedRange?.end ?? sourceDuration);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAsset?.id]);

  const effectiveRange = useMemo(() => {
    const clampT = (v: number) => Math.min(sourceDuration || v, Math.max(0, v));
    if (rangeMode === "custom") {
      const start = clampT(customStart);
      return { start, end: Math.max(start, clampT(customEnd)) };
    }
    if (rangeMode === "used" && usedRange) {
      return usedRange;
    }
    return { start: 0, end: sourceDuration };
  }, [rangeMode, customStart, customEnd, usedRange, sourceDuration]);

  const rangeLengthSeconds = Math.max(0, effectiveRange.end - effectiveRange.start);
  const estimatedFrames = Math.max(1, Math.round(rangeLengthSeconds * (quality === "quality" ? 30 : 8)));

  // Text params shared by the preview builder and Apply, keyed the way the handler reads them.
  const textOptions = useMemo(
    () => ({ text, textColor, fontFamily, fontSize: String(fontSize), positionX: String(posX), positionY: String(posY) }),
    [text, textColor, fontFamily, fontSize, posX, posY]
  );

  const baseComposition = useMemo(() => {
    if (liveComposition) {
      return liveComposition;
    }
    if (!selectedAsset) {
      return undefined;
    }
    const base = createDefaultComposition({
      id: `tbp_preview_${selectedAsset.id}`,
      name: "Text Behind Person preview",
      durationSeconds: selectedAsset.durationSeconds,
      assetId: selectedAsset.id
    });
    return { ...base, width: selectedAsset.width || base.width, height: selectedAsset.height || base.height };
  }, [liveComposition, selectedAsset]);

  const previewComposition = useMemo(() => {
    if (!bakedMask || !baseComposition || !selectedAsset) {
      return undefined;
    }
    // A windowed matte (custom / used-in-timeline range) covers only a slice of the source, so the
    // built layers last just that slice. Trim the throwaway standalone preview comp to the matte's
    // span so the viewer scrubs exactly the produced range instead of going black past the slice.
    // The editor path (liveComposition) keeps its real duration — the slice inserts at the clip's spot.
    const previewBase =
      liveComposition || !bakedMask.durationSeconds
        ? baseComposition
        : {
            ...baseComposition,
            durationSeconds: Math.min(baseComposition.durationSeconds, bakedMask.durationSeconds)
          };
    return applyTextBehindPersonComposition(
      previewBase,
      {
        text: text || "TEXT",
        textColor,
        fontSize,
        fontFamily,
        position: { x: posX, y: posY },
        maskId: bakedMask.id,
        mask: bakedMask,
        sourceAssetId: selectedAsset.id
      },
      liveComposition ? "insert" : "replace"
    );
  }, [baseComposition, bakedMask, fontFamily, fontSize, liveComposition, posX, posY, selectedAsset, text, textColor]);

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
    const handler = getLayerToolEffectHandler("text-behind-person");
    if (!handler) {
      setStatus("Text Behind Person runner is unavailable.");
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
      setStatus(`Matte ready: ${mask.frames.length} frames. Tune the text, then Apply.`);
    } catch (error) {
      if (cancelledRef.current || runIdRef.current !== runId) {
        return;
      }
      setStatus(error instanceof Error ? error.message : "Segmentation failed.");
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
    const handler = getLayerToolEffectHandler("text-behind-person");
    if (!handler) {
      return;
    }

    if (onApplyToComposition && liveComposition) {
      const applyArgs = {
        composition: liveComposition,
        layer: undefined,
        asset: selectedAsset,
        result: bakedMask,
        options: textOptions,
        context: "editor" as const
      };
      onApplyToComposition(handler.applyResult(applyArgs), handler.describeEditableFields?.(applyArgs));
      return;
    }

    setBusy(true);
    try {
      const project = await createProject({ title: `${tool.name} Draft`, sourceAssetId: selectedAsset.id });
      // Build on the graph addEffect RETURNS (current version), not the stale createProject graph —
      // otherwise the patched composition can be dropped on the server path (original clip lands).
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
        options: textOptions,
        context: "standalone" as const
      };
      const nextComposition = handler.applyResult(applyArgs);
      const draftGraph: ProjectGraph = {
        ...graph,
        editableFields: { ...graph.editableFields, ...(handler.describeEditableFields?.(applyArgs) ?? {}) },
        composition: nextComposition,
        version: graph.version + 1
      };
      // Ensure the matte resolves to a durable URL before the fresh editor mounts (else the subject
      // renders as the plain clip, not the cutout). No-op when the matte is already durable.
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
          <TextBehindResultViewer asset={selectedAsset} composition={previewComposition} />
        ) : (
          <div className="toolws-preview-empty">
            <Layers size={34} />
            <h2>{selectedAsset ? "No matte yet" : "No video selected"}</h2>
            <p>
              {selectedAsset
                ? "Type your text and generate a matte to preview it tucked behind the subject."
                : "Upload or pick a clip to place text behind its subject."}
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
            <input accept="video/*" type="file" onChange={(event) => void onUploadAsset(event.currentTarget.files?.[0] ?? null)} />
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
        <span className="toolws-field-label">Text</span>
        <textarea className="toolws-textarea" rows={2} value={text} disabled={busy} onChange={(event) => setText(event.target.value)} placeholder="Behind-subject text" />
      </div>

      <div className="toolws-field">
        <span className="toolws-field-label">Colour</span>
        <ColorControl icon={<Type size={14} />} label="Text colour" palette={TEXT_SWATCHES} value={textColor} onChange={setTextColor} />
      </div>

      <div className="toolws-field">
        <span className="toolws-field-label">Font</span>
        <ThemedSelect ariaLabel="Font family" value={fontFamily} options={FONT_OPTIONS} onChange={setFontFamily} />
      </div>

      <div className="toolws-field">
        <span className="toolws-field-label">Size · {fontSize}px</span>
        <input type="range" min={24} max={320} step={2} value={fontSize} disabled={busy} onChange={(event) => setFontSize(Number(event.target.value))} />
      </div>

      <div className="toolws-field">
        <span className="toolws-field-label">Position · {posX}% / {posY}%</span>
        <div className="toolws-range-inputs">
          <label>
            <span>X</span>
            <input type="range" min={0} max={100} step={1} value={posX} disabled={busy} onChange={(event) => setPosX(Number(event.target.value))} />
          </label>
          <label>
            <span>Y</span>
            <input type="range" min={0} max={100} step={1} value={posY} disabled={busy} onChange={(event) => setPosY(Number(event.target.value))} />
          </label>
        </div>
      </div>

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
              <input type="number" min={0} max={sourceDuration} step={0.1} value={Number(customStart.toFixed(2))} disabled={busy} onChange={(event) => setCustomStart(Number(event.target.value))} />
            </label>
            <label>
              <span>End</span>
              <input type="number" min={0} max={sourceDuration} step={0.1} value={Number(customEnd.toFixed(2))} disabled={busy} onChange={(event) => setCustomEnd(Number(event.target.value))} />
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

/** Result preview player — renders the text-behind composite through the editor's renderer. */
function TextBehindResultViewer({ asset, composition }: { asset: SourceAsset; composition: TimelineComposition }) {
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

  const graph: ProjectGraph = useMemo(() => ({ projectId: "tbp_preview", effects: [], editableFields: {}, version: 1 }), []);
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
