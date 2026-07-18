/**
 * Orreris OS — the World Model's first brain consumer (K1). An async local tier that answers
 * "analyze clip 3" / "what does clip 2 look like" / "analyze the timeline" from MEASURED
 * facts — metadata (L0), sampled-frame look (L1), text coverage (L2) — zero tokens, honest
 * provenance in the answer ("3 sampled frames", "from the import record").
 *
 * Precision-first like every tier: the trigger regexes are whole-string anchored, the clip
 * phrase must parse exactly, and anything else escalates silently to the normal model path.
 * Answers here are read-only (kind "answer") — the world route NEVER mutates.
 */

import { layerIdForOrdinal, type TimelineComposition, type TimelineLayer } from "@orreris/shared";
import type { BrainContext, BrainRouteResult } from "../brain/router";
import { normalizePrompt, parseExactClipPhrase } from "../brain/router";
import { queryFact } from "./knowledge";
import type { WorldContext } from "./types";
import type { MediaLookFact } from "./observers/look";
import { MEDIA_LOOK_FACT } from "./observers/look";
import type { MediaMetadataFact } from "./observers/metadata";
import { MEDIA_METADATA_FACT } from "./observers/metadata";
import type { CompositionTextFact } from "./observers/text-summary";
import { COMPOSITION_TEXT_FACT } from "./observers/text-summary";
import type { CompositionCharacterFact } from "./observers/character";
import { COMPOSITION_CHARACTER_FACT } from "./observers/character";
import type { MediaFacesFact } from "./observers/faces";
import { MEDIA_FACES_FACT } from "./observers/faces";
import type { CompositionFormatFact } from "./observers/format";
import { COMPOSITION_FORMAT_FACT } from "./observers/format";
import type { MediaSceneFact } from "./observers/scene";
import { MEDIA_SCENE_FACT } from "./observers/scene";
import type { SystemCapabilitiesFact } from "./observers/system";
import { SYSTEM_CAPABILITIES_FACT, SYSTEM_TARGET_ID } from "./observers/system";
import type { UserAiProfileFact } from "./observers/user-profile";
import { USER_AI_PROFILE_FACT, USER_TARGET_ID } from "./observers/user-profile";
import type { ProjectMediaFact } from "./observers/project-media";
import { PROJECT_MEDIA_FACT, PROJECT_TARGET_ID } from "./observers/project-media";

const ESCALATE: BrainRouteResult = { kind: "escalate" };

/**
 * Lazy so this module stays importable under node/tsx for eval: world/index pulls lib/api
 * (import.meta.env) which only exists in the Vite bundle. Any load/query failure → escalate.
 */
async function worldContext(composition: TimelineComposition): Promise<WorldContext | null> {
  try {
    const { buildWorldContext } = await import("./index");
    return buildWorldContext(composition);
  } catch {
    return null;
  }
}

const ANALYZE_CLIP_RE = /^(?:analy[sz]e|inspect|measure) (.+)$/;
// P1 (real transcript 2026-07-18): face-count QUESTIONS answer from the measured fact —
// "how many persons can you see in clip 5", "analyze clip 4 and tell me how many people
// are there". The model tier guessed here ("I detected a single face"); the world tier
// answers from the measurement or says honestly that it can't.
const FACES_QUESTION_RE = /\b(?:how many|number of) (?:persons?|people|faces|humans?)\b/;
const CLIP_REF_RE = /\bclip (\d{1,3})\b/;
// Compound analyze tails that still mean "just analyze": "…and give me a summary", "…in short".
const SUMMARY_TAIL_RE =
  /^(?:and |then |just )*(?:tell me about it|give me (?:a |the )?(?:very )?(?:short )?summary|summar(?:y|ize|ise)(?: it| this)?|in (?:very )?short|briefly)(?: in (?:very )?short| briefly| please)?[.?!]?$/;
const LOOK_RE = /^what does (.+?) look like\??$/;
const ANALYZE_COMP_RE = /^(?:analy[sz]e|inspect|measure) (?:the |this |my )?(?:timeline|composition|comp|sequence|edit)$/;
// K2 state branches — whole-string anchored like everything else in this tier.
const ANALYZE_SYSTEM_RE =
  /^(?:analy[sz]e|inspect|check) (?:my |the |this )?(?:system|browser|machine|device|hardware)$|^what can (?:my|this) (?:browser|machine|device|system) (?:do|handle)$/;
