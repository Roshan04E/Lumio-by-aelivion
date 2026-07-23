<!--
  Default PR template. For Flarex evaluation-engine work (Slice 2+), the architecture is
  FROZEN in project-tracker/adr/008,009,010. Reviews measure implementation against the
  contract — they do not reopen it. See plans/flarex-evaluation-engine.md.
-->

## What & why

<!-- One paragraph: what this change does and which slice / issue it advances. -->

## Review checklist

Architecture is not on this list — it is settled in the ADRs. Answer these three:

1. **Contract compliance** — Does this satisfy ADR-008/009/010 exactly? If it deviates, is that
   an implementation bug to fix, or does it reveal a genuinely missing evaluator *question*
   (see Architectural impact below)?
2. **Correctness** — Does it preserve the invariants (ADR-009 R1–R3; ADR-010 §1–12)? Which gates
   prove them, and are those gates in this PR?
3. **Performance** — Is this the simplest implementation that satisfies the contracts?

## Architectural impact

Reopening a frozen ADR must be a deliberate event, never an accident of coding. Tick one:

- [ ] **No new evaluator question introduced.** This implements the contract as written.
- [ ] **Introduces a new evaluator question — ADR-010 must be revisited before merge.**

If the second box is ticked, the evaluator must ask something it cannot ask today (a new decision,
not a new answerer). State it precisely — a new dependency provider, context axis, artifact kind,
or execution trait is *not* a new question and does not belong here:

> New evaluator question:
> ______________________________________________

## Gates run

<!-- e.g. `render:compare:pixels` result (pixel floor?), cache hit == cold recompute byte-check,
     pnpm typecheck. Paste numbers, not "passes". -->
