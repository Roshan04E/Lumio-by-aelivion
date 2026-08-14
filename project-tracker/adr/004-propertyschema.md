# ADR-004 — PropertySchema

- Status: Provisional
- Date adopted: 2026-07-23 (design accepted; implementation deferred)

## Context

`PropertyField[]` describes the properties of one object but carries no description of the
**object itself** — its identity, version, grouping, documentation, or how old serialized data
migrates forward. Consumers beyond the inspector (AI editing, search/command palette,
copy-paste, presets, migration, localization) each need that object-level metadata and would
otherwise reinvent it.

## Decision

Introduce `PropertySchema` as the canonical description of an editable object:
`{ id, version, metadata, groups, fields[], migrations, documentation }`. It is **inert,
serializable metadata** — no React, no domain logic. Adapters (ADR-005) produce it; consumers
read it.

Design commitments:
- **Groups are metadata, not UI** — a stable grouping id per field; the inspector chooses layout.
  Single-level only (no nesting) until a real need appears.
- **Migrations are generic and append-only** — `renameField`/`splitField`/`mergeFields`/
  `changeDefault`/`deprecateField`/`setKind`, each a pure `(values, ctx) → values`, run at load
  time before adapters/renderers, applied identically to project data, presets, and clipboard
  (all `{schemaId, version, values}`).
- **Presetability is described by the schema; presets are separate data.**
- **Documentation is metadata only** — name/description/tooltip/examples/help/AI-hint(synonyms).
- **Localization uses stable ids, never localized strings.**
- **The schema is versioned independently of the UI.**

Recommended **minimal** first cut before any freeze (from the design self-critique): ship
`{ id, version, metadata, groups(flat), fields[], migrations, documentation }`; fold `defaults`
into a computed accessor, fold `presetable` into a field-envelope flag, defer an `x`/extension
namespace until a real feature needs it.

## Alternatives considered

- **Keep passing bare `PropertyField[]` everywhere.** Rejected: object identity, versioning, and
  migration have nowhere to live; every consumer improvises.
- **Full schema with defaults/presetable/extensions/nested-groups now.** Rejected as premature —
  unnecessary surface area frozen before a single adopter validates it.

## Consequences

- **Status is Provisional by design.** Freeze trigger: the first non-trivial adapter (Tracker,
  or an audio effect) builds against it and ships without forcing a section change. Until then,
  do not evolve it speculatively (ADR-001).
- Migrations being data-shaped (not code branches) is what lets old projects/presets/clipboard
  load safely as the taxonomy grows.

## First adopter — 2026-08-14 (ADR-023 S4, `text-style`)

Implemented in `packages/shared/src/property-schema.ts`, exactly the minimal cut recommended above.
**The Decision section needed no change to accommodate it**, which is half of what the freeze trigger
asks for. Status stays **Provisional** on the other half: the trigger names a *second, unrelated*
system (Tracker or an audio effect), and one adopter cannot show the shape generalizes. Text was also
the easiest possible first case — a flat bag of scalars with no nesting pressure — so the parts most
likely to be wrong (nested groups, `list`/`transform` fields, cross-field validation) remain untested.
Freeze when the second adapter lands.

What the first adopter exercised, and what it did not:

- **Exercised:** `{id, version, metadata, groups(flat), fields[], migrations, documentation}`; the
  `{schemaId, version, values}` envelope shared by project data, clipboard and (S6) presets;
  `presetable` as a field-envelope flag; `defaults` as a computed accessor. All four minimal-cut
  recommendations held.
- **Two additions to the FIELD envelope, not to the schema** — the growth surface this ADR predicted.
  `absenceIsMeaningful` marks a field where "no key" is permanent state rather than shorthand for the
  default (ADR-023 D1a: `fontRef`, `direction`, `strokePaintOrder`), so nothing — a migration
  included — may fill it in. `animatableAs` names the keyframe track. Metadata evolved; taxonomy did
  not.
- **Not exercised:** four of the six migration operations. `renameField` and `deprecateField` are
  implemented because they are what a v1→v2 needs in order not to lose data; `splitField`,
  `mergeFields`, `changeDefault` and `setKind` are deliberately absent under the standing directive
  against dormant infrastructure. The runner's switch is exhaustive, so adding one is a compile error
  until it is handled.
- **A finding for the eventual freeze.** This ADR says migrations run "at load time before
  adapters/renderers". The implementation additionally REFUSES two cases rather than best-effort
  coercing them: a foreign `schemaId`, and a version newer than the build's. Loading part of a payload
  silently is worse than declining it, because the user cannot see which part went missing. If that
  posture is right generally, it belongs in the Decision section at freeze time.
