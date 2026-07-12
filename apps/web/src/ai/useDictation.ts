import { useCallback, useEffect, useRef, useState } from "react";
import { detectBrowserToolCapabilities } from "../tools/capabilities";
import { transcribeAudioUrlLocally } from "../tools/local-transcription";

/**
 * Voice dictation for the AI composer. Primary engine is the browser-native Web Speech API
 * (`SpeechRecognition`), which streams live interim transcripts — the ChatGPT-style dictation feel.
 * Where Web Speech is unavailable (Firefox) but a mic is, we fall back to recording with
 * `MediaRecorder` and transcribing the blob through the local whisper pipeline (no live interim).
 *
 * The hook owns ALL mic/engine state; the composer only wires callbacks + renders the button/waveform.
 * There are no TS DOM lib types for `webkitSpeechRecognition`, so the minimal shapes we use are
 * declared locally (kept strict so `tsc --noEmit`, the only lint gate, passes).
 */

export type DictationStatus = "idle" | "listening" | "transcribing" | "error" | "unsupported";
export type DictationEngine = "speech" | "recorder" | null;

export interface UseDictationOptions {
  /** BCP-47 language tag; defaults to the browser language, then "en-US". */
  lang?: string | undefined;
  /** Auto-stop after this many ms of no new speech. */
  silenceTimeoutMs?: number | undefined;
  /** Auto-stop budget BEFORE any speech has been heard this session — give the user time to
   * think before their first word without dragging out the pause-to-submit after they talk. */
  initialSilenceTimeoutMs?: number | undefined;
  /** Live partial transcript (Web Speech only) — dim text in the composer. */
  onInterim?: ((text: string) => void) | undefined;
  /** A committed chunk of final text — append to the composer base. */
  onFinal?: ((text: string) => void) | undefined;
  /** Human-readable error (permission denial, etc.). */
  onError?: ((message: string) => void) | undefined;
  /**
   * High-accuracy hearing (Web Speech engine only): when provided, the session's audio is ALSO
   * recorded (from the waveform's existing mic stream — no extra permission) and offered here
   * after the session ends. Resolve with better text (local Moonshine ASR) to REPLACE the
   * session's Web Speech finals via `onRefined`, or null to keep them. The hook holds status at
   * "transcribing" while this runs, so voice-session auto-submit waits for the better text.
   */
  refineFinal?: ((audio: Blob) => Promise<string | null>) | undefined;
  /** The refined full-session transcript (replaces this session's finals in the composer). */
  onRefined?: ((text: string) => void) | undefined;
}

export interface UseDictationApi {
  status: DictationStatus;
  /** True only once the engine is REALLY capturing (Web Speech `audiostart`) — "listening"
   * status alone lies for the first ~300–800ms while Chrome handshakes with its service. */
  capturing: boolean;
  interimText: string;
  error: string | null;
  amplitude: number;
  supported: boolean;
  engine: DictationEngine;
  start: () => void;
  stop: () => void;
  cancel: () => void;
  toggle: () => void;
}

// ---- Minimal Web Speech typings (no DOM lib types for the webkit-prefixed variant) ----
interface SpeechRecognitionAlternativeLike {
  transcript: string;
}
interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: SpeechRecognitionAlternativeLike;
}
interface SpeechRecognitionResultListLike {
  readonly length: number;
  [index: number]: SpeechRecognitionResultLike;
}
interface SpeechRecognitionEventLike {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultListLike;
}
interface SpeechRecognitionErrorEventLike {
  readonly error: string;
}
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  /** Fires when the engine ACTUALLY starts capturing audio — `start()` returns immediately but
   * Chrome spends ~300–800ms handshaking with its speech service first; speech in that window
   * is silently dropped. UI must not claim "listening" before this. */
  onaudiostart?: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  const g = globalThis as typeof globalThis & {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return g.SpeechRecognition ?? g.webkitSpeechRecognition ?? null;
}

const DEFAULT_SILENCE_MS = 3500;

/** Bare Web Speech recognizer for auxiliary listeners (the "hey lumio" wake-word standby);
 * null where Web Speech is unavailable (the whisper fallback can't run continuously). */
export function createSpeechRecognition(): SpeechRecognitionLike | null {
  const Ctor = getSpeechRecognitionCtor();
  try {
    return Ctor ? new Ctor() : null;
  } catch {
    return null;
  }
}
export type { SpeechRecognitionLike };

