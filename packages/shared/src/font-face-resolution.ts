/**
 * ADR-023 S2.7 — **Bold picks the bold FILE.**
 *
 * A pinned ref's weight comes from the ref, because the ref describes a *file* (`fontRefCss`). That
 * is correct and was settled in S2 — and it left a hole: the layer's Bold toggle writes a CSS weight
 * that nothing reads, so Bold over a pinned font did nothing at all. S2.6 wired the picker to the
 * layer's current weight, so picking *while* Bold is on pins the bold cut; toggling *after* pinning
 * was still inert, and with 7,804 faces pickable it is now trivially reachable.
 *
 * The industry answer, and it is not synthetic weight: resolve a weight/style request to a REAL face
 * of the family, and rewrite the ref. Figma, InDesign and Canva all do this. Faux-bold over a family
 * that ships a bold file is smeared on screen and different in the export — two renderers disagreeing
 * about a font, which is the whole thing S2 exists to prevent.
 *
 * ## No cut, no lie — and the decision is DISABLE, not synthesise
 *
 * A single-style family (Anton is the standing example; `warpFontCatalog`'s bold-less entry was the
 * precedent) has no bold file. The plan allows either "the control disables with a reason" or
 * "synthesis is explicit and visible". **This module takes the first**, for three reasons:
 *
 *  1. It is what every professional tool does. You cannot pick a cut a family does not have, and
 *     saying so is more useful than producing a smeared approximation of one.
 *  2. Visible synthesis would be a new user-facing degraded state, and T-16 requires those to be
 *     proven in PIXELS with a check falsified against a hidden marker. That is real weight to carry
 *     for a state we would rather never enter.
 *  3. S2.6 made the alternative cheap: there are 1,942 families to choose from, and a user who needs
 *     bold can have a family that has one.
 *
 * The disable is also what makes the rest safe. `catalogueFace` and `fontIndexFace` both resolve to
 * the NEAREST available weight, so asking either for Anton 700 answers Anton 400 — perfectly
 * reasonable when picking a family, and a silent lie when the question was "make this bold". The
 * availability check is what stops that question from ever being asked.
 *
 * ## Where this will meet S9 (noted, deliberately not built)
 *
 * A variable family exposing a `wght` axis is ONE file. This stage picks BETWEEN files, and it works
 * on variable families only because Google's index enumerates their instances and its CDN serves a
 * static instance per weight — so "Cairo 700" here is a pinned static cut, not an axis setting. S9's
 * per-character and variable-axis animation needs the opposite: one variable file plus
 * `font-variation-settings`, because you cannot animate weight by swapping pinned files (each swap
 * is a different `fileHash`, and T-8 makes it a different raster). When S9 lands, a variable family
 * will want ONE ref plus an axis map, and this resolver will need to stop enumerating its instances.
 * Nothing here should be generalised in anticipation.
 */
import { catalogueFace, catalogueFamily } from "./font-catalogue";
import { fontIndexFamily } from "./font-index";
import type { FontRef } from "./fonts";

/** The weight a Bold toggle asks for. 700 is "the bold cut"; see `LEGACY_CSS_BOLD_WEIGHT`. */
export const FACE_BOLD_WEIGHT = 700;
export const FACE_REGULAR_WEIGHT = 400;

/**
 * What the Bold toggle writes into `fontWeight` on a LEGACY layer — unchanged from before this
 * stage, and deliberately different from {@link FACE_BOLD_WEIGHT}.
 *
 * A system stack has no files to choose between, so its bold is the browser's synthetic one and 900
 * is what this editor has always asked for. Changing it would move every legacy render for no gain,
 * which `render:baseline` would (correctly) refuse. D1a: untouched, permanently.
 */
export const LEGACY_CSS_BOLD_WEIGHT = 900;

/** Anything at or above this reads as "bold" when deciding whether a toggle is lit. */
const BOLD_THRESHOLD = 600;

export interface FaceDescriptor {
  weight: number;
  style: "normal" | "italic";
}

/**
 * The faces a family actually offers.
 *
 * The remote index wins over the bundled catalogue where both know the family, because the index is
 * the full picture: we bundle Arimo 400 and 700 but the family also has italics, and a user should
 * be able to reach them — the mirror will fetch the cut on demand (S2.6). The bundled list is the
 * fallback for a family the index does not carry.
 *
 * Empty for anything unknown, which includes `source: "user"` fonts (S3): we hold one uploaded file
 * and know nothing about its siblings, so every cut-changing control correctly reports "no other
 * cut" rather than guessing. That is the honest answer until S3 gives a user font a family group.
 */
export function familyFaces(family: string): readonly FaceDescriptor[] {
  const indexed = fontIndexFamily(family);
  if (indexed) return indexed.faces;
  const bundled = catalogueFamily(family);
  if (bundled) return bundled.faces.map((face) => ({ weight: face.weight, style: face.style }));
  return [];
}

/**
 * The face a family offers for a weight/style request — nearest weight WITHIN the requested style.
 *
 * Unlike `catalogueFace`/`fontIndexFace` this never crosses styles: a family with no italic answers
 * `undefined` for an italic request rather than handing back the roman. That distinction is the
 * point of this module — those two are answering "what should I show", and this one is answering
 * "does the cut you asked for exist".
 */
