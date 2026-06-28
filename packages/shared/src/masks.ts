import type { MatteRef, TimelineComposition, TimelineEffect, TimelineKeyframeV2, TimelineLayer, TimelineVector2 } from "./types";

export interface SubjectBounds {
  timeSeconds: number;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
}

export interface MaskFrame {
  timeSeconds: number;
  width: number;
  height: number;
  previewPath: string;
  confidence: number;
}

export interface MaskSequenceArtifactData {
  id: string;
  sourceAssetId?: string | undefined;
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  /** Low-res frames for the inspector scrubber - cheap, not used for final compositing. */
  frames: MaskFrame[];
  /**
   * Canonical grayscale luma-matte video URI used by both renderers for real
   * compositing (white = keep, black = drop). Undefined until the matte has been
   * baked (e.g. mock/preview-only runs only populate `frames`).
   */
  matteVideoUri?: string | undefined;
  feather: number;
  edgeMode: "fast" | "clean";
  source: "mock" | "browser" | "cloud" | "desktop";
}

export interface TrackingPoint {
  timeSeconds: number;
  position: TimelineVector2;
  bounds: SubjectBounds;
  confidence: number;
  /**
   * Optional 3D track channels, present when the point came from a planar/homography
   * tracker rather than a plain subject-center bounding box. Undefined channels mean
   * "no change from identity" (scale 1, rotation 0).
   */
  scale?: number | undefined;
  /** In-plane (Z axis) rotation in degrees. */
  rotateZ?: number | undefined;
  /** Perspective tilt around the horizontal axis, degrees. */
  rotateX?: number | undefined;
  /** Perspective tilt around the vertical axis, degrees. */
  rotateY?: number | undefined;
}

export interface TrackingPathArtifactData {
  id: string;
  sourceAssetId?: string | undefined;
  durationSeconds: number;
  points: TrackingPoint[];
  smoothing: number;
  source: "mock" | "browser" | "cloud" | "desktop";
  /** True when `points` carry real scale/rotateZ/rotateX/rotateY from a planar track, not just position. */
  is3d?: boolean | undefined;
}

/**
 * A full-frame video where a selected subject has been removed and the hole
 * filled (inpainted). Unlike a mask, this is finished RGB color video - it is
 * dropped on the timeline as an ordinary video layer (no matte), so both
 * renderers play it identically with no special compositing.
 */
export interface InpaintedClipArtifactData {
  id: string;
  sourceAssetId?: string | undefined;
  /** Server asset id once uploaded (used for export + reload survival). */
  assetId?: string | undefined;
  /** Resolved playable URL (blob: for this session, http(s) after upload). */
  uri?: string | undefined;
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  source: "mock" | "browser" | "cloud" | "desktop";
}

export interface SubjectAnalysisArtifacts {
  maskSequence: MaskSequenceArtifactData;
  trackingPath: TrackingPathArtifactData;
  subjectBounds: SubjectBounds[];
}

/**
 * Builds the real `MatteRef` a renderer reads from a mask sequence artifact.
 * Returns `undefined` when the mask has no baked matte video yet (e.g. an
 * inspector-only/mock run that produced preview frames but no compositable matte) -
 * callers should fall back to a non-composited layer in that case.
 */
export function createMatteRefFromMaskSequence(
  mask: MaskSequenceArtifactData,
  overrides?: Partial<Pick<MatteRef, "invert" | "opacity">>
): MatteRef | undefined {
  if (!mask.matteVideoUri) {
    return undefined;
  }
  return {
    artifactId: mask.id,
    uri: mask.matteVideoUri,
    kind: "luma",
    fps: mask.fps,
    feather: mask.feather,
    edgeMode: mask.edgeMode,
    invert: overrides?.invert,
    opacity: overrides?.opacity
  };
}

export interface TextBehindPersonOptions {
  text: string;
  textColor: string;
  maskId: string;
  /** Real mask artifact, when available, so the subject layer gets a real MatteRef instead of placeholder metadata. */
  mask?: MaskSequenceArtifactData | undefined;
  sourceAssetId?: string | undefined;
}

export interface RemoveBackgroundOptions {
  mode: "timelineMask" | "greenScreen";
  maskId: string;
  /** Real mask artifact, when available, so the subject layer gets a real MatteRef instead of placeholder metadata. */
  mask?: MaskSequenceArtifactData | undefined;
  sourceAssetId?: string | undefined;
}

/**
 * Per-channel control over which tracked transform properties the follow
 * text actually applies. Position always follows; the rest are opt-in so the
 * user can pick e.g. "position only" (plain 2D follow) or "position +
 * rotation, no scale" instead of an all-or-nothing 2D/3D switch.
 */
export interface FollowTrackChannels {
  scale?: boolean | undefined;
  rotation?: boolean | undefined;
  perspective?: boolean | undefined;
}

const defaultFollowTrackChannels: Required<FollowTrackChannels> = {
  scale: true,
  rotation: true,
  perspective: true
};

export interface SmartFollowTextOptions {
  text: string;
  textColor: string;
  trackingPath: TrackingPathArtifactData;
  smoothing: number;
  depthStrength: number;
  /** Distinguishes multiple simultaneous follow-text layers (e.g. multi-target tracking). Defaults to a single shared track. */
  key?: string | undefined;
  /** Which tracked channels to apply on top of position. Defaults to all enabled (full 3D follow). */
  channels?: FollowTrackChannels | undefined;
  /**
   * Placement of the text relative to the tracked point, in percent of frame
   * (x right, y down). {0,0} = on the point; e.g. {x:0,y:-30} floats it above
   * the tracked point. The text still rides the tracked motion - this only
   * shifts where it sits relative to that point.
   */
  offset?: TimelineVector2 | undefined;
}

