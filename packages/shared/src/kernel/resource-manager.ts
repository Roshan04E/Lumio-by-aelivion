/**
 * Resource Manager (ADR-012 3.12, slice S3.4) — who OWNS a derived resource, and when it comes back.
 *
 * ## Two defects, in the same structure
 *
 * `ScenePreviewCanvas` keeps its grade renderers, render targets and matte caches in React refs, and
 * both of the invariants those refs break are visible in one Map.
 *
 * **I-8 — every runtime resource MUST have exactly one owner.** `sharedGradeRenderersRef` holds entries
 * belonging to three different owners: the live frame, the viewer-capture handle, and the node-thumbnail
 * pool. Which owner a given entry belongs to is decided by **parsing a prefix off its key** — the live
 * prune skips `id.startsWith("capture:")`, and the capture release selects
 * `startsWith("capture:") || startsWith("thumb:")`. Ownership is therefore a substring convention
 * re-derived independently in two places, and a fourth owner (or a typo in either predicate) either
 * double-disposes a live resource or leaks a scratch one, silently and with no instrument that would
 * show it.
 *
 * **I-33 — reclamation MUST NOT depend on frames being presented.** The live prune sits *after* the
 * coherence-hold early return, so **a held frame reclaims nothing**. That is not an inefficiency, it is
 * the amplifier in the loop both runtime audits identified: slow sources → held frames → no reclamation
 * → VRAM climbs → context eviction → every cache destroyed → slow sources. The recovery mechanism feeds
 * the failure, which is why no timeout tuning has ever broken the cycle.
 *
 * ## What this module owns, and what it must never own
 *
 * It owns **the record of a resource and the decision to reclaim it**. It never owns the resource. A
 * render target is a GL object and I-36 forbids this directory from touching one, so the kernel holds
 * the key, the scope and the wall-clock age, and the host does the disposing when told. That boundary
 * is not a compromise — it is what lets the same ownership rules apply to an export, a worker and a
 * headless harness, none of which have a GL context to hand.
 *
 * ## Why the sweep is wall-clock and the set-difference prune stays where it is
 *
 * The existing prune ("dispose every entry whose layer left the draw set") is *correct and fast*, and it
 * is deliberately left exactly where it is. It cannot simply be moved above the hold gate: the sets it
 * subtracts against (`liveMediaSourceIds`) are populated *by* the grade pass the hold skips, so running
 * it early would compute the difference against an empty set and dispose the held frame's own renderers
 * — a landmine the file already carries a comment about.
 *
 * The kernel adds the thing that CAN run under a hold: a wall-clock idle sweep. An entry touched this
 * frame has age zero, so a sweep keyed on age is safe on any frame, in any outcome, by construction.
 * That is the whole reason ADR-012 replaces the presented-frame TTL clock with wall-clock aging (P15) —
 * not because wall-clock is tidier, but because it is the only clock that still runs when the thing that
 * was driving the old one has stopped.
 *
 * In a healthy session the sweep reclaims **nothing**: the fast path has already disposed everything it
 * would have caught. It bites only in the failure the loop is made of, which is exactly where the old
 * reclamation went quiet.
 */

import { kernelDiagnostics } from "./diagnostics";
import type { RuntimeSession } from "./session";

/**
 * How long an unused resource may sit before the idle sweep reclaims it.
 *
 * Generous on purpose. This is a BACKSTOP, not a budget: the set-difference prune already disposes an
 * entry the moment its layer leaves the draw set, so anything this catches has survived that path —
 * which means the frame that would have pruned it never got there. Ten seconds is far longer than the
 * longest hold episode on record (1506 ms) and far shorter than the time it takes stranded render
 * targets to matter, so the sweep can never race the fast path it backs up.
 */
export const RESOURCE_IDLE_MS = 10_000;

