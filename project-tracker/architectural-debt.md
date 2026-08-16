# Architectural Debt Register

Append-only. Governed by `FLAREX_IMPLEMENTATION_GOVERNANCE.md` §6.

**No undocumented debt.** A compromise without an entry here is a merge blocker. Every unexplained
special case in the pre-ADR-012 runtime was once an undocumented compromise that outlived its reason.

**Expiry is a condition, never a date.** "When S4.5 lands" is valid; "Q4" is not. When the planned
slice ships, an entry is either **retired** (naming the PR that retired it) or **re-justified** with a
new expiry condition and explicit sign-off. It may not silently persist.

**Debt may not be extended by a PR that is not paying it down.** The Detection field exists so a
reviewer can notice when a change is deepening a compromise rather than resolving it.

The problem/solution body is never rewritten; to change it, append a new dated note under it.

**`Status` and `Expiry condition` are current state, not history (see `README.md`, "State fields
vs. history").** Edit them in place when the truth changes, and add one line to the body noting
what the field said before and when it changed — append-only covers that correction the same way
it covers everything else. A `Status:` line that contradicts the entry's own latest update is not
open, retired, or parked — it is simply wrong, and costs a full read to discover.

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
- **Update (2026-08-05) — the mechanism half is FIXED; the retention evidence is PARTIAL, do not close.**
  `51abcac` makes a mounted Flarex loader live even on a frame nobody sampled it (mount, not
  consumption, is the liveness proof), and `82275b8` closes the descriptor-gap path that served without
  touching. Founder-confirmed on their own comp. First ledger reading, from the latch acceptance run:
  `LONGPLAY 15s` and `LONGIDLE 15s` both `resources 3→3 · media-renderer 2→2 · reclaimed 0 ·
  handleFailures 0`, `scopes[live:2 permanent:1]`. Flat — encouraging, and **not** sufficient: 15s arms
  on a **3-resource** fixture is not the long session this entry needs, and two of the changes
  (declared-retention, the `permanent` scope) make the runtime retain MORE in the subsystem whose
  runaway growth was ADR-012's original amplifier. **Owed: a long session on a real comp, reading
  `resourceLedger` total/byKind.**
  **READER TRAP, recorded because it will mislead at 2am.** In that same run `oldestIdleMs` reads
  **52-68s** — which looks exactly like a frozen-clock leak and is not one. The scope census explains
  it: the only non-live record is the `permanent` compositor sentinel, which is never touched *by
  design*. **Read `byScope` before concluding anything from `oldestIdleMs`.** A frozen clock and a
  correctly-permanent record are indistinguishable in the aggregate number alone.

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
- **Update (2026-08-05) — AUDIT DONE. Still open, but the claim is now enumerated instead of unexamined.**
  The expiry condition is an exhaustive claim nobody had ever tested. Tested now.
  **What the Manager actually owns:** 7 `registerResource`/`forgetResource` sites across **4** files —
  `ScenePreviewCanvas.tsx` (grade, media, flarex-proxy), `viewerProxyCapture.ts`,
  `export/scene-frame-compositor.ts`, `playback/scene-resource-orchestration.ts`. Note the altitude:
  the Manager tracks *records* (a renderer, a target) and never a GL object, per I-36 — so counting
  `gl.createTexture` sites against it is a category error. The 10 allocation sites in
  `packages/shared/src/color/*` are internals of renderers that ARE tracked, and are not exceptions.
  **Owners of GL that dispose OUTSIDE the Manager — the real answer, 6 files, in two classes:**
  - *Not GPU records at all, correctly out of scope:* `preview-frame-pool.ts` (disposes decoder
    **providers**; lifetime belongs to the Decoder Manager, ADR-012 3.11) and `sourceProxyEngine.ts`
    (disposes an **encoder** and a provider). Different subsystems, different owners. Not debt.
  - *Component-owned GL, and this IS the gap:* `TransitionLayer.tsx` (a transition **compositor**),
    `WebglColorView.tsx` and `WebglVideoOverlay.tsx` (a webgl **applicator** each), and
    `WebglMediaLayer.tsx` (3 **renderer** disposals). Each is created and destroyed by a React effect
    cleanup, i.e. **its lifetime is a component unmount** — the precise coupling I-24 forbids and that
    S3.3 removed for decoder sessions without ever removing it for these.
  **So the condition is NOT met, and now it is falsifiable.** Retirement requires those four
  component-owned owners to register (or a written argument that a viewer-local applicator is not a
  *tracked* resource — defensible for the overlay, much weaker for `TransitionLayer`'s compositor and
  `WebglMediaLayer`'s renderers, which are full render targets).
  **Detection sharpened by the audit:** the giveaway is a `.dispose()` inside a `useEffect` cleanup with
  no matching `forgetResource`. That is a one-line grep and should be the reviewer's check.
  **Scope note:** 82 `.dispose()` sites exist in `apps/web/src`; most are probe/stress pages
  (`ExportStressPage`, `GovernorStressPage`, `WcDecoderGatePage`, …) which are not production paths and
  are excluded deliberately — but if one of those is ever promoted to a real surface it inherits the
  same gap unexamined.

### DEBT-004 — Cache identity is correct but there are no cross-frame records to exploit it
- Status: **RETIRED 2026-08-05** (measured; see the closing update at the end of this entry)
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
- **Update (2026-08-05) — RETIRED on measurement.** `flarex:perf`, 12 frames, real GPU (ANGLE/AMD
  Radeon Vega 8, D3D11), `shared-expensive-6x8`: **`cache 179h/1m promo=1 evict=0 7.9MB`**.
  The discriminating number is the MISS COUNT, not the hit count. A cache that only deduplicated
  *within* a frame would miss once per frame — ~12 misses over this run, one per frame, each frame
  re-materializing. It missed **once in total**, materialized once (`promo=1`), and served 179 hits
  after that. The record therefore survived across frames, which is precisely this entry's expiry
  condition. Evictions zero, so nothing was rebuilt behind the hits.
  **Read the other eight scenarios correctly before concluding anything from them:** all report
  `promo=0` and the harness's own `cache INERT` note. That is not a broken cache, it is
  `MATERIALIZE_MIN_PASSES = 2` excluding comps below the threshold by design — confirmed by dropping the
  threshold to 1, at which point `shared-cheap-1x8` immediately materializes (`179h/1m promo=1`). An
  inert scenario proves nothing about this debt either way; `shared-expensive-6x8` is the only one that
  can answer it.

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
- **Update (2026-08-05) — the owed soak RAN. Debt stays open, and the gate is not evaluable on the
  blank-project fixture.** Gate committed as `pnpm --filter @orreris/worker settle:soak`.
  Two runs, both against a blank project + one clip, `kernelDiagnostics` on:
  - **Run 1** (20 scrub/play/pause cycles): `settle-backstop-expired` **1**, `load-bearing` 0,
    `surplus` 0. Non-zero, so the condition is not met as measured — though a backstop firing mid-scrub
    is arguably the window doing its job, not debt, which is why run 2 measured steady state instead.
  - **Run 2** (same gestures, then a 15s QUIET TAIL, counting only the delta): every settle counter 0 —
    but so was `surplus`, i.e. **no settle signal of any kind**. VOID by its own guard.
  **Why the fixture cannot answer this.** `frame-held` dominates both runs — 1185 of 1186 transition
  events in run 1's gesture phase, 207 in run 2's 15s quiet tail alone. The settle-window classifier is
  reached from the draw path, and a held frame does not get there. On a fixture that holds essentially
  every paused frame, the window is unreachable, so zero means *not measured*.
  **Corrected witness, for whoever runs this next.** My first guard used `surplus` as proof the
  classifier ran; that is wrong — a run can enter the window and never waste a composite. Any non-zero
  settle signal witnesses reachability, and `settle-backstop-expired` firing in run 1 is what proved the
  window exists at all. The gate now encodes that.
  **Owed work, restated:** re-run against a fixture whose picture actually SETTLES while paused — the
  same acceptance-surface lesson as DEBT-009, where a lone `MediaIn→MediaOut` structurally could not
  exhibit the reported symptom. A real comp on the founder's project is the surface. Until then S7.2's
  gate-crossing stands unremedied and the settle window stays.

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
- **Update (2026-08-05) — RE-CONFIRMED on the current build, and my earlier scoping of it was wrong.**
  I recorded this as "one measurement". It is not: the expiry condition has two clauses, and the first
  (*`fanout` counts distinct evaluation contexts*) is **implementation work**, not a reading. Only the
  second clause is measurable, and measuring it first is still worth doing because it says whether the
  backstop is still earning its place. It is. Threshold temporarily set to 1, `flarex:perf` 12 frames,
  real GPU:
  - `shared-cheap-1x8` (the favourable shape): `179h/1m promo=1 evict=0 31.6MB` — threshold 1 **wins**
    here, which is why this is a genuine trade and not an obvious call.
  - `shared-cheap-retimed-1x8` (the counterweight): `72h/**109m** promo=9 **evict=101** **253.1MB**`.
  253.1MB matches the originally registered figure exactly, and 101 evictions in 12 frames is the same
  rate as the registered 389 per 60. **The defect reproduces unchanged on the post-S7.2 build**, so the
  threshold-2 backstop stays and DEBT-006's replaced justification still holds. Threshold reverted.
  **Owed work, restated correctly:** make `fanout` count evaluation contexts (S6.5 made them
  enumerable), THEN re-run the pair — clause two is the acceptance for clause one, not a substitute.

### DEBT-010 — the node-thumbnail cache key omits ADR-009's ContextVersion
- Status: **RETIRED 2026-08-09** (see the closing update at the end of this entry)
- Registered: 2026-08-05 (surfaced by the DEBT-009 latch investigation)
- Reason: `flarex-node-thumbnails.ts` keys its cache on `NodeContentHash` alone
  (`:139-143`, `:169`), omitting the **ContextVersion** ADR-009 requires. A thumbnail captured before
  its source decodes is therefore cached under a key that cannot distinguish "this node's content" from
  "this node's content, at a moment when nothing had arrived yet", so the stale capture is never
  invalidated.
- Invariant affected: ADR-009 completeness rules (cache identity must include the evaluation context)
- Owner: unassigned
- Expiry condition: the thumbnail key includes ContextVersion, and a thumbnail captured before decode is
  replaced once the source arrives
- Planned slice: none — should land BEFORE ADR-013 Phase 0's baseline, since thumbnails share the
  resource subsystem Phase 0 measures
- Tracking issue: —
- Detection: any new thumbnail cache path keyed on content identity without an evaluation-time axis
- **Update (2026-08-05) — PART 1 DONE, part 2 is a design decision and is deliberately not guessed.**
  ContractVersion is now folded into the key (`${FLAREX_CONTENT_HASH_CONTRACT_VERSION}:${contentHash}`).
  Two of ADR-009's three axes are present; bumping the hash contract no longer leaves every thumbnail
  on screen serving pixels computed under the old meaning.
  **ContextVersion remains absent, and that is the axis the defect needs.** It cannot be folded in from
  this module because there is no value to fold: `FlarexThumbnailPass` carries `hostLayerId`, `comp`,
  `timeSeconds`, `nodeIds` and a capture handle, and **none of them changes when media arrives**.
  Supplying one means deciding what "context" means for a thumbnail — most likely the decoded frame
  version of every source the node reads — and plumbing it from the viewer. Render dimensions, the
  usual other component, are constant here (`FLAREX_THUMB_W/H`), so they are not the answer.
  Left undone on purpose: **a wrong ContextVersion is worse than none**, because it would invalidate
  correct thumbnails every frame and turn the cache into a per-frame re-render.
  Reasoning recorded at the `entryKey` site so the next reader does not re-derive it.
- **Why it currently looks fixed, and why that is the dangerous part.** The visible symptom — node
  thumbnails showing the HOST clip — resolved as a *downstream consequence* of the DEBT-009 latch fix:
  the first render was capturing the host because the MediaIn was substituting the host. Remove the
  substitution and the capture is correct, so the bug disappears from view **without its cause being
  touched**. It resurfaces whenever a first render lands before decode — a large asset, a cold OPFS —
  which is rarer now but not gone. An entry exists precisely because "the symptom stopped" is the
  weakest possible evidence that a cache-identity defect is fixed.
- **Header updated 2026-08-13:** Status was "open (LATENT — the symptom is gone, the defect is
  not)" from registration. It should have flipped the day this update below landed; the register's
  old append-only-header convention left it stale for four days. See `README.md`, "State fields
  vs. history."
- **RETIRED (2026-08-09).** Fixed by sidestepping the ContextVersion question rather than answering it:
  readiness is an EVENT, not a state, so it does not need a version number — it needs the existing
  "not ready, try later" contract `SceneViewerCaptureHandle.renderFlarexNodeThumbnail` already had for
  three other cases (playing / no frame yet / host off-screen). Found the exact fallback site
  (`packages/shared/src/scene/build-scene-draws.ts:895-909`'s `resolveSourceDraw`, which returns
  `null` — not `"pending"` — for a MediaIn whose virtual layer hasn't been built yet, indistinguishable
  from a node with no source at all; `compile-flarex.ts:1826-1829`'s `previewRootNodeId` fallthrough
  then silently re-evaluates from MediaOut instead of respecting the requested root when that returns
  null; `build-scene-draws.ts:912`'s `return lowered ?? draw;` is where the host gets substituted, with
  no signal distinguishing "genuinely nothing to wait for" from "still loading"). Added a FOURTH
  not-ready case in `ScenePreviewCanvas.tsx`'s `renderIsolated`: a local `onFlarexDegrade` listener,
  scoped to `degradation.nodeId === rootNodeId`, flags a `"host-substituted:pending"` /
  `"source-pending-retimed"` degrade for the SPECIFIC requested node and returns `null` instead of
  compositing — no cache-key change, no ContextVersion, no new plumbing into
  `flarex-node-thumbnails.ts` at all.
  **The spin guard, verified not by reading the code but by injection**: `resolveSourceDraw` only ever
  returns this signal for a node that HAS a loader (`collectFlarexVirtualLayers` resolved its
  `sourceAssetId` to a real, existing asset) whose graded canvas hasn't landed — never for an empty
  `sourceAssetId` or a deleted/unresolvable one, both of which return a valid (non-null) host-draw
  image immediately and never reach this degrade branch. A MediaIn with no source assigned settled to
  zero further capture attempts across 10s of idle canvas, confirmed via a temporary console.log
  injection (reverted, proven clean via `git diff` + a token search) rather than asserted from reading
  the branch.
  **Acceptance, all three links, `git diff`-proven falsifiable**: (1) a MediaIn bound to a second asset
  showed its own picture ~1.4s after binding, no reload, while staying on the Flarex page throughout;
  (2) reverting the fix to git HEAD and repeating the identical steps reproduced the bug exactly —
  the host clip's picture persisted for 15+ seconds of continued interaction, never self-corrected;
  (3) an unbound MediaIn produced zero further render attempts once settled. All three measured on a
  real running editor via Playwright, not asserted from the diff.
  ContextVersion remains genuinely absent from `entryKey` for every other axis a thumbnail could in
  principle depend on — none are known to cause a real defect today, so this retires rather than
  expanding into "add ContextVersion for everything." See `flarex-node-thumbnails.ts`'s own docstring,
  rewritten in place, for the fuller account.

### DEBT-009 — a resource's liveness is inferred from a signal its consumer does not emit
- Status: open
- Registered: 2026-08-05 (third occurrence; registered as a CLASS, not as one bug)
- Reason: every reclaimer in the scene path proves liveness the same way — *the grade pass touched it
  this frame*. That is a sound proof for a timeline clip, whose pixels the grade pass really does
  consume. It is not sound for anything whose consumer is elsewhere, and the runtime now has two such
  consumers: the **Flarex compiler** (`resolveSourceDraw`) and the **compositor's own intra-call
  path**. When the proof does not apply, silence reads as death and the resource is reclaimed while
  still in use. **Three instances, two of them user-visible:**
  1. *2026-07-07* — a transiently source-less layer dropped from the draw list: "a black flicker on
     every ruler click" (11 flickers / 19s of scrubbing). Fixed by teaching the grade path to HOLD.
  2. *2026-08-05* — `scene-compositor/intra-call`, a module-load sentinel nothing ever touches, so
     `lastUsedAt` froze at load and the idle sweep reclaimed it after `RESOURCE_IDLE_MS`. Every
     intra-call texture then resolved null and a comp went black the moment a node needed a nested
     render. Fixed with a `permanent` scope.
  3. *2026-08-05* — `media/flarexsrc:*`: consumed through the compiler, therefore absent from
     `liveMediaSourceIds`, so the **departed prune** disposed it on every presented frame it was not
     sampled. Fixed by `declaredMediaSourceIds` retention (`51abcac`) — mount, not consumption, is the
     liveness proof for a loader. Second gap in the same resource, fixed at `82275b8`:
     `getMediaSingleCtx`'s **descriptor-missing branch serves the entry's last graded texture and
     returns before reaching `gradeMediaInContext`**, i.e. it serves WITHOUT touching. A remount plus a
     decode is not a sub-frame event, so that gap can outlast `RESOURCE_IDLE_MS` and the idle sweep
     then reclaims a resource that is on screen.
     - **CORRECTION (2026-08-05).** As first written this entry blamed the idle-sweep half on the media
       pool's only `touchResource` (`ScenePreviewCanvas.tsx:1298`) sitting in a grade loop "the loader
       never enters". **That is false and was inference, not measurement.** The loader does reach it:
       `getMediaGraded` → `getMediaSingleCtx` → `gradeMediaInContext` → the touch, on both the
       cache-hit path (`build-scene-draws.ts:985`) and the miss path (`buildLayerDraw:680`). Measured
       refutation: 15s LONGPLAY and 15s LONGIDLE arms — 3× the TTL — with `reclaimedTotal` 0,
       resources 3→3, media 2→2. A frozen `lastUsedAt` would have moved `reclaimedTotal` during
       LONGPLAY, when the viewer is certainly compositing. The *fix direction* (touch on the consumer's
       path, never a `permanent` exemption) was right; the *mechanism* was wrong, and it was corrected
       by the session holding the measurements rather than by the one holding the theory.
     - **The founder's ~10-20s hitch is a REAL report** (asked and confirmed verbatim: "yes,... around
       10-20 sec span") but its cause was never attributed: 30s spanning 3× the TTL did not reproduce a
       periodic hitch, and the mechanism first written here is refuted. It was deliberately NOT closed
       on probe evidence, because the fixture is a lone `MediaIn→MediaOut` — which renders this defect
       as *black* — while the founder's comp has the **merge topology** that renders it as *flashing the
       host*. The fixture structurally cannot exhibit the reported symptom.
     - **ACCEPTED on the founder's own comp (2026-08-05):** after `51abcac` + `82275b8` the periodic
       hitch is gone. That is the acceptance surface the fixtures could not reach. But the causal chain
       was **never completed, and must not be recorded as if it were.** A 30s run spanning three TTLs
       showed `reclaimedTotal` 0 throughout and zero handle failures — the hitch did not reproduce at
       all, so nothing here was ever shown to CAUSE it. The founder's own follow-up was "probably gone,
       I'm not seeing it in another MediaIn clip", which is weaker than a confirmed fix and should be
       read that way. **Instance 3 is closed on its LATCH symptoms** (black screen, host flicker, node
       thumbnails, mid-session bind — all founder-confirmed), **not on the periodic hitch.** If a
       periodic hitch returns it is an unattributed defect and should re-open here; the refuted
       `lastUsedAt`-frozen theory is recorded above so it is not tried a second time.
     - **Residual, separate, OPEN:** a single hitch of ~800ms-1s, no longer periodic. Long enough to
       need a cause. Prime suspect is startup rather than reclamation — decoder warmup, ingest-proxy
       arrival and first-frame acquisition all land in the first ~1.5s (`preview-budget-probe` discards
       `WARMUP_MS = 1_500` for exactly this reason), and a warmup stall is expected-shaped where a
       reclaim stall is not. **Discriminator, unmeasured:** does it occur at the START of each playback,
       or at a random point mid-play? Start ⇒ warmup, and belongs to ADR-013's acquisition scheduling.
       Mid-play ⇒ neither warmup nor this class, and needs its own hunt.
- Invariant affected: I-24 (presentation policy MUST NOT change resource lifetime) — reached through
  the reclaimer rather than through the acquirer, which is why the existing detection missed it
- Owner: unassigned
- Expiry condition: every reclaimer proves liveness from a signal its resource's **actual consumer**
  emits — i.e. no pool infers departure or idleness from a set populated by a pass that does not
  consume that resource
- Planned slice: none — instances 1–3 are fixed (`51abcac`, `82275b8`, `e6cf87c`). The entry stays
  **open** because the class is not closed by fixing its instances: the expiry condition is about every
  reclaimer, and instance 3's residual symptom is still unattributed (see the CORRECTION above).
- Tracking issue: —
- Detection: a resource registered in one subsystem and swept by another that keys on a set the first
  subsystem never writes to. Concretely: a `ScenePool` entry with no `touchResource` call on its own
  consumption path.
- **Instance 4 (2026-08-15) — OUTSIDE the scene pool, and it widens the class.** ADR-023 S6's contact
  sheet surfaced a pinned font rendering as a fallback in any composition with no media layer.
  `SceneTextRasterizer` drew and cached a text raster through a sync `ctx.font`, which substitutes
  silently, and the only thing invalidating a fallback raster was a `document.fonts` `loadingdone`
  listener bumping a version into the cache key — debounced 150ms. Whether the correct font reached
  the pixels therefore depended on whether something else in the frame outlasted the debounce; a media
  decode round-trip does, and text alone has nothing to lose the race to. **This is the same shape with
  no pool and no reclaimer in it:** correctness rested on a notification the consumer never asked for.
  Fixed the same way the other three were — on the consumer's path (`ensureOverlayFonts`, awaited
  inside `rasterize`), never by exempting anything. The listener stays as an optimization.
  **Detection widens accordingly:** not only "a resource swept by a subsystem that never writes to its
  set", but **any correctness that depends on a signal arriving before an unrelated deadline** — an
  event listener, a debounce, or a `ready` promise standing in for "the thing I am about to use is
  usable". If the consumer can ask directly, it must.
- **The fix for instance 3 is a touch on the compiler's consumption path, NOT an exemption.**
  `permanent` now exists and is the tempting one-liner; it is wrong here. A Flarex loader genuinely can
  depart, and an unreclaimable media resource is the VRAM leak S3.4 was written against — that trade
  converts a ~300ms hitch into the original ADR-012 amplifier. The retention must stay bounded; only
  the clock is wrong.
- Note: the two fixes shipped so far (HOLD, `permanent`) each corrected one instance without naming the
  class, which is why a third appeared. This entry exists so the fourth is caught by a rule.

### DEBT-008 — the `[S4.5]` pending check is mis-named for what it now guards
- Status: **RETIRED 2026-08-05** (see the closing update at the end of this entry)
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
- **Update (2026-08-05) — RETIRED, and there were TWO of them.** The `pending("S4.5", …)` call is now
  `enforced("I-27", "a NO-LOADER MediaIn draws the host clip — the host IS its source")`: same boolean,
  correct tier, and named for the cause it actually exercises.
  **Second instance found while fixing the first, one line down.** `enforced("I-34", "an UN-retimed
  pending substitutes the host, and says so")` has been untrue since S7.2 family 5 (`366860c`) made the
  refusal unconditional. It kept passing because it never looked at the draw — only at whether the
  REASON `host-substituted:pending` was reported. A name describing behaviour the runtime had stopped
  having, guarded by a check that could not notice. Renamed to "is REPORTED as
  host-substituted:pending"; the assertion itself is byte-identical.
  **Gap closed, not just renamed.** I-27's actual claim — a `pending` MediaIn yields absence, never
  another shot's pixels — had only a *structural* guard (I-34 greps the source for the unconditional
  refusal). Structural checks pass if the branch merely stops being reached. Added the behavioural
  half: `resolveSourceDraw: () => "pending"` must compile to `null`. **Falsifiability verified** — with
  the refusal disabled (`if (false && substituting)`) the new I-27 assertion FAILS alongside I-34,
  while the `no-loader` assertion correctly stays green, so the pair discriminates rather than
  co-firing.
  **Vocabulary drift, recorded and deliberately NOT fixed:** the reason string is still
  `host-substituted:pending` and the degradation record still sets `substituted: true`, for a case that
  no longer substitutes anything. It now means "the case that WOULD have substituted". Renaming it
  would break `__rfFlarexDegradation`, the probes, and the substitution census DEBT-001 was judged
  against — a wide blast radius to fix a word. Left as-is with the meaning written down; if it is ever
  renamed, `substitutedTotal` stops being comparable across that boundary.

### DEBT-011 — frame rate is not a valid comparand on a contended fixture
- Status: **open**
- Registered: 2026-08-05 (ADR-013 Phase 0 / M0)
- Reason: under contention the runtime has **no arbitration among `playhead` leases** (ADR-013 §1). Which sources hold WebCodecs sessions is decided by arrival order, so it varies run to run; the losers fall to the `<video>` element path. The sampled source's frame rate therefore reports **which lottery it won**, not what the change under test did.
- Invariant affected: I-40 (not yet implemented — this is the defect it exists to close)
- Owner: unassigned
- Expiry condition: identical arms on one contended fixture converge on the same routing across runs — see the acceptance criterion below
- Planned slice: ADR-013 3.25, Media Acquisition Scheduler
- Tracking issue: —
- Detection: any measurement, gate or acceptance argument that compares p50/p95 fps across arms on a fixture with more declared sources than the session budget, without also reporting `wcProvider %`

**The measured numbers, recorded so nobody re-derives them at the cost of a void run.** Four runs,
eight arms, six distinct sources against a four-slot budget, chrome channel, 14s sampled per arm:

- identical off-arms differ by **55–125%** p50 fps (29.9 vs 67.4; 66.9 vs 29.8);
- the split is **bistable** — one arm ~67fps, the other ~30fps, never intermediate;
- **which arm degrades alternates between runs** (run 1: arm A degraded; run 2: arm B degraded);
- the degraded arm is identifiable *only* from routing: `decode wc-hw/element`, `wcProvider 60–66%`,
  `stale 53–56%`, `unmet 1`. Its frame rate says nothing about the change under test;
- meanwhile every unconditional decoder counter is **identical** across all eight arms —
  `capMisses 10`, `created 11`, `blindSplits 1`. Contention counters are deterministic here; fps is not.

**The rule.** *On a fixture with more declared sources than the session budget, fps may not be used as a
comparand. Use `capMisses` and the other unconditional counters, and report `wcProvider %` alongside any
frame-rate figure so a reader can see which arms were even comparable.*

**Acceptance criterion for the slice that retires this — and it is not an fps improvement.** The defect
is *non-determinism of routing under contention*, so the test is convergence, not speed:

> Identical arms on the same contended fixture must resolve to the **same routing**, run to run.
> `wcProvider %`, `stale %` and `unmet` are the instruments. **A faster p50 with the lottery still
> running is not a pass.**

A scheduler could raise p50 by consistently favouring whichever source the probe happens to sample and
leave the arbitration defect entirely intact. This entry exists partly to make that argument unavailable.

**Update (2026-08-05, ADR-013 Phase 0 Stage 1) — the admission-side half of this entry, and it is the
same phenomenon rather than a related one.** Stage 1 measured the mechanism that draws the lottery this
entry observes:

- every contended admission (8/8) was decided by **minimum residency**, not by rank;
- **rank decided 0/8**; the §6.11 aging term fired on none (C1, now measured on live data, not read);
- `MIN_RESIDENCY_MS` is 1000ms and every source in a six-source comp mounts inside that window, so the
  first to mount is protected against every later challenger regardless of merit;
- `capMisses` did not move once during 20s of steady-state playback — the contention is a **mount-storm
  transient**, and it finishes before the residency window expires.

So the lottery is **drawn at admission** (arrival order converted into protected incumbency before merit
is consulted) and **observed at routing** (which sources ended up on WebCodecs vs the element path). One
event, two ends. Recorded here rather than as a neighbouring entry because reading them apart is what
would make either look like a tuning problem.

Tracked as **OQ9** in `plans/adr-013-phase0-measurement.md` §6.1: the magnitude needed is *mount-storm
duration ÷ residency window*. If the storm is shorter than the window, residency is not a damping term —
it is the admission policy, and rank is decorative.

**Neither half retires without the other.** A change that makes routing deterministic while arrival
order still decides admission has moved the lottery, not removed it.

**`MIN_RESIDENCY_MS` is not to be changed yet** — a mechanism change mid-measurement is how a programme
loses the ability to interpret its own numbers.

### DEBT-012 — CLASS: proof by a signal the subject never emits

- Status: **open** (registered as a META-CLASS; now documents at least five shapes — see body:
  instance 1 liveness/DEBT-009, instance 2 declaration/F2, a mirror-image "precondition that
  cannot pass," a "counter maintained on some paths and not others," "verifying the wrong
  SUBJECT," and a "DIFFERENCE assertion satisfied by two broken states" — plus a related but distinct
  shared-tree-collision pattern recorded here for proximity)
- Registered: 2026-08-05 (ADR-013 Phase 0)
- Reason: a health signal is verified against something **asserted upstream** rather than **observed from the subject**. The signal cannot fail, so it reads clean *because* the defect is present. This is the shape shared by DEBT-009 and by F2 below, and naming it is what makes it reviewable instead of rediscoverable.
- Invariant affected: none directly — this is a class of *evidence* defect, which is why it evades invariant checks
- Owner: unassigned
- Expiry condition: none — a class entry retires when every documented shape/instance retires and
  no new one is found for a sustained period. (Originally written "when both instances retire and
  no third is found"; retired 2026-08-13 as a condition — a third, fourth, and fifth shape were
  found while it was still worded as a count of two, which is the same header-drift class this
  register now has a convention for. See `README.md`, "State fields vs. history.")
- Detection: **ask what the subject itself did.** If the answer is "something else supplied the value on its behalf", the signal is a fabrication. A health metric that has never been observed *failing* on a real defect is the leading indicator.

**Instance 1 — liveness (DEBT-009).** Liveness was proved by *"the grade pass touched it this frame"* —
a touch the loader's consumer never performs, because that consumer is the Flarex compiler. Silence read
as death.

**Instance 2 — declaration (F2, ADR-013 Phase 0 §6.1).** Ranking merit is proved by the source's declared
`VisibleContribution`. For Flarex virtual sources, `collectFlarexVirtualLayers`
(`packages/shared/src/flarex/virtual-layers.ts:338`) synthesises a **hardcoded identity transform**
(`scale: 1, opacity: 100`), so `contributionRank` returns exactly `1.0` for every such source, always.
Nobody supplied that transform; the collection path manufactured it.

**The tell, and why it is worth a class entry.** Phase 0 recorded ***U* = 0.0%** — the fraction of
candidates with *no* declared contribution — as a clean precondition across two checkpoints. It is not
clean. It reads 0.0% **because every declaration is a fabrication**: an undeclared contribution would
have ranked at `UNDECLARED_RANK` and honestly said *"we do not know"*, which the kernel's own comment
insists on (*absence is meaningful; never synthesize a plausible default*). A manufactured identity
transform does the opposite one layer up — it asserts full area and full opacity **with authority**.

> **The metric that was supposed to detect the wiring gap is the metric the wiring gap makes look
> healthy.** DEBT-009 proved liveness by a touch the consumer never performs; F2 proves declaration by a
> transform nobody supplied. Same meta-class: *proof by a signal the subject never emits.*

