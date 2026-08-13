/**
 * ADR-023 D4/D4a/T-3/T-11 — the mirror, and the license that cannot be dropped.
 *
 * Runs against the LOCAL storage driver into a temp root, with an injected fetcher, so it exercises
 * the real `persistBytes`/`objectExists` code paths without touching R2 or the network. What it is
 * proving is the write CONTRACT — two objects or none, keyed by hash, refused without a license —
 * and that contract is driver-independent.
 *
 * **The negative tests are succeed-then-fail, not permanently-broken.** A fetcher that never
 * succeeds proves the setup fails, not that a MISSING font fails at the right point: the mirror
 * would report an error while never having reached the code under test. So the fetcher here serves
 * real bytes first, establishes that the good path writes both objects, and only then degrades.
 * This repo has been bitten by the permanently-broken variant twice in one day.
 *
 * Run: pnpm --filter @orreris/worker font:mirror-test
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orreris-font-mirror-"));
// Must be set BEFORE @orreris/storage is imported: resolveStorageConfig memoizes on first call.
process.env.STORAGE_DRIVER = "local";
process.env.STORAGE_ROOT = tempRoot;

const { mirrorCatalogueFont, mirrorGoogleFont, googleFontLicenseUrl, FontMirrorError } = await import("@orreris/storage");
const { computeFontFileHash, fontIndexFamily, fontLicenseObjectKey, fontObjectKey, canServeFont, fontStoreKeyFor } =
  await import("@orreris/shared");

const fontsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public/fonts");
function readFont(file: string): ArrayBuffer {
  const buffer = fs.readFileSync(path.join(fontsDir, file));
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}
const exists = (key: string) => fs.existsSync(path.join(tempRoot, key));

async function main(): Promise<void> {
  const antonBytes = readFont("Anton-Regular.ttf");
  const antonHash = await computeFontFileHash(antonBytes);

  // ---- The good path: fetched once, both objects written. -----------------------------------
  let fetches = 0;
  const fetcher = async () => {
    fetches += 1;
    return antonBytes;
  };

  const first = await mirrorCatalogueFont("https://fonts.example/anton.ttf", { fetcher });
  assert.equal(first.fetched, true);
  assert.equal(first.key.fileHash, antonHash, "the mirror is keyed by the CONTENT hash, not the URL.");
  assert.equal(first.identity?.family, "Anton");
  assert.equal(fetches, 1);

  const fontKey = fontObjectKey(first.key);
  const licenseKey = fontLicenseObjectKey(first.key);
  assert.equal(fontKey, `fonts/catalogue/${antonHash}`, "D4's shared-store layout.");
  assert.ok(exists(fontKey), "the font must be in the bucket.");
  // T-11, the whole point: this file renders nothing, so nothing about the product breaks if it is
  // missing. Only an assertion catches it.
  assert.ok(exists(licenseKey), "the LICENSE must be in the bucket, written by the same operation.");
  const licenseText = fs.readFileSync(path.join(tempRoot, licenseKey), "utf8");
  assert.match(licenseText, /Open Font License/, "the license text comes from the font's own name table.");
  assert.match(licenseText, new RegExp(antonHash), "the license names the exact face it belongs to.");
  assert.match(licenseText, /T-11/, "and says why it must not be deleted separately.");

  // ---- Mirror-on-first-USE: a PINNED second call must not re-fetch. --------------------------
  // The manifest always carries the hash (D1), so this is the shape every render after the first
  // takes. A pinned hash is the object key, which is what makes recognition possible without
  // downloading anything.
  const second = await mirrorCatalogueFont("https://fonts.example/anton.ttf", { fetcher, expectedHash: antonHash });
  assert.equal(second.fetched, false, "a face already mirrored must never be fetched from Google again.");
  assert.equal(fetches, 1, "…and that means literally zero further fetches.");
  assert.equal(second.identity, undefined, "nothing was fetched, so nothing was parsed — say so rather than inventing it.");

  // Honest limit, asserted so it does not get mistaken for a bug later: WITHOUT a pin there is no
  // way to know what a URL will serve except to fetch it. The first ingest of a family pays one
  // fetch; every render after that is pinned and pays none.
  const unpinned = await mirrorCatalogueFont("https://fonts.example/anton.ttf", { fetcher });
  assert.equal(unpinned.fetched, false, "…and it still recognises the entry once hashed, so it re-writes nothing.");
  assert.equal(fetches, 2, "an unpinned call must fetch to learn the hash — that is the cost of not pinning.");

  // ---- T-11 repair: a mirror entry whose license went missing is NOT trusted. ----------------
  // This is the succeed-then-fail shape applied to state rather than to a call: the entry got there
  // by succeeding, and only then loses its license. A test that started from a licenseless entry
  // would prove the check runs on an empty bucket, which is not the case anyone worries about.
  fs.unlinkSync(path.join(tempRoot, licenseKey));
  const repaired = await mirrorCatalogueFont("https://fonts.example/anton.ttf", { fetcher });
  assert.equal(repaired.fetched, true, "a font missing its license must be re-fetched and repaired, not reported as fine.");
  assert.ok(exists(licenseKey), "…and the license must be back.");
  assert.equal(fetches, 3);

  /* ---- Negative 1: the pin catches a DIFFERENT face served under the same name. ---------------
   *
   * SUCCEED-THEN-FAIL, and the structure is load-bearing. A fetcher that serves the wrong font from
   * the start proves only that a wrong font is refused on an empty bucket. What matters is the
   * upstream that WAS correct and then changed — Google reshipping a family under an unchanged name,
   * which is the concrete scenario D1's hash exists for. So: mirror Arimo successfully against its
   * own pin, remove it from the bucket so the short-circuit cannot mask the fetch, then have the
   * same URL serve different bytes.
   *
   * Note what the first half also demonstrates: once a face IS mirrored, a drifting upstream cannot
   * substitute anything, because the pinned hash is recognised without fetching at all. The
   * mismatch check guards the window before that — the first fetch of a newly pinned hash.
   */
  const arimoBytes = readFont("Arimo-Bold.ttf");
  const arimoHash = await computeFontFileHash(arimoBytes);
  let drifted = false;
  const drifting = async () => {
    fetches += 1;
    return drifted ? antonBytes : arimoBytes;
  };
  const pinned = await mirrorCatalogueFont("https://fonts.example/family.ttf", { fetcher: drifting, expectedHash: arimoHash });
  assert.equal(pinned.fetched, true, "the pinned fetch must SUCCEED while the bytes still match — otherwise this proves nothing.");
  assert.equal(pinned.key.fileHash, arimoHash);
  fs.unlinkSync(path.join(tempRoot, fontObjectKey(pinned.key)));

  drifted = true;
  await assert.rejects(
    () => mirrorCatalogueFont("https://fonts.example/family.ttf", { fetcher: drifting, expectedHash: arimoHash }),
    (error: unknown) => error instanceof FontMirrorError && error.code === "hash-mismatch",
    "the SAME url now serving different bytes must be refused — that is the substitution D1's hash exists to catch."
  );
  assert.equal(exists(fontObjectKey({ store: "catalogue", fileHash: arimoHash })), false, "and the wrong bytes must not have been written under the pinned name.");

  // ---- Negative 2: no license, no mirror, and nothing left behind. ---------------------------
  // A font that parses fine and identifies itself, but declares no license. Built by blanking the
  // license name records rather than by corrupting the file, so the ONLY reason it is refused is the
  // one under test — a corrupt file would be rejected earlier, by the parser, proving nothing.
  const stripped = stripLicenseRecords(new Uint8Array(antonBytes.slice(0)));
  const strippedHash = await computeFontFileHash(stripped.buffer as ArrayBuffer);
  await assert.rejects(
    () => mirrorCatalogueFont("https://fonts.example/unlicensed.ttf", { fetcher: async () => stripped.buffer as ArrayBuffer }),
    (error: unknown) => error instanceof FontMirrorError && error.code === "no-license",
    "a font that will not say what its license is cannot lawfully be redistributed (D4a)."
  );
  assert.equal(
    exists(`fonts/catalogue/${strippedHash}`),
    false,
    "and it must not be in the bucket at all — the refusal happens BEFORE any write, so an unlicensed font never exists there even transiently."
  );

  /**
   * ---- S2.6: the licence lives beside the font, and T-11 still holds. ------------------------
   *
   * The specimen above — a real font with name IDs 13/14 blanked — is not a synthetic curiosity.
   * It is exactly what `fonts.gstatic.com` serves: every static instance Google's CDN hands out has
   * those records stripped, measured across Cairo, Amiri, Noto Naskh Arabic and Inter. So the arm
   * below is the mirror-on-pick path, and the arm above is what that path looked like before this
   * commit: refused, every family, always.
   */
  const OFL_TEXT = `Copyright 2020 The Test Project Authors\n\n${"This Font Software is licensed under the SIL Open Font License, Version 1.1. ".repeat(6)}`;
  let licenseFetches = 0;
  const licenseFetcher = async () => {
    licenseFetches += 1;
    return OFL_TEXT;
  };
  const beside = await mirrorCatalogueFont("https://fonts.example/stripped.ttf", {
    fetcher: async () => stripped.buffer as ArrayBuffer,
    licenseUrl: "https://raw.example/ofl/test/OFL.txt",
    licenseFetcher
  });
  assert.equal(beside.fetched, true);
  assert.equal(beside.key.fileHash, strippedHash);
  assert.equal(licenseFetches, 1);
  const besideLicense = fs.readFileSync(path.join(tempRoot, fontLicenseObjectKey(beside.key)), "utf8");
  assert.ok(besideLicense.includes("SIL Open Font License"), "the stored licence must be the DOCUMENT, not a note saying one exists.");
  assert.ok(
    besideLicense.includes("License source: google/fonts"),
    "…and it must record where the text came from. An operator auditing the bucket cannot tell a name-table " +
      "licence from a fetched one otherwise, and D4a's lawfulness rests on which document applies."
  );
  assert.ok(besideLicense.includes(strippedHash), "the licence names the exact bytes it licenses.");

  /**
   * SUCCEED-THEN-FAIL on the LICENCE, which is the half T-11 exists to protect. A licence fetcher
   * that never works proves the setup fails; what matters is the source that WAS serving a licence
   * and then stopped — a moved file, a repo reorganisation, a 404 page returned with status 200.
   * The font fetch still succeeds throughout, so the only thing that changed is the licence.
   */
  fs.unlinkSync(path.join(tempRoot, fontObjectKey(beside.key)));
  fs.unlinkSync(path.join(tempRoot, fontLicenseObjectKey(beside.key)));
  await assert.rejects(
    () =>
      mirrorCatalogueFont("https://fonts.example/stripped.ttf", {
        fetcher: async () => stripped.buffer as ArrayBuffer,
        licenseUrl: "https://raw.example/ofl/test/OFL.txt",
        licenseFetcher: async () => "404: Not Found"
      }),
    (error: unknown) => error instanceof FontMirrorError && error.code === "no-license",
    "a licence source answering with something that is not a licence must refuse the mirror, not be stored as one."
  );
  assert.equal(exists(fontObjectKey(beside.key)), false, "and the FONT must not be in the bucket — both objects or neither (T-11).");
  assert.equal(exists(fontLicenseObjectKey(beside.key)), false);

  /**
   * ---- Mirror-on-PICK, end to end from an index row, offline. --------------------------------
   *
   * Every network edge is injected, so what is being proven is the CAUSATION rather than Google's
   * uptime: an index row names a family, the resolver is asked for that exact face, the bytes come
   * back, and a `fileHash` exists that did not exist before. That direction matters — the hash is
   * what we fetched, never what a table promised (D1) — and it is why the index carries no hashes.
   */
  const cairo = fontIndexFamily("Cairo");
  assert.ok(cairo?.licensePath, "Cairo must be in the index with a licence path — the arm below is void otherwise.");
  let asked: string | undefined;
  const picked = await mirrorGoogleFont({
    family: cairo.family,
    weight: 400,
    style: "normal",
    licensePath: cairo.licensePath,
    urlResolver: async (family, weight, style) => {
      asked = `${family}|${weight}|${style}`;
      return "https://fonts.example/cairo-400.ttf";
    },
    fetcher: async () => stripped.buffer as ArrayBuffer,
    licenseFetcher
  });
  assert.equal(asked, "Cairo|400|normal", "the face requested must be the face the row named.");
  assert.equal(picked.key.fileHash, strippedHash);
  assert.ok(exists(fontObjectKey(picked.key)) && exists(fontLicenseObjectKey(picked.key)), "a pick leaves BOTH objects behind.");
  assert.equal(
    googleFontLicenseUrl(cairo.licensePath),
    "https://raw.githubusercontent.com/google/fonts/main/ofl/cairo/OFL.txt",
    "the index's licence path must compose into the real document URL — a wrong path is a silent no-licence."
  );

  // ---- T-3: the two stores are two types, and one cannot be served as the other. -------------
  const catalogueKey = fontStoreKeyFor({ source: "catalogue", family: "Anton", weight: 400, style: "normal", fileHash: "h" });
  const userKey = fontStoreKeyFor({ source: "user", family: "Brand", weight: 400, style: "normal", fileHash: "h", ownerId: "u1" });
  assert.ok(catalogueKey && userKey);
  assert.equal(fontObjectKey(userKey), "fonts/user/u1/h", "the per-user path includes the owner, non-optional.");
  assert.notEqual(fontObjectKey(catalogueKey), fontObjectKey(userKey), "identical hashes in different stores are different objects (D4).");
  assert.equal(canServeFont(catalogueKey, undefined), true, "catalogue faces are public by licence.");
  assert.equal(canServeFont(userKey, "u1"), true);
  assert.equal(canServeFont(userKey, "u2"), false, "a user font is never served to another account, even by someone who knows the hash.");
  assert.equal(canServeFont(userKey, undefined), false);
  assert.equal(fontStoreKeyFor({ source: "system", fontFamily: "Arial" }), undefined, "a system ref names a platform font and has nothing to install.");

  console.log(`Font mirror passed. ${fetches} fetch(es), both objects written, unlicensed font refused.`);
}

/**
 * Blank the license name records (IDs 13/14) in a real font's `name` table, in place.
 *
 * Walks the table directory to find `name`, then rewrites the record list so those two IDs report
 * zero length. The font still parses and still identifies itself — which is exactly the specimen
 * needed: the mirror must refuse it for the license, not for being broken.
 */
function stripLicenseRecords(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const numTables = view.getUint16(4);
  let nameOffset = -1;
  for (let i = 0; i < numTables; i += 1) {
    const record = 12 + i * 16;
    const tag = String.fromCharCode(bytes[record]!, bytes[record + 1]!, bytes[record + 2]!, bytes[record + 3]!);
    if (tag === "name") nameOffset = view.getUint32(record + 8);
  }
  if (nameOffset < 0) throw new Error("test specimen has no name table — cannot build the unlicensed case.");
  const count = view.getUint16(nameOffset + 2);
  for (let i = 0; i < count; i += 1) {
    const record = nameOffset + 6 + i * 12;
    const nameId = view.getUint16(record + 6);
    if (nameId === 13 || nameId === 14) view.setUint16(record + 8, 0); // length := 0
  }
  return bytes;
}

main()
  .catch((error) => {
    process.stderr.write(`${String(error?.stack ?? error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
