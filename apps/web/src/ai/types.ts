import type { CostEstimate, TimelineComposition } from "@orreris/shared";
import type { IntentScope } from "./planner/intent-continuity";

export type { IntentScope } from "./planner/intent-continuity";

/**
 * Orreris AI — shared plan types. A plan is an ordered list of steps the user
 * reviews before anything is applied. Steps are one of:
 *  - `timelineAction` — invoke a registered Timeline Action (free, local).
 *  - `tool` — open an existing tool window (e.g. tracker); may pause for input.
 *  - `skill` — run a Skill (e.g. AI asset generation); may hand off to a studio.
 *  - `clarify` — ask the user a question before continuing.
 *  - `answer` — a plain conversational reply when the message needs no edit/tool/skill (a question or chat).
 */
export type PlanStepKind = "timelineAction" | "tool" | "skill" | "clarify" | "answer" | "inspect";

export interface PlanStep {
  id: string;
  kind: PlanStepKind;
  /** Human one-liner shown in Plan Review and Progress. */
  summary: string;
  /** For `timelineAction`. */
  actionId?: string;
  params?: unknown;
  /** For `tool`. */
  toolSlug?: string;
  /** For `tool` — the user must confirm/tweak in the tool window before resuming. */
  requiresInput?: boolean;
  /** For `skill` — which skill + task kind to run (params carries the task params). */
  skillId?: string;
  taskKind?: string;
  /** For `clarify`. */
  question?: string;
  /** For `answer` — the conversational reply text shown directly in chat (no plan card). */
  text?: string;
  /** For `inspect` — read a capability's full doc client-side (free) before using it. */
  capabilityId?: string;
  cost: CostEstimate;
}

export interface AiPlan {
  id: string;
  prompt: string;
  steps: PlanStep[];
  totalCredits: number;
  /** Confidence label (deterministic planner) — see also `confidencePercent`. */
  confidence: "Exact" | "High Quality" | "Approximation" | "Experimental";
  /** Raw model confidence 0–100, shown directly in the UI when the LLM gateway produced the plan. */
  confidencePercent?: number;
  /** Anything the planner couldn't do, surfaced honestly to the user. */
  notes: string[];
  /** The model's chain-of-thought (GP2 thinking log), shown collapsed in the plan card. */
  reasoning?: string;
  /** Which gateway provider produced the plan (e.g. "groq"), for the activity log. */
  provider?: string;
  /**
   * B5 final-batch contract: the model marks a batch as completing the request. If every step
   * succeeds, the agent loop ends WITHOUT a closing LLM call, using `finalSummary` as the
   * run's answer — killing the wasted "done" iteration every run used to pay.
   */
  final?: boolean;
  finalSummary?: string;
}

/** One turn of the AI conversation, fed back to the planner for follow-ups (P5). */
export interface ConversationTurn {
  role: "user" | "ai";
  text: string;
}

/** What the last applied plan touched — lets "make it bigger" resolve a target (P5). */
export interface LastActionContext {
  /** Layer ids created or modified by the most recent applied plan. */
  targetLayerIds: string[];
  /** The prompt that produced them. */
  prompt: string;
}

export interface PlannerContext {
  composition: TimelineComposition;
  /** Currently-selected layer ids. */
  selection: string[];
  /** Playhead time in seconds. */
  nowSeconds: number;
  /** Prior turns, oldest first — present so the planner can resolve follow-ups (P5). */
  history?: ConversationTurn[];
  /** The most recent applied plan's targets, for delta edits (P5). */
  lastAction?: LastActionContext | undefined;
  /** Remembered user preferences the planner uses to fill defaults (P6/P11 retrieved slice). */
  memory?: AiMemoryPreferences | undefined;
  /** P11 — a one-line memory steer for the LLM (e.g. "usual caption style: bold yellow"). */
  memoryNote?: string | undefined;
  /**
   * P10 — whether this message continues the previous request or starts a new one.
   * Gates whether `lastAction` is threaded and biases the planners. See
   * `planner/intent-continuity.ts`.
   */
  intentScope?: IntentScope | undefined;
  /** Reference images (data URLs) for this turn; routed to a vision-capable provider. */
  referenceImages?: string[] | undefined;
  /**
   * Local mode (Ollama): when true, this run plans against the user's local model (browser-direct)
   * instead of the cloud gateway. Set by the chat panel only after a successful pre-flight ping, so
   * the planner can assume Local is reachable; any mid-run failure still falls back to the gateway.
   */
  useLocalLlm?: boolean | undefined;
  /** Live hands-free voice session — replies are read aloud, so the prompts switch to the
   * spoken-conversation register (short, varied, no lists; see shared VOICE_MODE_NOTE). */
  voiceMode?: boolean | undefined;
}

/**
 * GP2.1 live planning events — drive the Claude-Code-style thinking log in real time.
 * `index` maps to a pipeline phase (0=understanding … 5=validating).
 */
export type PlanStreamEvent =
  | { type: "phase"; index: number }
  | { type: "provider"; provider: string }
  | { type: "reasoning"; delta: string };

export type PlanEventHandler = (event: PlanStreamEvent) => void;

export interface PlannerProvider {
  /** Name shown in the UI / used for analytics. */
  readonly id: string;
  /** `onEvent` (optional) receives live phase/reasoning updates while planning. */
  plan(prompt: string, ctx: PlannerContext, onEvent?: PlanEventHandler): Promise<AiPlan>;
}

/**
 * Permission modes (P4) — how much autonomy the AI has before applying:
 *  - `quick`        — auto-apply small, free, non-destructive plans without a review card.
 *  - `professional` — always show the plan for approval (the default, safest).
 *  - `agent`        — multi-step workflows; auto-applies and auto-continues clarifications.
 */
export type PermissionMode = "quick" | "professional" | "agent" | "talk";

/** Remembered preferences (P6). All optional; persisted by the host. */
export interface AiMemoryPreferences {
  captionStyle?: string;
  colorGrade?: string;
  qualityMode?: "fast" | "balanced" | "best";
  language?: string;
  permissionMode?: PermissionMode;
  /** Last text color the user added, so "another one" matches. */
  textColor?: string;
}

export type StepStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface StepProgress {
  stepId: string;
  status: StepStatus;
  detail?: string | undefined;
}
