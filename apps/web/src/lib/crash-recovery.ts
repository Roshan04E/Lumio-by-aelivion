import type { ProjectGraph } from "@orreris/shared";

/**
 * Crash-recovery checkpoint store.
 *
 * localStorage drafts only cover LOCAL projects (and are subject to the ~5MB quota);
 * a server-backed project edited offline loses everything since its last successful
 * sync if the tab dies. This module keeps one OPFS checkpoint per project — written
 * on a trailing debounce after every edit and flushed on pagehide/tab-hide — so the
 * editor can offer "Restore unsaved changes?" on the next open.
 *
 * Deliberately simple: one file per project (`recovery/<id>.json`), last writer wins
 * (multi-tab races are acceptable — the prompt is user-confirmed, never auto-applied).
 * OPFS unavailable → every function is a silent no-op; recovery is best-effort by design.
 */

export interface RecoveryCheckpoint {
  savedAt: string;
  durationSeconds: number;
  graph: ProjectGraph;
}

const OPFS_DIR = "recovery";
const CHECKPOINT_DEBOUNCE_MS = 1000;

/** Resolution order: `?crashRecovery=0|1` → localStorage `orreris.crashRecovery` → `VITE_CRASH_RECOVERY` → true. */
export function getCrashRecoveryEnabled(): boolean {
  const truthy = (v: string | null | undefined): boolean => v === "1" || v === "true";
  if (typeof window !== "undefined") {
    try {
      if (new URLSearchParams(window.location.search).has("crashRecovery")) {
        return truthy(new URLSearchParams(window.location.search).get("crashRecovery"));
      }
      const stored = window.localStorage?.getItem("orreris.crashRecovery");
      if (stored != null) return truthy(stored);
    } catch {
      /* SSR / restricted storage — fall through */
    }
  }
  const env = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_CRASH_RECOVERY;
  return env == null ? true : truthy(env);
}

async function getRecoveryDir(): Promise<FileSystemDirectoryHandle | null> {
  const storage = navigator.storage as (StorageManager & { getDirectory?: () => Promise<FileSystemDirectoryHandle> }) | undefined;
  if (!storage?.getDirectory) return null;
  try {
    const root = await storage.getDirectory();
    return await root.getDirectoryHandle(OPFS_DIR, { create: true });
  } catch {
    return null;
  }
}

function checkpointFileName(projectId: string): string {
  return `${projectId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`;
}

interface PendingCheckpoint {
  graph: ProjectGraph;
  durationSeconds: number;
  timer: number;
}

const pending = new Map<string, PendingCheckpoint>();
// Serialize writes per project so a slow OPFS write can't be overtaken by a newer one
// finishing first (last-committed content must be the newest edit).
const writeChains = new Map<string, Promise<void>>();
let lifecycleFlushRegistered = false;

function registerLifecycleFlush(): void {
  if (lifecycleFlushRegistered || typeof window === "undefined") return;
  lifecycleFlushRegistered = true;
  const flushAll = () => {
    for (const projectId of [...pending.keys()]) {
      flushCheckpoint(projectId);
    }
  };
  window.addEventListener("pagehide", flushAll);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushAll();
  });
}

function flushCheckpoint(projectId: string): void {
  const entry = pending.get(projectId);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(projectId);
  const chain = (writeChains.get(projectId) ?? Promise.resolve())
    .then(() => writeCheckpoint(projectId, entry.graph, entry.durationSeconds))
    .catch(() => {
      /* best-effort */
    });
  writeChains.set(projectId, chain);
}

async function writeCheckpoint(projectId: string, graph: ProjectGraph, durationSeconds: number): Promise<void> {
  const dir = await getRecoveryDir();
  if (!dir) return;
  const payload: RecoveryCheckpoint = { savedAt: new Date().toISOString(), durationSeconds, graph };
  const handle = await dir.getFileHandle(checkpointFileName(projectId), { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(JSON.stringify(payload));
    await writable.close();
  } catch (error) {
    try {
      await writable.abort();
    } catch {
      /* already closed */
    }
    throw error;
  }
}

/**
 * Record the latest graph for `projectId` on a trailing debounce. Call on every edit —
 * cheap (timer reset) until the debounce fires. Covers server projects too, unlike the
 * localStorage draft record.
 */
export function scheduleRecoveryCheckpoint(projectId: string, graph: ProjectGraph, durationSeconds: number): void {
  if (!getCrashRecoveryEnabled() || typeof window === "undefined") return;
  registerLifecycleFlush();
  const existing = pending.get(projectId);
  if (existing) clearTimeout(existing.timer);
  const timer = window.setTimeout(() => flushCheckpoint(projectId), CHECKPOINT_DEBOUNCE_MS);
  pending.set(projectId, { graph, durationSeconds, timer });
}

/** Read the stored checkpoint for a project (null when absent/unreadable/disabled). */
export async function readRecoveryCheckpoint(projectId: string): Promise<RecoveryCheckpoint | null> {
  if (!getCrashRecoveryEnabled()) return null;
  const dir = await getRecoveryDir();
  if (!dir) return null;
  try {
    const handle = await dir.getFileHandle(checkpointFileName(projectId));
    const file = await handle.getFile();
    const parsed = JSON.parse(await file.text()) as Partial<RecoveryCheckpoint>;
    if (!parsed || typeof parsed.savedAt !== "string" || !parsed.graph || typeof parsed.durationSeconds !== "number") {
      return null;
    }
    return parsed as RecoveryCheckpoint;
  } catch {
    return null;
  }
}

/** Delete a project's checkpoint (user chose Discard, or the project was deleted). */
export async function discardRecoveryCheckpoint(projectId: string): Promise<void> {
  const entry = pending.get(projectId);
  if (entry) {
    clearTimeout(entry.timer);
    pending.delete(projectId);
  }
  const dir = await getRecoveryDir();
  if (!dir) return;
  try {
    await dir.removeEntry(checkpointFileName(projectId));
  } catch {
    /* already gone */
  }
}
