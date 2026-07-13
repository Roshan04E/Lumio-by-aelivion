/**
 * Effects-tab catalog: the single, lightweight source that powers the categorized
 * (Video / Text / Audio / Transition / AI) dropdown. It only assembles *descriptors* from the
 * existing registries — timeline effects + AI tools ([@kimera-by-aelivion/shared]) and animation presets —
 * so importing it pulls no effect-control UI, no ML handlers, and no renderer code. The actual
 * implementations load lazily when an item is added/run (see EditorPage handlers + lazy modals).
 */
import {
  createManifestTransitionProvider,
  listEffectLibrary,
  listLookLibrary,
  listTransitionLibrary,
  toolCapabilityDefinitions,
  resolveEffectManifest,
  resolveLookManifest,
  type PluginLookManifest,
  type PluginEffectManifest,
  type PluginTransitionManifest,
  type TimelineEffectDefinition,
  type TimelineEffectType,
  type TimelineLayerType,
  type ToolInputType,
  type TransitionDirection,
  type TransitionKind
} from "@kimera-by-aelivion/shared";
import { animationPresets } from "../inspector/keyframeUtils";
import { READY_TOOL_SLUGS } from "../../tools/ready-tool-slugs";

export type EffectPanelCategory = "uploaded" | "video" | "text" | "audio" | "look" | "transition" | "ai";

export const effectPanelCategories: { id: EffectPanelCategory; label: string }[] = [
  { id: "uploaded", label: "Uploaded Effects" },
  { id: "video", label: "Video" },
  { id: "text", label: "Text" },
  { id: "audio", label: "Audio" },
  { id: "look", label: "Looks" },
  { id: "transition", label: "Transition" },
  { id: "ai", label: "AI" }
];

/**
 * Industry-standard transition gallery categories (the "Show more" gallery groups by these). Order here is
 * the order chips + sections render in. Chosen for how a creator reaches for a transition (Essentials, a
 * Zoom, a Whip, a Reveal, a Glitch, …) rather than implementation buckets.
 */
export type TransitionGroup =
  | "uploaded"
  | "essentials"
  | "slide-push"
  | "zoom-spin"
  | "whip-blur"
  | "reveals"
  | "glitch"
  | "cinematic"
  | "impact";

export const transitionGalleryCategories: { id: TransitionGroup; label: string }[] = [
  { id: "uploaded", label: "Uploaded" },
  { id: "essentials", label: "Essentials" },
  { id: "slide-push", label: "Slide & Push" },
  { id: "zoom-spin", label: "Zoom & Spin" },
  { id: "whip-blur", label: "Whip & Blur" },
  { id: "reveals", label: "Wipes & Reveals" },
  { id: "glitch", label: "Glitch" },
  { id: "cinematic", label: "Cinematic" },
  { id: "impact", label: "Impact" }
];

export interface BuildEffectCatalogOptions {
  effectManifests?: PluginEffectManifest[] | undefined;
  lookManifests?: PluginLookManifest[] | undefined;
  transitionManifests?: PluginTransitionManifest[] | undefined;
}

export type LookGroup = "uploaded" | "cinematic" | "film" | "clean" | "vintage" | "creator";

export interface LookPreviewStyle {
  filter: string;
  overlay: string;
  opacity: number;
}

export const lookGalleryCategories: { id: LookGroup; label: string }[] = [
  { id: "uploaded", label: "Uploaded Looks" },
  { id: "cinematic", label: "Cinematic" },
  { id: "film", label: "Film" },
  { id: "clean", label: "Clean" },
  { id: "vintage", label: "Vintage" },
  { id: "creator", label: "Creator Packs" }
];

