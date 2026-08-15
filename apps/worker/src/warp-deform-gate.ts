/**
 * ADR-023 D9a (S7 half B) — does warp DEFORM SHAPED TEXT?
 *
 * This file replaces `warp-shaping-gate.ts`, which asserted the opposite: that warp REFUSED a
 * shaping-dependent script and said so on screen (T-12). That gate's own header instructed its
 * deletion when D9a landed, and it is deleted rather than kept passing — an interim gate that
 * survives its interim starts defending the workaround instead of the property.
 *
 * ── Why these arms are shaped the way they are ────────────────────────────────────────────────
 *
 * T-15 addendum 3 (2026-08-15): **every falsifier in this programme is a DIFFERENCE assertion, and
 * difference assertions fail OPEN.** An equality assertion needs one reason to differ and the defect
 * supplies it; a difference assertion is satisfied by ANY asymmetry, including two flavours of the
 * same failure. The no-media arm in `font:install-gate` passed twice while its defect was fully
 * present, for exactly this reason. So each arm below names what its two sides SHARE, and the only
 * declared difference is the property under test.
 *
 * ── The arms ──────────────────────────────────────────────────────────────────────────────────
 *
 * A. WARP APPLIES to a shaping-dependent script. Two renders of one fixture, sharing text, font,
 *    size, stroke, direction and layout; sole declared difference is the presence of the warp field.
 *    Before D9a this pair was IDENTICAL — the engine detected Arabic and refused itself.
 *
 * B. THE DEFORM OPERATES ON SHAPED TEXT. This is the stage's actual claim and the one arm A cannot
 *    make: arm A would also pass for an engine that deformed the wrong glyphs, which is precisely
 *    what the outline engine did for Latin-only scripts and would have done here.
 *
 *    Two renders, both warped, sharing every style and every letter. The sole declared difference is
 *    ZERO-WIDTH NON-JOINERS between the Arabic letters. ZWNJ suppresses cursive joining, so a
 *    pipeline that SHAPES renders the two differently (joined medial forms vs isolated forms), and a
 *    pipeline that does glyph LOOKUP — one code point, one glyph, no context — renders them
 *    identically because ZWNJ is invisible and carries no glyph of its own. The old engine would
 *    have failed this arm; that is what makes it evidence rather than decoration.
 *
 * C. SUPERSAMPLING IS DERIVED FROM THE FIELD, not a constant (D9a scope). Pure-function arms over
 *    `warpSupersampleScale`, no browser: two fields sharing bend and box, differing only in style,
 *    must produce different factors — a translation-only `arc` asks for none, a `bulge` magnifies.
 *
 * D. T-12 IS RETIRED, NOT DISABLED. `isTextWarpSuppressed` must not exist. A predicate left behind
 *    returning false would pass every behavioural arm above while leaving the trap in place.
 *
 * Run: pnpm --filter @orreris/worker warp:deform-gate
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TimelineLayer } from "@orreris/shared";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orreris-warp-deform-"));
process.env.STORAGE_DRIVER = "local";
process.env.STORAGE_ROOT = tempRoot;

const { buildRenderManifest } = await import("@orreris/render-templates");
const shared = await import("@orreris/shared");
const { createRenderComparisonFixture, renderComparisonFrameSeconds, warpSupersampleScale, textWarpField, normalizeTextWarp } = shared;
const { renderManifestStill } = await import("./remotion-renderer");
const { assertQuietBrowserMachine } = await import("./browser/browser-preflight");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const outDir = path.join(repoRoot, "tmp", "warp-deform");

/** Zero-width non-joiner — suppresses cursive joining without adding a glyph. */
const ZWNJ = "‌";

interface Override {
  text?: string;
  clearWarp?: boolean;
}

/**
 * Render the `text-warp-shaped` fixture with one property overridden. Everything else — font, size,
 * stroke, direction, position, the media layer behind it — is the fixture's and is therefore shared
 * by construction rather than by my remembering to keep it equal.
 */
async function render(label: string, override: Override): Promise<string> {
  const fixture = createRenderComparisonFixture("text-warp-shaped");
  const composition = fixture.graph.composition!;
  let touched = 0;
  const graph = {
    ...fixture.graph,
    composition: {
      ...composition,
      tracks: composition.tracks.map((track) => ({
        ...track,
        layers: track.layers.map((layer) => {
          if (layer.type !== "text") return layer;
          touched += 1;
          const next: TimelineLayer = { ...layer };
          if (override.text !== undefined) next.text = override.text;
          if (override.clearWarp) next.textWarp = undefined;
          return next;
        })
      }))
    }
  };
  assert.equal(touched, 1, "the fixture must have exactly one text layer, or these arms are comparing the wrong thing.");

  const manifest = buildRenderManifest({
    projectId: graph.projectId,
    graph: graph as never,
    assets: fixture.assets,
    quality: "final",
    createdAt: new Date(0).toISOString()
  });

  // The warp must reach the manifest at all. It did not until 2026-08-15 — `textWarp` travels in the
  // STYLE BAG, both rasterizers read a TOP-LEVEL field, and so warp never rendered in the export
  // while the editor showed a bend. Asserted here rather than trusted, because every pixel arm below
  // would read "no difference" and blame the deform.
  const textLayer = (manifest.layers as unknown as Array<Record<string, unknown>>).find((l) => l.type === "text");
  const carried = (textLayer?.style as { textWarp?: unknown } | undefined)?.textWarp;
  if (override.clearWarp) {
    assert.ok(!carried, `${label}: the control must carry NO warp, or the arm compares two warped renders.`);
  } else {
    assert.ok(carried, `${label}: the manifest dropped textWarp. Every arm below would then measure the same picture twice.`);
  }

  const out = path.join(outDir, `gate-${label}.png`);
  await renderManifestStill({
    manifest,
    frame: Math.round(renderComparisonFrameSeconds * manifest.output.fps),
    outputLocation: out,
    rendererMode: "webgl"
  });
  return out;
}

