import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, ArrowRight, Clapperboard, Wand2 } from "lucide-react";
import type { ModuleType } from "@orreris/shared";
import { UploadDropzone } from "../components/UploadDropzone";
import { createAsset, createProject } from "../lib/api";
import { usePro } from "../lib/proMode";

type Step = "upload" | "style" | "prompt";
type Intent = "manual" | "ai";
type Orientation = "portrait" | "landscape";

interface CreatePreset {
  id: string;
  icon: string;
  label: string;
  /** Forces a canvas orientation (undefined → use the detected/overridden orientation). */
  orientation?: Orientation;
  /** Frame rate — e.g. Cinematic → 24, everything else → 30. */
  fps?: number;
  /** Target length for a footage-less draft (ignored once real footage is attached — it wins). */
  durationHint?: number;
  /** Starting module stack seeded onto the project (manual path). */
  effects: ModuleType[];
  /** Prepended to the user's words on the AI path so the planner has the goal. */
  aiSeed: string;
}

// Create-only goal presets — deterministic project properties (canvas + fps + starting module
// stack), NOT tied to the Templates page. Each one lands the user a step ahead; everything stays
// editable in the editor.
const PRESETS: CreatePreset[] = [
  { id: "product-promo", icon: "🎬", label: "Product Promo", orientation: "portrait", fps: 30, durationHint: 15, effects: ["MOTION_TEXT", "ZOOM_CUTS"], aiSeed: "a fast, punchy product promo ad with bold price text" },
  { id: "reel", icon: "📱", label: "Reel", orientation: "portrait", fps: 30, durationHint: 20, effects: ["AUTO_CAPTIONS", "BEAT_SYNC"], aiSeed: "a short vertical social reel with captions" },
  { id: "youtube", icon: "🎥", label: "YouTube Video", orientation: "landscape", fps: 30, effects: ["AUTO_CAPTIONS"], aiSeed: "a YouTube video with a strong hook and clean captions" },
  { id: "cinematic", icon: "✨", label: "Cinematic", orientation: "landscape", fps: 24, effects: [], aiSeed: "a cinematic, moody edit with graded color" },
  { id: "presentation", icon: "💼", label: "Presentation", orientation: "landscape", fps: 30, effects: ["MOTION_TEXT"], aiSeed: "a clean, corporate presentation-style video" },
  { id: "blank", icon: "➕", label: "Blank Project", fps: 30, effects: [], aiSeed: "" }
];

interface Detected {
  width: number;
  height: number;
  durationSeconds: number;
  orientation: Orientation;
}

