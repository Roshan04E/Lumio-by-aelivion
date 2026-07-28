/**
 * ATOMIC FULL-RES SWAP (2026-07-28) — a paused viewer sharpens ALL of its sources at once, or none.
 *
 * ── The symptom this fixes ───────────────────────────────────────────────────────────────────────
 * A Flarex comp with three `MediaIn` sources visibly "filled in" one clip at a time while paused.
 * The cause is not decoding and not temporal coherence: it is the FULL-RES SETTLE path (user rule
 * 2026-07-05). ~300ms after the transport parks, each layer independently leases the ORIGINAL bytes
 * (not the ~854px ingest proxy) and native-seeks them, swapping itself in the moment its own `seeked`
 * fires. Seek latency on original media depends on GOP structure, resolution and codec, so N sources
 * sharpen at N different moments — exactly "every clip is different".
 *
 * ── Why no time-based barrier could ever have caught it ──────────────────────────────────────────
 * The proxy frame and the settled frame represent the SAME requested time. `stalenessSeconds` reads
 * ~0 on both sides of the swap, so `temporal-coherence.ts` is structurally blind to it. That module
 * gates WHEN a frame is for; this one gates WHICH RESOLUTION every source is showing. Two different
 * axes, and the symptom lives on this one. Match the barrier's axis to the axis of the symptom.
 *
 * ── Ownership ────────────────────────────────────────────────────────────────────────────────────
 * The producer OFFERS its upgrade (`ScenePreviewMediaSnapshot.fullResFrame` / `fullResPending`) and
 * keeps serving the proxy frame; the compositor — the only thing that knows the whole participating
 * set — decides when everyone has one. Pure and framework-free so it can move to the ADR-008
 * evaluation engine unchanged, like `temporal-coherence.ts` beside it.
 *
 * ── Why waiting here is cheap, unlike the coherence hold ─────────────────────────────────────────
 * Nothing is ever WITHHELD. The proxy frame is on screen throughout, so the only cost of waiting is
 * staying soft slightly longer — no held present, no frozen viewer, no latency added to anything the
 * user is looking at. That is why this barrier can ship ON while the coherence hold ships OFF.
 */

/**
 * How long to wait for every source before sharpening with whatever has arrived.
 *
 * Sized from the settle path's own documented worst case: "a sparse-GOP 4K original may take 1–3s to
 * sharpen in". A budget under that would routinely fire the hatch on exactly the heavy material this
 * exists to keep in step — turning the atomic swap back into the staggered one — while far above it a
 * genuinely wedged source keeps the whole viewer soft.
 */
export const FULL_RES_RENDEZVOUS_MAX_MS = 3000;

export interface FullResRendezvousState {
  /** Participants that expect an upgrade but do not have one yet. */
  pendingCount: number;
  /** Participants holding a ready upgrade. */
  readyCount: number;
  /** Wall time the current pending episode began; null when nobody is pending. */
  pendingSinceMs: number | null;
  nowMs: number;
  budgetMs?: number;
}

export interface FullResRendezvousDecision {
  /** Should the viewer use every available full-res frame on the next composite? */
  commit: boolean;
  /** True when `commit` was forced by the budget rather than by everyone arriving. */
  viaHatch: boolean;
  /** The pending-episode clock to carry into the next frame. */
  pendingSinceMs: number | null;
}

/**
 * Decide whether the viewer commits to full-res this frame.
 *
 * - **Commit** when nobody is pending and at least one upgrade exists.
 * - **Withdraw** the moment anyone goes pending again — transport movement invalidates every settle
 *   frame at once, so all sources must fall back to their proxy together, just as atomically as they
 *   upgraded. A one-way latch would leave stale full-res pixels on screen after a scrub.
 * - **Hatch** when someone has been pending past the budget while others are ready, so one source
 *   that can never seek cannot keep the whole viewer soft forever.
 *
 * `readyCount > 0` guards both paths: with nothing to swap to there is nothing to commit, and a
 * viewer of sources that never produce upgrades (stills, generators, clips whose proxy IS the
 * original) simply never engages this at all.
 */
export function decideFullResRendezvous(state: FullResRendezvousState): FullResRendezvousDecision {
  const { pendingCount, readyCount, nowMs } = state;
  const budgetMs = state.budgetMs ?? FULL_RES_RENDEZVOUS_MAX_MS;
  const pendingSinceMs = pendingCount > 0 ? (state.pendingSinceMs ?? nowMs) : null;
  if (pendingCount === 0) {
    return { commit: readyCount > 0, viaHatch: false, pendingSinceMs: null };
  }
  const waitedMs = nowMs - (pendingSinceMs ?? nowMs);
  const viaHatch = readyCount > 0 && waitedMs >= budgetMs;
  return { commit: viaHatch, viaHatch, pendingSinceMs };
}