export function createMockSubjectAnalysis(input: {
  sourceAssetId?: string | undefined;
  durationSeconds: number;
  frameCount?: number | undefined;
  feather?: number | undefined;
  smoothing?: number | undefined;
}): SubjectAnalysisArtifacts {
  const durationSeconds = Math.max(1, input.durationSeconds);
  const frameCount = Math.max(4, Math.min(input.frameCount ?? 12, 48));
  const bounds = Array.from({ length: frameCount }, (_, index) => {
    const progress = frameCount <= 1 ? 0 : index / (frameCount - 1);
    const timeSeconds = progress * durationSeconds;
    const drift = Math.sin(progress * Math.PI * 2);
    const bob = Math.sin(progress * Math.PI);
    return {
      timeSeconds,
      x: 38 + drift * 5,
      y: 21 + bob * 3,
      width: 25 + bob * 2,
      height: 49 - bob * 3,
      confidence: Number((0.88 + bob * 0.08).toFixed(3))
    };
  });

  const maskSequence: MaskSequenceArtifactData = {
    id: `mask_mock_${Date.now()}`,
    sourceAssetId: input.sourceAssetId,
    width: 360,
    height: 640,
    fps: 8,
    durationSeconds,
    feather: input.feather ?? 8,
    edgeMode: "fast",
    source: "mock",
    frames: bounds.map((item) => ({
      timeSeconds: item.timeSeconds,
      width: 360,
      height: 640,
      previewPath: subjectPathFromBounds(item),
      confidence: item.confidence
    }))
  };

  const trackingPath: TrackingPathArtifactData = {
    id: `track_mock_${Date.now()}`,
    sourceAssetId: input.sourceAssetId,
    durationSeconds,
    smoothing: input.smoothing ?? 0.45,
    source: "mock",
    points: bounds.map((item) => ({
      timeSeconds: item.timeSeconds,
      position: {
        x: item.x + item.width / 2,
        y: item.y + item.height * 0.42
      },
      bounds: item,
      confidence: item.confidence
    }))
  };

  return {
    maskSequence,
    trackingPath,
    subjectBounds: bounds
  };
}

export function trackingPathToPositionKeyframes(
  trackingPath: TrackingPathArtifactData,
  options: {
    layerId: string;
    propertyPrefix?: "transform.position" | undefined;
    smoothing?: number | undefined;
    /**
     * When set, position keyframes follow the track's *motion* relative to its
     * first frame, added on top of this base placement - so the layer keeps the
     * spot the user gave it (e.g. text above the head) while riding the motion
     * of a point tracked elsewhere (e.g. the subject's shoe). When omitted, the
     * keyframes are the absolute tracked positions (text sits on the point).
     */
    basePosition?: TimelineVector2 | undefined;
    /**
     * Prefix for generated keyframe ids. Defaults to `layerId` (the original,
     * single-track-per-layer behavior). Pass a track-specific value (e.g.
     * `${layerId}_track_${trackId}`) when a layer might have more than one saved
     * track attached over time, so re-attaching one saved track only replaces
     * that track's own keyframes and leaves any other attached track alone.
     */
    keyPrefix?: string | undefined;
  }
): TimelineKeyframeV2[] {
  const propertyPrefix = options.propertyPrefix ?? "transform.position";
  const keyPrefix = options.keyPrefix ?? options.layerId;
  const smoothed = smoothTrackingPoints(trackingPath.points, options.smoothing ?? trackingPath.smoothing);
  const points = decimateTrackingPoints(smoothed, trackingPath.durationSeconds);
  const first = points[0]?.position ?? { x: 0, y: 0 };
  const base = options.basePosition ?? first;
  return points.flatMap((point, index) => [
    {
      id: `${keyPrefix}_track_x_${index + 1}`,
      target: {
        scope: "layer" as const,
        property: `${propertyPrefix}.x`
      },
      timeSeconds: point.timeSeconds,
      value: Number((base.x + (point.position.x - first.x)).toFixed(2)),
      interpolation: "linear" as const,
      temporal: {}
    },
    {
      id: `${keyPrefix}_track_y_${index + 1}`,
      target: {
        scope: "layer" as const,
        property: `${propertyPrefix}.y`
      },
      timeSeconds: point.timeSeconds,
      value: Number((base.y + (point.position.y - first.y)).toFixed(2)),
      interpolation: "linear" as const,
      temporal: {}
    }
  ]);
}

/**
 * Mask-tracking variant of {@link trackingPathToPositionKeyframes}: makes a vector mask follow a saved
 * track's motion. Emits `scope:"mask"` keyframes for the mask's own `transform.x`/`transform.y` so the mask
 * shape rides the track. Resolved by every renderer via `resolveMaskAtTime`, so no renderer changes are needed.
 *
 * Unit conversion is the crux: tracking `position` is in **percent of the comp**, but a mask's `transform.x/y`
 * is in **comp pixels**. We follow the track's motion *relative to its first frame* and add it onto the mask's
 * current pixel offset (`basePx`), so the mask keeps where the user drew it and just rides the motion.
 */
export function trackingPathToMaskTransformKeyframes(
  trackingPath: TrackingPathArtifactData,
  options: {
    maskId: string;
    /** The mask's current `transform.x/y` in comp pixels — motion is added on top of this. */
    basePx: TimelineVector2;
    compWidth: number;
    compHeight: number;
    /** Id prefix so re-attaching one track only replaces its own keyframes, e.g. `${layerId}_mask_${maskId}_track_${trackId}`. */
    keyPrefix: string;
    smoothing?: number | undefined;
  }
): TimelineKeyframeV2[] {
  const { maskId, basePx, compWidth, compHeight, keyPrefix } = options;
  const smoothed = smoothTrackingPoints(trackingPath.points, options.smoothing ?? trackingPath.smoothing);
  const points = decimateTrackingPoints(smoothed, trackingPath.durationSeconds);
  const first = points[0]?.position ?? { x: 0, y: 0 };
  return points.flatMap((point, index) => [
    {
      id: `${keyPrefix}_x_${index + 1}`,
      target: { scope: "mask" as const, maskId, property: "transform.x" },
      timeSeconds: point.timeSeconds,
      value: Number((basePx.x + ((point.position.x - first.x) * compWidth) / 100).toFixed(2)),
      interpolation: "linear" as const,
      temporal: {}
    },
    {
      id: `${keyPrefix}_y_${index + 1}`,
      target: { scope: "mask" as const, maskId, property: "transform.y" },
      timeSeconds: point.timeSeconds,
      value: Number((basePx.y + ((point.position.y - first.y) * compHeight) / 100).toFixed(2)),
      interpolation: "linear" as const,
      temporal: {}
    }
  ]);
}

/**
 * Converts a real 3D (planar/homography) tracking path into the full set of
 * transform keyframes: position, scale, in-plane rotation, and perspective
 * tilt (rotateX/rotateY). Channels the tracker didn't populate fall back to
 * identity (scale 1, rotation 0) rather than being omitted, so the layer
 * doesn't jump when only some frames carry 3D data.
 */
