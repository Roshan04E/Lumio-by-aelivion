import {
  createProjectEffect,
  createDefaultComposition,
  instantiateTemplateComposition,
  resolveModuleInsertions,
  templateDefinitions,
  toolDefinitions,
  walletPacks,
  type AssetAiRef,
  type AssetExternalRef,
  type AssetSource,
  type ModuleType,
  type PluginCatalogResponse,
  type PluginPackageKind,
  type ProjectGraph,
  type RenderJob,
  type SourceAsset,
  type SourceColorMetadata,
  type StockOrientation,
  type StockResult,
  type StockVariant,
  type CaptionInterchangeArtifact,
  type CaptionTrackData,
  type CloudTranscriptionLanguage,
  type TranscriptArtifactData,
  type TemplateDefinition,
  type ToolDefinition
} from "@orreris/shared";
import { getAssetBlobStore, requestPersistentAssetStorage } from "./asset-blob-store";
// Runtime-only use (inside function bodies) — safe across the api⇄sync circular edge; no top-level call.
import {
  candidateProjectIds,
  clearLocalAssetPromotion,
  getAssetPromotionMap,
  markLocalAssetPromoted,
  resolveProjectId
} from "./sync";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4100/api";

/** Thrown when an EXISTING project id can't be loaded from server or local storage. Callers should retry or
 *  surface an error — NEVER swap in a blank project, which the user can unknowingly edit (lost-work scare). */
export class ProjectLoadError extends Error {
  constructor(public readonly projectId: string) {
    super(`Could not load project ${projectId}. Check your connection and try again.`);
    this.name = "ProjectLoadError";
  }
}

const LOCAL_PROJECT_ID_PREFIX = "project_local_";
const tokenKey = "orreris_token";
const localProjectsKey = "orreris_local_projects";
const localAssetsKey = "orreris_local_assets";
// Mirrors the server ProjectAsset join for the offline/local-first path: projectId -> linked assetIds.
// Keep the filtering logic here in lockstep with the server GET /assets scope in apps/api.
const localProjectLinksKey = "orreris_project_asset_links";
const pluginCatalogLatestKey = "orreris_plugin_catalog_latest";

type LocalProjectLinks = Record<string, string[]>;

function readLocalProjectLinks(): LocalProjectLinks {
  return readLocal<LocalProjectLinks>(localProjectLinksKey, {});
}
function writeLocalProjectLinks(links: LocalProjectLinks): void {
  writeLocal(localProjectLinksKey, links);
}
function addLocalProjectLink(projectId: string, assetId: string): void {
  const links = readLocalProjectLinks();
  const set = new Set(links[projectId] ?? []);
  set.add(assetId);
  links[projectId] = [...set];
  writeLocalProjectLinks(links);
}
function removeLocalProjectLink(projectId: string, assetId: string): void {
  const links = readLocalProjectLinks();
  if (!links[projectId]) return;
  links[projectId] = links[projectId].filter((id) => id !== assetId);
  writeLocalProjectLinks(links);
}
/** Local-first mirror of the server's `scope` filter (project = owned uploads + linked; library = no owner). */
function filterLocalAssetsByScope(
  assets: SourceAsset[],
  projectId: string | undefined,
  scope: "project" | "library" | "all"
): SourceAsset[] {
  if (scope === "library") return assets.filter((a) => !a.ownerProjectId);
  if (scope === "project" && projectId) {
    const linked = new Set(readLocalProjectLinks()[projectId] ?? []);
    return assets.filter((a) => a.ownerProjectId === projectId || linked.has(a.id));
  }
  return assets;
}
/** Marker stored as a local asset's fileUrl; the real bytes live in the on-device blob
 *  store (asset-blob-store.ts) and are resolved to a fresh object URL on load. */
export const LOCAL_BLOB_PREFIX = "localblob:";

/** Resolve any local-blob-marker asset URLs to live session object URLs from the store. */
async function resolveLocalAssetUrls(assets: SourceAsset[]): Promise<SourceAsset[]> {
  if (!assets.some((asset) => asset.fileUrl?.startsWith(LOCAL_BLOB_PREFIX))) {
    return assets;
  }
  const store = await getAssetBlobStore();
  return Promise.all(
    assets.map(async (asset) => {
      if (!asset.fileUrl?.startsWith(LOCAL_BLOB_PREFIX)) return asset;
      const id = asset.fileUrl.slice(LOCAL_BLOB_PREFIX.length);
      const url = await store.getObjectUrl(id);
      if (url) return { ...asset, fileUrl: url };
      // On-device bytes missing (evicted/other machine) but a cloud copy exists → play from cloud.
      return asset.cloudUrl ? { ...asset, fileUrl: asset.cloudUrl } : asset;
    })
  );
}

/**
 * LOCAL CACHE OVERLAY (media pull, M2): a SERVER/stock asset whose bytes were pulled on-device
 * (media-pull.ts caches them under the asset's own id) plays from the local copy instead of
 * streaming — same behavior a local upload gets. Records are untouched (the http URL stays the
 * durable location); only the resolved, session-facing fileUrl is swapped. Never touches local-
 * marker assets (resolveLocalAssetUrls owns those) or non-http URLs.
 */
async function overlayPulledAssetUrls(assets: SourceAsset[]): Promise<SourceAsset[]> {
  const store = await getAssetBlobStore();
  return Promise.all(
    assets.map(async (asset) => {
      if (!asset.fileUrl || !/^https?:\/\//i.test(asset.fileUrl)) return asset;
      const url = (await store.has(asset.id)) ? await store.getObjectUrl(asset.id) : null;
      return url ? { ...asset, cloudUrl: asset.cloudUrl ?? asset.fileUrl, fileUrl: url } : asset;
    })
  );
}

export interface ApiEnvelope<T> {
  success: boolean;
  message: string;
  data: T;
}

export interface UserRecord {
  id: string;
  name: string;
  email: string;
  walletCredits: number;
}

export interface ProjectRecord {
  id: string;
  userId: string;
  templateId?: string | null | undefined;
  title: string;
  status: string;
  sourceAssetId?: string | null | undefined;
  projectGraph: ProjectGraph;
  previewUrl?: string | null | undefined;
  finalUrl?: string | null | undefined;
  durationSeconds: number;
  createdAt: string;
  updatedAt: string;
  template?: TemplateDefinition | null | undefined;
  sourceAsset?: SourceAsset | null | undefined;
  renderJobs?: RenderJob[];
}

/** Thrown when a request needs a valid session that isn't present (401). */
export class AuthRequiredError extends Error {
  constructor(message = "Authentication required") {
    super(message);
    this.name = "AuthRequiredError";
  }
}

/** The real JWT, or null for guests (a legacy "mock-local-token" counts as no session). */
export function getToken(): string | null {
  const token = localStorage.getItem(tokenKey);
  return token && token !== "mock-local-token" ? token : null;
}

export function isAuthenticated(): boolean {
  return getToken() !== null;
}

export function logout(): void {
  localStorage.removeItem(tokenKey);
}

const DEMO_CREDENTIALS = { name: "Demo Creator", email: "demo@pesamee.studio", password: "password123" };

export async function loginRequest(email: string, password: string): Promise<UserRecord> {
  const data = await apiRequest<{ token: string; user: UserRecord }>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password })
  });
  localStorage.setItem(tokenKey, data.token);
  return data.user;
}

