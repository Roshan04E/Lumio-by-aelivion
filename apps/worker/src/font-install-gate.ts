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
const {
  createRenderComparisonFixture,
  renderComparisonFrameSeconds,
  catalogueFontRef,
  fontIndexFace,
  fontIndexFamily,
  fontLicenseObjectKey,
  planFaceChange,
  FontResolutionError
} = await import("@orreris/shared");
const { mirrorCatalogueFont, mirrorGoogleFont } = await import("@orreris/storage");
const { renderManifestStill } = await import("./remotion-renderer");
const { assertQuietBrowserMachine, listAutomationBrowsers } = await import("./browser/browser-preflight");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const outDir = path.join(repoRoot, "tmp", "font-install-gate");
const antonPath = path.join(repoRoot, "apps", "worker", "public", "fonts", "Anton-Regular.ttf");

/**
 * Render `scaled-text` with every text layer's font forced to `ref`. Returns the PNG path.
 *
 * `media: false` strips every non-text layer, which is not a stylistic variation — see the no-media
 * arm in `main`. Every other arm in this gate renders a composition that happens to carry a media
 * layer, and that media layer was masking a real defect for the whole of S2.
 */
async function renderWithFont(ref: FontRef, label: string, options: { media?: boolean } = {}): Promise<string> {
  const withMedia = options.media !== false;
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
          .filter((layer) => withMedia || layer.type === "text")
          .map((layer) => {
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

  /**
   * ---- THE BUNDLED ARM, run BEFORE anything mirrors. ------------------------------------------
   *
   * Every arm below seeds the store first, so every one of them exercises the MIRROR path. That
   * left the bundled path — `catalogueFontRef`'s synchronous pin, the route every layer took for
   * the five pre-S2.6 families before a picker existed — with no gate at all, and it was broken: the
   * catalogue hash a bundled pick writes is never a hash `mirrorCatalogueFont` produces (the mirror
   * is seeded FROM the bundled file, D1's round trip runs the other way), so resolving it as a plain
   * `fonts/catalogue/<hash>` store object 404s. `tempRoot` here has nothing in it yet — no mirror
   * write has happened in this process — so a pass proves the bundled ref resolves with the store
   * completely empty, which is the whole reason these five are bundled rather than fetched.
   */
  const bundledRef = catalogueFontRef("Anton", 400, "normal");
  assert.ok(bundledRef, "Anton must be a catalogue family — the bundled arm is void otherwise.");
  const bundledPng = await renderWithFont(bundledRef, "bundled-anton");
  const bundledSystemPng = await renderWithFont({ source: "system", fontFamily: "Anton" }, "bundled-anton-system");
  process.stdout.write(
    `bundled (unmirrored) → pinned=${hashOf(bundledPng).slice(0, 12)}  system-named=${hashOf(bundledSystemPng).slice(0, 12)}\n`
  );
  assert.notEqual(
    hashOf(bundledPng),
    hashOf(bundledSystemPng),
    "BUNDLED INSTALL PATH NOT PROVEN — a catalogue ref pinned straight from `catalogueFontRef`, with no mirror " +
      "write anywhere in this process, rendered identically to Anton named as a system stack. Either the bundled " +
      "ref fell back to a substitute (T-17: the badge would fire correctly on a broken path — see " +
      "font-install.ts's catalogue case), or this host has Anton installed and the comparison proves nothing."
  );

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

  /**
   * ---- S2.6: the WHOLE chain, from an index row. ---------------------------------------------
   *
   * The plan's end-to-end for this stage: "metadata row → mirror write with license → `FontRef` with
   * `fileHash` → renders in the export." Every arm above starts from bytes we already named. This
   * one starts from a row in the index — a family the picker lists and we hold nothing of — and ends
   * at pixels.
   *
   * The network edges are injected, deliberately: what is under test is the CAUSATION, not Google's
   * uptime. Arimo is the subject because it is a real index row whose bytes this repo also ships, so
   * the chain can be exercised offline without the row and the bytes describing different fonts.
   *
   * The T-17 shape is reused rather than re-derived: the same family named as a system stack must
   * render DIFFERENTLY, which is what proves the pinned render is showing bytes the store delivered
   * rather than a face this host happens to have.
   */
  const row = fontIndexFamily("Arimo");
  assert.ok(row, "Arimo must be an index row — the end-to-end arm is void otherwise.");
  const rowFace = fontIndexFace(row.family, 700, "normal");
  assert.ok(rowFace, "the index row must offer the face being asked for.");
  const arimoBytes = fs.readFileSync(path.join(repoRoot, "apps", "worker", "public", "fonts", "Arimo-Bold.ttf"));
  let resolverAsked: string | undefined;
  const fromIndex = await mirrorGoogleFont({
    family: row.family,
    weight: rowFace.weight,
    style: rowFace.style,
    licensePath: row.licensePath,
    urlResolver: async (family, weight, style) => {
      resolverAsked = `${family}|${weight}|${style}`;
      return "https://fonts.example/arimo-700.ttf";
    },
    fetcher: async () => arimoBytes.buffer.slice(arimoBytes.byteOffset, arimoBytes.byteOffset + arimoBytes.byteLength) as ArrayBuffer
  });
  assert.equal(resolverAsked, "Arimo|700|normal", "the face fetched must be the face the row named.");
  assert.ok(fromIndex.key.fileHash, "the pick must produce a hash — which did not exist anywhere before this fetch (D1).");
  assert.ok(
    fs.existsSync(path.join(tempRoot, fontLicenseObjectKey(fromIndex.key))),
    "and the LICENCE must be beside it. Nothing renders differently without this file, so only an assertion catches it (T-11)."
  );

  const fromIndexRef: FontRef = {
    source: "catalogue",
    family: row.family,
    weight: rowFace.weight,
    style: rowFace.style,
    fileHash: fromIndex.key.fileHash
  };
  const indexPinnedPng = await renderWithFont(fromIndexRef, "index-row-arimo");
  const indexSystemPng = await renderWithFont({ source: "system", fontFamily: "Arimo" }, "index-row-arimo-system");
  process.stdout.write(
    `index row → pinned=${hashOf(indexPinnedPng).slice(0, 12)}  system-named=${hashOf(indexSystemPng).slice(0, 12)}\n`
  );
  assert.notEqual(
    hashOf(indexPinnedPng),
    hashOf(indexSystemPng),
    "END-TO-END NOT PROVEN — a family taken from the index, mirrored, and pinned rendered identically to the " +
      "same family named as a system stack. Either the mirrored bytes never reached the raster, or this host " +
      "has Arimo installed and the comparison says nothing about where the pixels came from."
  );
  /**
   * And the two PINNED renders must differ from each other. Observed while writing this: naming
   * Anton as a system stack and naming Arimo as a system stack produce the IDENTICAL picture,
   * because neither is installed and both land on the same fallback. That is the control behaving
   * correctly — and it means "differs from the control" alone would also pass if one single face
   * were standing in for every pinned font. This arm is the same invariant `font:preview-gate`
   * asserts across the picker's rows, applied at the render boundary.
   */
  assert.notEqual(
    hashOf(indexPinnedPng),
    hashOf(pinnedPng),
    "two DIFFERENT pinned families rendered identically. One face is standing in for both, which is the " +
      "empty-catalogue failure reaching the export rather than the picker."
  );

  /**
   * ---- S2.7: Bold picks the bold FILE, proven at the raster. ----------------------------------
   *
   * The plan's verification, and it is T-17's sharpened form: the two renders must differ FROM EACH
   * OTHER, not merely from a fallback. Differing from a fallback would pass if both cuts resolved to
   * the same file, or if one of them quietly fell back and the browser faux-bolded it — and a
   * faux-bold of Arimo 400 looks enough like Arimo 700 that no one would question the picture.
   *
   * Both cuts are real files this repo ships, mirrored through the same path, so what is being
   * compared is two pinned refs of ONE family that differ only in which bytes they name.
   */
  const regularFace = fontIndexFace("Arimo", 400, "normal");
  assert.ok(regularFace, "the index must offer Arimo's regular cut.");
  const arimoRegularBytes = fs.readFileSync(path.join(repoRoot, "apps", "worker", "public", "fonts", "Arimo-Regular.ttf"));
  const mirroredRegular = await mirrorGoogleFont({
    family: "Arimo",
    weight: regularFace.weight,
    style: regularFace.style,
    licensePath: row.licensePath,
    urlResolver: async () => "https://fonts.example/arimo-400.ttf",
    fetcher: async () =>
      arimoRegularBytes.buffer.slice(arimoRegularBytes.byteOffset, arimoRegularBytes.byteOffset + arimoRegularBytes.byteLength) as ArrayBuffer
  });

  assert.notEqual(
    mirroredRegular.key.fileHash,
    fromIndex.key.fileHash,
    "Arimo 400 and Arimo 700 must be different fileHashes. If they are equal the resolver is handing the same " +
      "file to both requests, and every pixel comparison below is comparing a font with itself."
  );

  // What the toggle would produce, taken from the SHARED planner rather than restated here — a gate
  // that recomputed the rule would agree with the rule being wrong.
  const boldPlan = planFaceChange(
    { fontRef: { source: "catalogue", family: "Arimo", weight: 400, style: "normal", fileHash: mirroredRegular.key.fileHash }, fontWeight: 400, italic: false },
    { bold: true }
  );
  assert.equal(boldPlan.kind, "face");
  assert.equal(boldPlan.kind === "face" ? boldPlan.weight : 0, 700, "the Bold toggle must ask for the 700 cut.");

  const regularPng = await renderWithFont(
    { source: "catalogue", family: "Arimo", weight: 400, style: "normal", fileHash: mirroredRegular.key.fileHash },
    "arimo-regular"
  );
  const boldPng = await renderWithFont(
    { source: "catalogue", family: "Arimo", weight: 700, style: "normal", fileHash: fromIndex.key.fileHash },
    "arimo-bold"
  );
  process.stdout.write(
    `S2.7 weight → regular=${hashOf(regularPng).slice(0, 12)} (${mirroredRegular.key.fileHash.slice(0, 8)}…)  ` +
      `bold=${hashOf(boldPng).slice(0, 12)} (${fromIndex.key.fileHash.slice(0, 8)}…)\n`
  );
  assert.notEqual(
    textRegionHash(regularPng),
    textRegionHash(boldPng),
    "BOLD DID NOTHING — the same family pinned at 400 and at 700 rendered the same text pixels. Either both refs " +
      "resolved to one file, or the bold ref never reached the raster. This is the defect S2.7 exists to close, " +
      "and it is asserted between the two PINNED renders rather than against a fallback, because a faux-bolded " +
      "regular would also differ from a fallback."
  );

  /**
   * ---- THE NO-MEDIA ARM (2026-08-15). ---------------------------------------------------------
   *
   * Found by S6's contact sheet, and invisible to every arm above because every fixture they render
   * carries a media layer. Strip it and the SAME graph, the SAME seeded mirror and the SAME bytes in
   * `inputProps` rendered a fallback: a silent substitution in an unattended export, the exact
   * failure D3/T-2 exist to prevent.
   *
   * The cause was ordering, which is why nothing above could see it. The raster is drawn through a
   * sync `ctx.font` that substitutes silently, and the only thing invalidating a fallback raster was
   * a 150ms-debounced `document.fonts` listener — a LIVENESS signal (DEBT-009). Whether the right
   * face reached the pixels therefore depended on whether something ELSE in the frame outlasted the
   * debounce. A media decode round-trip does. Nothing does, in a composition of text alone.
   *
   * **Two PINNED families AT THE SAME WEIGHT, and it took two wrong drafts to land there.** Both
   * wrong drafts failed the same way — they passed while the defect was present, because both were
   * comparing two different FALLBACKS rather than a font against a font:
   *
   *   1. pinned Anton vs Anton named as a system stack. Different family stacks are emitted, so the
   *      two fall back differently (a thin sans and a serif). Both wrong; `notEqual` satisfied.
   *   2. pinned Anton 400 vs pinned Arimo 700. Same stack now, but the WEIGHT travels with the ref,
   *      so the fallbacks are sans-serif 400 and sans-serif 700. Both wrong; `notEqual` satisfied.
   *
   * Only at equal weight do the two collapse onto one identical picture when the install path
   * delivers neither — and Anton (ultra-bold condensed) against Arimo (an Arial metric clone) is as
   * far apart as this catalogue gets when it delivers both. This is the S2.6 arm's lesson below,
   * which already records two system-named families collapsing onto one fallback, arrived at from
   * the other side: a `notEqual` between renders is evidence of nothing until every reason they
   * could differ WITHOUT the font arriving has been removed.
   *
   * What this arm does NOT pin down, stated so nobody reads more into a pass than is there: it proves
   * at least one of the two families arrives, not both. That is the claim being guarded — pinned
   * bytes reach the raster in a composition with no media in it — and it is proven to discriminate by
   * construction: with the readiness await removed, these two hashes are byte-identical.
   */
  const medialessAnton = await renderWithFont(pinned, "no-media-anton", { media: false });
  const arimoRegularRef: FontRef = { source: "catalogue", family: "Arimo", weight: 400, style: "normal", fileHash: mirroredRegular.key.fileHash };
  assert.equal(arimoRegularRef.weight, pinned.weight, "the two refs must share a weight, or their FALLBACKS differ and the arm proves nothing.");
  const medialessArimo = await renderWithFont(arimoRegularRef, "no-media-arimo", { media: false });
  process.stdout.write(
    `no media → anton=${hashOf(medialessAnton).slice(0, 12)}  arimo=${hashOf(medialessArimo).slice(0, 12)}\n`
  );
  assert.notEqual(
    hashOf(medialessAnton),
    hashOf(medialessArimo),
    "NO-MEDIA REGRESSION — in a composition with no media layer, two DIFFERENT pinned families rendered " +
      "the identical picture, i.e. both fell back. The pinned bytes reach the raster only when something " +
      "else in the frame is slow enough to let them win a race they should never have been in. " +
      "See tmp/font-install-gate/no-media-*.png."
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
