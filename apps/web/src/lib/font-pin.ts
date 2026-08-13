/**
 * ADR-023 S2.6 — **pinning a font, from the editor's side.**
 *
 * The picker lists ~1900 families we do not hold a byte of. Picking one has to turn that row into
 * stored bytes and a `FontRef` carrying the `fileHash` those bytes hash to — which is a round trip,
 * because the hash cannot be known until something has actually fetched the file (D1). This module
 * is that round trip, plus the state a list needs in order to show it happening.
 *
 * **Two paths, and the split is not an optimisation.**
 *  - A BUNDLED family (`font-catalogue.ts`) already has a known hash in the repo, verified against
 *    the file by `font:catalogue-test`. Pinning it is synchronous, offline, and touches no server.
 *  - Anything else goes to `POST /api/fonts/mirror`, which mirrors the face WITH its licence in one
 *    operation (T-11) and answers with the ref.
 *
 * **A failed pin writes nothing.** Not a system ref, not a half-filled catalogue ref, not the family
 * name as a CSS stack. The layer keeps the font it had and the row says what went wrong. The
 * alternative — falling back to a name-only stack because the mirror refused — is precisely the
 * silent substitution D1's hash exists to prevent, arriving through the UI instead of the renderer.
 */
import { catalogueFontRef, fontIndexFace, type FontRef } from "@orreris/shared";
import { apiRequest } from "./api";

export type PinState = { status: "resolving" } | { status: "failed"; message: string };

const states = new Map<string, PinState>();
const inFlight = new Map<string, Promise<FontRef | undefined>>();
const listeners = new Set<() => void>();
let version = 0;

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

export function subscribeFontPins(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function fontPinVersion(): number {
  return version;
}

export function fontPinState(family: string): PinState | undefined {
  return states.get(family);
}

export function clearFontPinState(family: string): void {
  if (states.delete(family)) notify();
}

/**
 * Pin a family at a weight/style, mirroring it first if we do not already hold it.
 *
 * Resolves to the ref to write, or `undefined` if it could not be pinned — in which case
 * `fontPinState(family)` carries the reason for the row to show. Deliberately does NOT throw: a
 * picker row is not a place where an unhandled rejection helps anyone, and the failure has to be
 * visible in the list rather than in the console.
 *
 * Concurrent picks of the same family share one request. Without that, dragging through a list of
 * families would queue a mirror per row the pointer passed over.
 */
export function pinFont(family: string, weight = 400, style: "normal" | "italic" = "normal"): Promise<FontRef | undefined> {
  /**
   * The bundled fast path, and it must be EXACT (S2.7).
   *
   * `catalogueFontRef` resolves to the nearest bundled cut, which is right when the question is
   * "show me this family" and wrong when it is "give me the italic": we bundle Arimo 400 and 700
   * and no italics, so a nearest-match would hand back the roman under an italic request and the
   * layer would claim a cut it does not have. An inexact match falls through to the mirror, which
   * can fetch the real one.
   */
  const bundled = catalogueFontRef(family, weight, style);
  if (bundled && bundled.weight === weight && bundled.style === style) return Promise.resolve(bundled);

  const key = `${family}|${weight}|${style}`;
  const existing = inFlight.get(key);
  if (existing) return existing;

  states.set(family, { status: "resolving" });
  notify();

  const request = (async (): Promise<FontRef | undefined> => {
    try {
      const face = fontIndexFace(family, weight, style);
      const data = await apiRequest<{ ref: FontRef; fetched: boolean }>("/fonts/mirror", {
        method: "POST",
        body: JSON.stringify({ family, weight: face?.weight ?? weight, style: face?.style ?? style })
      });
      // Trust the server's ref over anything reassembled here: it is the side that hashed the bytes.
      // A client that rebuilt the ref from its own idea of the weight could pin a hash to the wrong
      // face description, and the manifest would then describe a font it does not contain.
      if (!data?.ref || data.ref.source !== "catalogue" || !data.ref.fileHash) {
        throw new Error("The server answered without a pinned font reference.");
      }
      states.delete(family);
      notify();
      return data.ref;
    } catch (error) {
      states.set(family, { status: "failed", message: error instanceof Error ? error.message : "Could not add this font." });
      notify();
      return undefined;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, request);
  return request;
}
