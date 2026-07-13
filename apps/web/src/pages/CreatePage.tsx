import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, ChevronDown, FilePlus2, LayoutTemplate, Sparkles } from "lucide-react";
import { templateDefinitions, type TemplateDefinition } from "@kimera-by-aelivion/shared";
import { UploadDropzone } from "../components/UploadDropzone";
import { createAsset, createProject, listTemplates } from "../lib/api";

export function CreatePage() {
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [templates, setTemplates] = useState<TemplateDefinition[]>(templateDefinitions);
  const [templateId, setTemplateId] = useState(templateDefinitions[0]?.id ?? "");
  const [title, setTitle] = useState("My Kimera edit");
  const [prompt, setPrompt] = useState("Make this like a fast product promo with bold price text.");
  const [orientation, setOrientation] = useState<"portrait" | "landscape">("portrait");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    listTemplates().then((items) => {
      setTemplates(items);
      setTemplateId(items[0]?.id ?? "");
    });
  }, []);

  async function create(mode: "template" | "prompt" | "blank") {
    setBusy(true);
    // Only mint an asset when the user actually uploaded a file. Fabricating a placeholder
    // "creator-upload.mp4" asset for an empty create was exactly what seeded a black clip on
    // "Open empty editor": createDefaultComposition saw a truthy assetId and added a media layer
    // whose asset has no bytes → an empty black video.
    const metadata = file ? await readMediaMetadata(file) : undefined;
    const asset = file
      ? await createAsset({
          file,
          fileName: file.name,
          durationSeconds: metadata?.durationSeconds,
          width: metadata?.width,
          height: metadata?.height
        })
      : undefined;
    const project = await createProject({
      title,
      templateId: mode === "template" ? templateId : undefined,
      prompt: mode === "prompt" ? prompt : undefined,
      sourceAssetId: asset?.id,
      orientation
    });
    navigate(`/editor/${project.id}`);
  }

  return (
    <div className="mkt-page">
      <section className="mkt-hero" style={{ padding: "64px 0 12px" }}>
        <div className="mkt-wrap mkt-hero-inner">
          <span className="mkt-eyebrow">Create</span>
          <h1 style={{ fontSize: "clamp(32px, 4.4vw, 52px)" }}>
            Start from a video. <span className="mkt-grad">Shape it your way.</span>
          </h1>
          <p className="mkt-sub">
            Bring a clip, then pick a template, describe it, or open a blank timeline. Every path lands in
            the same fully editable editor — nothing is baked in.
          </p>
        </div>
      </section>

      <div className="mkt-wrap mkt-narrow">
        <div className="mkt-flow-step">
          <span className="mkt-flow-label">Step 1</span>
          <h2>Bring your footage</h2>
          <p className="sub">Drop a video, image, or audio file. It stays on your machine until you export.</p>
          <UploadDropzone file={file} onFile={setFile} />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 28, marginTop: 18, alignItems: "flex-end" }}>
            <label className="mkt-field" style={{ flex: "1 1 260px", maxWidth: 420 }}>
              <span>Project title</span>
              <input className="mkt-input" value={title} onChange={(event) => setTitle(event.target.value)} />
            </label>
            <div className="mkt-field">
              <span>Canvas</span>
              <div className="mkt-seg" role="group" aria-label="Canvas orientation">
                <button type="button" aria-pressed={orientation === "portrait"} onClick={() => setOrientation("portrait")}>
                  <span className="glyph portrait" /> Portrait <span style={{ color: "var(--mkt-text-dim)", fontFamily: "var(--mkt-mono)", fontSize: 11 }}>9:16</span>
                </button>
                <button type="button" aria-pressed={orientation === "landscape"} onClick={() => setOrientation("landscape")}>
                  <span className="glyph landscape" /> Landscape <span style={{ color: "var(--mkt-text-dim)", fontFamily: "var(--mkt-mono)", fontSize: 11 }}>16:9</span>
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="mkt-flow-step" style={{ paddingBottom: 100 }}>
          <span className="mkt-flow-label">Step 2</span>
          <h2>Choose how to start</h2>
          <p className="sub">Pick one — you can add, remove, and re-edit everything once the editor opens.</p>

          <div className="mkt-start-row">
            <div className="mkt-start-info">
              <span className="mkt-ic"><LayoutTemplate size={18} /></span>
              <div>
                <h3>Start from a template</h3>
                <p>Reusable module stacks — captions, follow-text, background removal, and more.</p>
              </div>
            </div>
            <div className="mkt-start-action">
              <TemplatePicker templates={templates} value={templateId} onChange={setTemplateId} />
              <button type="button" className="mkt-linkbtn" disabled={busy} onClick={() => create("template")}>
                {busy ? "Creating…" : "Use template"} <ArrowRight size={15} />
              </button>
            </div>
          </div>

          <div className="mkt-start-row mkt-start-featured">
            <div className="mkt-start-info">
              <span className="mkt-ic"><Sparkles size={18} /></span>
              <div>
                <h3>Describe it with a prompt</h3>
                <p>Kimera plans a starting graph from your words — you edit everything after.</p>
              </div>
            </div>
            <div className="mkt-start-action">
              <label className="mkt-field">
                <span>Prompt</span>
                <textarea className="mkt-textarea" value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={3} />
              </label>
              <button type="button" className="mkt-linkbtn" disabled={busy} onClick={() => create("prompt")}>
                {busy ? "Planning…" : "Plan graph"} <ArrowRight size={15} />
              </button>
            </div>
          </div>

          <div className="mkt-start-row">
            <div className="mkt-start-info">
              <span className="mkt-ic"><FilePlus2 size={18} /></span>
              <div>
                <h3>Continue without a template</h3>
                <p>Open a blank timeline with just your footage and build from scratch.</p>
              </div>
            </div>
            <div className="mkt-start-action">
              <button type="button" className="mkt-linkbtn" disabled={busy} onClick={() => create("blank")}>
                {busy ? "Opening…" : "Open empty editor"} <ArrowRight size={15} />
              </button>
            </div>
          </div>
        </div>
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

function TemplatePicker({
  templates,
  value,
  onChange
}: {
  templates: TemplateDefinition[];
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selected = templates.find((template) => template.id === value) ?? templates[0];

  useEffect(() => {
    function closeOnOutsideClick(event: MouseEvent) {
      if (rootRef.current?.contains(event.target as Node)) {
        return;
      }
      setOpen(false);
    }

    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, []);

  return (
    <div className="mkt-select" ref={rootRef}>
      <span style={{ fontFamily: "var(--mkt-mono)", fontSize: 10, letterSpacing: ".12em", textTransform: "uppercase", color: "var(--mkt-text-dim)" }}>
        Reel stack
      </span>
      <button
        aria-expanded={open}
        className="mkt-select-trigger"
        type="button"
        onClick={() => setOpen((prev) => !prev)}
      >
        <span>{selected?.name ?? "Choose template"}</span>
        <ChevronDown size={16} />
      </button>
      {open ? (
        <div className="mkt-select-menu" role="listbox">
          {templates.map((template) => (
            <button
              aria-selected={template.id === value}
              className={template.id === value ? "is-selected" : ""}
              key={template.id}
              role="option"
              type="button"
              onClick={() => {
                onChange(template.id);
                setOpen(false);
              }}
            >
              <strong>{template.name}</strong>
              <span>{template.durationSeconds}s · {template.requiredModules.length} modules</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