export function useDictation(options: UseDictationOptions = {}): UseDictationApi {
  const { onInterim, onFinal, onError, refineFinal, onRefined } = options;
  const lang = options.lang ?? (typeof navigator !== "undefined" ? navigator.language : undefined) ?? "en-US";
  const silenceMs = options.silenceTimeoutMs ?? DEFAULT_SILENCE_MS;
  const initialSilenceMs = options.initialSilenceTimeoutMs ?? silenceMs;

  // Latest-callback refs so the long-lived engine handlers never capture stale closures.
  const onInterimRef = useRef(onInterim);
  const onFinalRef = useRef(onFinal);
  const onErrorRef = useRef(onError);
  const refineFinalRef = useRef(refineFinal);
  const onRefinedRef = useRef(onRefined);
  onInterimRef.current = onInterim;
  onFinalRef.current = onFinal;
  onErrorRef.current = onError;
  refineFinalRef.current = refineFinal;
  onRefinedRef.current = onRefined;

  const caps = useRef(detectBrowserToolCapabilities());
  const engine: DictationEngine = caps.current.speechRecognition
    ? "speech"
    : caps.current.microphone
      ? "recorder"
      : null;
  const supported = engine !== null;

  const [status, setStatus] = useState<DictationStatus>(supported ? "idle" : "unsupported");
  const [capturing, setCapturing] = useState(false);
  const [interimText, setInterimText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [amplitude, setAmplitude] = useState(0);

  // Engine/session refs.
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  // High-accuracy hearing: parallel recording of the SPEECH-engine session (waveform stream).
  const speechRecorderRef = useRef<MediaRecorder | null>(null);
  const speechChunksRef = useRef<Blob[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heardSpeechRef = useRef(false); // any result this session yet (drives the two-phase silence budget)
  const wantActiveRef = useRef(false); // still supposed to be listening (drives Chrome auto-restart)
  const manualStopRef = useRef(false); // user-initiated stop/cancel vs engine auto-end
  const cancelledRef = useRef(false); // discard results for this session
  const statusRef = useRef<DictationStatus>(status);
  statusRef.current = status;

  const clearSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current !== null) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  }, []);

  // ---- Waveform: own getUserMedia + AnalyserNode (Web Speech opens its own mic internally). ----
  const stopWaveform = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    analyserRef.current = null;
    if (audioContextRef.current) {
      void audioContextRef.current.close().catch(() => undefined);
      audioContextRef.current = null;
    }
    setAmplitude(0);
  }, []);

  const startWaveform = useCallback(
    (stream: MediaStream) => {
      if (!caps.current.audioContext) {
        return;
      }
      try {
        const AudioCtor =
          typeof AudioContext !== "undefined"
            ? AudioContext
            : (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AudioCtor) {
          return;
        }
        const ctx = new AudioCtor();
        audioContextRef.current = ctx;
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        analyserRef.current = analyser;
        const data = new Uint8Array(analyser.frequencyBinCount);
        let lastWrite = 0;
        let smoothed = 0;
        const loop = () => {
          const node = analyserRef.current;
          if (!node) {
            return;
          }
          node.getByteTimeDomainData(data);
          let sumSquares = 0;
          for (let i = 0; i < data.length; i += 1) {
            const centered = (data[i]! - 128) / 128;
            sumSquares += centered * centered;
          }
          const rms = Math.sqrt(sumSquares / data.length); // 0..~1
          smoothed = smoothed * 0.8 + Math.min(1, rms * 2.2) * 0.2;
          const now = performance.now();
          if (now - lastWrite > 66) {
            // ~15fps state writes to avoid render churn
            lastWrite = now;
            setAmplitude(smoothed);
          }
          rafRef.current = requestAnimationFrame(loop);
        };
        rafRef.current = requestAnimationFrame(loop);
      } catch {
        // Waveform is a nice-to-have; degrade to flat if the analyser can't attach.
        stopWaveform();
      }
    },
    [stopWaveform]
  );

  // ---- Teardown of every engine resource (idempotent). ----
  const teardown = useCallback(() => {
    clearSilenceTimer();
    stopWaveform();
    if (recognitionRef.current) {
      recognitionRef.current.onresult = null;
      recognitionRef.current.onerror = null;
      recognitionRef.current.onend = null;
      try {
        recognitionRef.current.abort();
      } catch {
        // already stopped
      }
      recognitionRef.current = null;
    }
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      try {
        recorderRef.current.stop();
      } catch {
        // already stopped
      }
    }
    recorderRef.current = null;
    if (speechRecorderRef.current) {
      speechRecorderRef.current.onstop = null; // cancelled session — discard, never refine
      if (speechRecorderRef.current.state !== "inactive") {
        try {
          speechRecorderRef.current.stop();
        } catch {
          // already stopped
        }
      }
      speechRecorderRef.current = null;
    }
    speechChunksRef.current = [];
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
    setCapturing(false);
    setInterimText("");
  }, [clearSilenceTimer, stopWaveform]);

  const finishError = useCallback((message: string) => {
    wantActiveRef.current = false;
    setError(message);
    setStatus("error");
    setInterimText("");
    onErrorRef.current?.(message);
  }, []);

  // ---- Silence auto-stop (re-armed on each speech result / above-threshold RMS). ----
  const armSilenceTimer = useRef<() => void>(() => undefined);

  // ================= Web Speech engine =================
  const startSpeech = useCallback(() => {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      finishError("Voice input isn't supported in this browser.");
      return;
    }
    const recognition = new Ctor();
    recognitionRef.current = recognition;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = lang;

    // Real capture start (post-handshake) — the UI's cue to tell the user "talk now".
    recognition.onaudiostart = () => setCapturing(true);

    recognition.onresult = (event) => {
      if (cancelledRef.current) {
        return;
      }
      setCapturing(true); // safety where audiostart isn't fired
      heardSpeechRef.current = true;
      armSilenceTimer.current();
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i]!;
        const text = result[0]?.transcript ?? "";
        if (result.isFinal) {
          const trimmed = text.trim();
          if (trimmed) {
            onFinalRef.current?.(trimmed);
          }
        } else {
          interim += text;
        }
      }
      setInterimText(interim);
      onInterimRef.current?.(interim);
    };

    recognition.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        finishError("Microphone access denied. Enable it in your browser to dictate.");
        teardown();
        return;
      }
      if (event.error === "aborted") {
        // User cancel — handled by cancel(); no error surface.
        return;
      }
      // "no-speech"/"audio-capture"/transient: let onend + silence handling drive the outcome.
    };

    recognition.onend = () => {
      // Chrome ends the session on its own (~60s, or after a silent stretch). If we still want to be
      // listening and the user didn't stop, restart transparently; otherwise finalize the session.
      if (wantActiveRef.current && !manualStopRef.current && !cancelledRef.current) {
        try {
          recognition.start();
          return;
        } catch {
          // fall through to finalize if restart is rejected
        }
      }
      clearSilenceTimer();
      stopWaveform();
      recognitionRef.current = null;
      setCapturing(false);
      setInterimText("");

      const finishTracks = () => {
        if (mediaStreamRef.current) {
          mediaStreamRef.current.getTracks().forEach((track) => track.stop());
          mediaStreamRef.current = null;
        }
      };
      const settleIdle = () => {
        if (!cancelledRef.current) {
          setStatus((current) => (current === "error" ? current : "idle"));
        }
      };

      // High-accuracy hearing: hand the recorded session audio to the refiner (local ASR) — its
      // text REPLACES the Web Speech finals via onRefined. Status holds at "transcribing" so the
      // voice-session auto-submit waits for the better transcript; any failure keeps the Web
      // Speech text (the refiner can only ever improve a transcript, never lose one).
      const speechRecorder = speechRecorderRef.current;
      speechRecorderRef.current = null;
      if (speechRecorder && !cancelledRef.current && refineFinalRef.current) {
        speechRecorder.onstop = () => {
          const chunks = speechChunksRef.current;
          speechChunksRef.current = [];
          finishTracks();
          const refiner = refineFinalRef.current;
          if (cancelledRef.current || chunks.length === 0 || !refiner) {
            settleIdle();
            return;
          }
          setStatus("transcribing");
          const blob = new Blob(chunks, { type: speechRecorder.mimeType || "audio/webm" });
          refiner(blob)
            .then((text) => {
              if (text && text.trim() && !cancelledRef.current) {
                onRefinedRef.current?.(text.trim());
              }
            })
            .catch(() => undefined)
            .finally(settleIdle);
        };
        if (speechRecorder.state !== "inactive") {
          try {
            speechRecorder.stop(); // → onstop above drives the rest
            return;
          } catch {
            speechRecorder.onstop = null; // recorder wedged — fall through to the plain path
          }
        } else {
          speechRecorder.onstop = null;
        }
      }
      speechChunksRef.current = [];
      finishTracks();
      settleIdle();
    };

    try {
      recognition.start();
    } catch {
      finishError("Couldn't start voice input. Try again.");
      return;
    }

    // Best-effort waveform via a separate mic stream (independent of Web Speech's internal capture).
    if (caps.current.audioContext && caps.current.microphone) {
      navigator.mediaDevices
        .getUserMedia({ audio: true })
        .then((stream) => {
          if (!wantActiveRef.current || recognitionRef.current === null) {
            stream.getTracks().forEach((track) => track.stop());
            return;
          }
          mediaStreamRef.current = stream;
          startWaveform(stream);
          // High-accuracy hearing: record the session from this SAME stream (no extra
          // permission) so the local ASR can re-transcribe the whole utterance at the end.
          if (refineFinalRef.current && typeof MediaRecorder !== "undefined") {
            try {
              speechChunksRef.current = [];
              const speechRecorder = new MediaRecorder(stream);
              speechRecorderRef.current = speechRecorder;
              speechRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                  speechChunksRef.current.push(event.data);
                }
              };
              speechRecorder.start();
            } catch {
              speechRecorderRef.current = null; // recording is an enhancement, never a blocker
            }
          }
        })
        .catch(() => undefined);
    }

    setStatus("listening");
    armSilenceTimer.current();
  }, [lang, finishError, teardown, clearSilenceTimer, stopWaveform, startWaveform]);

  // ================= MediaRecorder + whisper fallback =================
  const finalizeRecording = useCallback(async () => {
    const chunks = chunksRef.current;
    chunksRef.current = [];
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
    stopWaveform();
    setCapturing(false);
    if (cancelledRef.current || chunks.length === 0) {
      setStatus((current) => (current === "error" ? current : "idle"));
      return;
    }
    const blob = new Blob(chunks, { type: recorderRef.current?.mimeType || "audio/webm" });
    recorderRef.current = null;
    const url = URL.createObjectURL(blob);
    setStatus("transcribing");
    try {
      const transcript = await transcribeAudioUrlLocally(url, 0);
      const text = transcript.segments
        .map((segment) => segment.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (text && !cancelledRef.current) {
        onFinalRef.current?.(text);
      }
      setStatus("idle");
    } catch (err) {
      finishError(err instanceof Error ? err.message : "Couldn't transcribe the recording.");
    } finally {
      URL.revokeObjectURL(url);
    }
  }, [stopWaveform, finishError]);

  const startRecorder = useCallback(() => {
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        if (!wantActiveRef.current) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        mediaStreamRef.current = stream;
        chunksRef.current = [];
        const recorder = new MediaRecorder(stream);
        recorderRef.current = recorder;
        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) {
            chunksRef.current.push(event.data);
          }
        };
        recorder.onstop = () => {
          void finalizeRecording();
        };
        recorder.start();
        startWaveform(stream);
        setStatus("listening");
        setCapturing(true); // MediaRecorder captures immediately — no service handshake
        armSilenceTimer.current();
      })
      .catch(() => {
        finishError("Microphone access denied. Enable it in your browser to dictate.");
      });
  }, [finalizeRecording, startWaveform, finishError]);

  // ---- Public controls ----
  const stop = useCallback(() => {
    if (statusRef.current !== "listening") {
      return;
    }
    manualStopRef.current = true;
    wantActiveRef.current = false;
    clearSilenceTimer();
    if (engine === "speech") {
      try {
        recognitionRef.current?.stop();
      } catch {
        // ignore
      }
    } else if (engine === "recorder") {
      try {
        recorderRef.current?.stop(); // triggers onstop → finalizeRecording (transcription)
      } catch {
        setStatus("idle");
      }
    }
  }, [engine, clearSilenceTimer]);

  // Silence timer arms a graceful stop (defined after stop so it can call it). Before any
  // speech this session it uses the (longer) initial budget — thinking time; after the first
  // result it tightens to the pause-to-submit budget.
  armSilenceTimer.current = () => {
    clearSilenceTimer();
    silenceTimerRef.current = setTimeout(
      () => {
        if (statusRef.current === "listening") {
          stop();
        }
      },
      heardSpeechRef.current ? silenceMs : initialSilenceMs
    );
  };

  const start = useCallback(() => {
    if (!supported) {
      setStatus("unsupported");
      return;
    }
    if (statusRef.current === "listening" || statusRef.current === "transcribing") {
      return;
    }
    cancelledRef.current = false;
    manualStopRef.current = false;
    wantActiveRef.current = true;
    heardSpeechRef.current = false;
    setCapturing(false);
    setError(null);
    setInterimText("");
    if (engine === "speech") {
      startSpeech();
    } else {
      startRecorder();
    }
  }, [supported, engine, startSpeech, startRecorder]);

  const cancel = useCallback(() => {
    if (statusRef.current === "idle" || statusRef.current === "unsupported") {
      return;
    }
    cancelledRef.current = true;
    manualStopRef.current = true;
    wantActiveRef.current = false;
    teardown();
    setStatus("idle");
    setError(null);
  }, [teardown]);

  const toggle = useCallback(() => {
    if (statusRef.current === "listening") {
      stop();
    } else if (statusRef.current === "idle" || statusRef.current === "error") {
      start();
    }
  }, [start, stop]);

  // Unmount cleanup — abort everything so the browser mic indicator turns off.
  useEffect(() => {
    return () => {
      cancelledRef.current = true;
      wantActiveRef.current = false;
      teardown();
    };
  }, [teardown]);

  return { status, capturing, interimText, error, amplitude, supported, engine, start, stop, cancel, toggle };
}
