# ADR-020 slice D — the layer-side re-acquire

*Status: **IMPLEMENTED 2026-08-06**, **ACCEPTANCE VOID 2026-08-07** — see §8. The contract below was
written before the code, because this slice crosses out of the kernel and the seam is where the last two
admission defects lived. It is left in its original form; §7 records what the runs then showed and §8
records why that record does not amount to acceptance.*

---

## 0. What this closes, precisely

Slice A closed one half of DEBT-013 and said so: starvation became a **state** that the runtime reports,
and §6.11's declared terminal became reachable. It did not close the other half. Acceptance clause (b)
is met; clause **(a) — "subsequently admitted" — is not**, because *a denied source still never re-asks*.

The gap is not in the kernel. `recoverDeniedAdmissions` already computes the verdict; there is simply no
layer-side path that turns a `retry` verdict into an acquire. `requestLiveReprime` was the obvious
candidate and is the wrong one — it re-seeks the `<video>` element and never re-attempts an acquire.

This slice supplies that path, and nothing else.

---

## 1. Measured basis (2026-08-06, `starvation:census`, chrome, 6 sources / 4 slots)

The contract below is sized against a real run, not against the constants:

```
routing          3/6 off-element  (three sources on wc-sw, three stuck on element)
capMisses        6
starvedSources   peak 3 · final 3
starvedLongestMs peak 186876          ← 187 seconds, on a 30s terminal
recovery         ticks 5 · sweeps 2 (nominal ≈5) · waits 3
outcomes         retries 0 · permanentDenials 3
```

Three facts from this run bear directly on the design:

1. **The losers are identifiable and stable.** Three sources starved for the entire window and none
   recovered — `starvedSources` never moved off 3. The set this slice acts on is small and quiet, not a
   churning population.
2. ~~**`retries 0` is the whole gap.** Recovery never issued a `retry` verdict because free capacity
   never appeared: the pool stayed full for the entire session. A retry path that only fires on freed
   capacity would have done nothing in this run.~~ **WRONG — falsified 2026-08-06 (OQ11).** Measuring
   releases *at the release site* rather than inferring from `retries 0` gives
   **`capacityFreedWhileStarved 5 · samePool 4`** on a run where recovery granted **0** permissions.
   Capacity freed four times in the right pool while a source was starved, and recovery saw none of it.
   The pool does not stay full; it **churns** (`created 11` against a 4-slot cap), and the sweep's
   ~11.5s sampling steps over the transients. The opportunity existed and was not observed.

   *Third time in this programme that a zero was read as "the condition never occurred" instead of "the
   instrument never looked". The counter said what recovery SAW, and I wrote down what the pool DID.*
3. ~~**The sweep cadence under-delivers.** `ticks 5 · sweeps 2`: recovery's own 10s rate limit rejects
   most of the host ticks it rides.~~ **WRONG — falsified 2026-08-06 by instrumenting the branch.**
   `rejects n=0` on four consecutive runs; the limit has never rejected a tick. The gap was an uncounted
   third branch (the registry was still empty), and the accounting now closes at
   `ticks 7 = sweeps 4 + rejects 0 + empty 3`. The tick period is real and variable
   (min 10140ms / mean ~11.5s / max 18607ms against a nominal 10s) because the sweep rides the composite
   loop, but the constant sits *below* the observed minimum and never binds. See DEBT-013 / OQ10.

   *This item is left visible rather than deleted: it was an inference from a gap between two counters,
   published as a measurement, in a programme whose central rule is `count the reasons, never infer
   which branch fired`. The rule applies to the person applying it.*

---

## 2. Ownership, stated first because the last two defects lived at this seam

| Concern | Owner | Non-negotiable |
|---|---|---|
| *Is this source starved?* | pool (`deniedWaiters`) | Unconditional. Never the diagnostics ring. |
| *Should it re-ask?* | pool (`recoveryAction`) | **One admission decision point.** The layer never decides it is entitled to a slot. |
| *When may it re-ask?* | layer | The kernel does not know what the transport is doing. |
| *Does it get the slot?* | pool (`acquirePreviewFrameProvider`) | Unchanged. The existing path admits or refuses exactly as always. |

The layer proposes a moment; the kernel disposes of the request. Any design in which the layer concludes
"I was told to retry, therefore I have a slot" reintroduces two admission authorities, which is the
defect ADR-012 §6.11 exists to prevent.

---

## 3. The contract

### C-D1 — Eligibility is a kernel-owned flag, read by the layer

