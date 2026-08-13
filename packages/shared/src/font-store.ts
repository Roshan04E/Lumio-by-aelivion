/**
 * ADR-023 D4 / T-3 — **the two font stores are two types, and that is a licensing invariant.**
 *
 * The shared mirror holds OFL/Apache catalogue faces, deduplicated across all users, because those
 * licenses permit redistribution. The per-user store holds fonts a user licensed personally; two
 * users who upload byte-identical copies of the same commercial font get two objects, and the
 * storage waste is the *point* — the duplicate is what makes the isolation structural.
 *
 * **This is deliberately not a boolean on one store.** A flag is a thing an optimisation can read as
 * "these rows have the same hash, collapse them", and content-addressed storage's whole instinct is
 * to collapse equal hashes. That collapse, on a commercial font, redistributes a licence the user
 * bought and we did not.
 *
 * So the encoding, in the manner of `input-transform.ts:60-85`: `CatalogueFontKey` and `UserFontKey`
 * have **no common supertype carrying a resolvable location**. There is no `FontKey` interface with
 * a `key: string` field to program against. A function that wants bytes must accept the union and
 * discriminate on `store`, or it does not compile — which is what makes T-3 enforced rather than
 * merely written down.
 *
 * > If a future reader is tempted to merge these for storage efficiency: the saving is measured in
 * > gigabytes and the exposure is measured in lawsuits. ADR-023 D4 exists so that the merge has to
 * > be argued against a written decision instead of discovered as clever.
 */
import type { FontRef } from "./fonts";

/** A face in the shared mirror. Serveable to anyone; that is what the licence permits. */
export interface CatalogueFontKey {
  readonly store: "catalogue";
  readonly fileHash: string;
}

/**
 * A face in a user's private store. `ownerId` is not optional and has no default (D4) — a user font
 * with no owner is not resolvable for anybody, and a default would be an owner nobody chose.
 */
export interface UserFontKey {
  readonly store: "user";
  readonly fileHash: string;
  readonly ownerId: string;
}

/**
 * The union a resolver must accept. Note there is deliberately no shared base interface: this type
 * can be *consumed* only by discriminating, and cannot be *constructed* generically.
 */
export type FontStoreKey = CatalogueFontKey | UserFontKey;

/**
 * The storage-relative object key. The one place either layout is written down.
 *
 * Exhaustive by construction: adding a third store makes this function fail to compile rather than
 * silently return a catalogue path for it.
 */
export function fontObjectKey(key: FontStoreKey): string {
  switch (key.store) {
    case "catalogue":
      return `fonts/catalogue/${key.fileHash}`;
    case "user":
      return `fonts/user/${key.ownerId}/${key.fileHash}`;
    default: {
      const unreachable: never = key;
      return unreachable;
    }
  }
}

/**
 * T-11 — the license object that must exist alongside every mirrored font. Derived from the font
 * key so the two can never be given different hashes by a caller passing them separately.
 */
export function fontLicenseObjectKey(key: CatalogueFontKey): string {
  return `${fontObjectKey(key)}.LICENSE.txt`;
}

/**
 * The store key a `FontRef` points at, or `undefined` for a legacy `{ source: "system" }` ref, which
 * points at no stored bytes at all — it names a platform font.
 *
 * `undefined` is meaningful here rather than an error: a system ref is a perfectly valid thing for a
 * layer to hold (D1a), it simply has nothing to install.
 */
export function fontStoreKeyFor(ref: FontRef): FontStoreKey | undefined {
  switch (ref.source) {
    case "catalogue":
      return { store: "catalogue", fileHash: ref.fileHash };
    case "user":
      return { store: "user", fileHash: ref.fileHash, ownerId: ref.ownerId };
    case "system":
      return undefined;
    default: {
      const unreachable: never = ref;
      return unreachable;
    }
  }
}

/**
 * Whether `viewerId` may be served the bytes behind `key`.
 *
 * Catalogue faces are public by licence. A user face is served to its owner and to nobody else —
 * including a viewer who somehow knows the hash, which is exactly the attack content-addressed
 * storage invites. Deliberately a total function over the union rather than a check the caller may
 * forget: `resolveFontBytes` in the worker takes its result, not a boolean the caller computed.
 */
export function canServeFont(key: FontStoreKey, viewerId: string | undefined): boolean {
  switch (key.store) {
    case "catalogue":
      return true;
    case "user":
      return Boolean(viewerId) && viewerId === key.ownerId;
    default: {
      const unreachable: never = key;
      return unreachable;
    }
  }
}