export function CreatePage() {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [detected, setDetected] = useState<Detected | null>(null);
  const [intent, setIntent] = useState<Intent>("manual");
  const [preset, setPreset] = useState<CreatePreset | null>(null);
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("My Orreris edit");
  const [orientationOverride, setOrientationOverride] = useState<"auto" | Orientation>("auto");
  const [busy, setBusy] = useState(false);
  const [pro] = usePro();

  const effectiveOrientation: Orientation =
    orientationOverride !== "auto" ? orientationOverride : detected?.orientation ?? "portrait";

  async function handleFile(next: File | null) {
    setFile(next);
    if (!next) {
      setDetected(null);
      return;
    }
    const meta = await readMediaMetadata(next);
    setDetected({
      width: meta.width,
      height: meta.height,
      durationSeconds: meta.durationSeconds,
      orientation: meta.width >= meta.height ? "landscape" : "portrait"
    });
  }

  async function startEditor(opts: {
    orientation: Orientation;
    fps?: number | undefined;
    effects?: ModuleType[] | undefined;
    durationSeconds?: number | undefined;
    prompt?: string | undefined;
  }) {
    setBusy(true);
    try {
      const asset = file
        ? await createAsset({
            file,
            fileName: file.name,
            durationSeconds: detected?.durationSeconds,
            width: detected?.width,
            height: detected?.height
          })
        : undefined;
      const project = await createProject({
        title,
        sourceAssetId: asset?.id,
        orientation: opts.orientation,
        ...(opts.fps !== undefined ? { fps: opts.fps } : {}),
        ...(opts.effects && opts.effects.length ? { effects: opts.effects } : {}),
        ...(opts.durationSeconds !== undefined ? { durationSeconds: opts.durationSeconds } : {}),
        ...(opts.prompt !== undefined ? { prompt: opts.prompt } : {})
      });
      navigate(`/editor/${project.id}`);
    } catch {
      setBusy(false); // stay on the flow so the user can retry
    }
  }

  function choosePreset(option: CreatePreset) {
    setPreset(option);
    const orientation = option.orientation ?? effectiveOrientation;
    // Blank always jumps straight in; AI (Pro) collects a prompt next; manual seeds the preset stack.
    if (option.id === "blank") {
      void startEditor({ orientation, fps: option.fps });
    } else if (intent === "ai" && pro) {
      setStep("prompt");
    } else {
      void startEditor({ orientation, fps: option.fps, effects: option.effects, durationSeconds: option.durationHint });
    }
  }

  function generateDraft() {
    const combined = [preset?.aiSeed, prompt.trim()].filter(Boolean).join(". ");
    void startEditor({
      orientation: preset?.orientation ?? effectiveOrientation,
      fps: preset?.fps,
      prompt: combined || "Make a short, engaging edit from this video"
    });
  }

  return (
    <div className="mkt-page create-page">
      <div className="create-shell">
        {step === "upload" ? (
          <div className="create-stage">
            <span className="mkt-eyebrow">Create a new project</span>
            <h1>Start with your video.</h1>

            <UploadDropzone file={file} onFile={handleFile} />
            {detected ? (
              <p className="create-detected">
                Detected {detected.width}×{detected.height} ·{" "}
                {effectiveOrientation === "landscape" ? "Landscape 16:9" : "Portrait 9:16"}
                {orientationOverride === "auto" ? " · auto" : ""}
              </p>
            ) : null}

            <div className="create-section">
              <h2>How do you want to edit?</h2>
              <div className="create-choice">
                <button
                  type="button"
                  className={`create-choice-card${intent === "manual" ? " is-active" : ""}`}
                  onClick={() => setIntent("manual")}
                >
                  <Clapperboard size={20} />
                  <strong>Edit it myself</strong>
                  <span>Jump straight into the editor.</span>
                </button>
                <button
                  type="button"
                  className={`create-choice-card${intent === "ai" ? " is-active" : ""}${pro ? "" : " is-locked"}`}
                  onClick={() => { if (pro) setIntent("ai"); }}
                  disabled={!pro}
                  title={pro ? undefined : "Pro feature — turn on Pro in the header to use AI planning"}
                >
                  <span className="create-pro-pill">Pro</span>
                  <Wand2 size={20} />
                  <strong>Help me with AI</strong>
                  <span>{pro ? "Orreris drafts a starting edit." : "Turn on Pro to use AI planning."}</span>
                </button>
              </div>
            </div>

            <details className="create-settings">
              <summary>⚙ Project settings</summary>
              <div className="create-settings-body">
                <label className="mkt-field">
                  <span>Project title</span>
                  <input className="mkt-input" value={title} onChange={(event) => setTitle(event.target.value)} />
                </label>
                <div className="mkt-field">
                  <span>Aspect ratio</span>
                  <div className="mkt-seg" role="group" aria-label="Aspect ratio">
                    <button type="button" aria-pressed={orientationOverride === "auto"} onClick={() => setOrientationOverride("auto")}>
                      Auto
                    </button>
                    <button type="button" aria-pressed={orientationOverride === "portrait"} onClick={() => setOrientationOverride("portrait")}>
                      <span className="glyph portrait" /> Portrait
                    </button>
                    <button type="button" aria-pressed={orientationOverride === "landscape"} onClick={() => setOrientationOverride("landscape")}>
                      <span className="glyph landscape" /> Landscape
                    </button>
                  </div>
                </div>
              </div>
            </details>

            <div className="create-nav">
              <button type="button" className="mkt-btn mkt-btn-primary create-primary" onClick={() => setStep("style")}>
                Continue <ArrowRight size={16} />
              </button>
            </div>
          </div>
        ) : null}

        {step === "style" ? (
          <div className="create-stage">
            <button type="button" className="create-back" onClick={() => setStep("upload")}>
              <ArrowLeft size={15} /> Back
            </button>
            <span className="mkt-eyebrow">{file ? "Your video is ready" : "New project"}</span>
            <h1>What do you want to make?</h1>
            <p className="mkt-sub">
              {intent === "ai"
                ? "Pick a starting point — you'll describe the details next."
                : "Pick a starting point — everything stays editable in the editor."}
            </p>
            <div className="create-styles">
              {PRESETS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className="create-style-card"
                  disabled={busy}
                  onClick={() => choosePreset(option)}
                >
                  <span className="create-style-ic" aria-hidden="true">{option.icon}</span>
                  <strong>{option.label}</strong>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {step === "prompt" ? (
          <div className="create-stage create-stage-narrow">
            <button type="button" className="create-back" onClick={() => setStep("style")}>
              <ArrowLeft size={15} /> Back
            </button>
            <span className="mkt-eyebrow">{preset?.label ?? "AI draft"}</span>
            <h1>Describe your video.</h1>
            <textarea
              className="mkt-textarea create-prompt"
              placeholder="e.g. Turn this into a fast product ad with bold price text"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={3}
            />
            <div className="create-nav">
              <button type="button" className="mkt-btn mkt-btn-primary create-primary" disabled={busy} onClick={generateDraft}>
                {busy ? "Generating…" : "Generate draft"} <ArrowRight size={16} />
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function readMediaMetadata(file: File) {
  if (file.type.startsWith("video/")) {
    return new Promise<{ durationSeconds: number; width: number; height: number }>((resolve) => {
      const url = URL.createObjectURL(file);
      const video = document.createElement("video");
      video.preload = "metadata";
      video.onloadedmetadata = () => {
        URL.revokeObjectURL(url);
        resolve({
          durationSeconds: clamp(Number.isFinite(video.duration) ? video.duration : 12, 0.2, 7200),
          width: Math.max(320, video.videoWidth || 1080),
          height: Math.max(320, video.videoHeight || 1920)
        });
      };
      video.onerror = () => {
        URL.revokeObjectURL(url);
        resolve({ durationSeconds: 12, width: 1080, height: 1920 });
      };
      video.src = url;
    });
  }

  if (file.type.startsWith("image/")) {
    return new Promise<{ durationSeconds: number; width: number; height: number }>((resolve) => {
      const url = URL.createObjectURL(file);
      const image = new window.Image();
      image.onload = () => {
        URL.revokeObjectURL(url);
        resolve({
          durationSeconds: 3,
          width: Math.max(320, image.naturalWidth || 1080),
          height: Math.max(320, image.naturalHeight || 1920)
        });
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        resolve({ durationSeconds: 3, width: 1080, height: 1920 });
      };
      image.src = url;
    });
  }

  if (file.type.startsWith("audio/")) {
    return new Promise<{ durationSeconds: number; width: number; height: number }>((resolve) => {
      const url = URL.createObjectURL(file);
      const audio = document.createElement("audio");
      audio.preload = "metadata";
      audio.onloadedmetadata = () => {
        URL.revokeObjectURL(url);
        resolve({
          durationSeconds: clamp(Number.isFinite(audio.duration) ? audio.duration : 12, 0.2, 7200),
          width: 1080,
          height: 1920
        });
      };
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        resolve({ durationSeconds: 12, width: 1080, height: 1920 });
      };
      audio.src = url;
    });
  }

  return Promise.resolve({ durationSeconds: 12, width: 1080, height: 1920 });
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
