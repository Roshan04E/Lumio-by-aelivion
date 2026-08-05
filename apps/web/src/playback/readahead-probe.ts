/**
 * READ-AHEAD PROBE (S0 of `plans/preview-readahead-ring.md`) — measurement only, no behaviour change.
 *
 * The ring plan's own gate, quoted: *"This slice decides whether the rest is worth building — if
 * headroom is already negative on the founder's machine, a ring buys ordering, not smoothness, and
 * that changes the pitch."* So this module exists to answer ONE question before any ring is built:
 *
 *   **Can the decoders deliver more frames per second than playback consumes?**
 *
 * If yes, that surplus is what a ring converts into a lead, and the plan is sound. If no, a ring can
 * never fill — it would inherit the deficit and buy only ordering and bounded failure, which is a
 * different (smaller, still real) pitch that the founder should get to judge before the work starts.
 *
 * ── Why it measures at the COMPOSITE, not at `getFrame` ──────────────────────────────────────────
 * The obvious hook is `requestWcFrame`'s completion, but that only sees the WebCodecs pull path — and
 * the 2026-07-29 pause measurements (tracker v33d) found the editor's host clip on the `element` path
 * the whole time, because a freshly imported original has no ingest proxy and `preferNativeDecode`
 * wins. Instrumenting `getFrame` would have measured an empty seam and reported a confident zero.
 * `ScenePreviewMediaSnapshot` is the layer where both decode paths look the same, so that is where
 * this reads. Delivery is counted from a CHANGE IN `servedSourceTime`, not from `frameVersion`:
 * the version counts publishes, and the WebCodecs path republishes on every completed request
 * including ones that returned the frame it already held. Counting publishes read 43.5
 * "delivered/s" from a 30fps source — impossible on its face, and it flipped the verdict.
 *
 * ── The pull path's structural signature, which this exists to make visible ───────────────────────
 * `lead` is how far a source has decoded BEYOND the playhead. In a pull design nothing is ever
 * requested before it is needed, so lead can never be positive — it is 0 when keeping up and negative
 * when behind. A ring's whole purpose is to make that number positive. Recording it now gives the
 * before-picture for exactly the axis the ring is supposed to move.
 *
 * Inert unless `?previewRing=probe`. Read with `window.__rfReadahead.report()`.
 */

/** Resolution order: `?previewRing=probe` → localStorage `orreris.previewRing` → OFF. */
export function isReadaheadProbeEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const q = new URLSearchParams(window.location.search).get("previewRing");
    if (q != null) return q === "probe" || q === "1";
    return window.localStorage?.getItem("orreris.previewRing") === "probe";
  } catch {
    return false; // SSR / restricted storage
  }
}

/** One source's state in a single composite. Everything here is already on the media snapshot. */
export interface ReadaheadSample {
  id: string;
  /** Monotonic per-source counter; an increment since the last composite means a frame arrived. */
  frameVersion: number;
  /** Timeline seconds this source is BEHIND the requested moment; null = time-invariant/unknowable. */
  stalenessSeconds: number | null;
  /** True when the source has no decode at all for this moment (staleness is unmeasurable, not 0). */
  awaiting: boolean;
  decodeMode: string | null;
  label: string | null;
  /** The source's own frame rate when known — its delivery CEILING. Null = unknown. */
  nominalFps: number | null;
  /**
   * Source seconds the held frame represents. A CHANGE here is a genuinely new decoded frame;
   * `frameVersion` alone counts republishes of the same moment and inflates delivery.
   */
  servedSourceTime: number | null;
}

interface SourceState {
  label: string | null;
  decodeMode: string | null;
  lastFrameVersion: number;
  /** Last DISTINCT served source time — the basis for counting real frames, not republishes. */
  lastServedSourceTime: number | null;
  /** Composites in which a genuinely new frame arrived — the numerator of delivered fps. */
  advances: number;
  composites: number;
  /** Composites with no new frame while the source was behind: a ring read that would have missed. */
  emptyReads: number;
  /** Most negative lead seen (deepest deficit), in timeline seconds. */
  worstLeadSeconds: number;
  firstMs: number;
  lastMs: number;
  /** Highest nominal fps seen for this source — its delivery ceiling. 0 = never reported. */
  nominalFps: number;
}

