# ADR-013 real-project measurement — plan, pre-registered

- Status: **DESIGN ONLY. Not built, not run.** Requires explicit approval before any code or browser
  session is created.
- Purpose: every number this programme has produced so far (mechanism B, OQ1–OQ11, the storm-vs-steady-
  state dissolutions) came from adversarial synthetic fixtures — sources deliberately built to exceed a
  budget (6 sources, 4 slots). Nothing has ever measured a project that looks like something a user made.
  This measurement decides three things at once: whether slice B2 is needed (I-48), whether the Governor
  has any empirical basis at all, and whether ADR-013 is finished once C16/I-44 land (`plans/
  adr-013-scope-after-adr-020.md`, second amendment).
- Referenced from `project-tracker/architectural-debt.md`, DEBT-013, "DISPOSITION UPDATE (2026-08-08)."

---

## 0. What "the new gate" is, so this plan is self-contained

**`flarexConcurrentLoaders`** is a value already shipped on this branch, not something this measurement
introduces. Full account:

- **What it is:** a count, computed once per render in `VideoPreview.tsx`, of how many Flarex virtual
  loaders (asset-source MediaIns, excluding generators) are currently mounted across the whole project —
  `flarexVirtualLayers.filter((v) => !isFlarexGeneratorVirtualLayer(v)).length`.
- **What it does:** gates `preferSoftwareDecode`, the prop that forces a Flarex virtual loader onto CPU
  (software) decode instead of the GPU hardware decoder, to keep it from contending with the host clip for
  the one hardware H.264 block. **Before:** any virtual loader at all forced software decode
  (`isFlarexVirtualLayerId(layer.id)` alone — a decision made from what kind of layer this is, the exact
  thing I-44 forbids). **After:** software decode only kicks in when `flarexConcurrentLoaders > 1` — a
  lone virtual loader now takes hardware, same as the host; ≥2 concurrent loaders still take software,
  which is the exact multiplicity (host + 2 = 3 hardware consumers) the original starvation was measured
  at, so the change narrows the old rule at the point it was proven to matter, rather than loosening past
  it.
