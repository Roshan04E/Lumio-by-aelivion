/**
 * Runtime Kernel — Diagnostics sink (ADR-012 Part 3 "Diagnostics", slice S0.1).
 *
 * ONE record for every runtime degradation, denial, write-off, cache statistic and resource-pressure
 * event, keyed on ONE identity namespace.
 *
 * ## Why this exists
 *
 * The 2026-08-01 runtime audit had to reconstruct causality by hand: the runtime publishes 40+
 * `window.__rf*` globals that key their subjects four different ways — layer id, virtual-source id
 * (`flarexsrc:<compId>:<nodeId>`), `compId`+`nodeId` pair, and bare node id. No two of them could be
 * joined without knowing which scheme each used, and three of the four Critical findings were
 * unmeasurable because the degradation that caused them was never recorded at all.
 *
 * Every later kernel slice reports through this module. The existing `__rf*` globals are NOT removed
 * by this slice — they stay untouched until Phase 7, so this is purely additive and nothing that
 * reads them today changes behaviour.
 *
 * ## The one rule this module must never break
 *
 * **Diagnostics must never perturb the path they measure** (ADR-012 Part 3, and the empirical
 * observer effect already recorded in `tmp/flarex-observer-effect.ts`). Two consequences:
 *
 * 1. When disabled, recording must cost a single boolean read and allocate nothing. Call sites
 *    therefore guard on {@link kernelDiagnostics}`.enabled` so the event object literal is never
 *    constructed in the disabled case:
 *
 *    ```ts
 *    if (kernelDiagnostics.enabled) kernelDiagnostics.record({ ... });
 *    ```
 *
 *    Passing an already-built object to an internal `if (!enabled) return` would allocate on the hot
 *    path even when off — which is precisely the bug this comment exists to prevent.
 *
 * 2. The ring buffer is pre-allocated and overwritten in place. Recording never grows an array,
 *    never sorts, and never stringifies.
 *
 * Resolution order for the flag: `?kernelDiagnostics=0|1` → localStorage `orreris.kernel.diagnostics`
 * → default ON. It defaults on because it is additive and observation-only; the escape hatch exists
 * for A/B frame-time measurement (programme risk R1).
 */

// ---------------------------------------------------------------------------------------------
// Identity — the single namespace
// ---------------------------------------------------------------------------------------------

/**
 * Everything the runtime can say something about. One closed union, so a consumer can always join
 * two events without knowing which subsystem produced them.
 *
 * `sourceId` is the runtime source identity — a timeline layer id for an ordinary clip, or the
 * synthetic `flarexsrc:<compId>:<nodeId>` id for a Flarex virtual loader. Producers must pass the id
 * they actually hold; the kernel does not guess, and {@link parseFlarexSourceSubject} is the only
 * sanctioned way to recover a comp/node pair from one.
 */
export type RuntimeSubject =
  | { readonly kind: "runtime" }
  | { readonly kind: "frame"; readonly frameId: number }
  | { readonly kind: "comp"; readonly compId: string }
  | { readonly kind: "node"; readonly compId: string; readonly nodeId: string }
  | { readonly kind: "source"; readonly sourceId: string }
  | { readonly kind: "layer"; readonly layerId: string }
  | { readonly kind: "resource"; readonly resourceKind: string };

/**
 * Canonical, stable string for a subject. This is the join key: two events about the same thing
 * produce the same string regardless of which subsystem recorded them.
 */
export function subjectKey(subject: RuntimeSubject): string {
  switch (subject.kind) {
    case "runtime":
      return "runtime";
    case "frame":
      return `frame:${subject.frameId}`;
    case "comp":
      return `comp:${subject.compId}`;
    case "node":
      return `node:${subject.compId}/${subject.nodeId}`;
    case "source":
      return `source:${subject.sourceId}`;
    case "layer":
      return `layer:${subject.layerId}`;
    case "resource":
      return `resource:${subject.resourceKind}`;
  }
}

const FLAREX_SOURCE_PREFIX = "flarexsrc:";

/**
 * Recover the `(compId, nodeId)` a Flarex virtual-loader source id encodes, or `null` for an
 * ordinary timeline source. Lets a consumer fold source-keyed events onto node-keyed ones — the
 * exact join the audit had to perform by hand.
 */
