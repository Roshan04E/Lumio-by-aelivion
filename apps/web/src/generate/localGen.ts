/**
 * Local image generation — the "Local" route for AI asset generation.
 *
 * Like the local LLM (`ai/ollama.ts`), a local Stable Diffusion server runs on the user's
 * machine and our remote API can't reach it, so the BROWSER talks to it directly. This keeps
 * local generation private, offline, and free. Config lives only in this browser (localStorage).
 *
 * AUTOMATIC1111 (`/sdapi/v1/*`) is supported directly — it has a simple JSON txt2img/img2img
 * API. ComfyUI is graph-based: we submit a baked default text-to-image workflow to `/prompt`,
 * poll `/history/{id}`, and fetch the rendered image via `/view`. ComfyUI must be launched with
 * CORS allowed for this origin (see the setup note in LocalGenPanel). ComfyUI image-to-image /
 * inpaint are not wired yet (they need uploaded init/mask images) — those still route to A1111.
 *
 * Video is never local — the resolver has no local video model, so video always routes to cloud.
 */

export type LocalGenBackend = "a1111" | "comfy";

export interface LocalGenConfig {
  /** Host root, no trailing slash. */
  baseUrl: string;
  backend: LocalGenBackend;
  /** Checkpoint / model name (A1111 `sd_model_checkpoint`); optional — server default is used when blank. */
  model: string;
  /** Whether the local route is currently active (toggled on in the panel). */
  enabled: boolean;
}

/** AUTOMATIC1111's default port. */
export const DEFAULT_LOCAL_GEN_BASE_URL = "http://localhost:7860";
/** ComfyUI's default port. */
export const DEFAULT_COMFY_BASE_URL = "http://localhost:8188";
const STORAGE_KEY = "orreris.gen.local.v1";

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export function loadLocalGenConfig(): LocalGenConfig | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LocalGenConfig>;
    if (!parsed.baseUrl) return null;
    return {
      baseUrl: normalizeBaseUrl(parsed.baseUrl),
      backend: parsed.backend === "comfy" ? "comfy" : "a1111",
      model: parsed.model ?? "",
      enabled: Boolean(parsed.enabled)
    };
  } catch {
    return null;
  }
}

export function saveLocalGenConfig(config: LocalGenConfig): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...config, baseUrl: normalizeBaseUrl(config.baseUrl) }));
  } catch {
    /* private mode / quota — best effort */
  }
}

export function clearLocalGenConfig(): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/** The local route is a candidate only when configured AND toggled on. */
export function isLocalGenActive(): boolean {
  const config = loadLocalGenConfig();
  return Boolean(config?.enabled);
}

