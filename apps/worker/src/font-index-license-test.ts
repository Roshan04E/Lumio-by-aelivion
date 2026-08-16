/**
 * ADR-023 S10.5 — the licence ingest never emits a silent blank, checked against LIVE data.
 *
 * No browser, no pixel gate: the defect this stage fixes lives entirely in `font-index-build.ts`'s
 * data pipeline (metadata + a git tree, both plain fetches), so this exercises `resolveLicenseCode`/
 * `buildLicenseCodeBySlug` directly rather than going through `main()`'s file write. Network-bound
 * but cheap — two JSON fetches, no Chrome, no compositor.
 *
 * WHY THIS DOES NOT HARD-ASSERT "these ten families resolve to nothing." `google/fonts` is a live
 * upstream repository — this investigation (2026-08-16) found ten free, properly-licensed families
 * (Tinos, M PLUS Rounded 1c, Kumar One Outline, Playwrite NZ Basic Guides, and six Edu Hand/Cursive
 * faces) with no licence file reachable at their expected `google/fonts` path RIGHT NOW, despite each
 * one's own METADATA.pb declaring `license: "OFL"`. That gap may close the next time this file's
 * fetches run. Asserting it stays broken would make a FIX upstream fail this test; the invariant that
 * actually matters, and stays true either way, is narrower: these ten must never be silently treated
 * as `RESTRICTED_LICENSE_CODE` (the two-family "verified proprietary, permanent" answer) just because
 * a lookup missed. That is the exact confusion the bug produced — "ten free fonts blamed for a lookup
 * miss" — and it is what this test can prove stays fixed regardless of which way upstream moves.
 *
 * ALSO asserts the second half of that fix: `font:index-build` must not simply refuse forever while
 * these ten stay unresolved upstream. Each is on `KNOWN_UNRESOLVED_LICENSES`, dated — this test checks
 * that acknowledgement actually lets `classifyFamilyLicense` proceed (`failBuild: false`, coded
 * `UNRESOLVED_LICENSE_CODE`) rather than the build being stuck red on a live upstream gap it cannot
 * control.
 *
 * Run: pnpm --filter @orreris/worker font:index-license-test
 */
import assert from "node:assert/strict";
import {
  buildLicenseCodeBySlug,
  classifyFamilyLicense,
  KNOWN_UNRESOLVED_LICENSES,
  RESTRICTED_FAMILIES,
  RESTRICTED_LICENSE_CODE,
  resolveLicenseCode,
  TREE_URL,
  UNRESOLVED_LICENSE_CODE
} from "./font-index-build";

/**
 * The ten families this investigation found silently blank in the CHECKED-IN
 * `packages/shared/src/font-index-data.ts` — every one confirmed (2026-08-16) to declare a real
 * licence in its own `google/fonts` METADATA.pb (`license: "OFL"`), and NONE of them on
 * `RESTRICTED_FAMILIES`. Named explicitly, not derived from the generated file, so this test does not
 * validate itself against the very data it exists to distrust.
 */
const SHOULD_NEVER_BE_RESTRICTED = [
  "Tinos",
  "M PLUS Rounded 1c",
  "Kumar One Outline",
  "Playwrite NZ Basic Guides",
  "Edu NSW ACT Cursive",
  "Edu SA Hand",
  "Edu VIC WA NT Hand Pre",
  "Edu NSW ACT Hand Pre",
  "Edu VIC WA NT Hand",
  "Edu QLD Hand"
];

/** A handful of families with unambiguous, stable licences — the happy path stays happy. */
const KNOWN_LICENSED = ["Roboto", "Inter", "Open Sans"];

