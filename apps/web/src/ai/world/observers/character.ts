/**
 * Orreris OS inference rule — composition character (K5, L4 "meaning" rung of the fidelity
 * ladder; ORRERIS_OS.md → Layer 2). The first observer that derives a fact FROM another
 * fact rather than from media: it consumes the L2 text-summary fact (bought through the
 * Knowledge Service like any consumer — cache hit when fresh) plus the composition's own
 * timing, and infers WHAT KIND of edit this is:
 *
 *   profile: "caption-driven" | "mixed" | "footage-driven"
 *   pacing:  "fast-cut" | "moderate" | "long-take"
 *
 * The three laws it demonstrates for every future inference rule:
 *  1. **Confidence propagates** — the derived confidence is the rule prior (0.8) × the input
 *     fact's confidence; an inference is never more certain than its evidence.
 *  2. **Dependencies cascade** — the derived fact records the input fact's id; when a text
 *     edit invalidates the text summary, the character fact dies with it automatically.
 *  3. **Meaning stays honest** — thresholds are wide bands, and the value carries the raw
 *     shares so any consumer (or the WHY trace) can show the arithmetic.
 */

import type { TimelineComposition } from "@orreris/shared";
import { queryFact } from "../knowledge";
import type { ObservedFact, WorldContext, WorldObserver, WorldTarget } from "../types";
import { COMPOSITION_TEXT_FACT, textSummaryObserver, type CompositionTextFact } from "./text-summary";

export const COMPOSITION_CHARACTER_FACT = "composition.character";

export interface CompositionCharacterFact {
  profile: "caption-driven" | "mixed" | "footage-driven";
  pacing: "fast-cut" | "moderate" | "long-take";
  /** The evidence, kept in the value so consumers can show the arithmetic. */
  textCoverageShare: number;
  averageClipSeconds: number;
}

const RULE_PRIOR = 0.8;

function compositionFor(target: WorldTarget, ctx: WorldContext): TimelineComposition | undefined {
  if (target.kind !== "composition") {
    return undefined;
  }
  return ctx.composition && ctx.composition.id === target.id ? ctx.composition : undefined;
}

function averageClipSeconds(composition: TimelineComposition): number {
  const layers = composition.tracks.flatMap((track) => track.layers);
  if (layers.length === 0) {
    return 0;
  }
  return layers.reduce((sum, layer) => sum + layer.durationSeconds, 0) / layers.length;
}

export const characterObserver: WorldObserver = {
  id: "character-inference@builtin",
  version: 1,
  factTypes: [COMPOSITION_CHARACTER_FACT],
  fidelity: 4,
  estCostMs: 10,
  estConfidence: 0.8,
  signature(target, ctx) {
    const composition = compositionFor(target, ctx);
    if (!composition) {
      return null;
    }
    // The inference's input signature = its INPUT observer's signature + the timing shape it
    // reads directly. Any input change (text edit, retime) invalidates this fact on read —
    // and store-side dependency cascade catches the same change from the other direction.
    const inputSignature = textSummaryObserver.signature(target, ctx);
    if (inputSignature === null) {
      return null;
    }
    return `${inputSignature}|avg:${averageClipSeconds(composition).toFixed(3)}`;
  },
  async observe(target, ctx) {
    const composition = compositionFor(target, ctx);
    if (!composition) {
      return [];
    }
    // Buy the input through the Knowledge Service — cached when fresh, re-measured when not.
    // MUST be "inline": this observe() already runs inside the perception pump; a nested
    // scheduled job would deadlock it (caught by world:eval the day this rule was written).
    const text = await queryFact<CompositionTextFact>({ type: COMPOSITION_TEXT_FACT, target, budgetMs: 250 }, ctx, "inline");
    if (!text) {
      return []; // no evidence → no inference (precision-first: decline, never guess)
    }
    const t = text.fact.value;
    const coverage = t.timelineSeconds > 0 ? t.coveredSeconds / t.timelineSeconds : 0;
    const avg = averageClipSeconds(composition);
    const value: CompositionCharacterFact = {
      profile: t.textLayerCount >= 3 && coverage >= 0.6 ? "caption-driven" : coverage >= 0.25 ? "mixed" : "footage-driven",
      pacing: avg > 0 && avg < 2 ? "fast-cut" : avg > 6 ? "long-take" : "moderate",
      textCoverageShare: coverage,
      averageClipSeconds: avg
    };
    const fact: ObservedFact<CompositionCharacterFact> = {
      type: COMPOSITION_CHARACTER_FACT,
      value,
      confidence: RULE_PRIOR * text.fact.confidence,
      dependencies: [text.fact.id]
    };
    return [fact];
  }
};