/** A single addable catalog entry; `kind` selects which EditorPage handler runs on add. */
export type CatalogItem =
  | { kind: "effect"; id: string; label: string; description: string; effectType: TimelineEffectType; draggable: true }
  | {
      kind: "effectManifest";
      id: string;
      label: string;
      description: string;
      manifest: PluginEffectManifest;
      effectType: TimelineEffectType;
      draggable: false;
    }
  | { kind: "audio"; id: string; label: string; description: string; effectType: "volume"; fade?: "in" | "out" | undefined }
  | { kind: "preset"; id: string; label: string; description: string; presetId: string }
  | {
      kind: "look";
      id: string;
      label: string;
      description: string;
      lookName: string;
      group: LookGroup;
      sourceId: string;
      manifest?: PluginLookManifest | undefined;
      previewStyle: LookPreviewStyle;
    }
  | {
      kind: "transition";
      id: string;
      label: string;
      description: string;
      transition: TransitionKind;
      /** True for junction kinds (applied between the selected clip and its left neighbour). */
      junction?: boolean;
      direction?: TransitionDirection;
      mode?: "in" | "out";
      color?: string;
      /** Registry param overrides for this preset (e.g. strength, motionBlur, flashColor). */
      params?: Record<string, number | number[] | boolean>;
      manifest?: PluginTransitionManifest | undefined;
      /** Grouping bucket in the transition gallery (see `transitionGalleryCategories`). */
      group?: TransitionGroup;
    }
  | { kind: "ai"; id: string; label: string; description: string; toolSlug: string };

