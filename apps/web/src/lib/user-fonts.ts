/**
 * ADR-023 D4 / D5 (S3) — **brand fonts: a user's own licensed font, uploaded and usable.**
 *
 * D5 is the shape of this file in one line: *user fonts are assets, and reuse the asset doctrine
 * unchanged.* Bytes land on-device first (`asset-blob-store`, OPFS with the same fallbacks every
 * other asset gets), a cloud upload is opt-in and **records a pairing** rather than remapping the
 * project, and a font missing on a second machine takes the existing `needs-relink` path rather than
 * inventing a font-shaped one. No new sync concept is introduced here, and that is deliberate — the
 * asset pipeline already argued all of this out once.
 *
 * ## What the upload actually does, and the order matters
 *
 *  1. **Decompress if it is WOFF2.** opentype.js cannot Brotli-decode it, and neither can the warp
 *     path (`font-outlines.ts:35`).
 *  2. **Parse the name table.** This is the validity gate (D2/T-4): a file that will not say what it
 *     is, is not a font, and it is refused in an upload dialog rather than mid-export.
 *  3. **Hash what we are keeping** — the decompressed bytes, which is what the `fileHash` pins.
 *  4. Store locally, and only then offer the cloud.
 *
 * The hash is of the CONVERTED file, not the upload. D1 makes `fileHash` the render identity, so it
 * has to name bytes the worker can install; hashing the `.woff2` would pin something nothing
 * downstream could use, and would make the same face uploaded twice in two formats into two fonts.
 *
 * ## What is NOT here, on purpose
 *
 * Nothing that shares a user font with anyone. D4's isolation is structural — `ownerId` is in the
 * key and in the type — and the sharing question (OQ7: a collaborator who cannot relink because they
 * do not own the licence) is unresolved. Building "publish to a project" ahead of that answer would
 * be building the thing the open question is about.
 */
import {
  computeFontFileHash,
  FontIngestError,
  readFontIdentity,
  type FontIdentity,
  registerUserFontFaces,
  type FontRef
} from "@orreris/shared";
import { getAssetBlobStore } from "./asset-blob-store";
import { apiRequest, getCurrentUserId } from "./api";

/** One font this account has uploaded. Local-first: `cloud` says whether the server also has it. */
export interface UserFontRecord {
  fileHash: string;
  family: string;
  subfamily: string;
  weight: number;
  style: "normal" | "italic";
  ownerId: string;
  /** Original filename — for display only. Never for identity (T-4). */
  fileName: string;
  /** True once the bytes have been mirrored to the per-user store by an explicit opt-in. */
  cloud: boolean;
  addedAt: string;
}

const REGISTRY_KEY = "orreris_user_fonts";
const listeners = new Set<() => void>();
let version = 0;

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

export function subscribeUserFonts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function userFontsVersion(): number {
  return version;
}

function readRegistry(): UserFontRecord[] {
  try {
    const raw = localStorage.getItem(REGISTRY_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as UserFontRecord[]) : [];
  } catch {
    return [];
  }
}

function writeRegistry(records: UserFontRecord[]): void {
  localStorage.setItem(REGISTRY_KEY, JSON.stringify(records));
  syncFaceRegistry();
  notify();
}

/**
 * ADR-023 T-18 (S3) — hand this account's uploaded cuts to the face resolver.
 *
 * **This is what closes the seam S2.7 left.** Until an uploaded font had known siblings, both weight
 * controls correctly reported "we don't know what other cuts this has" and refused to turn bold ON
 * — right when you know nothing, wrong the moment you do. Scoped to the signed-in account for the
 * same reason `listUserFonts` is: the browser registry is shared by everyone who uses this machine.
 */
function syncFaceRegistry(): void {
  registerUserFontFaces(listUserFonts());
}

/**
 * Seed the face registry at module load: the local registry outlives the session that wrote it, so
 * a reload must restore an uploaded font's known cuts BEFORE the inspector renders its weight
 * controls. Otherwise the first paint after a refresh reports "we don't know what other cuts this
 * has" for a font sitting right there in the list — S2.7's seam, reopened once per reload.
 */
if (typeof window !== "undefined") syncFaceRegistry();

/**
 * This account's uploaded fonts.
 *
 * Filtered by owner rather than merely listed: the registry is browser-local and two accounts can
 * share a machine. Showing account A's fonts to account B in the picker would be the same disclosure
 * D4 forbids at the storage layer, arriving through a list instead of a URL — and every ref it wrote
 * would name an owner the render is not for, so it would abort anyway.
 */
export function listUserFonts(): UserFontRecord[] {
  const ownerId = getCurrentUserId();
  if (!ownerId) return [];
  return readRegistry().filter((record) => record.ownerId === ownerId);
}

