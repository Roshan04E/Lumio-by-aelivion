/**
 * ADR-023 S2.5 — the browsable catalogue over the mirrored store.
 *
 * S2 made fonts *travel correctly*: a `FontRef` pins a `fileHash`, the mirror stores the bytes with
 * their licence, and the worker installs before rendering or aborts by name. None of that gave a
 * user anything to click. This is the list they pick from, and every entry here carries the
 * `fileHash` that makes the pick a pinned ref rather than a wish.
 *
 * **Every hash below is the SHA-256 of a real file this repo ships**, and `font:catalogue-gate`
 * re-hashes each one on every run. That check is not ceremony. `warpFontCatalog` — the
 * hand-maintained table this replaces — shipped EMPTY once, so every warped family silently rendered
 * as the Roboto fallback and "changing the font did nothing" reached a user before anyone noticed.
 * A font table that is wrong looks exactly like a font table that is right, which is why the
 * catalogue is not allowed to be merely *declared* correct.
 *
 * SCOPE, honestly. This is the set already mirrored and shipped, not the Google catalogue. The
 * ceiling `renderSafeFonts` imposed was five *system stacks the export box was known to have*;
 * what replaces it is a set of pinned faces that render identically everywhere because their bytes
 * are pinned. Growing the list is now adding rows plus a mirror write — no engine change, which is
 * exactly what the seam was for. Ingest from Google at scale is S3's neighbour, not this stage.
 */
import type { FontRef } from "./fonts";

/** One selectable face: a family at a specific weight and style, pinned by content hash. */
export interface CatalogueFace {
  weight: number;
  style: "normal" | "italic";
  /** The RENDER identity (D1). What a pick writes into the manifest. */
  fileHash: string;
  /**
   * Path of the bundled copy, relative to each app's public root. Used for PREVIEWS and as the
   * source the mirror is seeded from — never as a substitute for the store at render time, because
   * an editor that quietly rendered bundled bytes while the worker aborted would be the editor and
   * the export disagreeing, which is the whole thing S2 exists to prevent.
   */
  file: string;
}

export interface CatalogueFamily {
  family: string;
  /** What the family is for, in the picker. Not a taxonomy — a hint. */
  category: "sans" | "serif" | "mono" | "display";
  faces: readonly CatalogueFace[];
}

export const fontCatalogue: readonly CatalogueFamily[] = [
  {
    family: "Anton",
    category: "display",
    faces: [
      { weight: 400, style: "normal", fileHash: "a4ba3a92350ebb031da0cb47630ac49eb265082ca1bc0450442f4a83ab947cab", file: "fonts/Anton-Regular.ttf" }
    ]
  },
  {
    family: "Arimo",
    category: "sans",
    faces: [
      { weight: 400, style: "normal", fileHash: "e43898b143ec826ac8cb4034816458a7047fbe0836558de2a1f8c6223ae3e0ca", file: "fonts/Arimo-Regular.ttf" },
      { weight: 700, style: "normal", fileHash: "d7a8b187cf8444d4cfee102e8eae9e3043682fd5106d5d33ed677fe268a0e2ba", file: "fonts/Arimo-Bold.ttf" }
    ]
  },
  {
    family: "Cousine",
    category: "mono",
    faces: [
      { weight: 400, style: "normal", fileHash: "1da22250675fc4c42fcf3a9736c44bc0570516105331443b663fd5cfbd1412fe", file: "fonts/Cousine-Regular.ttf" },
      { weight: 700, style: "normal", fileHash: "17c8a7245156d2253531c9e529474937b09d9f641c5ae7695c5e33f22822eef4", file: "fonts/Cousine-Bold.ttf" }
    ]
  },
  {
    family: "Roboto",
    category: "sans",
    faces: [
      { weight: 400, style: "normal", fileHash: "79e851404657dac2106b3d22ad256d47824a9a5765458edb72c9102a45816d95", file: "fonts/Roboto-Regular.ttf" }
    ]
  },
  {
    family: "Tinos",
    category: "serif",
    faces: [
      { weight: 400, style: "normal", fileHash: "60a0e8ef0c04dd5dd69ffe91025fa2ae5836cbd35600a82ba031977557e2cb61", file: "fonts/Tinos-Regular.ttf" },
      { weight: 700, style: "normal", fileHash: "393269dbab8899f938db19783eca5eac92eb431f7ae0ab45b8349ca895f1a06b", file: "fonts/Tinos-Bold.ttf" }
    ]
  }
];

