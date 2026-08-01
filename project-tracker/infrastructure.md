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
