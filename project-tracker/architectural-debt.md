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
- Status: **RETIRED 2026-08-05** (see the S7.2 update at the end of this entry)
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
- **Update (2026-08-05, S7.2 complete) — RETIRED, and the expiry condition was never satisfiable.**
  The condition reads "the `[S4.5]` pending check stops reproducing". It cannot. That check calls
  `compileFlarexComp` with `resolveSourceDraw: () => null`, so `resolved === null` — the **`no-loader`**
  branch, which this same entry (2026-08-03) records as *not debt and never to be retired*. The gate was
  aimed at the legitimate Phase-1 contract, not at the violation. An expiry condition that cannot fire is
  not a gate, it is a permanent entry wearing one, and it would have kept this open forever.
  Retired instead on **structural** evidence, which is stronger than the flag default the 2026-08-03
  update proposed. The I-27 violation was `host-substituted:pending` — a node whose loader owns the
  pixels showing the host's instead. Since `366860c` (S7.2 family 5) the compiler refuses it
  unconditionally (`if (substituting) return null;`), `allowHostSubstitution` is gone from
  `FlarexLowerCtx` and from `build-scene-draws`, and **I-34 is now an enforced conformance assertion**
  that the refusal is unconditional AND that the opt-out appears nowhere in the file. There is no
  configuration in which the violation can occur, and a permanent test fails if one is reintroduced.
  Note the earlier gate is also now unevaluable for a second reason: it was phrased as
  "`kernelCoherenceUnified` defaulting ON", and that flag no longer exists.
  **`no-loader` / `no-resolver` remain correct behaviour and are not tracked here.** The `pending()`
  check keeps reproducing and should stay — it is a live witness that the legitimate path still works —
  but it is **mis-named** for what it now guards. Renaming it to say `no-loader` explicitly is a
  loose end, recorded under DEBT-008.

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
- **Update (2026-08-05) — still open, and now with a user-visible cost.** S3.4 gave reclamation a
  wall-clock sweep and S7.2 family 5 deleted the coherence hold that the live prune sat behind, so the
  *presented-frame TTL* half of this entry is satisfied. The *present-path branch* half is not, and the
  black-MediaIn investigation found the reason it matters: `pruneDepartedSceneResources` treats a source
  that is **absent from `liveMediaSourceIds` this frame** as **departed**, disposes it, and calls
  `forgetResources`. A loader whose graded media simply was not consumed on one frame — because a
  `comp.version` bump missed the source-draw cache and forced a rebuild — is destroyed and re-registered
  the next frame, generation +1, and any handle held across the gap resolves `handle-missing` → null
  texture → the node draws nothing. Measured as a climbing generation (1→2→3) against
  `comp.version` 41→46 with identical node and edge sets. That is *presentation policy changing resource
  lifetime* (I-24) reached through the prune, which is exactly what this entry predicted.
  **Do not retire on the wall-clock evidence alone.** The remaining condition is specifically: *absent
  this frame* must stop meaning *departed*. Retirement needs a soak, because the set-difference prune is
  load-bearing for VRAM reclamation and loosening it is the failure mode S3.4 was written against.

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
- **Update (2026-08-05) — open, evidence not gathered.** S5.2 (`0fe9f43`/`13776e0`) gave handles
  generations and S3.4 moved ownership to `kernel/resource-manager.ts`, so the *accounting* half is
  done. The expiry condition is stronger than that — *no subsystem allocates or frees a tracked GPU
  resource except through the Resource Manager* — and that is an exhaustive-audit claim nobody has made.
  Do not retire it by association with the slices. **Owed work:** enumerate GL allocation/dispose sites
  and show each one routes through the manager, or name the exceptions. Note this entry is adjacent to
  DEBT-002's live defect: the prune disposing a still-declared source is a lifetime decision, and
  whether it counts as "through the Resource Manager" is exactly the question this audit must answer.

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
- **Update (2026-08-05) — open, one measurement from retirement.** The expiry condition is "node
  evaluation records survive across frames". S6.4 (`b5452cd`) shipped records deliberately **write-only**
  — reading one back then returned draws whose textures could belong to disposed pool entries, and reuse
  was assigned to S6.5. S6.5 (`93ce78b`) and S6.6 (`f7abb92`) have since shipped and the incremental
  evaluator is host-wired (`cdc8142`), so cross-frame reuse should now be real. **Owed work:** show a
  clean node reusing a record from a previous frame — a `flarex:perf` run where evaluation count is
  below node count on an unchanged graph would do it. That single number retires this entry.

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
- **Update (2026-08-05, S7.2 complete) — OPEN, and its gate was crossed without the evidence.**
  This entry states the condition plainly: *both counters must read zero across a real soak before
  `orreris.kernelFrames` may default on.* S7.2 family 4 (`15d615b`) **deleted that flag**, which makes
  explicit frame completion unconditionally on — the state the gate was protecting — and **the soak
  evidence was never collected.** The S7.2 soaks measured decoder topology (`detaches`, `capMisses`,
  `blindSplits`); they never sampled `settle-backstop-expired` or `settle-window-load-bearing`. Removing
  a flag is not the same act as flipping its default, but it has the same consequence for a gate written
  in terms of the default, and the programme did not notice the difference. Recorded as a process
  finding, not just a debt note: **a flag deletion inherits every precondition attached to that flag's
  default, and S7.2 had no step that checked for them.**
  The backstop itself is still present and still instrumented
  (`ScenePreviewCanvas.tsx`, `reason: "settle-backstop-expired"`), so nothing is lost — the evidence is
  simply owed. **Owed work:** one soak reading `__rfKernel.events("transition")` for both counters. If
  they are zero the timer can go and this retires; if `load-bearing` is non-zero it names a producer
  that arrives without announcing itself, which is a defect to fix rather than a reason to keep a timer.
  Until then the settle window stays.

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
- **Update (2026-08-05) — open, and now ACTIONABLE for the first time.** The planned slice condition
  ("candidate S6.5 — dependency tracking is what makes evaluation contexts enumerable") is satisfied:
  S6.5 (`93ce78b`) and S6.6 (`f7abb92`) both shipped. The blocker was never the threshold, it was that
  contexts could not be enumerated; they can now. **Owed work:** re-derive `fanout` against distinct
  evaluation contexts and re-run `shared-cheap-retimed-1x8` at threshold 1. Until that runs,
  `MATERIALIZE_MIN_PASSES` stays at **2** — it is the backstop for this entry, and lowering it without
  fixing `fanout` first reproduces p95 2.70→12.30ms and 389 evictions per 60 frames.

