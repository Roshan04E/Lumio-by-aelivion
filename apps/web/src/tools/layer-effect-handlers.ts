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
  type TimelineComposition,
  type TimelineLayer,
  type TrackingPathArtifactData
} from "@kimera-by-aelivion/shared";
import { createAsset } from "../lib/api";
import { createToolArtifactStore } from "./artifact-store";
import { detectBrowserToolCapabilities } from "./capabilities";
import { storeInpaintArtifact } from "./inpaint-store";
import { chooseSamDeviceProfile, isSamSupported, segmentVideoPrompted, type SamPrompt } from "./local-sam";
import { chooseSegmentationDeviceProfile, segmentVideoFast, segmentVideoQuality } from "./local-segmentation";
import { trackSubjectPlanar3D } from "./local-tracking";
import { transcribeAssetLocally } from "./local-transcription";
import { storeMatteArtifact } from "./matte-store";
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
  layer: TimelineLayer;
  /** Composition frame rate, so tools can frame-lock their output to the timeline. */
  fps: number;
  options: Record<string, string>;
  onProgress: (message: string) => void;
  isCancelled: () => boolean;
}

export interface LayerToolEffectApplyArgs<TResult> {
  composition: TimelineComposition;
  layer: TimelineLayer;
  asset: SourceAsset;
  result: TResult;
  /** The same run-time choices the user selected before Run (see optionFields). */
  options: Record<string, string>;
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
}

function defineLayerToolEffectHandler<TResult>(handler: LayerToolEffectHandler<TResult>): LayerToolEffectHandler<unknown> {
  return handler as LayerToolEffectHandler<unknown>;
}

const autoCaptionsLayerEffect = defineLayerToolEffectHandler({
  toolSlug: "auto-captions",
  run: async ({ asset, onProgress, isCancelled }) => transcribeAssetLocally(asset, onProgress, isCancelled),
  applyResult: ({ composition, result }) => {
    const stylePreset = captionStylePresets[0]!;
    const captionTrack = createCaptionTrack(result, stylePreset.id, "");
    return applyCaptionTrackToComposition(composition, captionTrack, stylePreset);
  }
});

const extractPersonLayerEffect = defineLayerToolEffectHandler({
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
    }
  ],
  run: async ({ asset, fps, options, onProgress, isCancelled }) => {
    const segmentOptions = {
      videoUrl: asset.fileUrl,
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
    const { maskSequence, blob } = await storeMatteArtifact(result, store, runId);
    try {
      const matteAsset = await createAsset({
        file: new File([blob], `${maskSequence.id}.webm`, { type: blob.type || "video/webm" }),
        source: "timeline-generated",
        folder: "generated/background-removed",
        originalName: "Subject matte"
      });
      return { ...maskSequence, matteVideoUri: matteAsset.fileUrl };
    } catch {
      return maskSequence;
    }
  },
  applyResult: ({ composition, asset, result }) =>
    applyExtractPersonComposition(composition, { mask: result, sourceAssetId: asset.id }, "insert")
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
    }
  ],
  run: async ({ asset, fps, options, onProgress, isCancelled }) =>
    trackSubjectPlanar3D({
      videoUrl: asset.fileUrl,
      durationSeconds: asset.durationSeconds,
      width: asset.width || 720,
      height: asset.height || 1280,
      quality: options.quality === "quality" ? "quality" : "fast",
      trackFps: Math.min(15, Math.max(6, Math.round(fps))),
      onProgress,
      isCancelled
    }),
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
 * Shared by remove-background and text-behind-person: both need the same fast
 * person-segmentation matte, stored the same way extract-person stores it.
 */
async function runSegmentationMatte(args: LayerToolEffectRunArgs): Promise<MaskSequenceArtifactData> {
  const { asset, fps, onProgress, isCancelled } = args;
  const result = await segmentVideoFast({
    videoUrl: asset.fileUrl,
    durationSeconds: asset.durationSeconds,
    width: asset.width || 720,
    height: asset.height || 1280,
    targetFps: fps,
    tier: "fast",
    onProgress,
    isCancelled
  });
  onProgress("Saving matte...");
  const store = await createToolArtifactStore();
  const runId = `matte_${Date.now()}`;
  const { maskSequence, blob } = await storeMatteArtifact(result, store, runId);
  try {
    const matteAsset = await createAsset({
      file: new File([blob], `${maskSequence.id}.webm`, { type: blob.type || "video/webm" }),
      source: "timeline-generated",
      folder: "generated/background-removed",
      originalName: "Subject matte"
    });
    return { ...maskSequence, matteVideoUri: matteAsset.fileUrl };
  } catch {
    return maskSequence;
  }
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
        { value: "greenScreen", label: "Green screen", description: "Composites the subject over a solid green plate." }
      ]
    }
  ],
  run: async (args) => runSegmentationMatte(args),
  applyResult: ({ composition, asset, result, options }) =>
    applyRemoveBackgroundComposition(
      composition,
      {
        mode: options.mode === "greenScreen" ? "greenScreen" : "timelineMask",
        maskId: result.id,
        mask: result,
        sourceAssetId: asset.id
      },
      "insert"
    )
});

const textBehindPersonLayerEffect = defineLayerToolEffectHandler<MaskSequenceArtifactData>({
  toolSlug: "text-behind-person",
  run: async (args) => runSegmentationMatte(args),
  applyResult: ({ composition, asset, result }) =>
    applyTextBehindPersonComposition(
      composition,
      {
        text: "TEXT",
        textColor: "#FFFFFF",
        maskId: result.id,
        mask: result,
        sourceAssetId: asset.id
      },
      "insert"
    )
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
    const { maskSequence, blob } = await storeMatteArtifact(result, store, runId);
    try {
      const matteAsset = await createAsset({
        file: new File([blob], `${maskSequence.id}.webm`, { type: blob.type || "video/webm" }),
        source: "timeline-generated",
        folder: "generated/roto",
        originalName: "Subject matte"
      });
      return { ...maskSequence, matteVideoUri: matteAsset.fileUrl };
    } catch {
      return maskSequence;
    }
  },
  applyResult: ({ composition, asset, result }) =>
    applyExtractPersonComposition(composition, { mask: result, sourceAssetId: asset.id }, "insert")
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
  applyResult: ({ composition, asset, result }) =>
    applyRemovePersonComposition(
      composition,
      {
        inpaintedAssetId: result.inpaintedAssetId,
        inpaintedUri: result.inpaintedUri,
        durationSeconds: result.durationSeconds,
        sourceAssetId: asset.id
      },
      "insert"
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
