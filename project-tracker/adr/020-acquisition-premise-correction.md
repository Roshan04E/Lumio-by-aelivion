# ADR-020 — Acquisition premise correction: the runtime lacks the behaviours ADR-013's knobs describe

- Status: **Accepted** (normative; **amends ADR-013**, supersedes nothing)
- Date drafted: 2026-08-06
- Date accepted: 2026-08-06
- Governed by: `FLAREX_IMPLEMENTATION_GOVERNANCE.md`

```
Amends:  ADR-013 §9 (open questions), §1 (context), §4.4 (reservations)
Depends on: ADR-012 (the constitution), ADR-013 (media acquisition scheduling)
Supersedes: nothing — ADR-013's two subsystems, four contracts and fifteen invariants all stand
Evidence base: plans/adr-013-phase0-measurement.md (Phase 0, 2026-08-04 → 2026-08-06)
Related debt: DEBT-011, DEBT-012, DEBT-013
```

---

## 0. Why this exists

ADR-013 §9 left eight magnitudes open and forbade planning the implementation programme until they were
answered. Phase 0 was built to answer them. **It did not, and the reason is the finding.**

> **ADR-013 was specified to size a scheduler's knobs. Measurement says the runtime does not have the
> behaviours those knobs describe.**

Four of the nine open magnitudes (eight, plus OQ9 registered mid-programme) turned out to be unaskable in
their current form — not unmeasured, but **ill-posed against the runtime that exists**. One mechanism
finding outranks all nine and is promoted here to ADR-013's primary motivating defect.

This amendment records the premise correction, restates the motivating defect, dispositions the question
set with the run that closed each, and names the one genuinely open design question that remains. It
proposes slices; it writes none.

---

## 1. The premise correction

ADR-013 §1 describes a runtime under **sustained contention**, where ranking, aging, hysteresis and
reservation windows arbitrate an ongoing competition. Every open magnitude in §9 is a duration or a
weight for damping that competition.

**Measured, twice, on two purpose-built fixtures:**

| Fixture | Samples | `capMisses` movement |
|---|---|---|
| steady-state playback, 6 sources / 4 slots | 74 over 20s | **0** |
| scripted seeks, scrubs and long jumps, 6 sources / 4 slots | 115 over 30s | **0** |

All contention occurs in the **mount storm** — a transient at composition load — and none of it recurs.
The second fixture was built specifically to find playback-time contention and found none, which is the
stronger of the two results: it is a negative from an instrument designed to produce the positive.

> **Correction to ADR-013 §1: contention in this runtime is a mount-storm transient, not steady-state
> pressure.**

Everything downstream inherits it. A hysteresis constant damps excursions; there are none. A reservation
window protects a frame from a competitor claiming capacity later; nothing claims capacity later. A
fairness term lifts a starved source over time; there is no later decision for it to be lifted into.

---

## 2. The primary motivating defect — ADR-012 §6.11's third outcome, in shipped code

ADR-013's motivating defect was stated as *four `playhead` leases with no arbitration between them*.
That is true and remains true. It is also **not the harm**. The harm is what happens after.

Two independently measured facts compose:

1. **The §6.11 aging term is structurally inert on the live admission path.** Every incumbent is pushed
   with `admittedAtMs` set, and `rankAdmission` applies aging only when that is null; the sole
   null-valued candidate is the newcomer, whose `firstRequestedAtMs` is `now`. **Every aging term in
   every live contended decision is exactly zero.** Asserted continuously by the instrument (`C1`), held
   across three runs.
2. **There are no admission decisions after the mount storm.** Sessions are retained across seeks, so
   the winners keep their slots and the losers never re-enter a ranking. Measured: 6 decisions at mount,
   **0 across 30s of aggressive transport.**

Therefore:

> **A source that loses the mount-storm lottery has no mechanism by which it can ever be admitted.**
> It does not age into contention — aging never fires. It is not re-ranked — no further decision occurs.
> It is not declared permanently denied — that terminal is reached through `deniedForMs`, which for such
> a candidate never accumulates. It stays on the `<video>` element path for the lifetime of the session,
> silently.

ADR-012 §6.11 offers exactly two acceptable ends for a persistently low-ranked source: **it receives a
session, or it is declared permanently denied.** Neither occurs. The third outcome — waiting forever,
which the invariant was written to forbid — is the one the runtime produces.

