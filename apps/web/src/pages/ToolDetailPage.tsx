import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import {
  AlignHorizontalJustifyCenter,
  AlignHorizontalJustifyEnd,
  AlignHorizontalJustifyStart,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart,
  ArrowLeft,
  Bold,
  Check,
  Circle,
  Clock3,
  FileJson,
  Highlighter,
  Info,
  Italic,
  PaintBucket,
  Pause,
  PenLine,
  Play,
  RotateCcw,
  Sparkles,
  Square,
  Upload,
  WandSparkles,
  Captions,
  Eraser,
  Layers,
  Move3d,
  Scissors,
  Wrench,
  type LucideIcon
} from "lucide-react";
import {
  applyCaptionTrackToComposition,
  captionStylePresets,
  createAutoCaptionPrompt,
  createAutoCaptionAssistantPlan,
  createMockSubjectAnalysis,
  createMockToolRun,
  createCaptionTrack,
  createCaptionInterchangeArtifact,
  getCompositionTextRunStyle,
  getCompositionTextRuns,
  getCompositionTextStyle,
  getToolCapability,
  exportTranscriptToSrt,
  exportTranscriptToVtt,
  pickDefaultToolAdapter,
  parseCaptionInterchangeArtifact,
  parseTranscriptInput,
  renderSafeFonts,
  stageLabel,
  type TranscriptArtifactData,
  type ToolIconKey,
  toolCapabilityDefinitions,
  validateTranscriptArtifact,
  type CaptionStylePreset,
  type CaptionSegmentStyleOverride,
  type CaptionTrackData,
  type CloudTranscriptionLanguage,
  type SourceAsset,
  type SubjectAnalysisArtifacts,
  type TimelineComposition,
  type TimelineLayer,
  type TimelineTrack,
  type ToolAdapterType,
  type ToolRun,
  type TranscriptSegment,
} from "@orreris/shared";
import { AiRotoToolPanel } from "./AiRotoToolPanel";
import { RemovePersonToolPanel } from "./RemovePersonToolPanel";
import { SmartFollowTextToolPanel } from "./SmartFollowTextToolPanel";
import { ThemedSelect } from "../editor/inspector/controls/ThemedSelect";
import { AiActivityIndicator } from "../components/AiActivityIndicator";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { ColorControl } from "../components/ColorControl";
import { CreditBadge } from "../components/CreditBadge";
import { ShadowCostBadge } from "../components/ShadowCostBadge";
import { addEffect, createAsset, createProject, listAssets, patchProject, suggestAutoCaptionHighlights, transformAutoCaptions } from "../lib/api";
import { buildBackgroundColor, parseBackgroundColor } from "../lib/colorBackground";
import { defaultColorPalette, extractPaletteFromAsset } from "../lib/colorPalette";
import { transcribeAssetWithCloudAdapter } from "../tools/cloud-transcription";
import { getLayerToolEffectHandler } from "../tools/layer-effect-handlers";
import { chooseSegmentationDeviceProfile, type SegmentationDeviceProfile } from "../tools/local-segmentation";
import { createToolRuntimeState, runToolAdapter, type ToolRunController, type ToolRuntimeState } from "../tools/tool-runner";
import { assertToolRunnable } from "../tools/useLayerToolEffectRunner";
import { isCompatibleToolAsset, resolveToolMediaUrl } from "../tools/tool-media";

const TOOL_ICONS: Record<ToolIconKey, LucideIcon> = {
  captions: Captions,
  "text-behind": Layers,
  "background-removal": Eraser,
  "follow-text": Move3d,
  "person-extraction": Scissors,
  generic: Wrench
};

