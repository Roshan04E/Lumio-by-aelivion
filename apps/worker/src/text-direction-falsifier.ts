/**
 * ADR-023 T-15 — flip the field and prove the RENDER changes.
 *
 * WHY THIS EXISTS, in one sentence: `render:compare:pixels` compares two consumers of the same
 * manifest bag, so it cannot detect a field that never reached the bag — both renderers agree, at
 * 0.000%, about an answer neither of them was given. S1 shipped within one commit of exactly that
 * (`strokePaintOrder` missing from `buildRenderManifest`'s hand-written field list: editor rendered
 * stroke-under, export stroke-over, gate green). What caught it was flipping the value and finding
 * the render byte-identical. T-15 makes that falsifier mandatory for every new text field; this is
 * S0b's.
 *
 * SUBJECT — the `bidi-direction` fixture (Arabic + an embedded Latin word + a trailing `؟`) rendered
 * at `direction: "rtl"` and at `"ltr"`. The two renders MUST differ. If they do not, `direction` is
 * not reaching the renderer, whatever the parity gate says.
 *
 * CONTROL — the `scaled-text` fixture (Latin "HI") through the identical flip. It MUST NOT differ.
 * Without this the gate is worthless: a subject-only check passes just as happily if flipping
 * `direction` perturbs the render for some reason unrelated to bidi (a cache key, a re-raster, a
 * different code path), which would make the gate report success for the wrong reason. Measured
 * before it was relied on: base direction changes an Arabic canvas render and leaves a pure-Latin
 * one byte-identical.
 *
 * Run: pnpm --filter @orreris/worker text:direction-falsifier
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
  type RenderComparisonFixtureKey,
  type TimelineLayer
} from "@orreris/shared";
import { assertQuietBrowserMachine, listAutomationBrowsers } from "./browser/browser-preflight";
import { renderManifestStill } from "./remotion-renderer";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const outDir = path.join(repoRoot, "tmp", "text-direction-falsifier");

type Direction = NonNullable<TimelineLayer["direction"]>;

/**
 * WHY T-13a HAS NO PIXEL ARM HERE, measured while trying to build one.
 *
 * The obvious falsifier for "collapsing a line to one `fillText` changes placement" is to render the
 * same text both ways and require a difference. It cannot be built. `collapseLine` keys on the
 * EFFECTIVE draw style (resolved font string, colour, highlight), not on the declared run fields, so
 * every way of forcing the run-by-run path also changes how the text looks — restating `fontFamily`
 * on alternate runs resolves to the identical font string and still collapses (verified: byte-
 * identical renders), and a colour or size difference moves pixels for its own reason. There is no
 * pixel-invisible way to select the logical path, which is a property of the design rather than a
 * gap in the gate: the raster only takes that path when the runs genuinely look different.
 *
 * T-13a is therefore covered by (a) `collapseLine` asserted directly as a pure function in
 * `render:compare`, and (b) the `bidi-direction` baseline delta this stage produces — the Arabic
 * subject's `"rtl"` hash moved from S0b's `90a2ae8ad561` to a new picture, which IS "differs from the
 * word-by-word draw" with S0b's committed render as the word-by-word draw.
 */

/**
 * Render a fixture with EVERY text layer's direction forced to `direction`, and hash the PNG.
 *
 * The override is applied to the fixture graph rather than through a second fixture key, so both
 * arms are provably the same composition differing in exactly one field — which is the whole claim.
 */
interface Arm {
  direction: Direction;
  label: string;
  /** Replace the layer text, so a control can be the SAME fixture differing only in content. */
  text?: string;
}