export interface SourceHeadroom {
  id: string;
  label: string | null;
  decodeMode: string | null;
  /** Frames actually delivered per second of wall time. */
  deliveredFps: number;
  /**
   * TRUE demand: `min(composite rate, source fps)`.
   *
   * Capping at the source's own rate is what makes the headroom figure honest. The compositor runs at
   * display rate (~44/s observed), but a 30fps source can never deliver more than 30 new frames/sec —
   * the extra composites redraw a frame that is still correct. Measuring against the raw composite
   * rate overstated the deficit four-fold (25.5 vs 44.3 = −18.8/s, when the shortfall against the
   * source's own ceiling is −4.5/s), and that number is the one gating whether the ring gets built.
   * Falls back to the composite rate when the decode path cannot report fps (the `<video>` element
   * exposes no such API), so an unknown ceiling degrades to the old pessimistic reading rather than
   * a fabricated optimistic one.
   */
  demandFps: number;
  /** The raw composite rate, kept so the two readings can be compared rather than swapped silently. */
  compositeFps: number;
  /** The source's reported ceiling; null when the decode path cannot report one. */
  nominalFps: number | null;
  /** deliveredFps − demandFps. POSITIVE is the surplus a ring would convert into a lead. */
  headroomFps: number;
  /** Deepest deficit, seconds. Never positive in a pull design — see the module header. */
  worstLeadSeconds: number;
  emptyReadPct: number;
  composites: number;
}

const sources = new Map<string, SourceState>();
let compositeCount = 0;
let windowStartMs = 0;
/** Last composite's timeline time, for the transport-jump detector in noteReadaheadComposite. */
let lastTimelineSeconds: number | null = null;
let lastJumpMs: number | null = null;
/** How long after a transport jump the lead statistic stays suppressed. */
const JUMP_SETTLE_MS = 1500;

/**
 * Record one composite. Call once per present with every media source that participated.
 *
 * Cheap by construction: a map lookup and a few numeric compares per source, no allocation on the
 * steady path. Still gated by {@link isReadaheadProbeEnabled} at the call site so an un-flagged
 * session pays nothing at all.
 */
export function noteReadaheadComposite(
  samples: readonly ReadaheadSample[],
  nowMs: number,
  timelineSeconds?: number
): void {
  if (samples.length === 0) return;
  if (windowStartMs === 0) windowStartMs = nowMs;
  compositeCount += 1;
  // TRANSPORT JUMP DETECTION. `lead` is meaningless across a seek: rewinding the ruler 13s makes
  // every source instantly "13s behind" without any decoder having done anything wrong, and that
  // number then reads as the worst deficit of the session (observed: worstLead −13.267s, which was
  // the gate's own Home keypress). A jump larger than a few frames is a ruler move, not a decode
  // failure, so the lead sample for that composite is skipped.
  if (
    timelineSeconds != null &&
    lastTimelineSeconds != null &&
    Math.abs(timelineSeconds - lastTimelineSeconds) > 0.25
  ) {
    lastJumpMs = nowMs;
  }
  if (timelineSeconds != null) lastTimelineSeconds = timelineSeconds;
  // Skip the whole SETTLING WINDOW, not just the jump composite. Gating only the jump frame left the
  // artifact intact (worstLead still −13.4s): after a 13s rewind the source stays legitimately far
  // behind for many composites while it re-decodes, and none of those are "jumps" themselves. A ring
  // would be refilling across exactly that window too, so it is not a decode deficit either.
  const jumped = lastJumpMs != null && nowMs - lastJumpMs < JUMP_SETTLE_MS;
  for (const s of samples) {
    let st = sources.get(s.id);
    if (!st) {
      st = {
        label: s.label,
        decodeMode: s.decodeMode,
        lastFrameVersion: s.frameVersion,
        lastServedSourceTime: s.servedSourceTime,
        advances: 0,
        composites: 0,
        emptyReads: 0,
        worstLeadSeconds: 0,
        firstMs: nowMs,
        lastMs: nowMs,
        nominalFps: 0,
      };
      sources.set(s.id, st);
    }
    if (s.nominalFps != null && s.nominalFps > st.nominalFps) st.nominalFps = s.nominalFps;
    st.composites += 1;
    st.lastMs = nowMs;
    st.decodeMode = s.decodeMode ?? st.decodeMode;
    st.label = s.label ?? st.label;
    // A genuinely NEW frame = the served moment changed. Fall back to the publish counter only when
    // the path cannot report a served time (a still, or a decoder that does not stamp one), where a
    // republish is the best signal available. See `ScenePreviewMediaSnapshot.servedSourceTime`.
    // Quantise the served time to the source's FRAME GRID before comparing. Raw equality is not
    // enough: the WC path stamps `sourceTime - lag`, and both terms drift continuously, so the same
    // decoded frame reports a slightly different served time on every republish. That float wobble
    // still read 39.1 "delivered/s" from a 30fps source after the first fix. Snapping to 1/fps is
    // what makes "a different frame" mean a different FRAME.
    const grid = st.nominalFps > 0 ? st.nominalFps : 0;
    const bucket = (t: number | null): number | null =>
      t == null ? null : grid > 0 ? Math.round(t * grid) : t;
    const nowBucket = bucket(s.servedSourceTime);
    const lastBucket = bucket(st.lastServedSourceTime);
    const advanced =
      nowBucket != null && lastBucket != null
        ? nowBucket !== lastBucket
        : s.frameVersion !== st.lastFrameVersion;
    if (advanced) st.advances += 1;
    st.lastFrameVersion = s.frameVersion;
    if (s.servedSourceTime != null) st.lastServedSourceTime = s.servedSourceTime;
    // Lead is the negation of staleness: behind by X ⇒ lead −X. `awaiting` has no measurable
    // distance (no served frame exists to compare), so it counts as an empty read but must not
    // enter the lead statistic — the same rule temporal-coherence.ts applies to staleness.
    const behind = s.awaiting ? null : s.stalenessSeconds;
    if (!jumped && behind != null && -behind < st.worstLeadSeconds) st.worstLeadSeconds = -behind;
    // A ring READ would have missed here: no new frame this composite, and the held one was not
    // the frame this moment wanted. With a ring, this is exactly the "ring empty → repeat last
    // frame" case, so the count is the honest upper bound on how often a ring would still stutter.
    if (!advanced && (s.awaiting || (s.stalenessSeconds ?? 0) > 0.001)) st.emptyReads += 1;
  }
}