const hashOf = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** Insert ZWNJ between every pair of adjacent non-space characters. */
function disjoin(text: string): string {
  const chars = [...text];
  let out = "";
  for (let i = 0; i < chars.length; i += 1) {
    out += chars[i];
    const next = chars[i + 1];
    if (next && chars[i]!.trim() && next.trim()) out += ZWNJ;
  }
  return out;
}

async function main(): Promise<void> {
  assertQuietBrowserMachine({ label: "warp:deform-gate", scriptMarker: "warp-deform-gate" });
  fs.mkdirSync(outDir, { recursive: true });

  // ── D. T-12 retired, not disabled ───────────────────────────────────────────────────────────
  assert.ok(
    !("isTextWarpSuppressed" in shared),
    "T-12 NOT RETIRED — `isTextWarpSuppressed` still exists. D9a's whole claim is that there is no " +
      "shaping gap left to guard; a predicate kept around to answer 'no' is a trap for the next reader " +
      "and would pass every behavioural arm in this file."
  );

  // ── C. Supersampling derived from the field ─────────────────────────────────────────────────
  // Two fields sharing bend, box and font size. Sole declared difference: the style, i.e. the shape
  // of the field itself. `arc` translates and does not magnify; `bulge` scales its centre vertically.
  const boxW = 900;
  const boxH = 200;
  const fontSize = 150;
  const arcScale = warpSupersampleScale(textWarpField(normalizeTextWarp({ style: "arc", bend: 60, distortH: 0, distortV: 0 }), boxW, boxH, fontSize));
  const bulgeScale = warpSupersampleScale(textWarpField(normalizeTextWarp({ style: "bulge", bend: 60, distortH: 0, distortV: 0 }), boxW, boxH, fontSize));
  process.stdout.write(`supersample → arc=${arcScale.toFixed(3)}  bulge=${bulgeScale.toFixed(3)}\n`);
  assert.ok(
    bulgeScale > arcScale,
    `SUPERSAMPLE NOT DERIVED — a magnifying field (bulge, ${bulgeScale.toFixed(3)}) asked for no more ` +
      `resolution than a translating one (arc, ${arcScale.toFixed(3)}). That is what a fixed multiplier ` +
      `looks like from the outside, and D9a asks for the field's own maximum local magnification.`
  );
  assert.ok(arcScale >= 1, "the factor must never drop below 1 — a raster cannot be sharpened by shrinking it.");

  // ── A. Warp applies to a shaping-dependent script ───────────────────────────────────────────
  const warped = await render("arabic-warped", {});
  const unwarped = await render("arabic-unwarped", { clearWarp: true });
  process.stdout.write(`arm A → warped=${hashOf(warped).slice(0, 12)}  unwarped=${hashOf(unwarped).slice(0, 12)}\n`);
  assert.notEqual(
    hashOf(warped),
    hashOf(unwarped),
    "WARP DID NOT APPLY — an Arabic layer rendered identically with and without a warp field. Before " +
      "D9a this was the CORRECT behaviour (T-12: detect the script, refuse, say so). If it is still " +
      "true, the rasterize-then-deform path is not running for shaping-dependent text."
  );

  // ── B. The deform operates on SHAPED text ───────────────────────────────────────────────────
  const fixtureText = "مرحبا بالعالم";
  const joined = await render("arabic-joined", { text: fixtureText });
  const isolated = await render("arabic-zwnj", { text: disjoin(fixtureText) });
  process.stdout.write(`arm B → joined=${hashOf(joined).slice(0, 12)}  zwnj=${hashOf(isolated).slice(0, 12)}\n`);
  assert.notEqual(
    hashOf(joined),
    hashOf(isolated),
    "THE DEFORM IS NOT SEEING SHAPED TEXT — the same warped Arabic rendered identically with and " +
      "without zero-width non-joiners between its letters. ZWNJ changes which GLYPH each letter " +
      "resolves to and nothing else, so only a pipeline that shapes can tell these apart. A pipeline " +
      "doing glyph lookup renders them the same, which is the defect D9a exists to remove."
  );
  // And the joined render must equal itself across runs, so arm B's difference is the ZWNJ rather
  // than render nondeterminism — the cheapest possible guard against reading noise as signal.
  const joinedAgain = await render("arabic-joined-again", { text: fixtureText });
  assert.equal(
    hashOf(joined),
    hashOf(joinedAgain),
    "NONDETERMINISTIC — the same warped manifest rendered twice produced different pixels, so arm B's " +
      "inequality is not evidence of shaping."
  );

  process.stdout.write("\nPASS — warp deforms text the browser shaped, and the supersample follows the field.\n");
  process.stdout.write(`stills: ${outDir}\n`);
}

main()
  .catch((error) => {
    process.stderr.write(`${String(error?.stack ?? error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
