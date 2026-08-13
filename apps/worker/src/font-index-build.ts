/**
 * ADR-023 S2.6 — regenerate the font INDEX from Google's catalogue metadata.
 *
 * The index is what breaks S2.5's circle. Mirror-on-first-use (D4) means a family costs nothing
 * until someone picks it — but the picker could only list what had already been mirrored, so nothing
 * was ever picked, so nothing was ever mirrored. Five families, forever.
 *
 * What this writes is **metadata only**: family, category, faces, subsets. No bytes, no URLs, no
 * hashes. The bytes still arrive on first use through `mirrorCatalogueFont`, unchanged, and the
 * `fileHash` a `FontRef` pins is still whatever the mirror actually hashed — never something this
 * file asserted. That separation is deliberate: an index that carried hashes would be a second
 * source of truth about bytes, and the whole of S2 exists because a name is not bytes.
 *
 * Run when the catalogue should be refreshed:
 *   pnpm --filter @orreris/worker font:index-build
 *
 * It is a checked-in generated file rather than a runtime fetch, for two reasons: the picker must
 * open instantly and offline, and a list that changes under you between sessions is a list whose
 * gates cannot be reproduced.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const outFile = path.join(repoRoot, "packages/shared/src/font-index-data.ts");

const METADATA_URL = "https://fonts.google.com/metadata/fonts";
const TREE_URL = "https://api.github.com/repos/google/fonts/git/trees/main?recursive=1";

/**
 * **Where a family's LICENCE lives, and why the index has to know.**
 *
 * S2.3 read the licence out of the font's own name table (IDs 13/14) and refused any font without
 * one — correct for the bundled faces, which come from full upstream builds. It does not survive
 * contact with Google's CDN: **every static instance served from `fonts.gstatic.com` has name IDs
 * 13/14 stripped**, measured across Cairo, Amiri, Noto Naskh Arabic, Inter and Google Sans. Read the
 * name table alone and `mirrorCatalogueFont` refuses every single family the picker can offer, and
 * mirror-on-pick is dead on arrival.
 *
 * The licence is not missing, only stored elsewhere: `google/fonts` keeps one per family directory.
 * So the index records WHICH file, the mirror fetches font and licence together and writes both or
 * neither, and T-11 is satisfied exactly as written — one operation, never served without it. What
 * changes is where the licence bytes come from, not whether they are mandatory.
 */
const LICENSE_PATHS: Record<string, string> = {
  o: "ofl/%/OFL.txt",
  a: "apache/%/LICENSE.txt",
  u: "ufl/%/UFL.txt",
  c: "ufl/%/LICENCE.txt"
};

interface GoogleFamily {
  family: string;
  category: string;
  subsets: string[];
  fonts: Record<string, unknown>;
  popularity: number;
  isOpenSource: boolean;
}

/** Google's prose categories → the five-letter codes the index stores. */
const CATEGORY_CODE: Record<string, string> = {
  "Sans Serif": "s",
  Serif: "f",
  Display: "d",
  Handwriting: "h",
  Monospace: "m"
};

