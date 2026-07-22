import {
  applyCaptionTrackToComposition,
  applyExtractPersonComposition,
  applyRemoveBackgroundComposition,
  applyRemovePersonComposition,
  applySmartFollowTextComposition,
  applyStabilizationComposition,
  applyTextBehindPersonComposition,
  captionStylePresets,
  createCaptionTrack,
  type MaskSequenceArtifactData,
  type SourceAsset,
  type SubjectAnalysisArtifacts,
  type TimelineComposition,
  type TimelineLayer,
  type TrackingPathArtifactData
} from "@orreris/shared";
import { createAsset } from "../lib/api";
import { createToolArtifactStore } from "./artifact-store";
import { detectBrowserToolCapabilities } from "./capabilities";
import { storeInpaintArtifact } from "./inpaint-store";
import { chooseSamDeviceProfile, isSamSupported, segmentVideoPrompted, type SamPrompt } from "./local-sam";
import { chooseSegmentationDeviceProfile, segmentVideoFast, segmentVideoQuality } from "./local-segmentation";
import { trackSubjectPlanar3D } from "./local-tracking";
import { transcribeAssetLocally } from "./local-transcription";
import { findReusableMask, findReusableTrackingPath, registerMaskForAsset, registerTrackingForAsset } from "./mask-resolver";
import { storeMatteArtifact, uploadMatteForExport } from "./matte-store";
import type { InpaintMask } from "./mock-inpaint";
import { runVideoInpaint } from "./video-inpaint";

export interface LayerToolEffectOptionChoice {
  value: string;
  label: string;
  description?: string;
}

/**
 * A run-time choice a handler wants surfaced in the popup before it runs
 * (e.g. quality tier). Generic select-style field - the modal renders these
 * without knowing which tool defined them.
 */
export interface LayerToolEffectOptionField {
  key: string;
  label: string;
  defaultValue: string;
  choices: LayerToolEffectOptionChoice[];
}

export interface LayerToolEffectRunArgs {
  asset: SourceAsset;
  /** The selected timeline layer in the editor; undefined on standalone surfaces (the /tools page has no timeline yet). */
  layer: TimelineLayer | undefined;
  /** Composition frame rate, so tools can frame-lock their output to the timeline. */
  fps: number;
  /**
   * The current composition, when the surface has one (the editor always does).
   * Used for cross-tool artifact reuse: a layer already compositing this asset
   * through a durable matte lets mask consumers skip a fresh segmentation.
   */
  composition?: TimelineComposition | undefined;
  /** The project graph's durable per-tool artifacts (the /tools page supplies these). */
  editableFields?: Record<string, unknown> | undefined;
  options: Record<string, string>;
  onProgress: (message: string) => void;
  isCancelled: () => boolean;
}

export interface LayerToolEffectApplyArgs<TResult> {
  composition: TimelineComposition;
  layer: TimelineLayer | undefined;
  asset: SourceAsset;
  result: TResult;
  /** The same run-time choices the user selected before Run (see optionFields). */
  options: Record<string, string>;
  /**
   * "editor" (default) applies into the live timeline non-destructively (the
   * shared builders' "insert" mode). "standalone" is the /tools page building a
   * fresh draft project, where the builders' default "replace" mode is correct.
   */
  context?: "editor" | "standalone" | undefined;
}

/**
 * A tool capability that can run as a one-click effect on a single selected
 * timeline layer, rather than the full multi-stage /tools/:slug flow. This is
 * the only place that decides which `toolCapabilityDefinitions` entries are
 * "ready" to show in the editor's Effects tab - adding a new ready tool later
 * means adding one entry here, nothing in the panel/popup components changes.
 */
export interface LayerToolEffectHandler<TResult = unknown> {
  toolSlug: string;
  /** Optional run-time choices (e.g. quality tier) shown in the popup before Run. */
  optionFields?: LayerToolEffectOptionField[];
  run: (args: LayerToolEffectRunArgs) => Promise<TResult>;
  applyResult: (args: LayerToolEffectApplyArgs<TResult>) => TimelineComposition;
  /**
   * The durable per-project artifact patch a standalone surface should merge
   * into `projectGraph.editableFields` after applying (the /tools page persists
   * masks/tracking there so later sessions — and the cross-tool mask-reuse
   * lookup — can find them). Editor surfaces don't consume this yet.
   */
  describeEditableFields?: (args: LayerToolEffectApplyArgs<TResult>) => Record<string, unknown>;
}