**This is user-visible.** On a six-source comp against a four-slot budget, two sources decode through the
element path for the whole session: measurably different playback, reported by nothing. It is registered
as **DEBT-013** and raised as a defect in its own right, not merely as an ADR note.

**ADR-013 §1's context section is amended** to state this as the motivating defect. The arbitration gap
is its cause; the permanent unadmittability is its consequence, and the consequence is what a user
experiences.

---

## 3. Disposition of the question set

Each closure names the run that produced it. Full detail in `plans/adr-013-phase0-measurement.md`.

| OQ | Disposition | Closed by |
|---|---|---|
| **1** rank weights | **SUPERSEDED on path B.** Rank decided 0/8 then 0/6 contended decisions; residency decided 100%. Underneath that, merit for Flarex virtual sources is a **manufactured constant** — `collectFlarexVirtualLayers` stamps an identity transform, so every such source scores exactly 1.0 and rank cannot discriminate by construction. Well-posed on timeline clips, where the path propagates faithfully. | Stage 1 corpus run; `residency:falsify` (VOID, and the void was the answer); `contribution:scope` 9/9 |
| **2** lag tolerance | **OPEN — the only surviving magnitude.** Offline, pixel-based, reads no contention counter. Unaffected by the premise correction. | — (M2, not yet run) |
| **3** L4 vs L3 ordering | **OPEN · PROCEDURE BROKEN.** The question stands; its comparand was fps, which DEBT-011 forbids on a contended fixture. Needs re-specification to decode-ms and sessions-consumed. | M0, DEBT-011 |
| **4** Governor hysteresis | **CLOSED — ill-posed.** Asks how long to damp a signal with no excursions to damp. | playback-contention fixture: 115 samples, `capMisses` +0 |
| **5** reservation granularity | **PREMATURE, not blocked.** C15 now carries purpose faithfully; the workload has one class. Every acquisition through the decode pool is `live` — proxy builds go through `sourceProxy.worker.ts` and never touch it. Re-open when a background acquirer shares the pool: a runtime change, not a corpus one. | C15 threading + purpose-diversity guard |
| **6** reservation window + floor | **REWRITTEN.** A reserve must protect against the storm, not the steady state. Collapses substantially into OQ9. | premise correction |
| **7** budget K | **OPEN · STRENGTHENED.** K decides who gets WebCodecs at all — `wcProvider 4/6` — and by §2 that assignment is permanent for the session. Comparand becomes routing determinism, not fps. | Stage 1, DEBT-011 |
| **8** Governor cadence | **CLOSED — inherits OQ4.** A cadence bounds a reaction to sustained pressure; there is none. | same run as OQ4 |
| **9** residency ÷ mount-storm duration | **OPEN · PROMOTED.** Registered mid-programme; it is the quantity that decided every contended admission measured. Residency was specified to *damp* oscillation and instead *decides* the outcome, because the contention finishes before the 1000ms window expires — and re-arms on every re-acquisition. | Stage 1; `residency:falsify` F1 |

**Net: two closed as ill-posed, one premature, one superseded on one path, one rewritten, four open** —
of which only OQ2 is runnable exactly as written.

---

## 4. The one open design question: where acceptance can be measured

ADR-013 does not state how its scheduler is accepted. Phase 0 supplied the criterion and then constrained
where it can be applied, and the pair belongs here rather than in another measurement.

**The criterion** (established at Phase 0 checkpoint 1, recorded in DEBT-011). The defect is
non-determinism of routing under contention, so the test is **convergence, not speed**:

> Identical arms on the same contended fixture must resolve to the **same routing**, run to run.
> `wcProvider %`, `stale %` and `unmet` are the instruments. **A faster p50 with the lottery still
> running is not a pass.**

Frame rate is explicitly excluded: identical arms differ 55–125%, bistable, with the degraded arm
alternating between runs, because arrival order decides who holds a session (DEBT-011, P7).

**The constraint, and it is new.** Contention exists only at mount, so **a playback-time convergence test
has nothing to observe.** The criterion is unchanged; the moment it can be evaluated is not:

- **Acceptance is measured across mounts**, not within a session — repeated composition loads, comparing
  the resulting routing assignment for stability.
