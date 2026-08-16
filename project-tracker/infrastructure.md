# Infrastructure / build / service worker

## v1 — Dev and build are separate browser-storage universes (2026-07-06)
**Problem:** "Works in dev, broken in build" confusion: `:5173` (dev) and `:4173` (vite preview)
have separate localStorage AND separate OPFS/IndexedDB — proxies, flags, and local media built on
one origin do not exist on the other. First session on the build origin rebuilds proxies (paused).
**Fix:** understanding + the cold-origin "Optimizing media" toast. Not a bug — expected behavior.

## v2 — Service worker served stale bundles across fixes (2026-07-06)
**Problem:** Two "the fix didn't work" reports were the OLD CacheFirst service worker serving
pre-fix chunks (and it intercepts module-worker chunk fetches too — span/transcode workers).
**Fix:** JS/wasm runtime caching CacheFirst → NetworkFirst (vite.config.ts): deployed bytes always
win when the server is reachable; cache is only the offline/deleted-chunk fallback.
**Rule:** before believing any "not fixed" on `:4173`, check the console's `index-*.js` hash against
the latest build output; if stale → DevTools → Application → Service Workers → Unregister → reload ×2.

## v3 — The stylize pixel-gate failures are not a regression; the baseline was never reproducible (2026-08-01)
**Problem:** `render:compare:pixels` fails two fixtures — `stylize-ink` 7.857%, `stylize-subject`
8.014%, both against a 3.5% bar — and `stylize-print` sits at 3.261%, passing only because it is a
quarter-point under the bar. The committed `tmp/render-comparison/summary.json` records all three at
0.049–0.068%, so this reads exactly like a regression introduced by one of the 35 commits since the
2026-07-28 re-baseline (`5648643`).

**It is not.** Established by measurement, not inference, in this order:
1. Working tree stashed → clean `HEAD` reproduces **7.857% / 8.014% exactly**. Not the uncommitted work.
2. `dc5ba40` ("Full quality" / ingest-proxy split — the strongest suspect, since a proxy-vs-original
   swap would soften the source and high-frequency effects would diverge first) → same numbers. Its
   parent `e6911ea` → same numbers.
3. **`5648643` itself — the commit whose own summary.json records 0.068% — reproduces 7.857%.**

A commit cannot regress against itself. No commit on this branch caused it, and bisecting further is
wasted effort: the "good" anchor is not good on this machine.

**What the diff actually shows** (`diff-stylize-ink.png`): stochastic red speckle confined to the ink
effect's hatch bands, with flat regions completely clean. Both renderers therefore produce the bands
in the same places — what differs is the per-pixel stipple *inside* them. That is a dither/hatch
pattern seeded differently between the web preview and Remotion. It is NOT a sharpness difference (no
edge halos), NOT a colour shift (no uniform delta), and NOT run-to-run flake (five runs returned
`162930` differing pixels, identical every time — deterministic on each side, disagreeing across).

The family behaves exactly as that explanation predicts: `stylize` (Kuwahara, no stochastic term)
0.001%; `stylize-print` (halftone) 3.261%; `stylize-ink` (hatching) 7.857%; `stylize-subject` 8.014%.
Diff magnitude tracks how much of the effect is stochastic.

**Conclusion:** cross-renderer parity for the stylize family was never robust — it was *incidental*,
holding on whatever machine recorded the baseline because the two seeds happened to agree there. The
gate has been reporting a parity it does not have.

**Rule — the one worth carrying:** a recorded baseline is evidence that a number was once observed,
never that the code produces it. Before treating a gate failure as a regression, re-run the fixture at
the baseline commit itself. Two of the three "obvious" suspects here were disproved by one such run,
and the third was disproved by the anchor.

**Not fixed — deliberately.** Two honest options, and the choice is a product/QA call rather than an
architectural one: (a) seed the stipple deterministically from shared frame time so both renderers
agree by construction — real parity, and the only option that makes the fixtures meaningful; or
(b) give the stylize family explicit per-fixture bars, as `3737ef3` already did for `flarex-generators`
and `advanced-transition`, whose comment is explicit that loose fixtures "stay loose rather than
quietly exempted — they need the slack for uninvestigated reasons and that debt should stay visible."
Option (b) is one line and unblocks the gate; option (a) is the actual fix. Do not silently raise the
global bar: 3.5% was already sized for the loosest fixture, and widening it again would re-create the
exact blindness `3737ef3` was written to remove.

