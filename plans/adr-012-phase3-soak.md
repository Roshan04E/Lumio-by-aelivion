# ADR-012 Phase 3 — browser soak protocol

**Purpose.** Phase 3 shipped three behavioural changes to the most defect-dense subsystem in the
runtime. Every safety argument for them is currently *structural* — reasoned from the code, asserted
headlessly at 139/139, and **never watched running**. Phase 4 builds directly on decoder behaviour, so
this is the gate between the two.

**Governance.** Risk **R2**: *never ship two decoder slices in one release.* S3.3 and S3.5 are both
decoder slices and are both in this unreleased range. That is the reason S3.5 defaults OFF and the
reason Run C is separate from Run B rather than folded into it.

---

## 0. What you are testing

| Flag | Default | Slice | The claim being tested |
|---|---|---|---|
| `kernelDecoderLifetime` | **ON** | S3.3 | A re-render no longer destroys a decoder; retention pays for itself and leaks nothing |
| `kernelResources` | **ON** | S3.4 | Reclamation happens on held frames; nothing visible is ever swept |
| `kernelProxySource` | **OFF** | S3.5 | A proxy demotes its sources instead of deleting them — **without** re-introducing 75→35fps |

Flags are read once at load. **Changing one means a reload**, and any run where you changed a flag
mid-session is void.

## 0.1 The console handles

```js
__rfKernelState        // NEW — the three Phase 3 ledgers, point-in-time state
__rfWcPool             // decoder pool: sessions, caps, retention counters
__rfKernel.summary()   // the kernel event ring, rolled up by reason
__rfFlarexProxy        // per-comp proxy decode stats
__rfWcMode             // per-source decode mode (wc-hw / wc-sw / element)
__rfFlarexDegradation  // host-clip substitution census
```

Reset between runs with `__rfKernel.reset()`. `__rfWcPool` counters are cumulative for the page
lifetime and are **not** resettable — record them as deltas or reload between runs.

## 0.2 Reaching the editor

The `CLAUDE.md` demo login is not seeded and returns 401. Use **"Try the demo"** → upload → **Continue**
→ **Blank Project**.

---

## Run A — baseline (all kernel flags off)

**URL:** `?kernelDecoderLifetime=0&kernelResources=0&kernelProxySource=0`

This is the control. Without it, every number below is unanchored.

- [ ] **A1.** Build a Flarex comp with **3+ asset-source MediaIns** on one clip. Play the whole clip.
- [ ] **A2.** Record `__rfWcPool` — note `created`, `capMisses`, `preemptions`, `reused`.
- [ ] **A3.** Scrub hard across the clip for ~30s. Record `__rfWcPool` again.
- [ ] **A4.** With the **frame profiler** on (`?flarexProfile=1`), note steady-state **fps while playing
      the comp**. This is the number S3.5 must not regress.
- [ ] **A5.** Prepare a proxy for the comp, let it serve, then **drag a layer underneath the clip and
      back out** (this breaks and restores `canSubstituteFlarexProxy` eligibility).

**Expect:** `created` climbs steadily with scrubbing — this is the defect, visible as decoders being
rebuilt. At A5 expect a **visible degrade**: the comp's MediaIns fall back to the host clip's picture
for a beat while decoders re-acquire from cold. **That flash is the bug Phase 3 exists to remove** — if
you cannot reproduce it here, say so, because then S3.5's premise needs re-examining before Phase 4.

---

## Run B — S3.3 + S3.4 (the shipped defaults)

**URL:** *(no flags — these are already the defaults)*

### B1 — decoder lifetime (S3.3)

- [ ] Repeat A1–A3 identically.
- [ ] Read `__rfWcPool`.

**Expect:**
- `retentions` **> 0** — releases the kernel overruled, i.e. decoders an unmount did not destroy.
- `retentionHits / retentions` **meaningfully above zero**. This is the honesty check: near-zero means
  the residency is protecting decoders nothing comes back for — cost with no benefit, and the signal to
  re-tune `DECODER_RETENTION_MS` or revert. **Report the ratio even if it looks good.**
