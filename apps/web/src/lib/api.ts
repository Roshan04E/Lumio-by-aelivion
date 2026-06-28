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
  type ProjectGraph,
  type RenderJob,
  type SourceAsset,
  type StockOrientation,
  type StockResult,
  type StockVariant,
  type CaptionInterchangeArtifact,
  type CaptionTrackData,
  type CloudTranscriptionLanguage,
  type TranscriptArtifactData,
  type TemplateDefinition,
  type ToolDefinition
} from "@reelforge/shared";
import { getAssetBlobStore, requestPersistentAssetStorage } from "./asset-blob-store";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4100/api";
const tokenKey = "reelforge_token";
const localProjectsKey = "reelforge_local_projects";
const localAssetsKey = "reelforge_local_assets";
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
      return url ? { ...asset, fileUrl: url } : asset;
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

const DEMO_CREDENTIALS = { name: "Demo Creator", email: "demo@reelforge.studio", password: "password123" };

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
      email: "demo@reelforge.studio",
      walletCredits: Number(localStorage.getItem("reelforge_wallet") ?? 120)
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

export interface CreateAssetInput {
  file?: File | undefined;
  fileName?: string | undefined;
  fileType?: string | undefined;
  durationSeconds?: number | undefined;
  width?: number | undefined;
  height?: number | undefined;
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
}

export async function createAsset(input: CreateAssetInput) {
  await ensureDemoSession();

  try {
    // SourceAsset.durationSeconds is a Postgres Int column - a real clip's duration is
    // essentially never a whole number, so this must be rounded before it's sent.
    // Rounded UP, never down, so the stored value can never under-represent the
    // actual clip length (which would risk the timeline cutting it short).
    const durationSeconds = Math.max(1, Math.ceil(input.durationSeconds ?? 12));
    if (input.file) {
      const body = new FormData();
      body.append("file", input.file);
      body.append("durationSeconds", String(durationSeconds));
      body.append("width", String(input.width ?? 1080));
      body.append("height", String(input.height ?? 1920));
      appendAssetMetadata(body, input);
      const data = await apiRequest<{ asset: SourceAsset }>("/assets", { method: "POST", body });
      return data.asset;
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
        tags: input.tags,
        external: input.external,
        ai: input.ai
      })
    });
    return data.asset;
  } catch {
    const file = input.file;
    const isFileVideo = file?.type.startsWith("video/");
    const id = `asset_local_${Date.now()}`;

    // Persist the actual bytes on-device so the asset survives refresh and large clips load
    // instantly. Only a stable marker is stored as the URL; the live object URL is resolved
    // now (for immediate use) and re-resolved by listAssets() / resolveLocalAssetUrls() later.
    let liveUrl = "/assets/reelforge-studio-hero.png";
    if (file) {
      try {
        const store = await getAssetBlobStore();
        await store.put(id, file);
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
      durationSeconds: input.durationSeconds ?? 12,
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
      tags: input.tags,
      projectId: input.projectId,
      external: input.external,
      ai: input.ai
    };
    const assets = readLocal<SourceAsset[]>(localAssetsKey, []);
    writeLocal(localAssetsKey, [asset, ...assets]);
    return { ...asset, fileUrl: liveUrl };
  }
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
}

export async function listAssets(): Promise<SourceAsset[]> {
  await ensureDemoSession();

  try {
    const data = await apiRequest<{ assets: SourceAsset[] }>("/assets");
    return data.assets;
  } catch {
    return resolveLocalAssetUrls(readLocal<SourceAsset[]>(localAssetsKey, []));
  }
}