## v4 — `fract(sin())` is not a hash; it was the stylize parity failure (2026-08-01)
**Problem:** the v3 investigation established the stylize failures were not a regression and pointed
at "a dither pattern seeded differently between renderers". The seed was never the issue — the HASH
was. Both the fragment-effect harness and the transition harness defined, byte-identically:

    float _rand(vec2 co){ return fract(sin(dot(co.xy, vec2(12.9898, 78.233))) * 43758.5453); }

For a 1080×1920 frame `_rand(floor(uv * uResolution))` feeds `dot` values around 164000. One highp
ULP at that magnitude is ~0.016 while sin's period is 2π≈6.28, so a single ULP of input error moves
the phase ~0.25% of a cycle; ×43758 and `fract` leaves pure noise in the low bits. GLSL does not
specify sin's range-reduction, so two conformant implementations legitimately disagree — and the web
preview and the Remotion renderer go through different backends. Deterministic on each side (five
runs, exactly 162930 differing pixels), divergent across them.

**Fix:** one shared `packages/shared/src/color/glsl-hash.ts` exporting `GLSL_HASH_PRELUDE` — a 32-bit
integer avalanche hash, inputs quantized to a 1/256 grid. GLSL ES 3.00 specifies `uint` as exactly 32
bits with defined wraparound and shifts, so the result is bit-identical on every conformant device;
no transcendental can promise that. Both harnesses now import it instead of each carrying a copy.

**Measured (same run, before → after):**

    stylize-ink        7.857%  →  0.146%     (bar 3.5%)
    stylize-subject    8.014%  →  0.203%
    stylize-print      3.261%  →  0.080%
    advanced-transition 3.131% →  2.810%     (improved unasked — same root cause)
    stylize / grain / transition                unchanged at 0.001% / 0.001% / 0.000%
    → full sweep: 53/53 PASS, the first green gate on this branch

**Rule:** `fract(sin(dot(...)))` is a *pattern generator*, not a hash, and it must never be used
anywhere two renderers are compared. Any value that has to agree across devices must be built from
integer arithmetic, which is specified, rather than from a transcendental, which is not. The same
applies to any future noise, dither, jitter or stipple.

**Second rule (why it lived here, not in two files):** a parity-critical definition must have exactly
one home. Two byte-identical copies is one edit away from transitions drifting from effects — the
same bug at one remove.

**Left open, deliberately:** (1) the stylize fixtures now measure 0.080–0.203% against a 3.5% bar, so
they should get tight per-fixture bars in the `3737ef3` style — but from an observed sweep with real
headroom, not from this single run. (2) `flarex-generators` is FLAKY, not loose: it read 86.895% in
one sweep and 0.000% on the next two. 86.895% is the documented signature of a generator producing
nothing, i.e. a readiness race at capture time, and it is unrelated to the hash. It needs its own
investigation — a fixture that fails catastrophically one run in three is not a gate.

## v5 — `flarex-generators` never becomes ready; the 250 ms sleep was hiding it (2026-08-03)

**Problem:** `flarex-generators` fails the pixel gate at 86.895% in roughly 40% of runs, on the same
commit, on a clean machine. v4 left this open as "a readiness race at capture time" and it was
repeatedly mistaken for a regression in whatever was being worked on that day — it cost most of a
session on ADR-012 S4.5 before being pinned down.

**Root cause:** two separate defects that looked like one.

1. *The gate never asked whether the picture existed.* `PreviewFixturePage.tsx` renders
   `data-render-fixture="ready"` as a **string literal** on the section, so it is true the moment
   React mounts and says nothing about painting. The only wait for GPU output was
   `page.waitForTimeout(250)`. The readiness contract for a pixel comparison was React mount plus
   elapsed wall-clock.
