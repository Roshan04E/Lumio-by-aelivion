/**
 * ADR-023 S9a (T-15, T-17) — flip a variable AXIS and prove the RASTER changes.
 *
 *   pnpm --filter @orreris/worker font:axis-falsifier
 *
 * ## Why this gate is the whole stage
 *
 * S5 deferred `font-variation-settings` with a good reason: canvas 2D exposes no
 * `fontVariationSettings` and `ctx.font` rejects an inline declaration, and since T-13's correction
 * the canvas raster is where BOTH renderers get their text pixels — so an axis applied at draw time
 * would move the editor's DOM overlay and ship nothing. S9a's claim is that the axis does not have
 * to be applied at draw time: a `variationSettings` DESCRIPTOR instances it at REGISTRATION, and an
 * instance is registered as its own alias family which the emitted CSS names.
 *
 * That claim is exactly the kind a parity gate cannot check. `render:compare:pixels` compares two
 * consumers of one manifest bag; both would agree at 0.000% about an axis neither was given. And
 * `textstyle:golden` proves the emitted family token moved, which is a claim about a STRING. Only a
 * render can say whether the glyphs are heavier. Hence: real bytes, real store, real Remotion.
 *
 * ## The controls, and what each one is for
 *
 * Every assertion below is a difference or an equality, and T-15 addendum 3 says both fail open. So:
 *
 *   FILE CONTROL — the fixture's font is read from its own `fvar` table and asserted VARIABLE with a
 *     real `wght` range. Without it, "the two axis renders are identical" is indistinguishable from
 *     what a STATIC file produces, and the subject below would be a report about the fixture. This is
 *     the arm the OQ6 spike's SVG section actually needed and initially lacked — it reported "the
 *     axis is ignored" while the face had never loaded, which is the identical picture.
 *
 *   SUBJECT (difference) — the same layer at `wght` 400 vs `wght` 700. The two sides share the
 *     fileHash, the ref weight, the ref style, the text, the size and the fixture; the ONLY declared
 *     difference is `fontWeightAxis`. If they match, the descriptor route does not reach the raster
 *     and the stage has shipped nothing.
 *
 *   T-17 SHARPENED — the two renders must differ FROM EACH OTHER, not merely from a fallback. That is
 *     what the subject already asserts, and it is why the subject is stated as 400-vs-700 rather than
 *     as axis-vs-no-font: a pair that differs because one side fell back to `sans-serif` would pass a
 *     naive difference test while proving the feature broken.
 *
 *   D1a (equality) — absent must render as the face's own default instance. Arimo's `fvar` default is
 *     400, read from the file rather than assumed, so an unauthored layer and an explicit `wght 400`
 *     must be byte-identical. This is what makes "absent stays absent" true of the PIXELS and not
 *     only of the emitted string: if registering an instance perturbed the raster at the default
 *     coordinate, every layer already pinned to a variable file would have moved.
 *
 *   REFUSAL (equality) — a `{source:"system"}` ref carrying an axis must be byte-identical to the
 *     same ref without one. A system family has no bytes to re-register, so there is no alias to name;
 *     the axis is dropped in `fontRefCss`. If this ever differs, something is emitting the axis as a
 *     declaration, which is the DOM-only feature this stage exists to not ship.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FontRef, TimelineLayer } from "@orreris/shared";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orreris-font-axis-"));
// Set BEFORE @orreris/storage loads: resolveStorageConfig memoizes on first call.
process.env.STORAGE_DRIVER = "local";
process.env.STORAGE_ROOT = tempRoot;

const { buildRenderManifest } = await import("@orreris/render-templates");
const { createRenderComparisonFixture, renderComparisonFrameSeconds, parseFontVariationAxes } = await import("@orreris/shared");
const { mirrorCatalogueFont } = await import("@orreris/storage");
const { renderManifestStill } = await import("./remotion-renderer");
const { assertQuietBrowserMachine, listAutomationBrowsers } = await import("./browser/browser-preflight");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const outDir = path.join(repoRoot, "tmp", "font-axis-falsifier");

/**
 * The fixture font, and it is already in this repo.
 *
 * Arimo-Regular ships here and renders today — and it turns out to be a VARIABLE file carrying a
 * `wght` axis over 400–700. That is worth more than a fetched font would be: no network in the gate,
 * no new binary in the tree, and the face under test is one the product already uses, so the D1a arm
 * below is asking about real project data rather than about a specimen.
 */
const arimoPath = path.join(repoRoot, "apps", "worker", "public", "fonts", "Arimo-Regular.ttf");

