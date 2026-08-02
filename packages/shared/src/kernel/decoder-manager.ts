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
const KEY_HOLDS = "decoder.holds";

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
  const held = key in session.state.get<Readonly<Record<string, string>>>(KEY_HOLDS, {});
  if (!held && !requiredKeys(session).has(key)) return "release";

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

/**
 * A NON-GRAPH consumer holds this session (slice S3.5 amendment, from the 2026-08-02 soak).
 *
 * Not every legitimate session is backed by a declared source. The comp proxy is the standing example:
 * it decodes a rendered blob that no `MediaIn` points at, so it has a real session and no binding — and
 * the first soak duly reported every comp proxy as `orphaned`, which is the reading that was supposed to
 * mean "a session leaked".
 *
 * **That was the instrument being wrong, not the runtime.** A criterion whose false positives are the
 * normal case is worse than no criterion, because the first real leak is indistinguishable from the
 * noise it is buried in.
 *
 * A hold is deliberately NOT a declaration. Declaring the proxy as a graph source would put a second
 * writer on the Media Manager's declared set and make "which sources does the graph contain?" depend on
 * a rendering decision — the exact I-16 confusion this programme is unwinding. The proxy is a
 * *consumer of capacity*, not a member of the graph, and this is the narrower fact that says so.
 */
export function holdDecoderSession(session: RuntimeSession, key: string, holder: string): void {
  const prev = session.state.get<Readonly<Record<string, string>>>(KEY_HOLDS, {});
  if (prev[key] === holder) return;
  session.state.set(KEY_HOLDS, { ...prev, [key]: holder });
}

