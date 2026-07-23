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
