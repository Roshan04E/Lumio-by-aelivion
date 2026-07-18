/**
 * Kimera OS — MotionIntent + deterministic compiler (K3 motion dialect, the second
 * GradeIntent-class craft compiler; see KIMERA_OS.md → Layer 5).
 *
 * The AI (or a tier-0 rule) authors a COMPACT intent — "entrance, pop, 0.6s" — and this
 * module expands it deterministically into ORDINARY layer keyframes (the same
 * `TimelineKeyframeV2` records the graph editor edits), applied via the `applyMotion`
 * timeline action. Renderer parity is free: both renderers already evaluate layer
 * keyframes through the shared animation evaluator; nothing new touches them.
 *
 * The LLM never chooses keyframe values. It says "pop"; this compiler does the craft.
 */

import { z } from "zod";
import type { TimelineLayer } from "../types";

/* --------------------------------------------------------------------- vocabulary */

export const MOTION_KINDS = ["entrance", "exit", "emphasis"] as const;
export type MotionKind = (typeof MOTION_KINDS)[number];

/** Canonical styles per kind — the registry the closure validates against. */
export const MOTION_STYLES: Record<MotionKind, readonly string[]> = {
  entrance: ["fade", "slide", "scale", "pop", "spin", "drift"],
  exit: ["fade", "slide", "scale", "spin", "drift"],
  emphasis: ["pulse", "shake", "spin"]
};

/** Style aliases — vocabulary AIs/users plausibly say. Data, not code. */
const STYLE_ALIASES: Record<string, string> = {
  appear: "fade",
  dissolve: "fade",
  "fade in": "fade",
  "fade out": "fade",
  zoom: "scale",
  grow: "scale",
  shrink: "scale",
  bounce: "pop",
  spring: "pop",
  fly: "slide",
  sweep: "slide",
  swipe: "slide",
  push: "slide",
  float: "drift",
  drift: "drift",
  rotate: "spin",
  twirl: "spin",
  whirl: "spin",
  wiggle: "shake",
  jiggle: "shake",
  vibrate: "shake",
  pump: "pulse",
  beat: "pulse",
  heartbeat: "pulse",
  breathe: "pulse"
};

export type MotionDirection = "left" | "right" | "up" | "down";

export const motionIntentSchema = z
  .object({
    kind: z.enum(MOTION_KINDS),
    /** Style name — canonical or alias; closure canonicalizes (never guess downstream). */
    style: z.string().min(1),
    /** For slide/drift: where the motion comes FROM (entrance) or goes TO (exit). */
    direction: z.enum(["left", "right", "up", "down"]).optional(),
    durationSeconds: z.number().min(0.1).max(3).optional(),
    /** 0..1 amplitude scale. Default 0.7 — assertive but not cartoonish. */
    intensity: z.number().min(0).max(1).optional()
  })
  .strict();

export type MotionIntent = z.infer<typeof motionIntentSchema>;

export interface MotionStyleResolution {
  style: string;
  repair?: string | undefined;
}

/** Canonicalize a style for a kind: exact → alias. Null = genuinely unknown for that kind. */
export function resolveMotionStyle(kind: MotionKind, requested: string): MotionStyleResolution | null {
  const key = requested.toLowerCase().trim();
  const canon = MOTION_STYLES[kind];
  if ((canon as readonly string[]).includes(key)) {
    return { style: key };
  }
  const alias = STYLE_ALIASES[key];
  if (alias && (canon as readonly string[]).includes(alias)) {
    return { style: alias, repair: `style "${requested}" → ${alias}` };
  }
  return null;
}

/* --------------------------------------------------------------------- compiler */

/** The keyframe shape this compiler emits — mirrors createLayerKeyframe's output. */
export interface CompiledMotionKeyframe {
  property: "position.x" | "position.y" | "scale" | "rotation" | "opacity";
  /** Layer-LOCAL seconds. */
  timeSeconds: number;
  value: number;
  interpolation: "linear" | "easeIn" | "easeOut" | "easeInOut";
}

const DEFAULT_DURATION: Record<MotionKind, number> = { entrance: 0.6, exit: 0.6, emphasis: 0.8 };