/** Fast reachability probe (aborts after `timeoutMs`). Feeds `availability.localEndpoint`. */
export async function pingLocalGen(baseUrl: string, backend: LocalGenBackend, timeoutMs = 1500): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const probe = backend === "comfy" ? "/system_stats" : "/sdapi/v1/sd-models";
  try {
    const response = await fetch(`${normalizeBaseUrl(baseUrl)}${probe}`, { method: "GET", signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** List local checkpoints. A1111: `/sdapi/v1/sd-models`; ComfyUI: `/object_info` checkpoint enum. */
export async function listLocalModels(baseUrl: string, backend: LocalGenBackend): Promise<string[]> {
  const base = normalizeBaseUrl(baseUrl);
  if (backend === "comfy") {
    return listComfyCheckpoints(base);
  }
  const response = await fetch(`${base}/sdapi/v1/sd-models`, { method: "GET" });
  if (!response.ok) {
    throw new Error(`Local server responded ${response.status}`);
  }
  const json = (await response.json()) as Array<{ title?: string; model_name?: string }>;
  return json.map((item) => item.model_name ?? item.title ?? "").filter(Boolean);
}

/** Discover ComfyUI checkpoints from the CheckpointLoaderSimple node's `ckpt_name` enum. */
async function listComfyCheckpoints(base: string): Promise<string[]> {
  const response = await fetch(`${base}/object_info/CheckpointLoaderSimple`, { method: "GET" });
  if (!response.ok) {
    throw new Error(`ComfyUI responded ${response.status}`);
  }
  const json = (await response.json()) as Record<
    string,
    { input?: { required?: { ckpt_name?: unknown[] } } }
  >;
  const enumField = json.CheckpointLoaderSimple?.input?.required?.ckpt_name;
  // ComfyUI encodes an enum as `[[...values], {opts}]`.
  const values = Array.isArray(enumField) && Array.isArray(enumField[0]) ? (enumField[0] as unknown[]) : [];
  return values.map((value) => String(value)).filter(Boolean);
}

export interface LocalGenParams {
  prompt: string;
  negativePrompt?: string | undefined;
  aspectRatio?: string | undefined;
  seed?: number | undefined;
  /** i2i / inpaint: a data URL or base64 init image. */
  referenceImage?: string | undefined;
  /** inpaint: a data URL or base64 mask. */
  mask?: string | undefined;
  strength?: number | undefined;
}

export interface LocalGenRequest {
  baseUrl: string;
  backend: LocalGenBackend;
  model?: string | undefined;
  taskKind: string;
  params: LocalGenParams;
  signal?: AbortSignal | undefined;
}

export interface LocalGenResult {
  /** PNG data URL of the generated image. */
  dataUrl: string;
  width: number;
  height: number;
}

/** Map an aspect ratio to pixel dims at a target long edge (kept multiples of 8 for SD). */
function aspectToDims(aspectRatio: string | undefined, longEdge = 1024): { width: number; height: number } {
  const parts = (aspectRatio ?? "1:1").split(":");
  const w = Number(parts[0]) || 1;
  const h = Number(parts[1]) || 1;
  const round8 = (value: number) => Math.max(256, Math.round(value / 8) * 8);
  if (w >= h) {
    return { width: round8(longEdge), height: round8((longEdge * h) / w) };
  }
  return { width: round8((longEdge * w) / h), height: round8(longEdge) };
}

/** Strip a data-URL prefix if present — A1111 accepts bare base64 for init/mask images. */
function toBareBase64(value: string): string {
  const comma = value.indexOf(",");
  return value.startsWith("data:") && comma >= 0 ? value.slice(comma + 1) : value;
}

/**
 * Run a local image generation. Only image task kinds are supported (text-to-image,
 * image-to-image, inpaint); video has no local model. Throws on any failure so the caller
 * can fall back to the cloud route.
 */
export async function generateLocalImage(request: LocalGenRequest): Promise<LocalGenResult> {
  if (request.backend === "comfy") {
    return generateComfyImage(request);
  }
  const base = normalizeBaseUrl(request.baseUrl);
  const { params } = request;
  const dims = aspectToDims(params.aspectRatio);
  const usesInit = request.taskKind === "image-to-image" || request.taskKind === "inpaint";

  const body: Record<string, unknown> = {
    prompt: params.prompt,
    negative_prompt: params.negativePrompt ?? "",
    width: dims.width,
    height: dims.height,
    steps: 25,
    ...(params.seed !== undefined ? { seed: params.seed } : {}),
    ...(request.model ? { override_settings: { sd_model_checkpoint: request.model } } : {})
  };

  if (usesInit) {
    if (!params.referenceImage) {
      throw new Error("This task needs a reference image.");
    }
    body.init_images = [toBareBase64(params.referenceImage)];
    body.denoising_strength = params.strength ?? 0.65;
    if (request.taskKind === "inpaint" && params.mask) {
      body.mask = toBareBase64(params.mask);
      body.inpainting_fill = 1;
    }
  }

  const endpoint = usesInit ? "/sdapi/v1/img2img" : "/sdapi/v1/txt2img";
  const response = await fetch(`${base}${endpoint}`, {
    method: "POST",
    ...(request.signal ? { signal: request.signal } : {}),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`Local generation failed: HTTP ${response.status}`);
  }
  const json = (await response.json()) as { images?: string[] };
  const image = json.images?.[0];
  if (!image) {
    throw new Error("Local server returned no image.");
  }
  const dataUrl = image.startsWith("data:") ? image : `data:image/png;base64,${image}`;
  return { dataUrl, width: dims.width, height: dims.height };
}

// ---- ComfyUI (graph-based) ----------------------------------------------------------------

const COMFY_POLL_INTERVAL_MS = 1_000;
const COMFY_MAX_WAIT_MS = 3 * 60_000;

/** A ComfyUI node in API (prompt) format. */
interface ComfyNode {
  class_type: string;
  inputs: Record<string, unknown>;
}

/**
 * A minimal, checkpoint-agnostic text-to-image workflow (works for SD1.5 and SDXL checkpoints).
 * Node ids are strings per ComfyUI's API format; links are `[nodeId, outputIndex]`.
 */
function buildComfyTxt2ImgGraph(args: {
  checkpoint: string;
  prompt: string;
  negative: string;
  width: number;
  height: number;
  seed: number;
}): Record<string, ComfyNode> {
  return {
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: args.checkpoint } },
    "5": { class_type: "EmptyLatentImage", inputs: { width: args.width, height: args.height, batch_size: 1 } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: args.prompt, clip: ["4", 1] } },
    "7": { class_type: "CLIPTextEncode", inputs: { text: args.negative, clip: ["4", 1] } },
    "3": {
      class_type: "KSampler",
      inputs: {
        seed: args.seed,
        steps: 25,
        cfg: 7,
        sampler_name: "euler",
        scheduler: "normal",
        denoise: 1,
        model: ["4", 0],
        positive: ["6", 0],
        negative: ["7", 0],
        latent_image: ["5", 0]
      }
    },
    "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
    "9": { class_type: "SaveImage", inputs: { filename_prefix: "orreris", images: ["8", 0] } }
  };
}