/** The blob-store id for a font's bytes. Namespaced so it cannot collide with a media asset id. */
function blobId(ownerId: string, fileHash: string): string {
  return `font_${ownerId}_${fileHash}`;
}

/** Local bytes for a pinned user font, or `null` if this device does not have them (→ needs-relink). */
export async function readLocalUserFont(ownerId: string, fileHash: string): Promise<Blob | null> {
  const store = await getAssetBlobStore();
  return store.getBlob(blobId(ownerId, fileHash));
}

export class UserFontError extends Error {
  readonly code: FontIngestError["code"] | "not-signed-in" | "upload-failed";
  constructor(code: UserFontError["code"], message: string) {
    super(message);
    this.name = "UserFontError";
    this.code = code;
  }
}

/**
 * Ingest one uploaded file: decompress, parse, hash, store on-device.
 *
 * Returns the record AND the `FontRef` a layer would pin. Deliberately does not touch the network —
 * D5's local-first rule — so a user with no connection can still use their own font in the editor.
 */
export async function addUserFont(file: File): Promise<{ record: UserFontRecord; ref: FontRef; identity: FontIdentity }> {
  const ownerId = getCurrentUserId();
  // D4: `ownerId` is not optional and has no default. Without one there is no key to write and no
  // account to serve it back to, so this refuses rather than inventing a placeholder owner.
  if (!ownerId) throw new UserFontError("not-signed-in", "Sign in to add your own fonts — a font is stored against your account.");

  const uploaded = await file.arrayBuffer();

  /**
   * **WOFF2 is decompressed on the SERVER, and this is a measured limitation rather than a choice.**
   *
   * Everything else here is local-first (D5) and stays that way: `.ttf`, `.otf` and `.woff` are
   * parsed, hashed and stored on-device with no network at all — opentype.js inflates `.woff`
   * natively, verified against a real one. WOFF2 is the exception because it needs Brotli plus
   * table-reconstruction, and the only decoder available is an emscripten build that takes its Node
   * branch in a browser (`require("fs")`) and hangs instead of resolving. Measured with a real
   * WOFF2 in a real Chrome, not assumed — and it is why this is a round trip rather than a call.
   *
   * The consequence is stated plainly to the user by the error below: adding a `.woff2` needs a
   * connection. Converting it to `.ttf` needs none.
   */
  if (isWoff2(uploaded)) return addUserFontViaServer(file, ownerId);

  // Everything from here is `.ttf`/`.otf`/`.woff`, which need no decompression at all — opentype.js
  // inflates WOFF natively. Nothing on this path can reach the emscripten decoder, which is exactly
  // the point: it does not run in a browser and is not in the bundle.
  const bytes = uploaded;
  let identity: FontIdentity;
  try {
    identity = await readFontIdentity(bytes);
  } catch (error) {
    // The ingest error's own message is already written for a person to read (D2) — it says what is
    // wrong with the file, not what threw. Passed through rather than replaced.
    if (error instanceof FontIngestError) throw new UserFontError(error.code, error.message);
    throw error;
  }

  const fileHash = await computeFontFileHash(bytes);
  const store = await getAssetBlobStore();
  await store.put(blobId(ownerId, fileHash), new Blob([bytes], { type: "font/ttf" }), { userId: ownerId });

  const record: UserFontRecord = {
    fileHash,
    family: identity.family,
    subfamily: identity.subfamily,
    weight: identity.weight,
    style: identity.style,
    ownerId,
    fileName: file.name,
    cloud: false,
    addedAt: new Date().toISOString()
  };
  // Re-uploading the same face is idempotent: same bytes, same hash, same record. The registry is
  // keyed on (owner, hash) rather than appended to, so a user who drags the file in twice gets one
  // entry rather than a duplicate that pins the identical file.
  const others = readRegistry().filter((entry) => !(entry.ownerId === ownerId && entry.fileHash === fileHash));
  const existing = readRegistry().find((entry) => entry.ownerId === ownerId && entry.fileHash === fileHash);
  writeRegistry([...others, { ...record, cloud: existing?.cloud ?? false }]);

  return { record, ref: userFontRef(record), identity };
}

function isWoff2(bytes: ArrayBuffer): boolean {
  const head = new Uint8Array(bytes, 0, Math.min(4, bytes.byteLength));
  return head.length === 4 && head[0] === 0x77 && head[1] === 0x4f && head[2] === 0x46 && head[3] === 0x32;
}

