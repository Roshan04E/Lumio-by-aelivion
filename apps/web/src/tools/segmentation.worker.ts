/**
 * High-quality RVM matting worker — keeps the onnxruntime-web session AND all per-frame inference
 * off the main thread, so a long/large bake never freezes the page ("page not responding"). Mirrors
 * the asr.worker.ts / tts.worker.ts discipline: the main-thread client (local-segmentation.ts) owns
 * the video decode (seek / drawImage / getImageData), lifecycle, progress UI and cancellation; this
 * worker only loads the model (streaming download progress via the OPFS model cache) and turns an
 * RGBA frame + the recurrent state into an alpha-luma frame.
 *
 * RVM's recurrence (r1..r4) lives HERE and never crosses threads — the client streams frames in
 * order and gets luma back. ORT sessions aren't reentrant, so runs are serialized through one chain.
 * All model config (URLs, execution providers) is passed in from the main thread so the worker stays
 * a pure inference engine with no duplicated constants.
 */
import { getCachedModel, type ModelFetchProgress } from "./model-cache";

console.log("[seg-worker] module loaded");

export interface SegWarmRequest {
  type: "warm";
  modelUrl: string;
  ortUrls: string[];
  ortWasmBase: string;
  executionProviders: string[];
  /** Model weight precision — drives whether src/recurrent tensors are float16 or float32. */
  precision: "fp16" | "fp32";
}
export interface SegBeginRequest {
  type: "begin";
}
export interface SegFrameRequest {
  type: "frame";
  id: number;
  width: number;
  height: number;
  /** Underlying buffer of the (downscaled) frame's RGBA Uint8ClampedArray, transferred in. */
  rgba: ArrayBuffer;
}
export type SegWorkerRequest = SegWarmRequest | SegBeginRequest | SegFrameRequest;

export type SegWorkerResponse =
  | { type: "progress"; loaded: number; total: number }
  | { type: "status"; message: string }
  | { type: "ready" }
  | { type: "load-error"; message: string }
  | { type: "frame"; id: number; ok: true; luma: ArrayBuffer }
  | { type: "frame"; id: number; ok: false; message: string };

interface WorkerScope {
  postMessage(message: SegWorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<SegWorkerRequest>) => void) | null;
}
const scope = self as unknown as WorkerScope;

type OrtTensor = unknown;
interface OrtModule {
  env: { wasm: { wasmPaths?: string; numThreads?: number } };
  InferenceSession: { create: (model: Uint8Array, options?: Record<string, unknown>) => Promise<OrtInferenceSession> };
  Tensor: new (type: string, data: Float32Array | Uint16Array, dims: number[]) => OrtTensor;
}
interface OrtInferenceSession {
  run: (feeds: Record<string, unknown>) => Promise<Record<string, { data: Float32Array | Uint16Array }>>;
}

let ort: OrtModule | null = null;
let session: OrtInferenceSession | null = null;
let loading: Promise<void> | null = null;
let precision: "fp16" | "fp32" = "fp32";
// RVM recurrent state (r1i..r4i feed tensors). Reset per clip on "begin".
let recurrentState: Record<string, unknown> = {};
let frameIndex = 0;

// The browser's native Float16Array (Baseline 2024; present wherever WebGPU is) — used to pack/unpack
// IEEE-754 half floats for the fp16 model without hand-rolled bit twiddling.
interface Float16Like {
  readonly length: number;
  readonly buffer: ArrayBuffer;
  readonly byteOffset: number;
  [index: number]: number;
}
type Float16Ctor = {
  new (elements: ArrayLike<number>): Float16Like;
  new (buffer: ArrayBufferLike, byteOffset: number, length: number): Float16Like;
};
const Float16 = (globalThis as unknown as { Float16Array?: Float16Ctor }).Float16Array;

/** float16 zero is 0x0000, so a zeroed Uint16Array IS the fp16 zero tensor. */
function zeroTensor(): OrtTensor {
  return precision === "fp16"
    ? new ort!.Tensor("float16", new Uint16Array(1), [1, 1, 1, 1])
    : new ort!.Tensor("float32", new Float32Array(1), [1, 1, 1, 1]);
}
function initialState(): Record<string, unknown> {
  return { r1i: zeroTensor(), r2i: zeroTensor(), r3i: zeroTensor(), r4i: zeroTensor() };
}