interface ComfyHistoryEntry {
  outputs?: Record<string, { images?: Array<{ filename: string; subfolder: string; type: string }> }>;
  status?: { completed?: boolean; status_str?: string };
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read image blob"));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}

async function generateComfyImage(request: LocalGenRequest): Promise<LocalGenResult> {
  if (request.taskKind !== "text-to-image") {
    throw new Error(
      "ComfyUI supports text-to-image here for now. For image-to-image or inpaint, use an AUTOMATIC1111 server."
    );
  }
  const base = normalizeBaseUrl(request.baseUrl);
  const { params } = request;
  const dims = aspectToDims(params.aspectRatio);

  // Resolve a checkpoint: the configured model, else the first one ComfyUI reports.
  let checkpoint = request.model?.trim() ?? "";
  if (!checkpoint) {
    const available = await listComfyCheckpoints(base);
    checkpoint = available[0] ?? "";
  }
  if (!checkpoint) {
    throw new Error("ComfyUI has no checkpoint installed — put a model in ComfyUI/models/checkpoints.");
  }

  const seed = params.seed ?? Math.floor(Math.random() * 2_147_483_647);
  const graph = buildComfyTxt2ImgGraph({
    checkpoint,
    prompt: params.prompt,
    negative: params.negativePrompt ?? "",
    width: dims.width,
    height: dims.height,
    seed
  });
  const clientId = `orreris-${Math.random().toString(36).slice(2)}`;

  const submit = await fetch(`${base}/prompt`, {
    method: "POST",
    ...(request.signal ? { signal: request.signal } : {}),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: graph, client_id: clientId })
  });
  if (!submit.ok) {
    const detail = await submit.text().catch(() => "");
    throw new Error(`ComfyUI rejected the workflow (HTTP ${submit.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  const promptId = ((await submit.json()) as { prompt_id?: string }).prompt_id;
  if (!promptId) {
    throw new Error("ComfyUI did not return a prompt id.");
  }

  const startedAt = Date.now();
  for (;;) {
    if (request.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    if (Date.now() - startedAt > COMFY_MAX_WAIT_MS) {
      throw new Error("ComfyUI generation timed out.");
    }
    await new Promise((resolve) => setTimeout(resolve, COMFY_POLL_INTERVAL_MS));
    const historyRes = await fetch(`${base}/history/${promptId}`, {
      ...(request.signal ? { signal: request.signal } : {})
    });
    if (!historyRes.ok) {
      continue;
    }
    const history = (await historyRes.json()) as Record<string, ComfyHistoryEntry>;
    const entry = history[promptId];
    if (!entry?.outputs) {
      continue;
    }
    const image = Object.values(entry.outputs)
      .flatMap((output) => output.images ?? [])
      .find((img) => img.type !== "temp");
    if (!image) {
      // Completed with no saved image (e.g. only a preview) — keep waiting briefly, then fail.
      if (entry.status?.completed) {
        throw new Error("ComfyUI finished but produced no saved image.");
      }
      continue;
    }
    const viewUrl =
      `${base}/view?filename=${encodeURIComponent(image.filename)}` +
      `&subfolder=${encodeURIComponent(image.subfolder)}&type=${encodeURIComponent(image.type)}`;
    const imageRes = await fetch(viewUrl, { ...(request.signal ? { signal: request.signal } : {}) });
    if (!imageRes.ok) {
      throw new Error(`Failed to fetch ComfyUI image (HTTP ${imageRes.status}).`);
    }
    const dataUrl = await blobToDataUrl(await imageRes.blob());
    return { dataUrl, width: dims.width, height: dims.height };
  }
}
