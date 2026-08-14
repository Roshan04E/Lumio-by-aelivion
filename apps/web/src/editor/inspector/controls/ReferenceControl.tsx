/**
 * ADR-003's `reference` kind, renderer side — the resolver contract every reference field shares, and
 * the canonical editor for `refType: "asset"`.
 *
 * ## What is shared, and what is not
 *
 * A reference is an **id plus a resolver**. The id is what serializes (ADR-003: "resolver-backed,
 * serializes as id"); the resolver is what turns it back into something a human can see. Those two
 * facts are the same for a font, an asset, a composition or a preset, and they are what this file
 * owns:
 *
 *  - **Resolution.** `resolveReference` is the ONE place an id becomes a label. Adapters supply a
 *    resolver; they never hand the renderer a pre-computed label, because a label computed by the
 *    adapter is a label that can silently disagree with what the id actually points at.
 *  - **Validation.** Resolvability is the validation semantics of the kind. An id that resolves to
 *    nothing is `missing`, named the same way everywhere, rather than each picker inventing its own
 *    presentation for a dangling id (which is what the two pre-S4b pickers did).
 *  - **Emptiness.** "No reference" is a first-class state distinct from "a reference that is broken",
 *    and every refType gets to name it (`Host clip`, `None`) instead of showing a blank.
 *
 * What is NOT shared is the browsing experience, and deliberately so: picking a font is a searchable
 * 1,900-family list, picking an asset is a "click a tile in the media pool" mode. That is the axis
 * `refType` dispatches on. Different resolvers and different browsers over identical semantics is
 * consolidation working; if two refTypes ever wanted different *semantics*, that would be evidence
 * against a shared kind and worth saying out loud rather than absorbing.
 *
 * INTERPOLABILITY IS NOT DECLARED HERE. It is declared on the kind, in `propertyKindInterpolable`
 * (ADR-003, Consequences). The renderer's `reference` field carries no `keyframe` member at all, so
 * the rule is enforced by the type rather than by everyone remembering it.
 */

import type { ReactNode } from "react";
import { PropertyRow } from "./PropertyRow";

/** What an id points at, once resolved. */
export interface ResolvedReference {
  /** What the row shows. */
  label: string;
  /** The id resolves to nothing this build holds — a dangling reference, shown as such. */
  missing: boolean;
  thumbnailUrl?: string | undefined;
  /** A short chip beside the name ("VID", "pinned"). */
  badge?: string | undefined;
  /** Tooltip detail; falls back to the label. */
  title?: string | undefined;
}

/** id → what it points at, or `null` when nothing in the project answers to that id. */
export type ReferenceResolver = (refId: string) => ResolvedReference | null;

/**
 * The shared resolution step: empty → the refType's own "nothing referenced" wording; unresolvable →
 * a named missing state carrying the id, so a broken project says WHICH reference broke.
 */
export function resolveReference(refId: string, resolve: ReferenceResolver, emptyLabel: string): ResolvedReference {
  if (!refId) return { label: emptyLabel, missing: false };
  return resolve(refId) ?? { label: `(missing: ${refId})`, missing: true };
}

/**
 * `refType: "asset"` — the canonical asset-reference editor (was `flarex/FlarexSourcePicker`, moved
 * here in S4b because a shared renderer may not import a domain folder; the widget was never
 * Flarex-specific, only Flarex-located).
 *
 * The Fusion Loader model: a trigger showing the current source that puts the REAL media pool into
 * "pick one" mode — the flow the user already knows from the timeline's "Replace asset" — rather than
 * an embedded list that can drift from the pool's actual contents. A small "×" clears the reference.
 *
 * The DOM and the `flarex-source-*` class names are carried over unchanged. Renaming them would be a
 * pure-cosmetic diff on a stage whose entire claim is that nothing moved, and the CSS is self-
 * contained (`global.css`); it can be renamed on a commit that has something to show for it.
 */
export function AssetReferenceControl({
  label,
  icon,
  className,
  refId,
  resolved,
  onBrowse,
  onClear,
  onInspect,
  onReset
}: {
  label: string;
  icon?: ReactNode | undefined;
  className?: string | undefined;
  refId: string;
  resolved: ResolvedReference;
  /** Open the media pool in pick-one mode (omit to disable, e.g. a host with no pool wiring). */
  onBrowse?: (() => void) | undefined;
  onClear: () => void;
  /** Open the Source Viewer (proxy vs original A/B) for the referenced asset. */
  onInspect?: ((refId: string) => void) | undefined;
  onReset?: (() => void) | undefined;
}) {
  return (
    <PropertyRow
      label={label}
      icon={icon}
      className={className}
      onReset={onReset}
      control={
        <div className="flarex-source-row">
          <button
            type="button"
            className="flarex-source-trigger"
            title={onBrowse ? `${resolved.label} — click to pick from the media pool` : resolved.label}
            disabled={!onBrowse}
            onClick={() => onBrowse?.()}
          >
            {resolved.thumbnailUrl ? (
              <img className="flarex-source-thumb" src={resolved.thumbnailUrl} alt="" />
            ) : (
              <span className="flarex-source-thumb flarex-source-thumb--host" aria-hidden />
            )}
            <span className="flarex-source-name">{resolved.label}</span>
            {resolved.badge ? <span className="flarex-source-badge">{resolved.badge}</span> : null}
          </button>
          {refId && onInspect ? (
            <button
              type="button"
              className="flarex-source-clear"
              title="Inspect source — play proxy vs original"
              aria-label="Inspect source"
              onClick={() => onInspect(refId)}
            >
              ⧉
            </button>
          ) : null}
          {refId ? (
            <button type="button" className="flarex-source-clear" title="Revert to host clip" aria-label="Revert to host clip" onClick={onClear}>
              ×
            </button>
          ) : null}
        </div>
      }
    />
  );
}
