/**
 * ADR-023 D2/T-4 — the name-table ingest, asserted against REAL font binaries.
 *
 * These are the eight OFL files already hosted in `apps/worker/public/fonts`, so the test reads
 * fonts that actually ship rather than a synthetic fixture. That matters for a parser: the failure
 * mode being guarded against is "the reader looked in the wrong place and every font came back
 * unnamed", which a hand-built fixture designed against the same wrong assumption would not catch.
 *
 * Run: pnpm --filter @orreris/worker font:ingest-test
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeFontFileHash, decompressFontIfNeeded, FontIngestError, readFontIdentity } from "@orreris/shared";

const fontsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public/fonts");

function read(file: string): ArrayBuffer {
  const buffer = fs.readFileSync(path.join(fontsDir, file));
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

async function main(): Promise<void> {
  // The filename says "Bold"; the assertion is that we did not read the filename. Anton's file is
  // named "-Regular" and IS 400; Arimo-Bold's OS/2 says 700. If the parser were filename-driven both
  // would still pass, so the real evidence is the pair below plus the deliberate mismatch case.
  const anton = await readFontIdentity(read("Anton-Regular.ttf"));
  assert.equal(anton.family, "Anton");
  assert.equal(anton.weight, 400);
  assert.equal(anton.style, "normal");

  const arimoBold = await readFontIdentity(read("Arimo-Bold.ttf"));
  assert.equal(arimoBold.family, "Arimo", "family comes from the name table, and it is NOT 'Arimo-Bold'.");
  assert.equal(arimoBold.subfamily, "Bold");
  assert.equal(arimoBold.weight, 700, "weight comes from OS/2.usWeightClass.");

  // T-4 stated as a falsifiable claim: rename the file and the identity must not budge by one byte.
  const renamed = fs.readFileSync(path.join(fontsDir, "Arimo-Bold.ttf"));
  const misleading = path.join(fontsDir, "MyFont-Thin-FINAL(2).ttf");
  fs.writeFileSync(misleading, renamed);
  try {
    const fromLiar = await readFontIdentity(read("MyFont-Thin-FINAL(2).ttf"));
    assert.deepEqual(fromLiar, arimoBold, "a filename is not evidence of anything (D2) — identity must be byte-identical.");
  } finally {
    fs.unlinkSync(misleading);
  }

  // Every hosted catalogue font identifies itself and carries its license IN the name table. The
  // second half is what makes T-11 enforceable from the same parse that produced the bytes.
  for (const file of fs.readdirSync(fontsDir).filter((name) => /\.(ttf|otf|woff)$/i.test(name))) {
    const identity = await readFontIdentity(read(file));
    assert.ok(identity.family, `${file} must report a family.`);
    assert.ok(identity.weight >= 1 && identity.weight <= 1000, `${file} weight out of range: ${identity.weight}`);
    assert.ok(identity.license?.text, `${file} must carry its license text — the mirror refuses fonts without one (T-11).`);
    // D4a permits mirroring OFL *and* Apache-2.0, and the hosted set uses both: the Liberation-metric
    // faces are OFL, Roboto is Apache-2.0. Asserting OFL alone failed here, which is the assertion
    // being wrong rather than the font — worth keeping as the reason this reads the way it does.
    assert.match(
      identity.license.text,
      /Open Font License|Apache License/i,
      `${file} is redistributed under D4a; its own name table must say which license.`
    );
  }

  // D2: THE PARSE IS THE VALIDITY GATE. Rejection is the feature, not an edge case.
  await assert.rejects(
    () => readFontIdentity(new TextEncoder().encode("this is not a font at all, not even close").buffer as ArrayBuffer),
    (error: unknown) => error instanceof FontIngestError && error.code === "not-a-font",
    "a file that is not a font must be rejected at INGEST, not discovered at render."
  );
  await assert.rejects(
    () => readFontIdentity(new ArrayBuffer(0)),
    (error: unknown) => error instanceof FontIngestError && error.code === "empty-file"
  );
  // WOFF2 gets its own code because the fix is specific; the generic parse error reads as "your font
  // is broken" when it is merely compressed in a way opentype.js cannot undo. `readFontIdentity`
  // still refuses it even though S3 can now decompress: this function's contract is "read what a
  // font says about itself", and converting inside it would hide from every caller — including the
  // ones that STORE what they parsed — that the bytes changed.
  const woff2 = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 0, 0, 0]);
  await assert.rejects(
    () => readFontIdentity(woff2.buffer as ArrayBuffer),
    (error: unknown) => error instanceof FontIngestError && error.code === "woff2-unsupported"
  );

  /**
   * ---- S3: WOFF2 is now ACCEPTED, by decompressing before the parse. --------------------------
   *
   * The fixture is BUILT here rather than checked in, which also makes the arm a round trip: a real
   * OFL binary is compressed to WOFF2 and must come back as a font that identifies itself the same
   * way. A checked-in `.woff2` would prove the decoder runs; this proves it produces the right font.
   *
   * `compress` is deliberately absent from this repo's `wawoff2` declaration — nothing in the
   * product creates WOFF2, and declaring it would invite something to start — so the gate reaches
   * for it explicitly. That asymmetry is the point rather than an oversight.
   */
  const wawoff2 = (await import("wawoff2")) as unknown as {
    compress(input: Uint8Array): Promise<Uint8Array>;
    decompress(input: Uint8Array): Promise<Uint8Array>;
  };
  const antonTtf = new Uint8Array(read("Anton-Regular.ttf"));
  const compressed = await wawoff2.compress(antonTtf);
  assert.deepEqual([...compressed.slice(0, 4)], [0x77, 0x4f, 0x46, 0x32], "the fixture must really be a WOFF2.");
  const compressedBuffer = compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength) as ArrayBuffer;

  const restored = await decompressFontIfNeeded(compressedBuffer);
  const restoredIdentity = await readFontIdentity(restored);
  assert.equal(restoredIdentity.family, "Anton", "a decompressed WOFF2 must identify itself as the font it came from.");
  assert.equal(restoredIdentity.weight, 400);
  assert.equal(restoredIdentity.style, "normal");

  /**
   * **The hash is of the DECOMPRESSED file, and that is the whole reason the conversion happens
   * before the hash rather than after.** D1 makes `fileHash` the render identity — the thing the
   * worker resolves to bytes and installs — so it has to name bytes that can actually be parsed and
   * rasterized. Pinning the upload would name something nothing downstream could use.
   */
  const restoredHash = await computeFontFileHash(restored);
  const compressedHash = await computeFontFileHash(compressedBuffer);
  assert.notEqual(restoredHash, compressedHash, "the stored hash must be the decompressed file's, not the upload's.");
  assert.equal(await computeFontFileHash(await decompressFontIfNeeded(compressedBuffer)), restoredHash, "…and it must be stable.");

  // A non-WOFF2 passes through untouched, byte for byte. Otherwise every .ttf upload would be
  // re-hashed through a code path that had no business touching it.
  const untouched = await decompressFontIfNeeded(read("Anton-Regular.ttf"));
  assert.equal(await computeFontFileHash(untouched), await computeFontFileHash(read("Anton-Regular.ttf")));

  // A WOFF2 that is only a header is not decompressible, and must still fail with the TYPED code —
  // the same code, now meaning "this file is broken" rather than "this format is unsupported".
  await assert.rejects(
    () => decompressFontIfNeeded(woff2.buffer as ArrayBuffer),
    (error: unknown) => error instanceof FontIngestError && error.code === "woff2-unsupported"
  );

  // The render identity is the bytes. Same bytes, same hash; one flipped byte, different hash.
  const bytes = read("Anton-Regular.ttf");
  const hashA = await computeFontFileHash(bytes);
  const hashB = await computeFontFileHash(read("Anton-Regular.ttf"));
  assert.equal(hashA, hashB, "hashing must be deterministic — it is the manifest's pin.");
  assert.equal(hashA.length, 64);
  const mutated = new Uint8Array(bytes.slice(0));
  mutated[mutated.length - 1] = (mutated[mutated.length - 1]! + 1) & 0xff;
  assert.notEqual(await computeFontFileHash(mutated.buffer as ArrayBuffer), hashA, "one byte must change the render identity.");

  console.log(`Font ingest passed. ${anton.family} 400, ${arimoBold.family} 700, ${hashA.slice(0, 12)}… — WOFF2 round-trips to ${restoredIdentity.family}.`);
}

main().catch((error) => {
  process.stderr.write(`${String(error?.stack ?? error)}\n`);
  process.exit(1);
});