Recovery marks a waiter **eligible**; it does not call anything. The pool exposes a predicate the layer
can ask about a url it already owns. Eligibility is advisory and revocable: it means *the kernel would
entertain a re-ask*, never *a slot is reserved*.

### C-D2 — The re-acquire happens only at a transport boundary

Permitted moments — a **seek**, a **scrub**, or **while paused**. Forbidden: mid-playback on a running
source.

~~**Why a transport boundary and not freed capacity.** The pool stayed full for the entire session, so a
capacity-triggered retry would have been dead code shipped behind a clean gate.~~ **This argument is
RETRACTED (OQ11, 2026-08-06).** Capacity frees 4–5 times per run while a source is starved; a
capacity-event trigger would have fired, not lain dead. The premise was an inference from `retries 0`.

**C-D2 still stands, on its other argument alone** — the risk asymmetry below — and the retraction
actually *sharpens* the clause rather than undermining it. Eligibility and the moment of re-acquire are
two different things, and this contract already separates them: the kernel decides *whether* a re-ask is
entertained, the layer decides *when*. OQ11 shows the defect is in the first half, not the second. The
opportunity is a **release event**; recovery only looks for it on a ~11.5s sweep, so it misses
transients. Fixing that means granting eligibility *at the release*, which leaves C-D2 completely intact
— the layer would still act only at a seek, scrub, or pause.

**Not implemented here, deliberately.** It would make this slice's fixture pass, and a mechanism must not
be changed to satisfy the run that measures it. Recorded as OQ11 with a recommendation; the decision is
open.

The reasoning is the risk asymmetry, and it is the same argument that kept displacement out of slice A.
A re-acquire tears down and rebuilds a decode path. At a transport boundary a decode discontinuity is
*already happening and already invisible*; mid-playback the same teardown is a visible hitch on a source
that is currently working. Recovery admits only into **free** capacity, so the switch costs no other
source its session — the cost is bounded, one-time, and borne by the source that is currently degraded.

Phase 0 measured 115 transport samples across 30 seconds. Boundaries are plentiful; nothing needs to be
manufactured, and nothing needs to fire promptly.

### C-D3 — Eligible is not served, and the census must keep saying so

**An eligible-but-not-yet-upgraded source still reads as starved.** `starvedSources` must not decrease
when eligibility is granted, only when a session is actually served.

This is the clause most likely to be violated by a well-meaning implementation, and violating it
recreates the exact defect slice A was written to remove: a health reading that goes quiet while the
picture is still degraded. Eligibility is a *permission*, and permissions are not outcomes.

### C-D4 — A failed re-acquire must not reset the starvation clock

If the re-ask is denied, the waiter returns to waiting with its **original `deniedSinceMs` intact**.

`noteDenied` already guards this on the mount path, for the reason that matters here too: refreshing the
timestamp on every re-ask means a source that asks often enough can never reach the terminal — "waiting
forever" wearing a retry loop. A retry path that resets the clock would defeat the half of DEBT-013 that
slice A just closed, which is a strictly worse outcome than having no retry path at all.

### C-D5 — No new decision cadence

The layer already receives transport events. This slice adds no timer, no polling loop, and no per-frame
hook. If no boundary ever arrives, the source stays starved and keeps reporting it — which is a correct
outcome under C-D3, not a failure to handle.

---

## 4. Explicitly out of scope

- **Displacing an incumbent.** Unchanged from slice A. `RecoveryAction` names the omission.
- **Mid-playback switching.** C-D2.
- **Tuning `MIN_RESIDENCY_MS`.** OQ9 is still unsized.
- **Fixing the sweep cadence (OQ10).** Real, measured above, and a separate change: it alters *when the
  kernel decides*, which is a different blast radius from *how the layer acts on a decision*. Bundling
  them would make the soak un-bisectable, and one topology change per commit is binding.

---

## 5. Acceptance, with its vacuity guards declared first

Extends `starvation:census`. The run is only readable if the preconditions hold:

- **P-a:** `routing.engaged > 0` — the decoder subsystem ran. *(Note: the "most sources off-element"
  form of this guard is CIRCULAR and was removed on 2026-08-06. A denied source falls back to the element
  path, so demanding that most sources have left it demands that starvation not occur; it voided a run
  that had in fact produced the denial it was looking for.)*
- **P-b:** `capMisses > 0` — denial actually occurred. `starvedSources 0` otherwise means the registry
  was never populated, which is not the same claim as "nothing starved".
- **P-c:** at least one transport boundary occurred during the window. Without this, `retries 0` says
  nothing about the mechanism — it says the trigger never fired. **This guard is load-bearing**: the
  measured run above had `retries 0` for exactly that reason.

