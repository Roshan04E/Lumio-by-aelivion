import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { AudioLines, BarChart3, Brain, Cpu, Ear, ImagePlus, KeyRound, Mic, Plus, SendHorizontal, Settings2, Sparkles, Square, SquarePen, Undo2, X } from "lucide-react";
import { createPortal } from "react-dom";
import { buildCapabilityIndex, closeColorGrade, getSkill, getSkillTaskKind, logUnsupported, parseClipReference, recordPlanReviewed, resolveTargetLayer, timelineActionRegistry, type SourceAsset } from "@orreris/shared";
import { createPlanner } from "../../ai/planner/createPlanner";
import { createSpeechRecognition, useDictation } from "../../ai/useDictation";
import { looksLikeSelfEcho } from "../../ai/echo-guard";
import { learnWakePhrase, loadWakePhrases, loadWakeWordEnabled, looksLikeWakeAttempt, matchWakeWord, saveWakeWordEnabled } from "../../ai/wake-word";
import {
  getNaturalVoice,
  NATURAL_VOICES,
  naturalVoiceStatus,
  onNaturalVoiceProgress,
  playReadyBlip,
  recentlySpokenLines,
  retryNaturalVoice,
  setNaturalVoice,
  speakReply,
  startSpeechStream,
  stopSpeaking,
  warmNaturalVoice,
  type AssistantVoiceChoice,
  type NaturalVoiceProgress
} from "../../ai/tts";
import { runGeneration } from "../../generate/generateClient";
import type { GenerateStudioPrefill } from "../generate/GenerateStudio";
import { classifyContinuity, type ContinuityResult } from "../../ai/planner/intent-continuity";
import { arbitrateFinal, normalizeTranscript } from "../../ai/transcript-normalizer";
import { requestSpokenAck } from "../../ai/ack";
import {
  localEarsEnabled,
  localEarsStatus,
  onLocalEarsProgress,
  retryLocalEars,
  setLocalEarsEnabled,
  transcribeBlobLocally,
  warmLocalEars,
  type LocalEarsProgress
} from "../../ai/asr";
import { streamTalk } from "../../ai/talk";
import { loadOllamaConfig, onOllamaCorsBlocked, pingOllama, saveOllamaConfig, type OllamaConfig } from "../../ai/ollama";
import { executePlan, type ToolStepResult } from "../../ai/executor/PlanExecutor";
import {
  appendItem,
  clearTranscript,
  loadTranscript,
  patchItem,
  saveTranscript,
  transcriptId,
  type TranscriptItem,
  type TranscriptItemInput
} from "../../ai/transcript";
import { AGENT_ITERATION_CAPS, runAgentLoop } from "../../ai/agent/AgentLoop";
import { routePrompt, type BrainRouteResult } from "../../ai/brain/router";
import { routePromptWorld } from "../../ai/world/route";
import { routePromptHypothesis } from "../../ai/world/hypothesis-route";
import type { EditorCommandDispatcher } from "../../editor/editor-commands";
import { forgetLearnedPlan, maybeLearnPhrase, routePromptSemantic, storeCachedPlan } from "../../ai/brain/semantic";

/** One completed turn awaiting 👍/👎. `source: "brain"` = an instant local rule (feedback trains
 * its trust); `source: "llm"` = a model result (👍 blesses the cached replay of this prompt,
 * 👎 forgets it so the exact ask is never wrongly repeated). */
interface FeedbackTurn {
  prompt: string;
  ruleId: string;
  hadEdits: boolean;
  at: number;
  source: "brain" | "llm";
  /** LLM turns only: this run's plan was stored for instant replay. */
  cached?: boolean;
}
import { FAST_LANE_RULE_ID, looksTransactional, routePromptFast } from "../../ai/brain/fast";
import { LLM_STATIC_TOKENS_PER_CALL, recordRoute, type BrainRoute } from "../../ai/brain/ledger";
import { recordRuleConfirmed, recordRuleFired, recordRuleRejected } from "../../ai/brain/feedback";
import { loadMemory, loadFacts, rememberFacts, rememberPreferences, hydrateFromServer } from "../../ai/memory";
import { selectMemorySlice } from "../../ai/memory-retriever";
import { extractFacts } from "../../ai/memory-extractor";
import type {
  AiPlan,
  ConversationTurn,
  LastActionContext,
  PermissionMode,
  PlanStep,
  PlanStreamEvent,
  PlannerContext,
  StepProgress
} from "../../ai/types";
import { AgentTranscript, ApprovalBar } from "./AgentTranscript";
import { PermissionModeSelector } from "./PermissionModeSelector";
import { AiInsightsDashboard } from "./AiInsightsDashboard";
import { AiThinkingLog } from "./AiThinkingLog";
import { ByoKeyPanel } from "./ByoKeyPanel";
import { OllamaPanel } from "./OllamaPanel";
import { MemoryPanel } from "./MemoryPanel";

export interface AiChatPanelProps {
  /** Fresh editor context (composition/selection/playhead). Called at plan + execute time. */
  getContext: () => PlannerContext;
  /** Commit one applied step to the editor (goes through the normal undo path). */
  commitComposition: (after: PlannerContext["composition"], summary: string) => Promise<void> | void;
  /** Optional: open an existing tool window for a `tool` step. */
  openTool?: (step: PlanStep) => Promise<ToolStepResult>;
  /** Optional: undo ONE committed editor change. The panel calls it once per step the last plan applied. */
  onUndo?: () => Promise<void> | void;
  /** Closes the whole AI dock (rendered as the ✕ in the panel header). */
  onClose?: () => void;
  /** Open the Generate Studio (optionally pre-filled) — used by the composer button and video handoff. */
  onOpenGenerate?: (prefill?: GenerateStudioPrefill) => void;
  /** Place a freshly generated asset onto the timeline (image skill steps land inline). */
  onAddAssetToTimeline?: (asset: SourceAsset) => void;
  /** P11 — the current project, so memory facts can be project-scoped + synced. */
  projectId?: string | undefined;
  /** Monotonic token bumped by the host's "/" shortcut to (re)focus the composer input. */
  focusToken?: number | undefined;
  /** Monotonic token bumped by the host's Alt+M shortcut to toggle voice dictation. */
  micToggleToken?: number | undefined;
  /** Host's Alt+L toggle COMMAND (monotonic token — micToggleToken pattern). One-way by
   * design: the panel OWNS the session and reports real state up via `onVoiceSessionChange`;
   * a two-way "desired" boolean ping-ponged with that report (infinite on/off loop). */
  voiceToggleToken?: number | undefined;
  /** Reports the REAL session state up (Esc / "stop listening" / Ear exits happen in here). */
  onVoiceSessionChange?: ((active: boolean) => void) | undefined;
  /** Reports the Ear (wake word) toggle up — the host keeps the dock mounted for standby. */
  onWakeWordChange?: ((on: boolean) => void) | undefined;
  /** Resolve a layer's assetId to a fetchable media URL — used by local analysis (beat detection). */
  resolveAssetUrl?: ((assetId: string) => string | undefined) | undefined;
  /** Editor command plane: executes tier-0 control commands ("pan mode", "pause") in the host. */
  runEditorCommand?: EditorCommandDispatcher | undefined;
}


/**
 * Downscale a chosen image to a compact JPEG data URL (≤1024px long edge) so the
 * reference stays well under the server's payload cap and uploads fast. Falls back
 * to the raw data URL if canvas isn't available.
 */
async function encodeReferenceImage(file: File): Promise<string> {
  const rawDataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("read failed"));
    reader.readAsDataURL(file);
  });
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("decode failed"));
      image.src = rawDataUrl;
    });
    const maxEdge = 1024;
    const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return rawDataUrl;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.82);
  } catch {
    return rawDataUrl;
  }
}

/** Clickable starter prompts shown on the empty chat (one tap → runs a plan). */
/** First-run wake-phrase onboarding flag: "offered" | "done" | "dismissed" (never re-offered). */
const WAKE_SETUP_KEY = "orreris.voice.wakesetup.v1";

const STARTER_PROMPTS = [
  "Add captions",
  "Make it cinematic",
  "Remove the background",
  "Add bold text saying SALE",
  "Track the subject and follow with text",
  "Add a fade in and fade out"
];

/**
 * The Orreris AI chat panel. Type → see a plan → Apply. AI never mutates the
 * timeline directly: every applied edit flows through the Timeline Action
 * Registry and the editor's existing undo. It is project- AND conversation-aware
 * (P5: follow-ups), respects remembered preferences (P6), runs under a permission
 * mode (P4: Quick auto-applies safe edits), and surfaces demand analytics (P7).
 */
