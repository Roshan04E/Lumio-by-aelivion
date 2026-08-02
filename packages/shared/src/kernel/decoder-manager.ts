/**
 * Decoder Manager (ADR-012 3.11, slice S3.3) — who decides a decode session's LIFETIME.
 *
 * ## The defect this slice retires
 *
 * Today a decoder session is created by a React effect and destroyed by that effect's cleanup. The
 * effect is keyed on `[mediaType, src]`, so **a `useMemo` recompute is a decoder teardown**: the layer
 * unmounts, `lease.release()` runs, the provider parks in a two-deep FIFO, and a comp with four loaders
 * loses two decoders outright to an eviction that had nothing to do with resource pressure. That is
 * **I-24** — *presentation policy MUST NOT change resource lifetime* — and it is the reason a comp
 * re-entering a proxy span re-demuxes and re-indexes media it was reading a frame earlier.
 *
 * ## What this module owns, and what it deliberately does not
 *
 * It owns **the decision**, and the ledger that makes the decision auditable. It does not own the
 * decoder: the decoder is a WebCodecs object, and I-36 forbids this directory from touching one. The
 * split is the same one S3.2 made — `collectFlarexVirtualLayers` stayed the derivation while the kernel
 * took ownership of the *result*. Here `preview-frame-pool.ts` stays the mechanism (sessions, sharing,
 * caps, preemption, parking) while the kernel takes ownership of *when a release actually ends a
 * session*.
 *
 * It also does NOT schedule. What an admitted session decodes next, in what order, against what
 * deadline, is the Acquisition Scheduler's concern (ADR-013 §1) and does not exist yet. That boundary
 * is the whole point of the decode-scheduling review: an S3.3 that quietly absorbed scheduling would
 * have satisfied its own completion criteria and left the defect intact.
 *
 * ## The rule, stated once
 *
 *   *A session ends when no DECLARED source needs it — never because a component stopped existing.*
 *
 * Which makes the lifetime a function of the graph (via the S3.2 declared set) rather than of React's
 * reconciliation. Two consequences that are not obvious and are both load-bearing:
 *
 * 1. **Retention is not unconditional.** A `preempted` or `failed` release is honoured immediately and
 *    can never be retained. Retaining a broken decoder means handing the next consumer the same wedge —
 *    the pool learned that the expensive way (`disposeTraced(provider, key, "preempt")` exists because a
 *    parked wedged decoder wedged its successor too). Only a *lifecycle* release is overruled.
 *
 * 2. **Retention is bounded, and its expiry is reported.** {@link DECODER_RETENTION_MS} is a residency,
 *    not a lease-for-life: a source can stay declared indefinitely while the viewer never looks at it
 *    again, and an unbounded retention would be a memory leak wearing the costume of a fix (I-31 —
 *    every wait MUST be bounded and its expiry reported).
 *
 * ## Why bindings are written by the acquirer but expired by the declaration
 *
 * The kernel cannot derive a decoder key from a source id. The key is a media URL plus a decode mode,
 * chosen at acquisition from proxy availability, GOP measurements and a software-decode preference —
 * host knowledge, and knowledge that legitimately changes under a source that never changed. So the
 * acquirer *reports* the binding.
 *
 * But the binding's LIFETIME is never the acquirer's: a binding is live exactly while its source is in
 * the declared set. If unbinding were also the acquirer's job, an unmount would remove the binding, the
 * key would look unrequired, and the release would be honoured — which is the exact coupling this slice
 * removes, reintroduced one level down. **Mounts write bindings; only the graph removes them.**
 */

import { kernelDiagnostics } from "./diagnostics";
import { getMediaSources } from "./media-manager";
import type { RuntimeSession } from "./session";

const KEY_BINDINGS = "decoder.bindings";
const KEY_OPEN = "decoder.open";

/**
 * How long a retained session may sit unused before the host must let it go.
 *
 * 4s is chosen against the thing being protected: the gap between a comp's loaders unmounting and
 * remounting is a re-render (sub-frame) or a proxy span exit and re-entry (typically well under a
 * second). Anything that has not come back in four seconds is not a reconciliation artefact, it is a
 * source the viewer has moved away from — and holding a decoder plus a GOP window for it is the cost
 * the pool's caps exist to bound.
 */
