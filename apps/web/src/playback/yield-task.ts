/**
 * MACROTASK YIELD for the preview frame-request loop (2026-07-28).
 *
 * ── Why this exists ──────────────────────────────────────────────────────────────────────────────
 * `preview-frame-pool` builds preview providers with `frameBudgetMs: 24` so no single `getFrame`
 * blocks the main thread for seconds. That bounds LATENCY per call. It does not bound OCCUPANCY:
 * `WebglMediaLayer::requestWcFrame` re-enters from inside its own resolved promise when a scrub tick
 * arrived mid-flight, and a promise callback is a MICROTASK — it runs before the event loop gets a
 * turn. So the next ≤24ms decode begins immediately, and 3–4 concurrent sources doing that add up to
 * ~100% main-thread occupancy while every individual call is honestly inside its budget.
 *
 * Measured (production build, low-end machine, scrubbing during playback): `STALL 2641ms` with
 * `88× getFrame < requestWcFrame` and `60× requestWcFrame` — ~1.6s of JS in a 2.6s window. The tab
 * goes unresponsive with no Chrome unresponsive prompt, because nothing is technically hung; the
 * event loop is simply never idle.
 *
 * A per-call budget is not a rate limit. Anything that re-enters on completion needs a real yield
 * between units.
 *
 * ── Why MessageChannel, not setTimeout(0) ────────────────────────────────────────────────────────
 * Browsers clamp nested timeouts to ~4ms. At preview cadence that clamp is a large fraction of the
 * frame budget itself, so `setTimeout` would convert an occupancy problem into a throughput problem —
 * a long catch-up decode would spend most of its time idle waiting on the clamp. `MessageChannel`
 * posts a genuine macrotask with no clamp: the event loop (input, rAF, timers, decoder output
 * callbacks) gets its turn, and the next decode starts as soon as that turn is over.
 *
 * This mirrors the private helper in `export/webcodecs-decoder.ts` rather than importing it: that
 * file is listed in `RENDER_FINGERPRINT_SOURCES` (vite.config.ts), so touching it would change the
 * render-pipeline fingerprint and invalidate every cached proxy span for a change that alters no
 * pixels. Two MessageChannels cost nothing; a repo-wide proxy rebuild is not free.
 */
export const yieldTask: () => Promise<void> = (() => {
  if (typeof MessageChannel === "undefined") {
    return () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  const channel = new MessageChannel();
  let pending: Array<() => void> = [];
  channel.port1.onmessage = () => {
    // Swap first: a callback that schedules another yield must land in the NEXT batch, never extend
    // the one being drained (that would rebuild the starvation this module exists to prevent).
    const callbacks = pending;
    pending = [];
    for (const callback of callbacks) callback();
  };
  return () =>
    new Promise<void>((resolve) => {
      pending.push(resolve);
      channel.port2.postMessage(0);
    });
})();
