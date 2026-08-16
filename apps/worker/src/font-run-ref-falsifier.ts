/**
 * ADR-023 S10 — flip a RUN's `fontRef` and prove the RENDER changes, one layer down from
 * `font-ref-falsifier.ts`'s own claim about the LAYER field.
 *
 * WHY A SEPARATE FILE rather than a new arm in `font-ref-falsifier.ts`: that file's subject is
 * `getCompositionFontRef`/the layer's own field, reached through `MANIFEST_LAYER_STYLE_KEYS`. This
 * file's subject is `getCompositionRunFontRef`/`getCompositionTextRunStyle`'s new third parameter,
 * reached through `textRuns` — a field that was ALREADY in the manifest bag before S10 (T-9 does not
 * require a new arm for every new FIELD VALUE a field can carry, only for every new field), so the
 * risk here is not "did the bag forget it" but "does the run's OWN ref win over the layer's, and does
 * an existing run's plain string keep meaning what it always meant."
 *
 * THE NAME-MATCHING TRAP, and why the two arms below name the SAME family on purpose. The dangerous
 * bug is not "a run's font does nothing" (that would be obvious in any screenshot) — it is "a run's
 * `fontFamily` STRING gets silently resolved through the catalogue because it happens to share a name
 * with a bundled family," which reads as *more* correct in a casual look, not less. Both arms below
 * ask for a run named "Anton": one via a plain CSS stack (the pre-S10, forever-system path), one via
 * a real pinned `FontRef`. If a future edit ever name-matched the first onto the second, this
 * falsifier is the one thing that would still catch it — pixel EQUALITY where the assertion demands
 * inequality, T-17's shape.
 *
 * SELF-ESTABLISHING, not host-dependent: rather than asserting "this host does not have a font
 * literally named Anton" (the exact trap `font-install-gate.ts` documents avoiding), this renders the
 * SAME composition twice, changing only whether the second run carries a real `fontRef` — so the
 * comparison is against itself, not against an assumption about the render box's font folder.
 *
 * Run: pnpm --filter @orreris/worker font:run-ref-falsifier
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRenderManifest } from "@orreris/render-templates";
import { catalogueFontRef, createRenderComparisonFixture, renderComparisonFrameSeconds, type TextRun } from "@orreris/shared";
import { assertQuietBrowserMachine, listAutomationBrowsers } from "./browser/browser-preflight";
import { renderManifestStill } from "./remotion-renderer";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const outDir = path.join(repoRoot, "tmp", "font-run-ref-falsifier");

/** A name shared by a legacy CSS stack AND a bundled catalogue family — the collision the
 *  name-matching trap needs to be reachable at all. */
const SHARED_FAMILY_NAME = "Anton";
const LEGACY_STACK = `${SHARED_FAMILY_NAME}, sans-serif`;

/** Render `scaled-text` with its text layer's runs set to two runs, and hash the PNG. */
async function renderWithRuns(runs: TextRun[], label: string): Promise<string> {
  const fixture = createRenderComparisonFixture("scaled-text");
  const composition = fixture.graph.composition;
  if (!composition) throw new Error(`Fixture "scaled-text" must include a composition.`);

  let textLayersTouched = 0;
  const graph = {
    ...fixture.graph,
    composition: {
      ...composition,
      tracks: composition.tracks.map((track) => ({
        ...track,
        layers: track.layers.map((layer) => {
          if (layer.type !== "text") return layer;
          textLayersTouched += 1;
          return { ...layer, text: runs.map((r) => r.text).join(""), textRuns: runs };
        })
      }))
    }
  };
  assert.ok(textLayersTouched > 0, `Fixture "scaled-text" has no text layer to set textRuns on — the arm is void.`);

  const manifest = buildRenderManifest({
    projectId: graph.projectId,
    graph,
    assets: fixture.assets,
    quality: "final",
    createdAt: new Date(0).toISOString()
  });
  const frame = Math.round(renderComparisonFrameSeconds * manifest.output.fps);
  const outputLocation = path.join(outDir, `${label}.png`);
  await renderManifestStill({ manifest, frame, outputLocation, rendererMode: "webgl" });
  return createHash("sha256").update(fs.readFileSync(outputLocation)).digest("hex");
}

