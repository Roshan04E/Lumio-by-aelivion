/**
 * ADR-023 D4 / T-3 (S3) — **a second account must not resolve the first account's font.**
 *
 * This is the assertion the whole two-stores decision exists for, and it is deliberately made
 * against the REAL paths rather than against `canServeFont` in isolation. A unit test of the guard
 * proves the guard returns `false`; it proves nothing about whether anything calls it. Both of the
 * ways bytes actually leave this system are exercised here:
 *
 *  1. **The HTTP path** — the real `createApp()`, listening on a real port. `/storage` is mounted
 *     ahead of the credentialed `/api` gate with `Access-Control-Allow-Origin: *`, because media
 *     URLs are unguessable capability URLs. A per-user font key is not: it is content-addressed, so
 *     two accounts holding byte-identical copies of the same commercial font produce the SAME hash.
 *     D4 stores them twice on purpose, and all of that isolation is undone if the path is readable
 *     by anyone who can compute a SHA-256.
 *  2. **The render path** — the real `resolveFontsForLayers`, which is how the worker turns a
 *     manifest into installed bytes. A render for account B must abort by name rather than quietly
 *     produce a perfectly good deliverable containing account A's licensed font.
 *
 * **Succeed-then-fail throughout.** Account A's own read succeeds FIRST in both halves. A gate where
 * nothing resolves proves the setup is broken, not that isolation works — and this repo has been
 * caught by the permanently-broken variant more than once.
 *
 * No database: the `/storage` guard is a capability check that needs only the JWT's `sub`, which is
 * exactly why it is not `requireAuth` (that additionally loads the user row, and could not run ahead
 * of the CORS gate anyway). What is NOT covered here is a token for a user who has since been
 * deleted — that is `requireAuth`'s job on the `/api` surface, and it is stated rather than implied.
 *
 * Run: pnpm --filter @orreris/worker font:isolation-gate
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { FontRef } from "@orreris/shared";

/**
 * **The gate takes its configuration FROM the app, and this is a measured correction rather than a
 * preference.** The first draft set `STORAGE_ROOT` and `JWT_SECRET` to a temp sandbox before
 * importing anything — the normal pattern in this repo's gates, and here it silently did nothing:
 * `dotenvx` OVERRIDES `process.env` from `.env`, so by the time the API's env module had parsed, the
 * app was serving from the repo's real storage root and verifying against the repo's real secret.
 * Alice's own read came back 404 and every isolation assertion below it would have "passed" against
 * a server that was refusing everything.
 *
 * So the API is imported first and asked what it is actually using. That also makes the gate more
 * honest, not less: it exercises the deployment's real configuration instead of one invented for it.
 * Only the two font objects are written, and they are removed again in `finally`.
 */
// Imported by RELATIVE path: this gate exercises the API app itself, and the worker deliberately
// does not depend on the API package. tsx resolves it, and express/zod resolve from the API's own
// node_modules because module resolution follows the file, not the process.
const { env } = await import("../../api/src/config/env");
const { isR2Storage, storagePaths } = await import("../../api/src/services/storage.service");
const { createApp } = await import("../../api/src/app");

// Now pin the worker's storage client to the SAME absolute root the API resolved. `STORAGE_ROOT` is
// a relative path in `.env`, and the two processes have different working directories — left alone,
// the render half of this gate would look for the font somewhere the HTTP half never wrote it.
process.env.STORAGE_DRIVER = "local";
process.env.STORAGE_ROOT = storagePaths.root;

const { canServeFont, fontObjectKey, computeFontFileHash } = await import("@orreris/shared");
const { deleteAsset, getPublicUrl, objectExists, persistBytes, isR2StorageEnabled } = await import("@orreris/storage");
const { resolveFontsForLayers } = await import("./fonts/font-resolver");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
/** Exactly the objects this gate created, so cleanup removes what it wrote and nothing else. */
const written: string[] = [];

const ALICE = "user_alice";
const BOB = "user_bob";
/**
 * Sign an HS256 JWT by hand rather than pulling `jsonwebtoken` into the worker.
 *
 * The guard under test verifies a real signature, so the token has to be genuinely valid — a fake
 * one would only ever exercise the rejection branch, and the arm that matters most is Alice's read
 * SUCCEEDING before Bob's is refused.
 */
