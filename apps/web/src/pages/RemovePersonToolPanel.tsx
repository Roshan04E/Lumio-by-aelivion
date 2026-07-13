import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Eraser, MousePointerClick, Paintbrush, Play, Upload, WandSparkles } from "lucide-react";
import {
  applyRemovePersonComposition,
  type ProjectGraph,
  type SourceAsset,
  type ToolCapabilityDefinition
} from "@kimera-by-aelivion/shared";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { CreditBadge } from "../components/CreditBadge";
import { ThemedSelect } from "../editor/inspector/controls/ThemedSelect";
import { addEffect, createAsset, createProject, patchProject } from "../lib/api";
import { createToolArtifactStore } from "../tools/artifact-store";
import { detectBrowserToolCapabilities } from "../tools/capabilities";
import { segmentVideoFast } from "../tools/local-segmentation";
import type { InpaintMask } from "../tools/mock-inpaint";
import { runVideoInpaint } from "../tools/video-inpaint";
import { storeInpaintArtifact, type InpaintBakeResult } from "../tools/inpaint-store";

interface RemovePersonToolPanelProps {
  tool: ToolCapabilityDefinition;
  assets: SourceAsset[];
  selectedAssetId: string;
  onSelectAsset: (id: string) => void;
  onUploadAsset: (file: File | null) => Promise<void>;
}

type RemoveTab = "upload" | "select" | "preview";
type SelectionMode = "tap" | "brush";

const DISPLAY_WIDTH = 300;
const OUTPUT_FPS = 12;