async function renderAt(key: RenderComparisonFixtureKey, arm: Arm): Promise<string> {
  const { direction, label, text } = arm;
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
          return { ...layer, direction, ...(text === undefined ? null : { text, textRuns: undefined }) };
        })
      }))
    }
  };
  // A run that overrode nothing would compare a fixture with itself and pass forever.
  assert.ok(textLayersTouched > 0, `Fixture "${key}" has no text layer to set direction on — the arm is void.`);

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
  assertQuietBrowserMachine({ label: "text:direction-falsifier", scriptMarker: "text-direction-falsifier" });
  process.stdout.write(`preflight: ${listAutomationBrowsers().length} automation browser process(es) alive (must be 0)\n`);
  fs.mkdirSync(outDir, { recursive: true });

  const subjectRtl = await renderAt("bidi-direction", { direction: "rtl", label: "subject-rtl" });
  const subjectLtr = await renderAt("bidi-direction", { direction: "ltr", label: "subject-ltr" });
  const subjectAuto = await renderAt("bidi-direction", { direction: "auto", label: "subject-auto" });
  process.stdout.write(
    `subject (arabic+latin+?)  rtl=${subjectRtl.slice(0, 12)}  ltr=${subjectLtr.slice(0, 12)}  auto=${subjectAuto.slice(0, 12)}\n`
  );

  /**
   * S0b's control, unchanged: pure Latin through the identical flip. Centre-aligned, so it isolates
   * GLYPH ORDER from alignment — the `bidi-direction` fixture's `textAlign: "end"` legitimately moves
   * a Latin line when direction flips, which would make it useless as a control for reordering.
   */
  const controlRtl = await renderAt("scaled-text", { direction: "rtl", label: "control-rtl" });
  const controlLtr = await renderAt("scaled-text", { direction: "ltr", label: "control-ltr" });
  const controlAuto = await renderAt("scaled-text", { direction: "auto", label: "control-auto" });
  process.stdout.write(
    `control (latin "HI")      rtl=${controlRtl.slice(0, 12)}  ltr=${controlLtr.slice(0, 12)}  auto=${controlAuto.slice(0, 12)}\n`
  );

  process.stdout.write("\n");

  /**
   * S0c's DEFINITION OF DONE, and the assertion that failed before this stage. `"auto"` is what new
   * text is authored with, so an `"auto"` that renders identically to `"ltr"` means Arabic is wrong
   * by default — which is exactly what S0b measured and could not fix from inside the raster.
   */
  assert.notEqual(
    subjectAuto,
    subjectLtr,
    "FALSIFIER FAILED — `direction: \"auto\"` over Arabic rendered BYTE-IDENTICALLY to `\"ltr\"`. " +
      "`\"auto\"` is not being resolved to a concrete direction in shared (resolveTextDirection), so " +
      "the raster is falling through to the canvas default. This is the S0b gap S0c exists to close."
  );
  assert.equal(
    subjectAuto,
    subjectRtl,
    "`\"auto\"` over Arabic must resolve to exactly `\"rtl\"` — same resolution, same pixels. A third, " +
      "different picture means the two paths are resolving separately."
  );
  // `"auto"` must not become a blanket rtl. (That it resolves to *ltr* specifically for Latin is
  // asserted in `render:compare` against the emitted CSS — pure Latin renders the same either way,
  // so pixels cannot tell those two apart and it would be dishonest to claim they can.)
  assert.equal(controlAuto, controlLtr, "`\"auto\"` must not perturb a Latin render.");

  assert.notEqual(
    subjectRtl,
    subjectLtr,
    "FALSIFIER FAILED — flipping `direction` between rtl and ltr produced a BYTE-IDENTICAL render of " +
      "Arabic text. The field is not reaching the renderer: check that the manifest's style bag " +
      "carries it (MANIFEST_LAYER_STYLE_KEYS) and that drawTextLayer sets ctx.direction from it. " +
      "render:compare:pixels cannot see this — it compares two consumers of the same bag."
  );
  assert.equal(
    controlRtl,
    controlLtr,
    "CONTROL FAILED — flipping `direction` changed a pure-LATIN render, which base direction must not " +
      "do. The subject's difference above therefore does not prove anything about bidi: something " +
      "unrelated (a cache key, a re-raster, a different code path) is moving with the flag."
  );

  process.stdout.write(`\nPASS — direction changes the Arabic render and leaves the Latin control byte-identical.\n`);
  process.stdout.write(`stills: ${outDir}\n`);
}

main().catch((error) => {
  process.stderr.write(`${String(error?.stack ?? error)}\n`);
  process.exit(1);
});