export async function deleteAsset(assetId: string) {
  await ensureDemoSession();

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

// --- Stock media (Pexels / Pixabay) ---------------------------------------------
// Stock requires the server (search hits provider APIs; import downloads the file into
// our own storage so the export worker can fetch it). No local-only fallback.

export type StockProvider = "pexels" | "pixabay";

export async function getStockStatus(): Promise<Record<StockProvider, boolean>> {
  await ensureDemoSession();
  try {
    return await apiRequest<Record<StockProvider, boolean>>("/stock/status");
  } catch {
    return { pexels: false, pixabay: false };
  }
}

/** Page size the stock API returns — lets the UI decide when to offer "Load more". */
export const STOCK_PAGE_SIZE = 24;

export async function searchStock(
  provider: StockProvider,
  query: string,
  type: "image" | "video",
  page = 1,
  orientation: StockOrientation = "all"
): Promise<{ configured: boolean; results: StockResult[] }> {
  await ensureDemoSession();
  const params = new URLSearchParams({ q: query, type, page: String(page), orientation });
  return apiRequest<{ configured: boolean; results: StockResult[] }>(`/stock/${provider}/search?${params.toString()}`);
}

export async function importStock(result: StockResult, variant?: StockVariant): Promise<SourceAsset> {
  await ensureDemoSession();
  const data = await apiRequest<{ asset: SourceAsset }>(`/stock/${result.provider}/import`, {
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
      sourceUrl: result.sourceUrl
    })
  });
  return data.asset;
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

  try {
    const data = await apiRequest<{ project: ProjectRecord }>(`/projects/${projectId}`);
    return data.project;
  } catch {
    const project = readLocal<ProjectRecord[]>(localProjectsKey, []).find((item) => item.id === projectId);
    if (project) {
      return project;
    }
    const fallback = createLocalProject({ title: "Untitled reel", templateId: templateDefinitions[0]?.id });
    saveLocalProject(fallback);
    return fallback;
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
    const insertedEffects = resolveModuleInsertions(project.projectGraph.effects, type).map((effect) =>
      effect.type === type ? { ...effect, config: { ...effect.config, ...config } } : effect
    );
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
    const wallet = Number(localStorage.getItem("reelforge_wallet") ?? 120);
    localStorage.setItem("reelforge_wallet", String(wallet + (pack?.credits ?? 0)));
    return true;
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

async function apiRequestWithAuthRetry<T>(path: string, init: RequestInit = {}, _canRetryAuth: boolean): Promise<T> {
  const headers = new Headers(init.headers);
  const bodyIsForm = init.body instanceof FormData;
  if (!bodyIsForm && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const token = getToken();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch(`${API_URL}${path}`, { ...init, headers });
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
}): ProjectRecord {
  const template = templateDefinitions.find((item) => item.id === input.templateId || item.slug === input.templateId) ?? templateDefinitions[0]!;
  const sourceAsset = input.sourceAssetId ? readLocal<SourceAsset[]>(localAssetsKey, []).find((asset) => asset.id === input.sourceAssetId) : undefined;
  const id = `project_local_${Date.now()}`;
  const graph: ProjectGraph = input.prompt
    ? {
        projectId: id,
        sourceAssetId: input.sourceAssetId,
        effects: [createProjectEffect("AUTO_CAPTIONS"), createProjectEffect("MOTION_TEXT"), createProjectEffect("ZOOM_CUTS")],
        editableFields: { hookText: input.prompt, captionStyle: "bold_yellow" },
        version: 1
      }
    : {
        ...template.templateGraph,
        projectId: id,
        sourceAssetId: input.sourceAssetId,
        version: 1
      };

  // A composition-based (save-as-template) template carries an authored
  // composition - instantiate it; otherwise build the default timeline.
  const templateComposition = !input.prompt ? template.templateGraph.composition : undefined;
  graph.composition = templateComposition
    ? instantiateTemplateComposition(templateComposition, id, { sourceAssetId: input.sourceAssetId, name: input.title })
    : createDefaultComposition({
        id,
        name: input.title,
        durationSeconds: sourceAsset?.durationSeconds ?? template.durationSeconds,
        assetId: input.sourceAssetId
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

function readLocal<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeLocal<T>(key: string, value: T) {
  localStorage.setItem(key, JSON.stringify(value));
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
