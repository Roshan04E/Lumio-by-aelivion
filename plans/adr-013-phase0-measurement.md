# ADR-013 Phase 0 — Measurement design

**Status:** design, pre-registered. **Branch:** `method-3-gpu-compositor`. **Date:** 2026-08-04.
**Governed by:** ADR-013 (Accepted), `FLAREX_IMPLEMENTATION_GOVERNANCE.md`, and the five soak rules in
`plans/adr-012-phase3-soak.md` — which are binding here without amendment.

---

## 0. What this document is, and what it deliberately is not

ADR-013 §9 leaves **eight magnitudes open** and says the implementation programme is not to be planned
until they are answered. This document designs the measurements that answer them. It contains **no
slice catalogue, no subsystem stubs, and no phase plan**, and producing one before these numbers exist
would be inventing architecture out of guesses — which is the specific failure ADR-013 §9 was written
to prevent.

Three things are pre-registered here, before any number is collected, and that ordering is the whole
point:

1. **the instrument** — what is recorded, by what code, and whether that code exists today;
2. **the decision rule** — the result that settles the question, declared as a threshold *before*
   measuring, so a marginal result cannot be rationalised afterwards;
3. **the falsifier** — the result that would say an ADR-013 clause is wrong rather than that a constant
   needs tuning. Six of the eight have one. A measurement with no falsifier is a fishing trip.

The exit criterion is in §6. Until it is met, no slice is written.

### 0.1 The property that makes this affordable

**Seven of the eight questions are measurable on today's runtime**, because today's runtime already
contains the mechanisms ADR-013 renames. Rank exists and is live
(`packages/shared/src/kernel/admission.ts`, S4.3). The quality ladder exists as ten rungs across six
owners — `previewQualityProfiles` is L3, comp proxy is L4, `preferSoftware` is L1, denial is L5. The
pressure signal exists as counters (`capMisses`, `shareDetaches`, `admissionDenials`, wedge timeouts).

So Phase 0 does not build the subsystems in order to measure them. It **instruments what is already
deciding**, which is also the only way to get a baseline that the later programme can be regressed
against. The one exception is OQ8's upper bound, which is perceptual and is not measurable by a probe
at all — §3.8 says so rather than inventing a number for it.

---

## 1. Preconditions — binding, not advisory

Carried verbatim in force from `plans/adr-012-phase3-soak.md` and the measurement-preconditions
directive. A run violating any of these is **void** and its numbers must be discarded, not caveated.

| # | Precondition | Why |
|---|---|---|
| P1 | `PIXEL_BROWSER_CHANNEL=chrome` on every browser measurement | Without it the probe runs SwiftShader at ~8fps, where none of these races reproduce. Nine "clean" runs were collected that way before anyone noticed. |
| P2 | Prove the subsystem ran before reading any number | `awaitWebCodecsEngaged`, then read `__rfRouting` / `__rfWcMode`. WebCodecs is element-routed until the ingest proxy lands (~10s); a soak that presses play on arrival measures a subsystem that never started. |
| P3 | Never two measurements concurrently | Both become void. Decode capacity is the shared quantity under test; a second run *is* a contending consumer. |
| P4 | Prove the build is the build | The temporal-coherence episode traced to a build shipping `react-dom.development` via `.env.local`. Record the bundle mode with each run. |
| P5 | One topology change per measurement arm | Rule 2. An arm that varies two things names a *run*, not a cause — the `dc1319d` bisect cost four extra runs to learn this. |
| P6 | Acceptance evidence does not transfer across a configuration change | Rule 3. A baseline collected at K=4 is not a baseline for K=5, even for a number believed unrelated to K. |
| **P7** | **On a fixture with more declared sources than the session budget, fps is not a comparand** | Measured 2026-08-05 (§4.1.1, DEBT-011). Identical arms differ 55–125%, bistable, and which arm degrades alternates between runs — because arrival order decides who holds a session. Use `capMisses` and the unconditional counters; report `wcProvider %` beside any frame-rate figure so a reader can see which arms were comparable at all. |
| **P8** | **`wcProvider %` is the precondition instrument, not `awaitWebCodecsEngaged`** | The helper tests `.some(mode !== "element")`, so one engaged source of six satisfies it. It answers "has anything started", never "is this arm comparable". An arm below 100% on a fixture whose sources should all decode is not comparable to one at 100%. |

### 1.1 Which measurements are decoder-topology changes

Rule 1 — *every decoder-topology change requires a decoder soak; pixel 53/53, `kernel:conform` and
typecheck are not sufficient* — applies to a measurement arm exactly as it applies to a slice. A
measurement that alters **who is declared, session identity, lease priority, admission, or retention**
is a topology change whatever its intent.

| Measurement | Topology change? | Soak required |
|---|---|---|
| M1 rank census | No — diagnostics-only record | No |
| M2 lag sensitivity | No — offline pixel comparison | No |
| M3 ladder cost/fidelity | **Yes** — comp-proxy arms change the declared-source set (this is precisely the S3.5 demotion shape that produced the `dc1319d` regression) | **Yes, per arm** |
| M4 pressure statistics | No — reads existing counters | No |
| M5 contention census | No — diagnostics-only record | No |
| M6 lead time / background floor | **Yes** for the floor arms (cap reallocation) | **Yes, per arm** |
| M7 budget K frontier | **Yes** — varies the caps directly | **Yes, per N** |
| M8 cadence band | No — derived from M4 | No |

M3, M6 and M7 are therefore the expensive ones, and they are sequenced last (§4).

### 1.2 The rule for every new instrument built in Phase 0

Programme risk **R1 — the observer effect** — is live and is why `kernelDiagnostics` survived S7.2 as
the one retained control. Every instrument added by Phase 0 must satisfy the classification the S7.2
audit established:

> **The state change happens BEFORE the guard. Only the `record()` call is inside it.**

An instrument that changes scheduling, admission, caching, borrowing, timing or execution is behaviour
wearing a diagnostics guard, and must be refactored out before it ships. The review question is: *does
the runtime do something different with the flag off?* If yes, it is not an instrument.

Two known traps, both already documented and both directly in Phase 0's path:

- `rankAdmission` allocates a candidate array and sorts it. M1 wants the *whole scored vector*, which is
  a larger allocation on the same per-acquire path. It must be behind the guard and must copy nothing
  when off.