/**
 * Legacy CSS families → the catalogue family that stands in for them when a VECTOR OUTLINE is
 * needed (warp). Metric-compatible where one exists: Arimo for Arial, Tinos for Times/Georgia,
 * Cousine for Courier, Anton for Impact.
 *
 * **This is not a migration and must never become one (D1a).** Nothing here changes what a legacy
 * layer RENDERS — a `{ source: "system" }` ref still resolves through the platform exactly as it
 * always has. This map exists only because `buildWarpedTextPaths` needs a font *binary* to read
 * outlines from, and the browser will not hand over the outlines of an installed system font. It is
 * consulted for warp and for nothing else.
 */
export const LEGACY_WARP_FAMILY_ALIASES: Readonly<Record<string, string>> = {
  Arial: "Arimo",
  Helvetica: "Arimo",
  "system-ui": "Arimo",
  Impact: "Anton",
  Haettenschweiler: "Anton",
  Georgia: "Tinos",
  "Times New Roman": "Tinos",
  "Courier New": "Cousine",
  Courier: "Cousine"
};

export function catalogueFamily(family: string): CatalogueFamily | undefined {
  return fontCatalogue.find((entry) => entry.family === family);
}

/**
 * The face a family resolves to at a given weight/style.
 *
 * Picks the closest available weight rather than failing: a family with 400 and 700 asked for 900
 * gives 700, which is what a picker showing "Bold" must do. Style is matched exactly when possible —
 * a synthesized oblique is a different look from a real italic, and pretending otherwise is the kind
 * of quiet substitution this stage is against.
 */
export function catalogueFace(family: string, weight = 400, style: "normal" | "italic" = "normal"): CatalogueFace | undefined {
  const entry = catalogueFamily(family);
  if (!entry) return undefined;
  const sameStyle = entry.faces.filter((face) => face.style === style);
  const pool = sameStyle.length ? sameStyle : entry.faces;
  let best: CatalogueFace | undefined;
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

/** Every selectable face, flattened — the picker's list. */
export function catalogueFaces(): Array<{ family: string; category: CatalogueFamily["category"]; face: CatalogueFace }> {
  return fontCatalogue.flatMap((entry) => entry.faces.map((face) => ({ family: entry.family, category: entry.category, face })));
}

/**
 * The bundled copy of a pinned catalogue hash, if the catalogue ships one.
 *
 * A catalogue `FontRef` names a store (`fontStoreKeyFor` → `fonts/catalogue/<hash>`), but that store
 * is not the only place the hash's bytes live: `CatalogueFace.file` says this repo ALSO ships them,
 * at a path relative to each app's public root. Resolving a pinned ref is therefore a question —
 * "does this hash have a bundled copy?" — not a single formula, and answering it by re-hashing the
 * mirror's key would put the store back in the loop the bundled path exists to skip.
 *
 * Matched by `fileHash`, not by family/weight/style: those describe what a picker showed, and a ref
 * that survived normalization carries only the hash as its render identity (D1).
 */
export function catalogueFileForHash(fileHash: string): string | undefined {
  for (const entry of fontCatalogue) {
    for (const face of entry.faces) {
      if (face.fileHash === fileHash) return face.file;
    }
  }
  return undefined;
}

/**
 * The `FontRef` a pick writes. **This one function is what the whole S2 contract hangs off**: it
 * emits a `fileHash`, so the manifest pins bytes rather than a name, so the worker can install them
 * or abort. A picker that wrote `fontFamily: "Anton"` would leave every S2 obligation unreachable
 * while looking, in the editor, exactly the same.
 */
export function catalogueFontRef(
  family: string,
  weight = 400,
  style: "normal" | "italic" = "normal"
): Extract<FontRef, { source: "catalogue" }> | undefined {
  const face = catalogueFace(family, weight, style);
  if (!face) return undefined;
  return { source: "catalogue", family, weight: face.weight, style: face.style, fileHash: face.fileHash };
}
