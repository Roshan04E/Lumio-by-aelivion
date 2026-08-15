/**
 * ADR-023 S6 — **look at the presets.** Renders every first-party look through the REAL Remotion
 * renderer and writes two contact sheets.
 *
 * WHY THIS EXISTS, and it is the whole S5 lesson: that stage shipped with parity at 0.000%, a passing
 * T-15 flip, byte-exact emitted style and byte-identical no-op arms — while line two's pill painted
 * over line one's descenders in BOTH renderers. Every instrument agreed, and every instrument was
 * answering "does the field reach the renderer" when the question was "is the picture right".
 *
 * `presets:test` proves each preset changes the emitted style. It cannot prove the look is any good,
 * that a stroke is not eating the letterform, or that a pill is not sitting on the line above. S6
 * ships looks people will apply with one click, so somebody has to LOOK at them. This is what they
 * look at.
 *
 * It is a viewer, not a gate: it asserts only the preconditions that would make the picture a lie
 * (the mirror really holds the pinned bytes; every preset really reached a layer). Nothing here
 * compares to a baseline, because there is no correct answer to compare against — that is the point.
 *
 * **The ground layer is load-bearing and is not decoration.** A media layer sits behind the cells for
 * two reasons, the second of which is a defect this script found:
 *
 *  1. White looks vanish on white and dark looks vanish on black. A sheet that hides half its
 *     subjects is worse than no sheet, and the manifest's own background is hardcoded black
 *     (`SceneStage.tsx:952`), so the ground has to be a layer.
 *  2. **Without a media layer in the composition, a pinned font does not reach the glyphs.** Same
 *     graph, same seeded mirror, same resolved bytes in `inputProps` — drop the image layer and
 *     Anton renders as the `sans-serif` fallback. Recorded in
 *     `project-tracker/adr/023-…md` as an open defect; it is an S2/D3 render-boundary problem, not
 *     S6's, and it is invisible to `font:install-gate` because every fixture there carries media.
 *
 * Run: pnpm --filter @orreris/worker preset:sheet
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orreris-preset-sheet-"));
// Set BEFORE @orreris/storage loads: resolveStorageConfig memoizes on first call.
process.env.STORAGE_DRIVER = "local";
process.env.STORAGE_ROOT = tempRoot;

const { buildRenderManifest } = await import("@orreris/render-templates");
const {
  applyStylePreset,
  createRenderComparisonFixture,
  fontCatalogue,
  firstPartyStylePresets
} = await import("@orreris/shared");
type StylePreset = import("@orreris/shared").StylePreset;
type TimelineLayer = import("@orreris/shared").TimelineLayer;
const { mirrorCatalogueFont } = await import("@orreris/storage");
const { renderManifestStill } = await import("./remotion-renderer");
const { assertQuietBrowserMachine } = await import("./browser/browser-preflight");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const outDir = path.join(repoRoot, "tmp", "preset-sheet");
const fontsDir = path.join(repoRoot, "apps", "worker", "public", "fonts");

/**
 * Put every catalogue face in the store, through the real mirror path, and prove the hash it lands
 * under is the one the catalogue declares.
 *
 * Not setup noise — a precondition. A pinned ref the store cannot resolve ABORTS the render (T-2), so
 * a mismatch here would present as "the preset sheet crashed" rather than as "the catalogue and the
 * shipped bytes disagree", and the second sentence is the one worth reading.
 */
async function seedCatalogue(): Promise<void> {
  for (const family of fontCatalogue) {
    for (const face of family.faces) {
      const file = path.join(fontsDir, path.basename(face.file));
      assert.ok(fs.existsSync(file), `catalogue face ${family.family} ${face.weight} is missing its bundled file: ${file}`);
      const bytes = fs.readFileSync(file);
      const mirrored = await mirrorCatalogueFont(`https://fonts.example/${path.basename(face.file)}`, {
        fetcher: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
      });
      assert.equal(
        mirrored.key.fileHash,
        face.fileHash,
        `${family.family} ${face.weight} mirrored as ${mirrored.key.fileHash} but the catalogue pins ${face.fileHash} — ` +
          "a preset naming this face would abort the render."
      );
    }
  }
  process.stdout.write(`seeded ${fontCatalogue.reduce((n, f) => n + f.faces.length, 0)} catalogue faces\n`);
}

