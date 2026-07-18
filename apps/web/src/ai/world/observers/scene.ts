/**
 * Orreris OS inference rule — scene ambience (K5/SDK v1; L4). Derives a grading-relevant
 * read of an ASSET's footage from the measured look fact: lighting band, palette lean, and
 * energy. It's the first ASSET-level inference (character/format are composition-level),
 * and the first written against the frozen SDK contract (ORRERIS_SDK.md) end to end:
 * single input bought inline, confidence = prior × evidence, dependency recorded,
 * pure exported classifier for world:eval.
 *
 * Deliberately modest: this is ambience classification from measured pixels — bands wide,
 * evidence kept in the value — NOT scene understanding ("night"/"indoor" would be a guess).
 */

import { queryFact } from "../knowledge";
import type { ObservedFact, WorldObserver } from "../types";
import { lookObserver, MEDIA_LOOK_FACT, type MediaLookFact } from "./look";

export const MEDIA_SCENE_FACT = "media.scene";

export interface MediaSceneFact {
  lighting: "low-light" | "bright" | "standard";
  palette: "warm" | "cool" | "neutral";
  energy: "vivid" | "muted" | "moderate";
  /** The evidence, kept in the value so consumers (and WHY) can show the arithmetic. */
  avgLuma: number;
  temperature: number;
  saturation: number;
}

const RULE_PRIOR = 0.7;

export function classifyScene(look: Pick<MediaLookFact, "avgLuma" | "temperature" | "saturation">): MediaSceneFact {
  return {
    lighting: look.avgLuma < 0.3 ? "low-light" : look.avgLuma > 0.62 ? "bright" : "standard",
    palette: look.temperature > 0.06 ? "warm" : look.temperature < -0.06 ? "cool" : "neutral",
    energy: look.saturation > 0.45 ? "vivid" : look.saturation < 0.18 ? "muted" : "moderate",
    avgLuma: look.avgLuma,
    temperature: look.temperature,
    saturation: look.saturation
  };
}

export const sceneObserver: WorldObserver = {
  id: "scene-inference@builtin",
  version: 1,
  factTypes: [MEDIA_SCENE_FACT],
  fidelity: 4,
  // The look input may need a fresh frame sample — price the chain, not just the math.
  estCostMs: 1_600,
  estConfidence: 0.7,
  signature(target, ctx) {
    // Input signature IS the inference's signature: new footage bytes → new scene read.
    return lookObserver.signature(target, ctx);
  },
  async observe(target, ctx) {
    // Buy the input through the Knowledge Service — "inline" (we're inside the pump).
    const look = await queryFact<MediaLookFact>({ type: MEDIA_LOOK_FACT, target, budgetMs: 2_000 }, ctx, "inline");
    if (!look) {
      return []; // no evidence → no inference (decline, never guess)
    }
    const fact: ObservedFact<MediaSceneFact> = {
      type: MEDIA_SCENE_FACT,
      value: classifyScene(look.fact.value),
      confidence: RULE_PRIOR * look.fact.confidence,
      dependencies: [look.fact.id]
    };
    return [fact];
  }
};
