# ADR-001 — Foundation Freeze

- Status: Stable
- Date adopted: 2026-07-23

## Context

Over several weeks the core UI/architecture layers (theme, property system, inspector
rendering, timeline actions, Flarex node format) stabilized and gained multiple adopters. The
risk shifted from "not enough structure" to "structure churning under its own weight" — each
new feature tempting a refactor of the very layers meant to make features cheap. The team
decided the architecture should stop being the work and start paying dividends.

## Decision

Declare a **foundation freeze**. The following are frozen — changes require a demonstrable
architectural flaw, documented in a new ADR, not a preference or a speculative generalization:

**Stable (frozen):**
- Theme system (see ADR-006)
- PropertyField taxonomy + promotion rule (ADR-003)
- PropertyFieldList renderer (ADR-002)
- Inspector adapter pattern (ADR-005)
- Timeline action system

**Provisional (NOT frozen — freeze only after a production feature proves them):**
- PropertySchema (ADR-004) — designed, not yet implemented; zero adopters
- Flarex Node Definition format (ADR-007) — Phase 2 node types not yet landed

Engineering effort shifts from infrastructure to **capability**, next milestone being the
Flarex evaluation engine.

## Alternatives considered

- **Freeze everything, including the provisional two.** Rejected: freezing a design with no
  adopters (PropertySchema) or a format that hasn't absorbed its remaining node types (Flarex)
  is the exact over-generalization the freeze exists to prevent.
- **Freeze nothing, keep evolving organically.** Rejected: the observed failure mode was
  drift/duplication (three parallel inspector dispatch sites), which an explicit freeze + reuse
  scorecard directly counters.

## Consequences

- New features are measured by a **reuse scorecard**: did this need a new control, a new
  property kind, or a renderer change? Default "no"; a "yes" requires an ADR.
- Provisional items carry an explicit **freeze trigger** (first real adopter survives unchanged).
- Refactoring a frozen layer is no longer free — it costs an ADR and a flaw demonstration.