function defineLayerToolEffectHandler<TResult>(handler: LayerToolEffectHandler<TResult>): LayerToolEffectHandler<unknown> {
  return handler as LayerToolEffectHandler<unknown>;
}

/**
 * Shared "extract once, reuse everywhere" choice for every mask consumer.
 * Default reuses a real mask already produced for the same source asset
 * (a prior Extract Person run, a masked layer on the timeline); "Re-analyze"
 * is the escape hatch when the old mask is stale (clip retrimmed/replaced).
 */
const maskSourceOptionField: LayerToolEffectOptionField = {
  key: "maskSource",
  label: "Subject mask",
  defaultValue: "auto",
  choices: [
    { value: "auto", label: "Reuse if available", description: "Uses a mask already extracted for this clip; runs a fresh analysis otherwise." },
    { value: "reanalyze", label: "Re-analyze", description: "Ignore any existing mask and run segmentation again." }
  ]
};

const autoCaptionsLayerEffect = defineLayerToolEffectHandler({
  toolSlug: "auto-captions",
  run: async ({ asset, onProgress, isCancelled }) => transcribeAssetLocally(asset, onProgress, isCancelled),
  applyResult: ({ composition, result }) => {
    const stylePreset = captionStylePresets[0]!;
    const captionTrack = createCaptionTrack(result, stylePreset.id, "");
    return applyCaptionTrackToComposition(composition, captionTrack, stylePreset);
  }
});

const extractPersonLayerEffect = defineLayerToolEffectHandler<SubjectAnalysisArtifacts>({
  toolSlug: "extract-person",
  optionFields: [
    {
      key: "quality",
      label: "Quality",
      defaultValue: "fast",
      choices: [
        { value: "fast", label: "Fast preview", description: "Quick, lower-quality edges." },
        { value: "quality", label: "High quality", description: "Slower, temporally stable edges - recommended before export." }
      ]
    },
    maskSourceOptionField
  ],
  run: async ({ asset, fps, composition, editableFields, options, onProgress, isCancelled }) => {
    // A fast-preview request is trivially satisfied by an existing high-quality
    // bake; an explicit quality bake always runs fresh (that's its whole point).
    if (options.quality !== "quality" && options.maskSource !== "reanalyze") {
      const reused = findReusableMask({ sourceAssetId: asset.id, asset, composition, editableFields });
      if (reused && reused.mask.edgeMode === "clean") {
        onProgress('Reusing the high-quality subject mask already extracted for this clip. Choose "Re-analyze" to regenerate.');
        const reusedTrack = findReusableTrackingPath({ sourceAssetId: asset.id, editableFields });
        return {
          maskSequence: reused.mask,
          trackingPath:
            reusedTrack?.trackingPath ??
            ({
              id: `track_reused_${Date.now()}`,
              sourceAssetId: asset.id,
              durationSeconds: asset.durationSeconds,
              smoothing: 0.4,
              source: "browser",
              points: []
            } satisfies TrackingPathArtifactData),
          subjectBounds: []
        };
      }
    }

    const segmentOptions = {
      videoUrl: asset.fileUrl,
      sourceAssetId: asset.id,
      durationSeconds: asset.durationSeconds,
      width: asset.width || 720,
      height: asset.height || 1280,
      targetFps: fps,
      onProgress,
      isCancelled
    };
    const result =
      options.quality === "quality"
        ? await segmentVideoQuality(
            { ...segmentOptions, tier: "quality" },
            chooseSegmentationDeviceProfile(detectBrowserToolCapabilities(), asset.durationSeconds)
          )
        : await segmentVideoFast({ ...segmentOptions, tier: "fast" });

    onProgress("Saving preview matte...");
    const store = await createToolArtifactStore();
    const runId = `extract_${Date.now()}`;
    const baked = await storeMatteArtifact(result, store, runId);
    const outcome = await uploadMatteForExport({
      maskSequence: baked.maskSequence,
      blob: baked.blob,
      folder: "generated/background-removed",
      onProgress
    });
    registerMaskForAsset(asset.id, outcome.maskSequence);
    registerTrackingForAsset(asset.id, result.trackingPath);
    return { maskSequence: outcome.maskSequence, trackingPath: result.trackingPath, subjectBounds: result.subjectBounds };
  },
  applyResult: ({ composition, asset, result, context }) =>
    applyExtractPersonComposition(
      composition,
      { mask: result.maskSequence, sourceAssetId: asset.id },
      context === "standalone" ? "replace" : "insert"
    ),
  describeEditableFields: ({ result }) => ({
    maskSequence: result.maskSequence,
    trackingPath: result.trackingPath,
    subjectBounds: result.subjectBounds
  })
});