- `created` **lower than Run A** for the same scrubbing. This is the win, stated as a number.
- `retentionOverrides` small — retained parks evicted anyway under cap pressure. Non-zero is fine
  (retention is a preference, never a veto); large means the TTL is fighting the caps.
- `wedgeTimeouts` **0**. Any non-zero here is a decoder that stopped answering — investigate before
  Phase 4 regardless of what else passes.

- [ ] Read `__rfKernelState.decoder`.

**Expect:**
- `orphaned` **empty**. ← **The single most important reading in this document.** This is the leak S3.3's
  retention could introduce. Non-empty at rest = stop, do not proceed to Phase 4.
- `unmet` empty **at rest**. Transient non-empty during scrubbing is normal (a session costs a demux and
  an index). Persistently non-empty is starvation, and retention must never be what hides it.
- `openCount` ≤ 4 (`MAX_WC_TOTAL_SESSIONS`), always.

- [ ] `__rfKernel.summary()` — look for `decoder-retained:lifecycle` and `decoder-retention-expired`.

**Expect:** both present. Retentions that expire unused are the residency being too long; retentions
that always hit are it being about right. A run with **only** expiries and no hits means the mechanism
is pure cost.

### B2 — resource reclamation (S3.4)

- [ ] Open **several node thumbnails** beside a paused viewer, then leave the tab idle ~30s.
- [ ] Read `__rfKernelState.resources`.

**Expect:**
- `byScope` shows `live` **and** `scratch:capture`/`scratch:thumb` separately. If everything is `live`,
  the scope derivation is wrong and the I-8 fix is not actually in effect.
- `reclaimedWhileUnpresented` — **non-zero is the finding, not the failure.** Every one is memory the
  old prune would have held until a frame presented. **Zero across the whole soak is also a valid
  result** and means the amplifier does not fire on this hardware; record which you saw.
- `oldestIdleMs` bounded, not climbing without limit.

- [ ] **The safety check that matters:** with a comp playing, watch for **any layer going black or
      flickering** at ~10s intervals (the `RESOURCE_IDLE_MS` cadence).

**Expect:** none, ever. A visible layer being swept is the one way this slice can do harm; it would mean
a touch site was missed. If you see it, note **which layer type** (media / text / shape) — that names
the missing touch.

### B3 — the A/B that isolates it

- [ ] Reload with `?kernelResources=0` and repeat B2's idle test.

**Expect:** `reclaimedWhileUnpresented` stays 0 (the sweep is off). If B2 showed flicker and this does
not, the sweep is the cause and `RESOURCE_IDLE_MS` / the touch sites are where to look.

---

## Run C — S3.5 (the flag that is not on yet)

**URL:** `?kernelProxySource=1`

**Run this separately from Run B.** R2 is the reason: two decoder slices under observation at once
means an ambiguous result, and an ambiguous decoder result is how the last two freezes were
misdiagnosed for several rounds each.

### C1 — the regression this must not cause

- [ ] Repeat **A4 exactly**: proxy serving, comp playing, `?flarexProfile=1`, read steady-state fps.

**Expect:** **within noise of Run A's A4.** This is the whole risk of the slice. The structural argument
is that a suspended loader is not pulled from and its output is not consumed — but that argument has
never been measured, and **this checkbox is the flag's flip condition.** A material drop toward ~35fps
means suspension is not actually stopping the pulls, and the flag stays off.

- [ ] Cross-check: `__rfFlarexProxy` for the served comp shows `decodes` climbing (the proxy is
      decoding) while the comp's **loaders** are not. `__rfWcPool.activeSoftware` should be **stable**,
      not climbing.

### C2 — the failure it fixes

- [ ] Repeat **A5**: proxy serving, drag a layer under the clip and back out.

