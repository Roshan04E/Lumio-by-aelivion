import {
  applyCaptionTrackToComposition,
  applyExtractPersonComposition,
  applySmartFollowTextComposition,
  applyStabilizationComposition,
  captionStylePresets,
  createCaptionTrack,
  type SourceAsset,
  type TimelineComposition,
  type TimelineLayer,
  type TrackingPathArtifactData
} from "@lumio-by-aelivion/shared";
import { createAsset } from "../lib/api";
import { createToolArtifactStore } from "./artifact-store";
import { detectBrowserToolCapabilities } from "./capabilities";
import { chooseSegmentationDeviceProfile, segmentVideoFast, segmentVideoQuality } from "./local-segmentation";
import { trackSubjectPlanar3D } from "./local-tracking";
import { transcribeAssetLocally } from "./local-transcription";
import { storeMatteArtifact } from "./matte-store";

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

export const layerToolEffectHandlers: LayerToolEffectHandler[] = [
  autoCaptionsLayerEffect,
  extractPersonLayerEffect,
  smartFollowTextLayerEffect
];

export function getLayerToolEffectHandler(toolSlug: string): LayerToolEffectHandler | undefined {
  return layerToolEffectHandlers.find((handler) => handler.toolSlug === toolSlug);
}