async function main(): Promise<void> {
  assertQuietBrowserMachine({ label: "font:run-ref-falsifier", scriptMarker: "font-run-ref-falsifier" });
  process.stdout.write(`preflight: ${listAutomationBrowsers().length} automation browser process(es) alive (must be 0)\n`);
  fs.mkdirSync(outDir, { recursive: true });

  const bundledAnton = catalogueFontRef(SHARED_FAMILY_NAME, 400, "normal");
  assert.ok(bundledAnton, `${SHARED_FAMILY_NAME} must be a bundled catalogue family — the arm is void otherwise.`);

  // Arm A — BOTH runs name "Anton" as a plain CSS stack. Neither carries a `fontRef`.
  const bothLegacy = await renderWithRuns(
    [
      { text: "LEG", fontFamily: LEGACY_STACK },
      { text: "ACY", fontFamily: LEGACY_STACK }
    ],
    "both-legacy"
  );

  // Arm B — the SECOND run now carries a real pinned `fontRef` for the SAME family name. If the run
  // resolver ever name-matched the string in arm A onto this file, arms A and B would render
  // identically (the trap this whole falsifier exists to catch).
  const secondPinned = await renderWithRuns(
    [
      { text: "LEG", fontFamily: LEGACY_STACK },
      { text: "ACY", fontFamily: SHARED_FAMILY_NAME, fontRef: bundledAnton }
    ],
    "second-pinned"
  );

  process.stdout.write(`both-legacy=${bothLegacy.slice(0, 12)}  second-pinned=${secondPinned.slice(0, 12)}\n`);

  assert.notEqual(
    bothLegacy,
    secondPinned,
    "FALSIFIER FAILED — giving the second run a real pinned `FontRef` produced a BYTE-IDENTICAL " +
      "render to the same run naming the family as a plain CSS string. Either `run.fontRef` is not " +
      "reaching `getCompositionTextRunStyle` (check `getCompositionRunFontRef`'s precedence), or a " +
      "legacy `fontFamily` string is being name-matched onto the catalogue family it happens to share " +
      "a name with — which S10's two-constants rule (D1a) forbids: 'Anton' typed as a system stack and " +
      "'Anton' pinned by hash must be different renders."
  );

  // D1a's legacy control, one layer down: a run with ONLY a `fontFamily` string (no ref — arm A's
  // FIRST run, unchanged between arms) must render IDENTICALLY to how it always did — proven here by
  // running the SAME first-run text/style through a layer with nothing else on the line, and checking
  // it against a hand-built single-run composition with the identical legacy stack.
  const singleRunLegacy = await renderWithRuns([{ text: "LEGACY", fontFamily: LEGACY_STACK }], "single-run-legacy");
  const singleRunSplit = await renderWithRuns(
    [
      { text: "LEG", fontFamily: LEGACY_STACK },
      { text: "ACY", fontFamily: LEGACY_STACK }
    ],
    "single-run-split"
  );
  process.stdout.write(`single-run=${singleRunLegacy.slice(0, 12)}  split-same-style=${singleRunSplit.slice(0, 12)}\n`);
  assert.equal(
    singleRunLegacy,
    singleRunSplit,
    "D1a FAILED (run level) — splitting one legacy-stack run into two runs of the SAME stack changed " +
      "the render. A run's own `fontFamily` string must resolve exactly as a system stack, byte-for-byte, " +
      "with or without a sibling run present."
  );

  process.stdout.write(
    "PASS — a run's own fontRef changes the render, a legacy fontFamily string is never name-matched " +
      "onto a catalogue family, and splitting same-style text into two runs moves nothing.\n"
  );
  process.stdout.write(`stills: ${outDir}\n`);
}

main().catch((error) => {
  process.stderr.write(`${String(error?.stack ?? error)}\n`);
  process.exit(1);
});
