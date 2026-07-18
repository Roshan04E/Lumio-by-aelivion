/**
 * Local high-accuracy EARS (Moonshine ASR) — main-thread client for asr.worker.ts.
 *
 * Opt-in (⚙ "High-accuracy hearing"): downloads ~60MB once (browser-cached), then every voice
 * utterance is ALSO transcribed locally and the local result replaces Web Speech's final when
 * it succeeds — Web Speech keeps providing the instant interim text and mic lifecycle. Same
 * house rules as the Kokoro voice: worker isolation, VISIBLE download progress (no magic),
 * honest failure reasons, user-retryable.
 */

export type LocalEarsStatus = "unloaded" | "downloading" | "ready" | "unavailable";

export interface LocalEarsProgress {
  status: LocalEarsStatus;
  /** 0–100 while downloading. */
  percent?: number;
  /** Real transfer scale while downloading — honest sizing, not just a bar. */
  loadedMb?: number;
  totalMb?: number;
  /** Short human-readable failure reason (unavailable only) — surfaced, never swallowed. */
  reason?: string;
}

const ASR_MODEL_ID = "onnx-community/moonshine-base-ONNX";
const EARS_STORE_KEY = "orreris.voice.ears.v1";
/** Moonshine expects 16kHz mono input. */
const TARGET_SAMPLE_RATE = 16_000;
const TRANSCRIBE_TIMEOUT_MS = 15_000;

export function localEarsEnabled(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(EARS_STORE_KEY) === "on";
  } catch {
    return false;
  }
}

export function setLocalEarsEnabled(on: boolean): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(EARS_STORE_KEY, on ? "on" : "off");
    }
  } catch {
    // best-effort
  }
  if (on) {
    warmLocalEars();
  }
}

let asrWorker: Worker | null = null;
let asrReady = false;
let asrLoading = false;
let asrStatus: LocalEarsStatus = "unloaded";
let nextTranscribeId = 1;
const pendingTranscriptions = new Map<number, (text: string | null) => void>();
let lastEmittedPercent = -1;
let lastFailureAt = 0;
let lastFailureReason: string | undefined;
const progressListeners = new Set<(progress: LocalEarsProgress) => void>();

function emitProgress(progress: LocalEarsProgress): void {
  for (const listener of progressListeners) {
    try {
      listener(progress);
    } catch {
      // listener errors must not break the loader
    }
  }
}

export function localEarsStatus(): LocalEarsStatus {
  return asrStatus;
}

/** Subscribe to download/ready state (replays the current state immediately). */
export function onLocalEarsProgress(listener: (progress: LocalEarsProgress) => void): () => void {
  progressListeners.add(listener);
  listener({
    status: asrStatus,
    ...(asrStatus === "downloading" && lastEmittedPercent >= 0 ? { percent: lastEmittedPercent } : {}),
    ...(asrStatus === "unavailable" && lastFailureReason ? { reason: lastFailureReason } : {})
  });
  return () => progressListeners.delete(listener);
}

/** User-initiated retry (⚙ ↻): clears the failure cooldown for a fresh verdict. */
export function retryLocalEars(): void {
  if (asrReady || asrLoading) {
    return;
  }
  lastFailureAt = 0;
  lastFailureReason = undefined;
  asrStatus = "unloaded";
  warmLocalEars();
}

function failLocalEars(reason: string): void {
  console.warn("[orreris] local ears: failed to load Moonshine —", reason);
  lastFailureReason = reason;
  asrWorker?.terminate();
  asrWorker = null;
  asrReady = false;
  asrLoading = false;
  asrStatus = "unavailable";
  lastFailureAt = Date.now();
  for (const resolve of pendingTranscriptions.values()) {
    resolve(null);
  }
  pendingTranscriptions.clear();
  emitProgress({ status: "unavailable", reason });
  // Auto-retry after the cooldown while the voice UI is mounted — completed files are
  // browser-cached, so a retry after a flaky-network drop resumes cheaply.
  setTimeout(() => {
    if (!asrReady && progressListeners.size > 0 && localEarsEnabled()) {
      warmLocalEars();
    }
  }, 35_000);
}