export function parseFlarexSourceSubject(sourceId: string): { compId: string; nodeId: string } | null {
  if (!sourceId.startsWith(FLAREX_SOURCE_PREFIX)) return null;
  const rest = sourceId.slice(FLAREX_SOURCE_PREFIX.length);
  const split = rest.indexOf(":");
  if (split <= 0 || split >= rest.length - 1) return null;
  return { compId: rest.slice(0, split), nodeId: rest.slice(split + 1) };
}

// ---------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------

/**
 * What kind of thing happened. Deliberately small and closed — a new category is a reviewable event,
 * not a routine one, because the value of this sink is that everything lands in one shape.
 */
export type RuntimeEventKind =
  /** The runtime produced something less than what was asked for (ADR-012 I-34: declared, never silent). */
  | "degradation"
  /** A request for a budgeted resource was refused (ADR-012 I-27: denial is a state, not a substitution). */
  | "denial"
  /** Work was performed and then discarded — a wasted decode, evaluation, or upload. */
  | "write-off"
  /** A cache hit/miss/evict observation. */
  | "cache"
  /** A budget approached, reached, or exceeded its limit. */
  | "pressure"
  /** A frame was presented. Carries the effective time and the degraded set (slice S0.3). */
  | "present"
  /** A state machine transitioned (ADR-012 Part 5). */
  | "transition"
  /** Something structurally invalid was found and repaired (e.g. the graph healer, slice S1.1). */
  | "repair";

/**
 * Severity, used only for filtering a query. It carries no policy: the kernel never behaves
 * differently because an event was recorded at one level rather than another.
 */
export type RuntimeEventSeverity = "info" | "warn" | "error";

export interface RuntimeEvent {
  /** Monotonic sequence number across the whole process. Ordering key; never reused. */
  readonly seq: number;
  /** `performance.now()`-domain milliseconds when recorded. Wall-clock, never a frame counter. */
  readonly at: number;
  readonly kind: RuntimeEventKind;
  readonly severity: RuntimeEventSeverity;
  /** Who this is about. */
  readonly subject: RuntimeSubject;
  /**
   * Short, stable, machine-groupable cause. Not a sentence — this is the aggregation key
   * (e.g. `"source-pending"`, `"host-clip-substituted"`, `"no-session-available"`).
   */
  readonly reason: string;
  /** The frame this belongs to, when a frame identity exists. Populated from S2.1 onward. */
  readonly frameId?: number | undefined;
  /** Free-form, small, JSON-safe. Never load-bearing: consumers must work without it. */
  readonly detail?: Readonly<Record<string, string | number | boolean | null>> | undefined;
}

/** What a producer supplies; `seq` and `at` are stamped by the sink. */
export type RuntimeEventInput = Omit<RuntimeEvent, "seq" | "at"> & { readonly at?: number };

// ---------------------------------------------------------------------------------------------
// Flag
// ---------------------------------------------------------------------------------------------

const FLAG_QUERY = "kernelDiagnostics";
const FLAG_STORAGE = "orreris.kernel.diagnostics";

function resolveEnabled(): boolean {
  const truthy = (v: string | null | undefined): boolean => v === "1" || v === "true";
  if (typeof window !== "undefined" && typeof window.location?.search === "string") {
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.has(FLAG_QUERY)) return truthy(params.get(FLAG_QUERY));
      const stored = window.localStorage?.getItem(FLAG_STORAGE);
      if (stored != null) return truthy(stored);
    } catch {
      /* restricted storage / SSR — fall through to the default */
    }
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// The sink
// ---------------------------------------------------------------------------------------------

/** Ring capacity. ~4k events is several seconds of a badly-degrading session at 60fps. */
const RING_CAPACITY = 4096;

interface AggregateRow {
  readonly kind: RuntimeEventKind;
  readonly subject: string;
  readonly reason: string;
  count: number;
  firstAt: number;
  lastAt: number;
}