/**
 * RVM's OFFICIAL auto_downsample_ratio (github.com/PeterL1n/RobustVideoMatting, inference docs):
 *   downsample_ratio = min(512 / max(h, w), 1)
 * i.e. scale so the LONG side maps to ~512 (1080p → 0.25, 720p → 0.375, ≤512 → 1.0). This is the
 * value the recurrent decoder was trained against — feeding an off-spec ratio (an earlier version used
 * 384/shortSide, ~0.57 here) makes the matte collapse to a weak, smoky, person-shaped ghost.
 */
function downsampleRatioFor(width: number, height: number): number {
  return Math.min(1, 512 / Math.max(width, height));
}

function rgbaToNchw(rgba: Uint8ClampedArray, width: number, height: number): OrtTensor {
  const channelSize = width * height;
  const planar = new Float32Array(channelSize * 3);
  for (let i = 0; i < channelSize; i += 1) {
    planar[i] = (rgba[i * 4] ?? 0) / 255;
    planar[channelSize + i] = (rgba[i * 4 + 1] ?? 0) / 255;
    planar[channelSize * 2 + i] = (rgba[i * 4 + 2] ?? 0) / 255;
  }
  if (precision === "fp16") {
    if (!Float16) {
      throw new Error("This browser lacks Float16Array — can't run the fp16 matting model.");
    }
    // Convert the RGB [0,1] planar to half floats and hand ORT the raw 16-bit payload.
    const bits = new Uint16Array(new Float16(planar).buffer);
    return new ort!.Tensor("float16", bits, [1, 3, height, width]);
  }
  return new ort!.Tensor("float32", planar, [1, 3, height, width]);
}

/** Reads an ORT alpha (pha) output as Float32, transparently handling a float16 tensor payload. */
function phaToFloat32(data: Float32Array | Uint16Array, type: string | undefined): Float32Array {
  if (type === "float16") {
    if (!Float16) {
      throw new Error("This browser lacks Float16Array — can't read the fp16 matting output.");
    }
    const bits = data as Uint16Array;
    const view = new Float16(bits.buffer, bits.byteOffset, bits.length);
    return new Float32Array(view as unknown as ArrayLike<number>);
  }
  return data as Float32Array;
}

function alphaToLuma(alpha: Float32Array, width: number, height: number): Uint8ClampedArray {
  const luma = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const value = Math.round(Math.min(1, Math.max(0, alpha[i] ?? 0)) * 255);
    luma[i * 4] = value;
    luma[i * 4 + 1] = value;
    luma[i * 4 + 2] = value;
    luma[i * 4 + 3] = 255;
  }
  return luma;
}