export function track3dToTransformKeyframes(
  trackingPath: TrackingPathArtifactData,
  options: {
    layerId: string;
    smoothing?: number | undefined;
    /** Which non-position channels to emit keyframes for. Position always emits. Defaults to all enabled. */
    channels?: FollowTrackChannels | undefined;
  }
): TimelineKeyframeV2[] {
  const channels = { ...defaultFollowTrackChannels, ...options.channels };
  const smoothed = smoothTrackingPoints(trackingPath.points, options.smoothing ?? trackingPath.smoothing);
  const points = decimateTrackingPoints(smoothed, trackingPath.durationSeconds);
  return points.flatMap((point, index) => {
    const keyframes: TimelineKeyframeV2[] = [
      {
        id: `${options.layerId}_track_x_${index + 1}`,
        target: { scope: "layer" as const, property: "transform.position.x" },
        timeSeconds: point.timeSeconds,
        value: Number(point.position.x.toFixed(2)),
        interpolation: "linear" as const,
        temporal: {}
      },
      {
        id: `${options.layerId}_track_y_${index + 1}`,
        target: { scope: "layer" as const, property: "transform.position.y" },
        timeSeconds: point.timeSeconds,
        value: Number(point.position.y.toFixed(2)),
        interpolation: "linear" as const,
        temporal: {}
      }
    ];

    if (channels.scale) {
      keyframes.push({
        id: `${options.layerId}_track_scale_${index + 1}`,
        target: { scope: "layer" as const, property: "transform.scale" },
        timeSeconds: point.timeSeconds,
        value: Number((point.scale ?? 1).toFixed(3)),
        interpolation: "linear" as const,
        temporal: {}
      });
    }

    if (channels.rotation) {
      keyframes.push({
        id: `${options.layerId}_track_rotz_${index + 1}`,
        target: { scope: "layer" as const, property: "transform.rotation" },
        timeSeconds: point.timeSeconds,
        value: Number((point.rotateZ ?? 0).toFixed(2)),
        interpolation: "linear" as const,
        temporal: {}
      });
    }

    if (channels.perspective) {
      keyframes.push(
        {
          id: `${options.layerId}_track_rotx_${index + 1}`,
          target: { scope: "layer" as const, property: "transform.rotateX" },
          timeSeconds: point.timeSeconds,
          value: Number((point.rotateX ?? 0).toFixed(2)),
          interpolation: "linear" as const,
          temporal: {}
        },
        {
          id: `${options.layerId}_track_roty_${index + 1}`,
          target: { scope: "layer" as const, property: "transform.rotateY" },
          timeSeconds: point.timeSeconds,
          value: Number((point.rotateY ?? 0).toFixed(2)),
          interpolation: "linear" as const,
          temporal: {}
        }
      );
    }

    return keyframes;
  });
}

export function applyTextBehindPersonComposition(
  composition: TimelineComposition,
  options: TextBehindPersonOptions
): TimelineComposition {
  const duration = composition.durationSeconds;
  const trackBackgroundId = `${composition.id}_tbp_background`;
  const trackTextId = `${composition.id}_tbp_text`;
  const trackSubjectId = `${composition.id}_tbp_subject`;
  const sourceAssetId = options.sourceAssetId ?? findFirstVisualAssetId(composition);
  const backgroundLayer = createVisualLayer({
    id: `${trackBackgroundId}_layer`,
    trackId: trackBackgroundId,
    name: "Background plate",
    assetId: sourceAssetId,
    durationSeconds: duration,
    opacity: 92,
    effects: [
      effect(`${trackBackgroundId}_grade`, "brightnessContrast", "Background depth", 32, {
        brightness: -8,
        contrast: 10,
        saturation: 96
      }),
      effect(`${trackBackgroundId}_blur`, "blur", "Soft background", 12, {
        radius: 1.8
      })
    ]
  });
  const textLayer = createTextLayer({
    id: `${trackTextId}_layer`,
    trackId: trackTextId,
    name: "Behind subject text",
    text: options.text,
    color: options.textColor,
    durationSeconds: duration
  });
  const subjectLayer = createVisualLayer({
    id: `${trackSubjectId}_layer`,
    trackId: trackSubjectId,
    name: "Masked subject foreground",
    assetId: sourceAssetId,
    durationSeconds: duration,
    opacity: 100,
    effects: [
      effect(`${trackSubjectId}_mask_preview`, "shadow", "Mock mask edge", 28, {
        color: "#C9FF4A",
        blur: 6,
        x: 0,
        y: 0
      })
    ]
  });

  return {
    ...composition,
    tracks: [
      {
        id: trackSubjectId,
        type: "video",
        name: "Subject cutout",
        layers: [withMaskMetadata(subjectLayer, options.maskId, "foreground", options.mask)]
      },
      {
        id: trackTextId,
        type: "video",
        name: "Behind text",
        layers: [textLayer]
      },
      {
        id: trackBackgroundId,
        type: "video",
        name: "Background",
        layers: [backgroundLayer]
      }
      // Intentionally not preserving the incoming composition's other tracks -
      // applying a composite tool replaces the default-preset/template result
      // (e.g. createProject's hook/CTA placeholder text) rather than layering
      // on top of it, since that placeholder content isn't meaningful once a
      // real composite exists.
    ]
  };
}

export interface ExtractPersonApplyOptions {
  mask: MaskSequenceArtifactData;
  sourceAssetId?: string | undefined;
}

/**
 * Places the extracted subject directly on the timeline as a single masked
 * video layer. Unlike the composite tools below, this is the "just show me my
 * cutout" result for Extract Person itself - it replaces whatever tracks were
 * on the incoming composition (e.g. the generic default-preset hook/CTA
 * template `createProject` builds) rather than layering on top of them, since
 * none of that placeholder content is meaningful once a real mask exists.
 */
