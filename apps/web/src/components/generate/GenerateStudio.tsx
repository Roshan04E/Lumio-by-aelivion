import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ImagePlus, Sparkles, Settings2, X } from "lucide-react";
import {
  assetGenerationSkill,
  type GenerationAvailability,
  type GenerationPref,
  type RankedModel,
  type SkillTaskKind,
  type SourceAsset
} from "@kimera-by-aelivion/shared";
import { ThemedSelect } from "../../editor/inspector/controls/ThemedSelect";
import {
  getGenerationAvailability,
  rankModelsForTask,
  runGeneration
} from "../../generate/generateClient";
import { ShadowCostBadge } from "../ShadowCostBadge";
import { LocalGenPanel } from "./LocalGenPanel";

/**
 * Generate Studio — the Flow/Veo-style AI asset generation surface. A near-fullscreen floating
 * overlay inside the editor (deliberately NOT a new tab: generation is iterative and needs the
 * editor's assets, references, and drag-to-timeline). Resolves a capable+available model per task
 * via the shared registry (local-first for image; cloud for video), ingests the result into the
 * media bin's AI tab, and can drop it straight onto the timeline.
 */

export interface GenerateStudioPrefill {
  taskKind?: string | undefined;
  prompt?: string | undefined;
  aspectRatio?: string | undefined;
  durationSeconds?: number | undefined;
  referenceImage?: string | undefined;
}

interface GenerateStudioProps {
  open: boolean;
  onClose: () => void;
  projectId?: string | undefined;
  /** Register a freshly generated asset into the media bin (source="ai"). */
  onAssetCreated?: ((asset: SourceAsset) => void) | undefined;
  /** Drop a generated asset onto the timeline. */
  onAddToTimeline?: ((asset: SourceAsset) => void) | undefined;
  /** Prefill from a chat handoff (e.g. "generate a 5s clip of waves"). */
  initial?: GenerateStudioPrefill | undefined;
}

interface HistoryItem {
  key: string;
  asset: SourceAsset;
  modelLabel: string;
  tier: "browser" | "cloud";
  prompt: string;
}

const IMAGE_ASPECTS = ["1:1", "16:9", "9:16", "4:3", "3:4"];
const VIDEO_ASPECTS = ["16:9", "9:16", "1:1"];

/** Task kinds surfaced in the Studio (mask-based inpaint/outpaint need a mask painter — later). */
const STUDIO_TASKS: SkillTaskKind[] = assetGenerationSkill.taskKinds.filter(
  (task) => !task.inputs.includes("mask")
);

/** Downscale a picked file to a bounded JPEG data URL for reference input. */
async function fileToDataUrl(file: File, maxEdge = 1280): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Canvas unavailable");
  }
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.92);
}

