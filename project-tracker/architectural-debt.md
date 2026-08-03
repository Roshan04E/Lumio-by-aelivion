# Architectural Debt Register

Append-only. Governed by `FLAREX_IMPLEMENTATION_GOVERNANCE.md` §6.

**No undocumented debt.** A compromise without an entry here is a merge blocker. Every unexplained
special case in the pre-ADR-012 runtime was once an undocumented compromise that outlived its reason.

**Expiry is a condition, never a date.** "When S4.5 lands" is valid; "Q4" is not. When the planned
slice ships, an entry is either **retired** (naming the PR that retired it) or **re-justified** with a
new expiry condition and explicit sign-off. It may not silently persist.

**Debt may not be extended by a PR that is not paying it down.** The Detection field exists so a
reviewer can notice when a change is deepening a compromise rather than resolving it.

Entries are never rewritten. To change one, append a new dated note under it.

---

## Format

```
### DEBT-NNN — <one-line title>
- Status: open | retired (<PR>)
- Registered: YYYY-MM-DD (<slice that created it>)
- Reason: the CONSTRAINT that made the compromise necessary — not the symptom
- Invariant affected: I-NN (violated | partially satisfied)
- Owner: <name>
- Expiry condition: the observable condition that retires this
- Planned slice: SN.N
- Tracking issue: <link>
- Detection: how a reviewer notices this debt is being EXTENDED rather than paid
```

---

## Open

### DEBT-001 — Admission reports denials while the host-clip fallback still substitutes
- Status: open
- Registered: 2026-08-01 (pre-registered for S4.3)
- Reason: source admission must exist and be observable before the fallback can be deleted safely — deleting the substitution first would leave scarcity resolving to nothing with no ranking to decide who gets the budget.
- Invariant affected: I-27 (violated)
- Owner: unassigned
- Expiry condition: `kernel:conform` pending check `[S4.5] an unresolved asset MediaIn yields the HOST clip's pixels` stops reproducing
- Planned slice: S4.5 — must ship in the same release as S4.3
- Tracking issue: —
- Detection: any new call path that reaches `resolveSourceDraw`'s host-substitution branch, or any new fallback that yields pixels from a different source
- **Update (2026-08-03, S4.5 shipped as `a2da2e4`):** this entry's premise was too broad and the slice
  inherited the error. "The host-clip fallback" is not one construct: three causes reach that `return`,
  and only `host-substituted:pending` is a substitution under I-27 — the node has a loader, that loader
  owns the pixels, and they are late. `no-loader` and `no-resolver` mean no loader was ever promoted, so
  the host clip **is** that node's source; drawing it is the Phase-1 contract, not a stand-in. The first
  cut of S4.5 withheld all three and failed 11 flarex fixtures at up to 76.9%, on frames the present
  ledger reported fully settled — the degradation channel named `:no-loader` on every one and `:pending`
  on none. So the debt as written pointed at a superset of the violation.
  Debt remains **open**, with the expiry condition unchanged in words but different in meaning: the
  pending check still reproduces because it exercises the flag-OFF default, so retirement is now gated on
  `kernelCoherenceUnified` defaulting ON (evidence, per R7), not on the slice having merged. The
  `no-loader` path is NOT debt and will never be retired — conformance pins it via the predicate
  `substituting = resolved === "pending"` rather than via the gate, because the gate keeps passing if
  someone widens the predicate, which is precisely how this was written wrong the first time.

### DEBT-002 — Kernel owns state but presentation still gates reclamation
- Status: open
- Registered: 2026-08-01 (pre-registered for S3.1–S3.4)
- Reason: cache and resource ownership moves to the kernel before the reclamation policy is rewritten; splitting them would mean rewriting eviction twice.
- Invariant affected: I-21 (partially satisfied)
- Owner: unassigned
- Expiry condition: no prune, dispose, or acquire remains behind a present-path branch
- Planned slice: S5.3
- Tracking issue: —
- Detection: a new prune or TTL counted in presented frames rather than wall-clock milliseconds (regression G7)

### DEBT-003 — Resources accounted but not owned
- Status: open
- Registered: 2026-08-01 (pre-registered for S5.1)
- Reason: the Resource Manager lands observe-only first so the accounting can be validated against the measured ~1 GB texture accumulation before it is given authority to evict.
- Invariant affected: I-8 (violated)
- Owner: unassigned
- Expiry condition: no subsystem allocates or frees a tracked GPU resource except through the Resource Manager
- Planned slice: S5.2
- Tracking issue: —
- Detection: a new allocation site added outside the Resource Manager while it is still observe-only

### DEBT-004 — Cache identity is correct but there are no cross-frame records to exploit it
- Status: open
- Registered: 2026-08-01 (pre-registered for S6.2)
- Reason: correcting cache identity (the time axis, the browser/worker asymmetry) must land before evaluation records, or the records would be built on a key that collides.
- Invariant affected: none — performance only
- Owner: unassigned
- Expiry condition: node evaluation records survive across frames
- Planned slice: S6.4
- Tracking issue: —
- Detection: a per-frame memo being taught to persist ad hoc rather than moving to the record store