export function applyExtractPersonComposition(
  composition: TimelineComposition,
  options: ExtractPersonApplyOptions,
  mode: "replace" | "insert" = "replace"
): TimelineComposition {
  const duration = Math.max(composition.durationSeconds, options.mask.durationSeconds);
  const trackId = `${composition.id}_extracted_subject`;
  const sourceAssetId = options.sourceAssetId ?? options.mask.sourceAssetId ?? findFirstVisualAssetId(composition);
  const subjectLayer = createVisualLayer({
    id: `${trackId}_layer`,
    trackId,
    name: "Extracted person",
    assetId: sourceAssetId,
    durationSeconds: duration,
    opacity: 100
  });
  const subjectTrack = {
    id: trackId,
    type: "video" as const,
    name: "Extracted person",
    layers: [withMaskMetadata(subjectLayer, options.mask.id, "extract", options.mask)]
  };

  return {
    ...composition,
    durationSeconds: duration,
    tracks:
      mode === "insert"
        ? [subjectTrack, ...composition.tracks.filter((track) => track.id !== trackId)]
        : [subjectTrack]
  };
}

export function applyRemoveBackgroundComposition(
  composition: TimelineComposition,
  options: RemoveBackgroundOptions
): TimelineComposition {
  const duration = composition.durationSeconds;
  const trackSubjectId = `${composition.id}_rbg_subject`;
  const trackPlateId = `${composition.id}_rbg_plate`;
  const sourceAssetId = options.sourceAssetId ?? findFirstVisualAssetId(composition);
  const subjectLayer = createVisualLayer({
    id: `${trackSubjectId}_layer`,
    trackId: trackSubjectId,
    name: options.mode === "greenScreen" ? "Green-screen subject" : "Transparent subject",
    assetId: sourceAssetId,
    durationSeconds: duration,
    opacity: 100,
    effects: [
      effect(`${trackSubjectId}_edge`, "shadow", "Mock matte edge", 18, {
        color: "#C9FF4A",
        blur: 5,
        x: 0,
        y: 0
      })
    ]
  });
  const plateLayer: TimelineLayer =
    options.mode === "greenScreen"
      ? createShapeLayer({
          id: `${trackPlateId}_green`,
          trackId: trackPlateId,
          name: "Green screen plate",
          color: "#00B140",
          durationSeconds: duration
        })
      : createShapeLayer({
          id: `${trackPlateId}_checker`,
          trackId: trackPlateId,
          name: "Transparent preview plate",
          color: "#1F222A",
          durationSeconds: duration
        });

  return {
    ...composition,
    tracks: [
      {
        id: trackSubjectId,
        type: "video",
        name: "Removed background",
        layers: [withMaskMetadata(subjectLayer, options.maskId, options.mode, options.mask)]
      },
      {
        id: trackPlateId,
        type: "video",
        name: options.mode === "greenScreen" ? "Green screen" : "Transparency preview",
        layers: [plateLayer]
      }
      // See applyTextBehindPersonComposition for why incoming tracks aren't preserved.
    ]
  };
}

export interface RemovePersonApplyOptions {
  /** Full-frame inpainted clip (subject removed, background reconstructed). */
  inpaintedAssetId?: string | undefined;
  inpaintedUri?: string | undefined;
  durationSeconds?: number | undefined;
  sourceAssetId?: string | undefined;
}

/**
 * Places the person-removed result on the timeline as a single plain video layer
 * pointing at the inpainted clip. Because the inpainted frame is already the
 * finished image, the layer carries no `matte` - it renders like any ordinary
 * video, so web preview and Remotion stay in parity with zero new compositor
 * code. The selection mask/tracking is kept on the project's editableFields
 * (by the caller) so the removal stays re-editable. Like the other composite
 * tools, this replaces the incoming placeholder tracks.
 */
export function applyRemovePersonComposition(
  composition: TimelineComposition,
  options: RemovePersonApplyOptions
): TimelineComposition {
  const duration = Math.max(composition.durationSeconds, options.durationSeconds ?? 0);
  const trackId = `${composition.id}_person_removed`;
  const assetId = options.inpaintedAssetId ?? options.sourceAssetId ?? findFirstVisualAssetId(composition);
  const removedLayer = createVisualLayer({
    id: `${trackId}_layer`,
    trackId,
    name: "Person removed",
    assetId,
    durationSeconds: duration,
    opacity: 100
  });

  return {
    ...composition,
    durationSeconds: duration,
    tracks: [
      {
        id: trackId,
        type: "video",
        name: "Person removed",
        layers: [removedLayer]
      }
      // See applyTextBehindPersonComposition for why incoming tracks aren't preserved.
    ]
  };
}