function tokenFor(id: string): string {
  const secret = env.JWT_SECRET;
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const body = `${part({ alg: "HS256", typ: "JWT" })}.${part({ sub: id, iat: Math.floor(Date.now() / 1000) })}`;
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

function userRef(ownerId: string, fileHash: string): FontRef {
  return { source: "user", family: "Brand Sans", weight: 400, style: "normal", fileHash, ownerId };
}

async function main(): Promise<void> {
  /**
   * The two halves must be looking at the same STORE and the same DRIVER, and the driver half of
   * that is not pedantry: this gate first wrote with `fs` while the deployment was configured for
   * R2, so the API served from the bucket and the worker read from a directory the bytes had never
   * been in. Alice's own render "failed to resolve" — an isolation gate passing its refusals for
   * the wrong reason is exactly the void run this repo keeps paying for.
   *
   * So the bytes go in through `persistBytes`, the real storage API, whichever driver is live.
   */
  assert.equal(
    isR2StorageEnabled(),
    isR2Storage,
    "the API and the worker disagree about the storage driver — the two halves of this gate would be testing two systems."
  );
  process.stdout.write(`store: ${isR2Storage ? "r2" : storagePaths.root}
`);

  /* ---- Alice uploads a font. Real bytes, real path, real hash. ------------------------------- */
  const bytes = fs.readFileSync(path.join(repoRoot, "apps", "worker", "public", "fonts", "Arimo-Regular.ttf"));
  const fileHash = await computeFontFileHash(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const aliceKey = { store: "user" as const, ownerId: ALICE, fileHash };
  const objectKey = fontObjectKey(aliceKey);
  assert.equal(objectKey, `fonts/user/${ALICE}/${fileHash}`, "D4's per-user layout, with the owner in the path.");
  written.push(objectKey);
  await persistBytes(objectKey, bytes, "font/ttf");

  /**
   * **The hash is the same for both accounts, and that is the point.** Bob is not guessing — he
   * holds the identical commercial font and can compute its hash exactly as we did. If isolation
   * rested on the hash being secret it would already be broken.
   */
  const bobKey = { store: "user" as const, ownerId: BOB, fileHash };
  assert.equal(bobKey.fileHash, aliceKey.fileHash, "same bytes, same hash — nothing here is secret.");
  assert.notEqual(fontObjectKey(bobKey), objectKey, "…and yet two objects (D4). The duplication IS the isolation.");
  assert.equal(await objectExists(fontObjectKey(bobKey)), false, "Bob has not uploaded it.");

  /* ---- 1. THE HTTP PATH, against the real app. ----------------------------------------------- */
  const app = createApp();
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    // Succeed first: Alice's own read must WORK, or every refusal below is just a broken server.
    const alice = await fetch(`${base}/storage/${objectKey}`, { headers: { Authorization: `Bearer ${tokenFor(ALICE)}` } });
    assert.equal(alice.status, 200, "Alice must be able to read her own font — otherwise this gate proves nothing.");
    const served = Buffer.from(await alice.arrayBuffer());
    assert.equal(served.byteLength, bytes.byteLength, "…and get the real bytes back.");
    assert.equal(await computeFontFileHash(served.buffer.slice(served.byteOffset, served.byteOffset + served.byteLength) as ArrayBuffer), fileHash);

    // Then fail: same URL, Bob's token.
    const bob = await fetch(`${base}/storage/${objectKey}`, { headers: { Authorization: `Bearer ${tokenFor(BOB)}` } });
    assert.equal(
      bob.status,
      404,
      "A SECOND ACCOUNT READ THE FIRST ACCOUNT'S FONT over HTTP. This is D4's licensing invariant failing at the " +
        "only place it can actually be violated. 404 rather than 403 deliberately: confirming the hash exists in " +
        "someone else's store is itself the disclosure."
    );
    assert.equal((await bob.arrayBuffer()).byteLength, 0, "…and not one byte of it.");

    // And with no token at all, which is how the path was readable before this stage.
    const anonymous = await fetch(`${base}/storage/${objectKey}`);
    assert.equal(anonymous.status, 404, "an unauthenticated read of a per-user font must be refused.");
    const forged = await fetch(`${base}/storage/${objectKey}`, { headers: { Authorization: "Bearer not-a-real-token" } });
    assert.equal(forged.status, 404, "…as must a garbage token, rather than being treated as 'no token, carry on'.");

    // The CATALOGUE store must stay public through the same guard, or the fix broke S2.
    const cataloguePath = "fonts/catalogue/" + fileHash;
    written.push(cataloguePath);
    await persistBytes(cataloguePath, bytes, "font/ttf");
    const publicRead = await fetch(`${base}/storage/${cataloguePath}`);
    assert.equal(
      publicRead.status,
      200,
      "a CATALOGUE face must still be served with no credentials — it is public by licence, and that asymmetry " +
        "is the entire reason the two stores are two types rather than one store with a flag."
    );

    // A path that is under fonts/ but is not a key must be refused rather than passed to the static
    // handler, or "fonts/user/alice/../../secret" becomes a question about express.static's opinion.
    for (const probe of ["fonts/user/" + ALICE, "fonts/user/" + ALICE + "/short", "fonts/nonsense/x"]) {
      const response = await fetch(`${base}/storage/${probe}`, { headers: { Authorization: `Bearer ${tokenFor(ALICE)}` } });
      assert.equal(response.status, 404, `an unparseable font path must be refused, not guessed at: ${probe}`);
    }
    process.stdout.write("HTTP path  — Alice 200, Bob 404, anonymous 404, forged 404, catalogue 200.\n");
  } finally {
    // `fetch` keeps its sockets alive, so `close()` alone waits for them forever and the gate hangs
    // after every assertion has already passed — a green run that never prints.
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }

  /* ---- 2. THE RENDER PATH, against the real resolver. ---------------------------------------- */
  const layersFor = (ref: FontRef) => [{ type: "text" as const, fontRef: ref }];

  // Succeed first, again: Alice's render resolves her font to real bytes.
  const resolved = await resolveFontsForLayers(layersFor(userRef(ALICE, fileHash)), ALICE);
  assert.equal(resolved.length, 1, "Alice's own render must resolve her font.");
  assert.ok(resolved[0]!.src.startsWith("data:font/ttf;base64,"), "…to actual bytes, inlined for the render.");

  // Then fail: the same manifest, rendered for Bob.
  await assert.rejects(
    () => resolveFontsForLayers(layersFor(userRef(ALICE, fileHash)), BOB),
    (error: Error) => error.name === "FontResolutionError",
    "A RENDER FOR ANOTHER ACCOUNT RESOLVED A PER-USER FONT. The export would have been a perfectly good " +
      "deliverable containing a licence violation, which is the failure mode D4 exists to make impossible."
  );

  // Bob claiming ownership in the ref does not help: the bytes live under Alice's owner, and Bob's
  // path is empty. This is the attack the content-addressed store invites — same hash, own name.
  await assert.rejects(
    () => resolveFontsForLayers(layersFor(userRef(BOB, fileHash)), BOB),
    (error: Error) => error.name === "FontResolutionError",
    "a ref that names Bob as owner must not reach Alice's object just because the hashes match."
  );

  // No viewer at all fails CLOSED. This is the default every existing render entry point gets, so
  // "someone forgot to thread the owner" must be an abort, never an open door.
  await assert.rejects(
    () => resolveFontsForLayers(layersFor(userRef(ALICE, fileHash)), undefined),
    (error: Error) => error.name === "FontResolutionError",
    "a render with no viewer must refuse per-user fonts — the default has to fail closed."
  );

  // …and a CATALOGUE font still resolves with no viewer, which is what makes the default safe rather
  // than merely strict: nothing that worked before this stage stopped working.
  const catalogueRef: FontRef = { source: "catalogue", family: "Arimo", weight: 400, style: "normal", fileHash };
  const catalogueResolved = await resolveFontsForLayers(layersFor(catalogueRef), undefined);
  assert.equal(catalogueResolved.length, 1, "a catalogue face must still resolve for a viewerless render.");

  /* ---- The guard itself is total over the union, so a third store cannot default to 'sure'. --- */
  assert.equal(canServeFont(aliceKey, ALICE), true);
  assert.equal(canServeFont(aliceKey, BOB), false);
  assert.equal(canServeFont(aliceKey, undefined), false);
  assert.equal(canServeFont({ store: "catalogue", fileHash }, undefined), true);

  process.stdout.write("render path — Alice resolves, Bob aborts, spoofed owner aborts, no-viewer aborts, catalogue resolves.\n");
  process.stdout.write("\nPASS — the per-user store is isolated on both paths that can actually leak it.\n");
}

main()
  .catch((error) => {
    process.stderr.write(`${String(error?.stack ?? error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Only what this gate wrote. It runs against the REAL store, so anything broader than an exact
    // key list would take the developer's media with it.
    for (const key of written) {
      try {
        await deleteAsset(getPublicUrl(key));
      } catch {
        // A cleanup failure must not turn a passing gate red — it leaves two font objects behind.
      }
    }
  });