2. *The frame genuinely never settles.* Instrumenting the present ledger at capture time gives a
   clean separation across 8 runs: passing runs report `settled yes / 3 composites / notReady 0`;
   failing runs report **`NEVER` settled / 2 composites / notReady 2**, and stay that way through a
   full 10-second poll AFTER capture. The picture does not arrive late — it does not arrive. Two
   layers never become ready and the compositor stops re-compositing.

So the sleep is not the bug; it is what hides the bug, successfully about 60% of the time.

**Fix:** none yet for (2) — logged here so it stops being re-discovered. For (1), `PIXEL_READY_OBSERVE=1`
(commit `6d57179`) reports the ledger's verdict at capture: composites, participants, not-ready
layers, time-to-settle, and Flarex fallback causes. Deliberately NOT yet enforced as a bounded fatal
wait: while (2) exists, a fatal wait converts a 40% flaky failure into a 40% deterministic one.
Enforcement is gated on (2) being fixed, not on the harness.

**Verify:** 25-pair interleaved A/B, HEAD vs ADR-012 S4.5/S4.6, single fixture, alternating arms —
**10/25 failures on both arms, Fisher exact p = 1.0**. Interleaved rather than blocked because the
suspect is a timing race and any drift across the run (thermal, caches, process accumulation) would
otherwise land entirely on whichever arm ran second and manufacture a difference. That result is what
cleared the implementation; the fixture flakes identically without it.

**Two measurement traps this cost, both worth remembering:**

- *An instrument inside the window it measures.* The first version of the observation read the ledger
  BETWEEN the settle sleep and the screenshot. `page.evaluate` is a round-trip, so it widened the race
  and produced 6 passes in 6 runs against a 40% base rate. It failed by producing CLEAN data, which is
  why it was nearly accepted as proof the fix worked. Any read that crosses into the page must happen
  after the shutter.
- *A trend read off five samples.* Mid-sweep the drift check showed both arms falling 60%→0% and a
  shader-cache warm-up mechanism was proposed for it. By the end it had reversed (25%→54%). A decline
  that becomes an incline is noise. The drift check was right to exist; believing it at n=5 was not.

**Not the cause, ruled out with evidence:** orphaned Chromium processes (71 of them, real but
unrelated), the `fract(sin())` hash of v4, and ADR-012 S4.5/S4.6.

## v6 — defect (1) fixed with a readiness gate; defect (2) does not reproduce (2026-08-13)

**Fix for (1).** `render-pixel-comparison.ts` gained `awaitCaptureReadiness`, called where the blind
`page.waitForTimeout(250)` used to be the ONLY wait: it polls the same present ledger `v5`'s own
`PIXEL_READY_OBSERVE` instrument reads, for the same "settled" condition (a composite on record with
`notReady === 0`), bounded at 10s (`CAPTURE_READY_POLL_BUDGET_MS`, same figure `v5`'s post-capture
poll already used). The 250ms sleep is UNCHANGED and still runs — but now strictly after readiness is
confirmed, as the GPU-present buffer it was always documented as (a different, narrower race: content
logically settled a frame or two before the GPU has actually painted it — see the comment at the call
site). This costs ordinary fixtures nothing: they are already settled by the time the fonts/images wait
above finishes, so the first poll returns immediately. `flarex-generators` is the one fixture that
actually waits, for as long as it genuinely needs (measured 5.9-13s below).

If the poll times out unsettled, the gate now logs which fixture, how long it waited, and that the diff
comparison below is expected to fail loudly as a result — so a real failure is attributable at read
time instead of costing another investigation like this one.

**Defect (2) — "the frame genuinely never settles" — does NOT reproduce, on the same instrument and
the same bound that caught it.** This is reported as non-reproduction, not as a fix: nothing was
changed that specifically targets it, and no cause is claimed. Evidence:

- 6 isolated single-fixture runs (`PIXEL_FIXTURES=flarex-generators`, `PIXEL_READY_OBSERVE=1`):
  settled at 5.9s-13.0s every time (the 13s outlier was a cold vite/shader-compile run), zero
  `neverSettled`.
