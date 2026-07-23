# Architecture Decision Records (ADR)

Governance log for **structural** decisions on Orreris Pro — the ones a future contributor
(human or AI) could otherwise "clean up" without knowing why the shape is deliberate.

This is distinct from the sibling `project-tracker/*.md` problem/solution logs (append-only,
per-category incident history). An ADR captures **one durable decision**: the problem, the
decision, what was rejected, the consequences, and whether it is Stable or Provisional.

## Rules

- **Append-only.** Never rewrite an accepted ADR. To change a decision, add a new ADR that
  supersedes it and set the old one's status to `Superseded by ADR-NNN`.
- **One decision per file.** `NNN-kebab-title.md`.
- **Status vocabulary:** `Stable` (frozen — change only for a demonstrable architectural flaw),
  `Provisional` (accepted but not yet proven by a production feature — will freeze or fall),
  `Superseded by ADR-NNN`, `Deprecated`.
- **Reuse scorecard.** A change that adds a new inspector control, a new `PropertyField` kind,
  or a renderer branch must cite the ADR it satisfies — or add one. Default answer is "no new
  primitive"; a "yes" is a reviewable event, not a routine one.

## Template

```
# ADR-NNN — Title

- Status: Stable | Provisional | Superseded by ADR-NNN
- Date adopted: YYYY-MM-DD

## Context
## Decision
## Alternatives considered
## Consequences
```

## Index

- [ADR-001 — Foundation Freeze](001-foundation-freeze.md) — Stable
- [ADR-002 — PropertyFieldList: the sole schema-driven renderer](002-propertyfieldlist-renderer.md) — Stable
- [ADR-003 — PropertyField Taxonomy & Promotion Rule](003-propertyfield-taxonomy-promotion-rule.md) — Stable
- [ADR-004 — PropertySchema](004-propertyschema.md) — Provisional
- [ADR-005 — Inspector Adapter Pattern](005-inspector-adapter-pattern.md) — Stable
- [ADR-006 — Theme Accent Doctrine](006-theme-accent-doctrine.md) — Stable
- [ADR-007 — Flarex Compiler Contract (lowering to SceneDraw)](007-flarex-compiler-contract.md) — Stable