export async function signupRequest(name: string, email: string, password: string): Promise<UserRecord> {
  const data = await apiRequest<{ token: string; user: UserRecord }>("/auth/signup", {
    method: "POST",
    body: JSON.stringify({ name, email, password })
  });
  localStorage.setItem(tokenKey, data.token);
  return data.user;
}

export async function googleLoginRequest(credential: string): Promise<UserRecord> {
  const data = await apiRequest<{ token: string; user: UserRecord }>("/auth/google", {
    method: "POST",
    body: JSON.stringify({ credential })
  });
  localStorage.setItem(tokenKey, data.token);
  return data.user;
}

/**
 * "Try demo" — log in as the demo account, creating it first if the DB hasn't been seeded.
 * Lets anyone explore instantly without signup and never depends on a manual `db:seed`.
 */
export async function loginDemo(): Promise<UserRecord> {
  try {
    return await loginRequest(DEMO_CREDENTIALS.email, DEMO_CREDENTIALS.password);
  } catch {
    return signupRequest(DEMO_CREDENTIALS.name, DEMO_CREDENTIALS.email, DEMO_CREDENTIALS.password);
  }
}

/**
 * Session is owned by the AuthProvider now — this is a no-op kept for the many call sites
 * that awaited it. It deliberately does NOT auto-login: a guest stays a guest (local-first),
 * and authed endpoints return 401 → AuthRequiredError → local fallback for reads.
 */
export async function ensureDemoSession() {
  /* intentionally empty */
}

/** Validate the stored session against the server. Throws if there is no valid session. */
export async function fetchCurrentUser(): Promise<UserRecord> {
  if (!getToken()) {
    throw new AuthRequiredError();
  }
  const data = await apiRequest<{ user: UserRecord }>("/auth/me");
  return data.user;
}

export async function getMe(): Promise<UserRecord> {
  try {
    const data = await apiRequest<{ user: UserRecord }>("/auth/me");
    return data.user;
  } catch {
    return {
      id: "local_demo",
      name: "Demo Creator",
      email: "demo@pesamee.studio",
      walletCredits: Number(localStorage.getItem("orreris_wallet") ?? 120)
    };
  }
}

export async function listTemplates(): Promise<TemplateDefinition[]> {
  try {
    const data = await apiRequest<{ templates: TemplateDefinition[] }>("/templates");
    return data.templates;
  } catch {
    return templateDefinitions;
  }
}

/** Curated (userId null) + the current user's own saved templates — the in-editor Templates gallery. */
export async function listMyTemplates(): Promise<TemplateDefinition[]> {
  try {
    const data = await apiRequest<{ templates: TemplateDefinition[] }>("/templates/mine");
    return data.templates;
  } catch {
    return templateDefinitions;
  }
}

/** Delete one of the current user's own saved templates (curated templates can't be deleted this way). */
export async function deleteTemplate(id: string): Promise<void> {
  await apiRequest(`/templates/${id}`, { method: "DELETE" });
}

export async function createTemplate(input: {
  name: string;
  category: string;
  description: string;
  durationSeconds: number;
  requiredModules: string[];
  templateGraph: ProjectGraph;
}): Promise<TemplateDefinition> {
  const slug = `${input.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "custom"}-${Date.now().toString(36)}`;
  const data = await apiRequest<{ template: TemplateDefinition }>("/templates", {
    method: "POST",
    body: JSON.stringify({
      name: input.name,
      slug,
      category: input.category,
      description: input.description,
      durationSeconds: Math.round(input.durationSeconds),
      requiredModules: input.requiredModules,
      editableFields: [],
      templateGraph: input.templateGraph,
      active: true
    })
  });
  return data.template;
}

export async function listTools(): Promise<ToolDefinition[]> {
  try {
    const data = await apiRequest<{ tools: ToolDefinition[] }>("/tools");
    return data.tools;
  } catch {
    return toolDefinitions;
  }
}

export async function listPluginPackages(kind: PluginPackageKind | "all" = "all"): Promise<PluginCatalogResponse> {
  const params = new URLSearchParams();
  if (kind !== "all") {
    params.set("kind", kind);
  }
  const cacheNamespace = kind;
  try {
    const data = await apiRequest<PluginCatalogResponse>(`/plugin-packages${params.size ? `?${params.toString()}` : ""}`);
    writePluginCatalogCache(cacheNamespace, data);
    return data;
  } catch {
    return readPluginCatalogCache(cacheNamespace) ?? { packages: [], revision: "offline-empty" };
  }
}

export interface CreateAssetInput {
  file?: File | undefined;
  fileName?: string | undefined;
  fileType?: string | undefined;
  durationSeconds?: number | undefined;
  width?: number | undefined;
  height?: number | undefined;
  hasAudio?: boolean | undefined;
  // --- Media-library metadata ---
  source?: AssetSource | undefined;
  folder?: string | undefined;
  originalName?: string | undefined;
  thumbnailUrl?: string | undefined;
  fps?: number | undefined;
  sizeBytes?: number | undefined;
  tags?: string[] | undefined;
  projectId?: string | undefined;
  external?: AssetExternalRef | undefined;
  ai?: AssetAiRef | undefined;
  /** Detected source color metadata (Rec.709 SDR contract); absent → assume Rec.709. */
  color?: SourceColorMetadata | undefined;
  /** Container display rotation (0/90/180/270°) read from the tkhd matrix at ingest; absent/0 = none. */
  rotationDegrees?: 0 | 90 | 180 | 270 | undefined;
  /**
   * Local-first import: keep the bytes on-device (OPFS) and NEVER auto-upload them to the server.
   * The asset only reaches the cloud when the user explicitly pushes it (the Media Pool cloud toggle)
   * or when the export preflight (ensureExportReady) promotes it. Used by user file imports so large
   * footage isn't silently shipped to R2 on drop.
   */
  localOnly?: boolean | undefined;
}