- **A second criterion is required and did not exist before §2 was measured:** that a source which loses
  the initial assignment can subsequently gain one. Convergence alone is satisfiable by a scheduler that
  deterministically starves the same two sources every run, which is DEBT-013 made reproducible rather
  than fixed.

Stated as the acceptance pair:

> **(a) Routing assignment is stable across repeated mounts of the same composition, and
> (b) a source denied at mount is either subsequently admitted or explicitly declared denied.**
> Neither alone is sufficient. (a) without (b) is deterministic starvation; (b) without (a) is the
> current lottery with a recovery path bolted on.

This is the one genuinely open design question ADR-013 does not answer, and it is design work, not
measurement.

---

## 5. Slices proposed, none written

Sequenced. No code has moved; `MIN_RESIDENCY_MS` is untouched.

| # | Slice | Why it is where it is |
|---|---|---|
| **A** | **§6.11 recovery** — a denied source must reach one of §6.11's two ends. Requires an admission decision to exist after mount, or a denial that ages toward the declared terminal. | DEBT-013. The user-visible defect, and the only item here that changes what a user sees. |
| **B** | **F2 — virtual-source contribution.** `collectFlarexVirtualLayers` should derive contribution from the node's role in the comp instead of stamping identity. | Bounded to one collection path (`contribution:scope`). Blocks M1b and every weighting question on path B; blocks nothing on timeline clips. |
| **C** | **H1 — harness.** `awaitWebCodecsEngaged` tests `.some(mode !== "element")`, so one engaged source of six satisfies it. Strengthen to a declared fraction. | Must precede any stage whose precondition depends on multi-source engagement (M3, M7). |

**Deliberately not proposed: tuning `MIN_RESIDENCY_MS`.** It is the tempting one-liner, and OQ9 is
unsized. Shortening the window without an answer to *residency ÷ storm duration* trades a measured defect
for an unmeasured one.

---

## 6. What does not change

ADR-013's structure survives the correction intact, and this is worth stating because the premise
correction is large enough to invite a rewrite:

- **Both subsystems stand.** The mechanism/policy split is unaffected — the Governor's problem is that its
  input signal has no excursions on this runtime, not that the subsystem is wrong.
- **All four contracts stand.** C15 gained a purpose class by *addition*; C16–C18 were not touched. §5.2's
  claim that the contracts survive non-decode acquisition is untested but unchallenged.
- **All fifteen invariants stand.** I-48 is satisfied in letter and defeated in substance *for the
  virtual-source class only* — a scoped defect (slice B), not an invariant to amend.
- **§0.3's membership test stands.** Criterion 2 fails for the Flarex virtual-source class because its
  rank input is fabricated upstream. That is the drift the clause predicts, arriving one layer higher
  than expected, and the clause is what made it visible.

What changes is **§9's framing**: the programme was specified as a tuning exercise over an existing
competition, and it is a repair of behaviours the competition assumes.

---

## 7. Evidence index

| Commit | What it established |
|---|---|
| `562c029` | Stage 0 instrument (`admission.scored`), C1/C2 as assertions rather than code reads |
| `3c6cdea` | Fixture-gate discriminator; contention vacuity guard |
| `8eaea20` | M0: observer effect negligible (Δ sign flips between orders); *V*`capMisses` = 0 over 8 arms |
| `5d3708b` | DEBT-011; preconditions P7 (fps not a comparand) and P8 (`wcProvider %` is the instrument) |
| `82493e9` | Stage 1: residency decided 8/8; the M1 rule was defective and was amended in place |
| `fed62e3` | Question-set re-read; OQ9 registered; F2 and F1 from the falsifiability check |
| `b326137` | `contribution:scope` 9/9 — F2 bounded to one path; DEBT-012 meta-class |
| `3531972` | C15 purpose class, recorded-never-ranked (27/27); OQ5 premature |
| `479f875` | Playback contention does not exist; the mount-storm loser can never be admitted |

**Three guards fired on real runs and each prevented a wrong conclusion:** contention-possibility (stopped
a confident negative from a `wcProvider 0/1` fixture), corpus-variation, and purpose-diversity (stopped
"PER-SOURCE IS REQUIRED" being read off a fixture with one purpose class). They are retained.

---

*This amendment corrects ADR-013's premise and restates its motivating defect. It adds no subsystem, no
contract and no invariant, and it removes none.*