const TRANSITION_ITEMS: CatalogItem[] = [
  // ── Essentials ── (per-clip edge fades + the everyday blends/dips)
  { kind: "transition", id: "tr-fadeIn", label: "Fade In", description: "Fade the clip up from transparent at its start.", transition: "fadeIn", group: "essentials" },
  { kind: "transition", id: "tr-fadeOut", label: "Fade Out", description: "Fade the clip out to transparent at its end.", transition: "fadeOut", group: "essentials" },
  { kind: "transition", id: "tr-crossDissolve", label: "Cross Dissolve", description: "Dissolve the previous clip into this one.", transition: "crossDissolve", junction: true, group: "essentials" },
  { kind: "transition", id: "tr-dipBlack", label: "Dip to Black", description: "Dip through black between the clips.", transition: "dip", junction: true, color: "#000000", group: "essentials" },
  { kind: "transition", id: "tr-dipWhite", label: "Dip to White", description: "Dip through white between the clips.", transition: "dip", junction: true, color: "#FFFFFF", group: "essentials" },

  // ── Slide & Push ── (directional frame movement)
  { kind: "transition", id: "tr-slideLeft", label: "Slide Left", description: "Slide this clip in from the right.", transition: "slide", junction: true, direction: "right", group: "slide-push" },
  { kind: "transition", id: "tr-slideRight", label: "Slide Right", description: "Slide this clip in from the left.", transition: "slide", junction: true, direction: "left", group: "slide-push" },
  { kind: "transition", id: "tr-slideUp", label: "Slide Up", description: "Slide this clip in from the bottom.", transition: "slide", junction: true, direction: "down", group: "slide-push" },
  { kind: "transition", id: "tr-slideDown", label: "Slide Down", description: "Slide this clip in from the top.", transition: "slide", junction: true, direction: "up", group: "slide-push" },
  { kind: "transition", id: "tr-pushLeft", label: "Push Left", description: "Push the previous clip out to the left.", transition: "push", junction: true, direction: "right", group: "slide-push" },
  { kind: "transition", id: "tr-pushRight", label: "Push Right", description: "Push the previous clip out to the right.", transition: "push", junction: true, direction: "left", group: "slide-push" },
  { kind: "transition", id: "tr-pushUp", label: "Push Up", description: "Push the previous clip out upward.", transition: "push", junction: true, direction: "down", group: "slide-push" },
  { kind: "transition", id: "tr-pushDown", label: "Push Down", description: "Push the previous clip out downward.", transition: "push", junction: true, direction: "up", group: "slide-push" },
  { kind: "transition", id: "tr-parallaxLeft", label: "3D Push Left", description: "Parallax push with depth, leftward.", transition: "parallaxPush", junction: true, direction: "left", group: "slide-push" },
  { kind: "transition", id: "tr-parallaxRight", label: "3D Push Right", description: "Parallax push with depth, rightward.", transition: "parallaxPush", junction: true, direction: "right", group: "slide-push" },

  // ── Zoom & Spin ── (camera punch-ins / scale / rotation)
  { kind: "transition", id: "tr-zoomIn", label: "Zoom In", description: "Punch in from a larger scale into this clip.", transition: "zoom", junction: true, mode: "in", group: "zoom-spin" },
  { kind: "transition", id: "tr-zoomOut", label: "Zoom Out", description: "Pull back from a smaller scale into this clip.", transition: "zoom", junction: true, mode: "out", group: "zoom-spin" },
  { kind: "transition", id: "tr-punchZoom", label: "Punch Zoom", description: "Fast blurred zoom punch through the cut.", transition: "punchZoom", junction: true, group: "zoom-spin" },
  { kind: "transition", id: "tr-zoomBlur", label: "Smooth Zoom Blur", description: "Cinematic zoom with directional blur.", transition: "zoomBlur", junction: true, group: "zoom-spin" },
  { kind: "transition", id: "tr-spin", label: "Spin", description: "Spin and zoom between the clips.", transition: "spin", junction: true, group: "zoom-spin" },

  // ── Whip & Blur ── (fast, energetic swipes)
  { kind: "transition", id: "tr-whipLeft", label: "Whip Pan Left", description: "Motion-blurred whip to the left.", transition: "whipPan", junction: true, direction: "left", group: "whip-blur" },
  { kind: "transition", id: "tr-whipRight", label: "Whip Pan Right", description: "Motion-blurred whip to the right.", transition: "whipPan", junction: true, direction: "right", group: "whip-blur" },
  { kind: "transition", id: "tr-whipUp", label: "Whip Pan Up", description: "Motion-blurred whip upward.", transition: "whipPan", junction: true, direction: "up", group: "whip-blur" },
  { kind: "transition", id: "tr-whipDown", label: "Whip Pan Down", description: "Motion-blurred whip downward.", transition: "whipPan", junction: true, direction: "down", group: "whip-blur" },
  { kind: "transition", id: "tr-blurSwipeLeft", label: "Blur Swipe Left", description: "Soft blurred swipe to the left.", transition: "blurSwipe", junction: true, direction: "left", group: "whip-blur" },
  { kind: "transition", id: "tr-blurSwipeRight", label: "Blur Swipe Right", description: "Soft blurred swipe to the right.", transition: "blurSwipe", junction: true, direction: "right", group: "whip-blur" },

  // ── Wipes & Reveals ── (edge wipes + shape reveals)
  { kind: "transition", id: "tr-wipeLeft", label: "Wipe Left", description: "Wipe this clip in from the right edge.", transition: "wipe", junction: true, direction: "left", group: "reveals" },
  { kind: "transition", id: "tr-wipeRight", label: "Wipe Right", description: "Wipe this clip in from the left edge.", transition: "wipe", junction: true, direction: "right", group: "reveals" },
  { kind: "transition", id: "tr-wipeUp", label: "Wipe Up", description: "Wipe this clip in from the bottom.", transition: "wipe", junction: true, direction: "up", group: "reveals" },
  { kind: "transition", id: "tr-wipeDown", label: "Wipe Down", description: "Wipe this clip in from the top.", transition: "wipe", junction: true, direction: "down", group: "reveals" },
  { kind: "transition", id: "tr-irisIn", label: "Iris In", description: "Reveal this clip through a growing circle.", transition: "iris", junction: true, mode: "in", group: "reveals" },
  { kind: "transition", id: "tr-irisOut", label: "Iris Out", description: "Reveal this clip through a shrinking circle.", transition: "iris", junction: true, mode: "out", group: "reveals" },
  { kind: "transition", id: "tr-maskCircle", label: "Circle Reveal", description: "Reveal through a growing circle mask.", transition: "maskReveal", junction: true, params: { shape: 0 }, group: "reveals" },
  { kind: "transition", id: "tr-maskBox", label: "Box Reveal", description: "Reveal through a growing box mask.", transition: "maskReveal", junction: true, params: { shape: 1 }, group: "reveals" },
  { kind: "transition", id: "tr-maskDiamond", label: "Diamond Reveal", description: "Reveal through a growing diamond mask.", transition: "maskReveal", junction: true, params: { shape: 2 }, group: "reveals" },

  // ── Glitch ── (digital / hype)
  { kind: "transition", id: "tr-glitch", label: "Glitch", description: "RGB-split digital glitch through the cut.", transition: "glitch", junction: true, group: "glitch" },
  { kind: "transition", id: "tr-pixelate", label: "Pixelate", description: "Mosaic pixel dissolve between clips.", transition: "pixelate", junction: true, group: "glitch" },

  // ── Cinematic ── (film / organic looks)
  { kind: "transition", id: "tr-lumaFade", label: "Luma Fade", description: "Reveal through the image's bright areas.", transition: "lumaFade", junction: true, group: "cinematic" },
  { kind: "transition", id: "tr-lightLeak", label: "Light Leak", description: "Warm light leak sweeps across the cut.", transition: "lightLeak", junction: true, group: "cinematic" },
  { kind: "transition", id: "tr-filmBurn", label: "Film Burn", description: "Film burns through to the next clip.", transition: "filmBurn", junction: true, group: "cinematic" },

  // ── Impact ── (beat hits)
  { kind: "transition", id: "tr-flashWhite", label: "Flash", description: "Bright flash through the cut.", transition: "flash", junction: true, color: "#FFFFFF", group: "impact" },
  { kind: "transition", id: "tr-shake", label: "Camera Shake", description: "Impact shake across the cut.", transition: "shake", junction: true, group: "impact" }
];