/**
 * One-click Smart 3D Follow Text on a single clip. The full multi-target
 * /tools/smart-3d-follow-text page lets the user draw boxes and tune channels;
 * this editor-side effect runs the same real local planar tracker
 * (`trackSubjectPlanar3D`) against an auto-detected subject and applies the same
 * shared `apply*Composition` builders, so the result is identical editable
 * timeline data. The text is seeded with a placeholder ("TRACKED") the user
 * edits in place afterwards, mirroring how auto-captions/extract-person produce
 * editable output without prompting for free text up front.
 */
const smartFollowTextLayerEffect = defineLayerToolEffectHandler<TrackingPathArtifactData>({
  toolSlug: "smart-3d-follow-text",
  optionFields: [
    {
      key: "mode",
      label: "Mode",
      defaultValue: "follow",
      choices: [
        { value: "follow", label: "Follow text", description: "Attach editable text that rides the tracked subject." },
        { value: "stabilize", label: "Stabilize subject", description: "Hold the tracked subject steady (counter its motion)." }
      ]
    },
    {
      key: "quality",
      label: "Tracking quality",
      defaultValue: "fast",
      choices: [
        { value: "fast", label: "Fast", description: "Single-scale search - quick." },
        { value: "quality", label: "High quality", description: "Coarse-to-fine multi-scale - more robust to fast motion." }
      ]
    },
    {
      key: "trackSource",
      label: "Tracking data",
      defaultValue: "auto",
      choices: [
        { value: "auto", label: "Reuse if available", description: "Uses a tracking path already produced for this clip; tracks fresh otherwise." },
        { value: "reanalyze", label: "Re-track", description: "Ignore any existing tracking path and track the subject again." }
      ]
    }
  ],
  run: async ({ asset, fps, editableFields, options, onProgress, isCancelled }) => {
    if (options.trackSource !== "reanalyze") {
      const reused = findReusableTrackingPath({
        sourceAssetId: asset.id,
        minimumDurationSeconds: asset.durationSeconds,
        editableFields
      });
      if (reused) {
        onProgress('Reusing the tracking path already produced for this clip. Choose "Re-track" to regenerate.');
        return reused.trackingPath;
      }
    }
    const trackingPath = await trackSubjectPlanar3D({
      videoUrl: asset.fileUrl,
      sourceAssetId: asset.id,
      durationSeconds: asset.durationSeconds,
      width: asset.width || 720,
      height: asset.height || 1280,
      quality: options.quality === "quality" ? "quality" : "fast",
      trackFps: Math.min(15, Math.max(6, Math.round(fps))),
      onProgress,
      isCancelled
    });
    registerTrackingForAsset(asset.id, trackingPath);
    return trackingPath;
  },
  applyResult: ({ composition, asset, result, options }) =>
    options.mode === "stabilize"
      ? applyStabilizationComposition(composition, {
          trackingPath: result,
          smoothing: 0.4,
          sourceAssetId: asset.id,
          strength: 1
        })
      : applySmartFollowTextComposition(composition, {
          text: "TRACKED",
          textColor: "#4D9FFF",
          trackingPath: result,
          smoothing: 0.4,
          depthStrength: 0.5
        })
});

/**
 * Shared by remove-background and text-behind-person: both need the same
 * person-segmentation matte, stored the same way extract-person stores it.
 * Before segmenting from scratch, this reuses a real mask already produced for
 * the same source asset ("extract once, reuse everywhere") — a prior Extract
 * Person run in this session, the project's durable editableFields copy, or a
 * masked layer already on the timeline. `maskSource: "reanalyze"` skips reuse.
 */
