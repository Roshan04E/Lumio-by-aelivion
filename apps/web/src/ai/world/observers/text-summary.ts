/**
 * Orreris OS observer — composition text/speech summary (L2 transcript-derived, cheap +
 * deterministic). Derives spoken/on-screen-text facts from the text layers already on the
 * composition (captions land as text layers via applyCaptionTrackToComposition): how much
 * text, how many words, what share of the timeline it covers, effective words-per-minute.
 * No model runs — this is the "reuse what the transcript pipeline already produced" rung of
 * the fidelity ladder; a real ASR observer can register later as a higher-cost access path.
 */

import type { TimelineComposition, TimelineLayer } from "@orreris/shared";
import type { WorldContext, WorldObserver, WorldTarget } from "../types";
import { fnv1a } from "../types";

export const COMPOSITION_TEXT_FACT = "composition.textSummary";

export interface CompositionTextFact {
  textLayerCount: number;
  wordCount: number;
  /** Seconds of the timeline covered by at least one text layer (interval union). */
  coveredSeconds: number;
  /** Words per minute over the covered span (0 when nothing is covered). */
  wordsPerMinute: number;
  /** Total comp duration derived from the last layer end, seconds. */
  timelineSeconds: number;
}

function compositionFor(target: WorldTarget, ctx: WorldContext): TimelineComposition | undefined {
  if (target.kind !== "composition") {
    return undefined;
  }
  return ctx.composition && ctx.composition.id === target.id ? ctx.composition : undefined;
}

function textLayers(composition: TimelineComposition): TimelineLayer[] {
  const layers: TimelineLayer[] = [];
  for (const track of composition.tracks) {
    for (const layer of track.layers) {
      if (layer.type === "text" && (layer.text ?? "").trim().length > 0) {
        layers.push(layer);
      }
    }
  }
  return layers;
}

export const textSummaryObserver: WorldObserver = {
  id: "text-summary@builtin",
  version: 1,
  factTypes: [COMPOSITION_TEXT_FACT],
  fidelity: 2,
  estCostMs: 2,
  estConfidence: 0.95,
  signature(target, ctx) {
    const composition = compositionFor(target, ctx);
    if (!composition) {
      return null;
    }
    const parts = textLayers(composition).map(
      (layer) => `${layer.id}:${layer.startSeconds}:${layer.durationSeconds}:${layer.text ?? ""}`
    );
    return fnv1a(parts.join("|") || "empty");
  },
  async observe(target, ctx) {
    const composition = compositionFor(target, ctx);
    if (!composition) {
      return [];
    }
    const layers = textLayers(composition);
    let wordCount = 0;
    const intervals: Array<[number, number]> = [];
    let timelineEnd = 0;
    for (const track of composition.tracks) {
      for (const layer of track.layers) {
        timelineEnd = Math.max(timelineEnd, layer.startSeconds + layer.durationSeconds);
      }
    }
    for (const layer of layers) {
      wordCount += (layer.text ?? "").trim().split(/\s+/).filter(Boolean).length;
      intervals.push([layer.startSeconds, layer.startSeconds + layer.durationSeconds]);
    }
    const coveredSeconds = unionSeconds(intervals);
    const value: CompositionTextFact = {
      textLayerCount: layers.length,
      wordCount,
      coveredSeconds,
      wordsPerMinute: coveredSeconds > 0 ? (wordCount / coveredSeconds) * 60 : 0,
      timelineSeconds: timelineEnd
    };
    return [{ type: COMPOSITION_TEXT_FACT, value, confidence: 0.95 }];
  }
};

function unionSeconds(intervals: Array<[number, number]>): number {
  if (intervals.length === 0) {
    return 0;
  }
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [currentStart, currentEnd] = sorted[0]!;
  for (const [start, end] of sorted.slice(1)) {
    if (start <= currentEnd) {
      currentEnd = Math.max(currentEnd, end);
    } else {
      total += currentEnd - currentStart;
      currentStart = start;
      currentEnd = end;
    }
  }
  total += currentEnd - currentStart;
  return total;
}
