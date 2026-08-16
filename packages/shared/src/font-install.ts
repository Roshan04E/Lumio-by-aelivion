/**
 * ADR-023 D3 / T-2 — installing a pinned font, and refusing to pretend when it cannot be installed.
 *
 * The two consumers do very different things with the same list, and that asymmetry IS D3:
 *
 * - **Worker / export** resolves every pinned ref to bytes BEFORE the first frame and **aborts with
 *   a named error** if any one of them does not resolve. No fallback, no substitution, no
 *   `.catch(() => undefined)`. An export is a deliverable produced unattended; a font that quietly
 *   became something else there is wrong pixels that look like a working feature, discovered by the
 *   person who published them.
 * - **Editor / preview** installs what it can and **surfaces** what it cannot. A blanket hard-fail
 *   in the editor converts a small problem into a stopped session — one missing font of forty should
 *   not blank the canvas. The hard fail lands at the action that produces a deliverable.
 *
 * This module holds only what both share: the face descriptor, the CSS, and the error type. Byte
 * resolution is deliberately NOT here — it differs per environment (the worker reads the store
 * directly; the browser fetches over HTTP) and D4/T-3 requires each resolver to discriminate on the
 * store for itself.
 */
import type { CompositionLayerStyleInput } from "./composition-style";
import { getCompositionFontAxesSource, getCompositionFontRef, getCompositionRunFontRef, getCompositionTextRuns } from "./composition-style";
import {
  fontVariationSettingsCss,
  resolveFontVariationAxes,
  type FontVariationAxes
} from "./font-variation";
import { cssFamilyToken, isPinnedFontRef, type FontRef, type PinnedFontRef } from "./fonts";
import type { TextRun } from "./types";

/**
 * ADR-023 S10 — every run a layer might ever show, independent of the current playhead.
 *
 * Both collectors below need this to be TIME-INDEPENDENT: a pinned run font used only inside one
 * source-text keyframe entry still has to abort a render that starts on a different one, or T-2's
 * "abort BEFORE the first frame" guarantee has a gap sized exactly to "whichever entry the playhead
 * was not on." `getVisibleTextRuns` (composition-style.ts) answers a DIFFERENT question — "what
 * shows right now" — and is the wrong tool here for the same reason `getCompositionTextRuns` alone
 * would be: it only sees `layer.textRuns`, never the keyframe entries.
 */
function everyRunFor(layer: CompositionLayerStyleInput): readonly TextRun[] {
  if (layer.sourceTextKeyframes?.length) return layer.sourceTextKeyframes.flatMap((key) => key.runs);
  return getCompositionTextRuns(layer);
}

/** One `@font-face` the render page must have before it draws. */
export interface InstalledFontFace {
  family: string;
  weight: number;
  style: "normal" | "italic";
  /** Where the bytes come from: a `data:` URL in the worker, an HTTP URL in the browser. */
  src: string;
  /**
   * ADR-023 S9a — the `font-variation-settings` DESCRIPTOR, when this face is an axis instance.
   *
   * A descriptor, emphatically not a declaration: it instances the axis when the face is REGISTERED,
   * which is the only route that reaches the canvas raster (canvas 2D applies no axis at draw time).
   * A face carrying one is registered under an alias family — `fontAxisInstanceFamily` — so several
   * instances of the same bytes coexist, and the emitted CSS picks one by NAME.
   */
  variationSettings?: string | undefined;
}

/**
 * One registration a composition needs: a file, plus the axis instance to bake into it.
 *
 * Separate from a bare `FontRef` because the two multiplicities differ and conflating them is a real
 * bug rather than a tidiness point: N axis instances of one file are ONE set of bytes to fetch and N
 * faces to register. The worker resolves bytes per {@link collectPinnedFontRefs} and registers per
 * this — one download, several `@font-face` rules.
 */
export interface PinnedFontInstance {
  ref: PinnedFontRef;
  axes: FontVariationAxes | undefined;
}

/**
 * Every (file, axis-instance) pair a set of layers needs, deduplicated.
 *
 * The dedupe key includes the settings string, so two layers at `wght 550` share one registration and
 * a layer at 620 gets its own. That is also the shape S9b will meter: a continuously animated axis
 * turns this list from "a handful" into "one per sampled value", which is why S9b's first job is to
 * measure the registration cost rather than assume it.
 *
 * ADR-023 S10 — a RUN can now carry its OWN pinned font too, and it is collected alongside the
 * layer's: the layer's ref is always registered (harmless even if every run overrides it — one extra
 * unused `@font-face` costs nothing next to a missed abort), and each run that diverges
 * (`run.fontRef`/`run.fontFamily` present) adds its own resolved ref on top. A run's own pinned font
 * registers with NO axis instance — S9a stays layer-only, a decision stated at
 * `getCompositionTextRunStyle`'s doc, not an oversight here.
 */
