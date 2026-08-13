/**
 * ADR-023 T-15 — flip `fontRef` and prove the RENDER changes.
 *
 * WHY: `render:compare:pixels` compares two consumers of the same manifest bag, so it cannot detect
 * a field that never reached the bag — both renderers agree, at 0.000%, about an answer neither was
 * given. S1 shipped within one commit of exactly that. Every field this stage adds to the manifest
 * gets an arm here.
 *
 * SUBJECT — the same text layer rendered with two `{ source: "system" }` refs carrying different
 * stacks. The renders MUST differ. If they do not, `fontRef` is not reaching the renderer.
 *
 * LEGACY CONTROL — and this is the arm that matters most for commit 1, whose whole claim is "no
 * existing project moved": a layer with NO `fontRef` and a layer with an explicit system ref
 * carrying its own stack must be BYTE-IDENTICAL. That is D1a asserted in pixels rather than in
 * prose — normalization must be a no-op on legacy data, not merely an equivalent answer.
 *
 * Run: pnpm --filter @orreris/worker font:ref-falsifier
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRenderManifest } from "@orreris/render-templates";
import {
  createRenderComparisonFixture,
  renderComparisonFrameSeconds,
  type FontRef,
  type RenderComparisonFixtureKey
} from "@orreris/shared";
import { assertQuietBrowserMachine, listAutomationBrowsers } from "./browser/browser-preflight";
import { renderManifestStill } from "./remotion-renderer";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const outDir = path.join(repoRoot, "tmp", "font-ref-falsifier");

/**
 * Render a fixture with every text layer's `fontRef` set to `ref` (or explicitly REMOVED when `ref`
 * is null, which is the legacy arm), and hash the PNG.
 */
async function renderWithRef(key: RenderComparisonFixtureKey, ref: FontRef | null, label: string): Promise<string> {
  const fixture = createRenderComparisonFixture(key);
  const composition = fixture.graph.composition;
  if (!composition) throw new Error(`Fixture "${key}" must include a composition.`);

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
          return { ...layer, fontRef: ref ?? undefined };
        })
      }))
    }
  };
  // An arm that overrode nothing would compare a fixture with itself and pass forever.
  assert.ok(textLayersTouched > 0, `Fixture "${key}" has no text layer to set fontRef on — the arm is void.`);

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

/**
 * The stack the `scaled-text` fixture authors its layer with (`render-comparison-fixture.ts:2107`),
 * read from the fixture rather than assumed — the legacy control is worthless if the "same stack"
 * arm is not actually the same stack, and it would still PASS the inequality arm while doing so.
 */
const OWN_STACK = "Arial";

async function main(): Promise<void> {
  assertQuietBrowserMachine({ label: "font:ref-falsifier", scriptMarker: "font-ref-falsifier" });
  process.stdout.write(`preflight: ${listAutomationBrowsers().length} automation browser process(es) alive (must be 0)\n`);
  fs.mkdirSync(outDir, { recursive: true });

  const absent = await renderWithRef("scaled-text", null, "legacy-absent");
  const explicitOwn = await renderWithRef("scaled-text", { source: "system", fontFamily: OWN_STACK }, "legacy-explicit");
  const courier = await renderWithRef(
    "scaled-text",
    { source: "system", fontFamily: "'Courier New', Courier, monospace" },
    "system-courier"
  );
  process.stdout.write(
    `absent=${absent.slice(0, 12)}  explicit-same-stack=${explicitOwn.slice(0, 12)}  courier=${courier.slice(0, 12)}\n\n`
  );

  assert.notEqual(
    courier,
    absent,
    "FALSIFIER FAILED — changing `fontRef` produced a BYTE-IDENTICAL render. The field is not reaching " +
      "the renderer: check that the manifest's style bag carries it (MANIFEST_LAYER_STYLE_KEYS) and " +
      "that getCompositionTextStyle reads it via getCompositionFontRef. render:compare:pixels cannot " +
      "see this — it compares two consumers of the same bag."
  );
  assert.equal(
    explicitOwn,
    absent,
    "D1a FAILED — a layer with no `fontRef` and a layer with an explicit system ref carrying its own " +
      "stack rendered DIFFERENTLY. Normalization must be a no-op on legacy data. If these diverge, " +
      "every project authored before this field existed has just moved."
  );

  process.stdout.write("PASS — fontRef changes the render, and normalizing legacy data changes nothing.\n");
  process.stdout.write(`stills: ${outDir}\n`);
}

main().catch((error) => {
  process.stderr.write(`${String(error?.stack ?? error)}\n`);
  process.exit(1);
});
