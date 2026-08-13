/**
 * ADR-023 D2 / T-4 — font identity is read from the name table, and **the parse is the validity
 * gate**.
 *
 * `MyFont-Bold-FINAL(2).ttf` is not evidence of anything. Family, subfamily, weight class and the
 * italic flag come from the font's own `name` and `OS/2` tables, at ingest, once. Nothing downstream
 * ever infers identity from a filename, and nothing downstream re-parses to find out what a font is.
 *
 * "The parse is also the validity check" is a design decision with a consequence worth stating: a
 * file whose name table cannot be read **is not a font**, and is rejected at ingest rather than at
 * render. That moves the failure from an unattended export — where it is a broken deliverable — to
 * an upload dialog, where it is a sentence.
 *
 * Reuses `opentype.js`, already a lazy dependency of `font-outlines.ts`. D9a deleted `getPath` from
 * the warp path but deliberately retained the module for exactly this.
 */

/** Weight fallbacks for fonts whose `OS/2` table is missing or nonsensical (CSS names, USWeightClass). */
const SUBFAMILY_WEIGHTS: ReadonlyArray<readonly [RegExp, number]> = [
  [/\b(thin|hairline)\b/i, 100],
  [/\bextra[ -]?light\b|\bultra[ -]?light\b/i, 200],
  [/\blight\b/i, 300],
  [/\b(regular|normal|book|roman)\b/i, 400],
  [/\bmedium\b/i, 500],
  [/\b(semi[ -]?bold|demi[ -]?bold)\b/i, 600],
  [/\bbold\b/i, 700],
  [/\b(extra[ -]?bold|ultra[ -]?bold)\b/i, 800],
  [/\b(black|heavy)\b/i, 900]
];

/** What a font file says about itself. The only thing permitted to describe a font (T-4). */
export interface FontIdentity {
  /** Typographic family (name ID 16) when present, else the legacy family (ID 1). */
  family: string;
  /** Typographic subfamily (ID 17) when present, else ID 2. Retained for display, never for logic. */
  subfamily: string;
  /** `OS/2.usWeightClass`, 1–1000. Falls back to the subfamily keyword only if the table is absent. */
  weight: number;
  style: "normal" | "italic";
  postScriptName: string | undefined;
  /**
   * The embedded license (name IDs 13/14).
   *
   * This being IN the font is what makes T-11 enforceable rather than aspirational: the mirror does
   * not have to go and find a license file from somewhere else and hope the two stay together — the
   * bytes it needs came out of the same parse as the bytes it is storing. A catalogue font with no
   * license record is one we must refuse to mirror (see `font-mirror.ts`), and that check is cheap
   * precisely because it is right here.
   */
  license: { text: string; url: string | undefined } | undefined;
}

export type FontIngestErrorCode =
  | "not-a-font"
  | "woff2-unsupported"
  | "no-family-name"
  | "empty-file";

/**
 * A rejection with a reason the UI can render and the worker can name (T-2). Deliberately a distinct
 * class rather than a bare `Error`: the export abort path has to be able to tell "this font is
 * broken" from "the network failed", and a string match on a message is not that.
 */
export class FontIngestError extends Error {
  readonly code: FontIngestErrorCode;
  constructor(code: FontIngestErrorCode, message: string) {
    super(message);
    this.name = "FontIngestError";
    this.code = code;
  }
}

interface OpentypeNameRecord {
  [language: string]: string | undefined;
}
interface OpentypeNames {
  [platform: string]: Record<string, OpentypeNameRecord | undefined> | undefined;
}
interface ParsedOpentypeFont {
  names: OpentypeNames;
  tables: {
    os2?: { usWeightClass?: number; fsSelection?: number } | undefined;
    head?: { macStyle?: number } | undefined;
  };
}
interface OpentypeModule {
  parse(buffer: ArrayBuffer): ParsedOpentypeFont;
}

let opentypePromise: Promise<OpentypeModule> | undefined;
async function getOpentype(): Promise<OpentypeModule> {
  if (!opentypePromise) {
    opentypePromise = import("opentype.js").then(
      (mod) => (mod as unknown as { default?: OpentypeModule }).default ?? (mod as unknown as OpentypeModule)
    );
  }
  return opentypePromise;
}