- 3 full 76-fixture sweeps, post-fix, default settings: `flarex-generators` read **0.000%
  (0/2073600)** every time — the same reading the ORIGINAL v5/v3 investigations already got on their
  clean runs, now reproduced with the gate actually asserting readiness rather than racing it.
- The discriminating fact: v5's `neverSettled` reading was not a slow settle — it was measured against
  a FULL 10-second poll (the same bound this fix now uses to GATE capture) and still never arrived.
  If defect (2) still existed today, this fix's own bound would have hit it and logged a TIMED OUT
  line at least once across 9 runs. It did not, on any run.
- No specific commit is named as the cause. Plausible candidates in the 10 days since v5 include the
  DEBT-009/DEBT-013 admission and liveness fixes and the ADR-012 slices that landed in between, but
  none of them was written against this symptom and attributing it to one would be a guess.

**Re-registration trigger, not a close-and-forget:** the readiness gate's own TIMED-OUT log line is
now the instrument. If `flarex-generators` (or any fixture) ever prints it again, defect (2) is back,
attributed to whichever run produced the line, and this entry re-opens with that evidence rather than
starting from "a readiness race at capture time" a third time.

**Bar tightened.** `flarex-generators` moved off the loose global 3.5% bar onto 0.005 (same tier as
its `flarex-*` siblings), on the 3 clean 0.000% sweeps above. `advanced-transition` — unrelated,
untouched — stays on the loose bar.

**Verify:** `pnpm --filter @orreris/worker typecheck` clean. 3 consecutive full `render:compare:pixels`
sweeps (`PIXEL_BROWSER_CHANNEL=chrome`), 76/76 passing each time, `flarex-generators` at 0.000% in all
three.

---

## render:baseline — two text fixtures are irreproducible in a FULL sweep and clean when narrowed (v1, 2026-08-16)

**Symptom.** A full `render:baseline` reports the picture CHANGED for exactly two fixtures,
`text-warp` and `multi-stroke`, at 3/2073600 and 0–1/2073600 pixels. Running those same two fixtures
via `BASELINE_FIXTURES=text-warp,multi-stroke` reports both **unchanged**, repeatably.

**It is not a code change, and here is why that is a conclusion rather than a hope.**

1. **The reading is unstable across runs.** `multi-stroke` read **0** differing pixels in one full
   sweep and **1** in the next, against the same baseline, on render code that did not change between
   them (the only commits in between add preflight checks and touch no render path). A deterministic
   code change cannot produce two different diffs from the same inputs.
2. **The shape of the diff is wrong for a code change.** A raw byte comparison finds 18 differing
   bytes in `text-warp` and 2 in `multi-stroke`, every one of them **±1 in a single channel**, and
   all of them scattered on antialiased glyph edges — e.g. `(334,762) ch0 16→17`,
   `(540,831) ch0 194→195`. A code change moves a coherent REGION. This is last-significant-bit
   rasterizer rounding. (The gate reports 3 rather than 18 because `pixelmatch` applies a perceptual
   threshold; the two numbers are consistent with each other.)
3. **Two consecutive narrowed runs are byte-clean**, so the fixtures are capable of matching.

**The discriminating variable is the SWEEP, not the fixture**: identical inputs pass cold and
narrowed, and flag inside a long run. Process age, GPU state accumulated across ~85 prior renders, or
driver-level scheduling are all consistent with it; none has been measured, and no cause is claimed.

**DO NOT "fix" this by re-capturing the baseline.** That is the one action that makes it permanent:
a capture taken while the noise is live freezes it into the REFERENCE, where every later run inherits
it and no re-run can find it. `render-baseline-gate.ts`'s capture loop now carries that warning at the
line where it would happen.

**It VOIDS the sweep; it is not subtracted.** The founder's standing rule (2026-08-16, and the reason
a separate session lost a night to a noise floor) is that a noise floor voids a run rather than being
netted out. So the correct statement about the S9a batch is **"83 of 85 fixtures byte-identical, 2
irreproducible"** — NOT "83/85 passed". The zero-tolerance claim is not available on this machine
until this is closed, and the S9a stage's own no-move evidence rests instead on `textstyle:golden`
(103 emitted styles, 4 added, **0 changed**) and on `font:axis-falsifier`'s absent-==-face-default arm.

