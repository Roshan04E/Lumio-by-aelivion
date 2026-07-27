/**
 * Local-first sync engine.
 *
 * The editor can run fully offline (local drafts: `project_local_*` ids, `asset_local_*`
 * media whose bytes live in the on-device blob store). Server export, however, can only
 * render server projects whose media is on the server. This module bridges the two:
 *
 *   - timeline edits are written locally instantly and synced to the server in the
 *     background (debounced),
 *   - when the backend is reachable, local drafts are automatically PROMOTED to server
 *     projects: upload every local asset (reusing the real createAsset FormData path),
 *     remap the timeline's local asset ids to the server ids, create the server project,
 *     and save the remapped graph,
 *   - `ensureExportReady()` is a hard gate the Export button runs first, so the worker is
 *     never invoked with a local id or `localblob:`/`blob:` media.
 *
 * Promotion is idempotent: a `serverAssetId`/`serverId` already recorded is reused, so a
 * retry (reconnect + export racing) never duplicates assets or projects.
 *
 * Sync metadata is a small client-only registry in localStorage; media bytes stay in
 * asset-blob-store.ts. No DB/shared type changes.
 */

import type { ProjectGraph, SourceAsset } from "@orreris/shared";
import { collectFlarexSourceAssetIds, remapFlarexSourceAssetIds } from "@orreris/shared";
import {
  apiRequest,
  AuthRequiredError,
  isAuthenticated,
  listLocalAssetRecords,
  listLocalProjects,
  pingHealth,
  readLocalProject,
  writeLocalAssetRecords,
  writeLocalProjectRecord,
  type ProjectRecord,
} from "./api";
import { collectUnresolvedMattes, MatteResolveError, resolveGraphMattes } from "../export/matte-resolve";
import { getAssetBlobStore } from "./asset-blob-store";
import { scheduleRecoveryCheckpoint } from "./crash-recovery";

const SYNC_KEY = "orreris_sync_state";
const LOCAL_PROJECT_PREFIX = "project_local_";
const LOCAL_ASSET_PREFIX = "asset_local_";
const SAVE_DEBOUNCE_MS = 800;
// Local draft persistence used to run synchronously on EVERY edit — a full JSON
// stringify of every local project's graph into localStorage, per drag frame on
// a big timeline. A short trailing debounce (+ pagehide/tab-hide flush) keeps the
// crash-loss window tiny while removing the per-edit main-thread serialize.
const LOCAL_PERSIST_DEBOUNCE_MS = 250;
const POLL_INTERVAL_MS = 20000;

export type AssetSyncStatus = "local" | "uploading" | "synced" | "missing" | "failed";
export type ProjectSyncStatus = "local" | "syncing" | "synced" | "failed";

/** The five user-visible states surfaced by the badge. */
export type UiSyncStatus = "saved-local" | "syncing" | "synced" | "export-ready" | "failed";

export interface AssetSyncRecord {
  localAssetId: string;
  serverAssetId?: string | undefined;
  localBlobKey: string;
  serverUrl?: string | undefined;
  fileName?: string | undefined;
  fileType?: string | undefined;
  durationSeconds?: number | undefined;
  width?: number | undefined;
  height?: number | undefined;
  syncStatus: AssetSyncStatus;
}

export interface ProjectSyncRecord {
  localId: string;
  serverId?: string | undefined;
  syncStatus: ProjectSyncStatus;
  lastSyncedAt?: string | undefined;
  pendingGraph?: boolean | undefined;
}

interface SyncState {
  assets: Record<string, AssetSyncRecord>;
  projects: Record<string, ProjectSyncRecord>;
}

export interface RelinkAssetNeed {
  localAssetId: string;
  fileName: string;
}

export type PromoteResult =
  | { status: "promoted"; project: ProjectRecord }
  | { status: "needs-relink"; assets: RelinkAssetNeed[] }
  | { status: "offline" }
  | { status: "noop" }
  | { status: "error"; message: string };

export class SyncRequiredError extends Error {
  constructor(message = "Sync required before export.") {
    super(message);
    this.name = "SyncRequiredError";
  }
}

export class RelinkRequiredError extends Error {
  assets: RelinkAssetNeed[];
  constructor(assets: RelinkAssetNeed[]) {
    super("This media needs to be selected once so we can sync it for export. Your edits are safe.");
    this.name = "RelinkRequiredError";
    this.assets = assets;
  }
}

