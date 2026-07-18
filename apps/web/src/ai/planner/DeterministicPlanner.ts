import {
  actionCost,
  buildCapabilityIndex,
  classifyToolCost,
  compileGradeIntent,
  logUnsupported,
  matchLookInText,
  recordEffectDemand,
  recordToolDemand,
  resolveTargetLayer,
  type CapabilityIndex,
  type GradeIntent,
  type HueName,
  type TimelineComposition,
  type TimelineLayer
} from "@orreris/shared";
import type { AiPlan, PlanEventHandler, PlanStep, PlannerContext, PlannerProvider } from "../types";
import { extractColor, extractPosition, extractSize, extractTextStyle, resolveShapeGeometry } from "./entities";
import { analyze, hasLemma, type NluDoc } from "./nlu";

/**
 * Deterministic, swappable planner — the offline, zero-key, always-works floor
 * under the LLM gateway. It now runs a small in-browser NLU (wink-nlp, via
 * `./nlu`): it lemmatises + POS-tags the prompt, classifies the VERB FAMILY first
 * (add / edit / remove / effect / tool), and only then resolves entities and a
 * target. Deciding the action FAMILY before any target heuristic is what stops
 * "add a shape of neutral orange" from being misread as "recolor the text".
 *
 * Everything maps onto registered Timeline Actions / tools (it inspects the live
 * `CapabilityIndex`) and stays project- and conversation-aware (P5) plus
 * memory-aware (P6). No LLM, no API keys, synchronous.
 */

let stepCounter = 0;
function stepId(): string {
  stepCounter += 1;
  return `step_${Date.now().toString(36)}_${stepCounter}`;
}

function allLayers(composition: TimelineComposition): TimelineLayer[] {
  return composition.tracks.flatMap((track) => track.layers);
}

function findLayerById(composition: TimelineComposition, id: string | undefined): TimelineLayer | undefined {
  if (!id) return undefined;
  return allLayers(composition).find((layer) => layer.id === id);
}

/**
 * Pick the layer most edits should target — type-agnostic, so "blur it" works whether the target is
 * a video, image/graphic, text, or shape. Priority: selection → the visual clip under the playhead
 * (any editable type) → the main video → the first layer. Uses the shared reference resolver so this
 * matches how the LLM slice and the tool path resolve "this clip".
 */
function defaultTargetLayerId(ctx: PlannerContext): string | undefined {
  const resolved = resolveTargetLayer(ctx.composition, { selection: ctx.selection, nowSeconds: ctx.nowSeconds });
  if (resolved.layerId) {
    return resolved.layerId;
  }
  const layers = allLayers(ctx.composition);
  return (layers.find((layer) => layer.type === "video") ?? layers[0])?.id;
}

/**
 * The text layer a follow-up ("make it bigger") refers to: current selection, else
 * the layer(s) the last applied plan touched, else the most recent text layer.
 */
function followUpTextLayer(ctx: PlannerContext): TimelineLayer | undefined {
  const selected = findLayerById(ctx.composition, ctx.selection[0]);
  if (selected?.type === "text") {
    return selected;
  }
  for (const id of ctx.lastAction?.targetLayerIds ?? []) {
    const layer = findLayerById(ctx.composition, id);
    if (layer?.type === "text") {
      return layer;
    }
  }
  // P10 — only fall back to "the most recent text layer" when this isn't a NEW
  // request, so a fresh prompt can never be resolved onto an unrelated layer.
  if (ctx.intentScope === "new") {
    return undefined;
  }
  const texts = allLayers(ctx.composition).filter((layer) => layer.type === "text");
  return texts[texts.length - 1];
}

// --- Verb families. Classifying the verb decides the action family up front. ---
const ADD_VERBS = new Set(["add", "create", "insert", "place", "draw", "put", "append", "generate", "write", "include"]);
const REMOVE_VERBS = new Set(["remove", "delete", "clear", "erase", "strip", "drop"]);
const EDIT_VERBS = new Set([
  "change",
  "update",
  "recolor",
  "recolour",
  "resize",
  "move",
  "shift",
  "rename",
  "set",
  "adjust",
  "tweak",
  "edit",
  "increase",
  "decrease",
  "grow",
  "shrink",
  "enlarge",
  "delay"
]);