- `admissionDenials` is counted **inside** the guard and reads 0 with diagnostics off. `capMisses` is
  the unconditional counter beside it. M5 must read `capMisses` as its denominator and `admissionDenials`
  only as attribution, or its ratios are measured against a number that does not exist when the
  instrument is off.

---

## 2. Instrument inventory

**Exists and is sufficient:** `__rfWcPool` (created, capMisses, preemptions, reused, retentions,
retentionHits, wedgeTimeouts, shareDetaches, blindSplits, admissionDenials), `__rfKernelState`
(decoder / resources / media ledgers), `__rfKernel.summary()`, `__rfFrameStats`, `__rfWcMode`,
`__rfFlarexProxy`, `__rfFlarexDegradation`, `__rfBorrowLedger`, `__rfRenderCost`, `__rfRouting`,
the frame profiler (`?flarexProfile=1`), and `preview:budget` as the soak harness.

**Must be built (all diagnostics-guarded, all `record`-only):**

| Instrument | For | Shape |
|---|---|---|
| `admission.scored` ring | M1, M5 | The full scored vector at each contended decision: per candidate `{key, merit, aging, rank, undeclared, residencyProtected, incumbent, admitted}` plus `capacity` and `tieBroken`. **`tieBroken` is the discriminator that matters** and is **tri-valued** — `rank` \| `residency` \| `key` — because the comparator has three levels, not two (`admission.ts:217-221`). Recording it as a boolean would merge "damped by hysteresis, as designed" with "decided alphabetically", which are the opposite findings. `incumbent` (`admittedAtMs != null`) is recorded for the reason in §3.1's code note. |
| `acquire.lead` | M6 | Per live acquire: wall clock at which the need became predictable, wall clock at request. Transport state at both. **Built at Stage 5, not Stage 0 — see below.** |
| `pressure.series` | M4, M8 | C18-shaped tuple sampled at a fixed cadence: `{contention, missedDeadlines, starvationAge, cancelledWork, unclaimedReserve:0}`. `unclaimedReserve` is structurally zero today (no reservations exist) and is carried as a declared hole, not omitted. **Sampled harness-side — see below.** |

**Two refinements to how those two are built, decided while building them.**

**`pressure.series` is sampled from the harness, not instrumented in the runtime.** Every quantity it
needs already exists as an unconditional counter (`capMisses`, `shareDetaches`, `wedgeTimeouts`,
`created`) and as `__rfFrameStats`. Polling `__rfWcPool` from the probe at a fixed cadence and
differencing yields the same time series with **zero added runtime cost** — no new per-frame work, and
nothing for M0 to bound. An instrument that can live outside the process being measured should.

**`acquire.lead` moves to Stage 5.** It genuinely requires a runtime seam at the acquire site, but it
feeds M6a only, and M6a is Stage 5. Building it at Stage 0 would put a second untested instrument on the
acquire path and fold its cost into M0's bound, making the bound describe instrumentation that Stage 1
never runs with. It gets its own M0-shaped on/off check before M6a, under the same rule.

**Net effect on M0:** it now bounds exactly what Stage 1 executes with — `admission.scored`, and nothing
else. That is what makes its number interpretable.

Nothing else. Note what is **not** built: no scheduler, no Governor, no reservation mechanism, no
capability type. Phase 0 measures the runtime that exists.

---

## 3. The eight measurements

### 3.1 M1 — rank function weights (OQ1)

**Question as stated.** ADR-012 §6.3 names the ranking inputs but not their relative weight.

**The suspicion the measurement exists to test.** Weights may not be the open question at all.
`contributionRank` is `area × opacity` with aging added afterwards, and `area` is currently derived as
`min(1, scale²)` from the layer transform — **not coverage, not occlusion**
(`packages/shared/src/composition-style.ts:1661`). `reachable` defaults to true and
`underDisabledBranch` to false. For the canonical case ADR-013 §1 cites — four competing full-frame
MediaIns — every candidate scores merit 1.0, and the decision falls through to the `key` tie-break,
which is a URL string comparison. If that is what the data shows, ranking is presently **alphabetical**,
and tuning weights over a constant would be tuning nothing.

Separately: comp proxies acquire with **no contribution declared**
(`useFlarexCompProxies.ts:336`), so they rank at `UNDECLARED_RANK = 0.01` — below every declared source.

**Procedure.** Enable `admission.scored`. Run the fixture corpus (3+ asset-source MediaIns on one clip,
plus 5–8 MediaIn comps, plus a comp with a proxy serving) through play and hard-scrub, per the Run A/B
shape of the existing soak. Record every contended decision (`candidates > capacity`).

**The confound, and how the metric is split to remove it.** Undeclared candidates all score exactly
`UNDECLARED_RANK` and therefore tie **with each other**, falling through to the same `key` comparator a
degenerate `area` produces. A single tie-break fraction is thus driven by two independent defects with
opposite remedies — *rewrite the `area` derivation* versus *fix declaration at the call sites* — and
cannot distinguish them. The two populations are measured separately:

- ***T*_declared** — fraction of contended decisions **among fully-declared candidates only** resolved
  by the `key` tie-break. This is the metric that speaks to the `area` derivation.
- ***T*_undeclared** — tie-breaks among undeclared candidates, reported as a separate figure. It is a
  consequence of *U*, not evidence about `area`, and is never summed into *T*_declared.
- ***U*** — fraction of candidates with `undeclared: true`. Now an independent quantity.

Decisions with a mixed candidate set contribute to *T*_declared only if the contended boundary — the
admitted floor and the top denial — sits between two declared candidates. Otherwise the decision is
recorded as mixed and excluded from both, with the count reported.

**Decision rule, pre-registered.**

| Result | Settles as |
|---|---|
| *T*_declared ≥ 0.5 | **OQ1 is misposed.** Weights are not the open question; the derivation of `area` is. OQ1 is rewritten as "derive contributed area from coverage and occlusion", and weight tuning is deferred behind it. |
| *T*_declared ≤ 0.15 and *U* ≤ 0.15 | Rank genuinely discriminates. Weights are a real tuning surface → proceed to M1b. |
| otherwise | Inconclusive; widen the corpus and re-run before deciding. No default. |

