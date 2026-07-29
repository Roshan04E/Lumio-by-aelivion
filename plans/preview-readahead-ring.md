# Preview read-ahead ring — replacing the retry class, not the decoder

- Status: **Proposed** (nothing built)
- Written: 2026-07-29
- Prompted by: v32w–v33b in `project-tracker/playback-preview.md` — five preview-decode bugs found in
  one week, all in the same seam, all fixed correctly, none of which stopped the next one arriving.

---

## 1. The problem, stated as a class rather than a list

Preview media is **pull**: once per displayed frame the compositor asks each source
`provider.getFrame(sourceTime)`, one decode in flight per source (`wcBusyRef`), and if the answer is
late the LAYER decides what to do about it.

That last clause is the whole problem. "Late" has no structural answer in a pull design, so it becomes
a *policy*, and a policy needs thresholds:

| Constant | Question it guesses at |
|---|---|
| `WC_HOLD_LAG_S` | how far behind before the picture should hold |
| `WC_HOLD_MAX_MS` | how long a hold may last before degrading |
| `WC_SUSTAINED_HOLD_BAIL_MS` | when a hold means the source is unservable |
| `WC_DIVERGE_LAG_S` / `WC_DIVERGE_MAX_MS` | when lateness is catastrophic rather than slow |
| `WC_PAUSED_STALE_LAG_S` / `_MAX_MS` | the same three questions again, paused |
| `SHARE_DIVERGENCE_STRIKES` | when two sharers of a session want different times |
| `wcTolerateRetryRef` backoff | how fast to re-probe a source that yields nothing |

Every one of those is correct for the conditions it was tuned against. **A single new condition — a 2×
retime — falsified four of them at once**, and each looked like an independent bug:

- v32w decoder sharing inverted (two consumers, different times, one decoder → seek per member per frame)
- v32x software decode can't sustain rate × demand
- v32y self-driven retry paced by the event loop, not the display (~70 publishes per composite)
- v32z lag measured in SOURCE seconds compared against a VIEWER tolerance (wrong by ×rate)
- v33a the request had no upper clamp, so lag grew unbounded past media end → 658,265 holds,
  `scheduleWcRerequest` 53 of 71 samples in a 1.6s main-thread block

The fixes are all right and all shipped. But each one is *"make the pull path survive one more
condition"*, and there is no reason to think the list is finished.

### The four structural costs

1. **The decoder only works when asked.** Between requests it idles. Capacity that could have built a
   lead is discarded. Invisible at 1× on an easy source; there is no reserve when demand rises.
2. **Decode latency is on the critical path.** The displayed frame is decoded *after* it is needed.
3. **Failure is unbounded work.** A retry loop has no ceiling. A ring read has one: it either has a
   frame or it does not.
4. **N sources multiply it.** Each pulls independently, contends for a 4-session pool, and holds its
   own opinion of lateness. Keeping them on the same moment needed a separate coherence gate.

### What push replaces it with

The decoder runs **ahead** on its own schedule into a bounded ring of decoded frames. Playback reads
the ring. "Late" becomes "the ring is empty" and the answer is "repeat the last frame" — one rule, no
thresholds, nothing to retry. Coherence becomes structural: read the same index from every ring.

Prior art (researched 2026-07-29): Avid's off-speed playback patent describes reading whole GOPs into a
compressed-data buffer, building a **frame ring** over it, and playing from the ring.

---

## 2. Scope decision — the thing that must not be got wrong

**A ring is only good at SEQUENTIAL PLAYBACK.** Scrubbing, seeking, paused editing and thumbnail passes
are random access, which is what pull is genuinely good at. The same Avid patent describes a *second
stateless single-frame decoder* for off-speed and random access **alongside** the sequential one.

So:

> **The ring JOINS the pull path for playback. It does not replace it.**

Net machinery goes UP, not down. The win is confined to playback — which is exactly where every bug in
§1 lives, so that is the right trade. A plan that says "replace `getFrame`" is the wrong plan and
should be rejected.

**Non-goals:** export (already correct, already sequential, already gated), scrub/seek, paused settle,
node thumbnails, the comp-proxy path.

---

## 3. Decisions required BEFORE code (founder input)

### D1 — Frame memory budget
Each pinned decoded frame is ~6MB GPU-side. This repo has scar tissue: 32 pinned frames alongside the
compositor's render targets exhausted the GPU process → lost WebGL context → black export tail
(see the `OUTPUT_MAX` note in `webcodecs-decoder.ts`).

