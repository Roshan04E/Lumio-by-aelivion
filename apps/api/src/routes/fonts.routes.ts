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
import { z } from "zod";
import { fontIndexFace, fontIndexFamily, type FontRef } from "@orreris/shared";
import { FontMirrorError, mirrorGoogleFont } from "@orreris/storage";
import { asyncHandler, HttpError, ok, validateBody } from "../lib/http";
import { requireAuth, type AuthRequest } from "../middleware/auth";

export const fontsRouter = Router();

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
