import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { getToolCapability } from "@orreris/shared";
import { createAsset } from "../lib/api";

/**
 * Generative Stylize (stylize engine P6 v1, plans/stylize-anime-engine.md) — single-frame
 * generative redraw over the PROMPT BRIDGE: the page builds a fidelity-locked style prompt, the
 * user runs it in their own chat AI for free, and the redrawn image comes back in as a local-first
 * `source:"ai"` media-library asset carrying its prompt (`AssetAiRef`). The cloud diffusion
 * adapter stays a contract stub (registry lists `cloud`; per-use pricing later, metadata only).
 *
 * Deliberately NOT a video path: per-frame diffusion boils frame to frame — the deterministic
 * Stylize timeline effect is the video path, and the page says so (the honesty line).
 */

interface StylePreset {
  id: string;
  label: string;
  directive: string;
}

const STYLE_PRESETS: StylePreset[] = [
  {
    id: "anime-film",
    label: "Anime feature film",
    directive:
      "a high-quality 2D anime feature-film still: clean confident line art, cel shading with two or three tones per surface, painterly background, soft cinematic lighting, rich saturated palette"
  },
  {
    id: "comic-print",
    label: "Comic print",
    directive:
      "a printed comic-book panel: bold black ink outlines, halftone dot shading, slightly misregistered color plates, flat punchy colors on paper texture, dynamic graphic composition"
  },
  {
    id: "watercolor",
    label: "Watercolor",
    directive:
      "a hand-painted watercolor illustration: soft pigment washes, wet-on-wet gradients, visible paper grain, loose but accurate edges, gentle natural palette"
  },
  {
    id: "cg-character",
    label: "3D animated film",
    directive:
      "a modern 3D animated feature-film render: stylized appealing character proportions, soft global illumination, subsurface-scattered skin, crisp rim lighting, shallow depth of field"
  },
  {
    id: "custom",
    label: "Custom style…",
    directive: ""
  }
];

// The fidelity lock is the product: without it chat AIs freely recompose. Every preset shares it.
const FIDELITY_LOCK =
  "Keep the EXACT same composition, camera angle, framing, pose, and aspect ratio as the input image. " +
  "Preserve the identity, clothing, expression, and scene content — change ONLY the rendering style. " +
  "Do not add text, watermarks, borders, or new objects. Return a single finished image.";

function buildPrompt(preset: StylePreset, custom: string): string {
  const directive = preset.id === "custom" ? custom.trim() || "the art style described by the user" : preset.directive;
  return `Redraw the attached image as ${directive}. ${FIDELITY_LOCK}`;
}

/**
 * Integrated path (P6 completion): direct browser → Gemini image-output call with the USER'S OWN
 * API key — the key lives in localStorage only and never touches Orreris servers. This is the
 * monetization doctrine in code: the editor stays free, generation costs are the user's own
 * provider COGS, credits stay 0.
 */
const GEMINI_IMAGE_MODEL = "gemini-2.5-flash-image";
const GEMINI_KEY_STORAGE = "orreris.generativeStylize.geminiKey";

/** Downscale + re-encode the source so the request payload stays sane (provider caps + base64 bloat). */
async function fileToInlineData(file: File, maxEdge = 1536): Promise<{ mimeType: string; data: string }> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Could not read image"));
      el.src = url;
    });
    const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d")!.drawImage(img, 0, 0, w, h);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
    return { mimeType: "image/jpeg", data: dataUrl.slice(dataUrl.indexOf(",") + 1) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function base64ToFile(base64: string, mimeType: string, name: string): File {
  const bytes = atob(base64);
  const buf = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
  return new File([buf], name, { type: mimeType });
}

async function generateWithGemini(apiKey: string, prompt: string, source: File): Promise<File> {
  const inline = await fileToInlineData(source);
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: prompt }, { inlineData: { mimeType: inline.mimeType, data: inline.data } }]
          }
        ]
      })
    }
  );
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const err = (await res.json()) as { error?: { message?: string } };
      if (err.error?.message) detail = err.error.message;
    } catch {
      /* status alone */
    }
    throw new Error(detail);
  }
  const body = (await res.json()) as {
    candidates?: { content?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] } }[];
  };
  const part = body.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!part?.inlineData?.data) {
    throw new Error("The model returned no image (it may have declined this content). Try the free prompt path.");
  }
  return base64ToFile(part.inlineData.data, part.inlineData.mimeType ?? "image/png", "stylized-frame.png");
}

