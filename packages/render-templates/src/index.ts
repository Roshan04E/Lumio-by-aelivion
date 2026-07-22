import { REGION_PASS_MODEL_DEFAULT, expandEffectRegionMasks, expandFrameBorders, expandNestedCompositions, getTrackAudioGain, getTrackPan, graphicIsAnimated, graphicToDataUrl, isTrackEnabled, layerSourceTimeSeconds, normalizeProjectColorSettings, shiftSpeedKeyframes, type LayerFrame, type LayerGraphic } from "@orreris/shared";

/** Manifest field that lets the renderer PLAY a SMIL-animated graphic (see `RenderManifestLayer.graphic`).
 *  Static/absent graphics contribute nothing, so the settled `assetUrl` stays the source. */
function graphicAnimationFields(graphic: LayerGraphic | undefined): { graphic?: LayerGraphic } {
  return graphic && graphicIsAnimated(graphic) ? { graphic } : {};
}
import type {
  BlendMode,
  FlarexComp,
  LayerContentTransform,
  Mask,
  MatteRef,
  ManifestEncodeSettings,
  NestedGroupSpec,
  PluginEffectManifest,
  PluginLookManifest,
  PluginTransitionManifest,
  ProjectColorSettings,
  ProjectGraph,
  SourceAsset,
  SourceColorMetadata,
  SourceTextKeyframe,
  SpeedKeyframe,
  TemplateDefinition,
  TextRun,
  TimelineComposition,
  TimelineKeyframeV2,
  TimelineLayer,
  TrackAudioKeyframe,
  TransitionSpec
} from "@orreris/shared";

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
    watermark: "Orreris Preview",
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
  /** Detected/assumed source color metadata (Rec.709 SDR contract). Absent → assume Rec.709. */
  color?: SourceColorMetadata | undefined;
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
  /**
   * Vector graphic carrying SMIL animation. `assetUrl` holds the SETTLED (static) bake as a fallback;
   * when this is present the renderer instead rebuilds a deep-linked data URL PER FRAME
   * (`graphicToAnimatedDataUrl` at the shared `graphicAnimationBakeTime`) so the animation plays — same
   * frame math as the web preview + local export. Carries the layer's loop/duration overrides with it,
   * so the renderer resolves the plan via `resolveGraphicAnimation`. Static graphics leave this undefined.
   */
  graphic?: LayerGraphic | undefined;
  text?: string | undefined;
  textRuns?: TextRun[] | undefined;
  sourceTextKeyframes?: SourceTextKeyframe[] | undefined;
  /** Source media in-point (seconds), carried verbatim from the timeline layer for source-aware trimming. */
  sourceInSeconds?: number | undefined;
  /** Constant playback rate (rate stretch), carried verbatim. 1/absent = normal. */
  speed?: number | undefined;
  /**
   * Speed ramp (layer-local seconds → rate, linear segments), carried verbatim. Overrides `speed`.
   * Video: Remotion remaps per frame (dynamic trimBefore). Audio: presence routes the render
   * through the worker's audio post-mix (Remotion `<Audio>` can't ramp).
   */
  speedKeyframes?: SpeedKeyframe[] | undefined;
  /**
   * Frame hold ("on twos"): quantize VIDEO local time to N images/second, carried verbatim.
   * Audio stays continuous. Renderers map via shared `layerHeldLocalSeconds`.
   */
  holdFps?: number | undefined;
  /** Track mixer fader gain (0..2, 1 = unity), resolved at manifest build. */
  trackGain?: number | undefined;
  /** Track stereo pan (−1..1). Remotion itself can't pan; non-zero pan routes the render through the worker's audio post-mix. */
  trackPan?: number | undefined;
  /** Track fader automation (absolute comp seconds, linear), denormalized per layer. */
  trackVolumeKeyframes?: TrackAudioKeyframe[] | undefined;
  /** Track pan automation — presence routes the render through the worker's audio post-mix. */
  trackPanKeyframes?: TrackAudioKeyframe[] | undefined;
  /**
   * Person-extraction matte, carried through verbatim from the timeline layer.
   * `matte.uri` must resolve to an http(s) URL the worker can fetch - blob:/OPFS
   * uris (browser-only) are uploaded and rewritten client-side before a render
   * job is created: best-effort on every background sync and hard-gated in
   * `ensureExportReady` (both via `apps/web/src/export/matte-resolve.ts`, which
   * throws a MatteResolveError naming the layer when the bytes are unrecoverable).
   */
  matte?: MatteRef | undefined;
  /** Vector masks carried verbatim from the timeline layer; both renderers build the same SVG from them. */
  masks?: Mask[] | undefined;
  /**
   * Parametric frame (FRAMES.md), carried verbatim. The renderer synthesizes its clip mask via the shared
   * `frameClipMask` (SceneMaskMatteCache reads `layer.frame`), exactly like the preview/local export.
   * Without this a framed clip renders UN-clipped in the cloud path — pinned by the framed-media fixture.
   */
  frame?: LayerFrame | undefined;
  /**
   * Track matte key (D1), carried verbatim. The renderer's shared `buildSceneDraws` re-resolves the
   * SOURCE clip (nearest above in z) per frame — without this a matted clip renders UN-matted (and
   * its consumed source pops back in) in the cloud path. Pinned by the track-matte fixture.
   */
  trackMatte?: { mode: "alpha" | "luma"; invert?: boolean | undefined } | undefined;
  /**
   * Texture fill on text/shape (D2), carried verbatim — the shared rasterizer decodes `url` per
   * renderer. Like matte uris, `url` must be durable http(s)/data: for the cloud path.
   */
  fillTexture?: { assetId?: string | undefined; url: string; fit: "cover" | "tile"; scale?: number | undefined } | undefined;
  /** Junction transition on the incoming side, carried verbatim; the renderer reads wipe/iris from it. */
  transitionIn?: TransitionSpec | undefined;
  /** Layer blend mode, carried verbatim; the renderer applies it as CSS mix-blend-mode. */
  blendMode?: BlendMode | undefined;
  /** Flarex node-comp reference (FLAREX.md), carried verbatim — resolved against `RenderManifest.flarexComps`
   *  by the shared lowering compiler; without both, a comp'd clip renders as plain media in the cloud path. */
  flarexCompId?: string | undefined;
  /** Source-within-frame media pan/zoom/crop, carried verbatim for scene-compositor paths. */
  content?: LayerContentTransform | undefined;
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
    /**
     * Managed color contract for the render (working/output space + range). Both the local export and the
     * cloud/Remotion renderer tag output from this, so all render paths agree on Rec.709 SDR. `buildRenderManifest`
     * always sets it; optional so older serialized manifests / literals stay valid (consumers default to Rec.709).
     */
    color?: ProjectColorSettings | undefined;
    /**
     * Encode settings chosen in the export window (bitrate/mode). Set by the API's renderFinal from
     * the user's ExportSettings; the worker's renderMedia reads it. Absent → renderer defaults.
     */
    encode?: ManifestEncodeSettings | undefined;
  };
  assets: RenderManifestAsset[];
  plugins?: {
    effects?: PluginEffectManifest[] | undefined;
    looks?: PluginLookManifest[] | undefined;
    transitions?: PluginTransitionManifest[] | undefined;
  } | undefined;
  layers: RenderManifestLayer[];
  /**
   * Region-effect PASS model (see shared `REGION_PASS_MODEL_DEFAULT`): recorded at manifest build time so
   * the cloud renderer composites regions the same way the preview/local export that produced this manifest
   * did — all three renderers flip together through the one shared constant, never independently.
   */
  regionPassModel?: boolean | undefined;
  /**
   * Compound-clip group specs from `expandNestedCompositions` (NESTING.md Phase C), serialized as a plain
   * Record (Maps aren't JSON-safe) — `layers` above already carries nested children flattened in as
   * ordinary entries; this is consulted only to fold them back into a group + build the compound clip's
   * shell, exactly like the web preview/local export. Absent/empty = no nesting in this manifest.
   */
  nestedGroups?: Record<string, NestedGroupSpec> | undefined;
  /**
   * Flarex node-comp registry (FLAREX.md), carried verbatim from `ProjectGraph.flarexComps` — the
   * shared lowering compiler resolves `layer.flarexCompId` against it identically in all three
   * renderers. Absent = no comp'd clips in this manifest.
   */
  flarexComps?: Record<string, FlarexComp> | undefined;
  /**
   * RAW (unexpanded) layers of every track containing a compound clip (nesting Block 4c): junctions
   * where a side IS a compound clip only exist on the raw composition — nest expansion removes the
   * compound from its track, so the renderer's pair scan needs these to fold group↔clip transitions.
   * Absent = no compound junctions possible.
   */
  rawJunctionLayers?: TimelineLayer[] | undefined;
  createdAt: string;
  renderer: {
    engine: "orreris-manifest";
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
  // Nested sequences (NESTING.md Phase C) expand FIRST — same order as the web preview (VideoPreview.tsx)
  // and local export (export-core.ts): nest-expand, THEN region-mask expand. `expandNestedCompositions`
  // returns the SAME composition reference when there's nothing to expand, so a non-nested manifest is
  // unaffected. Nested children flatten into `layers` below like any other layer (generic over `layer.id`/
  // `layer.type`); `nestExpansion.groups` is carried separately (see `nestedGroups` on `RenderManifest`) so
  // SceneStage can fold them back into a group + build the compound clip's shell.
  const rawComposition = input.graph.composition ?? fallbackComposition(input.projectId);
  const nestExpansion = expandNestedCompositions(rawComposition, input.graph.compositions);
  // Block 4c: raw layers of every track containing a compound clip — junctions where a side is a
  // compound clip are only discoverable there (the expansion removes the compound from its track).
  const rawJunctionLayers = rawComposition.tracks
    .filter((track) => track.layers.some((layer) => layer.nestedCompositionId))
    .flatMap((track) => track.layers);
  // Frame borders expand FIRST (a framed layer gains a derived stroke-only shape clone above it — Step E),
  // then color/glow region masks into base + duplicate layers, so the Remotion renderer gets both via the
  // normal shape/clip-mask paths (duplicate's higher layerIndex → higher zIndex → drawn above its base).
  // Same order as the web preview (VideoPreview.tsx) and local export (export-core.ts).
  const composition = expandEffectRegionMasks(expandFrameBorders(nestExpansion.composition));
  const assetMap = new Map(input.assets.map((asset) => [asset.id, asset]));
  const visualTracks = composition.tracks.filter((track) => track.type !== "audio");

  // Premiere-style work area: when in/out points are set on the timeline, export
  // is clipped to that sub-range. Layers outside the range are dropped, layers
  // straddling an edge are trimmed, and everything is shifted so the range's
  // in-point becomes t=0 in the rendered output.
  const inPointSeconds = clampRange(composition.settings?.timeline.inPointSeconds ?? 0, 0, composition.durationSeconds);
  const outPointSeconds = clampRange(composition.settings?.timeline.outPointSeconds ?? composition.durationSeconds, inPointSeconds, composition.durationSeconds);
  const rangeDurationSeconds = Math.max(1 / composition.fps, outPointSeconds - inPointSeconds);
  const preserveTimingLayerIds = new Set<string>();
  const visualEndSecondsByLayerId = new Map<string, number>();
  const overlapsRange = (startSeconds: number, endSeconds: number) => startSeconds < outPointSeconds && inPointSeconds < endSeconds;
  const regionCloneBaseId = (layerId: string): string | null => {
    const marker = layerId.indexOf("__rfx_");
    return marker > 0 ? layerId.slice(0, marker) : null;
  };

  for (const track of composition.tracks) {
    for (const incoming of track.layers) {
      const transition = incoming.transitionIn;
      if (!transition || incoming.type === "audio") continue;
      const incomingStart = incoming.startSeconds;
      const transitionDuration = Math.max(0, Math.min(transition.durationSeconds, incoming.durationSeconds));
      const transitionEnd = incomingStart + transitionDuration;
      if (!overlapsRange(incomingStart, transitionEnd)) continue;
      preserveTimingLayerIds.add(incoming.id);
      const outgoing = track.layers.find((layer) => {
        if (layer.id === incoming.id || layer.type === "audio") return false;
        return Math.abs(layer.startSeconds + layer.durationSeconds - incomingStart) < 0.05;
      });
      if (outgoing) {
        preserveTimingLayerIds.add(outgoing.id);
        visualEndSecondsByLayerId.set(outgoing.id, Math.max(visualEndSecondsByLayerId.get(outgoing.id) ?? 0, transitionEnd));
      }
    }
  }
  for (const track of composition.tracks) {
    for (const layer of track.layers) {
      const baseId = regionCloneBaseId(layer.id);
      if (baseId && preserveTimingLayerIds.has(baseId)) {
        preserveTimingLayerIds.add(layer.id);
        const baseVisualEnd = visualEndSecondsByLayerId.get(baseId);
        if (baseVisualEnd !== undefined) {
          visualEndSecondsByLayerId.set(layer.id, baseVisualEnd);
        }
      }
    }
  }

  const layers = composition.tracks.flatMap((track, trackIndex) =>
    track.layers
      .filter((layer) => isTrackEnabled(track, composition.tracks) && !layer.muted && !layer.disabled)
      .flatMap((layer, layerIndex) => {
        const layerStartSeconds = layer.startSeconds;
        const layerEndSeconds = layer.startSeconds + layer.durationSeconds;
        const visualEndSeconds = Math.max(layerEndSeconds, visualEndSecondsByLayerId.get(layer.id) ?? layerEndSeconds);
        if (visualEndSeconds <= inPointSeconds || layerStartSeconds >= outPointSeconds) {
          return [];
        }
        const preserveTiming = preserveTimingLayerIds.has(layer.id) && layerStartSeconds < inPointSeconds;
        if (preserveTiming) {
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
            startSeconds: layerStartSeconds - inPointSeconds,
            durationSeconds: layer.durationSeconds,
            assetId: layer.assetId,
            assetUrl: layer.graphic ? graphicToDataUrl(layer.graphic) : asset?.fileUrl,
            ...graphicAnimationFields(layer.graphic),
            text: layer.text,
            textRuns: layer.textRuns,
            sourceTextKeyframes: layer.sourceTextKeyframes,
            sourceInSeconds: layer.sourceInSeconds,
            speed: layer.speed,
            speedKeyframes: layer.speedKeyframes,
            holdFps: layer.holdFps,
            trackGain: getTrackAudioGain(track),
            trackPan: getTrackPan(track),
            trackVolumeKeyframes: track.volumeKeyframes,
            trackPanKeyframes: track.panKeyframes,
            matte: layer.matte,
            masks: layer.masks,
            frame: layer.frame,
            trackMatte: layer.trackMatte,
            fillTexture: layer.fillTexture,
            transitionIn: layer.transitionIn,
            blendMode: layer.blendMode,
            flarexCompId: layer.flarexCompId,
            content: layer.content,
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
              // Shape geometry — without these a non-default shape (pen path, ellipse, frame-border clone)
              // rendered as the default rounded-rectangle in the cloud path (styleOf reads this bag).
              shapeKind: layer.shapeKind,
              shapePath: layer.shapePath,
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
          assetUrl: layer.graphic ? graphicToDataUrl(layer.graphic) : asset?.fileUrl,
          ...graphicAnimationFields(layer.graphic),
          text: layer.text,
          textRuns: layer.textRuns,
          sourceTextKeyframes: layer.sourceTextKeyframes,
          // Head trim consumes source media at the clip's playback rate (rate stretch / ramp integral).
          sourceInSeconds:
            layer.sourceInSeconds !== undefined
              ? layerSourceTimeSeconds(layer, trimmedFromHeadSeconds)
              : layer.sourceInSeconds,
          speed: layer.speed,
          speedKeyframes: shiftSpeedKeyframes(layer, trimmedFromHeadSeconds),
          holdFps: layer.holdFps,
          trackGain: getTrackAudioGain(track),
          trackPan: getTrackPan(track),
          trackVolumeKeyframes: track.volumeKeyframes,
          trackPanKeyframes: track.panKeyframes,
          matte: layer.matte,
          masks: layer.masks,
          frame: layer.frame,
          trackMatte: layer.trackMatte,
          fillTexture: layer.fillTexture,
          transitionIn: layer.transitionIn,
          blendMode: layer.blendMode,
          flarexCompId: layer.flarexCompId,
          content: layer.content,
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
            // Shape geometry — without these a non-default shape (pen path, ellipse, frame-border clone)
            // rendered as the default rounded-rectangle in the cloud path (styleOf reads this bag).
            shapeKind: layer.shapeKind,
            shapePath: layer.shapePath,
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
      format: "mp4",
      color: normalizeProjectColorSettings(composition.settings?.color)
    },
    assets: input.assets.map((asset) => ({
      id: asset.id,
      fileName: asset.fileName,
      fileType: asset.fileType,
      fileUrl: asset.fileUrl,
      durationSeconds: asset.durationSeconds,
      width: asset.width,
      height: asset.height,
      ...(asset.color ? { color: asset.color } : {})
    })),
    plugins: input.graph.plugins,
    layers,
    regionPassModel: REGION_PASS_MODEL_DEFAULT,
    // NEST-REVIEW: `nestExpansion.groups` is computed from the composition BEFORE the work-area (in/out
    // point) clipping above, so a compound clip's SHELL (spec.clip.startSeconds/durationSeconds) is NOT
    // corrected the way its CHILDREN are (children are ordinary flattened layers and go through the
    // `clippedStartSeconds`/`trimmedFromHeadSeconds` logic in the `layers` loop like any clip). Only
    // matters when a compound clip straddles the work-area boundary — the fully-inside case (by far the
    // common one) is unaffected. `local-export.ts` avoids this by running `clipCompositionToWorkArea`
    // (a whole-composition clip) BEFORE nest-expansion; this function's work-area logic is instead inline
    // per-flattened-layer (with transition-preservation nuance `clipCompositionToWorkArea` doesn't have),
    // so reordering isn't a safe drop-in — a real fix means either giving the shell clip the same
    // start/duration correction here, or switching this function to the whole-composition clip utility.
    // Deferred as a narrow, documented gap rather than a rushed fix to shared work-area logic.
    ...(nestExpansion.groups.size > 0 ? { nestedGroups: Object.fromEntries(nestExpansion.groups) } : {}),
    // Flarex comps ride verbatim (FLAREX.md): only when at least one clip references one, so
    // non-Flarex manifests are byte-identical to before.
    ...(input.graph.flarexComps && Object.keys(input.graph.flarexComps).length > 0
      ? { flarexComps: input.graph.flarexComps }
      : {}),
    ...(nestExpansion.groups.size > 0 && rawJunctionLayers.length > 0 ? { rawJunctionLayers } : {}),
    createdAt: input.createdAt ?? new Date().toISOString(),
    renderer: {
      engine: "orreris-manifest",
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