**Expect:** **no host-clip flash.** The loaders were never unmounted, so there is nothing to warm up.
This is "a crossfade in resource terms, not a cut", and it is the observable form of the whole slice.

- [ ] `__rfFlarexDegradation.substitutedTotal` — compare against the same manoeuvre in Run A.

**Expect:** **lower than Run A.** Each substitution is a MediaIn showing the host clip's pixels; that is
the I-27 violation S4.5 deletes, and this slice should reduce the count without touching that code.

### C3 — the states are exclusive

- [ ] While the proxy serves, read `__rfKernelState.media`.

**Expect:** `demoted` **non-empty**, `suppressed` **empty**. Both populated means the mutual-exclusion
clearing is broken and the census is unreadable. `active` should equal `declared` — a demoted source is
still active, and that is the entire I-16 distinction.

### C4 — proxy SUSPENDED hysteresis

- [ ] Drag a layer under the proxied clip and back out **within ~2s** (`PROXY_SUSPEND_MS`).

**Expect:** the proxy resumes **without re-acquiring** — `__rfFlarexProxy[compId].decodes` continues
climbing from where it was, and `__rfWcPool.created` does **not** increment for the proxy's object URL.

- [ ] Now drag it under and leave it >2s, then restore.

**Expect:** the proxy is genuinely released and re-acquired — `created` increments. The bound is
supposed to expire; that is I-31, not a bug.

- [ ] **Edit a node in the comp** while its proxy serves.

**Expect:** **immediate** teardown, not a 2s suspension — that is `INVALID`, not `SUSPENDED`. A stale
frame surviving an edit would be a correctness failure, and it is the one case hysteresis must not
apply to.

---

## Run D — stress, all flags on

**URL:** `?kernelDecoderLifetime=1&kernelResources=1&kernelProxySource=1`

Only after B and C are individually clean.

- [ ] Rigorous scrubbing across a multi-comp timeline for **2–3 minutes**, then leave paused for 60s.

**Expect:**
- No white page / renderer crash. (The 2026-07-27 lesson: two caps that merely sum are not a budget —
  `openCount` must stay ≤ 4 throughout.)
- `__rfKernelState.decoder.orphaned` **empty at rest**.
- `__rfWcPool.wedgeTimeouts` **0**.
- `capMisses` may be non-zero under stress — that is the pool refusing, which is correct behaviour, not
  a failure. Read it **with** `active`/`activeSoftware` to see which pool ran out.
- Memory (DevTools → Performance monitor, JS heap + GPU) **flat or sawtoothing**, not monotonically
  climbing across the 3 minutes.

---

## What "pass" means

Phase 4 may start when:

1. `decoder.orphaned` is empty at rest in **every** run;
2. `wedgeTimeouts` is 0 in every run;
3. no visible layer was ever swept, flashed, or blacked out;
4. C1's fps is within noise of A4 — **or** S3.5 stays off and Phase 4 proceeds with
   `kernelProxySource=0`, which is legitimate and costs nothing structural.

A **fail on C1 alone does not block Phase 4.** S3.5's flag is off by default precisely so that its
measurement is not on the critical path. Record it and move on.

## What to write down

For each run: the flag string, the `__rfWcPool` object, `__rfKernelState`, `__rfKernel.summary()`, the
fps reading, and — most valuable of all — **anything you saw that this document did not predict.**
Every one of the runtime's worst bugs was first noticed as something that looked slightly wrong and was
explained away.

---

# MANDATORY GATE: decoder-soak acceptance (added 2026-08-04)

**Every change to decoder topology must pass a decoder soak before it is accepted. Pixel parity is not
sufficient evidence and never was.**

This is not a precaution. It is the direct finding of the S7.2 rollout, and it was paid for twice in
one day.

## What happened