async function runSegmentationMatte(args: LayerToolEffectRunArgs): Promise<MaskSequenceArtifactData> {
  const { asset, fps, composition, editableFields, options, onProgress, isCancelled } = args;
  const wantsQuality = options.quality === "quality";
  if (options.maskSource !== "reanalyze") {
    const reused = findReusableMask({ sourceAssetId: asset.id, asset, composition, editableFields });
    // A fast-preview request is satisfied by any existing mask; a high-quality bake only reuses an
    // already-clean matte (otherwise it re-runs the quality segmentation, which is its whole point).
    if (reused && (!wantsQuality || reused.mask.edgeMode === "clean")) {
      onProgress(
        `Reusing the subject mask already extracted for this clip (${reused.mask.edgeMode === "clean" ? "high quality" : "fast preview"}). Choose "Re-analyze" to regenerate.`
      );
      return reused.mask;
    }
  }

  // Source-range window (Remove Background "Used in timeline"/Custom): segment only the used slice
  // of a long source. `startSeconds`/`windowSeconds` default to the whole clip when no valid range
  // is supplied, so callers without a range (one-click, other tools) are unchanged.
  const { startSeconds, windowSeconds } = resolveSegmentWindow(options, asset.durationSeconds);
  const segmentOptions = {
    videoUrl: asset.fileUrl,
    sourceAssetId: asset.id,
    startSeconds,
    durationSeconds: windowSeconds,
    width: asset.width || 720,
    height: asset.height || 1280,
    targetFps: fps,
    onProgress,
    isCancelled
  };
  const result = wantsQuality
    ? await runQualityWithFastFallback(segmentOptions, windowSeconds, isCancelled, onProgress)
    : await segmentVideoFast({ ...segmentOptions, tier: "fast" });
  onProgress("Saving matte...");
  const store = await createToolArtifactStore();
  const runId = `matte_${Date.now()}`;
  const baked = await storeMatteArtifact(result, store, runId);
  const outcome = await uploadMatteForExport({
    maskSequence: baked.maskSequence,
    blob: baked.blob,
    folder: "generated/background-removed",
    onProgress
  });
  // Only a FULL-source matte is registered for cross-tool reuse: a windowed matte covers just this
  // clip's slice, so reusing it for another clip of the same source (different in/out) would
  // misalign. Windowed runs still return their matte for this apply.
  if (startSeconds === 0) {
    registerMaskForAsset(asset.id, outcome.maskSequence);
    registerTrackingForAsset(asset.id, result.trackingPath);
  }
  return outcome.maskSequence;
}

/**
 * Runs the high-quality RVM matte, but degrades to the fast MediaPipe tier instead of failing when
 * the quality model can't run on this device. The RVM ONNX export uses ops (e.g. AveragePool with
 * ceil_mode) that some onnxruntime-web execution providers reject ("using ceil() in shape
 * computation is not yet supported for AveragePool") — on those devices High quality would otherwise
 * hard-error. A real cancellation is NOT swallowed (re-thrown so the caller can bail).
 */
async function runQualityWithFastFallback(
  segmentOptions: Omit<Parameters<typeof segmentVideoFast>[0], "tier">,
  windowSeconds: number,
  isCancelled: () => boolean,
  onProgress: (message: string) => void
): Promise<Awaited<ReturnType<typeof segmentVideoQuality>>> {
  try {
    return await segmentVideoQuality(
      { ...segmentOptions, tier: "quality" },
      chooseSegmentationDeviceProfile(detectBrowserToolCapabilities(), windowSeconds)
    );
  } catch (error) {
    if (isCancelled()) {
      throw error;
    }
    onProgress("High-quality model can't run on this device — using the fast matte instead.");
    return segmentVideoFast({ ...segmentOptions, tier: "fast" });
  }
}

/**
 * Reads the optional `rangeStartSeconds`/`rangeEndSeconds` run options (set by the Remove Background
 * source-range control) into a validated [start, length] window inside the source. Falls back to the
 * whole clip when the range is absent, malformed, or degenerate.
 */
