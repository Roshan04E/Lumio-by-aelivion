import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BarChart3, Brain, Cpu, ImagePlus, KeyRound, Plus, SendHorizontal, Settings2, Sparkles, Undo2, X } from "lucide-react";
import { getActionAnalytics, getSkill, getSkillTaskKind, logUnsupported, recordPlanReviewed, type SourceAsset } from "@lumio-by-aelivion/shared";
import { createPlanner } from "../../ai/planner/createPlanner";
import { runGeneration } from "../../generate/generateClient";
import type { GenerateStudioPrefill } from "../generate/GenerateStudio";
import { classifyContinuity, type ContinuityResult } from "../../ai/planner/intent-continuity";
import { streamTalk } from "../../ai/talk";
import { loadOllamaConfig, pingOllama, saveOllamaConfig, type OllamaConfig } from "../../ai/ollama";
import { Markdown } from "./Markdown";
import { executePlan, type ToolStepResult } from "../../ai/executor/PlanExecutor";
import { shouldAutoApply } from "../../ai/permission";
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
import { PlanReviewCard } from "./PlanReviewCard";
import { AiProgressList } from "./AiProgressList";
import { PermissionModeSelector } from "./PermissionModeSelector";
import { AiInsightsDashboard } from "./AiInsightsDashboard";
import { AiThinkingLog } from "./AiThinkingLog";
import { ByoKeyPanel } from "./ByoKeyPanel";
import { OllamaPanel } from "./OllamaPanel";
import { MemoryPanel } from "./MemoryPanel";

interface ChatMessage {
  id: string;
  role: "user" | "ai";
  text: string;
}

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
}