/**
 * Who a resource belongs to. **A scope, not a key prefix.**
 *
 * The point of this type is that ownership becomes a field one owner writes and every reader reads,
 * instead of a substring two prune loops each re-derive. `scratch:<id>` keeps the existing
 * `capture:`/`thumb:` distinction available to the host without the kernel ever parsing it — the kernel
 * compares scopes for equality and nothing else, which is the property that makes a fourth owner a
 * one-line addition rather than a fourth predicate to keep in sync.
 */
export type ResourceScope = "live" | `scratch:${string}` | "export";

export interface ResourceRecord {
  readonly scope: ResourceScope;
  /**
   * Which pool this lives in (`grade-renderer`, `media-renderer`, `matte-cache`…).
   *
   * Load-bearing, not a label. The host has several pools whose keys can legitimately collide — a grade
   * renderer keyed by layer id and a media renderer keyed by a resolved source id are routinely the same
   * string — so the registry key is namespaced while `kind` and {@link ResourceRecord.id} carry the way
   * back. The host dispatches on `kind` and indexes with `id`; **nothing ever parses the key**, which is
   * the habit this whole module exists to break.
   */
  readonly kind: string;
  /** The host's own handle within its pool — the key it will actually delete with. */
  readonly id: string;
  /** `performance.now()`-domain wall clock of the last use. The ONLY input to the idle sweep. */
  lastUsedAt: number;
}

/** A record plus its registry key, handed back by the sweep. */
export interface ReclaimableResource extends ResourceRecord {
  readonly key: string;
}

/**
 * The table lives OFF the state registry, deliberately.
 *
 * `StateRegistry` copies a value on write and coalesces a notification per key. That is right for state
 * a subscriber renders from and catastrophically wrong here: a frame touches every resource it uses, so
 * a registry-backed table would spread an object per touch per frame on the draw path. This is the
 * allocation-free half of programme risk R1, and it is why the table is a plain `Map` behind a
 * `WeakMap` keyed on the session — session-scoped without being state.
 */
const tables = new WeakMap<RuntimeSession, Map<string, ResourceRecord>>();

function tableOf(session: RuntimeSession): Map<string, ResourceRecord> {
  let table = tables.get(session);
  if (!table) {
    table = new Map<string, ResourceRecord>();
    tables.set(session, table);
  }
  return table;
}

let reclaimedTotal = 0;
let reclaimedWhileUnpresented = 0;

/**
 * Record that `key` now exists, owned by `scope`. Idempotent: re-registering an existing key touches it
 * rather than re-scoping it, because a resource changing owner mid-life is the exact confusion this
 * module exists to make impossible — a caller that means to move one must release it first.
 */
export function registerResource(
  session: RuntimeSession,
  key: string,
  entry: { scope: ResourceScope; kind: string; id: string },
  at: number
): void {
  const table = tableOf(session);
  const existing = table.get(key);
  if (existing) {
    existing.lastUsedAt = at;
    return;
  }
  table.set(key, { scope: entry.scope, kind: entry.kind, id: entry.id, lastUsedAt: at });
}

/**
 * Mark `key` used. **Hot path** — one map lookup and one field write, no allocation, no branching on
 * diagnostics. Touching an unregistered key is a silent no-op rather than an implicit registration: a
 * resource whose owner was never declared must not be able to acquire one by being used.
 */
export function touchResource(session: RuntimeSession, key: string, at: number): void {
  const record = tables.get(session)?.get(key);
  if (record !== undefined) record.lastUsedAt = at;
}

/** Forget `key`. The host has already disposed it (or is about to); this drops the record. */
export function forgetResource(session: RuntimeSession, key: string): void {
  tables.get(session)?.delete(key);
}

/**
 * Every key owned by `scope`. This is what replaces the prefix sniffing: a scope release asks the
 * registry who it owns instead of asking a string what it looks like.
 *
 * Allocates — call it when a scope ends, never per frame.
 */
export function resourcesInScope(session: RuntimeSession, scope: ResourceScope): ReclaimableResource[] {
  const out: ReclaimableResource[] = [];
  const table = tables.get(session);
  if (!table) return out;
  for (const [key, record] of table) {
    if (record.scope === scope) out.push({ ...record, key });
  }
  return out;
}

