/**
 * Settle window vs. frame completion (ADR-012 slice S2.2) — the flag, and the pure decisions.
 *
 * ## What the settle window is, and why it is a guess
 *
 * After any change the viewer keeps compositing for `SCENE_SETTLE_MS` (600ms), because async work — a
 * graded media frame, a text raster, a font load — may still be arriving and nothing tells the viewer
 * when it has all landed. The number is a guess at "long enough". It is the same guess five separate
 * timeouts in this runtime make, and ADR-012 I-30/I-31 exist because a bounded wait whose expiry is
 * indistinguishable from its success cannot be reasoned about: when the window closes, the viewer does
 * not know whether it closed because everything arrived or because time ran out.
 *
 * S2.1 gave frames identity. This slice gives them **completion**, so the window can be replaced by an
 * answer: composite until a frame *settles* — presents with no stale source and no unready layer — and
 * then stop, because there is provably nothing left to wait for.
 *
 * ## Why this ships measuring before it ships switching
 *
 * Collapsing the window is only safe if every async producer re-arms it on arrival (`requestDraw`).
 * Most do — a late raster explicitly does. But "most" is not a property, and the failure mode of being
 * wrong is a frame that never repaints, which is worse than a frame that repaints too often.
 *
 * So the flag is **off by default** and the instrument runs in **both** states. With the flag off we can
 * measure exactly what turning it on would have broken: {@link classifyComposite} labels every
 * settle-window composite, and the label that decides the question is `load-bearing` — a composite that
 * was NOT settled, in a window that had NOT been re-armed since the last settlement. Every one of those
 * is a repaint that closing the window would have lost. **Zero of them across a real soak is the
 * evidence that flipping the flag is safe**; a non-zero count names the producer that fails to re-arm,
 * which is a bug to fix rather than a reason to keep guessing.
 *
 * This is the same discipline the coherence barrier was held to (`temporal-coherence.ts`): do not
 * retire a mechanism, or adopt one, on anything but a measurement taken in a sound rig.
 */

/**
 * Is completion allowed to CLOSE the settle window? Flag (repo convention): `?kernelFrames=1` →
 * localStorage `orreris.kernelFrames` → **OFF**.
 *
 * Exclusive, per the programme: with it on the window is owned by the completion signal, with it off by
 * the timer. Never both — two mechanisms driving one window is regression G5, and the whole point is
 * that there be one answer to "is this frame done".
 *
 * Measurement is independent of the flag, so `?kernelFrames=0` still gives a fully instrumented
 * comparison run rather than a blind one.
 */
export function getFrameCompletionEnabled(): boolean {
  const truthy = (v: string | null | undefined): boolean => v === "1" || v === "true";
  if (typeof window !== "undefined") {
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.has("kernelFrames")) return truthy(params.get("kernelFrames"));
      const stored = window.localStorage?.getItem("orreris.kernelFrames");
      if (stored != null) return truthy(stored);
    } catch {
      /* SSR / restricted storage — fall through */
    }
  }
  return false;
}