/**
 * Render `scaled-text` with every text layer's font fields overridden, and hash the PNG.
 *
 * `media: false` strips the fixture's media layer. Not cosmetic: an axis moves a modest number of
 * pixels, and folding a video frame into the hash means any non-determinism there reads as a font
 * defect — which is the exact failure `font:install-gate` records having been masked by for all of S2.
 */
async function renderWith(label: string, over: Partial<TimelineLayer>): Promise<string> {
  const fixture = createRenderComparisonFixture("scaled-text");
  const composition = fixture.graph.composition!;
  let touched = 0;
  const graph = {
    ...fixture.graph,
    composition: {
      ...composition,
      tracks: composition.tracks.map((track) => ({
        ...track,
        layers: track.layers
          .filter((layer) => layer.type === "text")
          .map((layer) => {
            touched += 1;
            const next = { ...layer } as Record<string, unknown>;
            for (const [key, value] of Object.entries(over)) {
              if (value === undefined) delete next[key];
              else next[key] = value;
            }
            return next as unknown as TimelineLayer;
          })
      }))
    }
  };
  assert.ok(touched > 0, "fixture has no text layer — the arm is void.");

  const manifest = buildRenderManifest({
    projectId: graph.projectId,
    graph,
    assets: fixture.assets,
    quality: "final",
    createdAt: new Date(0).toISOString()
  });
  const outputLocation = path.join(outDir, `${label}.png`);
  await renderManifestStill({
    manifest,
    frame: Math.round(renderComparisonFrameSeconds * manifest.output.fps),
    outputLocation,
    rendererMode: "webgl"
  });
  return createHash("sha256").update(fs.readFileSync(outputLocation)).digest("hex");
}

const short = (hash: string) => hash.slice(0, 12);