export const DECODER_RETENTION_MS = 4_000;

/**
 * Why a release was requested. This is the whole input to the decision, so it is a closed union rather
 * than a string: a new cause must be a reviewed choice about lifetime, not an incidental label.
 */
export type DecoderReleaseCause =
  /** A component/effect that was using the session went away. The one cause that may be overruled. */
  | "lifecycle"
  /** The source left the declared set — the graph no longer contains it. */
  | "undeclared"
  /** The pool reclaimed the slot for a higher-priority acquisition. Never retained. */
  | "preempted"
  /** Init failed, or a watchdog wrote the session off. Never retained. */
  | "failed"
  /** The runtime itself is going away. Never retained. */
  | "shutdown";

export type DecoderReleaseVerdict = "retain" | "release";

type Bindings = Readonly<Record<string, string>>;
type OpenCounts = Readonly<Record<string, number>>;

function bindings(session: RuntimeSession): Bindings {
  return session.state.get<Bindings>(KEY_BINDINGS, {});
}

function openCounts(session: RuntimeSession): OpenCounts {
  return session.state.get<OpenCounts>(KEY_OPEN, {});
}

/**
 * Keys that at least one DECLARED source is bound to.
 *
 * Bindings whose source is no longer declared are inert rather than deleted, for two reasons. They are
 * the evidence that a source was dropped while a decoder was still open for it — deleting them eagerly
 * would leave the `orphaned` count below unable to name what it lost. And a source that leaves and
 * re-enters the declared set is the ordinary case, not the exotic one (it is exactly what a proxy span
 * exit and re-entry does, which is S3.5), so a surviving binding makes the verdict correct again the
 * instant the source returns rather than one acquisition later.
 */
function requiredKeys(session: RuntimeSession): Set<string> {
  const declared = new Set(getMediaSources(session).declared);
  const out = new Set<string>();
  for (const [sourceId, key] of Object.entries(bindings(session))) {
    if (declared.has(sourceId)) out.add(key);
  }
  return out;
}

/**
 * Report that `sourceId` currently decodes through `key` (a media URL plus its decode mode — whatever
 * the host's session identity actually is; the kernel never parses it).
 *
 * Rejects sources the Media Manager has not declared, for the same reason `suppressMediaSources` does:
 * a caller bug must not be able to make the kernel's view disagree with the graph. Returns whether the
 * binding changed.
 */
export function bindDecoderSource(session: RuntimeSession, sourceId: string, key: string): boolean {
  if (!getMediaSources(session).declared.includes(sourceId)) return false;
  const prev = bindings(session);
  if (prev[sourceId] === key) return false;
  session.state.set<Bindings>(KEY_BINDINGS, { ...prev, [sourceId]: key });
  return true;
}

/**
 * **The decision.** Should a release request actually end the session?
 *
 * Pure with respect to the host: it reads the declared set and the bindings and returns a verdict. The
 * host is free to ignore it (the kill switch does exactly that), which is what keeps this revertible.
 */
export function decoderReleaseVerdict(
  session: RuntimeSession,
  key: string,
  cause: DecoderReleaseCause
): DecoderReleaseVerdict {
  if (cause !== "lifecycle") return "release";
  if (!requiredKeys(session).has(key)) return "release";

  if (kernelDiagnostics.enabled) {
    // A `write-off` would be wrong: nothing was discarded — this is the record of work SAVED, and of an
    // I-24 violation caught in the act. `transition` is the honest kind: a session moved from held to
    // retained without any resource decision being involved.
    kernelDiagnostics.record({
      kind: "transition",
      // `info`, not `warn`. Unlike S3.2's suppression census, this event is the invariant being
      // ENFORCED rather than breached — recording the healthy path at warning level is how a channel
      // becomes noise people learn to scroll past.
      severity: "info",
      subject: { kind: "resource", resourceKind: "decode-session" },
      reason: "decoder-retained:lifecycle",
      detail: { key, retentionMs: DECODER_RETENTION_MS },
    });
  }
  return "retain";
}