Then, and only then:

| # | Criterion | Reads |
|---|---|---|
| D1 | A starved source is admitted after a transport boundary | `starvedSources` **decreases**, and the url leaves `element` in `__rfWcMode` |
| D2 | It was admitted, not merely permitted | a decode session exists for that url; `active`/`activeSoftware` rises |
| D3 | Eligibility alone never flatters the census | between eligibility and service, `starvedSources` is unchanged (C-D3) |
| D4 | A refused re-ask does not reset the clock | `starvedLongestMs` continues rising across the refusal (C-D4) |
| D5 | The terminal still fires for a source that never gets room | `admissionPermanentDenials > 0` when the pool stays full past the terminal |

D3 and D4 are the ones that matter. D1 is the feature; those two are the guarantees that stop the
feature from re-hiding what slice A made visible.

**Soak requirement.** This changes when decode sessions are created, which is a decoder-topology change.
Pixel + typecheck are not sufficient — a decoder soak is required, and the soak must be non-vacuous:
`capMisses 0` proves only that the slice breaks nothing.

---

## 6. Open questions this slice does not answer

- **OQ10 — SIZED AND CLOSED 2026-08-06, premise falsified, no constant changed.** `rejects n=0` across
  four runs; the rate limit never binds. The gap was the uncounted third branch (empty registry), and
  the accounting now closes at `ticks 7 = sweeps 4 + rejects 0 + empty 3` on every run. Tick period
  measured at min 10140ms / mean ~11.5s / max 18607ms against a nominal 10s: the constant sits below the
  observed minimum, so raising it would start rejecting ticks currently accepted and lowering it would
  do nothing. The residual is that recovery's cadence is coupled to **compositing activity** rather than
  a clock (`RESOURCE_IDLE_MS + time-to-next-composite`), which no constant can fix and which the "ride
  the existing tick" condition deliberately chose. Full record in the debt register under DEBT-013.
  **Recovery is not under-firing, so the block on the D fixture is lifted on evidence.**

  *(The superseded claim is kept below, struck, because the way it was wrong is the point.)*

- *(SUPERSEDED)* ~~Recovery's rate limit rejects ~60% of the host ticks it rides (`ticks 5 · sweeps 2`);
  the two 10s limits compose into an effective cadence neither declares.~~ The rejection rate was never
  measured — it was read off a gap between two counters while the branch that would have proved it went
  uninstrumented. It is 0%.
- **OQ9.** Residency ÷ mount-storm duration. Unsized; `MIN_RESIDENCY_MS` stays untouched.

---

## 7. What shipped, and what the runs established (2026-08-06)

### Implemented

| Piece | Where |
|---|---|
| `eligible` on the denied record; set by recovery on a `retry` verdict, cleared by a refused re-ask | `preview-frame-pool.ts` |
| `isAdmissionEligible(url)` — advisory, revocable, never a reservation (C-D1) | `preview-frame-pool.ts` |
| `noteServed(url)` — the single exit from the registry, called from **every** success path | `preview-frame-pool.ts` |
| Boundary detector: pause, or a transport step > `SEEK_DISCONTINUITY_S` (C-D2, C-D5) | `WebglMediaLayer.tsx` |
| Re-entry via `wcReacquireEpoch` in the **existing** lease effect's deps | `WebglMediaLayer.tsx` |
| `admissionReacquireAttempts` / `Grants`; `admission-reacquire` trace reason | pool + trace |

**A slice A defect was found and fixed while writing this.** The share path (`return
attachMember(existing, …)`) returned early *without clearing the denied registry*. A waiter later
satisfied by attaching to an existing session therefore stayed counted in `starvedSources` forever and
would eventually be **declared permanently denied while it was being served**. A census that reports a
served source as starved is exactly as wrong as one that reports a starved source as served, and D's D1
criterion ("`starvedSources` decreases") could not have meant anything while it stood. Fixed by routing
every success path through `noteServed`.

**No bespoke acquire call site.** Re-entry is a dependency bump on the existing lease effect. A separate
re-acquire would have had to re-derive priority, software preference, exclusivity, requested time,
purpose and contribution — six chances for the retry path to ask a different question than the mount
path, at the seam where the last two defects lived.

### Established by the runs

