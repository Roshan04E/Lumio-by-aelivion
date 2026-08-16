/**
 * Composited-frame cache — ADR-021 step 3b. After Effects' RAM Preview / Fusion's render cache.
 *
 * It holds the FINISHED COMPOSITE for a frame, keyed on `(graph content hash, t)`, so that asking for
 * a time already rendered returns the picture instead of re-running the graph. That is the whole of
 * its claim, and the claim is narrow on purpose:
 *
 *   **The win is SCRUB-BACK and LOOP, not general playback speed.** ADR-021 §7 measures composite at
 *   20.9–855.2 ms against decode's 2.8–9.0 ms at every N — the frame cache does not make a first pass
 *   over new ground any faster, because a first pass is all misses. It makes the SECOND pass over the
 *   same ground free. A param change or a rewire invalidates every entry by construction (the graph
 *   content hash moves), and that is correct rather than a limitation.
 *
 * It is a DIFFERENT OBJECT from the content-addressed artifact cache in `scene-compositor.ts`
 * (I-P7): different key, different lifetime, different granularity — that one caches a NODE's output
 * under `(ContractVersion, ContextVersion, NodeContentHash)` with no time axis, this one caches the
 * whole frame WITH a time axis. A claim proven about one does not transfer to the other; ADR-021
 * §3.2(c) exists because that transfer was made once already.
 *
 * ## Capacity, not cleverness (§3.2(c′))
 *
 * One 1080p RGBA8 frame is 7.91 MB, so a 1 GB budget holds ~129 frames — **~4.3 s of work area at
 * 1080p**. Behaviour is decided by residency: inside capacity, scrub-back and loop hit 100%; outside
 * it, the eviction policy is the entire story. Hence:
 *
 * ## I-P9 — LRU is DISQUALIFIED here, by measurement
 *
 * Looping a range is one of the two things playback actually is, and LRU on a cyclic access pattern
 * larger than capacity is the textbook worst case: it evicts precisely the frame wanted next. At a
 * 1 GB / 1080p budget (129 frames), an 8 s loop hits **0.0% under LRU and 27.6% under random**; a
 * 20 s loop, 0.0% vs 1.0%. Within capacity both are 100%, so the policy only shows itself at the
 * cliff — which is exactly where a user with a long work area lives.
 *
 * So this cache evicts at RANDOM among the frames it is allowed to touch. Note the inversion against
 * its sibling: `planArtifactEviction` uses LRU *correctly*, because a node artifact's access pattern
 * is fan-out within a frame, not a cycle across frames. Same word, opposite ruling, because the
 * access pattern is what decides — not taste, and not consistency for its own sake.
 *
 * The RNG is injected rather than read from `Math.random` so the policy is a pure function a gate can
 * pin, and so two runs of the same sweep evict the same frames.
 */

/** The retention-relevant facts about one cached frame — everything the policy may see. GL-free so
 *  the decision stays a pure function (the same split `planArtifactEviction` makes, for the same
 *  reason: this is the part that decides whether the claim holds). */
export interface FrameRetentionCandidate {
  cacheKey: string;
  bytes: number;
  /** Frame counter at the last hit or store. Used ONLY to protect the current frame (rule 1) —
   *  deliberately NOT used to rank, which is the whole of the I-P9 ruling. */
  lastAccessFrame: number;
}

/**
 * Pure retention policy for the composited-frame cache. Given every cached frame's facts and the
 * budget state, decide WHICH keys to evict.
 *
 * Rules, in order:
 *  1. Never evict a frame touched on the CURRENT frame counter — it is the one being served or stored.
 *  2. Among the rest, choose at RANDOM (I-P9). No recency ranking, no tiering.
 *  3. Stop as soon as both the byte budget and the entry cap are satisfied.
 *
 * `random()` must return [0, 1). Injected so the gate can pin a seed.
 */
export function planFrameCacheEviction(
  candidates: readonly FrameRetentionCandidate[],
  state: { frame: number; bytes: number; entries: number; budgetBytes: number; maxEntries: number },
  random: () => number,
): string[] {
  let { bytes, entries } = state;
  if (bytes <= state.budgetBytes && entries <= state.maxEntries) return [];

  // Rule 1. Copied into a mutable pool because rule 2 removes by index as it goes.
  const pool = candidates.filter((candidate) => candidate.lastAccessFrame < state.frame);

  const evict: string[] = [];
  while (pool.length > 0 && (bytes > state.budgetBytes || entries > state.maxEntries)) {
    // Rule 2: uniform choice, then swap-remove so each candidate is considered exactly once.
    const index = Math.min(pool.length - 1, Math.max(0, Math.floor(random() * pool.length)));
    const chosen = pool[index]!;
    pool[index] = pool[pool.length - 1]!;
    pool.pop();
    evict.push(chosen.cacheKey);
    bytes -= chosen.bytes;
    entries -= 1;
  }
  return evict;
}

/**
 * A small, fast, DETERMINISTIC generator (mulberry32). The point is reproducibility, not statistical
 * quality: eviction only needs "not correlated with the access order", and a seeded stream means a
 * failing sweep can be replayed exactly. `Math.random` would make every gate run a different
 * experiment, which is the void-run shape this repo keeps paying for.
 */
export function makeFrameCacheRandom(seed = 0x9e3779b9): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Observability. `staleServes` is deliberately absent: a stale serve is not a statistic to report,
 *  it is a defect the gate must make impossible — see `flarex-frame-cache-gate.ts`. */
export interface CompositedFrameCacheStats {
  entries: number;
  bytes: number;
  budgetBytes: number;
  hits: number;
  misses: number;
  stores: number;
  evictions: number;
  /** Frames the host declined to store because the picture was not settled (a source was stale or not
   *  ready). This is the counter that keeps the cache HONEST: it must be possible for a frame to be
   *  rendered and NOT cached, or the cache will eventually memoize a half-decoded picture forever. */
  declined: number;
}