S7.2 removed `kernelProxySource`, one of five flags whose ON path had already passed the pixel gate —
all 53 fixtures green with every default-OFF flag forced on. The deletion passed `kernel:conform`,
typecheck and the pixel gate again after it landed. It was, by every gate the programme had, safe.

The decoder soak then showed a divergence detach that had not existed before it:

| tree state | flag-on arm |
|---|---|
| pre-S7.2 baseline | `shared 8 · grants 8 · detaches 0 · blindSplits 1` |
| family 1 only | `shared 8 · grants 8 · detaches 0 · blindSplits 1` |
| `kernelProxySource` removed | `shared 5 · grants 5 · detaches 1 · blindSplits 0` |

## Why pixel parity cannot see it

Demotion keeps every declared source in the set instead of filtering out comps a proxy is serving.
That changes **who is declared**, and who is declared decides **who competes for a decode session** —
so the borrow topology changes with it: 8 grants become 5. Every pixel is still identical, because the
picture does not depend on which decoder produced it. The gate is measuring the output of the decode
path while the defect is in its allocation.

Any change with this shape — anything altering the set of declared sources, session identity, lease
priority, admission, or retention — is a decoder-topology change, whatever else it looks like.

## What the gate is

Run the decoder soak and require, on the arm under test:

- **zero divergence detaches** (`shareDetaches`, and no `⚠ DETACH` in the ledger);
- **`capMisses` flat** against the pre-change baseline — a fix that stops detaching by spending more
  sessions has moved the cost, not removed it;
- **sharing intact** — grants and hit ratio comparable to baseline. A run that stopped detaching
  because it stopped sharing has broken the thing the slice exists to protect;
- **no new approval mechanism** in the `approved-as` ledger.

```
PIXEL_BROWSER_CHANNEL=chrome PROBE_CUTS=3 PROBE_CUT_FRACTION=0.85 \
  PROBE_ARMS=satisfaction PROBE_EXTRA_FLAGS="wcDecode=1&<flags under test>" \
  PROBE_REQUIRE_WC=1 pnpm --filter @orreris/worker preview:budget
```

`PIXEL_BROWSER_CHANNEL=chrome` is a precondition, not a preference: without it the probe runs
SwiftShader at ~8fps, where these races do not reproduce at all. Nine "clean" runs were collected that
way before anyone noticed, and they were void.

## The deeper rule: acceptance must be regenerated for the operating configuration

S4.7's original acceptance — 12/12 clean — was measured with `kernelProxySource` OFF, i.e. for the
configuration S7.2 exists to delete. It proved the FLAGGED topology, not the one that ships.

When a flag is removed, the operating configuration changes, and prior acceptance evidence does not
transfer to it. It has to be regenerated under the flags as they will actually run. The second defect
found on 2026-08-04 was deterministic (3/3) in the always-on topology and had simply never been
sampled, because nothing had ever soaked that arrangement.

**Corollary for R2** ("never ship two decoder slices in one release"): read it as a SOAK rule, not a
commit-hygiene rule. Two decoder slices verified independently are not verified together.

## Every decoder-topology change must be BISECTABLE

A family containing more than one behavioural change must be splittable, so a decoder soak can isolate
the first regression to a single commit.

`dc1319d → 92ce73b` is the reference case. One commit removed two flags — `kernelProxySource` and
`kernelWallClockTtl` — because both looked like mechanical deletions and both passed every gate the
programme had. When the soak failed, the failure named a COMMIT, not a cause, and the two flags had to
be separated after the fact to find out which one mattered. Four isolation runs answered it:

| tree state | flag-on arm |
|---|---|
| pre-S7.2 baseline | `detaches 0 · blindSplits 1` |
| family 1 only | `detaches 0 · blindSplits 1` |
| families 1+2 | `detaches 1 · blindSplits 0` |
| families 1+2+3 | `detaches 1 · blindSplits 0` |
| `wallClockTtl` removed, `proxySource` restored | `detaches 0 · blindSplits 2` |

