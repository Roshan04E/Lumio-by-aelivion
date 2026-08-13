/**
 * ADR-023 D4/D4a/T-11 (S2.6) — **mirror-on-pick.** The endpoint that breaks S2.5's circle.
 *
 * S2.5's picker could only offer what had already been mirrored, so nothing was picked and nothing
 * was mirrored — five families behind a contract built for thousands. S2.6's index lists ~1900 more,
 * and this is what turns one of those metadata rows into bytes we hold: the editor asks for a family
 * at a weight, the mirror fetches it WITH its licence in one operation (T-11), and the answer is the
 * `fileHash` a `FontRef` then pins.
 *
 * **The hash is produced here and nowhere earlier.** The index deliberately carries none (D1): a
 * `FontRef` must pin what was actually fetched, not what a table promised it would be. So this route
 * is not a lookup — it is the point at which "a font exists somewhere" becomes "we hold these exact
 * bytes", and the response is the first moment that answer exists.
 *
 * Authenticated, because it causes an outbound fetch and a bucket write. The RESULT is public by
 * licence (D4 — catalogue faces are deduplicated across all users, which is what OFL/Apache permit),
 * so nothing here is scoped to the caller; the auth is on the action, not on the artifact.
 */
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import {
  computeFontFileHash,
  fontIndexFace,
  fontIndexFamily,
  FontIngestError,
  fontObjectKey,
  readFontIdentity,
  type FontRef,
  type UserFontKey
} from "@orreris/shared";
import { decompressFontIfNeeded, FontMirrorError, mirrorGoogleFont, objectExists, persistBytes } from "@orreris/storage";
import { asyncHandler, HttpError, ok, validateBody } from "../lib/http";
import { requireAuth, type AuthRequest } from "../middleware/auth";

export const fontsRouter = Router();

// 32 MiB. A CJK font is the honest upper bound here and lands well inside it; anything larger is not
// a font, and memoryStorage makes this the per-request RAM bound as well as the size cap.
const uploadFont = multer({ storage: multer.memoryStorage(), limits: { fileSize: 32 * 1024 * 1024 } });

const mirrorSchema = z.object({
  family: z.string().trim().min(1),
  weight: z.coerce.number().int().min(1).max(1000).default(400),
  style: z.enum(["normal", "italic"]).default("normal")
});

fontsRouter.post(
  "/mirror",
  requireAuth,
  asyncHandler<AuthRequest>(async (req, res) => {
    const { family, weight, style } = validateBody(mirrorSchema, req.body);

    // The index is the authority on what may be asked for. Without this the endpoint would fetch an
    // arbitrary caller-supplied family name from a third party and write the result into our
    // bucket — a request forgery with a storage bill attached.
    const indexed = fontIndexFamily(family);
    if (!indexed) throw new HttpError(404, `"${family}" is not in the font catalogue.`);

    // Resolve to a face the family actually HAS, so a request for 900 on a 400/700 family mirrors
    // the 700 file rather than asking Google for an instance that does not exist.
    const face = fontIndexFace(family, weight, style);
    if (!face) throw new HttpError(404, `"${family}" has no ${weight}/${style} face.`);

    try {
      const mirrored = await mirrorGoogleFont({
        family,
        weight: face.weight,
        style: face.style,
        licensePath: indexed.licensePath
      });
      // The exact shape the editor writes into the layer. Built here rather than reassembled by the
      // client so there is one place that decides what a pinned ref looks like.
      const ref: FontRef = {
        source: "catalogue",
        family,
        weight: face.weight,
        style: face.style,
        fileHash: mirrored.key.fileHash
      };
      return ok(res, mirrored.fetched ? "Font mirrored" : "Font already mirrored", { ref, fetched: mirrored.fetched });
    } catch (error) {
      if (error instanceof FontMirrorError) {
        /**
         * D3/T-2's vocabulary, at the pick boundary. A refusal here is a REFUSAL, never a fallback:
         * the alternative — quietly returning some other face — is the substitution D1's hash exists
         * to prevent, arriving through the front door.
         *
         * `no-license` is the one a user is most likely to meet (12 of 1942 families keep no licence
         * document in `google/fonts`), and it is a 409 rather than a 500 because nothing is broken:
         * the answer is "not this font", and it is stable.
         */
        const status = error.code === "no-license" ? 409 : error.code === "unknown-family" ? 404 : 502;
        throw new HttpError(status, `${family} ${face.weight}${face.style === "italic" ? " italic" : ""}: ${error.message}`);
      }
      throw error;
    }
  })
);

/**
 * ADR-023 D4 / D5 (S3) — **the opt-in cloud half of a user font upload.**
 *
 * The editor already has these bytes on-device; this endpoint is what makes them resolvable by a
 * cloud render and by the user's second machine. It records a pairing and remaps nothing (D5): the
 * project already refers to the font by `(ownerId, fileHash)`, and what changes is only whether the
 * server can answer for that pair.
 *
 * **The owner comes from the verified token and from nowhere else.** Not from the body, not from a
 * query parameter. `ownerId` is the entire isolation boundary (D4), and an endpoint that let a
 * caller name the owner would let them write into someone else's store — which is the same
 * violation as reading out of it, with the arrow reversed.
 *
 * The parse is the validity gate (D2/T-4) and it runs here too rather than trusting the editor's:
 * this endpoint is reachable without the editor, and "the client already checked" is not a check.
 */
fontsRouter.post(
  "/user",
  requireAuth,
  uploadFont.single("file"),
  asyncHandler<AuthRequest>(async (req, res) => {
    const file = (req as AuthRequest & { file?: { buffer: Buffer; originalname: string } }).file;
    if (!file?.buffer?.byteLength) throw new HttpError(400, "No font file was uploaded.");

    const uploaded = file.buffer.buffer.slice(file.buffer.byteOffset, file.buffer.byteOffset + file.buffer.byteLength) as ArrayBuffer;
    let bytes: ArrayBuffer;
    let identity: Awaited<ReturnType<typeof readFontIdentity>>;
    try {
      // WOFF2 first: opentype.js cannot Brotli-decode it, and what gets STORED must be what the
      // worker can install — so the conversion happens before the parse and before the hash.
      bytes = await decompressFontIfNeeded(uploaded);
      identity = await readFontIdentity(bytes);
    } catch (error) {
      if (error instanceof FontIngestError) throw new HttpError(400, error.message);
      throw error;
    }

    const fileHash = await computeFontFileHash(bytes);
    const key: UserFontKey = { store: "user", ownerId: req.user.id, fileHash };
    const objectKey = fontObjectKey(key);

    /**
     * D4's deduplication rule, and the one place it is tempting to be clever. Two accounts uploading
     * byte-identical copies of the same commercial font get TWO objects, because the second one is
     * not a copy of the first — it is a different user's licence. The existence check below is
     * therefore scoped to THIS owner's key and can never collapse across accounts: the owner is in
     * the path, so there is no shared key for an optimiser to notice.
     */
    const already = await objectExists(objectKey);
    if (!already) await persistBytes(objectKey, Buffer.from(bytes), "font/ttf");

    const ref: FontRef = {
      source: "user",
      family: identity.family,
      weight: identity.weight,
      style: identity.style,
      fileHash,
      ownerId: req.user.id
    };
    return ok(res, already ? "Font already uploaded" : "Font uploaded", { ref, stored: !already });
  })
);