export function readaheadHeadroom(): SourceHeadroom[] {
  const out: SourceHeadroom[] = [];
  for (const [id, st] of sources) {
    const seconds = Math.max(0.001, (st.lastMs - st.firstMs) / 1000);
    const deliveredFps = st.advances / seconds;
    const compositeFps = st.composites / seconds;
    // TRUE demand is capped by the source's own rate: asking a 30fps source 44 times a second cannot
    // make it produce 44 distinct frames, and the composites in between redraw a frame that is still
    // correct. Without this cap the deficit was overstated four-fold (see `demandFps`).
    const demandFps = st.nominalFps > 0 ? Math.min(compositeFps, st.nominalFps) : compositeFps;
    out.push({
      id,
      label: st.label,
      decodeMode: st.decodeMode,
      deliveredFps,
      demandFps,
      compositeFps,
      nominalFps: st.nominalFps || null,
      headroomFps: deliveredFps - demandFps,
      worstLeadSeconds: st.worstLeadSeconds,
      emptyReadPct: st.composites > 0 ? (st.emptyReads / st.composites) * 100 : 0,
      composites: st.composites,
    });
  }
  return out.sort((a, b) => a.headroomFps - b.headroomFps);
}

export function resetReadaheadProbe(): void {
  sources.clear();
  compositeCount = 0;
  windowStartMs = 0;
  lastTimelineSeconds = null;
  lastJumpMs = null;
}

/**
 * The S0 verdict, in the plan's own terms.
 *
 * Deliberately states a conclusion rather than only numbers: the plan gates the whole ring build on
 * this reading, and "headroom is −3.2fps" is not a decision until someone says what it implies.
 */
export function readaheadReport(): void {
  const rows = readaheadHeadroom();
  if (rows.length === 0) {
    console.warn("[readahead] nothing recorded — is ?previewRing=probe set, and did the viewer composite?");
    return;
  }
  console.group("%c[readahead] S0 — can the decoders build a lead?", "font-weight:bold");
  console.table(
    rows.map((r) => ({
      source: r.label ?? r.id.slice(-14),
      decode: r.decodeMode ?? "-",
      "delivered/s": Number(r.deliveredFps.toFixed(1)),
      "demand/s": Number(r.demandFps.toFixed(1)),
      "headroom/s": Number(r.headroomFps.toFixed(1)),
      "worst lead s": Number(r.worstLeadSeconds.toFixed(3)),
      "empty read %": Number(r.emptyReadPct.toFixed(1)),
      composites: r.composites,
    }))
  );
  const worst = rows[0]!;
  if (worst.headroomFps > 1) {
    console.log(
      `%cSURPLUS: every source delivers more than playback consumes (worst +${worst.headroomFps.toFixed(1)}/s). ` +
        `That surplus is what a ring converts into a lead — the plan's premise holds.`,
      "color:#3a3"
    );
  } else if (worst.headroomFps > -1) {
    console.log(
      `%cBREAK-EVEN: the worst source is delivering almost exactly what it consumes ` +
        `(${worst.headroomFps.toFixed(1)}/s). A ring would fill only while nothing else competes — ` +
        `expect it to buy ordering and bounded failure, not much smoothness.`,
      "color:#c80"
    );
  } else {
    console.log(
      `%cDEFICIT: the worst source cannot even keep up (${worst.headroomFps.toFixed(1)}/s), so a ring ` +
        `can never fill. It would still buy ORDERING and BOUNDED failure — but not smoothness, and ` +
        `the plan's pitch changes. Decide before building S1.`,
      "color:#c33"
    );
  }
  console.log("lead is ≤ 0 by construction in a pull design (nothing is decoded before it is asked for) — that is the number a ring exists to make positive.");
  console.groupEnd();
}

if (typeof window !== "undefined") {
  Object.defineProperty(window, "__rfReadahead", {
    configurable: true,
    get: () => ({
      enabled: isReadaheadProbeEnabled(),
      composites: compositeCount,
      headroom: readaheadHeadroom(),
      report: readaheadReport,
      reset: resetReadaheadProbe,
    }),
  });
}