#### AMENDMENT (2026-08-05) — the rule above is DEFECTIVE and its second row must not be applied

Recorded rather than quietly rewritten, because a pre-registered rule edited after seeing data is worth
nothing unless the edit and its reason are both visible.

**The defect.** *T*_declared measures the share of contended decisions decided by the `key` comparator.
The rule then reads a *low* *T*_declared as evidence that **rank** discriminated. That inference does not
hold: the comparator has **three** levels, so a decision not decided by `key` was decided by `rank` **or**
by `residency`, and those are opposite findings. Row 2 therefore fires on evidence that does not support
its conclusion.

**This is self-inflicted and the instrument already knew better.** `tieBroken` was deliberately made
tri-valued (§2) on the argument that a boolean *"would merge 'damped by hysteresis, as designed' with
'decided alphabetically', which are the opposite findings"*. The decision rule was then written as if the
instrument were two-valued. The reasoning that corrects it is the same reasoning that built the
instrument, and it stands without reference to any measurement — which is what makes this a correction
rather than a rationalisation.

**The corrected rule.** Report all three shares over declared-boundary contended decisions, and read the
one that dominates:

| Result | Settles as |
|---|---|
| `key` share ≥ 0.5 | **OQ1 is misposed** — the `area` derivation is the open question. *(unchanged)* |
| `rank` share ≥ 0.5 and *U* ≤ 0.15 | Rank genuinely discriminates → M1b weight sweep. *(this is what row 2 was trying to say)* |
| **`residency` share ≥ 0.5** | **Rank is inoperative at the moment contention occurs.** Minimum residency is the operative admission policy. Weight tuning is pointless until the residency window is reconciled with when contention actually happens — a *different* question from either original row, and one the original rule could not express. |
| otherwise | Inconclusive; widen the corpus. No default. |

The third row is new. It was not anticipated, and the measurement produced it on the first run.

**Falsifier, now testing something the rule does not.** *U* ≥ 0.5 says most consumers never declare a
contribution, so I-48 ("rank is an input, computed by Source Admission") is satisfied only vacuously —
Admission would be ranking mostly-absent data. That is a wiring defect to fix before the scheduler
consumes rank at all, and it changes the programme's first slice. It is now independent of
*T*_declared rather than the same observation read from the other end.

**Two things the code contradicts, recorded here rather than softened.**

**C1 — the §6.11 aging term is structurally inert on this path, so ranking is merit plus tie-breaks and
nothing else.** In `reportAdmissionDenial` (`preview-frame-pool.ts:1339-1354`) every incumbent is pushed
with `admittedAtMs: record.acquiredAt`, and `rankAdmission` applies aging only when `admittedAtMs == null`
(`admission.ts:202`). The sole candidate with a null value is the newcomer, whose `firstRequestedAtMs` is
`now` — so its `deniedForMs` is 0 and its aging term is 0. **Every aging term in every live contended
decision is therefore zero.** The pool's own header states the gap plainly (`:1322-1324`): *"a lease that
failed left no record to age."*

This strengthens the confound above rather than weakening it — undeclared candidates tie at *exactly*
`0.01`, and declared full-frame layers at *exactly* `1.0`, with no aging jitter to separate them. It also
means M1 must record the aging column and **assert it is zero**; a non-zero aging term would mean the
call path has changed since this was written and the analysis needs revisiting.

Consequence beyond M1: ADR-013 leans on aging in three places — I-40 (ordering damped and aged), I-51
(background capacity ages), and §4.4's fairness floor. All three inherit a fairness term that does not
currently fire. This is a **finding about the runtime, not a Phase 0 defect**, and it is recorded here
because it will otherwise be discovered by a slice that assumes aging works.

**C2 — `deniedForMs` means two different things depending on the candidate, and one of them corrupts a
denial reason M5 reads.** For the newcomer it is genuinely 0. For an incumbent it is
`now - record.acquiredAt` — *how long the source has held its slot*, not how long it has been denied.
Since `rankAdmission` maps `deniedForMs >= PERMANENT_DENIAL_AFTER_MS` to `"permanently-denied"`
(`admission.ts:284`), **any incumbent displaced after holding a session for 30s is labelled permanently
starved** — the exact inverse of its situation, and the one denial reason carrying `severity: "warn"`.

M1 and M5 must therefore split every denial census by the recorded `incumbent` flag and must not trust
`"permanently-denied"` as a starvation signal on the incumbent population. Reporting this as a
mis-labelled diagnostic is a Phase 0 deliverable; fixing it is not, and it must not be fixed inside a
measurement run — that would be a predicate change during measurement, which is rule 4 inverted.

**Both C1 and C2 are read from the code, and a read is not a measurement.** The house standard is
ADR-017 U12: a field ships only after its observer has been *watched working*. Five files were wired,
typecheck was clean and every negative test passed while a wrapper silently dropped the value — so
"I read the call path and it cannot age" has exactly the epistemic status that episode punished.

Each therefore ships with an assertion that fails loudly if the read was wrong:

| | Asserted in M1 | Fails when |
|---|---|---|
| **C1** | every `aging` term in every recorded contended decision is exactly `0` | the call path has changed since this reading, or some other caller reaches `rankAdmission` with `admittedAtMs: null` on an aged candidate |
| **C2** | for every candidate with `incumbent: true`, the recorded `deniedForMs` equals `now - acquiredAt` (residency), **not** time-since-first-denial | the incumbent/newcomer semantics are not what the read claimed |

A C2 assertion failure is not a curiosity: **M5's census split is built on that premise**, and the split
is what decides OQ5's per-class-versus-per-source answer. Failure means the split is invalid and M5 is
re-derived before its decision rule is applied, not after.

**M1b — offline weight sweep.** If M1 reaches the second row: sweep candidate weightings over the
*recorded* scored vectors, offline, scoring each weighting by how often it admits the source a human
would call most visible. This requires **no runtime change and therefore no soak**, and that property is
worth protecting — it means the weights can be tuned repeatedly at near-zero cost. Any tuning method
that requires a live arm has given this up and should be rejected on that ground alone.

---

### 3.2 M2 — lag tolerance derivation (OQ2)

**Question as stated.** "A declared property of a source's role in the frame" is the right shape; the
derivation from the graph is unspecified and must be validated against real comps before freezing.

