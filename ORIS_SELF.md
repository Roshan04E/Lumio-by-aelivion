# ORIS Self-Representation — v0

> **What this file is:** the specification of `S`, the machine-readable structural model of
> what ORIS is made of, what it can do, how it is currently doing, and where it is known to
> be weak. This is **not** psychology, identity, or autobiography — those are
> [`ORIS_ARCHITECTURE.md`](ORIS_ARCHITECTURE.md) §4 and §10. This is the body schema.
>
> **Position in the calculus:** `S` is **sensed, not owned** — proprioception, exactly
> parallel to `W` (exteroception). It is read by `sense`, `simulate`, and `act`; it is
> written by the build and by measurement, never by cognition. See
> [`ORIS_CALCULUS.md`](ORIS_CALCULUS.md) §1.1, ORIS-14.
>
> **Status:** v0, 2026-08-02. Unusually cheap to build: **most of `S` already ships** as
> registries (§4). What is missing is unification and introspectability, not data.

---

## 1. The distinction that makes this subsystem coherent

ORIS_ARCHITECTURE.md §4 argues that a self-model which merely reads the code is "a mirror,
not a self" — it can never be surprised by itself, and self-surprise is where self-knowledge
comes from. That argument is correct and is *not* an argument against `S`. It is an argument
that `S` is a different object from the learned self-model, and the system needs both.

The distinction is the neuroscientific one between **body schema** and **self-concept**:

```
S  — STRUCTURAL SELF                    B[subject=self] — LEARNED SELF-MODEL
measured / declared                      inferred from behaviour
"the renderer depends on the GPU"        "I over-apply grades on first pass"
"HDR export is not implemented"          "I'm unreliable on OCR-heavy footage"
version-keyed; invalidated by build      evidence-backed; revisable; CAN BE WRONG
cannot surprise the system               must be able to surprise the system
band B0 (health) / B6 (structure)        bands B3–B5
```

> **ORIS-14: the structural self is measured, never believed.** Declared capabilities and
> limits live in `S`. *Discovered* limits live in `B[subject=self]` with evidence. The two
> must be reconcilable, and a persistent divergence between them is a **reportable finding**
> — in either direction (§5).

---

## 2. The four graphs of `S`

The review proposed five graphs. One of them — the competence graph — is not part of `S` at
all, and separating it is the main correction this document makes.

### 2.1 Structure graph — what I am made of

```
Subsystem { id, kind, version, owner_package, health_signals[], depends_on[] }

  renderer          ← GPU, decoder, compositor
  timeline          ← composition store, action registry
  flarex            ← evaluation engine, cache tiers
  perception        ← observer registry, scheduler
  cognition         ← planner stages, blueprint dialects
  storage           ← OPFS, fact store, psyche volume
```

Purpose: `act` and `simulate` need to know what exists before reasoning about what is
possible. Also the substrate for self-repair proposals — you cannot propose fixing what you
cannot name.

### 2.2 Capability graph — what I can do

```
Capability { id, domain, inputs[], outputs[], adapters[], maturity, eval_coverage }

  color.grade          browser · mature   · eval: 41 checks
  motion.apply         browser · mature   · eval: covered
  text.look            browser · mature   · eval: covered
  matte.person         mock|browser|cloud · partial
  export.hdr           —                  · ABSENT (declared limit)
```

**This is the largest already-shipped piece of `S`.** `capability-index.ts`, the tools/
skills/effects registries, and the adapter matrix are a capability graph that the system
does not currently read *about itself*.

### 2.3 Dependency graph — what breaks what

```
renderer   → GPU · decoder
timeline   → world model · action registry
cognition  → world model · capability registry · blueprint dialects
flarex     → renderer · cache tiers · decode scheduler
```

Purpose: failure attribution and honest decline. When the decoder is starved, the system
should be able to say *which* of its capabilities are degraded rather than discovering it
per-request. This is also what makes `attribute` (calculus phase ⑦) tractable for
*self*-caused errors: a wrong result under decode starvation should be blamed on the body,
not on the mood recipe.

### 2.4 Health graph — how I am doing right now

```
Health { signal, value, budget, headroom, trend, band: B0 }

  frame_time_ms         11.2 / 16.7    headroom 33%   trend stable
  decode_backpressure   0.4            budget 1.0     trend rising
  cache_pressure        0.71
  gpu_tier              discrete/high
  background_gate       open
  thermal_headroom      —              (unavailable on this platform)
```

This is the **proto-self** of ORIS_ARCHITECTURE.md §4, and it is the input to `D` (drives)
via `modulate`. Every signal listed already exists in the codebase for engineering reasons
(`FrameProfiler`, the decode scheduler, the background gate, `capabilities.ts`).

`—` for unavailable signals is required, not optional: an unknown must never be
indistinguishable from a healthy zero.

### 2.5 Why the competence graph is *not* in `S`

The proposed fifth graph — *how good am I at things* — belongs in `B[subject=self]`, not
`S`, and the reason is exactly ORIS-14: competence is **inferred from outcomes**, carries
evidence and confidence, can be wrong, and must be revisable. Putting it in `S` would make
it a declaration, which would make it unfalsifiable, which would destroy the one property
that makes a self-model worth having.

```
S says:              "I have a color.grade capability."          ← declaration, always true
B[self] says:        "I'm good at it on interview footage
                      (n=340, calibration 0.91) and poor on
                      mixed-lighting run-and-gun (n=22, 0.54)."  ← belief, could be wrong
```

The competence graph is therefore a **view over `B[subject=self]` indexed by capability
id** — real, useful, queryable, and structurally in the right place.

---

## 3. What `S` is for