function resolveSegmentWindow(
  options: Record<string, string>,
  sourceDurationSeconds: number
): { startSeconds: number; windowSeconds: number } {
  const rawStart = Number(options.rangeStartSeconds);
  const rawEnd = Number(options.rangeEndSeconds);
  const hasRange = Number.isFinite(rawStart) && Number.isFinite(rawEnd) && rawEnd > rawStart;
  if (!hasRange) {
    return { startSeconds: 0, windowSeconds: sourceDurationSeconds };
  }
  const startSeconds = Math.max(0, Math.min(rawStart, Math.max(0, sourceDurationSeconds - 0.1)));
  const windowSeconds = Math.min(rawEnd, sourceDurationSeconds) - startSeconds;
  return windowSeconds > 0.05 ? { startSeconds, windowSeconds } : { startSeconds: 0, windowSeconds: sourceDurationSeconds };
}

const removeBackgroundLayerEffect = defineLayerToolEffectHandler<MaskSequenceArtifactData>({
  toolSlug: "remove-background",
  optionFields: [
    {
      key: "mode",
      label: "Output",
      defaultValue: "timelineMask",
      choices: [
        { value: "timelineMask", label: "Transparent", description: "Keeps the subject with a transparent timeline matte." },
        { value: "greenScreen", label: "Colour plate", description: "Composites the subject over a solid colour plate (green by default)." }
      ]
    },
    {
      key: "quality",
      label: "Quality",
      defaultValue: "fast",
      choices: [
        { value: "fast", label: "Fast preview", description: "Quick, lower-quality edges." },
        { value: "quality", label: "High quality", description: "Slower, temporally stable edges - recommended before export." }
      ]
    },
    maskSourceOptionField
  ],
  run: async (args) => runSegmentationMatte(args),
  applyResult: ({ composition, asset, result, options, context }) =>
    applyRemoveBackgroundComposition(
      composition,
      {
        mode: options.mode === "greenScreen" ? "greenScreen" : "timelineMask",
        maskId: result.id,
        mask: result,
        sourceAssetId: asset.id,
        ...(options.plateColor ? { plateColor: options.plateColor } : {})
      },
      context === "standalone" ? "replace" : "insert"
    ),
  describeEditableFields: ({ result, options }) => ({
    maskSequence: result,
    compositingTool: "remove-background",
    compositingMode: options.mode === "greenScreen" ? "greenScreen" : "timelineMask",
    ...(options.plateColor ? { plateColor: options.plateColor } : {})
  })
});

const textBehindPersonLayerEffect = defineLayerToolEffectHandler<MaskSequenceArtifactData>({
  toolSlug: "text-behind-person",
  optionFields: [
    {
      key: "quality",
      label: "Quality",
      defaultValue: "fast",
      choices: [
        { value: "fast", label: "Fast preview", description: "Quick, lower-quality edges." },
        { value: "quality", label: "High quality", description: "Slower, temporally stable edges - recommended before export." }
      ]
    },
    maskSourceOptionField
  ],
  run: async (args) => runSegmentationMatte(args),
  applyResult: ({ composition, asset, result, options, context }) => {
    const fontSize = Number(options.fontSize);
    const posX = Number(options.positionX);
    const posY = Number(options.positionY);
    const hasPosition = Number.isFinite(posX) && Number.isFinite(posY);
    return applyTextBehindPersonComposition(
      composition,
      {
        text: options.text || "TEXT",
        textColor: options.textColor || "#FFFFFF",
        maskId: result.id,
        mask: result,
        sourceAssetId: asset.id,
        ...(Number.isFinite(fontSize) && fontSize > 0 ? { fontSize } : {}),
        ...(options.fontFamily ? { fontFamily: options.fontFamily } : {}),
        ...(hasPosition ? { position: { x: posX, y: posY } } : {})
      },
      context === "standalone" ? "replace" : "insert"
    );
  },
  describeEditableFields: ({ result, options }) => ({
    maskSequence: result,
    compositingTool: "text-behind-person",
    compositingMode: "textBehindPerson",
    behindText: options.text || "TEXT",
    behindTextColor: options.textColor || "#FFFFFF"
  })
});

