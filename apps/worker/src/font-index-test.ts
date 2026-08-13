/**
 * ADR-023 S2.6 — the index, checked against what it claims and against the catalogue beside it.
 *
 * This gate is entirely OFFLINE. That is deliberate: the index is a checked-in generated file
 * precisely so the picker opens instantly and reproducibly, and a gate that reached the network to
 * verify it would be asserting something about today's Google rather than about the file we ship.
 * The network arms live in `font:mirror-live`, which is opt-in.
 *
 * The precedent is `warpFontCatalog`, which shipped EMPTY and turned every warped family into the
 * Roboto fallback with nothing looking broken. A generated table gets exactly the same treatment as
 * a hand-written one: nothing is trusted because it was produced by a script.
 *
 * Run: pnpm --filter @orreris/worker font:index-test
 */
import assert from "node:assert/strict";
import {
  catalogueFace,
  fontCatalogue,
  fontFamilySlug,
  FONT_SCRIPT_FILTERS,
  fontIndex,
  fontIndexFace,
  fontIndexFamily,
  queryFontIndex,
  renderSafeFonts
} from "@orreris/shared";

function main(): void {
  const index = fontIndex();

  /* ---- The index exists, at scale, and the decode survived the round trip. ------------------- */
  assert.ok(
    index.length > 1000,
    `an index of ${index.length} families is not a catalogue — S2.5 already shipped five, and the whole ` +
      `point of this stage is that the SIZE of the ceiling changed, not only its kind.`
  );
  assert.ok(index.length > renderSafeFonts.length * 100);

  const names = new Set<string>();
  let faceTotal = 0;
  for (const entry of index) {
    assert.ok(entry.family.trim(), "a family with no name would render as a blank picker row.");
    assert.ok(!names.has(entry.family), `duplicate family in the index: ${entry.family}`);
    names.add(entry.family);
    assert.ok(entry.faces.length > 0, `${entry.family} has no faces — an unpickable row.`);
    assert.ok(entry.subsets.length > 0, `${entry.family} has no subsets, so no script filter can ever match it.`);
    assert.ok(
      !entry.subsets.includes("menu"),
      `${entry.family} carries Google's "menu" subset. It is not a script — every family has it — so a ` +
        `filter offering it would match everything and mean nothing.`
    );
    for (const face of entry.faces) {
      // 1..1000, not 100..900. The first draft asserted the familiar 100-step range and failed on
      // Sofia Sans at weight 1 — and the assertion was wrong, not the data: CSS `font-weight` is a
      // 1..1000 scale, and ten variable families here really do expose an axis that starts at 1.
      assert.ok(Number.isFinite(face.weight) && face.weight >= 1 && face.weight <= 1000, `${entry.family}: bad weight ${face.weight}`);
      assert.ok(face.style === "normal" || face.style === "italic");
      faceTotal += 1;
    }
  }
  assert.ok(faceTotal > 5000, `${faceTotal} faces is short of the catalogue this stage claims to expose.`);

  /* ---- THE LICENCE. This is the field D4a/T-11 hangs off at index scale. --------------------- */
  const withLicense = index.filter((entry) => entry.licensePath);
  assert.ok(
    withLicense.length / index.length > 0.99,
    `only ${withLicense.length}/${index.length} families carry a licence path. Every one of the rest has to ` +
      `fall back to its name table, and Google's CDN strips that — so the shortfall is families that will ` +
      `refuse to mirror.`
  );
  for (const entry of withLicense) {
    assert.match(
      entry.licensePath!,
      /^(ofl|apache|ufl)\/[a-z0-9]+\/(OFL|LICENSE|LICENCE|UFL)\.txt$/,
      `${entry.family}: licence path "${entry.licensePath}" is not a shape google/fonts uses.`
    );
    assert.ok(
      entry.licensePath!.includes(`/${fontFamilySlug(entry.family)}/`),
      `${entry.family}: licence path points at another family's directory.`
    );
  }

  /* ---- The index and the bundled catalogue must not disagree about the same font. ------------ */
  for (const entry of fontCatalogue) {
    const indexed = fontIndexFamily(entry.family);
    if (!indexed) {
      // Not fatal: the bundled set is ours and need not be Google's. But it must be deliberate.
      console.log(`  note: bundled family "${entry.family}" is not in the remote index.`);
      continue;
    }
    /**
     * Category is deliberately NOT asserted equal, and the first draft of this gate did assert it
     * and failed on Anton: we file it under `display`, Google files it under `Sans Serif`. Both are
     * defensible — Anton is a sans-serif drawn for display use — so this is two opinions, not a
     * contradiction, and `font-catalogue.ts` already says a category is "not a taxonomy, a hint".
     * Asserting agreement between two hints would break the gate on a change of anybody's mind.
     * What IS a fact is which faces exist, and that is asserted below.
     */
    if (indexed.category !== entry.category) {
      console.log(`  note: "${entry.family}" is ${entry.category} here, ${indexed.category} upstream — a hint, not a conflict.`);
    }
    for (const face of entry.faces) {
      assert.ok(
        indexed.faces.some((candidate) => candidate.weight === face.weight && candidate.style === face.style),
        `${entry.family} ${face.weight}/${face.style} is bundled but absent from the index.`
      );
    }
  }

  /* ---- Script filtering: the join with S0b/S0c. --------------------------------------------- */
  for (const { subset, label } of FONT_SCRIPT_FILTERS) {
    const matches = queryFontIndex({ subset });
    assert.ok(
      matches.length > 0,
      `the "${label}" filter matches NOTHING. A chip that always returns an empty list is worse than no chip: ` +
        `it tells the user the library has no ${label} fonts.`
    );
    for (const entry of matches) assert.ok(entry.subsets.includes(subset));
  }
  const arabic = queryFontIndex({ subset: "arabic" });
  assert.ok(arabic.length >= 20, `${arabic.length} Arabic families is too few for the filter to be the point.`);
  // Named in the plan, because these are the faces someone writing Arabic actually reaches for. If
  // they are unreachable, S0b and S0c shipped a base-direction setting with nothing to apply it to.
  for (const family of ["Noto Naskh Arabic", "Cairo", "Amiri"]) {
    assert.ok(
      arabic.some((entry) => entry.family === family),
      `${family} is not findable under the Arabic filter, which is exactly the state that leaves the RTL work ` +
        `unreachable in practice.`
    );
  }
  // …and the filter must EXCLUDE, or it is not a filter. A Latin-only family must not appear.
  assert.ok(!arabic.some((entry) => entry.family === "Anton"), "Anton is Latin-only and must not match the Arabic filter.");

  /* ---- Query composition and weight resolution. --------------------------------------------- */
  assert.ok(queryFontIndex({ search: "noto sans" }).length > 5, "search must be case-insensitive substring.");
  assert.equal(queryFontIndex({ search: " no such family at all " }).length, 0);
  const serifOnly = queryFontIndex({ category: "serif", subset: "latin" });
  assert.ok(serifOnly.length > 50 && serifOnly.every((entry) => entry.category === "serif" && entry.subsets.includes("latin")));
  assert.ok(
    queryFontIndex({ category: "serif", subset: "arabic" }).length < serifOnly.length,
    "two filters must compose to something narrower than one."
  );

  const roboto = fontIndexFamily("Roboto");
  assert.ok(roboto, "Roboto must be in the index.");
  assert.equal(fontIndexFace("Roboto", 900)?.weight, 900);
  assert.equal(fontIndexFace("Roboto", 450)?.weight, 400, "nearest weight, not the first one listed.");
  assert.equal(fontIndexFace("Roboto", 400, "italic")?.style, "italic", "an italic request must not silently return upright.");
  assert.equal(fontIndexFace("No Such Family"), undefined);
  assert.equal(fontIndexFamily("No Such Family"), undefined);

  // Popularity order is the default sort and is stored as the row order — so it must actually BE an
  // order, not the alphabet the metadata happened to arrive in.
  const firstTwenty = index.slice(0, 20).map((entry) => entry.family);
  assert.notDeepEqual(firstTwenty, [...firstTwenty].sort(), "the index is alphabetical — popularity order was lost.");
  assert.ok(firstTwenty.includes("Roboto") && firstTwenty.includes("Open Sans"), "the first screen must be fonts people use.");

  // The bundled faces stay resolvable through their own path. The index does not replace them, and a
  // catalogue lookup must never start answering out of the index (they pin different bytes).
  assert.ok(catalogueFace("Anton", 400), "the bundled catalogue must still resolve independently of the index.");

  console.log(
    `Font index passed. ${index.length} families, ${faceTotal} faces, ${withLicense.length} with a licence path, ` +
      `${arabic.length} Arabic families reachable.`
  );
}

main();