export function resolveFamilyFace(family: string, weight: number, style: "normal" | "italic"): FaceDescriptor | undefined {
  const pool = familyFaces(family).filter((face) => face.style === style);
  if (!pool.length) return undefined;
  let best: FaceDescriptor | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const face of pool) {
    const distance = Math.abs(face.weight - weight);
    if (distance < bestDistance) {
      best = face;
      bestDistance = distance;
    }
  }
  return best;
}

/** Does this family ship a bold cut in the requested style? */
export function familyHasBold(family: string, style: "normal" | "italic" = "normal"): boolean {
  return familyFaces(family).some((face) => face.style === style && face.weight >= BOLD_THRESHOLD);
}

/** Does this family ship an italic at all? */
export function familyHasItalic(family: string): boolean {
  return familyFaces(family).some((face) => face.style === "italic");
}

/* ------------------------------------------------------------------------------------------------
 * The decision a toggle makes
 * ---------------------------------------------------------------------------------------------- */

/** The layer state a toggle reads. Deliberately the four fields and nothing else. */
export interface FaceRequestInput {
  fontRef: FontRef | undefined;
  fontWeight: number | undefined;
  italic: boolean | undefined;
}

export type FaceChangePlan =
  /** Legacy path: write CSS exactly as this editor always has. No files are involved (D1a). */
  | { kind: "css"; fontWeight: number; italic: boolean }
  /** Pinned path: the layer needs a ref for THIS cut. The caller resolves it to bytes. */
  | { kind: "face"; family: string; weight: number; style: "normal" | "italic" }
  /** The family has no such cut, and we will not fake one. `reason` is shown to the user. */
  | { kind: "unavailable"; reason: string };

/** Is the toggle lit? For a pinned layer the REF is the truth; the layer's CSS weight is unread. */
export function isBoldActive(input: FaceRequestInput): boolean {
  if (input.fontRef && input.fontRef.source !== "system") return input.fontRef.weight >= BOLD_THRESHOLD;
  return (input.fontWeight ?? FACE_REGULAR_WEIGHT) >= 700;
}

export function isItalicActive(input: FaceRequestInput): boolean {
  if (input.fontRef && input.fontRef.source !== "system") return input.fontRef.style === "italic";
  return input.italic ?? false;
}

/**
 * Whether a control should be enabled, and why not.
 *
 * `undefined` means "enabled". A legacy layer is ALWAYS enabled: the browser will synthesise, which
 * is what a system stack has always done and what D1a preserves permanently.
 */
export function faceControlBlocked(input: FaceRequestInput, control: "bold" | "italic"): string | undefined {
  const ref = input.fontRef;
  if (!ref || ref.source === "system") return undefined;
  if (control === "bold") {
    const style = ref.style;
    if (familyHasBold(ref.family, style)) return undefined;
    // Already on the bold cut and asking to turn it OFF must always be allowed, or a user who
    // pinned bold could never get back to regular.
    if (ref.weight >= BOLD_THRESHOLD) return undefined;
    return familyFaces(ref.family).length
      ? `${ref.family} has no bold cut. Pick another family for bold — we won't fake one.`
      : `We don't know what other cuts ${ref.family} has, so bold can't be resolved to a real file.`;
  }
  if (familyHasItalic(ref.family)) return undefined;
  if (ref.style === "italic") return undefined;
  return familyFaces(ref.family).length
    ? `${ref.family} has no italic. Pick another family for italic — we won't slant it artificially.`
    : `We don't know what other cuts ${ref.family} has, so italic can't be resolved to a real file.`;
}

/**
 * What flipping a toggle should do.
 *
 * The two paths never mix. A legacy layer writes CSS and no ref is touched; a pinned layer picks a
 * FILE and its CSS weight is left exactly where it was, so unpinning later behaves as it always did.
 */
export function planFaceChange(input: FaceRequestInput, change: { bold?: boolean; italic?: boolean }): FaceChangePlan {
  const ref = input.fontRef;
  const wantBold = change.bold ?? isBoldActive(input);
  const wantItalic = change.italic ?? isItalicActive(input);

  if (!ref || ref.source === "system") {
    return { kind: "css", fontWeight: wantBold ? LEGACY_CSS_BOLD_WEIGHT : FACE_REGULAR_WEIGHT, italic: wantItalic };
  }

  const style = wantItalic ? ("italic" as const) : ("normal" as const);
  const face = resolveFamilyFace(ref.family, wantBold ? FACE_BOLD_WEIGHT : FACE_REGULAR_WEIGHT, style);
  if (!face) {
    return {
      kind: "unavailable",
      reason: familyFaces(ref.family).length
        ? `${ref.family} has no ${style === "italic" ? "italic" : "upright"} cut.`
        : `We don't know what cuts ${ref.family} has.`
    };
  }
  // The resolver returns the NEAREST weight in the style, so a family without a bold cut would come
  // back with its regular one — a silent faux-bold by another route. Refuse it here as well as in
  // `faceControlBlocked`, because a plan is reachable from code that never consulted the control.
  if (wantBold && face.weight < BOLD_THRESHOLD) {
    return { kind: "unavailable", reason: `${ref.family} has no bold cut, and we won't fake one.` };
  }
  // The asymmetry is deliberate and needs no branch: turning bold ON must find a cut at or above the
  // threshold or refuse, while turning it OFF simply takes the nearest cut to 400 — a family whose
  // lightest weight is 700 legitimately stays at 700, because that is the lightest thing it has.
  return { kind: "face", family: ref.family, weight: face.weight, style };
}