/** The junction transition catalog items (everything except the per-clip edge fades). */
export type TransitionCatalogItem = Extract<CatalogItem, { kind: "transition" }>;

/** Resolve favourited catalog ids to their junction transition specs, in catalog order. */
export function favouriteTransitionSpecs(
  favourites: Set<string>
): Array<{
  label: string;
  spec: {
    kind: TransitionKind;
    direction?: TransitionDirection | undefined;
    mode?: "in" | "out" | undefined;
    color?: string | undefined;
    params?: Record<string, number | number[] | boolean> | undefined;
  };
}> {
  return TRANSITION_ITEMS.filter(
    (item): item is TransitionCatalogItem => item.kind === "transition" && Boolean(item.junction) && favourites.has(item.id)
  ).map((item) => ({
    label: item.label,
    spec: { kind: item.transition, direction: item.direction, mode: item.mode, color: item.color, params: item.params }
  }));
}

const AUDIO_ITEMS: CatalogItem[] = [
  { kind: "audio", id: "audio-volume", label: "Volume", description: "Set the clip's audio level (0–200%).", effectType: "volume" },
  { kind: "audio", id: "audio-fadeIn", label: "Fade In (audio)", description: "Ramp the audio up from silence at the clip start.", effectType: "volume", fade: "in" },
  { kind: "audio", id: "audio-fadeOut", label: "Fade Out (audio)", description: "Ramp the audio down to silence at the clip end.", effectType: "volume", fade: "out" }
];

function effectItem(type: TimelineEffectType, name: string, description: string): CatalogItem {
  return { kind: "effect", id: `fx-${type}`, label: name, description, effectType: type, draggable: true };
}

function presetItem(id: string, label: string): CatalogItem {
  return { kind: "preset", id: `preset-${id}`, label, description: `Apply the ${label} animation.`, presetId: id };
}

function aiItem(slug: string, name: string, description: string): CatalogItem {
  return { kind: "ai", id: `ai-${slug}`, label: name, description, toolSlug: slug };
}

function isTimelineEffectDefinition(value: unknown): value is TimelineEffectDefinition {
  return Boolean(
    value &&
      typeof value === "object" &&
      "type" in value &&
      "compatibleLayerTypes" in value &&
      Array.isArray((value as { compatibleLayerTypes?: unknown }).compatibleLayerTypes)
  );
}

function lookGroupForName(name: string): LookGroup {
  const key = name.toLowerCase();
  if (key.includes("film") || key.includes("burn") || key.includes("bleach")) return "film";
  if (key.includes("noir") || key.includes("faded") || key.includes("process")) return "vintage";
  if (key.includes("cold") || key.includes("clean")) return "clean";
  if (key.includes("cinematic") || key.includes("teal") || key.includes("sunset")) return "cinematic";
  return "creator";
}

