/**
 * Flarex event trace - ONE time-ordered log across the seams that today only have snapshots.
 *
 * WHY THIS EXISTS. Everything needed to explain "adding a node blacks the viewer" is already measured
 * somewhere: `__rfSourceMap` has per-source decode state, `__rfWcPool` has the session census,
 * `__rfRouting` has the element/pool decision, `__rfFlarexDegradation` has the compiler's own reasons.
 * They are keyed on four different identities and none of them carries a clock, so answering "what
 * happened, in what order, when I added the node" means joining four snapshots by eye and guessing at
 * the ordering. Two sessions have now produced incompatible causal stories from exactly that join.
 *
 * This records TRANSITIONS instead: an event is written only when an observed value actually changes,
 * so a node add plus ten seconds of playback is a readable page rather than 600 frames of noise.
 *
 * OFF BY DEFAULT, and the disabled cost is one boolean read - no polling timer is even created. Arm it
 * with `?flarexTrace=1` on the editor URL, or `__rfFlarexTrace.on()` from the console at any time.
 *
 * Read it with `__rfFlarexTrace.dump()` (aligned table) or `__rfFlarexTrace.json()` (paste-able).
 */

/** Ring capacity. A node add plus a 30s playback lands well under 300 events at change-granularity. */
const MAX_EVENTS = 4000;

export interface FlarexTraceEvent {
  /** ms since trace start - the whole point; every existing instrument is clockless. */
  t: number;
  kind: string;
  subject: string;
  detail?: unknown;
}

let enabled: boolean | undefined;
let startedAt = 0;
const events: FlarexTraceEvent[] = [];
/** Last emitted value per change-key, so a per-frame call site only writes on a real transition. */
const lastSeen = new Map<string, string>();
let watcher: number | null = null;
/** Highest kernel event seq already mirrored, so the ring is read forward-only, never re-emitted. */
let lastKernelSeq = -1;
/** Per (subject|reason) degradation totals, so the flicker view can emit deltas rather than states. */
const lastDegradeCounts = new Map<string, number>();

function readFlag(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return new URLSearchParams(window.location.search).get("flarexTrace") === "1";
  } catch {
    return false;
  }
}

export function flarexTraceEnabled(): boolean {
  if (enabled === undefined) {
    enabled = readFlag();
    if (enabled) start();
  }
  return enabled;
}

function push(kind: string, subject: string, detail?: unknown): void {
  if (events.length >= MAX_EVENTS) events.shift();
  events.push({
    t: Math.round(performance.now() - startedAt),
    kind,
    subject,
    ...(detail === undefined ? {} : { detail }),
  });
}

/** Unconditional event - for things that ARE transitions (a comp write, a mount, play/pause). */
export function traceFlarex(kind: string, subject: string, detail?: unknown): void {
  if (!flarexTraceEnabled()) return;
  push(kind, subject, detail);
}

/**
 * CHANGE-ONLY event: safe from a per-frame path. Nothing is written unless the value changed.
 *
 * `changeKey` exists because the interesting fields and the noisy ones travel together. A source
 * snapshot carries both its decode STATE (changes twice an hour) and its served TIME (changes 60x a
 * second); keying on the whole object makes every frame a "change" and the log becomes the flood this
 * was written to avoid - measured on this instrument's own first run. Pass the discriminating subset
 * as `changeKey` and let the volatile fields ride along in `value`, where they stay visible on every
 * line that does get written.
 */
export function traceFlarexChange(kind: string, subject: string, value: unknown, changeKey?: unknown): void {
  if (!flarexTraceEnabled()) return;
  const key = kind + " " + subject;
  const basis = changeKey === undefined ? value : changeKey;
  const encoded = typeof basis === "string" ? basis : JSON.stringify(basis) ?? "none";
  if (lastSeen.get(key) === encoded) return;
  lastSeen.set(key, encoded);
  push(kind, subject, value);
}

function shortId(id: string): string {
  return id.length > 44 ? "..." + id.slice(-44) : id;
}

/**
 * Poll the EXISTING snapshot globals and emit their deltas into this one timeline.
 *
 * Deliberately a poller rather than new call sites inside the decoder: those globals are already
 * maintained on the real paths, and re-instrumenting the same transitions a second time would be the
 * observer arriving through a path the runtime is being measured on. 100ms resolves every transition
 * this question needs (mount, lease, provider arrival, first frame) without touching a hot path.
 */
