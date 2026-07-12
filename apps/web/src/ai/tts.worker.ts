/**
 * Kokoro TTS Worker — model load + STREAMING generation entirely off the main thread.
 *
 * WASM inference on the main thread froze the whole editor for seconds per reply ("page
 * unresponsive"); here it costs the UI nothing. The main-thread client (tts.ts) owns engine
 * choice, playback, timeouts and fallback — this worker only loads the model (streaming
 * download progress back) and turns text into WAV bytes.
 *
 * Protocol v2 — speech sessions instead of one-shot generate: `speak-start` opens a
 * TextSplitterStream fed by `speak-push` fragments; kokoro's `stream()` generator yields one
 * audio per SENTENCE, each posted back as a transferable `chunk`. First sound after one
 * sentence's inference (not the whole reply), unlimited total length, and generation pipelines
 * ahead of playback. Text can be pushed while the model is still speaking earlier sentences —
 * which is how talk-mode reads the LLM reply live as it streams in.
 */

import { KokoroTTS, TextSplitterStream, type GenerateOptions } from "kokoro-js";

export interface TtsWorkerWarmRequest {
  type: "warm";
  modelId: string;
  /** The user's selected voice — the sanity generation runs with it so its style file
   * (network-fetched by kokoro-js on first use) is cached BEFORE "ready" is reported. */
  voice: string;
}
export interface TtsWorkerSpeakStartRequest {
  type: "speak-start";
  id: number;
  voice: string;
}
export interface TtsWorkerSpeakPushRequest {
  type: "speak-push";
  id: number;
  text: string;
}
export interface TtsWorkerSpeakEndRequest {
  type: "speak-end";
  id: number;
}
export interface TtsWorkerSpeakCancelRequest {
  type: "speak-cancel";
  id: number;
}
export type TtsWorkerRequest =
  | TtsWorkerWarmRequest
  | TtsWorkerSpeakStartRequest
  | TtsWorkerSpeakPushRequest
  | TtsWorkerSpeakEndRequest
  | TtsWorkerSpeakCancelRequest;

export type TtsWorkerResponse =
  | { type: "progress"; file: string; loaded: number; total: number }
  | { type: "ready"; device: "webgpu" | "wasm" }
  | { type: "load-error"; message: string }
  | { type: "chunk"; id: number; wav: ArrayBuffer }
  | { type: "speak-done"; id: number }
  | { type: "speak-error"; id: number; message: string };

interface WorkerScope {
  postMessage(message: TtsWorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<TtsWorkerRequest>) => void) | null;
}
const scope = self as unknown as WorkerScope;

let tts: KokoroTTS | null = null;
let loading: Promise<void> | null = null;
let activeDevice: "webgpu" | "wasm" = "wasm";

interface SpeakSession {
  splitter: TextSplitterStream;
  cancelled: boolean;
  /** TextSplitterStream.close() THROWS on a second call ("Stream is already closed." — real
   * crash 2026-07-12: end→timeout→cancel double-closed and the uncaught throw killed the
   * worker, which the main thread treated as a fatal engine failure). Track it ourselves. */
  closed: boolean;
}
const sessions = new Map<number, SpeakSession>();

function closeSplitter(session: SpeakSession): void {
  if (session.closed) {
    return;
  }
  session.closed = true;
  try {
    session.splitter.close();
  } catch {
    // already closed by the library — never let this escape onmessage
  }
}

const progressCallback = (progress: unknown) => {
  const p = progress as { status?: string; file?: string; loaded?: number; total?: number };
  if (p.status === "progress" && p.file && typeof p.loaded === "number") {
    scope.postMessage({ type: "progress", file: p.file, loaded: p.loaded, total: typeof p.total === "number" ? p.total : 0 });
  }
};

/** Run one throwaway generation and reject audio that is numerically broken — the guard that
 * lets us TRY WebGPU (2–10× faster than WASM, same q8 files = zero extra download) and fall
 * back automatically where the GPU path yields NaN/silence/noise. Also pays the one-time
 * session-compile AND kokoro-js's lazy network fetch of the voice's style file (`voices/
 * <voice>.bin` from huggingface.co) — run with the USER'S voice so "ready" means the first
 * real reply has nothing left to download. */
