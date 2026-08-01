# Flarex Implementation Governance

- Status: **Active** (2026-08-01) — binding on every PR that touches Flarex runtime code
- Constitution: `project-tracker/adr/012-flarex-runtime-kernel.md`
- Route: `plans/adr-012-implementation-programme.md`
- Evidence base: `FLAREX_RUNTIME_AUDIT.md`, `FLAREX_OWNERSHIP_REVIEW.md`

---

## Purpose

ADR-012 is the constitution. The implementation programme is the route. **This document is the guardrail.**

A multi-month migration touching every runtime subsystem has one dominant failure mode, and it is not any individual slice going wrong. It is **drift**: a hundred locally-reasonable decisions that each look fine in review and collectively rebuild the architecture the migration exists to replace. The previous runtime was not built badly. It was built one reasonable decision at a time, with nobody holding the whole shape.

This document holds the shape.

**Standing rule**: when a reviewer and an implementer disagree, ADR-012 Part 12 decides. If Part 12 does not cover the case, the change requires an architectural review — not a judgement call.

---

## 1. Architecture Freeze

Every subsystem below has a **frozen architectural responsibility**. Implementation may change the code freely. It may not change who owns what, what a subsystem is allowed to know, or what it is allowed to touch — **without a new ADR**.

The distinction that matters: *frozen architecture ≠ frozen code*. Rewriting a function is ordinary work. Moving a responsibility is a constitutional amendment.

### Tier A — Preserved verbatim (code and architecture both frozen)

These are the systems the audits found correct. They are the reason the migration is tractable. Changes require an ADR **and** a green pixel gate.

| Subsystem | Frozen responsibility | Why untouchable |
|---|---|---|
| **Lowering compiler** (`compile-flarex.ts` body) | pure, total, deterministic translation of evaluated values → `SceneDraw` | ADR-007 parity-by-construction; the product contract |
| **SceneDraw model** | the single renderer contract | all three renderers agree *because* of it |
| **Draw construction** (`build-scene-draws.ts`) | per-layer draw assembly shared by preview, export, worker | same |
| **Wrap-collapser** | folding consecutive ops into one shell | what makes grade chains viable on integrated GPUs |
| **Affine retime model** (`time-transform.ts`) | static resolution of the media half of TimeSpeed | ADR-011; sound — only its threading was broken |
| **Compositor rasterization** (`scene-compositor.ts` render path) | turning a `SceneFrameSpec` into pixels | proven; the RTT depth-pool handoff is the reference ownership model |
| **Node-blind evaluator machinery** (content hashing, cost estimation) | ADR-010 compliance | hard-won; must not accrete node knowledge |

**The single authorised exception**: slice **S6.1** may change signatures inside the lowering body to thread `EvaluationContext`. Structural only — no lowering logic may change, and the pixel gate must stay byte-identical on non-retimed fixtures.

### Tier B — Frozen architecture, code to be written

Responsibilities are fixed by ADR-012 Part 3. Implementation is open. Adding a responsibility to one of these, or moving one between them, requires an ADR.

| Subsystem | Owns | Must never |
|---|---|---|
| **Runtime Kernel** | all runtime responsibility; hosts the subsystems below | import a UI framework, DOM, or rendering API |
| **Transport** | the authoritative time | gate on render completion |
| **Playback Clock** | derivation and labelling of every time value | be bypassed — no subsystem holds an unlabelled time |
| **Frame Scheduler** | frame identity, purpose, deadline, cancellation, termination | let work begin without a `FrameRequest` |
| **Evaluation Scheduler** | the plan: what to evaluate, in what order, within what budget | under-approximate the dirty set |
| **Dependency Tracker / Dirty Propagation** | declared dependencies, forward closure | invalidate globally |
| **Node Evaluator** | traversal, node results, evaluation records | contain a node-type branch; read a clock; request media |
| **Evaluation Context** | the immutable context an evaluation runs under | be ambient, mutable, or inferred |
| **Media Manager** | source declaration and ranking | let a rendering decision change whether a source *exists* |
| **Source Admission** | grants under budget, with hysteresis | resolve scarcity by substitution |
| **Decoder Manager** | session lifetime | create or destroy a session as a side effect of anything outside itself |
| **Readiness Barrier** | `effectiveTime` and the degraded set | return a boolean |
| **Materialization Manager** | the materialize decision and artifact identity | inspect node type; wrap instead of tag |
| **Evaluation Cache** | **validity** | pin memory |
| **Artifact Cache** | **residency** | judge validity |
| **Resource Manager** | every runtime resource, one budget, wall-clock aging | let anything else allocate or free |
| **Presentation Scheduler / Barrier** | present cadence and permission | reason about source staleness |
| **Renderer Interface** | the backend contract | know the graph |
| **Export / Thumbnail Interfaces** | purpose-scoped frame production | consume proxies (export) or touch live scopes (thumbnail) |
| **Diagnostics** | the single record, one identity namespace | perturb the measured path |