/**
 * Keys idle for longer than `ttlMs`, for the host to dispose. **Safe on any frame in any outcome** — an
 * entry used this frame has age zero, which is the property that lets this run where the set-difference
 * prune cannot.
 *
 * `presented` is not a filter and never becomes one; it is recorded, so "how much did we reclaim on
 * frames that never presented?" is answerable. A non-zero count is the direct measurement of the I-33
 * violation this slice retires: every one of those reclaims is memory the old prune would have held
 * until the hold episode ended.
 *
 * Returns null rather than an empty array when there is nothing to do, so the common case allocates
 * nothing at all (I-35 does not apply: null here is a described "no work", not a communicated failure).
 */
export function collectIdleResources(
  session: RuntimeSession,
  at: number,
  ttlMs: number,
  presented: boolean
): ReclaimableResource[] | null {
  const table = tables.get(session);
  if (!table || table.size === 0) return null;
  let out: ReclaimableResource[] | null = null;
  for (const [key, record] of table) {
    if (at - record.lastUsedAt <= ttlMs) continue;
    (out ??= []).push({ ...record, key });
  }
  if (out === null) return null;

  reclaimedTotal += out.length;
  if (!presented) reclaimedWhileUnpresented += out.length;
  if (kernelDiagnostics.enabled) {
    kernelDiagnostics.record({
      kind: "pressure",
      // `warn`, unlike the retention record in S3.3: in a healthy session this sweep reclaims NOTHING,
      // because the fast path already disposed everything it would catch. A non-empty result means a
      // frame that should have pruned did not — which is the failure, not the routine.
      severity: "warn",
      subject: { kind: "resource", resourceKind: "derived-cache" },
      reason: presented ? "idle-reclaim" : "idle-reclaim-unpresented",
      detail: { count: out.length, ttlMs },
    });
  }
  return out;
}

export interface ResourceLedger {
  /** Live records by scope, so "who owns what" is a query rather than an audit of two predicates. */
  readonly byScope: { scope: string; count: number }[];
  readonly byKind: { kind: string; count: number }[];
  readonly total: number;
  /** Wall-clock age of the least recently used record, in ms. 0 when the registry is empty. */
  readonly oldestIdleMs: number;
  readonly reclaimedTotal: number;
  /**
   * Of those, reclaimed on a frame that never presented — **the I-33 census**. Before this slice that
   * number was structurally zero, because reclamation could not happen on such a frame at all.
   */
  readonly reclaimedWhileUnpresented: number;
}

/** Roll up. Query path — allocates and sorts, never called per frame. */
export function resourceLedger(session: RuntimeSession, at: number): ResourceLedger {
  const table = tables.get(session);
  const scopes = new Map<string, number>();
  const kinds = new Map<string, number>();
  let oldestIdleMs = 0;
  if (table) {
    for (const record of table.values()) {
      scopes.set(record.scope, (scopes.get(record.scope) ?? 0) + 1);
      kinds.set(record.kind, (kinds.get(record.kind) ?? 0) + 1);
      const idle = at - record.lastUsedAt;
      if (idle > oldestIdleMs) oldestIdleMs = idle;
    }
  }
  const rows = (map: Map<string, number>) =>
    [...map.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  return {
    byScope: rows(scopes).map((row) => ({ scope: row.name, count: row.count })),
    byKind: rows(kinds).map((row) => ({ kind: row.name, count: row.count })),
    total: table?.size ?? 0,
    oldestIdleMs,
    reclaimedTotal,
    reclaimedWhileUnpresented,
  };
}

/** Test-support: drop every record for a session, and reset the process-wide reclaim counters. */
export function __resetResourceManager(session: RuntimeSession): void {
  tables.delete(session);
  reclaimedTotal = 0;
  reclaimedWhileUnpresented = 0;
}