function now(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

class KernelDiagnostics {
  /**
   * Read this BEFORE building an event. It is a plain field, not a getter, so the disabled case is a
   * single property load and the event literal is never constructed. See the module header.
   */
  enabled: boolean = resolveEnabled();

  private readonly ring: (RuntimeEvent | undefined)[] = new Array<RuntimeEvent | undefined>(RING_CAPACITY);
  private write = 0;
  private seq = 0;
  private dropped = 0;
  private readonly aggregates = new Map<string, AggregateRow>();
  private listeners: ((event: RuntimeEvent) => void)[] = [];

  /**
   * Record one event. Callers MUST guard on {@link enabled}; the guard inside is a safety net for
   * paths that forget, not a licence to skip it — an unguarded call allocates its argument whether
   * or not the sink is on.
   */
  record(input: RuntimeEventInput): void {
    if (!this.enabled) return;
    const event: RuntimeEvent = {
      seq: this.seq++,
      at: input.at ?? now(),
      kind: input.kind,
      severity: input.severity,
      subject: input.subject,
      reason: input.reason,
      frameId: input.frameId,
      detail: input.detail,
    };

    if (this.ring[this.write] !== undefined) this.dropped++;
    this.ring[this.write] = event;
    this.write = (this.write + 1) % RING_CAPACITY;

    const key = `${event.kind} ${subjectKey(event.subject)} ${event.reason}`;
    const row = this.aggregates.get(key);
    if (row === undefined) {
      this.aggregates.set(key, {
        kind: event.kind,
        subject: subjectKey(event.subject),
        reason: event.reason,
        count: 1,
        firstAt: event.at,
        lastAt: event.at,
      });
    } else {
      row.count++;
      row.lastAt = event.at;
    }

    for (const listener of this.listeners) listener(event);
  }

  /** Events in record order, oldest surviving first. Allocates — query path only, never hot. */
  events(filter?: { kind?: RuntimeEventKind; subject?: string; sinceSeq?: number }): RuntimeEvent[] {
    const out: RuntimeEvent[] = [];
    for (let i = 0; i < RING_CAPACITY; i++) {
      const event = this.ring[(this.write + i) % RING_CAPACITY];
      if (event === undefined) continue;
      if (filter?.kind !== undefined && event.kind !== filter.kind) continue;
      if (filter?.sinceSeq !== undefined && event.seq < filter.sinceSeq) continue;
      if (filter?.subject !== undefined && subjectKey(event.subject) !== filter.subject) continue;
      out.push(event);
    }
    return out;
  }

  /** Rolled-up counts, most frequent first. This is the "what is going wrong, and how often" view. */
  summary(): AggregateRow[] {
    return [...this.aggregates.values()].sort((a, b) => b.count - a.count);
  }

  /** Events lost to ring wraparound. Non-zero means the session degraded faster than 4096 records. */
  droppedCount(): number {
    return this.dropped;
  }

  /**
   * Subscribe to events as they are recorded. Used by the S0.3 presented-frame ledger and by tests.
   * Listeners run synchronously inside `record`, so they are subject to the same no-perturbation
   * rule: do no work here beyond appending.
   */
  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners = [...this.listeners, listener];
    return () => {
      this.listeners = this.listeners.filter((entry) => entry !== listener);
    };
  }

  /** Drop everything. Test-support and the "start a clean soak" affordance. */
  reset(): void {
    this.ring.fill(undefined);
    this.write = 0;
    this.seq = 0;
    this.dropped = 0;
    this.aggregates.clear();
  }
}

/** The process-wide sink. One instance by design: a second one would re-create the join problem. */
export const kernelDiagnostics = new KernelDiagnostics();

// ---------------------------------------------------------------------------------------------
// Debug handle
// ---------------------------------------------------------------------------------------------

// Follows the repo's `__rf*` telemetry convention so it is discoverable next to the globals it will
// eventually replace. Unlike those, everything here shares one identity namespace.
if (typeof globalThis !== "undefined") {
  Object.defineProperty(globalThis, "__rfKernel", {
    configurable: true,
    get: () => ({
      enabled: kernelDiagnostics.enabled,
      dropped: kernelDiagnostics.droppedCount(),
      summary: kernelDiagnostics.summary(),
      events: (kind?: RuntimeEventKind) => kernelDiagnostics.events(kind ? { kind } : undefined),
      reset: () => kernelDiagnostics.reset(),
    }),
  });
}
