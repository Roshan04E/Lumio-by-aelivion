/**
 * TTS read-back for voice mode. The command plane's `say` lines and the brain/agent answers
 * were written TTS-ready; this is the voice that reads them.
 *
 * TWO ENGINES:
 *  - System (Web Speech `speechSynthesis`) — instant, zero download, the day-one default.
 *    Gender-matched to the chosen natural voice (Michael selected → male system voice).
 *  - Kokoro-82M (`kokoro-js`, Apache-2.0 — commercial OK) — genuinely natural, fully in-browser
 *    (WASM q8 ≈86MB, browser-cached after the first download; see warmNaturalVoice for why not
 *    webgpu/fp32). It warms in the background when voice mode is first used, WITH VISIBLE PROGRESS
 *    (user requirement: no magic) — subscribe via `onNaturalVoiceProgress`. Until it's ready
 *    (or where it can't run) the system voice answers; then Kokoro takes over seamlessly.
 *
 * SPEECH IS STREAMED, sentence by sentence: Kokoro's `stream()` yields one audio per sentence,
 * so the first sound arrives after ONE sentence's inference (not the whole reply), replies have
 * no length cap (multi-point answers are read in FULL), and `startSpeechStream()` lets talk-mode
 * speak the LLM reply live while it is still streaming in. The system engine mirrors this with
 * sentence-chunked utterances (also dodging Chrome's long-utterance mid-speech silence).
 *
 * Only ever invoked from a live voice session (AiChatPanel's `speakIfVoice`); typed chats stay
 * silent. The caller gates the mic while speech is pending — TTS and dictation must never
 * overlap or the recognizer transcribes our own reply.
 */

export function ttsSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";
}

/**
 * Strip emoji/markdown/UI glyphs so the spoken line is clean prose. Line-aware: bullet/number
 * markers are dropped and every line gets terminal punctuation, so list points become real
 * sentences with natural pauses — NO length cap (a truncation here once silenced everything
 * after a reply's first bullet point).
 */