**Ground truth first.** The derivation is a *predictor*; it needs something to predict. The measurable
truth is: **does serving this source an older moment produce a visible error?** That is directly
measurable with the existing pixel harness — render each fixture frame twice, once with source S served
at *t* and once at *t−Δ* for Δ ∈ {1, 2, 4} frames, and record the pixel delta. This yields a per-source
empirical lag sensitivity, ordered.

**Procedure.** Offline, over the 53-fixture pixel corpus plus the multi-MediaIn comps. No decoder
topology is touched: the comparison is between two renders, not two runtimes.

**Candidate derivations to score** (all graph properties, none identity):
D1 contributed area · D2 sits under a blur/defocus chain · D3 depth in the composite stack ·
D4 is the source of the frame's dominant motion.

**Decision rule, pre-registered — with a noise floor, because "no inversions" is not a survivable bar.**
Evaluated over 53+ fixtures against four candidate derivations, a single marginal pair would disqualify a
derivation, and the probability that all four fail on measurement noise alone is substantial. The
falsifier's consequence is a C15 contract-shape change; it must be triggered by a real inversion, not by
two fixtures a few deltas apart.

An inversion **counts** only if the `tolerant` source's measured lag error exceeds the `strict` source's
by more than the noise floor *N*, where:

> ***N* is measured, not assumed**: render each fixture frame twice at identical Δ and take the p99 of
> the resulting pixel deltas. That is the harness's own reproducibility, and it is collected before any
> derivation is scored.

A derivation is **admissible** iff its counted inversions ≤ **2** over the corpus — pre-registered, and
chosen as "more than one fixture disagrees" rather than as a rate, because a rate would let a derivation
that fails on a whole fixture class pass by being large. Among admissible derivations, prefer the one
with fewest inputs. If two or more remain, report both rather than breaking the tie on preference.

