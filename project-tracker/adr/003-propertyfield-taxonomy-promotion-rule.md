# ADR-003 — PropertyField Taxonomy & Promotion Rule

- Status: Stable
- Date adopted: 2026-07-23

## Context

Once one renderer owns all inspectors (ADR-002), the pressure moves to its vocabulary: every
new system (Tracker, Particles, Camera, Audio, Export) wants "just one more kind." Unchecked,
the `kind` union becomes a per-feature dumping ground and the renderer's switch grows without
bound — reintroducing the drift ADR-002 removed, one branch at a time.

A Tracker-inspector thought experiment (14 properties) confirmed the risk: 11 of 14 mapped to
existing kinds; only region/asset properties lacked a home, and those wanted **generic** kinds
(rect/asset), never a Tracker-specific one.

## Decision

**The taxonomy is intentionally conservative.** A new `PropertyField` kind may be added ONLY if
all four hold:

1. genuinely distinct **data shape**,
2. requires a distinct **canonical editor**,
3. requires distinct **validation and/or keyframe semantics**,
4. needed by **at least two unrelated systems**.

Otherwise, extend **metadata** on an existing kind. **Metadata evolves before taxonomy.**

Frozen set — **15 data kinds + 2 meta**:
- Primitive: `number` (with unit modifier), `boolean`, `text`, `enum`, `color` (space-tagged).
- Composite: `vector` (absorbs vec2/vec3/rect/dual-range via `semantic`), `transform`,
  `gradient`, `list`.
- Reference: `reference` (refType asset|clip|composition|layer|track|marker|effect|font,
  resolver-backed, serializes as id), `file`.
- Specialized: `curve`, `colorCurves`, `colorWheels`, `spline`.
- Meta escape hatches: `control`, `custom`.

Deliberately **NOT** kinds: time/angle (`number` + unit), lut (`reference` + `number`),
asset/clip/composition/font (`reference` refType), rect/vec2/vec3/dual-range (`vector` semantic).

> Note: the frozen taxonomy is the target API. The renderer today ships a subset
> (`number`/`vec2`/`boolean`/`enum`/`color`/`text`/`control`/`custom`); the remaining kinds are
> promoted on first genuine two-system demand, under the rule above.

## Renderer-subset promotion: `reference` — FIRED 2026-08-14

**The taxonomy is unchanged. No kind was added, and the four-part test above is not the governing
test for this.** The clause that fired is the note directly above: the renderer ships a subset of
the frozen set, and the remaining kinds are promoted "on first genuine two-system demand."

Two unrelated systems now hold `reference`-shaped pickers behind ADR-002's `custom`/`control`
escape hatch: **Flarex's asset picker**, and **text's font picker** (ADR-023 S4, `5cb1d4e`). ADR-023
S6's preset library would make a third. Both already *declare* `reference` correctly in their
schemas — `refType: "font"` and `refType: "asset"` are both named on line 33 — so the schemas are
right and the renderer cannot build what they declare.

This is precisely the drift ADR-002 exists to stop, arriving through the escape hatch rather than
through the kind union: two bespoke pickers, no shared validation, no shared keyframe or resolver
semantics. **Decision: implement `reference` in `PropertyFieldList`, resolver-backed, dispatching on
`refType`. Both existing pickers move onto it.** Recorded here rather than as an amendment because
nothing about the rule changed — the rule anticipated this and named the trigger in advance.

Worth stating for whoever reads this next: a kind being *frozen into the taxonomy* and a kind being
*buildable by the renderer* are two different states, and the gap between them is where escape-hatch
duplication accumulates silently. Check the subset note before concluding a promotion review is
needed.

**Built 2026-08-14 (ADR-023 S4b).** `reference` is now one of the kinds the renderer ships, resolver-
backed, dispatching on `refType`; both pickers are on it and neither is behind an escape hatch. The
renderer's subset is therefore `number`/`vec2`/`boolean`/`enum`/`color`/`text`/`reference`/`control`/
`custom`. Two findings worth carrying forward:

- **The refTypes wanted different resolvers, not different semantics.** Resolution, a named missing
  state and an empty state are identical for a font and an asset; only the browsing UI differs. Had
  the semantics diverged, that would have been evidence against a shared kind — the outcome this
  decision was explicitly prepared to hear.
- **Interpolability, being a property of the kind, is now enforced by the type**: the renderer's
  `reference` field has no `keyframe` member at all, and `propertyKindInterpolable` (in `shared`)
  states the rule for consumers that are not the inspector. A reference can still be *animated* by a
  hold track; that is a different mechanism and nothing should infer one from the other.

## Alternatives considered

- **Open taxonomy, add kinds freely.** Rejected: the switch becomes a feature dump; drift returns.
- **Even smaller set (primitives + custom only).** Rejected: pushes real cross-system structure
  (vector, transform, reference) into bespoke `custom` nodes, losing keyframing/validation/AI reuse.

## Consequences

- The high-leverage growth surface is the **field envelope** (unit, binding, validate,
  visibleWhen, help), not the kind list.
- Interpolability is a declared property of the kind, not a per-field flag.
- Recorded verbatim in project memory (`propertyfield-schema-doctrine`) as a permanent rule.
