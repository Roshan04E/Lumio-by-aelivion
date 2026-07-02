import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown, Sparkles } from "lucide-react";
import { templateDefinitions, type TemplateDefinition } from "@lumio-by-aelivion/shared";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { UploadDropzone } from "../components/UploadDropzone";
import { createAsset, createProject, listTemplates } from "../lib/api";

export function CreatePage() {
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [templates, setTemplates] = useState<TemplateDefinition[]>(templateDefinitions);
  const [templateId, setTemplateId] = useState(templateDefinitions[0]?.id ?? "");
  const [title, setTitle] = useState("My Lumio edit");
  const [prompt, setPrompt] = useState("Make this like a fast product promo with bold price text.");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    listTemplates().then((items) => {
      setTemplates(items);
      setTemplateId(items[0]?.id ?? "");
    });
  }, []);

  async function create(mode: "template" | "prompt") {
    setBusy(true);
    const metadata = file ? await readMediaMetadata(file) : undefined;
    const asset = await createAsset({
      file: file ?? undefined,
      fileName: file?.name ?? "creator-upload.mp4",
      durationSeconds: metadata?.durationSeconds,
      width: metadata?.width,
      height: metadata?.height
    });
    const project = await createProject({
      title,
      templateId: mode === "template" ? templateId : undefined,
      prompt: mode === "prompt" ? prompt : undefined,
      sourceAssetId: asset.id
    });
    navigate(`/editor/${project.id}`);
  }

  return (
    <div className="page create-page">
      <section className="page-heading">
        <Badge tone="lime">Create</Badge>
        <h1>Start from a video</h1>
        <p>Template projects and prompt-planned projects both become editable graphs.</p>
      </section>

      <div className="create-grid">
        <Card className="create-card">
          <UploadDropzone file={file} onFile={setFile} />
          <label className="field-control">
            <span>Project title</span>
            <input value={title} onChange={(event) => setTitle(event.target.value)} />
          </label>
        </Card>

        <Card className="create-card">
          <h2>Template</h2>
          <TemplatePicker templates={templates} value={templateId} onChange={setTemplateId} />
          <Button disabled={busy} onClick={() => create("template")}>
            Use Template
          </Button>
        </Card>

        <Card className="create-card">
          <h2>Prompt Planner</h2>
          <label className="prompt-box">
            <span>Prompt</span>
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={6} />
          </label>
          <Button icon={<Sparkles size={16} />} disabled={busy} onClick={() => create("prompt")}>
            Plan Graph
          </Button>
        </Card>
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
    <div className="field-control template-picker" ref={rootRef}>
      <span>Reel stack</span>
      <button
        aria-expanded={open}
        className="template-picker-trigger"
        type="button"
        onClick={() => setOpen((value) => !value)}
      >
        <span>{selected?.name ?? "Choose template"}</span>
        <ChevronDown size={16} />
      </button>
      {open ? (
        <div className="template-picker-menu" role="listbox">
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
