/**
 * ADR-023 S2.6 — the font INDEX: what families exist, independent of what bytes we hold.
 *
 * **This is the thing that breaks S2.5's circle.** The picker could only list what had already been
 * mirrored, so nothing was ever picked, so nothing was ever mirrored — five families, permanently,
 * behind a contract built for thousands. An index is metadata: a family EXISTS, has these faces, and
 * covers these scripts. Picking one is what causes bytes to be fetched (D4's mirror-on-first-use),
 * and only then does a `fileHash` exist to pin.
 *
 * **The index deliberately carries no hashes and no URLs.** A `FontRef`'s `fileHash` is what the
 * mirror actually hashed after fetching (D1), never what a table claimed it would be. If this file
 * carried hashes there would be two answers to "what bytes is this font", and the whole of S2 exists
 * because a name is not bytes.
 *
 * ## Relationship to `font-catalogue.ts`
 *
 * The catalogue is the small BUNDLED set — faces this repo ships as files, with real hashes, usable
 * offline and used for warp outlines. The index is the large REMOTE set. A family can be in both
 * (Roboto, Arimo, Anton, Cousine, Tinos are), and `font-index-test` asserts they agree about
 * category and weights, because two lists that describe the same font and disagree is how a picker
 * starts lying.
 */
import { FONT_INDEX_LICENSE_PATHS, FONT_INDEX_RAW, FONT_INDEX_SUBSETS } from "./font-index-data";

export type FontIndexCategory = "sans" | "serif" | "display" | "handwriting" | "mono";

const CATEGORY_BY_CODE: Record<string, FontIndexCategory> = {
  s: "sans",
  f: "serif",
  d: "display",
  h: "handwriting",
  m: "mono"
};

export interface FontIndexFace {
  weight: number;
  style: "normal" | "italic";
}

/**
 * ADR-023 S10.5 — the licence code for a family VERIFIED to have none, permanently. Must match
 * `RESTRICTED_LICENSE_CODE` in `font-index-build.ts` (same convention as `fontFamilySlug` below,
 * which already has to match that file's `familySlug`).
 *
 * Distinct from an ABSENT `licensePath`, which used to be the only signal and meant two different
 * things at once: "checked, and this family truly has no licence" and "the lookup missed." A row
 * carrying this code is the first; a row is never allowed to carry the second — `font-index-build.ts`
 * fails the whole generation run rather than emit one, so every row in `FONT_INDEX_RAW` is either a
 * real path or this code, never a blank the picker has to guess about.
 */
const RESTRICTED_LICENSE_CODE = "x";

export interface FontIndexFamily {
  family: string;
  category: FontIndexCategory;
  faces: readonly FontIndexFace[];
  /** Google's subset names — "latin", "arabic", "devanagari", … Never "menu"; see the generator. */
  subsets: readonly string[];
  /**
   * Path to the family's licence in `google/fonts`, or `undefined` for a `restricted` family (below)
   * — never `undefined` for any OTHER reason; see `RESTRICTED_LICENSE_CODE`'s own doc.
   *
   * **This exists because the licence is not in the font.** Google's CDN strips name IDs 13/14 from
   * every static instance it serves (measured — Cairo, Amiri, Noto Naskh Arabic, Inter all come back
   * with no licence text), so S2.3's name-table read, correct for the bundled faces, refuses every
   * family the picker can offer. The licence is not missing, only stored beside the font instead of
   * inside it. T-11 is unchanged: the mirror writes font and licence in one operation or writes
   * neither. Only the source of the licence bytes moved.
   */
  licensePath: string | undefined;
  /**
   * True for a family verified to carry no public licence at all — Google-proprietary, checked by
   * hand (`RESTRICTED_FAMILIES` in `font-index-build.ts`). Permanent, not "not yet mirrored": the
   * picker should say so (a restricted family will never resolve, however long you wait), rather
   * than showing the same "unavailable" a transient mirror failure would.
   */
  restricted: boolean;
}

/** The `google/fonts` directory name for a family. Must match the generator's derivation. */
export function fontFamilySlug(family: string): string {
  return family.toLowerCase().replace(/[^a-z0-9]/g, "");
}

let decoded: readonly FontIndexFamily[] | undefined;

/**
 * Decode the packed index. Lazy and memoized: this runs once, the first time anything asks, so
 * importing the module costs nothing and the picker's startup pays a parse rather than a fetch.
 */