`wallClockTtl` was innocent and stayed deleted; `proxySource` was the cause and came back. That
separation was recoverable only because the commit could be split. Had the family also carried the
decoder pair, the same soak would have implicated three behavioural changes at once and the bisect
would have cost a day rather than four runs.

The rule is therefore about the SHAPE of the commit, not its size: group by "one behavioural change I
can revert alone", never by "flags that happen to be adjacent in the file".

---

**Ownership note.** This document owns the PROCEDURE. `adr-012-implementation-programme.md` should own
the POLICY — in particular R2, which must be restated there as a soak rule rather than a release-hygiene
rule. That edit is outstanding only because the programme file carries another session's uncommitted
work; when it lands, mirror these five rules there and cross-reference this playbook so the two cannot
diverge.

---

# Rollout flags vs observability controls (added 2026-08-04, S7.2)

S7.2 says "delete every `kernel.*` flag". One flag does not belong to that sentence, and the
distinction is architectural rather than a carve-out for convenience.

**A ROLLOUT FLAG selects behaviour.** It chooses between two implementations, or keeps a rollback path
alive. Once one implementation is accepted, the other is debt and the flag must be eliminated —
`kernelScopes`, `kernelProxyUpload`, `kernelIncremental`, `kernelProxySource`, `kernelWallClockTtl`,
`kernelSessionSatisfaction`, `kernelSourceAdmission`, `kernelFrames`, `kernelCoherenceUnified`,
`kernelResources`, `kernelDecoderLifetime`. All eleven are gone.

**An OBSERVABILITY CONTROL selects whether instrumentation is emitted.** It does not change what the
editor does. `kernelDiagnostics` is the only one, and it is RETAINED.

Retaining it is what keeps programme risk **R1 (the observer effect)** enforceable. R1 requires
instrumentation to be *allocation-free when off*, and several guards sit on per-acquire and per-frame
paths where the record is genuinely expensive: `rankAdmission` allocates a candidate array and sorts
it, the borrow-grant record copies a ring buffer. Delete the switch and that property becomes
unachievable rather than merely unused — the cost is paid on every frame forever, and no future
investigation can turn on expensive telemetry without paying for it permanently.

The single-execution-path objective is untouched: the editor behaves identically with diagnostics on
or off. That is exactly what makes it an observability control and not a rollout flag.

## The audit that justifies retaining it

Every guarded site was classified before this decision. All 25 runtime sites are **pure telemetry**,
and the property that makes them so is uniform: **the state change happens BEFORE the guard, and only
the `record()` call is inside it.**

| site | unguarded (behaviour) | guarded (telemetry) |
|---|---|---|
| `dependency-graph:156` | `store.opaque.add(nodeId)` | `dependency-axis-unknown` |
| `dependency-graph:288` | `store.undeclaredSeen += …` | `dependency-undeclared-nodes` |
| `decoder-manager:543` | `session.state.set(KEY_OPEN, …)` | `decoder-closed:<cause>` |
| `evaluation-planner:141` | `evaluate.add` / `reasons.set` | `evaluation-plan` |
| `frame-scheduler:133/255` | `off()`, `listener(completion)` | timeout / listener-threw |
| `preview-frame-pool:1380` | `rankAdmission(...)` — the DECISION | `noteAdmissionDenied` + counter |
| `scene-frame-scope:74` | `classifyComposite(...)` | `settle-window-*` |

`frame-scheduler:186`'s `active !== null` gates REPORTING an overlap, not scheduling. The
`kernel-conformance.ts` hits are the harness setting the flag for its own tests, not guards.

**If a future guard lands in a third bucket — anything that changes scheduling, admission, caching,
borrowing, timing or execution — it is not diagnostics and must be refactored out before it ships.**
The rule to apply when reviewing one: does the runtime do something different with the flag off? If
yes, it is behaviour wearing a diagnostics guard.
