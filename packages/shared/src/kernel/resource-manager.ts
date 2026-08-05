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
 *
 * `permanent` is the one scope the idle sweep may not reclaim, and it exists because the alternative
 * was a comment. `scene-compositor/intra-call` is a SENTINEL, not a cache: it is registered once at
 * module load so that a texture the compositor produces and consumes inside one statement still has a
 * checkable handle, and its docstring asserted "it is never forgotten, so it is never stale". Nothing
 * enforced that. Nothing touches it either — `ephemeralSceneTexture` hands out the handle without a
 * `touchResource` — so its `lastUsedAt` was frozen at module load and {@link collectIdleResources}
 * reclaimed it after {@link RESOURCE_IDLE_MS}. From then on every intra-call texture resolved to
 * `null`, and a Flarex comp went black the moment a node added a nest to render (2026-08-05).
 *
 * The lesson is the reason this is a scope rather than a special case in the sweep: a lifetime that is
 * NOT "until it goes unused" has to be sayable at the registration site, where the author knows it, and
 * readable by every reclaimer without any of them re-deriving it.
 */
export type ResourceScope = "live" | `scratch:${string}` | "export" | "permanent";

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
  /**
   * Which INCARNATION of this key is live (ADR-012 I-17/I-9, slice S5.2).
   *
   * A key is reused: a grade renderer for layer `x` is disposed on resize and a new one is created
   * under the same key moments later. Identity alone therefore cannot answer "is the thing I was
   * handed still the thing that exists?" — which is why a stale `SceneTextureSource` is currently
   * prevented only by statement ordering, and why nothing detects it when the ordering is wrong.
   *
   * Monotonic per key, and it survives forgetting: {@link forgetResource} keeps the counter so a key
   * re-registered later cannot re-issue a generation that an outstanding handle still matches. A
   * counter that reset on delete would make the dangerous case — dispose, recreate, sample the old
   * handle — the one case it failed to catch.
   */
  readonly generation: number;
}

/**
 * A reference to a resource that can be CHECKED, unlike a device pointer (slice S5.2).
 *
 * The point is what it deliberately does not carry: no `WebGLTexture`, no buffer, nothing the holder
 * could use without asking first. A holder must resolve it, and resolution can fail — which is what
 * turns use-after-dispose from an invisible corruption into a declared, countable event (I-29).
 *
 * The kernel issues and validates these but never stores the device object itself; that stays with the
 * host pool, because a kernel that held a `WebGLTexture` would be a kernel that imports a rendering
 * API (I-36). Liveness accounting here, pixels there.
 */
export interface ResourceHandle {
  readonly key: string;
  readonly generation: number;
}

/** Why a handle failed to resolve. `missing` = never registered or forgotten; `stale` = superseded. */
export type HandleFailure = "missing" | "stale";

let staleHandleResolves = 0;

/**
 * Is this handle still the live incarnation of its key?
 *
 * Returns the failure REASON rather than a bare false (I-35), because the two causes are different
 * bugs: `missing` is a lifetime that ended under the holder, `stale` is a key that was rebuilt while
 * the holder kept the old reference. Hot path — one map lookup, no allocation on success.
 */
export function checkHandle(session: RuntimeSession, handle: ResourceHandle): HandleFailure | null {
  const record = tables.get(session)?.get(handle.key);
  if (record === undefined) return "missing";
  if (record.generation !== handle.generation) return "stale";
  return null;
}

/**
 * Record that a holder tried to use a superseded resource, and say which.
 *
 * Counted unconditionally while the DETAIL is diagnostics-gated (R1): the count is the census that
 * says whether I-17 is actually satisfied in the field, and a census that only runs when someone is
 * watching cannot answer that. The attribution costs an object, so it pays only when asked for.
 */
export function noteStaleHandle(session: RuntimeSession, handle: ResourceHandle, failure: HandleFailure): void {
  staleHandleResolves += 1;
  if (!kernelDiagnostics.enabled) return;
  kernelDiagnostics.record({
    kind: "degradation",
    severity: "warn",
    subject: { kind: "runtime" },
    reason: `handle-${failure}`,
    detail: { key: handle.key, generation: handle.generation },
  });
}

/** Handles that resolved to nothing since process start. **Non-zero is the finding** (I-17). */
export function staleHandleCount(): number {
  return staleHandleResolves;
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

/**
 * Highest generation ever issued per key — kept SEPARATELY from the record table, and outliving it.
 *
 * The record dies with {@link forgetResource}; this does not. That asymmetry is the whole mechanism:
 * dispose → recreate under the same key → sample a handle taken before the dispose is precisely the
 * use-after-dispose S5.2 exists to catch, and a counter stored on the record would have been deleted
 * by the dispose and reissued the same number to the new incarnation. The stale handle would then
 * validate cleanly against the resource that replaced it, which is worse than no check at all.
 *
 * Unbounded in principle, bounded in practice by the key space (pool keys, not per-frame values), and
 * it holds numbers rather than resources — so it pins nothing.
 */
const generations = new WeakMap<RuntimeSession, Map<string, number>>();

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
): ResourceHandle {
  const table = tableOf(session);
  const existing = table.get(key);
  if (existing) {
    existing.lastUsedAt = at;
    // Same incarnation: re-registering an existing key is a touch, so the handle a caller already
    // holds must stay valid. Bumping here would invalidate live handles on an idempotent call.
    return { key, generation: existing.generation };
  }
  // A key absent from the table is a NEW incarnation, whether it was never registered or was
  // forgotten. `generations` is the memory that outlives the record — see the note on its declaration.
  const generation = (generations.get(session)?.get(key) ?? 0) + 1;
  let seen = generations.get(session);
  if (!seen) {
    seen = new Map<string, number>();
    generations.set(session, seen);
  }
  seen.set(key, generation);
  table.set(key, { scope: entry.scope, kind: entry.kind, id: entry.id, lastUsedAt: at, generation });
  return { key, generation };
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
    // A permanent resource has no idle state to be in: its lifetime is its module's, not its usage's.
    // Checked before the age test rather than after, so a sentinel nobody touches is never even a
    // candidate — see the `permanent` note on ResourceScope for what this cost when it was a comment.
    if (record.scope === "permanent") continue;
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
  // Generations too, so a harness gets a clean numbering. Test-only: dropping this in production is
  // what the counter's whole design forbids, since it would let a rebuilt key reissue a live handle's
  // generation. Safe here because a reset session has no outstanding handles by construction.
  generations.delete(session);
  reclaimedTotal = 0;
  reclaimedWhileUnpresented = 0;
  staleHandleResolves = 0;
}