/** Release a hold. Idempotent — the callers that drive it are teardown paths that can fire twice. */
export function releaseDecoderHold(session: RuntimeSession, key: string): void {
  const prev = session.state.get<Readonly<Record<string, string>>>(KEY_HOLDS, {});
  if (!(key in prev)) return;
  const next = { ...prev };
  delete next[key];
  session.state.set(KEY_HOLDS, next);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Borrow grants — S3.3's observability obligation, and S4.7's evidence base
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The rule by which borrows are granted today, named so a record can say which rule produced it.
 *
 * **INHERITED, NOT ENDORSED.** S3.3 carries the existing predicate over completely unchanged: a borrow
 * is granted on decode-key identity plus decode-mode compatibility, and on nothing else. S3.3 owns
 * session *lifetime*. Whether a borrow is *safe* is a different question with a different owner —
 * ADR-012 §3.11, slice S4.7 — because answering it requires per-source requested times, which are in
 * §3.11's input set and not in §3.10's. Writing a predicate here would put half of S4.7 inside an
 * ownership migration whose whole value is being behaviour-neutral.
 *
 * The string is carried in every record so that a reader of a soak log can tell "granted by the old
 * rule" from "granted by a predicate" without diffing the pool.
 */
export const BORROW_RULE_INHERITED = "identity-match (INHERITED, not endorsed)";

/**
 * Why a participant's requested time is missing from a grant record.
 *
 * A closed union, because the honest answer to "what time did the joiner want?" is load-bearing and
 * must not decay into an unexplained `null`.
 */
export type BorrowTimeUnavailable =
  /**
   * **The interface limitation found by the 2026-08-02 S3.3 audit.** At the instant a borrow is granted
   * the joining member has not asked for anything: `AcquireOptions` carries priority, decode-mode and
   * exclusivity but no time, and `SharedMember.requestedTime` is `NaN` until the member's first
   * `getFrame`. So the pool decides sharing strictly BEFORE it can know whether the two members' times
   * co-locate.
   *
   * This is recorded rather than repaired. Adding a declared time to the acquire interface is a change
   * S4.7 needs and S3.3 must not make — it would be partial S4.7 logic wearing an instrumentation
   * costume, and the field would then carry a value the caller invented for the record's benefit. The
   * record's job is to say what was actually knowable, and this is the finding: under today's
   * interface, identity-alone is not merely the unguarded choice, it is the ONLY decision available.
   */
  | "joiner-has-not-requested-yet";

/** Why the borrow was granted — the match facts, recorded so the grant is explicable without the pool. */
export interface BorrowGrounds {
  /** Always true: a non-matching key is not offered. Present so the record is self-describing. */
  readonly keyMatched: boolean;
  /** The decode-mode compatibility check that accompanies identity (hardware/software). */
  readonly softwareCompatible: boolean;
  readonly joinerSoftware: boolean;
  readonly incumbentSoftware: boolean;
}

export interface BorrowGrant {
  /** The decode key (media URL + decode mode) both participants share. */
  readonly key: string;
  /** What the JOINER declared it will ask for. Always null today — see {@link BorrowTimeUnavailable}. */
  readonly joinerTime: number | null;
  /** Why {@link joinerTime} is null, or null when a time was genuinely supplied. */
  readonly joinerTimeUnavailable: BorrowTimeUnavailable | null;
  /**
   * What the INCUMBENT members are asking for at the moment of the grant. Non-finite entries are
   * dropped rather than coerced: a member that has not yet requested contributes no evidence, and a
   * zero in its place would be a fabricated data point in the census S4.7 is designed against.
   */
  readonly incumbentTimes: readonly number[];
  /** Incumbent members present, including those with no known time. `incumbentTimes.length` ≤ this. */
  readonly incumbentCount: number;
  readonly joinerPriority: string;
  readonly incumbentPriority: string;
  readonly grounds: BorrowGrounds;
  /** Always {@link BORROW_RULE_INHERITED} while S4.7 is unwritten. */
  readonly rule: string;
}

const KEY_BORROWS = "decoder.borrows";
/**
 * Bounded. This is a census, not a journal — an unbounded one would be a memory leak inside the module
 * whose subject is memory leaks, and the questions asked of it ("does a preload ever join a serving
 * session?") are answered by a sample, not by an exhaustive history.
 */
const MAX_BORROW_RECORDS = 64;

/**
 * Record that a session was BORROWED. **Records; does not judge.**
 *
 * WHY THIS IS S3.3's JOB. The revised *done when* asks S3.3 for "every borrow grant recorded with both
 * participants' requested times", and that ordering is deliberate: a satisfaction predicate written
 * before anyone has measured which borrows actually occur would be a guess with a flag on it. The
 * 2026-08-02 finding — a preload source joining a *serving* session at `capMisses: 0`, costing the
 * on-screen clip two hardware resets and ~295ms of supply 1.2s before a cut — was a single observation
 * on a single fixture. This turns it into a census, across whatever topologies a soak happens to reach.
 *
 * It changes nothing. No caller consults it, no allocation happens on a non-borrow path, and the
 * predicate that produced the grant is untouched upstream.
 */
export function noteBorrowGrant(
  session: RuntimeSession,
  grant: {
    key: string;
    incumbentTimes: readonly number[];
    incumbentCount: number;
    joinerPriority: string;
    incumbentPriority: string;
    grounds: BorrowGrounds;
  }
): void {
  const record: BorrowGrant = {
    key: grant.key,
    // Not inferred, not defaulted, not back-filled from the incumbent. See BorrowTimeUnavailable.
    joinerTime: null,
    joinerTimeUnavailable: "joiner-has-not-requested-yet",
    incumbentTimes: grant.incumbentTimes.filter((time) => Number.isFinite(time)),
    incumbentCount: grant.incumbentCount,
    joinerPriority: grant.joinerPriority,
    incumbentPriority: grant.incumbentPriority,
    grounds: grant.grounds,
    rule: BORROW_RULE_INHERITED,
  };
  const prev = session.state.get<readonly BorrowGrant[]>(KEY_BORROWS, []);
  session.state.set(KEY_BORROWS, prev.length >= MAX_BORROW_RECORDS ? [...prev.slice(1), record] : [...prev, record]);
  kernelDiagnostics.record({
    kind: "transition",
    severity: "info",
    // Same subject the rest of this module uses for sessions — a borrow is a decode-session event, and
    // giving it a private subject kind would split the decoder's diagnostics across two identities.
    subject: { kind: "resource", resourceKind: "decode-session" },
    reason: "borrow-granted",
    detail: {
      rule: BORROW_RULE_INHERITED,
      joinerPriority: grant.joinerPriority,
      incumbentPriority: grant.incumbentPriority,
      incumbentCount: grant.incumbentCount,
      joinerTime: null,
      joinerTimeUnavailable: "joiner-has-not-requested-yet",
    },
  });
}

/** Every borrow this session has granted, oldest first (bounded). Query-path only — allocates. */
export function borrowGrants(session: RuntimeSession): readonly BorrowGrant[] {
  return session.state.get<readonly BorrowGrant[]>(KEY_BORROWS, []);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Session satisfaction (slice S4.7) — CAN this session serve the new requirement without harming
// the one it already serves?
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Why a session can or cannot satisfy a requirement. A closed union because every answer is a declared
 * observable state (I-29): a refusal costs a decode session, and a cost with no stated reason is exactly
 * the undeclared degradation this slice removes — just pointed the other way.
 */
export type SatisfactionReason =
  /** No incumbent has requested anything yet, so there is no service to degrade. */
  | "no-incumbent-demand"
  /** The joiner wants what the session is already serving; one decode feeds both. */
  | "co-located"
  /** Granting would make one decoder serve two distinct moments — a seek per member per frame. */
  | "would-diverge"
  /** The joiner did not declare what it will ask for, so safety is unprovable. */
  | "joiner-undeclared";

export interface SatisfactionVerdict {
  readonly satisfies: boolean;
  readonly reason: SatisfactionReason;
  /** Widest distance between the joiner and any incumbent, or null when not computable. */
  readonly gapSeconds: number | null;
  /** The tolerance the decision was made against — the caller's, echoed so a log is self-explaining. */
  readonly toleranceSeconds: number;
}

/**
 * **The S4.7 decision.** Can `incumbentTimes`' session also serve `joinerTime` without degrading the
 * service it already provides?
 *
 * ## Why the Decoder Manager and not Admission
 *
 * ADR-012 §3.11 owns sharing and is the only subsystem whose ***In*** carries "per-source requested
 * times (post-retime)". §3.10's does not. Admission can grant *capacity*; it constitutionally cannot
 * choose *which session satisfies a grant*, because it cannot see the times that make one session
 * interchangeable with another. That is the whole reason this is a slice and not the second half of
 * S4.3.
 *
 * ## The criterion is BORROWED FROM THE BACKSTOP, deliberately
 *
 * `tolerance` is the caller's own divergence tolerance — the same number `isDiverged` uses to decide a
 * live share has broken. Inventing a second threshold here would have been easy and would have quietly
 * destroyed the slice's *done when*: "`noteDivergence` fires zero times across a full soak" is only a
 * meaningful assertion if the predicate refuses **exactly** what the backstop would later detach. With
 * one shared criterion, a firing is a proof that this function was wrong about a specific pair of
 * times — which is precisely the inversion the programme asks for in §10, where repair becomes
 * diagnostics.
 *
 * ## The four answers, and why each is what it is
 *
 * - **No incumbent demand → GRANT.** A session whose members have not yet asked for anything has no
 *   service to protect. This is not an edge case: two layers mounting in the same tick is the single
 *   most common real share, and it is *the* case sharing was built for — one file read as both the host
 *   clip and a comp's MediaIn. A predicate that refused here would spend the sessions sharing exists to
 *   save, which is this slice's stated risk.
 * - **Co-located → GRANT.** Both want the same moment; one decode feeds both, which is the entire win.
 * - **Would diverge → REFUSE.** One decoder dragged between two playheads is a seek — a whole GOP — per
 *   member per frame. Measured 2026-08-02: a `preload` joiner joined a *serving* session at
 *   `capMisses: 0` — spare capacity, harmful reuse — and cost the on-screen clip two hardware resets and
 *   ~295ms of supply, 1.2s before a cut. Refusing sends the joiner to its own session or its `<video>`
 *   fallback, which is the path it already takes when the pool is full.
 * - **Joiner undeclared → REFUSE.** Not a judgement about the joiner but an admission about us: with no
 *   declared time, safety is unprovable, and granting anyway would restore the unguarded borrow under a
 *   flag that claims to have fixed it. Refusing makes a missed call site visible as a lost share rather
 *   than silent as a resurrected defect. (Before S4.7 this was the ONLY answer available — the acquire
 *   interface carried no time at all; see the 2026-08-02 S3.3 audit.)
 *
 * Pure. Takes times rather than reading them, so it is testable without a pool, a decoder or a DOM —
 * and so that the host keeps ownership of where a "requested time" comes from (I-36).
 */
export function sessionSatisfaction(
  incumbentTimes: readonly number[],
  joinerTime: number | null,
  toleranceSeconds: number
): SatisfactionVerdict {
  const known = incumbentTimes.filter((time) => Number.isFinite(time));
  if (known.length === 0) {
    return { satisfies: true, reason: "no-incumbent-demand", gapSeconds: null, toleranceSeconds };
  }
  if (joinerTime == null || !Number.isFinite(joinerTime)) {
    return { satisfies: false, reason: "joiner-undeclared", gapSeconds: null, toleranceSeconds };
  }
  let gapSeconds = 0;
  for (const time of known) gapSeconds = Math.max(gapSeconds, Math.abs(time - joinerTime));
  return gapSeconds <= toleranceSeconds
    ? { satisfies: true, reason: "co-located", gapSeconds, toleranceSeconds }
    : { satisfies: false, reason: "would-diverge", gapSeconds, toleranceSeconds };
}

const KEY_REFUSALS = "decoder.borrowRefusals";

/**
 * Record a borrow REFUSED, with the same care the grant record takes.
 *
 * A refusal is a real cost — it spends a decode session out of a budget of four — so it must be as
 * visible as the harm it prevents. Without this, the failure mode of a too-strict predicate (this
 * slice's stated risk) would present as unexplained cap misses somewhere else entirely.
 */
export function noteBorrowRefused(
  session: RuntimeSession,
  refusal: { key: string; verdict: SatisfactionVerdict; joinerPriority: string; incumbentPriority: string }
): void {
  const prev = session.state.get<readonly BorrowRefusal[]>(KEY_REFUSALS, []);
  const record: BorrowRefusal = {
    key: refusal.key,
    reason: refusal.verdict.reason,
    gapSeconds: refusal.verdict.gapSeconds,
    toleranceSeconds: refusal.verdict.toleranceSeconds,
    joinerPriority: refusal.joinerPriority,
    incumbentPriority: refusal.incumbentPriority,
  };
  session.state.set(KEY_REFUSALS, prev.length >= MAX_BORROW_RECORDS ? [...prev.slice(1), record] : [...prev, record]);
  kernelDiagnostics.record({
    kind: "denial",
    // INFO, not warn: a refusal is the slice working. The warning-level event in this area is
    // `noteDivergence` firing, which after S4.7 means this predicate got one wrong.
    severity: "info",
    subject: { kind: "resource", resourceKind: "decode-session" },
    reason: `borrow-refused:${refusal.verdict.reason}`,
    detail: {
      gapSeconds: refusal.verdict.gapSeconds,
      toleranceSeconds: refusal.verdict.toleranceSeconds,
      joinerPriority: refusal.joinerPriority,
      incumbentPriority: refusal.incumbentPriority,
    },
  });
}

export interface BorrowRefusal {
  readonly key: string;
  readonly reason: SatisfactionReason;
  readonly gapSeconds: number | null;
  readonly toleranceSeconds: number;
  readonly joinerPriority: string;
  readonly incumbentPriority: string;
}

export function borrowRefusals(session: RuntimeSession): readonly BorrowRefusal[] {
  return session.state.get<readonly BorrowRefusal[]>(KEY_REFUSALS, []);
}

/**
 * The backstop fired: a live share broke that the predicate had approved. **After S4.7 this is a defect
 * report, not a routine correction** (programme §10) — it is the assertion that `sessionSatisfaction`
 * was right, and a firing says it was wrong about a specific pair of times.
 *
 * `noteDivergence` stays in the code and stays instrumented for exactly this reason. The slice's *done
 * when* is that this counter reads zero across a full soak.
 */
export function noteSatisfactionMiss(session: RuntimeSession, key: string, detail: Record<string, unknown>): void {
  const prev = session.state.get<number>("decoder.satisfactionMisses", 0);
  session.state.set("decoder.satisfactionMisses", prev + 1);
  kernelDiagnostics.record({
    kind: "degradation",
    // WARN, and the only warning in this area: after S4.7 a divergence detach means a share this module
    // approved had to be torn down under load — an incumbent was degraded exactly as the slice promised
    // it would not be.
    severity: "warn",
    subject: { kind: "resource", resourceKind: "decode-session" },
    reason: "satisfaction-miss:divergence-detach",
    detail: { ...detail, key },
  });
}

export function satisfactionMisses(session: RuntimeSession): number {
  return session.state.get<number>("decoder.satisfactionMisses", 0);
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
  /** Open sessions held by a non-graph consumer (the comp proxy). Legitimate, and never orphaned. */
  readonly held: readonly string[];
  /**
   * Required but not open — **the starvation signal**. Expected non-zero transiently (a session takes a
   * demux and an index to come up); persistent non-zero is a source that asked and never got one, which
   * is admission's business in S4.3 and must not be hidden by retention.
   */
  readonly unmet: readonly string[];
  /** Bindings whose source has left the declared set. These are what `orphaned` is usually named by. */
  readonly staleBindings: readonly string[];
  /**
   * Borrows granted, oldest first (bounded). **Observability only** — nothing consults this to make a
   * decision, and S4.7 is the slice that will.
   *
   * On the ledger rather than behind a separate accessor because a borrow is a statement about session
   * lifetime — the incumbent's session now outlives the joiner's independent need for one — and reading
   * it beside `open`/`orphaned`/`unmet` is what lets "session count is a function of admission alone" be
   * checked against the sessions that were never allocated because they were borrowed instead.
   */
  readonly borrows: readonly BorrowGrant[];
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
  const holds = session.state.get<Readonly<Record<string, string>>>(KEY_HOLDS, {});
  const open = Object.keys(counts).sort();
  return {
    required: [...required].sort(),
    open,
    held: Object.keys(holds).sort(),
    openCount: open.reduce((total, key) => total + (counts[key] ?? 0), 0),
    // A held key is accounted for, so it is not orphaned. Without this every comp proxy read as a leak
    // and the criterion that was supposed to catch a real one caught only itself.
    orphaned: open.filter((key) => !required.has(key) && !(key in holds)),
    unmet: [...required].filter((key) => (counts[key] ?? 0) === 0).sort(),
    staleBindings: Object.keys(bindings(session))
      .filter((sourceId) => !declared.has(sourceId))
      .sort(),
    borrows: borrowGrants(session),
  };
}

export const DECODER_KEYS = { bindings: KEY_BINDINGS, open: KEY_OPEN } as const;