export function applySmartFollowTextComposition(
  composition: TimelineComposition,
  options: SmartFollowTextOptions
): TimelineComposition {
  const duration = composition.durationSeconds;
  const trackId = `${composition.id}_follow_text${options.key ? `_${options.key}` : ""}`;
  const layerId = `${trackId}_layer`;
  const channels = { ...defaultFollowTrackChannels, ...options.channels };
  const is3d = Boolean(options.trackingPath.is3d);
  const followsScale = is3d && channels.scale;
  const followsRotation = is3d && channels.rotation;
  const followsPerspective = is3d && channels.perspective;
  // 2.5D fallback: when the track has no real rotation/scale data (or the
  // user turned the scale channel off), keep a cosmetic scale pulse driven by
  // depthStrength so the text still feels alive.
  const scalePulse = followsScale ? 0 : Math.max(0, Math.min(0.35, options.depthStrength * 0.18));
  const hasPerspectiveTilt =
    followsPerspective && options.trackingPath.points.some((point) => Math.abs(point.rotateX ?? 0) > 0.5 || Math.abs(point.rotateY ?? 0) > 0.5);

  // Decouple where the text sits (base placement) from the point it follows:
  // base = the tracked first point shifted by the user's offset, so e.g. the
  // text can float above the head while tracking the shoe. offset {0,0} keeps
  // it on the point (original behavior).
  const firstPoint = options.trackingPath.points[0]?.position ?? { x: 50, y: 50 };
  const offset = options.offset ?? { x: 0, y: 0 };
  const basePosition = { x: firstPoint.x + offset.x, y: firstPoint.y + offset.y };

  const textLayer: TimelineLayer = {
    ...createTextLayer({
      id: layerId,
      trackId,
      name: "Smart follow text",
      text: options.text,
      color: options.textColor,
      durationSeconds: duration
    }),
    fontSize: 74,
    textWidthPercent: 64,
    backgroundColor: "transparent",
    transform: {
      position: { x: basePosition.x, y: basePosition.y },
      scale: followsScale ? (options.trackingPath.points[0]?.scale ?? 1) : 1,
      rotation: followsRotation ? (options.trackingPath.points[0]?.rotateZ ?? 0) : 0,
      opacity: 100,
      rotateX: followsPerspective ? (options.trackingPath.points[0]?.rotateX ?? 0) : 0,
      rotateY: followsPerspective ? (options.trackingPath.points[0]?.rotateY ?? 0) : 0,
      perspective: hasPerspectiveTilt ? 900 : 0
    },
    effects: [
      effect(`${layerId}_depth_shadow`, "shadow", "Depth shadow", 52, {
        color: "#000000",
        blur: 18,
        x: 0,
        y: Math.round(8 + options.depthStrength * 10)
      }),
      effect(`${layerId}_motion_blur`, "motionBlur", "Follow softness", Math.round(options.depthStrength * 30), {
        amount: options.depthStrength
      })
    ],
    animations: is3d
      ? track3dToTransformKeyframes(options.trackingPath, {
          layerId,
          smoothing: options.smoothing,
          channels
        })
      : [
          ...trackingPathToPositionKeyframes(options.trackingPath, {
            layerId,
            smoothing: options.smoothing,
            basePosition
          }),
          ...(channels.scale
            ? [
                {
                  id: `${layerId}_scale_1`,
                  target: { scope: "layer" as const, property: "transform.scale" },
                  timeSeconds: 0,
                  value: 1,
                  interpolation: "easeInOut" as const,
                  temporal: {}
                },
                {
                  id: `${layerId}_scale_2`,
                  target: { scope: "layer" as const, property: "transform.scale" },
                  timeSeconds: duration * 0.5,
                  value: Number((1 + scalePulse).toFixed(3)),
                  interpolation: "easeInOut" as const,
                  temporal: {}
                },
                {
                  id: `${layerId}_scale_3`,
                  target: { scope: "layer" as const, property: "transform.scale" },
                  timeSeconds: duration,
                  value: 1,
                  interpolation: "easeInOut" as const,
                  temporal: {}
                }
              ]
            : [])
        ]
  };

  return {
    ...composition,
    tracks: [
      {
        id: trackId,
        type: "video",
        name: "Follow text",
        layers: [textLayer]
      },
      // Drop the default project's placeholder Hook/CTA caption track ("Your
      // next reel starts here" / "Save this idea") - nobody asked for that
      // text once a real follow-text layer exists. Keep the main video/audio
      // tracks (so the source clip stays visible/audible) and any other
      // follow-text tracks already added by a prior call in a multi-target
      // apply chain.
      ...composition.tracks.filter((track) => track.id !== trackId && !track.id.endsWith("_track_text"))
    ]
  };
}

export interface StabilizeSubjectOptions {
  trackingPath: TrackingPathArtifactData;
  smoothing: number;
  sourceAssetId?: string | undefined;
  /** 0 = no correction, 1 = fully cancel the tracked motion (subject held locked to its first-frame pose). */
  strength: number;
}

/**
 * Reuses the same planar track as Smart Follow Text, but applies the inverse
 * transform to the source subject layer itself instead of a text layer - this
 * is the "hold the subject steady" counterpart (After Effects Warp
 * Stabilizer-style), not a new tracking engine.
 */
export function applyStabilizationComposition(
  composition: TimelineComposition,
  options: StabilizeSubjectOptions
): TimelineComposition {
  const duration = composition.durationSeconds;
  const trackId = `${composition.id}_stabilized_subject`;
  const layerId = `${trackId}_layer`;
  const sourceAssetId = options.sourceAssetId ?? findFirstVisualAssetId(composition);
  const smoothed = smoothTrackingPoints(options.trackingPath.points, options.smoothing ?? options.trackingPath.smoothing);
  const points = decimateTrackingPoints(smoothed, options.trackingPath.durationSeconds);
  const first = points[0];
  const strength = Math.max(0, Math.min(1, options.strength));

  const subjectLayer: TimelineLayer = {
    ...createVisualLayer({
      id: layerId,
      trackId,
      name: "Stabilized subject",
      assetId: sourceAssetId,
      durationSeconds: duration,
      opacity: 100
    }),
    animations: first
      ? points.flatMap((point, index) => {
          const dx = (first.position.x - point.position.x) * strength;
          const dy = (first.position.y - point.position.y) * strength;
          const counterScale = 1 + (1 - (point.scale ?? 1)) * strength;
          const counterRotateZ = -(point.rotateZ ?? 0) * strength;
          const counterRotateX = -(point.rotateX ?? 0) * strength;
          const counterRotateY = -(point.rotateY ?? 0) * strength;
          return [
            {
              id: `${layerId}_stab_x_${index + 1}`,
              target: { scope: "layer" as const, property: "transform.position.x" },
              timeSeconds: point.timeSeconds,
              value: Number((50 + dx).toFixed(2)),
              interpolation: "linear" as const,
              temporal: {}
            },
            {
              id: `${layerId}_stab_y_${index + 1}`,
              target: { scope: "layer" as const, property: "transform.position.y" },
              timeSeconds: point.timeSeconds,
              value: Number((50 + dy).toFixed(2)),
              interpolation: "linear" as const,
              temporal: {}
            },
            {
              id: `${layerId}_stab_scale_${index + 1}`,
              target: { scope: "layer" as const, property: "transform.scale" },
              timeSeconds: point.timeSeconds,
              value: Number(counterScale.toFixed(3)),
              interpolation: "linear" as const,
              temporal: {}
            },
            {
              id: `${layerId}_stab_rotz_${index + 1}`,
              target: { scope: "layer" as const, property: "transform.rotation" },
              timeSeconds: point.timeSeconds,
              value: Number(counterRotateZ.toFixed(2)),
              interpolation: "linear" as const,
              temporal: {}
            },
            {
              id: `${layerId}_stab_rotx_${index + 1}`,
              target: { scope: "layer" as const, property: "transform.rotateX" },
              timeSeconds: point.timeSeconds,
              value: Number(counterRotateX.toFixed(2)),
              interpolation: "linear" as const,
              temporal: {}
            },
            {
              id: `${layerId}_stab_roty_${index + 1}`,
              target: { scope: "layer" as const, property: "transform.rotateY" },
              timeSeconds: point.timeSeconds,
              value: Number(counterRotateY.toFixed(2)),
              interpolation: "linear" as const,
              temporal: {}
            }
          ];
        })
      : []
  };

  return {
    ...composition,
    tracks: [
      {
        id: trackId,
        type: "video",
        name: "Stabilized subject",
        layers: [subjectLayer]
      },
      // See applySmartFollowTextComposition for why the default placeholder
      // Hook/CTA caption track is dropped here too.
      ...composition.tracks.filter((track) => track.id !== trackId && !track.id.endsWith("_track_text"))
    ]
  };
}

