/**
 * ADR-023 D1 / D1a / T-1 — what a layer stores when it names a font.
 *
 * A CSS font stack names a font; it does not provide one. `"Inter, sans-serif"` in a manifest is a
 * request that the render machine happens to have Inter installed, which is why the current
 * five-font `renderSafeFonts` ceiling exists at all: it is the set the export box is known to have.
 * A `FontRef` replaces the request with a reference — and, for the pinned sources, with a content
 * hash that is the RENDER identity.
 *
 * Two projects that both say "Inter 700" but pin different hashes are two different renders,
 * correctly: Google reships files under unchanged names and foundries revise metrics, so a
 * name-keyed manifest silently re-renders differently six months later. This is ADR-021's argument
 * for pinning a provider's identity rather than trusting container metadata, applied to fonts.
 *
 * **Bounded honestly (D1).** Pinning the bytes makes the FONT deterministic. It does not make the
 * render byte-identical across time — Chromium's shaper, hinting and rasterizer change between
 * versions, and both renderers ride Chromium. This module guarantees "the same font", never "the
 * same pixels forever".
 */
import { fontAxisInstanceFamily, type FontVariationAxes } from "./font-variation";

/**
 * What a layer stores. NOT a CSS string.
 *
 * `family`/`weight`/`style` are the HUMAN identity — they drive the picker and the CSS we hand the
 * browser. `fileHash` is the RENDER identity and is what the worker resolves to bytes.
 *
 * `source` is a discriminant with teeth, not a label: D4/T-3 requires that no function can resolve a
 * font to bytes without discriminating on it, because `catalogue` may be served to anyone and `user`
 * may be served only to its owner. See `font-store.ts` for where that invariant is enforced; here
 * the point is simply that `ownerId` lives on the `user` variant and nowhere else, so a resolver
 * that forgot to discriminate cannot type-check.
 */
export type FontRef =
  | { source: "catalogue"; family: string; weight: number; style: "normal" | "italic"; fileHash: string }
  | { source: "user"; family: string; weight: number; style: "normal" | "italic"; fileHash: string; ownerId: string }
  | { source: "system"; fontFamily: string };

/** The two pinned sources — the ones with a `fileHash`, and the only ones the worker installs. */
export type PinnedFontRef = Extract<FontRef, { fileHash: string }>;

export function isPinnedFontRef(ref: FontRef): ref is PinnedFontRef {
  return ref.source === "catalogue" || ref.source === "user";
}

/**
 * ADR-023 D1a — **a legacy project's font never moves. Not on open, not on save, not ever
 * automatically.**
 *
 * This is `color-management.ts:82-119`'s shape, applied to a second axis: two separate constants
 * rather than one default with a flag, precisely so that "the field is absent" keeps meaning
 * "authored before `FontRef` existed" PERMANENTLY — not merely until the default's value next
 * changes. That distinction took seven commits to land correctly for colour; this reuses it rather
 * than re-deriving it.
 *
 * The reason a silent remap is wrong is concrete rather than merely cautious. Swapping
 * `"Arial, Helvetica, sans-serif"` for the metric-compatible Arimo REFLOWS text — line breaks move,
 * a title that fit now clips — in a project the user may already have published. A colour default
 * drifting is bad; a caption drifting off a subject's shoulder because a font swap reflowed the line
 * is worse, because it fails in the EXPORT, unattended.
 *
 * Migrating to a pinned face is a per-project, user-triggered, visible action. There is deliberately
 * no migration script in this repo and there should never be one.
 */
export const LEGACY_FONT_SOURCE = "system" as const;

/**
 * What a NEW pinned pick is stamped with. Separate constant from {@link LEGACY_FONT_SOURCE} for the
 * reason above: these two must be able to diverge without either one dragging the other.
 */
export const NEW_FONT_SOURCE = "catalogue" as const;

/**
 * Read a layer's font as a `FontRef`, normalizing legacy data on the way through.
 *
 * Absent, malformed, or unrecognised all resolve to `{ source: "system", fontFamily }` carrying the
 * layer's CSS stack UNCHANGED. "I could not read it" and "it said something else" get the same safe
 * answer, which is `normalizeProjectColorSettings`'s rule (`color-management.ts:136`) and is the
 * whole reason absence is survivable here.
 *
 * Note this normalizes on READ and never writes back. A project file that has never seen a font
 * picker still contains exactly the bytes it always did.
 */