export function speakable(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => {
      let out = line
        // markdown links → their label
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        // list markers (bullets, numbering) — BEFORE emphasis stripping eats the `*`
        .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "")
        // emphasis/code/table markers
        .replace(/[*_`~#>|]/g, "")
        // emoji + pictographs + arrows/geometric UI glyphs
        .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{25A0}-\u{25FF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (out && !/[.!?:;,…]$/.test(out)) {
        out += ".";
      }
      return out;
    })
    .filter(Boolean);
  return lines.join(" ");
}

/**
 * Split CLEANED text (from `speakable`) into sentence chunks the system engine can speak one
 * utterance at a time. Tiny fragments merge into their neighbor; a run-on without punctuation
 * hard-splits around the cap.
 */
export function splitSpeakable(cleaned: string): string[] {
  const MAX_CHUNK = 280;
  const sentences = cleaned.match(/[^.!?…]+[.!?…]+["')\]]*\s*|[^.!?…]+$/g) ?? [];
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > MAX_CHUNK) {
      chunks.push(current.trim());
      current = "";
    }
    current += sentence;
    while (current.length > MAX_CHUNK) {
      // Run-on with no boundary — hard-split at the last space inside the cap.
      const head = current.slice(0, MAX_CHUNK);
      const cut = head.lastIndexOf(" ");
      const at = cut > 40 ? cut : MAX_CHUNK;
      chunks.push(current.slice(0, at).trim());
      current = current.slice(at);
    }
  }
  if (current.trim()) {
    chunks.push(current.trim());
  }
  return chunks.filter(Boolean);
}

// ---------------------------------------------------------------------------
// Natural voice (Kokoro) — lazy singleton with observable download progress
// ---------------------------------------------------------------------------

export type NaturalVoiceStatus = "unloaded" | "downloading" | "ready" | "unavailable";

export interface NaturalVoiceProgress {
  status: NaturalVoiceStatus;
  /** 0–100 while downloading. */
  percent?: number;
  /** Real transfer scale while downloading — honest sizing, not just a bar. */
  loadedMb?: number;
  totalMb?: number;
  /** Short human-readable failure reason (unavailable only) — surfaced, never swallowed. */
  reason?: string;
  /** Where inference landed (ready only): webgpu = the fast path, wasm = CPU fallback. */
  device?: "webgpu" | "wasm";
}

const KOKORO_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

/** Curated Kokoro voices offered in the AI settings menu (each is a tiny lazy-fetched style
 * file — the 86MB model is shared, so switching is cheap). `gender` also steers the SYSTEM
 * fallback voice, so picking Michael never answers in a female voice while Kokoro warms. */
export const NATURAL_VOICES = [
  { id: "af_heart", label: "Heart — American female", gender: "female" },
  { id: "am_michael", label: "Michael — American male", gender: "male" }
] as const;
export type NaturalVoiceId = (typeof NATURAL_VOICES)[number]["id"];
/** The picker also offers a full opt-out: "system" = always the instant OS/browser voice,
 * never download or run Kokoro. */
export type AssistantVoiceChoice = NaturalVoiceId | "system";

const VOICE_STORE_KEY = "kimera.voice.tts.voice.v1";

function loadVoiceChoice(): AssistantVoiceChoice {
  try {
    const stored = typeof localStorage !== "undefined" ? localStorage.getItem(VOICE_STORE_KEY) : null;
    if (stored === "system" || (stored && NATURAL_VOICES.some((voice) => voice.id === stored))) {
      return stored as AssistantVoiceChoice;
    }
  } catch {
    // fall through
  }
  return "af_heart";
}

let voiceChoice: AssistantVoiceChoice = loadVoiceChoice();
/** The Kokoro generation voice — stays on the last NATURAL pick even while opted out, so the
 * gender-matched system fallback keeps the user's chosen gender. */
let kokoroVoice: NaturalVoiceId = voiceChoice === "system" ? "af_heart" : voiceChoice;

export function getNaturalVoice(): AssistantVoiceChoice {
  return voiceChoice;
}

export function setNaturalVoice(id: AssistantVoiceChoice): void {
  voiceChoice = id;
  if (id !== "system") {
    kokoroVoice = id;
  }
  // The system fallback is gender-matched — re-pick it for the new selection.
  cachedVoice = undefined;
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(VOICE_STORE_KEY, id);
    }
  } catch {
    // best-effort
  }
  if (id !== "system") {
    // Back on a natural voice: (re)start the download if needed and pre-generate the instant
    // acks in the new voice (old voice's entries stay cached).
    warmNaturalVoice();
    warmAckCache();
  }
}

/** All Kokoro work happens in a dedicated Worker — WASM inference on the main thread froze the
 * entire editor for seconds per reply ("page unresponsive"). */
let kokoroWorker: Worker | null = null;
let kokoroReady = false;
let kokoroLoading = false;
let kokoroDevice: "webgpu" | "wasm" | undefined;
let kokoroStatus: NaturalVoiceStatus = "unloaded";
let nextSpeakId = 1;
let lastEmittedPercent = -1;
const progressListeners = new Set<(progress: NaturalVoiceProgress) => void>();

/** Live speech sessions in the worker, keyed by id — chunk/done/error land here. */
interface SpeakSessionHandlers {
  onChunk: (wav: ArrayBuffer) => void;
  onDone: () => void;
  onError: (message: string) => void;
}
const speakSessions = new Map<number, SpeakSessionHandlers>();

function emitProgress(progress: NaturalVoiceProgress): void {
  for (const listener of progressListeners) {
    try {
      listener(progress);
    } catch {
      // listener errors must not break the loader
    }
  }
}

export function naturalVoiceStatus(): NaturalVoiceStatus {
  return kokoroStatus;
}

/** User-initiated retry (⚙ menu ↻): clears the failure cooldown AND the too-slow strikes —
 * a fresh verdict, e.g. after the network recovers or the worker migration changed the math. */
export function retryNaturalVoice(): void {
  if (kokoroReady || kokoroLoading) {
    return;
  }
  kokoroSlowStrikes = 0;
  lastFailureAt = 0;
  lastFailureReason = undefined;
  kokoroStatus = "unloaded";
  warmNaturalVoice();
}

/** Subscribe to download/ready state (replays the current state immediately). */
export function onNaturalVoiceProgress(listener: (progress: NaturalVoiceProgress) => void): () => void {
  progressListeners.add(listener);
  listener({
    status: kokoroStatus,
    ...(kokoroStatus === "downloading" && lastEmittedPercent >= 0 ? { percent: lastEmittedPercent } : {}),
    ...(kokoroStatus === "unavailable" && lastFailureReason ? { reason: lastFailureReason } : {}),
    ...(kokoroStatus === "ready" && kokoroDevice ? { device: kokoroDevice } : {})
  });
  return () => progressListeners.delete(listener);
}

/**
 * Kick off the Kokoro download/compile in the background (idempotent). Called when a voice
 * session starts or the wake word is armed — by the time the user needs a reply, the natural
 * voice is often already there; the system voice covers the gap.
 */
let lastFailureAt = 0;
let lastFailureReason: string | undefined;

function failNaturalVoice(reason: string): void {
  console.warn("[kimera] natural voice: failed to load Kokoro —", reason);
  lastFailureReason = reason;
  kokoroWorker?.terminate();
  kokoroWorker = null;
  kokoroReady = false;
  kokoroLoading = false;
  kokoroDevice = undefined;
  ackCache.clear();
  kokoroStatus = "unavailable";
  lastFailureAt = Date.now();
  for (const session of speakSessions.values()) {
    session.onError(reason);
  }
  speakSessions.clear();
  emitProgress({ status: "unavailable", reason });
  // Auto-retry once the cooldown passes while anyone is still listening (voice UI mounted) —
  // completed files are browser-cached, so a retry after a flaky-network drop resumes cheaply.
  setTimeout(() => {
    if (!kokoroReady && progressListeners.size > 0) {
      warmNaturalVoice();
    }
  }, 35_000);
}

export function warmNaturalVoice(): void {
  // Opted out ("System voice" in the picker): never download or run Kokoro.
  if (voiceChoice === "system") {
    return;
  }
  if (kokoroReady || kokoroLoading || typeof window === "undefined" || typeof Worker === "undefined") {
    return;
  }
  // A failed attempt (flaky network mid-download is the common case) is retryable; the cooldown
  // stops a broken network from hammering in a loop.
  if (kokoroStatus === "unavailable" && Date.now() - lastFailureAt < 30_000) {
    return;
  }
  kokoroLoading = true;
  kokoroStatus = "downloading";
  lastEmittedPercent = 0;
  emitProgress({ status: "downloading", percent: 0 });

  // Download-progress aggregation (the worker forwards raw per-file events). The HF CDN
  // sometimes omits content-length (gzip): total 0 = unknown → emit honest MB, not a fake %.
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
    // q8/WASM on purpose (see AGENTS.md): ~86MB vs fp32's 326MB, community-standard pairing.
    const worker = new Worker(new URL("./tts.worker.ts", import.meta.url), { type: "module" });
    kokoroWorker = worker;
    worker.onmessage = (event: MessageEvent<import("./tts.worker").TtsWorkerResponse>) => {
      const message = event.data;
      if (message.type === "progress") {
        onFileProgress(message.file, message.loaded, message.total);
      } else if (message.type === "ready") {
        kokoroReady = true;
        kokoroLoading = false;
        kokoroDevice = message.device;
        kokoroStatus = "ready";
        kokoroSlowStrikes = 0; // ready = the worker's own warm generation already succeeded
        console.debug(`[kimera] natural voice: ready on ${message.device === "webgpu" ? "GPU (WebGPU)" : "CPU (WASM)"}`);
        emitProgress({ status: "ready", percent: 100, device: message.device });
        warmAckCache();
      } else if (message.type === "load-error") {
        failNaturalVoice(message.message);
      } else {
        const session = speakSessions.get(message.id);
        if (!session) {
          return; // superseded session — late chunks are dropped on the floor
        }
        if (message.type === "chunk") {
          session.onChunk(message.wav);
        } else if (message.type === "speak-done") {
          speakSessions.delete(message.id);
          session.onDone();
        } else {
          speakSessions.delete(message.id);
          console.warn("[kimera] natural voice: generation failed in worker —", message.message);
          session.onError(message.message);
        }
      }
    };
    worker.onerror = (event) => {
      // Fatal only while loading. Post-ready, one stray error must not cost the user the
      // loaded 86MB model — sessions have their own error/stall paths.
      if (!kokoroReady) {
        failNaturalVoice(event.message || "worker crashed");
      } else {
        console.warn("[kimera] natural voice: worker error (engine kept alive)", event.message);
      }
    };
    worker.postMessage({ type: "warm", modelId: KOKORO_MODEL_ID, voice: kokoroVoice } satisfies import("./tts.worker").TtsWorkerRequest);
  } catch (error) {
    failNaturalVoice(error instanceof Error ? error.message : String(error));
  }
}

/** Canned-ack cache: tiny frequent lines pre-generated per voice, so acknowledgments are
 * INSTANT regardless of device speed (the wake "Yes?" especially — it's the assistant's
 * reaction time). Keyed voice|text; switching voice just warms the new voice's entries. */
const ACK_LINES = ["Okay.", "Done.", "Yes?", "I'm listening.", "Go ahead."];
const ackCache = new Map<string, ArrayBuffer>();

function warmAckCache(): void {
  if (!kokoroWorker || !kokoroReady) {
    return;
  }
  for (const line of ACK_LINES) {
    const key = `${kokoroVoice}|${line}`;
    if (ackCache.has(key)) {
      continue;
    }
    const id = nextSpeakId;
    nextSpeakId += 1;
    speakSessions.set(id, {
      onChunk: (wav) => ackCache.set(key, wav),
      onDone: () => {},
      onError: () => {}
    });
    const post = (message: import("./tts.worker").TtsWorkerRequest) => kokoroWorker?.postMessage(message);
    post({ type: "speak-start", id, voice: kokoroVoice });
    post({ type: "speak-push", id, text: line });
    post({ type: "speak-end", id });
  }
}

// ---------------------------------------------------------------------------
// System voice (Web Speech) — instant fallback, gender-matched to the selection
// ---------------------------------------------------------------------------

let cachedVoice: SpeechSynthesisVoice | null | undefined;

const MALE_NAME_RE = /\b(male|david|mark|guy|andrew|christopher|james|george|ryan|eric|brian|daniel)\b/i;
const FEMALE_NAME_RE = /\b(female|zira|jenny|aria|michelle|samantha|susan|hazel|sonia|libby|catherine|natasha)\b/i;

function pickVoice(): SpeechSynthesisVoice | null {
  if (cachedVoice !== undefined) {
    return cachedVoice;
  }
  const voices = window.speechSynthesis.getVoices();
  if (voices.length === 0) {
    // Voice list not loaded yet (Chrome loads it async) — don't cache; retry next call.
    return null;
  }
  const lang = (typeof navigator !== "undefined" ? navigator.language : "en-US") || "en-US";
  const sameLang = voices.filter((voice) => voice.lang.startsWith(lang.slice(0, 2)));
  const pool = sameLang.length > 0 ? sameLang : voices;
  // Match the gender of the chosen natural voice (a male pick must not fall back to female).
  const gender = NATURAL_VOICES.find((voice) => voice.id === kokoroVoice)?.gender ?? "female";
  const genderPool =
    gender === "male"
      ? pool.filter((voice) => MALE_NAME_RE.test(voice.name) && !/female/i.test(voice.name))
      : (() => {
          const named = pool.filter((voice) => FEMALE_NAME_RE.test(voice.name));
          return named.length > 0 ? named : pool.filter((voice) => !MALE_NAME_RE.test(voice.name));
        })();
  // Some systems ship no voice of the wanted gender — fall back to the full pool honestly.
  const candidates = genderPool.length > 0 ? genderPool : pool;
  // Prefer NETWORK voices (localService=false — Chrome's Google voices) over local SAPI ones:
  // on Windows the local pool is the ancient "Microsoft David/Zira Desktop" tier (maximally
  // robotic), while the network voices are dramatically closer to natural.
  cachedVoice =
    candidates.find((voice) => !voice.localService && /natural|neural/i.test(voice.name)) ??
    candidates.find((voice) => /natural|neural/i.test(voice.name)) ??
    candidates.find((voice) => !voice.localService && /google/i.test(voice.name)) ??
    candidates.find((voice) => !voice.localService) ??
    candidates.find((voice) => /google/i.test(voice.name)) ??
    candidates[0] ??
    null;
  return cachedVoice;
}

/** Held module-wide: Chrome garbage-collects an unreferenced utterance MID-SPEECH (silence). */
let activeUtterance: SpeechSynthesisUtterance | null = null;

function speakSystem(cleaned: string): Promise<void> {
  if (!ttsSupported()) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    try {
      const synth = window.speechSynthesis;
      synth.cancel();
      const utterance = new SpeechSynthesisUtterance(cleaned);
      const voice = pickVoice();
      if (voice) {
        utterance.voice = voice;
      }
      utterance.rate = 1.05;
      activeUtterance = utterance;
      let settled = false;
      const settle = () => {
        if (!settled) {
          settled = true;
          if (activeUtterance === utterance) {
            activeUtterance = null;
          }
          resolve();
        }
      };
      utterance.onend = settle;
      utterance.onerror = settle;
      // Chrome DROPS an utterance queued in the same tick as cancel() — give the engine a beat,
      // and resume() first in case a previous cancel left the queue paused.
      setTimeout(() => {
        try {
          synth.resume();
          synth.speak(utterance);
        } catch {
          settle();
        }
      }, 80);
      // Safety valve: if Chrome never fires end/error (it happens), release the mic gate.
      setTimeout(settle, 30_000);
    } catch {
      resolve();
    }
  });
}

// ---------------------------------------------------------------------------
// Public speak/stop — sentence-streamed sessions routed to Kokoro or system
// ---------------------------------------------------------------------------

/** Monotonic token: bumping it silences any in-flight generation/playback (stop/next reply). */
let speakToken = 0;
let currentAudio: HTMLAudioElement | null = null;
/** The active stream's cancel hook — stopSpeaking() must reach INSIDE the session (worker
 * cancel + player-loop wake), not just pause the current audio element. */
let cancelActiveStream: (() => void) | null = null;

/** Two first-chunk timeouts in a row = this machine can't run Kokoro at conversational speed —
 * stop trying and let the system voice answer INSTANTLY instead of a dead 12s wait per reply. */
let kokoroSlowStrikes = 0;

/** Time-to-first-audio budget (Kokoro generates ONE sentence in this window, not the reply —
 * and "ready" already includes the worker's warm generation, so no compile can eat it). */
const FIRST_CHUNK_TIMEOUT_MS = 12_000;
/** Post-`end()` drain guard: a silent gap this long between chunks means the worker wedged. */
const CHUNK_STALL_MS = 20_000;

/** Play one WAV chunk; resolves on end/error/pause (pause = stopSpeaking — must NOT hang the
 * mic gate, which awaits this chain). */
function playWav(wav: ArrayBuffer, token: number): Promise<void> {
  if (token !== speakToken) {
    return Promise.resolve();
  }
  const url = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
  return new Promise<void>((resolve) => {
    const element = new Audio(url);
    currentAudio = element;
    let settled = false;
    const settle = () => {
      if (!settled) {
        settled = true;
        URL.revokeObjectURL(url);
        if (currentAudio === element) {
          currentAudio = null;
        }
        resolve();
      }
    };
    element.onended = settle;
    element.onerror = settle;
    // "pause" fires only on pause() (not at natural end) — i.e. stopSpeaking mid-chunk.
    element.onpause = settle;
    element.play().catch((playError: unknown) => {
      // Autoplay policy or decode refusal — surface it; the session falls back for the rest.
      console.warn("[kimera] natural voice: playback blocked", playError);
      settle();
    });
  });
}

// ---- Self-echo defense ----
// The recognizer can catch the TAIL of our own speech (speakers keep emitting for a beat after
// the speak promise settles, and Web Speech offers no device-audio filtering). Every line handed
// to TTS is recorded here so the voice submit path can discard transcripts that are just us
// hearing ourselves ("Moved clip 1 onto V3." → heard as "Move to clip 1 onto V3.").
const spokenLines: { text: string; at: number }[] = [];
const SPOKEN_RETAIN_MS = 15_000;
function recordSpokenLine(text: string): void {
  const now = performance.now();
  spokenLines.push({ text, at: now });
  while (spokenLines.length > 6 || (spokenLines.length > 0 && now - spokenLines[0]!.at > SPOKEN_RETAIN_MS)) {
    spokenLines.shift();
  }
}
/** Recently TTS-spoken lines (newest last), pruned to the last 15s — echo-guard input. */
export function recentlySpokenLines(): { text: string; at: number }[] {
  const now = performance.now();
  return spokenLines.filter((line) => now - line.at <= SPOKEN_RETAIN_MS);
}

export interface SpeechStreamHandle {
  /** Feed more text (any markdown — it's cleaned here). Safe to call repeatedly. */
  push(text: string): void;
  /** No more text; resolves when EVERYTHING pushed has finished playing. */
  end(): Promise<void>;
  /** Abandon the session immediately (alias of stopSpeaking for this session). */
  cancel(): void;
}

/**
 * Open a speech session — the one primitive under both `speakReply` (push once, end) and
 * talk-mode's live read-back (push sentence-by-sentence while the LLM streams). Cancels
 * anything already speaking. Routes to Kokoro when ready, else the system voice; a Kokoro
 * session that can't produce its FIRST chunk in time falls back to the system voice with
 * nothing lost (the text is replayed).
 */
export function startSpeechStream(): SpeechStreamHandle {
  stopSpeaking();
  const token = ++speakToken;

  let engine: "kokoro" | "system" = kokoroStatus === "ready" && kokoroWorker && voiceChoice !== "system" ? "kokoro" : "system";
  let ended = false;
  /** Everything pushed (cleaned) — replayed through the system voice on pre-first-chunk fallback. */
  let pushedText = "";
  let systemChain = Promise.resolve();

  const systemPush = (cleaned: string) => {
    for (const chunk of splitSpeakable(cleaned)) {
      systemChain = systemChain.then(() => (token === speakToken ? speakSystem(chunk) : Promise.resolve()));
    }
  };

  // ---- Kokoro session state (unused in system mode) ----
  let kokoroId = 0;
  const queue: ArrayBuffer[] = [];
  let chunkCount = 0;
  let workerDone = false;
  let firstChunkSeen = false;
  let firstPushAt = 0;
  let notify: (() => void) | null = null;
  const wake = () => {
    notify?.();
    notify = null;
  };
  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      let done = false;
      const settle = () => {
        if (!done) {
          done = true;
          resolve();
        }
      };
      notify = settle;
      setTimeout(settle, ms);
    });

  const post = (message: import("./tts.worker").TtsWorkerRequest) => {
    try {
      kokoroWorker?.postMessage(message);
    } catch {
      // worker gone — the session error path handles it
    }
  };

  const dropKokoroSession = () => {
    if (kokoroId) {
      speakSessions.delete(kokoroId);
      post({ type: "speak-cancel", id: kokoroId });
    }
  };

  /** Pre-first-chunk failure → the SYSTEM voice takes the whole reply (nothing spoken yet). */
  const fallBackToSystem = (reason: string, strike: boolean) => {
    if (engine !== "kokoro" || token !== speakToken) {
      return;
    }
    if (strike) {
      kokoroSlowStrikes += 1;
      console.warn(`[kimera] natural voice: ${reason} (strike ${kokoroSlowStrikes}) — using the system voice`);
      if (kokoroSlowStrikes >= 2) {
        kokoroStatus = "unavailable";
        lastFailureReason = "too slow on this device";
        emitProgress({ status: "unavailable", reason: lastFailureReason });
      }
    } else {
      console.warn(`[kimera] natural voice: ${reason} — using the system voice`);
    }
    dropKokoroSession();
    engine = "system";
    if (pushedText) {
      systemPush(pushedText);
    }
  };

  let playerDone = Promise.resolve();
  if (engine === "kokoro") {
    kokoroId = nextSpeakId;
    nextSpeakId += 1;
    speakSessions.set(kokoroId, {
      onChunk: (wav) => {
        queue.push(wav);
        chunkCount += 1;
        wake();
      },
      onDone: () => {
        workerDone = true;
        wake();
      },
      onError: (message) => {
        workerDone = true;
        if (!firstChunkSeen) {
          fallBackToSystem(`generation failed (${message})`, false);
        }
        wake();
      }
    });
    post({ type: "speak-start", id: kokoroId, voice: kokoroVoice });
    // stopSpeaking() must reach in here: cancel the worker session AND wake the player loop
    // (it may be parked waiting for pushes that will never come after a cancel).
    cancelActiveStream = () => {
      dropKokoroSession();
      wake();
    };
    const startedAt = performance.now();

    playerDone = (async () => {
      while (token === speakToken && engine === "kokoro") {
        const wav = queue.shift();
        if (wav) {
          if (!firstChunkSeen) {
            firstChunkSeen = true;
            kokoroSlowStrikes = 0;
            console.debug(`[kimera] natural voice: first chunk in ${Math.round(performance.now() - (firstPushAt || startedAt))}ms`);
          }
          await playWav(wav, token);
          continue;
        }
        if (workerDone) {
          break;
        }
        if (!firstChunkSeen && firstPushAt) {
          const remaining = FIRST_CHUNK_TIMEOUT_MS - (performance.now() - firstPushAt);
          if (remaining <= 0) {
            fallBackToSystem("first chunk timed out", true);
            break;
          }
          await wait(remaining);
          continue;
        }
        if (ended && firstChunkSeen) {
          // Draining after end(): a long silent gap means the worker wedged mid-reply. The
          // sentences already spoken stay spoken — no system replay (it would duplicate them).
          const before = chunkCount;
          await wait(CHUNK_STALL_MS);
          if (chunkCount === before && queue.length === 0 && !workerDone && token === speakToken) {
            console.warn("[kimera] natural voice: stream stalled mid-reply — stopping this reply");
            dropKokoroSession();
            break;
          }
          continue;
        }
        // Waiting for more pushes (live talk-mode) — no deadline; cancellation wakes us.
        await wait(60_000);
      }
      if (token !== speakToken) {
        dropKokoroSession();
      }
    })();
  }

  return {
    push(text: string) {
      if (ended || token !== speakToken) {
        return;
      }
      const cleaned = speakable(text);
      if (!cleaned) {
        return;
      }
      recordSpokenLine(cleaned); // at push time — the echo window opens when audio STARTS
      if (engine === "kokoro") {
        pushedText += (pushedText ? " " : "") + cleaned;
        if (!firstPushAt) {
          firstPushAt = performance.now();
        }
        post({ type: "speak-push", id: kokoroId, text: `${cleaned} ` });
        wake();
      } else {
        systemPush(cleaned);
      }
    },
    async end() {
      if (!ended) {
        ended = true;
        if (engine === "kokoro") {
          post({ type: "speak-end", id: kokoroId });
          wake();
        }
      }
      // Kokoro may fall back to system MID-await — the chain then holds the replayed text.
      await playerDone;
      await systemChain;
    },
    cancel() {
      if (token === speakToken) {
        stopSpeaking();
      }
    }
  };
}

/** Speak one reply; cancels anything already speaking. Resolves when speech ends (or on error /
 * unsupported), so callers can hold the mic until the room is quiet again. */
export async function speakReply(text: string): Promise<void> {
  const cleaned = speakable(text);
  if (!cleaned) {
    return;
  }
  // Instant path: pre-generated ack ("Okay." / "Done." / "Yes?") — zero generation wait, the
  // assistant's reaction time on any device.
  const cached = kokoroStatus === "ready" && voiceChoice !== "system" ? ackCache.get(`${kokoroVoice}|${cleaned}`) : undefined;
  if (cached) {
    stopSpeaking();
    recordSpokenLine(cleaned);
    await playWav(cached, ++speakToken);
    return;
  }
  const stream = startSpeechStream();
  stream.push(text);
  await stream.end();
}

/** Short "mic is live" earcon for voice sessions — the standard VUI cue that capture has
 * ACTUALLY started. Chrome's recognizer silently drops audio during its ~300–800ms startup
 * handshake; without a mark users talk into the gap and lose their first words. */
let blipContext: AudioContext | null = null;
export function playReadyBlip(): void {
  try {
    if (typeof AudioContext === "undefined") {
      return;
    }
    blipContext ??= new AudioContext();
    const ctx = blipContext;
    void ctx.resume().catch(() => undefined);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1318, ctx.currentTime + 0.07);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.06, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.12);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.13);
  } catch {
    // an earcon must never break speech
  }
}

export function stopSpeaking(): void {
  speakToken += 1;
  const cancel = cancelActiveStream;
  cancelActiveStream = null;
  cancel?.();
  if (currentAudio) {
    try {
      currentAudio.pause();
    } catch {
      // already stopped
    }
    currentAudio = null;
  }
  if (ttsSupported()) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      // already stopped
    }
  }
}