const ANALYZE_PROJECT_RE = /^(?:analy[sz]e|inspect|measure) (?:my |the |this )?(?:project|media|footage|bin|assets|media pool)$/;
const ANALYZE_USAGE_RE = /^(?:analy[sz]e|show|inspect) my (?:ai )?(?:usage|stats|profile|learning)$/;

export async function routePromptWorld(prompt: string, context: BrainContext): Promise<BrainRouteResult> {
  const text = normalizePrompt(prompt);
  if (!text || text.length > 120) {
    return ESCALATE;
  }

  if (ANALYZE_COMP_RE.test(text)) {
    return analyzeComposition(context.composition);
  }
  if (ANALYZE_SYSTEM_RE.test(text)) {
    return analyzeSystem(context.composition);
  }
  if (ANALYZE_PROJECT_RE.test(text)) {
    return analyzeProject(context.composition);
  }
  if (ANALYZE_USAGE_RE.test(text)) {
    return analyzeUsage(context.composition);
  }

  // Face-count question with an explicit clip reference — a QUESTION, answered from the
  // measurement (or an honest "can't measure here"), never handed to a guessing model.
  if (FACES_QUESTION_RE.test(text)) {
    const clipRef = CLIP_REF_RE.exec(text);
    if (clipRef) {
      return answerFacesCount(context.composition, Number(clipRef[1]));
    }
    return ESCALATE; // no explicit clip → deictic; the model tiers own that resolution
  }

  const match = ANALYZE_CLIP_RE.exec(text) ?? LOOK_RE.exec(text);
  if (!match) {
    return ESCALATE;
  }
  const ordinal = parseExactClipPhrase(match[1]!);
  if (ordinal) {
    return analyzeClip(context.composition, ordinal);
  }
  // Compound: "analyze clip 5 and give me a summary in very short" — a benign question
  // tail must not eject the ask to the model tiers (whole-string discipline stays for
  // everything else: unknown/edit tails still escalate).
  const compound = /^(clip \d{1,3})\s+(.+)$/.exec(match[1]!);
  if (compound && SUMMARY_TAIL_RE.test(compound[2]!)) {
    const compoundOrdinal = parseExactClipPhrase(compound[1]!);
    if (compoundOrdinal) {
      return analyzeClip(context.composition, compoundOrdinal);
    }
  }
  return ESCALATE; // "analyze the pacing" etc. — creative asks belong to the model tiers
}

/**
 * The face-count answer — measured, honest about its limits. Face detection on sampled
 * frames is NOT a people census: small/turned-away faces are missed, so the wording is
 * "at least N" and says so.
 */
async function answerFacesCount(composition: TimelineComposition, ordinal: number): Promise<BrainRouteResult> {
  const layerId = layerIdForOrdinal(composition, ordinal);
  const layer = layerId ? findLayer(composition, layerId) : undefined;
  if (!layer) {
    return answer(`There's no clip ${ordinal} on the timeline to check.`, "world.faces-count");
  }
  if (!layer.assetId) {
    return answer(`**Clip ${ordinal}** (“${layer.name}”) is a ${layer.type} layer with no media — no faces to detect.`, "world.faces-count");
  }
  const ctx = await worldContext(composition);
  if (!ctx) {
    return ESCALATE;
  }
  const target = { kind: "asset" as const, id: layer.assetId };
  const faces = await queryFact<MediaFacesFact>({ type: MEDIA_FACES_FACT, target, budgetMs: 12_000 }, ctx);
  if (!faces) {
    // Never let a model guess a measurement: if detection can't run here, say so.
    return answer(
      `I couldn't run face detection on clip ${ordinal} right now (the on-device detector isn't available). I won't guess a count.`,
      "world.faces-count"
    );
  }
  const f = faces.fact.value;
  if (f.presenceShare === 0) {
    return answer(
      `I didn't detect any faces in the frames I sampled from clip ${ordinal}. Small or turned-away faces can escape detection — but on what I measured: none.`,
      "world.faces-count"
    );
  }
  return answer(
    [
      `I can see **at least ${f.maxFaces} face${f.maxFaces === 1 ? "" : "s"}** in the frames I sampled from clip ${ordinal} (a face is on screen ${(f.presenceShare * 100).toFixed(0)}% of the time).`,
      `\n_I detect faces, not exact people counts — small or background faces may be missed. ${faces.path === "cached" ? "Cached measurement" : "Fresh measurement"} · 0 tokens_`
    ].join("\n"),
    "world.faces-count"
  );
}