type VerbFamily = "add" | "edit" | "remove" | null;

/** Classify the leading intent from token lemmas (priority: remove → add → edit). */
function verbFamily(doc: NluDoc): VerbFamily {
  if (hasLemma(doc, ...REMOVE_VERBS)) return "remove";
  if (hasLemma(doc, ...ADD_VERBS)) return "add";
  // "make a box" is an add; "make it bigger" / "make it cinematic" is an edit.
  if (doc.lemmas.has("make")) {
    return /\bmake\s+(a|an|some|another)\b/.test(doc.lower) ? "add" : "edit";
  }
  if (hasLemma(doc, ...EDIT_VERBS)) return "edit";
  return null;
}


/** A timing move for moveLayer: "start at 3s" / "3 seconds later" / "delay by 2 seconds". */
function extractTiming(doc: NluDoc): { startSeconds?: number; deltaSeconds?: number } | undefined {
  const startAt = doc.lower.match(/\bstart(?:s|ing)?\s+at\s+(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds)\b/);
  if (startAt) return { startSeconds: Number(startAt[1]) };
  const later = doc.lower.match(/(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds)\s+(?:later|earlier)/);
  if (later) {
    const value = Number(later[1]);
    return { deltaSeconds: doc.lower.includes("earlier") ? -value : value };
  }
  const delay = doc.lower.match(/\b(?:delay|push|shift)\b.*?(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds)/);
  if (delay) return { deltaSeconds: Number(delay[1]) };
  return undefined;
}

/**
 * Extract literal text content for a new/updated text layer. Only explicit content
 * markers count — "saying"/"that says"/"reads" or a quoted string. We deliberately
 * do NOT treat the bare word "text" as a marker, so "change the text color" is a
 * style edit, not a request to set the content to "color".
 */