Slice A's census passed **7/7 three times independently**. On the final run: `capMisses 10 ·
starvedSources peak 5 · starvedLongestMs 82s · ticks 7 · sweeps 4 · waits 7 · permanentDenials 3`.

### NOT established — D is unexercised, and this is the honest result

**77 transport boundaries were driven (P-c satisfied) and produced 0 re-asks.** Recovery granted no
eligibility all run (`retries 0`), so with no permission outstanding the layer correctly re-asked zero
times — **the layer half of D behaved exactly as contracted.**

The reason recovery granted nothing was FIRST RECORDED HERE AS "free capacity never appeared", and that
was wrong (OQ11, §1 above): capacity freed 4–5 times per run in the right pool, and the sweep's ~11.5s
sampling stepped over every one. So D is unexercised because of a defect in the KERNEL half — recovery
not observing the opportunity — and not because the fixture cannot produce the condition.

> **This run shows slice D breaks nothing. It does not show that it works.**
> D1 and D2 are unexercised, exactly as slice A's `capMisses 0` soak left slice A unexercised.

~~**Why this fixture structurally cannot exercise it.** Six simultaneous MediaIns live and die together,
so every release is a full teardown followed by a fresh lottery. D needs capacity to free
asymmetrically, and that is a property of the fixture.~~ **RETRACTED (OQ11).** This fixture DOES free
capacity asymmetrically — `capacityFreedWhileStarved 5 · samePool 4` per run, with sources starved
throughout. The arrangement was never the obstacle.

**So the next step is NOT fixture engineering.** It is OQ11: recovery must observe the release, because
the opportunity is an event and the sweep is a sample. Building a more elaborate fixture first would
have produced the same `retries 0` on a bigger rig, and I would have concluded the fixture was still
wrong. Until OQ11 is resolved, D's acceptance table remains a specification and not evidence.

### Carried forward

`ticks`/`sweeps` are recorded on every census run, so **OQ10's sizing evidence accumulates for free**
rather than needing its own campaign. Three runs so far: `1/–`, `2/5`, `4/6`, `4/7` sweeps/ticks — the
rate limit rejects a large and *varying* share of host ticks, and the run that recorded `sweeps 1` is the
one that missed §6.11's terminal entirely.

---

## 8. Acceptance is VOID (2026-08-07)

Every run of this slice, on every fixture built, through slice E and F, read `reacquireAttempts 0`. The
census run in §7 said so honestly at the time ("D is unexercised"), and that honesty is exactly why this
section exists now: the mechanism was never once observed to fire, on ANY fixture, until an unrelated
change — F's swap of the boundary detector from a React-render-gated inline effect to
`admission-reacquire.ts`'s imperative `subscribePlaybackClock` subscription — incidentally raised its
firing frequency to match the real transport clock. The very first run that change touched read
`reacquireAttempts 6-7 · reacquireGrants 2-3` (full account: DEBT-013, 2026-08-07 update; bisect: F's
soak regression, localized to that one swap).

**What this means for what "D shipped" means.** A contract's acceptance table (§5, D1–D5) is evidence
about a mechanism only across runs where the mechanism executed. Every prior run — including the ones
this document and DEBT-013 previously described as "D breaks nothing, established as unexercised" — had
`attempts 0`. Zero executions is not a small sample of a working mechanism; it is no sample. Any language
in this document, in DEBT-013, or in conversation that treated D's soak passing (`capMisses` moving,
gates green, D3/D4 holding) as *acceptance of D* was a vacuous pass over a population of approximately
zero, in exactly the shape slice A's first `capMisses 0` soak was — and that one was named as vacuous
immediately. This one was not, until now.

**Restated precisely.** DEBT-013 clause (a) — "a denied source is subsequently admitted" — remains
**unmet by anything currently on this branch**. The one run that ever exercised the re-acquire path did
so under code that is not committed (F's detector swap, held pending its own acceptance — see the
DEBT-013 update dated 2026-08-07 and the successor slice below). D1 and D2 (§5) are **retracted to
unevaluated**, not failed — the one data point available is favorable (`grants 2-3` of `attempts 6-7`)
but it is one run, on one fixture, and the trade it implies (preload eviction) has not been measured
under non-adversarial conditions. D3 and D4 continue to hold on every run measured, including this one.

**What ships instead.** The fix is not to D's contract — every clause here is still the right shape. It
is to WHERE the boundary detector lives and how it is triggered, which was always meant to be "at a
transport boundary" and, by an accident of React's render-gating, was instead "at a transport boundary
that also happens to cause a re-render" — a much rarer event. That fix is being proposed as its own
slice, provisionally named **"D fires"**, gated on a non-adversarial capacity measurement before
acceptance. See DEBT-013 for the pending measurement.