export function RemovePersonToolPanel({ tool, assets, selectedAssetId, onSelectAsset, onUploadAsset }: RemovePersonToolPanelProps) {
  const navigate = useNavigate();
  const selectedAsset = assets.find((asset) => asset.id === selectedAssetId);

  const [activeTab, setActiveTab] = useState<RemoveTab>("upload");
  const [selectionMode, setSelectionMode] = useState<SelectionMode>("tap");
  const [brushSize, setBrushSize] = useState(28);
  const [feather, setFeather] = useState(6);
  const [hasBrush, setHasBrush] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [clipUri, setClipUri] = useState<string | undefined>();

  const frameCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const bakedRef = useRef<InpaintBakeResult | undefined>(undefined);
  const cancelledRef = useRef(false);
  const paintingRef = useRef(false);

  const aspect = selectedAsset ? (selectedAsset.height || 1280) / (selectedAsset.width || 720) : 16 / 9;
  const displayWidth = DISPLAY_WIDTH;
  const displayHeight = Math.round(DISPLAY_WIDTH * aspect);

  const drawReferenceFrame = useCallback(async () => {
    const canvas = frameCanvasRef.current;
    if (!canvas || !selectedAsset?.fileUrl) {
      return;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.src = selectedAsset.fileUrl;
    video.muted = true;
    video.playsInline = true;
    try {
      await new Promise<void>((resolve, reject) => {
        video.onloadeddata = () => resolve();
        video.onerror = () => reject(new Error("Unable to load video frame."));
      });
      await new Promise<void>((resolve) => {
        video.onseeked = () => resolve();
        video.currentTime = Math.min(0.1, video.duration || 0);
      });
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    } catch {
      ctx.fillStyle = "#15171d";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  }, [selectedAsset?.fileUrl]);

  // Redraw the reference frame and clear any prior brush mask whenever the
  // selected asset changes, so the selection canvas always matches the source.
  useEffect(() => {
    if (activeTab !== "select") {
      return;
    }
    void drawReferenceFrame();
    clearMask();
  }, [activeTab, drawReferenceFrame]);

  function clearMask() {
    const mask = maskCanvasRef.current;
    const ctx = mask?.getContext("2d");
    if (mask && ctx) {
      ctx.clearRect(0, 0, mask.width, mask.height);
    }
    setHasBrush(false);
  }

  function paintAt(event: React.PointerEvent<HTMLCanvasElement>) {
    if (selectionMode !== "brush") {
      return;
    }
    const mask = maskCanvasRef.current;
    const ctx = mask?.getContext("2d");
    if (!mask || !ctx) {
      return;
    }
    const rect = mask.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * mask.width;
    const y = ((event.clientY - rect.top) / rect.height) * mask.height;
    ctx.fillStyle = "rgba(255,90,90,0.85)";
    ctx.beginPath();
    ctx.arc(x, y, brushSize / 2, 0, Math.PI * 2);
    ctx.fill();
    setHasBrush(true);
  }

  function handlePointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    if (selectionMode === "tap") {
      // A tap means "remove the auto-detected subject" - the actual segmentation
      // runs at generate time; here we just confirm the intent for the user.
      setStatus("Tap registered - the detected person will be removed. Press Generate clean clip.");
      return;
    }
    paintingRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    paintAt(event);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    if (paintingRef.current) {
      paintAt(event);
    }
  }

  function handlePointerUp() {
    paintingRef.current = false;
  }

  function coverageFromMaskCanvas(): Uint8Array {
    const mask = maskCanvasRef.current!;
    const ctx = mask.getContext("2d")!;
    const data = ctx.getImageData(0, 0, mask.width, mask.height).data;
    const coverage = new Uint8Array(mask.width * mask.height);
    for (let i = 0; i < coverage.length; i += 1) {
      coverage[i] = (data[i * 4 + 3] ?? 0) > 16 ? 255 : 0;
    }
    return coverage;
  }

  async function buildMask(): Promise<{ mask: InpaintMask; trackingPath?: unknown; subjectBounds?: unknown }> {
    if (selectionMode === "brush" && hasBrush) {
      const mask = maskCanvasRef.current!;
      return {
        mask: {
          width: mask.width,
          height: mask.height,
          frames: [{ timeSeconds: 0, coverage: coverageFromMaskCanvas() }]
        }
      };
    }

    setStatus("Detecting the person to remove...");
    const seg = await segmentVideoFast({
      videoUrl: selectedAsset!.fileUrl,
      durationSeconds: selectedAsset!.durationSeconds,
      width: selectedAsset!.width || 720,
      height: selectedAsset!.height || 1280,
      tier: "fast",
      onProgress: (message) => {
        if (!cancelledRef.current) {
          setStatus(message);
        }
      },
      isCancelled: () => cancelledRef.current
    });
    return {
      mask: {
        width: seg.maskSequence.width,
        height: seg.maskSequence.height,
        frames: seg.matteFrames.map((frame) => ({ timeSeconds: frame.timeSeconds, coverage: lumaToCoverage(frame.luma) }))
      },
      trackingPath: seg.trackingPath,
      subjectBounds: seg.subjectBounds
    };
  }

  async function handleGenerate() {
    if (!selectedAsset?.fileUrl) {
      setStatus("Upload or select a video first.");
      return;
    }
    if (selectionMode === "brush" && !hasBrush) {
      setStatus("Brush over the person/object you want to remove first.");
      return;
    }

    setBusy(true);
    cancelledRef.current = false;
    try {
      const { mask } = await buildMask();
      if (cancelledRef.current) {
        setStatus("Cancelled.");
        return;
      }

      const capabilities = detectBrowserToolCapabilities();
      const result = await runVideoInpaint({
        videoUrl: selectedAsset.fileUrl,
        durationSeconds: selectedAsset.durationSeconds,
        width: selectedAsset.width || 720,
        height: selectedAsset.height || 1280,
        fps: OUTPUT_FPS,
        mask,
        feather,
        capabilities,
        onProgress: (message) => {
          if (!cancelledRef.current) {
            setStatus(message);
          }
        },
        isCancelled: () => cancelledRef.current
      });
      if (cancelledRef.current) {
        setStatus("Cancelled.");
        return;
      }

      setStatus("Encoding clean clip...");
      const store = await createToolArtifactStore();
      const baked = await storeInpaintArtifact(result, store, `remove_${Date.now()}`, result.usedRealModel ? "browser" : "mock", selectedAsset.id);
      bakedRef.current = baked;
      setClipUri(baked.clip.uri);
      setActiveTab("preview");
      setStatus(
        result.usedRealModel
          ? "Clean clip ready using real AI inpainting. Preview it, then apply to the timeline."
          : "Clean clip ready using the fallback background fill (real AI model unavailable on this device). Preview it, then apply to the timeline."
      );
    } catch (error) {
      if (!cancelledRef.current) {
        setStatus(error instanceof Error ? error.message : "Removal failed.");
      }
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
    const baked = bakedRef.current;
    if (!baked || !selectedAsset) {
      setStatus("Generate a clean clip first.");
      return;
    }

    setBusy(true);
    try {
      const clipAsset = await createAsset({
        file: new File([baked.blob], `${baked.clip.id}.webm`, { type: baked.blob.type || "video/webm" }),
        durationSeconds: baked.clip.durationSeconds,
        width: baked.clip.width,
        height: baked.clip.height
      });
      const project = await createProject({ title: `${tool.name} Tool Draft`, sourceAssetId: selectedAsset.id });
      await addEffect(project.id, tool.moduleType);

      const graph = project.projectGraph as ProjectGraph;
      const composition = graph.composition;
      const nextComposition = composition
        ? applyRemovePersonComposition(composition, {
            inpaintedAssetId: clipAsset.id,
            inpaintedUri: clipAsset.fileUrl,
            durationSeconds: selectedAsset.durationSeconds,
            sourceAssetId: selectedAsset.id
          })
        : composition;

      const updated = await patchProject(project.id, {
        projectGraph: {
          ...graph,
          editableFields: {
            ...graph.editableFields,
            inpaintedClip: baked.clip,
            removalSelectionMode: selectionMode,
            removalFeather: feather
          },
          composition: nextComposition,
          version: graph.version + 1
        }
      });
      navigate(`/editor/${updated.id}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Apply failed.");
    } finally {
      setBusy(false);
    }
  }

  const tabs: Array<{ id: RemoveTab; label: string; icon: React.ReactNode }> = [
    { id: "upload", label: "Upload", icon: <Upload size={14} /> },
    { id: "select", label: "Select", icon: <Paintbrush size={14} /> },
    { id: "preview", label: "Preview", icon: <Play size={14} /> }
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
                  options={[
                    { value: "", label: "Select media…" },
                    ...assets.map((asset) => ({ value: asset.id, label: asset.fileName }))
                  ]}
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
            <div className="remove-person-modes" style={{ display: "flex", gap: 8 }}>
              <Button variant={selectionMode === "tap" ? "primary" : "ghost"} onClick={() => setSelectionMode("tap")}>
                <MousePointerClick size={14} /> Tap subject
              </Button>
              <Button variant={selectionMode === "brush" ? "primary" : "ghost"} onClick={() => setSelectionMode("brush")}>
                <Paintbrush size={14} /> Brush region
              </Button>
            </div>

            <div
              style={{ position: "relative", width: displayWidth, height: displayHeight, margin: "12px auto", borderRadius: 12, overflow: "hidden" }}
            >
              <canvas ref={frameCanvasRef} width={displayWidth} height={displayHeight} style={{ position: "absolute", inset: 0 }} />
              <canvas
                ref={maskCanvasRef}
                width={displayWidth}
                height={displayHeight}
                style={{ position: "absolute", inset: 0, cursor: selectionMode === "brush" ? "crosshair" : "pointer", touchAction: "none" }}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerLeave={handlePointerUp}
              />
            </div>

            {selectionMode === "brush" ? (
              <>
                <label className="tool-slider-row">
                  Brush size
                  <input type="range" min={8} max={80} value={brushSize} onChange={(event) => setBrushSize(Number(event.currentTarget.value))} />
                </label>
                <Button variant="ghost" onClick={clearMask}>
                  <Eraser size={14} /> Clear brush
                </Button>
              </>
            ) : (
              <p className="caption-status-line">Tap mode removes the auto-detected person across the whole clip.</p>
            )}

            <label className="tool-slider-row">
              Edge feather
              <input type="range" min={0} max={24} value={feather} onChange={(event) => setFeather(Number(event.currentTarget.value))} />
            </label>

            <div style={{ display: "flex", gap: 8 }}>
              <Button disabled={busy} onClick={handleGenerate}>
                <WandSparkles size={14} /> {busy ? "Working…" : "Generate clean clip"}
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
            {clipUri ? (
              <video src={clipUri} controls loop style={{ width: displayWidth, borderRadius: 12, margin: "0 auto", display: "block" }} />
            ) : (
              <p className="caption-status-line">Generate a clean clip from the Select tab first.</p>
            )}
            <Button disabled={busy || !clipUri} onClick={handleApply}>
              {busy ? "Working…" : "Apply to timeline"}
            </Button>
          </div>
        ) : null}

        {status ? <p className="caption-status-line">{status}</p> : null}
      </Card>
    </div>
  );
}

/** RGBA luma matte (R holds coverage, 255 = subject) -> single-channel coverage. */
function lumaToCoverage(luma: Uint8ClampedArray): Uint8Array {
  const coverage = new Uint8Array(luma.length / 4);
  for (let i = 0; i < coverage.length; i += 1) {
    coverage[i] = luma[i * 4] ?? 0;
  }
  return coverage;
}