function start(): void {
  if (typeof window === "undefined" || watcher !== null) return;
  startedAt = performance.now();
  const w = window as unknown as Record<string, any>;
  watcher = window.setInterval(() => {
    const pool = w.__rfWcPool;
    if (pool) {
      traceFlarexChange(
        "pool",
        "census",
        {
          created: pool.created,
          active: pool.active,
          capMisses: pool.capMisses,
          denials: pool.admissionDenials,
          preempt: pool.admissionPreemptions,
          shared: pool.shared,
        },
        [pool.created, pool.active, pool.capMisses, pool.admissionDenials, pool.admissionPreemptions, pool.shared].join("/")
      );
    }
    const sources = (w.__rfSourceMap ?? {}) as Record<string, any>;
    for (const [id, snap] of Object.entries(sources)) {
      // The fields that distinguish "decoding fine" from "granted but never initialised" from "no lease
      // at all" - the exact discrimination the two competing diagnoses disagree about. `served` rides
      // along for context but is NOT in the key, or playback would write a line per frame.
      traceFlarexChange(
        "source",
        shortId(id),
        { decode: snap.decode, state: snap.state, why: snap.why, wcProvider: snap.wcProvider, shared: snap.shared, served: snap.served },
        [snap.decode, snap.state, snap.why, snap.wcProvider, snap.shared].join("/")
      );
    }
    const routing = (w.__rfRouting ?? {}) as Record<string, any[]>;
    for (const [url, entries] of Object.entries(routing)) {
      const last = entries[entries.length - 1];
      if (!last) continue;
      traceFlarexChange(
        "route",
        shortId(url),
        { route: last.route, native: last.preferNativeDecode, bailed: last.bailed, decisions: entries.length },
        [last.route, last.preferNativeDecode, last.bailed].join("/")
      );
    }
    // HANDLE FAILURES, with the resource KEY attached (needs `?kernelDiagnostics=1`).
    //
    // This is the one reason whose detail decides the diagnosis. `handle-missing` means a holder asked
    // for a GPU resource whose registration had been forgotten under it, and `resolveSceneTexture`
    // answers a failed handle with `null` - i.e. nothing is drawn. The aggregate census can only say
    // that happened; the key says WHICH resource died, and therefore which prune killed it.
    const kernel = w.__rfKernel;
    if (kernel?.enabled) {
      for (const ev of kernel.events("degradation") as Array<Record<string, any>>) {
        if (typeof ev.reason !== "string" || !ev.reason.startsWith("handle-")) continue;
        if (ev.seq <= lastKernelSeq) continue;
        lastKernelSeq = ev.seq;
        push("HANDLE", ev.reason, { key: ev.detail?.key, generation: ev.detail?.generation, frameId: ev.frameId });
      }
    }
    // FLICKER VIEW. Everything above is change-only, which is right for a state that settles and wrong
    // for one that oscillates: a MediaIn alternating between its own picture and a degrade writes the
    // same reason every time, so the transition log collapses it to a single line and the flicker
    // becomes invisible in the instrument built to see it. This emits the count DELTA per subject
    // instead, so "it degraded 40 times while I dragged" is a readable row.
    const subs = w.__rfFlarexDegradation?.substitutions as Array<{ subject: string; reason: string; count: number }> | undefined;
    for (const row of subs ?? []) {
      const k = `${row.subject}|${row.reason}`;
      const prev = lastDegradeCounts.get(k) ?? 0;
      if (row.count <= prev) continue;
      lastDegradeCounts.set(k, row.count);
      push("FLICKER", shortId(row.subject), { reason: row.reason, added: row.count - prev, total: row.count });
    }
    const degr = w.__rfFlarexDegradation;
    if (degr?.byReason) {
      // Key on the SET of reasons, not their counts: the counts tick every frame and say nothing new.
      traceFlarexChange(
        "degrade",
        "reasons",
        degr.byReason,
        degr.byReason.map((r: { reason: string }) => r.reason).sort().join(",")
      );
    }
  }, 100);
}

function stop(): void {
  if (watcher !== null) window.clearInterval(watcher);
  watcher = null;
}

if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__rfFlarexTrace = {
    get events() {
      return events;
    },
    on() {
      enabled = true;
      start();
      return "flarex trace ON";
    },
    off() {
      enabled = false;
      stop();
      return "flarex trace OFF";
    },
    clear() {
      events.length = 0;
      lastSeen.clear();
      startedAt = performance.now();
      return "cleared";
    },
    /** Aligned, paste-able into an issue. */
    dump() {
      const lines = events.map((e) => {
        const detail = e.detail === undefined ? "" : typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail);
        return String(e.t).padStart(7) + "ms  " + e.kind.padEnd(9) + " " + e.subject.padEnd(46) + " " + detail;
      });
      console.log("FLAREX TRACE - " + events.length + " events\n" + lines.join("\n"));
      return events.length;
    },
    json() {
      return JSON.stringify(events, null, 1);
    },
  };
}