export function collectPinnedFontInstances(layers: CompositionLayerStyleInput[]): PinnedFontInstance[] {
  const byKey = new Map<string, PinnedFontInstance>();
  const add = (ref: FontRef, axes: FontVariationAxes | undefined) => {
    if (!isPinnedFontRef(ref)) return;
    const key = `${ref.source}|${ref.fileHash}|${ref.weight}|${ref.style}|${fontVariationSettingsCss(axes) ?? ""}`;
    if (!byKey.has(key)) byKey.set(key, { ref, axes });
  };
  for (const layer of layers) {
    const layerRef = getCompositionFontRef(layer);
    add(layerRef, resolveFontVariationAxes(getCompositionFontAxesSource(layer)));
    for (const run of everyRunFor(layer)) {
      if (!run.fontRef && !run.fontFamily) continue; // inherits the layer, already added above
      add(getCompositionRunFontRef(run, layerRef), undefined);
    }
  }
  return [...byKey.values()];
}

/**
 * T-2's error. A distinct class rather than a bare `Error` because the export path has to be able to
 * tell "this font is missing" from "the network hiccuped" — and because the message is user-facing:
 * it names the family and the hash, which are the two things needed to fix it.
 */
export class FontResolutionError extends Error {
  readonly refs: readonly PinnedFontRef[];
  constructor(refs: readonly PinnedFontRef[]) {
    const list = refs.map((ref) => `${ref.family} ${ref.weight}${ref.style === "italic" ? " italic" : ""} (${ref.fileHash.slice(0, 12)}…)`);
    super(
      `Render aborted: ${refs.length === 1 ? "a font" : `${refs.length} fonts`} could not be resolved — ${list.join(", ")}. ` +
        `A pinned font that is not available is not something to substitute: the export would be wrong in a way nobody would notice. ` +
        `Relink or re-pick the font and render again.`
    );
    this.name = "FontResolutionError";
    this.refs = refs;
  }
}

/**
 * Every pinned font a set of layers needs, deduplicated.
 *
 * System refs are skipped, and that is not an omission: a `{ source: "system" }` ref names a
 * platform font and has no bytes to install (D1a). It is also the only ref a legacy project has, so
 * this returning empty for every pre-`FontRef` project is exactly what keeps this whole path
 * inert for them.
 *
 * ADR-023 S10 — same run-level reach as {@link collectPinnedFontInstances}, restated here rather than
 * built on top of it: this function's dedupe key is coarser (no axis-settings component), which is
 * the whole reason it exists as a second function instead of `collectPinnedFontInstances(...).map()`.
 */
export function collectPinnedFontRefs(layers: CompositionLayerStyleInput[]): PinnedFontRef[] {
  const byHash = new Map<string, PinnedFontRef>();
  const add = (ref: FontRef) => {
    if (!isPinnedFontRef(ref)) return;
    const key = `${ref.source}|${ref.fileHash}|${ref.weight}|${ref.style}`;
    if (!byHash.has(key)) byHash.set(key, ref);
  };
  for (const layer of layers) {
    const layerRef = getCompositionFontRef(layer);
    add(layerRef);
    for (const run of everyRunFor(layer)) {
      if (!run.fontRef && !run.fontFamily) continue;
      add(getCompositionRunFontRef(run, layerRef));
    }
  }
  return [...byHash.values()];
}

/**
 * `@font-face` rules for a resolved set.
 *
 * `font-display: block` on purpose. The browser default (`auto`, effectively `block` with a short
 * swap period) will paint fallback glyphs if the face is slow, and in a RENDER that silent swap is
 * the whole failure mode this stage exists to remove. The worker additionally waits on
 * `document.fonts.load` before the first frame, so this is the belt to that braces.
 */
export function fontFaceCss(faces: readonly InstalledFontFace[]): string {
  return faces
    .map(
      (face) =>
        `@font-face{font-family:${cssFamilyToken(face.family)};font-weight:${face.weight};` +
        `font-style:${face.style};font-display:block;` +
        // ADR-023 S9a. Inside an `@font-face` block this is a DESCRIPTOR — it instances the axis when
        // the face is registered — and that is the only reason it works here at all: the same property
        // written as a declaration on an element is ignored by the canvas raster both renderers draw
        // through. Emitted before `src` so a reader sees what the face IS before where it comes from.
        `${face.variationSettings ? `font-variation-settings:${face.variationSettings};` : ""}` +
        `src:url(${face.src})}`
    )
    .join("\n");
}

/** The `document.fonts.load` shorthand for a face — the string that actually blocks on the bytes. */
export function fontLoadSpec(face: InstalledFontFace): string {
  return `${face.style} ${face.weight} 64px ${cssFamilyToken(face.family)}`;
}