- **When and whose commit:** today, 2026-08-08, this session, commit `37ed422` ("fix(preview): C16/I-44 —
  decode backend from contention, not source identity"). **Already shipped on this branch** — committed,
  not stashed or experimental, verified via a clean `git worktree` checkout + typecheck. Not yet pushed to
  `origin` as of this writing (it landed after the branch's last push).
- **Effect on this measurement:** the gate is existing, current behavior — this project will exercise
  whatever `VideoPreview.tsx` actually does today, not a hypothetical. Host A (§1, 3 siblings) tests the
  gate at a multiplicity above its threshold; Host B (2 siblings) tests exactly at the threshold. If the
  gate's `>1` cutoff is wrong for a real project's actual behavior, this is the run that would show it.
- **Caveat already on record (from the commit message):** this is a real, unmeasured behavioral change,
  flagged in-code as "should be watched, not assumed proven." This measurement is part of that watching,
  not a formality.

## 0.1 Corrections to the previous draft of this plan (2026-08-08)

Recorded rather than silently fixed, because a plan that changes between drafts without saying so is the
same defect as a document believed over `git log`:

1. **Two numbers disagreed.** The first draft said Host A had "3 sibling MediaIns" and separately described
   that as "(host + 2)" — those are different fixtures (4 vs 3 concurrent consumers). **Actual: Host A has
   3 MediaIns**, giving 1 host + 3 loaders = 4 sessions. Full arithmetic now tabulated in §1.
2. **The peak omitted the junction transition.** The draft predicted peak 4 during Host A's steady window
   and missed that the clip→Host A junction overlaps an outgoing decoder with all of Host A's, giving 5
   against a ceiling of 4. Recomputed in §1; it is now the run's most informative moment.
3. **The ceiling was misquoted.** `NOMINAL_CAP = 4` is a probe-local constant, not the pool's budget. The
   real model is `MAX_WC_TOTAL_SESSIONS = 4` with a separate hardware cap of 3 and one reserved hardware
   slot. Corrected in §1.
4. **The fixture could not test the thing that shipped.** With only Hosts A (3) and B (2), every observed
   case reads `flarexConcurrentLoaders > 1` — where `37ed422` and the old code behave *identically*. The
   `== 1` case, the only configuration the commit actually changed, was absent. **Host C (1 MediaIn) was
   added** for exactly this. Without it the run would have validated the threshold by never testing it —
   the vacuity failure this programme keeps rediscovering.
5. **Sampling was too coarse for the predicted window.** Corrected to 100ms plus high-water marks in §1.

## 1. The project

**Composition, not a stress rig.** Built with the same helpers the prior probes used
(`apps/worker/src/browser/editor-session.ts`: `importAssets`, `defaultClipPath`, `addAssetSourceMediaIn`,
`addMediaInBoundTo`) so it's constructed the same way a real timeline is, not hand-assembled JSON.

| Element | Count | Why this number |
|---|---|---|
| Timeline clips, ordinary (non-Flarex) | 8 | A short-form edit's typical clip count — enough to exercise normal mount/preroll/preempt traffic alongside the Flarex work, not a bare single-clip scaffold. |
| Source types | video (H.264, mixed resolutions), one image, one generated text layer | "Mixed source types" per the brief — an image and a text layer never touch the decode pool at all, which is itself a fact worth having on record (do they show up as `created 0` correctly, or leak a slot). |
| Flarex-hosted clips | **3** (was 2 — see the §0.1 correction) | More than one host, so a per-host contention count (I-48's actual subject) is distinguishable from a per-project one. The third exists specifically to exercise the `== 1` case the shipped `> 1` threshold turns on; with only Hosts A and B the fixture could not test the one thing `37ed422` actually changed. |
| MediaIns per Flarex host | **Host A: 3. Host B: 2. Host C: 1.** | **Host A is the mandatory element — F9.** Without ≥2 sibling MediaIns on one host, the run cannot speak to I-48 (which is specifically about *siblings on one host* scoring identically) and is vacuous by construction. **Host B = 2** is the gate's threshold boundary (the smallest count that still takes software). **Host C = 1** is the only configuration in the entire fixture where `37ed422` changed behaviour at all: `flarexConcurrentLoaders == 1`, so the loader now takes **hardware** where before it took software. Every other case (A, B) reads `> 1` and behaves identically under old and new code — a fixture without Host C would validate nothing about the threshold. |
| Transitions | 3 (cross-dissolve between two ordinary clips, wipe between two ordinary clips, one Flarex-graph junction transition between an ordinary clip and Host A) | Transitions are a declared "mixed source types" requirement and exercise the transition-overlay/pool-preempt path the synthetic fixtures never touched. **None of the three transitions connects Host A to Host B** — see the layout below; the two hosts never touch. |
| Effects | at least one grade + one blur on a non-Flarex clip, one Flarex node-graph color op inside a host | Confirms the run isn't accidentally a bare MediaIn→MediaOut passthrough (the documented "cliff" in `VideoPreview.tsx` — a graph with no asset-bound MediaIn builds zero loaders and the whole decode path stays dormant, silently voiding the run). |
| Total duration | ~90 seconds | Long enough to clear both of slice A's gating constants with margin (`ADMISSION_RECOVERY_IDLE_MS` 10s, `PERMANENT_DENIAL_AFTER_MS` 30s — same reasoning `starvation-census-probe.ts` already used), short enough to stay a single, reviewable fixture rather than a synthetic marathon. |

**Explicitly NOT included:** no source count is inflated past what the above needs. Six-sources-against-
four-slots is exactly the shape being tested *against* — reproducing it here would just rebuild the
synthetic fixture with extra steps.

### Temporal layout — the part that decides whether this run means anything

Counts alone don't say whether sources are concurrent or sequential; a stacked timeline is the synthetic
fixture wearing ordinary clothes. Pre-registered arrangement, on a single timeline track (per §"explicitly
not included" — no artificial stacking):

```
0s        10s  14s      34s     44s  46s        62s      72s        84s  86s     90s
|- clip1 -|xdis|- clip2 -|- clip3-|junc|- HOST A -|- clip4 -|- HOST B -|wipe|HOST C|
                                   tion  3 MediaIns          2 MediaIns      1 MediaIn
                                    ▲
                            THE PEAK MOMENT (~1.2–3.2s)
                       clip3 outgoing + Host A's host + A's 3 loaders
                              = 5 sessions against a ceiling of 4
```

- **Ordinary clips: sequential.** Each plays start-to-end before the next begins. The ONLY overlap between
  two ordinary clips is during their own transition (~1–2s), where outgoing and incoming briefly coexist.
  Not zero overlap ever — overlap bounded to the transition's own duration, never a deliberate stack.
- **No two Flarex hosts overlap.** A, B and C each occupy a contiguous span separated by at least one
  ordinary clip. Honored as a default per the brief; testing overlapping hosts would be its own
  separately-motivated measurement, not folded in here.
- **The Flarex junction transition connects clip3 to Host A**, never host-to-host — placing it between two
  hosts would manufacture exactly the overlap ruled out above.

#### Corrected arithmetic (the previous draft was wrong twice)

**Correction 1 — the ceiling is not 4-hardware.** The previous draft cited `NOMINAL_CAP = 4` from
`starvation-census-probe.ts` as if it were the pool's budget. The pool's actual constants
(`preview-frame-pool.ts:89–121`) are: `MAX_WC_TOTAL_SESSIONS = 4` (both modes, the real ceiling),
`MAX_WC_SESSIONS = 3` (hardware), `MAX_WC_SOFTWARE_SESSIONS = 3`, `HARDWARE_RESERVED_SLOTS = 1` (software
may never take the last slot; effective software allowance = `min(3, 4−1) = 3`). Eviction triggers at
`totalSessions() + headroom >= MAX_WC_TOTAL_SESSIONS`, with `headroom = 0` for a playhead lease and `1`
for preload — so **a playhead acquire already evicts at a total of 4**, not above it.

**Correction 2 — the count. Host A has 3 MediaIns, and the totals are:**

| Moment | Hardware | Software | Total | vs ceiling (4) |
|---|---|---|---|---|
| Ordinary clip, steady | 1 (the clip) | 0 | **1** | fine |
| Ordinary cross-dissolve/wipe | 2 (out + in) | 0 | **2** | fine |
| **Host A steady** | 1 (host clip) | 3 (loaders, `>1` ⇒ software) | **4** | **at the eviction threshold** |
| **clip3 → Host A junction** | **2** (clip3 + A's host) | **3** (A's loaders) | **5** | **EXCEEDS — cap misses expected here** |
| Host B steady | 1 | 2 (`>1` ⇒ software) | **3** | fine |
| Host C steady | **2** (host + loader, `==1` ⇒ **hardware**) | 0 | **2** | fine |

The previous draft's "peak = 4, only during Host A's window" was wrong in two directions at once: it
understated Host A steady (4 is already *at* the eviction trigger, not comfortably under a cap) and it
omitted the junction entirely.

**Peak: 5 sessions against a ceiling of 4, at the clip3→Host A junction.** This is the only moment in the
whole timeline where an ordinary project naturally exceeds the budget, and it is therefore the single most
informative window in the run — predicted here in advance so a `capMisses` reading there is a confirmed
prediction rather than a post-hoc explanation.

**When, and for how long.** The window is longer than the transition alone: `PRELOAD_LOOKAHEAD_SECONDS`
(1.2s, `VideoPreview.tsx`) mounts the incoming clip's decoder *before* its start, and Flarex host clips are
`type: "video"` so they preroll like any other — their loaders enter `renderedLayerEntries` (and therefore
`flarexVirtualLayers`) during preroll too. So the overlap runs from **~1.2s before the junction through the
transition's own ~1–2s: a ~1.2–3.2s window** centred on the cut at ~44–46s.

#### Sampling must be fine enough to see it — this was a plan defect

- `capMisses` is **cumulative and monotonic** (`capMisses += 1`, `preview-frame-pool.ts:1610`), so it
  survives coarse sampling: a total read at the end still counts the junction's misses.
- `starvedSources` is an **instantaneous gauge** (`deniedWaiters.size`), as are `active`/`activePreload`.
  At `starvation-census-probe.ts`'s `SAMPLE_MS = 500` a 1.2s window yields 2–3 samples and a short one
  could be missed entirely. **This run therefore samples at `SAMPLE_MS = 100`**, giving 12–32 samples
  across the predicted window.
- Additionally, every gauge is recorded as a **high-water mark across the whole run**, not only as a
  per-sample series, so a peak that falls between two samples still leaves a trace in the maximum.
- The run also records the **playhead time of each sample**, so a `capMisses` increment can be attributed
  to the junction rather than merely observed somewhere in 90 seconds. An unattributable increment is a
  weaker result and is reported as such.

## 2. Cold/warm control

Stated explicitly, per the standing instruction — this is the exact confound that voided both the
original E-vs-F soak and this thread's own arm-1-vs-F re-check.

**Decision: every arm from a cold dev server.** Not warm-up-and-discard. Reasoning: a warm-up run risks
reintroducing exactly the asymmetry that caused both prior confounds — "warm" was never independently
defined or bounded in either voided run, so it's a free variable this plan doesn't need. A cold start is
mechanically checkable (kill any running `pnpm dev`, confirm no process on the dev ports, start fresh) and
needs no judgment call about how warm is warm enough.

**Procedure, stated so it's auditable after the fact, not just asserted now:**
1. Before each arm: confirm no `pnpm dev` process is running (port check), start it fresh.
2. Wait for the dev server's own ready log line before opening the browser — not a fixed sleep.
3. Build presence check before measuring (per the `flarexSwDecodeOverride` lesson already in this repo's
   history — a symbol published unconditionally, checked directly, not inferred from a neighboring one),
   confirming this run's bundle actually contains `37ed422`'s change (`__rfFlarexLoaderRate` or an
   equivalent unconditionally-published marker specific to this commit).
4. One arm = one cold start = one project load = one measurement window. No second measurement reuses a
   dev server another measurement already touched.

## 3. What is read

At minimum, the six named in the brief, all confirmed to exist on `window.__rfWcPool` /
`window.__rfWcMode` already (no new telemetry needed):

| Counter | Source | What it answers |
|---|---|---|
| `capMisses` | `__rfWcPool.capMisses` | Did any acquire ever exceed the decode budget at all. |
| `starvedSources` | `__rfWcPool.starvedSources` | How many sources are starved *right now* (a state, not a moment — this is slice A's whole point). |
| `admissionRecoveries` | `__rfWcPool.admissionRecoveries` | Did the release-path grant (slice E) actually fire. |
| `created` | `__rfWcPool.created` | Total WebCodecs sessions created — the denominator for everything else. |
| `preload` | `__rfWcPool.activePreload` | Preload-priority lease count, the counter the earlier bisect was run against (not `created`, per that decision). |
| Per-source routing | `__rfWcMode` (keyed by source URL) | Which sources are on `element` vs `webcodecs` — this is what turns a raw `capMisses` number into "which of Host A's 3 siblings lost," the actual I-48 subject. |

**Additionally, specific to this run and not in the prior probes' vocabulary:**
- `flarexConcurrentLoaders` at the moment of each `preferSoftwareDecode` decision — read via a temporary
  console/window publish added for this measurement only (mirroring how `__rfFlarexLoaderRate` is
  published), so the run can show *directly* whether the new gate (`> 1`) actually differs in outcome
  from the old one (`isFlarexVirtualLayerId` alone) on this project, not just in principle.
- Per-host grouping of `starvedSources`/routing (Host A's 3 vs Host B's 2 vs Host C's 1), since I-48's
  question is scoped to siblings on **one** host, not the project total.
- **Playhead time on every sample**, so a `capMisses` increment can be attributed to the predicted junction
  window (§1) rather than merely observed somewhere in 90 seconds.
- **High-water marks** for every instantaneous gauge (`starvedSources`, `active`, `activePreload`,
  `flarexConcurrentLoaders`) across the whole run, so a peak between two samples still leaves a trace.
- **Sample interval 100ms**, not the census probe's 500ms — see §1's sampling note; 500ms could miss the
  predicted 1.2–3.2s peak window's shape entirely.

**This publish is instrumentation, and instrumentation has outlived its run on this branch before** (the
mechanism-A/B four-counter instrument earlier in this programme, reverted only after an explicit
instruction to do so). To not repeat that: the publish lands in its **own commit**, on top of `37ed422`,
titled as measurement-only instrumentation; it is **reverted in its own commit immediately after the 3
runs are read and reported** — before this plan's findings are acted on, and before any other work lands
on top of it. If the plan is approved but the runs are not completed in one sitting, the instrumentation
commit stays un-reverted only for as long as the runs are actively in progress, never as standing state.

## 4. Vacuity guard — one reading, two scopes, kept explicitly separate

The first pass here made a mistake worth naming: it treated low `created` as voiding the whole run. It
doesn't. Low `created` is not a broken measurement — on the most likely reading, it IS the measurement:
a real project may simply not press the pool hard enough to contend at all, and that is a legitimate,
reportable finding about ordinary projects, not a failure to test anything. What low `created` DOES void
is narrower: the I-48-specific claim, because if siblings never even reached the pool together, nothing
was ever tested about whether they score identically. One number, two different questions, and the answer
to each must be written down separately so neither swallows the other after the fact.

**Scope A — the general question ("does an ordinary project contend at all"):**
- No void condition on `created` being low. **`created` low (say, ≤4, never exceeding the 4-slot cap) is
  itself the finding**, reported as: *"a project shaped like §1 does not create enough concurrent decode
  sessions to press the admission pool."* That is real information about ADR-020's premise, not a failed
  run.
- The only thing that voids Scope A is the build-presence check (§2 step 3) failing, or `created == 0`
  (nothing ever asked for anything — a broken fixture, not a quiet one).

**Scope B — I-48 specifically ("do siblings on one host score identically when they actually compete"):**
- Guard, unchanged in substance from the first pass: at least one sample where **per-source routing shows
  ≥2 of Host A's 3 MediaIns simultaneously in a non-`element` (or simultaneously denied) state.** If every
  observed event involves loaders from *different* hosts, or only ever one loader per host at a time, or
  contention never occurs at all, **Scope B is VOID** — regardless of what Scope A found.
- **Scope A and Scope B can and are expected to disagree in the most likely case**: Scope A reads "no
  contention, real projects don't press the pool" (a genuine, reportable answer) while Scope B reads VOID
  (the sibling claim was never tested) — these are not in tension, they are two different questions, and
  the pre-registered outcomes in §5 are written to keep them apart.

Both scopes are evaluated **before** the pre-registered outcomes below are applied, not folded into them.

## 5. Pre-registered outcomes

Written now, before any run. Reported as a **triple** (Scope A finding, Scope B finding, Scope C finding)
every time — never collapsed into one verdict, per §4. The three answer different questions and are
expected to diverge.

- **Scope A: `capMisses 0` / `created` low (≤4)** → reported as **"an ordinary project of this shape does
  not press the admission pool hard enough to contend"** — a real finding about ADR-020's premise, stands
  on its own regardless of what Scope B reads.
- **Scope A: `capMisses > 0`, contention did occur** → report its shape (`capMisses` count, which
  clip/host, `starvedSources` peak) without pre-committing to a size.
- **Scope B: guard satisfied** (≥2 of Host A's siblings simultaneously contending, observed at least once)
  → **report the shape** (how many siblings, routing pattern, whether `admissionRecoveries` fired) without
  pre-committing to a size; **slice B2 and the Governor get scoped and sized from that shape**, not
  designed speculatively ahead of it.
- **Scope B: guard never satisfied** (siblings never simultaneously contended, whether or not Scope A saw
  contention elsewhere) → **B2 dissolves** on the same grounds as I-49/I-50/I-54 — not "the run failed,"
  but "the condition B2 exists for did not occur even when tested for." The Governor stays unmeasured (no
  empirical basis was ever produced, by design, not by gap). **ADR-013 completes** at the C16/I-44 state
  recorded in the scope note's second amendment.
- **Neither scope reached a reading at all** (build-presence check failed, or `created == 0`) → the run
  itself is broken, not informative either way — fix the fixture and re-run before drawing any conclusion.

### Scope C — the `> 1` threshold `37ed422` shipped unmeasured

A third job this measurement did not previously have. The scope note now records ADR-013 as complete
"with one unmeasured constant" (`plans/adr-013-scope-after-adr-020.md`); this is where that constant gets
resolved. It is a **separate scope** with its own pre-registered outcomes, reported alongside A and B and
never merged into them.

The fixture isolates all three regimes deliberately: **Host C = 1 loader** (`== 1`, now **hardware** —
changed by `37ed422`), **Host B = 2** (`> 1`, software — unchanged), **Host A = 3** (`> 1`, software —
unchanged, and the case the original 2026-07-27 finding was measured at).

- **Threshold VALIDATED** — Host C's window shows its lone loader on hardware (`__rfWcMode`) with no
  starvation attributable to it: `capMisses` does not increment during C's span, the loader does not fall
  back to `element`, and no held/dropped-frame signature appears. Combined with Hosts A and B behaving as
  before, `> 1` is the right cutoff and the unmeasured constant is retired.
- **Threshold FALSIFIED** — Host C's window shows starvation attributable to the host+loader pair
  (`capMisses` increments during C's span, or the loader/host falls to `element`, or frames hold). This is
  the falsifier named in the scope note: `== 1` was **not** safe on hardware, `37ed422` regressed that
  case, and the threshold must revert to the old behaviour (`> 0`) or take a different shape. **Reported as
  a defect in shipped code, not as a plan finding**, and it takes priority over I-48/Governor conclusions.
- **Threshold UNTESTED** → VOID for Scope C specifically — Host C never mounted, its loader never reached
  a create attempt, or the `== 1` regime was never actually observed (e.g. `flarexConcurrentLoaders` read
  something other than 1 during C's window, which would itself be a finding about the count's scope).
  Scopes A and B remain reportable; Scope C is simply unresolved and the constant stays unmeasured and
  named.

**Note on what Scope C can and cannot conclude.** A clean Host C window is evidence the `== 1` case is safe
*on this machine, this GPU, this media* — not a general proof. It retires the constant from "shipped with
no evidence at all" to "shipped with one supporting observation," which is the honest description and the
one that goes in the scope note.

## 6. Run count and agreement

**3 runs minimum**, each a fully independent cold start (§2), same project file, same commit.

**What agreement must look like to be trusted:** the categorical read for EACH of the three scopes (§5)
must independently agree across all 3 runs — Scope A's verdict cannot be "no contention" once and
"contention present" twice; Scope B's cannot be "guard satisfied" once and "never satisfied" twice; Scope
C's cannot be "validated" once and "falsified" twice. The scopes are not required to agree WITH EACH OTHER
(§4 already expects A and B to diverge in the likely case) — only each scope with its own three readings.

**One exception, stated in advance:** a Scope C **falsification in any single run** is treated as a real
finding immediately, not held to 3-of-3 agreement. An intermittent starvation on the `== 1` path is still
a regression in shipped code; requiring it to reproduce three times before being believed would be the
same "prove the defect harder before we'll look at it" posture this programme has already been bitten by.
Agreement still matters for *validation* — one clean run does not retire the constant.

The *counts*
within a category are expected to vary run-to-run (a soak's own history in this programme shows this —
`releaseScanWaiters / releases = 3.0` was itself a mean across a spread) and are reported as a range, not
averaged into a single number that hides disagreement. If the categorical read disagrees across the 3
runs, that is itself a finding (contention is timing-sensitive/racy on this project) and gets a 4th and
5th run rather than being resolved by majority vote — this programme has already been burned once by
treating a confounded number as authoritative (the E-vs-F soak) and once by trusting a document over
`git log` (the slice-B collision); a disagreement here does not get papered over a third time.

---

## What building this actually takes, stated so it isn't a surprise

**Effort.** This is a scripted fixture (Playwright + `apps/worker/src/browser/editor-session.ts`'s
existing helpers), not manual UI work — the same category of effort as `starvation-census-probe.ts`, but
larger: ~14 sources across 3 hosts plus 3 transitions plus explicit sequencing/timing (§1's layout) is
meaningfully more script than that probe's flat 6-sources-on-one-track shape. Realistic estimate: a new
probe script on the order of `starvation-census-probe.ts`'s size (that file is ~400 lines), plus iteration
time getting the timeline layout to actually land where §1 specifies (transition timing in particular
tends to need a couple of passes against the real editor before it matches a written diagram) — this is a
multi-hour task, not a quick script.

**Source media.** `defaultClipPath()` already resolves real seed clips from `apps/api/storage/finals`
(prior renders sitting in local dev storage) — 230 `.mp4` files currently present there, more than enough
distinct sources for 8 ordinary clips + 5 MediaIn assets without reusing the same file past what a real
edit would (some reuse across a project is itself realistic; wall-to-wall unique sources is not required
and isn't what "real project" means here). No new media needs to be sourced or downloaded. One still image
and one text-layer asset are the only elements not already covered by that pool — trivial to add.

## What this measurement is NOT

**This is not the pre-ship visual verification pass.** It answers three narrow, specific questions —
whether I-48/slice B2 is needed, whether the Governor has any empirical basis, and whether ADR-013 is
complete as scoped — by reading admission-pool telemetry. It says nothing about whether the project
*looks* correct (pixel-compare against Remotion, `render:compare:pixels`), whether C16/I-44's fix
introduced a visible regression, or general release-readiness. That verification is separate, still owed,
and not addressed by anything in this plan.

---

**Awaiting approval before any of this is built or run**, per instruction.