let messageSeq = 0;
function nextId(): string {
  messageSeq += 1;
  return `msg_${Date.now().toString(36)}_${messageSeq}`;
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
const STARTER_PROMPTS = [
  "Add captions",
  "Make it cinematic",
  "Remove the background",
  "Add bold text saying SALE",
  "Track the subject and follow with text",
  "Add a fade in and fade out"
];

/**
 * The Lumio AI chat panel. Type → see a plan → Apply. AI never mutates the
 * timeline directly: every applied edit flows through the Timeline Action
 * Registry and the editor's existing undo. It is project- AND conversation-aware
 * (P5: follow-ups), respects remembered preferences (P6), runs under a permission
 * mode (P4: Quick auto-applies safe edits), and surfaces demand analytics (P7).
 */
export function AiChatPanel({ getContext, commitComposition, openTool, onUndo, onClose, onOpenGenerate, onAddAssetToTimeline, projectId }: AiChatPanelProps) {
  const planner = useMemo(() => createPlanner(), []);
  const initialMemory = useMemo(() => loadMemory(), []);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [plan, setPlan] = useState<AiPlan | null>(null);
  const [progress, setProgress] = useState<Record<string, StepProgress>>({});
  const [phase, setPhase] = useState<"idle" | "planning" | "review" | "executing">("idle");
  const [mode, setMode] = useState<PermissionMode>(initialMemory.permissionMode ?? "professional");
  const [showInsights, setShowInsights] = useState(false);
  const [showByoKey, setShowByoKey] = useState(false);
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
  /** Talk mode is streaming a reply — shows a dot-wave (not the planner pipeline log). */
  const [talking, setTalking] = useState(false);
  /** The id of the AI bubble currently streaming in Talk mode (empty → show dots). */
  const [talkReplyId, setTalkReplyId] = useState<string | null>(null);

  // P11 — pull the user's memory profile (creator + this project) into the local
  // cache once, so the very first prompt already respects learned preferences.
  useEffect(() => {
    void hydrateFromServer(projectId);
  }, [projectId]);

  const pushMessage = useCallback((role: ChatMessage["role"], text: string) => {
    const id = nextId();
    setMessages((current) => [...current, { id, role, text }]);
    return id;
  }, []);

  const updateMessage = useCallback((id: string, text: string) => {
    setMessages((current) => current.map((message) => (message.id === id ? { ...message, text } : message)));
  }, []);

  // Auto-grow the composer so wrapped lines stay visible (height capped by CSS max-height).
  useEffect(() => {
    const el = inputRef.current;
    if (!el) {
      return;
    }
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  // Keep the latest message/plan/thinking in view — the user shouldn't have to scroll down each time.
  useEffect(() => {
    const el = logRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, phase, plan, progress, think]);

  /**
   * The executor pauses on a `clarify` step and calls this — we surface the
   * question in chat and resolve with the user's next typed message (ask → confirm
   * → reask → reconfirm). Returns null if the panel is torn down.
   */
  const askClarify = useCallback(
    (question: string) => {
      pushMessage("ai", question);
      setAwaitingInput(true);
      return new Promise<string | null>((resolve) => {
        pendingInputRef.current = resolve;
      });
    },
    [pushMessage]
  );

  /**
   * Augment the editor's base context with conversation history + memory + last
   * action (P5/P6), gated by the P10 intent-continuity classifier: a NEW request
   * does not thread the previous edit's target, so it can't be silently edited.
   */
  const buildContext = useCallback(
    (prompt: string): { context: PlannerContext; continuity: ContinuityResult } => {
      const base = getContext();
      const history: ConversationTurn[] = messages.map((message) => ({ role: message.role, text: message.text }));
      const continuity = classifyContinuity(prompt, {
        hasLastAction: Boolean(lastActionRef.current),
        hasSelection: base.selection.length > 0
      });
      // P11 — a small, high-confidence slice of learned memory (creator + project).
      const slice = selectMemorySlice(loadFacts(), { projectId });
      const context: PlannerContext = {
        ...base,
        history,
        lastAction: continuity.scope === "continue" ? lastActionRef.current : undefined,
        intentScope: continuity.scope,
        memory: slice.preferences,
        ...(slice.note ? { memoryNote: slice.note } : {}),
        ...(attachedImage ? { referenceImages: [attachedImage] } : {})
      };
      return { context, continuity };
    },
    [getContext, messages, projectId, attachedImage]
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
    [onOpenGenerate, onAddAssetToTimeline, projectId]
  );

  const runPlan = useCallback(
    async (activePlan: AiPlan, promptForMemory: string) => {
      setPhase("executing");
      recordPlanReviewed(true);
      // The user accepted an approximate/partial plan — record it as demand (spec #7).
      if (activePlan.confidence === "Approximation" || activePlan.notes.length > 0) {
        logUnsupported({
          prompt: activePlan.prompt,
          missingCapability: activePlan.notes[0] ?? "approximation",
          acceptedApproximation: true
        });
      }
      // Count commits so the in-panel Undo can revert exactly this plan's changes.
      let commits = 0;
      const countingCommit: AiChatPanelProps["commitComposition"] = async (after, summary) => {
        commits += 1;
        await commitComposition(after, summary);
      };
      const report = await executePlan(activePlan, {
        getContext,
        commitComposition: countingCommit,
        askClarify,
        ...(openTool ? { openTool } : {}),
        runSkillStep,
        onProgress: (update) => setProgress((current) => ({ ...current, [update.stepId]: update }))
      });
      setPhase("idle");
      setAwaitingInput(false);
      pendingInputRef.current = null;
      setUndoableCommits(commits);

      // Remember what was touched so the next prompt can say "make it bigger" (P5).
      if (report.targetLayerIds.length > 0) {
        lastActionRef.current = { targetLayerIds: report.targetLayerIds, prompt: promptForMemory };
      }
      // P11 — distil reusable creator/project facts from what was just applied
      // (replaces the old ad-hoc textColor learning). Cache + best-effort sync.
      rememberFacts(
        extractFacts(activePlan, {
          projectId,
          qualityMode: bestQuality ? "best" : "balanced",
          permissionMode: mode
        })
      );

      const analytics = getActionAnalytics();
      const parts = [`Applied ${report.applied} step${report.applied === 1 ? "" : "s"}`];
      if (report.failed) parts.push(`${report.failed} failed`);
      if (report.skipped) parts.push(`${report.skipped} skipped`);
      pushMessage(
        "ai",
        `${parts.join(", ")}. (AI actions so far: ${analytics.aiGeneratedCount}.) Everything stays editable — undo any time.`
      );
      setPlan(null);
    },
    [askClarify, commitComposition, getContext, openTool, runSkillStep, pushMessage, projectId, bestQuality, mode]
  );

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

    // If the executor is paused on a clarify step, this message is the answer —
    // resume rather than starting a new plan (ask → confirm → reask → reconfirm).
    if (pendingInputRef.current) {
      const resolve = pendingInputRef.current;
      pendingInputRef.current = null;
      setAwaitingInput(false);
      setInput("");
      pushMessage("user", prompt);
      resolve(prompt);
      return;
    }

    if (phase === "planning" || phase === "executing") {
      return;
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
      const replyId = pushMessage("ai", "");
      setTalkReplyId(replyId); // empty bubble → dot-wave until the first token
      setTalking(true);
      let streamed = "";
      const { context } = buildContext(prompt);
      try {
        const result = await streamTalk(prompt, context, {
          ...(image ? { images: [image] } : {}),
          useLocal,
          onDelta: (delta) => {
            streamed += delta;
            updateMessage(replyId, streamed.trim());
          }
        });
        if (result.status === "vision") {
          updateMessage(replyId, "I can't read that reference image with the current model — turn on **Pro**, or add a vision-capable key (e.g. Gemini) under 🔑.");
        } else if (result.status === "unavailable") {
          updateMessage(replyId, "I couldn't reach a model just now — the free providers are rate-limited or busy. Try again in a moment, turn on **Pro**, or add your own key under 🔑.");
        } else {
          updateMessage(replyId, result.text || "I couldn't reach a model just now — try again in a moment.");
          setSuggestions(result.suggestions);
        }
      } finally {
        setTalking(false);
        setTalkReplyId(null);
      }
      return;
    }

    setInput("");
    pushMessage("user", attachedImage ? `${prompt}  ·  📎 reference image` : prompt);
    setAttachedImage(null);
    setSuggestions([]);
    setPhase("planning");
    setProgress({});
    setUndoableCommits(0);
    setThink({ phase: 0, reasoning: "" });
    const onEvent = (event: PlanStreamEvent) => {
      setThink((current) => {
        if (event.type === "phase") return { ...current, phase: Math.max(current.phase, event.index) };
        if (event.type === "provider") return { ...current, provider: event.provider };
        return { ...current, reasoning: current.reasoning + event.delta };
      });
    };
    try {
      const { context, continuity } = buildContext(prompt);
      // Trust cue: tell the user when we're treating this as a follow-up (P10).
      if (continuity.scope === "continue" && context.lastAction) {
        pushMessage("ai", "↪ continuing your last edit");
      }
      const nextPlan = await planner.plan(prompt, { ...context, useLocalLlm: useLocal }, onEvent);
      const onlyClarify = nextPlan.steps.every((step) => step.kind === "clarify");

      // A clarify-only plan is a QUESTION, not an applyable plan — just ask it and go
      // idle. The user's next message is treated as the answer and re-plans (with this
      // exchange in history), so we never show a pointless "Apply" card for a question.
      if (onlyClarify) {
        setPlan(null);
        setPhase("idle");
        pushMessage("ai", nextPlan.steps[0]?.question ?? "Could you clarify what you'd like me to do?");
        return;
      }

      // Quick/Agent modes auto-apply safe plans without a review card (P4).
      if (shouldAutoApply(nextPlan, mode)) {
        setPlan(nextPlan);
        pushMessage("ai", `Applying directly (${mode} mode): ${nextPlan.confidence}.`);
        await runPlan(nextPlan, prompt);
        return;
      }

      setPlan(nextPlan);
      setPhase("review");
      pushMessage("ai", `Here's my plan (${nextPlan.confidence}).`);
    } catch (error) {
      setPhase("idle");
      pushMessage("ai", `I hit an error planning that: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [buildContext, input, mode, phase, planner, pushMessage, runPlan, attachedImage, updateMessage, resolveRoute]);

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
    async (stepIds?: string[]) => {
      if (!plan) {
        return;
      }
      // The review card may pass a subset (per-step checkboxes); apply only those.
      const selected = stepIds ? plan.steps.filter((step) => stepIds.includes(step.id)) : plan.steps;
      const activePlan = selected.length === plan.steps.length ? plan : { ...plan, steps: selected };
      await runPlan(activePlan, plan.prompt);
    },
    [plan, runPlan]
  );

  /** Revert the most recent applied plan by undoing each committed change it made. */
  const handleUndo = useCallback(async () => {
    if (!onUndo || undoableCommits === 0 || undoing) {
      return;
    }
    setUndoing(true);
    const count = undoableCommits;
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
  }, [onUndo, pushMessage, undoableCommits, undoing]);

  const handleCancel = useCallback(() => {
    recordPlanReviewed(false);
    setPlan(null);
    setPhase("idle");
    pushMessage("ai", "Cancelled — nothing was changed.");
  }, [pushMessage]);

  const handleModify = useCallback(() => {
    if (plan) {
      setInput(plan.prompt);
      inputRef.current?.focus();
    }
    recordPlanReviewed(false);
    setPlan(null);
    setPhase("idle");
  }, [plan]);

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
            className="ai-icon-btn"
            onClick={() => setShowByoKey(true)}
            title="Use your own AI key"
            aria-label="Use your own AI key"
          >
            <KeyRound size={15} />
          </button>
          <button
            type="button"
            className="ai-icon-btn"
            onClick={() => setShowMemory(true)}
            title="What Lumio remembers"
            aria-label="What Lumio remembers"
          >
            <Brain size={15} />
          </button>
          <button
            type="button"
            className="ai-icon-btn"
            onClick={() => setShowInsights(true)}
            title="AI insights & missing-capability demand"
            aria-label="AI insights"
          >
            <BarChart3 size={15} />
          </button>
          {onClose ? (
            <button type="button" className="ai-dock-close" onClick={onClose} aria-label="Close AI panel">
              ✕
            </button>
          ) : null}
        </div>
      </div>

      <div className="ai-chat-log" role="log" aria-live="polite" ref={logRef}>
        {messages.length === 0 && phase === "idle" && !plan ? (
          <div className="ai-empty">
            <p className="ai-empty-title">What should I edit?</p>
            <p className="ai-empty-sub">Pick a starter or type your own. I'll show a plan before changing anything.</p>
            <div className="ai-suggestions">
              {STARTER_PROMPTS.map((suggestion) => (
                <button key={suggestion} type="button" className="ai-suggestion" onClick={() => void handleSubmit(suggestion)}>
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {messages.map((message) => (
          <div key={message.id} className={`ai-chat-message is-${message.role}`}>
            {message.id === talkReplyId && !message.text ? (
              <span className="ai-typing-dots" aria-label="Thinking">
                <span />
                <span />
                <span />
              </span>
            ) : message.role === "ai" ? (
              <Markdown text={message.text} />
            ) : (
              message.text
            )}
          </div>
        ))}

        {phase === "planning" ? (
          <div className="ai-chat-message is-ai">
            <AiThinkingLog activePhase={think.phase} reasoning={think.reasoning} provider={think.provider} />
          </div>
        ) : null}

        {plan && (phase === "review" || phase === "executing") ? (
          <div className="ai-chat-message is-ai ai-chat-plan">
            {phase === "review" ? (
              <PlanReviewCard plan={plan} busy={false} onApply={handleApply} onCancel={handleCancel} onModify={handleModify} />
            ) : (
              <AiProgressList steps={plan.steps} progress={progress} />
            )}
          </div>
        ) : null}

        {onUndo && undoableCommits > 0 && phase === "idle" ? (
          <div className="ai-undo-row">
            <button type="button" className="ai-undo-btn" onClick={() => void handleUndo()} disabled={undoing}>
              <Undo2 size={14} /> {undoing ? "Undoing…" : `Undo last edit (${undoableCommits})`}
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
        <textarea
          ref={inputRef}
          className="ai-composer-input"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void handleSubmit();
            }
          }}
          placeholder={awaitingInput ? "Answer AI…" : mode === "talk" ? "Ask AI for ideas…" : "Ask AI to edit…"}
          rows={1}
          disabled={busy}
        />

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
          <button type="submit" className="ai-send" disabled={!input.trim() || busy} aria-label={awaitingInput ? "Reply" : "Send"}>
            <SendHorizontal size={15} />
          </button>
        </div>
      </form>
    </div>
  );
}