async function warm(req: SegWarmRequest): Promise<void> {
  loading ??= (async () => {
    const t0 = Date.now();
    precision = req.precision;
    console.log("[seg-worker] warm() start", { modelUrl: req.modelUrl, ortUrls: req.ortUrls, ortWasmBase: req.ortWasmBase, executionProviders: req.executionProviders, precision: req.precision });
    // Fetch the RVM weights once through the OPFS cache (available in workers) and hand the bytes to
    // ORT — same "no internal URL fetch" path the main thread used, now off-thread.
    console.log("[seg-worker] fetching model bytes (OPFS cache or download)…");
    const modelBytes = new Uint8Array(
      await getCachedModel(req.modelUrl, {
        onProgress: (p: ModelFetchProgress) => scope.postMessage({ type: "progress", loaded: p.loaded, total: p.total })
      })
    );
    console.log(`[seg-worker] model bytes ready: ${modelBytes.byteLength} bytes in ${Date.now() - t0}ms`);
    let lastError: unknown;
    for (const url of req.ortUrls) {
      try {
        scope.postMessage({ type: "status", message: "Loading the matting runtime…" });
        console.log("[seg-worker] importing ORT from", url);
        const importStart = Date.now();
        const mod = (await import(/* @vite-ignore */ url)) as OrtModule;
        console.log(`[seg-worker] ORT imported in ${Date.now() - importStart}ms`, { hasEnv: Boolean(mod.env), hasWasm: Boolean(mod.env?.wasm), hasCreate: Boolean(mod.InferenceSession?.create) });
        // Point ORT at its proxy binaries so the WebGPU backend can initialize.
        if (mod.env?.wasm) {
          mod.env.wasm.wasmPaths = req.ortWasmBase;
        }
        console.log("[seg-worker] navigator.gpu present:", typeof (self as unknown as { navigator?: { gpu?: unknown } }).navigator?.gpu !== "undefined");
        // This is the step that can stall on a first WebGPU init — announce it so a hang is localizable.
        scope.postMessage({
          type: "status",
          message: `Initializing the matting session (${req.executionProviders[0] ?? "wasm"})…`
        });
        console.log("[seg-worker] InferenceSession.create() START with EPs:", req.executionProviders);
        const createStart = Date.now();
        const created = await mod.InferenceSession.create(modelBytes, { executionProviders: req.executionProviders });
        console.log(`[seg-worker] InferenceSession.create() DONE in ${Date.now() - createStart}ms`);
        ort = mod;
        session = created;
        recurrentState = initialState();
        scope.postMessage({ type: "status", message: "Matting session ready — baking frames…" });
        console.log(`[seg-worker] warm() complete in ${Date.now() - t0}ms`);
        return;
      } catch (error) {
        console.error("[seg-worker] ORT load/create failed for", url, error);
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Unable to load the quality matting model.");
  })();
  return loading;
}

// ORT sessions are not reentrant: serialize every run() through one chain so overlapping frame
// messages can't enter run() concurrently. Frames are already streamed in order by the client.
let runChain: Promise<unknown> = Promise.resolve();
function serialize<T>(task: () => Promise<T>): Promise<T> {
  const result = runChain.then(task, task);
  runChain = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

scope.onmessage = (event) => {
  const message = event.data;
  if (message.type === "warm") {
    warm(message)
      .then(() => scope.postMessage({ type: "ready" }))
      .catch((error: unknown) => {
        loading = null;
        session = null;
        ort = null;
        scope.postMessage({ type: "load-error", message: error instanceof Error ? error.message : String(error) });
      });
    return;
  }
  if (message.type === "begin") {
    if (ort) {
      recurrentState = initialState();
      frameIndex = 0;
    }
    return;
  }
  if (message.type === "frame") {
    void serialize(async () => {
      try {
        if (!ort || !session) {
          throw new Error("matting model not loaded");
        }
        const rgba = new Uint8ClampedArray(message.rgba);
        const input = rgbaToNchw(rgba, message.width, message.height);
        const downsampleRatio = new ort.Tensor(
          "float32",
          new Float32Array([downsampleRatioFor(message.width, message.height)]),
          [1]
        );
        const ratioValue = downsampleRatioFor(message.width, message.height);
        const outputs = await session.run({ src: input, downsample_ratio: downsampleRatio, ...recurrentState });
        const phaTensor = outputs.pha as ({ data: Float32Array | Uint16Array; dims?: number[]; type?: string; location?: string } | undefined);
        if (!phaTensor?.data) {
          throw new Error("Matting model output missing alpha tensor.");
        }
        // fp16 model returns pha as raw float16 bits — decode to Float32 for thresholding/luma.
        const alpha = phaToFloat32(phaTensor.data, phaTensor.type);
        // One-time diagnostic on the FIRST frame: is the alpha near-zero (a WebGPU output-read bug) or
        // weak-but-present (a model/input problem)? min/max/mean + tensor location/dims decides it.
        if (frameIndex === 0) {
          let min = Infinity;
          let max = -Infinity;
          let sum = 0;
          let over = 0;
          for (let i = 0; i < alpha.length; i += 1) {
            const v = alpha[i] ?? 0;
            if (v < min) min = v;
            if (v > max) max = v;
            sum += v;
            if (v > 0.5) over += 1;
          }
          console.log(
            `[seg-worker] pha frame0: min=${min.toFixed(3)} max=${max.toFixed(3)} mean=${(sum / alpha.length).toFixed(3)} ` +
              `>0.5=${((over / alpha.length) * 100).toFixed(1)}% | len=${alpha.length} phaDims=${JSON.stringify(phaTensor?.dims)} ` +
              `phaType=${phaTensor?.type} phaLoc=${phaTensor?.location} | inputWxH=${message.width}x${message.height} ratio=${ratioValue.toFixed(3)} ` +
              `outputKeys=${JSON.stringify(Object.keys(outputs))}`
          );
        }
        frameIndex += 1;
        // Thread the recurrent state forward for the next frame's temporal stability.
        recurrentState = { r1i: outputs.r1o, r2i: outputs.r2o, r3i: outputs.r3o, r4i: outputs.r4o };
        const luma = alphaToLuma(alpha, message.width, message.height);
        const buffer = luma.buffer as ArrayBuffer;
        scope.postMessage({ type: "frame", id: message.id, ok: true, luma: buffer }, [buffer]);
      } catch (error) {
        scope.postMessage({ type: "frame", id: message.id, ok: false, message: error instanceof Error ? error.message : String(error) });
      }
    });
  }
};