const SAMPLE = "Wait, this part\nis important";

function baseLayer(id: string, index: number, columns: number, rows: number): TimelineLayer {
  const column = index % columns;
  const row = Math.floor(index / columns);
  return {
    id,
    trackId: "sheet_track",
    type: "text",
    name: id,
    startSeconds: 0,
    durationSeconds: 4,
    text: SAMPLE,
    // Each cell gets its own centre; the scale is what lets a 132px title and a 40px subtitle share
    // one frame at their real relative weights rather than being normalized into agreeing.
    transform: {
      position: { x: ((column + 0.5) / columns) * 100, y: ((row + 0.5) / rows) * 100 },
      scale: 0.42,
      rotation: 0,
      opacity: 100
    },
    effects: [],
    keyframes: []
  } as unknown as TimelineLayer;
}

function shapeLayer(id: string, index: number, columns: number): TimelineLayer {
  return {
    id,
    trackId: "sheet_track",
    type: "shape",
    name: id,
    startSeconds: 0,
    durationSeconds: 4,
    shapeKind: "rounded-rectangle",
    widthPercent: 18,
    heightPercent: 40,
    transform: {
      position: { x: ((index + 0.5) / columns) * 100, y: 50 },
      scale: 1,
      rotation: 0,
      opacity: 100
    },
    effects: [],
    keyframes: []
  } as unknown as TimelineLayer;
}

/** The fixture's landscape gradient, reused as the ground — see the header for why it must be there. */
const groundFixture = createRenderComparisonFixture("plain-image");
const groundLayer = {
  id: "ground",
  trackId: "sheet_track",
  type: "image",
  name: "Ground",
  startSeconds: 0,
  durationSeconds: 4,
  assetId: "fixture_image",
  fit: "cover",
  transform: { position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 100 },
  effects: [],
  keyframes: []
} as unknown as TimelineLayer;

async function renderSheet(
  label: string,
  presets: readonly StylePreset[],
  size: { width: number; height: number },
  makeLayer: (id: string, index: number) => TimelineLayer
): Promise<void> {
  const layers = presets.map((preset, index) => {
    const result = applyStylePreset(makeLayer(`cell_${index}`, index), preset);
    // An arm that silently skipped a preset would produce a sheet that looks fine and is missing the
    // one look that is broken.
    assert.ok(result.ok, `preset "${preset.id}" did not apply: ${result.ok ? "" : result.reason}`);
    return result.layer;
  });

  const graph = {
    projectId: "preset_sheet",
    effects: [],
    editableFields: {},
    version: 1,
    composition: {
      id: "preset_sheet_comp",
      width: size.width,
      height: size.height,
      fps: 30,
      durationSeconds: 4,
      backgroundColor: "#000000",
      tracks: [{ id: "sheet_track", type: "video", name: "Presets", layers: [groundLayer, ...layers] }]
    }
  };

  const manifest = buildRenderManifest({
    projectId: graph.projectId,
    graph: graph as never,
    assets: groundFixture.assets,
    quality: "final",
    createdAt: new Date(0).toISOString()
  });
  const outputLocation = path.join(outDir, `${label}.png`);
  await renderManifestStill({ manifest, frame: 30, outputLocation, rendererMode: "webgl" });
  process.stdout.write(`  ${label}: ${presets.length} looks -> ${outputLocation}\n`);
}

async function main(): Promise<void> {
  assertQuietBrowserMachine({ label: "preset:sheet", scriptMarker: "preset-sheet" });
  fs.mkdirSync(outDir, { recursive: true });
  await seedCatalogue();

  const text = firstPartyStylePresets.filter((preset) => preset.envelope.schemaId === "text-style");
  const shapes = firstPartyStylePresets.filter((preset) => preset.envelope.schemaId === "shape-style");
  const columns = 2;
  const rows = Math.ceil(text.length / columns);

  await renderSheet("text-presets", text, { width: 1600, height: 320 * rows }, (id, index) =>
    baseLayer(id, index, columns, rows)
  );
  await renderSheet("shape-presets", shapes, { width: 1600, height: 500 }, (id, index) =>
    shapeLayer(id, index, shapes.length)
  );

  process.stdout.write(`\nNow LOOK at them: ${outDir}\n`);
}

await main();
