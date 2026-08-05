/**
 * Scene resource orchestration (ADR-012 slice S7.1).
 *
 * Extracted verbatim from `ScenePreviewCanvas`, which S7.1 reduces to a surface. Nothing here is new
 * and nothing changed: this is the same two passes, the same order, the same flag branches. The value
 * is that the viewer no longer decides WHEN a GPU object dies — it draws, and asks this to keep the
 * pools honest.
 *
 * ## Why this is extraction and not deletion
 *
 * S7.1 is written as "remove the legacy orchestration", but the kernel replacements for scheduling and
 * readiness are still behind default-OFF flags (`kernelFrames`, `kernelCoherenceUnified`). Deleting the
 * legacy paths would therefore not remove dead code — it would force-enable those flags, which DEBT-002
 * gates on soak evidence that does not exist yet, and which S7.2 owns. So the responsibilities move out
 * of the component with BOTH branches intact, and S7.2 deletes the losing branch once the soaks say it
 * may.
 *
 * ## The two passes are not interchangeable, and the order is load-bearing
 *
 * {@link sweepIdleSceneResources} is wall-clock aged and runs ABOVE every hold gate. That placement is
 * the whole point of S3.4/S5.3: the set-difference prune below cannot run there, because it subtracts
 * against a live-source set that a held frame never populates — running it early would compute the
 * difference against an empty set and dispose the held frame's own renderers. A wall-clock sweep has no
 * such dependency (an entry touched this frame has age zero), so it is safe on any frame in any
 * outcome. That asymmetry is why the amplifier both runtime audits named — slow sources → held frames →
 * no reclamation → VRAM climbs → context eviction → slow sources — is broken by this one and not the
 * other.
 */

import {
  collectIdleResources,
  defaultSession,
  forgetResource,
  resourcesInScope,
  RESOURCE_IDLE_MS,
  type ResourceScope,
} from "@orreris/shared";
import { recoverDeniedAdmissions } from "./preview-frame-pool";

/** Everything both pools have in common, which is all this module is allowed to know about them. */
interface DisposableEntry {
  readonly renderer: { dispose: () => void };
  readonly target?: { dispose: () => void } | undefined;
}

export type ScenePool = Map<string, DisposableEntry>;

/** Registry keys. Namespaced because a layer id and a resolved source id are routinely equal. */
export const gradeResourceKey = (id: string): string => `grade/${id}`;
export const mediaResourceKey = (id: string): string => `media/${id}`;

/**
 * Who owns a pooled grade renderer (I-8, slice S3.4).
 *
 * The prefix is the caller's existing convention and still the source of truth, but it is read ONCE at
 * registration and is a field thereafter. Before S3.4 this fact was re-derived by `startsWith` in two
 * independently maintained places — a skip in the live prune and a select in the capture release — and
 * a fourth owner or a typo in either silently double-disposed a live resource or leaked a scratch one.
 */
export const gradeScopeOf = (key: string): ResourceScope =>
  key.startsWith("capture:") ? "scratch:capture" : key.startsWith("thumb:") ? "scratch:thumb" : "live";

export interface IdleSweepParams {
  readonly compositor: { sweepIdleCaches: () => void };
  readonly nowMs: number;
  readonly lastSweepMs: number;
  readonly gradePool: ScenePool;
  readonly mediaPool: ScenePool;
}

/**
 * Wall-clock reclamation that does not depend on a frame presenting (I-33).
 *
 * Returns the new `lastSweepMs`, so the caller keeps the clock and this stays free of module state.
 * Rate-limited to once per TTL, which is what keeps the per-frame cost one number comparison (risk R1).
 *
 * In a healthy session this reclaims NOTHING — the fast path already disposed everything it would have
 * caught. It bites only in the failure, which is exactly where the old reclamation went quiet.
 */
export function sweepIdleSceneResources(params: IdleSweepParams): number {
  if (params.nowMs - params.lastSweepMs <= RESOURCE_IDLE_MS) return params.lastSweepMs;

  // S5.3: age the COMPOSITOR's own caches on the same pre-hold tick. The kernel sweep below covers
  // resources the kernel knows about; the compositor's texture/program/target caches were pruned only
  // at the tail of a composited frame, so a viewer that held, paused or hid stopped reclaiming exactly
  // when pressure was highest. This is the half of I-21/I-33 the kernel cannot reach.
  params.compositor.sweepIdleCaches();

  // ADR-020 slice A — §6.11 recovery rides this tick and NOTHING ELSE about it is shared. The pass
  // rate-limits itself on its own `ADMISSION_RECOVERY_IDLE_MS`, so changing `RESOURCE_IDLE_MS` changes
  // how often this tick fires but not what recovery considers a recovery interval. Riding an existing
  // cadence rather than adding a timer is deliberate: a new per-frame hook would put ranking on the
  // acquire hot path (R1), and re-deciding every frame fights the minimum residency whose entire job is
  // to stop competitors trading a slot.
  // WHAT THIS DOES TODAY, precisely: it re-examines the denied set, declares §6.11's terminal for
  // anything starved past the bound, and keeps the starvation census current. It does NOT yet cause a
  // denied source to re-ask.
  //
  // The retry half needs a layer-side element→WebCodecs re-acquire path that does not exist.
  // `requestLiveReprime` was the obvious candidate and is the WRONG one — reading it shows it re-seeks
  // the `<video>` element and never re-attempts an acquire, so hooking it here would have counted
  // recoveries that could not occur. Left unwired deliberately rather than wired to a no-op: a
  // mechanism that reports success it cannot deliver is worse than one that reports the gap.
  recoverDeniedAdmissions(params.nowMs);

  // `presented: false` — this runs before the hold decision, so whether this frame reaches the screen
  // is not yet known. Reporting the pessimistic value keeps the I-33 census honest.
  const idle = collectIdleResources(defaultSession, params.nowMs, RESOURCE_IDLE_MS, false);
  if (idle) {
    for (const record of idle) {
      forgetResource(defaultSession, record.key);
      // Dispatch on the record's OWN kind and id. Nothing parses the key — that habit is what S3.4
      // exists to remove, and re-introducing it in the sweep would be the same bug one layer up.
      const pool = record.kind === "grade-renderer" ? params.gradePool : params.mediaPool;
      const entry = pool.get(record.id);
      if (!entry) continue;
      try {
        entry.renderer.dispose();
        entry.target?.dispose();
      } catch {
        /* a dying GPU object must never throw into the draw loop */
      }
      pool.delete(record.id);
    }
  }
  return params.nowMs;
}

