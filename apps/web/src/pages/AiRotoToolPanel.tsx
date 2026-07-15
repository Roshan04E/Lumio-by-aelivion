import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Eraser, MinusCircle, MousePointerClick, PlusCircle, Sparkles, Upload, WandSparkles } from "lucide-react";
import {
  applyExtractPersonComposition,
  type ProjectGraph,
  type SourceAsset,
  type ToolCapabilityDefinition
} from "@kimera-by-aelivion/shared";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { CreditBadge } from "../components/CreditBadge";
import { ThemedSelect } from "../editor/inspector/controls/ThemedSelect";
import { addEffect, createProject, patchProject } from "../lib/api";
import { createToolArtifactStore } from "../tools/artifact-store";
import { detectBrowserToolCapabilities } from "../tools/capabilities";
import { detectInitialSubjectBox } from "../tools/local-segmentation";
import {
  chooseSamDeviceProfile,
  getSamSession,
  isSamSupported,
  segmentVideoPrompted,
  type EncodedFrame,
  type SamPoint
} from "../tools/local-sam";
import { storeMatteArtifact, uploadMatteForExport } from "../tools/matte-store";

interface AiRotoToolPanelProps {
  tool: ToolCapabilityDefinition;
  assets: SourceAsset[];
  selectedAssetId: string;
  onSelectAsset: (id: string) => void;
  onUploadAsset: (file: File | null) => Promise<void>;
}

type RotoTab = "upload" | "select" | "preview";
type PromptLabel = 1 | 0; // 1 = include (foreground), 0 = exclude (background)
interface PromptDot extends SamPoint {
  label: PromptLabel;
}

const DISPLAY_WIDTH = 300;
const OUTPUT_FPS = 12;

/**
 * AI roto (Smart Select): point-promptable, ANY-OBJECT subject masking. The user
 * auto-seeds the person, then clicks to ADD any held object (bike, notebook…) or
 * SUBTRACT mistakes — something the person-only matting tools can't do. Runs SlimSAM
 * in the browser (see local-sam.ts): the reference frame is encoded once, each click
 * only runs the cheap decoder for instant preview; "Generate" bakes a per-frame matte
 * that flows through the same artifact pipeline as Extract Person (applyExtractPersonComposition).
 */
