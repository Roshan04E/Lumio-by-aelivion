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

## Alternatives considered

- **Open taxonomy, add kinds freely.** Rejected: the switch becomes a feature dump; drift returns.
- **Even smaller set (primitives + custom only).** Rejected: pushes real cross-system structure
  (vector, transform, reference) into bespoke `custom` nodes, losing keyframing/validation/AI reuse.

## Consequences

- The high-leverage growth surface is the **field envelope** (unit, binding, validate,
  visibleWhen, help), not the kind list.
- Interpolability is a declared property of the kind, not a per-field flag.
- Recorded verbatim in project memory (`propertyfield-schema-doctrine`) as a permanent rule.