export function ToolDetailPage() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const foundTool = slug ? getToolCapability(slug) : undefined;
  const tool = foundTool ?? toolCapabilityDefinitions[0]!;
  const initialRun = useMemo(() => (tool ? createMockToolRun(tool) : undefined), [tool]);
  const [run, setRun] = useState<ToolRun | undefined>(initialRun);
  const [runtime, setRuntime] = useState<ToolRuntimeState | undefined>();
  const [captionInput, setCaptionInput] = useState("");
  const [captionStyleId, setCaptionStyleId] = useState(captionStylePresets[0]?.id ?? "punchy-center");
  const [highlightedWords, setHighlightedWords] = useState("");
  const [captionStyleOverrides, setCaptionStyleOverrides] = useState<Record<string, CaptionSegmentStyleOverride>>({});
  const [maskFrameIndex, setMaskFrameIndex] = useState(0);
  const [maskFeather, setMaskFeather] = useState(8);
  const [trackingSmoothing, setTrackingSmoothing] = useState(0.45);
  const [realSubjectAnalysis, setRealSubjectAnalysis] = useState<SubjectAnalysisArtifacts | undefined>();
  const [segmentationStatus, setSegmentationStatus] = useState("");
  const [segmentationStage, setSegmentationStage] = useState<"idle" | "fast" | "quality">("idle");
  const [segmentationRunId, setSegmentationRunId] = useState(0);
  const cancelledSegmentationRef = useRef(false);
  const activeSegmentationRunIdRef = useRef(0);
  const [behindText, setBehindText] = useState("NEW DROP");
  const [behindTextColor, setBehindTextColor] = useState("#4D9FFF");
  const [removeBackgroundMode, setRemoveBackgroundMode] = useState<"timelineMask" | "greenScreen">("timelineMask");
  const [selectedAdapter, setSelectedAdapter] = useState<ToolAdapterType>(() => pickDefaultToolAdapter(tool));
  const [toolAssets, setToolAssets] = useState<SourceAsset[]>([]);
  const [selectedAssetId, setSelectedAssetId] = useState("");
  const [selectedCaptionSegmentId, setSelectedCaptionSegmentId] = useState("");
  const [busy, setBusy] = useState(false);
  const [localTranscriptionStatus, setLocalTranscriptionStatus] = useState("");
  const [cloudTranscriptionStatus, setCloudTranscriptionStatus] = useState("");
  const [cloudLanguage, setCloudLanguage] = useState<CloudTranscriptionLanguage>("hinglish");
  const [cloudTranscriptionRunId, setCloudTranscriptionRunId] = useState("");
  const [captionIntelligenceStatus, setCaptionIntelligenceStatus] = useState("");
  const [highlightSuggestionStatus, setHighlightSuggestionStatus] = useState("");
  const [lastLocalTranscript, setLastLocalTranscript] = useState<TranscriptArtifactData | undefined>();
  const [transcriptionRunId, setTranscriptionRunId] = useState(0);
  const cancelledTranscriptionRef = useRef(false);
  const activeTranscriptionRunIdRef = useRef(0);
  const cancelledCloudTranscriptionRef = useRef(false);
  const activeCloudTranscriptionRunIdRef = useRef("");
  const controllerRef = useRef<ToolRunController | null>(null);
  const selectedAsset = toolAssets.find((asset) => asset.id === selectedAssetId);
  const transcript = useMemo(() => parseTranscriptInput(captionInput), [captionInput]);
  const captionStyle = captionStylePresets.find((preset) => preset.id === captionStyleId) ?? captionStylePresets[0]!;
  const captionPrompt = useMemo(
    () =>
      createAutoCaptionPrompt({
        assetName: selectedAsset?.fileName,
        durationSeconds: selectedAsset?.durationSeconds || transcript.durationSeconds || undefined,
        highlightedWords,
        styleGoal: captionStyle.name
      }),
    [captionStyle.name, highlightedWords, selectedAsset?.durationSeconds, selectedAsset?.fileName, transcript.durationSeconds]
  );
  const transcriptIssues = useMemo(() => validateTranscriptArtifact(transcript), [transcript]);
  const captionTrack = useMemo(
    () => createCaptionTrack(transcript, captionStyle.id, highlightedWords, captionStyleOverrides),
    [captionStyle.id, captionStyleOverrides, highlightedWords, transcript]
  );
  const captionPreviewComposition = useMemo(() => {
    if (!selectedAsset) {
      return undefined;
    }

    const durationSeconds = Math.max(selectedAsset.durationSeconds, transcript.durationSeconds, captionTrack.segments.at(-1)?.endSeconds ?? 0, 1);
    const baseComposition: TimelineComposition = {
      id: "composition_auto_caption_preview",
      name: "Auto Caption Preview",
      width: selectedAsset.width || 1080,
      height: selectedAsset.height || 1920,
      fps: 30,
      durationSeconds,
      backgroundColor: "#000000",
      tracks: []
    };

    return applyCaptionTrackToComposition(prepareCaptionSourceComposition(baseComposition, selectedAsset, transcript.durationSeconds), captionTrack, captionStyle);
  }, [captionTrack, captionStyle, selectedAsset, transcript.durationSeconds]);
  const selectedCaptionSegmentIndex = captionTrack.segments.findIndex((segment) => segment.id === selectedCaptionSegmentId);
  const activeCaptionPreviewSegment =
    captionTrack.segments[selectedCaptionSegmentIndex >= 0 ? selectedCaptionSegmentIndex : 0] ?? captionTrack.segments[0];
  const captionPreviewTime = activeCaptionPreviewSegment
    ? activeCaptionPreviewSegment.startSeconds +
      Math.min(0.12, Math.max(0, (activeCaptionPreviewSegment.endSeconds - activeCaptionPreviewSegment.startSeconds) / 2))
    : 0;
  const captionPreviewLayerId =
    selectedCaptionSegmentIndex >= 0
      ? captionPreviewComposition?.tracks.flatMap((track) => track.layers).filter((layer) => layer.type === "text")[selectedCaptionSegmentIndex]?.id
      : undefined;
  const captionPreviewLayer = captionPreviewLayerId
    ? captionPreviewComposition?.tracks.flatMap((track) => track.layers).find((layer) => layer.id === captionPreviewLayerId)
    : captionPreviewComposition?.tracks.flatMap((track) => track.layers).find((layer) => layer.type === "text");
  const captionAssistantPlan = useMemo(
    () =>
      createAutoCaptionAssistantPlan({
        asset: selectedAsset,
        transcript,
        userGoal: `${captionStyle.name} ${highlightedWords}`,
        preferredAdapter: selectedAsset ? "cloud" : "browser"
      }),
    [captionStyle.name, highlightedWords, selectedAsset, transcript]
  );

  useEffect(() => {
    setSelectedCaptionSegmentId((current) => {
      if (current && transcript.segments.some((segment) => segment.id === current)) {
        return current;
      }
      return transcript.segments[0]?.id ?? "";
    });
  }, [transcript]);

  useEffect(() => {
    let alive = true;
    setSelectedAdapter(pickDefaultToolAdapter(tool));
    void createToolRuntimeState().then((state) => {
      if (alive) {
        setRuntime(state);
      }
    });
    return () => {
      alive = false;
      controllerRef.current?.cancel();
      controllerRef.current = null;
    };
  }, [tool.id]);

  useEffect(() => {
    let alive = true;
    listAssets().then((assets) => {
      if (!alive) {
        return;
      }
      setToolAssets(assets);
      setSelectedAssetId((current) => current || assets.find((asset) => isCompatibleToolAsset(tool, asset))?.id || "");
    });
    return () => {
      alive = false;
    };
  }, [tool.id]);

  if (!foundTool || !run) {
    return <Navigate to="/tools" replace />;
  }

  const activeStageIndex = Math.max(0, tool.stages.indexOf(run.stage));
  const previewArtifacts = tool.outputs.slice(0, 4);
  const isAutoCaptions = tool.slug === "auto-captions";
  const isExtractPerson = tool.slug === "extract-person";
  const isTextBehindPerson = tool.slug === "text-behind-person";
  const isRemoveBackground = tool.slug === "remove-background";
  const isSmartFollowText = tool.slug === "smart-3d-follow-text";
  const isRemovePerson = tool.slug === "remove-person";
  const isAiRoto = tool.slug === "ai-roto";
  const usesMaskComposite = isExtractPerson || isTextBehindPerson || isRemoveBackground;
  // Tools with a real, finished run lifecycle get the focused tabbed layout
  // (upload -> tweak -> apply) instead of the generic TL0 mock-adapter shell.
  const isTabbedTool = isAutoCaptions || isExtractPerson;

  const selectedAdapterCapability = runtime?.adapters.find((adapter) => adapter.type === selectedAdapter);
  const mockSubjectAnalysis = useMemo(
    () =>
      createMockSubjectAnalysis({
        durationSeconds: selectedAsset?.durationSeconds ?? 10,
        feather: maskFeather,
        smoothing: trackingSmoothing
      }),
    [maskFeather, trackingSmoothing, selectedAsset?.durationSeconds]
  );
  // Real segmentation output (once the user runs Extract) takes over from the
  // synthetic placeholder, which only exists so the inspector has something to
  // show before any media is processed.
  const subjectAnalysis = realSubjectAnalysis ?? mockSubjectAnalysis;
  const hasRealMatte = Boolean(realSubjectAnalysis?.maskSequence.matteVideoUri);
  const segmentationDeviceProfile = useMemo(
    () => (runtime ? chooseSegmentationDeviceProfile(runtime.capabilities, selectedAsset?.durationSeconds ?? 10) : undefined),
    [runtime, selectedAsset?.durationSeconds]
  );

  async function startToolRun() {
    if (!run) {
      return;
    }

    const activeRun = run;
    controllerRef.current?.cancel();
    controllerRef.current = await runToolAdapter({
      tool,
      run: {
        ...activeRun,
        inputAssetIds: selectedAsset ? [selectedAsset.id] : activeRun.inputAssetIds,
        params: {
          ...activeRun.params,
          sourceAssetId: selectedAsset?.id,
          sourceDurationSeconds: selectedAsset?.durationSeconds
        }
      },
      adapterType: selectedAdapter,
      onUpdate: setRun
    });
  }

  async function handleToolAssetUpload(file: File | null) {
    if (!file) {
      return;
    }

    setBusy(true);
    try {
      const metadata = await readMediaMetadata(file);
      const asset = await createAsset({ file, ...metadata });
      setToolAssets((current) => [asset, ...current.filter((item) => item.id !== asset.id)]);
      setSelectedAssetId(asset.id);
      setRun((current) =>
        current
          ? {
              ...current,
              inputAssetIds: [asset.id],
              params: {
                ...current.params,
                sourceAssetId: asset.id,
                sourceDurationSeconds: asset.durationSeconds
              },
              diagnostics: [
                ...current.diagnostics,
                {
                  level: "info",
                  code: "TOOL_INPUT_BOUND",
                  message: `Bound ${asset.fileName} as the tool input.`
                }
              ],
              updatedAt: new Date().toISOString()
            }
          : current
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleLocalTranscribe() {
    if (!selectedAsset) {
      setLocalTranscriptionStatus("Upload or select media first.");
      return;
    }
    const blocker = assertToolRunnable("auto-captions", "Auto Captions");
    if (blocker) {
      setLocalTranscriptionStatus(blocker);
      return;
    }

    setBusy(true);
    cancelledTranscriptionRef.current = false;
    const runId = Date.now();
    activeTranscriptionRunIdRef.current = runId;
    setTranscriptionRunId(runId);
    setLocalTranscriptionStatus("Starting local transcription...");
    try {
      // Same registered handler the editor's one-click flow drives — the ML entry
      // point is wired exactly once (layer-effect-handlers.ts).
      const nextTranscript = (await getLayerToolEffectHandler("auto-captions")!.run({
        asset: selectedAsset,
        layer: undefined,
        fps: 30,
        options: {},
        onProgress: (message) => {
          if (!cancelledTranscriptionRef.current && activeTranscriptionRunIdRef.current === runId) {
            setLocalTranscriptionStatus(message);
          }
        },
        isCancelled: () => cancelledTranscriptionRef.current
      })) as TranscriptArtifactData;
      if (cancelledTranscriptionRef.current || activeTranscriptionRunIdRef.current !== runId) {
        setLocalTranscriptionStatus("Local transcription cancelled.");
        return;
      }
      setLastLocalTranscript(nextTranscript);
      setCaptionInput(transcriptToJsonInput(nextTranscript));
      setRun((current) =>
        current
          ? {
              ...current,
              inputAssetIds: [selectedAsset.id],
              params: {
                ...current.params,
                sourceAssetId: selectedAsset.id,
                sourceDurationSeconds: selectedAsset.durationSeconds,
                transcriptionSource: "browser-local"
              },
              diagnostics: [
                ...current.diagnostics,
                {
                  level: "info",
                  code: "LOCAL_TRANSCRIPTION_READY",
                  message: `Local transcription produced ${nextTranscript.segments.length} editable caption segments.`
                }
              ],
              updatedAt: new Date().toISOString()
            }
          : current
      );
    } catch (error) {
      if (cancelledTranscriptionRef.current || activeTranscriptionRunIdRef.current !== runId) {
        return;
      }
      setLocalTranscriptionStatus(error instanceof Error ? error.message : "Local transcription failed.");
      setRun((current) =>
        current
          ? {
              ...current,
              diagnostics: [
                ...current.diagnostics,
                {
                  level: "warning",
                  code: "LOCAL_TRANSCRIPTION_FAILED",
                  message: error instanceof Error ? error.message : "Local transcription failed."
                }
              ],
              updatedAt: new Date().toISOString()
            }
          : current
      );
    } finally {
      if (activeTranscriptionRunIdRef.current === runId) {
        activeTranscriptionRunIdRef.current = 0;
        setTranscriptionRunId(0);
        setBusy(false);
      }
    }
  }

  function cancelLocalTranscribe() {
    cancelledTranscriptionRef.current = true;
    activeTranscriptionRunIdRef.current = 0;
    setTranscriptionRunId(0);
    setBusy(false);
    setLocalTranscriptionStatus("Local transcription cancelled.");
  }

  async function handleExtractPerson() {
    if (!selectedAsset?.fileUrl) {
      setSegmentationStatus("Upload or select a video first.");
      return;
    }

    const blocker = assertToolRunnable("extract-person", "Extract Person");
    if (blocker) {
      setSegmentationStatus(blocker);
      return;
    }

    setBusy(true);
    cancelledSegmentationRef.current = false;
    const runId = Date.now();
    activeSegmentationRunIdRef.current = runId;
    setSegmentationRunId(runId);
    setSegmentationStage("fast");
    setSegmentationStatus("Starting fast preview segmentation...");
    try {
      // The registered extract-person handler owns segmentation + matte bake +
      // upload (fail-loud via progress). The page's Extract buttons are the
      // PRODUCER surface, so they always re-analyze rather than reusing.
      const result = (await getLayerToolEffectHandler("extract-person")!.run({
        asset: selectedAsset,
        layer: undefined,
        fps: 30,
        options: { quality: "fast", maskSource: "reanalyze" },
        onProgress: (message) => {
          if (!cancelledSegmentationRef.current && activeSegmentationRunIdRef.current === runId) {
            setSegmentationStatus(message);
          }
        },
        isCancelled: () => cancelledSegmentationRef.current
      })) as SubjectAnalysisArtifacts;
      if (cancelledSegmentationRef.current || activeSegmentationRunIdRef.current !== runId) {
        setSegmentationStatus("Extraction cancelled.");
        return;
      }

      setRealSubjectAnalysis(result);
      setMaskFrameIndex(0);
      setSegmentationStatus(
        `Fast preview ready: ${result.maskSequence.frames.length} frames extracted. Bake high quality before final export for cleaner edges.`
      );
    } catch (error) {
      if (cancelledSegmentationRef.current || activeSegmentationRunIdRef.current !== runId) {
        return;
      }
      setSegmentationStatus(error instanceof Error ? error.message : "Person extraction failed.");
    } finally {
      if (activeSegmentationRunIdRef.current === runId) {
        activeSegmentationRunIdRef.current = 0;
        setSegmentationRunId(0);
        setSegmentationStage("idle");
        setBusy(false);
      }
    }
  }

  async function handleBakeQualityMatte() {
    if (!selectedAsset?.fileUrl || !segmentationDeviceProfile) {
      setSegmentationStatus("Extract a fast preview first.");
      return;
    }

    setBusy(true);
    cancelledSegmentationRef.current = false;
    const runId = Date.now();
    activeSegmentationRunIdRef.current = runId;
    setSegmentationRunId(runId);
    setSegmentationStage("quality");
    setSegmentationStatus(
      segmentationDeviceProfile.executionProvider === "webgpu"
        ? "Baking high-quality matte (WebGPU)..."
        : "Baking high-quality matte (CPU - this device has no WebGPU, so this will take longer)..."
    );
    try {
      // Same registered handler as the fast tier; `quality` selects the RVM bake
      // and always re-analyzes (a quality bake is an explicit fresh run).
      const result = (await getLayerToolEffectHandler("extract-person")!.run({
        asset: selectedAsset,
        layer: undefined,
        fps: 30,
        options: { quality: "quality", maskSource: "reanalyze" },
        onProgress: (message) => {
          if (!cancelledSegmentationRef.current && activeSegmentationRunIdRef.current === runId) {
            setSegmentationStatus(message);
          }
        },
        isCancelled: () => cancelledSegmentationRef.current
      })) as SubjectAnalysisArtifacts;
      if (cancelledSegmentationRef.current || activeSegmentationRunIdRef.current !== runId) {
        setSegmentationStatus("High-quality bake cancelled.");
        return;
      }

      setRealSubjectAnalysis(result);
      setMaskFrameIndex(0);
      setSegmentationStatus(`High-quality matte ready: ${result.maskSequence.frames.length} frames, temporally stable edges.`);
    } catch (error) {
      if (cancelledSegmentationRef.current || activeSegmentationRunIdRef.current !== runId) {
        return;
      }
      setSegmentationStatus(error instanceof Error ? error.message : "High-quality bake failed.");
    } finally {
      if (activeSegmentationRunIdRef.current === runId) {
        activeSegmentationRunIdRef.current = 0;
        setSegmentationRunId(0);
        setSegmentationStage("idle");
        setBusy(false);
      }
    }
  }

  function cancelExtractPerson() {
    cancelledSegmentationRef.current = true;
    activeSegmentationRunIdRef.current = 0;
    setSegmentationRunId(0);
    setSegmentationStage("idle");
    setBusy(false);
    setSegmentationStatus("Extraction cancelled.");
  }

  async function handleCloudTranscribe() {
    if (!selectedAsset) {
      setCloudTranscriptionStatus("Upload or select media first.");
      return;
    }

    const runId = `cloud_caption_${Date.now()}`;
    cancelledCloudTranscriptionRef.current = false;
    activeCloudTranscriptionRunIdRef.current = runId;
    setCloudTranscriptionRunId(runId);
    setBusy(true);
    setSelectedAdapter("cloud");
    setCloudTranscriptionStatus("Queued cloud transcription job.");
    setRun((current) =>
      current
        ? {
            ...current,
            status: "queued",
            progress: 0,
            stage: "transcribe",
            inputAssetIds: [selectedAsset.id],
            params: {
              ...current.params,
              adapter: "cloud",
              sourceAssetId: selectedAsset.id,
              sourceDurationSeconds: selectedAsset.durationSeconds,
              transcriptionLanguage: cloudLanguage,
              wordTimestamps: true,
              prompt: captionPrompt
            },
            diagnostics: [
              ...current.diagnostics,
              {
                level: "info",
                code: "CLOUD_TRANSCRIPTION_QUEUED",
                message: "Cloud transcription adapter queued with provider-neutral request metadata."
              }
            ],
            updatedAt: new Date().toISOString()
          }
        : current
    );

    try {
      const result = await transcribeAssetWithCloudAdapter({
        asset: selectedAsset,
        language: cloudLanguage,
        hintPrompt: captionPrompt,
        stylePresetId: captionStyle.id,
        highlightedWords,
        runId,
        onProgress: (progress) => {
          if (cancelledCloudTranscriptionRef.current || activeCloudTranscriptionRunIdRef.current !== runId) {
            return;
          }
          setCloudTranscriptionStatus(progress.message);
          setRun((current) =>
            current
              ? {
                  ...current,
                  status: progress.status === "completed" ? "completed" : progress.status === "failed" ? "failed" : "running",
                  progress: progress.progress,
                  stage: progress.status === "completed" ? "preview" : "transcribe",
                  updatedAt: new Date().toISOString()
                }
              : current
          );
        },
        isCancelled: () => cancelledCloudTranscriptionRef.current
      });

      if (cancelledCloudTranscriptionRef.current || activeCloudTranscriptionRunIdRef.current !== runId) {
        return;
      }

      setLastLocalTranscript(result.transcript);
      setCaptionInput(transcriptToJsonInput(result.transcript));
      setCaptionStyleOverrides(result.captionTrack.segmentStyleOverrides ?? {});
      setCloudTranscriptionStatus(`Cloud transcript ready: ${result.transcript.segments.length} segments.`);
      setRun((current) =>
        current
          ? {
              ...current,
              status: "completed",
              progress: 100,
              stage: "preview",
              artifacts: result.artifacts,
              diagnostics: [
                ...current.diagnostics,
                ...result.diagnostics.map((message) => ({
                  level: "info" as const,
                  code: "CLOUD_TRANSCRIPTION_ARTIFACT",
                  message
                }))
              ],
              updatedAt: new Date().toISOString()
            }
          : current
      );
    } catch (error) {
      if (cancelledCloudTranscriptionRef.current || activeCloudTranscriptionRunIdRef.current !== runId) {
        return;
      }
      const message = error instanceof Error ? error.message : "Cloud transcription failed.";
      setCloudTranscriptionStatus(`${message} You can retry or use local transcription.`);
      setRun((current) =>
        current
          ? {
              ...current,
              status: "failed",
              progress: 0,
              diagnostics: [
                ...current.diagnostics,
                {
                  level: "warning",
                  code: "CLOUD_TRANSCRIPTION_FAILED",
                  message
                }
              ],
              updatedAt: new Date().toISOString()
            }
          : current
      );
    } finally {
      if (activeCloudTranscriptionRunIdRef.current === runId) {
        activeCloudTranscriptionRunIdRef.current = "";
        setCloudTranscriptionRunId("");
        setBusy(false);
      }
    }
  }

  function cancelCloudTranscribe() {
    cancelledCloudTranscriptionRef.current = true;
    activeCloudTranscriptionRunIdRef.current = "";
    setCloudTranscriptionRunId("");
    setBusy(false);
    setCloudTranscriptionStatus("Cloud transcription cancelled. Retry whenever you want.");
    setRun((current) =>
      current
        ? {
            ...current,
            status: "cancelled",
            diagnostics: [
              ...current.diagnostics,
              {
                level: "warning",
                code: "CLOUD_TRANSCRIPTION_CANCELLED",
                message: "Cloud transcription was cancelled before artifacts were stored."
              }
            ],
            updatedAt: new Date().toISOString()
          }
        : current
    );
  }

  function importCaptionArtifactText(input: string) {
    const artifact = parseCaptionInterchangeArtifact(input);
    if (artifact) {
      setCaptionInput(transcriptToJsonInput(artifact.transcript));
      setCaptionStyleId(artifact.style.presetId);
      setHighlightedWords(artifact.style.highlightedWords.join(", "));
      setCaptionStyleOverrides(artifact.style.segmentStyleOverrides ?? {});
      setLastLocalTranscript(artifact.transcript);
      setLocalTranscriptionStatus("Imported Orreris caption artifact.");
      return;
    }

    const importedTranscript = parseTranscriptInput(input);
    setCaptionInput(transcriptToJsonInput(importedTranscript));
    setLastLocalTranscript(importedTranscript);
    setLocalTranscriptionStatus(`Imported ${importedTranscript.segments.length} caption segments.`);
  }

  async function importCaptionArtifactFile(file: File | null) {
    if (!file) {
      return;
    }
    importCaptionArtifactText(await file.text());
  }

  function exportCaptionData(format: "json" | "srt" | "vtt") {
    const artifact = createCaptionInterchangeArtifact({ transcript, captionTrack, stylePresetId: captionStyle.id });
    const body =
      format === "json"
        ? JSON.stringify(artifact, null, 2)
        : format === "srt"
          ? exportTranscriptToSrt(transcript)
          : exportTranscriptToVtt(transcript);
    const extension = format === "json" ? "orreris-captions.json" : format;
    downloadTextFile(`auto-captions.${extension}`, body, format === "json" ? "application/json" : "text/plain");
  }

  function updateTranscript(nextTranscript: TranscriptArtifactData) {
    setCaptionInput(transcriptToJsonInput(nextTranscript));
  }

  async function runCaptionIntelligence(action: "repair" | "improve") {
    const transcriptText = action === "repair" ? captionInput : transcriptToJsonInput(transcript);
    if (!transcriptText.trim()) {
      setCaptionIntelligenceStatus("Add or generate transcript text first.");
      return;
    }

    setBusy(true);
    setCaptionIntelligenceStatus(action === "repair" ? "Repairing transcript with Gemini..." : "Improving captions with Gemini...");
    try {
      const result = await transformAutoCaptions({
        action,
        transcriptText,
        language: cloudLanguage,
        durationSeconds: selectedAsset?.durationSeconds ?? transcript.durationSeconds,
        styleGoal: captionStyle.name,
        highlightedWords
      });
      setCaptionInput(transcriptToJsonInput(result.transcript));
      setLastLocalTranscript(result.transcript);
      setCaptionIntelligenceStatus(
        action === "repair"
          ? `Transcript repaired: ${result.transcript.segments.length} segments.`
          : `Captions improved: ${result.transcript.segments.length} segments.`
      );
    } catch (error) {
      setCaptionIntelligenceStatus(error instanceof Error ? error.message : "Caption intelligence failed.");
    } finally {
      setBusy(false);
    }
  }

  async function suggestHighlightsWithAi() {
    if (!transcript.segments.length) {
      setHighlightSuggestionStatus("Transcribe or paste a transcript first.");
      return;
    }

    setBusy(true);
    setHighlightSuggestionStatus("Finding important words with Gemini...");
    try {
      const result = await suggestAutoCaptionHighlights({
        transcriptText: transcriptToJsonInput(transcript),
        language: cloudLanguage
      });
      setHighlightedWords(result.words.join(", "));
      setHighlightSuggestionStatus(`Gemini picked ${result.words.length} highlight words: ${result.words.join(", ")}.`);
    } catch (error) {
      setHighlightSuggestionStatus(error instanceof Error ? error.message : "Highlight suggestion failed.");
    } finally {
      setBusy(false);
    }
  }

  function updateCaptionSegment(segmentId: string, patch: Partial<Pick<TranscriptSegment, "text" | "startSeconds" | "endSeconds">>) {
    const nextSegments = transcript.segments.map((segment) =>
      segment.id === segmentId
        ? rebuildSegment({
            ...segment,
            ...patch
          })
        : segment
    );
    updateTranscript({
      ...transcript,
      durationSeconds: Math.max(transcript.durationSeconds, nextSegments.at(-1)?.endSeconds ?? 0),
      segments: nextSegments
    });
  }

  function splitCaptionSegment(segmentId: string) {
    const segmentIndex = transcript.segments.findIndex((segment) => segment.id === segmentId);
    const segment = transcript.segments[segmentIndex];
    if (!segment) {
      return;
    }

    const words = segment.text.split(/\s+/).filter(Boolean);
    const splitIndex = Math.max(1, Math.floor(words.length / 2));
    const midTime = Number(((segment.startSeconds + segment.endSeconds) / 2).toFixed(3));
    const first = rebuildSegment({
      ...segment,
      id: `${segment.id}_a_${Date.now()}`,
      text: words.slice(0, splitIndex).join(" ") || segment.text,
      endSeconds: midTime
    });
    const second = rebuildSegment({
      ...segment,
      id: `${segment.id}_b_${Date.now()}`,
      text: words.slice(splitIndex).join(" ") || segment.text,
      startSeconds: midTime
    });
    const nextSegments = [...transcript.segments.slice(0, segmentIndex), first, second, ...transcript.segments.slice(segmentIndex + 1)];
    setSelectedCaptionSegmentId(second.id);
    updateTranscript({ ...transcript, segments: nextSegments });
  }

  function mergeCaptionSegmentWithNext(segmentId: string) {
    const segmentIndex = transcript.segments.findIndex((segment) => segment.id === segmentId);
    const segment = transcript.segments[segmentIndex];
    const next = transcript.segments[segmentIndex + 1];
    if (!segment || !next) {
      return;
    }

    const merged = rebuildSegment({
      ...segment,
      id: `${segment.id}_merged_${Date.now()}`,
      text: `${segment.text} ${next.text}`.replace(/\s+/g, " ").trim(),
      endSeconds: Math.max(segment.endSeconds, next.endSeconds)
    });
    const nextSegments = [...transcript.segments.slice(0, segmentIndex), merged, ...transcript.segments.slice(segmentIndex + 2)];
    setSelectedCaptionSegmentId(merged.id);
    updateTranscript({ ...transcript, segments: nextSegments });
  }

  function shiftCaptionSegment(segmentId: string, deltaSeconds: number) {
    const nextSegments = transcript.segments.map((segment) =>
      segment.id === segmentId
        ? rebuildSegment({
            ...segment,
            startSeconds: Math.max(0, Number((segment.startSeconds + deltaSeconds).toFixed(3))),
            endSeconds: Math.max(0.2, Number((segment.endSeconds + deltaSeconds).toFixed(3)))
          })
        : segment
    );
    updateTranscript({ ...transcript, segments: nextSegments });
  }

  function clampCaptionTiming() {
    let cursor = 0;
    const maxDuration = selectedAsset?.durationSeconds ?? Math.max(transcript.durationSeconds, transcript.segments.at(-1)?.endSeconds ?? 0);
    const nextSegments = transcript.segments
      .slice()
      .sort((a, b) => a.startSeconds - b.startSeconds)
      .map((segment) => {
        const startSeconds = Math.max(cursor, Math.min(segment.startSeconds, maxDuration));
        const endSeconds = Math.max(startSeconds + 0.2, Math.min(segment.endSeconds, maxDuration));
        cursor = endSeconds;
        return rebuildSegment({ ...segment, startSeconds, endSeconds });
      });
    updateTranscript({ ...transcript, durationSeconds: maxDuration, segments: nextSegments });
  }

  function confirmCaptionAssistantPlan() {
    setCaptionStyleId(captionAssistantPlan.suggestedStylePresetId);
    setHighlightedWords(captionAssistantPlan.suggestedHighlightedWords.join(", "));
    setCloudLanguage(captionAssistantPlan.suggestedLanguage);
    setCaptionStyleOverrides({});
  }

  function cancelRun() {
    controllerRef.current?.cancel();
    controllerRef.current = null;
  }

  function resetMockRun() {
    controllerRef.current?.cancel();
    controllerRef.current = null;
    setRun(createMockToolRun(tool));
  }

  async function applyMockToTimeline() {
    setBusy(true);
    try {
      const asset =
        selectedAsset ??
        (await createAsset({
          fileName: `${tool.slug}-source.mp4`,
          durationSeconds: Math.max(10, transcript.durationSeconds || subjectAnalysis.maskSequence.durationSeconds)
        }));
      const project = await createProject({
        title: `${tool.name} Tool Draft`,
        sourceAssetId: asset.id
      });
      await addEffect(project.id, tool.moduleType);
      if (isAutoCaptions) {
        const composition = project.projectGraph.composition;
        if (composition) {
          const projectWithCaptions = await patchProject(project.id, {
            projectGraph: {
              ...project.projectGraph,
              editableFields: {
                ...project.projectGraph.editableFields,
                transcript,
                captionTrack,
                captionInterchangeArtifact: createCaptionInterchangeArtifact({ transcript, captionTrack, stylePresetId: captionStyle.id }),
                lastLocalTranscript,
                captionStyle: captionStyle.id,
                captionHighlights: highlightedWords,
                captionStyleOverrides,
                captionSourceAssetId: asset.id
              },
              composition: applyCaptionTrackToComposition(prepareCaptionSourceComposition(composition, asset, transcript.durationSeconds), captionTrack, captionStyle),
              version: project.projectGraph.version + 1
            }
          });
          navigate(`/editor/${projectWithCaptions.id}`);
          return;
        }
      }
      if (isExtractPerson || isTextBehindPerson || isRemoveBackground) {
        const composition = project.projectGraph.composition;
        if (composition) {
          // One thin standalone apply over the same registered handler the editor
          // drives: `context: "standalone"` selects the builders' "replace" mode
          // (fresh draft project), and describeEditableFields supplies the durable
          // artifact patch. The page only adds its own page-state extras on top.
          const handler = getLayerToolEffectHandler(tool.slug)!;
          const applyArgs = {
            composition,
            layer: undefined,
            asset,
            result: isExtractPerson ? subjectAnalysis : subjectAnalysis.maskSequence,
            options: isTextBehindPerson
              ? { text: behindText, textColor: behindTextColor }
              : isRemoveBackground
                ? { mode: removeBackgroundMode }
                : {},
            context: "standalone" as const
          };
          const nextComposition = handler.applyResult(applyArgs);
          const pageExtras = isExtractPerson
            ? { maskFeather, trackingSmoothing }
            : { trackingPath: subjectAnalysis.trackingPath, subjectBounds: subjectAnalysis.subjectBounds };
          const projectWithArtifacts = await patchProject(project.id, {
            projectGraph: {
              ...project.projectGraph,
              editableFields: {
                ...project.projectGraph.editableFields,
                ...(handler.describeEditableFields?.(applyArgs) ?? {}),
                ...pageExtras
              },
              composition: nextComposition,
              version: project.projectGraph.version + 1
            }
          });
          navigate(`/editor/${projectWithArtifacts.id}`);
          return;
        }
      }
      navigate(`/editor/${project.id}`);
    } finally {
      setBusy(false);
    }
  }

  // Smart 3D Follow Text and Remove Person each own a dedicated, self-contained panel
  // (full tracking workspace / interactive tap-brush inpaint) rather than the generic
  // mask-composite shell. All hooks above run unconditionally before these branches, so
  // this is rules-of-hooks safe.
  if (isSmartFollowText) {
    return (
      <SmartFollowTextToolPanel
        tool={tool}
        assets={toolAssets}
        selectedAssetId={selectedAssetId}
        onSelectAsset={setSelectedAssetId}
        onUploadAsset={handleToolAssetUpload}
      />
    );
  }

  if (isRemovePerson) {
    return (
      <RemovePersonToolPanel
        tool={tool}
        assets={toolAssets}
        selectedAssetId={selectedAssetId}
        onSelectAsset={setSelectedAssetId}
        onUploadAsset={handleToolAssetUpload}
      />
    );
  }

  if (isAiRoto) {
    return (
      <AiRotoToolPanel
        tool={tool}
        assets={toolAssets}
        selectedAssetId={selectedAssetId}
        onSelectAsset={setSelectedAssetId}
        onUploadAsset={handleToolAssetUpload}
      />
    );
  }

  return (
    <div className={`page tool-detail-page ${isTabbedTool ? "tool-detail-page-captions" : ""}`}>
      <header className="mkt-tdh">
        <Link to="/tools" className="mkt-tdh-back">
          <ArrowLeft size={13} /> All tools
        </Link>
        <div className="mkt-tdh-body">
          <span className="mkt-ic mkt-tdh-ic">{(() => { const Icon = TOOL_ICONS[tool.icon ?? "generic"] ?? Wrench; return <Icon size={22} />; })()}</span>
          <div className="mkt-tdh-text">
            <span className="mkt-eyebrow">{tool.category} · {tool.browserMode}</span>
            <h1>{tool.name}</h1>
            <p>{tool.userDescription}</p>
            <div className="mkt-tdh-stages">
              {tool.stages.map((stage) => (
                <span key={stage}>{stageLabel(stage)}</span>
              ))}
            </div>
          </div>
          <span className={`mkt-tdh-credits ${(tool.estimatedCredits ?? 0) === 0 ? "free" : ""}`}>
            {(tool.estimatedCredits ?? 0) === 0 ? "Free" : `${tool.estimatedCredits} credits`}
          </span>
        </div>
      </header>

      <section className={`tool-shell ${isTabbedTool ? "tool-shell-captions" : ""}`}>
        {!isTabbedTool ? (
          <Card className="tool-stage-panel">
            <div className="panel-heading">
              <h2>Stages</h2>
              <Badge tone={run.status === "completed" ? "lime" : "muted"}>{run.status}</Badge>
            </div>
            <div className="tool-stage-list">
              {tool.stages.map((stage, index) => (
                <button className={index === activeStageIndex ? "is-active" : index < activeStageIndex ? "is-complete" : ""} key={stage} type="button">
                  {index < activeStageIndex ? <Check size={14} /> : index === activeStageIndex ? <Clock3 size={14} /> : <Circle size={14} />}
                  <span>{stageLabel(stage)}</span>
                </button>
              ))}
            </div>
          </Card>
        ) : null}

        <Card className="tool-preview-panel">
          <div className="tool-preview-top">
            <Badge tone="muted">{isAutoCaptions ? "Preview" : isExtractPerson ? "Live mask preview" : "TL6 adapters"}</Badge>
            <span>
              {isAutoCaptions
                ? `${captionTrack.segments.length} captions`
                : isExtractPerson
                  ? hasRealMatte
                    ? "Real matte"
                    : "Placeholder"
                  : `${run.progress}%`}
            </span>
          </div>
          <div className="tool-preview-canvas">
            {isAutoCaptions ? (
              captionPreviewComposition && selectedAsset ? (
                <div className="caption-real-preview">
                  <AutoCaptionMediaPreview
                    asset={selectedAsset}
                    composition={captionPreviewComposition}
                    currentTime={captionPreviewTime}
                    textLayer={captionPreviewLayer}
                  />
                  <span>{activeCaptionPreviewSegment ? `${activeCaptionPreviewSegment.startSeconds.toFixed(2)}s` : "0.00s"}</span>
                </div>
              ) : (
                <CaptionPreview captionTrack={captionTrack} stylePreset={captionStyle} />
              )
            ) : usesMaskComposite ? (
              <MaskInspectorPreview
                analysis={subjectAnalysis}
                frameIndex={maskFrameIndex}
                mode={isTextBehindPerson ? "textBehind" : isRemoveBackground ? removeBackgroundMode : "extract"}
                text={behindText}
                textColor={behindTextColor}
              />
            ) : (
              <>
                <WandSparkles size={34} />
                <h2>{stageLabel(run.stage)}</h2>
                <p>{tool.shortDescription}</p>
                <div className="tool-progress-track">
                  <span style={{ width: `${run.progress}%` }} />
                </div>
              </>
            )}
          </div>
          {!isAutoCaptions && !isExtractPerson ? (
            <>
              <div className="tool-adapter-selector" aria-label="Tool adapter">
                {tool.adapters.map((adapter) => {
                  const capability = runtime?.adapters.find((item) => item.type === adapter);
                  const disabled = capability?.status === "unavailable" || capability?.status === "planned";
                  return (
                    <button
                      className={selectedAdapter === adapter ? "is-active" : ""}
                      disabled={disabled || run.status === "running"}
                      key={adapter}
                      title={capability?.description}
                      type="button"
                      onClick={() => setSelectedAdapter(adapter)}
                    >
                      <span>{capability?.label ?? adapter}</span>
                      <small>{capability?.status ?? "detecting"}</small>
                    </button>
                  );
                })}
              </div>
              <div className="tool-action-row">
                <Button disabled={run.status === "running" || selectedAdapterCapability?.status === "unavailable" || selectedAdapterCapability?.status === "planned"} icon={<Play size={15} />} onClick={() => void startToolRun()}>
                  Run {selectedAdapter}
                </Button>
                <Button disabled={run.status !== "running"} icon={<Square size={15} />} variant="secondary" onClick={cancelRun}>
                  Cancel
                </Button>
                <Button icon={<RotateCcw size={15} />} variant="secondary" onClick={resetMockRun}>
                  Reset
                </Button>
              </div>
            </>
          ) : null}
        </Card>

        <Card className={`tool-results-panel ${isTabbedTool ? "caption-workspace-panel" : ""}`}>
          {!isAutoCaptions && !isExtractPerson ? (
            <>
              <div className="panel-heading">
                <h2>Capability</h2>
                <Badge tone="muted">{tool.browserMode}</Badge>
              </div>
              <div className="tool-capability-copy">
                <p>{tool.aiDescription}</p>
              </div>
            </>
          ) : null}

          {isAutoCaptions ? (
            <AutoCaptionsPanel
              captionInput={captionInput}
              captionStyleId={captionStyleId}
              captionStyleOverrides={captionStyleOverrides}
              assistantPlan={captionAssistantPlan}
              captionTrack={captionTrack}
              cloudLanguage={cloudLanguage}
              cloudTranscriptionRunId={cloudTranscriptionRunId}
              cloudTranscriptionStatus={cloudTranscriptionStatus}
              captionIntelligenceStatus={captionIntelligenceStatus}
              highlightSuggestionStatus={highlightSuggestionStatus}
              highlightedWords={highlightedWords}
              localTranscriptionStatus={localTranscriptionStatus}
              prompt={captionPrompt}
              selectedSegmentId={selectedCaptionSegmentId}
              transcriptionRunId={transcriptionRunId}
              transcriptIssues={transcriptIssues}
              assets={toolAssets.filter((asset) => isCompatibleToolAsset(tool, asset))}
              busy={busy}
              selectedAssetId={selectedAssetId}
              onChangeCaptionInput={setCaptionInput}
              onChangeHighlightedWords={setHighlightedWords}
              onChangeStyle={setCaptionStyleId}
              onConfirmAssistantPlan={confirmCaptionAssistantPlan}
              onChangeSegmentStyle={(segmentId, patch) =>
                setCaptionStyleOverrides((current) => ({
                  ...current,
                  [segmentId]: {
                    ...(current[segmentId] ?? {}),
                    ...patch
                  }
                }))
              }
              onCancelTranscribe={cancelLocalTranscribe}
              onCancelCloudTranscribe={cancelCloudTranscribe}
              onClampTiming={clampCaptionTiming}
              onCloudTranscribe={handleCloudTranscribe}
              onChangeCloudLanguage={setCloudLanguage}
              onExportCaptionData={exportCaptionData}
              onImportCaptionFile={(file) => void importCaptionArtifactFile(file)}
              onCaptionIntelligence={(action) => void runCaptionIntelligence(action)}
              onSuggestHighlights={() => void suggestHighlightsWithAi()}
              onMergeSegment={mergeCaptionSegmentWithNext}
              onSelectAsset={setSelectedAssetId}
              onSelectSegment={setSelectedCaptionSegmentId}
              onShiftSegment={shiftCaptionSegment}
              onSplitSegment={splitCaptionSegment}
              onTranscribeLocal={handleLocalTranscribe}
              onUpdateSegment={updateCaptionSegment}
              onUploadAsset={handleToolAssetUpload}
            />
          ) : null}

          {isExtractPerson ? (
            <ExtractPersonPanel
              analysis={subjectAnalysis}
              assets={toolAssets.filter((asset) => isCompatibleToolAsset(tool, asset))}
              busy={busy}
              deviceProfile={segmentationDeviceProfile}
              feather={maskFeather}
              frameIndex={maskFrameIndex}
              hasRealMatte={hasRealMatte}
              segmentationRunId={segmentationRunId}
              segmentationStage={segmentationStage}
              segmentationStatus={segmentationStatus}
              selectedAssetId={selectedAssetId}
              smoothing={trackingSmoothing}
              onBakeQuality={() => void handleBakeQualityMatte()}
              onCancelSegmentation={cancelExtractPerson}
              onChangeFeather={setMaskFeather}
              onChangeFrameIndex={setMaskFrameIndex}
              onChangeSmoothing={setTrackingSmoothing}
              onExtract={() => void handleExtractPerson()}
              onSelectAsset={setSelectedAssetId}
              onUploadAsset={handleToolAssetUpload}
            />
          ) : null}

          {isTextBehindPerson ? (
            <TextBehindPersonPanel
              color={behindTextColor}
              text={behindText}
              onChangeColor={setBehindTextColor}
              onChangeText={setBehindText}
            />
          ) : null}

          {isRemoveBackground ? (
            <RemoveBackgroundPanel mode={removeBackgroundMode} onChangeMode={setRemoveBackgroundMode} />
          ) : null}

          {!isAutoCaptions && !isExtractPerson ? (
            <details className="tool-dev-details">
              <summary>Developer details</summary>
              <div className="tool-meta-section">
                <h3>Outputs</h3>
                <div className="tool-chip-list">
                  {previewArtifacts.map((artifact) => (
                    <span key={artifact}>
                      <FileJson size={13} />
                      {artifact}
                    </span>
                  ))}
                </div>
              </div>

              <div className="tool-meta-section">
                <h3>Adapters</h3>
                <div className="tool-chip-list">
                  {tool.adapters.map((adapter) => (
                    <span key={adapter}>{adapter}{selectedAdapter === adapter ? " selected" : ""}</span>
                  ))}
                </div>
              </div>

              <div className="tool-meta-section">
                <h3>Runtime</h3>
                <div className="tool-chip-list">
                  <span>{runtime?.artifactStoreKind ?? "detecting"} store</span>
                  <span>{runtime?.capabilities.webWorkers ? "workers" : "no workers"}</span>
                  <span>{runtime?.capabilities.opfs ? "opfs" : "memory"}</span>
                  <span>{runtime?.capabilities.offscreenCanvas ? "offscreen" : "canvas"}</span>
                </div>
              </div>

              <div className="tool-diagnostics">
                {runtime?.diagnostics.map((diagnostic) => (
                  <p key={diagnostic.code ?? diagnostic.message}>
                    <Info size={14} />
                    {diagnostic.message}
                  </p>
                ))}
                {selectedAdapterCapability?.diagnostics.map((diagnostic) => (
                  <p key={diagnostic.code ?? diagnostic.message}>
                    <Info size={14} />
                    {diagnostic.message}
                  </p>
                ))}
                {run.diagnostics.map((diagnostic) => (
                  <p key={diagnostic.code ?? diagnostic.message}>
                    <Info size={14} />
                    {diagnostic.message}
                  </p>
                ))}
              </div>
            </details>
          ) : null}

          <div className={isTabbedTool ? "caption-apply-footer" : ""}>
            <Button
              disabled={busy || (isAutoCaptions && !captionTrack.segments.length) || (isExtractPerson && !hasRealMatte)}
              icon={<Check size={15} />}
              onClick={applyMockToTimeline}
            >
              {busy ? "Working..." : isAutoCaptions ? "Apply captions" : "Apply to timeline"}
            </Button>
            {isAutoCaptions && !captionTrack.segments.length ? (
              <p className="caption-status-line">Transcribe or paste a transcript first.</p>
            ) : null}
            {isExtractPerson && !hasRealMatte ? <p className="caption-status-line">Extract a person first.</p> : null}
          </div>
        </Card>
      </section>
    </div>
  );
}

function ExtractPersonPanel({
  analysis,
  assets,
  busy,
  deviceProfile,
  feather,
  frameIndex,
  hasRealMatte,
  segmentationRunId,
  segmentationStage,
  segmentationStatus,
  selectedAssetId,
  smoothing,
  onBakeQuality,
  onCancelSegmentation,
  onChangeFeather,
  onChangeFrameIndex,
  onChangeSmoothing,
  onExtract,
  onSelectAsset,
  onUploadAsset
}: {
  analysis: SubjectAnalysisArtifacts;
  assets: SourceAsset[];
  busy: boolean;
  deviceProfile: SegmentationDeviceProfile | undefined;
  feather: number;
  frameIndex: number;
  hasRealMatte: boolean;
  segmentationRunId: number;
  segmentationStage: "idle" | "fast" | "quality";
  segmentationStatus: string;
  selectedAssetId: string;
  smoothing: number;
  onBakeQuality: () => void;
  onCancelSegmentation: () => void;
  onChangeFeather: (value: number) => void;
  onChangeFrameIndex: (value: number) => void;
  onChangeSmoothing: (value: number) => void;
  onExtract: () => void;
  onSelectAsset: (value: string) => void;
  onUploadAsset: (file: File | null) => void;
}) {
  const frame = analysis.maskSequence.frames[Math.min(frameIndex, analysis.maskSequence.frames.length - 1)];
  const trackingPoint = analysis.trackingPath.points[Math.min(frameIndex, analysis.trackingPath.points.length - 1)];
  const selectedAsset = assets.find((asset) => asset.id === selectedAssetId);
  const isRunning = segmentationRunId > 0;

  const [activeTab, setActiveTab] = useState<"upload" | "adjust">("upload");
  const [showQualityWarning, setShowQualityWarning] = useState(false);
  const autoSwitchedRef = useRef(false);
  useEffect(() => {
    if (hasRealMatte && !autoSwitchedRef.current) {
      autoSwitchedRef.current = true;
      setActiveTab("adjust");
    }
  }, [hasRealMatte]);

  const tabs: Array<{ id: "upload" | "adjust"; label: string; icon: ReactNode }> = [
    { id: "upload", label: "Upload", icon: <Upload size={14} /> },
    { id: "adjust", label: "Adjust", icon: <WandSparkles size={14} /> }
  ];

  return (
    <div className="caption-tool-panel">
      <div className="caption-tabs" role="tablist" aria-label="Extract Person sections">
        {tabs.map((tab) => (
          <button
            aria-selected={activeTab === tab.id}
            className={activeTab === tab.id ? "is-active" : ""}
            key={tab.id}
            role="tab"
            type="button"
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.icon}
            <span>{tab.label}</span>
          </button>
        ))}
      </div>

      {activeTab === "upload" ? (
        <div className="caption-tab-panel mask-tool-panel">
          <div className="caption-input-card">
            <div>
              <span>Source video</span>
              <strong>{selectedAsset?.fileName ?? "No video selected"}</strong>
              <small>
                {selectedAsset
                  ? `${selectedAsset.fileType} · ${selectedAsset.durationSeconds.toFixed(2)}s`
                  : "Upload a talking-head clip to extract the person from."}
              </small>
            </div>
            <label className="caption-upload-button">
              <Upload size={14} />
              {busy && !isRunning ? "Uploading" : "Upload"}
              <input accept="video/*" disabled={busy} type="file" onChange={(event) => onUploadAsset(event.currentTarget.files?.[0] ?? null)} />
            </label>
          </div>

          {assets.length ? (
            <label className="caption-media-picker">
              <span>Or use existing media</span>
              <ThemedSelect
                ariaLabel="Existing media"
                value={selectedAssetId}
                placeholder="Select media"
                options={[
                  { value: "", label: "Select media" },
                  ...assets.map((asset) => ({ value: asset.id, label: `${asset.fileName} · ${asset.durationSeconds.toFixed(2)}s` }))
                ]}
                onChange={(next) => onSelectAsset(next)}
              />
            </label>
          ) : null}

          <div className="caption-local-transcribe">
            <button disabled={busy || !selectedAsset} type="button" onClick={onExtract}>
              {segmentationStage === "fast" ? "Extracting..." : "Extract person"}
            </button>
            <button
              className="is-secondary"
              disabled={busy || !selectedAsset}
              type="button"
              onClick={() => setShowQualityWarning(true)}
            >
              {segmentationStage === "quality" ? "Baking..." : "Bake high quality"}
            </button>
            {isRunning ? (
              <button className="is-secondary" type="button" onClick={onCancelSegmentation}>
                Cancel
              </button>
            ) : null}
            {isRunning ? <AiActivityIndicator label={segmentationStatus || "Working..."} /> : segmentationStatus ? <p>{segmentationStatus}</p> : null}
          </div>

          {showQualityWarning ? (
            <div className="mask-quality-warning">
              <p>
                High-quality baking runs a heavier model on this device{deviceProfile?.executionProvider === "webgpu" ? " (accelerated by WebGPU)" : " on the CPU, since this device has no WebGPU"}
                . It can take noticeably longer than the fast preview and will use significant CPU/GPU - on a laptop, expect it to run hot and drain battery faster while it works. Make sure your device has the resources free before continuing
                {deviceProfile?.suggestCloudOffload ? ", or consider a shorter clip since this one is long for CPU-only matting." : "."}
              </p>
              <div className="mask-quality-warning-actions">
                <button
                  type="button"
                  onClick={() => {
                    setShowQualityWarning(false);
                    onBakeQuality();
                  }}
                >
                  Continue
                </button>
                <button className="is-secondary" type="button" onClick={() => setShowQualityWarning(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : null}

          {deviceProfile ? (
            <p className="mask-device-note">
              {deviceProfile.executionProvider === "webgpu"
                ? "This device has WebGPU - the high-quality bake will run accelerated."
                : "No WebGPU on this device - the high-quality bake still works, just slower (CPU)."}
              {deviceProfile.suggestCloudOffload ? " This clip is long for CPU-only matting - cloud offload is recommended once available." : ""}
            </p>
          ) : null}
        </div>
      ) : null}

      {activeTab === "adjust" ? (
        <div className="caption-tab-panel mask-tool-panel">
          <label>
            <span>Frame</span>
            <input
              max={Math.max(0, analysis.maskSequence.frames.length - 1)}
              min={0}
              step={1}
              type="range"
              value={frameIndex}
              onChange={(event) => onChangeFrameIndex(Number(event.target.value))}
            />
          </label>
          <label>
            <span>Edge feather</span>
            <input min={0} max={24} step={1} type="range" value={feather} onChange={(event) => onChangeFeather(Number(event.target.value))} />
          </label>
          <label>
            <span>Tracking smoothing</span>
            <input min={0} max={0.95} step={0.05} type="range" value={smoothing} onChange={(event) => onChangeSmoothing(Number(event.target.value))} />
          </label>

          <div className="mask-stats-grid">
            <span>
              <strong>{frame?.timeSeconds.toFixed(2) ?? "0.00"}s</strong>
              time
            </span>
            <span>
              <strong>{Math.round((frame?.confidence ?? 0) * 100)}%</strong>
              mask confidence
            </span>
            <span>
              <strong>{trackingPoint?.position.x.toFixed(1) ?? "0"}, {trackingPoint?.position.y.toFixed(1) ?? "0"}</strong>
              subject center
            </span>
          </div>
          <p className="mask-device-note">
            {hasRealMatte
              ? analysis.maskSequence.edgeMode === "clean"
                ? "High-quality matte baked - ready to apply."
                : "Fast preview matte baked - usable now, bake high quality for the cleanest export."
              : "Extract a person on the Upload tab first."}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function TextBehindPersonPanel({
  color,
  text,
  onChangeColor,
  onChangeText
}: {
  color: string;
  text: string;
  onChangeColor: (value: string) => void;
  onChangeText: (value: string) => void;
}) {
  return (
    <div className="composite-tool-panel">
      <label>
        <span>Behind text</span>
        <input value={text} onChange={(event) => onChangeText(event.target.value)} />
      </label>
      <label>
        <span>Text color</span>
        <input type="color" value={color} onChange={(event) => onChangeColor(event.target.value)} />
      </label>
      <p>Apply creates an editable background layer, text layer, and masked foreground subject layer.</p>
    </div>
  );
}

function RemoveBackgroundPanel({
  mode,
  onChangeMode
}: {
  mode: "timelineMask" | "greenScreen";
  onChangeMode: (value: "timelineMask" | "greenScreen") => void;
}) {
  return (
    <div className="composite-tool-panel">
      <span>Output mode</span>
      <div className="composite-mode-grid">
        <button className={mode === "timelineMask" ? "is-active" : ""} type="button" onClick={() => onChangeMode("timelineMask")}>
          Timeline mask
        </button>
        <button className={mode === "greenScreen" ? "is-active" : ""} type="button" onClick={() => onChangeMode("greenScreen")}>
          Green screen
        </button>
      </div>
      <p>Apply creates a masked subject layer plus a preview plate. Real alpha export remains a renderer task.</p>
    </div>
  );
}

function MaskInspectorPreview({
  analysis,
  frameIndex,
  mode = "extract",
  text = "NEW DROP",
  textColor = "#4D9FFF"
}: {
  analysis: SubjectAnalysisArtifacts;
  frameIndex: number;
  mode?: "extract" | "textBehind" | "timelineMask" | "greenScreen" | "followText";
  text?: string;
  textColor?: string;
}) {
  const frame = analysis.maskSequence.frames[Math.min(frameIndex, analysis.maskSequence.frames.length - 1)];
  const points = analysis.trackingPath.points;
  const activePoint = points[Math.min(frameIndex, points.length - 1)];
  const activeX = activePoint ? activePoint.position.x * 3.2 : 180;
  const activeY = activePoint ? activePoint.position.y * 5.4 - 54 : 260;
  const pathPoints = points.map((point) => `${point.position.x * 3.2},${point.position.y * 5.4}`).join(" ");

  return (
    <div className={`mask-preview-frame mask-preview-${mode}`}>
      <Badge tone="lime">
        {mode === "followText"
          ? "Follow text"
          : mode === "textBehind"
            ? "Text behind"
            : mode === "greenScreen"
              ? "Green screen"
              : mode === "timelineMask"
                ? "Removed bg"
                : "Mock mask"}
      </Badge>
      <svg viewBox="0 0 360 640" role="img" aria-label="Person mask preview">
        <rect className="mask-preview-bg" x="0" y="0" width="360" height="640" rx="18" />
        {mode === "greenScreen" ? <rect className="mask-preview-green" x="12" y="12" width="336" height="616" rx="14" /> : null}
        {mode === "textBehind" ? (
          <text className="mask-preview-behind-text" x="180" y="292" fill={textColor}>
            {text.slice(0, 18)}
          </text>
        ) : null}
        {mode === "followText" ? (
          <text className="mask-preview-follow-text" x={activeX} y={activeY} fill={textColor}>
            {text.slice(0, 16)}
          </text>
        ) : null}
        <g transform="scale(3.2 5.4)">
          {frame ? <path className="mask-preview-subject" d={frame.previewPath} /> : null}
        </g>
        <polyline className="mask-preview-path" points={pathPoints} />
        {points.map((point, index) => (
          <circle
            className={index === frameIndex ? "is-active" : ""}
            cx={point.position.x * 3.2}
            cy={point.position.y * 5.4}
            key={`${point.timeSeconds}_${index}`}
            r={index === frameIndex ? 5 : 3}
          />
        ))}
      </svg>
      <p>{analysis.maskSequence.frames.length} mask frames and {analysis.trackingPath.points.length} tracking points ready</p>
      <div className="tool-progress-track">
        <span style={{ width: `${Math.round((frame?.confidence ?? 0) * 100)}%` }} />
      </div>
    </div>
  );
}

const captionLanguageOptions: Array<{ label: string; value: CloudTranscriptionLanguage }> = [
  { label: "Auto", value: "auto" },
  { label: "EN", value: "english" },
  { label: "HI", value: "hindi" },
  { label: "Hinglish", value: "hinglish" }
];

const captionEmphasisOptions: Array<{ id: NonNullable<CaptionSegmentStyleOverride["emphasis"]>; label: string }> = [
  { id: "none", label: "None" },
  { id: "pop-word", label: "Pop" },
  { id: "zoom-phrase", label: "Zoom" },
  { id: "shake-warning", label: "Shake" }
];

function CaptionSlider({
  label,
  value,
  min,
  max,
  step = 1,
  suffix = "",
  onChange
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  const safeValue = Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
  const percent = ((safeValue - min) / Math.max(0.0001, max - min)) * 100;
  return (
    <label className="caption-slider" style={{ "--slider-percent": `${percent}%` } as CSSProperties}>
      <span className="caption-slider-label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={safeValue}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="caption-slider-value">
        {step < 1 ? Math.round(safeValue * 100) / 100 : Math.round(safeValue)}
        {suffix}
      </span>
    </label>
  );
}

type AutoCaptionTab = "media" | "timing" | "style" | "export";

function AutoCaptionsPanel({
  assets,
  assistantPlan,
  busy,
  captionInput,
  captionStyleId,
  captionStyleOverrides,
  captionTrack,
  cloudLanguage,
  cloudTranscriptionRunId,
  cloudTranscriptionStatus,
  captionIntelligenceStatus,
  highlightSuggestionStatus,
  highlightedWords,
  localTranscriptionStatus,
  prompt,
  selectedAssetId,
  selectedSegmentId,
  transcriptionRunId,
  transcriptIssues,
  onChangeCaptionInput,
  onChangeCloudLanguage,
  onChangeHighlightedWords,
  onChangeSegmentStyle,
  onChangeStyle,
  onConfirmAssistantPlan,
  onCancelCloudTranscribe,
  onCancelTranscribe,
  onClampTiming,
  onCloudTranscribe,
  onExportCaptionData,
  onImportCaptionFile,
  onCaptionIntelligence,
  onSuggestHighlights,
  onMergeSegment,
  onSelectAsset,
  onSelectSegment,
  onShiftSegment,
  onSplitSegment,
  onTranscribeLocal,
  onUpdateSegment,
  onUploadAsset
}: {
  assets: SourceAsset[];
  assistantPlan: ReturnType<typeof createAutoCaptionAssistantPlan>;
  busy: boolean;
  captionInput: string;
  captionStyleId: string;
  captionStyleOverrides: Record<string, CaptionSegmentStyleOverride>;
  captionTrack: CaptionTrackData;
  cloudLanguage: CloudTranscriptionLanguage;
  cloudTranscriptionRunId: string;
  cloudTranscriptionStatus: string;
  captionIntelligenceStatus: string;
  highlightSuggestionStatus: string;
  highlightedWords: string;
  localTranscriptionStatus: string;
  prompt: string;
  selectedAssetId: string;
  selectedSegmentId: string;
  transcriptionRunId: number;
  transcriptIssues: ReturnType<typeof validateTranscriptArtifact>;
  onChangeCaptionInput: (value: string) => void;
  onChangeCloudLanguage: (value: CloudTranscriptionLanguage) => void;
  onChangeHighlightedWords: (value: string) => void;
  onChangeSegmentStyle: (segmentId: string, patch: CaptionSegmentStyleOverride) => void;
  onChangeStyle: (value: string) => void;
  onConfirmAssistantPlan: () => void;
  onCancelCloudTranscribe: () => void;
  onCancelTranscribe: () => void;
  onClampTiming: () => void;
  onCloudTranscribe: () => void;
  onExportCaptionData: (format: "json" | "srt" | "vtt") => void;
  onImportCaptionFile: (file: File | null) => void;
  onCaptionIntelligence: (action: "repair" | "improve") => void;
  onSuggestHighlights: () => void;
  onMergeSegment: (segmentId: string) => void;
  onSelectAsset: (value: string) => void;
  onSelectSegment: (value: string) => void;
  onShiftSegment: (segmentId: string, deltaSeconds: number) => void;
  onSplitSegment: (segmentId: string) => void;
  onTranscribeLocal: () => void;
  onUpdateSegment: (segmentId: string, patch: Partial<Pick<TranscriptSegment, "text" | "startSeconds" | "endSeconds">>) => void;
  onUploadAsset: (file: File | null) => void;
}) {
  const selectedAsset = assets.find((asset) => asset.id === selectedAssetId);
  const durationSeconds = Math.max(selectedAsset?.durationSeconds ?? 0, captionTrack.segments.at(-1)?.endSeconds ?? 0, 1);
  const selectedSegment = captionTrack.segments.find((segment) => segment.id === selectedSegmentId);
  const globalOverride = captionTrack.segments[0] ? captionStyleOverrides[captionTrack.segments[0].id] ?? {} : {};
  const globalStyle = captionStylePresets.find((preset) => preset.id === (globalOverride.stylePresetId ?? captionStyleId)) ?? captionStylePresets[0]!;
  const globalStrokeColor = globalOverride.strokeColor ?? globalStyle.strokeColor;
  const globalStrokeWidth = globalOverride.strokeWidth ?? globalStyle.strokeWidth;
  const backgroundParsed = parseBackgroundColor(globalOverride.backgroundColor, globalStyle.backgroundColor ?? "#08090d");
  const applyToAllSegments = (patch: CaptionSegmentStyleOverride) => {
    captionTrack.segments.forEach((segment) => onChangeSegmentStyle(segment.id, patch));
  };
  const highlightSet = new Set(captionTrack.highlightedWords.map((word) => normalizeCaptionWord(word)));
  const highlightWords = getTranscriptWordChoices(captionTrack.segments);
  const toggleHighlightWord = (word: string) => {
    const normalized = normalizeCaptionWord(word);
    const nextWords = new Set(captionTrack.highlightedWords.map((item) => normalizeCaptionWord(item)));
    if (nextWords.has(normalized)) {
      nextWords.delete(normalized);
    } else {
      nextWords.add(normalized);
    }
    onChangeHighlightedWords(Array.from(nextWords).join(", "));
  };

  const hasSegments = captionTrack.segments.length > 0;
  const errorCount = transcriptIssues.filter((issue) => issue.level === "error").length;
  const [activeTab, setActiveTab] = useState<AutoCaptionTab>("media");
  const autoSwitchedRef = useRef(false);
  useEffect(() => {
    if (hasSegments && !autoSwitchedRef.current) {
      autoSwitchedRef.current = true;
      setActiveTab("timing");
    }
  }, [hasSegments]);

  const [imagePalette, setImagePalette] = useState(defaultColorPalette);
  useEffect(() => {
    let alive = true;
    if (!selectedAsset) {
      setImagePalette(defaultColorPalette);
      return;
    }
    extractPaletteFromAsset(selectedAsset)
      .then((palette) => {
        if (alive) {
          setImagePalette(palette.length ? palette : defaultColorPalette);
        }
      })
      .catch(() => {
        if (alive) {
          setImagePalette(defaultColorPalette);
        }
      });
    return () => {
      alive = false;
    };
  }, [selectedAsset?.id]);

  const tabs: Array<{ id: AutoCaptionTab; label: string; icon: ReactNode; badge?: string | undefined }> = [
    { id: "media", label: "Media", icon: <Upload size={14} /> },
    { id: "timing", label: "Timing", icon: <Clock3 size={14} />, badge: hasSegments ? String(captionTrack.segments.length) : undefined },
    { id: "style", label: "Style", icon: <WandSparkles size={14} /> },
    { id: "export", label: "Export", icon: <FileJson size={14} /> }
  ];

  return (
    <div className="caption-tool-panel">
      <div className="caption-tabs" role="tablist" aria-label="Auto Captions sections">
        {tabs.map((tab) => (
          <button
            aria-selected={activeTab === tab.id}
            className={activeTab === tab.id ? "is-active" : ""}
            key={tab.id}
            role="tab"
            type="button"
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.icon}
            <span>{tab.label}</span>
            {tab.badge ? <em>{tab.badge}</em> : null}
            {tab.id === "timing" && errorCount > 0 ? <i className="caption-tab-alert" aria-label={`${errorCount} issues`} /> : null}
          </button>
        ))}
      </div>

      {activeTab === "media" ? (
        <div className="caption-tab-panel">
          <div className="caption-input-card">
            <div>
              <span>Media</span>
              <strong>{selectedAsset?.fileName ?? "No media selected"}</strong>
              <small>
                {selectedAsset
                  ? `${selectedAsset.fileType} · ${selectedAsset.durationSeconds.toFixed(2)}s`
                  : "Upload or choose audio/video before applying captions."}
              </small>
            </div>
            <label className="caption-upload-button">
              <Upload size={14} />
              {busy ? "Uploading" : "Upload"}
              <input accept="video/*,audio/*" disabled={busy} type="file" onChange={(event) => onUploadAsset(event.currentTarget.files?.[0] ?? null)} />
            </label>
          </div>

          {assets.length ? (
            <label className="caption-media-picker">
              <span>Or use existing media</span>
              <ThemedSelect
                ariaLabel="Existing media"
                value={selectedAssetId}
                placeholder="Select media"
                options={[
                  { value: "", label: "Select media" },
                  ...assets.map((asset) => ({ value: asset.id, label: `${asset.fileName} · ${asset.durationSeconds.toFixed(2)}s` }))
                ]}
                onChange={(next) => onSelectAsset(next)}
              />
            </label>
          ) : null}

          <div className="caption-local-transcribe">
            <button disabled={busy || !selectedAsset} type="button" onClick={onTranscribeLocal}>
              Transcribe locally
            </button>
            {transcriptionRunId ? (
              <button className="is-secondary" type="button" onClick={onCancelTranscribe}>
                Cancel
              </button>
            ) : null}
            {transcriptionRunId ? (
              <AiActivityIndicator label={localTranscriptionStatus || "Transcribing on your device..."} />
            ) : (
              <p>
                {localTranscriptionStatus ||
                  "Runs on your device. First use downloads a small speech model."}
              </p>
            )}
          </div>

          <div className="caption-cloud-transcribe">
            <div>
              <span>Cloud transcribe (Gemini)</span>
              <div className="caption-language-pills" aria-label="Caption language mode">
                {captionLanguageOptions.map((option) => (
                  <button
                    className={cloudLanguage === option.value ? "is-active" : ""}
                    disabled={busy}
                    key={option.value}
                    type="button"
                    onClick={() => onChangeCloudLanguage(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
            <button disabled={busy || !selectedAsset} type="button" onClick={onCloudTranscribe}>
              Cloud transcribe
            </button>
            {selectedAsset ? (
              <ShadowCostBadge action="caption.cloud-transcribe" units={selectedAsset.durationSeconds / 60} />
            ) : null}
            {cloudTranscriptionRunId ? (
              <button className="is-secondary" type="button" onClick={onCancelCloudTranscribe}>
                Cancel
              </button>
            ) : null}
            {cloudTranscriptionRunId ? (
              <AiActivityIndicator label={cloudTranscriptionStatus || "Gemini is transcribing..."} />
            ) : (
              <p>{cloudTranscriptionStatus || "Gemini creates editable captions with segment and word timing."}</p>
            )}
          </div>

          <div className="caption-onboarding-card">
            <span>Quick test checklist</span>
            <p>Try one short English clip, one Hindi or Hinglish clip, and one noisy clip before trusting a preset.</p>
          </div>
        </div>
      ) : null}

      {activeTab === "timing" ? (
        <div className="caption-tab-panel">
          {hasSegments ? (
            transcriptIssues.length ? (
              <div className="caption-validation-list">
                {transcriptIssues.slice(0, 6).map((issue) => {
                  const segment = issue.segmentId ? captionTrack.segments.find((item) => item.id === issue.segmentId) : undefined;
                  const content = (
                    <>
                      <Info size={13} />
                      <span>
                        {segment ? <em>{segment.startSeconds.toFixed(1)}s</em> : null}
                        {issue.message}
                      </span>
                    </>
                  );
                  return segment ? (
                    <button
                      className={issue.level === "error" ? "is-error" : ""}
                      key={`${issue.code}_${issue.segmentId ?? "global"}`}
                      type="button"
                      onClick={() => onSelectSegment(segment.id)}
                    >
                      {content}
                    </button>
                  ) : (
                    <p className={issue.level === "error" ? "is-error" : ""} key={`${issue.code}_${issue.segmentId ?? "global"}`}>
                      {content}
                    </p>
                  );
                })}
                {transcriptIssues.length > 6 ? <p className="caption-status-line">+{transcriptIssues.length - 6} more — fix the ones above first.</p> : null}
              </div>
            ) : (
              <div className="caption-validation-list">
                <p>
                  <Check size={13} />
                  Transcript looks ready.
                </p>
              </div>
            )
          ) : (
            <div className="caption-empty-tab-hint">
              <Info size={14} />
              <p>No captions yet. Transcribe in the Media tab, or paste a transcript in the Export tab.</p>
            </div>
          )}

          {hasSegments ? (
            <div className="caption-intelligence-card">
              <div>
                <span>Gemini polish</span>
                {busy && captionIntelligenceStatus ? (
                  <AiActivityIndicator label={captionIntelligenceStatus} />
                ) : (
                  <small>{captionIntelligenceStatus || "Shorten, split, and clean captions while keeping timing."}</small>
                )}
              </div>
              <button disabled={busy || !hasSegments} type="button" onClick={() => onCaptionIntelligence("improve")}>
                Improve
              </button>
            </div>
          ) : null}

          <div className="caption-assistant-card">
            <div>
              <span>Assistant suggestion</span>
              <strong>{assistantPlan.confirmationSummary}</strong>
              {busy && highlightSuggestionStatus ? (
                <AiActivityIndicator label={highlightSuggestionStatus} />
              ) : (
                <small>{highlightSuggestionStatus || (assistantPlan.missingInputs.length ? "Waiting for source input." : "Pick a style and let Gemini find the words worth highlighting.")}</small>
              )}
            </div>
            <div className="caption-assistant-actions">
              <button disabled={assistantPlan.missingInputs.length > 0} type="button" onClick={onConfirmAssistantPlan}>
                Use style
              </button>
              <button disabled={busy || !hasSegments} type="button" onClick={onSuggestHighlights}>
                AI highlights
              </button>
            </div>
          </div>

          {hasSegments ? (
            <label>
              <span>Highlight words</span>
              <input placeholder="Type words, or pick from the transcript below" value={highlightedWords} onChange={(event) => onChangeHighlightedWords(event.target.value)} />
            </label>
          ) : null}
          {hasSegments && highlightWords.length ? (
            <div className="caption-word-chip-panel">
              {highlightWords.slice(0, 28).map((word) => {
                const normalized = normalizeCaptionWord(word);
                return (
                  <button className={highlightSet.has(normalized) ? "is-active" : ""} key={normalized} type="button" onClick={() => toggleHighlightWord(word)}>
                    {word}
                  </button>
                );
              })}
            </div>
          ) : null}

          {hasSegments ? (
            <div className="caption-editor-panel">
              <div className="caption-editor-heading">
                <span>Fix timing · {captionTrack.segments.length} segments</span>
                <button type="button" onClick={onClampTiming}>Clamp timing</button>
              </div>

              <div className="caption-mini-timeline" aria-label="Caption timing overview">
                {captionTrack.segments.map((segment) => {
                  const left = (segment.startSeconds / durationSeconds) * 100;
                  const width = Math.max(1.6, ((segment.endSeconds - segment.startSeconds) / durationSeconds) * 100);
                  return (
                    <button
                      className={segment.id === selectedSegmentId ? "is-active" : ""}
                      key={segment.id}
                      style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }}
                      title={`${segment.startSeconds.toFixed(2)}s - ${segment.endSeconds.toFixed(2)}s`}
                      type="button"
                      onClick={() => onSelectSegment(segment.id)}
                    />
                  );
                })}
              </div>

              {selectedSegment ? (
                <div className="caption-segment-actions">
                  <button type="button" onClick={() => onShiftSegment(selectedSegment.id, -0.1)}>-0.1s</button>
                  <button type="button" onClick={() => onShiftSegment(selectedSegment.id, 0.1)}>+0.1s</button>
                  <button type="button" onClick={() => onSplitSegment(selectedSegment.id)}>Split</button>
                  <button type="button" onClick={() => onMergeSegment(selectedSegment.id)}>Merge next</button>
                </div>
              ) : null}

              <div className="caption-segment-list">
                {captionTrack.segments.map((segment) => (
                  <div className={segment.id === selectedSegmentId ? "is-active" : ""} key={segment.id} onClick={() => onSelectSegment(segment.id)}>
                    <input
                      aria-label="Caption start time"
                      min={0}
                      step={0.01}
                      type="number"
                      value={roundForInput(segment.startSeconds)}
                      onChange={(event) => onUpdateSegment(segment.id, { startSeconds: Number(event.target.value) })}
                    />
                    <input
                      aria-label="Caption end time"
                      min={0}
                      step={0.01}
                      type="number"
                      value={roundForInput(segment.endSeconds)}
                      onChange={(event) => onUpdateSegment(segment.id, { endSeconds: Number(event.target.value) })}
                    />
                    <input
                      aria-label="Caption text"
                      value={segment.text}
                      onChange={(event) => onUpdateSegment(segment.id, { text: event.target.value })}
                    />
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {activeTab === "style" ? (
        <div className="caption-tab-panel">
          <span className="caption-section-label">Style preset</span>
          <div className="caption-style-grid" aria-label="Caption styles">
            {captionStylePresets.map((preset) => (
              <button className={captionStyleId === preset.id ? "is-active" : ""} key={preset.id} type="button" onClick={() => onChangeStyle(preset.id)}>
                <strong>{preset.name}</strong>
                <small>{preset.description}</small>
              </button>
            ))}
          </div>

          {hasSegments ? (
            <div className="caption-style-override-panel">
              <div className="caption-editor-heading">
                <span>Fine-tune · applies to all captions</span>
                <button
                  className="caption-reset-link"
                  type="button"
                  onClick={() => applyToAllSegments({
                    stylePresetId: undefined,
                    color: undefined,
                    highlightColor: undefined,
                    strokeColor: undefined,
                    strokeWidth: undefined,
                    backgroundColor: undefined,
                    backgroundPaddingEm: undefined,
                    fontSize: undefined,
                    fontFamily: undefined,
                    positionX: undefined,
                    positionY: undefined,
                    textWidthPercent: undefined,
                    emphasis: undefined,
                    highlightBold: undefined,
                    highlightItalic: undefined,
                    highlightFontSizeMultiplier: undefined,
                    highlightFontFamily: undefined
                  })}
                >
                  <RotateCcw size={12} />
                  Reset
                </button>
              </div>

              <div className="caption-finetune-section">
                <span className="caption-finetune-label">Align</span>
                <div className="caption-finetune-body">
                  <div className="caption-align-row">
                    <div className="caption-align-group" aria-label="Horizontal alignment">
                      <button title="Align left" type="button" onClick={() => applyToAllSegments({ positionX: 12 })}>
                        <AlignHorizontalJustifyStart size={13} />
                      </button>
                      <button title="Align center" type="button" onClick={() => applyToAllSegments({ positionX: 50 })}>
                        <AlignHorizontalJustifyCenter size={13} />
                      </button>
                      <button title="Align right" type="button" onClick={() => applyToAllSegments({ positionX: 88 })}>
                        <AlignHorizontalJustifyEnd size={13} />
                      </button>
                    </div>
                    <div className="caption-align-group" aria-label="Vertical alignment">
                      <button title="Align top" type="button" onClick={() => applyToAllSegments({ positionY: 15 })}>
                        <AlignVerticalJustifyStart size={13} />
                      </button>
                      <button title="Align middle" type="button" onClick={() => applyToAllSegments({ positionY: 50 })}>
                        <AlignVerticalJustifyCenter size={13} />
                      </button>
                      <button title="Align bottom" type="button" onClick={() => applyToAllSegments({ positionY: 88 })}>
                        <AlignVerticalJustifyEnd size={13} />
                      </button>
                    </div>
                  </div>
                  <CaptionSlider label="Horizontal" suffix="%" min={0} max={100} value={globalOverride.positionX ?? 50} onChange={(value) => applyToAllSegments({ positionX: value })} />
                  <CaptionSlider label="Vertical" suffix="%" min={0} max={100} value={globalOverride.positionY ?? globalStyle.positionY} onChange={(value) => applyToAllSegments({ positionY: value })} />
                </div>
              </div>

              <div className="caption-finetune-section">
                <span className="caption-finetune-label">Text</span>
                <div className="caption-finetune-body">
                  <label className="caption-mini-field caption-mini-field-wide">
                    <span>Font</span>
                    <ThemedSelect
                      ariaLabel="Font"
                      value={globalOverride.fontFamily ?? globalStyle.fontFamily}
                      options={renderSafeFonts.map((font) => ({ value: font.family, label: font.label }))}
                      onChange={(next) => applyToAllSegments({ fontFamily: next })}
                    />
                  </label>
                  <CaptionSlider label="Size" min={12} max={160} value={globalOverride.fontSize ?? globalStyle.fontSize} onChange={(value) => applyToAllSegments({ fontSize: value })} />
                  <div className="control-grid">
                    <ColorControl
                      icon={<PaintBucket size={14} />}
                      label="Text color"
                      palette={imagePalette}
                      value={globalOverride.color ?? globalStyle.color}
                      onChange={(value) => applyToAllSegments({ color: value })}
                    />
                    <ColorControl
                      icon={<PenLine size={14} />}
                      label="Stroke color"
                      palette={imagePalette}
                      value={globalStrokeColor}
                      onChange={(value) => applyToAllSegments({ strokeColor: value })}
                    />
                  </div>
                  <CaptionSlider label="Stroke" min={0} max={24} value={globalStrokeWidth} onChange={(value) => applyToAllSegments({ strokeWidth: value })} />
                </div>
              </div>

              <div className="caption-finetune-section">
                <span className="caption-finetune-label">Background</span>
                <div className="caption-finetune-body">
                  <div className="control-grid">
                    <ColorControl
                      icon={<Square size={14} />}
                      label="Background color"
                      palette={imagePalette}
                      value={backgroundParsed.hex}
                      onChange={(hex) => applyToAllSegments({ backgroundColor: buildBackgroundColor(hex, backgroundParsed.alphaPercent) })}
                    />
                  </div>
                  <CaptionSlider
                    label="Opacity"
                    suffix="%"
                    min={0}
                    max={100}
                    value={backgroundParsed.alphaPercent}
                    onChange={(value) => applyToAllSegments({ backgroundColor: buildBackgroundColor(backgroundParsed.hex, value) })}
                  />
                  <CaptionSlider
                    label="Padding"
                    min={0}
                    max={100}
                    value={Math.round((globalOverride.backgroundPaddingEm ?? 0.08) * 125)}
                    onChange={(value) => applyToAllSegments({ backgroundPaddingEm: value / 125 })}
                  />
                </div>
              </div>

              <div className="caption-finetune-section">
                <span className="caption-finetune-label">Motion</span>
                <div className="caption-finetune-body">
                  <div className="caption-segmented" role="radiogroup" aria-label="Caption emphasis">
                    {captionEmphasisOptions.map((option) => (
                      <button
                        className={(globalOverride.emphasis ?? "none") === option.id ? "is-active" : ""}
                        key={option.id}
                        type="button"
                        onClick={() => applyToAllSegments({ emphasis: option.id })}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="caption-finetune-section">
                <span className="caption-finetune-label">Highlight</span>
                <div className="caption-finetune-body">
                  <div className="control-grid">
                    <ColorControl
                      icon={<Highlighter size={14} />}
                      label="Highlight color"
                      palette={imagePalette}
                      value={globalOverride.highlightColor ?? globalStyle.highlightColor}
                      onChange={(value) => applyToAllSegments({ highlightColor: value })}
                    />
                  </div>
                  <div className="caption-finetune-row">
                    <button
                      className={`caption-icon-toggle ${globalOverride.highlightBold ?? true ? "is-active" : ""}`}
                      title="Bold"
                      type="button"
                      onClick={() => applyToAllSegments({ highlightBold: !(globalOverride.highlightBold ?? true) })}
                    >
                      <Bold size={13} />
                    </button>
                    <button
                      className={`caption-icon-toggle ${globalOverride.highlightItalic ?? false ? "is-active" : ""}`}
                      title="Italic"
                      type="button"
                      onClick={() => applyToAllSegments({ highlightItalic: !(globalOverride.highlightItalic ?? false) })}
                    >
                      <Italic size={13} />
                    </button>
                    <label className="caption-mini-field caption-mini-field-wide">
                      <span>Highlight font</span>
                      <ThemedSelect
                        ariaLabel="Highlight font"
                        value={globalOverride.highlightFontFamily ?? ""}
                        options={[
                          { value: "", label: "Same as caption" },
                          ...renderSafeFonts.map((font) => ({ value: font.family, label: font.label }))
                        ]}
                        onChange={(next) => applyToAllSegments({ highlightFontFamily: next || undefined })}
                      />
                    </label>
                  </div>
                  <CaptionSlider
                    label="Size"
                    suffix="%"
                    min={80}
                    max={220}
                    step={5}
                    value={Math.round((globalOverride.highlightFontSizeMultiplier ?? 1) * 100)}
                    onChange={(value) => applyToAllSegments({ highlightFontSizeMultiplier: value / 100 })}
                  />
                </div>
              </div>
            </div>
          ) : (
            <div className="caption-empty-tab-hint">
              <Info size={14} />
              <p>Transcribe or paste a transcript first to style your captions.</p>
            </div>
          )}
        </div>
      ) : null}

      {activeTab === "export" ? (
        <div className="caption-tab-panel">
          <div className="caption-prompt-bridge">
            <p>Free path: copy this prompt into any chat agent (ChatGPT, Gemini, etc.), then paste the JSON/SRT/VTT result below.</p>
            <div className="caption-intelligence-actions">
              <button type="button" onClick={() => void navigator.clipboard?.writeText(prompt)}>
                Copy prompt
              </button>
              <button disabled={busy || !captionInput.trim()} type="button" onClick={() => onCaptionIntelligence("repair")}>
                Repair with Gemini
              </button>
            </div>
            <textarea readOnly rows={3} value={prompt} />
          </div>

          <label>
            <span>Transcript / SRT / VTT / AI JSON</span>
            <textarea value={captionInput} rows={6} onChange={(event) => onChangeCaptionInput(event.target.value)} />
          </label>
          {captionIntelligenceStatus ? (
            busy ? (
              <AiActivityIndicator label={captionIntelligenceStatus} />
            ) : (
              <p className="caption-status-line">{captionIntelligenceStatus}</p>
            )
          ) : null}

          <div className="caption-interchange-panel">
            <p>Move captions between Orreris, editors, chat agents, and subtitle tools.</p>
            <div className="caption-interchange-actions">
              <button type="button" onClick={() => onExportCaptionData("json")}>
                <FileJson size={13} />
                JSON
              </button>
              <button type="button" onClick={() => onExportCaptionData("srt")}>SRT</button>
              <button type="button" onClick={() => onExportCaptionData("vtt")}>VTT</button>
              <label className="caption-import-button">
                Import
                <input
                  accept=".json,.srt,.vtt,text/*,application/json"
                  type="file"
                  onChange={(event) => {
                    onImportCaptionFile(event.currentTarget.files?.[0] ?? null);
                    event.currentTarget.value = "";
                  }}
                />
              </label>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function transcriptToJsonInput(transcript: TranscriptArtifactData) {
  return JSON.stringify(transcript, null, 2);
}

function downloadTextFile(filename: string, body: string, mimeType: string) {
  const blob = new Blob([body], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function roundForInput(value: number) {
  return Number(value.toFixed(2));
}

function prepareCaptionSourceComposition(composition: TimelineComposition, asset: SourceAsset, transcriptDurationSeconds: number): TimelineComposition {
  const durationSeconds = Math.max(0.2, asset.durationSeconds, transcriptDurationSeconds);
  const sourceId = composition.id.replace(/^composition_/, "");
  const tracks: TimelineTrack[] = [];
  const linkedGroupId = `link_${asset.id}_${sourceId}_captions`;

  if (asset.fileType.startsWith("video/") || asset.fileType.startsWith("image/")) {
    tracks.push({
      id: `${sourceId}_caption_video_track`,
      type: "video",
      name: "Video 1",
      layers: [
        createCaptionSourceLayer({
          id: `${sourceId}_caption_video`,
          trackId: `${sourceId}_caption_video_track`,
          type: asset.fileType.startsWith("image/") ? "image" : "video",
          name: asset.fileName,
          assetId: asset.id,
          durationSeconds,
          linkedGroupId,
          fit: "cover"
        })
      ]
    });
  }

  if (asset.fileType.startsWith("video/") || asset.fileType.startsWith("audio/")) {
    tracks.push({
      id: `${sourceId}_caption_audio_track`,
      type: "audio",
      name: "Audio 1",
      layers: [
        createCaptionSourceLayer({
          id: `${sourceId}_caption_audio`,
          trackId: `${sourceId}_caption_audio_track`,
          type: "audio",
          name: `${asset.fileName} audio`,
          assetId: asset.id,
          durationSeconds,
          linkedGroupId
        })
      ]
    });
  }

  return {
    ...composition,
    durationSeconds,
    tracks
  };
}

function createCaptionSourceLayer(input: {
  id: string;
  trackId: string;
  type: TimelineLayer["type"];
  name: string;
  assetId: string;
  durationSeconds: number;
  fit?: TimelineLayer["fit"] | undefined;
  linkedGroupId?: string | undefined;
}): TimelineLayer {
  return {
    id: input.id,
    trackId: input.trackId,
    type: input.type,
    name: input.name,
    startSeconds: 0,
    durationSeconds: input.durationSeconds,
    assetId: input.assetId,
    fit: input.fit,
    linkedGroupId: input.linkedGroupId,
    transform: {
      position: { x: 50, y: 50 },
      scale: 1,
      rotation: 0,
      opacity: 100
    },
    effects: [],
    keyframes: []
  };
}

function rebuildSegment(segment: TranscriptSegment): TranscriptSegment {
  const text = segment.text.replace(/\s+/g, " ").trim();
  const words = text.split(/\s+/).filter(Boolean);
  const startSeconds = Math.max(0, Number(segment.startSeconds.toFixed(3)));
  const endSeconds = Math.max(startSeconds + 0.1, Number(segment.endSeconds.toFixed(3)));
  const duration = endSeconds - startSeconds;
  return {
    ...segment,
    text,
    startSeconds,
    endSeconds,
    words: words.map((word, index) => {
      const wordStart = startSeconds + (duration * index) / Math.max(1, words.length);
      const wordEnd = startSeconds + (duration * (index + 1)) / Math.max(1, words.length);
      return {
        id: `${segment.id}_word_${index + 1}`,
        text: word,
        startSeconds: Number(wordStart.toFixed(3)),
        endSeconds: Number(wordEnd.toFixed(3)),
        confidence: segment.confidence ?? 0.8
      };
    })
  };
}


async function readMediaMetadata(file: File): Promise<{ durationSeconds?: number | undefined; width?: number | undefined; height?: number | undefined }> {
  if (file.type.startsWith("video/")) {
    return readVideoMetadata(file);
  }
  if (file.type.startsWith("audio/")) {
    return readAudioMetadata(file);
  }
  return {};
}

/**
 * Some video/audio containers (notably certain MP4 encodes played from a blob: URL)
 * report `duration: Infinity` immediately after `loadedmetadata` fires - a
 * long-standing Chromium quirk, not an actually-infinite file. The fix is to seek
 * far past any real end: the browser clamps the seek to the true last frame and
 * recomputes a finite duration, which we read back off the resulting event. No
 * magic-number fallback - if a finite duration genuinely can't be read, this throws
 * rather than silently lying about the file's length to the rest of the app.
 */
async function resolveFiniteDuration(media: HTMLMediaElement): Promise<number> {
  if (Number.isFinite(media.duration) && media.duration > 0) {
    return media.duration;
  }
  return new Promise<number>((resolve, reject) => {
    const tryResolve = () => {
      if (Number.isFinite(media.duration) && media.duration > 0) {
        cleanup();
        resolve(media.duration);
      }
    };
    const cleanup = () => {
      media.removeEventListener("durationchange", tryResolve);
      media.removeEventListener("timeupdate", tryResolve);
      window.clearTimeout(timeout);
    };
    media.addEventListener("durationchange", tryResolve);
    media.addEventListener("timeupdate", tryResolve);
    media.currentTime = 1e7; // seek far beyond any real file - the browser clamps to the true end
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("Could not determine the file's real duration."));
    }, 4000);
  });
}

async function readVideoMetadata(file: File): Promise<{ durationSeconds: number; width: number; height: number }> {
  const url = URL.createObjectURL(file);
  try {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.src = url;
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error("Unable to read video metadata"));
    });
    return {
      durationSeconds: await resolveFiniteDuration(video),
      width: video.videoWidth || 1080,
      height: video.videoHeight || 1920
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function readAudioMetadata(file: File): Promise<{ durationSeconds: number; width: number; height: number }> {
  const url = URL.createObjectURL(file);
  try {
    const audio = document.createElement("audio");
    audio.preload = "metadata";
    audio.src = url;
    await new Promise<void>((resolve, reject) => {
      audio.onloadedmetadata = () => resolve();
      audio.onerror = () => reject(new Error("Unable to read audio metadata"));
    });
    return {
      durationSeconds: await resolveFiniteDuration(audio),
      width: 1080,
      height: 1920
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function AutoCaptionMediaPreview({
  asset,
  composition,
  currentTime,
  textLayer
}: {
  asset: SourceAsset;
  composition: TimelineComposition;
  currentTime: number;
  textLayer?: TimelineLayer | undefined;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const mediaUrl = resolveToolMediaUrl(asset.fileUrl);
  const isVideo = asset.fileType.startsWith("video/");
  const isImage = asset.fileType.startsWith("image/");

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !isVideo) {
      return;
    }
    const nextTime = Math.max(0, Math.min(asset.durationSeconds, currentTime));
    if (Number.isFinite(nextTime) && Math.abs(video.currentTime - nextTime) > 0.08) {
      video.currentTime = nextTime;
    }
  }, [asset.durationSeconds, currentTime, isVideo, mediaUrl]);

  const textStyle = textLayer ? getCompositionTextStyle(textLayer, { currentTimeSeconds: currentTime }) : undefined;
  const scaledTextStyle = textLayer && textStyle ? getScaledCaptionTextStyle(textLayer, textStyle, composition.width) : undefined;

  return (
    <div className="caption-media-preview-frame" style={{ aspectRatio: `${composition.width} / ${composition.height}` }}>
      {isVideo ? (
        <video
          muted
          playsInline
          preload="auto"
          ref={videoRef}
          src={mediaUrl}
          onLoadedMetadata={(event) => {
            const nextTime = Math.max(0, Math.min(asset.durationSeconds, currentTime));
            if (Number.isFinite(nextTime)) {
              event.currentTarget.currentTime = nextTime;
            }
          }}
        />
      ) : isImage ? (
        <img src={mediaUrl} alt="" />
      ) : (
        <div className="caption-audio-preview-plate">
          <span>{asset.fileName}</span>
        </div>
      )}
      {textLayer && scaledTextStyle && textStyle ? (
        <div className="caption-media-preview-text" style={scaledTextStyle}>
          {getCompositionTextRuns(textLayer).map((run, index) => (
            <span key={`${textLayer.id}_run_${index}`} style={getScaledCaptionRunStyle(run, textStyle, composition.width)}>
              {run.text}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function getScaledCaptionTextStyle(layer: TimelineLayer, style: ReturnType<typeof getCompositionTextStyle>, compositionWidth: number): CSSProperties {
  const fontSize = typeof style.fontSize === "number" ? style.fontSize : (layer.fontSize ?? 72);
  const strokeWidth = layer.strokeWidth ?? 0;
  return {
    ...(style as CSSProperties),
    fontSize: `${(fontSize / compositionWidth) * 100}cqw`,
    WebkitTextStroke: strokeWidth > 0 ? `${(strokeWidth / compositionWidth) * 100}cqw ${layer.strokeColor ?? "#000000"}` : undefined
  };
}

function getScaledCaptionRunStyle(run: ReturnType<typeof getCompositionTextRuns>[number], baseStyle: ReturnType<typeof getCompositionTextStyle>, compositionWidth: number): CSSProperties {
  const runStyle = getCompositionTextRunStyle(run, baseStyle);
  const fontSize = typeof runStyle.fontSize === "number" ? runStyle.fontSize : Number(runStyle.fontSize) || 72;
  return {
    ...(runStyle as CSSProperties),
    fontSize: `${(fontSize / compositionWidth) * 100}cqw`
  };
}


function CaptionPreview({ captionTrack, stylePreset }: { captionTrack: CaptionTrackData; stylePreset: CaptionStylePreset }) {
  const previewSegment = captionTrack.segments[0];
  const override = previewSegment ? captionTrack.segmentStyleOverrides?.[previewSegment.id] : undefined;
  const resolvedStyle = captionStylePresets.find((preset) => preset.id === override?.stylePresetId) ?? stylePreset;
  const color = override?.color ?? resolvedStyle.color;
  const highlightColor = override?.highlightColor ?? resolvedStyle.highlightColor;
  const fontSize = override?.fontSize ?? resolvedStyle.fontSize;

  return (
    <div className="caption-preview-frame">
      <Badge tone="lime">{resolvedStyle.name}</Badge>
      <div
        className="caption-preview-text"
        style={{
          color,
          fontFamily: resolvedStyle.fontFamily,
          fontSize: `${Math.max(28, fontSize * 0.46)}px`,
          WebkitTextStroke: resolvedStyle.strokeWidth ? `${Math.max(1, resolvedStyle.strokeWidth * 0.35)}px ${resolvedStyle.strokeColor}` : undefined
        }}
      >
        {previewSegment ? renderHighlightedCaptionText(previewSegment.text, captionTrack.highlightedWords, highlightColor) : "Upload or paste transcript"}
      </div>
      <p>{captionTrack.segments.length} caption segments ready</p>
      <div className="tool-progress-track">
        <span style={{ width: "100%" }} />
      </div>
    </div>
  );
}

function renderHighlightedCaptionText(text: string, highlightedWords: string[], highlightColor: string) {
  const highlighted = new Set(highlightedWords.map((word) => normalizeCaptionWord(word)));
  return text.split(/(\s+)/).map((part, index) => {
    if (!part.trim()) {
      return part;
    }
    const isHighlighted = highlighted.has(normalizeCaptionWord(part));
    return isHighlighted ? (
      <span className="caption-preview-highlight" key={`${part}_${index}`} style={{ color: highlightColor }}>
        {part}
      </span>
    ) : (
      part
    );
  });
}

function getTranscriptWordChoices(segments: TranscriptSegment[]) {
  const words = new Map<string, string>();
  for (const segment of segments) {
    for (const rawWord of segment.text.split(/\s+/)) {
      const normalized = normalizeCaptionWord(rawWord);
      if (normalized.length >= 3 && !words.has(normalized)) {
        words.set(normalized, rawWord.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""));
      }
    }
  }
  return Array.from(words.values()).slice(0, 48);
}

function normalizeCaptionWord(word: string) {
  return word.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