/**
 * Expand a canonicalized intent into keyframes for a concrete layer. Deterministic; uses the
 * layer's OWN base transform as the rest state so motion always settles exactly where the
 * user placed the clip. Duration is clamped to half the clip so entrance+exit can coexist.
 */
export function compileMotionIntent(intent: MotionIntent, layer: TimelineLayer): CompiledMotionKeyframe[] {
  const kind = intent.kind;
  const k = intent.intensity ?? 0.7;
  const clipSeconds = Math.max(0.1, layer.durationSeconds);
  const d = Math.min(intent.durationSeconds ?? DEFAULT_DURATION[kind], clipSeconds / 2);
  const base = layer.transform;
  const frames: CompiledMotionKeyframe[] = [];

  /** Map an entrance-shaped local offset (0=motion start … d=settled) onto the timeline. */
  const at = (offset: number): number => {
    if (kind === "entrance") return offset;
    if (kind === "exit") return clipSeconds - d + (d - offset); // mirrored at the tail
    return clipSeconds / 2 - d / 2 + offset; // emphasis: centered
  };
  const settleEase = kind === "exit" ? "easeIn" : "easeOut";
  const push = (property: CompiledMotionKeyframe["property"], offset: number, value: number, interpolation: CompiledMotionKeyframe["interpolation"] = settleEase) => {
    frames.push({ property, timeSeconds: Math.max(0, at(offset)), value, interpolation });
  };

  const direction: MotionDirection = intent.direction ?? "left";
  const axis: "position.x" | "position.y" = direction === "left" || direction === "right" ? "position.x" : "position.y";
  const basePos = axis === "position.x" ? base.position.x : base.position.y;
  const sign = direction === "left" || direction === "up" ? -1 : 1;

  switch (intent.style) {
    case "fade":
      push("opacity", 0, 0);
      push("opacity", d, base.opacity);
      break;
    case "scale":
      push("scale", 0, base.scale * Math.max(0.05, 1 - 0.45 * k));
      push("scale", d, base.scale);
      push("opacity", 0, 0);
      push("opacity", d * 0.6, base.opacity);
      break;
    case "pop":
      push("scale", 0, base.scale * 0.3);
      push("scale", d * 0.7, base.scale * (1 + 0.12 * k), "easeOut");
      push("scale", d, base.scale, "easeInOut");
      push("opacity", 0, 0);
      push("opacity", d * 0.4, base.opacity);
      break;
    case "slide":
      push(axis, 0, basePos + sign * 45 * k);
      push(axis, d, basePos);
      push("opacity", 0, 0);
      push("opacity", d * 0.6, base.opacity);
      break;
    case "drift":
      push(axis, 0, basePos + sign * 10 * k);
      push(axis, d, basePos);
      push("opacity", 0, 0);
      push("opacity", d, base.opacity);
      break;
    case "spin":
      if (kind === "emphasis") {
        push("rotation", 0, base.rotation, "easeInOut");
        push("rotation", d, base.rotation + 360 * (k >= 0.5 ? 1 : 0.5), "easeInOut");
      } else {
        push("rotation", 0, base.rotation - 180 * k);
        push("rotation", d, base.rotation);
        push("opacity", 0, 0);
        push("opacity", d * 0.6, base.opacity);
      }
      break;
    case "pulse":
      push("scale", 0, base.scale, "easeInOut");
      push("scale", d / 2, base.scale * (1 + 0.1 * k), "easeInOut");
      push("scale", d, base.scale, "easeInOut");
      break;
    case "shake": {
      const amp = 2.2 * k;
      const steps = [0, -amp, amp, -amp * 0.5, 0];
      steps.forEach((offset, index) => {
        push("position.x", (d * index) / (steps.length - 1), base.position.x + offset, "linear");
      });
      break;
    }
    default:
      // Unreachable when callers canonicalize via resolveMotionStyle first (the closure law).
      break;
  }

  // Exits need no value reversal: `at()` mirrors the time axis (offset 0 = the away pose at
  // the clip END, offset d = settled at end−d), so the entrance-shaped pushes above already
  // read correctly in reverse. One mapping, no double bookkeeping.
  return frames;
}