### Tier C — Being dismantled

Architecture is frozen as a **destination**; code is in flux. Adding a responsibility to these is a regression by definition.

| Component | Destination |
|---|---|
| `ScenePreviewCanvas` | a canvas surface — no scheduling, readiness, resources or capture |
| `VideoPreview` | layout and view only — no source declaration, no decoder lifetime |
| `useFlarexCompProxies` | split three ways: governor (eligibility), media manager (source), decoder manager (decode) |
| `preview-frame-pool` | mechanism retained; **ownership** moves to Decoder Manager under one budget |

---

## 2. Change Control

Four levels. The level is determined by **what the change touches**, not by its size. A one-line change can require an ADR; a thousand-line refactor may need only ordinary review.

### Level 1 — Ordinary PR review (one reviewer)

Code within a subsystem that changes no responsibility, no output, and no invariant.

*Examples*: implementing a slice exactly as specified · renaming internals · adding diagnostics fields · extending a test · performance work with identical output · fixing a bug inside one subsystem's boundary.

### Level 2 — Architectural review (two reviewers, one must be the runtime owner)

Anything touching a boundary, a budget, a scope, or a Tier A system.

*Examples*: any change to a Tier A file (including S6.1's authorised threading) · adding a field to `SceneDraw`, `SceneTextureSource`, or a cross-subsystem contract · changing a resource scope, budget, or eviction policy · adding a flag · changing a slice's specified approach · anything that alters frame timing · **any PR that spans two subsystems**.

*Required in the PR*: which ADR-012 Part 4 contract is affected, and why the change respects it.

### Level 3 — New ADR

Any change to an architectural responsibility, or to ADR-012 itself.

*Examples*: moving a responsibility between subsystems · giving a subsystem knowledge it is forbidden (a renderer learning the graph, an evaluator learning node types) · adding a new evaluator question (reopens ADR-010's closed set — a deliberate, visible event) · changing a Part 12 invariant · adding a new subsystem · changing the freeze status of a Tier A system.

*Process*: numbered successor ADR naming the amended clauses explicitly, as ADR-012 §0.3/§0.4/§0.5 name theirs. Never rewrite an accepted ADR (`project-tracker/adr/README.md`).

### Level 4 — Product decision

Anything that changes what a user sees, delivers, or can do — where the correct answer is not derivable from architecture.

*Examples*: the playback lag budget's magnitude (Open Item 1) · export-vs-live priority if background export becomes primary · whether a degraded state is surfaced as a badge, a warning, or silently in diagnostics · **any change to delivered export output**, including a correct one.

*Precedent*: the View Dot decision (ADR-012 §0.5) was a product decision, not an architectural one. Architecture identified the violation; product decided the resolution.

**Escalation rule**: if you cannot tell which level applies, it is Level 2. Reviewers may escalate; implementers may not de-escalate.

---

## 3. Implementation Rules

Every runtime PR must satisfy all of these. A PR that cannot is not ready.

### R1 — One slice, one PR
A PR implements exactly one slice, or one clearly-scoped part of one. The PR title carries the slice ID.

### R2 — Reference the specification
The PR description states: **slice ID** · **ADR-012 sections implemented** · **Part 12 invariants newly satisfied** · **invariants temporarily violated** (with the paired slice that resolves them).

### R3 — No drive-by refactors
Unrelated improvements go in a separate PR, even obvious ones. This rule is load-bearing: drift is made of individually-defensible drive-bys.

**Corollary — the standing repo directive applies**: if you find shipped code that looks wrong but is outside your slice, **do not silently fix it**. Raise it, get agreement, file it. Silent fixes to already-shipped behaviour are how the previous runtime accumulated its unexplained special cases.

### R4 — Preserve existing invariants
No PR may regress a previously-satisfied Part 12 invariant. The conformance suite enforces this mechanically (§7).

### R5 — Add conformance tests
A PR that satisfies a new invariant adds its permanent test in the same PR. An invariant without a test is not satisfied.

### R6 — Pixel gate
`render:compare:pixels` must be byte-identical, **or** the PR states which fixture changed, by how much, and why it is correct. Only **S4.5** has pre-authorised justification for a non-zero diff.

### R7 — Flag discipline
Behavioural slices land behind their specified flag, default off, with the old path intact. Flags are strictly ordered — a later flag requires its predecessors, asserted at startup. The three atomic slices (S1.2, S5.2, S6.1) and the trio (S4.4+S4.5+S4.6) ship without flags or under one exclusive flag, never partially.

### R8 — Debt is registered
Any temporary compromise gets a register entry in the same PR (§6). Undocumented debt is a merge blocker.

### R9 — Diagnostics survive
A PR that removes or relocates a code path must carry its diagnostics across. Losing observability is a regression (§4).

### R10 — Stage by explicit path
Never `git add -A` or `git add <directory>`. Stage explicit paths and audit `git status --short` before committing. Parallel sessions work in this repo and a broad add has already swept unrelated work into a commit once.

### R11 — Typecheck is the lint step
`pnpm --filter @orreris/web typecheck` and `pnpm --filter @orreris/worker typecheck` both green. There is no eslint.

### R12 — Update the trackers
Shipping or deferring something updates `architecture.md`. Recurring problem/solution knowledge appends to `project-tracker/` (append-only, versioned — never rewrite).

### PR header template

```
Slice:        S4.3 — Source Admission
ADR-012:      Part 3.10, Part 4 C6, Part 6.3
Satisfies:    (none yet — precondition for I-27)
Violates:     I-27 until S4.5 (paired, same release)
Flag:         kernel.admission (default off)
Pixel gate:   byte-identical
Debt:         DEBT-014 (ranking heuristic provisional)
```

---

## 4. Definition of Architectural Regression

A regression is **not** a bug. A bug produces a wrong result. A regression moves the architecture back toward the shape ADR-012 exists to replace — and it can pass every test.

**Any of the following is a regression and blocks merge, regardless of whether anything is broken.**

| # | Regression | Detection signal |
|---|---|---|
| **G1** | **Ownership moves into React** — runtime state in a ref, hook, memo, or component lifetime | a `useRef`/`useMemo`/`useState` holding a resource, session, cache, or schedule |
| **G2** | **Ambient state** — anything read implicitly rather than passed: module-level mutable state, a cursor, a singleton the kernel reads | mutable module scope in kernel or lowering code |
| **G3** | **The renderer decides correctness** — a rasterizer or presentation surface choosing what is right rather than what to draw | correctness logic below the SceneDraw boundary |
| **G4** | **A cache changes pixels** — a hit differing from a miss, on any renderer | conformance test asserting hit ≡ miss on all three |
| **G5** | **Duplicated responsibility** — a second implementation of readiness, scheduling, budgeting, or time derivation | two answers to one question |
| **G6** | **Hidden state transition** — a state reachable but not named or observable | a condition inferred from absence rather than a declared state |
| **G7** | **Presentation controls resource lifetime** — reclamation, allocation, or session lifetime gated on a present | a prune, dispose, or acquire behind a present-path branch |
| **G8** | **Substitution on scarcity** — unavailable resource resolved with different content | any fallback that yields pixels from another source |
| **G9** | **Policy in the lowering layer** — a decision, a clock read, an allocation, or a failure mode inside pure lowering | Tier A file gaining a branch on anything other than its inputs |
| **G10** | **Silent failure** — communicating failure by returning nothing | a `null` return that is not a described failure |
| **G11** | **Unlabelled time** — a time value held without provenance | a raw number crossing a subsystem boundary as a time |
| **G12** | **Graph learns runtime state**, or **runtime writes the graph** | a persisted field read by the kernel; any kernel write path to the document |
| **G13** | **Scratch touches live** — a thumbnail, capture, or analysis frame reaching live caches, pools, or version counters | shared pool access outside a purpose scope |
| **G14** | **Diagnostics lost** — a code path relocated without its observability | a degradation that no longer appears in the sink |
| **G15** | **Evaluator learns node types** — a node-type branch in kernel code | ADR-010 violation; `switch` on node type outside lowering |

**G1, G7 and G8 are the three that produced the current runtime.** Reviewers should weight them accordingly.

---

## 5. Review Checklist

Run before merging **any** runtime PR. Not all questions apply to every PR; every question must be *considered*.

### Ownership
- [ ] Which subsystem owns the responsibility this PR touches? Is it the one ADR-012 Part 3 assigns?
- [ ] Does this introduce a *new* responsibility? If so, who owns it, and is that recorded?
- [ ] Is any responsibility now owned by two things?
- [ ] Does any React construct hold runtime state? *(G1)*
- [ ] Does anything allocate or free a resource other than the Resource Manager? *(G7)*

### Determinism and evaluation
- [ ] Is evaluation still deterministic over `(graph, context, inputs)`?
- [ ] Is evaluation ordering still a function of graph structure alone?
- [ ] Is any new state ambient rather than passed? *(G2)*
- [ ] Does any kernel code branch on node type? *(G15)*

### Time
- [ ] Does every time value in this PR carry its provenance? *(G11)*
- [ ] Does evaluation read anything other than `effectiveTime`?
- [ ] Is evaluation time passed explicitly to every time-dependent read?

### Correctness boundaries
- [ ] Does this change exported pixels? If yes — is it a Level 4 product decision?
- [ ] Is `render:compare:pixels` byte-identical? If not, is the diff stated and justified?
- [ ] Could a cache hit differ from a miss, on **any** renderer? *(G4)*
- [ ] Does any performance or presentation policy change output? *(G3)*
- [ ] Does scarcity anywhere resolve to substituted content? *(G8)*

### State and failure
- [ ] Is every new state named and observable? *(G6)*
- [ ] Does any operation communicate failure by returning nothing? *(G10)*
- [ ] Is every new wait bounded, and is its expiry reported?
- [ ] Is every frame path still guaranteed to terminate?

### Scope and hygiene
- [ ] One slice only? Slice ID in the title? *(R1, R2)*
- [ ] Any drive-by refactor? *(R3)*
- [ ] Diagnostics preserved across relocated paths? *(G14)*
- [ ] Are new invariants tested, permanently? *(R5)*
- [ ] Is temporary debt registered with an expiry? *(R8)*
- [ ] Flag correct, default off, ordering asserted? *(R7)*
- [ ] Files staged explicitly, `git status --short` audited? *(R10)*

### The two questions that catch drift
- [ ] **If someone read only this diff, would they be able to tell which subsystem owns what?**
- [ ] **Does this PR make the next slice easier or harder?**

---

## 6. Architectural Debt Register

**Location**: `project-tracker/architectural-debt.md` — append-only, following the existing project-tracker convention.

**Rule: no undocumented debt.** A compromise without a register entry is a merge blocker. This is not bureaucracy — every unexplained special case in the current runtime was once an undocumented compromise that outlived its reason.

### Required fields

| Field | Meaning |
|---|---|
| **ID** | `DEBT-NNN`, monotonic, never reused |
| **Reason** | why the compromise was necessary — the constraint, not the symptom |
| **Invariant affected** | which Part 12 invariant is violated or partially satisfied |
| **Owner** | a named person accountable for retirement |
| **Expiry condition** | the *observable* condition that retires it — not a date |
| **Planned slice** | the slice ID that resolves it |
| **Tracking issue** | the issue link |
| **Detection** | how a reviewer notices this debt is being *extended* rather than paid |

### Expiry discipline

- Expiry is a **condition**, never a date. "When S4.5 lands" is valid; "Q4" is not.
- When the planned slice ships, the entry is either **retired** (with the PR that retired it) or **re-justified** with a new expiry condition and explicit sign-off. It may not silently persist.
- Debt whose planned slice has shipped without retirement is escalated to architectural review.
- **Debt may not be extended by a PR that is not paying it down.** Building on a compromise deepens it; the register's Detection field exists to catch that in review.

### Pre-registered debt

The programme knowingly creates these. They are registered at Phase start, not discovered later.

| ID | Debt | Invariant | Expires when |
|---|---|---|---|
| DEBT-001 | admission reports denials while the host-clip fallback still substitutes | I-27 | S4.5 ships (same release) |
| DEBT-002 | kernel owns state but presentation still gates reclamation | I-21 | S5.3 ships |
| DEBT-003 | resources accounted but not owned | I-8 | S5.2 ships |
| DEBT-004 | cache identity correct, no cross-frame records to exploit it | — (perf only) | S6.4 ships |
| DEBT-005 | settle-window backstop retained behind explicit completion | I-31 | S2.2 backstop stops firing in steady state |
| DEBT-006 | materialization threshold carried from the ADR-008-violating implementation | ADR-008 rule 2 | S6.3 re-derives it from measurement |

---

## 7. Conformance Policy

### The ratchet

**Every satisfied invariant becomes a permanent automated test, and the set of passing tests never shrinks.**

This is the mechanism that makes the migration irreversible. Architecture documents do not prevent drift; tests that fail on drift do.

### Suite

The ADR-012 Part 12 conformance suite is built on the S0.4 headless harness and follows the repo's standalone-script convention (assert, exit non-zero). It runs in CI on every PR touching runtime code.

### Test tiers

| Tier | Asserts | Example invariants |
|---|---|---|
| **Structural** | statically checkable properties | I-36 (no UI/DOM/GL import in kernel) · I-17 (no raw pointers in draws) · I-15 (no policy in lowering) |
| **Behavioural** | properties over synthetic scenarios | I-1 coherence · I-2 monotonicity · I-30 termination · I-31 bounded waits |
| **Differential** | equivalence across paths | I-21 hit ≡ miss **on all three renderers** · I-19 renderers consume the same draws · I-18 determinism under repetition |
| **Property** | invariants over randomised input | I-23 ordering from structure alone · dirty closure is a superset of actually-changed nodes |

### Rules

- **C1** An invariant is "satisfied" only when its test exists and passes. Prose claims do not count.
- **C2** A conformance test may never be disabled, skipped, or weakened. A failing conformance test is **reverted, not silenced**.
- **C3** Tests are added in the PR that satisfies the invariant — not in a follow-up.
- **C4** Differential tests must cover **all three renderers**. The audit found a cache live in the worker and dead in the browser; a preview-only test would not have caught it.
- **C5** The scoreboard — invariants satisfied / total (39) — is published per phase and only ever increases.
- **C6** Temporary violations under debt are marked `pending(DEBT-NNN)` in the suite, with the expiry condition asserted. When the debt retires, the test flips to enforced in the same PR.

### Scoreboard checkpoints

| Phase | Target |
|---|---|
| 0 | baseline established; harness reproduces ≥3 findings |
| 1 | I-20, I-26 |
| 2 | + I-30, I-32 |
| 3 | + I-36 (kernel), I-16 and I-24 substantially |
| 4 | + I-1, I-3, I-4, I-6, I-27, I-29, I-31, I-34 |
| 5 | + I-8, I-17, I-21, I-33 |
| 6 | + I-5, I-18, I-22, I-23 |
| 7 | **39 / 39** |

---

## 8. Success Criteria

### ADR-012 is **not** implemented when

- all 28 slices are merged;
- the kernel module exists;
- the code is "mostly moved over";
- performance improved;
- the reported symptoms stopped.

Every one of these is compatible with the architecture having drifted back. **Merging slices is activity, not completion.**

### ADR-012 **is** implemented when all seven hold simultaneously

1. **All 39 Part 12 invariants are satisfied**, each by a permanent passing conformance test.
2. **All conformance tests pass**, across all three renderers, with none disabled, skipped, or `pending`.
3. **No compatibility path remains** — one code path per responsibility; no old-path branches.
4. **No `kernel.*` flags remain** — every flag removed, not merely defaulted on.
5. **Runtime behaviour is independent of React** — the kernel drives a full frame, headless, with zero UI framework present, producing identical output to the browser path.
6. **Evaluation is renderer-independent and deterministic** — identical `(graph, context, inputs)` produces byte-identical output in preview, local export and worker.
7. **The architectural debt register is empty** of migration-era debt, or every remaining entry is explicitly re-justified and signed off.

### The standing test

Beyond the checklist, one question decides whether the migration achieved its purpose:

> **Can a new engineer, reading only ADR-012, correctly predict where any given responsibility lives in the code?**

If yes, the architecture is real. If no, the document describes a system that does not exist — and that is precisely the state the previous runtime was in, with three frozen ADRs specifying an evaluation engine that had never been built.
