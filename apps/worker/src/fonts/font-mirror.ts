/**
 * ADR-023 D4 / D4a / T-11 — mirror-on-first-use, and the license file that is not a follow-up step.
 *
 * A catalogue family is fetched from Google **once**, hashed, stored under
 * `fonts/catalogue/<fileHash>`, and never fetched from Google again. That is D4's shared store: the
 * licence permits redistribution, so deduplication across all users is correct here (and only here —
 * see `font-store.ts` for why the per-user store must never do the same thing).
 *
 * **T-11 is the reason this module exists as one function rather than two.** "Store the font, and
 * also store its license" is a sentence a future refactor can split, and the half that gets dropped
 * is always the second one, because nothing renders differently without it. So `mirrorCatalogueFont`
 * writes both objects or neither, and the license bytes come out of the SAME parse that validated
 * the font (`readFontIdentity` → `identity.license`), rather than from a second fetch that could
 * succeed, fail, or drift independently. A font whose own name table declares no license is refused
 * outright: we cannot lawfully redistribute what will not say what it is.
 *
 * The failure this prevents is silent. A mirror entry missing its `LICENSE.txt` renders perfectly.
 */
import { objectExists, persistBytes } from "@orreris/storage";
import {
  computeFontFileHash,
  fontLicenseObjectKey,
  fontObjectKey,
  readFontIdentity,
  type CatalogueFontKey,
  type FontIdentity
} from "@orreris/shared";

export interface MirroredFont {
  key: CatalogueFontKey;
  /**
   * `undefined` when the mirror already held the pinned hash, because then nothing was fetched and
   * therefore nothing was parsed. Deliberately not faked from the ref: a caller that needs identity
   * needs the FONT's answer (T-4), and the honest response to "we did not look" is `undefined`.
   *
   * Nothing on the render path needs it — `FontRef` already carries family/weight/style, which is
   * precisely why D1 puts the human identity in the ref alongside the hash.
   */
  identity: FontIdentity | undefined;
  /** True when the bytes were fetched and written by THIS call; false when the mirror already had them. */
  fetched: boolean;
}

export class FontMirrorError extends Error {
  readonly code: "fetch-failed" | "no-license" | "hash-mismatch";
  constructor(code: FontMirrorError["code"], message: string) {
    super(message);
    this.name = "FontMirrorError";
    this.code = code;
  }
}

/** Injectable so the gate can drive this without reaching the network. */
export type FontFetcher = (url: string) => Promise<ArrayBuffer>;

const defaultFetcher: FontFetcher = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new FontMirrorError("fetch-failed", `Font fetch failed: ${response.status} ${url}`);
  return response.arrayBuffer();
};

/**
 * The license text stored alongside a mirrored face. Includes the URL and the family it belongs to
 * so the object is self-describing when read on its own — an operator auditing the bucket should not
 * have to parse the neighbouring binary to learn what they are looking at.
 */
function licenseFileContents(identity: FontIdentity, fileHash: string): string {
  const url = identity.license?.url ? `\n\nLicense URL: ${identity.license.url}` : "";
  return (
    `${identity.family} ${identity.subfamily} (weight ${identity.weight}, ${identity.style})\n` +
    `SHA-256: ${fileHash}\n\n` +
    `${identity.license?.text ?? ""}${url}\n\n` +
    `Mirrored by Orreris under ADR-023 D4a. Redistribution is permitted by the license above; this\n` +
    `file is stored with the font as required by ADR-023 T-11 and must never be deleted separately.\n`
  );
}

/**
 * Fetch, validate, hash and mirror one catalogue face — or return the existing mirror entry.
 *
 * `expectedHash`, when given, is the manifest's pin: a fetched file whose hash differs is NOT the
 * font the project asked for, and mirroring it under the expected name would quietly substitute a
 * different face for a pinned one — the exact failure D1's hash exists to prevent.
 */
export async function mirrorCatalogueFont(
  sourceUrl: string,
  options: { expectedHash?: string; fetcher?: FontFetcher } = {}
): Promise<MirroredFont> {
  const fetcher = options.fetcher ?? defaultFetcher;

  /**
   * The real mirror-on-first-USE short circuit, and the reason `expectedHash` matters beyond
   * validation: a pinned hash IS the object key, so a face already in the bucket can be recognised
   * WITHOUT fetching it. Without a pin there is no way to know what a URL will serve except to
   * fetch it, so the first ingest of a family necessarily pays one fetch — but every render after
   * that carries the hash in its manifest and pays none.
   *
   * This was originally written to fetch first and check afterwards, which passed every functional
   * assertion while making "never fetched from Google again" false. The gate caught it.
   */
  if (options.expectedHash) {
    const pinnedKey: CatalogueFontKey = { store: "catalogue", fileHash: options.expectedHash };
    if ((await objectExists(fontObjectKey(pinnedKey))) && (await objectExists(fontLicenseObjectKey(pinnedKey)))) {
      return { key: pinnedKey, identity: undefined, fetched: false };
    }
  }

  const bytes = await fetcher(sourceUrl);

  // The parse is the validity gate (D2). A file that is not a font never reaches storage.
  const identity = await readFontIdentity(bytes);
  const fileHash = await computeFontFileHash(bytes);

  if (options.expectedHash && options.expectedHash !== fileHash) {
    throw new FontMirrorError(
      "hash-mismatch",
      `Font at ${sourceUrl} hashed ${fileHash}, but the manifest pins ${options.expectedHash}. ` +
        `Refusing to mirror: this is a different face under the same name, which is precisely what the pin exists to catch.`
    );
  }

  // D4a/T-11. Refused BEFORE any write, so the "font without a license" state cannot exist in the
  // bucket even transiently.
  if (!identity.license?.text) {
    throw new FontMirrorError(
      "no-license",
      `${identity.family} declares no license in its name table (IDs 13/14). It cannot be mirrored: ` +
        `D4a's redistribution is lawful only with the license retained, and T-11 forbids storing a font without one.`
    );
  }

  const key: CatalogueFontKey = { store: "catalogue", fileHash };
  const objectKey = fontObjectKey(key);
  const licenseKey = fontLicenseObjectKey(key);

  // Mirror-on-first-USE: an entry already present is never re-fetched. Both objects are checked,
  // not just the font — an entry whose license went missing is repaired rather than trusted, which
  // is T-11's "defect to fix before ship, not a cleanup task to defer" made operational.
  if ((await objectExists(objectKey)) && (await objectExists(licenseKey))) {
    return { key, identity, fetched: false };
  }

  // ONE operation, by construction: the license write is not reachable without the font write, and
  // neither is exposed separately. If the second write throws, the caller sees a failure and the
  // next call repairs the pair via the existence check above — it never reports success on a font
  // that is sitting in the bucket unlicensed.
  await persistBytes(objectKey, Buffer.from(bytes), "font/ttf");
  await persistBytes(licenseKey, Buffer.from(licenseFileContents(identity, fileHash), "utf8"), "text/plain; charset=utf-8");

  return { key, identity, fetched: true };
}