function lookPreviewStyleForName(name: string): LookPreviewStyle {
  const key = name.toLowerCase();
  if (key.includes("teal")) {
    return { filter: "contrast(1.16) saturate(1.16) sepia(0.08) hue-rotate(-8deg)", overlay: "linear-gradient(45deg, rgba(0, 128, 150, 0.28), rgba(255, 129, 58, 0.26))", opacity: 0.7 };
  }
  if (key.includes("faded")) {
    return { filter: "contrast(0.86) saturate(0.74) brightness(1.06) sepia(0.18)", overlay: "linear-gradient(45deg, rgba(60, 47, 37, 0.22), rgba(231, 205, 156, 0.24))", opacity: 0.68 };
  }
  if (key.includes("noir")) {
    return { filter: "grayscale(0.9) contrast(1.35) brightness(0.86)", overlay: "linear-gradient(45deg, rgba(0, 0, 0, 0.3), rgba(255, 255, 255, 0.08))", opacity: 0.75 };
  }
  if (key.includes("sunset")) {
    return { filter: "contrast(1.08) saturate(1.22) sepia(0.2) hue-rotate(-12deg) brightness(1.04)", overlay: "linear-gradient(45deg, rgba(255, 130, 42, 0.34), rgba(255, 214, 116, 0.18))", opacity: 0.72 };
  }
  if (key.includes("cold")) {
    return { filter: "contrast(1.08) saturate(0.82) hue-rotate(8deg) brightness(1.03)", overlay: "linear-gradient(45deg, rgba(55, 132, 180, 0.34), rgba(220, 245, 255, 0.16))", opacity: 0.74 };
  }
  if (key.includes("bleach")) {
    return { filter: "contrast(1.38) saturate(0.58) brightness(1.04)", overlay: "linear-gradient(45deg, rgba(245, 220, 155, 0.22), rgba(0, 0, 0, 0.2))", opacity: 0.72 };
  }
  if (key.includes("process")) {
    return { filter: "contrast(1.18) saturate(1.32) hue-rotate(14deg)", overlay: "linear-gradient(45deg, rgba(37, 172, 136, 0.24), rgba(222, 60, 172, 0.22))", opacity: 0.7 };
  }
  return { filter: "contrast(1.14) saturate(1.05) brightness(0.98)", overlay: "linear-gradient(45deg, rgba(34, 92, 130, 0.18), rgba(224, 139, 62, 0.2))", opacity: 0.66 };
}

function transitionGroupForCategory(category: string): TransitionGroup {
  if (category === "basic") return "essentials";
  if (category === "cinematic") return "cinematic";
  if (category === "glitch") return "glitch";
  if (category === "mask") return "reveals";
  return "impact";
}

/**
 * Build the catalog grouped by panel category for the selected layer type. Timeline effects are
 * bucketed by their `compatibleLayerTypes` (video/image→Video, text→Text, audio/video→Audio, minus
 * the dedicated `volume` effect which lives under the curated Audio items). Presets are layer-type
 * aware (`textOnly` → Text). AI tools are gated by the ready-slug list and their accepted inputs.
 * Items are layer-filtered when a layer is selected, else everything shows (discovery).
 */