function readImageDimensions(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read image"));
    };
    img.src = url;
  });
}

function firstImageFile(items: DataTransferItemList | FileList | null | undefined): File | null {
  if (!items) return null;
  for (const item of Array.from(items as ArrayLike<DataTransferItem | File> as (DataTransferItem | File)[])) {
    if (item instanceof File) {
      if (item.type.startsWith("image/")) return item;
    } else if (item.kind === "file" && item.type.startsWith("image/")) {
      return item.getAsFile();
    }
  }
  return null;
}

interface PickedImage {
  file: File;
  url: string;
  width: number;
  height: number;
}

export function GenerativeStylizePage() {
  const tool = getToolCapability("generative-stylize");
  const [source, setSource] = useState<PickedImage | undefined>();
  const [result, setResult] = useState<PickedImage | undefined>();
  const [presetId, setPresetId] = useState(STYLE_PRESETS[0]!.id);
  const [customStyle, setCustomStyle] = useState("");
  const [status, setStatus] = useState("");
  const [copied, setCopied] = useState(false);
  const [savedAssetName, setSavedAssetName] = useState("");
  const [busy, setBusy] = useState(false);
  const [apiKey, setApiKey] = useState(() => {
    try {
      return window.localStorage.getItem(GEMINI_KEY_STORAGE) ?? "";
    } catch {
      return "";
    }
  });
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState("");
  const sourceInputRef = useRef<HTMLInputElement>(null);
  const resultInputRef = useRef<HTMLInputElement>(null);

  const preset = STYLE_PRESETS.find((p) => p.id === presetId) ?? STYLE_PRESETS[0]!;
  const prompt = useMemo(() => buildPrompt(preset, customStyle), [preset, customStyle]);

  useEffect(() => {
    return () => {
      if (source) URL.revokeObjectURL(source.url);
    };
  }, [source]);
  useEffect(() => {
    return () => {
      if (result) URL.revokeObjectURL(result.url);
    };
  }, [result]);

  // Paste-anywhere: after the user copies the generated image in their chat AI, Ctrl+V on this
  // page lands it as the result (or as the source if none is loaded yet).
  useEffect(() => {
    function onPaste(event: ClipboardEvent) {
      const file = firstImageFile(event.clipboardData?.items ?? null);
      if (!file) return;
      event.preventDefault();
      void acceptImage(file, source ? "result" : "source");
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  async function acceptImage(file: File, slot: "source" | "result") {
    try {
      const { width, height } = await readImageDimensions(file);
      const picked: PickedImage = { file, url: URL.createObjectURL(file), width, height };
      if (slot === "source") {
        setSource(picked);
        setResult(undefined);
        setSavedAssetName("");
        setStatus("");
      } else {
        setResult(picked);
        setSavedAssetName("");
        setStatus("");
      }
    } catch {
      setStatus("That file could not be read as an image.");
    }
  }

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setStatus("Clipboard blocked — select the prompt text and copy manually.");
    }
  }

  async function saveResult() {
    if (!result) return;
    setBusy(true);
    setStatus("");
    try {
      const baseName = source?.file.name.replace(/\.[a-z0-9]+$/i, "") || "frame";
      const fileName = `${baseName}-${preset.id === "custom" ? "stylized" : preset.id}.png`;
      const asset = await createAsset({
        file: result.file,
        fileName,
        fileType: result.file.type || "image/png",
        width: result.width,
        height: result.height,
        durationSeconds: 6,
        source: "ai",
        localOnly: true,
        ai: { prompt },
        tags: ["generative-stylize"]
      });
      setSavedAssetName(asset.originalName ?? fileName);
      setStatus("");
    } catch {
      setStatus("Saving failed — you can still Download and import the file manually.");
    } finally {
      setBusy(false);
    }
  }

  function updateApiKey(value: string) {
    setApiKey(value);
    try {
      if (value) window.localStorage.setItem(GEMINI_KEY_STORAGE, value);
      else window.localStorage.removeItem(GEMINI_KEY_STORAGE);
    } catch {
      /* private-mode storage denial: the key still works for this session */
    }
  }

  async function generateDirectly() {
    if (!source || !apiKey.trim() || generating) return;
    setGenerating(true);
    setGenerateError("");
    try {
      const file = await generateWithGemini(apiKey.trim(), prompt, source.file);
      await acceptImage(file, "result");
    } catch (error) {
      setGenerateError(error instanceof Error ? error.message : "Generation failed.");
    } finally {
      setGenerating(false);
    }
  }

  function downloadResult() {
    if (!result) return;
    const a = document.createElement("a");
    a.href = result.url;
    a.download = "stylized-frame.png";
    a.click();
  }

  function dropZone(slot: "source" | "result") {
    return {
      onDragOver: (e: React.DragEvent) => e.preventDefault(),
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        const file = firstImageFile(e.dataTransfer.items ?? e.dataTransfer.files);
        if (file) void acceptImage(file, slot);
      }
    };
  }

  if (!tool) return null;

  return (
    <div className="mkt-section" style={{ paddingTop: 48 }}>
      <div className="mkt-wrap" style={{ maxWidth: 880 }}>
        <p style={{ marginBottom: 8 }}>
          <Link to="/tools" className="mkt-linkbtn">← All tools</Link>
        </p>
        <h1 style={{ fontSize: "clamp(28px, 3.6vw, 40px)" }}>{tool.name}</h1>
        <p className="mkt-sub" style={{ marginTop: 8 }}>{tool.userDescription}</p>

        {/* The honesty line — generative redraw is a still-image tool by design. */}
        <p style={{ opacity: 0.75, fontSize: 14, margin: "12px 0 28px" }}>
          Styling a whole <strong>video</strong>? Use the <strong>Stylize</strong> effect in the editor — it is
          temporally stable and free. Generative redraw works one frame at a time and would flicker on video.
        </p>

        {/* 1 — Source */}
        <section style={{ marginBottom: 28 }}>
          <h3>1 · Source frame</h3>
          <p style={{ opacity: 0.8, fontSize: 14 }}>
            Drop, paste, or pick the image to redraw. From the editor, pause on the frame you want and use the
            viewer's save-frame action first.
          </p>
          <div
            {...dropZone("source")}
            onClick={() => sourceInputRef.current?.click()}
            style={{
              border: "1px dashed rgba(128,128,128,0.5)",
              borderRadius: 10,
              padding: source ? 8 : 36,
              textAlign: "center",
              cursor: "pointer"
            }}
          >
            {source ? (
              <img src={source.url} alt="Source" style={{ maxWidth: "100%", maxHeight: 320, borderRadius: 6 }} />
            ) : (
              <span style={{ opacity: 0.7 }}>Drop / paste / click to choose an image</span>
            )}
          </div>
          <input
            ref={sourceInputRef}
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void acceptImage(file, "source");
              e.target.value = "";
            }}
          />
        </section>

        {/* 2 — Style + prompt */}
        <section style={{ marginBottom: 28 }}>
          <h3>2 · Style</h3>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "10px 0" }}>
            {STYLE_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                className="mkt-chip"
                onClick={() => setPresetId(p.id)}
                style={{
                  cursor: "pointer",
                  border: p.id === presetId ? "1px solid currentColor" : "1px solid transparent",
                  fontWeight: p.id === presetId ? 600 : 400
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
          {preset.id === "custom" ? (
            <textarea
              value={customStyle}
              onChange={(e) => setCustomStyle(e.target.value)}
              placeholder="Describe the art style (e.g. 'a 1960s screen-printed travel poster with three flat spot colors')"
              rows={2}
              style={{ width: "100%", marginBottom: 10 }}
            />
          ) : null}
          <textarea readOnly value={prompt} rows={4} style={{ width: "100%", opacity: 0.85, fontSize: 13 }} />
          <div style={{ display: "flex", gap: 10, marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button type="button" className="mkt-linkbtn" onClick={() => void copyPrompt()}>
              {copied ? "Copied ✓" : "Copy prompt"}
            </button>
            <span style={{ fontSize: 13, opacity: 0.75 }}>
              Free path: paste the prompt + your image into any chat AI (ChatGPT, Gemini, Claude…), then bring the
              generated image back below.
            </span>
          </div>

          {/* Integrated path: user's own key, browser → provider direct, key never leaves the device. */}
          <div
            style={{
              marginTop: 16,
              padding: 14,
              border: "1px solid rgba(128,128,128,0.35)",
              borderRadius: 10
            }}
          >
            <strong style={{ fontSize: 14 }}>Or generate right here (your own key)</strong>
            <p style={{ fontSize: 13, opacity: 0.75, margin: "6px 0 10px" }}>
              Paste a Google AI Studio API key and Orreris calls <code>{GEMINI_IMAGE_MODEL}</code> directly from your
              browser. The key is stored only on this device and generation is billed to your own Google account —
              Orreris adds nothing on top.
            </p>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => updateApiKey(e.target.value)}
                placeholder="Gemini API key (AIza…)"
                autoComplete="off"
                style={{ flex: "1 1 260px", minWidth: 220 }}
              />
              <button
                type="button"
                className="mkt-linkbtn"
                disabled={!source || !apiKey.trim() || generating}
                onClick={() => void generateDirectly()}
              >
                {generating ? "Generating…" : "Generate"}
              </button>
            </div>
            {!source && apiKey.trim() ? (
              <p style={{ fontSize: 13, opacity: 0.7, marginTop: 8 }}>Add a source frame above first.</p>
            ) : null}
            {generateError ? (
              <p style={{ color: "#e07070", fontSize: 13, marginTop: 8 }}>Generation failed: {generateError}</p>
            ) : null}
          </div>
        </section>

        {/* 3 — Result */}
        <section style={{ marginBottom: 28 }}>
          <h3>3 · Result</h3>
          <div
            {...dropZone("result")}
            onClick={() => resultInputRef.current?.click()}
            style={{
              border: "1px dashed rgba(128,128,128,0.5)",
              borderRadius: 10,
              padding: result ? 8 : 28,
              textAlign: "center",
              cursor: "pointer"
            }}
          >
            {result ? (
              <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
                {source ? (
                  <figure style={{ margin: 0, maxWidth: "48%" }}>
                    <img src={source.url} alt="Before" style={{ maxWidth: "100%", borderRadius: 6 }} />
                    <figcaption style={{ fontSize: 12, opacity: 0.7 }}>Before</figcaption>
                  </figure>
                ) : null}
                <figure style={{ margin: 0, maxWidth: source ? "48%" : "100%" }}>
                  <img src={result.url} alt="After" style={{ maxWidth: "100%", borderRadius: 6 }} />
                  <figcaption style={{ fontSize: 12, opacity: 0.7 }}>After</figcaption>
                </figure>
              </div>
            ) : (
              <span style={{ opacity: 0.7 }}>Drop / paste / click to add the generated image</span>
            )}
          </div>
          <input
            ref={resultInputRef}
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void acceptImage(file, "result");
              e.target.value = "";
            }}
          />
        </section>

        {/* 4 — Apply */}
        <section style={{ marginBottom: 40 }}>
          <h3>4 · Use it</h3>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <button type="button" className="mkt-linkbtn" disabled={!result || busy} onClick={() => void saveResult()}>
              {busy ? "Saving…" : "Save to media library"}
            </button>
            <button type="button" className="mkt-linkbtn" disabled={!result} onClick={downloadResult}>
              Download
            </button>
            {savedAssetName ? (
              <span style={{ fontSize: 13, opacity: 0.8 }}>
                Saved as <strong>{savedAssetName}</strong> — find it in the editor's Assets panel under <strong>AI</strong>
                (stored on this device; carries its prompt).
              </span>
            ) : null}
          </div>
          {status ? <p style={{ color: "#e07070", fontSize: 13, marginTop: 8 }}>{status}</p> : null}
        </section>
      </div>
    </div>
  );
}