// memo: EditorPage re-renders on every discrete edit; with identity-stable props (host wraps the
// callbacks in useStableHandlers), this keeps the whole panel out of those renders. The token props
// (focusToken/micToggleToken/voiceToggleToken) are deliberate change-signals and still get through.
export const AiChatPanel = memo(function AiChatPanel({ getContext, commitComposition, openTool, onUndo, onClose, onOpenGenerate, onAddAssetToTimeline, projectId, focusToken, micToggleToken, voiceToggleToken, onVoiceSessionChange, onWakeWordChange, resolveAssetUrl, runEditorCommand }: AiChatPanelProps) {
  const planner = useMemo(() => createPlanner(), []);
  const initialMemory = useMemo(() => loadMemory(), []);
  /** The agent work-log — the panel's single display truth (replaces chat bubbles/plan card/progress).
   * Restored per-project from localStorage so the conversation survives reloads; a debounced effect
   * below persists every change. Restored history also feeds the planner's follow-up context. */
  const [transcript, setTranscript] = useState<TranscriptItem[]>(() => loadTranscript(projectId ?? ""));

  // Persist the conversation per project (debounced — streaming patches arrive per token).
  useEffect(() => {
    const timer = setTimeout(() => saveTranscript(projectId ?? "", transcript), 400);
    return () => clearTimeout(timer);
  }, [transcript, projectId]);

  // If the panel survives a project switch (no remount), swap to that project's history.
  const transcriptProjectRef = useRef(projectId ?? "");
  useEffect(() => {
    if (transcriptProjectRef.current !== (projectId ?? "")) {
      transcriptProjectRef.current = projectId ?? "";
      setTranscript(loadTranscript(projectId ?? ""));
    }
  }, [projectId]);
  const [input, setInput] = useState("");
  const [plan, setPlan] = useState<AiPlan | null>(null);
  const [phase, setPhase] = useState<"idle" | "planning" | "review" | "executing">("idle");
  const [mode, setMode] = useState<PermissionMode>(initialMemory.permissionMode ?? "professional");
  const [showInsights, setShowInsights] = useState(false);
  const [showByoKey, setShowByoKey] = useState(false);
  // Header ⚙ dropdown — wake word, training, voice, key/memory/insights live here (the header
  // was piling up one icon per feature).
  const [showSettingsMenu, setShowSettingsMenu] = useState(false);
  const [naturalVoice, setNaturalVoiceState] = useState<AssistantVoiceChoice>(getNaturalVoice);
  const pickNaturalVoice = useCallback((id: AssistantVoiceChoice) => {
    setNaturalVoice(id);
    setNaturalVoiceState(id);
    // Instant audition — speakReply picks the best available engine (Kokoro when ready,
    // system voice otherwise), so tapping a voice ALWAYS answers audibly.
    void speakReply("Hi — this is my voice now.");
  }, []);
  const [showOllama, setShowOllama] = useState(false);
  const [showMemory, setShowMemory] = useState(false);
  /** Local (Ollama) config — null when not set up. `enabled` is the live "Local" toggle. */
  const [ollama, setOllama] = useState<OllamaConfig | null>(() => loadOllamaConfig());
  /** Cloud-fallback hint shown when Local is on but Ollama is unreachable (5s countdown + Cancel). */
  const [localFallback, setLocalFallback] = useState<{ countdown: number } | null>(null);
  const localFallbackResolveRef = useRef<((decision: "cloud" | "cancel") => void) | null>(null);
  /** GP4 — "Best Quality" routes through the shared paid Claude hop (when the server has a key). */
  const [bestQuality, setBestQuality] = useState(initialMemory.qualityMode === "best");
  /** True while the executor is paused awaiting a typed answer to a `clarify` step. */
  const [awaitingInput, setAwaitingInput] = useState(false);
  // Live mirrors for long-lived callbacks (the dictation interim handler fires between renders).
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const awaitingInputRef = useRef(awaitingInput);
  awaitingInputRef.current = awaitingInput;
  /** How many committed changes the last applied plan made — drives the in-panel "Undo" button. */
  const [undoableCommits, setUndoableCommits] = useState(0);
  const [undoing, setUndoing] = useState(false);
  /** GP2.1 live planning state, fed by the LLM stream. */
  const [think, setThink] = useState<{ phase: number; reasoning: string; provider?: string }>({ phase: 0, reasoning: "" });
  const lastActionRef = useRef<LastActionContext | undefined>(undefined);
  const pendingInputRef = useRef<((answer: string | null) => void) | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  /** A reference image (data URL) attached to the next prompt, for vision-capable models. */
  const [attachedImage, setAttachedImage] = useState<string | null>(null);
  /** Talk-mode runnable suggestions (clickable → switch to Professional and run). */
  const [suggestions, setSuggestions] = useState<string[]>([]);
  /** Talk mode is streaming a reply — the empty text row shows a dot-wave until the first token. */
  const [talking, setTalking] = useState(false);

  // ---- High-accuracy hearing (Moonshine local ASR) — opt-in via ⚙; same discipline as the
  // natural voice: worker isolation, VISIBLE download progress, honest failure reason, ↻ retry.
  // When ready, every dictation session is also recorded and re-transcribed locally; the local
  // text replaces Web Speech's final (declared before useDictation — its options read these).
  const [earsOn, setEarsOn] = useState(() => localEarsEnabled());
  const [earsInfo, setEarsInfo] = useState<LocalEarsProgress>(() => ({ status: localEarsStatus() }));
  useEffect(() => onLocalEarsProgress(setEarsInfo), []);
  useEffect(() => {
    if (earsOn) {
      warmLocalEars();
    }
  }, [earsOn]);
  const toggleEars = useCallback(() => {
    setEarsOn((current) => {
      const next = !current;
      setLocalEarsEnabled(next);
      return next;
    });
  }, []);
  const refineDictationFinal = useCallback(async (blob: Blob) => {
    const text = await transcribeBlobLocally(blob);
    return text ? normalizeTranscript(text) : null;
  }, []);

  // Hands-free session state — declared before the dictation hook because its options read it.
  const [voiceSession, setVoiceSession] = useState(false);
  const voiceSessionRef = useRef(false);
  voiceSessionRef.current = voiceSession;

  // ---- Voice dictation (mic) ----
  // The transcript is merged into the single `input` state so it stays fully editable and the
  // auto-grow effect keeps working. `dictationBaseRef` holds whatever was in the box when dictation
  // started; interim text is shown as `base + interim` live, and each finalized chunk is folded back
  // into the base. `lastDictationValueRef` is the last value we wrote programmatically, so a manual
  // keystroke (value ≠ ours) re-baselines instead of being clobbered by the next partial.
  const dictationBaseRef = useRef("");
  /** Composer content at SESSION start — onRefined replaces everything after it. */
  const dictationSessionBaseRef = useRef("");
  const lastDictationValueRef = useRef<string | null>(null);
  const inputStateRef = useRef(input);
  inputStateRef.current = input;
  /** One interim fast-accept per dictation session (reset in startDictation). */
  const interimFastFiredRef = useRef(false);
  /** The last interim the user READ before a final replaced it — the second engine
   * hypothesis `arbitrateFinal` weighs against the final ("neon" vs "new"). */
  const lastInterimRef = useRef("");
  const dictation = useDictation({
    // Hands-free timing, two-phase (real feedback: 1.6s "does not give me enough time to
    // talk"): ~7s of thinking time before the first word, then a 2.6s pause submits. Approvals
    // don't even wait that long — the interim fast-accept below fires instantly.
    silenceTimeoutMs: voiceSession ? 2600 : undefined,
    initialSilenceTimeoutMs: voiceSession ? 7000 : undefined,
    onInterim: (text) => {
      // Fast-accept: a lone "yes"/"no"-class INTERIM while the agent awaits an answer/approval
      // submits immediately — Web Speech often never finalizes single words (real report:
      // "saying yes sometimes doesn't pick it up until I say yes yes").
      const word = text.trim();
      if (
        voiceSessionRef.current &&
        !interimFastFiredRef.current &&
        (awaitingInputRef.current || phaseRef.current === "review") &&
        /^(?:yes|yeah|yep|yup|sure|ok(?:ay)?|no|nope|cancel|stop)[.!,]?$/i.test(word)
      ) {
        interimFastFiredRef.current = true;
        cancelDictationEngine(); // discard the session — the eventual final must not double-submit
        setInput("");
        handleSubmitVoiceRef.current(word.replace(/[.!,]$/, ""));
        return;
      }
      lastInterimRef.current = text;
      const base = dictationBaseRef.current;
      const next = base && text ? `${base} ${text}` : base + text;
      lastDictationValueRef.current = next;
      setInput(next);
    },
    onFinal: (rawText) => {
      // Registry-anchored arbitration first: the final only overrules the interim the user
      // was reading where the final's word resolves in our vocabularies too ("neon" survives
      // a "new" final). Then vocabulary biasing fixes editor-lexicon mishearings ("lip one"
      // → "clip 1") on the result, so the user sees the corrected command in the composer.
      const arbitrated = arbitrateFinal(lastInterimRef.current, rawText);
      lastInterimRef.current = "";
      const text = normalizeTranscript(arbitrated);
      const base = dictationBaseRef.current;
      const merged = base && text ? `${base} ${text}` : base + text;
      dictationBaseRef.current = merged;
      lastDictationValueRef.current = merged;
      setInput(merged);
    },
    // High-accuracy hearing: only wired while the local model is ON and ready, so the parallel
    // session recording never runs for nothing.
    refineFinal: earsOn && earsInfo.status === "ready" ? refineDictationFinal : undefined,
    onRefined: (text) => {
      // The local model heard the WHOLE utterance — its transcript replaces this session's Web
      // Speech finals (everything after the composer content captured at session start). The
      // same arbitration applies: the visible session text is a hypothesis the user already
      // read, and the refiner may not replace a registry-valid name with an invalid one.
      const base = dictationSessionBaseRef.current;
      const visible = inputStateRef.current.startsWith(base) ? inputStateRef.current.slice(base.length).trim() : "";
      const arbitrated = visible ? arbitrateFinal(visible, text) : text;
      const merged = base && arbitrated ? `${base} ${arbitrated}` : base + arbitrated;
      dictationBaseRef.current = merged;
      lastDictationValueRef.current = merged;
      setInput(merged);
    }
  });
  const { start: startDictationEngine, stop: stopDictationEngine, cancel: cancelDictationEngine, status: dictationStatus } = dictation;
  // "Talk now" earcon: blip the moment capture ACTUALLY starts in a voice session — the pill
  // and the sound now both mark the real window, so first words stop landing in dead air.
  const prevCapturingRef = useRef(false);
  useEffect(() => {
    const was = prevCapturingRef.current;
    prevCapturingRef.current = dictation.capturing;
    if (!was && dictation.capturing && voiceSessionRef.current) {
      playReadyBlip();
    }
  }, [dictation.capturing]);
  const dictationStatusRef = useRef(dictationStatus);
  dictationStatusRef.current = dictationStatus;

  const startDictation = useCallback(() => {
    dictationBaseRef.current = inputStateRef.current;
    dictationSessionBaseRef.current = inputStateRef.current;
    lastDictationValueRef.current = inputStateRef.current;
    interimFastFiredRef.current = false;
    lastInterimRef.current = "";
    startDictationEngine();
  }, [startDictationEngine]);

  const toggleDictation = useCallback(() => {
    if (dictationStatusRef.current === "listening") {
      stopDictationEngine();
    } else {
      startDictation();
    }
  }, [stopDictationEngine, startDictation]);
  const toggleDictationRef = useRef(toggleDictation);
  toggleDictationRef.current = toggleDictation;

  // ---- Voice session (hands-free) ----
  // The north star: edit without touching anything. Long-press the mic to enter; then dictation
  // auto-submits on silence, the mic re-arms after each agent turn, and questions/approvals accept
  // spoken answers ("yes" / "cancel"). Esc, or tapping the mic, exits.
  // (voiceSession state itself is declared ABOVE the dictation hook — its options read it.)
  const micPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const micLongPressFiredRef = useRef(false);

  // ---- TTS read-back ----
  // Replies are SPOKEN only inside a voice session; while speaking, the mic re-arm effect holds
  // off so the recognizer never transcribes our own voice. The hold is a COUNTER, not a boolean:
  // speakReply cancels whatever is already playing, so an overlapped speak's finally used to
  // clear the flag while the newer speech was still coming out of the speakers — the mic then
  // re-armed into our own voice and transcribed it as a command (the "move clip 1 to V3" ×3
  // self-echo loop). The flag may only drop when EVERY pending speak has settled.
  const [speaking, setSpeaking] = useState(false);
  const speakDepthRef = useRef(0);
  const speakIfVoice = useCallback((text: string) => {
    if (!voiceSessionRef.current) {
      return;
    }
    // Speaker and mic never run at once. If the mic is open (e.g. it re-armed for a clarify
    // answer before a late /ai/ack landed): an untouched session is cancelled so the recognizer
    // can't record this speech; but once the user has started talking, THEY win the channel —
    // drop the speak instead of talking over them.
    if (dictationStatusRef.current === "listening") {
      if (inputStateRef.current.trim() !== dictationSessionBaseRef.current.trim()) {
        return;
      }
      cancelDictationEngine();
    }
    speakDepthRef.current += 1;
    setSpeaking(true);
    void speakReply(text).finally(() => {
      speakDepthRef.current = Math.max(0, speakDepthRef.current - 1);
      setSpeaking(speakDepthRef.current > 0);
    });
  }, [cancelDictationEngine]);

  const exitVoiceSession = useCallback(() => {
    stopSpeaking();
    speakDepthRef.current = 0;
    setSpeaking(false);
    if (!voiceSessionRef.current) {
      return;
    }
    // Write the ref NOW (it is normally mirrored on render) — same-tick readers must see the exit.
    voiceSessionRef.current = false;
    setVoiceSession(false);
    cancelDictationEngine();
  }, [cancelDictationEngine]);

  /** Header toggle for hands-free voice mode (same session the mic long-press enters). */
  const toggleVoiceSession = useCallback(() => {
    if (voiceSessionRef.current) {
      exitVoiceSession();
    } else {
      voiceSessionRef.current = true;
      setVoiceSession(true);
      startDictation();
    }
  }, [exitVoiceSession, startDictation]);

  const handleMicPointerDown = useCallback(() => {
    micLongPressFiredRef.current = false;
    micPressTimerRef.current = setTimeout(() => {
      micPressTimerRef.current = null;
      micLongPressFiredRef.current = true;
      setVoiceSession(true);
      startDictation();
    }, 550);
  }, [startDictation]);

  const handleMicPointerUp = useCallback(() => {
    if (micPressTimerRef.current) {
      clearTimeout(micPressTimerRef.current);
      micPressTimerRef.current = null;
    }
  }, []);

  // Host Alt+M shortcut: toggle dictation whenever the token bumps (initial 0 ignored). Single-dep on
  // the token; the toggle is read through a ref so its identity changing never re-fires this.
  useEffect(() => {
    if (!micToggleToken) {
      return;
    }
    toggleDictationRef.current();
  }, [micToggleToken]);

  // Host Alt+L command ("Orreris, listen"): each token bump toggles the session ONCE. Pure
  // command — no state convergence, so the report-back mirror below can never ping-pong with
  // it (the old two-way `voiceDesired` boolean oscillated on/off forever: the panel and the
  // host ran half a render out of phase, each "correcting" to the other's stale value). Works
  // on FIRST mount too: Alt+L with the panel closed mounts the dock hidden with token=1 while
  // `handledVoiceTokenRef` starts at 0, so the mount processes the pending toggle.
  const toggleVoiceSessionRef = useRef<() => void>(() => {});
  toggleVoiceSessionRef.current = toggleVoiceSession;
  const handledVoiceTokenRef = useRef(0);
  useEffect(() => {
    if (!voiceToggleToken || voiceToggleToken === handledVoiceTokenRef.current) {
      return;
    }
    handledVoiceTokenRef.current = voiceToggleToken;
    toggleVoiceSessionRef.current();
  }, [voiceToggleToken]);

  // Mirror the REAL session state up (Esc, spoken "stop listening", Ear/mic exits all land here).
  // The initial mount value is deliberately NOT reported: when Alt+L hidden-mounts the dock,
  // reporting the pre-session `false` would flip the host's `aiVoiceWanted` off and unmount us
  // before the session ever started (the "Alt+L only works with the panel open" bug).
  const onVoiceSessionChangeRef = useRef(onVoiceSessionChange);
  onVoiceSessionChangeRef.current = onVoiceSessionChange;
  const reportedVoiceOnceRef = useRef(false);
  useEffect(() => {
    if (!reportedVoiceOnceRef.current) {
      reportedVoiceOnceRef.current = true;
      if (!voiceSession) {
        return;
      }
    }
    onVoiceSessionChangeRef.current?.(voiceSession);
  }, [voiceSession]);

  // ---- "Hey Orreris" wake word (opt-in, persisted) ----
  // A standby Web Speech recognizer runs whenever the mic is otherwise free; hearing the wake
  // word enters the voice session (aurora + hands-free loop). Deliberately opt-in: standby
  // keeps the browser mic indicator on the tab the whole time.
  const [wakeWordOn, setWakeWordOn] = useState(loadWakeWordEnabled);
  const toggleWakeWord = useCallback(() => {
    setWakeWordOn((value) => {
      const next = !value;
      saveWakeWordEnabled(next);
      return next;
    });
  }, []);
  // Report the Ear state up so EditorPage keeps the dock mounted for standby with the chat closed.
  const onWakeWordChangeRef = useRef(onWakeWordChange);
  onWakeWordChangeRef.current = onWakeWordChange;
  useEffect(() => {
    onWakeWordChangeRef.current?.(wakeWordOn);
  }, [wakeWordOn]);

  const startDictationRef = useRef(startDictation);
  startDictationRef.current = startDictation;
  /** Late-bound submit for the wake handler's carry-through ("hey orreris, blur clip 2") —
   * handleSubmit is declared much later; same pattern as handleUndoRef. */
  const handleSubmitVoiceRef = useRef<(prompt: string) => void>(() => {});
  /** At most ONE pending "were you calling me?" card at a time. */
  const pendingWakeTrainRef = useRef<string | null>(null);
  /** Live first-run wake-phrase training: while set, standby finals are captured as SAMPLES
   * (learned verbatim) instead of being matched — the user teaches Orreris THEIR phrase. */
  const wakeSetupRef = useRef<{ itemId: string; samples: string[] } | null>(null);
  // Standby runs only while the mic is otherwise free — the dictation engine and the wake
  // recognizer must never contend for Web Speech.
  const wakeStandby = wakeWordOn && !voiceSession && dictationStatus === "idle" && phase === "idle" && !talking;
  useEffect(() => {
    if (!wakeStandby) {
      return;
    }
    const recognition = createSpeechRecognition();
    if (!recognition) {
      return;
    }
    let disposed = false;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = typeof navigator !== "undefined" ? navigator.language : "en-US";
    const wake = (command?: string) => {
      if (disposed) {
        return;
      }
      disposed = true;
      try {
        recognition.abort();
      } catch {
        // already stopped
      }
      // The ref mirror is normally written on render — set it NOW so speakIfVoice/handleSubmit
      // see the session before React re-renders.
      voiceSessionRef.current = true;
      setVoiceSession(true);
      if (command && command.length >= 2) {
        // Carry-through: "hey orreris, blur clip 2" executes in one breath. 150ms lets the
        // standby recognizer release the mic first.
        setTimeout(() => handleSubmitVoiceRef.current(normalizeTranscript(command)), 150);
      } else {
        // Bare wake: acknowledge out loud — varied (a fixed phrase reads as robotic; all
        // variants are pre-generated in the ack cache so they play instantly). The re-arm
        // effect starts the mic once speech ends.
        const acks = ["Yes?", "I'm listening.", "Go ahead."];
        speakIfVoice(acks[Math.floor(Math.random() * acks.length)]!);
      }
    };
    recognition.onresult = (event) => {
      // Finals only: carry-through needs the whole utterance, and interims flip-flop too much
      // to train from.
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (!result?.isFinal) {
          continue;
        }
        const text = result[0]?.transcript ?? "";
        // First-run training: capture what was ACTUALLY heard as the user's wake phrase.
        const setup = wakeSetupRef.current;
        if (setup) {
          const heard = text.toLowerCase().replace(/[.,!?]/g, "").trim();
          const tokenCount = heard ? heard.split(/\s+/).length : 0;
          if (tokenCount >= 1 && tokenCount <= 4) {
            learnWakePhrase(heard);
            setup.samples.push(heard);
            const finished = setup.samples.length >= 3;
            setTranscript((current) =>
              patchItem(current, setup.itemId, { samples: [...setup.samples], ...(finished ? { stage: "done" } : {}) })
            );
            if (finished) {
              wakeSetupRef.current = null;
              try {
                localStorage.setItem(WAKE_SETUP_KEY, "done");
              } catch {
                // best-effort
              }
            }
          }
          continue; // never wake mid-training
        }
        const match = matchWakeWord(text, loadWakePhrases());
        if (match.matched) {
          wake(match.command);
          return;
        }
        // Near-miss ("hello mia") → offer to LEARN it. This is how the wake word is trained:
        // the recognizer will never hear "orreris" the same way twice across voices/accents.
        if (looksLikeWakeAttempt(text) && !pendingWakeTrainRef.current) {
          pendingWakeTrainRef.current = pushItem({
            kind: "wakeTrain",
            heard: text.toLowerCase().replace(/[.,!?]/g, "").trim()
          });
        }
      }
    };
    recognition.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        // Permission revoked — turn the feature off instead of error-looping the mic.
        disposed = true;
        setWakeWordOn(false);
        saveWakeWordEnabled(false);
      }
    };
    recognition.onend = () => {
      // Chrome ends continuous sessions on its own (~60s / silence) — restart transparently.
      if (!disposed) {
        try {
          recognition.start();
        } catch {
          // re-armed by the next wakeStandby flip
        }
      }
    };
    try {
      recognition.start();
    } catch {
      return;
    }
    return () => {
      disposed = true;
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      try {
        recognition.abort();
      } catch {
        // already stopped
      }
    };
  }, [wakeStandby]);

  // First-run onboarding: once per browser, invite the user to teach THEIR wake phrase.
  useEffect(() => {
    try {
      if (typeof localStorage === "undefined" || localStorage.getItem(WAKE_SETUP_KEY)) {
        return;
      }
      localStorage.setItem(WAKE_SETUP_KEY, "offered");
    } catch {
      return;
    }
    pushItem({ kind: "wakeSetup", stage: "offer", samples: [] });
    // pushItem is stable but declared below — run-once on mount is the real semantic.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Arming the Ear with NOTHING learned yet auto-starts training (visible card) — an untrained
  // ear is what made "hey orreris" fall on deaf ears. Only on a user-initiated off→on transition,
  // never silently on mount.
  const prevWakeWordOnRef = useRef(wakeWordOn);
  useEffect(() => {
    const was = prevWakeWordOnRef.current;
    prevWakeWordOnRef.current = wakeWordOn;
    if (was || !wakeWordOn || wakeSetupRef.current) {
      return;
    }
    try {
      if (localStorage.getItem(WAKE_SETUP_KEY) === "done") {
        return;
      }
    } catch {
      // fall through — worst case we offer training again
    }
    if (loadWakePhrases().length > 0) {
      return;
    }
    const id = pushItem({ kind: "wakeSetup", stage: "listening", samples: [] });
    wakeSetupRef.current = { itemId: id, samples: [] };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wakeWordOn]);

  /** Settings-menu entry: (re)train the wake phrase any time — arms the Ear + a listening card. */
  const startWakeTraining = useCallback(() => {
    if (wakeSetupRef.current) {
      return; // one live training at a time
    }
    setWakeWordOn(true);
    saveWakeWordEnabled(true);
    const id = pushItem({ kind: "wakeSetup", stage: "listening", samples: [] });
    wakeSetupRef.current = { itemId: id, samples: [] };
    // pushItem is stable but declared below this line — listing it in deps would TDZ at render.
  }, []);

  /** Resolve the setup card: start listening for samples, or stop/dismiss. */
  const resolveWakeSetup = useCallback((id: string, start: boolean) => {
    if (start) {
      setWakeWordOn(true);
      saveWakeWordEnabled(true);
      wakeSetupRef.current = { itemId: id, samples: [] };
      setTranscript((current) => patchItem(current, id, { stage: "listening" }));
      return;
    }
    const samples = wakeSetupRef.current?.samples ?? [];
    wakeSetupRef.current = null;
    setTranscript((current) => patchItem(current, id, { stage: samples.length > 0 ? "done" : "dismissed" }));
    try {
      localStorage.setItem(WAKE_SETUP_KEY, samples.length > 0 ? "done" : "dismissed");
    } catch {
      // best-effort
    }
  }, []);

  // ---- Natural voice (Kokoro) warmup — with VISIBLE progress (user requirement: no magic).
  // Warms as soon as voice is in play (session live or wake word armed); one transcript row
  // shows the download percentage live, then flips to "ready" / an honest failure line.
  const naturalVoiceNoticeRef = useRef<string | null>(null);
  // Mirrored into state so the AURORA PILL can show the download too — with the chat panel
  // hidden (Alt+L voice-only mode) the transcript notice alone would be invisible.
  // Short live label ("43%" or "12 MB" when the CDN hides the total) — null when not downloading.
  const [naturalVoiceDownload, setNaturalVoiceDownload] = useState<string | null>(null);
  // Always-on mirror of the engine state for the ⚙ menu (status + failure reason + ↻ retry).
  const [naturalVoiceInfo, setNaturalVoiceInfo] = useState<NaturalVoiceProgress>(() => ({ status: naturalVoiceStatus() }));
  useEffect(() => onNaturalVoiceProgress(setNaturalVoiceInfo), []);
  useEffect(() => {
    if (!voiceSession && !wakeWordOn) {
      return;
    }
    warmNaturalVoice();
    return onNaturalVoiceProgress((progress) => {
      setNaturalVoiceDownload(
        progress.status === "downloading"
          ? progress.percent !== undefined
            ? `${progress.percent}%`
            : `${progress.loadedMb ?? 0} MB`
          : null
      );
      if (progress.status === "downloading") {
        // No percent when the CDN omits content-length — live MB is still honest progress.
        const amount =
          progress.percent !== undefined
            ? `${progress.percent}%${progress.totalMb ? ` (${progress.loadedMb ?? 0}/${progress.totalMb} MB)` : ""}`
            : `${progress.loadedMb ?? 0} MB so far`;
        const text = `🎙 Downloading the natural voice (Kokoro, one-time)… ${amount}`;
        if (naturalVoiceNoticeRef.current) {
          setTranscript((current) => patchItem(current, naturalVoiceNoticeRef.current!, { text }));
        } else {
          naturalVoiceNoticeRef.current = pushItem({ kind: "notice", tone: "info", text });
        }
      } else if (progress.status === "ready" && naturalVoiceNoticeRef.current) {
        setTranscript((current) => patchItem(current, naturalVoiceNoticeRef.current!, { text: "🎙 Natural voice ready — I'll speak with it from now on." }));
      } else if (progress.status === "unavailable" && naturalVoiceNoticeRef.current) {
        setTranscript((current) =>
          patchItem(current, naturalVoiceNoticeRef.current!, {
            text: `🎙 Natural-voice download interrupted${progress.reason ? ` (${progress.reason})` : ""} — using the system voice for now; I'll retry automatically (finished parts are cached).`
          })
        );
      }
    });
    // pushItem/setTranscript are stable but declared below — deps stay on the real triggers.
  }, [voiceSession, wakeWordOn]);

  // P11 — pull the user's memory profile (creator + this project) into the local
  // cache once, so the very first prompt already respects learned preferences.
  useEffect(() => {
    void hydrateFromServer(projectId);
  }, [projectId]);

  // Local (Ollama) rejected the browser with 403 (CORS) → tell the USER, once, with the fix —
  // otherwise Local mode silently detours to the cloud and just looks broken.
  const ollamaCorsNoticeShownRef = useRef(false);
  useEffect(
    () =>
      onOllamaCorsBlocked(() => {
        if (ollamaCorsNoticeShownRef.current) {
          return;
        }
        ollamaCorsNoticeShownRef.current = true;
        pushItem({
          kind: "notice",
          tone: "warn",
          text: `⚠ Your local model (Ollama) refused the browser connection (CORS) — I'm answering from the cloud instead. To fix: set OLLAMA_ORIGINS to "*" (or ${typeof location !== "undefined" ? location.origin : "this site's address"}) and restart Ollama.`
        });
      }),
    // pushItem is declared below (TDZ) — referenced via closure only, like the voice effects.
    []
  );

  /** Append any transcript item; returns its id (for later patches). */
  const pushItem = useCallback((item: TranscriptItemInput) => {
    const id = item.id ?? transcriptId();
    setTranscript((current) => appendItem(current, { ...item, id } as TranscriptItem));
    return id;
  }, []);

  /** Back-compat message helper: user → prompt chip, ai → markdown text row. */
  const pushMessage = useCallback(
    (role: "user" | "ai", text: string) =>
      pushItem(role === "user" ? { kind: "user", text } : { kind: "text", markdown: text }),
    [pushItem]
  );

  const updateMessage = useCallback((id: string, text: string) => {
    setTranscript((current) => patchItem(current, id, { markdown: text }));
  }, []);

  /** Resolve a "were you calling me?" card: learn the mishearing (and wake) or dismiss it. */
  const resolveWakeTrain = useCallback(
    (id: string, heard: string, learn: boolean) => {
      setTranscript((current) => patchItem(current, id, { resolved: learn ? "learned" : "dismissed" }));
      pendingWakeTrainRef.current = null;
      if (learn) {
        learnWakePhrase(heard);
        voiceSessionRef.current = true;
        setVoiceSession(true);
        speakIfVoice("Yes? I'll answer to that from now on.");
      }
    },
    [speakIfVoice]
  );

  // Auto-grow the composer so wrapped lines stay visible (height capped by CSS max-height).
  useEffect(() => {
    const el = inputRef.current;
    if (!el) {
      return;
    }
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  // Host "/" shortcut: focus (and select) the composer whenever the token bumps. The initial 0 is
  // ignored so opening the panel by other means doesn't steal focus; the panel mounts on open, so
  // this effect runs after the textarea exists.
  useEffect(() => {
    if (!focusToken) {
      return;
    }
    const el = inputRef.current;
    if (!el) {
      return;
    }
    el.focus();
    el.select();
  }, [focusToken]);

  // Keep the latest message/plan/thinking in view — the user shouldn't have to scroll down each time.
  useEffect(() => {
    const el = logRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [transcript, phase, plan, think]);

  /**
   * The executor pauses on a `clarify` step and calls this — we surface the
   * question in chat and resolve with the user's next typed message (ask → confirm
   * → reask → reconfirm). Returns null if the panel is torn down.
   */
  const pendingQuestionIdRef = useRef<string | null>(null);
  const askClarify = useCallback(
    (question: string) => {
      pendingQuestionIdRef.current = pushItem({ kind: "question", text: question });
      setAwaitingInput(true);
      // Hands-free: the question is spoken, and the re-arm effect opens the mic for the answer.
      speakIfVoice(question);
      return new Promise<string | null>((resolve) => {
        pendingInputRef.current = resolve;
      });
    },
    [pushItem, speakIfVoice]
  );

  /**
   * Augment the editor's base context with conversation history + memory + last
   * action (P5/P6), gated by the P10 intent-continuity classifier: a NEW request
   * does not thread the previous edit's target, so it can't be silently edited.
   */
  const buildContext = useCallback(
    (prompt: string): { context: PlannerContext; continuity: ContinuityResult } => {
      const base = getContext();
      // Clip references ("clip 4", "the 2nd clip") resolve to a layer BEFORE planning and become the
      // effective selection for this turn, so every planner (deterministic OR LLM) targets that clip.
      // This is what makes "change clip 2 to hello" work without the user clicking the clip first.
      const reference = parseClipReference(prompt);
      const resolvedRef = reference
        ? resolveTargetLayer(base.composition, { selection: base.selection, nowSeconds: base.nowSeconds, reference })
        : undefined;
      const effectiveSelection = resolvedRef?.layerId ? [resolvedRef.layerId] : base.selection;
      // Conversation history for the planner: user prompts + AI prose/questions/summaries. Work rows
      // (steps/thoughts/notices) are display-only and never round-trip — token economy.
      const history: ConversationTurn[] = transcript.flatMap((item): ConversationTurn[] => {
        if (item.kind === "user") return [{ role: "user", text: item.text }];
        if (item.kind === "text" && item.markdown) return [{ role: "ai", text: item.markdown }];
        if (item.kind === "question") return [{ role: "ai", text: item.text }];
        // Explicit "it's done" — a bare "Applied 1 step(s)" left weak models deliberating for
        // 30s+ over whether a repeated-looking request still needed doing (real transcript).
        if (item.kind === "summary") return [{ role: "ai", text: `Applied ${item.applied} step(s) — the requested edit is complete.` }];
        return [];
      });
      const continuity = classifyContinuity(prompt, {
        hasLastAction: Boolean(lastActionRef.current),
        hasSelection: effectiveSelection.length > 0
      });
      // P11 — a small, high-confidence slice of learned memory (creator + project).
      const slice = selectMemorySlice(loadFacts(), { projectId });
      const context: PlannerContext = {
        ...base,
        selection: effectiveSelection,
        history,
        lastAction: continuity.scope === "continue" ? lastActionRef.current : undefined,
        intentScope: continuity.scope,
        memory: slice.preferences,
        ...(slice.note ? { memoryNote: slice.note } : {}),
        ...(attachedImage ? { referenceImages: [attachedImage] } : {}),
        // Voice session → the prompts switch to the spoken-conversation register (short,
        // varied, no lists — replies are read aloud).
        ...(voiceSessionRef.current ? { voiceMode: true } : {})
      };
      return { context, continuity };
    },
    [getContext, transcript, projectId, attachedImage]
  );

  /**
   * Execute a Skill step from a plan. Video generation hands off to the Generate Studio
   * (iterative + async — a new tab would lose editor state); image generation runs inline
   * and lands the asset on the timeline.
   */
  const runSkillStep = useCallback<(step: PlanStep) => Promise<ToolStepResult>>(
    async (step) => {
      const skill = step.skillId ? getSkill(step.skillId) : undefined;
      const task = skill && step.taskKind ? getSkillTaskKind(skill, step.taskKind) : undefined;
      if (!skill || !task) {
        return { applied: false, detail: "Unknown skill" };
      }
      const params = (step.params ?? {}) as Record<string, unknown>;

      // Color grade — compiled locally into an editable effect stack (no model, no cloud, no tokens).
      if (task.execution === "grade") {
        const ctx = getContext();
        const target = resolveTargetLayer(ctx.composition, { selection: ctx.selection, nowSeconds: ctx.nowSeconds });
        if (!target.layerId) {
          return { applied: false, detail: "Which clip? Select a clip or move the playhead over one, then retry." };
        }
        // Orreris OS K3: the grade goes through the Blueprint color dialect's capability
        // closure — unknown/misspelled looks become honest compile errors with the look
        // library as suggestions (or get repaired via the alias table: "moody" → Noir),
        // and an all-neutral grade can no longer reach execution as a silent "Applied 0".
        const closure = closeColorGrade(params);
        if (!closure.ok) {
          const detail = closure.issues
            .map((issue) => `${issue.message}${issue.suggestions?.length ? ` Available looks: ${issue.suggestions.join(", ")}.` : ""}`)
            .join(" ");
          return { applied: false, detail };
        }
        const { actions, repairs } = closure.closed;
        let composition = ctx.composition;
        for (const action of actions) {
          const outcome = timelineActionRegistry.execute(
            action.actionId,
            { layerId: target.layerId, ...(action.params as Record<string, unknown>) },
            { composition, selection: ctx.selection, nowSeconds: ctx.nowSeconds },
            { ai: true }
          );
          if (!outcome.ok) {
            return { applied: false, detail: outcome.message };
          }
          composition = outcome.result.after;
        }
        await commitComposition(composition, `Color grade (${actions.length} effect${actions.length > 1 ? "s" : ""})`);
        return {
          applied: true,
          composition,
          detail: `Applied a ${actions.length}-effect grade${repairs.length > 0 ? ` (${repairs.join("; ")})` : ""}`
        };
      }

      // Local media analysis (beat detection) — real DSP in the browser, optionally applying
      // markers/cuts in the same step via the registry (one commit, one undo entry).
      if (task.execution === "analysis") {
        const ctx = getContext();
        const explicit = typeof params.layerId === "string" ? params.layerId : undefined;
        const target = resolveTargetLayer(ctx.composition, {
          selection: ctx.selection,
          nowSeconds: ctx.nowSeconds,
          ...(explicit ? { explicitLayerId: explicit } : {})
        });
        const layer = target.layerId
          ? ctx.composition.tracks.flatMap((track) => track.layers).find((item) => item.id === target.layerId)
          : undefined;
        if (!layer) {
          return { applied: false, detail: "Which clip? Select a clip or name it (e.g. clip 2), then retry." };
        }
        if (!layer.assetId) {
          return { applied: false, detail: "That clip has no media/audio to analyze." };
        }
        const url = resolveAssetUrl?.(layer.assetId);
        if (!url) {
          return { applied: false, detail: "Couldn't resolve that clip's media URL." };
        }
        const { detectBeatsFromUrl } = await import("../../tools/beat-detection");
        const result = await detectBeatsFromUrl(url);
        // Source-time onsets → timeline times inside this clip (1x speed approximation).
        const sourceIn = layer.sourceInSeconds ?? 0;
        const times = result.beats
          .filter((beat) => beat >= sourceIn && beat <= sourceIn + layer.durationSeconds)
          .map((beat) => layer.startSeconds + (beat - sourceIn));
        if (times.length === 0) {
          return { applied: false, detail: "No clear beats detected in that clip's audio." };
        }
        const apply = typeof params.apply === "string" ? params.apply : "report";
        let composition = ctx.composition;
        let applied: string[] = [];
        if (apply === "markers" || apply === "both") {
          const outcome = timelineActionRegistry.execute(
            "addMarkersAtTimes",
            { times, namePrefix: "beat" },
            { composition, selection: ctx.selection, nowSeconds: ctx.nowSeconds },
            { ai: true }
          );
          if (outcome.ok) {
            composition = outcome.result.after;
            applied = [...applied, outcome.result.summary];
          }
        }
        if (apply === "cuts" || apply === "both") {
          const outcome = timelineActionRegistry.execute(
            "splitClipAtTimes",
            { layerId: layer.id, times },
            { composition, selection: ctx.selection, nowSeconds: ctx.nowSeconds },
            { ai: true }
          );
          if (outcome.ok) {
            composition = outcome.result.after;
            applied = [...applied, outcome.result.summary];
          }
        }
        if (composition !== ctx.composition) {
          await commitComposition(composition, `Beat sync (${applied.join(" + ")})`);
        }
        const bpmLabel = result.bpm ? ` @ ~${result.bpm} BPM` : "";
        const timesLabel =
          apply === "report" ? `; times(s): ${times.slice(0, 60).map((time) => time.toFixed(2)).join(",")}` : "";
        return {
          applied: true,
          ...(composition !== ctx.composition ? { composition } : {}),
          detail: `${times.length} beats${bpmLabel}${applied.length ? ` — ${applied.join("; ")}` : ""}${timesLabel}`
        };
      }

      if (task.modality === "video") {
        if (!onOpenGenerate) {
          return { applied: false, detail: "Open the Generate Studio to create video" };
        }
        onOpenGenerate({
          taskKind: task.id,
          prompt: typeof params.prompt === "string" ? params.prompt : undefined,
          aspectRatio: typeof params.aspectRatio === "string" ? params.aspectRatio : undefined,
          durationSeconds: typeof params.durationSeconds === "number" ? params.durationSeconds : undefined,
          referenceImage: typeof params.referenceImage === "string" ? params.referenceImage : undefined
        });
        return { applied: true, detail: "Opened the Generate Studio to finish your clip" };
      }

      try {
        const outcome = await runGeneration({
          skillId: skill.id,
          taskKind: task.id,
          params,
          ...(projectId ? { projectId } : {})
        });
        onAddAssetToTimeline?.(outcome.asset);
        return { applied: true, detail: `Generated with ${outcome.modelId}` };
      } catch (error) {
        return { applied: false, detail: error instanceof Error ? error.message : "Generation failed" };
      }
    },
    [onOpenGenerate, onAddAssetToTimeline, projectId, getContext, commitComposition, resolveAssetUrl]
  );

  /** Run-scoped accumulators (one agent run = possibly several batches). */
  const runCommitsRef = useRef(0);
  const runTargetsRef = useRef<string[]>([]);
  const runCancelledRef = useRef(false);

  /**
   * Execute ONE validated plan batch through the real executor. Appends a transcript row per step
   * and live-patches it from the executor's REAL progress signals (status + registry detail +
   * duration). Returns compact one-line outcomes for the agent loop's action log.
   */
  const executeBatch = useCallback(
    async (activePlan: AiPlan) => {
      setPhase("executing");
      // The user accepted an approximate/partial plan — record it as demand (spec #7).
      if (activePlan.confidence === "Approximation" || activePlan.notes.length > 0) {
        logUnsupported({
          prompt: activePlan.prompt,
          missingCapability: activePlan.notes[0] ?? "approximation",
          acceptedApproximation: true
        });
      }
      const countingCommit: AiChatPanelProps["commitComposition"] = async (after, summary) => {
        runCommitsRef.current += 1;
        await commitComposition(after, summary);
      };
      const rowIdByStep = new Map<string, string>();
      const startedAt = new Map<string, number>();
      const lastUpdate = new Map<string, StepProgress>();
      setTranscript((current) => {
        let next = current;
        for (const step of activePlan.steps) {
          const rowId = `step_${step.id}`;
          rowIdByStep.set(step.id, rowId);
          if (!next.some((item) => item.id === rowId)) {
            next = appendItem(next, { kind: "step", id: rowId, label: step.summary, status: "pending" });
          }
        }
        return next;
      });
      const report = await executePlan(activePlan, {
        getContext,
        commitComposition: countingCommit,
        askClarify,
        ...(openTool ? { openTool } : {}),
        runSkillStep,
        onProgress: (update) => {
          lastUpdate.set(update.stepId, update);
          const rowId = rowIdByStep.get(update.stepId) ?? `step_${update.stepId}`;
          if (update.status === "running") {
            startedAt.set(update.stepId, performance.now());
          }
          const begun = startedAt.get(update.stepId);
          const seconds =
            update.status !== "running" && update.status !== "pending" && begun !== undefined
              ? (performance.now() - begun) / 1000
              : undefined;
          setTranscript((current) =>
            patchItem(current, rowId, {
              status: update.status,
              ...(update.detail ? { detail: update.detail } : {}),
              ...(seconds !== undefined ? { seconds } : {})
            })
          );
        }
      });
      runTargetsRef.current = [...new Set([...runTargetsRef.current, ...report.targetLayerIds])];
      // Compact one-line real outcomes for the loop's action log (token economy: one line per step).
      const lines = activePlan.steps.map((step) => {
        const update = lastUpdate.get(step.id);
        const status = update?.status ?? "skipped";
        const tag = status === "done" ? "ok" : status.toUpperCase();
        // 600-char cap: enough for an analysis report line (e.g. beat times) without letting one
        // step flood the loop's action log.
        return `${step.summary} → ${tag}${update?.detail ? `: ${update.detail.slice(0, 600)}` : ""}`;
      });
      return { lines, applied: report.applied, failed: report.failed, skipped: report.skipped };
    },
    [askClarify, commitComposition, getContext, openTool, runSkillStep]
  );

  /**
   * Professional mode approval — resolves once the user decides on the slim approval bar. The
   * pending plan renders as ephemeral step rows + the bar (review phase); Apply resolves with the
   * (possibly per-step-filtered) plan, Cancel/Modify with null. Approve-once-per-run: the agent
   * loop asks only before its FIRST mutating batch, then free-runs.
   */
  const approvalResolveRef = useRef<((approved: AiPlan | null) => void) | null>(null);
  /** Late-bound apply/cancel (declared below handleSubmit) so voice/typed approvals can trigger them. */
  const handleApplyRef = useRef<() => void>(() => {});
  const handleCancelRef = useRef<() => void>(() => {});
  /** Late-bound undo so the brain's tier-0 "undo" command can trigger the existing revert. */
  const handleUndoRef = useRef<() => void>(() => {});
  /**
   * The last brain-resolved turn, for the 👍/👎 feedback row (B2/B6): 👍 confirms the rule,
   * 👎 undoes its edits and re-runs the SAME prompt through the model (skipBrainRef) — and a
   * rule the user keeps rejecting loses trust and stops fast-pathing (feedback.ts).
   */
  const [brainTurn, setBrainTurn] = useState<FeedbackTurn | null>(null);
  // Ref mirror for the implicit B6 signals (undo/next-prompt) — those handlers need the turn
  // SYNCHRONOUSLY (before React re-renders) and must be able to consume it exactly once.
  const brainTurnRef = useRef<FeedbackTurn | null>(null);
  const commitBrainTurn = useCallback((turn: FeedbackTurn | null) => {
    brainTurnRef.current = turn;
    setBrainTurn(turn);
  }, []);
  /** One-shot: the next submit bypasses the brain (set by the 👎 handler). */
  const skipBrainRef = useRef(false);
  const requestApproval = useCallback((pendingPlan: AiPlan) => {
    setPlan(pendingPlan);
    setPhase("review");
    // Hands-free approval: say the ask; the re-arm effect opens the mic for "yes"/"no".
    speakIfVoice(`${pendingPlan.steps.length} step${pendingPlan.steps.length === 1 ? "" : "s"} ready. Say yes to apply, or no to cancel.`);
    return new Promise<AiPlan | null>((resolve) => {
      approvalResolveRef.current = resolve;
    });
  }, [speakIfVoice]);

  const localActive = Boolean(ollama?.enabled && ollama.model);

  // Local button: open the setup panel if unconfigured; otherwise flip the live toggle. Turning Local
  // on turns Pro off (they are alternative routes).
  const handleLocalToggle = useCallback(() => {
    const config = loadOllamaConfig();
    if (!config) {
      setShowOllama(true);
      return;
    }
    const next: OllamaConfig = { ...config, enabled: !config.enabled };
    saveOllamaConfig(next);
    setOllama(next);
    if (next.enabled) {
      setBestQuality(false);
    }
  }, []);

  // Decide this run's route. In Local mode we pre-flight ping Ollama: reachable yields "local";
  // unreachable shows a 5s "using cloud" hint with Cancel ("cloud" on timeout, "cancel" aborts).
  const resolveRoute = useCallback(async (): Promise<"local" | "cloud" | "cancel"> => {
    if (!localActive || !ollama) {
      return "cloud";
    }
    if (await pingOllama(ollama.baseUrl)) {
      return "local";
    }
    return new Promise<"local" | "cloud" | "cancel">((resolve) => {
      let remaining = 5;
      setLocalFallback({ countdown: remaining });
      const timer = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) {
          clearInterval(timer);
          setLocalFallback(null);
          localFallbackResolveRef.current = null;
          resolve("cloud");
        } else {
          setLocalFallback({ countdown: remaining });
        }
      }, 1000);
      localFallbackResolveRef.current = (decision) => {
        clearInterval(timer);
        setLocalFallback(null);
        localFallbackResolveRef.current = null;
        resolve(decision);
      };
    });
  }, [localActive, ollama]);

  const handleSubmit = useCallback(async (promptOverride?: string) => {
    const prompt = (promptOverride ?? input).trim();
    if (!prompt) {
      return;
    }

    // Spoken exit: in a voice session "stop listening"/"exit voice mode" ends the session
    // instead of being planned as an edit.
    if (voiceSessionRef.current && /^(?:stop listening|exit voice(?: mode)?|voice (?:mode )?off|stop voice mode)[.!]?$/i.test(prompt)) {
      setInput("");
      exitVoiceSession();
      pushMessage("ai", "🎙 Voice mode off.");
      return;
    }

    // Voice-answerable approval: while the slim approval bar is pending, a spoken/typed "yes/apply"
    // approves and "no/cancel" rejects — no click needed (hands-free E3). Anything else falls
    // through and is treated as a normal message once the run settles.
    if (approvalResolveRef.current) {
      const normalized = prompt.toLowerCase();
      if (/^(yes|yeah|yep|apply|approve|confirm|go ahead|do it|ok(ay)?)\b/.test(normalized)) {
        setInput("");
        handleApplyRef.current();
        return;
      }
      if (/^(no|nope|cancel|stop|don'?t|reject)\b/.test(normalized)) {
        setInput("");
        handleCancelRef.current();
        return;
      }
    }

    // Additive: if dictation is running, tear it down before the send clears the input, so a late
    // partial can't re-append text after `setInput("")`. `prompt` was already captured above, so this
    // does not change what gets sent. No-op when idle → existing behavior is untouched.
    cancelDictationEngine();

    // If the executor is paused on a clarify step, this message is the answer —
    // resume rather than starting a new plan (ask → confirm → reask → reconfirm).
    if (pendingInputRef.current) {
      const resolve = pendingInputRef.current;
      pendingInputRef.current = null;
      setAwaitingInput(false);
      setInput("");
      // Show the answer inline on the question row (Claude-Code style) instead of a user chip.
      if (pendingQuestionIdRef.current) {
        const questionId = pendingQuestionIdRef.current;
        pendingQuestionIdRef.current = null;
        setTranscript((current) => patchItem(current, questionId, { answered: prompt }));
      } else {
        pushMessage("user", prompt);
      }
      resolve(prompt);
      return;
    }

    // Already working on a turn — ignore the submit. (We guard here instead of disabling the textarea,
    // so the composer never loses focus mid-turn: a disabled element gets blurred by the browser.)
    if (phase === "planning" || phase === "executing" || talking) {
      return;
    }

    // ---- Orreris Brain (B1 reflex + B2 rules): exact commands + registry questions resolve locally,
    // BEFORE any model or network (see AI_ARCHITECTURE.md). Precision-first: the router escalates
    // silently on anything it isn't structurally certain about. Talk mode, image turns, and a
    // 👎 re-run (skipBrainRef) bypass the brain.
    const skipBrain = skipBrainRef.current;
    skipBrainRef.current = false;
    // B6 implicit confirm: moving on to a NEW prompt while a brain edit is still standing (not
    // undone, no explicit 👍/👎) counts as a weak success signal for that rule.
    if (brainTurnRef.current?.hadEdits && (brainTurnRef.current.source === "brain" || brainTurnRef.current.cached)) {
      recordRuleConfirmed(brainTurnRef.current.ruleId);
    }
    commitBrainTurn(null);
    // Tier-3 fast-lane bookkeeping: tokens spent on an ESCALATED fast attempt still count
    // toward the ledger record of whichever route ends up handling the prompt.
    let fastLaneSpentTokens = 0;
    if (mode !== "talk" && !attachedImage && !skipBrain) {
      const reflexStartedAt = performance.now();
      let routed: BrainRouteResult = routePrompt(prompt, getContext());
      if (routed.kind === "escalate") {
        // Tier 2 (B3): paraphrases + plan-cache replays. Still local + zero tokens; escalates
        // immediately while the embedding model is cold (the load continues in the background).
        routed = await routePromptSemantic(prompt, getContext());
      }
      if (routed.kind === "escalate") {
        // World Model (Orreris OS K1): "analyze clip 3"-class questions answered from MEASURED
        // facts (metadata / sampled-frame look / text coverage) — local, zero tokens, read-only.
        // Precision-first: non-matching prompts return escalate in ~0ms.
        routed = await routePromptWorld(prompt, getContext());
      }
      if (routed.kind === "escalate") {
        // Orreris OS K4: vibe asks ("make it moody") run the hypothesis planner — World
        // Model facts with budgets → mood recipe → multi-goal Blueprint closed atomically,
        // emitted as an ordinary plan. Near-tied readings return the economic clarify.
        routed = await routePromptHypothesis(prompt, getContext());
      }
      // Editor commands need the host dispatcher; without it (shouldn't happen in the editor)
      // the prompt takes the normal model path instead of silently doing nothing.
      if (routed.kind === "command" && !runEditorCommand) {
        routed = { kind: "escalate" };
      }
      let fastMeta: { provider?: string | undefined; estTokens: number } | null = null;
      if (routed.kind === "escalate" && looksTransactional(prompt)) {
        // Tier 3 (B4): edit-shaped prompt the local tiers couldn't parse → ONE fast-class
        // (non-reasoning) model call with a micro context, instead of a full loop run.
        setPhase("planning");
        const fast = await routePromptFast(prompt, getContext());
        setPhase("idle");
        fastLaneSpentTokens = fast.estTokens;
        if (fast.kind === "plan" && fast.plan) {
          fastMeta = { provider: fast.provider, estTokens: fast.estTokens };
          routed = { kind: "plan", plan: fast.plan, tier: "semantic", ruleId: FAST_LANE_RULE_ID };
        }
      }
      const ledgerRoute: BrainRoute | null = routed.kind === "plan" || routed.kind === "answer" ? (fastMeta ? "llm-fast" : routed.tier) : null;
      const ledgerTokens = fastMeta?.estTokens ?? 0;
      if (routed.kind !== "escalate") {
        setInput("");
        pushMessage("user", prompt);
        if (routed.kind === "answer") {
          pushItem({
            kind: "notice",
            tone: "info",
            text: routed.tier === "world" ? "🌐 World Model · measured on-device — 0 tokens" : "⚡ Instant · answered locally — 0 tokens"
          });
          pushMessage("ai", routed.text);
          speakIfVoice(routed.text);
          recordRuleFired(routed.ruleId);
          commitBrainTurn({ prompt, ruleId: routed.ruleId, hadEdits: false, at: Date.now(), source: "brain" });
          recordRoute({ route: ledgerRoute ?? "reflex", ms: performance.now() - reflexStartedAt, estTokens: ledgerTokens, outcome: "answered" });
          return;
        }
        if (routed.kind === "undo") {
          if (undoableCommits > 0) {
            handleUndoRef.current();
          } else if (runEditorCommand) {
            // Nothing of the AI's to revert → drive the editor's own history instead of a tip.
            const result = runEditorCommand("editorUndoRedo", { op: "undo" });
            pushMessage("ai", result.ok ? "↶ Undone (editor history)." : result.say);
          } else {
            pushMessage("ai", "Nothing to undo from my side — press **⌘Z / Ctrl+Z** in the editor for general undo.");
          }
          recordRoute({ route: "reflex", ms: performance.now() - reflexStartedAt, estTokens: 0, outcome: "applied" });
          return;
        }
        // Editor command plane: execute in the host immediately — view/transport state changes
        // never wait for an approval bar (saying the opposite is the undo).
        if (routed.kind === "command") {
          const result = runEditorCommand!(routed.commandId, routed.params);
          pushItem({ kind: "notice", tone: "info", text: "⚡ Instant · editor command — 0 tokens" });
          pushMessage("ai", result.ok ? routed.say : result.say || "I couldn't run that right now.");
          speakIfVoice(result.ok ? routed.say : result.say || "I couldn't run that right now.");
          if (result.ok) {
            recordRuleFired(routed.ruleId);
            commitBrainTurn({ prompt, ruleId: routed.ruleId, hadEdits: false, at: Date.now(), source: "brain" });
          }
          recordRoute({
            route: "reflex",
            ms: performance.now() - reflexStartedAt,
            estTokens: 0,
            outcome: result.ok ? "applied" : "failed"
          });
          return;
        }
        // A compiled brain plan — an ordinary AiPlan through the SAME pipeline as an LLM plan:
        // Professional mode still gets the approval bar; everything stays undoable.
        pushItem({
          kind: "notice",
          tone: "info",
          text: fastMeta
            ? "⚡ Fast lane · one small model call"
            : routed.tier === "semantic"
              ? "⚡ Instant · recognized phrasing — 0 tokens"
              : routed.tier === "world"
                ? "🌐 World Model · hypothesis blueprint — 0 tokens"
                : "⚡ Instant · compiled locally — 0 tokens"
        });
        setSuggestions([]);
        setUndoableCommits(0);
        runCommitsRef.current = 0;
        runTargetsRef.current = [];
        runCancelledRef.current = false;
        try {
          const approvedPlan = mode === "professional" ? await requestApproval(routed.plan) : routed.plan;
          if (!approvedPlan) {
            recordRoute({ route: ledgerRoute ?? "reflex", ms: performance.now() - reflexStartedAt, estTokens: ledgerTokens, outcome: "cancelled" });
            return;
          }
          setPhase("executing");
          const outcome = await executeBatch(approvedPlan);
          pushItem({
            kind: "summary",
            applied: outcome.applied,
            failed: outcome.failed,
            skipped: outcome.skipped,
            note: "everything stays editable (undo any time)"
          });
          if (runTargetsRef.current.length > 0) {
            lastActionRef.current = { targetLayerIds: runTargetsRef.current, prompt };
          }
          setUndoableCommits(runCommitsRef.current);
          recordPlanReviewed(true);
          if (outcome.failed === 0) {
            recordRuleFired(routed.ruleId);
            commitBrainTurn({ prompt, ruleId: routed.ruleId, hadEdits: outcome.applied > 0, at: Date.now(), source: "brain" });
          }
          recordRoute({
            route: ledgerRoute ?? "reflex",
            ...(fastMeta?.provider ? { provider: fastMeta.provider } : {}),
            ms: performance.now() - reflexStartedAt,
            estTokens: ledgerTokens,
            outcome: outcome.failed > 0 ? "failed" : "applied"
          });
        } finally {
          setPhase("idle");
          setPlan(null);
        }
        return;
      }
    }

    // Pick this run's route (Local vs cloud) up front. A "cancel" from the unreachable-Local hint
    // aborts before any state changes, leaving the typed prompt intact for a retry.
    const route = await resolveRoute();
    if (route === "cancel") {
      return;
    }
    const useLocal = route === "local";

    // Talk mode — converse for inspiration; never builds/applies a plan. Streams
    // prose, then offers runnable suggestions that hand off to Professional mode.
    if (mode === "talk") {
      setInput("");
      const image = attachedImage;
      pushMessage("user", image ? `${prompt}  ·  📎 reference image` : prompt);
      setAttachedImage(null);
      setSuggestions([]);
      const replyId = pushMessage("ai", ""); // empty text row → dot-wave until the first token
      setTalking(true);
      let streamed = "";
      const { context } = buildContext(prompt);
      const talkStartedAt = performance.now();
      // Voice session: read the reply back LIVE — completed sentences are pushed to the speech
      // stream while the model is still generating, so speech starts before the text finishes.
      // `speaking` holds the mic re-arm off for the whole session (we must not hear ourselves).
      const voice = voiceSessionRef.current ? startSpeechStream() : null;
      let spokenUpTo = 0;
      if (voice) {
        speakDepthRef.current += 1;
        setSpeaking(true);
        // No canned ack here: talk mode streams live, so the reply's OWN first sentence is the
        // prompt-specific acknowledgment and lands within moments.
      }
      // Never speak past the SUGGESTIONS tail — the marker delta itself can reach onDelta.
      const speakLimit = () => {
        const marker = streamed.search(/SUGGESTIONS:/i);
        return marker === -1 ? streamed.length : marker;
      };
      const speakCompletedSentences = () => {
        if (!voice) {
          return;
        }
        const pending = streamed.slice(spokenUpTo, speakLimit());
        const boundary = Math.max(pending.lastIndexOf(". "), pending.lastIndexOf("! "), pending.lastIndexOf("? "), pending.lastIndexOf("\n"));
        if (boundary >= 0) {
          voice.push(pending.slice(0, boundary + 1));
          spokenUpTo += boundary + 1;
        }
      };
      try {
        const result = await streamTalk(prompt, context, {
          ...(image ? { images: [image] } : {}),
          useLocal,
          onDelta: (delta) => {
            streamed += delta;
            updateMessage(replyId, streamed.trim());
            speakCompletedSentences();
          }
        });
        if (result.status === "vision") {
          const line = "I can't read that reference image with the current model — turn on **Pro**, or add a vision-capable key (e.g. Gemini) under 🔑.";
          updateMessage(replyId, line);
          if (spokenUpTo === 0) {
            voice?.push(line);
          }
        } else if (result.status === "unavailable") {
          const line = "I couldn't reach a model just now — the free providers are rate-limited or busy. Try again in a moment, turn on **Pro**, or add your own key under 🔑.";
          updateMessage(replyId, line);
          if (spokenUpTo === 0) {
            voice?.push(line);
          }
        } else {
          updateMessage(replyId, result.text || "I couldn't reach a model just now — try again in a moment.");
          if (voice) {
            const limit = speakLimit();
            if (limit > spokenUpTo) {
              voice.push(streamed.slice(spokenUpTo, limit)); // the un-spoken tail
              spokenUpTo = limit;
            } else if (spokenUpTo === 0 && result.text) {
              voice.push(result.text); // local models can return text without streaming deltas
            }
          }
          setSuggestions(result.suggestions);
        }
      } finally {
        setTalking(false);
        if (voice) {
          void voice.end().finally(() => {
            speakDepthRef.current = Math.max(0, speakDepthRef.current - 1);
            setSpeaking(speakDepthRef.current > 0);
          });
        }
        recordRoute({
          route: "talk",
          ms: performance.now() - talkStartedAt,
          estTokens: Math.round((prompt.length + streamed.length) / 4) + LLM_STATIC_TOKENS_PER_CALL,
          outcome: "answered"
        });
      }
      return;
    }

    // ---- Agentic run (all non-talk modes): observe → think → act → observe → … ----
    setInput("");
    pushMessage("user", attachedImage ? `${prompt}  ·  📎 reference image` : prompt);
    setAttachedImage(null);
    setSuggestions([]);
    setPhase("planning");
    // Progressive response, prompt-SPECIFIC (user feedback: a generic canned phrase is not an
    // acknowledgment): a tiny payload-free call to the FAST pool runs in parallel with the real
    // planner and returns one line proving THIS request was understood ("Okay — moving clip 1
    // to the third video track."). Spoken only if the run is still thinking when it lands —
    // never over a clarify question or the final answer. Brain-instant paths returned above.
    if (voiceSessionRef.current) {
      void requestSpokenAck(prompt).then((ack) => {
        if (ack && voiceSessionRef.current && phaseRef.current === "planning" && !awaitingInputRef.current) {
          speakIfVoice(ack);
        }
      });
    }
    setUndoableCommits(0);
    runCommitsRef.current = 0;
    runTargetsRef.current = [];
    runCancelledRef.current = false;
    setThink({ phase: 0, reasoning: "" });
    // Live reasoning is tracked locally (state updates are async); each iteration's thinking is
    // folded into a persistent collapsed "Thought for Ns" transcript row when its plan arrives.
    const live = { reasoning: "", provider: undefined as string | undefined, started: performance.now() };
    const onEvent = (event: PlanStreamEvent) => {
      if (event.type === "provider") live.provider = event.provider;
      if (event.type === "reasoning") live.reasoning += event.delta;
      setThink((current) => {
        if (event.type === "phase") return { ...current, phase: Math.max(current.phase, event.index) };
        if (event.type === "provider") return { ...current, provider: event.provider };
        return { ...current, reasoning: current.reasoning + event.delta };
      });
    };
    const commitThought = () => {
      if (live.reasoning.trim()) {
        pushItem({
          kind: "thought",
          text: live.reasoning,
          streaming: false,
          seconds: (performance.now() - live.started) / 1000,
          provider: live.provider
        });
      }
      live.reasoning = "";
      live.provider = undefined;
      live.started = performance.now();
      setThink({ phase: 0, reasoning: "" });
    };

    const { context: firstContext, continuity } = buildContext(prompt);
    // Trust cue: tell the user when we're treating this as a follow-up (P10).
    if (continuity.scope === "continue" && firstContext.lastAction) {
      pushItem({ kind: "notice", tone: "info", text: "↪ continuing your last edit" });
    }

    const runStartedAt = performance.now();
    // Plan-cache feed (B3): collect what the model actually executed; if the whole run was
    // plain timeline actions and fully succeeded, the same prompt against the SAME timeline
    // state replays for free next time (semantic tier, Zod re-validated).
    const executedSteps: { actionId: string; params: unknown; summary: string }[] = [];
    let cacheable = true;
    try {
      const report = await runAgentLoop(prompt, {
        planner,
        // Fresh timeline slice each iteration; the pre-run conversation history is stable (this
        // run's own work rides separately as the loop's compact action log — token economy).
        buildContext: () => {
          setPhase("planning");
          return buildContext(prompt).context;
        },
        executeBatch: async (batchPlan) => {
          rememberFacts(
            extractFacts(batchPlan, {
              projectId,
              qualityMode: bestQuality ? "best" : "balanced",
              permissionMode: mode
            })
          );
          for (const note of batchPlan.notes) {
            pushItem({ kind: "notice", tone: "info", text: note });
          }
          if (batchPlan.provider === "offline") {
            pushItem({ kind: "notice", tone: "warn", text: "Offline plan (no AI) — best-effort keyword match." });
            cacheable = false;
          }
          for (const step of batchPlan.steps) {
            if (step.kind === "timelineAction" && step.actionId) {
              executedSteps.push({ actionId: step.actionId, params: step.params, summary: step.summary });
            } else {
              cacheable = false;
            }
          }
          return executeBatch(batchPlan);
        },
        ...(mode === "professional" ? { requestApproval } : {}),
        askUser: askClarify,
        inspectCapability: (capabilityId) => buildCapabilityIndex().describeCapability(capabilityId),
        onInspected: (capabilityId, found) =>
          pushItem({
            kind: "step",
            label: `Reading tool: ${capabilityId}`,
            status: found ? "done" : "failed",
            ...(found ? {} : { detail: "no such capability" })
          }),
        onAnswer: (text) => {
          pushMessage("ai", text);
          speakIfVoice(text);
        },
        onNotice: (text, tone) => pushItem({ kind: "notice", tone, text }),
        onEvent,
        onPlanned: () => commitThought(),
        isCancelled: () => runCancelledRef.current,
        maxIterations: AGENT_ITERATION_CAPS[mode] ?? 8,
        useLocalLlm: useLocal
      });

      recordRoute({
        route: "loop",
        ...(live.provider ? { provider: live.provider } : {}),
        ms: performance.now() - runStartedAt,
        estTokens: Math.round(report.estChars / 4) + report.iterations * LLM_STATIC_TOKENS_PER_CALL + fastLaneSpentTokens,
        outcome:
          report.stopped === "cancelled"
            ? "cancelled"
            : report.failed > 0
              ? "failed"
              : report.applied > 0
                ? "applied"
                : "answered",
        iterations: report.iterations
      });

      if (report.applied + report.failed + report.skipped > 0) {
        recordPlanReviewed(true);
        pushItem({
          kind: "summary",
          applied: report.applied,
          failed: report.failed,
          skipped: report.skipped,
          note: "everything stays editable (undo any time)"
        });
      }
      if (runTargetsRef.current.length > 0) {
        lastActionRef.current = { targetLayerIds: runTargetsRef.current, prompt };
      }
      setUndoableCommits(runCommitsRef.current);
      let planCachedNow = false;
      if (
        cacheable &&
        report.stopped === "done" &&
        report.failed === 0 &&
        report.skipped === 0 &&
        report.applied > 0 &&
        executedSteps.length === report.applied
      ) {
        storeCachedPlan(prompt, firstContext, executedSteps);
        planCachedNow = true;
        // B6: a single plain action the LLM resolved teaches the semantic tier this user's
        // phrasing — the next "soften the intro"-style ask compiles locally for free.
        maybeLearnPhrase(prompt, executedSteps);
      }
      // Feedback on the MODEL's work too: 👍 blesses the cached replay (this exact ask never
      // costs tokens again), 👎 reverts + forgets it — see handleBrainFeedback's llm branch.
      if (report.stopped === "done" && report.failed === 0) {
        commitBrainTurn({
          prompt,
          ruleId: planCachedNow ? "t2.plan-cache" : "llm.turn",
          hadEdits: report.applied > 0,
          at: Date.now(),
          source: "llm",
          cached: planCachedNow
        });
      }
    } catch (error) {
      commitThought();
      pushItem({ kind: "notice", tone: "error", text: `I hit an error: ${error instanceof Error ? error.message : String(error)}` });
    } finally {
      setPhase("idle");
      setAwaitingInput(false);
      pendingInputRef.current = null;
      pendingQuestionIdRef.current = null;
      setPlan(null);
    }
  }, [buildContext, getContext, input, mode, phase, talking, planner, pushMessage, pushItem, executeBatch, requestApproval, askClarify, attachedImage, updateMessage, resolveRoute, cancelDictationEngine, projectId, bestQuality, undoableCommits, commitBrainTurn, runEditorCommand, exitVoiceSession, speakIfVoice]);
  handleSubmitVoiceRef.current = (prompt: string) => void handleSubmit(prompt);

  // Attach a reference image (downscaled client-side) for the next prompt.
  const handleImagePick = useCallback(async (file: File | undefined) => {
    if (!file || !file.type.startsWith("image/")) {
      return;
    }
    try {
      setAttachedImage(await encodeReferenceImage(file));
    } catch {
      pushMessage("ai", "Couldn't read that image — try a different file.");
    }
  }, [pushMessage]);

  // A Talk-mode suggestion: hand off to Professional mode and run it as a real plan.
  const runSuggestion = useCallback((suggestion: string) => {
    setSuggestions([]);
    setMode("professional");
    void handleSubmit(suggestion);
  }, [handleSubmit]);

  const handleApply = useCallback(
    (stepIds?: string[]) => {
      if (!plan || !approvalResolveRef.current) {
        return;
      }
      // The approval bar may pass a subset (per-step checkboxes); the loop executes only those.
      const selected = stepIds ? plan.steps.filter((step) => stepIds.includes(step.id)) : plan.steps;
      const activePlan = selected.length === plan.steps.length ? plan : { ...plan, steps: selected };
      const resolve = approvalResolveRef.current;
      approvalResolveRef.current = null;
      recordPlanReviewed(true);
      setPlan(null);
      resolve(activePlan);
    },
    [plan]
  );

  /** Revert the most recent applied plan by undoing each committed change it made. */
  const handleUndo = useCallback(async () => {
    if (!onUndo || undoableCommits === 0 || undoing) {
      return;
    }
    setUndoing(true);
    const count = undoableCommits;
    // B6 implicit reject: undoing a brain edit within 60s is a negative signal for its rule
    // (consumed here so the explicit-👎 path, which clears the ref first, never double-counts).
    const turn = brainTurnRef.current;
    if (turn?.hadEdits && Date.now() - turn.at < 60_000) {
      if (turn.source === "brain" || turn.cached) {
        recordRuleRejected(turn.ruleId);
      }
      // Undoing an LLM edit right away = that plan was wrong — never replay it from cache.
      if (turn.source === "llm") {
        forgetLearnedPlan(turn.prompt);
      }
      commitBrainTurn(null);
    }
    try {
      for (let i = 0; i < count; i += 1) {
        await onUndo();
      }
      lastActionRef.current = undefined;
      setUndoableCommits(0);
      pushMessage("ai", `Reverted ${count} change${count === 1 ? "" : "s"} from the last edit.`);
    } finally {
      setUndoing(false);
    }
  }, [onUndo, pushMessage, undoableCommits, undoing, commitBrainTurn]);

  /**
   * 👍/👎 on a brain-resolved turn (B2/B6). 👍 → the rule earns trust, row disappears.
   * 👎 → the rule loses trust (repeat offenders stop fast-pathing for this user), the local
   * edits are reverted, and the SAME prompt re-runs through the model — "our intelligence is
   * not what this user wants" self-corrects without them retyping anything.
   */
  const handleBrainFeedback = useCallback(
    async (positive: boolean) => {
      const turn = brainTurn;
      if (!turn) {
        return;
      }
      commitBrainTurn(null);
      if (turn.source === "llm") {
        // Model turns: feedback manages the plan cache, not a rule's trust. 👎 deliberately does
        // NOT auto re-run — the same model would repeat itself; ask for a correction instead.
        if (positive) {
          if (turn.cached) {
            recordRuleConfirmed("t2.plan-cache");
          }
          pushMessage(
            "ai",
            turn.cached
              ? "Thanks! Marked as correct — ask this again and I'll apply it instantly, no AI round-trip. ⚡"
              : "Thanks — good to know that landed right. Feedback like this makes me better. 📈"
          );
          return;
        }
        forgetLearnedPlan(turn.prompt);
        if (turn.cached) {
          recordRuleRejected("t2.plan-cache");
        }
        if (turn.hadEdits && undoableCommits > 0) {
          await handleUndo();
          pushMessage("ai", "Thanks for the correction — I've reverted it and won't repeat that plan. Tell me what you wanted instead and I'll take another shot.");
        } else {
          pushMessage("ai", "Got it, thanks — I won't reuse that. Tell me what was off and I'll try again.");
        }
        return;
      }
      if (positive) {
        recordRuleConfirmed(turn.ruleId);
        pushMessage("ai", "Thanks — feedback like this literally trains me. That shortcut just got stronger for you. ⚡");
        return;
      }
      recordRuleRejected(turn.ruleId);
      if (turn.hadEdits && undoableCommits > 0) {
        await handleUndo();
        pushMessage("ai", "Thanks for the correction — I've reverted it, dialed that shortcut down, and I'm asking the full AI model instead…");
      } else {
        pushMessage("ai", "Got it, thanks — I'll trust that shortcut less and ask the full AI model…");
      }
      skipBrainRef.current = true;
      void handleSubmit(turn.prompt);
    },
    [brainTurn, undoableCommits, handleUndo, handleSubmit, pushMessage, commitBrainTurn]
  );

  /** Start a fresh conversation: clears the persisted per-project history + all turn state. */
  const handleNewChat = useCallback(() => {
    if (phase !== "idle" || talking) {
      return;
    }
    clearTranscript(projectId ?? "");
    setTranscript([]);
    setSuggestions([]);
    commitBrainTurn(null);
    setUndoableCommits(0);
    lastActionRef.current = undefined;
  }, [phase, talking, projectId, commitBrainTurn]);

  const handleCancel = useCallback(() => {
    recordPlanReviewed(false);
    setPlan(null);
    setPhase("idle");
    const resolve = approvalResolveRef.current;
    approvalResolveRef.current = null;
    resolve?.(null);
    pushItem({ kind: "notice", tone: "info", text: "Cancelled — nothing was changed." });
  }, [pushItem]);

  const handleModify = useCallback(() => {
    if (plan) {
      setInput(plan.prompt);
      inputRef.current?.focus();
    }
    recordPlanReviewed(false);
    setPlan(null);
    setPhase("idle");
    const resolve = approvalResolveRef.current;
    approvalResolveRef.current = null;
    resolve?.(null);
  }, [plan]);

  handleApplyRef.current = () => handleApply();
  handleCancelRef.current = handleCancel;
  handleUndoRef.current = () => {
    void handleUndo();
  };

  // Announce voice-session transitions in the transcript so the mode is never ambiguous.
  const prevVoiceSessionRef = useRef(false);
  useEffect(() => {
    if (voiceSession === prevVoiceSessionRef.current) {
      return;
    }
    prevVoiceSessionRef.current = voiceSession;
    pushItem({
      kind: "notice",
      tone: "info",
      text: voiceSession
        ? "🎙 Voice session on — speak; I'll submit when you pause. Say “yes”/“cancel” to answer approvals. Esc exits."
        : "Voice session off."
    });
  }, [voiceSession, pushItem]);

  // ---- Voice session effects (E1/E2): auto-submit on silence, re-arm after each turn ----
  const prevDictationStatusRef = useRef(dictationStatus);
  useEffect(() => {
    const previous = prevDictationStatusRef.current;
    prevDictationStatusRef.current = dictationStatus;
    if (!voiceSessionRef.current) {
      return;
    }
    // Dictation just settled (silence auto-stop or engine finish) → submit what was heard.
    if (previous !== "idle" && dictationStatus === "idle" && inputStateRef.current.trim()) {
      // Self-echo guard: a transcript that is near-verbatim a line WE just spoke is the mic
      // catching the tail of our own TTS, not the user — discard it instead of executing it
      // as a command (the "move clip 1 to V3" ×3 loop). Voice-only; typed submits never pass here.
      if (looksLikeSelfEcho(inputStateRef.current, recentlySpokenLines())) {
        console.debug("[orreris] voice: discarded self-echo transcript:", inputStateRef.current);
        setInput("");
        return;
      }
      void handleSubmit();
    }
  }, [dictationStatus, handleSubmit]);

  // Barge-in: while the assistant is SPEAKING, a lightweight recognizer listens for interrupt
  // words — "stop"/"wait"/"quiet"/"hey orreris" cut the speech short and hand the mic straight
  // back (the fast re-arm below). Deliberately interrupt-words-only, not any-speech: this
  // recognizer hears our own TTS through the speakers, and interrupt words are the
  // precision-safe subset (replies never transcribe to a lone "stop").
  useEffect(() => {
    if (!voiceSession || !speaking) {
      return;
    }
    const recognition = createSpeechRecognition();
    if (!recognition) {
      return;
    }
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = (typeof navigator !== "undefined" ? navigator.language : undefined) ?? "en-US";
    recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const text = (event.results[i]?.[0]?.transcript ?? "").trim().toLowerCase();
        if (text && text.split(/\s+/).length <= 4 && /^(?:stop|wait|okay stop|ok stop|shut up|be quiet|quiet|enough|hey (?:orreris|chimera)|orreris)\b/.test(text)) {
          stopSpeaking(); // speakReply resolves → speaking=false → this recognizer is torn down and the mic re-arms
          return;
        }
      }
    };
    recognition.onerror = () => {};
    recognition.onend = () => {};
    try {
      recognition.start();
    } catch {
      return;
    }
    return () => {
      recognition.onresult = null;
      try {
        recognition.abort();
      } catch {
        // already stopped
      }
    };
  }, [voiceSession, speaking]);

  // Users answer the MOMENT the assistant stops talking — a slow re-arm eats their first words
  // ("play the video" heard as "the video"). Track when speech last ended so the re-arm below
  // can be near-instant right after TTS, while keeping the defensive delay elsewhere (fresh
  // session entry, wake handoff — the standby recognizer needs a beat to release the mic).
  const lastSpokeAtRef = useRef(0);
  useEffect(() => {
    if (speaking) {
      lastSpokeAtRef.current = performance.now();
    }
  }, [speaking]);
  useEffect(() => {
    if (!voiceSession || dictationStatus !== "idle" || input.trim()) {
      return;
    }
    // Re-arm the mic when the agent is ready for the user again: idle (next request), review
    // (spoken approval), or a pending question. NEVER while the loop is executing — the user's
    // muttering must not become a command mid-run — and NEVER while TTS is speaking, or the
    // recognizer would transcribe our own reply.
    const ready = (phase === "idle" || phase === "review" || awaitingInput) && !speaking;
    if (!ready) {
      return;
    }
    const justSpoke = performance.now() - lastSpokeAtRef.current < 2_000;
    const timer = setTimeout(
      () => {
        if (voiceSessionRef.current) {
          startDictation();
        }
      },
      justSpoke ? 140 : 450
    );
    return () => clearTimeout(timer);
  }, [voiceSession, dictationStatus, phase, awaitingInput, input, startDictation, speaking]);

  /** Stop button: abort the running agent loop between steps (also unblocks a pending question). */
  const handleStop = useCallback(() => {
    stopSpeaking();
    setVoiceSession(false);
    runCancelledRef.current = true;
    const pending = pendingInputRef.current;
    pendingInputRef.current = null;
    setAwaitingInput(false);
    pending?.(null);
    const approval = approvalResolveRef.current;
    approvalResolveRef.current = null;
    approval?.(null);
  }, []);

  const handleModeChange = useCallback((next: PermissionMode) => {
    setMode(next);
    rememberPreferences({ permissionMode: next });
  }, []);

  const toggleBestQuality = useCallback(() => {
    setBestQuality((current) => {
      const next = !current;
      rememberPreferences({ qualityMode: next ? "best" : "balanced" });
      return next;
    });
  }, []);

  if (showInsights) {
    return (
      <div className="ai-chat-panel">
        <AiInsightsDashboard onClose={() => setShowInsights(false)} />
      </div>
    );
  }

  if (showByoKey) {
    return (
      <div className="ai-chat-panel">
        <ByoKeyPanel onClose={() => setShowByoKey(false)} />
      </div>
    );
  }

  if (showOllama) {
    return (
      <div className="ai-chat-panel">
        <OllamaPanel onClose={() => setShowOllama(false)} onChange={setOllama} />
      </div>
    );
  }

  if (showMemory) {
    return (
      <div className="ai-chat-panel">
        <MemoryPanel projectId={projectId} onClose={() => setShowMemory(false)} />
      </div>
    );
  }

  const busy = ((phase === "planning" || phase === "executing") && !awaitingInput) || talking;

  return (
    <div className="ai-chat-panel">
      <div className="ai-chat-head">
        <span className="ai-chat-title">
          <Sparkles size={15} /> AI
        </span>
        <div className="ai-chat-head-actions">
          <button
            type="button"
            className={`ai-icon-btn${voiceSession ? " is-voice-on" : ""}${wakeStandby ? " is-wake-standby" : ""}`}
            onClick={toggleVoiceSession}
            aria-pressed={voiceSession}
            title={
              voiceSession
                ? "Exit voice mode (Alt+L / Esc)"
                : wakeStandby
                  ? "Voice mode (Alt+L) — wake-word standby is listening for “Hey Orreris”"
                  : "Voice mode — hands-free, continuous listening (Alt+L)"
            }
            aria-label={voiceSession ? "Exit voice mode" : "Enter voice mode"}
            aria-keyshortcuts="Alt+L"
          >
            <AudioLines size={15} />
          </button>
          {transcript.length > 0 ? (
            <button
              type="button"
              className="ai-icon-btn"
              onClick={handleNewChat}
              disabled={phase !== "idle" || talking}
              title="New chat (clears this project's AI history)"
              aria-label="New chat"
            >
              <SquarePen size={15} />
            </button>
          ) : null}
          <div className="ai-settings-wrap">
            <button
              type="button"
              className={`ai-icon-btn${showSettingsMenu ? " is-voice-on" : ""}`}
              onClick={() => setShowSettingsMenu((open) => !open)}
              title="AI settings"
              aria-label="AI settings"
              aria-haspopup="menu"
              aria-expanded={showSettingsMenu}
            >
              <Settings2 size={15} />
            </button>
            {showSettingsMenu ? (
              <>
                <div className="ai-settings-backdrop" onClick={() => setShowSettingsMenu(false)} />
                <div className="ai-settings-menu" role="menu" aria-label="AI settings">
                  <button type="button" role="menuitemcheckbox" aria-checked={wakeWordOn} onClick={toggleWakeWord}>
                    <Ear size={14} /> “Hey Orreris” wake word
                    <span className={`ai-settings-state${wakeWordOn ? " is-on" : ""}`}>{wakeWordOn ? "On" : "Off"}</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setShowSettingsMenu(false);
                      startWakeTraining();
                    }}
                  >
                    <Mic size={14} /> Train my wake phrase…
                  </button>
                  <div className="ai-settings-sep" />
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setShowSettingsMenu(false);
                      setShowByoKey(true);
                    }}
                  >
                    <KeyRound size={14} /> Use your own AI key…
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setShowSettingsMenu(false);
                      setShowMemory(true);
                    }}
                  >
                    <Brain size={14} /> What Orreris remembers…
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setShowSettingsMenu(false);
                      setShowInsights(true);
                    }}
                  >
                    <BarChart3 size={14} /> AI insights…
                  </button>
                  <div className="ai-settings-sep" />
                  <div className="ai-settings-label">Assistant voice</div>
                  {NATURAL_VOICES.map((voice) => (
                    <button
                      key={voice.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={naturalVoice === voice.id}
                      onClick={() => pickNaturalVoice(voice.id)}
                    >
                      <AudioLines size={14} /> {voice.label}
                      {naturalVoice === voice.id ? <span className="ai-settings-state is-on">✓</span> : null}
                    </button>
                  ))}
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={naturalVoice === "system"}
                    onClick={() => pickNaturalVoice("system")}
                    title="Always use your device's built-in voice — instant, no download, Kokoro never runs"
                  >
                    <AudioLines size={14} /> System voice — instant, no download
                    {naturalVoice === "system" ? <span className="ai-settings-state is-on">✓</span> : null}
                  </button>
                  <div className="ai-settings-info">
                    {naturalVoice === "system" ? (
                      "Natural voice: off — you chose the system voice"
                    ) : (
                      <>
                        Natural voice:{" "}
                        {naturalVoiceInfo.status === "ready"
                          ? `ready (Kokoro${naturalVoiceInfo.device === "webgpu" ? " · GPU" : naturalVoiceInfo.device === "wasm" ? " · CPU" : ""})`
                          : naturalVoiceInfo.status === "downloading"
                            ? `downloading… ${naturalVoiceDownload ?? ""}`
                            : naturalVoiceInfo.status === "unavailable"
                              ? `failed${naturalVoiceInfo.reason ? `: ${naturalVoiceInfo.reason}` : ""} — using the system voice`
                              : "downloads when voice mode starts"}
                        {naturalVoiceInfo.status === "unavailable" || naturalVoiceInfo.status === "unloaded" ? (
                          <button
                            type="button"
                            className="ai-settings-retry"
                            onClick={() => {
                              retryNaturalVoice();
                            }}
                            title="Retry the natural-voice download/load now"
                          >
                            ↻ Retry
                          </button>
                        ) : null}
                      </>
                    )}
                  </div>
                  <div className="ai-settings-sep" />
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={earsOn}
                    onClick={toggleEars}
                    title="Re-transcribe each voice command with a local high-accuracy model (Moonshine, ~60MB one-time download)"
                  >
                    <Ear size={14} /> High-accuracy hearing
                    <span className={`ai-settings-state${earsOn ? " is-on" : ""}`}>{earsOn ? "On" : "Off"}</span>
                  </button>
                  {earsOn ? (
                    <div className="ai-settings-info">
                      Local hearing:{" "}
                      {earsInfo.status === "ready"
                        ? "ready (Moonshine)"
                        : earsInfo.status === "downloading"
                          ? `downloading… ${
                              earsInfo.percent !== undefined
                                ? `${earsInfo.percent}%${earsInfo.totalMb ? ` (${earsInfo.loadedMb ?? 0}/${earsInfo.totalMb} MB)` : ""}`
                                : `${earsInfo.loadedMb ?? 0} MB so far`
                            }`
                          : earsInfo.status === "unavailable"
                            ? `failed${earsInfo.reason ? `: ${earsInfo.reason}` : ""} — using browser hearing`
                            : "starting download…"}
                      {earsInfo.status === "unavailable" || earsInfo.status === "unloaded" ? (
                        <button
                          type="button"
                          className="ai-settings-retry"
                          onClick={() => {
                            retryLocalEars();
                          }}
                          title="Retry the hearing-model download/load now"
                        >
                          ↻ Retry
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </>
            ) : null}
          </div>
          {onClose ? (
            <button type="button" className="ai-dock-close" onClick={onClose} aria-label="Close AI panel">
              ✕
            </button>
          ) : null}
        </div>
      </div>

      <div className="ai-chat-log" role="log" aria-live="polite" ref={logRef}>
        {transcript.length === 0 && phase === "idle" && !plan ? (
          <div className="ai-empty">
            <p className="ai-empty-title">What should I edit?</p>
            <p className="ai-empty-sub">Tell me the edit — I'll work in visible steps you can watch, approve, and undo.</p>
            <div className="ai-suggestions">
              {STARTER_PROMPTS.map((suggestion) => (
                <button key={suggestion} type="button" className="ai-suggestion" onClick={() => void handleSubmit(suggestion)}>
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <AgentTranscript items={transcript} onWakeTrain={resolveWakeTrain} onWakeSetup={resolveWakeSetup} />

        {/* Live planning pipeline — real stream-event-driven rows, rendered unboxed in the log flow.
            When planning ends, the reasoning is folded into a persistent collapsed thought row. */}
        {phase === "planning" ? (
          <AiThinkingLog activePhase={think.phase} reasoning={think.reasoning} provider={think.provider} />
        ) : null}

        {/* Review: the planned steps as pending rows (ephemeral — they enter the transcript for real
            when applied) + the slim approval bar. Cancel simply drops them, leaving no residue. */}
        {plan && phase === "review" ? (
          <>
            <AgentTranscript
              items={plan.steps
                .filter((step) => step.kind !== "clarify")
                .map((step) => ({ kind: "step" as const, id: `preview_${step.id}`, label: step.summary, status: "pending" as const }))}
            />
            <ApprovalBar plan={plan} busy={false} onApply={handleApply} onCancel={handleCancel} onModify={handleModify} />
          </>
        ) : null}

        {onUndo && undoableCommits > 0 && phase === "idle" ? (
          <div className="ai-undo-row">
            <button type="button" className="ai-undo-btn" onClick={() => void handleUndo()} disabled={undoing}>
              <Undo2 size={14} /> {undoing ? "Undoing…" : `Undo last edit (${undoableCommits})`}
            </button>
          </div>
        ) : null}

        {/* Feedback on a brain-resolved turn: 👍 trains the rule up, 👎 reverts the local edits
            and re-runs the same prompt through the model (and trains the rule down — a rule the
            user keeps rejecting stops fast-pathing entirely). */}
        {brainTurn && phase === "idle" && !talking ? (
          <div className="ai-brain-feedback-row" role="group" aria-label="Was this result right?">
            <span className="ai-brain-feedback-label">
              {brainTurn.source === "llm" ? "Was this what you wanted?" : "⚡ Instant — was this right?"}
            </span>
            <button
              type="button"
              className="ai-brain-feedback-btn"
              onClick={() => void handleBrainFeedback(true)}
              title={
                brainTurn.source === "llm"
                  ? brainTurn.cached
                    ? "Yes — repeat this instantly next time"
                    : "Yes — that was right"
                  : "Yes — keep resolving this instantly"
              }
            >
              👍
            </button>
            <button
              type="button"
              className="ai-brain-feedback-btn"
              onClick={() => void handleBrainFeedback(false)}
              title={
                brainTurn.source === "llm"
                  ? brainTurn.hadEdits
                    ? "No — undo this and never repeat it"
                    : "No — that wasn't right"
                  : brainTurn.hadEdits
                    ? "No — undo this and ask the AI model instead"
                    : "No — ask the AI model instead"
              }
            >
              👎
            </button>
          </div>
        ) : null}
      </div>

      {suggestions.length > 0 ? (
        <div className="ai-suggestion-row" role="group" aria-label="Suggested edits">
          <span className="ai-suggestion-label">Try:</span>
          {suggestions.map((suggestion) => (
            <button key={suggestion} type="button" className="ai-suggestion-chip" onClick={() => runSuggestion(suggestion)} disabled={busy}>
              {suggestion}
            </button>
          ))}
        </div>
      ) : null}

      {attachedImage ? (
        <div className="ai-image-attached">
          <img src={attachedImage} alt="Reference" className="ai-image-thumb" />
          <span className="ai-image-label">Reference attached</span>
          <button type="button" className="ai-image-remove" onClick={() => setAttachedImage(null)} aria-label="Remove reference image">
            <X size={13} />
          </button>
        </div>
      ) : null}

      {localFallback ? (
        <div className="ai-local-fallback" role="status">
          <span>Local model unreachable — using cloud in {localFallback.countdown}s</span>
          <button type="button" onClick={() => localFallbackResolveRef.current?.("cancel")}>
            Cancel
          </button>
        </div>
      ) : null}

      <form
        className="ai-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void handleSubmit();
        }}
      >
        <div className="ai-composer-input-row">
        <textarea
          ref={inputRef}
          className="ai-composer-input"
          value={input}
          onChange={(event) => {
            // Additive: while dictating, a value we didn't write is a manual edit — re-baseline so the
            // next interim appends after the edit instead of clobbering it. Idle → plain setInput as before.
            if (dictationStatus === "listening" && event.target.value !== lastDictationValueRef.current) {
              dictationBaseRef.current = event.target.value;
              lastDictationValueRef.current = event.target.value;
            }
            setInput(event.target.value);
          }}
          onKeyDown={(event) => {
            // Additive: Esc discards an in-progress dictation (restores the text typed before it started).
            if (event.key === "Escape" && voiceSession) {
              event.preventDefault();
              exitVoiceSession();
              setInput(dictationBaseRef.current);
              return;
            }
            if (event.key === "Escape" && dictationStatus !== "idle" && dictationStatus !== "unsupported") {
              event.preventDefault();
              cancelDictationEngine();
              setInput(dictationBaseRef.current);
              return;
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void handleSubmit();
            }
          }}
          placeholder={awaitingInput ? "Answer AI…" : mode === "talk" ? "Ask AI for ideas…" : "Ask AI to edit…"}
          rows={1}
          // Deliberately NOT disabled while busy: a disabled textarea is blurred by the browser, which
          // stole focus every time you sent a message. Submits are guarded in handleSubmit instead, so
          // the composer keeps focus (and you can type your next prompt while the current one runs).
          aria-busy={busy}
        />
        {dictation.supported ? (
          <button
            type="button"
            className={`ai-mic-btn${dictationStatus === "listening" ? " is-recording" : ""}${
              dictationStatus === "transcribing" ? " is-transcribing" : ""
            }${dictationStatus === "error" ? " is-error" : ""}${voiceSession ? " is-session" : ""}`}
            onPointerDown={handleMicPointerDown}
            onPointerUp={handleMicPointerUp}
            onPointerLeave={handleMicPointerUp}
            onClick={() => {
              // A long-press just entered the voice session — swallow the trailing click.
              if (micLongPressFiredRef.current) {
                micLongPressFiredRef.current = false;
                return;
              }
              if (voiceSession) {
                exitVoiceSession();
                return;
              }
              if (dictationStatus === "listening") {
                stopDictationEngine();
              } else {
                startDictation();
              }
            }}
            disabled={dictationStatus === "transcribing"}
            aria-pressed={dictationStatus === "listening" || voiceSession}
            aria-label={voiceSession ? "Exit voice session" : dictationStatus === "listening" ? "Stop dictation" : "Dictate to AI"}
            title={
              dictation.error ??
              (voiceSession
                ? "Voice session — speak, it submits on silence; tap or Esc to exit"
                : dictationStatus === "listening"
                  ? "Listening… tap to stop (Esc to cancel)"
                  : dictationStatus === "transcribing"
                    ? "Transcribing…"
                    : "Voice input — dictate to the AI (⌥M). Hold for a hands-free voice session.")
            }
          >
            {dictationStatus === "listening" ? (
              <span className="ai-mic-wave" aria-hidden="true" style={{ "--amp": dictation.amplitude } as CSSProperties}>
                <span className="ai-mic-bar" />
                <span className="ai-mic-bar" />
                <span className="ai-mic-bar" />
                <span className="ai-mic-bar" />
              </span>
            ) : (
              <Mic size={16} />
            )}
          </button>
        ) : null}
        </div>

        <div className="ai-composer-bar">
          <div className="ai-composer-bar-left">
            <button
              type="button"
              className={`ai-plus-btn${attachedImage ? " is-active" : ""}`}
              onClick={() => fileInputRef.current?.click()}
              disabled={busy}
              aria-label="Attach reference image"
              title="Attach a reference image (needs a vision-capable model)"
            >
              <Plus size={16} />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(event) => {
                void handleImagePick(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
            <PermissionModeSelector mode={mode} onChange={handleModeChange} disabled={busy} />
            <button
              type="button"
              className={`ai-pro-toggle${bestQuality ? " is-active" : ""}`}
              onClick={toggleBestQuality}
              aria-pressed={bestQuality}
              aria-label="Pro"
              title="Pro — route through the premium model (Claude) when available"
            >
              <Sparkles size={14} />
            </button>
            <button
              type="button"
              className={`ai-local-toggle${localActive ? " is-active" : ""}`}
              onClick={handleLocalToggle}
              aria-pressed={localActive}
              aria-label={localActive && ollama?.model ? `Local — ${ollama.model}` : "Local"}
              title={localActive ? `Local — running on ${ollama?.model}` : "Local — run on your own Ollama model (private, offline)"}
            >
              <Cpu size={14} />
            </button>
            {ollama ? (
              <button
                type="button"
                className="ai-local-gear"
                onClick={() => setShowOllama(true)}
                title="Local model settings"
                aria-label="Local model settings"
              >
                <Settings2 size={13} />
              </button>
            ) : null}
            {onOpenGenerate ? (
              <button
                type="button"
                className="ai-local-toggle"
                onClick={() => onOpenGenerate()}
                aria-label="Generate images or video"
                title="Generate — create AI images or video assets"
              >
                <ImagePlus size={14} />
              </button>
            ) : null}
          </div>
          {(phase === "planning" || phase === "executing") && !awaitingInput ? (
            // Stop the running agent loop (checked between steps) — Claude-Code-style interrupt.
            <button type="button" className="ai-send ai-stop" onClick={handleStop} aria-label="Stop the agent" title="Stop">
              <Square size={13} />
            </button>
          ) : (
            <button type="submit" className="ai-send" disabled={!input.trim() || busy} aria-label={awaitingInput ? "Reply" : "Send"}>
              <SendHorizontal size={15} />
            </button>
          )}
        </div>
      </form>

      {/* Voice-mode ambience: a full-window aurora frame (portal — spans the ENTIRE editor, not
          the dock) that says "the AI has the controls": breathing edge glow while listening,
          faster warm sweep while executing, plus a status pill with a live transcript tail. */}
      {voiceSession
        ? createPortal(
            <div className="voice-aurora" data-state={(phase !== "idle" || talking) ? "working" : speaking ? "speaking" : dictationStatus === "listening" && dictation.capturing ? "listening" : "arming"}>
              <div className="voice-aurora-corners" aria-hidden="true" />
              <div className="voice-aurora-frame" aria-hidden="true" />
              <div className="voice-aurora-glow" aria-hidden="true" />
              <div className="voice-aurora-pill" role="status">
                <span className="voice-aurora-dot" aria-hidden="true" />
                <span className="voice-aurora-label">
                  {phase !== "idle" || talking
                    ? "Working on it…"
                    : speaking
                      ? "Speaking — say “stop” to interrupt"
                      : dictationStatus === "listening" && dictation.capturing
                        ? input.trim()
                          ? `“…${input.trim().slice(-48)}”`
                          : "Listening — just say it"
                        : "Starting the mic…"}
                </span>
                {naturalVoiceDownload !== null ? (
                  <span
                    className="voice-aurora-sub"
                    title="One-time download of the natural voice (Kokoro) — the system voice answers meanwhile"
                  >
                    ⬇ voice {naturalVoiceDownload}
                  </span>
                ) : null}
                {earsInfo.status === "downloading" ? (
                  <span
                    className="voice-aurora-sub"
                    title="One-time download of the high-accuracy hearing model (Moonshine) — browser hearing answers meanwhile"
                  >
                    ⬇ hearing {earsInfo.percent !== undefined ? `${earsInfo.percent}%` : `${earsInfo.loadedMb ?? 0} MB`}
                  </span>
                ) : null}
                <button type="button" className="voice-aurora-exit" onClick={exitVoiceSession} title="Exit voice mode (Esc)" aria-label="Exit voice mode">
                  ✕
                </button>
              </div>
            </div>,
            document.body
          )
        : null}
    </div>
  );
});