export function warmLocalEars(): void {
  if (asrReady || asrLoading || typeof window === "undefined" || typeof Worker === "undefined") {
    return;
  }
  if (asrStatus === "unavailable" && Date.now() - lastFailureAt < 30_000) {
    return;
  }
  asrLoading = true;
  asrStatus = "downloading";
  lastEmittedPercent = 0;
  emitProgress({ status: "downloading", percent: 0 });

  // Same aggregation as the voice download: HF CDN sometimes omits content-length (gzip) —
  // total 0 = unknown → emit honest MB, never a fake %.
  const files = new Map<string, { loaded: number; total: number }>();
  let lastEmittedMb = -1;
  const onFileProgress = (file: string, loaded: number, total: number) => {
    files.set(file, { loaded, total });
    let loadedSum = 0;
    let totalSum = 0;
    let totalKnown = true;
    for (const entry of files.values()) {
      loadedSum += entry.loaded;
      if (entry.total > 0) {
        totalSum += entry.total;
      } else {
        totalKnown = false;
      }
    }
    const loadedMb = Math.round(loadedSum / 1_048_576);
    if (totalKnown && totalSum > 0) {
      const percent = Math.max(0, Math.min(99, Math.round((loadedSum / totalSum) * 100)));
      if (percent !== lastEmittedPercent) {
        lastEmittedPercent = percent;
        emitProgress({ status: "downloading", percent, loadedMb, totalMb: Math.round(totalSum / 1_048_576) });
      }
    } else if (loadedMb !== lastEmittedMb) {
      lastEmittedMb = loadedMb;
      emitProgress({ status: "downloading", loadedMb });
    }
  };

  try {
    const worker = new Worker(new URL("./asr.worker.ts", import.meta.url), { type: "module" });
    asrWorker = worker;
    worker.onmessage = (event: MessageEvent<import("./asr.worker").AsrWorkerResponse>) => {
      const message = event.data;
      if (message.type === "progress") {
        onFileProgress(message.file, message.loaded, message.total);
      } else if (message.type === "ready") {
        asrReady = true;
        asrLoading = false;
        asrStatus = "ready";
        emitProgress({ status: "ready", percent: 100 });
      } else if (message.type === "load-error") {
        failLocalEars(message.message);
      } else {
        const resolve = pendingTranscriptions.get(message.id);
        if (resolve) {
          pendingTranscriptions.delete(message.id);
          if (message.ok) {
            resolve(message.text);
          } else {
            console.warn("[orreris] local ears: transcription failed in worker —", message.message);
            resolve(null);
          }
        }
      }
    };
    worker.onerror = (event) => {
      failLocalEars(event.message || "worker crashed");
    };
    worker.postMessage({ type: "warm", modelId: ASR_MODEL_ID } satisfies import("./asr.worker").AsrWorkerRequest);
  } catch (error) {
    failLocalEars(error instanceof Error ? error.message : String(error));
  }
}

/** Decode a recorded utterance (webm/ogg blob) to 16kHz mono PCM — decode/resample need the
 * main thread's audio stack; inference happens in the worker. */
async function decodeTo16kMono(blob: Blob): Promise<Float32Array | null> {
  try {
    const bytes = await blob.arrayBuffer();
    const AudioCtor =
      typeof AudioContext !== "undefined"
        ? AudioContext
        : (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtor || typeof OfflineAudioContext === "undefined") {
      return null;
    }
    const probe = new AudioCtor();
    let decoded: AudioBuffer;
    try {
      decoded = await probe.decodeAudioData(bytes);
    } finally {
      void probe.close().catch(() => undefined);
    }
    if (decoded.duration < 0.15) {
      return null; // too short to contain speech
    }
    const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * TARGET_SAMPLE_RATE), TARGET_SAMPLE_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return rendered.getChannelData(0);
  } catch (error) {
    console.warn("[orreris] local ears: couldn't decode the recording", error);
    return null;
  }
}

/** Transcribe one recorded utterance locally. Null on any failure/timeout — the caller keeps
 * the Web Speech text, so this can only ever IMPROVE a transcript, never lose one. */
export async function transcribeBlobLocally(blob: Blob): Promise<string | null> {
  if (!asrWorker || !asrReady) {
    return null;
  }
  const audio = await decodeTo16kMono(blob);
  if (!audio || !asrWorker || !asrReady) {
    return null;
  }
  const id = nextTranscribeId;
  nextTranscribeId += 1;
  const startedAt = performance.now();
  const result = await Promise.race([
    new Promise<string | null>((resolve) => {
      pendingTranscriptions.set(id, resolve);
      // Copy the buffer for transfer — the caller may still hold the original view.
      const payload = audio.slice().buffer;
      asrWorker!.postMessage({ type: "transcribe", id, audio: payload } satisfies import("./asr.worker").AsrWorkerRequest, [payload]);
    }),
    new Promise<null>((resolve) =>
      setTimeout(() => {
        pendingTranscriptions.delete(id);
        resolve(null);
      }, TRANSCRIBE_TIMEOUT_MS)
    )
  ]);
  if (result) {
    console.debug(`[orreris] local ears: transcribed ${Math.round(audio.length / TARGET_SAMPLE_RATE)}s in ${Math.round(performance.now() - startedAt)}ms`);
  }
  return result;
}
