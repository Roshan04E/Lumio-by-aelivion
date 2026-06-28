import type { BrowserToolCapabilities } from "./capabilities";

/**
 * Real per-frame image inpainting using LaMa (Large Mask Inpainting), the same
 * model family lama-cleaner ships. Unlike the diffusion placeholder in
 * mock-inpaint.ts (which just smears nearby background color inward), this
 * calls a genuine generative network that hallucinates plausible texture for
 * the hole.
 *
 * Model: Carve/LaMa-ONNX `lama_fp32.onnx` - the repo's own README marks this
 * (over the dynamo-exported `lama.onnx` sibling) as the recommended file:
 * opset 17, exported via `torch.onnx.export`, "identical to the original
 * model" in their comparison. Verified before wiring this in (mirroring the
 * "an earlier guessed, non-existent HF path 404'd" lesson noted next to the
 * RVM model in local-segmentation.ts): downloaded the real ~208MB file and
 * inspected its ONNX graph directly rather than guessing tensor names -
 *   - input "image": float32 [1,3,512,512], normalized 0-1, NCHW
 *   - input "mask": float32 [1,1,512,512], 1 = hole to fill, 0 = keep
 *   - output "output": float32 [1,3,512,512]
 * The graph's own final nodes are `Mul(mask, generated)` + `Mul(1-mask, image)`
 * + `Add`, i.e. it composites kept/generated pixels internally, then
 * `* 255` + `Clip(0, 255)` - so `output` is already a finished 0-255 RGB frame
 * with the original image preserved outside the mask. No extra blending step
 * is needed on our side for the modeled region.
 *
 * Fixed 512x512 input only accepts a square frame - the caller is responsible
 * for cropping/resizing a square region into this session and writing the
 * square result back (see video-inpaint.ts).
 */

export const LAMA_MODEL_SIZE = 512;

export interface LamaSession {
  /** image512/mask512 must be NCHW float32 of length 3*512*512 / 1*512*512. Returns NCHW float32 RGB, 0-255 range. */
  run: (image512: Float32Array, mask512: Float32Array) => Promise<Float32Array>;
}

const onnxRuntimeUrls = [
  "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.webgpu.min.mjs",
  "https://esm.sh/onnxruntime-web@1.20.1"
];

const lamaModelUrl = "https://huggingface.co/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx";

let cachedSession: Promise<LamaSession> | undefined;

/** Cached across calls within the tab so the ~208MB model loads once per session. */
export async function getLamaSession(capabilities: BrowserToolCapabilities): Promise<LamaSession> {
  cachedSession ??= loadLamaSession(capabilities);
  return cachedSession;
}

async function loadLamaSession(capabilities: BrowserToolCapabilities): Promise<LamaSession> {
  let lastError: unknown;
  for (const url of onnxRuntimeUrls) {
    try {
      const ort = (await import(/* @vite-ignore */ url)) as {
        InferenceSession: { create: (modelUrl: string, options?: Record<string, unknown>) => Promise<unknown> };
        Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown;
      };
      const session = await createSessionWithFallback(ort, capabilities.webGpu);
      return wrapLamaSession(session, ort);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Unable to load the LaMa inpainting model. ${lastError instanceof Error ? lastError.message : ""}`.trim());
}

async function createSessionWithFallback(
  ort: { InferenceSession: { create: (modelUrl: string, options?: Record<string, unknown>) => Promise<unknown> } },
  preferWebGpu: boolean
): Promise<unknown> {
  if (preferWebGpu) {
    try {
      return await ort.InferenceSession.create(lamaModelUrl, { executionProviders: ["webgpu"] });
    } catch {
      // Fall through to WASM - WebGPU presence doesn't guarantee this model/op set runs on it.
    }
  }
  return ort.InferenceSession.create(lamaModelUrl, { executionProviders: ["wasm"] });
}

function wrapLamaSession(
  session: unknown,
  ort: { Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown }
): LamaSession {
  const inferenceSession = session as { run: (feeds: Record<string, unknown>) => Promise<Record<string, { data: Float32Array }>> };
  return {
    run: async (image512, mask512) => {
      const imageTensor = new ort.Tensor("float32", image512, [1, 3, LAMA_MODEL_SIZE, LAMA_MODEL_SIZE]);
      const maskTensor = new ort.Tensor("float32", mask512, [1, 1, LAMA_MODEL_SIZE, LAMA_MODEL_SIZE]);
      const outputs = await inferenceSession.run({ image: imageTensor, mask: maskTensor });
      const output = outputs.output?.data;
      if (!output) {
        throw new Error("LaMa model output missing the 'output' tensor.");
      }
      return output;
    }
  };
}