export function smoothTrackingPoints(points: TrackingPoint[], smoothing: number): TrackingPoint[] {
  const amount = Math.max(0, Math.min(0.95, smoothing));
  if (points.length < 3 || amount <= 0) {
    return points;
  }

  const smoothChannel = (value: number | undefined, previous: number | undefined, next: number | undefined, fallback: number) => {
    const v = value ?? fallback;
    const p = previous ?? fallback;
    const n = next ?? fallback;
    return v * (1 - amount) + ((p + n) / 2) * amount;
  };

  return points.map((point, index) => {
    const previous = points[Math.max(0, index - 1)] ?? point;
    const next = points[Math.min(points.length - 1, index + 1)] ?? point;
    return {
      ...point,
      position: {
        x: point.position.x * (1 - amount) + ((previous.position.x + next.position.x) / 2) * amount,
        y: point.position.y * (1 - amount) + ((previous.position.y + next.position.y) / 2) * amount
      },
      scale: smoothChannel(point.scale, previous.scale, next.scale, 1),
      rotateZ: smoothChannel(point.rotateZ, previous.rotateZ, next.rotateZ, 0),
      rotateX: smoothChannel(point.rotateX, previous.rotateX, next.rotateX, 0),
      rotateY: smoothChannel(point.rotateY, previous.rotateY, next.rotateY, 0)
    };
  });
}

export interface TrackCleanupOptions {
  /** Base low-pass strength applied to every frame, 0..1. Defaults to 0.5. */
  smoothing?: number | undefined;
  /** How hard to pull frames onto the dominant line when the path is recognised as near-straight, 0..1. Defaults to 0.8. */
  straightenStrength?: number | undefined;
}

export interface TrackCleanupDiagnostics {
  pointCount: number;
  /** 0..1 where 1 = perfectly straight-line motion (from PCA of the path). */
  linearity: number;
  /** Number of jump/outlier frames that were replaced by neighbour interpolation. */
  outliersFixed: number;
  /** True when the path was straight enough that perpendicular jitter was actively suppressed. */
  straightened: boolean;
  /** Mean per-frame position correction, in percent-of-frame units (how far the cleaned path moved). */
  averageCorrection: number;
}

export interface TrackCleanupResult {
  points: TrackingPoint[];
  diagnostics: TrackCleanupDiagnostics;
}

/** Below this PCA linearity the motion is treated as a genuine curve and left to plain smoothing (no straightening). */
const STRAIGHTEN_LINEARITY_GATE = 0.86;
/** At/above this linearity, straightening is applied at full `straightenStrength`; it ramps in from the gate. */
const STRAIGHTEN_LINEARITY_FULL = 0.985;
const CLEANUP_SMOOTH_PASSES = 2;

function median(values: number[]): number {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  }
  return sorted[mid] ?? 0;
}

/**
 * Analyses a tracked path and corrects it: rejects jump/outlier frames (where the
 * tracker briefly lost lock and snapped onto the wrong feature), low-pass smooths the
 * rest with low-confidence frames pulled harder toward the trajectory, and - crucially -
 * recognises when the subject is moving in a near-straight line and suppresses the
 * sideways jitter toward that line so the text doesn't wobble/distort. A genuinely
 * curved path (low PCA linearity) is left to plain smoothing, never flattened.
 *
 * Pure and deterministic so it can be unit-asserted and reused by both the tool panel
 * and the editor's attach-to-layer flow. Operates in the same percent-of-frame units
 * the points are stored in.
 */
