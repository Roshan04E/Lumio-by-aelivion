import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, Check, Eraser, Layers, Pause, Play, Scissors, Upload } from "lucide-react";
import {
  applyExtractPersonComposition,
  createDefaultComposition,
  type ProjectGraph,
  type SourceAsset,
  type SubjectAnalysisArtifacts,
  type TimelineComposition,
  type ToolCapabilityDefinition
} from "@orreris/shared";
import { Button } from "../components/Button";
import { VideoPreview } from "../components/VideoPreview";
import { setPlaybackClock } from "../playback/playback-clock";
import { addEffect, createProject, patchProject } from "../lib/api";
import { resolveGraphMattes } from "../export/matte-resolve";
import { getLayerToolEffectHandler } from "../tools/layer-effect-handlers";
import { assertToolRunnable } from "../tools/useLayerToolEffectRunner";

export interface ExtractPersonToolPanelProps {
  tool: ToolCapabilityDefinition;
  assets: SourceAsset[];
  selectedAssetId: string;
  onSelectAsset: (id: string) => void;
  onUploadAsset: (file: File | null) => void | Promise<void>;
  /** Locks the workspace to this clip and hides the picker — the editor modal path. */
  preselectedAsset?: SourceAsset | undefined;
  /** Editor path: merge into this live composition instead of creating a new project. */
  liveComposition?: TimelineComposition | undefined;
  onApplyToComposition?:
    | ((nextComposition: TimelineComposition, editableFieldsPatch?: Record<string, unknown>) => void)
    | undefined;
  editableFields?: Record<string, unknown> | undefined;
  /** Compact chrome (no page header) for the modal context. */
  compact?: boolean | undefined;
}

type Quality = "fast" | "quality";

/** Friendly, ordered stages the checklist walks through — creative language, not algorithm names. */
const STAGES = ["Analyzing video", "Finding the subject", "Creating the cutout", "Finishing up"] as const;

/** Turns the engine's raw progress line into a human stage + percent + ETA (no "bake/frames/matte"). */
function humanizeProgress(raw: string): { stage: number; label: string; percent?: number; eta?: string } {
  const baked = raw.match(/Baked\s+(\d+)\s+of\s+(\d+)/i);
  if (baked) {
    const done = Number(baked[1]);
    const total = Number(baked[2]);
    const percent = total ? Math.round((done / total) * 100) : undefined;
    const eta = raw.match(/~\s*(.+?)\s+left/i)?.[1];
    return { stage: 2, label: "Creating the cutout", ...(percent !== undefined ? { percent } : {}), ...(eta ? { eta } : {}) };
  }
  if (/saving|upload|finish/i.test(raw)) {
    return { stage: 3, label: "Finishing up", percent: 98 };
  }
  if (/reusing/i.test(raw)) {
    return { stage: 3, label: "Reusing the existing cutout", percent: 95 };
  }
  if (/model|loading|initiali[sz]|runtime|session/i.test(raw)) {
    return { stage: 0, label: "Analyzing video" };
  }
  return { stage: 1, label: "Finding the subject" };
}