A 1s lead × 4 sources at 60fps is ~240 frames. Not affordable. The ring depth must be a **budget in
bytes, shared across all rings**, not a frame count per source.

Options: (a) fixed global cap (~12–16 frames total, dynamically split by source count);
(b) proportional to `previewQuality` resolution; (c) adaptive from measured decode headroom.
**Recommendation: (a) to start** — a constant that can be measured and raised, not a heuristic to debug.

### D2 — Where the ring lives
Main thread (simplest, shares the existing pool + lease lifecycle) vs a worker (true parallel decode,
but frame transfer and the `VideoFrame` transferability question, and it duplicates pool ownership).
**Recommendation: main thread first.** The existing pool, preemption, and lease teardown are all
main-thread and correct; moving them is a separate project.

### D3 — Who owns the ring
Per `SharedSession` in `preview-frame-pool.ts` (so sharers get it for free, and it dies with the
session) vs per layer in `WebglMediaLayer`. **Recommendation: per session** — sharing is already
solved there, and v32w's `exclusive` flag already distinguishes the retimed case.

---

## 4. Slices

**S0 — Instrument the current path (no behaviour change).**
Publish per-source: decode headroom (decodes/sec achievable vs needed), current lead (source seconds
decoded beyond the playhead), and ring-would-have-been-empty count. Ship OFF behind
`?previewRing=probe`. **This slice decides whether the rest is worth building** — if headroom is
already negative on the founder's machine, a ring buys ordering, not smoothness, and that changes the
pitch.

**S1 — Ring behind a flag, playback only.**
A bounded `FrameRing` on `SharedSession`: fill-ahead loop driven by the existing rAF pace, `read(t)`
returning the nearest frame at-or-before `t`, hard byte budget from D1. `WebglMediaLayer` reads the
ring while `isPlaying`, falls to today's `getFrame` path otherwise. Default OFF (`?previewRing=1`).

**S2 — Retire the thresholds the ring makes unreachable.**
With the ring live, `WC_HOLD_LAG_S`, the hold-streak machinery and the tolerant-retry backoff have no
job **during playback**. Delete them from that path only; the paused/scrub path keeps them.
*This is the actual payoff slice.* If it cannot be done, the ring did not replace the class and S1
should be reverted rather than carried as a second mechanism.

**S3 — Coherence by index.**
Replace the staleness-based present gate with "every ring has frame ≥ i" during playback. Keep
`temporal-coherence.ts` for the paused path.

**S4 — Flip the default**, after a soak on the founder's real project with 3–4 sources and a retime.

---

## 5. Gates

- `wcpool:test` — ring depth budget honoured; a ring never outlives its session; sharers read one ring.
- `coherence:test` — the index barrier must reproduce the existing multi-source results (5666 checks).
- `fullres:test`, `gop:test` — unchanged (random-access paths untouched).
- `render:compare:pixels` — must stay at flarex 0.000%; the ring is preview-only, so ANY pixel movement
  means it leaked into a renderer path. **Note `flarex-generators` is a known flaky fixture**
  (86.9% ↔ 0.000%, raster-readiness race, bisected to before TimeSpeed — do not read it as a signal).
- Live: `?flarexProfile=1` frame-delivery block shows all sources `advancing`, and the per-source frame
  version increments ~1 per composite (v32y: a spinning source showed ~70).

---

## 6. Explicitly NOT in this plan

- Replacing `getFrame` as the seam. See §2.
- Moving decode to a worker. See D2.
- Export, scrub, paused settle, thumbnails, comp proxy.
- Any change to `RENDER_FINGERPRINT_SOURCES` files without checking `apps/web/vite.config.ts` first —
  editing one invalidates every cached proxy span.

---

## 7. Reading order for whoever picks this up

1. `project-tracker/playback-preview.md` v32w → v33b (the five bugs, in order, with the evidence).
2. `apps/web/src/playback/preview-frame-pool.ts` — sessions, sharing, leases, preemption, `exclusive`.
3. `apps/web/src/components/WebglMediaLayer.tsx` `requestWcFrame` — the pull loop and every threshold.
4. `apps/web/src/export/webcodecs-decoder.ts` — the sequential/seek decision and the memory warnings.
5. `apps/web/src/playback/temporal-coherence.ts` — the staleness model S3 would replace during playback.