export function cleanTrackingPoints(points: TrackingPoint[], options: TrackCleanupOptions = {}): TrackCleanupResult {
  const baseSmoothing = Math.max(0, Math.min(0.95, options.smoothing ?? 0.5));
  const straightenStrength = Math.max(0, Math.min(1, options.straightenStrength ?? 0.8));

  if (points.length < 4) {
    return {
      points,
      diagnostics: { pointCount: points.length, linearity: 1, outliersFixed: 0, straightened: false, averageCorrection: 0 }
    };
  }

  const originalX = points.map((point) => point.position.x);
  const originalY = points.map((point) => point.position.y);
  const xs = [...originalX];
  const ys = [...originalY];
  const n = points.length;

  // --- Stage 1: robust outlier rejection ---------------------------------
  // A spike is a frame that sits far from the local windowed median of the
  // path. The median (not a neighbour average) is used so a single bad frame
  // doesn't make its two clean neighbours look like outliers too. The trigger
  // distance is scaled by a robust (median/MAD) estimate of the normal
  // per-frame step, so a fast-but-clean track isn't mistaken for noise.
  const steps: number[] = [];
  for (let i = 1; i < n; i += 1) {
    steps.push(Math.hypot((originalX[i] ?? 0) - (originalX[i - 1] ?? 0), (originalY[i] ?? 0) - (originalY[i - 1] ?? 0)));
  }
  const medStep = median(steps);
  const madStep = median(steps.map((step) => Math.abs(step - medStep)));
  const robustScale = 1.4826 * madStep;
  const jumpThreshold = medStep + Math.max(1.5, 4 * robustScale);

  let outliersFixed = 0;
  for (let i = 1; i < n - 1; i += 1) {
    const medX = median([originalX[i - 1] ?? 0, originalX[i] ?? 0, originalX[i + 1] ?? 0]);
    const medY = median([originalY[i - 1] ?? 0, originalY[i] ?? 0, originalY[i + 1] ?? 0]);
    const deviation = Math.hypot((originalX[i] ?? 0) - medX, (originalY[i] ?? 0) - medY);
    const lowConfidence = (points[i]?.confidence ?? 1) < 0.75;
    if (deviation > jumpThreshold && (lowConfidence || deviation > jumpThreshold * 2)) {
      xs[i] = medX;
      ys[i] = medY;
      outliersFixed += 1;
    }
  }

  // --- Stage 2: confidence-weighted multi-pass smoothing ------------------
  for (let pass = 0; pass < CLEANUP_SMOOTH_PASSES; pass += 1) {
    const prevX = [...xs];
    const prevY = [...ys];
    for (let i = 1; i < n - 1; i += 1) {
      // Less-confident frames are trusted less and pulled harder to the mean.
      const amount = Math.min(0.95, baseSmoothing + (1 - (points[i]?.confidence ?? 1)) * 0.3);
      const neighbourX = ((prevX[i - 1] ?? 0) + (prevX[i + 1] ?? 0)) / 2;
      const neighbourY = ((prevY[i - 1] ?? 0) + (prevY[i + 1] ?? 0)) / 2;
      xs[i] = (prevX[i] ?? 0) * (1 - amount) + neighbourX * amount;
      ys[i] = (prevY[i] ?? 0) * (1 - amount) + neighbourY * amount;
    }
  }

  // --- Stage 3: straight-path recognition + de-jitter --------------------
  // PCA of the cleaned path: the ratio of minor to major variance tells us how
  // 1-dimensional (straight) the motion is. Straight => suppress perpendicular
  // wobble toward the dominant axis; curved => leave it to the smoothing above.
  let meanX = 0;
  let meanY = 0;
  for (let i = 0; i < n; i += 1) {
    meanX += xs[i] ?? 0;
    meanY += ys[i] ?? 0;
  }
  meanX /= n;
  meanY /= n;

  let cxx = 0;
  let cyy = 0;
  let cxy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = (xs[i] ?? 0) - meanX;
    const dy = (ys[i] ?? 0) - meanY;
    cxx += dx * dx;
    cyy += dy * dy;
    cxy += dx * dy;
  }
  cxx /= n;
  cyy /= n;
  cxy /= n;

  const trace = cxx + cyy;
  const disc = Math.sqrt(Math.max(0, (trace * trace) / 4 - (cxx * cyy - cxy * cxy)));
  const lambdaMajor = trace / 2 + disc;
  const lambdaMinor = trace / 2 - disc;
  const linearity = lambdaMajor > 1e-6 ? 1 - lambdaMinor / lambdaMajor : 1;

  // Principal-axis unit vector (eigenvector of the major eigenvalue).
  let axisX = cxy;
  let axisY = lambdaMajor - cxx;
  if (Math.abs(axisX) < 1e-9 && Math.abs(axisY) < 1e-9) {
    // Degenerate covariance: fall back to whichever raw axis has more spread.
    axisX = cxx >= cyy ? 1 : 0;
    axisY = cxx >= cyy ? 0 : 1;
  }
  const axisLen = Math.hypot(axisX, axisY) || 1;
  axisX /= axisLen;
  axisY /= axisLen;

  // Signed perpendicular deviation of each point from the principal line. The
  // sign tells us which side of the line the point sits on. Jitter flips sides
  // frame to frame (high sign-change ratio); a genuine curve bulges to one side
  // and keeps the same sign. That oscillation - not raw linearity - is what
  // distinguishes "straight walk with wobble" (straighten it) from "real arc"
  // (leave it). A quarter-circle is fairly linear by PCA yet must not be flattened.
  const perp: number[] = new Array(n);
  let perpEnergy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = (xs[i] ?? 0) - meanX;
    const dy = (ys[i] ?? 0) - meanY;
    // Cross product magnitude = signed distance off the axis.
    perp[i] = dx * axisY - dy * axisX;
    perpEnergy += Math.abs(perp[i] ?? 0);
  }
  // Count how many times the deviation crosses the line (changes side), ignoring
  // tiny residuals. A genuine curve bulges to one side: 0-1 crossings. A straight
  // path with wobble/drift visits both sides repeatedly: many crossings. Using the
  // crossing COUNT (not the adjacent-flip ratio) means a slow multi-cycle drift -
  // which has long same-sign runs - still reads as oscillatory, while a single
  // intentional S-bend (1 crossing) is left untouched.
  const perpEpsilon = (perpEnergy / n) * 0.25;
  let signChanges = 0;
  let prevSign = 0;
  for (let i = 0; i < n; i += 1) {
    const value = perp[i] ?? 0;
    if (Math.abs(value) < perpEpsilon) {
      continue;
    }
    const sign = value > 0 ? 1 : -1;
    if (prevSign !== 0 && sign !== prevSign) {
      signChanges += 1;
    }
    prevSign = sign;
  }

  // Need both: the path must be roughly linear (a meaningful "line" exists) AND
  // the deviations must oscillate across the line (jitter/drift, not curvature).
  const oscillationRamp = Math.max(0, Math.min(1, (signChanges - 2) / (6 - 2)));
  const linearityRamp = Math.max(0, Math.min(1, (linearity - STRAIGHTEN_LINEARITY_GATE) / (STRAIGHTEN_LINEARITY_FULL - STRAIGHTEN_LINEARITY_GATE)));
  const straightenFactor = straightenStrength * oscillationRamp * (linearity >= 0.6 ? 1 : 0) * (0.4 + 0.6 * linearityRamp);
  const straightened = straightenFactor > 0.01;

  if (straightened) {
    for (let i = 0; i < n; i += 1) {
      const dx = (xs[i] ?? 0) - meanX;
      const dy = (ys[i] ?? 0) - meanY;
      const along = dx * axisX + dy * axisY;
      // Foot of the perpendicular onto the line; pulling toward it removes only
      // the sideways (perpendicular) component, never the along-track progress.
      const footX = meanX + along * axisX;
      const footY = meanY + along * axisY;
      xs[i] = (xs[i] ?? 0) + (footX - (xs[i] ?? 0)) * straightenFactor;
      ys[i] = (ys[i] ?? 0) + (footY - (ys[i] ?? 0)) * straightenFactor;
    }
  }

  // --- Rebuild points, keeping the visual box centred on the cleaned point.
  let totalCorrection = 0;
  const cleaned = points.map((point, i) => {
    const newX = xs[i] ?? point.position.x;
    const newY = ys[i] ?? point.position.y;
    totalCorrection += Math.hypot(newX - (originalX[i] ?? newX), newY - (originalY[i] ?? newY));
    const dx = newX - point.position.x;
    const dy = newY - point.position.y;
    return {
      ...point,
      position: { x: Number(newX.toFixed(3)), y: Number(newY.toFixed(3)) },
      bounds: { ...point.bounds, x: point.bounds.x + dx, y: point.bounds.y + dy }
    };
  });

  return {
    points: cleaned,
    diagnostics: {
      pointCount: n,
      linearity: Number(linearity.toFixed(3)),
      outliersFixed,
      straightened,
      averageCorrection: Number((totalCorrection / n).toFixed(3))
    }
  };
}

