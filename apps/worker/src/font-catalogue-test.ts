/**
 * ADR-023 S2.5 — the catalogue, checked against the files it claims to describe.
 *
 * A font table that is wrong looks exactly like a font table that is right. `warpFontCatalog`, the
 * hand-maintained table this replaces, shipped EMPTY once: every warped family fell through to the
 * Roboto fallback and "changing the font did nothing" reached a user. Nothing about the code was
 * broken — the data was, and nothing looked at the data.
 *
 * So every row is re-hashed here against the file on disk, in BOTH apps, and the pick contract is
 * asserted directly: a pick must produce a `fileHash`, because the entire S2 contract is downstream
 * of that one write.
 *
 * Run: pnpm --filter @orreris/worker font:catalogue-test
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  catalogueFace,
  catalogueFontRef,
  catalogueFaces,
  DEFAULT_WARP_FONT_FILE,
  fontCatalogue,
  isPinnedFontRef,
  LEGACY_WARP_FAMILY_ALIASES,
  normalizeFontRef,
  readFontIdentity,
  renderSafeFonts,
  warpFontFile
} from "@orreris/shared";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const appRoots = [path.join(repoRoot, "apps/worker/public"), path.join(repoRoot, "apps/web/public")];

/**
 * The table exactly as it shipped before the fold, transcribed from `font-outlines.ts` at 72982a3.
 * Kept verbatim so the refactor's claim — "legacy families resolve to the same binary they always
 * did" — is checked against the real previous behaviour rather than against a restatement of the
 * new behaviour, which would agree with any bug that survived the move.
 */
const PRE_FOLD_TABLE: Record<string, { regular: string; bold?: string }> = {
  Arial: { regular: "fonts/Arimo-Regular.ttf", bold: "fonts/Arimo-Bold.ttf" },
  Helvetica: { regular: "fonts/Arimo-Regular.ttf", bold: "fonts/Arimo-Bold.ttf" },
  "system-ui": { regular: "fonts/Arimo-Regular.ttf", bold: "fonts/Arimo-Bold.ttf" },
  Impact: { regular: "fonts/Anton-Regular.ttf" },
  Haettenschweiler: { regular: "fonts/Anton-Regular.ttf" },
  Georgia: { regular: "fonts/Tinos-Regular.ttf", bold: "fonts/Tinos-Bold.ttf" },
  "Times New Roman": { regular: "fonts/Tinos-Regular.ttf", bold: "fonts/Tinos-Bold.ttf" },
  "Courier New": { regular: "fonts/Cousine-Regular.ttf", bold: "fonts/Cousine-Bold.ttf" },
  Courier: { regular: "fonts/Cousine-Regular.ttf", bold: "fonts/Cousine-Bold.ttf" }
};

