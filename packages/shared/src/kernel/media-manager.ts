/**
 * Media Manager (ADR-012 3.9, slice S3.2) — which sources EXIST.
 *
 * ## The distinction this module is built on
 *
 * A source **existing** and a source being **rendered** are different facts, and the runtime currently
 * conflates them. `VideoPreview` derives the Flarex virtual-layer set correctly (pure, from the graph),
 * and then a second memo *removes* entries from it because a comp proxy is serving those comps. After
 * that filter, the source does not exist as far as anything downstream can tell: no decoder, no
 * admission, no readiness record, no diagnostics.
 *
 * That is **I-16**: *no rendering decision may change whether a source exists — only its priority.* And
 * it has a known cost. The proxy filter is why a comp whose proxy drops out is left with neither a proxy
 * nor warm decoders: the sources were not demoted, they were deleted, so there was nothing to fall back
 * to. (The filter is not a mistake — it exists because keeping those loaders mounted cost 75→35fps. The
 * mistake is that "stop decoding this" was expressed as "this does not exist".)
 *
 * ## What this slice does, and what it does not
 *
 * S3.2 moves **ownership of the result**, not the logic. `collectFlarexVirtualLayers` stays exactly
 * where it is and stays the derivation — it was already pure and already correct. What changes is that
 * the kernel now holds the declared set, versions it, and **records every suppression** rather than
 * letting sources vanish silently.
 *
 * Suppression is still honoured, so nothing renders differently. But it is now a *named, counted state*
 * instead of an absence, which is the same move S0.2 made for lowering degradations — and for the same
 * reason: S3.5 deletes this filter in favour of demotion, and that deletion should be made against
 * evidence about how often and for how long sources actually disappear.
 *
 * ## Why the set is compared before it is stored
 *
 * The declaration is recomputed whenever the graph or the timeline changes, which during an edit is
 * every frame. Storing a fresh array each time would make every subscriber wake on every frame and turn
 * "the source set changed" into a meaningless signal. Identity is therefore the *sorted id set*, and the
 * version only moves when membership actually moves.
 */

import { kernelDiagnostics } from "./diagnostics";
import type { RuntimeSession } from "./session";

const KEY_DECLARED = "media.sources.declared";
const KEY_SUPPRESSED = "media.sources.suppressed";
const KEY_DEMOTED = "media.sources.demoted";

export interface MediaSourceDeclaration {
  /** Every source the GRAPH says exists, sorted. Never filtered by a rendering decision. */
  readonly declared: readonly string[];
  /**
   * Declared sources a rendering decision is currently choosing not to run.
   *
   * The I-16 violation, made countable rather than invisible. Empty is the goal state, reached by S3.5
   * demoting these to a lower priority instead of removing them.
   */
  readonly suppressed: readonly string[];
  /**
   * Declared sources that still EXIST, still hold their decoder, and are merely not being pulled from
   * right now — **the state that replaces suppression** (slice S3.5).
   *
   * The difference is the entire point of I-16. A suppressed source is gone: no decoder, no admission,
   * no readiness record, so when the thing that suppressed it falters there is nothing to fall back to.
   * A demoted source is a source at a lower priority: its session stays warm, its last frame stays held,
   * and restoring it is a flag flip rather than a demux, an index and a GOP window.
   *
   * This is what makes a proxy transition "a crossfade in resource terms, not a cut".
   */
  readonly demoted: readonly string[];
  /** `declared` minus `suppressed` — what actually runs today. Demoted sources are still active. */
  readonly active: readonly string[];
}

function sortedUnique(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort();
}

/** Cheap set equality for already-sorted arrays. */
function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Declare the sources the graph says exist. Idempotent: re-declaring the same membership is a no-op, so
 * a caller may call this every frame without waking anything.
 *
 * Returns whether membership changed.
 */
export function declareMediaSources(session: RuntimeSession, ids: Iterable<string>): boolean {
  const next = sortedUnique(ids);
  const prev = session.state.get<readonly string[]>(KEY_DECLARED, []);
  if (sameIds(prev, next)) return false;
  session.state.set(KEY_DECLARED, next as readonly string[]);
  return true;
}

/**
 * Record that a rendering decision is suppressing some declared sources.
 *
 * `reason` is required and free-form because "why did this source stop existing" was the question the
 * audit could not answer from any instrument. Ids not in the declared set are ignored: suppressing
 * something that was never declared is a caller bug, and silently inventing membership here would hide
 * it — the count would then disagree with the graph, which is the one thing this module must not do.
 */