/** Caps keyframe density so generated tracks stay editable (hand-draggable in the timeline) instead of one keyframe per tracked frame. */
const MAX_TRACK_KEYFRAMES_PER_SECOND = 4;

export function decimateTrackingPoints(points: TrackingPoint[], durationSeconds: number): TrackingPoint[] {
  const maxCount = Math.max(2, Math.round(durationSeconds * MAX_TRACK_KEYFRAMES_PER_SECOND));
  if (points.length <= maxCount) {
    return points;
  }

  const step = (points.length - 1) / (maxCount - 1);
  const result: TrackingPoint[] = [];
  for (let index = 0; index < maxCount; index += 1) {
    const sourceIndex = Math.round(index * step);
    const point = points[Math.min(points.length - 1, sourceIndex)];
    if (point) {
      result.push(point);
    }
  }
  return result;
}

function subjectPathFromBounds(bounds: SubjectBounds) {
  const cx = bounds.x + bounds.width / 2;
  const top = bounds.y;
  const shoulderY = bounds.y + bounds.height * 0.26;
  const hipY = bounds.y + bounds.height * 0.72;
  const bottom = bounds.y + bounds.height;
  const halfHead = bounds.width * 0.22;
  const halfShoulder = bounds.width * 0.5;
  const halfHip = bounds.width * 0.38;
  return [
    `M ${cx} ${top}`,
    `C ${cx + halfHead} ${top} ${cx + halfHead} ${shoulderY - 4} ${cx + halfShoulder} ${shoulderY}`,
    `C ${cx + halfShoulder} ${hipY} ${cx + halfHip} ${bottom} ${cx} ${bottom}`,
    `C ${cx - halfHip} ${bottom} ${cx - halfShoulder} ${hipY} ${cx - halfShoulder} ${shoulderY}`,
    `C ${cx - halfHead} ${shoulderY - 4} ${cx - halfHead} ${top} ${cx} ${top}`,
    "Z"
  ].join(" ");
}

function createVisualLayer(input: {
  id: string;
  trackId: string;
  name: string;
  assetId?: string | undefined;
  durationSeconds: number;
  opacity: number;
  effects?: TimelineEffect[] | undefined;
}): TimelineLayer {
  return {
    id: input.id,
    trackId: input.trackId,
    type: "video",
    name: input.name,
    startSeconds: 0,
    durationSeconds: input.durationSeconds,
    assetId: input.assetId,
    fit: "cover",
    transform: {
      position: { x: 50, y: 50 },
      scale: 1,
      rotation: 0,
      opacity: input.opacity
    },
    effects: input.effects ?? [],
    keyframes: [],
    animations: []
  };
}

function createTextLayer(input: {
  id: string;
  trackId: string;
  name: string;
  text: string;
  color: string;
  durationSeconds: number;
}): TimelineLayer {
  return {
    id: input.id,
    trackId: input.trackId,
    type: "text",
    name: input.name,
    text: input.text,
    startSeconds: 0,
    durationSeconds: input.durationSeconds,
    fontFamily: "Arial",
    fontSize: 118,
    textWidthPercent: 86,
    textAlign: "center",
    color: input.color,
    strokeColor: "#050608",
    strokeWidth: 4,
    shadowColor: "#000000",
    shadowBlur: 14,
    shadowOffsetX: 0,
    shadowOffsetY: 7,
    transform: {
      position: { x: 50, y: 48 },
      scale: 1,
      rotation: 0,
      opacity: 100
    },
    effects: [],
    keyframes: [],
    animations: [
      {
        id: `${input.id}_scale_in`,
        target: { scope: "layer", property: "transform.scale" },
        timeSeconds: 0,
        value: 0.92,
        interpolation: "easeOut",
        temporal: {}
      },
      {
        id: `${input.id}_scale_hold`,
        target: { scope: "layer", property: "transform.scale" },
        timeSeconds: 0.25,
        value: 1,
        interpolation: "easeOut",
        temporal: {}
      }
    ]
  };
}

function createShapeLayer(input: {
  id: string;
  trackId: string;
  name: string;
  color: string;
  durationSeconds: number;
}): TimelineLayer {
  return {
    id: input.id,
    trackId: input.trackId,
    type: "shape",
    name: input.name,
    startSeconds: 0,
    durationSeconds: input.durationSeconds,
    widthPercent: 100,
    heightPercent: 100,
    borderRadius: 0,
    color: input.color,
    transform: {
      position: { x: 50, y: 50 },
      scale: 1,
      rotation: 0,
      opacity: 100
    },
    effects: [],
    keyframes: [],
    animations: []
  };
}

function withMaskMetadata(
  layer: TimelineLayer,
  maskId: string,
  mode: string,
  mask?: MaskSequenceArtifactData | undefined,
  invert?: boolean | undefined
): TimelineLayer {
  const matte = mask ? createMatteRefFromMaskSequence(mask, { invert }) : undefined;
  if (matte) {
    return { ...layer, matte };
  }

  // No baked matte yet (e.g. a mock run, or Extract Person hasn't applied) -
  // keep the disabled placeholder so the layer stays inspectable/traceable
  // until a real mask is generated and this composition is reapplied.
  return {
    ...layer,
    effects: [
      ...layer.effects,
      effect(`${layer.id}_mask_metadata`, "chromaKey", "Mask artifact reference", 0, {
        maskId,
        mode,
        enabled: false
      })
    ]
  };
}

function effect(
  id: string,
  type: TimelineEffect["type"],
  name: string,
  intensity: number,
  params?: TimelineEffect["params"]
): TimelineEffect {
  return {
    id,
    type,
    name,
    enabled: true,
    intensity,
    params
  };
}

function findFirstVisualAssetId(composition: TimelineComposition) {
  return composition.tracks.flatMap((track) => track.layers).find((layer) => layer.type === "video" || layer.type === "image")?.assetId;
}