export function fontIndex(): readonly FontIndexFamily[] {
  if (decoded) return decoded;
  const families: FontIndexFamily[] = [];
  for (const line of FONT_INDEX_RAW.split("\n")) {
    if (!line) continue;
    const [family, categoryCode, faceList, subsetList, licenseCode] = line.split("|");
    const category = CATEGORY_BY_CODE[categoryCode ?? ""];
    if (!family || !category) continue;
    const faces: FontIndexFace[] = [];
    for (const token of (faceList ?? "").split(",")) {
      if (!token) continue;
      const italic = token.endsWith("i");
      const weight = parseInt(italic ? token.slice(0, -1) : token, 10);
      if (Number.isFinite(weight)) faces.push({ weight, style: italic ? "italic" : "normal" });
    }
    const subsets = (subsetList ?? "")
      .split(",")
      .map((code) => FONT_INDEX_SUBSETS[Number(code)])
      .filter((name): name is string => Boolean(name));
    const restricted = licenseCode === RESTRICTED_LICENSE_CODE;
    const licenseTemplate = licenseCode ? FONT_INDEX_LICENSE_PATHS[licenseCode] : undefined;
    const licensePath = licenseTemplate?.replace("%", fontFamilySlug(family));
    if (faces.length) families.push({ family, category, faces, subsets, licensePath, restricted });
  }
  decoded = families;
  return decoded;
}

export function fontIndexFamily(family: string): FontIndexFamily | undefined {
  return fontIndex().find((entry) => entry.family === family);
}

/**
 * The scripts worth offering as a filter, in the order a picker should show them.
 *
 * **This list is where S2.6 meets S0b and S0c.** The RTL work those stages shipped is unreachable in
 * practice if a user writing Arabic cannot FIND an Arabic face — a Latin-only list makes base
 * direction a setting with nothing to apply it to. So script filtering is not a convenience here; it
 * is what connects two stages.
 *
 * Restricted to subsets with enough families to be worth a chip. The long tail (one family each for
 * Linear A, Ugaritic, Duployan…) stays reachable through search and through `subsets` on the row.
 */
export const FONT_SCRIPT_FILTERS: ReadonlyArray<{ subset: string; label: string }> = [
  { subset: "latin", label: "Latin" },
  { subset: "arabic", label: "Arabic" },
  { subset: "hebrew", label: "Hebrew" },
  { subset: "cyrillic", label: "Cyrillic" },
  { subset: "greek", label: "Greek" },
  { subset: "devanagari", label: "Devanagari" },
  { subset: "thai", label: "Thai" },
  { subset: "korean", label: "Korean" },
  { subset: "japanese", label: "Japanese" },
  { subset: "chinese-simplified", label: "Chinese" }
];

export interface FontIndexQuery {
  /** Case-insensitive substring of the family name. */
  search?: string | undefined;
  category?: FontIndexCategory | undefined;
  subset?: string | undefined;
}

/**
 * Filter the index. Returns families in the index's own order, which is popularity order — so an
 * unfiltered picker opens on the fonts people actually use rather than on the alphabet.
 *
 * A pure function over an array of ~2000, deliberately: the list is small enough that filtering on
 * every keystroke is cheaper than any index structure would be to maintain, and the expensive part
 * of a font picker was never the filter — it is loading a face per row, which is the list's problem
 * and is solved in the list (S2.6's virtualization), not here.
 */
export function queryFontIndex(query: FontIndexQuery): readonly FontIndexFamily[] {
  const search = query.search?.trim().toLowerCase();
  return fontIndex().filter((entry) => {
    if (query.category && entry.category !== query.category) return false;
    if (query.subset && !entry.subsets.includes(query.subset)) return false;
    if (search && !entry.family.toLowerCase().includes(search)) return false;
    return true;
  });
}

/**
 * The face an index family resolves to at a weight/style — nearest available weight, exact style
 * where the family has one.
 *
 * Mirrors `catalogueFace`'s rule rather than restating it loosely: a family with 400 and 700 asked
 * for 900 gives 700, because a picker offering "Bold" must land on the bold cut rather than quietly
 * dropping to regular.
 */
export function fontIndexFace(family: string, weight = 400, style: "normal" | "italic" = "normal"): FontIndexFace | undefined {
  const entry = fontIndexFamily(family);
  if (!entry) return undefined;
  const sameStyle = entry.faces.filter((face) => face.style === style);
  const pool = sameStyle.length ? sameStyle : entry.faces;
  let best: FontIndexFace | undefined;
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