// ── Registry ────────────────────────────────────────────────────────────────

function readState(): SyncState {
  try {
    const raw = localStorage.getItem(SYNC_KEY);
    if (!raw) return { assets: {}, projects: {} };
    const parsed = JSON.parse(raw) as Partial<SyncState>;
    return { assets: parsed.assets ?? {}, projects: parsed.projects ?? {} };
  } catch {
    return { assets: {}, projects: {} };
  }
}

function writeState(state: SyncState): void {
  try {
    localStorage.setItem(SYNC_KEY, JSON.stringify(state));
  } catch {
    /* ignore quota errors — registry is best-effort */
  }
  emit();
}

function upsertProject(localId: string, patch: Partial<ProjectSyncRecord>): ProjectSyncRecord {
  const state = readState();
  const next: ProjectSyncRecord = { localId, syncStatus: "local", ...state.projects[localId], ...patch };
  state.projects[localId] = next;
  writeState(state);
  return next;
}

function upsertAsset(localAssetId: string, patch: Partial<AssetSyncRecord>): void {
  const state = readState();
  state.assets[localAssetId] = {
    localAssetId,
    localBlobKey: localAssetId,
    syncStatus: "local",
    ...state.assets[localAssetId],
    ...patch,
  };
  writeState(state);
}

// ── Pub/sub ───────────────────────────────────────────────────────────────--

const listeners = new Set<() => void>();
export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  ensureMonitor();
  return () => listeners.delete(cb);
}
function emit(): void {
  for (const cb of listeners) cb();
}

// ── Connectivity ──────────────────────────────────────────────────────────--

let lastKnownOnline = true;
let pollTimer: number | null = null;
let monitorStarted = false;

export function getOnline(): boolean {
  return lastKnownOnline;
}

function setOnline(value: boolean): void {
  if (lastKnownOnline !== value) {
    lastKnownOnline = value;
    emit();
  }
}

/** Any local-origin draft that has not yet become a server project. */
function pendingLocalProjectIds(): string[] {
  const state = readState();
  return listLocalProjects()
    .filter((p) => p.id.startsWith(LOCAL_PROJECT_PREFIX) && !state.projects[p.id]?.serverId)
    .map((p) => p.id);
}

function hasPendingWork(): boolean {
  if (pendingLocalProjectIds().length > 0) return true;
  const state = readState();
  return Object.values(state.projects).some((p) => p.pendingGraph || p.syncStatus === "failed");
}

/** Real connectivity probe; promotes pending work on success (only when authenticated). */
export async function checkNow(): Promise<boolean> {
  const ok = await pingHealth();
  setOnline(ok);
  if (ok && isAuthenticated() && hasPendingWork()) {
    void promoteAllPending();
  }
  return ok;
}

function ensureMonitor(): void {
  if (monitorStarted || typeof window === "undefined") return;
  monitorStarted = true;
  window.addEventListener("online", () => void checkNow());
  pollTimer = window.setInterval(() => {
    if (hasPendingWork()) void checkNow();
  }, POLL_INTERVAL_MS);
}

