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
- Status: open (LATENT — the symptom is gone, the defect is not)
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

- Status: **open** (registered as a META-CLASS with two instances, not as one bug)
- Registered: 2026-08-05 (ADR-013 Phase 0)
- Reason: a health signal is verified against something **asserted upstream** rather than **observed from the subject**. The signal cannot fail, so it reads clean *because* the defect is present. This is the shape shared by DEBT-009 and by F2 below, and naming it is what makes it reviewable instead of rediscoverable.
- Invariant affected: none directly — this is a class of *evidence* defect, which is why it evades invariant checks
- Owner: unassigned
- Expiry condition: none — a class entry retires when both instances retire and no third is found
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

### DEBT-013 — a source denied at mount can never be admitted, and nothing reports it

- Status: **open — USER-VISIBLE DEFECT**, raised to the founder 2026-08-06
- Registered: 2026-08-06 (ADR-013 Phase 0; see ADR-020 §2)
- Reason: ADR-012 §6.11 offers a persistently low-ranked source exactly two ends — *it receives a session, or it is declared permanently denied.* The runtime produces a third: it waits forever. Two independently measured mechanisms compose to make recovery impossible, and neither is individually wrong.
- Invariant affected: **ADR-012 §6.11 (violated)**; I-40's aging requirement unmet in practice
- Owner: unassigned
- Expiry condition: a source denied at mount is subsequently admitted, or is declared permanently denied, on a fixture with more sources than slots
- Planned slice: ADR-020 §5 slice **A** (§6.11 recovery)
- Tracking issue: —
- Detection: any change that adds a retention path, or removes an admission decision point, without adding a compensating re-ranking opportunity. Also: `deniedForMs` failing to accumulate for a candidate that is losing.

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