/** "1080p" / "4K" / "540×960" resolution label for the source card. */
function resolutionLabel(width: number, height: number): string {
  const shortSide = Math.min(width, height);
  if (shortSide >= 2160) return "4K";
  if (shortSide >= 1440) return "1440p";
  if (shortSide >= 1080) return "1080p";
  if (shortSide >= 720) return "720p";
  if (shortSide > 0) return `${width}×${height}`;
  return "—";
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/**
 * Extract Person — a step-based creative workspace, not an engineering dashboard. A dominant live
 * viewer (real footage, then the real cut-out — never a placeholder silhouette) on the left; a
 * three-step workflow (Source → Extract → Result) on the right with one primary action at a time,
 * a reassuring humanized progress checklist + ETA, and guided next-steps once the cut-out is ready.
 * Dual-mode: serves both `/tools/extract-person` and the editor modal, reusing the same
 * `extract-person` layer-effect handler so the result is identical editable timeline data.
 */
export function ExtractPersonToolPanel({
  tool,
  assets,
  selectedAssetId,
  onSelectAsset,
  onUploadAsset,
  preselectedAsset,
  liveComposition,
  onApplyToComposition,
  editableFields,
  compact
}: ExtractPersonToolPanelProps) {
  const navigate = useNavigate();
  const selectedAsset = preselectedAsset ?? assets.find((asset) => asset.id === selectedAssetId);

  const [quality, setQuality] = useState<Quality>("fast");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [result, setResult] = useState<SubjectAnalysisArtifacts | undefined>();
  const [applying, setApplying] = useState(false);

  const cancelledRef = useRef(false);
  const runIdRef = useRef(0);

  // A fresh clip invalidates the previous cut-out.
  useEffect(() => {
    setResult(undefined);
    setStatus("");
    setBusy(false);
    cancelledRef.current = true;
  }, [selectedAsset?.id]);

  const baseComposition = useMemo(() => {
    if (liveComposition) return liveComposition;
    if (!selectedAsset) return undefined;
    const base = createDefaultComposition({
      id: `xtract_preview_${selectedAsset.id}`,
      name: "Extract Person preview",
      durationSeconds: selectedAsset.durationSeconds,
      assetId: selectedAsset.id
    });
    return { ...base, width: selectedAsset.width || base.width, height: selectedAsset.height || base.height };
  }, [liveComposition, selectedAsset]);

  // The viewer shows real footage before extraction, and the real cut-out afterwards.
  const previewComposition = useMemo(() => {
    if (!baseComposition || !selectedAsset) return undefined;
    if (!result) return baseComposition;
    return applyExtractPersonComposition(
      baseComposition,
      { mask: result.maskSequence, sourceAssetId: selectedAsset.id },
      liveComposition ? "insert" : "replace"
    );
  }, [baseComposition, result, selectedAsset, liveComposition]);

  const progress = busy ? humanizeProgress(status) : undefined;
  const activeStage = result ? STAGES.length : progress?.stage ?? -1;

  async function handleExtract() {
    if (!selectedAsset?.fileUrl) {
      setStatus("Choose a video first.");
      return;
    }
    const blocker = assertToolRunnable(tool.slug, tool.name);
    if (blocker) {
      setStatus(blocker);
      return;
    }
    const handler = getLayerToolEffectHandler("extract-person");
    if (!handler) {
      setStatus("Extract Person is unavailable on this device.");
      return;
    }

    setBusy(true);
    setResult(undefined);
    cancelledRef.current = false;
    const runId = Date.now();
    runIdRef.current = runId;
    setStatus("Analyzing video");
    try {
      const analysis = (await handler.run({
        asset: selectedAsset,
        layer: undefined,
        fps: baseComposition?.fps ?? 30,
        composition: liveComposition,
        editableFields,
        options: { quality, maskSource: "auto" },
        onProgress: (message) => {
          if (!cancelledRef.current && runIdRef.current === runId) {
            setStatus(message);
          }
        },
        isCancelled: () => cancelledRef.current
      })) as SubjectAnalysisArtifacts;
      if (cancelledRef.current || runIdRef.current !== runId) return;
      setResult(analysis);
      setStatus("");
    } catch (error) {
      if (cancelledRef.current || runIdRef.current !== runId) return;
      setStatus(error instanceof Error ? error.message : "Extraction failed.");
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
    setStatus("");
  }

  async function handleAddToTimeline() {
    if (!result || !selectedAsset) return;
    const handler = getLayerToolEffectHandler("extract-person");
    if (!handler) return;

    if (onApplyToComposition && liveComposition) {
      const applyArgs = {
        composition: liveComposition,
        layer: undefined,
        asset: selectedAsset,
        result,
        options: {},
        context: "editor" as const
      };
      onApplyToComposition(handler.applyResult(applyArgs), handler.describeEditableFields?.(applyArgs));
      return;
    }

    setApplying(true);
    try {
      const project = await createProject({ title: `${tool.name} Draft`, sourceAssetId: selectedAsset.id });
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
        result,
        options: {},
        context: "standalone" as const
      };
      const draftGraph: ProjectGraph = {
        ...graph,
        editableFields: { ...graph.editableFields, ...(handler.describeEditableFields?.(applyArgs) ?? {}) },
        composition: handler.applyResult(applyArgs),
        version: graph.version + 1
      };
      const { graph: resolvedGraph } = await resolveGraphMattes(draftGraph);
      const updated = await patchProject(project.id, { projectGraph: resolvedGraph });
      navigate(`/editor/${updated.id}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Couldn't add the cut-out.");
    } finally {
      setApplying(false);
    }
  }

  const workingLabel = progress?.label ?? "Working";

  // ── Left: the dominant live viewer ──────────────────────────────────────────────────────────────
  const viewer = (
    <div className="xtract-viewer">
      {previewComposition && selectedAsset ? (
        <ExtractPreviewPlayer
          asset={selectedAsset}
          composition={previewComposition}
          checker={Boolean(result)}
          badge={result ? "Cut-out" : "Preview"}
        />
      ) : (
        <div className="xtract-viewer-empty">
          <div className="xtract-viewer-empty-icon">
            <Play size={30} />
          </div>
          <p>Select a video to begin.</p>
        </div>
      )}
    </div>
  );

  // ── Right: the step-based workflow ──────────────────────────────────────────────────────────────
  const workflow = (
    <div className="xtract-flow">
      {/* STEP 1 — Source */}
      <section className={`xtract-step ${selectedAsset ? "is-done" : "is-active"}`}>
        <header className="xtract-step-head">
          <span className="xtract-step-num">{selectedAsset ? <Check size={13} /> : "1"}</span>
          <span className="xtract-step-title">Source</span>
        </header>
        {selectedAsset ? (
          <div className="xtract-source-card">
            <div className="xtract-source-thumb">
              {selectedAsset.thumbnailUrl ? (
                <img alt="" src={selectedAsset.thumbnailUrl} />
              ) : (
                <video muted playsInline preload="metadata" src={selectedAsset.fileUrl} />
              )}
            </div>
            <div className="xtract-source-meta">
              <strong title={selectedAsset.fileName}>{selectedAsset.fileName}</strong>
              <span>
                {formatDuration(selectedAsset.durationSeconds)} · {resolutionLabel(selectedAsset.width, selectedAsset.height)}
                {selectedAsset.fps ? ` · ${Math.round(selectedAsset.fps)} fps` : ""}
              </span>
            </div>
            {!preselectedAsset ? (
              <label className="xtract-change">
                Change
                <input accept="video/*" disabled={busy} type="file" onChange={(event) => void onUploadAsset(event.currentTarget.files?.[0] ?? null)} />
              </label>
            ) : null}
          </div>
        ) : (
          <label className="xtract-drop">
            <Upload size={20} />
            <strong>Select video</strong>
            <span>or drag &amp; drop</span>
            <input accept="video/*" type="file" onChange={(event) => void onUploadAsset(event.currentTarget.files?.[0] ?? null)} />
          </label>
        )}
        {!preselectedAsset && assets.length && !selectedAsset ? (
          <select className="xtract-existing" value={selectedAssetId} onChange={(event) => onSelectAsset(event.target.value)}>
            <option value="">Or use existing media…</option>
            {assets.map((asset) => (
              <option key={asset.id} value={asset.id}>
                {asset.fileName}
              </option>
            ))}
          </select>
        ) : null}
      </section>

      {/* STEP 2 — Extract */}
      <section className={`xtract-step ${result ? "is-done" : selectedAsset ? "is-active" : "is-pending"}`}>
        <header className="xtract-step-head">
          <span className="xtract-step-num">{result ? <Check size={13} /> : "2"}</span>
          <span className="xtract-step-title">Extract the person</span>
        </header>

        {busy ? (
          <div className="xtract-progress">
            <div className="xtract-progress-head">
              <strong>{workingLabel}…</strong>
              {progress?.percent !== undefined ? <span>{progress.percent}%</span> : null}
            </div>
            <div className="xtract-bar">
              <div
                className={`xtract-bar-fill ${progress?.percent === undefined ? "is-indeterminate" : ""}`}
                style={progress?.percent !== undefined ? { width: `${progress.percent}%` } : undefined}
              />
            </div>
            {progress?.eta ? <p className="xtract-eta">About {progress.eta} left</p> : null}
            <ul className="xtract-checklist">
              {STAGES.map((stage, index) => (
                <li key={stage} className={index < activeStage ? "is-done" : index === activeStage ? "is-active" : "is-pending"}>
                  <span className="xtract-dot">{index < activeStage ? <Check size={11} /> : null}</span>
                  {stage}
                </li>
              ))}
            </ul>
            <button className="xtract-cancel" type="button" onClick={handleCancel}>
              Cancel
            </button>
          </div>
        ) : (
          <>
            <div className="xtract-quality">
              <button type="button" className={quality === "fast" ? "is-active" : ""} onClick={() => setQuality("fast")}>
                Fast
              </button>
              <button type="button" className={quality === "quality" ? "is-active" : ""} onClick={() => setQuality("quality")}>
                Best quality
              </button>
            </div>
            <button className="xtract-primary" disabled={!selectedAsset} type="button" onClick={() => void handleExtract()}>
              <Scissors size={16} />
              {result ? "Extract again" : "Extract person"}
            </button>
            {status && !result ? <p className="xtract-note">{status}</p> : null}
          </>
        )}
      </section>

      {/* STEP 3 — Result + guided next steps */}
      <section className={`xtract-step ${result ? "is-active" : "is-pending"}`}>
        <header className="xtract-step-head">
          <span className="xtract-step-num">3</span>
          <span className="xtract-step-title">Use your cut-out</span>
        </header>
        {result ? (
          <div className="xtract-done">
            <p className="xtract-done-line">
              <Check size={14} /> Person extracted
            </p>
            <Button disabled={applying} icon={<ArrowRight size={15} />} onClick={() => void handleAddToTimeline()}>
              {applying ? "Adding…" : liveComposition ? "Add to timeline" : "Open in editor"}
            </Button>
            {!liveComposition ? (
              <div className="xtract-next">
                <button type="button" onClick={() => navigate("/tools/text-behind-person")}>
                  <Layers size={15} /> Place behind text
                </button>
                <button type="button" onClick={() => navigate("/tools/remove-background")}>
                  <Eraser size={15} /> Replace background
                </button>
              </div>
            ) : null}
          </div>
        ) : (
          <p className="xtract-note xtract-muted">Your cut-out and next steps appear here once it's ready.</p>
        )}
      </section>
    </div>
  );

  if (compact) {
    return <div className="xtract-shell">{viewer}{workflow}</div>;
  }

  return (
    <div className="page xtract-page">
      <header className="xtract-header">
        <span className="xtract-header-icon">
          <Scissors size={22} />
        </span>
        <div>
          <h1>{tool.name}</h1>
          <p>Remove a person from the background and create reusable cut-outs for effects and templates.</p>
        </div>
      </header>
      <div className="xtract-shell">
        {viewer}
        {workflow}
      </div>
    </div>
  );
}

/** Minimal viewer with play/scrub — real footage, then the real cut-out over a checker (no fake mask). */
function ExtractPreviewPlayer({
  asset,
  composition,
  checker,
  badge
}: {
  asset: SourceAsset;
  composition: TimelineComposition;
  checker: boolean;
  badge: string;
}) {
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const startRef = useRef<{ clockMs: number; timeSeconds: number } | null>(null);
  const timeRef = useRef(0);
  timeRef.current = currentTime;

  useEffect(() => {
    setCurrentTime(0);
    setIsPlaying(false);
  }, [asset.id, checker]);

  useEffect(() => {
    if (!isPlaying) {
      startRef.current = null;
      return;
    }
    const start = { clockMs: performance.now(), timeSeconds: timeRef.current };
    startRef.current = start;
    // VideoPreview plays the video element NATIVELY while `isPlaying` (smooth decode) and reads its
    // time from the shared playback clock. On the tools page nothing else drives that clock, so WE
    // advance it here at wall-clock rate — native playback + a matching clock = smooth, no seek-per-frame.
    setPlaybackClock(start.timeSeconds);
    let frame = 0;
    const tick = (clockMs: number) => {
      const s = startRef.current;
      if (!s) return;
      const next = s.timeSeconds + (clockMs - s.clockMs) / 1000;
      if (next >= composition.durationSeconds) {
        setPlaybackClock(composition.durationSeconds);
        setCurrentTime(composition.durationSeconds);
        setIsPlaying(false);
        return;
      }
      setPlaybackClock(next);
      setCurrentTime(next);
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [isPlaying, composition.durationSeconds]);

  const graph: ProjectGraph = useMemo(() => ({ projectId: "xtract_preview", effects: [], editableFields: {}, version: 1 }), []);
  const previewAssets = useMemo(() => [asset], [asset]);

  return (
    <div className={`xtract-player editor-viewer ${checker ? "is-checker" : ""}`} style={{ "--xtract-aspect": `${composition.width} / ${composition.height}` } as CSSProperties}>
      <span className="xtract-player-badge">{badge}</span>
      <VideoPreview
        assets={previewAssets}
        composition={composition}
        currentTime={Math.min(currentTime, composition.durationSeconds)}
        graph={graph}
        // Native playback while playing (smooth): VideoPreview reads the shared playback clock, which
        // our rAF drives above. When paused it falls back to the `currentTime` prop (seek to scrub).
        isPlaying={isPlaying}
        previewQuality="quality"
        sourceAsset={asset}
        viewMode="fit"
        manualScale={1}
        onSelectLayer={() => undefined}
      />
      <div className="xtract-player-controls">
        <button title={isPlaying ? "Pause" : "Play"} type="button" onClick={() => setIsPlaying((value) => !value)}>
          {isPlaying ? <Pause size={15} /> : <Play size={15} />}
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
        <span>{currentTime.toFixed(1)}s</span>
      </div>
    </div>
  );
}