export function buildEffectCatalog(
  selectedLayerType?: TimelineLayerType | undefined,
  options: BuildEffectCatalogOptions = {}
): Record<EffectPanelCategory, CatalogItem[]> {
  const effectDefinitions = listEffectLibrary()
    .map((item) => item.definition)
    .filter(isTimelineEffectDefinition);
  const effects = selectedLayerType
    ? effectDefinitions.filter((effect) => effect.compatibleLayerTypes.includes(selectedLayerType))
    : effectDefinitions;

  const video: CatalogItem[] = [];
  const text: CatalogItem[] = [];
  const audioFx: CatalogItem[] = [];
  const uploaded: CatalogItem[] = [];
  for (const effect of effects) {
    if (effect.type === "volume") continue; // curated under Audio
    const item = effectItem(effect.type, effect.name, effect.description);
    // Audio-category clip FX (EQ/compressor/gate/limiter) live under the Audio bin, after the
    // curated volume/fade items — they'd otherwise be dropped by the video/text bucketing below.
    if (effect.category === "Audio") {
      audioFx.push(item);
      continue;
    }
    if (effect.compatibleLayerTypes.includes("video") || effect.compatibleLayerTypes.includes("image")) video.push(item);
    if (effect.compatibleLayerTypes.includes("text")) text.push(item);
  }

  const importedEffects = (options.effectManifests ?? [])
    .map((manifest) => resolveEffectManifest(manifest))
    .filter((resolved) => !selectedLayerType || resolved.compatibleLayerTypes.includes(selectedLayerType));
  for (const resolved of importedEffects) {
    uploaded.push({
      kind: "effectManifest",
      id: `fx-imported-${resolved.id}`,
      label: resolved.name,
      description: resolved.description ?? `Imported ${resolved.effectType} preset.`,
      manifest: resolved.manifest,
      effectType: resolved.effectType,
      draggable: false
    });
  }

  // Animation presets: general presets under Video; text-only (Typewriter) under Text. When a
  // layer is selected, only show presets valid for it.
  for (const preset of animationPresets) {
    const isTextOnly = "textOnly" in preset && preset.textOnly;
    if (isTextOnly) {
      if (!selectedLayerType || selectedLayerType === "text") text.push(presetItem(preset.id, preset.label));
    } else {
      if (!selectedLayerType || selectedLayerType !== "audio") video.push(presetItem(preset.id, preset.label));
      if (selectedLayerType === "text") text.push(presetItem(preset.id, preset.label));
    }
  }

  const audio: CatalogItem[] =
    !selectedLayerType || selectedLayerType === "audio" || selectedLayerType === "video"
      ? [...AUDIO_ITEMS, ...audioFx]
      : [];

  // Opacity transitions are visual — audio layers fade via the Audio items instead.
  const importedTransitionProvider = options.transitionManifests?.length
    ? createManifestTransitionProvider("kimera.imported.transitions", "Imported Transitions", options.transitionManifests)
    : null;
  const importedTransitions: CatalogItem[] =
    importedTransitionProvider && (!selectedLayerType || selectedLayerType !== "audio")
      ? listTransitionLibrary([importedTransitionProvider]).map((item) => ({
          kind: "transition" as const,
          id: `tr-imported-${item.id}`,
          label: item.name,
          description: item.description ?? "Imported transition manifest.",
          transition: item.definition.id,
          junction: true,
          manifest: item.manifest,
          group: "uploaded"
        }))
      : [];
  const transition: CatalogItem[] = !selectedLayerType || selectedLayerType !== "audio" ? [...TRANSITION_ITEMS, ...importedTransitions] : [];
  const look: CatalogItem[] =
    !selectedLayerType || selectedLayerType !== "audio"
      ? [
          ...(options.lookManifests ?? []).map((manifest) => {
            const resolved = resolveLookManifest(manifest);
            return {
              kind: "look" as const,
              id: `look-imported-${manifest.id}`,
              label: resolved.name,
              description: resolved.description ?? "Imported color look.",
              lookName: resolved.look.name,
              group: "uploaded" as const,
              sourceId: manifest.id,
              manifest,
              previewStyle: lookPreviewStyleForName(resolved.look.name)
            };
          }),
          ...listLookLibrary().map((item) => ({
            kind: "look" as const,
            id: item.id,
            label: item.name,
            description: item.description ?? "Apply this color look.",
            lookName: item.name,
            group: lookGroupForName(item.name),
            sourceId: item.source.id,
            previewStyle: lookPreviewStyleForName(item.name)
          }))
        ]
      : [];

  const ai: CatalogItem[] = toolCapabilityDefinitions
    .filter(
      (tool) =>
        READY_TOOL_SLUGS.includes(tool.slug) &&
        (!selectedLayerType || tool.accepts.includes(selectedLayerType as ToolInputType))
    )
    .map((tool) => aiItem(tool.slug, tool.name, tool.shortDescription));

  return { uploaded, video, text, audio, look, transition, ai };
}