/** The host opened a real session for `key`. Counted, because a key may be opened more than once
 *  (an `exclusive` retimed loader deliberately refuses to share the host's session). */
export function noteDecoderSessionOpened(session: RuntimeSession, key: string): void {
  const prev = openCounts(session);
  session.state.set<OpenCounts>(KEY_OPEN, { ...prev, [key]: (prev[key] ?? 0) + 1 });
}

export function noteDecoderSessionClosed(session: RuntimeSession, key: string, cause: DecoderReleaseCause): void {
  const prev = openCounts(session);
  const next = (prev[key] ?? 0) - 1;
  const copy = { ...prev };
  if (next > 0) copy[key] = next;
  else delete copy[key];
  session.state.set<OpenCounts>(KEY_OPEN, copy);

  if (kernelDiagnostics.enabled && cause !== "lifecycle" && cause !== "undeclared") {
    kernelDiagnostics.record({
      kind: "write-off",
      severity: "warn",
      subject: { kind: "resource", resourceKind: "decode-session" },
      reason: `decoder-closed:${cause}`,
      detail: { key },
    });
  }
}

/**
 * A retention hit its residency deadline without the source coming back.
 *
 * Reported rather than silent because I-31 makes the EXPIRY the interesting half of a bounded wait: a
 * retention that always expires is a residency tuned wrong, and it is indistinguishable from one that
 * always pays off unless the expiry is counted.
 */
export function noteDecoderRetentionExpired(session: RuntimeSession, key: string): void {
  void session;
  if (!kernelDiagnostics.enabled) return;
  kernelDiagnostics.record({
    kind: "pressure",
    severity: "info",
    subject: { kind: "resource", resourceKind: "decode-session" },
    reason: "decoder-retention-expired",
    detail: { key, retentionMs: DECODER_RETENTION_MS },
  });
}

export interface DecoderLedger {
  /** Keys a declared source is bound to — what SHOULD hold a session. */
  readonly required: readonly string[];
  /** Keys the host reports as actually open. */
  readonly open: readonly string[];
  /** Real sessions alive, counting a key opened twice as two. */
  readonly openCount: number;
  /**
   * Open with nothing declared needing it — **the leak signal**. Non-zero after a soak settles means a
   * session outlived its requirement, which is the failure mode retention introduces and the number
   * that has to stay at zero for this slice to be safe.
   */
  readonly orphaned: readonly string[];
  /**
   * Required but not open — **the starvation signal**. Expected non-zero transiently (a session takes a
   * demux and an index to come up); persistent non-zero is a source that asked and never got one, which
   * is admission's business in S4.3 and must not be hidden by retention.
   */
  readonly unmet: readonly string[];
  /** Bindings whose source has left the declared set. These are what `orphaned` is usually named by. */
  readonly staleBindings: readonly string[];
}

/**
 * Roll the ledger up. Query path — allocates, sorts, never called per frame.
 *
 * These five numbers are what makes "session count is a function of admission alone" a thing you can
 * assert across a soak instead of a thing you believe. Before this slice the only reading available was
 * `__rfWcPool.active`, which cannot distinguish a session held because a source needs it from one held
 * because a component happened not to have unmounted yet.
 */
export function decoderLedger(session: RuntimeSession): DecoderLedger {
  const declared = new Set(getMediaSources(session).declared);
  const required = requiredKeys(session);
  const counts = openCounts(session);
  const open = Object.keys(counts).sort();
  return {
    required: [...required].sort(),
    open,
    openCount: open.reduce((total, key) => total + (counts[key] ?? 0), 0),
    orphaned: open.filter((key) => !required.has(key)),
    unmet: [...required].filter((key) => (counts[key] ?? 0) === 0).sort(),
    staleBindings: Object.keys(bindings(session))
      .filter((sourceId) => !declared.has(sourceId))
      .sort(),
  };
}

export const DECODER_KEYS = { bindings: KEY_BINDINGS, open: KEY_OPEN } as const;