export interface DepartedPruneParams {
  readonly liveLayerIds: ReadonlySet<string>;
  readonly liveMediaSourceIds: ReadonlySet<string>;
  /**
   * Media sources that are MOUNTED but whose consumption is mediated, and which this frame's silence
   * therefore says nothing about (I-8). Retained regardless of `liveMediaSourceIds`.
   *
   * Consumption is the right liveness proof for a clip: a clip nobody sampled has left the window, and
   * `liveMediaSourceIds` is exactly the set of clips the grade pass touched. A Flarex virtual loader
   * breaks that equivalence. It is mounted by the viewer (it has a descriptor, an element, a decoder
   * lease) but its pixels are requested through the Flarex COMPILER, and the compiler has several
   * legitimate reasons to return without asking on any given frame — `resolveSourceDraw` answers
   * "ended" past the loader's clamped duration, returns early when the node has no virtual layer, and
   * is never reached at all while an upstream branch is substituting. None of those mean "departed".
   *
   * Disposing on that silence was a LATCH, not a one-frame glitch: forget the resource → the holder's
   * handle goes stale → `resolveSceneTexture` answers null → the MediaIn cannot produce → the compiler
   * substitutes and returns null → `lowered ?? draw` puts the HOST on screen → and because it
   * substituted it did not ask again, so the next frame forgets it too. The climbing `generation` on
   * `media/flarexsrc:*` is that cycle counting its own revolutions.
   *
   * This is the same lesson the grade path learned on 2026-07-07 (tracker playback-preview v22): a
   * transiently source-less layer must HOLD, because dropping it from the draw list produced "a black
   * flicker on every ruler click". That fix taught one level to hold and left the reaper above it still
   * inferring departure from silence.
   *
   * Retention stays bounded, so this cannot leak: a loader that genuinely goes away leaves this set on
   * the very next composite and is pruned then, and one that lingers unconsumed is still reclaimed by
   * the wall-clock idle sweep above.
   */
  readonly declaredMediaSourceIds?: ReadonlySet<string> | undefined;
  readonly gradePool: ScenePool;
  readonly mediaPool: ScenePool;
}

/**
 * Set-difference prune: dispose what this frame did not consume, EXCEPT what was declared present.
 *
 * Runs only on a frame that got past every hold gate, because `liveMediaSourceIds` is populated by the
 * grade pass a hold skips — see the header for why that makes it un-hoistable.
 */
export function pruneDepartedSceneResources(params: DepartedPruneParams): void {
  for (const [id, entry] of params.gradePool) {
    // Entries owned by a SCRATCH scope belong to the viewer-capture run or the thumbnail pool
    // (arbitrary times / layers) — their own releaseCaptureResources() disposes them, not the live
    // frame's prune. The scope is the owner (I-8, S3.4).
    if (params.liveLayerIds.has(id) || gradeScopeOf(id) !== "live") continue;
    entry.renderer.dispose();
    entry.target?.dispose();
    params.gradePool.delete(id);
    forgetResource(defaultSession, gradeResourceKey(id));
  }
  if (params.mediaPool.size === 0) return;
  // Single-ctx: dispose media-grade renderers whose source id wasn't consumed this frame (clip left the
  // window / its descriptor was withdrawn).
  for (const [id, entry] of params.mediaPool) {
    if (params.liveMediaSourceIds.has(id) || params.declaredMediaSourceIds?.has(id)) continue;
    entry.renderer.dispose();
    entry.target?.dispose();
    params.mediaPool.delete(id);
    forgetResource(defaultSession, mediaResourceKey(id));
  }
}

/**
 * Release everything the two SCRATCH scopes own — the viewer-capture run and the node-thumbnail pool.
 *
 * The exact inverse of {@link pruneDepartedSceneResources}'s skip, and it lives beside it deliberately:
 * before S3.4 these were a `startsWith("capture:")` skip in the live prune and a
 * `startsWith("capture:") || startsWith("thumb:")` select here — two predicates, independently
 * maintained, re-deriving one fact from a substring. They now ask the registry who owns what, and they
 * are in one file so a future third scope cannot be added to only one of them.
 *
 * Every dispose is individually guarded: a dying GPU object must never throw out of a release path, or
 * the entries after it leak precisely when something has already gone wrong.
 */
export function releaseScratchSceneResources(gradePool: ScenePool): void {
  for (const scope of ["scratch:capture", "scratch:thumb"] as const) {
    for (const record of resourcesInScope(defaultSession, scope)) {
      const entry = gradePool.get(record.id);
      forgetResource(defaultSession, record.key);
      if (!entry) continue;
      try {
        entry.renderer.dispose();
      } catch {
        /* ignore */
      }
      try {
        entry.target?.dispose();
      } catch {
        /* ignore */
      }
      gradePool.delete(record.id);
    }
  }
}
