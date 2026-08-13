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
 * writes both objects or neither, and it obtains the license itself rather than trusting a caller to
 * hand one over. A face whose license cannot be obtained is refused outright: we cannot lawfully
 * redistribute what will not say what it is.
 *
 * The failure this prevents is silent. A mirror entry missing its `LICENSE.txt` renders perfectly.
 *
 * ## S2.6 — where the license bytes come from, and why that had to change
 *
 * S2.3 read the license out of the font's own name table (IDs 13/14) and refused anything without
 * one. That is right for the bundled faces, which come from full upstream builds, and it does not
 * survive contact with Google's CDN: **every static instance served from `fonts.gstatic.com` has
 * name IDs 13/14 stripped** — measured across Cairo, Amiri, Noto Naskh Arabic and Inter, all of
 * which come back with no license text at all. Kept as-is, this function would have refused every
 * family the S2.6 picker can offer, and mirror-on-pick would have been dead on arrival.
 *
 * The license is not missing, only stored beside the font: `google/fonts` keeps one per family
 * directory, which is what `FontIndexFamily.licensePath` records. So a second SOURCE is admitted —
 * never a second STEP. `licenseUrl` is fetched inside this call, before any write, and the
 * both-or-neither property is unchanged. T-11 as written is untouched: a mirrored font is never
 * stored, and never served, without its license file alongside it.
 *
 * ## This module lives in `@orreris/storage`, not in the worker
 *
 * Because mirror-on-pick is triggered from the EDITOR, through the API, while renders trigger it
 * from the worker. Two copies of a both-or-neither write is exactly the drift T-11 forbids, so there
 * is one, in the package both already depend on.
 */
import {
  computeFontFileHash,
  fontLicenseObjectKey,
  fontObjectKey,
  readFontIdentity,
  type CatalogueFontKey,
  type FontIdentity
} from "@orreris/shared";
import { objectExists, persistBytes } from "./index";

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
  readonly code: "fetch-failed" | "no-license" | "hash-mismatch" | "unknown-family";
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
function licenseFileContents(identity: FontIdentity, fileHash: string, license: ResolvedLicense): string {
  const url = license.url ? `\n\nLicense URL: ${license.url}` : "";
  return (
    `${identity.family} ${identity.subfamily} (weight ${identity.weight}, ${identity.style})\n` +
    `SHA-256: ${fileHash}\n` +
    `License source: ${license.origin}\n\n` +
    `${license.text}${url}\n\n` +
    `Mirrored by Orreris under ADR-023 D4a. Redistribution is permitted by the license above; this\n` +
    `file is stored with the font as required by ADR-023 T-11 and must never be deleted separately.\n`
  );
}

/** Where a mirrored face's license text came from — recorded in the stored file, so it is auditable. */
interface ResolvedLicense {
  text: string;
  url: string | undefined;
  origin: "font name table" | "google/fonts";
}

/** Fetches a license document as text. Injectable for the same reason `FontFetcher` is. */
export type LicenseFetcher = (url: string) => Promise<string>;

const defaultLicenseFetcher: LicenseFetcher = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new FontMirrorError("fetch-failed", `License fetch failed: ${response.status} ${url}`);
  return response.text();
};

/**
 * Fetch, validate, hash and mirror one catalogue face — or return the existing mirror entry.
 *
 * `expectedHash`, when given, is the manifest's pin: a fetched file whose hash differs is NOT the
 * font the project asked for, and mirroring it under the expected name would quietly substitute a
 * different face for a pinned one — the exact failure D1's hash exists to prevent.
 *
 * `licenseUrl` is the fallback source for the license when the font's own name table carries none —
 * see the module note on Google's stripped name tables. It is fetched HERE, not by the caller, so
 * "both objects or neither" stays a property of this function rather than a convention.
 */
