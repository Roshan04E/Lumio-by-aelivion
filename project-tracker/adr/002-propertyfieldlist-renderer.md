# ADR-002 — PropertyFieldList: the sole schema-driven renderer

- Status: Stable
- Date adopted: 2026-07-23 (documenting a decision in force since the inspector unification)

## Context

The repo had drifted toward per-system inspector panels, each re-implementing the same
"param → control" dispatch: `FrameEffectCard` (frame params), `EditableFieldPanel`,
`JunctionTransitionPopover`, and the Flarex inspector each switched on their own param type and
picked their own control. Every new editable surface risked a fourth, fifth, sixth copy —
divergent keyframe affordances, divergent reset behavior, divergent styling.

## Decision

`apps/web/src/editor/inspector/PropertyFieldList.tsx` is the **one** schema-driven property
renderer. It switches on `PropertyField.kind` **alone** — never on the object the field came
from — and delegates every widget to the shared controls (`NumberControl`, `EffectSliderControl`,
`PropertyRowGroup`, `BooleanControl`, `SelectControl`/`ThemedSelect`, `ColorControl`,
`PropertyRow`). It contains no domain logic and no markup beyond that delegation.

Any editable surface becomes a consumer by writing an **adapter** that translates its domain
model into `PropertyField[]` (ADR-005). The escape hatches `control` (adapter-supplied control
cell in the shared row) and `custom` (fully bespoke node) absorb genuinely singular editors
without forking the renderer.

## Alternatives considered

- **Per-system panels (status quo ante).** Rejected: N copies of the dispatch, guaranteed drift.
- **A React context / render-prop registry per control type.** Rejected: heavier, and the
  `kind` switch is already the minimal expression of "data shape picks the editor."

## Consequences

- Keyframe affordance, reset semantics, and the 24px grid are defined once and inherited.
- Deleting an adapter removes only a translation; every widget still lives in the shared controls.
- **Known incomplete convergence:** `FrameEffectCard` still has its own `param.type` dispatch
  (number/boolean/color/select). It is the reference example of the debt this ADR closes and a
  candidate for migration onto an adapter — tracked, not yet done.
- A new `kind` branch or a fourth renderer is a **reuse-scorecard event** (ADR-001/ADR-003), not
  a routine change.