### DEBT-005 — Settle-window backstop retained behind explicit frame completion
- Status: open
- Registered: 2026-08-01 (pre-registered for S2.2)
- Reason: five consumers currently infer readiness from the 600 ms settle window. Removing it in the same slice that introduces explicit completion would silently strand any consumer that was missed; the backstop stays and LOGS when it fires, so reliance is visible rather than fatal.
- Invariant affected: I-31 (partially satisfied)
- Owner: unassigned
- Expiry condition: the backstop records zero firings across a full soak in steady state
- Planned slice: S2.2 (retirement), enforced by S7.1
- Tracking issue: —
- Detection: a new consumer waiting on the settle window instead of `FrameComplete`
- **Update (2026-08-01, S2.2 shipped):** the expiry condition is now MEASURABLE rather than aspirational, and it turned out to need two counters, not one. `settle-backstop-expired` is the debt's own condition — the window ran out while the picture had still not settled, so the viewer stopped compositing on an unfinished frame. `settle-window-load-bearing` is the stricter one that gates the FLAG: a composite that was not settled inside a window nothing had re-armed, i.e. a repaint that only the timer caught because some producer arrives without announcing itself. Both must read zero across a real soak before `orreris.kernelFrames` may default on; a non-zero `load-bearing` count names a producer to fix rather than a reason to keep the timer. Retirement is therefore gated on evidence from `__rfKernel.events("transition")`, not on the slice having merged. Debt remains **open** by design: S2.2 built the instrument and the switch, and deliberately did not flip it.

### DEBT-006 — Materialization threshold carried from the ADR-008-violating implementation
- Status: open
- Registered: 2026-08-01 (pre-registered for S6.3)
- Reason: `MATERIALIZE_MIN_PASSES = 2` was measured against a `materialize()` that WRAPS a second group rather than tagging the existing one, so the threshold encodes the cost of the violation. It cannot be carried forward as if it were a property of the design.
- Invariant affected: ADR-008 rule 2 (violated)
- Owner: unassigned
- Expiry condition: the threshold is re-derived by `flarex:perf` measurement against the tagging implementation
- Planned slice: S6.3
- Tracking issue: —
- Detection: any tuning of the threshold that does not cite a fresh `flarex:perf` run
- **Update (2026-08-03, S6.3 shipped) — RETIRED.** Re-derived against the tagging implementation; the number is unchanged at 2 and its justification is entirely replaced. First finding: the constant was **unfalsifiable by the existing suite**. Thresholds 1 and 2 differ on exactly one input — a shared subtree costing exactly 1 pass — and no scenario produced one (`shared-expensive` sits far above, `fanout-8` shares a bare MediaIn whose draw is not a group at all, cost 0). Both values gave byte-identical behaviour on all seven scenarios, so the original "re-measure it" expiry condition could not have been met without new scenarios. Two were added (`shared-cheap-1x8`, `shared-cheap-retimed-1x8`). On the favourable shape threshold 1 wins (p50 0.70→0.30ms, 31.6MB); on the retimed shape it costs p95 2.70→**12.30ms**, 253.1MB and 389 evictions per 60 frames, because materialization there dedupes nothing. Kept at 2 on the tail, which is what drops frames. The old rationale (it prices the wrap) is dead; the live rationale is that it backstops context-blind fanout counting — see DEBT-007.

### DEBT-007 — `fanout` counts graph edges, not evaluation contexts
- Status: open
- Registered: 2026-08-03 (discovered during S6.3's threshold re-derivation)
- Reason: `shouldMaterialize` gates on `fanout > 1`, computed from the edge graph. When consumers sit behind different retimes the shared node is evaluated once per consumer at its own time — correctly, since collapsing those evaluations is the stale hit ADR-009 calls unforgivable — so it is sealed once per branch and dedupes nothing. Every render target is allocated and none is shared. The measured cost on `shared-cheap-retimed-1x8` at threshold 1 is p95 2.70→12.30ms with 253.1MB and 389 evictions per 60 frames; at threshold 2 the shape is simply excluded, which is a backstop rather than a fix.
- Invariant affected: ADR-010 §3 (the materialization decision is meant to be cost-driven; a cost model fed a wrong fanout is wrong regardless of the threshold)
- Owner: unassigned
- Expiry condition: `fanout` counts distinct evaluation contexts, and `shared-cheap-retimed-1x8` shows no eviction churn with the threshold lowered to 1
- Planned slice: candidate S6.5 (dependency tracking is what makes evaluation contexts enumerable)
- Tracking issue: —
- Detection: `shared-cheap-retimed-1x8` reporting `promo` > 1 for a single shared node
- Note: pre-existing and NOT introduced by S6.3 — it already applies to any retimed fan-out at cost ≥ 2. S6.3 only made it visible, by being the first slice to have a scenario that could see it.

---

## Retired

*(none yet — DEBT-006 is marked retired in place above, pending the S6.3 commit landing)*
