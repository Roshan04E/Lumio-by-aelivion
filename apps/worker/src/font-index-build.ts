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
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const outFile = path.join(repoRoot, "packages/shared/src/font-index-data.ts");

const METADATA_URL = "https://fonts.google.com/metadata/fonts";
export const TREE_URL = "https://api.github.com/repos/google/fonts/git/trees/main?recursive=1";

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

/**
 * The licence code for a family this index has VERIFIED has none, permanently — as opposed to
 * "we looked and found nothing this run" (see `main`'s exhaustiveness check below, which is what
 * catches the difference).
 *
 * Two families, both Google-proprietary: absent from `google/fonts` entirely (no `ofl/`, `apache/`
 * or `ufl/` directory — checked directly against the live tree, 2026-08-16) AND their own served
 * bytes carry no name-table licence either (IDs 13/14 stripped, measured). That is not a lookup
 * failure to paper over; it is the actual, correct answer, and it is worth a code of its own rather
 * than the same empty string a lookup MISS would produce — an empty field reads downstream as
 * "unknown, might resolve later," and for these two it never will.
 *
 * **This is a manually-maintained allowlist, not inferred from any metadata flag.** `isOpenSource`
 * is true for every family the API returns (checked, elsewhere in this file) and `isBrandFont` is
 * true for the entire Noto family tree too — which DOES have a real licence — so neither flag can
 * stand in for "genuinely unlicensed." A family belongs on this list only after being checked the
 * way the two below were: no directory, no name-table licence, confirmed by hand.
 */
export const RESTRICTED_LICENSE_CODE = "x";
export const RESTRICTED_FAMILIES = new Set(["Google Sans", "Google Sans Flex"]);

/**
 * The code for a family this run could not resolve a licence for, and which is not on
 * `RESTRICTED_FAMILIES` either — an ACKNOWLEDGED gap, not a verified permanent answer.
 *
 * Distinct from `RESTRICTED_LICENSE_CODE` on purpose: "restricted" is a checked, permanent fact about
 * the family. This code means "the lookup missed, a human has seen that and written the date down,
 * and the catalogue is choosing to ship anyway rather than block on a live upstream repo." The picker
 * must treat it as unpickable-for-now (see `entry.unresolved` in `font-index.ts` / `FontPicker.tsx`),
 * never silently offered — that offerable-but-unpickable gap is the same surface-reports-the-symptom
 * defect this stage exists to remove, one layer down.
 */
export const UNRESOLVED_LICENSE_CODE = "?";

/**
 * Families a human has SEEN unresolved and chosen to ship anyway, dated. This is an ACKNOWLEDGEMENT,
 * never a mute button: `main()` below still fails the whole build for any family that is unresolved
 * and NOT on this list. Being on this list only changes the row's code from "refuse to write the
 * catalogue" to "write it, flagged `unresolved: true`, and let the picker say so."
 *
 * Re-check periodically — a family here that starts resolving normally should be REMOVED (main() logs
 * when that happens, but does not fail the build over it; removing a stale entry is housekeeping, not
 * urgency). Dated 2026-08-16 investigation: `google/fonts`'s live tree had no licence file reachable at
 * these ten families' expected path, despite each declaring `license: "OFL"` in its own METADATA.pb.
 */
