/**
 * Orreris OS inference rule — composition FORMAT (K5, L4). The first TWO-input inference:
 * consumes the face-presence fact of the composition's dominant video asset (L3 browser-ML)
 * plus the text-summary fact (L2), and infers what kind of video this is:
 *
 *   "talking-head"  — a face holds the screen most of the time at medium+ size
 *   "b-roll"        — footage with (almost) nobody on camera
 *   "mixed"         — some people, not a presenter format
 *
 * New precedent this rule sets: with several inputs, confidence propagates through the
 * WEAKEST link (rule prior × min(input confidences)) — an inference chain is never more
 * certain than its shakiest evidence. Dependencies record BOTH input fact ids, so either
 * a footage change or a text edit cascade-kills the derived fact.
 *
 * The classification itself is a pure exported function (`classifyFormat`) so world:eval
 * verifies the thresholds under node, where the ML input path honestly declines.
 */

import type { TimelineComposition, TimelineLayer } from "@orreris/shared";
import { queryFact } from "../knowledge";
import type { ObservedFact, WorldContext, WorldObserver, WorldTarget } from "../types";
import { facesObserver, MEDIA_FACES_FACT, type MediaFacesFact } from "./faces";
import { COMPOSITION_TEXT_FACT, textSummaryObserver, type CompositionTextFact } from "./text-summary";

export const COMPOSITION_FORMAT_FACT = "composition.format";

export interface CompositionFormatFact {
  format: "talking-head" | "b-roll" | "mixed";
  /** Evidence kept in the value so consumers (and WHY) can show the arithmetic. */
  facePresenceShare: number;
  faceAreaShare: number;
  textCoverageShare: number;
  /** The asset the faces were measured on (the composition's dominant video source). */
  dominantAssetId: string;
}

const RULE_PRIOR = 0.75;

export function classifyFormat(faces: Pick<MediaFacesFact, "presenceShare" | "avgFaceAreaShare">): CompositionFormatFact["format"] {
  if (faces.presenceShare >= 0.7 && faces.avgFaceAreaShare >= 0.03) {
    return "talking-head";
  }
  if (faces.presenceShare < 0.2) {
    return "b-roll";
  }
  return "mixed";
}

/** The video layer with the most screen time — the footage that defines the edit. */
export function dominantVideoLayer(composition: TimelineComposition): TimelineLayer | undefined {
  let best: TimelineLayer | undefined;
  for (const track of composition.tracks) {
    for (const layer of track.layers) {
      if (layer.type !== "video" || !layer.assetId) {
        continue;
      }
      if (!best || layer.durationSeconds > best.durationSeconds) {
        best = layer;
      }
    }
  }
  return best;
}

function compositionFor(target: WorldTarget, ctx: WorldContext): TimelineComposition | undefined {
  if (target.kind !== "composition") {
    return undefined;
  }
  return ctx.composition && ctx.composition.id === target.id ? ctx.composition : undefined;
}

export const formatObserver: WorldObserver = {
  id: "format-inference@builtin",
  version: 1,
  factTypes: [COMPOSITION_FORMAT_FACT],
  fidelity: 4,
  // The faces input may need a fresh ML run — price the whole chain honestly.
  estCostMs: 4_200,
  estConfidence: 0.75,
  signature(target, ctx) {
    const composition = compositionFor(target, ctx);
    if (!composition) {
      return null;
    }
    const dominant = dominantVideoLayer(composition);
    if (!dominant?.assetId) {
      return null; // no video footage → the format question doesn't apply
    }
    // Composite input signature: either input changing (footage swap, text edit) invalidates
    // on read; the store-side dependency cascade catches the same from the other direction.
    const facesSignature = facesObserver.signature({ kind: "asset", id: dominant.assetId }, ctx);
    const textSignature = textSummaryObserver.signature(target, ctx);
    if (facesSignature === null || textSignature === null) {
      return null; // an input's access path doesn't exist here (e.g. no DOM) → decline
    }
    return `${facesSignature}|${textSignature}|${dominant.assetId}`;
  },
  async observe(target, ctx) {
    const composition = compositionFor(target, ctx);
    if (!composition) {
      return [];
    }
    const dominant = dominantVideoLayer(composition);
    if (!dominant?.assetId) {
      return [];
    }
    // Buy both inputs through the Knowledge Service — "inline" because this observe()
    // already runs inside the perception pump (nested scheduling deadlocks it).
    const faces = await queryFact<MediaFacesFact>(
      { type: MEDIA_FACES_FACT, target: { kind: "asset", id: dominant.assetId }, budgetMs: 8_000 },
      ctx,
      "inline"
    );
    const text = await queryFact<CompositionTextFact>({ type: COMPOSITION_TEXT_FACT, target, budgetMs: 250 }, ctx, "inline");
    if (!faces || !text) {
      return []; // missing evidence → no inference (precision-first: decline, never guess)
    }
    const t = text.fact.value;
    const value: CompositionFormatFact = {
      format: classifyFormat(faces.fact.value),
      facePresenceShare: faces.fact.value.presenceShare,
      faceAreaShare: faces.fact.value.avgFaceAreaShare,
      textCoverageShare: t.timelineSeconds > 0 ? t.coveredSeconds / t.timelineSeconds : 0,
      dominantAssetId: dominant.assetId
    };
    const fact: ObservedFact<CompositionFormatFact> = {
      type: COMPOSITION_FORMAT_FACT,
      value,
      // Weakest-link law: prior × min(inputs) — never more certain than the shakiest evidence.
      confidence: RULE_PRIOR * Math.min(faces.fact.confidence, text.fact.confidence),
      dependencies: [faces.fact.id, text.fact.id]
    };
    return [fact];
  }
};