**Sibling failure mode — the guard that cannot pass (2026-08-06).** The class has a mirror image, and it
belongs here rather than in an entry of its own: where the instances above are *a signal that cannot
fail*, this is *a precondition that cannot pass* — both a predicate misaligned with what it claims to
observe. The starvation census required `≥5 of 6 sources off the <video> element path` before it would
read a run. But DEBT-013 **is** "a denied source falls back to the element path", so the guard asserted
the absence of the very defect under test, and declared VOID on a run that had produced it (`capMisses
4`, two sources starved 183s). It could never have passed on a fixture built to starve — it rejects
exactly the runs worth reading. **The general fix: a precondition may assert that the MECHANISM RAN,
never that a particular party PREVAILED.** Here that is `engaged >= cap` — the budget filled, whoever
won it. This applies directly to the slice-C harness item ("strengthen `awaitWebCodecsEngaged` to a
declared fraction"), which would have shipped this bug in its obvious form.

**THE DETECTION RULE (2026-08-06).** Three instances in one programme — F2's `U = 0.0%`, OQ10's
rejection rate, OQ11's "capacity never freed" — were the same defect, and it is now general enough to
state as something checkable at review time rather than as a warning to be careful:

> **Match the instrument's shape to the phenomenon's. Sample for STATES; hook the site for EVENTS.**

All three placed a counter at a **sampler** and asked it about a **phenomenon that is an event**. The
counters were honest — each faithfully reported what its observer SAW. The topology was wrong, so what
they saw was not what happened. `starvedSources` is a state and a sample reads it correctly; a decoder
session being released is an event, and a 11.5s sweep reads it as absent 4 times out of 5.

This is checkable in review without a measurement: *for each counter, name the phenomenon; if it is an
event, find the hook; if there is no hook, the zero means nothing.* The earlier framings ("proof by a
signal the subject never emits") described the failure but gave no test.

**A third shape — the counter maintained on some paths and not others (2026-08-06).** Slice A's denied
registry was cleared on the create-session success path but NOT on the share path, which returns early
via `attachMember`. A waiter later satisfied by attaching to an existing session therefore stayed
counted in `starvedSources` indefinitely and would eventually be **declared permanently denied while it
was being served** — a census lying in both directions at once. The reading could not fail to look
plausible, because a partially-maintained counter always produces a number in the right range. The fix
is structural, not a patch: every success path now exits through one `noteServed`, so a future fourth
success path cannot forget.

The same class occurs in prose: slice A's registry comment claimed clearing "on
`resetPreviewFramePool`", a function that does not exist in that module (it has no reset entry point at
all). An assertion about a mechanism nobody performs, one register away from the counters written to
catch it.

**Scope of instance 2 — MEASURED 2026-08-05 (`contribution:scope`, 9/9): BOUNDED, not systemic.**

| Path | Behaviour | Evidence |
|---|---|---|
| real timeline clips | **propagates** the transform | full 1.0000 · half-scale 0.2500 · 25%-opacity 0.2500 |
| Flarex virtual sources | **manufactures** identity | hosts at scale 1/op 100 and scale 0.1/op 10 both yield `scale=1 opacity=100` → merit 1.0000 each |

So instance 2 is a **scoped defect in one collection path**, and specifically **not** a hole in ADR-013
§0.3's membership test: criterion 2 (*"rankable by visible contribution"*) fails for the Flarex
virtual-source class and holds for timeline clips. The first write-up of this finding stated the
consequences universally; that over-generalised an all-virtual fixture and is corrected in place in
`plans/adr-013-phase0-measurement.md` §6.1.

**The limit, stated so it is not over-read in turn:** the check proves the timeline path *can* differ,
not that real projects *do*. A timeline whose clips all sit at default transform still yields 1.0 for
every one. That is a corpus question and needs a live run; this settles the mechanism question only.

**Proposed slice — scoped, sequenced, not implemented.** `collectFlarexVirtualLayers` should derive each
virtual layer's contribution from its node's actual role in the comp rather than stamping identity.
Sequenced **behind** the C15 purpose-class work and the playback-contention fixture, because F2 is
bounded: it blocks M1b on virtual sources only, and OQ1 remains runnable on a timeline-clip corpus.
No code has moved; `MIN_RESIDENCY_MS` is untouched.

**NAME-COLLISION CORRECTION (2026-08-08).** This paragraph was accurate on 2026-08-05 and has been
misquoted as current in three later entries (this register's own DEBT-013 updates, and
`plans/adr-013-scope-after-adr-020.md`), each saying "slice B... remains unimplemented" without checking
git log against the claim. **Slice B shipped**, in `collectFlarexVirtualLayers`, currently at `38b9c73`
("fix(flarex): slice B — a virtual source inherits its host's transform instead of manufacturing one";
the commit's own self-naming). Its pre-repair hash was `cd6fdf8` — verified identical content (empty
`git diff cd6fdf8 38b9c73`), re-hashed by the 2026-08-07 corruption repair like every commit after it,
not a second, different piece of work.

What shipped is **narrower than what this paragraph describes.** The commit inherits a virtual layer's
HOST transform, which discriminates correctly **between** comps on different hosts (a half-scale,
10%-opacity host can no longer outrank a full-frame one) — measured 10/10, `contribution:scope`. It does
**not** discriminate **within** one comp: siblings on the same host still score identically, because that
needs each node's own reachability/composited area within the comp graph, "for which a TimelineLayer has
no channel today" (the shipping commit's own words) — a real design gap, not an oversight, and exactly
the remaining scope this paragraph originally described in full.

**So: one slice B, shipped partially, not two.** To stop the collision this caused from recurring, the
**unshipped remainder — within-comp/sibling discrimination, needing a new per-node contribution channel —
is renamed `slice B2`** from this entry forward. `slice B` alone now means only the shipped,
cross-host-discrimination piece. I-48's status is corrected accordingly in DEBT-013 and the scope note:
partially satisfied (cross-host), still defeated in substance for the within-comp case, blocked on
unimplemented `slice B2` — not on an unimplemented `slice B`.

**A fourth shape — verifying the wrong SUBJECT, not the wrong property (2026-08-07).** A zero-context
patch (`git apply --cached --unidiff-zero`), used to stage one session's hunks out of a file another
session held dirty, computed its line numbers against the working tree and applied them to the index —
producing a byte-valid but wrongly-positioned splice in the **committed blob** of
`WebglMediaLayer.tsx` across three commits. Every gate run that session (typecheck, pixel, decoder soak,
`kernel:conform`) passed, repeatedly, because every one of them ran against the **working tree**, which
was never touched by the corruption and stayed correct throughout. The break was invisible until a
`git worktree add` at the suspect commit produced a file that failed to parse.

This is not instance 1–3's shape (a sampler reading a state where an event was needed) — the gates here
were the *right* kind of check, run against the *wrong* artifact. Two different files existed under one
path: the one every tool read, and the one `git log` would eventually ship. Nothing in the session's gate
suite ever looked at the second one. **The general form: for anything that lands as a commit, "it passes"
must mean "a clean checkout of the commit passes" — verifying the working tree, however thoroughly, is a
claim about a different artifact than the one being shipped.** Detection: any workflow that edits or
stages a file whose committed content the reviewer has not independently checked out and built stand-alone
is exposed to this, regardless of how many working-tree gates it runs. The repair (sequential
`cherry-pick` + context-anchored rebuild + `--amend`, full typecheck at every intermediate commit, not
just the tip) is recorded in ADR-020's evidence index rather than here; this entry keeps only the class.

**Third incident of the shared-tree class (2026-08-08).** A concurrent session, live on this same branch,
committed while this session had a file staged; the shared index took whatever was staged at commit time,
attributing this session's content to that session's unrelated commit message. A subsequent history
rewrite by that session (the commit is now dangling) restored correct attribution, but by luck of timing,
not by any safeguard either session had. Third occurrence of two sessions writing the same branch at once
producing a wrong or misleading commit — after the 2026-07-29 broad `git add -A` sweep and the 2026-08-07
zero-context-patch corruption above. No fix is proposed here; recorded so the pattern is visible the next
time it costs someone an hour.

**A fifth shape — the DIFFERENCE assertion satisfied by two broken states (2026-08-15).** Shapes 1–4
are all a signal that reads healthy while the subject is broken. This one is its negative-space twin,
and it cost three gate drafts in one sitting. `font:install-gate` gained a no-media arm to guard the
newly-fixed DEBT-009 instance 4, and its claim was "a pinned font reaches the raster", asserted as
*two renders must DIFFER*. Two drafts passed while the defect was fully present:

  1. pinned Anton vs Anton named as a system stack — different family stacks are emitted, so the two
     land on different fallbacks (a thin sans and a serif). Both wrong. `notEqual` satisfied.
  2. pinned Anton 400 vs pinned Arimo 700 — same stack now, but weight travels with the ref, so the
     fallbacks are sans-serif 400 and sans-serif 700. Both wrong. `notEqual` satisfied.

Only two pinned families **at the same weight** collapse onto one picture when neither arrives. The
general form, and it is checkable at review time without running anything:

> **For a gate asserting two things DIFFER, enumerate every way they could differ while the subject
> is still broken. Each one is a way the gate passes vacuously.** An equality assertion fails safe —
> it needs one reason to differ and gets it from the defect. A difference assertion fails OPEN: it is
> satisfied by *any* asymmetry, including two flavours of the same failure.

The tell here was available for free and was walked past twice: this same file already records, at its
S2.6 arm, that two *system-named* families collapse onto one identical fallback. That is the same fact
stated from the other side, sitting eight lines above the arm being written. **Detection:** a
`notEqual`/`toBeGreaterThan`/"changed" assertion whose two operands differ in more than the one
property under test. If the operands differ in two respects, the gate tests neither.

### DEBT-013 — a source denied at mount can never be admitted, and nothing reports it

- Status: **open — USER-VISIBLE DEFECT**, raised to the founder 2026-08-06. **PARKED WITH A TRIGGER
  2026-08-13**: the pool half is closed and guarded on every `wc:gate`; the remaining layer half is
  blocked on an unwritten identity slice for the comp-proxy acquire site — see the closing update at
  the end of this entry
- Registered: 2026-08-06 (ADR-013 Phase 0; see ADR-020 §2)
- Reason: ADR-012 §6.11 offers a persistently low-ranked source exactly two ends — *it receives a session, or it is declared permanently denied.* The runtime produces a third: it waits forever. Two independently measured mechanisms compose to make recovery impossible, and neither is individually wrong.
- Invariant affected: **ADR-012 §6.11 (violated)**; I-40's aging requirement unmet in practice
- Owner: unassigned
- Expiry condition: a source denied at mount is subsequently admitted, or is declared permanently denied, on a fixture with more sources than slots
- Planned slice: **none currently accepted** (was "ADR-020 §5 slice A (§6.11 recovery)" through
  2026-08-10; the 2026-08-09/10 duty-cycle measurement in this entry refutes the mechanism that
  slice was built against — see the 2026-08-12 phase 1 read, "The remedy the entry's own header
  names is no longer the operative one." No successor slice has been proposed; the reachable-MediaIn
  fixture named in that read is the next instrument, not a fix.)
- Tracking issue: —
- Detection: any change that adds a retention path, or removes an admission decision point, without adding a compensating re-ranking opportunity. Also: `deniedForMs` failing to accumulate for a candidate that is losing.
- **Header updated 2026-08-13:** see the Planned-slice correction above. The defect statement ("open
  — USER-VISIBLE DEFECT, raised to the founder 2026-08-06") is unchanged because it remains
  accurate; only the named remedy had drifted. Status gained the PARK later the same day, after the
  slice F read settled what the remaining half is actually blocked on. See `README.md`, "State
  fields vs. history."

**The mechanism, measured.**

1. **Aging is structurally inert on the live admission path.** Incumbents are pushed with `admittedAtMs`
   set, and `rankAdmission` applies aging only when it is null; the sole null-valued candidate is the
   newcomer, whose `firstRequestedAtMs` is `now`. **Every aging term in every live contended decision is
   exactly zero.** Held across three runs, asserted continuously by the instrument (`C1`).
2. **No admission decision occurs after the mount storm.** Sessions are retained across seeks, so the
   winners keep their slots and the losers never re-enter a ranking. Measured: **6 decisions at mount, 0
   across 30s of scripted seeks, scrubs and long jumps** (115 transport samples).

So the loser does not age into contention, is not re-ranked, and never reaches the
`PERMANENT_DENIAL_AFTER_MS` terminal — because that terminal is reached through `deniedForMs`, which for
such a candidate never accumulates.

**Why this is a defect and not only an ADR note.** On a six-source comp against a four-slot budget, two
sources decode through the `<video>` element path **for the lifetime of the session**. That is
measurably different playback — the element path is the fallback, not the intended one — and **nothing
reports it**. `capMisses` records the moment of denial and then stops moving; no counter says "two
sources have been degraded continuously for four minutes". The user sees it; the runtime does not.

**Relationship to the other two entries.** DEBT-011 is the routing-side symptom (which sources end up on
WebCodecs varies run to run, bistable, arrival-decided). OQ9 is the admission-side cause (arrival order
converted into a protected incumbency before merit is consulted). **This entry is the consequence that
makes both permanent**: without it the lottery would be re-drawn and would average out; with it, one draw
decides the whole session. The three retire together or not at all.

**Not fixed here.** The slice is proposed in ADR-020 §5 and deliberately unwritten. `MIN_RESIDENCY_MS` is
untouched: shortening it is the tempting one-liner and OQ9 — *residency ÷ mount-storm duration* — is
still unsized, so it would trade a measured defect for an unmeasured one.

**Update (2026-08-06) — slice A shipped PARTIALLY. The silence is fixed; the permanence is not.**

Of the two halves of this defect, the reportability half is closed and the recovery half is not.

**Closed.** An unconditional denied registry now exists in the pool (deliberately *not* the
diagnostics ring, which reads empty with instrumentation off — a recovery mechanism reading it would
stop recovering the moment someone turned diagnostics off, making behaviour depend on observation).
`__rfWcPool` gained four unconditional readings, and the first two are what make starvation a **state**
rather than an event:

| reading | why `capMisses` could not say it |
|---|---|
| `starvedSources` | how many sources are refused **right now** |
| `starvedLongestMs` | how long the worst has been refused |
| `admissionRecoveries` | waiters found free capacity |
| `admissionPermanentDenials` | waiters that reached §6.11's terminal |

`capMisses` counts the *moment* of denial and then goes quiet, so two sources degraded for four minutes
read identically to two denied once and immediately served. These distinguish them. §6.11's second
acceptable end is now reachable: a source starved past `PERMANENT_DENIAL_AFTER_MS` is declared, once,
at `severity: "warn"`, and **kept in the registry** — dropping it would make the census read healthy
while the picture is degraded, which is silence arrived at from the other side.

Recovery rides the existing idle-sweep tick with **its own constant**, `ADMISSION_RECOVERY_IDLE_MS`,
initially equal to `RESOURCE_IDLE_MS`. Separated deliberately: recovery is admission policy, the sweep
is resource lifetime, and sharing the constant would mean a later change to how long a texture may sit
unused silently changes how quickly a starved source gets another chance — the same coupling defect as
the two disconnected `frameBudgetMs` constants ADR-013 was written about.

**NOT closed, and stated precisely.** A denied source still does not re-ask, so acceptance clause **(a)
"subsequently admitted" is unmet**; clause (b) "explicitly declared denied" is met. The retry half needs
a layer-side **element→WebCodecs re-acquire path that does not exist**. `requestLiveReprime` was the
obvious candidate and is the wrong one: reading it shows it re-seeks the `<video>` element and never
re-attempts an acquire, so hooking recovery to it would have incremented `admissionRecoveries` for
recoveries that could not happen. **Left unwired rather than wired to a no-op** — a mechanism that
reports success it cannot deliver is worse than one that reports the gap, and this register exists
partly because that distinction gets lost.

Remaining work is therefore a **layer-side slice**, not a kernel one, and it is the only thing standing
between this entry and retirement. It is contracted, unwritten, in
`plans/adr-020-slice-d-transport-reacquire.md`.

**Update (2026-08-06) — slice A's readings OBSERVED, and the soak that passed it was vacuous.**

Slice A's decoder soak recorded `capMisses 0`. That soak proved the slice *breaks nothing*; it did not
test it, because with nothing denied the registry was empty for the whole run and the recovery pass
never rendered a verdict. Shipping a health reading that has never been seen non-zero is DEBT-012 in its
own right, so the readings were re-run against a fixture built to deny (6 sources / 4 slots, chrome,
55s sized from `PERMANENT_DENIAL_AFTER_MS` + 2 × `ADMISSION_RECOVERY_IDLE_MS`):

```
routing          3/6 off-element  — the three losers stuck on <video>, which IS this defect
capMisses        6
starvedSources   peak 3 · final 3
starvedLongestMs peak 186876          (187s, against a 30s terminal)
recovery         ticks 5 · sweeps 2 (nominal ≈5) · waits 3
outcomes         retries 0 · permanentDenials 3
```

Every reading moved, and §6.11's terminal was declared for all three starved sources. The verdict
arithmetic is exactly consistent (2 sweeps × 3 waiters = 6 = 3 waits + 3 declares), which is the check
that the counters describe the same events rather than merely being non-zero.

Two things the run added that the constants did not predict:

- **`retries 0`.** Free capacity never appeared — the pool stayed full for the entire session. A retry
  path triggered *only* by freed capacity would therefore have done nothing here. This is the measured
  reason slice D's trigger is a transport boundary rather than a capacity event.
- **OQ10 — the sweep cadence under-delivers, and it already cost a terminal.** `ticks 5 · sweeps 2`:
  recovery's own 10s limit rejects most of the host ticks it rides. An earlier run in the same session
  recorded `sweeps 1 · permanentDenials 0` — the terminal was **missed entirely** for a source starved
  128s. So §6.11's second end is reachable but not *reliably* reached. Not fixed here: it changes when
  the kernel decides, which is a different blast radius from how the layer acts on a decision, and
  bundling them would make the soak un-bisectable.

  > **OQ10 SIZED AND CLOSED, 2026-08-06 — and the premise above is FALSIFIED. No constant changed.**
  >
  > The claim "recovery's own 10s limit rejects most of the host ticks it rides" was an **inference from
  > `ticks > sweeps`**, and it was wrong. Instrumenting the rejection branch directly gives
  > **`rejects n=0` across four consecutive runs**: the rate limit has never rejected a single tick. The
  > entire gap is the third branch nobody had counted — ticks that arrived while the registry was still
  > empty, which is correct behaviour. With all three counted the accounting closes exactly and
  > identically on every run: **`ticks 7 = sweeps 4 + rejects 0 + empty 3`**.
  >
  > This is the register's own meta-class caught once more, and by me: reading a gap between two counters
  > as evidence for a *particular* cause, when the branch that would prove it was never instrumented.
  > **Count the reasons; never infer which branch fired** — the rule applies to the person applying it.
  >
  > **Measured tick period (n=18 intervals over 3 runs): min 10140ms, mean ~11.5s, max 18607ms**, against
  > a nominal 10s. So the constant is not the mechanism — `ADMISSION_RECOVERY_IDLE_MS` sits *below* the
  > observed minimum and therefore never binds. Raising it "with margin" would begin rejecting ticks that
  > are currently all accepted; lowering it would change nothing. **Either direction is a change with no
  > benefit, and one of them is a regression.** It stays at 10s, still named and still separate — the
  > point was never that it hold a different value, only that changing one does not silently change the
  > other.
  >
  > **What the period distribution actually says.** The sweep rides the composite loop and fires on the
  > first composite *after* the interval expires, so its period is `RESOURCE_IDLE_MS + time-to-next-
  > composite` — the overshoot IS the composite gap. Recovery's cadence is therefore **coupled to
  > compositing activity, not to a clock**, and when the viewer holds or pauses, recovery slows with it.
  > That is a real property and the residual of OQ10; it is *not* addressable by tuning either constant,
  > and making recovery independent would mean adding a timer, which the founder condition on slice A
  > explicitly ruled out in favour of riding the existing tick. **Left as a stated property with an open
  > decision, not silently fixed.**
  >
  > **Consequence for sequencing:** recovery fires every ~11.5s whenever anything is starved (4 sweeps
  > per 55s run, every run). It is *not* under-firing, so a null result from the slice D fixture will be
  > attributable rather than ambiguous between "no asymmetric release" and "no permission granted in
  > time". The block on building that fixture is lifted **on evidence**.

- **OQ11 — recovery samples for an opportunity that arrives as an event, and misses it. NEW, 2026-08-06,
  and it falsifies my own published claim.**

  Slice D reported `retries 0` and I wrote *"free capacity never appeared: the pool stayed full for the
  entire session."* That was an inference from a counter which only observes the pool every ~11.5s.
  Measuring releases **at the release site** instead gives, on a single 55s run:

  > **`capacityFreedWhileStarved 5 · samePool 4`**, with `admissionRecoveries 0`.

  Capacity freed **four times in the same pool as a waiter**, while sources were starved throughout, and
  recovery granted **zero** permissions. The pool never stays full — it *churns* (`created 11` against a
  4-slot cap). The sweep steps over the transients: a slot is released and retaken well inside 11.5s.

  **The opportunity is an EVENT; the sweep is a SAMPLE.** No cadence fixes that, because the gap is not
  a rate — a faster sweep only shortens the window it can miss. The structural answer is to grant
  eligibility where the opportunity is created, in the release path, which is where the pool already
  knows both facts (a slot opened, and someone is waiting).

  **This leaves C-D2 fully intact**, and that is why it is the right shape rather than a convenient one:
  the contract already separates *whether* a re-ask is entertained (kernel) from *when* it happens
  (layer). OQ11 is a defect in the first half only. The layer would still act only at a seek, scrub, or
  pause; it would simply have a permission to act on.

  **Deliberately not implemented.** It would make slice D's own fixture pass, and a mechanism must not be
  changed to satisfy the run that measures it. Recommendation recorded; decision open.

  **It also retires the fixture-engineering plan.** The stated next step was to build an arrangement that
  frees capacity asymmetrically — the existing fixture *already does*, 4–5 times per run. Building a
  bigger rig first would have reproduced `retries 0` on it and invited the conclusion that the fixture
  was still wrong.

  **Third instance of one error in this programme**, all mine, all the same shape: a zero read as *"the
  condition never occurred"* when it meant *"the instrument never looked"* (F2's `U = 0.0%`, OQ10's
  rejection rate, and now this). It is the sharpest statement yet of DEBT-012, because in each case the
  counter was accurate — it faithfully reported what the subject SAW, and I wrote down what the world
  DID.

- **SLICE E — OQ11 FIXED AND ACCEPTED ON ITS OWN TERMS, 2026-08-06.** Eligibility is now granted in the
  release path (`bumpActive`), where the pool knows both facts at the instant both are true: a slot
  opened, and someone is waiting. Measured on the census fixture:

  | reading | before E | after E |
  |---|---|---|
  | same-pool opportunities | 4 | 4 |
  | permissions granted | **0** | **3** |
  | opportunities leaving a waiter unpermitted | 4 | **0** |

  **Accepted with slice D absent from every check.** All four criteria are computed from release-site
  readings only — none reads a re-ask, a boundary, or a routing flip — so E would still be falsifiable
  if the layer half were deleted. That separation is deliberate: D's acceptance must come from a
  different run, or one thing gets proved twice and counted as two.

  The three constraints held. **The sweep stays** — E adds a trigger and replaces none; the sweep remains
  the backstop and still drives §6.11's terminal, which is time-based and cannot be event-driven
  (`permanentDenials 3` unchanged). **Grant, never reserve** — verified by a check that would fail if a
  permission decremented the census (`starved still 5 with 3 permissions outstanding`). **R1 shown, not
  asserted** — hoisted callback and module scratch make the release allocation-free, and
  `releaseScanWaiters / releases = 3.0 waiters/release` demonstrates the scan is O(waiters).

  One correction worth keeping: E's first acceptance check counted grants per opportunity and read
  **1/4 on a correct run** — once all three waiters held a permission, the next three releases rightly
  granted nothing. A rate cannot express *"everyone who should be permitted is"*. The criterion is the
  IMPLICATION (`releaseLeftUnpermitted == 0`), not a ratio.

- **SLICE D IS UNREACHABLE ON THIS PATH — measured 2026-08-06, and it is not a fixture problem.** With E
  supplying permissions, D still reported `attempts 0`. Attribution instead of inference:

  > **`0/5 starved source(s) are layers the D trigger can see.`**

  Slice D's boundary detector lives in `WebglMediaLayer.tsx`. The pool has a SECOND acquire call site,
  `useFlarexCompProxies.ts`, and every starved source in this fixture came from it. There is no re-ask
  path for them at all — which is a different failure from a trigger that fired and lost, and the two
  are indistinguishable in a count of zero. `__rfWcMode` covers only `WebglMediaLayer` layers, which is
  what made the attribution possible.

  So DEBT-013's clause (a) needs D's trigger at BOTH acquire sites, not a better fixture. Not
  implemented here: it is a third call site's worth of layer work, and bundling it with E would make
  E's soak un-bisectable.


Two instrument additions were needed to make this readable at all, both unconditional:
`admissionRecoverySweeps`/`admissionRecoveryWaits` (did the pass run, and did it decide per waiter) and
`admissionRecoveryTicks` (did the host call it). Without them, a run in which nothing recovers and
nothing reaches the terminal leaves the outcome counters at zero — indistinguishable from a pass that
never ran. That is DEBT-012's signature, and the fix is the same every time: count the reasons, never
infer which branch fired.

**SLICE F shipped a shared boundary detector (one predicate, `admission-reacquire.ts`, consumed at both
acquire sites) and, incidentally, un-stuck D's own layer-site trigger for the first time — measured
2026-08-07, and it is NOT the same finding as F's own stated purpose.**

Bisected against a decoder-topology regression on `preview:budget` (PROBE_SOURCES=6): E's repaired tip
reads `created 11 · unmet 1 · preload 3` stable across three clean runs; F reads `created 13-14 · unmet
2-3 · preload 0` stable across four. Restoring D's original render-dependency-gated inline detector at
the `WebglMediaLayer` site ALONE (F's other changes — the comp-proxy trigger, `kernel:conform`'s
enumeration check — left in place) exactly reproduces E's numbers, twice, byte-identical. The regression
is localized to that one swap, not to the shared module's existence or to the second site.

The mechanism is not the stale-eligibility-flag bug it first looked like — `noteDenied` already resets
`record.eligible = false` on every re-denial (checked directly; not present). Direct instrumentation of
the same fixture instead shows the shared detector's real effect: `reacquireAttempts 6-7 ·
reacquireGrants 2-3 · admissionRecoveries 9-10` — D's OWN re-acquire path, wired since slice D and
carried forward unchanged, executing for the first time in this fixture. D's inline effect was gated on
a React re-render (`[mediaType, src, transportTime, transportPlaying]`) that this fixture apparently
never delivered inside a 12s arm; F's hook is driven by `subscribePlaybackClock`'s imperative,
render-independent notification and reaches the same guarded body at the clock's real cadence. Nothing
in the swap is incorrect — `wcModeRef !== "element"` and `isAdmissionEligible` gate both versions
identically — F's detector simply *fires*, where D's mostly didn't, in exactly the scenario this whole
programme exists to fix.

**The cost is real and attributable, not a bug.** Every additional reacquire attempt is a `playhead`-
priority `acquirePreviewFrameProvider` call, and `preload`-priority pre-roll shells are the documented,
pre-existing victims of exactly that contention (`WebglMediaLayer.tsx`'s own comment: "a mounting
PLAYHEAD clip can preempt them"). Recovering the currently-broken visible source at the expense of a
not-yet-visible pre-roll shell's warm session is the priority system doing what it was built to do; it
was simply never exercised at this frequency before F fixed the trigger's cadence. There is no code
defect here to fix — reverting the swap would mean deliberately re-breaking D's own mechanism to hide a
cost the mechanism was always going to have once it worked.

**F's OWN stated purpose remains unconfirmed.** The census fixture's attribution (paused, comp-proxy-
heavy) reads `comp-proxy re-asks 0` even with `slice E permissions 3` granted — `useFlarexCompProxies`'s
new trigger has never been observed to fire, on any run in this programme. So the accounting is: a
**measured, reproducible, explicable cost** (preload eviction, from D's own trigger finally running) is
now attached to F, and F's actual contribution over D — a second acquire site — has **zero observed
benefit**. These are separable facts about one commit. Not shipped as a single unit pending a decision on
whether they should be.

**SLICE D'S ACCEPTANCE IS VOID — ruled 2026-08-07, founder decision, recorded here as the load-bearing
copy (full reasoning: `plans/adr-020-slice-d-transport-reacquire.md` §8).** `reacquireAttempts 6-7` above
is the FIRST nonzero reading this mechanism has ever produced, on any fixture, across slices D, E, and F.
Every prior soak, gate run, and census pass that treated D as shipped-and-fine was a vacuous pass over a
population of zero executions — D's contract (§5, D1–D5) is evidence about a mechanism only across runs
where the mechanism ran, and until this bisect none had. **DEBT-013 clause (a) remains unmet by anything
on the branch.** D1/D2 are downgraded from "unexercised" to **retracted, unevaluated** — one favorable
data point (`grants 2-3` of `attempts 6-7`) exists now, but it is one run, on one adversarial fixture, and
does not by itself constitute acceptance. D3/D4 continue to hold on every run measured.

**Successor slice, provisionally "D fires" — proposed, not accepted, gated on one measurement.** The fix
is not to D's contract (every clause is still the right shape); it is that the boundary detector's actual
firing site should be the imperative clock subscription (`admission-reacquire.ts`), not the React-render-
gated inline effect — "a transport-boundary re-ask that does not fire on transport boundaries is not a
shipped mechanism, it is dormant code with a commit hash." **Not yet accepted**, because every reading of
its cost so far comes from an adversarial fixture (six sources against four slots) built specifically to
force contention. The pending measurement: the same A/B (D-restored vs. detector-swapped) on a
non-adversarial timeline — one or two sources, spare decoder capacity, `capMisses` at or near 0 — to learn
whether `preload 3 → 0` is a contention-only cost (an easy accept) or persists with capacity to spare (a
harder decision). Until that lands, "D fires" ships as neither accepted nor reverted — held in the working
tree, not committed.

**F's second half — does not ship, and is blocked on a different slice, not on F.** `comp-proxy re-asks 0`
on every run in this programme, before and after F, including the census run above with three permissions
outstanding on a comp-proxy-heavy fixture. This is not an unlucky fixture: `useFlarexCompProxies` mints a
fresh blob URL per attempt (see `admission-reacquire.ts`'s own doc comment and `forgetAdmissionWaiter`),
so the site has no stable identity for a granted permission to attach to across a re-ask — the finding
that explains why it structurally cannot fire, not merely why it hasn't yet. Blocked on an identity slice
for that acquire site, unwritten. **What survives from F regardless, correct on its own terms and
unaffected by either open question above:** the shared boundary-detector module (`admission-reacquire.ts`,
`isTransportBoundary`/`useTransportBoundary`), `kernel-conformance.ts`'s enumeration of acquire sites, and
the epoch-state→callback re-render fix (both documented in `admission-reacquire.ts`'s own header). These
ship as their own commit, independent of "D fires" and independent of the comp-proxy second half.

**CORRECTION, 2026-08-07 — the "F causes a decoder-topology regression" framing above is RETRACTED, with
reason, not deleted. It was quoted as established across three replies in this thread before the defect
in the measurement was found. Left in place above because rewriting it would hide how the mistake was
made, which is worth more than a register that reads as though it always knew.**

A pre-registered instrument (four counters inside D's original inline effect body: entered unconditionally,
passed both gates, failed on healthy-not-starved, failed on not-yet-eligible) was run on the E tree across
four arms, two thermal states (immediately post-restart, and after prior probes had already warmed the
same server). Every arm read **36 boundary-reaching events**, split as **0–2 passes** and **~15–21 blocked
on `isAdmissionEligible` false at a genuinely starved (`wcModeRef === "element"`) source** — confirmed
per-instance, not global, by reading the `useRef` declaration directly. The one thing that varied between
arms was thermal state, not tree: the sole anomalous reading (`created 14 · preload 0 · gatePassed 2`) was
the first successful run after a dev-server restart; every other arm — including the *second* arm of that
same run, on the same tree — converged on an identical `created 11 · preload 3 · gatePassed 0`.

**Supported — mechanism B.** D's inline effect body runs at high frequency and reliably reaches its gate
(36/arm, stable across thermal state and across trees). It almost never passes. The trigger and the
permission are not synchronised: eligibility is granted at a release event and consumed only if a
transport boundary happens to land while it is still true, and on this evidence that coincidence is rare
by construction, not because either half is broken. Per your ruling: this is what F's clock-driven
detector is polling — a gate that refuses ~100% of the time until a sample lands — and firing it faster is
not a repair. **F's detector does not ship**, decided on this evidence, independent of the retraction
below.

**Not supported — F causes a decoder-topology regression.** The claim (three replies in this thread: soak
tables, `created 11→13-14`, `preload 3→0`, localized via an arm-1 bisect to the WebglMediaLayer detector
swap) rested on comparing E and F readings taken under uncontrolled, opposite thermal conditions — in
every comparison run, whichever tree was read first-after-a-restart differed from whichever was read
after prior probes had already warmed the server, and tree identity was confounded with thermal state
throughout. **`preload 3 → 0` is specifically retracted**: the one run in this thread that measured F's
actual `preload` value under the pre-registered instrument's conditions read **1**, not 0. The raw logs
for the original three-E/four-F comparison predate this session's context and cannot be re-inspected to
separate thermal state from tree identity after the fact. **This is unrecoverable, not merely unproven** —
re-running would cost a day to re-establish a number nothing now depends on, since mechanism B already
decides F's detector on independent grounds. Not re-run.

**DEBT-013 — PARKED, 2026-08-07, and this is a good outcome, not a stall.** Three things block retirement,
stated precisely so the next person starts in an hour instead of a week:

1. **Clause (a) ("subsequently admitted") remains unsatisfied.** D's trigger and E's permission exist but
   are not synchronised (mechanism B above) — D is effectively inert in practice, not because it never
   runs, but because it almost never runs *while eligible*.
2. **F's detector is rejected**, on the mechanism-B evidence, independent of the retracted regression
   claim. No fix is proposed here — see open question 1.
3. **The comp-proxy site cannot be tracked across attempts at all.** `useFlarexCompProxies` mints a fresh
   blob URL per re-ask, so there is no stable identity for a granted permission to attach to. This is a
   structural gap, not a tuning question.

**Two open questions, recorded and NOT chased today:**

- **Why eligibility and boundaries never coincide.** The obvious suspect is cadence: recovery's sweep
  rides the ~10-11.5s idle tick (OQ10), against a 12s probe arm — a permission window and a boundary
  window that are each individually plentiful can still rarely overlap if one is short relative to the
  other's period. Untested. A real slice, not today's.
- **Stable waiter identity at the comp-proxy site.** `useFlarexCompProxies` needs an identity for a
  re-ask that survives the blob-URL churn — the specific shape is unwritten. A real slice, not today's.

**What ships from this programme:** the corruption repair (verified at eight commits, backup retained
until this correction lands), `kernel-conformance.ts`'s enumeration of acquire sites, and the
epoch-state→callback re-render fix in `admission-reacquire.ts`. **What does not ship: F, either half** —
the shared detector module ships only as inert, unconsumed code (the enumeration and the callback fix are
real independent of whether anything calls `useTransportBoundary` yet); nothing currently calls it into
service.

**UPDATE (2026-08-08) — separation executed, and the paragraph above is corrected on two points, not
rewritten.** Working tree audit found `WebglMediaLayer.tsx` still mixed with another session's
uncommitted grade-compare work; it was not touched (hard stop, no hunk surgery — that technique is
retired). The other four files were mine alone and clean:

- `useFlarexCompProxies.ts` and `preview-frame-pool.ts` — reverted whole-file (`git checkout --`). Both
  diffs existed solely in service of F's rejected comp-proxy trigger (`forgetAdmissionWaiter`,
  `admissionWaitersAbandoned` served no other consumer once the trigger that used them is gone).
- `admission-reacquire.ts` — **did not ship.** Both its consumers are rejected (D's swap, still sitting
  unreverted in the hard-stopped `WebglMediaLayer.tsx`; F's comp-proxy trigger, just reverted), so it has
  zero consumers — L13, no dormant code. Preserved as a design artifact on branch
  **`artifact/adr020-shared-detector`** (commit `1ffc898`), not on `main`/`method-3-gpu-compositor`. The
  "epoch-state→callback re-render fix" named above lives entirely inside this module and shipped nowhere,
  contrary to the paragraph above — corrected here. It also does not map cleanly onto D's own committed
  code as something to "extract and land": D's inline detector (as committed) reads render-time values via
  a dependency array and never had the `useState`-epoch anti-pattern the fix addresses — that pattern only
  ever existed in an early, never-committed draft of this shared module. There is nothing to extract onto
  D, and `wcReacquireEpoch` itself is not dead cost (it is D's real, still-parked mechanism, occasionally
  observed firing under mechanism B) — so neither offered option applied. No action taken; moot in
  practice today regardless, since the file it would touch is hard-stopped.
- `kernel-conformance.ts` — shipped, reduced. Of the block's five assertions, four depended on
  `admission-reacquire.ts` existing (three would read a file absent from any clean checkout and throw,
  not fail gracefully) and were dropped rather than disabled. The base enumeration — a third undeclared
  acquire site fails the harness — stands alone and was verified standing alone: `kernel:conform` run with
  `admission-reacquire.ts` removed from the tree entirely, and again from a clean detached-worktree
  checkout of the committed tip (`7db1085`), both green.

**CORRECTION (2026-08-08) — the update immediately above is itself wrong on one point, verified against
the committed blob, not asserted.** `git show HEAD:apps/web/src/components/WebglMediaLayer.tsx` shows:

- `:685` — `const [wcReacquireEpoch, setWcReacquireEpoch] = useState(0);`
- `:1007` — the lease-acquire effect's own dependency array, `[mediaType, src, wcReacquireEpoch]`
- `:1050` — `setWcReacquireEpoch((value) => value + 1);`, inside D's own boundary-detector effect

D's committed code **does** have a `useState`-declared epoch, bumped, and depended on by another effect.
The claim two entries up — "D's inline detector... never had the `useState`-epoch anti-pattern... nothing
to extract onto D" — is **wrong** and is corrected here, not rewritten there, per this register's own
convention.

**A second, related correction, in the other direction.** `admission-reacquire.ts`'s own doc comment
(and this register's earlier readings of it) describe the pre-callback draft as one that "re-renders
every consumer on every boundary." `wcReacquireEpoch` is declared with `useState` **inside the component
function body** — per-layer-instance, not module-level or global. A bump in one layer's epoch re-renders
that layer alone; it does not re-render every media layer in the comp. That characterization, inherited
from the shared module's own history and repeated in this register without independently checking the
scope of the state it was said to describe, was also wrong.

**The quantified consequence — labelled INFERENCE, not measured.** The lease effect's deps are
`[mediaType, src, wcReacquireEpoch]`; `mediaType` and `src` are stable for a mounted layer within one
probe arm, so that effect re-runs if and only if `wcReacquireEpoch` changes. Mechanism B's `bodyRuns`
counter (this entry, 2026-08-07) measured **~320** invocations of D's *detector* effect per 12s arm,
against only **~36** that reach the boundary-relevant gate — leaving **~285 unaccounted for at the time**,
attributed then to the two early returns (`mediaType !== "video"`, and the boundary predicate
`playing && !jumped`) without a counter placed on either. **Inference, not yet confirmed:** if a
meaningful share of those ~285 detector-effect re-entries are themselves caused by the epoch's own bump
triggering a component re-render (a bump forces a re-render; a re-render recomputes `transportTime`/
`transportPlaying` fresh from `wcTimeRef.current`; if those differ from the prior render — likely during
active playback — the detector effect's own deps change and it re-enters), then a large share of the
missing 285 is the epoch mechanism re-entering its own trigger, exiting immediately because the boundary
predicate is false on a re-render that wasn't itself a transport event. This is a **hypothesis about the
missing-285 attribution, not a demonstrated one** — it requires a counter at `:1050` (or on the lease
effect's own entry) to confirm, and that requires editing the hard-stopped file. Recorded here so it is
checkable the moment `WebglMediaLayer.tsx` unblocks, not asserted as established.

**BLOCKED-WORK NOTE, for whoever hits this next.** `admission-reacquire.ts` must remain on disk,
**untracked**, for as long as the uncommitted `WebglMediaLayer.tsx` imports it — confirmed 2026-08-07 by
removing it and watching `pnpm --filter @orreris/web typecheck` fail for the whole shared tree, not just
this branch's own work. `git clean -fd` (or any equivalent untracked-file sweep) will reproduce that
failure. **This does not resolve on its own and is on this programme's critical path**: it untangles only
when the other session's grade-compare work is committed (or otherwise resolved) and `WebglMediaLayer.tsx`
stops being mixed — at which point D's swap can finally be reverted for real, and `admission-reacquire.ts`
can be deleted from the working tree (it already lives safely on `artifact/adr020-shared-detector`). Until
then, do not `git clean` this tree expecting a normal untracked-file cleanup to be safe.

**RESOLVED (2026-08-08).** The other session committed the grade-compare work as `32e5703`;
`WebglMediaLayer.tsx` stopped being mixed. `git diff` on the file showed only F's swap (16 insertions / 44
deletions: the `useTransportBoundary` import, D's inline detector replaced by the shared hook, doc-comment
changes) — read in full before acting, confirmed to contain nothing else. Reverted with `git checkout --`,
restoring D's original inline detector and doc comments (the rejection this programme decided on but could
not execute while the file was hard-stopped). Grepped the whole repo for `admission-reacquire` afterward:
the only remaining hits are a diagnostic string literal (`WebglMediaLayer.tsx:793`), a trace-reason tag
(`provider-lifecycle-trace.ts:49`), and documentation references — no code imports the module. Deleted
`apps/web/src/playback/admission-reacquire.ts` from disk; it remains preserved on
`artifact/adr020-shared-detector` (`1ffc898`). `pnpm --filter @orreris/web typecheck` and
`pnpm --filter @orreris/worker typecheck` both pass clean. Nothing on this programme's critical path
remains blocked by this file.

**DISPOSITION UPDATE (2026-08-08) — C15, C16, I-44, I-48, and a location error corrected.**

- **C15 satisfied, not fixed.** `preview-frame-pool.ts` already receives `contribution`/`priority` only
  as `AcquireOptions` fields and never computes rank itself — the constraint C15 asks for was structurally
  true before this session touched anything. No code changed.
- **C16 and I-44 are one violation, fixed in one commit (`37ed422`).** `preferSoftwareDecode` chose a
  backend from `isFlarexVirtualLayerId(layer.id)` — source identity — forbidden by I-44's own corollary
  (ADR-013 §4.2). Replaced with a gate on `flarexConcurrentLoaders > 1`, the count of decode-hungry
  virtual loaders actually mounted — a declared-need signal read from real contention, not from what kind
  of layer this is. A lone virtual loader now takes hardware like the host does; ≥2 (the measured 3-way
  starvation shape, host + 2) still takes software. Verified from a clean `git worktree` checkout, not
  the working tree.
- **Location error, corrected.** The founder's own check pointed at `WebglMediaLayer.tsx` (`preferSoftware`
  found there via grep) as I-44's site. That file only *consumes* the value (`preferSoftware:
  props.preferSoftwareDecode`) — the decision lives in `VideoPreview.tsx:3767` (now `:3786`), which is
  where it was fixed. Same lesson as the epoch-pattern correction two entries up: **a grep hit names where
  a symbol is read, not where it is decided** — check the assignment site, not the first match.
- **I-48 is DEFERRED, not scheduled.** Slice B2 (within-comp/sibling virtual-layer discrimination) is real,
  unscoped design work — a new per-node contribution channel `TimelineLayer` does not have — for a defect
  nobody has shown causes harm. That is exactly ADR-020's own dissolution shape. It is not designed here.
  **Trigger, not a deadline:** if the large real-project measurement (see the measurement plan, filed
  alongside this entry) shows sibling virtual layers on one Flarex host actually contending, B2 gets
  scoped and sized from that finding. If it does not, B2 dissolves on the same grounds as I-49/I-50/I-54.
- **The slice-B collision's root cause, as a class, not just a correction.** A document said "proposed and
  unimplemented" and was believed over `git log` for three days across three later documents. Documents
  drift; the repo is the subject. Same family as the fourth DEBT-012 shape above — for anything that ships
  as a commit, the artifact of record is the commit, never a paragraph that once described it correctly.

**CORRECTION (2026-08-08, same day) — "C16 and I-44 satisfied" above is too strong on I-44.** Caught by the
founder reading `37ed422` itself rather than the claim about it. The shipped condition is:

```
(flarexSwDecodeOverride() ?? true) && isFlarexVirtualLayerId(layer.id) &&
flarexConcurrentLoaders > 1 && flarexLoaderRate(layer) <= 1
```

`isFlarexVirtualLayerId(layer.id)` — **source identity — is still a conjunct.** A contention term was added
beside it; the identity term was never removed. Against I-44 as originally written ("Capability selection
is a function of rank and declared need, **never of source identity**") that is not satisfied, and this
register said "satisfied" without stating the interpretation it depended on.

**Resolved by amending the invariant, deliberately and in writing** — ADR-013 §6 now carries **I-44a**,
which distinguishes identity *scoping* a capability rule (permitted; every rule needs a domain, and a
domain is necessarily expressed in terms of what a source is) from identity *deciding* a backend
(forbidden, unchanged). Test: hold identity fixed, vary declared need — if the backend still changes,
identity is scoping. `preferSoftwareDecode` passes it now (hardware when alone, software when contending)
and would have failed it before `37ed422`.

**Why this is recorded loudly rather than absorbed:** an invariant reinterpreted to fit shipped code is
precisely the failure mode this programme exists to catch, and the fact that the reinterpretation is (I
believe) correct does not exempt it from being written down. Anyone who rejects I-44a should read ADR-013
as **not** satisfying I-44. **Second-order lesson, of a piece with the two above:** I verified the fix
against the *invariant's intent as I understood it* and reported "satisfied" — without re-reading the
invariant's actual text against the actual shipped conjunction. Same shape as verifying the working tree
instead of the committed blob, and as believing a document over `git log`: **the artifact of record was
right there, and the check was run against a paraphrase of it.**

**MEASURED, AND FALSIFIED (2026-08-08, later the same day). ADR-013 REOPENS — "complete as scoped" is
WITHDRAWN.** The real-project measurement ran, 3 cold arms at `14b66dc`. The unmeasured constant named
below was tested and **failed, 3/3**. Readings, identical in every arm: with a clean baseline immediately
before Host C's `== 1` regime (`capMisses 0`, `starvedSources 0` at t≈76.78), the regime showed
`F1_capMissOnset = 2` and `F4_starvedOnset = 1`, with `activeSoftware = 0` throughout — the lone loader
took hardware as the new rule intends, and something starved for it.

**The sharper consequence:** every cap miss in the whole 90s project occurs inside the lone-loader window.
Host A's three siblings produced zero. The only contention this project generated is contention the fix
introduced. C16 and I-44's "satisfied" status is **withdrawn**.

**L11 held.** An ADR is a hypothesis until a measurement it could have failed has survived it; this one
did not. That is the process working, not a setback, and it is recorded without softening.

**The tension that constrains the fix, stated plainly:** reverting to the old behaviour (any virtual
loader → software) **re-breaks I-44a** — a `> 0` threshold is always true for a virtual loader, so the
count decides nothing and the hold-identity-vary-need test fails. **Safety and I-44a conflict; safety
wins. I-44 returns to UNSATISFIED until a threshold exists that is both safe AND varies.**

**Not yet attributed.** Falsifying "a lone loader is safe on hardware" is not the same as showing
`37ed422` caused it. The counterfactual (same fixture at `> 0`, 3 cold arms) is pre-registered in
`plans/adr-013-real-project-measurement-plan.md` §7 and **no fix is chosen until it reads**.

**Two measurement defects found in the run itself, both recorded rather than absorbed:**
1. **F2 caught prospectively — the falsifier could not have fired.** Scope C's original window (78–90s)
   was drawn to be "decode-clean," which excluded the only moment the defect can manifest (Host C's
   preroll overlap, 76.8–78.0, where both cap misses land). F1 measured from 78.0 read 0 while the event
   had already happened; F4 was a level, so it fired on starvation inherited from earlier in the run.
   Found by running the fixture **once without measuring**, and corrected in `14b66dc` **before any arm
   ran**. Standing lesson: run a new fixture once as a non-measuring validation pass, specifically to ask
   whether the pre-registered reading *could* fire.
2. **Scope A's junction claim is VOID, not clean.** `active = 0` across the whole predicted peak window
   means WebCodecs never engaged there — the probe pressed play before routing flipped, ignoring this
   repo's own `awaitWebCodecsEngaged` / read-`__rfRouting`-first rule. Its counters characterise a warming
   system, not an ordinary project. Scope B is correspondingly weak (siblings were software by design) and
   **I-48/B2 is NOT dissolved on it**. Open question: `samplesWithTwoPlusNonElement` read 273/277/**143**,
   localised to Host A — concurrent sibling WebCodecs engagement lasted ~17s in cold1 but ~0.9s in cold3,
   a ~19× run-to-run difference in decode routing stability between nominally identical cold arms.

**Original entry, retained for the record:** ADR-013's completion rests on **one unmeasured
constant** — the `> 1` threshold itself. What is measured is that ≥3 concurrent hardware consumers starve
(2026-07-27). What is *not* measured is that a lone virtual loader is safe on hardware, which is the case
`37ed422` newly created. Falsifier and resolution path are recorded in
`plans/adr-013-scope-after-adr-020.md` (§"Two qualifications on 'complete'") and
`plans/adr-013-real-project-measurement-plan.md` (§5, Scope C).

**UPDATE (2026-08-10) — a Flarex-side demand-reduction fix shipped (`ac0d9f2`, following `680ddfc`). It
changes the PARKED verdict's evidence, not the verdict itself, and mechanism B is refuted on new
measurement.**

**Clause (a) is still unmet as written, and remains so — stated plainly rather than claimed satisfied.**
"A source denied at mount is subsequently admitted" requires an admission that happened *after* a denial.
Nothing on the branch produces one. What `ac0d9f2` changed is upstream of admission entirely: an
unreachable Flarex loader (one that feeds no node the viewer is showing) is now ranked `preload` whenever
it is unreachable, not only while playing, so on the measured fixture it loses its slot to a starved
reachable source *before* a denial is ever recorded. `starvedSources` reads 0, the denied registry is
empty, and the starvation probe returns `{"skipped": "no starved source"}` — clause (a) has no subject to
satisfy on this fixture, which is a different fact from the subject having been satisfied. The distinction
matters the first time a fixture produces a denial this change cannot prevent (more starved sources than
there are unreachable loaders to preempt, for instance) — clause (a) will be exactly as unmet then as it
is today.

**Mechanism B (2026-08-07, above) is refuted, not superseded — the trigger and the permission were never
the problem.** That verdict rested on a pre-registered instrument reading 36 boundary-reaching events/arm,
~15-21 blocked on `isAdmissionEligible` false, 0-2 passes — support for "the trigger and the permission
almost never coincide." Direct re-measurement (2026-08-09/10, `admission-eligibility-duty-probe.ts`, both
the real 7-MediaIn fixture and the synthetic 6-of-4 census rig, same instrument, same session) found the
opposite:

- Eligibility duty cycles ran 13.6-100% across sources and fixtures.
- Boundary coincidence: **28/28** (real fixture) and **25/25** (census fixture) driven transport boundaries
  landed while at least one starved source held a permission.
- 30 re-ask attempts across four pre-fix runs, **every one** holding a live `isAdmissionEligible` permission
  at the moment of the attempt.
- Grants: **0 of 30.** `reserveSession` found no preload-priority victim to evict, because 680ddfc's
  demotion was gated on `isPlaying` and slice D's re-ask trigger fires exactly when `isPlaying` is false
  (paused, or just-seeked) — the two were mutually exclusive by construction, not by rarity.

So the trigger and the permission coincide constantly; what was missing was a victim for `reserveSession`
to find. `ac0d9f2` supplies one. This is a different mechanism than mechanism B named, not a refinement of
it — the 2026-08-07 measurement is not wrong on its own numbers, but the explanation it supported does not
generalize to this fixture, and should not be cited as evidence against a re-ask mechanism in general.

**A residual mismatch, unaddressed: eligibility is gated on free capacity, not on an available victim.**
Grants require `sessionCap(3) − activeSoftware > 0` (`preview-frame-pool.ts`'s recovery sweep). In the one
observed saturated run (`activeSoftware 3`, no free software slot) duty cycle read **0%** across all three
starved sources and time-to-first-grant was **never**, for the full sampling window. `ac0d9f2`'s preemption
happens at ACQUIRE time and does not depend on this gate — but eligibility-driven recovery still does, and
the two mechanisms were not measured together under saturation. Whether `ac0d9f2` closes this gap or merely
sits beside it unmeasured is open.

**A failed re-ask costs 12-30s of permission.** `noteDenied` clears `record.eligible` on every re-denial by
design (C-D4, prevents the terminal from being unreachable for sources that retry often); regrant needs a
release event, and the deliberately-failed re-ask fired this round to test that path took 12.4-14.0s to
regrant on the census fixture and did not regrant at all within a 30s window on the real fixture (one arm).
Not a problem while the first attempt succeeds — `ac0d9f2` makes that the common case on the measured
fixture — but a sharp non-linearity if a re-ask ever fails after this: the next several seconds to tens of
seconds see a source that COULD retry sitting out because its permission was just spent and refused.

**Open, not measured: no run in either round landed at `activeSoftware 3`.** All five valid post-fix runs
and both pre-fix runs settled at `activeSoftware 2` (one free software slot). Whether `ac0d9f2` helps, does
nothing, or costs a thumbnail at `activeSoftware 3` — where a preempted loader has nowhere to land — is
unknown. This is the same run-to-run software-pool instability already recorded as **DEBT-014 blocker 2**
(concurrent WebCodecs engagement varying ~19× between nominally identical cold arms); it is not a new
finding, but it is the reason this round could not close the question it was measuring.

**Status unchanged: open — PARKED.** The three blockers from 2026-08-07 are not all resolved. Blocker 3
(comp-proxy site cannot be tracked across attempts — `useFlarexCompProxies` mints a fresh blob URL per
re-ask) is untouched by `ac0d9f2`, which is a `WebglMediaLayer`-site-only change. Blocker 1 ("clause (a)
remains unsatisfied") is reworded above, not closed. Blocker 2 ("F's detector is rejected") is unaffected —
`ac0d9f2` does not touch the shared boundary-detector question at all.

**PHASE 1 READ (2026-08-12) — batched with DEBT-014 and DEBT-018. Three defects, not fewer. This one
does NOT reproduce today and is NOT closed, and those are different sentences.**

**Does it reproduce?** No, on the measured fixture — and the 2026-08-10 update already says why, in
the right words: `ac0d9f2` removes the *denial*, not the *defect*. An unreachable Flarex loader is now
ranked `preload` whenever it is unreachable, so a starved reachable source preempts it before a denial
is ever recorded; `starvedSources` reads 0, the denied registry is empty, and the starvation probe
returns `{"skipped": "no starved source"}`. Clause (a) has no subject on that fixture. **The mechanism
underneath is untouched**: nothing added a path from `element` back to a session for a source that was
genuinely refused, so the first fixture that produces a denial `ac0d9f2` cannot prevent will reproduce
this exactly as it stood. Verified on this branch: `ac0d9f2`, `680ddfc`, `37ed422`, `14b66dc` are all
ancestors of HEAD.

**The remedy the entry's own header names is no longer the operative one, and that should not be
rediscovered.** *Planned slice: ADR-020 §5 slice A* and the whole 2026-08-07 "the trigger and the
permission rarely coincide" reading were refuted by the 2026-08-09/10 duty-cycle measurement in this
entry (boundary coincidence 28/28 and 25/25; 30 re-ask attempts, every one holding a live permission;
grants 0 for want of a victim, not of a trigger). A reader who stops at the header will build the wrong
thing. Header and body disagree; the body is correct.

**Current code state, checked rather than assumed:**
- D's re-ask trigger is present and is the ORIGINAL React-render-gated inline effect
  (`WebglMediaLayer.tsx:1098-1116`, deps `[mediaType, src, transportTime, transportPlaying]`).
- Slice F's shared boundary detector **is not in the tree, on this branch or in its history**.
  `admission-reacquire.ts` and `kernel-conformance.ts` do not exist under `apps/web/src`. F was
  preserved as a design artifact in `1ffc898` (zero consumers, per L13) — and that commit is **not an
  ancestor of this branch's HEAD**, so on `method-3-gpu-compositor` the module is absent outright, not
  merely unused. Any plan that assumes a shared predicate exists here is wrong.
- Blocker 3 is intact and unchanged: `useFlarexCompProxies.ts:331` still does
  `URL.createObjectURL(stored.blob)` per attempt, so that acquire site still has no stable identity for
  a permission to attach to across a re-ask.

**What instrument would show it failing — and the entry's existing ones would NOT, today.** The
readings are all present and unconditional (`__rfWcPool.starvedSources` / `starvedLongestMs` /
`capMisses` / `admissionRecoveries` / `admissionPermanentDenials`, plus `__rfWcMode`); what is missing
is a fixture that still denies. The instrument is therefore a FIXTURE requirement first:

> **Every MediaIn must feed a node the viewer is showing** — so `ac0d9f2` has no unreachable loader to
> preempt — with more such sources than the hardware cap (`MAX_WC_SESSIONS = 3`). Five or six reachable
> sources on a 3-slot pool. A comp built from off-screen or unrouted loaders will read `starvedSources 0`
> and prove nothing, which is exactly what the current fixture now does.

Then the failure signature is: `capMisses > 0` **and** `starvedSources` sustained > 0 **and**
`admissionRecoveries` 0 across ≥2 driven transport boundaries, with the same urls on `element` in
`__rfWcMode` throughout. Report all four; a zero in any one of them alone is unattributable between
"never denied", "denied and recovered", and "the instrument never looked" — the failure mode this entry
has already hit three times by its own count.

**An instrument that shows it already exists and runs on every `wc:gate` — this was not known.** The
decoder gate's pool scenario forces a denial synthetically (preload A+B take the spare slots, C is
refused at the reserved slot, a playhead lease preempts), and its accounting dump on a PASSING run
today reads:

```
capMisses 2 · starvedSources 1 · admissionDenials 1
capacityFreedWhileStarved 3 · capacityFreedMatchingPool 3
releaseGrantEvents 1 · releaseEligibilityGrants 1 · releaseLeftUnpermitted 0
admissionRecoveries 1
admissionReacquireAttempts 0 · admissionReacquireGrants 0
```

Slice E's half works — capacity freed while starved, a permission granted, nobody left unpermitted.
**`admissionReacquireAttempts 0` is clause (a) unmet, observed live, on a gate that runs in CI-style
verification rather than on a hand-built census rig.** A permission was granted and no re-ask was ever
made against it. That is a cheaper starting instrument than the fixture described above: it already
denies, it already grants, and the one counter that would have to move for this entry to retire is
already being printed and is already zero. What it cannot show is the *product* consequence — these
are pool leases, not layers with a `<video>` fallback and a visible picture — so the reachable-MediaIn
fixture is still needed for clause (a) proper. Two instruments, cheap one first.

**Not the same defect as DEBT-018** — see the comparison table appended to that entry. Same visible end
state, different decider, different gate, different status; and DEBT-018's A1 is the only observed proof
anywhere that `wcReacquireEpoch` re-acquires successfully, which locates this entry's gap upstream of
the vehicle rather than in it.

**UPDATE (2026-08-12) — the counter is now an ASSERTION, and it has been seen failing. Still open.**

The phase 1 read found that `wc:gate` already denies synthetically and already prints
`admissionReacquireAttempts 0` on a passing run. That reading has been turned into a check rather than
a fixture (`WcDecoderGatePage.tsx` `runReadmissionChecks`, asserted in `wc-decoder-gate.ts`), and it
runs on every `wc:gate`.

**The preconditions are the substance, not the counters.** `attempts 0 / grants 0` is the same reading
in three different worlds — never denied, denied and refused, or nobody asked — and this entry has
already been burned three times by exactly that ambiguity. So the gate now asserts, in order:

```
re-admission precondition: the source was really denied        capMisses=2 starved=[…#other]
re-admission precondition: freed capacity granted a permission eligible=true grants=1 leftUnpermitted=0
re-admission precondition: nothing had re-asked yet            attempts=0 grants=0
denied source is RE-ADMITTED on its permission                 lease=true provider=true frame=true
the re-ask is attributed, granted, and leaves the starved reg.  attempts 0→1 grants 0→1 starved=[]
```

A DECODED FRAME, not a lease handle, is what closes it — a counter that moves while nothing decodes is
the class of evidence this entry keeps being misled by. The node side additionally asserts all five
checks are PRESENT, because `every(ok)` is silent about a check that was deleted, and this one guards a
defect that does not currently reproduce.

**Falsified before being trusted.** With the pool temporarily refilled before the re-ask (token
`TEMPORARY-DEBT013-FALSIFY`, reverted, zero grep matches), the gate went red in precisely the intended
shape: the three preconditions stayed GREEN, `attempts 0→1` (the ask was made and attributed) and
`grants 0→0` (it was refused), source still starved, exit 1. That is the discrimination the entry
needs — a refused re-ask is now distinguishable from an absent one, by measurement rather than by
argument.

**What this does and does not settle.** It settles that slice D's vehicle is sound at the POOL level:
a source denied at acquire, granted a permission when capacity freed, re-asking through the ordinary
acquire path, is admitted and decodes. It does NOT settle clause (a), which is about a LAYER with a
`<video>` fallback and a visible picture; these are pool leases with no layer, no element and no
`wcReacquireEpoch`. The reachable-MediaIn fixture named in the phase 1 read is still what clause (a)
needs, and this entry stays **open** for it. What changed is that the pool half is now guarded in
CI-style verification instead of being re-derived by hand each time.

**Slice F's shared detector is absent from this branch — recorded here so it is not built twice or
never.** `admission-reacquire.ts` / `kernel-conformance.ts` do not exist under `apps/web/src`;
`1ffc898` (which preserved F as a zero-consumer design artifact) is NOT an ancestor of
`method-3-gpu-compositor`. Any plan for this entry that assumes a shared boundary predicate exists
here is wrong, and work sitting on an unmerged branch is exactly how a defect gets fixed twice or not
at all.

**SLICE F IS REFUTED, NOT MERELY ABSENT — read 2026-08-13, recorded so nobody re-derives it.** The
note above says where F is. This says whether to bring it back, which is the question a reader
actually arrives with, and the answer is no.

`1ffc898` contains exactly one file, `apps/web/src/playback/admission-reacquire.ts` (99 lines, zero
consumers): the pure predicate `isTransportBoundary(previous, next, playing)` with
`SEEK_DISCONTINUITY_S = 0.5`, and `useTransportBoundary(playing, onBoundary)` driving it from
`subscribePlaybackClock` as a CALLBACK rather than a `useState` epoch. Its stated purpose was one
boundary definition consumed at BOTH acquire sites, replacing D's per-site inline effect.

**Its rationale is refuted by this entry's own measurement.** F's case rested on mechanism B — D's
React-render-gated trigger and slice E's permission "almost never coincide", so a clock-driven
detector would fire where D's did not. The 2026-08-09/10 duty-cycle probe measured the opposite and
is recorded above: boundary coincidence **28/28** (real 7-MediaIn fixture) and **25/25** (synthetic
6-of-4 census rig), with all 30 re-ask attempts holding a live `isAdmissionEligible` permission at
the moment of the ask. The trigger and the permission coincide constantly. Grants were 0/30 for want
of a **victim** for `reserveSession` to evict — which is what `ac0d9f2` supplies, at acquire time,
via `preemptible`. A faster or better-placed boundary detector would not have moved that number by
one.

**And `ac0d9f2` does not intersect F.** Checked rather than assumed: `ac0d9f2` touches
`VideoPreview.tsx` and `WebglMediaLayer.tsx` only — a new `preemptible` prop joining the existing
`hidden || suspended` demotion effect, ungated by playback. It changes lease PRIORITY at the pool,
not when or whether a boundary is detected. Nothing in it reads `isTransportBoundary`,
`subscribePlaybackClock`, or D's detector body. So F is neither obsoleted nor validated by it — F
was aimed at a mechanism that measurement says was never broken.

**Disposition: NOT cherry-pick, NOT port, NOT re-derive — for the `WebglMediaLayer` site.** D's
original inline detector is present and correct at `:1098-1116`, and swapping it for F's hook was
already rejected once on the mechanism-B evidence (2026-08-07). Re-landing it now would be a
behaviour change with no defect behind it. A stale fix carried forward is worse than an absent one,
and this one would also re-open the `created 11→13-14 / preload 3→0` question whose own framing this
entry has already had to retract.

**DEBT-013's REMAINING HALF IS PARKED WITH A TRIGGER (2026-08-13), not scheduled.** Founder call.
The pool half is closed and guarded in CI (`wc:gate`, five checks, falsified). What is left is
clause (a) at the LAYER, and the only site still lacking any re-ask trigger is the comp-proxy one —
blocker 3, unchanged since 2026-08-07: `useFlarexCompProxies.ts:331` mints a fresh
`URL.createObjectURL(stored.blob)` per attempt, so a granted permission has no stable identity to
attach to across a re-ask. **That is an identity problem, not a trigger problem**, which is exactly
why F's second half was never observed firing (`comp-proxy re-asks 0` on every run in this
programme, before and after F, including with three permissions outstanding). Landing a boundary
detector at that site now — F's or a new one — builds finished-but-unused infrastructure ahead of
its consumer, against the standing directive, and would produce another mechanism that cannot fire
for reasons unrelated to itself.

> **Trigger: an identity slice for the comp-proxy acquire site exists** — a waiter identity that
> survives blob-URL churn across attempts. Until then this entry stays open and unworked. When it
> lands, the boundary predicate is a small piece of that slice's own work, and `1ffc898` is worth
> reading for its SHAPE (one predicate, delivered by call not by re-render-triggering state) even
> though its rationale is dead.

**GENERALIZATION (2026-08-13), found building ADR-021 step 2 and stronger than this entry's original
claim.** DEBT-013 as registered is about the SESSION pool specifically — "a source denied a slot at
mount is never re-admitted". Building `apps/web/src/playback/flarex-source-providers.ts` (a BYTE
budget, no sessions, no cap) reproduced the identical shape inside its own fix, at first construction:
a comp mounting 12 MediaIns in one tick started 12 constructions together, each holding a PROVISIONAL
charge before its real size was known, none yet evictable (nothing was live to evict), and the budget
had no move left but to refuse — 9 of 12 denied, with the budget sitting at 757 MB of 768 MB and
`evictions: 0`. Session count was never the cause; **the cause is any admission authority judging a
BURST of simultaneous requests against a budget that starts empty**, and a byte budget is exactly as
exposed to it as a session cap. Work in progress on `artifact/adr021-step2-pullseam`; not retired here,
because the seam itself has not shipped and this entry's own pool half is unaffected. Recorded so the
next thing that admits under any kind of budget — the frame cache's I-P9 eviction, a future GPU-memory
budget — starts from "serialize or stagger the burst" instead of re-discovering it.

**UPDATE (2026-08-15) — ADR-021 step 2 SHIPPED, and clause (a) is gone AT THE FLAREX ACQUIRE SITE.
Read the scope narrowly: this does not retire the entry.**

The seam landed and passed its own acceptance on a real editor (`flarex-loader-ceiling-probe.ts`, 12
distinct real renders bound as asset-source `MediaIn`s on one comp, wired through a Merge chain to
`MediaOut`, real Chrome, both arms on the identical fixture):

| arm | rendering | admission |
|---|---|---|
| session pool (BEFORE) | 3 of 12 | `capMisses 29`, 9 loaders → `<video>` |
| byte-budgeted seam (AFTER) | **12 of 12** | **0 denials, 0 element fallbacks**, 0 evictions, peak 706 MB / 768 MB |

**Why this is a removal rather than a recovery, which matters for how the entry retires.** Clause (a)
asks that a source denied at mount be *subsequently admitted*. The seam satisfies it by making the
denial not happen: there is no session, no slot, and therefore no mount-order lottery to lose. Every
mechanism this entry catalogues — aging that is structurally inert, no post-storm decision point,
`MIN_RESIDENCY_MS` converting arrival order into protected incumbency — is about arbitrating scarce
SESSIONS, and at this acquire site there are none to arbitrate. That is a stronger fix than the retry
path slices D/E/F chased, and it is why none of those mechanisms had to be repaired to get here.

**What remains open, unchanged.** (1) The TIMELINE still acquires through `preview-frame-pool` and its
caps are correct there and deliberately not relaxed — ADR-021 step 4 is where that changes, and it is
not scheduled. (2) The comp-proxy acquire site (`useFlarexCompProxies.ts`) still mints a fresh blob URL
per attempt, so blocker 3 — the identity slice — is untouched; the trigger recorded at the top of this
entry stands. (3) Nothing here revisits D/E/F: they remain rejected/parked on their own evidence.

**One defect this step FOUND by removing the ceiling, fixed in the same commit.** With all 12 loaders
finally holding providers, a pre-existing dropped-request path became reachable at scale:
`WebglMediaLayer.requestWcFrame`'s `wcProviderRef.current !== provider` guard correctly discards a frame
whose provider the layer no longer holds, and then re-asks for nothing — so the layer waits on a request
only the playback rAF loop would ever re-issue. PAUSED there is no such loop, and the loader stays dark
forever. Attributed on a one-line control, paused, single variable: **without the re-arm 1 of 12 render
(host substitutions 1854); with it 12 of 12, all coherent at `staleMs 0` (substitutions 79).** Fixed on
the consumer's path per DEBT-009's rule — a paced `scheduleWcRerequest()` — not by exempting the
provider from the identity check. **The ceiling had been hiding it:** under the pool the 9 losing
loaders were denied a provider and took the `<video>` path, so they never reached the race. Worth
recording as its own small class — *removing a limiter exposes the paths its victims never used to
reach* — because steps 3 and 4 will remove two more.

### DEBT-014 — the host clip loses the hardware decode block at mount, regardless of any threshold

- Status: **RETIRED 2026-08-12** (see the closing update at the end of this entry)
- Registered: 2026-08-08, from the ADR-013 real-project measurement and its counterfactual
- Invariant affected: none directly; this is the defect the `preferSoftwareDecode` rule has been arguing
  *around* rather than addressing.
- **Header updated 2026-08-13:** Status was "open — PARKED, deliberately not chased (2026-08-08)"
  from registration through the 2026-08-12 phase 1 read. See `README.md`, "State fields vs.
  history."

**The finding, in one line: Host C's host clip is routed to `element` in every arm of BOTH conditions —
6 of 6 runs, at `> 1` and at `> 0` alike.** The threshold changes which engine the *loader* gets
(`wc-hw` under `> 1`, `wc-sw` under `> 0`); it never changes the host's outcome. The host loses the
hardware block at mount either way.

This is the same shape as the 2026-07-27 report the software-decode rule was originally built for ("host
frozen, loaders playing" — `preview-frame-pool.ts:91–101` records it), which means that rule has been
mitigating a symptom whose cause is still present. Every threshold argument in this programme has been
conducted downstream of it.

**Evidence** (`tmp/adr013-real-project/{cold,old}{1,2,3}.json`): in Host C's regime all six runs show
exactly one source on `element` and one on WebCodecs, `active` 0 with `activeSoftware` 1 under `> 0`, and
`active` 1 with `activeSoftware` 0 under `> 1`. The pair never both hold a session.

**Why it is PARKED and not chased now.** It is a real investigation into decoder acquisition ordering at
mount, not a fix; it is not what ADR-013 was reopened for; and the measurement that found it has two known
defects (below) which would confound any attempt to size it today.

**Blockers, precisely:**
1. The probe presses play before WebCodecs routing has engaged (`active = 0` across the predicted peak
   window in all three `cold` arms) — this repo's own `awaitWebCodecsEngaged` / read-`__rfRouting`-first
   rule was not applied. Any timing claim about mount is unsound until it is.
2. Run-to-run routing instability is unexplained and large: concurrent sibling WebCodecs engagement lasted
   ~17s in `cold1` vs ~0.9s in `cold3`, and `old2` established **no** hardware WebCodecs session at all
   during playback while `old1`/`old3` did. Until that is understood, two runs of this fixture are not
   comparable.

**Trigger (not a schedule):** investigate when either a user-visible host freeze on a Flarex clip is
reported, or the ADR-013 fixture is re-run with an engagement gate and the instability in blocker 2 is
resolved — whichever comes first.

**PHASE 1 READ (2026-08-12) — batched with DEBT-013 and DEBT-018. Stays PARKED, and its evidence is
now stale for a third reason nobody has recorded.**

**Does it reproduce?** Unknown, and cannot be answered from the existing evidence. The entry rests on
`tmp/adr013-real-project/{cold,old}{1,2,3}.json`, and those artifacts are **not in the tree** (the
`adr013-real-project` directory is absent under `apps/worker/tmp`), so the six runs cannot be
re-examined either.

**The two blockers the entry names are still open, and there is now a THIRD.** Blocker 1 (the probe
pressed play before WebCodecs engaged) and blocker 2 (run-to-run routing instability ~19×) are
unchanged. The new one: **the evidence predates `ac0d9f2` (2026-08-10) by two days**, and `ac0d9f2`
changes precisely the competition this entry says the host loses. It adds a `preemptible` prop, ungated
by playback, that demotes an unreachable virtual loader to `preload` — which is a victim
`reserveSession` can take at acquire time, on behalf of exactly the kind of source this entry watches
being refused. Whether Host C's host clip still lands on `element` in 6/6 arms after that change is
unmeasured. **Any re-run must therefore be a fresh measurement, not a comparison against the recorded
numbers.**

**The routing rule itself is unchanged**, checked directly: `VideoPreview.tsx:3857-3862` still reads
`(flarexSwDecodeOverride() ?? true) && isFlarexVirtualLayerId(layer.id) && flarexConcurrentLoaders > 1
&& flarexLoaderRate(layer) <= 1`. So the `> 1` threshold this entry was written *around* is intact and
its "unmeasured" caveat still stands.

**Is it an instance of DEBT-013? Probably not — and here is the discriminator, which is one reading
nobody has taken.** The pool's caps are `MAX_WC_SESSIONS = 3` hardware, `MAX_WC_SOFTWARE_SESSIONS = 3`,
`MAX_WC_TOTAL_SESSIONS = 4`, `HARDWARE_RESERVED_SLOTS = 1` (`preview-frame-pool.ts:90-119`). Host C's
regime is **two** decode consumers — the host and one loader. Two against a 3/3/4 budget cannot be a
capacity refusal, so the host's `element` routing is very unlikely to be an admission denial at all,
which would make this a different defect from DEBT-013 rather than an instance of it. That is an
inference from the constants, not a measurement, and the measurement is cheap:

> **Read `__rfWcPool.capMisses` and the denied registry at the moment the host lands on `element`.**
> `capMisses` 0 with the host on `element` ⇒ nothing refused it ⇒ this is an acquisition-ORDERING or
> attach defect, and the two entries stay separate. `capMisses` > 0 ⇒ the host was genuinely denied
> ⇒ this collapses into DEBT-013 and should be merged rather than chased alone.

Any such run must also fix blocker 1 (`awaitWebCodecsEngaged`, read `__rfRouting` before pressing play)
and answer blocker 2 by reporting a distribution over ≥3 arms rather than a mean — this repo's own
measurement-preconditions rule, and the reason the original six runs cannot be trusted.

**Trigger unchanged, and deliberately not converted into a schedule here.** It remains: a user-visible
host freeze on a Flarex clip, or an ADR-013 re-run with the engagement gate and blocker 2 resolved.

**RETIRED 2026-08-12 — the reading was taken, and the regime does not reproduce. Scope stated below.**

The discriminating reading this entry specified has been taken, on a fresh fixture, with all three of
its own blockers addressed (`apps/worker/tmp/debt014-host-routing-probe.ts`). Host clip on one file, a
Flarex MediaIn bound to a DIFFERENT file — two decode consumers, which is Host C's regime — sampled at
250ms from mount through 12s paused and 12s playing, in three independent arms.

```
arm 1/2/3   host modes seen: wc-hw   (never element, paused or playing)
            loader: <second seed>=wc-hw          playhead advanced 6.0s under play
            capMisses=0  admissionDenials=0  starved=0  active=2/sw0
usable arms 3/3 · host reached 'element' with a loader present: 0/3
```

**Pressing Space is an input, not a result**, so the playing half is gated on the playhead having
actually moved (`__rfClock.committed`, ≥0.5s or the arm VOIDs; 6.0s observed in all three). A keypress
that lands on a focused control leaves the transport parked and the "playing" window becomes a second
paused window wearing a label — the same class of void as blocker 1, and it would have gone unnoticed
here because the verdict is a NEGATIVE finding, which a dead window produces for free.

**Blockers, each answered rather than noted.** Blocker 1: `awaitWebCodecsEngaged` gates the run and a
failure to engage is a VOID, not a number — so no claim here is made about a subsystem that had not
started. Blocker 2: three arms are printed individually and the verdict is only taken where they
agree; they agreed exactly. Blocker 3 (the one added by the phase 1 read): the evidence predating
`ac0d9f2` cannot be compared to, so this is a fresh measurement and is reported as one — no number
here is set against the recorded 6/6.

**On the merge question: not an instance of DEBT-013, and now on evidence rather than on constants.**
Strictly, the discriminator's antecedent never occurred — the host never landed on `element`, so
"capMisses at that moment" has no moment. That is itself the answer to the entry: with two consumers
against a 3/3/4 budget, `capMisses` stayed 0 for the whole run, no denial was recorded anywhere, and
BOTH consumers held hardware sessions simultaneously (`active=2/sw0`). There is no refusal for this
entry to be an instance of. The phase 1 inference from the cap constants is confirmed by measurement;
the entries stay separate.

**SCOPE, and it is a real limit.** This is a two-consumer minimal reconstruction, not Host C's project
— those artifacts are gone from the tree and cannot be recovered. So the honest claim is: *the
described regime does not reproduce on a current fixture built to its own specification.* It is not a
proof that no real project can put a host clip on `element`. Retired on non-reproduction, which the
register treats as different from "fixed": nothing was changed to make this go away, and `ac0d9f2` is
the most likely reason it is gone.

**Re-registration trigger, unchanged in substance and now cheap to act on:** a user-visible host freeze
on a Flarex clip. The probe is in the tree; re-running it is the first step, and if the host does land
on `element` its `@host=element` row prints the census at that instant, which is the reading this
entry existed to obtain.

**Two probe defects found and fixed while taking this reading**, both of the class that produces
confident wrong numbers rather than errors, and both recorded because the next probe author will meet
them: (1) `addMediaInBoundTo(page, 1)` bound the MediaIn to the HOST's own asset — asset-bin tile
order is not import order — producing the one-file-two-doors SHARE the fixture header explicitly rules
out, and a clean-looking 3/3 result from a fixture in which no denial was ever possible. The fix picks
the tile by NAME, and a second guard now asserts on the measurement itself that the loader's asset is
not the host's, so that mistake VOIDS instead of answering. (2) tsx compiles with `keepNames`, which
wraps a function-valued `const` inside `page.evaluate` in a `__name()` helper that does not exist in
the page — every arm reported VOID with `__name is not defined`. Loud, so it cost minutes rather than
a conclusion, but worth knowing before writing the next evaluate.

### DEBT-015 — CLASS: an error path that reports COMPLETION, so a failure ships as product output

- Status: **open** (registered as a CLASS. As of 2026-08-10: **both known scopes are fully audited
  and every identified live instance is fixed** — worker/Remotion export (`SceneStage.tsx`,
  instances 1/2/4 fixed, instance 3 and the stale-handle row measured dormant) and browser/local
  export (`apps/web/src/export/`, one live instance plus three ambiguous rows, all fixed, including
  the 20s audio-mixdown budget replaced by measurement). Left **open** rather than flipped to
  retired: the expiry condition names "the export pipeline," broader than the two directories
  audited — the API-layer mock processing service is explicitly out of scope per CLAUDE.md, not
  evidence the class is closed — and retiring a CLASS entry on a shrinking instance count is a call
  left to the founder rather than inferred here.)
- Registered: 2026-08-09 (from an intermittent `render:compare:pixels` failure)
- Reason: an export's error handler had exactly one job it could not do — there is no safe degraded
  output for a render. Faced with a composite that threw, `SceneStage.tsx` set `complete = true` and
  released the `delayRender()` handle, so **Remotion was told the frame was finished**. It wrote
  whatever was in the canvas — nothing — and the process exited **0**. The compromise was not
  carelessness: `complete = true` prevented a `delayRender()` timeout from hanging the export. The
  author chose "ship something" over "hang", and the third option — *fail* — was not taken.
- Invariant affected: none named yet. The rule this violates is **a process that exits 0 asserts its
  output is valid**; the runtime had no invariant saying so, which is why nothing caught it.
- Owner: unassigned
- Expiry condition: no error path in the export pipeline releases a render handle, or reports
  completion, for work that did not succeed — for EVERY such path, not only the composite one
- Planned slice: none. Instance 2 below is the next unit of work.
- Tracking issue: —
- Detection: **a `catch` that sets a success/completion flag.** Concretely, in any Remotion component:
  a `continueRender()` reachable from a `catch`, or any assignment of a completion variable inside one.
  The grep is `catch` within a few lines of `continueRender` or `complete =`.
- **Header updated 2026-08-13:** Status previously froze at the 2026-08-09 exhaustive-audit state
  and did not reflect the 2026-08-10 update that fixed every remaining ambiguous row in the
  browser-export scope (the "Status line NOT changed" note inside that update was a deliberate
  choice under the old convention, not an oversight — reworded now that the convention itself
  changed). See `README.md`, "State fields vs. history."

**How it surfaced, and why it is a production bug rather than a lab curiosity.** `render:compare:pixels`
failed once at `e448b0d` with `flarex-unified-color` at **78.506% (1627901/2073600)** against a 0.500%
bar. The log carried, before any fixture ran, `SceneStage: composite failed` /
`Error: media-renderer: shader compile failed:` with an **empty info log**, through
`SceneCompositor.regionGradeEntry → renderGroupInto → renderFrameCore`. The tell was in the artifacts:
the `remotion-*.png` files were MODIFIED while the `web-preview-*.png` files were **byte-identical** —
the preview rendered correctly and only the export was blank. A re-run passed 53/53. **Only a
comparison gate could see this**; the export itself reported success. A customer would have received a
video with a blank frame in it and no indication anything went wrong.

**Falsifiability, established by breaking the subject (2026-08-09).** A guaranteed compile failure was
injected into `MEDIA_FRAGMENT_SHADER` and `render:manifest` run on the `flarex-unified-color` fixture:

| | before the fix | after the fix |
|---|---|---|
| exit code | **0** | **1** |
| mp4 written | yes, 524073 bytes | **none** |
| exported mp4 frame | **blank white**, 99.99% `rgb(255,255,255)` | not produced |
| still PNG | blank black, `meanLuma 0.00`, 100% `rgb(0,0,0)` | not produced |
| console | `SceneStage: composite failed` ×N, then `[mp4] done` | 3 retries at 150/300/600ms, then the named abort |

The before-case reproduced the reported incident precisely, including the **white** frame. (The still
path blanks to black and the video path to white — same defect, different background; do not treat the
colour as diagnostic.) Injection reverted; `git diff` on `media-shader.ts` empty.

**Instance 1 — FIXED. The composite path (`SceneStage.tsx`).** A failed composite now enters a bounded
ladder — 3 retries at 150/300/600ms with the `delayRender` handle **held**, so nothing is emitted while
retrying — and then calls `cancelRender()` with a named error. The hang requirement that motivated
`complete = true` is preserved: the ladder always terminates, and its total (~1s) sits far inside the
`delayRender` timeout. The shape deliberately copies `ScenePreviewCanvas`'s context-loss ladder
(`MAX_SCENE_REBUILDS` / `RECOVERY_BACKOFF_MS` / `HEALTHY_FRAMES_TO_RESET`) rather than inventing a second
recovery vocabulary. **One deliberate difference:** the preview degrades to the DOM path when its budget
is exhausted, because a viewer showing something slightly wrong beats a viewer showing nothing; an export
has no such fallback, because a wrong file *is* the product. Terminal state here is failure.

**Instance 2 — FIXED 2026-08-09. Update at the end of this entry.**

**Instance 2, as first found — NOT FIXED at the time, and it is the same defect one function away.** `SceneStage.tsx`'s
controller-creation effect catches a `SceneCompositor` init failure, logs
`"SceneStage: SceneCompositor init failed"`, and sets `controllerRef.current = null`. The composite
effect then returns early on `if (!controller) return;` — **before any `delayRender()` handle is
acquired.** So an init failure does not even need to release a handle to ship a blank frame: it never
blocks the frame at all, and every frame of the export is emitted uncomposited, exit 0. This is
instance 1's outcome by a shorter route. It was left alone because the scope of this fix was the
composite path, the observed incident went through `mediaRendererFor` during composite (not init), and
guessing at init-failure semantics unprompted is how a second, differently-shaped recovery path gets
invented. **It is the next unit of work and this entry does not retire while it stands.**

**The GL transient itself is NOT diagnosed, and this entry does not claim it is.** What is known: the
compile failed with an **empty info log** on a context that `gl.isContextLost()` reported as *not* lost —
`media-renderer.ts:108-110` converts exactly that empty-log case to `MEDIA_RENDERER_CONTEXT_LOST` when
the context *is* lost, and that conversion did not fire here. **Memory pressure is a SUSPECT, not a
finding.** The circumstantial support: the same machine produced two Chrome OOM/`networkidle` void runs
of this gate at 3.9 GB free of 13.9 GB with 28 chrome + 34 node processes live, and a user exporting on a
loaded laptop is that condition. Nobody has reproduced the compile failure by applying memory pressure,
and until someone does, "OOM caused it" is a hypothesis with a plausible mechanism and no measurement.

**Why the fix is worth having even though the cause is unknown.** It converts an undiagnosed, intermittent
GPU transient from *silent wrong output* into *a loud, named, non-zero-exit failure*. That is worth having
on its own, and it is also what makes the cause investigable: the next occurrence will announce itself
with the frame number and the underlying error instead of hiding in a PNG nobody diffs.

**Update (2026-08-09) — instance 2 FIXED, and it fails immediately rather than retrying.**

The controller-init catch now calls `cancelRender()` with a named error instead of nulling the controller
and letting every frame emit uncomposited. **Deliberately NOT the composite path's ladder**, and the
reasoning is recorded at the call site as well as here so nobody "harmonises" the two later:

- init runs **once per render**, not per frame — it is not the per-frame transient the ladder exists for;
- the plausible causes (no WebGL2, context creation refused, OOM at startup) are mostly conditions a
  one-second retry cannot change;
- a render that fails at frame 0 costs a queued job that can be re-run; a silent blank export cannot be
  recovered at all. The asymmetry favours failing loudly and early over machinery for a case nobody has
  observed.

Copying the ladder would have invented a second recovery vocabulary for a case with no evidence behind
it. **If init failures are ever shown to be transient that is a new finding and a new decision** — it is
deliberately not pre-empted in code.

Falsifiability, by breaking the subject: `new SceneController(...)` forced to throw, `render:manifest` on
the `flarex-unified-color` fixture. **BEFORE:** mp4 written, exit **0**. **AFTER:** no mp4, exit **1**,
`SceneStage: SceneCompositor init failed — refusing to emit an uncomposited render (DEBT-015)`. Injection
reverted, `git diff` empty, zero grep matches for the token.

**Instance 3 — the unconditional `continueRender` on unmount. DORMANT, measured, deliberately UNCHANGED.**

`SceneStage.tsx`'s unmount cleanup releases `pendingRef`'s handle unconditionally — it does not
distinguish a healthy pending frame from one that FAILED and is mid-ladder. On paper that is exactly what
this entry's expiry condition forbids, and it matches this entry's own Detection rule. **The fix for
instance 1 widened its window**: a failed composite used to resolve in the same tick, so `pendingRef`
essentially never referred to a failed frame; the ladder now holds the handle across 150+300+600ms plus
composite time. Recorded here because the register's Detection field exists precisely to catch a
compromise being deepened *by the PR paying the debt down* — which is what happened, and it was found in
review rather than by the author.

**It is not reachable on the export path**, measured before being left alone:

| condition | mounts | unmounts |
|---|---|---|
| healthy render (still + mp4, exit 0) | 3 | **0** |
| every composite failing — ladder active throughout, ending in `cancelRender` (exit 1) | 1 | **0** |

The second row is the sensitive one: with every composite throwing, a failed frame's handle is held for
essentially the whole life of the component, so any teardown would collide with it. None occurred.
Structurally: `SceneStage` has exactly **one** call site (`Root.tsx:61`, rendered unconditionally as the
composition root, no key, no conditional branch), there is **no StrictMode** anywhere in
`apps/worker/src`, and Remotion ends a render by **closing the page**, which never runs React cleanup.

**The sharper consequence, stated because it is easy to stop one step short of:** if unmount never fires,
then the effect's *original* purpose — the comment says it exists "so a teardown mid-frame can't hang the
render" — also describes a scenario that does not occur. **Instance 3 is dormant, and so is the
protection it was written for.** It has been dormant since well before instance 1's fix existed.

**Kept, not deleted, and NOT an L13 violation.** L13 is about newly built infrastructure shipped ahead of
a consumer; this is a pre-existing safety net whose absence would fail *silently*, and reachability
arguments age badly. **Re-arming condition, precisely:** the moment `SceneStage` acquires a second,
conditionally-mounted host (a preview surface, a harness that swaps compositions), unmount becomes
reachable and this becomes load-bearing — at which point the release must distinguish *pending and
healthy* (release, as today) from *pending and failed / mid-ladder* (`cancelRender`). The argument is
duplicated as a comment at the effect so the next reader does not re-derive it.

**Update (2026-08-09) — EXHAUSTIVE AUDIT (read-only; no fix in this pass). Verdict: CANNOT RETIRE — a
fourth live instance found, unfixed.**

The entry's own expiry condition is about EVERY error path in the export pipeline, and no exhaustive
audit had been done — instances 1-3 were each found by chasing a SPECIFIC incident, never by asking
"what else in this file does the same thing." Asked now. Every `continueRender`/`cancelRender`/
`delayRender` call and every catch/finally/cleanup path in `apps/worker/` lives in exactly one file,
`SceneStage.tsx` (confirmed by grep across the whole `apps/worker/src` tree — `remotion-renderer.ts`
only mentions `delayRender` in comments, configuring Remotion's own `timeoutInMilliseconds`, never
calling the API itself; `Root.tsx`/`entry.tsx` carry no completion logic of their own).

| site | signals completion | on the failure path | verdict |
|---|---|---|---|
| `SceneStage.tsx:539-546` `ImageGrabber`, load success/cancelled | `continueRender(handle)` in `.then()` | N/A — this row is the happy path | SAFE — `cancelled` gates whether `onFrame` fires; the render still needs releasing either way so a superseded load can't hang the frame |
| **`SceneStage.tsx:546` `ImageGrabber`, `.catch(() => continueRender(handle))`** | **`continueRender`, unconditionally, on ANY image-load failure** | **swallowed — no `cancelRender`, no `console.error`, nothing** | **DEFECT — live, same class as instances 1/2/3, unfixed.** `loadImageOnce` (line 100-113) rejects via `img.onerror`, i.e. a genuinely broken/unreachable/corrupt image or graphic asset. That rejection is caught and answered with `continueRender` — Remotion is told the frame is done. `onFrame` is never called for that layer (its `.then()` branch didn't run), so it is simply ABSENT from `rawRef`, the composite proceeds without it, and the export ships a frame silently missing an image/graphic/text-behind-person layer, exit 0. This is instance 1's exact defect (error path reports completion) in a path instances 1-3 never touched. |
| `SceneStage.tsx:547-550` `ImageGrabber`, unmount/dep-change cleanup | `continueRender(handle)`, unconditional | N/A — not itself a failure path | SAFE, distinct from instance 3's shape: this component owns exactly ONE handle for ONE effect run, so a superseded run's handle release cannot ship stale content — either a NEW effect run (new `src`) already owns its own new handle, or the layer/composition is genuinely gone. Nothing is asserted as "complete" that isn't. |
| `SceneStage.tsx:646-684` controller-init `catch` → `cancelRender` | N/A — this IS the failure path | `cancelRender` with a named DEBT-015 error | SAFE — this is instance 2, FIXED. Falsifier already on record above (forced throw, exit 0→1, `git diff` empty after revert). |
| `SceneStage.tsx:702-729` `failComposite` → ladder → `cancelRender` on exhaustion | N/A — this IS the failure path | 3 retries (150/300/600ms, handle held throughout) then `cancelRender` with a named DEBT-015 error | SAFE — this is instance 1, FIXED. Falsifier already on record above. |
| `SceneStage.tsx:739-748` (now `:784-793` after instance 4's insertions above it — file grew, site unchanged) composite effect, "new frame, stale OTHER-frame handle" release | `continueRender(pendingRef.current.id)` before acquiring the new frame's handle | N/A if reasoning below holds — no failure state can reach this branch | **Upgraded 2026-08-09: MEASURED DORMANT** (was reasoned-only). See the follow-up measurement below — 0 hits across a real healthy multi-frame render AND a real all-failing render, plus two structural gaps the original reasoning left open (retry interaction, post-abort interaction) now closed by tracing rather than assuming. Original reasoning retained below for the record. `pendingRef.current` is nulled immediately after every successful `continueRender` (line 816, now ~869) and never touched by the retry ladder (a retry re-runs the SAME `frame`, so the outer `pendingRef.current.frame !== frame` guard is false and this block is skipped). For this branch to fire, `frame` (from `useCurrentFrame()`) would have to advance to a NEW value while an OLDER frame's handle is still outstanding — which Remotion's own `delayRender` contract exists to prevent within one mounted instance. |
| `SceneStage.tsx:791-826` composite effect, success path | `continueRender`, gated on `pass === compositePassRef.current` AND `pendingRef.current.frame === frame` | failure is diverted to `failComposite` at line 806 BEFORE this code is reached | SAFE — the staleness guard is exactly what instance-1's fix relies on; a superseded pass returns at line 804 before either branch. |
| `SceneStage.tsx:832-839` cleanup, clear the retry timer | none — clears a `setTimeout`, not a render signal | N/A | SAFE / not applicable — listed because it sits beside the ladder and could be mistaken for a completion signal; it is bookkeeping only. |
| `SceneStage.tsx:864-875` unmount cleanup, unconditional `continueRender` | `continueRender`, unconditional, on any pending handle | releases a handle without checking pending-vs-failed | **This IS instance 3** — already fully documented and measured above (4 mounts / 0 unmounts, both a healthy and an all-failing render). Not re-measured here; cited for completeness of the exhaustive claim. Kept DORMANT with its re-arming condition on record. |
| `SceneController.pruneRenderers` (`:278`) / `.dispose()` (`:381`) `catch { /* ignore */ }` | none — these swallow GL-disposal errors, not render completion | N/A | Not applicable to this class. Checked because the brief asked for every catch/finally in the file; neither sets a completion flag nor touches `continueRender`/`cancelRender`. Best-effort cleanup, a different (and generally correct) pattern from "an error became a success." |
| `SceneController.composite()` returning `false` for a not-yet-decoded media frame (`:305,306,313,326`) | N/A — this is the existing "not ready, retry" contract, not a failure | the composite effect correctly does NOT `continueRender` on `complete === false` (line 809's guard) | SAFE, and worth naming explicitly: this is the LEGITIMATE pending case DEBT-015 was never about — confirms the boundary between "still loading" (return false, retry) and "threw" (catch, ladder) is drawn correctly at the one place that matters. |
| `VideoGrabber` (`OffthreadVideo`'s `onVideoFrame`) | delegated entirely to Remotion's own library component | delegated | Out of scope — this codebase never calls `delayRender`/`continueRender` for video frames itself; Remotion's `<OffthreadVideo>` owns that internally. Auditing Remotion's own library code is a different exercise. |
| `remotion-renderer.ts` (`timeoutInMilliseconds` config) | N/A — configures Remotion's OWN internal `delayRender` timeout budget | N/A | Out of scope — comments only, no call site. |

**Why this is not a tidy retirement.** The table has one unambiguous DEFECT (the image-load `.catch`) and
one lower-confidence DORMANT verdict reached by reasoning rather than measurement (the stale-handle
release at `:739-748`). Per this round's own rule — *"anything you cannot decide is DEFECT until proven
otherwise, do not guess to make the table tidy"* — the `:739-748` row is reported exactly as confident as
the evidence supports, not rounded up to match instance 3's measured certainty.

**Not fixed here, on instruction.** The image-load defect is a live bug matching this entry's own class,
found by this audit and left for its own prompt with its own falsifier — the same discipline instances
1 and 2 were each given. **DEBT-015 does not retire.**

**Update (2026-08-09) — instance 4 FIXED. Verdict unchanged: DEBT-015 still does not retire (one
lower-confidence row remains open).**

`ImageGrabber`'s `.catch(() => continueRender(handle))` (was `:546`) now retries up to
`MAX_IMAGE_RETRIES = 3` times with `IMAGE_RETRY_BACKOFF_MS = [150, 300, 600]` — the same constants and
ladder shape as `failComposite`'s (instance 1) — holding ONE `delayRender` handle across every attempt
(never releasing and re-acquiring, which is exactly what would let a partial frame slip out between
retries), then `cancelRender` on exhaustion with a message naming the layer id, a truncated `src`
(a data URL can be multi-megabyte), the attempt count, and the underlying cause. `loadImageOnce`
(`:100-113`) only memoizes on SUCCESS, so each retry is a genuine new attempt, not a vacuous repeat of a
cached rejection.

**The falsifier needed a second design pass.** The first fixture (a single static, permanently-broken
image layer) did NOT reproduce "ships blank, exits 0" — it reproduced a *different* real problem: Remotion's
own generic delayRender timeout (28s for `renderStill`'s default, 120s for `renderManifestToMp4`'s
configured `MEDIA_FETCH_TIMEOUT_MS`) firing and failing the render with exit 1, because
`SceneController.composite()` (`:304-306`) already refuses to report a frame complete while any active
media layer has no entry in `rawById` — a layer that *never* successfully decodes blocks every frame
forever and the render hangs-then-fails, it does not silently succeed. Traced and confirmed empirically
(logs on record) before accepting it as the finding, rather than asserting it from the code alone.

The actual "ships blank/stale, exits 0" mechanism needs a layer whose `src` **changes every frame**
(true of `layer.graphic`'s per-frame `graphicToAnimatedDataUrl` re-bake, `:533-536`) where an EARLY
frame's decode succeeds — populating `rawRef.current` for that `layer.id` — and a LATER frame's decode
fails: `rawById.has(layer.id)` is still `true` from the earlier success, so `composite()`'s gate passes,
and the composite proceeds using the STALE earlier frame while the current one silently never updates.
No timeout, no error, no log — the export completes and looks fine.

Reproducing this organically (a real animated graphic that decodes for N frames then breaks) was judged
too fragile to depend on for a repeatable test, so it was isolated with the same temporary-injection
methodology already used elsewhere in this file's history (DEBT-010, the composite ladder's own
untested-branch exercise below): a `layer.id === "image_layer_1"` probe in `ImageGrabber` forcing
`frame < 15` to the real (valid) asset and `frame >= 15` to a syntactically-valid-but-undecodable data
URL, injected on top of each code version, run, then fully reverted (`git diff` empty afterward).

Falsifier (current/defective code + probe, `debt015-run-mp4-only.ts` against `debt015-manifest-good.json`,
90 frames @ 30fps/3s): **exit 0**, mp4 produced. Frame 80 (65 frames after the layer started permanently
failing) is pixel-identical to frame 45 of a clean render — the STALE frame 14 image, shipped silently,
forever, with zero signal anything was wrong.

With the fix (same probe, same manifest): 2 render tabs each logged `retry 1/3 in 150ms` →
`retry 2/3 in 300ms` → `retry 3/3 in 600ms`, then `cancelRender` at ~12% progress:
`SceneStage: image load failed for layer image_layer_1 after 4 attempts — refusing to emit a frame
missing this layer (DEBT-015). src="data:image/png;base64,c3RhbGUtcHJvYmUtYmFkLWJ5dGVzLTE1" cause=image
failed to load`. **exit 1**, fast (~1s of retries, not a 28-120s generic timeout), named cause.

Happy path (fix applied, probe removed, same manifest): exit 0, ran to 100% with no retry warnings,
spot-checked frame pixel-identical to the falsifier's pre-break frames. No cost added to a working decode.

Exhaustion branch: exercised directly by the same probe run above (a real, forced 4-consecutive-failure
sequence, not asserted from reading the code) — not a separate step.

**Judgement call, made and disclosed rather than silently picked:** the retry ladder does NOT
differentiate a generated data URL (`layer.graphic`'s animated bake) from a `layer.assetUrl` fetch, even
though a malformed data URL will fail identically on every retry (no possible transient recovery) while
an asset URL failure might be a genuine transient (slow storage, a race with an in-flight upload). Chose
NOT to differentiate: it mirrors `failComposite`'s precedent (which also retries on any composite
failure without cause-based branching), and the cost of retrying a data URL that can't recover is capped
at the same ~1050ms the composite ladder already treats as negligible next to a render's total runtime —
adding a second branch to save ~1s on a frame that was going to fail anyway was judged not worth a new
axis of behavior with no precedent in this file.

**Manifest paths treating a missing image as legitimately optional — checked, none do.** Two places
already short-circuit BEFORE any decode is attempted: `ImageGrabber`'s own `if (!src) return undefined;`
(an empty/absent `assetUrl`) and the Flarex loader mount's `if (!loader.assetUrl) return null;`
(`:934`, an asset that failed to resolve — "the compiler's documented host soft-degrade still applies").
Both are EMPTY-url cases, never reaching `delayRender`/the retry ladder at all — they were already
correctly optional before this fix and remain unchanged by it. No manifest path treats a PRESENT-but-broken
image URL as optional anywhere; every truthy `src` that fails to decode now goes through the same
retry-then-cancelRender path regardless of which of the three producers (timeline image layer, matte
layer, Flarex asset-source loader) supplied it.

**DEBT-015 still does not retire at this point in the log** — see the next update, which closes the
remaining open row.

**Update (2026-08-09, same day) — the `:739-748` (now `:784-793`) stale-handle-release row: MEASURED,
upgraded from reasoned-only. DEBT-015 retirement status: see verdict at the end of this update.**

The prior pass's reasoning was sound but admittedly untested: `pendingRef.current` is nulled on every
successful `continueRender`, and a same-frame retry can't reach the branch because `pendingRef.current.frame
!== frame` is false throughout a retry (the retry ladders — both `failComposite`'s and instance 4's new
image ladder — never change `frame`, only re-run in place). The one thing genuinely unverified was
whether Remotion's `delayRender` contract really does prevent `frame` from advancing while a handle from
an OLDER frame is still open, in a REAL multi-tab render, under both normal and failing conditions.

Measured directly, using the same temporary-injection-then-revert method as the rest of this file's
history: a `console.warn` at the exact branch (`if (pendingRef.current)` inside the "Acquire (or keep)"
block), firing only when reached with a NON-null `pendingRef` whose `frame` differs from the incoming
one — precisely the condition the reasoning claimed was unreachable.

- **Healthy render**: a two-clip, 150-frame (5s @ 30fps) fixture with a junction transition between them
  (so two media layers are simultaneously active, not just one static clip) — `debt015b-manifest-healthy.json`,
  rendered via `renderManifestToMp4` directly. **0 hits**, exit 0.
- **All-failing render**: the same fixture with one clip's asset pointing at an undecodable data URL —
  `debt015b-manifest-broken.json`. Both render tabs ran the instance-4 retry ladder to exhaustion
  (`retry 1/3` → `retry 2/3` → `retry 3/3`) and `cancelRender`d. **0 hits**, exit 1.

This also closes two structural gaps the original reasoning left open without naming them: (1) whether a
composite-retry sequence could somehow still reach this branch — traced and confirmed impossible by
construction (retries hold `frame` constant, so the branch's own precondition is false the entire time);
(2) whether the abort path could reach it — traced and confirmed impossible (`if (renderAbortedRef.current)
return;` at the top of the same effect exits before this code runs at all, once aborted).

Reverted cleanly after measurement (`git diff` on `SceneStage.tsx` matches instance 4's committed fix
exactly, zero probe tokens remaining).

**Verdict: MEASURED DORMANT**, same confidence class as instance 3 now (a bounded real-render
measurement, not exhaustive formal proof — the same standard instance 3 itself was held to).

**Left open, not declared retired.** All four known instances are now resolved (1, 2, 4 fixed; 3 and this
row confirmed dormant) and the 2026-08-09 exhaustive audit accounted for every completion-signaling site
in `apps/worker/`. Whether that satisfies the entry's own expiry condition — "no error path in the export
pipeline," a claim broader than one grep-verified directory — is left for the founder to decide rather
than inferred here from an instance count reaching zero. Any FUTURE completion-signaling site added to
this file starts its own clock regardless of how this is decided.

**(2026-08-08, founder-identified, from this session's own Scope C.)** The pre-registered falsifier read
*"a lone loader is safe on hardware"* — an **absolute**. It fired: with the lone loader on hardware, a
source starved. The verdict looked clean and it was wrong, because the counterfactual arm then showed the
same starvation with the lone loader on **software** — there is no clean baseline here. The absolute
phrasing silently assumed one, and nobody had measured it.

**The general form: an absolute falsifier presupposes a baseline. If the baseline is unmeasured, the
falsifier smuggles in an assumption and reads as a verdict.** The correct form is **comparative** —
*"a lone loader on hardware is no worse than on software"* — which, against exactly the same data, yields
a bounded answer (`capMisses` 2/2/2 vs 1/0/1: worse, by about one, and more consistently) instead of a
false verdict ("unsafe, revert").

Detection: any falsifier phrased as a property of one condition rather than a difference between two.
Ask "compared to what, and did I measure it?" — and if the answer is "compared to how it presumably
behaved before," the counterfactual arm is not optional.

Same family as the four shapes above, and the most expensive to catch late: it produces a *confident,
reproducible, 3/3* result that points at the wrong remedy. Here it would have reverted a real
common-case benefit (a lone Flarex clip getting hardware decode) to recover ~one cap miss in a
three-host fixture, and re-broken I-44a for nothing.

**Update (2026-08-09) — SCOPE 2: the browser export pipeline (`apps/web/src/export/`). One live instance
found and FIXED. DEBT-015 remains open; this scope is now audited but not exhausted (three ambiguous
sites written up, not fixed).**

The prior audit (worker scope) explicitly declined to retire on the grounds that "the export pipeline"
is broader than one directory — there is a SECOND, independent export path with its own completion
semantics and no Remotion `delayRender` contract at all: the browser's local export
(`local-export.ts` → `export-core.ts` → `scene-frame-compositor.ts` / `webcodecs-decoder.ts` /
`source-decoder.ts` / `video-encoder.ts` / `audio-mixer.ts` / `matte-resolve.ts` / `source-color.ts`).
This scope is not hypothetical: it already shipped the exact DEBT-015 symptom once (black/blank clips
in a completed export, traced to WebCodecs decoder warmup/flush lifecycle — see
`EXPORT_DECODER_WARMUP_TODO`/`lumio.exportDecodeDebug`).

**The falsifier needed the same second design pass instance 4 needed, for the same structural reason.**
A permanently-broken source never even gets a provider created (`createWebCodecsVideoSource`'s own
probe-decode returns null and `source-decoder.ts` falls through to `<video>`, or that also fails and the
whole export throws at setup — already correctly loud). The silent-success shape only appears when a
provider that ALREADY decoded successfully has a LATER `getFrame()` call fail — mirroring instance 4's
"early success, later failure" finding exactly. Confirmed empirically (not assumed) before accepting the
finding, via a `FrameProvider` wrapped to succeed for its first 3 calls then return null forever, run
through a real `SceneFrameCompositor.renderFrame()` loop in a live browser (Playwright/Chromium),
injected on a temporary route (`Debt015bFalsifierPage.tsx`, deleted after use, `App.tsx` route reverted
— `git diff` empty afterward).

| site | signals completion | on the failure path | verdict |
|---|---|---|---|
| **`scene-frame-compositor.ts` `gradeMediaLayer`, `!frame` after `source.getFrame(sourceTime)`** (was one `if`, now the retry block below it) | previously: `return null` | `buildSceneDraws`'s `getMediaGraded` (`packages/shared/src/scene/build-scene-draws.ts:690`) treats a null graded source as "not ready yet" — `onLayerNotReady?.()` (not even wired up by this caller) then `return null` — the layer is simply omitted from the composite. Frame ships, export exits 0, zero console output in the default (non-diagnostic) path. | **DEFECT — FIXED this round.** Retry 3× (150/300/600ms, same constants/shape as the worker's `failComposite`/instance-4 ladders) then `throw`, naming the layer, time, provider key, and attempt count. |
| `scene-frame-compositor.ts` `gradeMediaLayer`, `!source` (provider never found for an active layer's key) | `return null`, stageProbe-only diagnostic (off by default) | same "not ready" absorption as above | DEFECT by the same shape, **NOT fixed this round** — structurally near-unreachable: `export-core.ts`'s per-frame loop `await`s `loadSource` for every `activeSourceKeysAt(t)` key BEFORE `renderFrame(t)` runs, and a non-matte `loadSource` failure already throws (see next row) — this path should only fire if the two independently-computed provider-key functions (`export-core.ts`'s `mediaSourceKey` vs this file's inline `providerKey` computation) ever disagree, which inspection did not find but cannot rule out as a future regression. Written up, not fixed — no known incident, and a confident fix here would be guessing at an unreachable branch's intent. |
| `scene-frame-compositor.ts` `gradeMediaLayer`, matte `getFrame()` returns null (`matteFrame` stays null) | silent — no stageProbe entry even, layer renders **unmatted** (full clip visible) instead of failing | matches `export-core.ts`'s `loadSource` (next row) — the SAME deliberate matte-specific leniency, not an independent gap | DEFECT by DEBT-015's letter, **written up, not fixed** — ambiguous: mirrors an EXISTING, apparently deliberate design decision (mattes are treated as optional throughout this pipeline), and making a matte failure abort the whole export would be a real product-behavior change, not "fail loudly instead of silently" in the narrow sense. The founder's call. |
| `export-core.ts` `loadSource`, `catch (error) { if (!key.startsWith("matte:")) throw error; }` | swallows ONLY for matte-prefixed keys; every non-matte source load failure already throws (confirmed — this path is SAFE) | a failed matte load leaves no entry in `sources`, feeding the row above | Same ambiguous matte-optional decision as the row above — one finding, two call sites. Written up together, not fixed. |
| `local-export.ts` audio mixdown: `Promise.race([mixTimelineAudio(...), timeout(20s)]).catch(() => null)` | any throw OR a 20s stall is converted to `null` — indistinguishable from "the timeline has no audio" (`mixTimelineAudio`'s own legitimate null-return contract) | export proceeds **muted**, no warning, exit 0, reported successful | DEFECT by DEBT-015's letter (a genuine failure ships as success) but this is clearly BUILT infrastructure, not an oversight — the 20s race is explicit and documented. Whether a broken audio mix should fail the WHOLE video export is a real, debatable product tradeoff (unlike "a video frame must be complete", there is no established precedent elsewhere in this codebase that missing audio is export-fatal). Written up, not fixed. |
| `audio-mixer.ts` `decode()`, fetch/decodeAudioData failure → `buffer = null` | documented as intentional: *"a source without an audio track (silent video) just contributes nothing"* | that ONE audio layer is silent; other layers still mix and play | SAFE — explicitly by design, low severity (per-layer, not per-export), and the file's own comment predates this audit. Noted imprecision: this conflates "no audio track" with "fetch/network failure," which are different conditions, but not a completion-signaling defect — just an unexamined edge inside an intentionally-lenient path. |
| `matte-resolve.ts` `resolveGraphMattes` | never throws per-matte; every unrecoverable matte lands in a `failures` array, explicitly documented: *"the caller decides whether that's fatal"* | verified the actual export-gate caller: `apps/web/src/lib/sync.ts:745` does `throw new MatteResolveError(matteReport.failures)`. Tool-panel callers (`TextBehindPersonToolPanel.tsx` etc.) don't throw — those are bake/background-sync flows, a different, already-documented concern (`"opportunistically on every background sync"`). | SAFE — explicit contract, correctly consumed where it matters. |
| `video-encoder.ts` `addVideoFrame`/`finalize` (encoder-error latch, backpressure watchdog, bounded stall-recovery ladder) | throws on a stalled queue after ≤2 bounded reset attempts; checks the latched `encoderError` before AND after `flush()`/`close()` | fully explicit, no swallow anywhere — this file's own top comment names the exact hazard DEBT-015 is about ("a WebCodecs encoder reports failures through its async error callback, NOT by rejecting any promise... if we just throw in that callback, the error vanishes... the export silently 'stops'") and was ALREADY built to avoid it | SAFE — model implementation, not a defect source. |
| `video-encoder.ts` `dispose()` catches | swallow `close()` errors | only called to ABANDON an already-failing/aborted encode (its own docstring), never a success path | SAFE — same shape as the worker's `SceneController.dispose()`, judged the same way there. |
| `export-core.ts` per-frame loop: `FRAME_TIMEOUT_MS` watchdog, black-frame guard (throws on 2 consecutive black expected-media-frame samples), `EncoderStallRecoveredError` re-render | throws on stall/timeout/context-loss; the guard throws when tripped | explicit propagation throughout — this file's own comments state the philosophy plainly: *"Phase 5: no canvas2D degrade... propagates out of the loop... surfaces as a hard export error rather than shipping black"* | SAFE — actively working AS a DEBT-015-class safety net. Coverage gap noted, not itself a defect: the black-frame guard is opt-in, sparse-sampled (≤4 timestamps per export), and only wired up on the default Worker-scene path (`workerSceneDiagnostics`) — the main-thread fallback (`runExportCore` called directly, no diagnostics) has no guard at all. This round's fix (row 1) is the actual safety net for the general case; the guard is supplementary tooling on top of it. |
| `export-core.ts` `document.fonts.load(...).catch(() => undefined)` | catch → undefined, falls back to the platform font | text still renders (different font, not missing) — explicitly matches the LIVE PREVIEW's own non-blocking font-load behavior, so preview↔export stay in parity | SAFE — intentional, documented, not a content-loss defect. |
| `local-export.ts` `rasterizeSvgSources` catch | keeps the original SVG URL unchanged on rasterize failure | the main-thread `<img>`-decode SVG path (`createImageSource`) is a real, exercised fallback, not a dead end | SAFE — documented fallback chain. |
| `export.worker.ts` | always posts exactly `"done"` or `"error"`, one try/catch, no swallow | N/A | SAFE. |
| `webcodecs-decoder.ts` `createWebCodecsVideoSource` setup/probe failures (demux, `isConfigSupported`, `configure`, probe-decode) — many sites | all return `null`, each with a `console.warn` naming why | `source-decoder.ts`'s `.catch(() => null)` + null-check falls through to the `<video>` fallback provider, which has its OWN real error handling (`createVideoSource`'s load/seek both reject on timeout) | SAFE — an explicit, documented two-tier fallback contract, correctly consumed by the caller. Not a silent-success shape: setup failure here means "try the other decoder," not "ship anyway." |
| `webcodecs-decoder.ts` `getFrame()` returning `null` mid-stream (warmup-stall bail, drain-yielded-nothing bail, `KEY_RETRY_MAX`-exhausted decode() throw) | returns `null`, no exception (by the `FrameProvider` contract's own design — see `source-decoder.ts`'s docstring: `"Returns null when the file can't be demuxed/decoded"`) | consumed by `gradeMediaLayer` — this is exactly what feeds the FIXED row at the top of this table | The `null` contract itself is correct and by design; the defect was never here — it was purely in how the CONSUMER (`gradeMediaLayer`) treated a genuine failure identically to "not ready." Now covered by the fix. |
| `source-decoder.ts` `createVideoSource().getFrame()` → `null` when `readyState < 2` right after a resolved seek | same shape as the row above, same consumer, same fix | — | Covered by the fix. |
| `source-color.ts` `detectSourceMetadataFromFile` — any parse failure returns `{ color: null, ... }` | export proceeds tagged with DEFAULT color metadata instead of DETECTED | metadata-tagging concern, not "did the frame render" — a genuinely different, much lower-stakes class (color-accuracy nuance vs missing content) | SAFE / not applicable to this defect class — same treatment the worker audit gave GL-disposal catches ("a different, generally correct pattern"). |
| `export-gl-debug.ts`, `export-preview-suspend.ts`, `export-worker-protocol.ts` | no completion signaling anywhere in these files | N/A | Not applicable — pure diagnostics, refcount state, and message-protocol types. |

**Falsifier, before/after** (`Debt015bFalsifierPage.tsx`, 12-clip fixture, one provider wrapped to
succeed 3 times then return null forever, run via `SceneFrameCompositor.renderFrame()` in a real browser):

| | before the fix | after the fix |
|---|---|---|
| result | `state=ready`, **50/50 frames rendered** | `state=error` at frame 3 |
| console | nothing — zero warnings, zero errors | `retry 1/3 in 150ms` → `retry 2/3 in 300ms` → `retry 3/3 in 600ms`, then the named throw |
| thrown error | none | `Export: no decoded frame for layer "stress_clip_0" at t=0.360s after 4 attempts (providerKey=stress_image, sourceTime=0.000, provider=1080x1920) — refusing to ship a frame missing this layer (DEBT-015).` |

Happy-path / exhaustion-branch note: the retry loop's own guard (`while ((!frame || ...) && decodeAttempt
< MAX)`) is skipped ENTIRELY when the first `getFrame()` call already succeeds — a working decode adds
zero code execution, not just zero visible behavior change. The exhaustion branch (all 4 attempts fail)
is exercised directly by the falsifier above, not asserted from reading the code. A DEDICATED
non-flaky happy-path browser run (same fixture, real decode, no wrapper) was attempted three times at
increasing fixture sizes (12/3/2 clips) and three times failed to complete within this environment
(`page.goto` itself did not resolve, unrelated to any observable change from this fix — the same hang
reproduced on a 2-clip fixture, ruling out GPU/render load as the cause) — **stated plainly as
unverified by a dedicated run**, rather than silently dropped: the happy-path claim rests on the
structural guarantee above plus the 3 real, unwrapped, successful decodes the falsifier's OWN "before
failure" frames already exercised under the fixed code (visible in the retry log: exactly 3 renderFrame
calls completed cleanly before the wrapped failure began).

`pnpm --filter @orreris/web typecheck` clean.

**DEBT-015 still does not retire.** Scope 2 (browser export) is now audited, one live instance found and
fixed, three sites written up as ambiguous (two matte-related, one audio-mixdown) — none fixed this
round, each is its own future prompt with its own product decision. The `!source` row is flagged
DEFECT-by-shape but near-unreachable; not fixed, no known incident. Combined with worker scope
(instances 1/2/4 fixed, instance 3 and the stale-handle row measured dormant), the entry now covers two
of what may be more than two export paths in this codebase (the API-layer mock processing service is
explicitly mocked, not real, per CLAUDE.md, and was not audited here since it does not perform genuine
encode/render work) — retirement remains the founder's call, not inferred from a shrinking instance count.

**Update (2026-08-10) — the three scope-2 rows written up as ambiguous are now FIXED. Every DEFECT row
in the scope-2 audit table is closed; Status line left unchanged (see why, below).**

The three sites the prior round declined to fix on product-ambiguity grounds got their product decision
this round (founder call, not inferred): a matte that was SPECIFIED and then failed to load or decode is
now fatal to the export; a matte that was never specified stays untouched (the existing "mattes are
optional" design, preserved exactly); a genuine audio-mixdown throw or stall now fails the export instead
of shipping muted; a project with no audio still ships silent, unchanged.

| scope-2 table row | this round |
|---|---|
| `scene-frame-compositor.ts` `!source` | FIXED — throws `no source provider found for layer "…"` instead of `return null` |
| `scene-frame-compositor.ts` matte `getFrame()` null / zero-width | FIXED — throws `…failed to decode…`, only inside `if (layer.matte?.uri)` |
| `export-core.ts` `loadSource`'s `matte:`-prefixed swallow | FIXED — swallow removed (provably safe: a `matte:<layerId>` key only ever exists when `layer.matte?.uri` is set, at all three map-building sites, so every failure on it is specified-and-broken, never never-specified) |
| `local-export.ts` audio mixdown `.catch(() => null)` | FIXED — split via a private timeout sentinel into: legitimate null (unchanged), thrown → `"mixdown failed"`, race expired → `"did not finish within 20s"` |

**Verification, both halves of each case, real Chrome:**
- Audio: no audio layers → export completes, ships silent (`{"kind":"done"}`). A real `OfflineAudioContext`
  `startRendering` RangeError (absurd composition duration, not a wrapper) → rejects, named "mixdown
  failed". A genuinely pending fetch (`page.route()` that never resolves, not a simulated delay) → real
  20s wait → rejects, named "did not finish within 20s" — distinguishable from the throw case.
- Matte decode: **succeed-2-then-fail** injected through `SceneFrameCompositor`'s own `getSource`
  constructor seam — the matte provider returns real frames for calls 1–2, `null` on call 3 — throws
  exactly on frame 3 (`matteCalls:3`), the mid-stream shape, not a permanently-broken setup that would
  fail at load time and never reach the decode branch. No matte specified: completes, `matteCalls:0`.
- Matte load: `getSource` returning `undefined` for `matte:<id>` while `layer.matte?.uri` is set → throws
  `…failed to load…`. Missing main source (`!source`): `getSource` returning `undefined` for the layer's
  own key → throws `…no source provider found…`.
- **Residual closed this round**: the previous round flagged the real `export-core.ts` `loadSource` →
  `runExportCore` → `exportLocally` propagation path, and the actual message a user would see on a real
  matte-URL failure, as unverified. Both are now settled. Propagation was settled by reading (both
  `loadSource` call sites are awaited, so a rejection reaches `runExportCore`'s awaited flow and cannot
  become an unhandled rejection). The message was NOT settled by reading — ran one real export against a
  matte URL that 404s (real network failure, real pipeline, no wrapper): the message that reached the
  catch was `"Failed to load video source for export"` — generic, named neither the layer nor the URL nor
  that it was a matte. Fixed the message only (no restructuring): `loadSource`'s single catch now wraps
  the underlying detail with the key (decoded to `matte for layer "<id>"` or `source "<id>"`) and the URL.
  Re-ran the same live 404 after the fix: `"Export: failed to load matte for layer \"clip1\"
  (http://…/__debt015_nonexistent_matte__.mp4) — Failed to load video source for export"` — names the
  layer, names it as a matte, gives the URL, and preserves the original detail.
- `render:compare:pixels` 55/55, no fixture regressed. `pnpm --filter @orreris/web typecheck` clean.

**Left open, explicitly, so it is not lost**: the 20s audio-mixdown budget (`local-export.ts`) is fixed
regardless of timeline length or audio-layer count. A mixdown that legitimately needs 25s now fails
loudly instead of shipping muted silently — a real improvement — but it still fails a mixdown that would
have succeeded given more time. Whether the budget should scale with duration/layer-count, and if so how,
was explicitly left as a separate decision — not evaluated, not fixed, this round.

**Status line NOT changed.** Every DEFECT row in the scope-2 table is now closed, but the entry's own
2026-08-09 language already reserved retirement as the founder's call rather than something inferred from
an instance count reaching zero, and named a specific reason it wasn't ready to close even with worker
scope fully accounted for: "the entry now covers two of what may be more than two export paths in this
codebase" (the API-layer mock processing service was explicitly excluded from audit, being mocked rather
than real per CLAUDE.md — not evidence the class is closed, just evidence it wasn't in scope). Nothing
this round changes that reservation. What DOES change: scope 2, specifically, now has zero open DEFECT
rows in its own audit table — if scope 2 alone were the question, it would retire; DEBT-015 as a whole
does not, on the same grounds the prior round already gave.

**Update (2026-08-10) — the 20s-budget residual left open above is now RESOLVED. Fixed in `2f02c5a`.**

The prior append registered the fixed 20s audio-mixdown budget as an explicitly open residual — a
mixdown that legitimately needed 25s would fail loudly instead of shipping muted, an improvement, but
still a failed export the budget had no real basis for. Resolved by measurement, not by picking a bigger
number: `mixTimelineAudio` alone, timed across a 3x3 grid (1/5/20 audio layers x 1/10/30 minutes of
timeline, real Chrome), came in at 6.63s worst case (20 layers, 30 min) — a third of the 20s budget that
was failing exports, and the expectation ("mixing is cheap, even 20 layers over 30 minutes should be
single-digit seconds") held, so the deadline itself was removed rather than rescaled. The premise DEBT-015
never examined — a stopwatch on mixing was aimed at the wrong subject, since mixing either completes or
errors, and what can actually hang forever is the underlying network fetch — is now the guard: each audio
source fetch in `audio-mixer.ts` is individually bounded (25s, mirroring `export-core.ts`'s
`SOURCE_LOAD_TIMEOUT_MS`), `response.ok` is checked explicitly (fetch does not reject on 404, so an
unchecked 404 would previously have fallen through to a decode failure and been silently absorbed), and a
new `AudioSourceFetchError` distinguishes a fetch failure from a genuine mixdown failure at the call site.
No scaled constant (duration x layers x factor) was introduced — the measurement didn't call for one, and
the prior round's own instruction was explicit that wanting one would mean the premise was wrong. Mixdown
also now reports real per-layer progress through the existing `onProgress` channel, closing the silent gap
the prior append didn't mention but this round's task named directly — a stalled mix is now observable by
progress not advancing, without a number chosen in advance.

Verified in real Chrome, all four outcomes through the real `exportLocally`: no audio layers → silent
export ships, unchanged; a genuine `OfflineAudioContext` RangeError → named mixdown failure; a
never-fulfilled fetch (`page.route()`, no fulfill/continue/abort) → rejects after the real 25s bound,
named fetch failure; a genuine 404 (`route.fulfill({status:404})` — an unmapped path on Vite's OWN dev
server turned out to 200 via SPA history fallback, a dev-server artifact worth remembering the next time
someone tries to reproduce a 404 against this same dev server) → rejects immediately, named fetch failure,
HTTP 404 visible in the message. Progress observed monotonic across five layers
(`[0.18, 0.36, 0.54, 0.72, 0.9, 1]`). `render:compare:pixels` 56/56 (one fixture,
`flarex-animated-roto`, appeared between runs — a parallel session's work landing mid-round, unrelated).
`pnpm --filter @orreris/web typecheck` clean.

**New residual, so the entry does not read as having nothing left when it does**: an AUDIO-type layer
whose file decodes to no usable audio track is still silently absorbed by `audio-mixer.ts`'s `decode()` —
`buffer = null`, that layer contributes nothing, no warning, no failure. This is CORRECT and deliberate
for a video layer used for its picture only (silent by design, per the file's own pre-existing comment).
It is arguably WRONG for a layer the user explicitly added AS an audio clip — a broken/silent audio file
placed deliberately on an audio track probably should not disappear without a trace. Distinguishing the
two needs layer-type context `mixTimelineAudio`/`decode()` do not have today (`AudioLayerInput` carries no
layer-type field). Named here, not fixed this round.

### DEBT-016 — a source-draw cache key omitted an input the cached value depended on

- Status: **RETIRED same commit** (fixed as part of the change that registers this entry)
- Registered: 2026-08-09 (surfaced while implementing the "MediaIn stays put when the host clip is
  scaled from the inspector" fix)
- Reason: `FlarexSourceDrawCache` (`packages/shared/src/flarex/source-draw-cache.ts`) keys a bare Flarex
  asset-source MediaIn's cached draw template on `(layerId, comp.version, renderScale)` —
  ADR-009's `CacheKey = (ContractVersion, applicableContext, NodeContentHash)` rule, narrowed to what
  this cache actually varies on. At the time this cache was built (perf slice, source-draw-cache.ts's own
  header) a bare loader's transform was a hardcoded identity constant, so the key's omission of transform
  was correct — nothing content-dependent was left out. **ADR-020 slice B (`38b9c73`) changed what a bare
  loader's transform IS** — inherited from the host clip (`transform: host.transform ?? …`,
  virtual-layers.ts) instead of the identity constant — **without adding it to the cache key that already
  omitted it.** The key kept describing the OLD invariant ("this loader's presentation is time- and
  edit-invariant") after the change made it false: a host-transform edit is now a real content change the
  key is blind to.
- Invariant affected: ADR-009 completeness rules (cache identity must include every input the cached
  value depends on) — same class as DEBT-010 (node-thumbnail cache key omits ContextVersion).
- Owner: unassigned
- Expiry condition: n/a — retired in place. Detection kept below for the next cache built over a field
  that starts constant and is later made variable.
- Planned slice: none (unplanned defect, not a rollout-flag compromise)
- Tracking issue: —
- Detection: any cache key built when a field was a hardcoded constant, that is not revisited when a
  later change turns that field into a variable derived from caller state. Concretely here: `git blame`
  on a field a cache's key omits — if the omission predates the field becoming variable, the key is stale
  by construction, not by oversight at the time it was written.

**Symptom.** Founder repro: drop a clip on the timeline → scale it → open Flarex, create a comp → add a
second media as an asset-source MediaIn → back to the timeline → scale the clip AGAIN from the inspector.
The host clip's own picture scales correctly (its draw rebuilds fresh every frame). The MediaIn inside
its comp does not move — it stays exactly where it was when the comp was first rendered. A full page
reload "fixes" it (a fresh mount gets a fresh, empty cache), until the next host-transform edit
reproduces it again.

**Why 0 of 13 existing Flarex pixel fixtures caught this, and why a fixture couldn't unless built for
it.** Two independent reasons stack here, not one:
1. Every existing Flarex fixture's host sits at an identity transform, so the stale cached value and the
   correct value are the same value — a diff of the two is zero regardless of whether the bug is present.
2. `render:compare:pixels` renders each fixture exactly ONCE per process. The defect only appears on a
   SECOND render against an already-warm cache (the comp already exists; the host is edited after). A
   single-frame render is structurally unable to exercise that sequence no matter what transform the
   fixture's host carries — reason 1 alone is not the whole story, and fixing only reason 1 (a fixture
   with a non-identity host, rendered once) would still pass on the buggy code.
- Slice B's own commit cited pixel parity as evidence for a decoder-topology-only change ("NOT DRAWN...
  the pixel gate is the evidence for that claim" — virtual-layers.ts's own comment on the transform
  field). That citation was honest about what the gate measured and wrong about what it could prove:
  every fixture the gate runs sits at the one input value (identity) that makes this defect
  unobservable, so "the gate passed" was never evidence against a bug that only manifests away from
  identity.

**Fix.** `cachedPreFlarexDraw`'s cache-hit path (`build-scene-draws.ts`) now rebinds the transform
(`transform`/`rotateX`/`rotateY`/`perspective`/`z`) from a fresh `getCompositionTransform(virtual, …)`
call on every hit, exactly like it already rebound the live media handle. Enumerated what else in a bare
loader's cached template depends on transform before choosing this over widening the cache key: `mask` is
null regardless (bare requires empty `masks`, and virtual loaders never carry `.frame`, so
`SceneMaskMatteCache.get`'s combined mask list is always empty and returns null before reading the
transform argument); `content`/`blurPx`/`glow`/`fit`/`blendMode` read layer fields that don't depend on
`.transform` at all for a bare loader. Transform is the only transform-dependent field, so rebinding it on
the hit path is the complete fix — folding `compVersion` on the transform instead would mint a new cache
entry every frame of a live scale-drag, defeating the cache during exactly the interaction that surfaces
this bug.

**Falsifiability**, `packages/shared/src/scene/flarex-source-draw-cache-transform.test.ts`
(`pnpm --filter @orreris/shared sourceCacheTransform:test`): builds one comp, renders it once at an
identity host transform (populates the cache), mutates the SAME host layer's transform, renders again
through the SAME cache instance, and asserts the second render's MediaIn transform matches the new host
transform. Confirmed BEFORE the fix (`cachedPreFlarexDraw`'s hit branch reverted to the pre-fix spread):
the gate fails, reporting the exact stale value (`{"x":50,"y":50,"scale":1,...}` where 30/30/0.5 was
promised) — the same failure mode as the founder's repro, reproduced deterministically outside the
browser. Restored and reconfirmed passing. `render:compare:pixels` (chrome channel) run after the fix:
all 13 Flarex fixtures unmoved at 0.000%, full 54-fixture sweep passed.

**Note (2026-08-09) — a parity gate can never guard this entry, structurally, not just in practice.**
`flarexSourceDrawCache` is constructed and consumed ONLY in `apps/web/src/components/ScenePreviewCanvas.tsx`
(six sites) — the Remotion/export path never builds one, so it always does a full rebuild and is never
subject to the staleness this entry describes. A differential gate comparing the two renderers has
nothing to compare on this specific defect: web-preview would be wrong, Remotion would be right (or,
after the fix, both right), and either way the two sides never disagree with each other in the way
`render:compare:pixels` measures. Confirmed empirically, not just reasoned: reverting the fix and running
`PIXEL_FIXTURES=flarex-host-transform` reads 0.000% both before and after. The two-render unit test
(`flarex-source-draw-cache-transform.test.ts`) remains this entry's sole and correct guard — see DEBT-017
for the general shape of this gap.

### DEBT-017 — CLASS: the pixel-parity gate cannot see a bug both renderers share

- Status: **open** — registered as a CLASS, not a single instance. **THREE axes.** (1) both renderers
  compute the same wrong value; (2) the gate cannot see the EDITOR at all; (3) the gate's universe is
  its FIXTURE LIST. Axis 3 has a real instrument now: `render:link-gate`, a total (all-registry)
  compile/link gate promoted 2026-08-13, self-checking, 128/128 green, transition coverage 3/29 → 6/29
  (all four multi-pass pipeline transitions now fixture-covered; 26 monolith transitions and 10
  fragment effects remain link-checked only, by design). Axis 1's own instrument is likewise BUILT,
  not merely named: `render:linear-gate` predicts arithmetic in advance and has caught real defects —
  what axis 1 lacks is coverage, not design. Does not retire until axis 2's editor-reaching gate exists
  and axis 3's remaining fragment/monolith coverage is a scoped decision, not merely a number
- Registered: 2026-08-09 (discovered attempting to falsify the DEBT-016 pixel fixture — twice, against two
  different auditor-proposed reverts, neither of which the gate could detect)
- Reason: `render:compare:pixels` is a **differential** instrument — it renders the SAME composition
  through the web-preview path and the Remotion/export path and diffs the two PNGs. That is exactly
  right for what it was built to catch: CLAUDE.md's own worked example is a renderer-only
  `entranceScale()` spring that zoomed exports while the editor preview stayed flat — genuine divergence
  between two independent implementations. It has never been able to catch the other failure mode: a
  wrong value computed ONCE by code both renderers consume verbatim, because there both sides compute the
  identical (wrong) answer and the diff reads 0.000% by construction. There is no disagreement to measure.
  On this branch specifically, the amount of Flarex logic that is SHARED rather than renderer-specific has
  been deliberately increasing — `collectFlarexVirtualLayers`, `buildSceneDraws`, the evaluator, and (per
  the branch's own name) the compositor are now consumed verbatim by both consumers. Every one of those is
  a growing blind spot for this gate, not a shrinking one.
- Invariant affected: none named — this is a gap in the TEST INSTRUMENT, not a violation of a product
  invariant. The closest existing language is ADR-010's determinism rule ("same (comp, ctx) → structurally
  identical draws"), which is true and is exactly why the gate cannot see inside it: two renderers being
  fed the same deterministic function are GUARANTEED to agree, correct or not.
- Owner: unassigned
- Expiry condition: an audit exists naming which parts of the Flarex render path are STILL
  renderer-specific — i.e., what surface `render:compare:pixels` can actually still see, versus what has
  been absorbed into shared code and is now gate-invisible. That number was explicitly NOT claimed here:
  attempting it without auditing would be exactly the confident-but-unmeasured mistake this register exists
  to catch (see DEBT-012's own five shapes). Until that audit exists, "the pixel gate passed" is not
  evidence of correctness for any change that lands entirely inside `packages/shared`.
- Planned slice: none. This entry names the gap and the RIGHT instrument shape for it (below); building
  that instrument is unscoped, future work.
- Tracking issue: —
- Detection: any change that moves logic from a renderer-specific file (`apps/web/src/components/*`,
  `apps/worker/src/remotion/*`) into `packages/shared` should say so in its commit message as a
  side-effect: it may be shrinking what `render:compare:pixels` can still catch, even though the sweep
  will keep passing at 0.000% throughout the move. **Added 2026-08-13 (axis 3):** also any new entry
  added to a rendering registry — a transition, a fragment effect, a node — WITHOUT a fixture that
  renders it. It is invisible to both gates from the moment it lands, and "the sweep is green" will
  keep being true if it never worked at all.
- **Header updated 2026-08-13 (morning):** Status previously said only "registered as a CLASS, not a
  single instance"; it now names all three axes and flags the corrected instrument claim.
- **Header updated 2026-08-13 (afternoon), same day:** Status revised again after axis 3 was promoted
  from a finding to a shipped gate (`render:link-gate`) with measured before/after coverage, and to
  fold in that axis 1's own instrument is also built rather than merely named. See `README.md`, "State
  fields vs. history."

**The demonstration, not just the claim.** While attempting to falsify the DEBT-016 pixel fixture
(`flarex-host-transform`) by reverting the ADR-020 slice-B transform-inheritance line in
`virtual-layers.ts` back to its pre-slice-B hardcoded identity value, the fixture read **0.000% both
before and after** the revert — the same null result as reverting DEBT-016's own fix directly. Before
reporting that as "the inherited transform isn't reaching the drawn output" (the auditor's own
pre-registered contingency for a larger finding), the actual rendered PNGs were pixel-diffed against a
fresh correct-code run to rule out a stale-build artifact:

```
remotion: correct vs reverted — diff 1759396/2073600 (84.847%)
web:      correct vs reverted — diff 1759335/2073600 (84.844%)
```

The edit changed **~85% of the frame, on BOTH renderers, by the same amount** — proof the revert took
full effect and proof the two renderers moved in lockstep, together, the whole way. `render:compare:pixels`
still read 0.000% throughout, because it was never looking at whether the picture was right — only at
whether the two renderers agreed with each other, which two renderers fed the same shared function by
construction always will.

**What this means for the project's primary render gate, stated plainly.** A 53-or-55/N sweep at 0.000%
is evidence that web-preview and Remotion AGREE. It is not, and never was, evidence that the picture is
CORRECT. For any change that lands entirely inside shared evaluator/compositor code, the pixel gate
passing is silent on correctness — it can only speak to divergence, and shared code cannot diverge from
itself.

**The right instrument, named but not built.** Shared-layer correctness needs an ABSOLUTE assertion
against a known ground truth, never a differential one — either (a) a unit test with hand-computed
expected values (exactly the shape of the bounding-box measurement used earlier this session to confirm
the host and an asset-source MediaIn land in the mathematically-predicted box for a given transform), or
(b) an oracle render compared against an independently-computed expected image. `render:compare:pixels`
answers "do the two renderers agree"; only an absolute-ground-truth instrument answers "is either of them
right." This entry names the gap; building that harness is not attempted here.

**SECOND AXIS (2026-08-11) — the gate cannot see the EDITOR at all, only the two renderers.**

Registered here rather than as its own entry, deliberately. A reader consults this entry to answer one
question — *"my sweep is green; what has it NOT told me?"* — and splitting the answer across two
entries invites the specific mistake of fixing the differential axis (an absolute-ground-truth
harness, above) and concluding the gate now covers everything. It would not. These are two axes of one
instrument's blind spot: the first is *what both renderers compute wrongly together*; the second is
*what neither renderer draws at all.*

`render:compare:pixels` renders a composition through the web-preview path and the Remotion path. The
editor's own on-canvas surfaces — `MaskEditorOverlay`'s handles and outline, the inspector rows,
`flarex-mask-bridge.ts`, the node canvas — are in **neither**. They are not a renderer, they produce
no frame, and no fixture exercises them. The gate's universe does not contain them.

**The instance (slice 2, fixed in this commit).** Attaching a track to a Flarex mask node offset the
rasterized outline correctly — the compiler applied it, and the three tracked fixtures read 0.000% /
0.004% / 1.123% against their bars. But `flarex-mask-bridge.ts`, which builds the synthetic layer the
mask overlay edits, did **not** apply the same offset. The consequence is precise and bad: the editing
handles sat on the un-tracked outline while the rasterized edge sat on the tracked one, so at every
time except the track's start the user would drag a handle that was not on the shape it belonged to.
A full sweep was green throughout. It was found by driving the real editor in Chrome and reading
`.mask-outline path` at four playhead positions — four identical values where the track predicted four
different ones.

Note what makes this worse than a normal untested surface: the bridge exists **specifically** to keep
the overlay and the compiler in agreement (its own header says two resolvers "would mean the overlay's
handles could sit somewhere other than the rasterized edge, which is the specific failure a bridge
exists to prevent"). The one property it is for is the one property nothing checks.

**Detection.** Ask of any change: *does this alter something the user manipulates on the viewer, or
only something drawn into the frame?* Anything in the first category — overlays, handles, inspector
affordances, the bridge — is outside the gate regardless of how green it is. Slice 1b's dead alt-click
gesture and slice 2's untracked overlay were both in this category, and both were invisible to a full
sweep.

**Expiry condition.** A browser-driven editor gate exists and runs in CI: reach the editor, perform a
gesture, assert an observable DOM property (the `.mask-outline path` `d` attribute is the natural
subject — it is precise, it is the thing the user aims at, and it is already what the slice-1/1b/2
probes read). The apparatus is largely built and proven: `apps/worker/src/browser/editor-session.ts`'s
`reachEditor` is the maintained product-flow entry point, and the slice-1/1b/2 probes in
`apps/worker/tmp/` are working examples against real Chrome. What does not exist is the promotion of
any of it out of `tmp/` into a committed, named gate with stable selectors. Size: roughly two days for
a first gate covering mask-overlay geometry, most of it in making the selectors and the settling
robust enough not to flake — the recurring cost in every probe written so far has been waiting for the
workspace to mount, not the assertion itself.

**THIRD AXIS (2026-08-13) — the gate's universe is its FIXTURE LIST, so most of the product is
invisible to it for a reason that has nothing to do with the two renderers agreeing.**

Axis 1 is *both renderers compute the same wrong value*. Axis 2 is *neither renderer draws it at
all*. This third one is blunter and, measured, much larger: **the code is never executed by any
gate**, so whether the renderers would agree is moot. `6d58690` is the worked example — all four
multi-pass transitions had never compiled in any renderer, for the life of the feature, and the
commit's own words are the axis: *"a shader that never links is invisible to every pixel gate we
have… the defect survived because nothing rendered it."*

**Measured coverage, not estimated** (`apps/worker/tmp/debt017-shader-link-audit.ts --coverage`,
which walks every fixture's built graph and intersects it with the live registries):

| registry | exercised by ≥1 of the 76 fixtures | invisible |
|---|---|---|
| transitions | **3 of 29** — `crossDissolve`, `rgbDisplace`, `focusPull` | 26 |
| visual timeline effects | **14 of 24** | 10 |

The 26: `dip, wipe, iris, slide, push, zoom, punchZoom, zoomBlur, whipPan, blurSwipe, flash, shake,
spin, lumaFade, lightLeak, filmBurn, parallaxPush, glitch, pixelate, maskReveal, organicReveal,
lumaWarp, liquidMorph, portal, motionSmear, kineticSwoosh`. The 10: `hueSatCurves, creativeLook,
importedLut, sharpen, chromaticAberration, sketch, oldTv, glitchFx, halftone, posterize`. (Audio
effects are excluded — not a pixel concern.)

**Three details that make this worse than a bare coverage number.**

1. **`render:baseline` adds nothing on this axis.** It reads the same `renderComparisonFixtureKeys`
   array (`render-baseline-gate.ts:49,74-77`). Two gates, two instrument *shapes* — differential and
   historical — and **one identical universe**. Neither can see outside it, so "two gates passed" is
   one gate's coverage counted twice.
2. **3 of the 4 multi-pass transitions are still uncovered** — `liquidMorph`, `portal`,
   `motionSmear`. `6d58690` fixed the shared dedupe for all four and added a fixture for
   `focusPull` only. The fix is real and the other three are asserted-correct **by shared-code
   inheritance**, which is precisely the reasoning this entry exists to distrust.
3. **The uncovered fragment effects each compile their own program.** `sharpen`,
   `chromaticAberration`, `sketch`, `oldTv`, `glitchFx`, `halftone`, `posterize` are separate
   `buildFragmentEffectShader` programs, so a break in one is scoped to that one — no other fixture
   fails in sympathy, and the blast radius is exactly the thing nothing looks at.

**What would have to break for every gate to stay green, and does anything else catch it?**

| candidate | what breaks it silently | caught by |
|---|---|---|
| any of the 26 transitions | any GLSL error; a wrong constant; a dead param | **nothing** |
| the 7 uncovered fragment effects | same, scoped to that one program | **nothing** |
| pipeline uniform redefinition (the `6d58690` defect) | re-introducing the dedupe bug | `color:test` #40 — all 4 defs, both light spaces, on the SOURCE |
| a wrong transfer function both renderers apply | `effectLight` not reaching a renderer | `render:linear-gate` — absolute, predicted arithmetic |
| the keyframe evaluator | a wrong value at time *t* | `animation:test` |
| shared draw-building (`buildSceneDraws`) | a wrong transform on a cache hit | only for the ONE case DEBT-016 pinned |

**DEMONSTRATED, not argued — the class reproduced on demand.** `dip` (uncovered, monolith) was given
one undefined identifier (`TEMPORARY_DEBT017_FALSIFY_undefined_symbol`, reverted; `git diff` on
`transitions/registry.ts` empty and zero token matches after). With a shipped transition thereby
**dead in every renderer**:

```
debt017-shader-link-audit   FAIL  dip @display, dip @linear   (126/128 linked)
render:compare:pixels       PASS  7/7 — transition, advanced-transition, pipeline-transition,
                                  linear-transition, linear-pipeline-transition,
                                  nested-transition, nested-junction-transition
```

Every transition fixture in the tree, green, while a transition in the product cannot compile. That
is this entry's whole thesis, now with a repeatable one-command demonstration behind it.

**THE CURRENT STATE IS CLEAN, and that is the least interesting part of this audit.** With the
injection reverted, **128 of 128** assembled sources link against a real WebGL2 context — every
fragment effect (each pass of each multi-pass def) and every transition (each pass of each pipeline
def), in **both** light spaces, since `effectLight` selects between two different assembled programs
and a fixture exercising one says nothing about the other. So there is no dead shader today. The
class is live; its instances are latent. **Nothing in any gate performs this check** — the only
reason the number is known is that the probe was written for this audit, and it is deliberately not
wired into any script (promoting it is the founder's call, per the standing "different instrument,
not a code change" point).

**A CORRECTION TO THIS ENTRY'S OWN "right instrument, named but not built."** It IS built, for a
narrow surface: `render:linear-gate` renders a known input and checks it against **arithmetic
predicted in advance** (a blurred edge's midpoint at code 128 display / 188 linear; a crossfade at
progress 0.5 likewise; the `focusPull` pipeline landing on the same 188.0, which is evidence rather
than repetition because a defocus of a flat field is the identity). That is exactly shape (a) from
the paragraph above, it exists, and it has caught real defects — the truncated glow kernel and radial
blur's dead Centre Y. **What is missing is coverage, not design.** So the response to this axis is to
extend a proven instrument, not to build the harness this entry says is unscoped.

**TWO PROBE DEFECTS, recorded because both produced a confident, plausible, WRONG failure list** —
and in both cases the discriminator was a fixture already known to be green:
1. *A hand-written stub vertex shader.* Reported **0/128**, every one
   `FRAGMENT varying v_uv does not match any VERTEX varying` — including `crossDissolve`, which
   renders green today. A link is a contract between TWO shaders; the vertex half has to be the
   product's own (`FULLSCREEN_TRI_VS`, now imported) or every result describes the stub. **A probe
   that fails uniformly is measuring itself.**
2. *Passing a pass INDEX where the API takes the pass OBJECT.* `buildFragmentEffectPassShader(def,
   pass, light)` — with an index, `pass.glsl` is `undefined`, the literal text `undefined` lands in
   the source, and 18 cases failed with `'undefined' : syntax error` in `builtin.stylize` and
   `flarex.chromaKey`. Both are covered by green fixtures, which is the only reason it was caught
   rather than filed. Had this landed on an UNCOVERED effect there would have been no green fixture
   to contradict it, and the audit would have reported a live defect that does not exist.

**Expiry condition — unchanged in substance, and this audit is the first half of it.** The condition
asks for an audit naming what the gate can still see. The registry half is now measured and above.
The remaining half is the one this entry has always described: enumerate which parts of the *Flarex
render path* are still renderer-specific versus absorbed into `packages/shared`. Not attempted here,
and deliberately not estimated.

**STATED PLAINLY, because it belongs at the level of a rule rather than a footnote: `render:compare:pixels`
and `render:baseline` share one fixture universe, so their two passes are not two independent pieces
of evidence — they are one piece of evidence about that universe, read twice.** This weakens every
"both gates agreed" claim made about this codebase to date, including ones made in this register and
in this session's own reports, for anything the 76-fixture (now 82) set does not build. It does not
make those claims wrong for what they actually cover; it makes them narrower than "both gates agreed"
sounds. Read "N/N fixtures passed" as "the fixture set's own universe renders without incident", never
as "the product is correct" — the second claim needs an instrument that predicts an answer in advance
(below), not one that compares two things fed the same code.

**UPDATE (2026-08-13) — PROMOTED. The probe is now a real gate, three of the four coverage gaps this
audit itself found are closed, and the falsification was re-run through the wired gate, not just the
tmp probe.**

**The gate.** `apps/worker/tmp/debt017-shader-link-audit.ts` is now `apps/worker/src/render-link-gate.ts`
(`pnpm --filter @orreris/worker render:link-gate`), inside the worker's own `tsconfig` `include` rather
than typechecked separately. Same 128-source sweep (every transition and fragment effect, every pass,
both light spaces), no rendering, no fixtures, no baselines — the cheap, total half of the standard
split; golden images stay the expensive, curated half.

**The self-check is now mandatory, not a plan.** Before the main sweep runs at all, EIGHT cases —
one real sentinel per builder shape (transition monolith, transition pipeline pass, fragment
single-pass, fragment multi-pass), each checked once as-built (must LINK) and once corrupted with a
guaranteed-invalid top-level GLSL statement (must FAIL) — must all match expectation. A mismatch
aborts at exit 2 and reports NOTHING about the registries: this directly targets the two probe defects
this audit's own first pass produced (a stub vertex shader that failed uniformly; a pass-index-for-
pass-object argument bug), both of which were plausible specifically because nothing else was watching
the effects they landed on. Verified both directions: a clean run reads `self-check: 8/8 matched
expectation`, and the `dip` falsification below re-confirmed the self-check stays green even while the
main sweep goes red — i.e. the harness correctly distinguishes "the harness is broken" from "the
product is broken", which is the one distinction this whole entry is about.

**`dip` re-falsified through the WIRED gate, not just the tmp probe.** Same injection
(`TEMPORARY_DEBT017_FALSIFY_undefined_symbol`, reverted; `registry.ts` byte-identical after, zero
token matches):

```
render:link-gate   self-check: 8/8 matched expectation — harness trusted.
                   FAIL  transition dip @display / @linear
                   FAIL — 126/128 sources linked; 2 FAILED   (exit 1)
```

**Fixtures added for `liquidMorph`, `portal`, `motionSmear`** — the 3 of the 4 multi-pass pipeline
transitions this audit itself found still asserted-correct only by shared-code inheritance.
`liquid-morph-transition` / `linear-liquid-morph-transition` / `portal-transition` /
`linear-portal-transition` / `motion-smear-transition` / `linear-motion-smear-transition`
(`render-comparison-fixture.ts`), byte-for-byte the same shape as `pipeline-transition` /
`linear-pipeline-transition` — same transition pair, same 0.45s sample, `transitionKind` swapped — plus
a `different` cross-fixture relation for each display/linear pair, matching `focusPull`'s own. The
other 26 uncovered transitions and 10 uncovered effects were deliberately NOT given fixtures: link-
checking 128 sources is cheap and total; pixel-comparing 128 is neither, and a fixture nobody tunes a
bar for becomes the next flaky gate. Multi-pass was the right subset because it is where the dead ones
actually lived and where shared-code inheritance is weakest.

Measured, reproducible byte-identical across 3 independent runs (two scoped to just these six
fixtures, one inside the full 82-fixture sweep):

```
liquid-morph-transition          0.000% (5/2073600)
linear-liquid-morph-transition   0.000% (4/2073600)
portal-transition                0.000% (6/2073600)
linear-portal-transition         0.092% (1899/2073600)   <- portal's additive-mix pass is the
                                                             only one of the four that ADDS light
                                                             rather than only blending it
motion-smear-transition          0.000% (0/2073600)
linear-motion-smear-transition   0.001% (11/2073600)
```

All six given the 0.005 tier (matching the `flarex-*`/`flarex-tracked-mask-*` siblings) rather than
six bespoke values. `linear-portal-transition` is the tightest fit at ~5.4x headroom over its measured
reading — still 7x tighter than the 3.5% global, and the reading is a real, stable, reproduced-3-times
cross-renderer noise floor rather than a race.

**Coverage, before → after:** transitions 3/29 → **6/29** — `crossDissolve`, `rgbDisplace`,
`focusPull`, `liquidMorph`, `portal`, `motionSmear`. All four multi-pass pipeline transitions are now
covered; 26 monolith transitions and 10 fragment effects remain link-checked-only, by design (see
above). Fragment effects unchanged at 14/24 — out of scope for this round.

**Verification:** six typechecks zero. `render:link-gate`: self-check 8/8, main sweep 128/128, `dip`
falsification red (both above), self-check unaffected by the falsification. `render:compare:pixels`:
6/6 scoped to the new fixtures, then the full 82-fixture sweep — 82/82, all six readings
byte-identical to the two scoped runs, no regression elsewhere in the wider set. Tree held still
throughout (`fcd2559` unchanged as parent).

### DEBT-018 — a recovery the code declares available was never performed (paused WC fallback)

- Status: **RETIRED 2026-08-12** (see the closing update at the end of this entry)
- Registered: 2026-08-09 (a four-round measurement chain: D1-D4 seek-delay probe → path/cap-contention
  audits → E1-E4 seek-triggered demotion → F1-F4 telemetry-confirmed the `pausedStall` site, WRONG on
  the first-proposed `busyWedge` site → G1-G4 confirmed the seek is required and a full remount DOES
  restore WebCodecs, meaning nothing was blocking recovery — only the retry itself was missing)
- Reason: `WebglMediaLayer.tsx`'s paused-case stall guard (`WC_PAUSED_STALE_LAG_S`/`WC_PAUSED_STALE_MAX_MS`,
  ~line 2286 pre-fix) hands a layer to the native `<video>` element on a sustained stale-lag streak while
  paused, and — unlike the PLAYING branch, which deliberately blacklists via `wcBailedSources` — the
  paused branch never added the source to that list. The comment already said so ("Remember it (playing
  case) so a re-mount skips WC"). Nothing forbade recovery; nothing performed it either. One paused seek
  cost a user hardware decode for the rest of the session, and G4 measured that a page reload (a remount)
  fixed it by accident — confirming there was never a policy, only a missing retry.
- Invariant affected: none named in ADR-012/020; this is closer to DEBT-013's shape (a source denied a
  session with no path back) than to a numbered ADR invariant. Related, not identical: DEBT-013 is
  about ADMISSION losing a cap fight; this is about a SELF-HEAL declaring a source unservable with no
  re-attempt, on a single-source fixture with no contention at all.
- Owner: unassigned
- Expiry condition (for the remaining open half): A3 below is observed to fire — a real fourth
  `pausedStall` event after the 3-attempt budget is spent, producing the ladder's own "exhausted"
  console line — on any fixture, not necessarily this one.
- Planned slice: none: this is a bounded, already-landed fix, not a slice.
- Tracking issue: —
- Detection: any future change to `wcBailedSources`, `scheduleWcPausedRecovery`, or the paused branch of
  the stall guard should re-run `rulerjump:recoveryaccept` (A1-A3) before merging — the ladder shape is
  copied from ScenePreviewCanvas's context-loss ladder / SceneStage's DEBT-015 composite ladder
  specifically so it stays legible; diverging from that shape without re-justifying it here is the thing
  Detection exists to catch.
- **Header updated 2026-08-13:** Status was "fixed — one acceptance link (A3, exhaustion) remains
  observed-never, not disproven" from 2026-08-09 A1/A2 acceptance through the 2026-08-12 phase 1
  read — even though the SAME 2026-08-09 update, later in this entry, records A3 confirmed by
  injection. This is the exact drift the 2026-08-12 phase 1 read below names and the register now
  has a convention for. See `README.md`, "State fields vs. history."

**The fix, one paragraph.** `WebglMediaLayer.tsx`'s paused-stall branch now calls
`scheduleWcPausedRecovery()` instead of only falling back: up to `MAX_PAUSED_WC_RECOVERY_ATTEMPTS` (3)
bounded, backed-off (`[150, 300, 600]`ms) re-attempts, each re-entering the SAME lease-acquire effect a
starved-source reacquire already used (`wcReacquireEpoch` — S4.3/ADR-020 slice D), not a new acquisition
path. A sustained healthy run (120 clean guard passes) resets the budget, mirroring the two existing
ladders' shape exactly. The PLAYING branch (`wcBailedSources`) is untouched, as is `tolerateLag` behaviour
and both stall thresholds — none of those were the diagnosed defect and none were touched.

**Acceptance, A1-A3, measured (`rulerjump:recoveryaccept`), two full runs.**

| reading | result |
|---|---|
| A1 — recovery after a demoting seek | **confirmed**, twice: 1380ms and 1608ms after the demoting seek, no reload |
| A2 — no thrash across 10+ seeks / 60s | **confirmed**, twice: 2-3 scheduled attempts total across 17-18 repeated seeks, never exceeding the 3-attempt cap, no oscillation |
| A3 — the bound terminates under forced persistence | **not observed either way** — see below |

**A3, honestly unresolved.** Three independent attempts to force a fourth `pausedStall` (repeating the
exact triggering jump; repeating it in tight succession; cycling through ten DISTINCT far-from-keyframe
targets spread across the whole clip, in tight succession) all produced the same pattern: 1-2 stalls
right at the start of WebCodecs engagement for that source, then **zero further stalls across 100+ more
seeks of every kind tried**, including fresh jumps into regions never previously visited. This looks like
a real, reproducible property of the underlying decoder — once exercised a couple of times, this source
stopped presenting the stale-lag condition at all — not a probe bug (the same pattern held across two
full independent runs with different random session state). The consequence: the ladder's give-up path
(`attempt >= MAX` → console.warn "exhausted" → stay on element) was never exercised by measurement, on
this fixture. Per this round's own standard — "a recovery mechanism that has never been observed giving
up is not bounded, it is untested" — A3 is reported as **untested**, not confirmed, and the Expiry
condition above names exactly what would close it.

**Update (2026-08-09) — A3 confirmed, by injection rather than behaviour.** Three behavioural forcing
attempts above were reasonable and were never going to be reliable against a decoder that stabilises
after light use — that is a property of the decoder, not a gap in the probing. Closed instead the way
DEBT-015 closed its own untested branch: temporarily set `MAX_PAUSED_WC_RECOVERY_ATTEMPTS = 0` in
`WebglMediaLayer.tsx` (token `TEMPORARY-DEBT018A3-INJECTION`, reverted immediately after, proven clean
via `git diff` reporting no changes and a grep for the token returning zero matches), then fired the
same real trigger (seek 2 → 16.37) used throughout this investigation. Result:

```
mode before test seek: wc-hw
mode 8s after the stall-triggering seek: element
ladder console lines (1):
  WebglMediaLayer: paused WC recovery exhausted (0 attempts) — staying on <video> element for this source
saw "attempt" line: false (budget was 0 — correctly never scheduled one)
```

The exhaustion path fires exactly as designed: the warning logs, no attempt is scheduled, the layer
settles on `element`. **Status: fixed, all three acceptance links (A1/A2/A3) confirmed** — A1/A2 by
ordinary behaviour, A3 by injection because ordinary behaviour could not reach it. That distinction —
which link needed which method — is worth keeping on the record rather than collapsing into a single
"tested" checkbox.

**PHASE 1 READ (2026-08-12) — this entry is RETIRABLE, and its own header is the only thing still
saying otherwise.**

Read as part of a three-entry batch (DEBT-013/014/018) taken together because they share a subsystem
and a symptom. Findings for this one:

**It does not reproduce, and the fix is present and intact.** `WebglMediaLayer.tsx` still carries the
whole mechanism the 2026-08-09 update describes: `MAX_PAUSED_WC_RECOVERY_ATTEMPTS = 3` (`:85`), the
`scheduleWcPausedRecovery` ladder with its `[150, 300, 600]`ms backoff and its named exhaustion warning
(`:2180-2192`), the call from the paused branch of the stall guard (`:2398`), and the PLAYING branch's
`wcBailedSources.add(src)` left untouched beside it (`:2394`). Nothing since has moved it.

**The header contradicts the entry's own last update, and the header is the stale one.** The Status
line still reads *"fixed — one acceptance link (A3, exhaustion) remains observed-never, not disproven"*
and the Expiry condition still names A3 as the open half. The 2026-08-09 update closes exactly that:
A3 was confirmed by injection (`MAX_PAUSED_WC_RECOVERY_ATTEMPTS = 0`, token
`TEMPORARY-DEBT018A3-INJECTION`, reverted and proven clean), the exhaustion line logged, no attempt
scheduled, the layer settled on `element`. **The expiry condition as written is met.** Recommendation:
retire in place, on that evidence. Left as a recommendation rather than done here, because retiring an
entry is a founder call and this pass was a read.

**Not the same defect as DEBT-013, and the difference is worth keeping.** Both end in the same visible
state — a source on `<video>` for the rest of the session with no way back — which is why batching them
was reasonable. They are not one mechanism:

| | DEBT-013 | DEBT-018 |
|---|---|---|
| who decides | the POOL, on a cap it cannot satisfy | the LAYER, abandoning a session it already holds |
| contention | required (more sources than slots) | none — single source, spare capacity |
| what recovery needs | a permission AND a free slot AND a trigger | only a retry |
| status | open, clause (a) unmet | fixed, all three links confirmed |

**What they DO share is the recovery vehicle, and that is the useful finding.** DEBT-018's ladder
re-enters the same lease-acquire effect through `wcReacquireEpoch` that ADR-020 slice D introduced for
starved sources — it does not add an acquisition path. So DEBT-018's A1 (recovery measured 1380ms and
1608ms after a demoting seek, twice, no reload) is **the only end-to-end demonstration anywhere in this
programme that `wcReacquireEpoch` actually re-acquires and succeeds.** DEBT-013 has never observed one.
That matters for how DEBT-013 is read: its gap is upstream of the vehicle — permission, victim, and a
fixture that still denies — not in the re-acquire itself. Cross-referenced rather than merged.

**RETIRED 2026-08-12, on the evidence this entry already contained.**

Retired on the founder's call after the phase 1 read above. Nothing new was measured to retire it, and
that is the point: **the expiry condition was met on 2026-08-09 and the header was never updated.**

The condition, as written: *"A3 below is observed to fire — a real fourth `pausedStall` event after the
3-attempt budget is spent, producing the ladder's own 'exhausted' console line — on any fixture."* The
2026-08-09 update in this entry records exactly that: `MAX_PAUSED_WC_RECOVERY_ATTEMPTS = 0` (token
`TEMPORARY-DEBT018A3-INJECTION`, reverted and proven clean by `git diff` and a zero-match grep), the
real seek trigger fired, `mode 8s after the stall-triggering seek: element`, and the ladder's own line
logged: *"paused WC recovery exhausted (0 attempts) — staying on `<video>` element for this source"*,
with no attempt scheduled. A1 and A2 were confirmed by ordinary behaviour (recovery at 1380ms and
1608ms after a demoting seek, twice, no reload; 2-3 attempts across 17-18 seeks, never exceeding the
cap). All three acceptance links hold; the fix is present and intact in `WebglMediaLayer.tsx`
(`:85`, `:2180-2192`, `:2394`, `:2398`), unmoved by anything since.

**What was actually wrong here was bookkeeping, and it is worth naming.** An entry whose Status line
and Expiry condition contradict its own most recent update is not "open" — it is unmarked, and it
costs a full read to discover that. The phase 1 batch spent its DEBT-018 budget rediscovering a
conclusion the entry already stated. The register's own rule ("append a new dated note") makes the
header the oldest text in a long entry by construction, so a reader who stops at the header reads the
entry backwards. Both DEBT-018 and DEBT-013 hit this in the same pass, in the same way.

**Not merged with DEBT-013**, and the comparison table above is the reason. DEBT-018's A1 remains the
only end-to-end demonstration in this programme that `wcReacquireEpoch` re-acquires and succeeds in
the product — which is why retiring this entry does not weaken DEBT-013's position but locates it: the
vehicle works, and 013's gap is upstream of it.

### DEBT-019 — a source provider holds the WHOLE file in memory, so residency scales with clip length

- Status: **open, narrower again.** Remote range-paging SHIPPED (2026-08-13). The ~15 MB/source
  residual is **ATTRIBUTED (2026-08-13)** and its park is LIFTED — it is decoded frames held in the
  decoder's own bounded output queue plus the chunk window, priced by frame GEOMETRY and
  **duration-independent**; see the attribution update at the end of this entry. What remains open is
  smaller and different: a ~4.8 MB/source browser-internal decode floor with no JS object behind it
  (not actionable), and the untouched pass-through mint sites this entry flags but does not fix
  (`useFlarexCompProxies.ts:331` etc.).
- Registered: 2026-08-10 (surfaced by the ADR-021 pull-model feasibility measurement, not by a slice)
- Reason: `fetchSourceBlob` (`apps/web/src/export/webcodecs-decoder.ts`) materialises the entire
  source file as a `Blob` and the provider retains it for its whole lifetime, because the chunk
  window (`createBlobChunkWindow`) slices encoded samples out of that Blob on demand. That was a
  sound trade when a small, fixed number of sources were live at once: one Blob per playing clip is
  cheap, and slicing a resident Blob avoids re-issuing range requests per GOP. It stops being sound
  the moment the number of simultaneously-live sources becomes a product variable rather than a
  constant — which is exactly what ADR-021's frame-provider seam makes it.
  **The cost is a function of clip LENGTH, not of resolution or of how much of the clip is used.**
  A provider that serves one frame of a 2-minute source still holds the whole 2-minute file.
- Invariant affected: **none — and that is the finding.** I-8 governs *tracked GPU resources* and a
  source Blob is CPU memory that no subsystem tracks at all, so this residency is invisible to the
  Resource Manager's accounting and to every budget built on it. Same shape as DEBT-003 (accounted
  but not owned), one level worse: not accounted either.
- Owner: unassigned
- Expiry condition (restated 2026-08-13, see the phase-1/2a/2b updates and the remote-range-paging
  close below for why): the original wording — "the encoded-sample window is demand-paged and
  evictable" — is **already satisfied** and was never the unbounded term; the window
  (`WINDOW_MAX_SPAN_BYTES`, 24 MB) was bounded from the start, for BOTH source kinds now. Current
  condition: **no source kind retains a whole-file copy by default** —
  `sourceResidentBytes().copiedBytes` reads 0 on a local-only project AND on an all-remote project
  whose server honors Range, at every rung — **plus 25 bytes × sample count for the sample index**
  (≤0.09 MB for a 2-minute 30fps source, ≤0.5 MB for 10 minutes, ≤2.7 MB per hour), **plus the 24 MB
  transient chunk window**, with total provider residency reported in BYTES (never provider count) to
  whatever authority enforces ADR-021's I-P6 budget. A remote source whose Range probe fails degrades
  to `copiedBytes` honestly (see the close below) rather than silently reinstating this debt. This
  does NOT claim total residency is duration-flat: a ~15 MB/source residual at N=100 is real,
  measured, and — as of 2026-08-13 — present at a closely matching ratio on BOTH source kinds, not a
  local-only artifact. **No longer unattributed:** the attribution update at the end of this entry
  names it (decoded frames + the chunk window, priced on frame geometry, duration-independent) and
  leaves ~4.8 MB/source as a browser-internal decode floor.
- Planned slice: none. The residual's sizing was the prerequisite ADR-021 step 2 was waiting on and it
  is DONE — that step's I-P6 budget is charged on the measured per-provider figure. Remote
  range-paging is likewise DONE, not planned — see the close below.
- Tracking issue: —
- Detection: any new consumer that constructs providers per *source* rather than per *playing clip*,
  without first asking what the resident-byte ceiling is. Concretely: a `createFrameProvider` call
  site whose count is bounded by the project's asset count or a comp's node count instead of by a
  small constant. Also — a memory budget expressed in **provider count** rather than in **bytes** is
  this debt being extended, because count is only a proxy for bytes while clip lengths are similar.
- **Header updated 2026-08-13 (morning):** Status was plain "open" from registration; Expiry
  condition named the encoded-sample window as the unbounded term. Both were superseded by the
  entry's own 2026-08-12 phase-1 measurement (the window was never unbounded; the Blob was) and 2b's
  restated ceiling. See `README.md`, "State fields vs. history."
- **Header updated 2026-08-13 (afternoon):** Status and Expiry condition rewritten again — remote
  range-paging shipped, closing this entry's namesake product-breaking ceiling and extending the
  "already satisfied" half of the expiry condition to remote sources. See the closing update at the
  end of this entry for the measurement.

**Measurement (2026-08-10, `plans/adr-021-pull-model-feasibility.md`).** N live providers over
distinct 1280×720 sources, sum of all `chrome.exe` working sets, fresh browser per rung with a
baseline taken before the providers exist:

| N | delta | per source |
|---|---|---|
| 1 | 106 MB | 106.4 MB |
| 25 | 617 MB | 24.7 MB |
| 50 | 892 MB | 17.8 MB |
| 100 | **2546 MB** | 25.5 MB |

~25 MB per source at N=100 — **with 3-second clips**. This is why memory, not latency, is the first
hard wall in ADR-021 §3.2(a). The figure is not a resolution effect: the same clips at 2 minutes
would hold ~40× the bytes per source for the same picture on screen.

**Why this is a defect on its own terms, independent of ADR-021.** It is registered here rather than
inside the ADR because it is not conditional on the seam shipping. Today's timeline already builds a
provider per playing clip, and a project cutting between several long sources pays the same
whole-file residency for clips it shows for a second. The pull model makes it acute; it does not
make it true.

**Update (2026-08-12) — Phase 1 investigation: the premise is CONFIRMED, the shape is not what this
entry says, and the named remedy is aimed at the wrong term.** Read-only; no product code changed.
Measured with `apps/worker/tmp/debt019-residency-probe.ts`, same instrument and rules as the ladder
above (sum of every `chrome.exe` working set, fresh browser per rung, baseline in that same browser
before the sources exist), over two corpora identical in every axis except duration — 3s vs 120s.

*The instrument had to be fixed first, and the fix matters for anyone re-running the original
ladder.* `browser.close()` does **not** reap Chrome here: a first pass left 16–36 `chrome.exe` alive
and every rung after the first baselined against the previous rung's corpses, producing baselines of
1.4–3.3 GB and **negative deltas** (−694 MB). The probe now hard-kills chrome and refuses to measure
a rung unless the count reaches zero first; baselines then sit at 460–490 MB, consistent with the
original study's ~445 MB. Numbers from any ladder that did not enforce that floor are suspect.

**Term 1 — the Blob. The claim is true: it is RAM-resident and it scales 1:1 with file size.**
Variant `blob` holds only `fetch(url).blob()`, no demux and no decoder:

| corpus | file size | N | delta | per source |
|---|---|---|---|---|
| 3s | 1.9 MB | 10 | 49 MB | 4.9 MB |
| 120s | 76.8 MB | 10 | 865 MB | **86.5 MB** |

40× the duration buys **17.6×** the per-source residency, and 86.5 MB resident for a 76.8 MB file is
a whole-file RAM copy plus overhead. Chromium is not spooling these to disk at this working-set size.
**This directly falsifies the file's own header comment** (`webcodecs-decoder.ts:10-16`: "disk-backed
Blob … Peak RAM is O(one GOP window), not O(file)"). The window part is true; the Blob part is not.

**Term 2 — the chunk window is ALREADY demand-paged, bounded and evictable.**
`createBlobChunkWindow` (`webcodecs-decoder.ts:386`) caps each materialization at
`WINDOW_MAX_SAMPLES = 96` **and** `WINDOW_MAX_SPAN_BYTES = 24 MB`, and `ensure()` does a
whole-window replace (`loaded = next`), which is a strict bound, not a leak. It is duration-*flat*
by construction — for a 120s source the window covers ~3.2s of samples. So this entry's Expiry
condition ("the encoded-sample window is demand-paged and evictable") **is already satisfied**, and
work aimed there would close nothing. The unbounded thing is not the window; it is the Blob the
window slices out of.

**Term 3 — the sample index, a real but secondary duration-scaling term.** `SampleIndexEntry[]` is
one JS object per sample (`webcodecs-decoder.ts:48`), so it is O(duration) on the JS heap: at N=10
the heap goes 56.2 MB (3s) → 73.9 MB (120s), ≈ **1.8 MB per 2-minute source**. Unbounded in
principle (a 2-hour source is ~216k entries) and, like the Blob, invisible to every budget.

**Term 4 — flat.** Full provider minus blob at N=10 is ≈25 MB/source on the 3s corpus: `VideoDecoder`
+ DPB + pinned frames + the 64 MB-capped reverse cache. This is the ~25 MB/source the original ladder
reported, and it is **not** the Blob — at 3s the Blob is only 4.9 MB of it. The headline figure that
motivated this entry was therefore mostly attributed to the wrong term.

**The finding that changes the fix: residency DIFFERS BY SOURCE KIND, and for the local-first path
it is entirely gratuitous.** `createFrameProvider` is not usually handed a remote URL. OPFS assets
are `URL.createObjectURL(await handle.getFile())` (`apps/web/src/lib/asset-blob-store.ts:175`) — an
object URL over a **disk-backed `File` that already slices lazily at zero residency** — and the store
already exposes that File directly as `getBlob(id)` (`:184`). `fetchSourceBlob` takes that URL and
does `fetch().blob()` over it, which measurement shows is a **full disk→RAM copy**, not a handle
pass-through. Six OPFS files of 32 MB, both arms paying the identical write cost:

| variant | what is held | delta | vs. the other arm |
|---|---|---|---|
| `opfs-file` | the `File` from `handle.getFile()` | 204 MB | — |
| `opfs-fetch` | `fetch(objectURL).blob()` | 430 MB | **+226 MB for 192 MB of files** |

Holding the File costs nothing beyond the write; fetching a copy costs the whole file. So:

- **Local / OPFS / IndexedDB sources (the dominant path):** there is no paging problem to solve. The
  bytes are already on disk and already lazily sliceable. The fix is to stop making the copy — pass
  the `File`/`Blob` through instead of re-fetching its object URL. `blob.slice()` in the existing
  window then reads from disk on demand, unchanged.
- **Remote http(s) sources:** the residency is real and unavoidable *as written*, and this is the
  only case that needs actual demand-paging — HTTP `Range` requests per window instead of one
  whole-body `.blob()`. Both the R2 origin and the probe's own media server already advertise
  `Accept-Ranges`.

**Consequences for this entry.** The debt is real and stays open — a provider does hold whole-file
RAM that scales with duration. But (a) its Expiry condition as written is already met and must be
restated in terms of the Blob, not the window; (b) the dominant per-source term in the ADR-021
ladder was decoder state, not the Blob, so ADR-021 §3.2(a)'s memory wall does not move as much as
closing this debt might suggest; and (c) the two source kinds are two different fixes, one of which
is a deletion rather than a mechanism. **Restated expiry condition:** a provider's resident encoded
bytes are bounded by a byte budget independent of source duration — local sources by holding the
disk-backed `File` rather than a fetched copy, remote sources by range-paging the window — with
total provider residency reported in BYTES to whatever authority enforces ADR-021's I-P6 budget.

**Update (2026-08-12) — Phase 2a shipped: the local-source copy is deleted. Status stays OPEN
(remote range-paging is a separate slice), and THE ORIGINAL LADDER IN THIS ENTRY IS RETRACTED.**

**Retraction first, because it is the most quotable thing here.** The 1 / 25 / 50 / 100 table above
(106 / 617 / 892 / **2546 MB**, "~25 MB per source") was produced without a zero-Chrome floor.
`browser.close()` does not reliably reap its tree on Windows, so rungs can baseline against the
previous rung's corpses — the failure mode that produced baselines of 1.4–3.3 GB and deltas of
−694 MB when it was noticed. **Those four numbers should not be quoted as fact.** Their headline
conclusion is also wrong on attribution: measured cleanly, ~25 MB/source at 3 seconds is dominated
by DECODER state (VideoDecoder + DPB + pinned frames), which is FLAT in duration. The Blob — the
term this entry is named for — was only **4.9 MB** of it. The debt was real and the motivation
pointed at the wrong thing. Any ladder that did not enforce the floor is suspect, including that one;
`src/browser/browser-preflight.ts` now enforces it and refuses to run without it.

**What shipped.** `fetchSourceBlob` no longer copies a source we already have. `object-url-registry.ts`
records url → Blob at the four places object URLs are minted (`asset-blob-store.cacheUrl`,
`proxyMediaStore` OPFS + memory, `sourceProxyEngine`, `api.ts` upload), and `sourceBlobFor` returns
that original Blob. For OPFS/IndexedDB assets and picked Files that Blob is a disk-backed handle, so
`blob.slice()` reads each window off disk and **nothing is resident**. Remote http(s) still fetches.
`sourceResidentBytes()` / `window.__rfSourceResidency` report `copiedBytes` vs `passthroughBytes` —
in BYTES, never in provider count, per this entry's own Detection clause. The chunk window was left
exactly as it was, per Phase 1: it was never the unbounded term.

**Both ladders, clean instrument, fresh browser per rung, zero-Chrome floor enforced, providers
proven live (100 streaming / 0 fragmented, 400 getFrame calls, 0 nulls, 5827–9303 decodes) and
proven to page (frames pulled at 2%/35%/70%/98% of each clip, not one frame at 0.5s).** `local` is
the shipped path (OPFS → `getObjectUrl` → provider); `remote` is the unchanged fetch path, i.e. the
before-picture, measured in the same run:

| N | 3s local | 120s local | ratio | 3s remote | 120s remote | ratio |
|---|---|---|---|---|---|---|
| 1 | 109.1 | 127.4 | 1.17× | 113.9 | 216.3 | 1.90× |
| 25 | 14.0 | 21.4 | **1.53×** | 19.7 | 107.9 | **5.48×** |
| 50 | 14.4 | 19.8 | 1.38× | 17.3 | **could not complete** | — |
| 100 | 11.8 | 29.3 | 2.48× | 15.5 | **could not complete** | — |

(MB per source. Duration varies 40× between the two corpora.)

`copiedBytes` was **0 at every local rung** — the pass-through is proven engaged, not inferred from
the memory number it would otherwise be used to explain.

**The remote path could not finish its own ladder.** At 50 × 2-minute sources it exhausts, falls
back to `<video>`, and times out — reproduced twice. The fixed local path completed the same rung at
19.8 MB/source and went on to N=100. So this is not only a byte reduction; at realistic source
lengths it is the difference between working and not.

**HONEST FAILURE TO MEET THE PASS CONDITION.** The bar was per-source residency FLAT across
duration. Local is 1.17–2.48×, not 1.0×. It is a large improvement on the 1.90–5.48× it replaces and
the named term is gone, but it is not flat, and the residual is duration-scaling:
- **~7 MB/source** of sample-table metadata (our `SampleIndexEntry[]` — one JS object per sample —
  plus mp4box's own parse structures). Isolated by re-running with a SINGLE pull per clip, which
  drops the ratio to 1.33×.
- **the rest, ~14 MB/source, is decode/seek state** that only appears under multi-point access: a
  long clip's four pulls cross GOPs and force resets (9303 decodes vs 5827 for the short corpus).
Neither is the Blob, and neither was in this slice's scope. The index term is the obvious next one —
five parallel typed arrays instead of 3600+ objects — and it is cheap.

**Restated, again, for what remains open:** remote http(s) sources still hold whole-file RAM copies
(`sourceBlobCache`, ≤12 entries) and still need range-paged windows; the fragmented-MP4 fallback is
O(file) for BOTH source kinds by construction; and the sample index is O(duration) regardless of
source kind. Local sources no longer hold encoded bytes at all.

**PHASE 2b (2026-08-12) — the sample index is now typed-array COLUMNS, and the measurement RETRACTS
the attribution that motivated it. The term was real and is closed; it was never ~7 MB/source, and
closing it moved per-source residency by nothing measurable.**

`SampleIndexEntry[]` — one JS object per sample, five properties each — is now five typed arrays
(`Float64` offset, `Uint32` size, `Float64` timestamp, `Uint32` duration, `Uint8` isKey), allocated
once at the exact sample count both demux paths already know. `keyIndices` went the same way
(`Int32Array`), because an all-intra source has one entry per sample there and a JS `number[]` would
have re-introduced a duration-scaled term beside the one being removed. Every consumer was converted;
the chunk window, the cursor scan, the fps derivation and `decodableEndSeconds` read columns now.

**THE ARITHMETIC, BEFORE AND AFTER — and the before was wrong by ~80×.** Phase 2a attributed
~7 MB/source of the 120s residual to sample-table metadata, and predicted that at N=100 the 120s local
rung (29.3 MB/source) sat about 4 MB above a ~25 MB/source duration-flat decoder floor, so this fix
should land within noise of that floor. `residency.indexBytes`/`indexSamples` now measure the term
directly instead of attributing it, and it reads:

| corpus | samples held (N=100) | index bytes | per source |
|---|---|---|---|
| 3s | 9,000 | 0.2 MB | **0.002 MB** |
| 120s | 360,000 | 8.6 MB | **0.086 MB** |

**0.086 MB per 2-minute source, not 7 MB.** The phase-2a figure was a residual attributed by
subtraction — the leftover after a duration-flat floor was assumed — and nothing checked it against
the shape it named. It was checkable in advance: 3600 samples reaching 7 MB requires ~2 KB per sample,
and a five-field JS object is two orders of magnitude smaller than that. Measured directly for the two
shapes at the sizes the decoder actually builds (`tmp/debt019-index-shape-probe.ts`, retained heap
after a forced GC):

| samples | rows (JS objects) | columns (typed) | bytes/sample |
|---|---|---|---|
| 360,000 (100 × 2-min) | 19.65 / 19.66 MB | 8.59 / 8.58 MB | **57.2 → 25.0** |

Two consecutive runs, reproducing to ±0.1 B/sample, and the column figure lands exactly on the
analytic `25 = 8+4+8+4+1` — which is the check that the probe measures the object it names. Only the
large run is quoted: `performance.memory` is quantised coarsely enough that a few-hundred-KB
allocation sits inside its own granularity (the 3600-sample rows read 37.9 B/sample, and a mid-size
run once read **negative** — a collection landing inside the baseline). Extrapolated to one 2-minute
30fps source: **~201 KB of objects → 88 KB of columns, a saving of ~0.11 MB per source.**

**So the fix is right and the reason given for it was not.** The columns are the correct shape — they
remove hundreds of thousands of allocations, make the table's cost exactly `25 × samples` bytes and
state that ceiling in the type — but they close a term worth ~0.09 MB/source, not one worth ~7, and
the ladder confirms they move the total by nothing outside noise.

**Local ladder, re-run at the same shape (both corpora and both arms in ONE process, one proven build
identity, fresh browser per rung, zero-Chrome floor enforced, `copiedBytes` 0 at every local rung):**

| N | 3s local | 120s local | ratio | 120s local, phase 2a | index held (120s) |
|---|---|---|---|---|---|
| 1 | 100.8 | 102.8 | 1.02× | 127.4 | 0.1 MB |
| 25 | 14.5 | 23.9 | 1.65× | 21.4 | 2.1 MB / 90,000 smp |
| 50 | 14.0 | 19.4 | 1.39× | 19.8 | 4.3 MB / 180,000 smp |
| 100 | 12.3 | 27.8 | 2.26× | 29.3 | 8.6 MB / 360,000 smp |

(MB per source; duration varies 40× between corpora.) Providers proven live and proven to page: 100
streaming / 0 fragmented, 400 `getFrame` calls, 0 nulls, 5,856–9,307 decodes, pulls at 2/35/70/98% of
each clip. Preconditions: `PIXEL_BROWSER_CHANNEL=chrome`, **0 chrome.exe before the run**, 10 node.exe,
worktree root PROVEN. One caveat on that last one, stated because it matters: the build-identity check
hashes `scene-frame-compositor.ts`, which this change does not touch, so it proves the dev server's
ROOT and not this file's content — what proves the new build is serving is the `index …smp` reading
itself, which does not exist in the previous build.

Ratios are 1.02–2.26× against phase 2a's 1.17–2.48×: **inside the ladder's own rung-to-rung noise.**
Nothing was expected to move once the term's true size was known, and nothing did.

**THE RESIDUAL IS UNATTRIBUTED, and is stated that way rather than re-attributed by subtraction — the
error above was made once already.** At N=100 the 120s local rung is ~15 MB/source above the 3s rung.
Named terms account for 0.086 MB of it. Two hypotheses were tested by reading and **both are refuted,
recorded here so nobody spends the day re-deriving them**:
- *mp4box's own sample array, retained via the `track` object the provider keeps.* Refuted:
  `ISOFile.getInfo` builds `track` as a fresh plain object of copied scalars (mp4box 0.5.4,
  `mp4box.all.js:6905-6990`); its only references into the parsed tree are `edits` and the tkhd
  `matrix`, neither of which reaches `trak.samples`.
- *the codec `description` aliasing a large parse buffer.* Refuted: `getDescription` writes the
  avcC/hvcC box into a **fresh** `DataStream` and returns a view on that, so it retains tens of bytes.

**The instrument this now needs is not the ladder.** A working-set delta can say how much, never what
holds it, and every mis-attribution in this entry came from asking it the second question. The next
step is a heap snapshot with retainer paths taken at a held rung, plus a per-term ablation (build
providers with the decode step skipped, with the window disposed, with the index dropped) — a
different instrument, and a separate slice from this one.

**EXPIRY CONDITION RESTATED — "flat" was the wrong target, and is withdrawn.** A sample index has one
entry per sample by definition, and every NLE keeps one because it is how seeking works; a decode path
whose retained bytes do not vary at all with duration is not achievable and was never the right bar.
Replaced with a **byte ceiling on the terms this entry names**, which is achieved and provable today:

> For a LOCAL source, the decode path retains **zero whole-file copies** (`sourceResidentBytes().copiedBytes`
> reads 0 on a local-only project, at every rung) plus **25 bytes × sample count** for the sample index —
> ≤ 0.09 MB for a 2-minute 30fps source, ≤ 0.5 MB for 10 minutes, ≤ 2.7 MB per hour — plus a chunk
> window bounded by `WINDOW_MAX_SPAN_BYTES` (24 MB) that is transient and evicted on advance.

That ceiling does not grow meaningfully with duration and is the honest form of what this entry asked
for. **It does not claim the residency question as a whole**: total per-source residency still varies
1.0–2.3× across a 40× duration change, that variance is unattributed, and it is tracked as the open
item above rather than folded into a condition this entry can mark satisfied.

**THE REMOTE EXHAUSTION IS A PRODUCT CEILING IN ITS OWN RIGHT, not a footnote to a memory ladder.**
Recorded as a first-class finding: **the unfixed remote path cannot build 50 concurrent 2-minute
sources.** It exhausts, falls back to `<video>`, and times out — three independent
reproductions now — where the fixed local path completes the same rung and goes on to N=100. Stated as
a limit rather than a measurement: a project may hold roughly 25–50 2-minute remote
sources before the decode path stops working, against no such limit on local ones. That asymmetry is
what makes remote range-paging a **scheduled slice** rather than a someday item — it is not a byte
optimisation, it is the difference between a working project and a broken one, and it lands on exactly
the sources a user does not control the size of (stock, cloud, shared).

**A missed pass-through site, found while reading and deliberately NOT fixed here.**
`useFlarexCompProxies.ts:331` mints an object URL with a bare `URL.createObjectURL(stored.blob)` for a
comp proxy read out of IndexedDB, so that URL is invisible to `object-url-registry.ts` and
`sourceBlobFor` falls through to the fetch — a disk-backed blob copied into RAM, which is the exact
defect phase 2a deleted, at a site phase 2a did not cover. It is one line plus its paired revoke, but
its proof is "which sources still copy on a real project" (`copiedBytes` on a live editor), not
"bytes vs duration on a synthetic ladder", and it needs an audit of the other mint sites rather than a
single spot fix. Registered here so it is not rediscovered: the remaining untracked video-source mint
sites are `useFlarexCompProxies.ts:331`, `sourceProxyStore.ts:239/266/289`, `sourceProxyEngine.ts:737`,
and the picked-`File` sites in `CreatePage.tsx`/`EditorPage.tsx`.

**PARKED WITH A TRIGGER (2026-08-12): the ~15 MB/source unattributed residual blocks ADR-021 step 2's
I-P6 budget, and nothing before it.** — *superseded 2026-08-13: the trigger fired and the residual is
attributed; see the attribution update at the end of this entry. The reasoning below is retained
because it is what made this a park rather than a stall, and because it correctly predicted both the
instrument and the two failure modes that instrument would hit.*

Founder call, and the reasoning is worth keeping because it is what makes this a park rather than a
stall. The residual is real and is correctly recorded above as UNATTRIBUTED. But it only bites at
large N, and today the timeline builds a provider **per playing clip**, so N is small and this costs a
user nothing. Large N is precisely what ADR-021's frame-provider seam introduces — every source
becomes a provider whether or not it is playing — and that work is deferred. So the trigger is not a
date and not a symptom report: **ADR-021 step 2 may not accept its I-P6 residency budget while this is
open.** Sizing it before then would be building a measurement for a shape that does not exist yet.

**The next instrument, written down so the next investigator does not start where the last two rounds
did.** Do NOT open with a working-set delta. Every mis-attribution in this entry — the retracted
~25 MB/source, the retracted ~7 MB/source index term — came from asking a delta *what* was holding
memory, which it cannot answer; it can only ever say *how much*. What is needed is:

> A **heap snapshot with retainer paths** taken at a large-N rung, plus a **per-term ablation** (build
> the provider with the index disabled, with the chunk window disabled, with the decoder unconfigured,
> and difference the retained sizes). The snapshot names the holder; the ablation prices it. Either
> alone reproduces the error already made twice.

Two hypotheses are already dead and should not be re-derived: mp4box's sample array is NOT retained
via the `track` object (`getInfo` builds a fresh object of copied scalars), and the codec
`description` does NOT alias a parse buffer (`getDescription` writes into a fresh `DataStream`).

**Harness note (2026-08-12), belonging to this entry because the reaper was born here.**
`browser-preflight.ts` counted BROWSERS, so it passed a machine holding two leftover **node** trees
from earlier `wc:gate` runs and the next run hung with no output and no browser for ~25 minutes — the
same class of failure the preflight was promoted to prevent, one process class over. It now also
refuses on a live process running the calling gate's own script (`scriptMarker`), excluding this
process and its ancestors. Both directions were exercised on the way in: it caught three real corpses
on its first run (one of them the run whose PASSED output had already been read), and it produced one
false positive by building its ancestor map from `node.exe` rows only — the chain
`pnpm → shell → tsx` has a non-node link, the walk stopped at the hole, and the preflight refused on
its own two parents. The map is now built from ALL processes and filtered to node afterwards.

The root cause of the leftovers was in the gate, not the preflight, and is fixed too: `stopProcess`
killed the `cmd.exe` that `spawn(..., { shell: true })` returns, which dies obediently while the vite
node process underneath survives holding the stdio pipes it inherited — so a gate that had already
printed PASSED could not exit. It now `taskkill /T /F`s the tree and waits.

**UPDATE (2026-08-13) — REMOTE RANGE-PAGING SHIPPED. The namesake ceiling (this entry's own
"could not complete" finding, three reproductions) is closed: N=100 × 2-minute remote sources now
completes cleanly, where it previously exhausted at 50 and fell back to `<video>`.**

**What shipped.** `fetchSourceBlob`'s whole-body `fetch(url).blob()` is no longer the only path for a
remote http(s) source. `sourceBlobFor` now calls `remoteByteSourceFor`
(`apps/web/src/export/webcodecs-decoder.ts`), which pages the SAME window the local pass-through
already uses — `WINDOW_MAX_SAMPLES` (96) / `WINDOW_MAX_SPAN_BYTES` (24 MB), whole-window replace —
over HTTP `Range` instead of `Blob.slice()`. A new `ByteSource` interface (`{ size, slice(start, end):
{ arrayBuffer() } }`) is the seam: `Blob` already satisfies it structurally, so `demuxIndex`,
`demuxFragmented` and `createBlobChunkWindow` needed ZERO changes — the same 4 MB
(`INDEX_SLICE_BYTES`) index-parse rounds and the same ≤24 MB feed window now bound a `Range` GET
exactly as they bounded a `Blob.slice()`. `RangedRemoteByteSource` implements `ByteSource` over
`fetch()` with an explicit `Range` header; `probeAndBuildRangedSource` confirms support with a REAL
byte-range request (a `206`, not an `Accept-Ranges` header taken on faith) and that same response
primes `demuxIndex`'s first round, so detection costs nothing on the happy path.

**The four things the task named, each decided and tested, not assumed:**

- **A server that ignores Range.** Detected by the actual response status, not a header:
  `probeAndBuildRangedSource` throws `NotRangeableError` on anything but a real `206`, and
  `remoteByteSourceFor` degrades to `fetchSourceBlob`'s existing whole-file copy — charged as
  `copiedBytes`, the SAME bucket a real whole-file fetch already uses, specifically so the degrade
  cannot read as a win in the residency numbers. Exercised for real (not asserted): a purpose-built
  Range-blind test server (`apps/worker/tmp/debt019-latency-probe.ts`'s `rangeBlindServer`, answers
  preflight normally, then always returns 200 with the whole body) drove three of the four measured
  cases below. A URL that fails the probe once is remembered (`rangeUnsupported`) so later providers
  for the same source don't re-pay a doomed probe — but only for a real non-206 response; a
  network-level failure (dead URL, timeout) is NOT remembered as "unrangeable", since it says nothing
  about Range support and must not poison a later attempt once the network recovers.
- **CORS.** Checked against the storage this product actually uses, not assumed: `fetch()` with an
  explicit `Range` header is a non-simple cross-origin request, so the browser preflights with
  `OPTIONS` — unlike the existing native `<video>`/`OffthreadVideo` Range usage this repo already
  ships, which the browser's own media pipeline issues and does NOT preflight. The `/storage` CORS
  middleware (`apps/api/src/app.ts`) was permissive on `Access-Control-Allow-Origin` but had no
  `Allow-Methods`/`Allow-Headers` and no `OPTIONS` handler, so a preflight fell through to the R2
  proxy handler's `405` (or a static 200 with no CORS headers) and the browser blocked every real
  range read — silently reinstating this debt. Fixed with `Access-Control-Allow-Methods`,
  `Access-Control-Allow-Headers: Range`, an `OPTIONS → 204` short-circuit, and
  `Access-Control-Expose-Headers: Content-Range, Accept-Ranges, Content-Length` (also required —
  those response headers are NOT on the cross-origin safelist, so without it `fetch()` could see a
  `206` but never read the total size). This gap is invisible in production: nginx serves the web app
  and proxies `/storage/` under one origin, so no preflight ever fires there. It bites only the DEV
  cross-origin split (web `:5173`, api `:4100`, per `CLAUDE.md`) and any future consumer that reads
  `/storage` genuinely cross-origin. R2 itself was already fine — `packages/storage`'s
  `getObjectStream`/`streamFromR2WithResume` already forwards `Range` natively and R2 honors it; this
  was purely an API-layer CORS gap, never an R2 problem, and no R2 bucket policy changed.
- **The moov/index.** Confirmed rather than assumed: `demuxIndex` already parses the sample table
  incrementally, `blob.slice(pos, end).arrayBuffer()` in `INDEX_SLICE_BYTES` (4 MB) rounds, following
  mp4box's own next-parse-position (which jumps past an unparsed `mdat` for a moov-at-end file — head
  slice + tail slice, not a full read). Because `ByteSource` is a structural drop-in for `Blob`, this
  needed no changes at all to page over Range; the `RANGE_PROBE_BYTES` support-check doubles as the
  first such round.
- **Retry and partial-response handling.** `fetchRange` retries up to 3× with backoff on a dropped or
  timed-out request (bounded at 20s/attempt) before surfacing to the caller — which already treats a
  thrown `ensure()`/`slice()` as provider failure (`<video>` fallback), so an exhausted retry degrades
  the same way a demux failure already did, not a new failure mode. A response that answers `200`
  instead of `206` mid-session (a CDN/proxy hop dropping the header after the origin advertised
  support) is handled by slicing the returned whole body in JS rather than failing a request that DID
  answer, just not the way it was asked.

**MEASUREMENT 1 — RESIDENCY.** Same instrument and rules as this entry's own phase-2a/2b ladders:
`apps/worker/tmp/debt019-residency-probe.ts`, sum of every `chrome.exe` working set, fresh browser per
rung, zero-Chrome floor enforced, build identity proven, both corpora (3s/120s, 100 files each, same
recipe) and all four rungs in one process. The `provider` variant against a REMOTE `mediaOrigin`
(cross-origin from the probe's own page — a different port, the same shape as a real remote source)
now takes the ranged path by default; no flag, no separate code path.

| N | 3s ranged | 120s ranged | ratio | 3s local (phase 2b) | 120s local (phase 2b) | local ratio |
|---|---|---|---|---|---|---|
| 1 | 119.3 | 149.1 | 1.25× | 100.8 | 102.8 | 1.02× |
| 25 | 23.3 | 31.5 | 1.35× | 14.5 | 23.9 | 1.65× |
| 50 | 18.6 | 23.8 | 1.28× | 14.0 | 19.4 | 1.39× |
| 100 | 13.4 | 30.5 | **2.28×** | 12.3 | 27.8 | **2.26×** |

(MB per source; duration varies 40× between corpora.) `copiedBytes` reads **0 at every single rung** —
the pass-through is proven engaged for every remote source, not inferred from the memory number.
Providers proven live and proven to page: 100 streaming / 0 fragmented at N=100 (both corpora), 400
`getFrame` calls, **0 nulls**, pulls at 2/35/70/98% of each clip. `chrome.exe` after run: 0.

**THE HEADLINE.** N=100 × 120s **completes**, cleanly, with zero nulls — the exact rung this entry's
own prior measurement (three reproductions) recorded as "could not complete... exhausts, falls back
to `<video>`, and times out." That ceiling is gone.

**HONEST FAILURE TO MEET DURATION-FLAT, same as the local half, and closely matching it.** The bar
this entry has always used is per-source residency flat across duration; ranged is 1.25–2.28×, not
1.0×. But look at the two ratio columns above: at every N the ranged ratio and the LOCAL ratio (this
entry's own phase-2b table) are within a few hundredths of each other, and at N=100 they are
**2.28× vs 2.26×** — indistinguishable given the ladder's own rung-to-rung noise. **This is the same
already-parked, already-unattributed ~15 MB/source residual, not a new range-paging-specific defect.**
It was never a property of the Blob; it is decode/seek state that appears under multi-point GOP-
crossing access (this entry's own phase-2b finding: "a long clip's four pulls cross GOPs and force
resets"), and that cost exists regardless of whether the encoded bytes arrived via `Blob.slice()` or
`fetch()` Range. The park below is updated to say so — the residual is now confirmed source-kind-
independent, not local-only.

`rangedBytes` plateaus at 23 MB (3s) / 922 MB (120s) from N=25 onward — the `RANGED_SOURCE_CACHE_MAX`
(12) LRU cap on tracked ranged sources, not a leak. Read this number as a BOOKKEEPING CHARGE (the
logical size of what is being served without a whole-file copy, same framing as `passthroughBytes`),
not literal resident RAM — actual transient resident bytes per source stay bounded by the same ≤24 MB
window every source kind already pays, local or remote.

**MEASUREMENT 2 — LATENCY, the risk the split was made for.** A residency ladder cannot see this.
New instrument, `apps/worker/tmp/debt019-latency-probe.ts`: one 120s/77.2 MB clip, two purpose-built
servers (Range-honoring vs Range-blind, so BOTH code paths are exercised for real — not toggled by a
debug flag the shipped code doesn't have), two CDP-emulated network profiles (fast = unthrottled
loopback; throttled = 5 Mbps down / 1 Mbps up / 120 ms RTT, a realistic weak connection), fresh browser
per case, zero-floor + build-identity preconditions as above. Cold-start = time to first frame from a
freshly created provider; seek = time to a frame at ~90% into the clip (a region nothing has fetched
yet).

| network | ranged cold | whole-file(degraded) cold | ranged seek | whole-file(degraded) seek |
|---|---|---|---|---|
| fast (LAN) | 162–171 ms | 1276–1434 ms | 75–76 ms | 44–51 ms |
| throttled (weak link) | 11.7 s | **123.1 s** | 3.5 s | 14 ms |

Reproduced twice at each network condition (both fast-arm pairs and both throttled-arm pairs agree to
within measurement noise).

**Cold start: ranged wins on BOTH networks, not just the slow one** — ~8–9× faster even over loopback
(the whole-file arm still pays a full 77 MB copy before anything can decode), ~10.5× faster under
throttle. **Seek: the real, honest trade.** Ranged pays 3.5s under throttle for a genuine new Range
fetch of the target GOP window; whole-file pays ~14ms because by the time a seek happens the ENTIRE
file is already resident. A source that gets seeked into several cold regions on a slow link pays that
3.5s more than once under ranging — priced, not hidden.

**But the whole-file baseline is not simply "slow", it is FRAGILE at exactly this size/link
combination, and that changes the trade.** A `providerKind` diagnostic (added specifically because
`streaming=0 frag=0` on the throttled whole-file run was otherwise inexplicable given `frame0=true`)
proved the 123.1s run did NOT complete via WebCodecs: `fetchSourceBlob`'s own PRE-EXISTING 120s body
timeout fired mid-transfer, the provider silently fell back to the `<video>` element, and THAT is what
finished the load. This timeout is not new and is not part of this slice's change — it is a latent
property of the code this slice replaces, and this measurement is the first to actually catch it
firing on a realistic slow-link file size. A remote source large enough and a link slow enough to
approach ~120s was already one dropped connection away from losing frame-accurate blocking-decode
semantics before this slice; range-paging doesn't just beat that path on speed, it avoids the failure
mode entirely, because no single ranged read is anywhere near large enough to approach that timeout.

**Is it worth the ceiling being gone? Yes, priced rather than assumed:** the residency ceiling this
entry is named for was product-breaking (a hard, measured limit of roughly 25–50 concurrent 2-minute
remote sources, independent of link speed), while the seek-latency cost ranging introduces is bounded,
retried, and only paid when a genuinely cold region is touched. The whole-file path being replaced was
never a clean, reliable "slow but works" baseline to begin with — under a realistic weak connection at
a realistic file size it was already failing its own budget and silently degrading to a worse decode
path. Both problems this slice fixes (the ceiling, and this latent fragility) point the same direction.

**Preconditions, reported for both instruments, not assumed:** `PIXEL_BROWSER_CHANNEL=chrome`;
zero-browser floor enforced before every rung/case (`assertZeroBrowserFloor`); build identity proven
serving this worktree (`assertServingThisWorktree`, both probes); subsystem proven live — providers
demuxed via the streaming path (never fragmented, 0 nulls across 400+ `getFrame` calls in the
residency ladder), frames pulled across the WHOLE clip (2/35/70/98%) so the chunk window actually
pages rather than sitting on its first span, and (latency probe) `providerKind` proving which decode
path actually served each case rather than inferring it from a timing number.

**VERIFICATION, as run:**
1. Six typechecks: **zero** (`shared`, `storage`, `web`, `render-templates`, `worker`, `api`). The
   product code lives in `apps/web/src/export/webcodecs-decoder.ts` (covered by `apps/web`'s
   tsconfig); the two new/changed `apps/worker/tmp/*.ts` probes are outside `apps/worker`'s
   `tsconfig.json` `include` (matches this repo's existing tmp-script convention) and were typechecked
   manually with matching compiler flags — clean but for the SAME pre-existing false positive
   `pull-bootstrap.ts` already carries (a Vite-resolved absolute-path import tsc can't statically
   resolve outside the real build).
2. `wc:gate` — **PASSED**, all scenarios (streaming/fragmented classification, frame accuracy on both
   MP4 layouts, pool admission/preemption/re-admission, reverse-shuttle bounded decode work, DEBT-013
   re-admission). This exercises export/seek/scrub CORRECTNESS through the `ByteSource` refactor —
   every scenario in `WcDecoderGatePage.tsx` uses either a raw (untracked) `blob:` URL or the
   same-origin `/__wc-fixtures/real.mp4`, both of which now route through `remoteByteSourceFor` too
   (neither is in the object-URL registry), so this is a real regression check on the refactor. Stated
   plainly: none of `wc:gate`'s scenarios are genuinely cross-origin, so it does NOT exercise the CORS
   fix — that is what the latency/residency probes' cross-port media servers cover instead.
3. `render:link-gate` and `render:compare:pixels` — **not run.** This slice touches
   `apps/web/src/export/webcodecs-decoder.ts`, `apps/api/src/app.ts`'s `/storage` CORS middleware, and
   two `apps/worker/tmp/*` test harnesses; nothing in `packages/shared/src/color/`, the transition/
   effect registries, or `render-comparison-fixture.ts`. Neither gate reads anything this slice
   changed.
4. Tree held still — `ba3472d` stayed HEAD throughout; no concurrent commits landed underneath this
   work.

**What is NOT part of this close.** The ~15 MB/source unattributed residual (now confirmed present on
both source kinds) stays PARKED on the same trigger — ADR-021 step 2's I-P6 budget, still not sized,
still not scheduled. The fragmented-MP4 fallback is unchanged and remains O(file) for both source
kinds by construction (unrelated to this slice — it never held a Blob to page in the first place). The
untouched pass-through mint sites (`useFlarexCompProxies.ts:331`, `sourceProxyStore.ts:239/266/289`,
`sourceProxyEngine.ts:737`) are unaudited, exactly as this entry already flagged.

---

**THE RESIDUAL IS ATTRIBUTED (2026-08-13). It is DECODED FRAMES, and it is not duration-scaling —
the ladder that framed it as a duration effect was measuring a property of its own access pattern.**

The trigger fired: ADR-021 step 2 is being built, so the residual was sized before its I-P6 budget was
written rather than after. Instrument: `apps/worker/tmp/debt019-attribution-probe.ts` plus
`debt019-attribution-browser.js`, running **exactly the two things this entry's own park specified** —
a per-term ablation over the real provider internals, and a heap snapshot with retainer paths. Neither
alone would have been enough, and the park was right about which error each one prevents.

**The ablation runs the REAL internals, not a replica.** `wcAblationBuild`
(`apps/web/src/export/webcodecs-decoder.ts`) builds a provider partially, stopping after one
construction stage, calling the same `sourceBlobFor` / `demuxIndex` / `createBlobChunkWindow` /
`VideoDecoder.configure` the product calls. A probe that re-implemented those stages would have been
this entry's own mistake in a new costume — measuring something adjacent to the thing it names.

**PART A — the ablation. N=100, 1280x720, working-set MB per source, two corpora differing only in
duration:**

| stage | 3s | 120s | ratio |
|---|---|---|---|
| byte source only | 2.42 | 3.14 | 1.30× |
| + sample index | 2.46 | 2.87 | 1.17× |
| + chunk window | 2.76 | 3.02 | 1.09× |
| + configured `VideoDecoder` | 2.95 | 3.60 | 1.22× |
| + **ONE** pull | **22.40** | **23.39** | **1.04×** |
| + **FOUR** pulls | **13.55** | **28.61** | **2.11×** |

Read the last two rows together, because that is where the whole answer is.

- **Everything before decode is under 1 MB/source, on both corpora.** Byte source, sample index, chunk
  window and decoder allocation together account for **0.65 MB** of the ~15 MB/source gap. The terms
  this entry is named for are, finally and quantitatively, not the problem.
- **One pull costs ~20 MB/source and the two corpora AGREE to 1.04×.** A provider that has served a
  frame holds ~20 MB regardless of whether its clip is three seconds or two minutes. **The dominant
  term is duration-INDEPENDENT**, which is precisely why four rounds of duration ladders could not
  name it: the axis they varied is not the axis it lives on.
- **The gap appears only at FOUR pulls** (2.11×, a difference of 15.06 MB/source — the residual,
  reproduced). Four pulls spread across a 120s clip cross GOPs and land the decoder mid-stream; four
  pulls across a 3s clip run past EOS, where the flush drains the output queue. So the "duration
  effect" is a **multi-point-access effect**, and duration only decides whether four pulls happen to
  straddle the end of the file.

**PART B — the heap snapshot with retainer paths. N=25, full provider.** This is the half that says
WHAT, and it starts by ruling out the place everyone looks first:

> **The JS heap is exonerated.** Total JS self size: 3s **21.0 MB**, 120s **23.3 MB** — a difference of
> **0.092 MB/source** against a working-set difference of ~15. Nothing on the JavaScript heap holds
> this. A `VideoFrame`'s pixels are renderer/GPU memory with a ~100-byte JS shell, so the byte columns
> of a heap snapshot are *structurally blind* to the term — which is why the snapshot is read for
> INSTANCE COUNTS and retainer paths, not for sizes.

| native class | 3s (count) | 120s (count) | per source 3s | per source 120s |
|---|---|---|---|---|
| `VideoFrame` | 50 | 216 | **2.00** | **8.64** |
| `EncodedVideoChunk` | 150 | 1392 | 6.00 | 55.68 |
| `VideoDecoder` | 25 | 24 | 1.00 | 0.96 |

Retainer paths, walked on the 120s snapshot (abbreviated to the load-bearing hops):

```
native:VideoFrame         Window → Array(held) → Object(provider) → closure:dispose
                                 → Context → Array → VideoFrame
native:EncodedVideoChunk  Window → Array(held) → Object(provider) → closure:dispose → Context
                                 → Object → closure:dispose → Context → Map → array → EncodedVideoChunk
```

Both terminate inside the provider's own closure, and both name a specific structure:

- the **`Array`** holding `VideoFrame`s is the decoder's decoded-output `queue` plus `current`
  (`webcodecs-decoder.ts`). **8.64 per provider is exactly its documented steady state** —
  `OUTPUT_MAX` (8) queued outputs plus the current frame. Not a leak: the designed feed window,
  correctly bounded, and simply never accounted for.
- the **`Map`** holding `EncodedVideoChunk`s is `createBlobChunkWindow`'s `loaded`
  (`webcodecs-decoder.ts:758`). 55.68 chunks/source sits inside `WINDOW_MAX_SAMPLES` (96) — again
  bounded as designed, and again unaccounted.

**Pricing the two named holders against the 15.06 MB/source gap:**

| holder | Δ instances/src | unit | Δ MB/src |
|---|---|---|---|
| `VideoFrame` (`queue` + `current`) | +6.64 | 1.38 MB (1280×720 NV12) | **≈ 9.2** |
| `EncodedVideoChunk` (`loaded` window) | +49.68 | 21.3 KB (76.8 MB / 3600 samples) | ≈ 1.1 |
| **named total** | | | **≈ 10.3 of 15.06** |

**The remaining ~4.8 MB/source is stated as unnamed rather than attributed by subtraction**, because
that is the error this entry made twice. What can be said about it positively: it is not on the JS
heap (part B), it is not any pre-decode term (part A ≤ 0.65 MB), and `native:blink::DecoderTemplate
<blink::VideoDecoder>` appears in the graph carrying no size — i.e. it is decoder-internal memory
(reorder buffer, GPU-side frame backing) with no JS object to count. It is a floor the browser charges
per decode session, not a defect with a fix.

**CONSEQUENCE FOR THE I-P6 BUDGET — the reason this park existed.** The budget must be charged per
provider on **frame GEOMETRY**, not on clip duration and not on file size:

> `providerBytes = fixed(≈3 MB) + PINNED_FRAMES(16) × width × height × 1.5`

16 rather than the snapshot's 8.64 is deliberate and is documented at the constant
(`apps/web/src/playback/flarex-source-providers.ts`): the instance count and the working set disagree
by ~40% because of memory with no JS object, and a budget built on the count would over-admit by that
much. The charge follows the working set, which is the thing that actually kills the tab.

**Status change: this entry's remaining open item is now SIZED, and the park is LIFTED.** What it was
blocking has been delivered — ADR-021 step 2 can and does state its budget in bytes with a measured
per-provider charge. What remains genuinely open here is smaller and different from what the header
said: the ~4.8 MB/source browser-internal decode floor, which is not actionable, and the untouched
pass-through mint sites, which are.

**Instrument notes, both of which cost a run and would cost the next investigator one too:**
- **A working-set sample must be taken after a forced GC.** The first ablation came back
  NON-MONOTONIC (`ab-bytes` 448 MB > `ab-index` 267 MB at N=100), which is impossible for cumulative
  retention: the sample was dominated by uncollected transients. `HeapProfiler.collectGarbage` twice,
  then a 3s settle, before reading. Without it the stage costs measure GC timing.
- **A stage that stops early can retain something no real provider holds.** The `bytes` stage read
  207 MB of post-GC JS heap at N=100 on the 3s corpus — exactly 100 × 1.9 MB of
  `probeAndBuildRangedSource`'s primed 206 body, which is released by `demuxIndex`'s first slice and
  therefore never held in production. The stage now consumes the prime the way the next stage would.
  Both readings looked like findings and neither was.

---

### DEBT-020 — CLASS: a time-varying parameter that is not a number is invisible to the content hash

- Status: **open** — registered as a CLASS with two instances, one of which was latent for six weeks
- Registered: 2026-08-11 (second instance found by the slice-2 cache enumeration; the enumeration was
  only being run at all because slice 1 had found the first one a day earlier)
- Reason: ADR-009 R1 says a keyframed parameter contributes its **evaluated value at t**, never its
  keyframe track. `computeFlarexContentHashes`'s `resolveParam`
  (`packages/shared/src/flarex/content-hash.ts`) implements that rule with a single type test:

  ```ts
  if (typeof raw !== "number") return raw;   // ← everything else hashes as its literal
  return evaluateFlarexNodeParam({ ... });
  ```

  The test is correct for what it was written against — at the time, every driver *was* numeric, and
  the animation evaluator only handles numbers. But Flarex's own convention (stated in `FlarexNode`:
  *"Flat scalars; complex payloads are JSON.stringify'd strings"*) means a parameter whose value IS a
  track arrives as a **string**. It has no numeric form to resolve, so it falls through and hashes as
  a constant. The node's content hash is then **identical at every frame while its output moves.**
- Invariant affected: none named. ADR-009's rule is not violated in letter — the hash still "resolves
  drivers to values" for every driver the resolver recognises. The defect is in what it does not
  recognise, which is why no invariant check fires.
- Owner: unassigned
- Expiry condition: see below — a `kernel:conform` assertion. **Not** vigilance.
- Detection: **a node definition whose params include a non-numeric value that varies with time, and
  whose `trackParams` does not list it.** A reviewer notices it in `node-defs.ts`, at the moment a
  `z.string()` param is added: ask *"does this string change what the node outputs from one frame to
  the next?"* If yes and it is not in `trackParams`, this defect just shipped. It will not be noticed
  anywhere downstream, because every consumer of the hash is a cache, and a cache serving a stale
  value looks exactly like a cache working.

**Instance 1 — `shapeKeyframes` (slice 1, fixed in `0a3b220`).** Animatable mask outlines. The
keyframe track is a JSON string, so an animating `polygonMask`/`bezierMask` hashed identically at
every time. Found by the enumeration the slice was required to do, *before* the feature shipped —
i.e. it never reached a user. Fixed by introducing `FlarexNodeDefinition.trackParams` (a def-declared
list of params that carry tracks) and folding a time term into the digest when one is non-empty, with
`FLAREX_CONTENT_HASH_CONTRACT_VERSION` bumped 1 → 2.

**Instance 2 — `trackingPathData` (slice 2, fixed in this commit). Latent since 2026-07-28.** The
Tracker node embeds its whole track as JSON in node params — deliberately, so it reaches the manifest
and both renderers (see the node's own comment). Same shape, same result: a Tracker's hash was
constant at every frame while its transform swept across the frame. This one **shipped and sat there
for six weeks**, through the slice that introduced it and every slice after, and would have gone on
sitting there: the only reason it was found is that slice 2 was required to repeat slice 1's
enumeration, and `trackingPathData` is the same kind of input.

**Where it shows, and why nothing caught it.** Every consumer is a cache:

| Consumer | Consequence of a frozen hash |
|---|---|
| Node-thumbnail cache (`flarex-node-thumbnails.ts`) | keys `(ContractVersion, contentHash)` with **no time axis at all**, so a tracked/animated node's thumbnail freezes on its first rendered frame — the user-visible symptom, and a cosmetic-looking one that nobody would file as a cache bug |
| Materialization / content-addressed nest cache (`compile-flarex.ts` → `scene-compositor.ts`) | a sealed group can be served from a nest rendered at a different frame's geometry — a stale *picture*, not a stale thumbnail |
| `render:compare:pixels` | **cannot see any of it.** The gate renders one still per fixture and diffs two renderers; both consume the same shared hash and would agree on the same stale value. See DEBT-017 — this class is a concrete instance of that one's blind spot. |

**Two instances in two consecutive slices is the signal.** Both were found by hand, by an enumeration
that happened to be mandated. Neither was found by a test, a gate, or a type. The base rate matters
more than either bug: the resolver's `typeof raw !== "number"` is a **silent, permissive default** —
add a JSON param and you get wrong behaviour with no diagnostic — and every new node type is another
draw from that distribution. `filter.effectParams`, `colorCurves.curves`, and the `wheels`/`secondary`
payloads sketched in `plans/flarex-node-expansion` are all non-numeric params today; they are safe
only because they are *currently* static, which is a property of today's features, not of the code.

**Expiry condition — invert the default, in `kernel:conform`.** The only version of this that survives
the next contributor is a structural assertion, because the failure is silent and the correct
declaration is invisible when omitted:

> For every node definition, every param whose Zod type is not a number must appear in **either**
> `trackParams` **or** a new explicit `timeInvariantParams` list. A param in neither fails the
> conformance run with the node type and param name.

That inverts the default from *silently wrong* to *must declare*. It is checkable statically — it
reads `node-defs.ts` only, needs no render and no browser — and it is node-blind in ADR-010's sense
(it reads declarations uniformly, learns nothing about node types).

**Viability: yes, and it is small.** Roughly half a day. The mechanical part is one pass over
`flarexNodeDefs` unwrapping each param's Zod type (`z.string`/`z.enum`/`z.boolean` vs `z.number`),
plus the `timeInvariantParams` field on `FlarexNodeDefinition`, plus one assertion in the existing
conformance harness. The real cost is the one-time backfill: ~39 node types must each have their
non-numeric params classified, and that classification is a judgement call per param — which is
precisely the judgement that is currently being made implicitly, by omission, and getting it wrong
twice. Two caveats a builder should know going in: `z.enum` is non-numeric but essentially always
time-invariant (a blend mode does not animate), so the backfill will be mostly `timeInvariantParams`
and the assertion earns its keep on the handful of JSON-payload params; and the check cannot catch a
param that is *declared* time-invariant and later *becomes* time-varying, so the declaration should
sit adjacent to the param in `node-defs.ts` where the person changing it will see it.

**This class does not retire when its instances are fixed.** Both known instances are fixed. The
class stays open until the conformance assertion exists, for the reason the register exists: the
mechanism that produced two bugs in two slices is still in place and still silent.

---

## Retired

- **DEBT-001** — retired 2026-08-05 in place above. The I-27 host-clip substitution for `pending` is
  structurally impossible since `366860c` and is pinned by enforced invariant I-34. Its original expiry
  condition was unsatisfiable (it watched the `no-loader` path, which is correct behaviour); see
  DEBT-008 for the harness tidy-up that remains.
- **DEBT-004** — retired 2026-08-05 in place above, on measurement: `shared-expensive-6x8` shows
  `179h/1m promo=1`, i.e. ONE miss across 12 frames rather than one per frame, so the evaluation record
  survives between frames. The other scenarios are inert by threshold design and cannot answer it.
- **DEBT-008** — retired 2026-08-05 in place above. Two mis-named conformance assertions corrected
  (one promoted `pending`→`enforced`, one renamed), and I-27 gained the behavioural guard it was
  missing — verified non-vacuous by breaking the runtime and watching it fail.
- **DEBT-006** — retired 2026-08-03 in place above; the S6.3 commit (`b5452cd`) has landed. The
  threshold stays at 2 on a replaced justification: it now backstops DEBT-007's context-blind `fanout`.
- **DEBT-016** — retired 2026-08-09 in place above, same commit as its fix. `FlarexSourceDrawCache`'s
  hit path now rebinds the transform, not just the media handle; falsified before/after with
  `flarex-source-draw-cache-transform.test.ts`.
- **DEBT-018** — retired 2026-08-12 in place above, on evidence the entry already held: its own
  2026-08-09 update closed A3 by injection and the Status/Expiry lines were never updated to match.
  Nothing was re-measured to retire it. Its A1 remains the only end-to-end proof in this programme that
  `wcReacquireEpoch` re-acquires and succeeds in the product, which is why DEBT-013 cites it.
- **DEBT-014** — retired 2026-08-12 in place above, on NON-REPRODUCTION rather than a fix. The
  discriminating reading was taken on a fresh two-consumer fixture with all three blockers addressed
  (`tmp/debt014-host-routing-probe.ts`): host `wc-hw` in 3/3 arms, `capMisses 0`, no denial anywhere,
  both consumers holding hardware simultaneously. Not an instance of DEBT-013 — there is no refusal for
  it to be an instance of. Scope is stated in the entry: a reconstruction, not Host C's project, whose
  artifacts are gone.
- **DEBT-010** — retired 2026-08-09 in place above, same commit as its fix. Sidestepped ContextVersion
  entirely: readiness is now a fourth not-ready EVENT at the capture boundary
  (`ScenePreviewCanvas.tsx`'s `renderIsolated`), not a cache-key axis. All three acceptance links
  (repro / falsifier / spin-guard) measured on a real running editor via Playwright.

---

### DEBT-021 — the un-retimed pending soft-degrade regressed, and its guard is a known-flaky fixture's only backstop

- Status: **RESOLVED 2026-08-16 — there was no regression.** The behaviour was DELETED ON PURPOSE by
  `366860c` (S7.2 5/n) under I-27, and the assertion outlived it. Bisected; see the closing update at
  the end of this entry, which also falsifies the `flarex-generators` inheritance below.
- **Header updated 2026-08-16:** Status was "open, unowned, and NOT attributable to the text
  programme". (`README.md`, "State fields vs. history.")
- Registered: 2026-08-14, by the auditor, on a report from the ADR-023 S4b session
- Symptom: `pnpm --filter @orreris/shared flarex:test` fails one assertion at HEAD —

  ```
  FAIL  an UN-retimed unready loader still soft-degrades to the host (renderer parity)
  ```

  The other twenty checks in that block pass, including the three neighbouring degrade cases
  (`null` still degrades, an un-retimed MediaIn still degrades, a RETIMED unready loader correctly
  yields nothing). Only the `resolveSourceDraw: () => "pending"` arm on an **un-retimed** node has
  stopped returning `debugLayerId === "host"`.
- Provenance: the assertion dates to `6974a06` (2026-07-29, "a retimed MediaIn must never fall back
  to the playhead frame"), which is three weeks before the text programme began. The S4b session
  reported it failing identically with its own changes stashed, and the auditor reproduced it at
  HEAD. **Nothing in S0–S4b touches `compile-flarex`'s mediaIn path.** Recorded explicitly because a
  failing test discovered during a programme tends to get attributed to it.
- Why this is worth an entry rather than a bug note: the assertion is not incidental. Its own
  comment (`flarex.test.ts:2368-2371`) records what it is defending —

  > the two renderers do not become ready on the same frame, so dropping it turns a readiness race
  > into a parity failure (`flarex-generators` went 0.000% → 86.895% when this was unscoped)

  So this guard is the backstop for the `flarex-generators` flakiness already on record in
  `pixel-gate-open-items` (86.895% then 0.000% across runs — flaky, not loose). **A broken guard here
  predicts intermittent pixel-gate failures on that fixture**, which is the most expensive kind of
  failure this repo has: a full sweep that fails for a reason unrelated to the commit under test.
- What has NOT been established, and should not be assumed:
  - **when** it regressed. No bisect was run. "Pre-existing on this branch" is the whole claim.
  - whether `flarex-generators` is currently flaky in practice. The recent full sweeps have passed;
    that is consistent with the guard mattering only on a readiness race that did not happen to
    occur, and it is equally consistent with the guard being redundant now. Do not read the passing
    sweeps as evidence either way.
- Next step when someone picks this up: bisect the assertion, not the fixture. It is a pure-function
  test that runs in seconds, so the bisect is cheap — which is the opposite of the usual situation
  here and is the reason to do it before the next full sweep rather than after a flaky failure sends
  someone hunting.

**CLOSED 2026-08-16 — bisected. The guard did not break; the BEHAVIOUR was deleted, on purpose, and
the assertion was left behind.**

The instruction above was followed exactly and it was the right instruction: 8 arms, seconds each,
grepping for the assertion by NAME rather than trusting the suite's exit code — necessary, because
other assertions in the range fail for unrelated reasons and older commits predate this one, so an
exit code would have mixed three different answers together.

```
first bad commit  366860c  refactor(kernel): S7.2 (5/n) — one coherence mechanism, and the
                           fallback that hid the race is gone
```

That commit's own message says what it did: *"The host-clip substitution for `pending`. I-27 forbids
resolving scarcity by showing ANOTHER source's content, and only `pending` does that. Now refused
unconditionally; `allowHostSubstitution` is gone from the compiler's surface and from
`build-scene-draws`, so no caller can ask for the old behaviour."* The neighbouring cases still pass
because they were never in scope — `null` means "no loader owns this node", a different answer that
correctly keeps the Phase-1 degrade.

So the assertion had been asserting the exact thing an accepted invariant forbids, for twelve days,
and reading as a regression the whole time. **Repaired by INVERTING it to S7.2's own claim** ("an
UN-retimed unready loader is refused too — nobody can opt out of I-27"), which is what conformance
note I-34 in that commit already says in prose. `flarex:test` is now green in full.

**THE `flarex-generators` INHERITANCE IS FALSIFIED, and that half mattered more than the assertion.**
This entry argued, from `flarex.test.ts`'s own comment, that the guard was that fixture's parity
backstop and that its breakage PREDICTED pixel failures there. The prediction appeared to land — the
fixture began failing reproducibly at 0.691%. It was tested rather than believed:

| arm | `flarex-generators` |
| --- | --- |
| `15d615b`, parent of the deletion | 0.000% |
| `366860c`, the deletion itself | 0.000% |

The deletion moves that fixture by nothing. A separate 9-arm bisect puts the pixel failure at
`fe4f77c` (2026-08-15, the pinned-font await), three weeks later and in a different programme —
`project-tracker/infrastructure.md` v8. **Two symptoms, two causes, and the plausible story joining
them was wrong.** Worth keeping as a pattern: a comment recording *why* an assertion was added is
evidence about the past, not a live causal claim, and this one had already been made obsolete by a
commit nobody connected to it.

### DEBT-022 — a weaker cache key sits ABOVE the correct one and short-circuits it, so a keyframe edit does not invalidate

- Status: **RETIRED 2026-08-16** — fixed the same day it was registered, by founder decision to repair
  it before building 3b. See the closing update at the end of this entry.
- Registered: 2026-08-16
- **Header updated 2026-08-16:** Status was "open — USER-VISIBLE DEFECT, found 2026-08-16 closing out
  ADR-021 step 3a" — see the closing update below. (`README.md`, "State fields vs. history.")
- Reason: `incremental-evaluation.ts` decides node reuse from a hand-rolled per-node signature,
  `signatureOf` = `type | enabled | RAW params` (`:116`). A Flarex node's keyframes do **not** live in
  `node.params` — they live in `comp.animations` — and nothing else marks the node. With the playhead
  stationary the node is clean on content, context, time and source, so `reuseValue` returns the
  previous value and `compile-flarex.ts:1394` skips the node's **entire upstream subtree** (that call is
  "placed BEFORE lowering", deliberately, which is what makes the skip worth having and also what makes
  this defect total rather than partial). The viewer keeps the previous picture.
- **The correct key already exists one layer down and is never consulted.** ADR-009's
  `NodeContentHash` resolves every param to its value at `t` (R1) — so it *does* see a keyframe edit —
  and `SceneCompositor.contentCacheKey` keys the content-addressed cache on exactly
  `(ContractVersion, ContextVersion, NodeContentHash, dependencyVersions)`. That is I-P7's key, correct
  and shipped. It cannot help here because the weaker check runs first and returns before reaching it.
  **This is the defect's shape and the reason it is registered as a class, not a typo: a cache whose key
  is right can be defeated by a cheaper guard placed in front of it.**
- Invariant affected: ADR-021 **I-P7** in substance (the node-output cache's identity), and the same
  class as retired **DEBT-016** — "a cache key omitted an input the cached value depended on". DEBT-016
  was one cache keyed on `(layerId, comp.version, renderScale)`; this one omits `comp.animations`.
- Owner: unassigned
- Expiry condition: an edit that changes what a param RESOLVES TO at the current time invalidates the
  node, for every route the editor can write one — asserted by `flarex:incremental-gate`, which must be
  green in both directions (the unchanged-comp counterweight must keep REUSING)
- Planned slice: none accepted. The obvious repair is to make the signature fold what
  `NodeContentHash` folds — params resolved at `t` — and `compile-flarex.ts:570` already computes
  `computeFlarexContentHashes(comp, ctx.timeSeconds)` on every compile, so the value exists; the cost
  question is that `beginIncrementalFrame` runs BEFORE the compile and would either recompute the
  hashes or need them threaded to it. A cheaper stopgap is to fold `comp.version` (documented as "THE
  dirty/invalidation key") into the signature, at the price of invalidating every node in a comp on
  any edit — which would drop the param-drag reuse measured below to 0%. **Neither is chosen here.**
- Tracking issue: —
- Detection: any reuse/skip guard whose key is assembled by hand rather than taken from
  `computeFlarexContentHashes`. Concretely: a `signatureOf`-style string built from `node.params` while
  the value being cached depends on `comp.animations`.

**Reproduced through the PRODUCT'S OWN WRITE PATH, not a simulation of it.**
`applyNodeParamValueAtTime`'s documented four-way rule says that for an ALREADY ANIMATED param it
updates or inserts a keyframe and "never touch[es] the base". `flarex:incremental-gate` asserts exactly
that and then asks the mechanism:

```
PASS  BASELINE: an unchanged comp at an unchanged time REUSES     <- the counterweight
PASS  param drag invalidates
PASS  rewire invalidates
PASS  source change invalidates a downstream node
FAIL  KEYFRAME VALUE edit invalidates
FAIL  KEYFRAME MOVE invalidates
FAIL  KEYFRAME DELETE invalidates
PASS  editor's write path leaves node.params untouched for an animated param   -- 0 -> 0
FAIL  SLIDER DRAG on an ANIMATED param invalidates
```

The baseline check is load-bearing: without it a mechanism that reported "dirty" unconditionally would
pass every other line and prove nothing.

**User-visible statement of it:** *with the playhead parked, drag a slider on a Flarex node param that
already has keyframes — the value is written, and the viewer does not change.* It recovers as soon as
anything else invalidates (move the playhead, touch a non-animated param, a source decodes a frame),
which is why it would read as flakiness rather than as a stuck cache.

**Why it was not found earlier, recorded so the next audit starts from the right place.** Every gate
that covers this area covers a *different* cache. `flarex:cache-gate` asserts warm-vs-cold parity for
the content-addressed materialization cache — the one whose key is correct — and it is a SEQUENCE gate
over frames at MOVING time, where the time axis dirties everything anyway and this defect cannot
reproduce. The stationary playhead is the only regime it appears in, and no gate held it still.


**FIXED AND ACCEPTED 2026-08-16 — the hash is THREADED, not recomputed, and the decision is a
correctness one that a cost measurement could not have made.**

The repair: `compileFlarexComp` already computes every node's `NodeContentHash` on every compile
(`compile-flarex.ts:570`, `computeFlarexContentHashes(comp, ctx.timeSeconds, …)`), and now hands it to
the host alongside the question — `reuseValue(nodeId, contextKey, contentHash)` and
`onEvaluated(nodeId, contextKey, value, contentHash)`. `incremental-evaluation.ts` stores the hash a
value was produced under and refuses reuse when it moves, **ahead of** the axis machinery. Mismatch OR
absent-on-either-side ⇒ evaluate, which is the compiler's own stated asymmetry for this channel ("the
failure mode of a wrong `null` is wasted work and the failure mode of a wrong value is a stale pixel").

**Why THREAD rather than RECOMPUTE, and it is not the cost.** `build-scene-draws.ts` calls the compiler
with `timeSeconds: Math.max(0, t - layer.startSeconds)` — comp-local time, **different per referencing
layer** — while `beginIncrementalFrame` knows only the timeline `t`. A host-side recompute would sample
the animation curve at the WRONG time for any Flarex clip that does not start at 0, and would therefore
miss exactly the keyframe edits this entry is about. It would also be a second full hash pass on top of
the one the compile already runs; priced on the real captured graph for the record:

| nodes | one hash pass | share of a 33.3 ms frame |
|---|---|---|
| 61 | 0.999 ms | 3.0% |
| 122 | 1.595 ms | 4.8% |
| 244 | 3.159 ms | 9.5% |

Threading adds no hashing at all — one `Map.get` per node per compile — and `f?.(args)` short-circuits,
so a caller that supplies no channels (export, worker, fixtures) does not even evaluate the lookup.
**Export output is byte-identical by construction**, which is why no pixel gate was run for it.

**Acceptance: `flarex:incremental-gate` is GREEN, 9/9**, including the counterweight (an unchanged comp
at an unchanged time still REUSES) — without which a repair that simply always invalidated would pass
every other line. The three keyframe classes and the slider-drag-on-an-animated-param case all now
invalidate.

**The cost of the repair, stated as a number rather than a hope.** Re-running `flarex:reuse-measure`
over the same captured 61-node graph, before → after:

| edit | before | after |
|---|---|---|
| none (counterweight) | 100.0% | **100.0%** |
| param drag @ HEAD source | 75.4% | **75.4%** |
| param drag @ TAIL source | 91.8% | **91.8%** |
| rewire one edge | 78.7% | **78.7%** |
| source change | 0.0% | **0.0%** |
| slider drag on an ANIMATED param | 100.0% *(stale)* | **75.4%** |

**No edit class lost reuse.** The only row that moved is the one that was wrong, and it moved to
exactly the figure its non-animated twin already had — the same node, the same closure — which is the
result that says the fix is precise rather than merely conservative. This is the outcome the rejected
stopgap could not have produced: folding `comp.version` would have taken every row to 0%.

Regression surface checked: `kernel:conform` green (including **I-15**, "the lowering layer owns no
clock, no kernel dependency and no module state" — the invariant a new compiler out-channel parameter
could plausibly have broken), and `flarex:test` fails exactly one assertion, the pre-existing
**DEBT-021** one, verified by stashing this change and re-running at the merge base to get the
identical single failure.


---

### DEBT-023 — `mediaEpoch` is a global SUM, so ANY decode dirties EVERY MediaIn

**Registered 2026-08-16, deliberately NOT built** (founder instruction, during ADR-021 3b).

**Status:** open. **Expiry:** when the ADR-021 seam gives each source its own identity, or sooner if a
live reuse rate above zero becomes load-bearing for a performance claim.

The incremental evaluator's `source` axis is driven by `mediaEpoch`, a single number summed over every
media-pool content version. One frame arriving on one source moves the sum, which marks the axis
dirty, which dirties every `mediaIn`, which propagates through the merge chain to the whole graph.

**What it costs, measured** (`flarex:reuse-measure`, 61-node/12-source comp on real footage): live
steady-state reuse is **0** — not because the mechanism fails, but because on a video comp the only
thing that WAKES the compositor is a decode, and a decode invalidates globally. Every non-zero figure
in that harness's table is an EDIT-triggered recomposite. So the node-output cache's real-world value
today is confined to editing, exactly as ADR-021 §3.2(c) says, and this is the reason.

**The fix is per-source epochs** — a decode on source A dirties the `mediaIn` nodes bound to A and
nothing else. It is the only change that would make the live reuse rate non-zero.

**Why it is registered rather than done.** It is a behaviour change to shipped ADR-012 code with its
own risk, and it is not on the critical path of anything currently claimed: ADR-021 3b's win is
scrub-back and loop, which is a FRAME cache and independent of this axis. Doing it opportunistically
inside a cache commit would also make any resulting stale-picture report ambiguous between two layers
— the precise mistake DEBT-022 was fixed ahead of 3b to avoid.

**Do not fix this by exempting `mediaIn` from the source axis.** That is the DEBT-009 shape (proving
liveness by a signal the consumer never emits) wearing the opposite sign, and it would trade a
conservative invalidation for a stale one.

---

### DEBT-024 — ADR-021 3b's host wiring is UNVERIFIED, and every field reading taken so far is VOID

**RESOLVED 2026-08-16** — the wiring is verified and the default is **ON**; see the closing update at
the end of this entry. The reasoning trail below is kept in full, because two of its three "findings"
were instrument error and the sequence of how that was established is the useful part.

~~**Open 2026-08-16.** The 3b host wiring ships **DEFAULT OFF** (`getFrameCacheEnabled()` returns false;
`?frameCache=1` opts in). **Expiry:** when `flarex:frame-cache-field` returns a non-VOID verdict on a
machine with free disk.~~

**Not in doubt: the MECHANISM.** `flarex:frame-cache-gate` is green on every arm and provably
falsifiable — `FRAME_CACHE_SABOTAGE=drop-t` gives 16 failures, `drop-graph` 2. That gate hosts its own
experiment, has no load-to-load axis, and writes nothing large. Nothing below touches it.

**VOID, AND NOT TO BE CITED AS FACTS ABOUT THE RENDERER.** Every `flarex:frame-cache-field` reading
was taken while C: ran down to **zero bytes free** (DEBT-025: 195.8 GB of leaked browser profiles).
Specifically void, and *not* to be repeated as findings:
- run 1's apparent **stale serve**;
- the cross-load noise floor of **0-to-6-of-6**;
- the same-load **2-of-6** bypass disagreement;
- and the conclusion drawn from it, that **I-P8 does not hold in the live editor**.

**Why these are facts about a machine, not a renderer.** A full disk does not announce itself. Chrome
cannot write its cache, a screenshot returns partial or fails, a decoder fails — and what the harness
observes is *the picture at a fixed `t` did not reproduce*. That is indistinguishable by inspection
from genuine renderer nondeterminism, which is exactly the conclusion that was nearly recorded here as
established. The moment the condition became visible (a heredoc failing with "No space left on
device") was **not** when it began; it had been corrupting runs silently for an unknown stretch before
that, so no reading in the window can be rescued by arguing it "looked fine".

**What survives, and it is not a measurement.** The instrument REDESIGN stands on its own merits and
is not in question: runtime bypass via `__rfFrameCacheBypass`, five sweeps inside a single load over
warmed decoders, and a noise floor treated as a **precondition that VOIDs the run** rather than a
quantity to subtract. Re-run that instrument; do not rebuild it.

**RE-RUN ON A CLEAN MACHINE, 2026-08-16 (238 GB free). The disk was necessary but not sufficient:
the probe had TWO defects of its own hiding underneath it, and both are now fixed.**

1. **The stops sampled past the end of the composition.** Fixed fractions `[0.12 … 0.42]` assumed the
   ruler's span matched the comp's; the ruler ran ~70s wide over a ~22s comp. A click past the end is
   **ignored, not clamped** (measured: `t(0.92)` read back 0, the initial value), so the playhead simply
   stayed where the previous stop left it and four of six stops re-measured ONE frame. **That single
   defect produced both earlier "findings"** — the 4-position stale serve and the 3-position unstable
   oracle were each confined entirely to the dead stops, while the two in-range stops agreed perfectly
   across every sweep of both runs. The probe now binary-searches for the real end and **VOIDs unless
   the stops land on distinct playhead times**.
2. **The seed clip was selected to be static.** `defaultClipPath` takes the *smallest* mp4 ≥20s — the
   lowest-bitrate, least-moving file present. The first clean run VOIDed on the probe's own
   one-distinct-picture guard. Use `PROBE_CLIP` with real motion.

**What the fixed instrument says.** With both corrected, the good runs are unambiguous: **6 distinct
pictures at 6 distinct times, `attributable = 0`, 16/17 of 17 frames served from cache and every one
pixel-identical to a fresh render.** That is the first real evidence the shipped host's key is
COMPLETE.

**But the oracle still does not reproduce reliably, and a longer settle no longer buys anything:**

| `FIELD_SETTLE_MS` | noise floor per run (of 6) |
| --- | --- |
| 900 | 2, 3 |
| 2500 | 1, 1, 2 |
| 6000 | 2, 1 (a third run died at browser launch) |

900 → 2500 helps; **2500 → 6000 does not.** It plateaus at 1–2 of 6 unstable positions, which is the
**NONDETERMINISTIC** branch of the fork, not the converging one. The settle predicate being too eager
is real and worth fixing, but it is not the whole story: a residual irreproducibility survives any
wait tested.

**So I-P8 is now a genuine open question about the media path** — properly isolated at last from the
disk (fixed) and from instrument error (two defects found and fixed). It is not established as a
renderer defect; it is established that a re-render oracle cannot currently certify this path to 3/3.

**KEEP THE DEFAULT OFF.** Two of three clean runs passing is not the bar for flipping a default that
decides whether the editor shows a stale frame. The remaining work is to make the oracle deterministic
— or to find an oracle that does not depend on re-rendering — not to re-run this one hoping for three.

**CLOSED 2026-08-16 — DEFAULT ON, by SPLITTING the question rather than by re-running the same one.**

The paragraph above asked for a deterministic oracle and then looked for it in the wrong place: in a
longer settle over live footage. The two questions tangled together here are not one question.

- **Is the host's KEY complete?** That is the cache's question and the only one that can decide the
  default.
- **Does the picture at a fixed `t` reproduce over the LIVE MEDIA PATH?** That is a property of decode
  and settle, it is real, and it is **not** a frame-cache defect. Registered as **DEBT-027**.

A Flarex comp is eligible because the **compiler** stamps a content token — it does not need a MediaIn
to be eligible. So the first question can be asked on content that has no decode in it at all. New
fixture (`FIELD_FIXTURE=deterministic`, `buildDeterministicFlarexFixture`): the seeded video clip is
**deleted**, six SHAPE clips are tiled 3s apart along the timeline, each wrapped in its own Flarex comp,
and each stop is a different shape. No decode anywhere in the frame, so `storable`
(`staleIds`/`notReadyIds` both empty) is trivially true and the oracle is sound.

**Result, 4 runs (3 + 1 confirming), every one green and every hash identical across runs AND across
page loads:**

```
eligible=true · A-FILL hits=1 · A-SERVE hits=6 misses=0 · stores=8 declined=0 entries=8 · 63.3MB
attributable 0 [] · noise floor 0 []      (budget 0 — see below)
6 distinct pictures at 6 exact times: 1.0s 4.0s 7.0s 10.0s 13.0s 16.0s
```

**The noise budget in this arm is ZERO, not 1.** Nothing decodes, so there is no mechanism by which a
bypassed re-render could differ from the previous one; a single unstable position would be an
unexplained result, not tolerable noise. The media arm keeps a budget of 1 because its instability is
the question it is asking.

**And the probe was made to prove it could FAIL, from the run's own data.** "A equals B at every
position" is also what an instrument that cannot tell frames apart reports. So the comparison is
re-run SHIFTED — `A-SERVE[i]` against `B[i+1]`, the frame a key that lost `t` would have collided
with — and every position must disagree. All 5 comparisons disagree. A wrong-`t` serve would be seen.

**Two defects the fixture found on its way in, both worth the entry on their own.**

1. **The shape dropdown's `onChange` ADDS the layer** (`TimelineStrip.tsx:3176`); it does not merely
   arm the button beside it. Clicking both put a second, un-comped clip at every start time, and a
   frame is cacheable only if EVERY draw carries a token — so the twin made every frame **ineligible**
   and the first run reported "the 3b wiring is inert in the product". A true statement about a
   fixture with a stowaway in it. The guard was `after > before`; it is now `after === before + 1`.
2. **`eligible: false` was unactionable observability.** It is true of every uncacheable frame there
   is and cannot tell a plain clip (expected — step 4's job) from a Flarex comp that silently lowered
   to nothing (a defect). `__rfFrameCache` now also reports `draws` and `blockedBy` (the first
   token-less draw's `debugLayerId`), which is what turned the run above from a dead end into a
   one-line diagnosis.

**What the default is claimed for, narrowly: scrub-back and loop over ground already rendered.** Not
playback — ADR-021 §7 has not moved, and a first pass over new ground is all misses. And only where
every draw carries a content token, which today means a Flarex comp; step 4 is where the timeline
earns the same identity. Escape hatch `?frameCache=0`.

Green at the flip: `flarex:frame-cache-gate` all arms, `flarex:frame-cache-field` 4/4, web + worker
typecheck, `render:compare:pixels`.

---

### DEBT-027 — the picture at a fixed `t` does not reproduce over the live media path

**Open 2026-08-16.** **Status:** **CAUSE NAMED the same day — it is DECODER SUPPLY, not renderer
nondeterminism.** See the update at the end of this entry. Still not being chased from here.
**Expiry:** when a `FIELD_FIXTURE=media` run reaches a zero noise floor three times running.
**Header updated 2026-08-16:** Status was "registered, deliberately NOT being chased", and the Expiry
clause "or when the cause is named" is now discharged. (`README.md`, "State fields vs. history.")

**The finding.** `flarex:frame-cache-field` renders the same six playhead positions twice in one page
load, with the frame cache bypassed on both sweeps, over a Flarex comp on real footage. Two such
sweeps should be identical. They are not: **1–2 of 6 positions differ**, and a longer settle does not
converge:

| `FIELD_SETTLE_MS` | unstable positions per run (of 6) |
| --- | --- |
| 900 | 2, 3 |
| 2500 | 1, 1, 2 |
| 6000 | 2, 1 (a third run died at browser launch) |

900 → 2500 helps. **2500 → 6000 does not.** That is the *nondeterministic* branch, not the
*converging* one: the settle predicate being too eager is real, but a residual survives every wait
tested.

**These numbers are trustworthy in a way the earlier ones were not**, and that is why this is a
finding rather than another void. Taken with 238 GB free (DEBT-025 fixed), after the probe's two own
defects were found and fixed (stops past the end of the comp; a seed clip selected for being static),
and with the ruler calibrated at runtime plus a hard VOID unless the stops land on distinct times.

**Why it is NOT a frame-cache defect, and must not gate one.** The same host, the same key and the
same compositor are exercised by `FIELD_FIXTURE=deterministic` — six shape clips, no decode — and
there the identical instrument returns a **zero** noise floor, four runs running, with hashes stable
across page loads. The variable that moves is the media path, not the cache. What this costs is an
ORACLE: over live footage a re-render cannot certify a frame, so questions of this shape have to be
asked on deterministic content until it is fixed.

**Where to start when it is picked up.** `settledRef` (`ScenePreviewCanvas.tsx`) is
`staleIds.length === 0 && notReadyIds.length === 0` — the settle predicate the 900 → 2500 improvement
implicates. That it improves but does not converge says there are (at least) two terms: one the
predicate can see and one it cannot. The obvious suspect for the second is a decode whose output
differs between two seeks to the same `t` (GOP position, reset timing — the ~34 ms reset cost of
ADR-021 §3.3 and OQ1 is the same subsystem). **Do not chase it from the frame-cache side.**

**UPDATE 2026-08-16 — the cause is named, and it took a fact rather than a longer wait.**

The suspicion above was right about the subsystem and wrong about the shape. It is not "a decode whose
output differs between two seeks to the same `t`". **It is a decoder that stops supplying altogether
partway through a sweep**, which is a coarser and much more visible failure than the one being looked
for — and it was invisible only because nothing downstream of the grade published WHICH MOMENT the
pixels were of. ADR-021 4b's served-time carry (`SceneLayerDraw.servedTime`, published per draw as
`__rfFrameCache.served`) makes the probe print it, and the two bypassed sweeps separate immediately:

```
stop    B (fresh)                    C (fresh)
0.248   media_1@5.0000               media_1@4.9333
0.387   media_1@7.8000               media_1@4.9333
0.526   media_1@10.6000              media_1@4.9333
0.665   media_1@13.3000              media_1@-          <- no served time at all
0.804   media_1@16.1000              media_1@-
```

Two readings fall out, and the second is the more useful one:

1. **The renderer is exonerated.** In sweep B the served moment tracks the request EXACTLY at every
   stop — 5.0000 for t=5.000, 7.8000 for t=7.800, 16.1000 for t=16.100. Given its input the renderer
   is deterministic and on time. Sweep C's pictures differ because its INPUT differed: the source
   pinned at 4.9333 and then lost its frame entirely. Two renders of different material were never
   going to agree, and every settle-length in the table above was waiting for something that had
   already stopped arriving.
2. **`served == requested`, to four decimals, whenever supply works.** That is the fact ADR-021 4b's
   media content token needs — a token folding `servedTime` would HIT across two visits to one `t`,
   rather than being a term that can never repeat. 4b is viable in principle and still not
   acceptable, because its gate would have to run on this fixture and this fixture voids.

**So the remaining question is narrower and belongs to the decoder**: what makes a source stop
supplying during a repeated scrub sweep in the same page load, and why does it report `-` (no served
time) rather than an error. `awaitReason` / `elementTime` / `wcBusy` are already on the snapshot and
already published to `__rfSourceMap`; the next session on this can read them at the failing stop
without building anything. **Still not the frame cache's, and still not to be chased from that side.**

---

### DEBT-025 — every headless browser launch leaks a Chrome profile directory, and nothing reaps them

**Found 2026-08-16, while a browser gate failed for a reason that had nothing to do with the gate.**

**Status:** open. **Expiry:** when `browser-preflight.ts` reaps stale profile directories as well as
stale processes, or the launcher passes a user-data-dir it cleans up.

**The measurement.** `%LOCALAPPDATA%\Temp` had grown to **239.7 GB across 13,843 directories** and the
disk reached **0 bytes free on C:**. Of those, **13,813 are `puppeteer_dev_chrome_profile-*`** —
oldest 2026-08-09 09:18, newest 2026-08-16 11:24 (i.e. still being created during this session),
**totalling a measured 195.8 GB** — essentially the entire tail, at ~14 MB each. A further 16.5 GB sits in
`debt019-profile-120s`, itself a leftover Chrome user-data-dir from a finished investigation, and 24
`playwright_chromiumdev_profile-*` dirs (0.25 GB) were reaped by hand during this session.

**Why it matters beyond disk.** A full disk does not fail a gate honestly. It **silently truncated a
probe's output mid-write** (`grep: write error`; one full run lost) while every other part of the run
looked normal. Browser gates write profiles, screenshots and vite caches continuously, so a run near
zero free space produces numbers that look like measurements and are not. Generations 3–4 of
`flarex:frame-cache-field` were taken in that state and are marked for re-taking in DEBT-024.

**This is the disk half of a hazard the repo already knows.** `browser-preflight.ts` exists because
leftover browser PROCESSES corrupt gates, and the memory note about stray Chrome trees says the same.
Nobody was watching the directories those processes leave behind. One launch leaks one profile; a week
of gate runs leaks fourteen thousand.

**The fix has two halves. Half one SHIPPED 2026-08-16; half two is DEBT-026.**
1. **DONE.** `reapStaleBrowserProfiles` in `browser-preflight.ts` deletes `puppeteer_dev_chrome_profile-*`
   / `playwright_*` dirs older than 2h (`GATE_PROFILE_REAP_HOURS`), running before `assertFreeDisk`
   measures, so the refusal is never triggered by garbage the gates themselves produce. Age is the only
   safety guard available for a directory and it is sufficient: a live run's profile is minutes old.
2. **DEBT-026.** Have the renderer share one browser rather than opening one per API call, so the
   garbage is never produced. That is the durable fix; the reaper only makes it non-urgent.

**Reaped by hand 2026-08-16 (founder go-ahead):** 13,813 dirs older than 2h plus
`debt019-profile-120s`, leaving the 190 younger than 2h alone — **8.63 GB → 238.45 GB free**.

**Add free disk space to the measurement preconditions.** Alongside "prove the subsystem ran", "prove
the flag applied" and "prove the machine is clean", there is now "prove the machine can still write".

---

### DEBT-026 — the Remotion renderer opens a browser per call, and every one of them leaks its profile

**Open 2026-08-16.** **Expiry:** when `remotion-renderer.ts` shares one browser across a render, and
`%TEMP%` stops growing by a profile directory per Remotion API call.

**The measurement.** 13,995 `puppeteer_dev_chrome_profile-*` directories, **195.8 GB**, oldest 7 days,
which filled C: to zero bytes free and voided a night of readings (DEBT-025, DEBT-024). That count is
not an incident. It is approximately *every browser this repo has ever launched*.

**The cause.** `remotion-renderer.ts` calls `selectComposition`, `renderMedia` and `renderStill`
without ever passing a shared `puppeteerInstance`, so **each call opens and closes its own browser** —
two or more per fixture, ~23 fixtures, every gate run. Our code does close them; what fails is
puppeteer's cleanup of its own temp profile, which on Windows cannot remove a tree Chrome still holds
handles under, and fails silently. The directory name is puppeteer's default, which is what identifies
Remotion rather than our Playwright gates as the source.

**Why it is not urgent, and what makes it worth doing anyway.** `assertQuietBrowserMachine` now reaps
profile dirs older than 2h before it measures free space, so the disk no longer fills. The reason to
fix the source is speed, not space: a browser launch dominates gate startup (the whole basis of the
gate-cost-discipline rule in CLAUDE.md), and this launches one per API call rather than one per run.
Sharing an instance should measurably cut every Remotion-driven gate.

**Why it needs a session rather than a patch.** `selectComposition` and `renderMedia` must then agree
on browser lifetime, cancellation (`cancelSignal`) has to stay correct across a shared instance, and
`chromiumOptions: { gl: "angle" }` — load-bearing for the in-composition WebGL2 colour engine — has to
apply to the shared browser rather than per call. That is a render-correctness change, and it must be
proven byte-neutral with `render:baseline` at zero tolerance, which per CLAUDE.md is the one claim that
must never be batched with another.

**Do NOT "fix" this by raising the reap frequency.** The reaper is the collector, not the cure; it
exists so this item can wait for a proper session.
