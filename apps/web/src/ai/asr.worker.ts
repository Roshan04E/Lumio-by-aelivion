/**
 * Local high-accuracy EARS worker — Moonshine-base ASR entirely off the main thread.
 *
 * Web Speech (the browser vendor's generic cloud model) hears "make clip 1 in lower V2 layer"
 * as "make lip one in lower be to layer" and offers zero vocabulary control. Moonshine
 * (Useful Sensors) is built for edge ASR — it beats whisper-tiny at comparable size and runs
 * in transformers.js. Same worker discipline as tts.worker.ts: the main-thread client
 * (asr.ts) owns lifecycle/timeouts/fallback; this worker only loads the model (streaming
 * download progress) and turns 16kHz mono Float32 audio into text.
 */

import { pipeline } from "@huggingface/transformers";

export interface AsrWorkerWarmRequest {
  type: "warm";
  modelId: string;
}
export interface AsrWorkerTranscribeRequest {
  type: "transcribe";
  id: number;
  /** 16kHz mono PCM, transferred as the Float32Array's underlying buffer. */
  audio: ArrayBuffer;
}
export type AsrWorkerRequest = AsrWorkerWarmRequest | AsrWorkerTranscribeRequest;

export type AsrWorkerResponse =
  | { type: "progress"; file: string; loaded: number; total: number }
  | { type: "ready" }
  | { type: "load-error"; message: string }
  | { type: "result"; id: number; ok: true; text: string }
  | { type: "result"; id: number; ok: false; message: string };

interface WorkerScope {
  postMessage(message: AsrWorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<AsrWorkerRequest>) => void) | null;
}
const scope = self as unknown as WorkerScope;

type Transcriber = (audio: Float32Array) => Promise<{ text?: string } | Array<{ text?: string }>>;
let transcriber: Transcriber | null = null;
let loading: Promise<void> | null = null;

function warm(modelId: string): Promise<void> {
  loading ??= (async () => {
    // wasm/q8 — the known-good pairing (WebGPU for ASR is a later, tested flag; not assumed).
    transcriber = (await pipeline("automatic-speech-recognition", modelId, {
      dtype: "q8",
      device: "wasm",
      progress_callback: (progress) => {
        const p = progress as { status?: string; file?: string; loaded?: number; total?: number };
        if (p.status === "progress" && p.file && typeof p.loaded === "number") {
          scope.postMessage({ type: "progress", file: p.file, loaded: p.loaded, total: typeof p.total === "number" ? p.total : 0 });
        }
      }
    })) as unknown as Transcriber;
  })();
  return loading;
}

scope.onmessage = (event) => {
  const message = event.data;
  if (message.type === "warm") {
    warm(message.modelId)
      .then(() => scope.postMessage({ type: "ready" }))
      .catch((error: unknown) => {
        transcriber = null;
        loading = null;
        scope.postMessage({ type: "load-error", message: error instanceof Error ? error.message : String(error) });
      });
    return;
  }
  if (message.type === "transcribe") {
    void (async () => {
      try {
        if (!transcriber) {
          throw new Error("model not loaded");
        }
        const output = await transcriber(new Float32Array(message.audio));
        const first = Array.isArray(output) ? output[0] : output;
        scope.postMessage({ type: "result", id: message.id, ok: true, text: (first?.text ?? "").trim() });
      } catch (error) {
        scope.postMessage({ type: "result", id: message.id, ok: false, message: error instanceof Error ? error.message : String(error) });
      }
    })();
  }
};
