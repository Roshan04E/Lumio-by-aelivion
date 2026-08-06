# ADR-020 slice D — the layer-side re-acquire

*Status: **IMPLEMENTED 2026-08-06**, and **UNEXERCISED** — see §7. The contract below was written before
the code, because this slice crosses out of the kernel and the seam is where the last two admission
defects lived. It is left in its original form; §7 records what the runs then showed.*

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
2. **`retries 0` is the whole gap.** Recovery never issued a single `retry` verdict, because free
   capacity never appeared: the pool stayed full for the entire session. **A retry path that only fires
   on freed capacity would have done nothing in this run.** See §5 — this is why the trigger is a
   transport boundary and not a capacity event.
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

**Why a transport boundary and not freed capacity — this is the measured reason the slice has its
shape.** In the 2026-08-06 census the pool stayed full for the entire session and recovery issued
`retries 0`: free capacity **never appeared**. A retry path triggered only by a capacity event would
therefore have been *dead code shipped behind a clean gate* — it would have passed every gate in the
repo while never once firing, and the counters would have read 0 exactly as they do now. The trigger has
to be an event that actually occurs on a starved runtime, and transport is the one that does.

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

**77 transport boundaries were driven (P-c satisfied) and produced 0 re-asks — correctly.** Recovery
granted no eligibility all run (`retries 0`) because free capacity never appeared: the pool stayed full
for the entire session. With no permission outstanding, the correct number of re-asks is zero.

> **This run shows slice D breaks nothing. It does not show that it works.**
> D1 and D2 are unexercised, exactly as slice A's `capMisses 0` soak left slice A unexercised.

**Why this fixture structurally cannot exercise it.** Six simultaneous MediaIns in one comp live and die
together, so every release is a full teardown followed by a fresh lottery — never *one source leaving
while another stays starved*. D needs capacity to free **asymmetrically**, and that is a property of the
fixture, not of the runtime.

**The next step is fixture engineering, not code.** An arrangement is needed in which one source departs
while a starved one remains — timeline clips whose windows differ under a seek is the obvious candidate,
since a clip leaving the window releases its session while the rest stay mounted. Until such a run
exists, D's acceptance table is a specification and not evidence, and it should be described that way.

### Carried forward

`ticks`/`sweeps` are recorded on every census run, so **OQ10's sizing evidence accumulates for free**
rather than needing its own campaign. Three runs so far: `1/–`, `2/5`, `4/6`, `4/7` sweeps/ticks — the
rate limit rejects a large and *varying* share of host ticks, and the run that recorded `sweeps 1` is the
one that missed §6.11's terminal entirely.
