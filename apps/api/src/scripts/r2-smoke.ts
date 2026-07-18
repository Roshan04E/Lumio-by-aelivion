/**
 * R2 connectivity smoke test — run: pnpm --filter @orreris/api exec tsx src/scripts/r2-smoke.ts
 * Uploads a tiny object, reads it back, deletes it — proving endpoint + credentials work end to end.
 * Safe to delete this file; it's a one-off diagnostic.
 */
import type { Readable } from "node:stream";
import { env } from "../config/env";
import { deleteAsset, getObjectStream, isR2Storage, saveBuffer } from "../services/storage.service";

async function streamToString(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  console.log("Effective storage config:");
  console.log("  STORAGE_DRIVER =", env.STORAGE_DRIVER);
  console.log("  R2_ENDPOINT    =", env.R2_ENDPOINT ?? "(unset)");
  console.log("  R2_BUCKET      =", env.R2_BUCKET ?? "(unset)");
  console.log("  R2 keys set    =", Boolean(env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY));
  console.log("  R2_PUBLIC_BASE =", env.R2_PUBLIC_BASE_URL ?? "(unset — API will proxy reads)");

  if (!isR2Storage) {
    console.log("\n⚠  STORAGE_DRIVER is not 'r2'. Set STORAGE_DRIVER=r2 in your .env and re-run. Nothing was uploaded.");
    return;
  }

  const stamp = Date.now();
  const expected = `orreris r2 smoke test ${stamp}\n`;

  console.log("\n1) Uploading test object…");
  const url = await saveBuffer(Buffer.from(expected), `r2-smoke-${stamp}.txt`);
  console.log("   ✓ PUT ok →", url);

  const key = url.slice(url.indexOf("uploads/"));
  console.log(`2) Reading it back (key: ${key})…`);
  const { body, contentType } = await getObjectStream(key);
  const got = await streamToString(body);
  console.log("   ✓ GET ok →", JSON.stringify(got.trim()), `(content-type: ${contentType ?? "?"})`);
  if (got !== expected) throw new Error("Round-trip content mismatch!");

  console.log("3) Deleting test object…");
  await deleteAsset(url);
  console.log("   ✓ DELETE ok");

  console.log("\n✅ R2 is wired correctly. (The test object was cleaned up.)");
}

main().catch((error) => {
  console.error("\n❌ R2 smoke test FAILED:\n  ", error instanceof Error ? error.message : error);
  console.error(
    "\nCommon causes: wrong R2_ENDPOINT (must NOT include /orreris), bad keys, or the token isn't scoped to this bucket."
  );
  process.exit(1);
});