### DEBT-008 — the `[S4.5]` pending check is mis-named for what it now guards
- Status: open
- Registered: 2026-08-05 (discovered auditing DEBT-001 at S7.2 close)
- Reason: the check reads "an unresolved asset MediaIn yields the HOST clip's pixels" and is registered
  as `pending("S4.5", …)`, i.e. as *a known violation the migration has not reached yet*. It is neither.
  It calls `resolveSourceDraw: () => null`, so it exercises the **`no-loader`** branch, where the host
  clip genuinely IS the node's source and drawing it is the Phase-1 contract. The assertion is correct
  and should keep passing forever; only its name and its `pending` tier are wrong.
- Invariant affected: none — the runtime is correct; this is a harness-honesty defect
- Owner: unassigned
- Expiry condition: the check is renamed to say `no-loader` explicitly and moved from `pending` to
  `enforced`, so the ratchet stops advertising a violation that no longer exists
- Planned slice: none — housekeeping, safe to do whenever `kernel-conformance.ts` is free
- Tracking issue: —
- Detection: any reader concluding from `pending("S4.5")` that I-27 is still violated. It is not — see
  DEBT-001's retirement note and enforced invariant I-34.
- Cost of leaving it: a `pending()` entry is a standing claim that the migration is unfinished. This one
  can never stop reproducing, so it will misinform every future audit exactly as it misinformed
  DEBT-001's expiry condition.

---

## Retired

- **DEBT-001** — retired 2026-08-05 in place above. The I-27 host-clip substitution for `pending` is
  structurally impossible since `366860c` and is pinned by enforced invariant I-34. Its original expiry
  condition was unsatisfiable (it watched the `no-loader` path, which is correct behaviour); see
  DEBT-008 for the harness tidy-up that remains.
- **DEBT-006** — retired 2026-08-03 in place above; the S6.3 commit (`b5452cd`) has landed. The
  threshold stays at 2 on a replaced justification: it now backstops DEBT-007's context-blind `fanout`.