export function normalizeFontRef(ref: unknown, legacyFontFamily: string): FontRef {
  if (!ref || typeof ref !== "object") return { source: LEGACY_FONT_SOURCE, fontFamily: legacyFontFamily };
  const candidate = ref as Record<string, unknown>;

  if (candidate.source === "system") {
    // A system ref whose stack is unreadable falls back to the layer's own stack rather than to a
    // hardcoded family: the layer's string is the better evidence of what the author meant.
    return {
      source: "system",
      fontFamily: typeof candidate.fontFamily === "string" && candidate.fontFamily ? candidate.fontFamily : legacyFontFamily
    };
  }

  if (candidate.source === "catalogue" || candidate.source === "user") {
    const family = typeof candidate.family === "string" ? candidate.family : "";
    const fileHash = typeof candidate.fileHash === "string" ? candidate.fileHash : "";
    // A pinned ref missing its render identity is not a pinned ref. Falling back to the legacy stack
    // is the safe answer; the alternative — keeping `source: "catalogue"` with an empty hash — hands
    // the worker something it must abort on (T-2) for data that was merely corrupt on read.
    if (!family || !fileHash) return { source: LEGACY_FONT_SOURCE, fontFamily: legacyFontFamily };
    const weight = typeof candidate.weight === "number" && Number.isFinite(candidate.weight) ? candidate.weight : 400;
    const style = candidate.style === "italic" ? ("italic" as const) : ("normal" as const);
    if (candidate.source === "user") {
      const ownerId = typeof candidate.ownerId === "string" ? candidate.ownerId : "";
      // D4/T-3: `ownerId` is not optional and has no default. A user ref without one cannot be
      // resolved to bytes for anybody, so it must not survive normalization as a user ref.
      if (!ownerId) return { source: LEGACY_FONT_SOURCE, fontFamily: legacyFontFamily };
      return { source: "user", family, weight, style, fileHash, ownerId };
    }
    return { source: "catalogue", family, weight, style, fileHash };
  }

  return { source: LEGACY_FONT_SOURCE, fontFamily: legacyFontFamily };
}

/**
 * Quote a family name for CSS if it needs it. A pinned family is a bare NAME ("Playfair Display"),
 * not a stack, so it has to be quoted before it can be concatenated into one.
 */
export function cssFamilyToken(family: string): string {
  return /^[A-Za-z][A-Za-z0-9-]*$/.test(family) ? family : `'${family.replace(/'/g, "\\'")}'`;
}

/**
 * The CSS a `FontRef` contributes to `getCompositionTextStyle`.
 *
 * For `system` this is EXACTLY the legacy behaviour: the stack, unchanged, and no weight or style
 * opinion at all — the layer's own `fontWeight`/`italic` continue to drive those, so an existing
 * project's emitted CSS is byte-identical and not merely equivalent.
 *
 * For a pinned ref, `weight`/`style` come from the REF rather than from the layer, because they
 * describe the file: a pinned "Inter 700" IS the 700 file, and letting a layer-level `fontWeight:
 * 900` ride on top of it would ask the browser to synthesize a bolder face than the one we pinned —
 * which is the determinism this whole type exists to provide, silently discarded.
 *
 * A fallback tail is appended so that an editor which has not yet loaded the face still lays text
 * out rather than showing nothing. That is the EDITOR's degraded state (D3), and it is surfaced
 * rather than hidden; the worker never relies on it, because an unresolved pinned font aborts the
 * render before a frame is drawn (T-2).
 */
export function fontRefCss(
  ref: FontRef,
  axes?: FontVariationAxes | undefined
): { fontFamily: string; fontWeight?: number; fontStyle?: "normal" | "italic" } {
  // ADR-023 S9a. A system ref REFUSES an axis instead of approximating one: there are no bytes to
  // re-register under an alias, so the only route left would be a `font-variation-settings`
  // declaration — which the DOM overlay honours and the canvas raster ignores, i.e. an axis that
  // moves the editor and ships nothing. Silently dropping it here is what makes the refusal
  // TESTABLE as an equality (system+axis must be byte-identical to system), which is the only form
  // that catches it. See `font-variation.ts` for why draw-time is not available at all.
  if (ref.source === "system") return { fontFamily: ref.fontFamily };
  return {
    // The axis lives in the FAMILY TOKEN, not in a declaration, because it was baked into the face at
    // registration. That is what lets `ctx.font`, the DOM and an SVG `@font-face` all pick it up
    // without a single line on the drawing path knowing that variable fonts exist.
    fontFamily: `${cssFamilyToken(fontAxisInstanceFamily(ref.family, axes))}, sans-serif`,
    // Unchanged by the axis, deliberately (the S2.7 boundary): the alias face is registered with the
    // REF's own weight/style descriptors, so an axis moves the family token and nothing else. A
    // pinned layer's emitted `font-weight` is byte-identical with and without an axis.
    fontWeight: ref.weight,
    fontStyle: ref.style
  };
}

/**
 * Stable identity of a `FontRef` — the key for dedupe, for install planning, and (T-8) for any text
 * raster's content hash. Deliberately includes `source` and `ownerId`: two refs with the same
 * `fileHash` from different stores are NOT the same resolvable font (D4).
 */
export function fontRefKey(ref: FontRef): string {
  if (ref.source === "system") return `system|${ref.fontFamily}`;
  if (ref.source === "user") return `user|${ref.ownerId}|${ref.fileHash}|${ref.weight}|${ref.style}`;
  return `catalogue|${ref.fileHash}|${ref.weight}|${ref.style}`;
}