async function main(): Promise<void> {
  assertQuietBrowserMachine({ label: "font:axis-falsifier", scriptMarker: "font-axis-falsifier" });
  process.stdout.write(`preflight: ${listAutomationBrowsers().length} automation browser process(es) alive (must be 0)\n`);
  fs.mkdirSync(outDir, { recursive: true });

  // --- FILE CONTROL: is the fixture font actually variable? ---------------------------------------
  const bytes = fs.readFileSync(arimoPath);
  const axes = parseFontVariationAxes(new Uint8Array(bytes));
  assert.ok(
    axes !== undefined,
    `VOID — could not read ${path.basename(arimoPath)}'s fvar table at all, so nothing below can be ` +
      `attributed to an axis. (\`undefined\` means "unreadable", not "static" — a WOFF2 container ` +
      `answers this way too.)`
  );
  const wght = axes!.find((axis) => axis.tag === "wght");
  assert.ok(
    wght && wght.max > wght.min,
    `VOID — ${path.basename(arimoPath)} exposes no usable \`wght\` axis (${JSON.stringify(axes)}). Every ` +
      `equality below would hold trivially on a static file, and the subject's difference could not ` +
      `hold at all, so this run would be a report about the fixture rather than about the feature.`
  );
  process.stdout.write(
    `file control: ${path.basename(arimoPath)} is VARIABLE — wght ${wght!.min}..${wght!.max}, default ${wght!.default}\n`
  );

  // Seed the mirror through the REAL path, so the bytes travel file → ingest → hash → store →
  // resolver → data URL → @font-face → raster, which is where the descriptor has to survive.
  const mirrored = await mirrorCatalogueFont("https://fonts.example/arimo.ttf", {
    fetcher: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  });
  const pinned: FontRef = {
    source: "catalogue",
    family: "Arimo",
    weight: 400,
    style: "normal",
    fileHash: mirrored.key.fileHash
  };
  process.stdout.write(`mirrored Arimo at ${short(mirrored.key.fileHash)}…\n`);

  // --- SUBJECT + D1a --------------------------------------------------------------------------
  const light = await renderWith("axis-400", { fontRef: pinned, fontWeightAxis: wght!.default });
  const heavy = await renderWith("axis-700", { fontRef: pinned, fontWeightAxis: wght!.max });
  const absent = await renderWith("axis-absent", { fontRef: pinned, fontWeightAxis: undefined });
  process.stdout.write(
    `pinned     absent=${short(absent)}  wght${wght!.default}=${short(light)}  wght${wght!.max}=${short(heavy)}\n`
  );

  /**
   * --- THE SECOND SURFACE (S8's arc), and why it gets its own arms -----------------------------
   *
   * A curved run is not drawn by the canvas raster at all: it is an SVG rasterized as an image, an
   * isolated document that carries its own embedded `@font-face`. S9a therefore has to reach it a
   * second time, and the failure mode if it does not is silent rather than loud — the document would
   * define "Arimo" while its `<text>` asks for "Arimo ~axis~wght700", and the arc would render in the
   * fallback with no error anywhere.
   *
   * The OQ6 spike measured that `font-variation-settings` as a PRESENTATION ATTRIBUTE on `<text>` is
   * ignored in this surface. That is a different mechanism from the `@font-face` DESCRIPTOR used
   * here, so nothing about the spike's negative predicts this arm — which is the whole reason it is
   * an arm and not an assumption.
   */
  const curveLight = await renderWith("curve-axis-400", {
    fontRef: pinned,
    fontWeightAxis: wght!.default,
    textPathCurve: 60
  });
  const curveHeavy = await renderWith("curve-axis-700", {
    fontRef: pinned,
    fontWeightAxis: wght!.max,
    textPathCurve: 60
  });
  process.stdout.write(`curved     wght${wght!.default}=${short(curveLight)}  wght${wght!.max}=${short(curveHeavy)}\n`);

  // --- REFUSAL ----------------------------------------------------------------------------------
  const systemRef: FontRef = { source: "system", fontFamily: "Arimo" };
  const systemPlain = await renderWith("system-plain", { fontRef: systemRef, fontWeightAxis: undefined });
  const systemAxis = await renderWith("system-axis", { fontRef: systemRef, fontWeightAxis: wght!.max });
  process.stdout.write(`system     plain=${short(systemPlain)}  +axis=${short(systemAxis)}\n\n`);

  assert.notEqual(
    heavy,
    light,
    `SUBJECT FAILED — the same pinned file rendered at wght ${wght!.default} and wght ${wght!.max} is ` +
      `BYTE-IDENTICAL. The axis is not reaching the raster. The two sides share the fileHash, the ref ` +
      `weight/style, the text and the fixture; the only declared difference is \`fontWeightAxis\`. Check ` +
      `that (a) the manifest bag carries it — MANIFEST_LAYER_STYLE_KEYS — (b) \`fontRefCss\` emitted the ` +
      `alias family, and (c) the resolver registered a face under that alias WITH a ` +
      `\`font-variation-settings\` descriptor. Do NOT "fix" this by feature-detecting ` +
      `FontFace.variationSettings: it does not reflect back, so that detect reports a working API as ` +
      `unsupported. See font-variation.ts.`
  );

  assert.equal(
    absent,
    light,
    `D1a FAILED — a layer with NO axis and a layer explicitly at the file's own default (${wght!.default}) ` +
      `rendered DIFFERENTLY. Absent must mean "the face's default instance", so registering an instance ` +
      `at the default coordinate has to be a no-op on the pixels. If these diverge, every project already ` +
      `pinned to a variable file has just moved — and this repo renders with such a file today.`
  );

  assert.notEqual(
    curveHeavy,
    curveLight,
    `SECOND SURFACE FAILED — a CURVED run rendered identically at wght ${wght!.default} and wght ` +
      `${wght!.max}. The arc is an SVG rasterized as an image, so the axis has to reach it through the ` +
      `\`@font-face\` embedded in that document — check that \`resolveFontFaceCss\` was given the INSTANCE ` +
      `family (not \`ref.family\`) and emitted the \`font-variation-settings\` descriptor. Two ways this ` +
      `fails and they look the same: the descriptor is being dropped, or the family names an instance ` +
      `the document never defined and the whole arc has quietly fallen back. Open the two stills — if ` +
      `they are not in Arimo, it is the second one.`
  );

  assert.equal(
    systemAxis,
    systemPlain,
    "REFUSAL FAILED — a `{source:\"system\"}` ref responded to a variable axis. It must not: there are no " +
      "bytes to re-register under an alias, so the only route left is a `font-variation-settings` " +
      "DECLARATION — which the editor's DOM overlay honours and the canvas raster ignores. That is an " +
      "axis that moves the editor and changes nothing in the export, which is the failure shape this " +
      "whole ADR keeps returning to."
  );

  process.stdout.write(
    "PASS — the axis reaches the raster, absent still means the face's default, and a system ref refuses it.\n"
  );
  process.stdout.write(`stills: ${outDir}\n`);
}

main().catch((error) => {
  process.stderr.write(`${String(error?.stack ?? error)}\n`);
  process.exit(1);
});
