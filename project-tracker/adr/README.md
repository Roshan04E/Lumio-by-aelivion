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
- **Status vocabulary:** `Stable` / `Frozen` (change only for a demonstrable architectural flaw),
  `Provisional` (accepted but not yet proven by a production feature — will freeze or fall),
  `Superseded by ADR-NNN`, `Deprecated`. Frozen normative ADRs carry a dependency header
  (`Depends on:` / `Supersedes:` / `Implemented by:`) so the authoritative document is obvious.
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
- [ADR-008 — Flarex Evaluation Engine (content-addressed materialization substrate)](008-flarex-evaluation-engine.md) — Frozen
- [ADR-009 — Content Version Contract (completeness rules)](009-content-version-contract.md) — Frozen (§1–3 normative; §4–8 superseded by ADR-010)
- [ADR-010 — Node Capability Contract (the evaluator foundation)](010-node-capability-contract.md) — Frozen
- [ADR-011 — Evaluation Context Transform (the fourth evaluator question)](011-evaluation-context-transform.md) — Provisional (extends ADR-010 §5 by ONE question)
- [ADR-012 — Flarex Runtime Kernel & Evaluation Engine Specification](012-flarex-runtime-kernel.md) — **Accepted** (governing spec; amends ADR-007 §soft-degrade, §dirty-key, §view-dot)
- [ADR-013 — Media Acquisition Scheduling & the Performance Governor](013-media-acquisition-scheduling.md) — **Accepted** (extends ADR-012 Part 3/4/12 by two subsystems, contracts C15–C18, invariants I-40…I-54; changes no existing clause)
- [ADR-014 — Experience Stream Architecture](014-experience-stream.md) — **Accepted** (E1–E14; the ORIS history substrate: append-only, envelope/payload, producer≠kind, provenance outranks retention)
- [ADR-015 — Decision Evidence Schema](015-decision-evidence.md) — **Accepted** (D1–D10; what one AI decision preserves about itself — situation, facts, owner, claim, candidates; beliefs deliberately excluded)
- [ADR-016 — Evidence Integrity](016-evidence-integrity.md) — **Accepted** (I1–I14; when a record may be trusted: per-field admission, sequence over clocks, retained policies, quarantine-by-derivation, observation coverage, verifiers must prove they ran)
- [ADR-017 — User-Action Observation](017-user-action-observation.md) — **Accepted** (U1–U12; the editor producer: outcomes are never recorded, the seam is the composition write choke point, one gesture = one transaction, initiation and operation identity are declared not inferred)
