import { expandEffectRegionMasks, isTrackEnabled } from "@reelforge/shared";
import type { BlendMode, Mask, MatteRef, ProjectGraph, SourceAsset, TemplateDefinition, TextRun, TimelineComposition, TimelineKeyframeV2, TransitionSpec } from "@reelforge/shared";

export interface RenderComposition {
  id: string;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  layers: Array<{
    id: string;
    type: string;
    label: string;
    config: Record<string, unknown>;
  }>;
}

export function buildCompositionFromGraph(
  template: Pick<TemplateDefinition, "slug" | "durationSeconds">,
  graph: ProjectGraph
): RenderComposition {
  if (graph.composition) {
    return {
      id: `${graph.composition.id}_${graph.version}`,
      width: graph.composition.width,
      height: graph.composition.height,
      fps: graph.composition.fps,
      durationInFrames: Math.round(graph.composition.durationSeconds * graph.composition.fps),
      layers: graph.composition.tracks.flatMap((track) =>
        track.layers.map((layer) => ({
          id: layer.id,
          type: layer.type,
          label: `${track.name} / ${layer.name}`,
          config: {
            startSeconds: layer.startSeconds,
            durationSeconds: layer.durationSeconds,
            assetId: layer.assetId,
            text: layer.text,
            transform: layer.transform,
            effects: layer.effects,
            keyframes: layer.keyframes
          }
        }))
      )
    };
  }

  return {
    id: `composition_${template.slug}_${graph.version}`,
    width: 720,
    height: 1280,
    fps: 30,
    durationInFrames: template.durationSeconds * 30,
    layers: graph.effects.map((effect, index) => ({
      id: effect.id,
      type: effect.type,
      label: `${index + 1}. ${effect.name}`,
      config: effect.config
    }))
  };
}

export function createPreviewOverlay(graph: ProjectGraph) {
  return {
    watermark: "ReelForge Preview",
    effectBadges: graph.effects.map((effect) => effect.name),
    trackingDots: graph.effects.some((effect) => effect.type === "SMART_3D_FOLLOW_TEXT"),
    personCutoutLayer: graph.effects.some((effect) => effect.type === "TEXT_BEHIND_PERSON")
  };
}

export type RenderQuality = "preview" | "final";

export interface RenderManifestAsset {
  id: string;
  fileName: string;
  fileType: string;
  fileUrl: string;
  durationSeconds: number;
  width: number;
  height: number;
}

export interface RenderManifestLayer {
  id: string;
  trackId: string;
  trackName: string;
  trackType: string;
  zIndex: number;
  type: string;
  name: string;
  startSeconds: number;
  durationSeconds: number;
  assetId?: string | undefined;
  assetUrl?: string | undefined;
  text?: string | undefined;
  textRuns?: TextRun[] | undefined;
  /** Source media in-point (seconds), carried verbatim from the timeline layer for source-aware trimming. */
  sourceInSeconds?: number | undefined;
  /**
   * Person-extraction matte, carried through verbatim from the timeline layer.
   * `matte.uri` must resolve to an http(s) URL the worker can fetch - an OPFS
   * uri (browser-only storage) needs to be uploaded/resolved before reaching the
   * render manifest; that resolution step is not built yet (see CLAUDE.md /
   * Open follow-ups in the Extract Person plan).
   */
  matte?: MatteRef | undefined;
  /** Vector masks carried verbatim from the timeline layer; both renderers build the same SVG from them. */
  masks?: Mask[] | undefined;
  /** Junction transition on the incoming side, carried verbatim; the renderer reads wipe/iris from it. */
  transitionIn?: TransitionSpec | undefined;
  /** Layer blend mode, carried verbatim; the renderer applies it as CSS mix-blend-mode. */
  blendMode?: BlendMode | undefined;
  transform: Record<string, unknown>;
  style: Record<string, unknown>;
  effects: unknown[];
  keyframes: unknown[];
  animations: TimelineKeyframeV2[];
  animatedProperties: string[];
  /** Base value for the typewriter reveal (0–1). When animated via `animations`,
   *  the Remotion renderer evaluates keyframes to determine visible character count. */
  textRevealProgress?: number | undefined;
  muted?: boolean | undefined;
}

export interface RenderManifest {
  id: string;
  schemaVersion: 1;
  animationVersion: 1;
  projectId: string;
  quality: RenderQuality;
  output: {
    width: number;
    height: number;
    fps: number;
    durationSeconds: number;
    durationInFrames: number;
    format: "mp4";
  };
  assets: RenderManifestAsset[];
  layers: RenderManifestLayer[];
  createdAt: string;
  renderer: {
    engine: "reelforge-manifest";
    version: 1;
    note: string;
  };
}