export async function createAsset(input: CreateAssetInput) {
  // Send the EXACT fractional duration — SourceAsset.durationSeconds is a Float column now. The old
  // scheme (ceil to Int for the server, restore the real value only on THIS response) silently lost
  // the real duration on every reload/listAssets: clips created from a reloaded asset ran up to ~1s
  // past the decodable media and froze on their last frame (2026-07-13 frozen-tail report).
  // withRealDuration stays as a belt-and-braces fixup against any stale server still returning ints.
  const durationSeconds = Math.max(0.2, Math.min(7200, input.durationSeconds ?? 12));
  const realDuration = durationSeconds;
  const tags = withAssetAudioTag(input.tags, input.hasAudio);
  const withRealDuration = (asset: SourceAsset): SourceAsset => ({ ...asset, durationSeconds: realDuration });

  // Persist the bytes on-device and record a local asset — no server round-trip. This is the
  // local-first path (used explicitly via `localOnly`, and as the offline fallback below).
  async function persistLocally(): Promise<SourceAsset> {
    const file = input.file;
    const isFileVideo = file?.type.startsWith("video/");
    // Random suffix: a bare Date.now() id COLLIDES when two imports land in the same millisecond —
    // both assets then share one id, the second OPFS put overwrites the first file's bytes (data
    // loss), and every id-keyed UI (menus, selection, used-counts) matches both tiles.
    const id = `asset_local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Persist the actual bytes on-device so the asset survives refresh and large clips load
    // instantly. Only a stable marker is stored as the URL; the live object URL is resolved
    // now (for immediate use) and re-resolved by listAssets() / resolveLocalAssetUrls() later.
    let liveUrl = "/assets/orreris-hero.png";
    if (file) {
      try {
        const store = await getAssetBlobStore();
        // Local taxonomy mirror (plans/media-cloud-architecture.md): project-owned bytes live under
        // the project's OPFS home, library assets under library/. Purely organizational — reads
        // stay id-keyed with a legacy-flat fallback.
        await store.put(id, file, { projectId: input.projectId ?? null });
        void requestPersistentAssetStorage();
        liveUrl = (await store.getObjectUrl(id)) ?? URL.createObjectURL(file);
      } catch {
        liveUrl = URL.createObjectURL(file); // session-only last resort
      }
    }

    const asset: SourceAsset = {
      id,
      userId: "local_demo",
      fileName: file?.name ?? input.fileName ?? "demo-clip.mp4",
      fileType: file?.type ?? input.fileType ?? "video/mp4",
      // Persist the MARKER, not the (session-only) object URL.
      fileUrl: file ? `${LOCAL_BLOB_PREFIX}${id}` : liveUrl,
      durationSeconds: realDuration,
      width: input.width ?? 1080,
      height: input.height ?? 1920,
      status: isFileVideo || file?.type.startsWith("image/") ? "ready" : "uploaded",
      createdAt: new Date().toISOString(),
      source: input.source ?? "local",
      folder: input.folder,
      originalName: input.originalName ?? file?.name ?? input.fileName,
      thumbnailUrl: input.thumbnailUrl,
      fps: input.fps,
      sizeBytes: input.sizeBytes ?? file?.size,
      tags,
      projectId: input.projectId,
      // A local upload is owned by the project it was added to (null = user-level library asset).
      ownerProjectId: input.projectId,
      external: input.external,
      ai: input.ai,
      ...(input.color ? { color: input.color } : {}),
      ...(input.rotationDegrees ? { rotationDegrees: input.rotationDegrees } : {})
    };
    const assets = readLocal<SourceAsset[]>(localAssetsKey, []);
    writeLocal(localAssetsKey, [asset, ...assets]);
    // Mirror the server's auto-link so the project's scoped bin shows this upload offline too.
    if (input.projectId) addLocalProjectLink(input.projectId, id);
    return { ...asset, fileUrl: liveUrl };
  }

  // Local-first import: never ship the bytes to the server on drop. They stay in OPFS until the
  // user opts in (Media Pool cloud toggle) or the export preflight promotes them. This is the
  // whole point of the editor being local-first — big footage isn't auto-uploaded.
  if (input.localOnly) {
    return persistLocally();
  }

  await ensureDemoSession();

  try {
    if (input.file) {
      const body = new FormData();
      body.append("file", input.file);
      body.append("durationSeconds", String(durationSeconds));
      body.append("width", String(input.width ?? 1080));
      body.append("height", String(input.height ?? 1920));
      appendAssetMetadata(body, { ...input, tags });
      const data = await apiRequest<{ asset: SourceAsset }>("/assets", { method: "POST", body });
      return withRealDuration(data.asset);
    }

    const data = await apiRequest<{ asset: SourceAsset }>("/assets", {
      method: "POST",
      body: JSON.stringify({
        fileName: input.fileName ?? "demo-clip.mp4",
        fileType: input.fileType ?? "video/mp4",
        durationSeconds,
        width: input.width ?? 1080,
        height: input.height ?? 1920,
        source: input.source,
        folder: input.folder,
        originalName: input.originalName,
        thumbnailUrl: input.thumbnailUrl,
        fps: input.fps,
        sizeBytes: input.sizeBytes,
        projectId: input.projectId,
        tags,
        external: input.external,
        ai: input.ai,
        color: input.color,
        rotationDegrees: input.rotationDegrees
      })
    });
    return withRealDuration(data.asset);
  } catch {
    // Backend unreachable (or the upload failed): fall back to the same on-device persist.
    return persistLocally();
  }
}

export interface PresignedAssetUpload {
  asset: SourceAsset;
  uploadUrl: string;
}

/**
 * Request a presigned direct-to-R2 upload: the server creates the SourceAsset row and returns a
 * PUT URL the browser streams bytes to itself (see cloud-upload.ts) — no API RAM buffering, no
 * double bandwidth. Returns `null` when the backend is on local-disk storage (no presign); callers
 * then fall back to the multipart `createAsset` path. On a failed PUT, delete the returned asset id.
 */
export async function presignAssetUpload(input: CreateAssetInput): Promise<PresignedAssetUpload | null> {
  await ensureDemoSession();
  const durationSeconds = Math.max(0.2, Math.min(7200, input.durationSeconds ?? 12));
  const tags = withAssetAudioTag(input.tags, input.hasAudio);
  const data = await apiRequest<{ supported: boolean; asset?: SourceAsset; uploadUrl?: string }>(
    "/assets/presign",
    {
      method: "POST",
      body: JSON.stringify({
        fileName: input.fileName ?? "demo-clip.mp4",
        fileType: input.fileType ?? "video/mp4",
        durationSeconds,
        width: input.width ?? 1080,
        height: input.height ?? 1920,
        source: input.source,
        folder: input.folder,
        originalName: input.originalName,
        thumbnailUrl: input.thumbnailUrl,
        fps: input.fps,
        sizeBytes: input.sizeBytes,
        projectId: input.projectId,
        tags,
        external: input.external,
        ai: input.ai,
        color: input.color,
        rotationDegrees: input.rotationDegrees
      })
    }
  );
  if (!data.supported || !data.asset || !data.uploadUrl) return null;
  // Send back the EXACT fractional duration, same as createAsset (Float column; server clamps).
  return { asset: { ...data.asset, durationSeconds }, uploadUrl: data.uploadUrl };
}

/** Append optional media-library metadata to the multipart upload body. */
function appendAssetMetadata(body: FormData, input: CreateAssetInput) {
  if (input.source) body.append("source", input.source);
  if (input.folder) body.append("folder", input.folder);
  if (input.originalName) body.append("originalName", input.originalName);
  if (input.thumbnailUrl) body.append("thumbnailUrl", input.thumbnailUrl);
  if (input.fps != null) body.append("fps", String(input.fps));
  if (input.sizeBytes != null) body.append("sizeBytes", String(input.sizeBytes));
  if (input.projectId) body.append("projectId", input.projectId);
  if (input.tags?.length) body.append("tags", JSON.stringify(input.tags));
  if (input.external) body.append("external", JSON.stringify(input.external));
  if (input.ai) body.append("ai", JSON.stringify(input.ai));
  if (input.color) body.append("color", JSON.stringify(input.color));
  if (input.rotationDegrees) body.append("rotationDegrees", String(input.rotationDegrees));
}

const ASSET_AUDIO_TRUE_TAG = "orreris:audio=true";
const ASSET_AUDIO_FALSE_TAG = "orreris:audio=false";

function withAssetAudioTag(tags: string[] | undefined, hasAudio: boolean | undefined): string[] | undefined {
  const clean = (tags ?? []).filter((tag) => tag !== ASSET_AUDIO_TRUE_TAG && tag !== ASSET_AUDIO_FALSE_TAG);
  if (hasAudio === undefined) return clean.length ? clean : undefined;
  return [...clean, hasAudio ? ASSET_AUDIO_TRUE_TAG : ASSET_AUDIO_FALSE_TAG];
}

/**
 * List assets scoped to a project (its owned uploads + linked library assets), the reusable library pool, or
 * everything. The local-first fallback mirrors the server's scope filter via `filterLocalAssetsByScope`.
 */
export async function listAssets(
  projectId?: string,
  scope: "project" | "library" | "all" = "all"
): Promise<SourceAsset[]> {
  await ensureDemoSession();

  const params = new URLSearchParams();
  if (projectId) params.set("projectId", projectId);
  if (scope !== "all") params.set("scope", scope);
  const query = params.toString();

  try {
    const data = await apiRequest<{ assets: SourceAsset[] }>(`/assets${query ? `?${query}` : ""}`);
    // ONE ASSET, TWO LOCATIONS. Imports are local-first (createAsset localOnly), so browser-local
    // records must merge into the online list — the server alone doesn't know them, and dropping
    // them would orphan every timeline clip that references them. An uploaded local asset keeps its
    // LOCAL id and tile; its cloud copy is recorded in the sync registry (localId → serverId), and
    // the paired SERVER asset is hidden here — so an upload never shows as a duplicate tile.
    const localRecords = filterLocalAssetsByScope(readLocal<SourceAsset[]>(localAssetsKey, []), projectId, scope).filter(
      (asset) => asset.id.startsWith(LOCAL_ASSET_ID_PREFIX)
    );
    if (localRecords.length === 0) return data.assets;

    const promotions = getAssetPromotionMap();
    const claimed = new Set(Object.values(promotions));
    const serverById = new Map(data.assets.map((asset) => [asset.id, asset]));

    // Adoption (one-time healing for uploads made before pairing existed): a server asset that
    // matches an unpaired local by exact name + nonzero size IS that local's cloud copy — record
    // the pairing so it collapses into the local tile from now on.
    for (const local of localRecords) {
      if (promotions[local.id]) continue;
      const twin = data.assets.find(
        (server) =>
          !claimed.has(server.id) &&
          server.fileName === local.fileName &&
          typeof server.sizeBytes === "number" &&
          server.sizeBytes > 0 &&
          server.sizeBytes === local.sizeBytes
      );
      if (twin) {
        markLocalAssetPromoted(local.id, twin.id, twin.fileUrl);
        promotions[local.id] = twin.id;
        claimed.add(twin.id);
      }
    }

    // Overlay each paired local with its cloudUrl (persisting it once) so the tile reads "synced".
    const locals = localRecords.map((local) => {
      const serverId = promotions[local.id];
      if (!serverId) return local;
      const cloudUrl = serverById.get(serverId)?.fileUrl ?? local.cloudUrl;
      if (cloudUrl && local.cloudUrl !== cloudUrl) void updateLocalAssetRecord(local.id, { cloudUrl });
      return cloudUrl ? { ...local, cloudUrl } : local;
    });

    // Return EVERYTHING — including paired server assets. Timelines saved by the old remap-era
    // upload flow (and export-promoted server graphs) reference SERVER ids; dropping those records
    // here broke their clip resolution ("Missing video asset"). The bin hides paired server assets
    // at the DISPLAY layer instead (AssetBin filters via getAssetPromotionMap), so there is still
    // exactly one visible tile per logical asset.
    return [...(await resolveLocalAssetUrls(locals)), ...(await overlayPulledAssetUrls(data.assets))];
  } catch {
    const local = filterLocalAssetsByScope(readLocal<SourceAsset[]>(localAssetsKey, []), projectId, scope);
    return resolveLocalAssetUrls(local);
  }
}

/**
 * Project-scoped bin load (perf fix, 2026-07-17: a new project must NOT enumerate the whole
 * account): the project's owned+linked assets plus the user-level library pool (Brand/AI/stock —
 * browsable so they can be linked in), deduped. Graph-referenced ids that fall outside both scopes
 * (legacy remap-era graphs, cross-project duplicates) are healed by `fetchAssetById` on demand.
 */
export async function listProjectAssets(projectId: string): Promise<SourceAsset[]> {
  const [project, library] = await Promise.all([listAssets(projectId, "project"), listAssets(undefined, "library")]);
  const seen = new Set<string>();
  const merged: SourceAsset[] = [];
  for (const asset of [...project, ...library]) {
    if (seen.has(asset.id)) continue;
    seen.add(asset.id);
    merged.push(asset);
  }
  return merged;
}

/** Fetch one asset by id (server first, local records fallback). Null when unknown everywhere. */
export async function fetchAssetById(assetId: string): Promise<SourceAsset | null> {
  if (!assetId.startsWith(LOCAL_ASSET_ID_PREFIX)) {
    try {
      const data = await apiRequest<{ asset: SourceAsset }>(`/assets/${assetId}`);
      return (await overlayPulledAssetUrls([data.asset]))[0] ?? data.asset;
    } catch {
      /* fall through to local records */
    }
  }
  const local = readLocal<SourceAsset[]>(localAssetsKey, []).find((asset) => asset.id === assetId);
  return local ? ((await resolveLocalAssetUrls([local]))[0] ?? local) : null;
}

/** Prefix of ids minted by the local-first `createAsset` persist path (asset_local_<ts>). */
const LOCAL_ASSET_ID_PREFIX = "asset_local_";

/**
 * Remove a browser-local asset from the on-device stores WITHOUT touching the server (record +
 * OPFS bytes). Used by full asset deletion; callers must ensure nothing still references the id.
 */
export async function removeLocalAssetRecord(assetId: string): Promise<void> {
  if (!assetId.startsWith(LOCAL_ASSET_ID_PREFIX)) return;
  await withLocalAssetsWriteLock(async () => {
    const assets = readLocal<SourceAsset[]>(localAssetsKey, []);
    writeLocal(localAssetsKey, assets.filter((asset) => asset.id !== assetId));
  });
  try {
    const store = await getAssetBlobStore();
    await store.remove(assetId);
  } catch {
    /* best-effort — reclaiming the OPFS blob must never block the caller */
  }
}

/**
 * Patch a browser-local asset record in place (e.g. stamp `cloudUrl` after an upload, or clear it
 * after "Remove from cloud"). A key explicitly set to `undefined` in the patch is DELETED from the
 * record. No-op for server ids.
 */
export async function updateLocalAssetRecord(assetId: string, patch: Partial<SourceAsset>): Promise<void> {
  if (!assetId.startsWith(LOCAL_ASSET_ID_PREFIX)) return;
  await withLocalAssetsWriteLock(async () => {
    const assets = readLocal<SourceAsset[]>(localAssetsKey, []);
    writeLocal(
      localAssetsKey,
      assets.map((asset) => {
        if (asset.id !== assetId) return asset;
        const next = { ...asset, ...patch } as unknown as Record<string, unknown>;
        for (const [key, value] of Object.entries(patch)) {
          if (value === undefined) delete next[key];
        }
        return next as unknown as SourceAsset;
      })
    );
  });
}

/** Link a reusable library asset (brand/ai/stock) into a project's bin. Server + local-first mirror. */
export async function linkAssetToProject(assetId: string, projectId: string): Promise<void> {
  await ensureDemoSession();
  addLocalProjectLink(projectId, assetId);
  try {
    await apiRequest(`/assets/${assetId}/link`, { method: "POST", body: JSON.stringify({ projectId }) });
  } catch {
    /* local link already recorded; server will reconcile on next online create/link */
  }
}

/** Remove a library asset from a project's bin (does not delete the asset). Server + local-first mirror. */
export async function unlinkAssetFromProject(assetId: string, projectId: string): Promise<void> {
  await ensureDemoSession();
  removeLocalProjectLink(projectId, assetId);
  try {
    await apiRequest(`/assets/${assetId}/link?projectId=${encodeURIComponent(projectId)}`, { method: "DELETE" });
  } catch {
    /* local unlink already recorded */
  }
}

export async function deleteAsset(assetId: string) {
  await ensureDemoSession();

  // Local asset: remove the on-device record + bytes, AND its recorded cloud copy (if it was
  // uploaded) — otherwise the hidden paired server asset would linger as an unreachable orphan.
  if (assetId.startsWith(LOCAL_ASSET_ID_PREFIX)) {
    const serverId = getAssetPromotionMap()[assetId];
    if (serverId) {
      try {
        await apiRequest<{ id: string }>(`/assets/${serverId}`, { method: "DELETE" });
      } catch {
        /* cloud copy already gone or offline — the local delete still proceeds */
      }
      clearLocalAssetPromotion(assetId);
    }
    await removeLocalAssetRecord(assetId);
    return;
  }

  try {
    await apiRequest<{ id: string }>(`/assets/${assetId}`, { method: "DELETE" });
  } catch {
    const assets = readLocal<SourceAsset[]>(localAssetsKey, []);
    writeLocal(
      localAssetsKey,
      assets.filter((asset) => asset.id !== assetId)
    );
    try {
      const store = await getAssetBlobStore();
      await store.remove(assetId);
    } catch {
      /* best-effort cleanup */
    }
  }
}

// The local fallback below is a READ-MODIFY-WRITE of one localStorage key. Concurrent calls (the
// bin's batch label/move actions fire one per selected asset) all read the pre-batch array and the
// LAST write clobbered every other change — "only the latest selected gets the label"
// (2026-07-04). All local asset mutations therefore serialize through this chain.
let localAssetsWriteChain: Promise<unknown> = Promise.resolve();
function withLocalAssetsWriteLock<T>(task: () => Promise<T>): Promise<T> {
  const run = localAssetsWriteChain.then(task, task);
  localAssetsWriteChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

export async function updateAssetFolder(assetId: string, folder: string | null): Promise<SourceAsset> {
  await ensureDemoSession();

  try {
    const data = await apiRequest<{ asset: SourceAsset }>(`/assets/${assetId}`, {
      method: "PATCH",
      body: JSON.stringify({ folder })
    });
    return data.asset;
  } catch {
    return withLocalAssetsWriteLock(async () => {
      const assets = readLocal<SourceAsset[]>(localAssetsKey, []);
      const nextAssets = assets.map((asset) => (asset.id === assetId ? { ...asset, folder: folder ?? undefined } : asset));
      writeLocal(localAssetsKey, nextAssets);
      const updated = nextAssets.find((asset) => asset.id === assetId);
      if (!updated) {
        throw new Error("Asset not found");
      }
      return (await resolveLocalAssetUrls([updated]))[0] ?? updated;
    });
  }
}

/** Replace an asset's tag list (carries the editor's color label as a "label:<color>" tag). */
export async function updateAssetTags(assetId: string, tags: string[]): Promise<SourceAsset> {
  await ensureDemoSession();

  try {
    const data = await apiRequest<{ asset: SourceAsset }>(`/assets/${assetId}`, {
      method: "PATCH",
      body: JSON.stringify({ tags })
    });
    return data.asset;
  } catch {
    return withLocalAssetsWriteLock(async () => {
      const assets = readLocal<SourceAsset[]>(localAssetsKey, []);
      const nextAssets = assets.map((asset) => (asset.id === assetId ? { ...asset, tags } : asset));
      writeLocal(localAssetsKey, nextAssets);
      const updated = nextAssets.find((asset) => asset.id === assetId);
      if (!updated) {
        throw new Error("Asset not found");
      }
      return (await resolveLocalAssetUrls([updated]))[0] ?? updated;
    });
  }
}

/**
 * Duration HEAL: shrink a stored asset duration to the true decodable end demuxed by the proxy
 * transcode. Legacy rows (ceil-to-Int era) overshoot their media by up to ~1s, so clips authored
 * to that length freeze on the last frame for the overshoot. Downward-only (the server enforces
 * it too) and best-effort — a failure just means the next proxy build retries the heal.
 */
export async function healAssetDurationSeconds(assetId: string, durationSeconds: number): Promise<void> {
  const clamped = Math.max(0.2, Math.min(7200, durationSeconds));
  try {
    await apiRequest(`/assets/${assetId}`, {
      method: "PATCH",
      body: JSON.stringify({ durationSeconds: clamped })
    });
  } catch {
    /* offline/local — fall through to the local record below */
  }
  await withLocalAssetsWriteLock(async () => {
    const assets = readLocal<SourceAsset[]>(localAssetsKey, []);
    const next = assets.map((asset) =>
      asset.id === assetId && asset.durationSeconds > clamped ? { ...asset, durationSeconds: clamped } : asset
    );
    writeLocal(localAssetsKey, next);
  }).catch(() => undefined);
}

// --- Stock media ------------------------------------------------------------------
// One unified, provider-agnostic Search surface — no provider name is ever shown in the UI. Stock
// requires the server (search hits the provider API; import downloads the file into our own storage so
// the export worker can fetch it). No local-only fallback.

export async function getStockStatus(): Promise<{ configured: boolean }> {
  await ensureDemoSession();
  try {
    return await apiRequest<{ configured: boolean }>("/stock/status");
  } catch {
    return { configured: false };
  }
}

/** Page size the stock API returns — lets the UI decide when to offer "Load more". */
export const STOCK_PAGE_SIZE = 24;

export async function searchStock(
  query: string,
  type: "image" | "video",
  page = 1,
  orientation: StockOrientation = "all"
): Promise<{ configured: boolean; results: StockResult[] }> {
  await ensureDemoSession();
  const params = new URLSearchParams({ q: query, type, page: String(page), orientation });
  return apiRequest<{ configured: boolean; results: StockResult[] }>(`/stock/search?${params.toString()}`);
}

/**
 * Import a stock result. URL-FIRST by default (2026-07-17 directive): the created asset stores a
 * REFERENCE to the provider's CDN URL — no bytes are copied into our storage ("what's the point of
 * uploading stock the provider already serves"). Pass `{ referenceOnly: false }` for the legacy
 * copy-into-storage behavior (used when the user explicitly wants the bytes hosted by us).
 * On-device availability is separate: "Pin offline" (media-pull cache) works for both modes.
 */
export async function importStock(
  result: StockResult,
  variant?: StockVariant,
  projectId?: string,
  options: { referenceOnly?: boolean } = {}
): Promise<SourceAsset> {
  await ensureDemoSession();
  const data = await apiRequest<{ asset: SourceAsset }>("/stock/import", {
    method: "POST",
    body: JSON.stringify({
      externalId: result.externalId,
      type: result.type,
      downloadUrl: variant?.downloadUrl ?? result.downloadUrl,
      width: variant?.width ?? result.width,
      height: variant?.height ?? result.height,
      durationSeconds: result.durationSeconds,
      fileType: variant?.fileType ?? result.fileType,
      author: result.author,
      sourceUrl: result.sourceUrl,
      referenceOnly: options.referenceOnly ?? true,
      ...(projectId ? { projectId } : {})
    })
  });
  // Mirror the server's ProjectAsset link locally, so the bin's per-project stock scoping works
  // offline and immediately (the server link isn't serialized back on asset rows).
  if (projectId) addLocalProjectLink(projectId, data.asset.id);
  return data.asset;
}

/** Asset ids linked into a project (local-first mirror of the server ProjectAsset join). */
export function getLinkedAssetIdsForProject(projectId: string): string[] {
  return readLocalProjectLinks()[projectId] ?? [];
}

export async function transcribeAutoCaptions(input: {
  assetId: string;
  language: CloudTranscriptionLanguage;
  stylePresetId: string;
  highlightedWords: string;
  prompt?: string | undefined;
}): Promise<{ job: AutoCaptionTranscriptionJob }> {
  await ensureDemoSession();
  return apiRequest("/tools/auto-captions/transcribe", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export interface AutoCaptionTranscriptionJob {
  id: string;
  status: "queued" | "processing" | "completed" | "failed" | "cancelled";
  progress: number;
  message: string;
  errorMessage?: string | undefined;
  createdAt: string;
  updatedAt: string;
  result?: {
    transcript: TranscriptArtifactData;
    captionTrack: CaptionTrackData;
    captionInterchangeArtifact: CaptionInterchangeArtifact;
    provider: "gemini";
    model: string;
  } | undefined;
}

export async function getAutoCaptionTranscriptionJob(jobId: string): Promise<AutoCaptionTranscriptionJob> {
  await ensureDemoSession();
  const data = await apiRequest<{ job: AutoCaptionTranscriptionJob }>(`/tools/auto-captions/transcribe/${jobId}`);
  return data.job;
}

export async function cancelAutoCaptionTranscriptionJob(jobId: string): Promise<AutoCaptionTranscriptionJob> {
  await ensureDemoSession();
  const data = await apiRequest<{ job: AutoCaptionTranscriptionJob }>(`/tools/auto-captions/transcribe/${jobId}/cancel`, {
    method: "POST"
  });
  return data.job;
}

export type AutoCaptionTranscriptionResult = {
  transcript: TranscriptArtifactData;
  captionTrack: CaptionTrackData;
  captionInterchangeArtifact: CaptionInterchangeArtifact;
  provider: "gemini";
  model: string;
};

export async function transformAutoCaptions(input: {
  action: "repair" | "improve";
  transcriptText: string;
  language: CloudTranscriptionLanguage;
  durationSeconds?: number | undefined;
  styleGoal?: string | undefined;
  highlightedWords?: string | undefined;
}): Promise<{
  transcript: TranscriptArtifactData;
  provider: "gemini";
}> {
  await ensureDemoSession();
  return apiRequest("/tools/auto-captions/transform", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function suggestAutoCaptionHighlights(input: {
  transcriptText: string;
  language: CloudTranscriptionLanguage;
}): Promise<{
  words: string[];
  provider: "gemini";
}> {
  await ensureDemoSession();
  return apiRequest("/tools/auto-captions/highlights", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function createProject(input: {
  title: string;
  templateId?: string | undefined;
  sourceAssetId?: string | undefined;
  prompt?: string | undefined;
  orientation?: "portrait" | "landscape" | undefined;
  fps?: number | undefined;
  effects?: ModuleType[] | undefined;
  durationSeconds?: number | undefined;
}): Promise<ProjectRecord> {
  await ensureDemoSession();

  try {
    const data = await apiRequest<{ project: ProjectRecord }>("/projects", {
      method: "POST",
      body: JSON.stringify(input)
    });
    return data.project;
  } catch {
    const project = createLocalProject(input);
    saveLocalProject(project);
    return project;
  }
}

export async function listProjects(): Promise<ProjectRecord[]> {
  await ensureDemoSession();

  try {
    const data = await apiRequest<{ projects: ProjectRecord[] }>("/projects");
    return data.projects;
  } catch {
    return readLocal<ProjectRecord[]>(localProjectsKey, []);
  }
}

export async function getProject(projectId: string): Promise<ProjectRecord> {
  await ensureDemoSession();

  // Search local storage under EVERY id this project may be keyed by (self, mapped server id, mapped local
  // id). A promoted draft's record can be keyed by its local id while the UI holds the server id — searching
  // only one id is what caused the intermittent miss → blank "Untitled reel" fabrication.
  const readLocalCandidate = (): ProjectRecord | undefined => {
    const local = readLocal<ProjectRecord[]>(localProjectsKey, []);
    for (const id of candidateProjectIds(projectId)) {
      const found = local.find((item) => item.id === id);
      if (found) return found;
    }
    return undefined;
  };

  // Local drafts live ONLY in the browser — a server fetch for them always 404s, and routing that guaranteed
  // failure through the catch below is exactly what made a transient hiccup fabricate a blank project. Read
  // local FIRST for local ids and skip the doomed round trip.
  if (projectId.startsWith(LOCAL_PROJECT_ID_PREFIX)) {
    const local = readLocalCandidate();
    if (local) return local;
  }

  try {
    const data = await apiRequest<{ project: ProjectRecord }>(`/projects/${resolveProjectId(projectId)}`);
    return data.project;
  } catch (error) {
    const local = readLocalCandidate();
    if (local) return local;
    // No local copy. Preserve the AUTH distinction: a 401 (guest / expired session) is not a transient
    // network blip — retrying can't help, the caller must prompt sign-in. Re-throw AuthRequiredError as-is;
    // otherwise fail with ProjectLoadError. Either way we NEVER fabricate a blank project the user could edit.
    if (error instanceof AuthRequiredError) throw error;
    throw new ProjectLoadError(projectId);
  }
}

export async function patchProject(projectId: string, patch: Partial<ProjectRecord>) {
  try {
    const data = await apiRequest<{ project: ProjectRecord }>(`/projects/${projectId}`, {
      method: "PATCH",
      body: JSON.stringify(patch)
    });
    return data.project;
  } catch {
    const project = await getProject(projectId);
    const updated = { ...project, ...patch, updatedAt: new Date().toISOString() };
    saveLocalProject(updated);
    return updated;
  }
}

export async function deleteProject(projectId: string): Promise<void> {
  try {
    await apiRequest(`/projects/${resolveProjectId(projectId)}`, { method: "DELETE" });
  } catch {
    // Local draft or backend offline — the local removal below is the source of truth for those.
  }
  removeLocalProjectRecord(projectId);
}

/** Clone a project into a fresh local draft (new ids, "copy" suffix, reset to draft with no renders). */
export async function duplicateProject(projectId: string): Promise<ProjectRecord> {
  const source = await getProject(projectId);
  const id = `${LOCAL_PROJECT_ID_PREFIX}${Date.now()}`;
  const graph: ProjectGraph = { ...source.projectGraph, projectId: id };
  if (graph.composition) {
    graph.composition = { ...graph.composition, id: `composition_${id}` };
  }
  const now = new Date().toISOString();
  const copy: ProjectRecord = {
    ...source,
    id,
    title: `${source.title} copy`,
    status: "draft",
    previewUrl: undefined,
    finalUrl: undefined,
    projectGraph: graph,
    createdAt: now,
    updatedAt: now
  };
  saveLocalProject(copy);
  return copy;
}

export async function addEffect(projectId: string, type: ModuleType, config: Record<string, unknown> = {}) {
  try {
    const data = await apiRequest<{ project: ProjectRecord; insertedEffects: ProjectGraph["effects"] }>(
      `/projects/${projectId}/add-effect`,
      {
        method: "POST",
        body: JSON.stringify({ type, config })
      }
    );
    return data;
  } catch {
    const project = await getProject(projectId);
    const insertedEffects = resolveModuleInsertions(project.projectGraph.effects, type, {
      editableFields: project.projectGraph.editableFields
    }).map((effect) => (effect.type === type ? { ...effect, config: { ...effect.config, ...config } } : effect));
    const updatedGraph = {
      ...project.projectGraph,
      effects: [...project.projectGraph.effects, ...insertedEffects],
      version: project.projectGraph.version + 1
    };
    const updated = await patchProject(projectId, { projectGraph: updatedGraph });
    return { project: updated, insertedEffects };
  }
}

export async function generatePreview(projectId: string) {
  try {
    const data = await apiRequest<{ project: ProjectRecord }>(`/projects/${projectId}/preview`, { method: "POST" });
    return data.project;
  } catch {
    const project = await getProject(projectId);
    return patchProject(projectId, {
      status: "preview_ready",
      previewUrl: createLocalRenderUrl("preview", project)
    });
  }
}

export async function exportFinal(projectId: string) {
  try {
    const data = await apiRequest<{ project: ProjectRecord }>(`/projects/${projectId}/export`, { method: "POST" });
    return data.project;
  } catch (error) {
    if (projectId.startsWith("project_local_")) {
      throw new Error("This is a local browser draft. Create a new project while the backend is running to export a real MP4.");
    }

    throw error;
  }
}

export async function getRenderManifest(projectId: string, quality: "preview" | "final" = "final") {
  const data = await apiRequest<{ manifest: unknown }>(`/projects/${projectId}/render-manifest?quality=${quality}`);
  return data.manifest;
}

export async function listJobs() {
  try {
    const data = await apiRequest<{ jobs: RenderJob[] }>("/jobs");
    return data.jobs;
  } catch {
    const projects = readLocal<ProjectRecord[]>(localProjectsKey, []);
    return projects.flatMap((project) => project.renderJobs ?? []);
  }
}

/** Cancel a queued/processing render job. Returns the updated job. */
export async function cancelJob(id: string) {
  const data = await apiRequest<{ job: RenderJob }>(`/jobs/${id}/cancel`, { method: "POST" });
  return data.job;
}

export async function buyCredits(packId: "starter" | "creator" | "growth", projectId?: string) {
  try {
    const order = await apiRequest<{ payment: { id: string } }>("/payments/create-order", {
      method: "POST",
      body: JSON.stringify({ packId, projectId })
    });
    await apiRequest("/payments/verify", {
      method: "POST",
      body: JSON.stringify({ paymentId: order.payment.id, providerPaymentId: `mock_${Date.now()}` })
    });
    return true;
  } catch {
    const pack = walletPacks.find((item) => item.id === packId);
    const wallet = Number(localStorage.getItem("orreris_wallet") ?? 120);
    localStorage.setItem("orreris_wallet", String(wallet + (pack?.credits ?? 0)));
    return true;
  }
}

// --- Phase 0 shadow-billing (MONETIZATION_STRATEGY.md §4): usage telemetry readout ---
// Additive-only: this NEVER represents a debit. Every row/aggregate is "free during beta".

export interface UsageActionSummary {
  action: string;
  units: number;
  credits: number;
  count: number;
}

export interface UsageSummary {
  totalShadowCredits: number;
  byAction: UsageActionSummary[];
  periodStart: string;
}

/** Recent shadow-billing usage + per-action aggregates for the account/checkout "usage this
 *  month (free during beta)" panel. Returns an empty summary (never throws) for guests/offline. */
export async function fetchUsage(): Promise<UsageSummary> {
  try {
    const data = await apiRequest<UsageSummary & { rows: unknown[] }>("/payments/usage");
    return { totalShadowCredits: data.totalShadowCredits, byAction: data.byAction, periodStart: data.periodStart };
  } catch {
    return { totalShadowCredits: 0, byAction: [], periodStart: new Date().toISOString() };
  }
}

// --- Phase 11: AI Memory OS sync (client-first; ai/memory.ts owns the offline cache) ---

export interface MemoryFactDTO {
  id: string;
  scope: string;
  projectId: string | null;
  key: string;
  value: unknown;
  confidence: number;
  source: string;
  lastUsedAt: string;
  updatedAt: string;
}

export interface MemoryFactUpsert {
  scope: "creator" | "project" | "style";
  projectId?: string | undefined;
  key: string;
  value: string | number | boolean | string[];
  confidence?: number | undefined;
  source?: "inferred" | "explicit" | undefined;
}

/** These throw on failure (offline / no DB) — the caller in `ai/memory.ts` falls back to localStorage. */
export async function listMemory(projectId?: string): Promise<MemoryFactDTO[]> {
  await ensureDemoSession();
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  const data = await apiRequest<{ facts: MemoryFactDTO[] }>(`/memory${query}`);
  return data.facts;
}

export async function upsertMemory(facts: MemoryFactUpsert[]): Promise<MemoryFactDTO[]> {
  await ensureDemoSession();
  const data = await apiRequest<{ facts: MemoryFactDTO[] }>("/memory", {
    method: "PUT",
    body: JSON.stringify({ facts })
  });
  return data.facts;
}

export async function deleteMemory(id: string): Promise<boolean> {
  await ensureDemoSession();
  const data = await apiRequest<{ removed: boolean }>(`/memory/${id}`, { method: "DELETE" });
  return data.removed;
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  return apiRequestWithAuthRetry<T>(path, init, true);
}

/** Origin of the API (without the `/api` suffix), for non-`/api` routes like `/health`. */
function apiOrigin(): string {
  return API_URL.replace(/\/api\/?$/, "");
}

/** Lightweight connectivity probe — true if the backend `/health` responds OK. */
export async function pingHealth(timeoutMs = 3500): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${apiOrigin()}/health`, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// --- Local store accessors (used by the sync engine; bytes live in asset-blob-store) ---

export function listLocalProjects(): ProjectRecord[] {
  return readLocal<ProjectRecord[]>(localProjectsKey, []);
}

export function readLocalProject(id: string): ProjectRecord | undefined {
  return listLocalProjects().find((item) => item.id === id);
}

export function writeLocalProjectRecord(project: ProjectRecord): void {
  saveLocalProject(project);
}

export function removeLocalProjectRecord(id: string): void {
  writeLocal(localProjectsKey, listLocalProjects().filter((item) => item.id !== id));
}

export function listLocalAssetRecords(): SourceAsset[] {
  return readLocal<SourceAsset[]>(localAssetsKey, []);
}

export function writeLocalAssetRecords(assets: SourceAsset[]): void {
  writeLocal(localAssetsKey, assets);
}

// ── Backend-offline state (2026-07-03) ─────────────────────────────────────
// A refused connection used to surface as N unhandled fetch errors (one per mounted data hook)
// with nothing user-visible. Now: the FIRST network failure flips a shared offline flag (the app
// shows a banner via useApiOffline), every request while offline fails fast with ApiOfflineError
// (callers' local-fallback paths catch it like any error — no thundering retry herd), and ONE
// /health poller with backoff flips the flag back when the backend returns.
// Note: the browser itself still logs net::ERR_CONNECTION_REFUSED lines for real attempts — that
// console noise is Chrome's, not an unhandled error; this keeps attempts to the single poller.

export class ApiOfflineError extends Error {
  constructor() {
    super("Backend offline — the API at " + API_URL + " is not reachable. Working locally; retrying in the background.");
    this.name = "ApiOfflineError";
  }
}

let apiOffline = false;
let offlinePollTimer: number | undefined;
const offlineListeners = new Set<(offline: boolean) => void>();

export function isApiOffline(): boolean {
  return apiOffline;
}

export function subscribeApiOffline(listener: (offline: boolean) => void): () => void {
  offlineListeners.add(listener);
  return () => offlineListeners.delete(listener);
}

function setApiOffline(next: boolean): void {
  if (apiOffline === next) return;
  apiOffline = next;
  for (const listener of offlineListeners) listener(next);
  if (next) {
    scheduleOfflinePoll(2000);
  } else if (offlinePollTimer !== undefined) {
    clearTimeout(offlinePollTimer);
    offlinePollTimer = undefined;
  }
}

function scheduleOfflinePoll(delayMs: number): void {
  if (typeof window === "undefined") return;
  if (offlinePollTimer !== undefined) clearTimeout(offlinePollTimer);
  offlinePollTimer = window.setTimeout(() => {
    offlinePollTimer = undefined;
    void pingHealth().then((ok) => {
      if (ok) {
        setApiOffline(false);
      } else if (apiOffline) {
        scheduleOfflinePoll(Math.min(15_000, delayMs * 1.6)); // backoff 2s → 15s cap
      }
    });
  }, delayMs);
}

async function apiRequestWithAuthRetry<T>(path: string, init: RequestInit = {}, _canRetryAuth: boolean): Promise<T> {
  // Fail fast while offline: one poller owns reconnection; data callers drop to their local paths.
  if (apiOffline) {
    throw new ApiOfflineError();
  }
  const headers = new Headers(init.headers);
  const bodyIsForm = init.body instanceof FormData;
  if (!bodyIsForm && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const token = getToken();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, { ...init, headers });
  } catch (error) {
    // fetch rejects with TypeError ONLY for network-level failures (refused/DNS/CORS) — the
    // backend is unreachable, not returning errors.
    if (error instanceof TypeError) {
      setApiOffline(true);
      throw new ApiOfflineError();
    }
    throw error;
  }
  const json = (await response.json()) as ApiEnvelope<T>;

  // A 401 on a non-auth route means the session is missing/expired. Drop the stale token
  // and surface AuthRequiredError. Read paths catch it and fall back to local (guest mode);
  // cloud actions (export) surface it to prompt sign-in. No more silent demo re-login.
  if (response.status === 401 && !path.startsWith("/auth/")) {
    localStorage.removeItem(tokenKey);
    throw new AuthRequiredError(json.message || "Authentication required");
  }

  if (!response.ok || !json.success) {
    throw new Error(json.message || "API request failed");
  }

  return json.data;
}

function createLocalProject(input: {
  title: string;
  templateId?: string | undefined;
  sourceAssetId?: string | undefined;
  prompt?: string | undefined;
  orientation?: "portrait" | "landscape" | undefined;
  fps?: number | undefined;
  effects?: ModuleType[] | undefined;
  durationSeconds?: number | undefined;
}): ProjectRecord {
  const template = templateDefinitions.find((item) => item.id === input.templateId || item.slug === input.templateId) ?? templateDefinitions[0]!;
  const sourceAsset = input.sourceAssetId ? readLocal<SourceAsset[]>(localAssetsKey, []).find((asset) => asset.id === input.sourceAssetId) : undefined;
  const id = `project_local_${Date.now()}`;
  const presetEffects = (input.effects ?? []).map((type) => createProjectEffect(type));
  // "Continue without a template": no templateId, no prompt AND no preset stack → a genuinely
  // blank project. Mirrors the server, which only instantiates a template's authored composition
  // when one was actually selected.
  const usesTemplate = Boolean(input.templateId);
  const isBlank = !usesTemplate && !input.prompt && presetEffects.length === 0;
  const graph: ProjectGraph = input.prompt
    ? {
        projectId: id,
        sourceAssetId: input.sourceAssetId,
        effects: [createProjectEffect("AUTO_CAPTIONS"), createProjectEffect("MOTION_TEXT"), createProjectEffect("ZOOM_CUTS")],
        editableFields: { hookText: input.prompt, captionStyle: "bold_yellow" },
        version: 1
      }
    : usesTemplate
      ? {
          ...template.templateGraph,
          projectId: id,
          sourceAssetId: input.sourceAssetId,
          version: 1
        }
      : { projectId: id, sourceAssetId: input.sourceAssetId, effects: presetEffects, editableFields: {}, version: 1 };

  // A composition-based (save-as-template) template carries an authored composition - instantiate
  // it. Prompt drafts, goal presets, and blank projects all get the clean default timeline instead.
  const templateComposition = !input.prompt && usesTemplate ? template.templateGraph.composition : undefined;
  graph.composition = templateComposition
    ? instantiateTemplateComposition(templateComposition, id, { sourceAssetId: input.sourceAssetId, name: input.title })
    : createDefaultComposition({
        id,
        name: input.title,
        durationSeconds: sourceAsset?.durationSeconds ?? input.durationSeconds ?? template.durationSeconds,
        assetId: input.sourceAssetId,
        orientation: input.orientation,
        fps: input.fps,
        blank: isBlank
      });
  const projectDurationSeconds = graph.composition.durationSeconds;

  const now = new Date().toISOString();
  return {
    id,
    userId: "local_demo",
    templateId: template.id,
    title: input.title,
    status: "draft",
    sourceAssetId: input.sourceAssetId,
    projectGraph: graph,
    durationSeconds: projectDurationSeconds,
    createdAt: now,
    updatedAt: now,
    template,
    sourceAsset
  };
}

function saveLocalProject(project: ProjectRecord) {
  const projects = readLocal<ProjectRecord[]>(localProjectsKey, []);
  const withoutCurrent = projects.filter((item) => item.id !== project.id);
  writeLocal(localProjectsKey, [project, ...withoutCurrent]);
}

function readPluginCatalogCache(namespace: string): PluginCatalogResponse | undefined {
  const latest = readLocal<Record<string, string>>(pluginCatalogLatestKey, {});
  const revision = latest[namespace];
  return revision ? readLocal<PluginCatalogResponse | undefined>(`orreris_plugin_catalog_${namespace}_${revision}`, undefined) : undefined;
}

function writePluginCatalogCache(namespace: string, value: PluginCatalogResponse) {
  const latest = readLocal<Record<string, string>>(pluginCatalogLatestKey, {});
  writeLocal(pluginCatalogLatestKey, { ...latest, [namespace]: value.revision });
  writeLocal(`orreris_plugin_catalog_${namespace}_${value.revision}`, value);
}

function readLocal<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeLocal<T>(key: string, value: T) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    // Quota overflow (large graphs) or restricted storage must not break the caller —
    // every writeLocal consumer is a best-effort local cache/registry.
    console.warn(`[orreris] localStorage write failed for "${key}"`, error);
  }
}

function createLocalRenderUrl(type: "preview" | "final", project: ProjectRecord) {
  const assets = readLocal<SourceAsset[]>(localAssetsKey, []);
  const payload = {
    type: `local-${type}-manifest`,
    projectId: project.id,
    title: project.title,
    createdAt: new Date().toISOString(),
    note: "Local browser fallback. Create/open a DB-backed project to use the worker render pipeline.",
    graph: project.projectGraph,
    assets
  };
  return URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
}
