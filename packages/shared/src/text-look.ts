/**
 * Orreris OS — built-in text looks + resolver (K3 text dialect vocabulary).
 *
 * A text look is a NAMED, reusable text treatment — the text-domain sibling of the creative
 * color looks (color/looks.ts). Each look is plain `TextStyleFields` data baked onto a text
 * layer via `applyTextStyle`, so results are ordinary editable layer fields (no live link,
 * no new render path — both renderers already draw these fields).
 *
 * Same closure discipline as color looks: `resolveTextLookName` (exact → case/format-
 * insensitive → alias) is the ONE shared resolution for the blueprint text dialect, the
 * `applyTextLook` action's validation/canonicalization, and any future picker. Unknown
 * names are compile/validation errors carrying this library — never a silent default.
 */

import { z } from "zod";
import type { TextStyleFields } from "./types";

export interface TextLook {
  name: string;
  description: string;
  style: TextStyleFields;
}

export const TEXT_LOOKS: TextLook[] = [
  {
    name: "Headline",
    description: "Big bold hero title with a soft drop shadow.",
    style: {
      fontWeight: 800,
      fontSize: 84,
      color: "#ffffff",
      shadowColor: "rgba(0,0,0,0.45)",
      shadowBlur: 24,
      shadowOffsetX: 0,
      shadowOffsetY: 6,
      textAlign: "center"
    }
  },
  {
    name: "Subtitle",
    description: "Quiet secondary line under a headline.",
    style: { fontWeight: 500, fontSize: 40, color: "#e5e7eb", textAlign: "center" }
  },
  {
    name: "Caption Pill",
    description: "Small caption on a rounded dark pill — social-safe.",
    style: {
      fontWeight: 600,
      fontSize: 34,
      color: "#ffffff",
      backgroundColor: "rgba(0,0,0,0.65)",
      backgroundPaddingEm: 0.45,
      backgroundRadiusEm: 0.6,
      textAlign: "center"
    }
  },
  {
    name: "Lower Third",
    description: "Broadcast-style name bar, left aligned.",
    style: {
      fontWeight: 700,
      fontSize: 44,
      color: "#ffffff",
      backgroundColor: "rgba(17,24,39,0.82)",
      backgroundPaddingEm: 0.5,
      backgroundRadiusEm: 0.15,
      textAlign: "left"
    }
  },
  {
    name: "Neon",
    description: "Glowing sign — colored text with a matching bloom.",
    style: {
      fontWeight: 700,
      fontSize: 64,
      color: "#22d3ee",
      shadowColor: "#22d3ee",
      shadowBlur: 32,
      shadowOffsetX: 0,
      shadowOffsetY: 0,
      textAlign: "center"
    }
  },
  {
    name: "Outline",
    description: "White fill with a heavy dark stroke — comic/thumbnail energy.",
    style: { fontWeight: 800, fontSize: 72, color: "#ffffff", strokeColor: "#111827", strokeWidth: 6, textAlign: "center" }
  },
  {
    name: "Minimal",
    description: "Light, clean, no decoration.",
    style: { fontWeight: 400, fontSize: 48, color: "#f9fafb", textAlign: "center" }
  }
];

export const TEXT_LOOK_NAMES = TEXT_LOOKS.map((look) => look.name);

/** Aliases AIs/users plausibly say. Data, not code. */
const TEXT_LOOK_ALIASES: Record<string, string> = {
  title: "Headline",
  heading: "Headline",
  hero: "Headline",
  banner: "Headline",
  sub: "Subtitle",
  secondary: "Subtitle",
  caption: "Caption Pill",
  pill: "Caption Pill",
  badge: "Caption Pill",
  "lower third": "Lower Third",
  nameplate: "Lower Third",
  broadcast: "Lower Third",
  glow: "Neon",
  glowing: "Neon",
  cyber: "Neon",
  cyberpunk: "Neon",
  stroke: "Outline",
  outlined: "Outline",
  comic: "Outline",
  thumbnail: "Outline",
  clean: "Minimal",
  simple: "Minimal",
  plain: "Minimal"
};

function normalizeKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export interface TextLookResolution {
  look: string;
  repair?: string | undefined;
}

/** Exact → case/format-insensitive → alias. Null = genuinely unknown. */
export function resolveTextLookName(requested: string): TextLookResolution | null {
  const exact = TEXT_LOOKS.find((look) => look.name === requested);
  if (exact) {
    return { look: exact.name };
  }
  const key = normalizeKey(requested);
  const relaxed = TEXT_LOOKS.find((look) => normalizeKey(look.name) === key);
  if (relaxed) {
    return { look: relaxed.name, repair: `text look "${requested}" → ${relaxed.name}` };
  }
  const alias = TEXT_LOOK_ALIASES[key];
  if (alias) {
    return { look: alias, repair: `text look "${requested}" → ${alias}` };
  }
  return null;
}

export function getTextLook(name: string): TextLook | undefined {
  return TEXT_LOOKS.find((look) => look.name === name);
}

/** The text dialect's goal payload: WHICH look, nothing about how it's drawn. */
export const textLookIntentSchema = z.object({ look: z.string().min(1) }).strict();
export type TextLookIntent = z.infer<typeof textLookIntentSchema>;