export function buildRenderManifest(input: {
  projectId: string;
  graph: ProjectGraph;
  assets: SourceAsset[];
  quality: RenderQuality;
  createdAt?: string | undefined;
}): RenderManifest {
  // Expand color/glow region masks into base + duplicate layers so the Remotion renderer gets them via the
  // normal clip-mask path (duplicate's higher layerIndex → higher zIndex → drawn above its base).
  const composition = expandEffectRegionMasks(input.graph.composition ?? fallbackComposition(input.projectId));
  const assetMap = new Map(input.assets.map((asset) => [asset.id, asset]));
  const visualTracks = composition.tracks.filter((track) => track.type !== "audio");

  // Premiere-style work area: when in/out points are set on the timeline, export
  // is clipped to that sub-range. Layers outside the range are dropped, layers
  // straddling an edge are trimmed, and everything is shifted so the range's
  // in-point becomes t=0 in the rendered output.
  const inPointSeconds = clampRange(composition.settings?.timeline.inPointSeconds ?? 0, 0, composition.durationSeconds);
  const outPointSeconds = clampRange(composition.settings?.timeline.outPointSeconds ?? composition.durationSeconds, inPointSeconds, composition.durationSeconds);
  const rangeDurationSeconds = Math.max(1 / composition.fps, outPointSeconds - inPointSeconds);

  const layers = composition.tracks.flatMap((track, trackIndex) =>
    track.layers
      .filter((layer) => isTrackEnabled(track, composition.tracks) && !layer.muted)
      .flatMap((layer, layerIndex) => {
        const layerStartSeconds = layer.startSeconds;
        const layerEndSeconds = layer.startSeconds + layer.durationSeconds;
        if (layerEndSeconds <= inPointSeconds || layerStartSeconds >= outPointSeconds) {
          return [];
        }
        const clippedStartSeconds = Math.max(layerStartSeconds, inPointSeconds);
        const clippedEndSeconds = Math.min(layerEndSeconds, outPointSeconds);
        const trimmedFromHeadSeconds = clippedStartSeconds - layerStartSeconds;

        const asset = layer.assetId ? assetMap.get(layer.assetId) : undefined;
        const visualZIndex = track.type === "audio" ? -1 : visualTracks.length - trackIndex;
        return [{
          id: layer.id,
          trackId: track.id,
          trackName: track.name,
          trackType: track.type,
          zIndex: visualZIndex * 1000 + layerIndex,
          type: layer.type,
          name: layer.name,
          startSeconds: clippedStartSeconds - inPointSeconds,
          durationSeconds: clippedEndSeconds - clippedStartSeconds,
          assetId: layer.assetId,
          assetUrl: asset?.fileUrl,
          text: layer.text,
          textRuns: layer.textRuns,
          sourceInSeconds: layer.sourceInSeconds !== undefined ? layer.sourceInSeconds + trimmedFromHeadSeconds : layer.sourceInSeconds,
          matte: layer.matte,
          masks: layer.masks,
          transitionIn: layer.transitionIn,
          blendMode: layer.blendMode,
          transform: layer.transform as unknown as Record<string, unknown>,
          style: {
            color: layer.color,
            fontFamily: layer.fontFamily,
            fontSize: layer.fontSize,
            fontWeight: layer.fontWeight,
            italic: layer.italic,
            letterSpacing: layer.letterSpacing,
            lineHeight: layer.lineHeight,
            textWidthPercent: layer.textWidthPercent,
            textAlign: layer.textAlign,
            textWarp: layer.textWarp,
            fit: layer.fit,
            widthPercent: layer.widthPercent,
            heightPercent: layer.heightPercent,
            borderRadius: layer.borderRadius,
            strokeColor: layer.strokeColor,
            strokeWidth: layer.strokeWidth,
            backgroundColor: layer.backgroundColor,
            backgroundPaddingEm: layer.backgroundPaddingEm,
            backgroundRadiusEm: layer.backgroundRadiusEm,
            shadowColor: layer.shadowColor,
            shadowBlur: layer.shadowBlur,
            shadowOffsetX: layer.shadowOffsetX,
            shadowOffsetY: layer.shadowOffsetY
          },
          effects: layer.effects,
          keyframes: layer.keyframes,
          animations: layer.animations ?? [],
          animatedProperties: [...new Set([...(layer.keyframes ?? []).map((keyframe) => keyframe.property), ...(layer.animations ?? []).map((animation) => animation.target.property)])],
          textRevealProgress: layer.textRevealProgress,
          muted: layer.muted
        } satisfies RenderManifestLayer];
      })
  );

  const outputFps = input.quality === "preview" ? Math.min(24, composition.fps) : composition.fps;

  return {
    id: `render_${input.projectId}_${input.quality}_${Date.now()}`,
    schemaVersion: 1,
    animationVersion: 1,
    projectId: input.projectId,
    quality: input.quality,
    output: {
      width: input.quality === "preview" ? Math.round(composition.width / 2) : composition.width,
      height: input.quality === "preview" ? Math.round(composition.height / 2) : composition.height,
      fps: outputFps,
      durationSeconds: rangeDurationSeconds,
      durationInFrames: Math.round(rangeDurationSeconds * outputFps),
      format: "mp4"
    },
    assets: input.assets.map((asset) => ({
      id: asset.id,
      fileName: asset.fileName,
      fileType: asset.fileType,
      fileUrl: asset.fileUrl,
      durationSeconds: asset.durationSeconds,
      width: asset.width,
      height: asset.height
    })),
    layers,
    createdAt: input.createdAt ?? new Date().toISOString(),
    renderer: {
      engine: "reelforge-manifest",
      version: 1,
      note: "This manifest is the render contract. Remotion/FFmpeg encoding plugs into this boundary next."
    }
  };
}

function clampRange(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function fallbackComposition(projectId: string): TimelineComposition {
  return {
    id: `composition_${projectId}`,
    name: "Untitled render",
    width: 1080,
    height: 1920,
    fps: 30,
    durationSeconds: 12,
    backgroundColor: "#000000",
    tracks: []
  };
}