function findLayer(composition: TimelineComposition, layerId: string): TimelineLayer | undefined {
  for (const track of composition.tracks) {
    const found = track.layers.find((layer) => layer.id === layerId);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function answer(text: string, ruleId: string): BrainRouteResult {
  return { kind: "answer", text, tier: "world", ruleId };
}

async function analyzeClip(composition: TimelineComposition, ordinal: number): Promise<BrainRouteResult> {
  const layerId = layerIdForOrdinal(composition, ordinal);
  const layer = layerId ? findLayer(composition, layerId) : undefined;
  if (!layer) {
    return answer(`There's no clip ${ordinal} on the timeline to analyze.`, "world.analyze-clip");
  }
  if (!layer.assetId) {
    return answer(
      `**Clip ${ordinal}** (“${layer.name}”) is a ${layer.type} layer with no media source — nothing to measure. Try “describe clip ${ordinal}” for its timeline details.`,
      "world.analyze-clip"
    );
  }

  const ctx = await worldContext(composition);
  if (!ctx) {
    return ESCALATE;
  }
  const target = { kind: "asset" as const, id: layer.assetId };
  const [metadata, look, faces, scene] = await Promise.all([
    queryFact<MediaMetadataFact>({ type: MEDIA_METADATA_FACT, target, budgetMs: 250 }, ctx),
    queryFact<MediaLookFact>({ type: MEDIA_LOOK_FACT, target, budgetMs: 12_000 }, ctx),
    // L3 browser-ML purchase — first run pays the model download; cached per asset after.
    queryFact<MediaFacesFact>({ type: MEDIA_FACES_FACT, target, budgetMs: 12_000 }, ctx),
    queryFact<MediaSceneFact>({ type: MEDIA_SCENE_FACT, target, budgetMs: 12_000 }, ctx)
  ]);

  if (!metadata && !look) {
    // The world can't stand behind an answer (asset record missing, bytes unreadable) —
    // decline honestly instead of guessing; the model tiers take over.
    return ESCALATE;
  }

  const lines: string[] = [`**Clip ${ordinal} — measured analysis** (“${layer.name}”)`];
  if (metadata) {
    const m = metadata.fact.value;
    const fps = m.fps ? ` @ ${m.fps}fps` : "";
    const size = m.sizeBytes ? ` · ${(m.sizeBytes / (1024 * 1024)).toFixed(1)} MB` : "";
    lines.push(`- Source: ${m.fileName} — ${m.width}×${m.height}${fps}, ${m.durationSeconds.toFixed(2)}s${size}`);
    if (m.rotationDegrees) {
      lines.push(`- Container rotation: ${m.rotationDegrees}°`);
    }
  }
  if (look) {
    const v = look.fact.value;
    const temperatureLabel = v.temperature > 0.06 ? "warm" : v.temperature < -0.06 ? "cool" : "neutral";
    const saturationLabel = v.saturation < 0.18 ? "muted" : v.saturation > 0.45 ? "vivid" : "moderate";
    lines.push(
      `- Look: **${v.exposure}** exposure (mean luma ${(v.avgLuma * 100).toFixed(0)}%), contrast spread ${(v.contrast * 100).toFixed(0)}%, ${temperatureLabel} balance, ${saturationLabel} saturation`
    );
    // Scene ambience (inferred) — shown only when it says something a grade should care
    // about; "standard/neutral/moderate" footage adds no line (zero noise rule).
    if (scene && (scene.fact.value.lighting !== "standard" || scene.fact.value.palette !== "neutral")) {
      const s = scene.fact.value;
      const parts = [
        s.lighting === "low-light" ? "low-light footage — lift gently, don't crush shadows" : s.lighting === "bright" ? "bright footage — watch the highlights" : null,
        s.palette === "warm" ? "already warm-leaning" : s.palette === "cool" ? "already cool-leaning" : null
      ].filter(Boolean);
      lines.push(`- Scene: ${parts.join(", ")} (my read · ${Math.round(scene.fact.confidence * 100)}% sure)`);
    }
    if (faces) {
      const f = faces.fact.value;
      if (f.presenceShare > 0) {
        const size = f.avgFaceAreaShare >= 0.12 ? "close-up" : f.avgFaceAreaShare >= 0.03 ? "medium shot" : "in the distance";
        const region = f.dominantRegion === "center" ? "centered" : `on the ${f.dominantRegion}`;
        lines.push(
          `- People: ${f.maxFaces > 1 ? `at least ${f.maxFaces} faces` : "a face"} on screen ${(f.presenceShare * 100).toFixed(0)}% of the time — ${size}, ${region} (sampled frames; small faces may be missed)`
        );
      } else {
        lines.push(`- People: no faces detected in the sampled frames`);
      }
    }
    const sampled = look.fact.provenance.sampledRanges?.length ?? 0;
    lines.push(
      `\n_Measured on-device from ${sampled > 0 ? `${sampled} sampled frame${sampled === 1 ? "" : "s"}` : "the import record"} · ${look.path === "cached" ? "cached fact" : "fresh observation"} · 0 tokens_`
    );
  } else {
    lines.push(`\n_From the import record · 0 tokens (frame sampling unavailable for this source)_`);
  }
  return answer(lines.join("\n"), "world.analyze-clip");
}

async function analyzeSystem(composition: TimelineComposition): Promise<BrainRouteResult> {
  const ctx = await worldContext(composition);
  if (!ctx) {
    return ESCALATE;
  }
  const result = await queryFact<SystemCapabilitiesFact>(
    { type: SYSTEM_CAPABILITIES_FACT, target: { kind: "system", id: SYSTEM_TARGET_ID }, budgetMs: 250 },
    ctx
  );
  if (!result) {
    return ESCALATE;
  }
  const v = result.fact.value;
  const flag = (ok: boolean) => (ok ? "✓" : "✗");
  const lines = [
    `**This machine — measured capabilities**`,
    `- Compute: ${v.hardwareConcurrency} logical core(s)${v.deviceMemoryGb ? ` · ~${v.deviceMemoryGb} GB RAM (coarse)` : ""}`,
    `- Video: ${flag(v.webCodecs)} WebCodecs · ${flag(v.webGpu)} WebGPU · ${flag(v.offscreenCanvas)} OffscreenCanvas`,
    `- Runtime: ${flag(v.webWorkers)} Workers · ${flag(v.sharedArrayBuffer)} SharedArrayBuffer · ${flag(v.crossOriginIsolated)} cross-origin isolated · ${flag(v.opfs)} OPFS`,
    `- Voice: ${flag(v.speechRecognition)} speech recognition · ${flag(v.microphone)} microphone · ${flag(v.audioContext)} AudioContext`,
    `\n_Detected on-device · ${result.path === "cached" ? "cached fact" : "fresh detection"} · 0 tokens_`
  ];
  return answer(lines.join("\n"), "world.analyze-system");
}

async function analyzeProject(composition: TimelineComposition): Promise<BrainRouteResult> {
  const ctx = await worldContext(composition);
  if (!ctx) {
    return ESCALATE;
  }
  const result = await queryFact<ProjectMediaFact>(
    { type: PROJECT_MEDIA_FACT, target: { kind: "project", id: PROJECT_TARGET_ID }, budgetMs: 250 },
    ctx
  );
  if (!result) {
    return ESCALATE;
  }
  const v = result.fact.value;
  if (v.assetCount === 0) {
    return answer(`The media bin is empty — nothing to measure yet.`, "world.analyze-project");
  }
  const minutes = Math.floor(v.totalFootageSeconds / 60);
  const seconds = Math.round(v.totalFootageSeconds % 60);
  const sources = Object.entries(v.bySource)
    .map(([source, count]) => `${count} ${source}`)
    .join(", ");
  const lines = [
    `**Project media — measured summary**`,
    `- ${v.assetCount} asset(s): ${v.videoCount} video, ${v.imageCount} image, ${v.audioCount} audio${v.otherCount > 0 ? `, ${v.otherCount} other` : ""}`,
    `- Footage: ${minutes > 0 ? `${minutes}m ` : ""}${seconds}s total${v.totalSizeBytes > 0 ? ` · ${(v.totalSizeBytes / (1024 * 1024)).toFixed(0)} MB on disk` : ""}`,
    `- Resolution ceiling: ${v.maxWidth}×${v.maxHeight}`,
    `- Sources: ${sources}`,
    `\n_Measured on-device · ${result.path === "cached" ? "cached fact" : "fresh observation"} · 0 tokens_`
  ];
  return answer(lines.join("\n"), "world.analyze-project");
}

async function analyzeUsage(composition: TimelineComposition): Promise<BrainRouteResult> {
  const ctx = await worldContext(composition);
  if (!ctx) {
    return ESCALATE;
  }
  const result = await queryFact<UserAiProfileFact>(
    { type: USER_AI_PROFILE_FACT, target: { kind: "user", id: USER_TARGET_ID }, budgetMs: 250 },
    ctx
  );
  if (!result) {
    return ESCALATE;
  }
  const v = result.fact.value;
  const lines = [
    `**Your AI profile — from on-device learning data**`,
    `- Local tiers resolved **${Math.round(v.instantShare * 100)}%** of recent requests (~${v.estTokensSaved.toLocaleString()} tokens saved)`,
    `- ${v.rulesTracked} rule(s) tracked: ${v.totalFired} fired · ${v.totalConfirmed} 👍 · ${v.totalRejected} 👎`,
    v.distrustedRuleIds.length > 0
      ? `- Rules you've turned off by feedback: ${v.distrustedRuleIds.join(", ")}`
      : `- No rules distrusted — every fast path is holding up`,
    `\n_All data stays on this device · ${result.path === "cached" ? "cached fact" : "fresh summary"} · 0 tokens_`
  ];
  return answer(lines.join("\n"), "world.analyze-usage");
}

// Plain-language surface labels for the inferred edit-style fact. The fact keeps its compact
// internal vocabulary ("caption-driven"/"long-take") — only the chat line speaks human.
const EDIT_PROFILE_LABELS: Record<CompositionCharacterFact["profile"], string> = {
  "caption-driven": "built around text/captions",
  mixed: "a mix of footage and text",
  "footage-driven": "mostly raw footage"
};
const EDIT_PACING_LABELS: Record<CompositionCharacterFact["pacing"], string> = {
  "fast-cut": "quick cuts",
  moderate: "medium-paced cuts",
  "long-take": "long unhurried shots"
};
const FORMAT_LABELS: Record<CompositionFormatFact["format"], string> = {
  "talking-head": "talking-head — someone is on camera most of the time",
  "b-roll": "b-roll — footage without people on camera",
  mixed: "mixed — people appear, but it's not a presenter video"
};

async function analyzeComposition(composition: TimelineComposition): Promise<BrainRouteResult> {
  const ctx = await worldContext(composition);
  if (!ctx) {
    return ESCALATE;
  }
  const result = await queryFact<CompositionTextFact>(
    { type: COMPOSITION_TEXT_FACT, target: { kind: "composition", id: composition.id }, budgetMs: 250 },
    ctx
  );
  if (!result) {
    return ESCALATE;
  }
  const v = result.fact.value;
  const clipTotal = composition.tracks.reduce((sum, track) => sum + track.layers.length, 0);
  const coverage = v.timelineSeconds > 0 ? Math.round((v.coveredSeconds / v.timelineSeconds) * 100) : 0;
  // K5 inference: the derived L4 character fact (confidence-propagated; labeled as an
  // inference, never dressed up as a measurement — honest-labels invariant).
  const character = await queryFact<CompositionCharacterFact>(
    { type: COMPOSITION_CHARACTER_FACT, target: { kind: "composition", id: composition.id }, budgetMs: 500 },
    ctx
  );
  // Two-input inference (faces × text) — its faces input may trigger a fresh on-device ML
  // run on the dominant footage; the budget prices that honestly (cached after the first).
  const format = await queryFact<CompositionFormatFact>(
    { type: COMPOSITION_FORMAT_FACT, target: { kind: "composition", id: composition.id }, budgetMs: 12_000 },
    ctx
  );
  const lines = [
    `**Timeline — measured analysis**`,
    `- ${clipTotal} layer(s) across ${composition.tracks.length} track(s), ${v.timelineSeconds.toFixed(1)}s long`,
    v.textLayerCount > 0
      ? `- Text: ${v.textLayerCount} text layer(s), ${v.wordCount} words covering ${coverage}% of the timeline (${v.wordsPerMinute.toFixed(0)} wpm over covered spans)`
      : `- Text: none on the timeline`,
    ...(character
      ? [
          `- Edit style: **${EDIT_PROFILE_LABELS[character.fact.value.profile]}**, ${EDIT_PACING_LABELS[character.fact.value.pacing]} (my read of the timeline · ${Math.round(character.fact.confidence * 100)}% sure)`
        ]
      : []),
    ...(format
      ? [
          `- Format: **${FORMAT_LABELS[format.fact.value.format]}** (from face detection on the main footage · ${Math.round(format.fact.confidence * 100)}% sure)`
        ]
      : []),
    `\n_Measured on-device · ${result.path === "cached" ? "cached fact" : "fresh observation"} · 0 tokens_`
  ];
  return answer(lines.join("\n"), "world.analyze-comp");
}