function preFoldResolve(stack: string, weight: number | undefined): string {
  const primary = (stack.split(",")[0] ?? "").trim().replace(/^['"]|['"]$/g, "");
  const entry = PRE_FOLD_TABLE[primary];
  if (!entry) return DEFAULT_WARP_FONT_FILE;
  return (typeof weight === "number" && Number.isFinite(weight) && weight >= 600 ? entry.bold : undefined) ?? entry.regular;
}

async function main(): Promise<void> {
  assert.ok(fontCatalogue.length > 0, "an EMPTY catalogue is the exact defect this file exists for.");
  assert.ok(
    catalogueFaces().length > renderSafeFonts.length,
    `the catalogue must clear the ceiling, not restate it: ${catalogueFaces().length} faces vs ${renderSafeFonts.length} system stacks.`
  );

  /* ---- Every row describes the file it points at, in both apps. ----------------------------- */
  for (const entry of fontCatalogue) {
    for (const face of entry.faces) {
      const hashes = new Set<string>();
      for (const root of appRoots) {
        const filePath = path.join(root, face.file);
        assert.ok(fs.existsSync(filePath), `${entry.family} ${face.weight}: ${face.file} is missing from ${root}.`);
        const bytes = fs.readFileSync(filePath);
        hashes.add(createHash("sha256").update(bytes).digest("hex"));
      }
      assert.equal(hashes.size, 1, `${face.file} differs between apps/web and apps/worker — the two renderers would install different bytes.`);
      const actual = [...hashes][0]!;
      assert.equal(
        actual,
        face.fileHash,
        `${entry.family} ${face.weight}: catalogue pins ${face.fileHash.slice(0, 12)}… but the file hashes ${actual.slice(0, 12)}…. ` +
          `A pin that does not match its bytes resolves to nothing in the mirror, and the render aborts (T-2).`
      );

      // …and the file is the FACE it claims (T-4). A row can be internally consistent and still
      // point at the wrong font — a copy/paste that swapped two paths keeps every hash valid.
      const buffer = fs.readFileSync(path.join(appRoots[0]!, face.file));
      const identity = await readFontIdentity(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer);
      assert.equal(identity.family, entry.family, `${face.file} says it is "${identity.family}", not "${entry.family}".`);
      assert.equal(identity.weight, face.weight, `${face.file} says weight ${identity.weight}, catalogue says ${face.weight}.`);
      assert.equal(identity.style, face.style);
      assert.ok(identity.license?.text, `${face.file} must carry its license — the mirror refuses fonts without one (T-11).`);
    }
  }

  /* ---- THE ONE WRITE. ------------------------------------------------------------------------ */
  const ref = catalogueFontRef("Anton", 400, "normal");
  assert.ok(ref, "picking a catalogue family must produce a ref.");
  assert.equal(ref.source, "catalogue");
  assert.ok(isPinnedFontRef(ref), "…and it must be PINNED.");
  assert.equal(
    ref.fileHash,
    "a4ba3a92350ebb031da0cb47630ac49eb265082ca1bc0450442f4a83ab947cab",
    "a pick must write a fileHash, not a family string. Everything S2 built — the mirror, the install " +
      "path, the named abort — is downstream of this one field, and a picker that omitted it would look " +
      "identical in the editor while making all of it unreachable."
  );
  // And it must survive normalization as pinned, which is what the manifest actually stores.
  const normalized = normalizeFontRef(ref, "Arial");
  assert.equal(normalized.source, "catalogue");
  assert.ok(isPinnedFontRef(normalized) && normalized.fileHash === ref.fileHash);

  // Weight resolution: nearest available, never a silent drop to the default face.
  assert.equal(catalogueFontRef("Arimo", 900)?.weight, 700, "900 on a 400/700 family resolves to 700.");
  assert.equal(catalogueFontRef("Arimo", 100)?.weight, 400);
  assert.equal(catalogueFontRef("Anton", 900)?.weight, 400, "a single-cut display face stays itself.");
  assert.equal(catalogueFontRef("Nothing Here"), undefined, "an unknown family produces NO ref rather than a wrong one.");
  assert.equal(catalogueFace("Nothing Here"), undefined);

  /* ---- The warp fold: legacy families must resolve exactly as they always did. --------------- */
  const stacks = [
    ...Object.keys(PRE_FOLD_TABLE),
    "Comic Sans MS",
    "",
    "Arial, Helvetica, sans-serif",
    "'Courier New', Courier, monospace",
    "Impact, Haettenschweiler, 'Arial Narrow Bold', sans-serif",
    "Georgia, 'Times New Roman', serif",
    "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
  ];
  const weights: Array<number | undefined> = [undefined, 100, 400, 500, 599, 600, 700, 900];
  for (const stack of stacks) {
    for (const weight of weights) {
      assert.equal(
        warpFontFile(stack, weight),
        preFoldResolve(stack, weight),
        `warp fold changed a LEGACY family: "${stack}" @${weight}. The fold is a refactor; the warp path is a render path.`
      );
    }
  }
  // Every alias must name a family the catalogue actually has, or the alias silently means "Roboto".
  for (const [legacy, family] of Object.entries(LEGACY_WARP_FAMILY_ALIASES)) {
    assert.ok(catalogueFace(family), `alias ${legacy} → ${family}, which is not in the catalogue.`);
  }
  // What the fold DID change, asserted so it is a decision rather than a surprise: a catalogue family
  // named directly now warps in itself. It could not be named before (renderSafeFonts never offered
  // it), and with the picker it will be.
  assert.equal(warpFontFile("Anton", 400), "fonts/Anton-Regular.ttf");
  assert.equal(preFoldResolve("Anton", 400), DEFAULT_WARP_FONT_FILE, "…which used to fall back to Roboto.");
  assert.equal(warpFontFile("Tinos", 700), "fonts/Tinos-Bold.ttf");
  // The fallback still works for a family with no face at all — warp degrades, it does not break.
  assert.equal(warpFontFile("Wingdings", 400), DEFAULT_WARP_FONT_FILE);

  console.log(`Font catalogue passed. ${fontCatalogue.length} families, ${catalogueFaces().length} faces, all hashes verified.`);
}

main().catch((error) => {
  process.stderr.write(`${String(error?.stack ?? error)}\n`);
  process.exit(1);
});