export const KNOWN_UNRESOLVED_LICENSES: Record<string, string> = {
  Tinos: "2026-08-16",
  "M PLUS Rounded 1c": "2026-08-16",
  "Kumar One Outline": "2026-08-16",
  "Playwrite NZ Basic Guides": "2026-08-16",
  "Edu NSW ACT Cursive": "2026-08-16",
  "Edu SA Hand": "2026-08-16",
  "Edu VIC WA NT Hand Pre": "2026-08-16",
  "Edu NSW ACT Hand Pre": "2026-08-16",
  "Edu VIC WA NT Hand": "2026-08-16",
  "Edu QLD Hand": "2026-08-16"
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
export function familySlug(family: string): string {
  return family.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Slug → licence code, from a `google/fonts` git tree listing. Extracted from `main` so
 * `font-index-build-test.ts` can exercise the REAL lookup against a REAL, freshly-fetched tree
 * without going through metadata fetch + file write — the failure this stage exists to catch is a
 * missed FILE, and a test that reimplemented the regex would agree with the regex being wrong.
 */
export function buildLicenseCodeBySlug(tree: { path: string }[]): Map<string, string> {
  const licenseCodeBySlug = new Map<string, string>();
  for (const [code, template] of Object.entries(LICENSE_PATHS)) {
    const pattern = new RegExp(`^${template.replace("%", "([^/]+)").replace(/\./g, "\\.")}$`);
    for (const entry of tree) {
      const match = pattern.exec(entry.path);
      // First code wins, in LICENSE_PATHS order — a directory never carries two of these.
      if (match?.[1] && !licenseCodeBySlug.has(match[1])) licenseCodeBySlug.set(match[1], code);
    }
  }
  return licenseCodeBySlug;
}

/**
 * The licence code a family resolves to, or `undefined` when this run cannot answer either way — the
 * `unresolvedLicenses` case in `main` below. Also extracted for `font-index-build-test.ts`: this one
 * function is the entire "ten free fonts blamed for a lookup miss" defect, isolated from the network
 * calls around it.
 */
export function resolveLicenseCode(familyName: string, licenseCodeBySlug: ReadonlyMap<string, string>): string | undefined {
  return licenseCodeBySlug.get(familySlug(familyName)) ?? (RESTRICTED_FAMILIES.has(familyName) ? RESTRICTED_LICENSE_CODE : undefined);
}

/**
 * The full three-way outcome `main()` writes into a row, and what `font-index-license-test.ts`
 * exercises directly — the whole "unresolved must never become a silent blank OR a silent restriction"
 * claim lives in this one function, network calls aside.
 */
export function classifyFamilyLicense(familyName: string, licenseCodeBySlug: ReadonlyMap<string, string>): { code: string; failBuild: boolean } {
  const resolved = resolveLicenseCode(familyName, licenseCodeBySlug);
  if (resolved !== undefined) return { code: resolved, failBuild: false };
  if (KNOWN_UNRESOLVED_LICENSES[familyName]) return { code: UNRESOLVED_LICENSE_CODE, failBuild: false };
  return { code: "", failBuild: true };
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

  const licenseCodeBySlug = buildLicenseCodeBySlug(tree.tree);

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

  /** Families that expected a licence (not on `RESTRICTED_FAMILIES`, not on
   *  `KNOWN_UNRESOLVED_LICENSES`) and found none. See the exhaustiveness check right after `lines`
   *  below. */
  const unresolvedLicenses: string[] = [];
  /** Families ON `KNOWN_UNRESOLVED_LICENSES` that resolved fine this run — the acknowledgement is
   *  stale and should be removed (housekeeping, not a build failure). */
  const staleAcknowledgements: string[] = [];

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
    /**
     * A code from FOUR sources, in order, and an empty string is no longer one of them:
     *  1. A real licence file found in `google/fonts` — the common case.
     *  2. `RESTRICTED_LICENSE_CODE` — this family is on the manually-verified "genuinely has none"
     *     list, checked by hand, not inferred. A permanent fact.
     *  3. `UNRESOLVED_LICENSE_CODE` — the lookup missed, but a human has SEEN that and dated it on
     *     `KNOWN_UNRESOLVED_LICENSES`. The catalogue ships this family flagged `unresolved: true`
     *     rather than blocking on a live upstream repo; the picker keeps it visible-but-unpickable
     *     with a stated reason (D3), never silently offered.
     *  4. Neither — collected into `unresolvedLicenses` below rather than emitted as `""`. An empty
     *     field here used to mean "no licence file in google/fonts", read downstream as a licence
     *     FACT (`fontIndex()`'s own doc: "the mirror falls back to the name table"); it was actually
     *     just as often "the lookup missed" — ten free, properly-licensed families came back this
     *     way, and a silent miss reads exactly like the two that are genuinely unlicensed. See
     *     `main`'s exhaustiveness check for what happens to this list.
     */
    const outcome = classifyFamilyLicense(family.family, licenseCodeBySlug);
    if (outcome.failBuild) unresolvedLicenses.push(family.family);
    else if (outcome.code !== UNRESOLVED_LICENSE_CODE && KNOWN_UNRESOLVED_LICENSES[family.family]) staleAcknowledgements.push(family.family);
    return `${family.family}|${CATEGORY_CODE[family.category]}|${faces}|${subsets}|${outcome.code}`;
  });

  /**
   * THE EXHAUSTIVENESS CHECK. A family this index expected to resolve a licence for — everything
   * that is not on `RESTRICTED_FAMILIES` — and did not, fails the WHOLE build rather than shipping a
   * catalogue with an ambiguous blank in it. `warpFontCatalog` shipped empty once and nobody noticed
   * until a user did; a `""` here is the same failure at smaller scale, and this is the check that
   * turns it into something a human sees at build time instead.
   *
   * Not a per-family skip: refusing the WHOLE run is what makes this impossible to routinely ignore.
   * A build that silently drops ten rows and ships the other 1932 still passes a glance at the
   * family count; a build that refuses outright, naming names, does not.
   */
  if (unresolvedLicenses.length) {
    throw new Error(
      `${unresolvedLicenses.length} famil${unresolvedLicenses.length === 1 ? "y" : "ies"} expected a licence and none was found ` +
        `(not in google/fonts, not on RESTRICTED_FAMILIES, not acknowledged on KNOWN_UNRESOLVED_LICENSES): ${unresolvedLicenses.join(", ")}. ` +
        `This is not a mute-and-move-on situation. Check each by hand, then either: (a) if google/fonts genuinely ` +
        `lacks the licence file right now, add the family to KNOWN_UNRESOLVED_LICENSES with today's date so the ` +
        `build can proceed with it flagged unresolved-but-visible, or (b) if it is verified proprietary with no ` +
        `public licence at all, add it to RESTRICTED_FAMILIES. Never widen this into a silent empty field.`
    );
  }

  if (staleAcknowledgements.length) {
    console.log(
      `${staleAcknowledgements.length} famil${staleAcknowledgements.length === 1 ? "y" : "ies"} on KNOWN_UNRESOLVED_LICENSES resolved a real ` +
        `licence this run and no longer need the acknowledgement — remove from the list: ${staleAcknowledgements.join(", ")}`
    );
  }

  const faceCount = usable.reduce((total, family) => total + Object.keys(family.fonts).length, 0);
  const restrictedCount = lines.filter((line) => line.endsWith(`|${RESTRICTED_LICENSE_CODE}`)).length;
  const unresolvedCount = lines.filter((line) => line.endsWith(`|${UNRESOLVED_LICENSE_CODE}`)).length;

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
 * either a key of FONT_INDEX_LICENSE_PATHS, "${RESTRICTED_LICENSE_CODE}" for a family verified to have
 * no public licence at all (Google-proprietary — see RESTRICTED_FAMILIES in font-index-build.ts), or
 * "${UNRESOLVED_LICENSE_CODE}" for a family a human has acknowledged and dated on
 * KNOWN_UNRESOLVED_LICENSES (the lookup missed, shipped anyway, flagged unresolved). NEVER empty: a
 * family this build could not resolve AND could not find acknowledged fails the whole run rather than
 * shipping a blank that reads as a licence fact — ${restrictedCount} famil${restrictedCount === 1 ? "y is" : "ies are"} restricted,
 * ${unresolvedCount} famil${unresolvedCount === 1 ? "y is" : "ies are"} unresolved-but-acknowledged, this run.
 */
export const FONT_INDEX_SUBSETS: readonly string[] = ${JSON.stringify(subsetTable, null, 0).replace(/","/g, '", "')};

/** Licence code → path in \`google/fonts\`, with \`%\` standing for the family's directory slug. Does
 *  NOT include "${RESTRICTED_LICENSE_CODE}" (restricted) — that code names no path; see font-index.ts's decoder. */
export const FONT_INDEX_LICENSE_PATHS: Readonly<Record<string, string>> = ${JSON.stringify(LICENSE_PATHS, null, 2).replace(/\n/g, "\n")};

export const FONT_INDEX_RAW = \`${lines.join("\n")}\`;
`;

  fs.writeFileSync(outFile, source, "utf8");
  const kb = (Buffer.byteLength(source, "utf8") / 1024).toFixed(0);
  console.log(`Wrote ${usable.length} families / ${faceCount} faces / ${subsetTable.length} subsets → ${path.relative(repoRoot, outFile)} (${kb} KB)`);
}

// Guarded: `font-index-license-test.ts` imports this module's pure exports (`resolveLicenseCode`,
// `buildLicenseCodeBySlug`) without wanting the full network-fetching, file-writing `main()` to run
// as an import side effect. `require.main === module`'s ESM shape — `pathToFileURL` rather than a
// hand-built `file://${...}` string because `process.argv[1]` is a Windows backslash PATH, not a URL,
// and comparing it against `import.meta.url` (always forward-slashed) as a raw string silently never
// matches on Windows: the guard would swallow every direct `tsx font-index-build.ts` run too.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${String(error?.stack ?? error)}\n`);
    process.exit(1);
  });
}