/** The `google/fonts` directory name for a family. Verified against the real tree, below. */
function familySlug(family: string): string {
  return family.toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function main(): Promise<void> {
  const response = await fetch(METADATA_URL);
  if (!response.ok) throw new Error(`metadata fetch failed: ${response.status}`);
  const payload = (await response.json()) as { familyMetadataList: GoogleFamily[] };
  const families = payload.familyMetadataList;
  if (!Array.isArray(families) || families.length < 500) {
    // An index that silently comes back tiny is the empty-`warpFontCatalog` incident with a network
    // in front of it: the picker would still open, still look like a font list, and list nothing.
    throw new Error(`metadata returned ${families?.length ?? 0} families — refusing to write a catalogue that small.`);
  }

  /**
   * `isOpenSource` is TRUE for every family in this payload, so it filters nothing and is not
   * treated as a licence check. The actual licence gate is `mirrorCatalogueFont`, which refuses any
   * font whose own name table declares no licence (D4a/T-11) — a check on the bytes, not on a flag
   * in a JSON file we did not write.
   */
  // One request for the whole repo tree, rather than 1942 directory listings. `truncated` is the
  // failure that would silently halve the licence coverage, so it is checked rather than assumed.
  const treeResponse = await fetch(TREE_URL);
  if (!treeResponse.ok) throw new Error(`google/fonts tree fetch failed: ${treeResponse.status}`);
  const tree = (await treeResponse.json()) as { truncated?: boolean; tree?: Array<{ path: string }> };
  if (tree.truncated) throw new Error("google/fonts tree came back TRUNCATED — licence coverage would be silently partial.");
  if (!tree.tree?.length) throw new Error("google/fonts tree came back empty.");

  const licenseCodeBySlug = new Map<string, string>();
  for (const [code, template] of Object.entries(LICENSE_PATHS)) {
    const pattern = new RegExp(`^${template.replace("%", "([^/]+)").replace(/\./g, "\\.")}$`);
    for (const entry of tree.tree) {
      const match = pattern.exec(entry.path);
      // First code wins, in LICENSE_PATHS order — a directory never carries two of these.
      if (match?.[1] && !licenseCodeBySlug.has(match[1])) licenseCodeBySlug.set(match[1], code);
    }
  }

  const usable = families
    .filter((family) => CATEGORY_CODE[family.category] && family.subsets.length > 0)
    // Popularity order IS the default sort, so the reader's first screen is the fonts people use.
    // Storing the order rather than the rank costs zero bytes.
    .sort((a, b) => a.popularity - b.popularity);

  // Subsets are interned: "latin" appears 1821 times and "latin-ext" 1518, and spelling them out per
  // family roughly doubles the file for no added information.
  const subsetTable: string[] = [];
  const subsetIndex = new Map<string, number>();
  const subsetCode = (name: string): number => {
    const existing = subsetIndex.get(name);
    if (existing !== undefined) return existing;
    const code = subsetTable.length;
    subsetTable.push(name);
    subsetIndex.set(name, code);
    return code;
  };

  const lines = usable.map((family) => {
    // Google keys faces as "400" / "400i". Kept verbatim: the decoder reads the trailing "i" as
    // italic, and inventing a different spelling here would mean two encodings of one fact.
    const faces = Object.keys(family.fonts)
      .filter((key) => /^\d+i?$/.test(key))
      .sort((a, b) => (parseInt(a, 10) - parseInt(b, 10)) || (a.length - b.length))
      .join(",");
    const subsets = family.subsets
      // "menu" is Google's tiny name-only subset used to render its own list. It is not a script and
      // must never appear as a filter, or every family matches it and the filter means nothing.
      .filter((subset) => subset !== "menu")
      .map((subset) => subsetCode(subset))
      .join(",");
    // The emitted file is a template literal, so a family carrying a separator, a backtick or a
    // `${` would either corrupt the format or execute. Refuse rather than escape: a font name that
    // needs escaping is a signal the format is wrong, not a case to paper over.
    if (/[|`\n]|\$\{/.test(family.family)) throw new Error(`family name is not safe for the index format: ${family.family}`);
    // Empty means "no licence file in google/fonts". Those families are still LISTED, because the
    // font's own name table may still carry one and the mirror checks both — and if neither has it,
    // the pick fails with a named error, which is the visible refusal D4a wants rather than a family
    // quietly absent from the picker for a reason no one can see.
    const license = licenseCodeBySlug.get(familySlug(family.family)) ?? "";
    return `${family.family}|${CATEGORY_CODE[family.category]}|${faces}|${subsets}|${license}`;
  });

  const faceCount = usable.reduce((total, family) => total + Object.keys(family.fonts).length, 0);

  const source = `/**
 * ADR-023 S2.6 — GENERATED. Do not edit by hand.
 *
 * Regenerate with: pnpm --filter @orreris/worker font:index-build
 * Source: ${METADATA_URL}
 * Generated: ${new Date().toISOString().slice(0, 10)} — ${usable.length} families, ${faceCount} faces.
 *
 * METADATA ONLY. No URLs, no hashes, no bytes. A row here says a family EXISTS, what faces and
 * scripts it has, and where its LICENCE lives; it does not say what any of them weigh in SHA-256,
 * because that answer belongs to the mirror, which hashes what it actually fetched (D1). See
 * \`font-index.ts\` for the decoder and the format.
 *
 * One line per family, in POPULARITY order — the order is the default sort and costs nothing to
 * store. Fields: family|category|faces|subsets|licence, where category is one of s/f/d/h/m, faces
 * are Google's own keys ("400", "700i"), subsets are indices into FONT_INDEX_SUBSETS, and licence is
 * a key of FONT_INDEX_LICENSE_PATHS (empty when \`google/fonts\` carries no licence file for the
 * family — ${lines.filter((line) => line.endsWith("|")).length} of ${lines.length}, which fall back to the font's own name table).
 */
export const FONT_INDEX_SUBSETS: readonly string[] = ${JSON.stringify(subsetTable, null, 0).replace(/","/g, '", "')};

/** Licence code → path in \`google/fonts\`, with \`%\` standing for the family's directory slug. */
export const FONT_INDEX_LICENSE_PATHS: Readonly<Record<string, string>> = ${JSON.stringify(LICENSE_PATHS, null, 2).replace(/\n/g, "\n")};

export const FONT_INDEX_RAW = \`${lines.join("\n")}\`;
`;

  fs.writeFileSync(outFile, source, "utf8");
  const kb = (Buffer.byteLength(source, "utf8") / 1024).toFixed(0);
  console.log(`Wrote ${usable.length} families / ${faceCount} faces / ${subsetTable.length} subsets → ${path.relative(repoRoot, outFile)} (${kb} KB)`);
}

main().catch((error) => {
  process.stderr.write(`${String(error?.stack ?? error)}\n`);
  process.exit(1);
});
