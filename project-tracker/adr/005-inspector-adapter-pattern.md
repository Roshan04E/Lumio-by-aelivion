# ADR-005 — Inspector Adapter Pattern

- Status: Stable
- Date adopted: 2026-07-23 (documenting a decision in force since the Flarex inspector)

## Context

Given one renderer (ADR-002) and one taxonomy (ADR-003), each domain (timeline clip effects,
Flarex nodes, frames, transitions) still needs a way to expose its own model without either
teaching the renderer about that model or forking the renderer.

## Decision

Each domain provides an **adapter**: a pure function translating its domain model + current
values + write/keyframe handlers into `PropertyField[]` (and, under ADR-004, a `PropertySchema`).
The reference implementation is the Flarex node-graph adapter
(`apps/web/src/editor/flarex/flarex-inspector-fields.tsx`). Renderers never contain
domain-specific logic; adapters never render.

The boundary is: **adapter = domain → schema; renderer = schema → widgets.** An inspector is
then just "run the adapter, hand the result to PropertyFieldList, add shared layout chrome."

## Alternatives considered

- **Renderer reads domain models directly (branch per source).** Rejected: reintroduces the
  per-system dispatch ADR-002 removed.
- **Domains render their own controls, sharing only styling.** Rejected: divergent keyframe/reset
  behavior, the pre-unification failure mode.

## Consequences

- Adapters are unit-testable pure functions (no DOM).
- The same adapter output feeds AI editing, search, and copy/paste — not just the visible panel.
- Reaching for `control`/`custom` (ADR-002) is legal for a truly singular editor; if the same
  `custom` recurs in a second system, that triggers the ADR-003 promotion review.
- **Pre-existing debt:** Flarex's asset picker is currently smuggled through the `control` escape
  hatch (no `reference`/asset kind yet) — the canonical example of a `custom`/`control` that ADR-003
  would promote once a second system needs it.
- **That second system has now arrived — 2026-08-14 (ADR-023 S4).** The text-style adapter's font
  picker is a `reference` field (refType `font`, per ADR-003's explicit "font is a reference refType,
  not a kind") bridged through the escape hatch for the same reason: the renderer ships no `reference`
  branch. Two unrelated systems now hold reference-shaped pickers behind `control`/`custom`, which is
  the recurrence this section says triggers an **ADR-003 promotion review** — the four-part test looks
  satisfiable (distinct shape: an id + a resolver; distinct editor: a picker; distinct validation:
  resolvability; two unrelated systems: Flarex assets, text fonts). **Recorded, not acted on.**
  Promoting a kind is a doctrine decision under ADR-003, not something a stage may take, and S4
  deliberately added none. The review is owed a decision before a third instance appears.
- **Decided and built — 2026-08-14 (ADR-023 S4b).** Two corrections to the paragraph above, which
  should be read as the reasoning of the day rather than as the rule. First, **the four-part test was
  never the governing test here**: `reference` was already inside ADR-003's frozen fifteen, with
  `font` and `asset` named as refTypes, so nothing was promoted *into* the taxonomy. What fired was
  ADR-003's renderer-subset clause — the renderer ships a subset, the rest arrive on first genuine
  two-system demand — and reaching for the promotion test was the trap ADR-003's own note now warns
  about. Second, the debt is **cleared**: `PropertyFieldList` builds `reference`, and both the Flarex
  asset picker and the text font picker are fields rather than escape hatches. The asset widget moved
  to `inspector/controls/ReferenceControl` — a renderer may not import a domain folder, and the
  widget was only ever Flarex-*located*.