export function suppressMediaSources(session: RuntimeSession, ids: Iterable<string>, reason: string): boolean {
  const declared = session.state.get<readonly string[]>(KEY_DECLARED, []);
  const next = sortedUnique(ids).filter((id) => declared.includes(id));
  const prev = session.state.get<readonly string[]>(KEY_SUPPRESSED, []);
  if (sameIds(prev, next)) return false;
  session.state.set(KEY_SUPPRESSED, next as readonly string[]);

  if (kernelDiagnostics.enabled) {
    // Only the newly suppressed are reported. Re-reporting a source that was already suppressed would
    // make the count a function of how often the caller recomputes rather than of how often a source
    // actually disappeared — and the whole point of the number is the second thing.
    for (const id of next) {
      if (prev.includes(id)) continue;
      kernelDiagnostics.record({
        kind: "denial",
        // A warning, not info: a suppressed source is invisible to admission, readiness and decoding,
        // which is the I-16 violation S3.5 retires — not a normal steady state to be at peace with.
        severity: "warn",
        subject: { kind: "source", sourceId: id },
        reason: `source-suppressed:${reason}`,
        detail: { declaredCount: declared.length, suppressedCount: next.length },
      });
    }
  }
  return true;
}

/**
 * Record that a rendering decision wants some declared sources to stop *producing* — without ceasing to
 * exist. **This is the call that replaces {@link suppressMediaSources}** (slice S3.5).
 *
 * Same declared-set discipline as suppression: a source that is not declared cannot be demoted, because
 * the kernel's view must never disagree with the graph. And the same no-re-report rule, for the same
 * reason — the count must measure how often a source was actually demoted, not how often the caller
 * recomputed.
 *
 * Reported at `info`, not `warn`. Suppression is warned about because it is the I-16 violation; demotion
 * is the fix, and recording the correct behaviour at warning level is how a channel becomes noise.
 */
export function demoteMediaSources(session: RuntimeSession, ids: Iterable<string>, reason: string): boolean {
  const declared = session.state.get<readonly string[]>(KEY_DECLARED, []);
  const next = sortedUnique(ids).filter((id) => declared.includes(id));
  const prev = session.state.get<readonly string[]>(KEY_DEMOTED, []);
  if (sameIds(prev, next)) return false;
  session.state.set(KEY_DEMOTED, next as readonly string[]);

  if (kernelDiagnostics.enabled) {
    for (const id of next) {
      if (prev.includes(id)) continue;
      kernelDiagnostics.record({
        kind: "transition",
        severity: "info",
        subject: { kind: "source", sourceId: id },
        reason: `source-demoted:${reason}`,
        detail: { declaredCount: declared.length, demotedCount: next.length },
      });
    }
  }
  return true;
}

export function getMediaSources(session: RuntimeSession): MediaSourceDeclaration {
  const declared = session.state.get<readonly string[]>(KEY_DECLARED, []);
  const suppressed = session.state.get<readonly string[]>(KEY_SUPPRESSED, []);
  const demoted = session.state.get<readonly string[]>(KEY_DEMOTED, []);
  return {
    declared,
    suppressed,
    demoted,
    active: suppressed.length === 0 ? declared : declared.filter((id) => !suppressed.includes(id)),
  };
}

/**
 * Is this source DEMOTED — declared, but deliberately not producing (S3.5)?
 *
 * Exists so a reporter can tell an intentional silence from a fault without allocating the full
 * declaration on a hot path. That distinction is I-29 and it is not decorative: the frame profiler was
 * labelling every demoted loader "decoder dropped/preempted", which is the exact opposite of what had
 * happened — the decoder was fine and had been TOLD to stop. One state read, one linear scan of a list
 * that holds a handful of ids.
 */
export function isMediaSourceDemoted(session: RuntimeSession, id: string): boolean {
  return session.state.get<readonly string[]>(KEY_DEMOTED, []).includes(id);
}

/** Subscribe to membership changes. Coalesced by the registry — see `state-registry.ts`. */
export function subscribeMediaSources(session: RuntimeSession, listener: () => void): () => void {
  const offDeclared = session.state.subscribe(KEY_DECLARED, listener);
  const offSuppressed = session.state.subscribe(KEY_SUPPRESSED, listener);
  const offDemoted = session.state.subscribe(KEY_DEMOTED, listener);
  return () => {
    offDeclared();
    offSuppressed();
    offDemoted();
  };
}

export const MEDIA_SOURCE_KEYS = { declared: KEY_DECLARED, suppressed: KEY_SUPPRESSED, demoted: KEY_DEMOTED } as const;