export function GenerateStudio({
  open,
  onClose,
  projectId,
  onAssetCreated,
  onAddToTimeline,
  initial
}: GenerateStudioProps) {
  const [view, setView] = useState<"studio" | "local">("studio");
  const [taskKindId, setTaskKindId] = useState<string>(STUDIO_TASKS[0]?.id ?? "text-to-image");
  const [prompt, setPrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [aspectRatio, setAspectRatio] = useState("1:1");
  const [durationSeconds, setDurationSeconds] = useState(5);
  const [seed, setSeed] = useState("");
  const [strength, setStrength] = useState(0.65);
  const [scale, setScale] = useState<"2x" | "4x">("2x");
  const [variations, setVariations] = useState(1);
  const [referenceImage, setReferenceImage] = useState<string | undefined>();

  const [availability, setAvailability] = useState<GenerationAvailability | null>(null);
  const [pref, setPref] = useState<GenerationPref>("localFirst");
  const [selectedModelId, setSelectedModelId] = useState<string>("");

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const task = useMemo(() => STUDIO_TASKS.find((t) => t.id === taskKindId) ?? STUDIO_TASKS[0]!, [taskKindId]);
  const isVideo = task.modality === "video";
  const needsReference = task.inputs.includes("image");
  const usesPrompt = task.id !== "upscale";

  // Load availability whenever the overlay opens.
  const refreshAvailability = useCallback(async () => {
    const next = await getGenerationAvailability();
    setAvailability(next);
  }, []);

  useEffect(() => {
    if (!open) return;
    void refreshAvailability();
  }, [open, refreshAvailability]);

  // Apply a chat-handoff prefill once when opening.
  useEffect(() => {
    if (!open || !initial) return;
    if (initial.taskKind && STUDIO_TASKS.some((t) => t.id === initial.taskKind)) setTaskKindId(initial.taskKind);
    if (initial.prompt) setPrompt(initial.prompt);
    if (initial.aspectRatio) setAspectRatio(initial.aspectRatio);
    if (typeof initial.durationSeconds === "number") setDurationSeconds(initial.durationSeconds);
    if (initial.referenceImage) setReferenceImage(initial.referenceImage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Keep the aspect ratio valid for the current modality.
  useEffect(() => {
    const allowed = isVideo ? VIDEO_ASPECTS : IMAGE_ASPECTS;
    if (!allowed.includes(aspectRatio)) setAspectRatio(allowed[0]!);
  }, [isVideo, aspectRatio]);

  const paramsForRanking = useMemo(
    () => ({ aspectRatio, ...(isVideo ? { durationSeconds } : {}) }),
    [aspectRatio, isVideo, durationSeconds]
  );

  const ranked: RankedModel[] = useMemo(() => {
    if (!availability) return [];
    return rankModelsForTask(assetGenerationSkill.id, task.id, paramsForRanking, availability, pref);
  }, [availability, task.id, paramsForRanking, pref]);

  // Default the model to the top-ranked pick when the candidate set changes.
  useEffect(() => {
    if (ranked.length === 0) {
      setSelectedModelId("");
    } else if (!ranked.some((r) => r.model.id === selectedModelId)) {
      setSelectedModelId(ranked[0]!.model.id);
    }
  }, [ranked, selectedModelId]);

  const handlePickReference = async (file: File | undefined) => {
    if (!file) return;
    try {
      setReferenceImage(await fileToDataUrl(file));
    } catch {
      setError("Couldn't read that image.");
    }
  };

  function buildParams(): Record<string, unknown> {
    const seedNum = seed.trim() ? Number(seed.trim()) : undefined;
    if (task.id === "upscale") {
      return { referenceImage, scale };
    }
    if (task.id === "text-to-video") {
      return { prompt, negativePrompt: negativePrompt || undefined, aspectRatio, durationSeconds, seed: seedNum };
    }
    if (task.id === "image-to-video") {
      return { prompt: prompt || undefined, referenceImage, aspectRatio, durationSeconds, seed: seedNum };
    }
    const base: Record<string, unknown> = {
      prompt,
      negativePrompt: negativePrompt || undefined,
      aspectRatio,
      seed: seedNum,
      variations: 1
    };
    if (task.id === "image-to-image") {
      base.referenceImage = referenceImage;
      base.strength = strength;
    }
    return base;
  }

  const canGenerate =
    !running &&
    ranked.length > 0 &&
    (!usesPrompt || prompt.trim().length > 0) &&
    (!needsReference || Boolean(referenceImage));

  const handleGenerate = async () => {
    if (!canGenerate) return;
    setRunning(true);
    setError("");
    setProgress(0);
    setNote("");
    const runs = isVideo ? 1 : Math.max(1, Math.min(4, variations));
    try {
      for (let i = 0; i < runs; i += 1) {
        const outcome = await runGeneration(
          {
            skillId: assetGenerationSkill.id,
            taskKind: task.id,
            params: buildParams(),
            pref,
            modelId: selectedModelId || undefined,
            projectId
          },
          (value, message) => {
            setProgress(value);
            setNote(runs > 1 ? `Variation ${i + 1}/${runs} — ${message}` : message);
          }
        );
        const modelLabel = ranked.find((r) => r.model.id === outcome.modelId)?.model.label ?? outcome.modelId;
        setHistory((current) => [
          { key: `${outcome.asset.id}-${i}`, asset: outcome.asset, modelLabel, tier: outcome.tier, prompt },
          ...current
        ]);
        onAssetCreated?.(outcome.asset);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Generation failed");
    } finally {
      setRunning(false);
      setProgress(0);
      setNote("");
    }
  };

  if (!open) return null;

  const aspects = isVideo ? VIDEO_ASPECTS : IMAGE_ASPECTS;

  return (
    <div className="gen-studio-scrim" role="dialog" aria-modal="true" aria-label="AI asset generation">
      <div className="gen-studio">
        <header className="gen-studio-head">
          <div className="gen-studio-title">
            <Sparkles size={16} />
            <strong>Generate</strong>
            <span className="gen-studio-sub">AI images &amp; video</span>
          </div>
          <div className="gen-studio-head-actions">
            <button type="button" className="gen-ghost" onClick={() => setView(view === "local" ? "studio" : "local")}>
              <Settings2 size={14} /> Local setup
            </button>
            <button type="button" className="ai-dock-close" onClick={onClose} aria-label="Close">
              <X size={16} />
            </button>
          </div>
        </header>

        {view === "local" ? (
          <div className="gen-studio-body gen-studio-local">
            <LocalGenPanel
              onClose={() => {
                setView("studio");
                void refreshAvailability();
              }}
              onChange={() => void refreshAvailability()}
            />
          </div>
        ) : (
          <div className="gen-studio-body">
            <div className="gen-studio-controls">
              <label className="gen-field">
                <span>Type</span>
                <ThemedSelect
                  ariaLabel="Generation type"
                  value={task.id}
                  options={STUDIO_TASKS.map((t) => ({ value: t.id, label: t.label }))}
                  onChange={(next) => setTaskKindId(next)}
                />
              </label>

              {usesPrompt ? (
                <label className="gen-field">
                  <span>Prompt</span>
                  <textarea
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                    rows={3}
                    placeholder={isVideo ? "A slow drone shot over misty pines at dawn…" : "A neon-lit rainy Tokyo alley, cinematic…"}
                  />
                </label>
              ) : null}

              {needsReference ? (
                <div className="gen-field">
                  <span>Reference image</span>
                  <div className="gen-ref">
                    {referenceImage ? (
                      <img src={referenceImage} alt="Reference" className="gen-ref-thumb" />
                    ) : (
                      <div className="gen-ref-empty">No image</div>
                    )}
                    <button type="button" className="gen-ghost" onClick={() => fileInputRef.current?.click()}>
                      <ImagePlus size={14} /> {referenceImage ? "Replace" : "Upload"}
                    </button>
                    {referenceImage ? (
                      <button type="button" className="gen-ghost" onClick={() => setReferenceImage(undefined)}>
                        Remove
                      </button>
                    ) : null}
                  </div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    hidden
                    onChange={(event) => void handlePickReference(event.target.files?.[0] ?? undefined)}
                  />
                </div>
              ) : null}

              {task.id !== "upscale" ? (
                <div className="gen-row">
                  <label className="gen-field">
                    <span>Aspect</span>
                    <ThemedSelect
                      ariaLabel="Aspect ratio"
                      value={aspectRatio}
                      options={aspects.map((value) => ({ value, label: value }))}
                      onChange={(next) => setAspectRatio(next)}
                    />
                  </label>
                  {isVideo ? (
                    <label className="gen-field">
                      <span>Duration (s)</span>
                      <input
                        type="number"
                        min={1}
                        max={10}
                        value={durationSeconds}
                        onChange={(event) => setDurationSeconds(Math.max(1, Math.min(10, Number(event.target.value) || 5)))}
                      />
                    </label>
                  ) : (
                    <label className="gen-field">
                      <span>Variations</span>
                      <input
                        type="number"
                        min={1}
                        max={4}
                        value={variations}
                        onChange={(event) => setVariations(Math.max(1, Math.min(4, Number(event.target.value) || 1)))}
                      />
                    </label>
                  )}
                </div>
              ) : (
                <label className="gen-field">
                  <span>Scale</span>
                  <ThemedSelect
                    ariaLabel="Upscale factor"
                    value={scale}
                    options={[
                      { value: "2x", label: "2×" },
                      { value: "4x", label: "4×" }
                    ]}
                    onChange={(next) => setScale(next as "2x" | "4x")}
                  />
                </label>
              )}

              {task.id === "image-to-image" ? (
                <label className="gen-field">
                  <span>Strength ({strength.toFixed(2)})</span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={strength}
                    onChange={(event) => setStrength(Number(event.target.value))}
                  />
                </label>
              ) : null}

              {usesPrompt && !isVideo ? (
                <label className="gen-field">
                  <span>Negative prompt (optional)</span>
                  <input value={negativePrompt} onChange={(event) => setNegativePrompt(event.target.value)} placeholder="blurry, low quality…" />
                </label>
              ) : null}

              <div className="gen-row">
                <label className="gen-field">
                  <span>Seed (optional)</span>
                  <input value={seed} onChange={(event) => setSeed(event.target.value.replace(/[^0-9]/g, ""))} placeholder="random" />
                </label>
                <label className="gen-field">
                  <span>Prefer</span>
                  <ThemedSelect
                    ariaLabel="Model preference"
                    value={pref}
                    options={[
                      { value: "localFirst", label: "Local first (free)" },
                      { value: "quality", label: "Quality" },
                      { value: "speed", label: "Speed" }
                    ]}
                    onChange={(next) => setPref(next as GenerationPref)}
                  />
                </label>
              </div>

              <label className="gen-field">
                <span>Model</span>
                {ranked.length > 0 ? (
                  <ThemedSelect
                    ariaLabel="Model"
                    value={selectedModelId}
                    options={ranked.map((r) => ({
                      value: r.model.id,
                      label: `${r.model.label} · ${r.model.provider === "local" ? "local · free" : "cloud"}`
                    }))}
                    onChange={(next) => setSelectedModelId(next)}
                  />
                ) : (
                  <p className="gen-empty">
                    {isVideo
                      ? "No cloud model available. Add a FAL_KEY on the server to generate video."
                      : "No generator available. Connect a local Stable Diffusion server, or add a FAL_KEY on the server."}
                  </p>
                )}
              </label>

              {error ? <p className="gen-error">{error}</p> : null}

              {ranked.length > 0 && ranked.find((r) => r.model.id === selectedModelId)?.model.provider !== "local" ? (
                <ShadowCostBadge action={`generate.${task.id}`} units={isVideo ? durationSeconds : 1} />
              ) : null}

              <button type="button" className="gen-generate" disabled={!canGenerate} onClick={() => void handleGenerate()}>
                {running ? `${note || "Generating"} · ${progress}%` : "Generate"}
              </button>
            </div>

            <div className="gen-studio-results">
              {history.length === 0 ? (
                <div className="gen-results-empty">
                  <Sparkles size={22} />
                  <p>Generated assets appear here and in your media bin.</p>
                </div>
              ) : (
                <div className="gen-grid">
                  {history.map((item) => (
                    <div key={item.key} className="gen-card">
                      {item.asset.fileType.startsWith("video/") ? (
                        <video src={item.asset.fileUrl} className="gen-card-media" muted loop playsInline />
                      ) : (
                        <img src={item.asset.fileUrl} alt={item.prompt || "Generated asset"} className="gen-card-media" />
                      )}
                      <div className="gen-card-meta">
                        <span className="gen-card-model">
                          {item.modelLabel}
                          <span className={`gen-tier gen-tier-${item.tier}`}>{item.tier === "browser" ? "local" : "cloud"}</span>
                        </span>
                        {onAddToTimeline ? (
                          <button type="button" className="gen-ghost" onClick={() => onAddToTimeline(item.asset)}>
                            Add to timeline
                          </button>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