async function assertSaneOutput(candidate: KokoroTTS, voice: string): Promise<void> {
  const generated = await candidate.generate("Okay.", { voice: voice as NonNullable<GenerateOptions["voice"]> });
  const samples = (generated as unknown as { audio?: Float32Array }).audio;
  if (!samples || samples.length === 0) {
    throw new Error("test generation produced no audio");
  }
  let sumSquares = 0;
  let clipped = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i]!;
    if (Number.isNaN(sample)) {
      throw new Error("test generation produced NaN audio");
    }
    sumSquares += sample * sample;
    if (Math.abs(sample) > 0.999) {
      clipped += 1;
    }
  }
  const rms = Math.sqrt(sumSquares / samples.length);
  if (rms < 1e-4) {
    throw new Error("test generation produced silence");
  }
  if (clipped / samples.length > 0.2) {
    throw new Error("test generation produced clipped noise");
  }
}

function warm(modelId: string, voice: string): Promise<void> {
  loading ??= (async () => {
    const hasWebGpu = Boolean((globalThis as { navigator?: { gpu?: unknown } }).navigator?.gpu);
    if (hasWebGpu) {
      try {
        const candidate = await KokoroTTS.from_pretrained(modelId, { dtype: "q8", device: "webgpu", progress_callback: progressCallback });
        await assertSaneOutput(candidate, voice);
        tts = candidate;
        activeDevice = "webgpu";
        return;
      } catch (error) {
        console.warn("[lumio] tts worker: WebGPU path failed sanity — falling back to WASM.", error);
      }
    }
    const cpu = await KokoroTTS.from_pretrained(modelId, { dtype: "q8", device: "wasm", progress_callback: progressCallback });
    await assertSaneOutput(cpu, voice);
    tts = cpu;
    activeDevice = "wasm";
  })();
  return loading;
}

function startSession(id: number, voice: string): void {
  if (!tts || sessions.has(id)) {
    scope.postMessage({ type: "speak-error", id, message: tts ? "duplicate session" : "model not loaded" });
    return;
  }
  const session: SpeakSession = { splitter: new TextSplitterStream(), cancelled: false, closed: false };
  sessions.set(id, session);
  void (async () => {
    try {
      for await (const chunk of tts.stream(session.splitter, { voice: voice as NonNullable<GenerateOptions["voice"]> })) {
        if (session.cancelled) {
          break;
        }
        const wav = chunk.audio.toWav();
        scope.postMessage({ type: "chunk", id, wav }, [wav]);
      }
      if (!session.cancelled) {
        scope.postMessage({ type: "speak-done", id });
      }
    } catch (error) {
      scope.postMessage({ type: "speak-error", id, message: error instanceof Error ? error.message : String(error) });
    } finally {
      sessions.delete(id);
    }
  })();
}

scope.onmessage = (event) => {
  // Nothing in here may throw uncaught: an uncaught error surfaces as worker.onerror on the
  // main thread, which (pre-ready) tears the whole engine down — one bad message must never
  // cost the user the loaded model.
  try {
    const message = event.data;
    if (message.type === "warm") {
      warm(message.modelId, message.voice)
        .then(() => scope.postMessage({ type: "ready", device: activeDevice }))
        .catch((error: unknown) => {
          tts = null;
          loading = null;
          scope.postMessage({ type: "load-error", message: error instanceof Error ? error.message : String(error) });
        });
      return;
    }
    if (message.type === "speak-start") {
      startSession(message.id, message.voice);
      return;
    }
    const session = sessions.get(message.id);
    if (!session) {
      return; // session already finished/cancelled — late pushes are harmless
    }
    if (message.type === "speak-push") {
      if (!session.closed) {
        session.splitter.push(message.text);
      }
    } else if (message.type === "speak-end") {
      closeSplitter(session);
    } else if (message.type === "speak-cancel") {
      // Can't abort mid-inference; the flag stops the loop at the next sentence boundary.
      // closeSplitter is idempotent — cancel routinely arrives AFTER end (timeout fallback).
      session.cancelled = true;
      closeSplitter(session);
    }
  } catch (error) {
    console.warn("[lumio] tts worker: message handling failed", error);
  }
};