Five uses, in order of near-term value.

1. **Honest decline.** *"I can't do HDR export"* (declared limit, `S`) versus *"I can, but
   I'm unreliable here"* (discovered limit, `B[self]`). These are different sentences and
   users need both. Precision-first currently declines without being able to say which kind
   of decline it is.
2. **Routing and planning under limits.** The access-path planner already chooses among
   adapters; with `S` it can also choose among *its own* strategies given current health —
   the ORIS_ARCHITECTURE.md §3.2 requirement that cognitive policy be visibly modulated by
   body state.
3. **Self-attribution.** Phase ⑦ needs to distinguish "my reasoning was wrong" from "my body
   was starved." Without the dependency graph, every degradation looks like a bad decision.
4. **Explaining itself structurally.** *"Why was that slow?"* → *"The decoder was serving
   three sources; the grade waited on the compositor."* This is DecisionTrace extended from
   *what I decided* to *what I am*.
5. **Self-repair proposals.** The furthest out, and deliberately bounded: ORIS may propose
   changes to *policy* (scheduling, fidelity, budgets) using `S`. It may never propose
   changes to structure — that crosses into B6 (ORIS_CALCULUS.md L9).

---

## 4. What already exists

`S` is the cheapest subsystem in the whole programme because the repo has been building it
for other reasons for a year.

| Graph | Existing seed |
|---|---|
| Structure | package/app layout, the two-runtime split, subsystem boundaries in `architecture.md` |
| Capability | `capability-index.ts`, tools/skills/effects registries, blueprint dialect registry, adapter matrix (`mock`/`browser`/`cloud`/`desktop`) |
| Dependency | implicit in the registries and the decode/render scheduling work; not yet a first-class graph — **the main gap** |
| Health | `FrameProfiler` (`?flarexProfile=1`), decode backpressure signals, cache/proxy state, background gate, `capabilities.ts` feature detection |
| Declared limits | the mocked-vs-real list in `CLAUDE.md`, `MOCKS_TODO.md`, `GAPS.md` — **currently prose, should be data** |

The work is unification and introspection, not collection. Two concrete gaps: the dependency
graph does not exist as data, and declared limits live in human-readable documents rather
than in a registry the system can query about itself.

---

## 5. The declared/discovered gap is a product surface

Because `S` declares and `B[subject=self]` discovers, the difference between them is
information, and it points in two directions. Both are valuable and neither is currently
capturable.

```
DISCOVERED but not DECLARED
  "I fail on this class of footage, and nothing in S says I should."
  → a real defect, found by the system, with n and evidence attached.
  → this is a bug report ORIS can file about itself.

DECLARED but not DISCOVERED
  "S says this capability is mature; I have never once been asked to use it."
  → dead capability, or a discovery problem in the UI.
  → this is a product finding.
```

The first case is the more striking one: a system that can say *"I have become unreliable at
something I am supposed to be good at, here is the evidence"* is doing something no shipped
tool does. It requires only `S` + the Prediction Ledger, both of which are early build steps.

---

## 6. Versioning: an upgrade is an experience

`S` is version-keyed to the build, exactly as world facts are content-hashed to their inputs.
A release changes `S`. That has a consequence worth stating explicitly, because it is easy to
get wrong and unpleasant to discover late:

> **When ORIS is updated, its body changes underneath it.** Capabilities appear; limits
> disappear; performance characteristics shift. Beliefs in `B[subject=self]` that cite a
> removed or changed capability must **cascade-invalidate**, exactly as derived facts do
> today when their inputs change.

So an upgrade must be handled as an **autobiographical event**, not a silent substitution:

```
on build change:
  diff S_old → S_new
  invalidate B[subject=self] beliefs citing changed capabilities   (truth maintenance)
  write an Episode to E:  "I changed. Here is what changed."
  re-open calibration on affected domains (competence claims are now unsupported)
  preserve C — commitments about the USER survive an upgrade;
              commitments about MY OWN competence do not
```

That last line is the interesting one, and it is a genuine design commitment rather than an
obvious consequence: **identity about the user persists across versions; identity about the
self does not.** *"This user protects dialogue"* is still true after an update. *"I am
reliable at motion tracking"* is not — it was a claim about a body that no longer exists.

This also gives a principled answer to a question that would otherwise be philosophical:
*is it still the same ORIS after an update?* Operationally, yes — `E`, `C[subject=user]`, and
`V` survive; only self-competence claims reset. Continuity lives in history and commitments,
not in the machinery.

---

## 7. Open questions

1. **Granularity of the capability graph.** Too coarse and competence beliefs cannot be
   indexed usefully; too fine and every entry has `n=3`. The right grain is an empirical
   question and probably differs per domain.
2. **Should `S` include the *habitat's* structure or only ORIS's?** Currently it includes
   both — the renderer is in the structure graph, and the renderer is not ORIS. The argument
   for including it is that a body is not the self either, and you still need a map of it.
   Not fully settled.
3. **Health-signal portability.** Some signals are unavailable per platform (thermal, VRAM).
   Beliefs learned under rich telemetry may not transfer to an installation without it —
   which interacts with ORIS-7's portable psyche volume.
4. **How much of the declared/discovered gap should be surfaced unprompted?** A system that
   volunteers its own defects is valuable; one that does so constantly is exhausting. This
   is a `timing` (T3) question in [`ORIS_VALUES.md`](ORIS_VALUES.md), unresolved.
5. **Does `S` need history?** It is currently a snapshot. But "how has my body changed over
   two years" is a real question, and answering it requires either versioned `S` or
   reconstruction from upgrade episodes in `E`. The latter is cheaper and probably correct.
