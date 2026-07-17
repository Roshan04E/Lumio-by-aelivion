/**
 * Kimera OS — the World Model's first brain consumer (K1). An async local tier that answers
 * "analyze clip 3" / "what does clip 2 look like" / "analyze the timeline" from MEASURED
 * facts — metadata (L0), sampled-frame look (L1), text coverage (L2) — zero tokens, honest
 * provenance in the answer ("3 sampled frames", "from the import record").
 *
 * Precision-first like every tier: the trigger regexes are whole-string anchored, the clip
 * phrase must parse exactly, and anything else escalates silently to the normal model path.
 * Answers here are read-only (kind "answer") — the world route NEVER mutates.
 */

import { layerIdForOrdinal, type TimelineComposition, type TimelineLayer } from "@kimera-by-aelivion/shared";
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
const LOOK_RE = /^what does (.+?) look like\??$/;
const ANALYZE_COMP_RE = /^(?:analy[sz]e|inspect|measure) (?:the |this |my )?(?:timeline|composition|comp|sequence|edit)$/;

export async function routePromptWorld(prompt: string, context: BrainContext): Promise<BrainRouteResult> {
  const text = normalizePrompt(prompt);
  if (!text || text.length > 120) {
    return ESCALATE;
  }

  if (ANALYZE_COMP_RE.test(text)) {
    return analyzeComposition(context.composition);
  }

  const match = ANALYZE_CLIP_RE.exec(text) ?? LOOK_RE.exec(text);
  if (!match) {
    return ESCALATE;
  }
  const ordinal = parseExactClipPhrase(match[1]!);
  if (!ordinal) {
    return ESCALATE; // "analyze the pacing" etc. — creative asks belong to the model tiers
  }
  return analyzeClip(context.composition, ordinal);
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
  const [metadata, look] = await Promise.all([
    queryFact<MediaMetadataFact>({ type: MEDIA_METADATA_FACT, target, budgetMs: 250 }, ctx),
    queryFact<MediaLookFact>({ type: MEDIA_LOOK_FACT, target, budgetMs: 12_000 }, ctx)
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
    const sampled = look.fact.provenance.sampledRanges?.length ?? 0;
    lines.push(
      `\n_Measured on-device from ${sampled > 0 ? `${sampled} sampled frame${sampled === 1 ? "" : "s"}` : "the import record"} · ${look.path === "cached" ? "cached fact" : "fresh observation"} · 0 tokens_`
    );
  } else {
    lines.push(`\n_From the import record · 0 tokens (frame sampling unavailable for this source)_`);
  }
  return answer(lines.join("\n"), "world.analyze-clip");
}

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
  const lines = [
    `**Timeline — measured analysis**`,
    `- ${clipTotal} layer(s) across ${composition.tracks.length} track(s), ${v.timelineSeconds.toFixed(1)}s long`,
    v.textLayerCount > 0
      ? `- Text: ${v.textLayerCount} text layer(s), ${v.wordCount} words covering ${coverage}% of the timeline (${v.wordsPerMinute.toFixed(0)} wpm over covered spans)`
      : `- Text: none on the timeline`,
    `\n_Measured on-device · ${result.path === "cached" ? "cached fact" : "fresh observation"} · 0 tokens_`
  ];
  return answer(lines.join("\n"), "world.analyze-comp");
}