function extractText(prompt: string): string | undefined {
  const quoted = prompt.match(/["“”']([^"“”']{1,200})["“”']/);
  if (quoted?.[1]) {
    return quoted[1];
  }
  const saying = prompt.match(/\b(?:saying|that says|that reads|reads|says)\s+([a-z0-9 ,.!?'-]{2,80})/i);
  return saying?.[1]?.trim();
}

/**
 * Data-driven effect match: match the effect's own `type` (e.g. "blur") or its
 * de-camelCased form ("color grade") against the prompt. We match on the type, not
 * on split name words, so a generic word like "color" can't spuriously trigger a
 * color-grade effect.
 */
function matchEffectType(doc: NluDoc, index: CapabilityIndex): string | undefined {
  // "color wheels" / "lift gamma gain" / "3-way" → the Color Wheels effect.
  if (hasLemma(doc, "wheel", "wheels", "lift", "gamma", "gain") || /\b3[- ]?way\b/.test(doc.lower)) {
    const wheels = index.effects.find((effect) => effect.type === "colorWheels");
    if (wheels) return wheels.type;
  }
  // "curve" / "curves" → the pro graph Curves effect (colorCurves).
  if (hasLemma(doc, "curve", "curves") && !hasLemma(doc, "hue", "sat", "saturation")) {
    const curves = index.effects.find((effect) => effect.type === "colorCurves");
    if (curves) return curves.type;
  }
  // "hue sat curves" / "hue vs sat" / "hue/sat" → hueSatCurves (Lumetri hue curves).
  if (hasLemma(doc, "hue") && hasLemma(doc, "sat", "saturation", "curve", "curves", "luma", "luminance")) {
    const hsc = index.effects.find((effect) => effect.type === "hueSatCurves");
    if (hsc) return hsc.type;
  }
  // "secondary" / "isolate color" / "mask color" / "select color" → hslSecondary.
  if (hasLemma(doc, "secondary", "isolate", "mask", "keyer", "key") && hasLemma(doc, "color", "hue", "range")) {
    const sec = index.effects.find((effect) => effect.type === "hslSecondary");
    if (sec) return sec.type;
  }
  // "look" / "preset" / "teal orange" / "faded film" / "noir" / "bleach" → creativeLook.
  if (
    hasLemma(doc, "look", "preset", "lut", "style", "feel", "mood") ||
    /teal.{0,6}orange|faded.{0,4}film|noir|bleach.{0,4}bypass|cross.{0,4}process|warm.{0,4}sunset|cold.{0,4}morning/i.test(doc.lower)
  ) {
    const look = index.effects.find((effect) => effect.type === "creativeLook");
    if (look) return look.type;
  }
  // Common phrasings that don't contain the literal effect type. "Color Grade" was
  // retired, so grade/cinematic intents resolve to Basic Color Correction (the real
  // primary corrector), falling back to any color/curve effect.
  if (hasLemma(doc, "cinematic", "filmic", "moody", "grade", "graded")) {
    const grade =
      index.effects.find((effect) => /grade|brightnessContrast/i.test(effect.type)) ??
      index.effects.find((effect) => /color|curve/i.test(effect.type));
    if (grade) return grade.type;
  }
  for (const effect of index.effects) {
    const type = effect.type.toLowerCase();
    const spaced = effect.type.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
    if (doc.lemmas.has(type) || doc.tokens.some((token) => token.norm === type) || doc.lower.includes(spaced)) {
      return effect.type;
    }
  }
  return undefined;
}

/** The color-family effect types that route through the color-grade skill (not a bare addEffect). */
const COLOR_GRADE_EFFECTS = new Set([
  "brightnessContrast",
  "colorGrade",
  "colorCurves",
  "colorWheels",
  "hueSatCurves",
  "hslSecondary",
  "creativeLook"
]);

/**
 * The deterministic floor's "colorist": turn a plain-language grade request into a compact
 * GradeIntent (the same shape the LLM emits). Keeps color grading a REAL grade offline / on
 * fallback — no default-drop. Intentionally modest; the LLM is the primary brain when available.
 */
function extractGradeIntent(lower: string): GradeIntent {
  const intent: GradeIntent = {};
  const primary: NonNullable<GradeIntent["primary"]> = {};
  const tone: NonNullable<GradeIntent["tone"]> = {};

  const looks: [RegExp, string][] = [
    [/teal.{0,6}orange/, "Teal & Orange"],
    [/faded.{0,4}film|analog/, "Faded Film"],
    [/noir|black.{0,4}and.{0,4}white|monochrome/, "Noir"],
    [/warm.{0,4}sunset|golden.{0,4}hour/, "Warm Sunset"],
    [/cold.{0,4}morning/, "Cold Morning"],
    [/bleach.{0,4}bypass/, "Bleach Bypass"],
    [/cross.{0,4}process/, "Cross Process"],
    [/cinematic|filmic|film look|movie look/, "Cinematic"]
  ];
  for (const [re, name] of looks) {
    if (re.test(lower)) {
      intent.look = name;
      break;
    }
  }
  // K3 follow-up: "<name> look" phrases resolve through the SHARED look resolver (registry +
  // alias table), so "apply a moody look" lands Noir @ 55 offline instead of falling through
  // to a bare creativeLook default-drop (which used to mean Teal & Orange @ 100 — user repro
  // 2026-07-18). The regex table above stays first for phrasings without the word "look".
  if (!intent.look) {
    const matched = matchLookInText(lower);
    if (matched) {
      intent.look = matched.look;
      if (matched.intensity !== undefined) {
        intent.lookIntensity = matched.intensity;
      }
    }
  }

  if (/\bwarm(er|th)?\b/.test(lower)) primary.temperature = 20;
  if (/\bcool(er)?\b|colder|\bcold\b/.test(lower)) primary.temperature = -20;
  if (/brighter|brighten|lighter|more exposure/.test(lower)) primary.exposure = 20;
  if (/darker|darken/.test(lower)) primary.exposure = -20;
  if (/more contrast|higher contrast|punchy|contrasty/.test(lower)) primary.contrast = 25;
  if (/less contrast|\bflat(ter)?\b|low contrast/.test(lower)) primary.contrast = -20;
  if (/more saturat|vivid|vibrant|colou?rful/.test(lower)) primary.saturation = 130;
  if (/desaturat|muted|less saturat|wash(ed)? out/.test(lower)) primary.saturation = 70;

  if (/crush.{0,4}black|deep(er)? black|deep shadows/.test(lower)) tone.crush = 0.4;
  if (/lift.{0,4}(shadow|black)|raise.{0,4}(shadow|black)|faded black/.test(lower)) tone.lift = 0.3;
  if (/roll.{0,4}off.{0,4}highlight|soft(er)? highlight|tame.{0,4}highlight/.test(lower)) tone.rolloff = 0.4;
  if (Object.keys(tone).length) intent.tone = tone;

  // "make the reds pop", "boost the blues" → hue-selective saturation.
  const hueWords: HueName[] = ["red", "orange", "yellow", "green", "teal", "cyan", "blue", "purple", "magenta"];
  if (/(pop|boost|enhance|more|vivid|saturat)/.test(lower)) {
    const hue = hueWords
      .filter((h) => new RegExp(`\\b${h}s?\\b`).test(lower))
      .map((h) => ({ target: h, sat: 0.4 }));
    if (hue.length) intent.hue = hue;
  }

  // "keep skin warm, desaturate the background", "isolate the sky".
  const secondary: NonNullable<GradeIntent["secondary"]> = [];
  if (/isolate.{0,10}skin|keep.{0,6}skin|skin.{0,6}(warm|tone)/.test(lower)) {
    secondary.push({ target: "skin", sat: 0.1 });
    if (/desaturat|mute|background/.test(lower)) secondary.push({ target: "skin", invert: true, sat: -0.5 });
  }
  if (/isolate.{0,10}sky|boost.{0,6}sky|bluer sky/.test(lower)) secondary.push({ target: "sky", sat: 0.4 });
  if (secondary.length) intent.secondary = secondary;

  if (Object.keys(primary).length) intent.primary = primary;
  return intent;
}

export class DeterministicPlanner implements PlannerProvider {
  readonly id = "deterministic";

  async plan(prompt: string, ctx: PlannerContext, _onEvent?: PlanEventHandler): Promise<AiPlan> {
    const index = buildCapabilityIndex();
    const doc = await analyze(prompt);
    const memory = ctx.memory ?? {};
    const steps: PlanStep[] = [];
    const notes: string[] = [];

    const family = verbFamily(doc);
    const color = extractColor(prompt);
    const position = extractPosition(prompt);
    const size = extractSize(prompt);
    const textStyle = extractTextStyle(prompt);
    const shape = resolveShapeGeometry(prompt, ctx.composition);
    const requestedText = extractText(prompt);

    const needsTarget = (label: string): string | undefined => {
      const target = defaultTargetLayerId(ctx);
      if (!target) {
        notes.push(`Couldn't ${label}: no layer to apply it to. Select or add a layer first.`);
      }
      return target;
    };

    // --- 1. Tools (independent of verb family) ---
    let backgroundHandled = false;
    if (hasLemma(doc, "caption", "subtitle", "subtitles", "transcribe", "transcript")) {
      const tool = index.findTool("auto-captions");
      if (tool) {
        recordToolDemand(tool.slug);
        const usual = hasLemma(doc, "usual", "preferred") && memory.captionStyle;
        steps.push({
          id: stepId(),
          kind: "tool",
          toolSlug: tool.slug,
          summary: usual ? `Generate captions (${memory.captionStyle} — your usual style)` : "Generate captions",
          cost: classifyToolCost(tool.slug)
        });
      }
    }
    if (family === "remove" && hasLemma(doc, "background")) {
      const tool = index.findTool("remove-background");
      if (tool) {
        recordToolDemand(tool.slug);
        backgroundHandled = true;
        steps.push({ id: stepId(), kind: "tool", toolSlug: tool.slug, summary: "Remove background", cost: classifyToolCost(tool.slug) });
      } else {
        notes.push("No background-removal tool is registered.");
        logUnsupported({ prompt, missingCapability: "background-removal", acceptedApproximation: false });
      }
    }
    if (hasLemma(doc, "follow", "track") && !steps.length) {
      const tool = index.findTool("follow");
      if (tool) {
        recordToolDemand(tool.slug);
        steps.push({
          id: stepId(),
          kind: "tool",
          toolSlug: tool.slug,
          summary: "Track the subject and follow with text",
          requiresInput: true,
          cost: classifyToolCost(tool.slug)
        });
      }
    }

    // --- 1b. Spatial reposition of an EXISTING layer ("put the selected text in
    // the center"). "put"/"move" classify as add, but with no new object (no shape,
    // no quoted/"saying" text) and a position + a reference to existing content, the
    // intent is a move, not a create. Handled before ADD so it pre-empts a stray addText. ---
    const introducesNewObject = shape.isShape || Boolean(requestedText);
    const referencesExisting =
      ctx.selection.length > 0 || hasLemma(doc, "it", "this", "that", "selected") || /\bthe\s+(text|title|caption|shape|layer|element)\b/.test(doc.lower);
    const wantsSpatialMove =
      (position.x !== undefined || position.y !== undefined) && referencesExisting && !introducesNewObject && !steps.length;
    if (wantsSpatialMove) {
      const target = followUpTextLayer(ctx) ?? findLayerById(ctx.composition, ctx.selection[0]);
      if (target?.type === "text") {
        steps.push({
          id: stepId(),
          kind: "timelineAction",
          actionId: "updateText",
          params: { layerId: target.id, ...position },
          summary: "Reposition the text",
          cost: actionCost()
        });
      } else {
        notes.push("Select the text layer you want to reposition first.");
      }
    }

    // --- 2. ADD family: new layers. Guarded so it can never recolor existing text. ---
    const wantsAdd =
      !wantsSpatialMove && (family === "add" || (family === null && (shape.isShape || Boolean(requestedText))));
    if (wantsAdd && shape.isShape) {
      steps.push({
        id: stepId(),
        kind: "timelineAction",
        actionId: "addShape",
        params: {
          ...(color ? { color } : {}),
          ...(shape.widthPercent !== undefined ? { widthPercent: shape.widthPercent } : {}),
          ...(shape.heightPercent !== undefined ? { heightPercent: shape.heightPercent } : {}),
          ...(shape.borderRadius !== undefined ? { borderRadius: shape.borderRadius } : {}),
          ...position
        },
        summary: `Add ${color ? "a colored " : "a "}shape`,
        cost: actionCost()
      });
    } else if (wantsAdd && requestedText) {
      const textColor = color ?? memory.textColor;
      steps.push({
        id: stepId(),
        kind: "timelineAction",
        actionId: "addText",
        params: {
          text: requestedText,
          ...(textColor ? { color: textColor } : {}),
          ...(size ? { size } : {}),
          ...(textStyle.bold !== undefined ? { bold: textStyle.bold } : {}),
          ...(textStyle.italic !== undefined ? { italic: textStyle.italic } : {}),
          ...position
        },
        summary: `Add text "${requestedText}"`,
        cost: actionCost()
      });
    }

    // --- 3. REMOVE family. Resolve the right target by VOCABULARY (effect vs fade
    // vs whole layer) so "remove the blur" strips the blur effect — not the clip —
    // and a vague "delete this" can't silently nuke a media clip. ---
    if (family === "remove" && !backgroundHandled && !steps.length) {
      const removeEffectType = matchEffectType(doc, index);
      const selected = findLayerById(ctx.composition, ctx.selection[0]);

      if (/\bfade\b/.test(doc.lower)) {
        // "remove the fade [in/out]" → strip transition keyframes from the target.
        const target = ctx.selection[0] ?? defaultTargetLayerId(ctx);
        if (target) {
          steps.push({
            id: stepId(),
            kind: "timelineAction",
            actionId: "removeTransition",
            params: { layerId: target },
            summary: "Remove the fade",
            cost: actionCost()
          });
        } else {
          notes.push("Tell me which layer's fade to remove — select it first.");
        }
      } else if (removeEffectType) {
        // "remove the blur" → find the layer carrying that effect and detach it by id.
        const carrier =
          selected?.effects?.some((effect) => effect.type === removeEffectType) ? selected : allLayers(ctx.composition).find((layer) => layer.effects?.some((effect) => effect.type === removeEffectType));
        const effect = carrier?.effects?.find((item) => item.type === removeEffectType);
        if (carrier && effect) {
          recordEffectDemand(removeEffectType);
          steps.push({
            id: stepId(),
            kind: "timelineAction",
            actionId: "removeEffect",
            params: { layerId: carrier.id, effectId: effect.id },
            summary: `Remove the ${removeEffectType} effect`,
            cost: actionCost()
          });
        } else {
          notes.push(`I couldn't find a ${removeEffectType} effect to remove — apply or select it first.`);
        }
      } else {
        // Plain layer delete. A media CLIP referenced only vaguely ("this"/"it"/"layer")
        // with nothing selected is too destructive to assume — ask instead.
        const vague = !ctx.selection[0] && hasLemma(doc, "it", "this", "that", "layer", "element");
        const target = ctx.selection[0] ?? (vague ? defaultTargetLayerId(ctx) : undefined);
        const targetLayer = findLayerById(ctx.composition, target);
        const isMediaClip = targetLayer ? ["video", "audio", "image"].includes(targetLayer.type) : false;
        if (target && (ctx.selection[0] || !isMediaClip)) {
          steps.push({
            id: stepId(),
            kind: "timelineAction",
            actionId: "deleteLayer",
            params: { layerId: target },
            summary: targetLayer?.type === "text" ? "Delete the text" : "Delete the layer",
            cost: actionCost()
          });
        } else if (isMediaClip && vague) {
          steps.push({
            id: stepId(),
            kind: "clarify",
            question:
              "Do you want to delete the whole video/media clip, or remove something on it (a text/shape element, an effect like \"the blur\", or a fade)? Select the exact layer, or name what to remove.",
            summary: "Confirm what to delete",
            cost: actionCost()
          });
        } else {
          notes.push("Tell me which layer to remove — select it first.");
        }
      }
    }

    // --- 4. EDIT / delta: modify an existing layer (never on an ADD of a fresh object) ---
    if (!wantsAdd && (family === "edit" || family === null)) {
      const followText = followUpTextLayer(ctx);
      const timing = extractTiming(doc);
      if (timing && ctx.selection[0]) {
        steps.push({
          id: stepId(),
          kind: "timelineAction",
          actionId: "moveLayer",
          params: { layerId: ctx.selection[0], ...timing },
          summary: "Re-time the layer",
          cost: actionCost()
        });
      } else if (followText) {
        const currentSize = typeof followText.fontSize === "number" ? followText.fontSize : 64;
        if (hasLemma(doc, "big", "bigger", "large", "larger", "increase", "grow", "enlarge")) {
          steps.push(updateTextStep(followText.id, { size: Math.min(800, Math.round(currentSize * 1.4)) }, "Make the text bigger"));
        } else if (hasLemma(doc, "small", "smaller", "shrink", "reduce", "decrease", "tiny", "tinier")) {
          steps.push(updateTextStep(followText.id, { size: Math.max(8, Math.round(currentSize * 0.7)) }, "Make the text smaller"));
        } else if (hasLemma(doc, "dramatic", "bold", "bolder", "punchy", "punchier", "strong", "stronger", "pop")) {
          steps.push(
            updateTextStep(
              followText.id,
              { size: Math.min(800, Math.round(currentSize * 1.25)), color: color ?? "#facc15" },
              "Make the text more dramatic"
            )
          );
        } else if (requestedText) {
          steps.push(updateTextStep(followText.id, { text: requestedText }, "Change the text"));
        } else if (color) {
          steps.push(updateTextStep(followText.id, { color }, "Recolor the text"));
        }
      }
    }

    // --- 5. Effects (data-driven), applied to the resolved target ---
    const effectType = matchEffectType(doc, index);
    const addedNewLayer = steps.some((step) => step.actionId === "addShape" || step.actionId === "addText");
    if (effectType && !addedNewLayer) {
      const target = needsTarget(`apply ${effectType}`);
      if (target) {
        // Color-family effects route through the color-grade skill so the request produces a REAL
        // grade (compiled to an editable effect stack), never a neutral default-drop. If the prompt
        // carries no gradable signal (e.g. bare "add curves"), fall back to adding the tool at default.
        const intent = COLOR_GRADE_EFFECTS.has(effectType) ? extractGradeIntent(doc.lower) : null;
        if (intent && compileGradeIntent(intent).length > 0) {
          recordEffectDemand(effectType);
          steps.push({
            id: stepId(),
            kind: "skill",
            skillId: "color-grade",
            taskKind: "color-grade",
            params: intent,
            summary: memory.colorGrade ? `Color grade (${memory.colorGrade})` : "Color grade",
            cost: { tier: "browser", credits: 0 }
          });
        } else {
          recordEffectDemand(effectType);
          steps.push({
            id: stepId(),
            kind: "timelineAction",
            actionId: "addEffect",
            params: { layerId: target, effectType },
            summary: `Apply ${effectType}`,
            cost: actionCost()
          });
        }
      }
    } else if (effectType && addedNewLayer) {
      notes.push(`Couldn't auto-apply ${effectType} to the new layer — select it and ask again.`);
    }

    // --- 6. Fades / transitions ---
    if (/\bfade\s*in\b/.test(doc.lower)) {
      const target = needsTarget("add a fade in");
      if (target) {
        steps.push({
          id: stepId(),
          kind: "timelineAction",
          actionId: "addTransition",
          params: { layerId: target, kind: "fadeIn" },
          summary: "Add fade in",
          cost: actionCost()
        });
      }
    }
    if (/\bfade\s*out\b/.test(doc.lower)) {
      const target = needsTarget("add a fade out");
      if (target) {
        steps.push({
          id: stepId(),
          kind: "timelineAction",
          actionId: "addTransition",
          params: { layerId: target, kind: "fadeOut" },
          summary: "Add fade out",
          cost: actionCost()
        });
      }
    }

    // --- Fallback: a specific clarify ---
    if (steps.length === 0) {
      const missing = family === "edit" ? "follow-up-reference" : "unknown-intent";
      logUnsupported({ prompt, missingCapability: missing, acceptedApproximation: false });
      steps.push({
        id: stepId(),
        kind: "clarify",
        question:
          missing === "follow-up-reference"
            ? "I'm not sure which layer you mean — select it, or name the exact change (e.g. \"make the title bigger\")."
            : "Sorry — I didn't catch an edit in that. Tell me what you'd like changed, like \"add captions\" or \"make it cinematic\".",
        summary: "Ask for clarification",
        cost: actionCost()
      });
    }

    const totalCredits = steps.reduce((sum, step) => sum + step.cost.credits, 0);
    const { confidence, confidencePercent } = pickConfidence(steps, notes);

    // The deterministic planner is the LAST-RESORT keyword matcher — it only runs when the LLM is
    // unreachable or returned nothing usable. Tag it as `offline` so the UI can say so, and never let
    // it claim more than "Approximation": its best-case "Exact · 90%" made a wrong keyword guess look
    // like a confident AI plan (user report 2026-07-08). Real confidence lives on the LLM path.
    const cappedPercent = Math.min(confidencePercent, 55);
    const cappedConfidence: AiPlan["confidence"] = confidence === "Exact" || confidence === "High Quality" ? "Approximation" : confidence;

    return {
      id: `plan_${Date.now().toString(36)}`,
      prompt,
      steps,
      totalCredits,
      confidence: cappedConfidence,
      confidencePercent: cappedPercent,
      notes,
      provider: "offline"
    };
  }
}

function updateTextStep(layerId: string, params: { size?: number; color?: string; text?: string }, summary: string): PlanStep {
  return {
    id: stepId(),
    kind: "timelineAction",
    actionId: "updateText",
    params: { layerId, ...params },
    summary,
    cost: actionCost()
  };
}

function pickConfidence(
  steps: AiPlan["steps"],
  notes: string[]
): { confidence: AiPlan["confidence"]; confidencePercent: number } {
  if (steps.every((step) => step.kind === "clarify")) {
    return { confidence: "Experimental", confidencePercent: 30 };
  }
  if (notes.length > 0) {
    return { confidence: "Approximation", confidencePercent: 55 };
  }
  if (steps.some((step) => step.requiresInput)) {
    return { confidence: "High Quality", confidencePercent: 70 };
  }
  return { confidence: "Exact", confidencePercent: 90 };
}