async function main(): Promise<void> {
  assert.equal(RESTRICTED_FAMILIES.size, 2, `RESTRICTED_FAMILIES grew or shrank without this test being updated: ${[...RESTRICTED_FAMILIES]}`);
  assert.ok(RESTRICTED_FAMILIES.has("Google Sans") && RESTRICTED_FAMILIES.has("Google Sans Flex"), "the two verified-proprietary families must be exactly these two, by name.");

  const treeResponse = await fetch(TREE_URL);
  assert.ok(treeResponse.ok, `google/fonts tree fetch failed: ${treeResponse.status}`);
  const tree = (await treeResponse.json()) as { truncated?: boolean; tree?: Array<{ path: string }> };
  assert.ok(!tree.truncated, "google/fonts tree came back TRUNCATED — licence coverage would be silently partial.");
  assert.ok(tree.tree?.length, "google/fonts tree came back empty.");
  const licenseCodeBySlug = buildLicenseCodeBySlug(tree.tree);
  process.stdout.write(`tree: ${tree.tree.length} entries, ${licenseCodeBySlug.size} directories carry a recognised licence file\n`);

  // THE RESTRICTED SET, by name: exactly these two resolve to the permanent "no licence" code.
  for (const family of RESTRICTED_FAMILIES) {
    const code = resolveLicenseCode(family, licenseCodeBySlug);
    assert.equal(code, RESTRICTED_LICENSE_CODE, `"${family}" must resolve to the restricted code regardless of what the tree says (it is a manual allowlist, not a lookup).`);
  }

  // THE CORE CLAIM. None of the ten free, properly-licensed families may EVER read as restricted —
  // that confusion (a lookup miss standing in for "genuinely unlicensed") is the defect itself.
  const wronglyRestricted: string[] = [];
  const stillUnresolved: string[] = [];
  for (const family of SHOULD_NEVER_BE_RESTRICTED) {
    const code = resolveLicenseCode(family, licenseCodeBySlug);
    if (code === RESTRICTED_LICENSE_CODE) wronglyRestricted.push(family);
    else if (code === undefined) stillUnresolved.push(family);
  }
  assert.equal(
    wronglyRestricted.length,
    0,
    `${wronglyRestricted.length} famil${wronglyRestricted.length === 1 ? "y" : "ies"} that IS properly licensed resolved to the RESTRICTED code: ` +
      `${wronglyRestricted.join(", ")}. RESTRICTED_FAMILIES must be a manually-verified allowlist, never a fallback for "the lookup missed."`
  );
  process.stdout.write(
    stillUnresolved.length
      ? `${stillUnresolved.length} of 10 still unresolved via google/fonts right now (upstream gap, not this fix's job to paper over): ${stillUnresolved.join(", ")}\n`
      : "all 10 now resolve a real licence path — the upstream gap this investigation found has closed.\n"
  );

  // THE BUILD MUST STILL RUN. Every still-unresolved family must be acknowledged and dated on
  // KNOWN_UNRESOLVED_LICENSES, and that acknowledgement must actually let classifyFamilyLicense
  // proceed rather than fail the whole build — the "landmine" this stage's own build failure would be
  // if the acknowledgement path did not exist.
  const missingAcknowledgement: string[] = [];
  const stillFailsBuild: string[] = [];
  for (const family of stillUnresolved) {
    if (!KNOWN_UNRESOLVED_LICENSES[family]) missingAcknowledgement.push(family);
    const outcome = classifyFamilyLicense(family, licenseCodeBySlug);
    if (outcome.failBuild) stillFailsBuild.push(family);
    else assert.equal(outcome.code, UNRESOLVED_LICENSE_CODE, `"${family}" is acknowledged-unresolved but did not code as UNRESOLVED_LICENSE_CODE (got "${outcome.code}").`);
  }
  assert.equal(
    missingAcknowledgement.length,
    0,
    `still-unresolved but NOT on KNOWN_UNRESOLVED_LICENSES (font:index-build would refuse the whole run): ${missingAcknowledgement.join(", ")}`
  );
  assert.equal(
    stillFailsBuild.length,
    0,
    `acknowledged on KNOWN_UNRESOLVED_LICENSES but classifyFamilyLicense still reports failBuild — the acknowledgement path is broken: ${stillFailsBuild.join(", ")}`
  );

  // THE HAPPY PATH, unchanged: an ordinary well-known family still resolves normally.
  for (const family of KNOWN_LICENSED) {
    const code = resolveLicenseCode(family, licenseCodeBySlug);
    assert.ok(code && code !== RESTRICTED_LICENSE_CODE, `"${family}" — an ordinary, unambiguously-licensed family — failed to resolve a real licence code (got ${code ?? "undefined"}).`);
  }

  process.stdout.write(
    "PASS — the restricted set is exactly {Google Sans, Google Sans Flex}, no properly-licensed family reads as restricted, " +
      "every still-unresolved family is acknowledged and coded UNRESOLVED (font:index-build can complete), and the happy path is unchanged.\n"
  );
}

main().catch((error) => {
  process.stderr.write(`${String(error?.stack ?? error)}\n`);
  process.exit(1);
});