export async function mirrorCatalogueFont(
  sourceUrl: string,
  options: { expectedHash?: string; fetcher?: FontFetcher; licenseUrl?: string; licenseFetcher?: LicenseFetcher } = {}
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

  /**
   * D4a/T-11. Resolved BEFORE any write, so the "font without a license" state cannot exist in the
   * bucket even transiently — and resolved from the font FIRST, because a license the face itself
   * declares is better evidence than one inferred from where the file was found.
   */
  let license: ResolvedLicense | undefined;
  if (identity.license?.text) {
    license = { text: identity.license.text, url: identity.license.url, origin: "font name table" };
  } else if (options.licenseUrl) {
    const text = await (options.licenseFetcher ?? defaultLicenseFetcher)(options.licenseUrl);
    // An empty or token-sized response is not a license. Without this, a 200-with-an-error-page
    // would be mirrored as the license text and T-11 would be satisfied by a lie.
    if (text.trim().length < 200) {
      throw new FontMirrorError(
        "no-license",
        `The license document at ${options.licenseUrl} came back ${text.trim().length} characters long. ` +
          `That is not a license, and storing it would satisfy T-11 on paper while leaving the font unlicensed.`
      );
    }
    license = { text, url: options.licenseUrl, origin: "google/fonts" };
  }
  if (!license) {
    throw new FontMirrorError(
      "no-license",
      `${identity.family} declares no license in its name table (IDs 13/14) and no license document was ` +
        `available for it. It cannot be mirrored: D4a's redistribution is lawful only with the license ` +
        `retained, and T-11 forbids storing a font without one.`
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
  await persistBytes(licenseKey, Buffer.from(licenseFileContents(identity, fileHash, license), "utf8"), "text/plain; charset=utf-8");

  return { key, identity, fetched: true };
}

/* ------------------------------------------------------------------------------------------------
 * Mirror-on-PICK: from an index row to stored bytes.
 * ---------------------------------------------------------------------------------------------- */

/**
 * Resolve the static-instance URL Google serves for one face.
 *
 * The CSS API answers differently per client: a browser gets `woff2`, and a plain server-side
 * `fetch` gets `truetype`. That is what we want and it is load-bearing rather than incidental —
 * `readFontIdentity` cannot parse woff2 (`FontIngestError` has a `woff2-unsupported` code precisely
 * for this), so a `User-Agent` that advertises woff2 support would break the ingest. Left alone
 * deliberately; do not "modernise" this by adding browser headers.
 */
export async function resolveGoogleFontUrl(family: string, weight: number, style: "normal" | "italic"): Promise<string> {
  const axis = style === "italic" ? `ital,wght@1,${weight}` : `wght@${weight}`;
  const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:${axis}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new FontMirrorError(
      "unknown-family",
      `Google has no ${family} ${weight}/${style} (css2 answered ${response.status}). The index and the CDN disagree.`
    );
  }
  const css = await response.text();
  const match = /src:\s*url\((https:[^)]+)\)/.exec(css);
  if (!match?.[1]) throw new FontMirrorError("unknown-family", `No font URL in Google's answer for ${family} ${weight}/${style}.`);
  return match[1];
}

/** The raw URL of a license document in `google/fonts`, from `FontIndexFamily.licensePath`. */
export function googleFontLicenseUrl(licensePath: string): string {
  return `https://raw.githubusercontent.com/google/fonts/main/${licensePath}`;
}

/**
 * Mirror one face named by an INDEX row. The whole of mirror-on-pick, in one call.
 *
 * This is what breaks S2.5's circle at runtime: the picker lists a family it does not hold, the user
 * picks it, and the bytes arrive — with their license, in one operation — so that a `FontRef` with a
 * real `fileHash` can be written. No hash is known before this runs, and that is the correct
 * direction of causation: the hash is what we fetched, never what a table promised (D1).
 */
export async function mirrorGoogleFont(request: {
  family: string;
  weight: number;
  style: "normal" | "italic";
  licensePath?: string | undefined;
  fetcher?: FontFetcher | undefined;
  licenseFetcher?: LicenseFetcher | undefined;
  urlResolver?: ((family: string, weight: number, style: "normal" | "italic") => Promise<string>) | undefined;
}): Promise<MirroredFont> {
  const resolve = request.urlResolver ?? resolveGoogleFontUrl;
  const sourceUrl = await resolve(request.family, request.weight, request.style);
  return mirrorCatalogueFont(sourceUrl, {
    ...(request.licensePath ? { licenseUrl: googleFontLicenseUrl(request.licensePath) } : {}),
    ...(request.fetcher ? { fetcher: request.fetcher } : {}),
    ...(request.licenseFetcher ? { licenseFetcher: request.licenseFetcher } : {})
  });
}