const aiRotoLayerEffect = defineLayerToolEffectHandler<MaskSequenceArtifactData>({
  toolSlug: "ai-roto",
  run: async ({ asset, fps, onProgress, isCancelled }) => {
    const capabilities = detectBrowserToolCapabilities();
    if (!isSamSupported(capabilities)) {
      throw new Error("AI Roto needs a browser with Web Workers support.");
    }
    // One-click path: seed a single center-frame positive point. The full /tools/ai-roto
    // page lets the user place their own include/exclude clicks for precise selections.
    const prompt: SamPrompt = { positive: [{ x: 0.5, y: 0.5 }], negative: [] };
    const result = await segmentVideoPrompted({
      videoUrl: asset.fileUrl,
      sourceAssetId: asset.id,
      durationSeconds: asset.durationSeconds,
      width: asset.width || 720,
      height: asset.height || 1280,
      targetFps: fps,
      prompt,
      profile: chooseSamDeviceProfile(capabilities, asset.durationSeconds),
      onProgress,
      isCancelled
    });
    onProgress("Saving matte...");
    const store = await createToolArtifactStore();
    const runId = `roto_${Date.now()}`;
    const baked = await storeMatteArtifact(result, store, runId);
    const outcome = await uploadMatteForExport({
      maskSequence: baked.maskSequence,
      blob: baked.blob,
      folder: "generated/roto",
      onProgress
    });
    // Deliberately NOT registered for cross-tool reuse: an AI-roto matte keys an
    // arbitrary prompted object, not the person mask the other tools expect.
    return outcome.maskSequence;
  },
  applyResult: ({ composition, asset, result, context }) =>
    applyExtractPersonComposition(
      composition,
      { mask: result, sourceAssetId: asset.id },
      context === "standalone" ? "replace" : "insert"
    )
});

interface RemovePersonResult {
  inpaintedAssetId: string;
  inpaintedUri: string;
  durationSeconds: number;
}

/** One-click seed: a static centered box covering roughly the middle third of the frame. */
function buildCenteredInpaintMask(width: number, height: number): InpaintMask {
  const maskW = 100;
  const maskH = 100;
  const coverage = new Uint8Array(maskW * maskH);
  const x0 = Math.round(maskW * 0.3);
  const x1 = Math.round(maskW * 0.7);
  const y0 = Math.round(maskH * 0.15);
  const y1 = Math.round(maskH * 0.85);
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      coverage[y * maskW + x] = 255;
    }
  }
  return { width: maskW, height: maskH, frames: [{ timeSeconds: 0, coverage }] };
}

const removePersonLayerEffect = defineLayerToolEffectHandler<RemovePersonResult>({
  toolSlug: "remove-person",
  run: async ({ asset, fps, onProgress, isCancelled }) => {
    onProgress("Seeding a centered selection (use the full Remove Person tool to brush a precise area)...");
    const capabilities = detectBrowserToolCapabilities();
    const width = asset.width || 720;
    const height = asset.height || 1280;
    const result = await runVideoInpaint({
      videoUrl: asset.fileUrl,
      durationSeconds: asset.durationSeconds,
      width,
      height,
      fps,
      mask: buildCenteredInpaintMask(width, height),
      capabilities,
      onProgress,
      isCancelled
    });
    onProgress("Encoding the reconstructed clip...");
    const store = await createToolArtifactStore();
    const runId = `inpaint_${Date.now()}`;
    const { clip, blob } = await storeInpaintArtifact(result, store, runId, "browser", asset.id);
    const createdAsset = await createAsset({
      file: new File([blob], `${clip.id}.webm`, { type: blob.type || "video/webm" }),
      source: "timeline-generated",
      folder: "generated/person-removed",
      originalName: "Person removed"
    });
    return {
      inpaintedAssetId: createdAsset.id,
      inpaintedUri: createdAsset.fileUrl,
      durationSeconds: asset.durationSeconds
    };
  },
  applyResult: ({ composition, asset, result, context }) =>
    applyRemovePersonComposition(
      composition,
      {
        inpaintedAssetId: result.inpaintedAssetId,
        inpaintedUri: result.inpaintedUri,
        durationSeconds: result.durationSeconds,
        sourceAssetId: asset.id
      },
      context === "standalone" ? "replace" : "insert"
    )
});

export const layerToolEffectHandlers: LayerToolEffectHandler[] = [
  autoCaptionsLayerEffect,
  extractPersonLayerEffect,
  smartFollowTextLayerEffect,
  removeBackgroundLayerEffect,
  textBehindPersonLayerEffect,
  aiRotoLayerEffect,
  removePersonLayerEffect
];

export function getLayerToolEffectHandler(toolSlug: string): LayerToolEffectHandler | undefined {
  return layerToolEffectHandlers.find((handler) => handler.toolSlug === toolSlug);
}