**Re-registration trigger.** If a full sweep ever reports these two fixtures with a STABLE pixel count
across two consecutive runs, this stops being noise and becomes a real regression to bisect. If a
third fixture joins them, the cause is spreading and this entry re-opens with that run as evidence.

**Not investigated:** whether this predates S9a. A worktree at `5601ab9` plus a full sweep would
settle it, and was not spent — the three lines of evidence above already exclude a code change, and a
fresh worktree's first sweep is a documented throwaway (vite pre-bundle), so the run would have cost
two sweeps rather than one.

## render:baseline — the noise is NOT sweep-length-dependent; v1's discriminator does not hold (v2, 2026-08-16)

**v1 is not withdrawn. Its conclusion — this is not a code change — survives intact. Its MODEL of when
it fires does not.** v1 said "the discriminating variable is the SWEEP, not the fixture": identical
inputs pass narrowed and flag inside a long run. Two readings taken during S9 contradict that, in both
directions.

**1. A FULL sweep came back completely clean.** `render:baseline` unbatched over the whole set at S9,
on a preflighted machine (0 automation browsers, 242 GB free): **85 of 85 checked fixtures
byte-identical, 0 irreproducible.** `text-warp` and `multi-stroke` — the two v1 is about — both report
`unchanged` inside a ~85-fixture sweep, which is exactly the condition v1 predicts they flag in.

**2. A NARROWED run flagged.** `cluster-text`, S9's new fixture, captured at `d46ed61b2753` and then
run twice via `BASELINE_FIXTURES=cluster-text`:

    verify run 1   CHANGED    3/2073600 pixels (0.000%)
    verify run 2   unchanged

Same code, same baseline, same narrowing, consecutive. v1 predicts a narrowed run is clean; this one
was not, and its magnitude is the same 3/2073600 `text-warp` shows.

**What this changes.** The instability is **run-to-run and independent of sweep length**. Nothing about
process age or accumulated GPU state across ~85 prior renders is required to explain it, and v1's three
candidate causes were offered as consistent-but-unmeasured — this reading removes the one they had in
common. No cause is claimed here either. What is now established is narrower and more useful: **a
single byte-clean run is not evidence a fixture is stable, at any scope.** Two consecutive runs are the
minimum, which is the discipline that found this at all.

**`cluster-text` is a third fixture with the signature, and that does NOT trip v1's re-registration
trigger.** The trigger reads "if a third fixture joins them, the cause is spreading". This one is a
fixture whose baseline was captured TODAY, so it is new coverage landing on an existing floor rather
than the floor reaching into coverage that used to be clean. Stated explicitly because the trigger is
written to be acted on by someone who was not here, and "three fixtures now" is the wrong reading.

**The baseline entry was KEPT, not dropped, and not re-captured.** Re-capturing to launder run 1's
reading is the forbidden action (v1) and was not taken. Dropping the entry to keep the gate quiet is
the same laundering wearing the other hat: it would remove the stage's own fixture from the only
zero-tolerance instrument in the repo. It stays, with this entry as the record of what it does.

**The cost this imposes, said plainly.** The text programme has now put ~20 glyph-edge fixtures into a
zero-tolerance gate, and glyph edges are where subpixel AA is least stable. Every one is a candidate
for this floor. That is a real and growing drag on the gate's signal, and it is the reason S9's
load-bearing evidence is deliberately NOT the picture gate: its tiling invariant is arithmetic
(`cluster:model`, where a one-pixel gap is exactly representable and an AA wobble is not) and its
at-rest equality is a hash comparison of a memcpy, which has no floor to sit on.

**Correct statement of S9's sweep**, in the form the founder's noise-floor rule requires: **85 of 85
checked byte-identical, 0 irreproducible** — and, separately, **7 fixtures were NOT CHECKED because
they have no baseline** (`cluster-text` before this capture, plus `liquid-morph-transition`,
`portal-transition`, `motion-smear-transition` and their three `linear-` twins). Those six transition
fixtures are pre-existing unbaselined coverage, are not S9's, and were deliberately left alone: a
blanket `--capture` would have registered six references nobody has looked at.