export function AiRotoToolPanel({ tool, assets, selectedAssetId, onSelectAsset, onUploadAsset }: AiRotoToolPanelProps) {
  const navigate = useNavigate();
  const selectedAsset = assets.find((asset) => asset.id === selectedAssetId);

  const [activeTab, setActiveTab] = useState<RotoTab>("upload");
  const [mode, setMode] = useState<"add" | "subtract">("add");
  const [points, setPoints] = useState<PromptDot[]>([]);
  const [busy, setBusy] = useState(false);
  const [encoding, setEncoding] = useState(false);
  const [decoding, setDecoding] = useState(false);
  const [status, setStatus] = useState("");
  const [matteUri, setMatteUri] = useState<string | undefined>();

  const frameCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const encodedRef = useRef<EncodedFrame | undefined>(undefined);
  const bakedMaskRef = useRef<Awaited<ReturnType<typeof storeMatteArtifact>>["maskSequence"] | undefined>(undefined);
  const cancelledRef = useRef(false);
  // Decode concurrency guard: a click while a decode is running stores the latest prompt instead of
  // piling up N heavy inferences; the in-flight decode re-runs once with the newest dots when it finishes.
  const decodeBusyRef = useRef(false);
  const pendingDotsRef = useRef<PromptDot[] | null>(null);
  // Guards the prepare-frame effect so it encodes ONCE per asset, never re-entrantly.
  const preparingRef = useRef(false);

  // MUST be memoized: detectBrowserToolCapabilities() returns a fresh object each call, and it feeds the
  // useCallback/useEffect deps below — recomputing it per render makes those identities change every render,
  // which re-fires the prepare-frame effect endlessly (re-encoding until the tab runs Out Of Memory).
  const capabilities = useMemo(() => detectBrowserToolCapabilities(), []);
  const supported = isSamSupported(capabilities);

  const aspect = selectedAsset ? (selectedAsset.height || 1280) / (selectedAsset.width || 720) : 16 / 9;
  const displayWidth = DISPLAY_WIDTH;
  const displayHeight = Math.round(DISPLAY_WIDTH * aspect);

  // Draw a tinted overlay of the current mask + the prompt dots.
  const drawOverlay = useCallback((mask: Uint8ClampedArray | null, dots: PromptDot[]) => {
    const canvas = overlayCanvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (mask && mask.length === canvas.width * canvas.height * 4) {
      const tint = new ImageData(canvas.width, canvas.height);
      for (let i = 0; i < canvas.width * canvas.height; i += 1) {
        if ((mask[i * 4] ?? 0) > 128) {
          tint.data[i * 4] = 64;
          tint.data[i * 4 + 1] = 220;
          tint.data[i * 4 + 2] = 255;
          tint.data[i * 4 + 3] = 120;
        }
      }
      ctx.putImageData(tint, 0, 0);
    }
    for (const dot of dots) {
      ctx.beginPath();
      ctx.arc(dot.x * canvas.width, dot.y * canvas.height, 6, 0, Math.PI * 2);
      ctx.fillStyle = dot.label === 1 ? "#39d98a" : "#ff5a5a";
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#0b0d12";
      ctx.stroke();
    }
  }, []);

  // Decode the mask for the given prompt dots against the encoded reference frame, then redraw.
  // Coalesces overlapping calls (see decodeBusyRef) so rapid clicks stay responsive.
  const decodeAndDraw = useCallback(
    async (dots: PromptDot[]) => {
      const encoded = encodedRef.current;
      if (!encoded) return;
      if (!dots.length) {
        drawOverlay(null, dots);
        return;
      }
      if (decodeBusyRef.current) {
        pendingDotsRef.current = dots;
        return;
      }
      decodeBusyRef.current = true;
      setDecoding(true);
      try {
        const session = await getSamSession(chooseSamDeviceProfile(capabilities, selectedAsset?.durationSeconds ?? 0));
        const mask = await session.decode(encoded, {
          positive: dots.filter((d) => d.label === 1),
          negative: dots.filter((d) => d.label === 0)
        });
        drawOverlay(mask, dots);
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "Mask preview failed.");
      } finally {
        decodeBusyRef.current = false;
        setDecoding(false);
        const pending = pendingDotsRef.current;
        if (pending) {
          pendingDotsRef.current = null;
          void decodeAndDraw(pending);
        }
      }
    },
    [capabilities, drawOverlay, selectedAsset?.durationSeconds]
  );

  // Draw the reference frame, encode it once for SAM, then auto-seed the person.
  const prepareReferenceFrame = useCallback(async () => {
    const canvas = frameCanvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !selectedAsset?.fileUrl) return;
    if (preparingRef.current) return; // never encode re-entrantly
    preparingRef.current = true;

    setEncoding(true);
    setStatus("Loading the AI selection model…");
    try {
      const video = document.createElement("video");
      video.crossOrigin = "anonymous";
      video.src = selectedAsset.fileUrl;
      video.muted = true;
      video.playsInline = true;
      await new Promise<void>((resolve, reject) => {
        video.onloadeddata = () => resolve();
        video.onerror = () => reject(new Error("Unable to load video frame."));
      });
      await new Promise<void>((resolve) => {
        video.onseeked = () => resolve();
        video.currentTime = Math.min(0.1, video.duration || 0);
      });
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      const session = await getSamSession(chooseSamDeviceProfile(capabilities, selectedAsset.durationSeconds));
      const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
      encodedRef.current = await session.encodeFrame(frame);

      // Auto-seed: drop one "include" point on the detected person so the user starts
      // with a subject already selected and only clicks to add objects / fix edges.
      let seeded: PromptDot[] = [];
      try {
        setStatus("Finding the subject…");
        const box = await detectInitialSubjectBox({
          videoUrl: selectedAsset.fileUrl,
          width: selectedAsset.width || 720,
          height: selectedAsset.height || 1280
        });
        seeded = [{ x: (box.x + box.width / 2) / 100, y: (box.y + box.height / 2) / 100, label: 1 }];
      } catch {
        seeded = [];
      }
      setPoints(seeded);
      await decodeAndDraw(seeded);
      setStatus(seeded.length ? "Subject selected. Click to add objects (e.g. a bike) or switch to Subtract to fix edges." : "Click the subject to select it. Add more clicks for held objects.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not prepare the frame.");
    } finally {
      setEncoding(false);
      preparingRef.current = false;
    }
  }, [capabilities, decodeAndDraw, selectedAsset?.fileUrl, selectedAsset?.durationSeconds, selectedAsset?.width, selectedAsset?.height]);

  useEffect(() => {
    if (activeTab !== "select" || !supported) return;
    encodedRef.current = undefined;
    setPoints([]);
    void prepareReferenceFrame();
  }, [activeTab, supported, prepareReferenceFrame]);

  function handleOverlayClick(event: React.PointerEvent<HTMLCanvasElement>) {
    if (encoding || !encodedRef.current) return;
    const canvas = overlayCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    const next: PromptDot[] = [...points, { x, y, label: mode === "add" ? 1 : 0 }];
    setPoints(next);
    void decodeAndDraw(next);
  }

  function resetPoints() {
    setPoints([]);
    drawOverlay(null, []);
    setStatus("Cleared. Click the subject to start selecting.");
  }

  async function handleGenerate() {
    if (!selectedAsset?.fileUrl) {
      setStatus("Upload or select a video first.");
      return;
    }
    if (!points.some((p) => p.label === 1)) {
      setStatus("Click the subject (at least one include point) first.");
      return;
    }
    setBusy(true);
    cancelledRef.current = false;
    try {
      const result = await segmentVideoPrompted({
        videoUrl: selectedAsset.fileUrl,
        sourceAssetId: selectedAsset.id,
        durationSeconds: selectedAsset.durationSeconds,
        width: selectedAsset.width || 720,
        height: selectedAsset.height || 1280,
        targetFps: OUTPUT_FPS,
        prompt: { positive: points.filter((p) => p.label === 1), negative: points.filter((p) => p.label === 0) },
        profile: chooseSamDeviceProfile(capabilities, selectedAsset.durationSeconds),
        onProgress: (message) => {
          if (!cancelledRef.current) setStatus(message);
        },
        isCancelled: () => cancelledRef.current
      });
      if (cancelledRef.current) {
        setStatus("Cancelled.");
        return;
      }
      setStatus("Encoding matte…");
      const store = await createToolArtifactStore();
      const baked = await storeMatteArtifact(result, store, `airoto_${Date.now()}`);
      const outcome = await uploadMatteForExport({
        maskSequence: baked.maskSequence,
        blob: baked.blob,
        folder: "generated/ai-roto",
        originalName: "AI roto matte"
      });
      bakedMaskRef.current = outcome.maskSequence;
      setMatteUri(URL.createObjectURL(baked.blob));
      setActiveTab("preview");
      setStatus(
        outcome.uploaded
          ? "Matte ready. Preview it, then apply to the timeline."
          : `Matte ready. ${outcome.warning ?? ""}`.trim()
      );
    } catch (error) {
      if (!cancelledRef.current) setStatus(error instanceof Error ? error.message : "AI roto failed.");
    } finally {
      setBusy(false);
    }
  }

  function handleCancel() {
    cancelledRef.current = true;
    setBusy(false);
    setStatus("Cancelled.");
  }

  async function handleApply() {
    const mask = bakedMaskRef.current;
    if (!mask || !selectedAsset) {
      setStatus("Generate a matte first.");
      return;
    }
    setBusy(true);
    try {
      const project = await createProject({ title: `${tool.name} Draft`, sourceAssetId: selectedAsset.id });
      await addEffect(project.id, tool.moduleType);
      const graph = project.projectGraph as ProjectGraph;
      const composition = graph.composition;
      const nextComposition = composition
        ? applyExtractPersonComposition(composition, { mask, sourceAssetId: selectedAsset.id }, "replace")
        : composition;
      const updated = await patchProject(project.id, {
        projectGraph: { ...graph, composition: nextComposition, version: graph.version + 1 }
      });
      navigate(`/editor/${updated.id}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Apply failed.");
    } finally {
      setBusy(false);
    }
  }

  const tabs: Array<{ id: RotoTab; label: string; icon: React.ReactNode }> = [
    { id: "upload", label: "Upload", icon: <Upload size={14} /> },
    { id: "select", label: "Select", icon: <MousePointerClick size={14} /> },
    { id: "preview", label: "Preview", icon: <Sparkles size={14} /> }
  ];

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

      <Card className="caption-tool-panel">
        {!supported ? (
          <p className="caption-status-line">This device can&apos;t run the in-browser AI selection model.</p>
        ) : null}

        <div className="caption-tabs" role="tablist">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              role="tab"
              type="button"
              aria-selected={activeTab === tab.id}
              className={activeTab === tab.id ? "is-active" : ""}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.icon}
              <span>{tab.label}</span>
            </button>
          ))}
        </div>

        {activeTab === "upload" ? (
          <div className="caption-tab-body">
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
            <Button disabled={!selectedAsset} onClick={() => setActiveTab("select")}>
              Continue to selection
            </Button>
          </div>
        ) : null}

        {activeTab === "select" ? (
          <div className="caption-tab-body">
            <div style={{ display: "flex", gap: 8 }}>
              <Button variant={mode === "add" ? "primary" : "ghost"} onClick={() => setMode("add")}>
                <PlusCircle size={14} /> Add
              </Button>
              <Button variant={mode === "subtract" ? "primary" : "ghost"} onClick={() => setMode("subtract")}>
                <MinusCircle size={14} /> Subtract
              </Button>
              <Button variant="ghost" onClick={resetPoints}>
                <Eraser size={14} /> Reset
              </Button>
            </div>

            <div style={{ position: "relative", width: displayWidth, height: displayHeight, margin: "12px auto", borderRadius: 12, overflow: "hidden" }}>
              <canvas ref={frameCanvasRef} width={displayWidth} height={displayHeight} style={{ position: "absolute", inset: 0 }} />
              <canvas
                ref={overlayCanvasRef}
                width={displayWidth}
                height={displayHeight}
                style={{ position: "absolute", inset: 0, cursor: encoding ? "progress" : "crosshair", touchAction: "none" }}
                onPointerDown={handleOverlayClick}
              />
              {encoding ? (
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    textAlign: "center",
                    padding: 16,
                    fontSize: 13,
                    color: "#e6ecf7",
                    background: "rgba(8,10,16,0.62)",
                    backdropFilter: "blur(2px)"
                  }}
                >
                  {status || "Loading the AI model…"}
                </div>
              ) : decoding ? (
                <div
                  style={{
                    position: "absolute",
                    top: 8,
                    right: 8,
                    fontSize: 11,
                    color: "#0b0d12",
                    background: "rgba(64,220,255,0.9)",
                    borderRadius: 999,
                    padding: "2px 8px"
                  }}
                >
                  updating…
                </div>
              ) : null}
            </div>

            <p className="caption-status-line">
              {mode === "add" ? "Click the person and any object they hold (bike, notebook…)." : "Click areas to remove from the selection."}
            </p>

            <div style={{ display: "flex", gap: 8 }}>
              <Button disabled={busy || encoding} onClick={handleGenerate}>
                <WandSparkles size={14} /> {busy ? "Working…" : "Generate matte"}
              </Button>
              {busy ? (
                <Button variant="ghost" onClick={handleCancel}>
                  Cancel
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        {activeTab === "preview" ? (
          <div className="caption-tab-body">
            {matteUri ? (
              <video src={matteUri} controls loop muted style={{ width: displayWidth, borderRadius: 12, margin: "0 auto", display: "block" }} />
            ) : (
              <p className="caption-status-line">Generate a matte from the Select tab first.</p>
            )}
            <Button disabled={busy || !matteUri} onClick={handleApply}>
              {busy ? "Working…" : "Apply to timeline"}
            </Button>
          </div>
        ) : null}

        {status ? <p className="caption-status-line">{status}</p> : null}
      </Card>
    </div>
  );
}