/**
 * Pull one name ID out of opentype.js's `{ platform: { nameId: { lang: value } } }` shape.
 *
 * The nesting is version-dependent and was verified against the copy in this repo rather than
 * assumed: this build exposes `names.windows.fontFamily.en`, NOT the flat `names.fontFamily` older
 * documentation shows. A flat read returns `undefined` silently, which would have made every font
 * "unnamed" and every ingest a rejection — a failure that looks like a bad font rather than a bad
 * reader. Platforms and languages are both walked so a font that only carries a Macintosh record, or
 * only a non-`en` language, still identifies itself.
 */
function readName(names: OpentypeNames, id: string): string | undefined {
  for (const platform of ["windows", "macintosh", "unicode"]) {
    const record = names[platform]?.[id];
    const value = record?.en ?? (record ? Object.values(record).find((entry) => entry) : undefined);
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  for (const platform of Object.keys(names)) {
    const record = names[platform]?.[id];
    const value = record?.en ?? (record ? Object.values(record).find((entry) => entry) : undefined);
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function isWoff2(bytes: Uint8Array): boolean {
  // 'wOF2'
  return bytes.length >= 4 && bytes[0] === 0x77 && bytes[1] === 0x4f && bytes[2] === 0x46 && bytes[3] === 0x32;
}

/**
 * Read a font's identity from its own tables, or reject it.
 *
 * Never consults a filename, a MIME type, or anything the caller claims (T-4).
 */
export async function readFontIdentity(bytes: ArrayBuffer): Promise<FontIdentity> {
  if (bytes.byteLength === 0) throw new FontIngestError("empty-file", "That file is empty.");
  if (isWoff2(new Uint8Array(bytes))) {
    // Named rather than left to fail as a generic parse error, because the fix is specific and the
    // generic message ("Unsupported OpenType signature wOF2") reads as "your font is broken" when it
    // is not. `font-outlines.ts:35` records the same limitation for the warp path.
    throw new FontIngestError(
      "woff2-unsupported",
      "WOFF2 fonts must be decompressed before ingest — opentype.js cannot Brotli-decode them. Upload .ttf, .otf or .woff."
    );
  }

  const opentype = await getOpentype();
  let font: ParsedOpentypeFont;
  try {
    font = opentype.parse(bytes);
  } catch (error) {
    // D2: the parse IS the validity check. A file that does not parse is not a font, and we say so
    // here rather than discovering it mid-render.
    throw new FontIngestError("not-a-font", `That file is not a readable font: ${(error as Error)?.message ?? "parse failed"}`);
  }

  // Name ID 16/17 (typographic family/subfamily) when present: for a large family, ID 1 is chopped
  // into four-style groups for legacy Windows menus ("Roboto Condensed Light"), and ID 16 is the
  // real family. Picking ID 1 would shatter one family into many in the picker.
  const family = readName(font.names, "preferredFamily") ?? readName(font.names, "fontFamily");
  if (!family) {
    throw new FontIngestError("no-family-name", "That font has no family name in its name table, so it cannot be identified.");
  }
  const subfamily = readName(font.names, "preferredSubfamily") ?? readName(font.names, "fontSubfamily") ?? "Regular";

  const os2Weight = font.tables.os2?.usWeightClass;
  const weight =
    typeof os2Weight === "number" && Number.isFinite(os2Weight) && os2Weight >= 1 && os2Weight <= 1000
      ? Math.round(os2Weight)
      : (SUBFAMILY_WEIGHTS.find(([pattern]) => pattern.test(subfamily))?.[1] ?? 400);

  // fsSelection bit 0 = ITALIC; head.macStyle bit 1 = italic. Either is authoritative over the name,
  // which is only consulted when neither table is present.
  const fsSelection = font.tables.os2?.fsSelection ?? 0;
  const macStyle = font.tables.head?.macStyle ?? 0;
  const style: "normal" | "italic" =
    (fsSelection & 0x01) !== 0 || (macStyle & 0x02) !== 0 || /\b(italic|oblique)\b/i.test(subfamily) ? "italic" : "normal";

  const licenseText = readName(font.names, "license");
  const license = licenseText ? { text: licenseText, url: readName(font.names, "licenseURL") } : undefined;

  return {
    family,
    subfamily,
    weight,
    style,
    postScriptName: readName(font.names, "postScriptName"),
    license
  };
}

/**
 * The RENDER identity (D1): SHA-256 of the exact bytes, hex.
 *
 * `crypto.subtle` rather than a Node import so the same function runs in the browser (upload, S3)
 * and in the worker (mirror, commit 3) — two hashers would be two chances to disagree about what a
 * font's identity is, and the hash is the thing the manifest pins.
 */
export async function computeFontFileHash(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