**A limit on generalisation, stated rather than engineered around.** A source that is static over the
sampled window has zero delta at every Δ and is scored maximally tolerant — but that is a property of the
fixture's *motion content*, not of the source's *role in the frame*. Since D4 ("source of the frame's
dominant motion") is itself a candidate derivation, scoring it against this ground truth partly tests it
against a restatement of itself.

The corpus controls for it in the only honest way available: **sources with sub-*N* delta at Δ=4 are
excluded from scoring entirely** and reported as an unclassified population with its size. They carry no
evidence either way — a source that cannot be shown to care about lag has not been shown to tolerate it.
If that population is large (> ⅓ of sources), M2 does not generalise beyond moving content, and D4's
result specifically must be read as provisional. No fixture is added to fix this; adding motion to make a
derivation score better would be tuning the ground truth to the hypothesis.

**Falsifier — and it is a real fork.** If *every* candidate derivation inverts on real comps, lag
tolerance is not derivable from the graph. C15's `lagTolerance` then changes from a computed field to a
**declared** one, sourced from the source's declaration rather than from Admission — a contract-shape
change, and one that must be recorded as an ADR-013 amendment rather than absorbed silently by an
implementer.

**Note on what this replaces.** `tolerateLag` today is set from `isFlarexVirtualLayerId` — identity, the
defect ADR-013 §4.2 names explicitly. Whatever M2 selects, it must not be a predicate on a layer id.

---

### 3.3 M3 — level ordering for substitution, L4 vs L3 (OQ3)

**Question as stated.** L4 (prepared stand-in) sits below L3 (spatial) on the assumption a proxy costs
more fidelity than a downscale. Needs measurement on the integrated-GPU target — a comp proxy may be
cheaper *and* sharper than a heavily downscaled live evaluation.

**Both mechanisms already exist.** L3 is `previewQualityProfiles` (`resolutionScale` 0.25 / 0.5 / 1).
L4 is the comp proxy via `useFlarexCompProxies`. So this is measurable without building a ladder.

**Procedure.** Four arms per fixture, each an independent run (P5): L0 live at scale 1 · L3 at 0.5 ·
L3 at 0.25 · L4 comp proxy. Record cost as steady-state fps under `?flarexProfile=1`, decode ms/frame,
and sessions consumed; record fidelity as pixel delta against the L0 render **at equal presented
resolution** — comparing a 0.25-scale backing against a full-res reference without upsampling to a
common surface makes the fidelity number meaningless.

**This is a topology change and each arm needs a decoder soak.** Turning a comp proxy on changes who is
declared, which changes who competes for a session — 8 grants became 5 in the `dc1319d` case with every
pixel identical. Read `shareDetaches`, `capMisses` and grant/hit ratio on each arm.

**Decision rule, pre-registered.**

| Result | Settles as |
|---|---|
| L4 fidelity loss ≥ L3@0.25 fidelity loss, at equal or worse cost | ADR-013 §4.3's ordering stands as written. |
| L4 is both cheaper **and** sharper than L3@0.25 on ≥ ⅔ of fixtures | The ladder's global order is wrong. L4 moves above L3. |
| The comparison inverts across fixtures (L4 wins on some, loses on others) | **The ladder is not totally ordered on this hardware.** |

**Falsifier.** The third row falsifies a normative clause: ADR-013 §4.3 declares "one ordered list,
walked in order". A partial order — where the next rung depends on the source — is a different design
and requires an ADR amendment before any Governor is written against it. This is the most likely
outcome and should be treated as such, not as a surprise.

---

### 3.4 M4 — Governor hysteresis constants (OQ4)

**Question as stated.** Deliberately unfixed, for the same reason ADR-012 leaves the playback lag budget
unfixed.

**What can be measured before a Governor exists.** Not the constants — the *signal they must sit
outside of*. Hysteresis must be longer than a transient pressure burst (or the Governor chases noise,
which is I-52's failure mode arriving by accident) and shorter than a user-noticeable interval.

**Procedure.** Sample `pressure.series` at fixed cadence across play, scrub, seek, multi-comp and
background-proxy-active conditions. Characterise: burst duration distribution (p50/p95/p99), inter-burst
interval, and autocorrelation.

**Decision rule, pre-registered.** Hysteresis lower bound := **p95 contention-burst duration**. The upper
bound comes from OQ8/M8. Report the band, not a number — the constant is configuration (§6.12) and is
the founder's to pick within a measured band.

**Falsifier — and it is asymmetric with the others; the asymmetry is part of the result.** If p95 burst
duration exceeds M8's upper bound, the two bounds cross and there is no valid fixed hysteresis constant:
the Governor could not be a fixed-hysteresis design, and §3.26's "continuous; hysteretic" lifecycle needs
reformulating — most likely as a rate-limited controller over a smoothed signal rather than a threshold
with dwell.

But **only one side of that comparison is measured.** M4's lower bound comes from the pressure series;
M8's upper bound is human-chosen and not measurable by a probe (§3.8). So a crossing says *the design is
infeasible under the tolerance someone chose*, which is weaker than a measured falsification and must not
be recorded as one.

> **Recording rule.** A bound crossing is written as **"infeasible at upper bound *X*, chosen by *[name]*
> on *[date]*"** — never as "I-52 falsified". The chosen value and its owner travel with the result
> permanently.

The distinction is not pedantic: a later reader who sees "I-52 falsified" will assume it was measured and
will not think to re-examine the tolerance, which is the one input that could legitimately change. §3.8's
instruction stands unaltered — **the upper bound is not widened until it fits**. This finding governs how
the result is labelled, not whether the widening is permitted.

---

### 3.5 M5 — reservation granularity, per-class or per-source (OQ5)

**Question as stated.** Per-class is simpler and probably sufficient; per-source is more precise and
more to get wrong.

**The measurement that decides it.** Who actually contends with whom. A per-class reserve can only
express protection *across* classes; if the observed contention is predominantly `live`-versus-`live`,
a per-class reserve cannot express the needed protection and the simpler design is simply insufficient.

**Procedure.** From `admission.scored`, for every contended denial record the purpose class of the
denied candidate and of the sources that displaced it. Denominator is `capMisses` (unconditional), not
`admissionDenials` (guard-gated) — see §1.2.

Split the census by the recorded `incumbent` flag, per **C2** in §3.1: `deniedForMs` measures denial
duration for the newcomer and *residency age* for an incumbent, so `"permanently-denied"` on the
incumbent population is a mis-label and must not be read as starvation. Starvation evidence comes from
the newcomer population only.

**Decision rule, pre-registered.** Let *I* = intra-class share of contended denials.

| *I* | Settles as |
|---|---|
| < 0.10 | **Per-class.** Simplest sufficient design; record the measured *I* as the justification. |
| > 0.30 | **Per-source is required.** Per-class would be a reserve that cannot see the contention it exists to arbitrate. |
| 0.10–0.30 | Inconclusive. Widen the corpus; do not default to the simpler option because it is simpler. |

**Falsifier.** If contended denials are rare in absolute terms across the whole corpus (< ~1% of
acquires), reservations are solving a problem this workload does not have on this hardware, and their
priority in the programme drops behind the ladder and the ordering work. That is a finding worth having
before building the mechanism ADR-013 §4.4 calls the one that "matters most".

---

### 3.6 M6 — reservation window and background floor (OQ6)

**Question as stated.** Too short a window and the reserve never protects anything; too long and it
becomes the partition §4.4 forbids. The floor has the same shape.

**Two independent magnitudes, measured separately.**

**M6a — the window.** A reservation is capacity held for work *not yet issued*, so its window must cover
the **lead time**: the interval between the moment a live frame's need becomes predictable and the moment
it is requested. Instrument `acquire.lead`. During steady playback the lead is ~one frame interval and
the need is predictable. During a seek it is **zero** — the need becomes known and is requested in the
same instant.

Decision rule: window := p95 live lead time, measured separately per transport state.

**Falsifier, and it is likely.** If scrub and seek dominate the corpus, p95 lead ≈ 0 and **a fixed
reservation window cannot protect anything** — you cannot hold capacity for work whose existence you
learn about at the moment it is requested. Reservations would then have to be triggered by *transport
state* ("the transport is live, hold a reserve") rather than by a declared window, which is a different
mechanism from the one §4.4 specifies. Note that this reformulation must still satisfy I-50: a
transport-triggered reserve still expires, or it is a partition with extra words.

**M6b — the background floor.** I-51 requires a non-zero floor that ages. The floor must be large enough
for background work to make *monotone forward progress*, or it satisfies the invariant's letter and
delivers the starvation it forbids.

Procedure: with live holding N sessions of K=4, measure whether a proxy build completes, and its
throughput, at 4−N ∈ {1, 2}. **Cap reallocation is a topology change; each arm gets a soak.**

Decision rule: floor := the smallest allocation at which proxy build throughput is non-zero and
monotone over a 3-minute run.

**Falsifier.** If proxy generation cannot progress at 1 session while live holds 3, then no floor exists
inside K=4 that satisfies both I-51 and live's needs. That is a finding about **K**, not about the
floor, and it feeds directly into M7 — which is why M7 is sequenced after it.

---

### 3.7 M7 — the acquisition budget K in practice (OQ7)

**Question as stated.** K is a machine constant but its value is not fixed by the ADR: currently 4
concurrent sessions on the integrated-GPU target, and it will differ per host and per acquisition
dimension.

**What is there now, and the scar on it.** `MAX_WC_SESSIONS = 3` hardware, `MAX_WC_SOFTWARE_SESSIONS = 3`,
`MAX_WC_TOTAL_SESSIONS = 4`, `HARDWARE_RESERVED_SLOTS = 1`. The pool's own header records why the total
cap exists: splitting hardware and software into separate caps silently raised concurrency from 3 to 7
and killed the renderer under scrubbing. *Two caps that merely sum are not a budget.*

**Procedure.** For N ∈ {2, 3, 4, 5, 6} total sessions, one arm each, one commit each (P5), run the Run D
stress shape: rigorous scrubbing across a multi-comp timeline for 2–3 minutes, then 60s paused. Record
sustained fps, decode ms/frame, `capMisses`, `openCount`, `wedgeTimeouts`, `orphaned` at rest, and JS
heap + GPU memory trend.

**Measure the dimensions separately.** ADR-013 §5.2 promoted "acquisition capacity is multi-dimensional"
to normative: hardware sessions, software sessions and (later) network connections are distinct pools
that do not substitute. A scalar K would look correct until the second acquisition kind arrives, so
report K as a vector from the outset — `K_hw` and `K_sw` — even though only two dimensions exist today.

**Decision rule, pre-registered.** K := the largest N for which **all** hold: sustained fps within noise
of N−1; `wedgeTimeouts` 0; `orphaned` empty at rest; no renderer crash; memory flat or sawtoothing.

**Falsifier.** If fps *degrades* between N=3 and N=4, the shipped K is already past the frontier and
today's default is a misconfiguration — which would mean part of the observed contention is
self-inflicted and the scheduler is being asked to arbitrate scarcity that a cap correction removes.
Worth knowing before designing around it.

**Cost note.** This is the most expensive measurement — 5 arms × (3 min stress + soak) plus baselines —
and it changes a cap, so it runs last, on its own commits, and its arms are never interleaved with
anything else (P3).

---

### 3.8 M8 — the Governor cadence bound (OQ8)

**Question as stated.** The principle — strictly slower than frame rate — is normative; the multiple is
not. It must be slow enough that a directive change is never mistaken for a per-frame response, and fast
enough to react to sustained pressure within a user-noticeable interval.

**The honest split, stated because inventing a number here would be the easiest mistake in this
document.** The bound has two halves and only one of them is measurable by a probe:

- **Lower bound — measurable.** Derived from M4: the cadence must exceed the p95 contention-burst
  duration, or the Governor responds to bursts, which by I-52's own definition makes it a scheduler.
  Additionally it must exceed one frame interval by a stated multiple — the multiple is what M4's
  autocorrelation structure informs.
- **Upper bound — NOT measurable by a probe.** "User-noticeable interval" is a perceptual quantity about
  a human watching a quality change. No counter in this runtime observes it. It is settled by human
  judgement, and Phase 0's job is to hand over a *feasible band*, not to manufacture a number and
  present it as measured.

**Decision rule, pre-registered.** Report the band `[lower, upper_candidate]` where `upper_candidate` is
a human-chosen value, explicitly labelled as chosen rather than measured. Then verify mechanically that
a conformance assertion — `QualityDirective` changes at most once per N frames — is satisfiable at the
chosen value. That assertion is what makes "the Governor became a second scheduler" a failing test
rather than a reviewer's opinion, so it must be shown to be constructible at Phase 0, not assumed.

**Falsifier.** An empty band — lower bound above the chosen upper bound — says I-52 is unimplementable as
stated and requires an ADR amendment. Do not resolve an empty band by widening the upper bound until it
fits. Record it under §3.4's recording rule: *infeasible at upper bound X, chosen by [name] on [date]* —
because the upper half of the comparison is a judgement, and the record must say whose.

---

## 4. Sequencing

**Serial, always** (P3). Grouped by cost and by whether an arm touches decoder topology.

| Stage | Measurements | Topology change | Prerequisite |
|---|---|---|---|
| **0** | Build `admission.scored`, `acquire.lead`, `pressure.series` behind `kernelDiagnostics`; verify allocation-free when off (R1); then **M0 — bound the cost when on** (§4.1) | No | — |
| **1** | M1 (rank census), M5 (contention census), M4 (pressure statistics) — one corpus run instruments all three | No | Stage 0 |
| **2** | M2 (lag sensitivity), M1b (offline weight sweep, if M1 reaches it) | No — offline | Stage 1 |
| **3** | M8 (cadence band) | No — derived | M4 |
| **4** | M3 (ladder cost/fidelity) | **Yes, per arm** | Stage 1 |
| **5** | M6a (lead time), then M6b (background floor) | M6b **yes** | Stage 1, M3 |
| **6** | M7 (budget K frontier) | **Yes, per N** | M6b |

Stages 1–3 are cheap, share one instrumented corpus run, and answer four of the eight questions with no
decoder-topology risk. That is deliberate: **the cheap questions are answered first, and their results
may change what the expensive ones need to measure.** If M1 shows rank is currently alphabetical, the
ladder and reservation work is being designed on top of an ordering that does not yet order — and that
is worth knowing before spending stage 6's runs.

Stage 0's own verification is not a formality. An instrument that allocates when off would make every
subsequent number a measurement of the instrument, which is R1 and is exactly what `kernelDiagnostics`
was retained to keep enforceable.

### 4.1 M0 — bounding the observer effect in the ON direction

R1 requires an instrument to be free **when off**, and Stage 0 verifies exactly that. But Stages 1–3 run
with the instruments **on**, and `admission.scored` records the whole scored vector on the per-acquire
path — §1.2 already notes this is a larger allocation than the sort `rankAdmission` performs today. So
verifying only the off direction proves the shipped runtime is unharmed and *assumes* the measured
runtime is, on the exact path whose contention is the subject of every Stage-1 number.

§5's void class 6 — an instrument enabled in one arm and not another — describes the Stage-1 baseline's
relationship to the shipped runtime precisely.

**Procedure.** One fixture, two arms, identical topology, `kernelDiagnostics` on versus off. Record
steady-state fps under `?flarexProfile=1`, decode ms/frame, and `capMisses`. `capMisses` is the load-
bearing one: it is the unconditional counter (§1.2), so it is the only contention figure comparable
across the two arms — `admissionDenials` reads 0 in the off arm by construction and comparing it would
manufacture the effect it is meant to detect.

**The variance baseline comes first, because the strict bar assumes a determinism `capMisses` may not
have.** `capMisses` is a contention count on a system with real timing variance; two identical off-arm
runs need not produce the same number. A rule requiring Δ`capMisses` = 0 would then fail spuriously, and
M0's falsifier is written so that a spurious failure refactors a sound instrument and blocks all of
Stage 1. M2's discipline applies here too: measure the floor before scoring against it.

**Procedure, ordered.**

1. **Two off-arm runs, identical topology.** Record `capMisses` and fps on each. This is the run-to-run
   variance *V*, and it is collected before the instruments are ever enabled.
2. **The on/off pair.** One fixture, two arms, identical topology, `kernelDiagnostics` on versus off.

**Decision rule, pre-registered.** Δfps and Δ`capMisses` **within *V*** → the effect is negligible and
Stage 1 proceeds unqualified. Exceeding *V* → the measured delta is recorded as a **standing correction
carried on every Stage-1 number**, stated as a magnitude rather than as a caveat.

**If `capMisses` proves genuinely deterministic across the off-arm pair — *V* = 0 — say so and keep the
strict Δ = 0 bar.** That is the stronger result: a deterministic contention counter makes every later
contention comparison in this programme sharper. Record *V* either way; a `capMisses` that turns out to
be stochastic is itself a finding about what M4 and M5 can claim.

**Falsifier.** If enabling the instruments changes `capMisses` **by more than *V***, the instrument is
altering admission outcomes, not merely observing them — it is behaviour wearing a diagnostics guard (§1.2), and it must be
refactored before any Stage-1 number is collected. That is R1 as a gate rather than as a principle.

### 4.1.1 M0 RESULT — measured 2026-08-05. Stage 1 proceeds unqualified.

Four runs, eight arms, `PROBE_SOURCES=6` distinct files against a 4-slot budget, `PIXEL_BROWSER_CHANNEL=chrome`,
`PROBE_REQUIRE_WC=1`, 14s sampled per arm. Contention guard PASSED on every run (`capMisses 10`).

**The decision: the observer effect is negligible.**

| | forward order | reverse order |
|---|---|---|
| p50 fps OFF | 66.9 | 67.6 |
| p50 fps ON | 66.6 | 67.8 |
| Δ | −0.4% | **+0.3%** |
| Δ`capMisses` | **0** (10 → 10) | **0** (10 → 10) |

The sign of Δfps **flips between orders**, which is what makes it noise rather than a small effect: an
instrument that cost 0.4% would cost it in both orders. Both arms of both pairs ran fully `wc-hw` at
`wcProvider 100%`, so this is a comparison between two runs of the same subsystem.

***V*_capMisses = 0, measured across all eight arms** — every arm read exactly `capMisses 10`, `created 11`,
`blindSplits 1`. `capMisses` is **deterministic on this fixture**, so the strict Δ = 0 bar declared in §4.1
is kept rather than relaxed. That is the stronger outcome, and it makes every later contention comparison
in this programme sharper.

**What is NOT usable, and why it is a finding rather than a defeat.** *V*_fps could not be established:
identical off-arms differ by **55–125%**, and the difference is **bistable** — one arm runs clean at ~67fps
while the other sits at ~30fps, and *which* arm degrades alternates between runs. The degraded arm is
always identifiable from its routing, never from its fps: `decode wc-hw/element`, `wcProvider 60–66%`,
`stale 53–56%`, and `unmet 1`.

The cause is **ADR-013 §1's motivating defect, observed directly**: six sources compete for four slots with
no arbitration among `playhead` leases, so which sources hold WebCodecs sessions is decided by arrival and
varies run to run. The losers fall to the `<video>` element path, and the sampled source's fps depends
entirely on whether it won its lottery that run. This is the concrete form of *"the fourth arrival loses
because it arrived fourth"* — and it means **fps is not a valid comparand on a contended fixture until the
Acquisition Scheduler exists.** M0's verdict rests on `capMisses`, which was the load-bearing comparand by
design (§4.1) and is unaffected.

This also retires the earlier `V_fps ≥ 14.5%` observation: it was never machine variance. It was the same
routing lottery on a smaller fixture, and it is now explained rather than outstanding.

**Two arm-only differences, confirmed as telemetry and not behaviour.** The ON arm additionally reports
`grants 3 (no-incumbent-demand 3)` and `degrade substituted ~1010`. Both counters live *inside* the
diagnostics guard and read 0 with it off — the same shape as `admissionDenials` (§1.2). They are the
instrument reporting, not the runtime diverging: `capMisses`, `created`, `shared`, `blindSplits`,
`sessions open`, `orphaned` and `unmet` are byte-identical across the pair. This is precisely why the
decision rule was written against the unconditional counter.

**Harness findings recorded, not acted on.**

1. `awaitWebCodecsEngaged` tests `values.some(mode => mode !== "element")` — **one** engaged source
   satisfies it. On a six-source fixture "engaged" can mean 1/6, which is why a per-arm gate reported
   `engaged` for an arm that then sampled at `wcProvider 66%`. It is a shared helper that
   `source-admission-probe` also depends on, so its semantics were **not** changed mid-measurement.
   Strengthening it to a fraction is **harness slice H1**, and it must land before any later stage whose
   precondition depends on multi-source engagement — M3's proxy arms and M7's budget frontier both do.

**What actually established the WebCodecs precondition for M0, since the helper cannot.** The verdict
does not rest on `awaitWebCodecsEngaged`, and saying otherwise would rest it on an instrument disclosed
as weak in the same breath. It rests on the **independent reading in the report body**: both arms of
both accepted pairs ran `decode wc-hw` at **`wcProvider 100%`**, against `wcProvider 60–66%` and
`decode wc-hw/element` on every arm that was rejected. The routing was measured, not assumed.

> **Standing rule from here: `wcProvider %` is the precondition instrument.** `awaitWebCodecsEngaged` is
> a liveness check — it answers "has anything started", never "is this arm comparable". Any arm whose
> `wcProvider` is below 100% on a fixture whose sources should all be decoding is not comparable to one
> at 100%, whatever the helper returned.
2. The per-arm precondition wait added during this measurement (`reopenWithFlags` settles 6s; an ingest
   proxy lands in ~10s) is correct and retained, but it did **not** remove the swing — the swing was the
   session lottery, not cold start. Recorded because a fix that does not fix the symptom is exactly the
   kind of thing that gets misremembered as having worked.

**`orphaned` is 0 at rest in all eight arms.** The `orphaned 1` seen in the pre-hold run did not reproduce
on the fixed runtime; it is closed, not carried.

### 4.2 The reverse dependency: Stages 1 and 3 are conditional on K = 4

The cheap-first argument runs in one direction. The dependency runs in both, and the return direction is
the one that can void spent runs.

**Contention statistics are definitionally a function of K.** Intra-class denial share (M5),
contention-burst duration (M4), contended-decision counts (M1) and everything M8 derives from M4 are all
measured against the shipped `MAX_WC_TOTAL_SESSIONS = 4`. M7's own falsifier explicitly entertains that
this default is already past the frontier — in which case *part of the observed contention is
self-inflicted*, and the Stage-1 corpus measured a scarcity that a cap correction removes.

P6 applies without softening: acceptance evidence does not transfer across a configuration change, and
§1's table says so even for numbers *believed* unrelated to K. These are not believed unrelated.

**The position taken, stated so nobody has to discover it while writing the programme:**

> **Every Stage 1 and Stage 3 result is recorded with the qualifier `@K=4`, and is provisional until M7
> confirms K = 4.** The qualifier is written into the result record itself, not into a covering note.

And the contingency is budgeted rather than discovered:

| Stage | Fires when | Cost |
|---|---|---|
| **7 (contingent)** | M7 concludes K ≠ 4 | Re-run the Stage-1 corpus at the confirmed K, and re-derive M8 from the new M4. M2 and M1b are unaffected — both are offline over recorded vectors and neither reads a contention rate. |

If Stage 7 fires, the K=4 results are **retained, not discarded**: the pair is the evidence for how much
of the measured contention was self-inflicted, which is a finding the programme wants and which a single
run at the corrected K could not produce.

**What this does not license.** Planning the programme against `@K=4` numbers while M7 is outstanding.
§6's exit criterion requires all eight answered; M7 is one of the eight, and this section only fixes how
the other results are labelled while it is pending.

---

## 5. Void-run classes

Restated as a checklist because each of these has already cost between 30 minutes and 2 hours:

1. SwiftShader instead of Chrome (P1) — races do not reproduce; the run measured a different machine.
2. WebCodecs never engaged (P2) — the run measured the element path and called it decode.
3. Flag changed mid-session — flags are read once at load; changing one means a reload.
4. Two runs concurrent (P3) — each was the other's contention.
5. Development bundle (P4) — the build was not the build.
6. Instrument enabled in one arm and not another — the observer effect became the finding.

And the standing one from the completion report, which is not a run-validity rule but a reasoning rule:
**count the reasons; never infer which branch fired.** Every instrument in §2 carries a discriminator
that names the path — `tieBroken`, transport state, purpose class — for exactly this reason. Two
sessions were lost to plausible-but-unsupported inference, and the S4.7 fix was found only once a
discriminator existed.

---

## 6. Exit criterion — when the programme may be planned

The ADR-013 implementation programme may be written when **all eight questions have either a measured
answer or a recorded, justified deferral**, and specifically:

1. every measurement in §3 has run under §1's preconditions, or is explicitly deferred with the reason;
2. each result is recorded against its **pre-registered** decision rule — including the ones that landed
   in an "inconclusive" band, which are findings and not failures;
3. every falsifier that fired has an ADR-013 amendment drafted **before** any slice depends on the
   clause it falsifies. §3.3's partial-order outcome and §3.6a's zero-lead outcome are the two most
   likely, and both change a normative clause;
4. the baseline for the later programme's regressions — `__rfWcPool`, `__rfKernelState`,
   `__rfKernel.summary()`, fps, and the pressure series — is captured on a clean tree and committed, so
   that "acceptance evidence does not transfer" has something to transfer *from*;
5. **M7 has confirmed K**, or Stage 7 has fired and the Stage-1 corpus has been re-run at the corrected
   value (§4.2). Planning against `@K=4` numbers while M7 is outstanding is not permitted;
6. **M0's observer bound is recorded** (§4.1) — negligible, or carried as a stated magnitude on every
   Stage-1 number;
7. the two runtime findings this design turned up while reading the code — **C1**, the §6.11 aging term
   being structurally inert on the live admission path, and **C2**, `deniedForMs` conflating incumbent
   residency with denial duration and mislabelling displaced incumbents `permanently-denied` — are
   recorded as programme inputs with their code references. Neither is fixed during Phase 0: changing a
   predicate mid-measurement is rule 4 inverted.

Until then, the slice catalogue does not exist, and the correct answer to "what are the slices" is that
the numbers that would decide them have not been collected.

---

## 7. Named failure modes to watch during Phase 0 itself

ADR-013 names three ways the design degrades. Phase 0 can begin any of them before a line of the
subsystem is written, so each has a Phase 0 tripwire:

| Failure mode | How it starts in Phase 0 | Tripwire |
|---|---|---|
| **God scheduler** | An instrument records something with no meaningful rank, and the recording normalises it as scheduler-adjacent | Every `admission.scored` entry must carry a real rank. An unrankable subject in that ring is the subsystem reporting the work does not belong to it (§0.3). |
| **Governor as second scheduler** | M4/M8 produce a cadence that is "just a few frames", and a few frames is a schedule | M8's lower bound is derived from burst duration, not from convenience. An empty band is reported as an empty band. |
| **Reservation as partition** | M6 produces a window so long the reserve is never released | Every proposed window is checked against I-50: unclaimed at expiry it must be released and reported as waste. A window with no measured expiry event in the run has not been shown to expire. |

---

## 8. Carried debt (not actioned)

`plans/adr-012-phase3-soak.md` §Ownership records an outstanding edit: the five soak rules must be
mirrored into `plans/adr-012-implementation-programme.md`, restating R2 as a **soak** rule rather than a
release-hygiene one, and cross-referencing the playbook so the two cannot diverge.

**Not done in this session.** `plans/adr-012-implementation-programme.md` currently carries another
session's uncommitted modifications (`git status --short` shows it as ` M`). It has been neither edited
nor staged. The debt is carried forward and should be picked up when that file is clean.

**Second carried mirror, added 2026-08-05.** P7 and P8 above are measurement rules and belong in the
programme doc's measurement-rules section, not only here — every future session that compares two arms
on a contended fixture will otherwise re-derive P7 at the cost of a void run, which is exactly what the
five soak rules were mirrored to prevent. The authoritative statement is **DEBT-011** in
`project-tracker/architectural-debt.md`, which carries the numbers and the scheduler's acceptance
criterion. Mirror both alongside the soak rules when the programme file is clean, and cross-reference
DEBT-011 rather than restating the numbers, so the two cannot diverge.

**Harness slice H1, booked.** Strengthen `awaitWebCodecsEngaged` from `.some()` to a declared fraction of
declared sources. Must land **before M3 and M7**, whose preconditions depend on multi-source engagement.
Not done during a measurement: changing a shared helper's semantics mid-measurement is ADR-012's fourth
learning inverted, and `source-admission-probe` depends on the current behaviour.