/**
 * The WOFF2 path: the server decompresses, parses, hashes and stores, and answers with the ref.
 *
 * The bytes are then pulled back down and cached locally, so that after one online add the font
 * behaves exactly like a locally-ingested one — same OPFS key, same offline availability. The upload
 * is not "opt-in" here in the way {@link publishUserFont} is, and that difference is real rather
 * than an oversight: we cannot read this format without the server, so there is no local-only state
 * for it to be in. A user who wants their brand font to stay on their machine converts it first.
 */
async function addUserFontViaServer(file: File, ownerId: string): Promise<{ record: UserFontRecord; ref: FontRef; identity: FontIdentity }> {
  const form = new FormData();
  form.append("file", file, file.name);
  let ref: FontRef;
  try {
    ({ ref } = await apiRequest<{ ref: FontRef }>("/fonts/user", { method: "POST", body: form }));
  } catch (error) {
    throw new UserFontError(
      "upload-failed",
      `WOFF2 fonts are decompressed on the server, so adding one needs a connection — or convert it to .ttf first. (${
        error instanceof Error ? error.message : "upload failed"
      })`
    );
  }
  if (ref.source !== "user") throw new UserFontError("upload-failed", "The server did not return a per-user font reference.");

  // Pull the stored (decompressed) bytes back for the local cache, so the font works offline from
  // here on. A failure is not fatal: the ref is valid and the server can serve it.
  try {
    const token = localStorage.getItem("orreris_token");
    const base = (import.meta.env?.VITE_API_URL as string | undefined)?.replace(/\/api\/?$/, "") ?? "http://localhost:4100";
    const response = await fetch(`${base}/storage/fonts/user/${ref.ownerId}/${ref.fileHash}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    });
    if (response.ok) {
      const store = await getAssetBlobStore();
      await store.put(blobId(ownerId, ref.fileHash), await response.blob(), { userId: ownerId });
    }
  } catch {
    // Local cache is an optimisation here; the ref already resolves through the server.
  }

  const record: UserFontRecord = {
    fileHash: ref.fileHash,
    family: ref.family,
    subfamily: ref.style === "italic" ? "Italic" : "Regular",
    weight: ref.weight,
    style: ref.style,
    ownerId,
    fileName: file.name,
    cloud: true,
    addedAt: new Date().toISOString()
  };
  writeRegistry([...readRegistry().filter((entry) => !(entry.ownerId === ownerId && entry.fileHash === ref.fileHash)), record]);
  return {
    record,
    ref,
    identity: { family: ref.family, subfamily: record.subfamily, weight: ref.weight, style: ref.style, postScriptName: undefined, license: undefined }
  };
}

/** The `FontRef` a layer pins for an uploaded font. `ownerId` travels with it (D4). */
export function userFontRef(record: UserFontRecord): FontRef {
  return {
    source: "user",
    family: record.family,
    weight: record.weight,
    style: record.style,
    fileHash: record.fileHash,
    ownerId: record.ownerId
  };
}

/**
 * Opt-in cloud upload. **Records a pairing; it does not remap anything** (D5).
 *
 * The project already references the font by `(ownerId, fileHash)`. Sending the bytes up does not
 * change a single reference — it changes whether the server can answer for them, which is what makes
 * a cloud render and a second machine possible. That is exactly the asset doctrine's "one asset, two
 * locations", and the reason this is a separate, explicit action rather than a side effect of adding
 * a font: uploading someone's licensed font to a server is their decision to make.
 */
export async function publishUserFont(fileHash: string): Promise<void> {
  const ownerId = getCurrentUserId();
  if (!ownerId) throw new UserFontError("not-signed-in", "Sign in to upload a font.");
  const blob = await readLocalUserFont(ownerId, fileHash);
  if (!blob) throw new UserFontError("upload-failed", "This font's bytes are no longer on this device. Re-add the file first.");

  const form = new FormData();
  form.append("file", blob, `${fileHash}.ttf`);
  try {
    await apiRequest<{ ref: FontRef }>("/fonts/user", { method: "POST", body: form });
  } catch (error) {
    throw new UserFontError("upload-failed", error instanceof Error ? error.message : "Could not upload this font.");
  }
  writeRegistry(readRegistry().map((entry) => (entry.ownerId === ownerId && entry.fileHash === fileHash ? { ...entry, cloud: true } : entry)));
}

/** Forget a font locally. Does not delete server bytes — that is a separate, owned decision. */
export async function removeUserFont(fileHash: string): Promise<void> {
  const ownerId = getCurrentUserId();
  if (!ownerId) return;
  const store = await getAssetBlobStore();
  await store.remove(blobId(ownerId, fileHash));
  writeRegistry(readRegistry().filter((entry) => !(entry.ownerId === ownerId && entry.fileHash === fileHash)));
}
