/**
 * ADR-023 D3/T-2 — the install path, proven at the render boundary.
 *
 * **THE CENTRAL ARM, and why it is shaped this way.** The plan asks for "a catalogue font that is
 * not installed on the host — proves the install path is what put it there and not the machine."
 * Asserting "Anton is not a Windows font" would make this gate depend on the contents of whoever's
 * font folder it runs in, which is the very dependency it claims to remove. So the machine is asked
 * DIRECTLY instead: render the same text twice, once naming Anton as a `{ source: "system" }` stack
 * — which resolves through the platform and nothing else — and once as a pinned catalogue ref that
 * goes through the store. If the two renders differ, the host does NOT have Anton and the pinned
 * render is showing bytes the install path delivered. The control is self-establishing on any
 * machine, and on a machine that DOES have Anton it fails honestly rather than passing vacuously.
 *
 * The mirror is seeded here through the real `mirrorCatalogueFont`, from a real OFL binary, so the
 * bytes travel the whole path: file → ingest → hash → store → resolver → data URL → @font-face →
 * raster.
 *
 * Run: pnpm --filter @orreris/worker font:install-gate
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
// Type-only, so it does not force @orreris/storage to load before STORAGE_ROOT is set below.
import type { FontRef } from "@orreris/shared";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orreris-font-install-"));
// Set BEFORE @orreris/storage loads: resolveStorageConfig memoizes on first call.
process.env.STORAGE_DRIVER = "local";
process.env.STORAGE_ROOT = tempRoot;

const { buildRenderManifest } = await import("@orreris/render-templates");
const { createRenderComparisonFixture, renderComparisonFrameSeconds, FontResolutionError } = await import("@orreris/shared");
const { mirrorCatalogueFont } = await import("./fonts/font-mirror");
const { renderManifestStill } = await import("./remotion-renderer");
const { assertQuietBrowserMachine, listAutomationBrowsers } = await import("./browser/browser-preflight");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const outDir = path.join(repoRoot, "tmp", "font-install-gate");
const antonPath = path.join(repoRoot, "apps", "worker", "public", "fonts", "Anton-Regular.ttf");

/** Render `scaled-text` with every text layer's font forced to `ref`. Returns the PNG path. */
async function renderWithFont(ref: FontRef, label: string): Promise<string> {
  const fixture = createRenderComparisonFixture("scaled-text");
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
          return { ...layer, fontRef: ref };
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
  return outputLocation;
}

const hashOf = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/**
 * Hash only the TEXT REGION. The determinism claim the plan asks for is about text, and hashing the
 * whole frame would fold in the fixture's media layer — if that ever became non-deterministic the
 * failure would read as a font defect.
 */
function textRegionHash(file: string): string {
  const png = PNG.sync.read(fs.readFileSync(file));
  const top = Math.floor(png.height * 0.35);
  const bottom = Math.floor(png.height * 0.65);
  const slice = Buffer.alloc((bottom - top) * png.width * 4);
  png.data.copy(slice, 0, top * png.width * 4, bottom * png.width * 4);
  return createHash("sha256").update(slice).digest("hex");
}

async function main(): Promise<void> {
  assertQuietBrowserMachine({ label: "font:install-gate", scriptMarker: "font-install-gate" });
  process.stdout.write(`preflight: ${listAutomationBrowsers().length} automation browser process(es) alive (must be 0)\n`);
  fs.mkdirSync(outDir, { recursive: true });

  // Seed the mirror through the REAL path, from a real OFL binary.
  const bytes = fs.readFileSync(antonPath);
  const mirrored = await mirrorCatalogueFont("https://fonts.example/anton.ttf", {
    fetcher: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  });
  assert.equal(mirrored.identity?.family, "Anton");
  const antonHash = mirrored.key.fileHash;
  process.stdout.write(`mirrored Anton at ${antonHash.slice(0, 12)}…\n`);

  const pinned: FontRef = { source: "catalogue", family: "Anton", weight: 400, style: "normal", fileHash: antonHash };
  const asSystem: FontRef = { source: "system", fontFamily: "Anton" };

  const pinnedPng = await renderWithFont(pinned, "pinned-anton");
  const systemPng = await renderWithFont(asSystem, "system-anton");
  process.stdout.write(`pinned=${hashOf(pinnedPng).slice(0, 12)}  system-named=${hashOf(systemPng).slice(0, 12)}\n`);

  assert.notEqual(
    hashOf(pinnedPng),
    hashOf(systemPng),
    "INSTALL PATH NOT PROVEN — naming Anton as a system stack and pinning it by hash produced the SAME " +
      "render. Either the install path did nothing (and both fell back), or this host has Anton " +
      "installed, in which case the render says nothing about where the bytes came from. Check " +
      `tmp/font-install-gate: if system-anton.png is already in Anton, run this on a host without it.`
  );

  /**
   * DETERMINISM (plan): same manifest, two renders, byte-identical text region. Worth asserting
   * precisely because the bytes now arrive over a resolution path with a cache in it — a resolver
   * that returned a different face on a warm second call would be invisible to every other arm here.
   */
  const secondPng = await renderWithFont(pinned, "pinned-anton-again");
  assert.equal(
    textRegionHash(pinnedPng),
    textRegionHash(secondPng),
    "DETERMINISM FAILED — the same manifest rendered twice produced different text pixels."
  );

  /**
   * THE NEGATIVE TEST, and it is SUCCEED-THEN-FAIL by construction. The subject is the font that
   * just rendered correctly, twice: same family, same weight, same everything except a hash the
   * store does not have. A font that never resolved would prove the setup fails, not that a MISSING
   * font fails at the right point — the render might have aborted for any reason at all, including
   * one that has nothing to do with fonts.
   */
  const bogus: FontRef = { ...pinned, fileHash: "0".repeat(64) };
  let aborted: unknown;
  try {
    await renderWithFont(bogus, "bogus-hash-SHOULD-NOT-EXIST");
  } catch (error) {
    aborted = error;
  }
  assert.ok(aborted, "T-2 FAILED — a manifest pinning a hash the store does not have RENDERED. A missing font must abort.");
  assert.ok(
    aborted instanceof FontResolutionError,
    `T-2 FAILED — the render aborted, but not with the named error: ${String(aborted)}. ` +
      `"Something went wrong" is not what D3 asks for; the message has to name the font.`
  );
  assert.match((aborted as Error).message, /Anton/, "the abort must name the family…");
  assert.match((aborted as Error).message, /000000000000/, "…and the hash, which are the two things needed to fix it.");
  assert.equal(
    fs.existsSync(path.join(outDir, "bogus-hash-SHOULD-NOT-EXIST.png")),
    false,
    "and it must abort BEFORE producing an output file — a wrong deliverable is the thing being prevented."
  );

  process.stdout.write("\nPASS — pinned bytes reach the raster, the render is deterministic, and a missing font aborts by name.\n");
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