export function stopMonitor(): void {
  if (pollTimer != null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  monitorStarted = false;
}

// ── Redirect resolution ───────────────────────────────────────────────────--

/** Map an id the UI holds (possibly a promoted local id) to the live server id. */
export function resolveProjectId(id: string): string {
  return readState().projects[id]?.serverId ?? id;
}

/**
 * Every id a project may be stored under, given ANY id the UI holds — the id itself, its mapped server id
 * (if this is a promoted local draft), and its local id (if this is a server id whose local record is keyed
 * differently). A local lookup must try all of these: after promotion the localStorage record can be keyed
 * by the local id while the UI/route holds the server id (or vice-versa), and searching only one id is what
 * makes `getProject` miss and fabricate a blank project on a transient server failure.
 */
export function candidateProjectIds(id: string): string[] {
  const ids = new Set<string>([id]);
  const state = readState();
  const serverId = state.projects[id]?.serverId;
  if (serverId) ids.add(serverId);
  for (const record of Object.values(state.projects)) {
    if (record.serverId === id || record.localId === id) {
      ids.add(record.localId);
      if (record.serverId) ids.add(record.serverId);
    }
  }
  return [...ids];
}

/** Record a project that was created directly on the server (online) as already synced. */
export function markServerProjectSynced(id: string): void {
  if (id.startsWith(LOCAL_PROJECT_PREFIX)) return;
  const existing = readState().projects[id];
  if (existing?.syncStatus === "synced" && existing.serverId === id) return;
  upsertProject(id, { serverId: id, syncStatus: "synced", lastSyncedAt: new Date().toISOString(), pendingGraph: false });
}

// ── Server-only API calls (no local fallback — promotion must hit the server) --

async function serverCreateProject(input: {
  title: string;
  templateId?: string | undefined;
  sourceAssetId?: string | undefined;
}): Promise<ProjectRecord> {
  const data = await apiRequest<{ project: ProjectRecord }>("/projects", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return data.project;
}

async function serverPatchProject(id: string, patch: Partial<ProjectRecord>): Promise<ProjectRecord> {
  const data = await apiRequest<{ project: ProjectRecord }>(`/projects/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  return data.project;
}

async function serverGetProject(id: string): Promise<ProjectRecord> {
  const data = await apiRequest<{ project: ProjectRecord }>(`/projects/${id}`);
  return data.project;
}

async function serverCreateAsset(
  file: File,
  meta: { durationSeconds?: number | undefined; width?: number | undefined; height?: number | undefined }
): Promise<SourceAsset> {
  const body = new FormData();
  body.append("file", file);
  // Exact fractional duration (Float column) — ceiling here made promoted assets overshoot their
  // media on later loads, freezing clip tails (see createAsset in api.ts for the full story).
  body.append("durationSeconds", String(Math.max(0.2, meta.durationSeconds ?? 12)));
  body.append("width", String(meta.width ?? 1080));
  body.append("height", String(meta.height ?? 1920));
  const data = await apiRequest<{ asset: SourceAsset }>("/assets", { method: "POST", body });
  return data.asset;
}

// ── Graph helpers ─────────────────────────────────────────────────────────--

function collectAssetIds(graph: ProjectGraph): Set<string> {
  const ids = new Set<string>();
  if (graph.sourceAssetId) ids.add(graph.sourceAssetId);
  for (const track of graph.composition?.tracks ?? []) {
    for (const layer of track.layers) {
      if (layer.assetId) ids.add(layer.assetId);
    }
  }
  // Flarex asset-source MediaIns load media-pool assets that are NOT on any track, so the walk above
  // cannot see them. They were therefore never uploaded on export and the render worker 404'd on them
  // (user report 2026-07-27). This set drives BOTH the upload and the relink check, so both were blind.
  for (const assetId of collectFlarexSourceAssetIds(graph.flarexComps)) ids.add(assetId);
  return ids;
}

function remapGraph(graph: ProjectGraph, map: Record<string, string>): ProjectGraph {
  const clone = structuredClone(graph) as ProjectGraph;
  if (clone.sourceAssetId && map[clone.sourceAssetId]) clone.sourceAssetId = map[clone.sourceAssetId];
  for (const track of clone.composition?.tracks ?? []) {
    for (const layer of track.layers) {
      if (layer.assetId && map[layer.assetId]) layer.assetId = map[layer.assetId];
    }
  }
  // ...and the same remap inside Flarex comps, or the promoted graph keeps LOCAL ids in its MediaIn
  // nodes while the timeline points at server ones — the worker then 404s on the local id.
  remapFlarexSourceAssetIds(clone.flarexComps, map);
  return clone;
}

// ── Background graph save (debounced, local-first) ──────────────────────────--

interface PendingSave {
  graph: ProjectGraph;
  durationSeconds: number;
  timer: number;
}
const pendingSaves = new Map<string, PendingSave>();

/**
 * Called by the editor on every edit. Persists the graph to the local draft record
 * immediately and debounces a background server sync. Never throws.
 */
export function scheduleGraphSave(projectId: string, graph: ProjectGraph, durationSeconds: number): void {
  // Persist to the local draft record shortly (debounced; flushed on pagehide) so a
  // refresh keeps the edit while offline — without a full-graph serialize per edit.
  scheduleLocalPersist(projectId, graph, durationSeconds);
  // OPFS crash checkpoint covers server projects too (localStorage drafts don't).
  scheduleRecoveryCheckpoint(projectId, graph, durationSeconds);
  if (projectId.startsWith(LOCAL_PROJECT_PREFIX)) {
    upsertProject(projectId, { pendingGraph: true });
  } else {
    upsertProject(projectId, { serverId: projectId, pendingGraph: true });
  }
  emit();

  const existing = pendingSaves.get(projectId);
  if (existing) clearTimeout(existing.timer);
  const timer = window.setTimeout(() => void flushGraphSave(projectId), SAVE_DEBOUNCE_MS);
  pendingSaves.set(projectId, { graph, durationSeconds, timer });
  ensureMonitor();
}

interface PendingLocalPersist {
  graph: ProjectGraph;
  durationSeconds: number;
  timer: number;
}
const pendingLocalPersists = new Map<string, PendingLocalPersist>();
let persistFlushRegistered = false;

function scheduleLocalPersist(projectId: string, graph: ProjectGraph, durationSeconds: number): void {
  if (!persistFlushRegistered && typeof window !== "undefined") {
    persistFlushRegistered = true;
    window.addEventListener("pagehide", flushAllLocalPersists);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flushAllLocalPersists();
    });
  }
  const existing = pendingLocalPersists.get(projectId);
  if (existing) clearTimeout(existing.timer);
  const timer = window.setTimeout(() => flushLocalPersist(projectId), LOCAL_PERSIST_DEBOUNCE_MS);
  pendingLocalPersists.set(projectId, { graph, durationSeconds, timer });
}

function flushLocalPersist(projectId: string): void {
  const entry = pendingLocalPersists.get(projectId);
  if (!entry) return;
  clearTimeout(entry.timer);
  pendingLocalPersists.delete(projectId);
  persistLocalGraph(projectId, entry.graph, entry.durationSeconds);
}

function flushAllLocalPersists(): void {
  for (const projectId of [...pendingLocalPersists.keys()]) {
    flushLocalPersist(projectId);
  }
}

function persistLocalGraph(projectId: string, graph: ProjectGraph, durationSeconds: number): void {
  try {
    const record = readLocalProject(projectId);
    if (!record) return; // server-only project — server is the store
    record.projectGraph = graph;
    record.durationSeconds = durationSeconds;
    record.updatedAt = new Date().toISOString();
    writeLocalProjectRecord(record);
  } catch {
    // localStorage quota/serialization failure must never break editing — the OPFS
    // crash checkpoint (no 5MB quota) still holds the newest graph for recovery.
  }
}

async function flushGraphSave(projectId: string): Promise<void> {
  // Commit any debounced local persist first so the draft record matches what syncs.
  flushLocalPersist(projectId);
  const pending = pendingSaves.get(projectId);
  if (pending) {
    clearTimeout(pending.timer);
    pendingSaves.delete(projectId);
  }

  // A local draft must be promoted (which also saves its graph). A server project just
  // patches. In both cases syncProject() does the right, idempotent thing.
  const result = await syncProject(projectId, pending?.graph, pending?.durationSeconds);
  if (result.status === "offline") {
    // Stay "Saved locally"; the monitor retries on reconnect.
    upsertProject(projectId, { syncStatus: "local" });
  }
}

/** Force any queued save for this id to run now and wait for it. */
export async function flushPendingSave(projectId: string): Promise<void> {
  if (!pendingSaves.has(projectId)) return;
  await flushGraphSave(projectId);
}

// ── Promotion / sync (idempotent) ───────────────────────────────────────────

const inflight = new Map<string, Promise<PromoteResult>>();

export function promoteProject(projectId: string): Promise<PromoteResult> {
  return syncProject(projectId);
}

export async function promoteAllPending(): Promise<void> {
  if (!isAuthenticated()) return; // cloud sync requires a signed-in account
  for (const id of pendingLocalProjectIds()) {
    await syncProject(id);
  }
}

/**
 * Idempotently sync `projectId` to the server: create the server project (once) and save the graph.
 * `overrideGraph` is the freshest in-editor graph (from the debounced save) if available.
 *
 * LOCAL-FIRST DOCTRINE: background sync ships the project JSON ONLY. Media bytes leave the device
 * exclusively when `uploadAssets` is true — passed by the EXPORT gate (ensureExportReady), which is
 * user intent to render in the cloud. (The other byte paths are the Pro-gated media-pool buttons.)
 * Without it, un-uploaded local ids stay in the saved graph as-is; already-recorded pairings still
 * remap. Background sync used to upload every referenced asset's bytes, silently pushing footage
 * to the server on every edit — the 2026-07-14 "it's in the cloud but I never opted in" report.
 */
function syncProject(
  projectId: string,
  overrideGraph?: ProjectGraph,
  overrideDuration?: number,
  options?: { uploadAssets?: boolean }
): Promise<PromoteResult> {
  const existing = inflight.get(projectId);
  if (existing) return existing;
  const run = doSyncProject(projectId, overrideGraph, overrideDuration, options).finally(() => inflight.delete(projectId));
  inflight.set(projectId, run);
  return run;
}

async function doSyncProject(
  projectId: string,
  overrideGraph?: ProjectGraph,
  overrideDuration?: number,
  options?: { uploadAssets?: boolean }
): Promise<PromoteResult> {
  const uploadAssets = options?.uploadAssets === true;
  // Promotion paths (reconnect monitor) may run without an override graph — make sure
  // the local record they fall back to includes any still-debounced edit.
  flushLocalPersist(projectId);
  const localRecord = readLocalProject(projectId);
  const state = readState();
  const projRec = state.projects[projectId];

  // Resolve the working graph + metadata.
  const graph = overrideGraph ?? localRecord?.projectGraph;
  const serverId = projRec?.serverId;

  if (!graph && !serverId) {
    return { status: "error", message: "Draft not found" };
  }

  if (!isAuthenticated()) {
    // Cloud sync requires an account — stay a local draft until the user signs in.
    return { status: "offline" };
  }
  if (!(await pingHealth())) {
    setOnline(false);
    return { status: "offline" };
  }
  setOnline(true);

  upsertProject(projectId, { syncStatus: "syncing" });

  try {
    const workingGraph = graph ?? (await serverGetProject(serverId!)).projectGraph;
    const durationSeconds = overrideDuration ?? localRecord?.durationSeconds ?? 0;

    // 1. Map local asset ids to recorded cloud copies; upload bytes ONLY in export mode.
    const localAssetIds = [...collectAssetIds(workingGraph)].filter((id) => id.startsWith(LOCAL_ASSET_PREFIX));
    const map: Record<string, string> = {};
    const missing: RelinkAssetNeed[] = [];
    const store = await getAssetBlobStore();
    const localAssets = listLocalAssetRecords();

    for (const id of localAssetIds) {
      const recorded = readState().assets[id];
      if (recorded?.serverAssetId) {
        map[id] = recorded.serverAssetId;
        continue;
      }
      if (!uploadAssets) {
        // Background sync: leave the un-uploaded local id in the graph. Bytes stay on-device
        // until the user opts in (media-pool cloud actions) or exports (uploadAssets: true).
        continue;
      }
      const meta = localAssets.find((a) => a.id === id);
      const blob = await store.getBlob(id);
      if (!blob) {
        upsertAsset(id, { syncStatus: "missing", fileName: meta?.fileName });
        missing.push({ localAssetId: id, fileName: meta?.fileName ?? "media" });
        continue;
      }
      upsertAsset(id, { syncStatus: "uploading", fileName: meta?.fileName, fileType: meta?.fileType });
      try {
        const file = new File([blob], meta?.fileName ?? `${id}`, {
          type: meta?.fileType || blob.type || "application/octet-stream",
        });
        const serverAsset = await serverCreateAsset(file, {
          durationSeconds: meta?.durationSeconds,
          width: meta?.width,
          height: meta?.height,
        });
        map[id] = serverAsset.id;
        upsertAsset(id, { serverAssetId: serverAsset.id, serverUrl: serverAsset.fileUrl, syncStatus: "synced" });
      } catch (err) {
        upsertAsset(id, { syncStatus: "failed" });
        throw err;
      }
    }

    if (missing.length > 0) {
      // Edits stay safe locally; don't surface an alarming "failed" during editing — the export gate
      // (ensureExportReady) still returns needs-relink and prompts the user to re-select the media.
      upsertProject(projectId, { syncStatus: "local", pendingGraph: true });
      return { status: "needs-relink", assets: missing };
    }

    // 2. Remap local→server asset ids in the graph.
    let remapped = remapGraph(workingGraph, map);

    // 2b. Matte resolution uploads blob:/opfs: matte BYTES to the server, so it is export-mode
    // only (same local-first rule as media above); the export gate is the hard stop for anything
    // still unresolved at render time.
    if (uploadAssets) {
      try {
        const matteReport = await resolveGraphMattes(remapped);
        if (matteReport.resolvedCount > 0) {
          remapped = matteReport.graph;
        }
      } catch {
        /* matte upload is retried by the export gate's direct resolve */
      }
    }

    // 3. Create the server project once.
    let targetServerId = readState().projects[projectId]?.serverId;
    if (!targetServerId) {
      const created = await serverCreateProject({
        title: localRecord?.title ?? "Untitled reel",
        templateId: localRecord?.templateId ?? undefined,
        sourceAssetId: remapped.sourceAssetId,
      });
      targetServerId = created.id;
      upsertProject(projectId, { serverId: targetServerId });
    }

    // 4. Save the remapped graph server-side.
    const saved = await serverPatchProject(targetServerId, {
      projectGraph: remapped,
      durationSeconds,
    });

    upsertProject(projectId, {
      serverId: targetServerId,
      syncStatus: "synced",
      lastSyncedAt: new Date().toISOString(),
      pendingGraph: false,
    });
    if (targetServerId !== projectId) {
      // Self-record under the server id too, so saves keyed by the server id are synced.
      markServerProjectSynced(targetServerId);
    }
    return { status: "promoted", project: saved };
  } catch (err) {
    upsertProject(projectId, { syncStatus: "failed" });
    return { status: "error", message: err instanceof Error ? err.message : "Sync failed" };
  }
}

// ── Relink ────────────────────────────────────────────────────────────────--

/**
 * Record that a browser-local asset now has a cloud copy (the opt-in "upload to cloud" path).
 * The LOCAL id stays on the timeline and the bin — this only records the pairing, exactly like
 * syncProject does during an export promotion, so a later export reuses the server id instead of
 * re-uploading the bytes. ONE asset, two locations — never a second bin entry.
 */
export function markLocalAssetPromoted(localAssetId: string, serverAssetId: string, serverUrl?: string): void {
  upsertAsset(localAssetId, { serverAssetId, ...(serverUrl ? { serverUrl } : {}), syncStatus: "synced" });
}

/** Forget a local asset's cloud pairing (after "Remove from cloud"). Export will re-upload on demand. */
export function clearLocalAssetPromotion(localAssetId: string): void {
  const state = readState();
  const record = state.assets[localAssetId];
  if (!record?.serverAssetId) return;
  delete record.serverAssetId;
  delete record.serverUrl;
  record.syncStatus = "local";
  writeState(state);
}

/** The recorded cloud copy (server asset id) of a local asset, if it has been uploaded. */
export function getRecordedServerAssetId(localAssetId: string): string | undefined {
  return readState().assets[localAssetId]?.serverAssetId;
}

/** Full localId → serverId pairing map. Drives the bin merge: paired server assets are hidden
 *  behind their local tile so an uploaded asset never shows as a duplicate. */
export function getAssetPromotionMap(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [id, record] of Object.entries(readState().assets)) {
    if (record?.serverAssetId) map[id] = record.serverAssetId;
  }
  return map;
}

/** How many local project graphs reference `assetId` (optionally excluding one project). Powers the
 *  "used in N other projects" warning before removing a shared asset's cloud copy. */
export function countLocalProjectsUsingAsset(assetId: string, exceptProjectId?: string): number {
  let count = 0;
  for (const project of listLocalProjects()) {
    if (exceptProjectId && project.id === exceptProjectId) continue;
    const graph = (project as { projectGraph?: ProjectGraph }).projectGraph;
    if (graph && collectAssetIds(graph).has(assetId)) count += 1;
  }
  return count;
}

/**
 * Re-attach missing media bytes (re-selected by the user) under the SAME local asset id,
 * so existing `layer.assetId` references keep resolving, then clear the missing flag.
 */
export async function relinkAsset(localAssetId: string, file: File): Promise<void> {
  const store = await getAssetBlobStore();
  await store.put(localAssetId, file);
  // Refresh local asset metadata (name/type) so the eventual upload is well-formed.
  try {
    const assets = listLocalAssetRecords();
    const next = assets.map((a) =>
      a.id === localAssetId ? { ...a, fileName: file.name || a.fileName, fileType: file.type || a.fileType } : a
    );
    writeLocalAssetRecords(next);
  } catch {
    /* metadata refresh is best-effort */
  }
  upsertAsset(localAssetId, { syncStatus: "local", fileName: file.name, fileType: file.type });
}

// ── Export gate ─────────────────────────────────────────────────────────────

/**
 * Block export until: backend reachable, project has a server id, all timeline assets
 * uploaded, no localblob/blob URLs remain, and the latest graph is saved server-side.
 * Returns the server project id Export should use. Throws SyncRequiredError /
 * RelinkRequiredError for the UI to handle.
 */
export async function ensureExportReady(projectId: string): Promise<{ projectId: string }> {
  if (!isAuthenticated()) throw new AuthRequiredError("Sign in to export.");
  const online = await checkNow();
  if (!online) throw new SyncRequiredError();

  // Flush any debounced save for this id so promotion uses the freshest graph.
  await flushPendingSave(projectId).catch(() => undefined);

  // Export IS user intent to put the project's media in the cloud — the only sync mode that
  // uploads bytes (uploadAssets). Background saves never do (local-first doctrine).
  const result = await syncProject(projectId, undefined, undefined, { uploadAssets: true });
  if (result.status === "needs-relink") throw new RelinkRequiredError(result.assets);
  if (result.status === "offline") throw new SyncRequiredError();
  if (result.status === "error") throw new Error(result.message);

  const serverId = result.status === "promoted" ? result.project.id : resolveProjectId(projectId);

  // Verify no local asset ids slipped through (e.g. the call above coalesced onto an inflight
  // BACKGROUND sync, which doesn't upload) — one uploading retry closes that race.
  const serverProject = result.status === "promoted" ? result.project : await serverGetProject(serverId);
  const allIds = [...collectAssetIds(serverProject.projectGraph)];
  const remaining = allIds.filter((id) => id.startsWith(LOCAL_ASSET_PREFIX));
  // What the export believes it needs, and what is still local. `collectAssetIds` now includes Flarex
  // asset-source MediaIns (they are off-timeline); logging it makes an asset that was never uploaded
  // visible HERE rather than as a bare 404 in the render worker minutes later (2026-07-27).
  console.info("[export] assets required by this project:", {
    all: allIds,
    flarexSources: collectFlarexSourceAssetIds(serverProject.projectGraph.flarexComps),
    stillLocal: remaining,
  });
  if (remaining.length > 0) {
    const retry = await syncProject(projectId, serverProject.projectGraph, serverProject.durationSeconds, { uploadAssets: true });
    if (retry.status === "needs-relink") throw new RelinkRequiredError(retry.assets);
    if (retry.status !== "promoted") throw new Error("Could not finish preparing media for export.");
  }

  // Hard matte gate: the worker fetches `layer.matte.uri` like any media URL, and a
  // blob:/opfs: URI hangs the frame render silently. One direct resolve retry here
  // (the background-sync pass may have raced or failed), then fail loud naming the
  // layers so the user can re-run the extraction instead of watching a stuck export.
  const unresolvedMattes = collectUnresolvedMattes(serverProject.projectGraph.composition);
  if (unresolvedMattes.length > 0) {
    const matteReport = await resolveGraphMattes(serverProject.projectGraph);
    if (matteReport.resolvedCount > 0) {
      await serverPatchProject(serverId, { projectGraph: matteReport.graph });
    }
    if (matteReport.failures.length > 0) {
      throw new MatteResolveError(matteReport.failures);
    }
  }

  return { projectId: serverId };
}

// ── UI snapshot ─────────────────────────────────────────────────────────────

/** Stable string snapshot for useSyncExternalStore (value-compared, no re-render churn). */
export function getSyncStatusString(projectId: string): UiSyncStatus {
  const state = readState();
  const rec = state.projects[projectId] ?? (resolveProjectId(projectId) !== projectId ? state.projects[resolveProjectId(projectId)] : undefined);
  const isLocalDraft = projectId.startsWith(LOCAL_PROJECT_PREFIX) && !rec?.serverId;

  if (!rec) {
    // Unknown to the registry yet: a server id is export-ready, a local id is local-only.
    return isLocalDraft ? "saved-local" : "export-ready";
  }
  if (rec.syncStatus === "failed") return "failed";
  if (rec.syncStatus === "syncing") return "syncing";
  if (rec.syncStatus === "local" || isLocalDraft) return "saved-local";
  // synced
  if (rec.serverId && !rec.pendingGraph) return "export-ready";
  return "synced";
}
