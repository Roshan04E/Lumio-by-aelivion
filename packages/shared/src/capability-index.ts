import type { ZodTypeAny } from "zod";
import { timelineEffectRegistry, type TimelineEffectDefinition } from "./effects";
import { timelineActionRegistry } from "./timeline-actions";
import type { TimelineActionDefinition } from "./timeline-actions";
import { describeSkillsForPlanner, getSkill } from "./skills";
import { toolCapabilityDefinitions } from "./tools";
import type { ToolCapabilityDefinition } from "./types";

/**
 * Capability discovery. The planner MUST inspect what the editor can actually do
 * before producing a plan — never invent tools/effects/actions. `buildCapabilityIndex`
 * is the single queryable view over all three source-of-truth registries:
 * tools (`toolCapabilityDefinitions`), effects (`timelineEffectRegistry`), and
 * timeline actions (`timelineActionRegistry`).
 */

export interface CostEstimate {
  tier: "browser" | "cloud";
  /** Browser/local work is free (0); cloud work consumes credits (metadata only — no gating). */
  credits: number;
}

export interface CapabilityIndex {
  tools: ToolCapabilityDefinition[];
  effects: TimelineEffectDefinition[];
  actions: TimelineActionDefinition<unknown>[];
  /** Find a tool by slug/id or a loose keyword match against its descriptions. */
  findTool: (intent: string) => ToolCapabilityDefinition | undefined;
  /** Find an effect by exact type or a keyword match against name/description. */
  findEffect: (intent: string) => TimelineEffectDefinition | undefined;
  hasAction: (id: string) => boolean;
  listActionIds: () => string[];
  /** Validate proposed action params against the action's Zod schema (param-level, not just id existence). */
  validateActionParams: (actionId: string, params: unknown) => { ok: boolean; errors: string[] };
  /** Compact text the (deterministic or future LLM) planner can read. */
  describeForPlanner: () => string;
  /**
   * The agent's "read the tool manual" — a fuller doc for ONE capability (action, tool, effect,
   * or skill), resolved entirely client-side for the `inspect` step. Null when the id matches
   * nothing in any registry.
   */
  describeCapability: (id: string) => string | null;
}

/**
 * Reflect a Zod object schema into a compact `field: type(constraints)` hint string
 * for the planner. The model can't pick `addShape` over `updateText` if it doesn't
 * know `addShape` takes a `color` — so we surface each action's real parameters
 * (derived from its live `inputSchema`, never a hand-maintained copy).
 */
export function describeZodShape(schema: ZodTypeAny): string {
  // Defensive runtime reflection — Zod's internal `_def` shape is stable across 3.x.
  const def = (schema as { _def?: { typeName?: string; shape?: () => Record<string, ZodTypeAny> } })._def;
  if (!def || def.typeName !== "ZodObject" || typeof def.shape !== "function") {
    return "";
  }
  const shape = def.shape();
  const fields = Object.entries(shape).map(([key, field]) => `${key}${describeZodField(field)}`);
  return fields.join(", ");
}

function describeZodField(field: ZodTypeAny): string {
  let current = field as { _def?: Record<string, unknown> };
  let optional = false;
  // Unwrap Optional/Nullable/Default wrappers to reach the inner type.
  for (let i = 0; i < 5; i += 1) {
    const typeName = current._def?.typeName as string | undefined;
    if (typeName === "ZodOptional" || typeName === "ZodNullable" || typeName === "ZodDefault") {
      optional = optional || typeName !== "ZodDefault";
      current = (current._def as { innerType?: { _def?: Record<string, unknown> } }).innerType ?? current;
      continue;
    }
    break;
  }
  const def = current._def as Record<string, unknown> | undefined;
  const typeName = def?.typeName as string | undefined;
  const mark = optional ? "?" : "";
  switch (typeName) {
    case "ZodString": {
      const checks = (def?.checks as { kind?: string }[] | undefined) ?? [];
      const hint = checks.some((check) => check.kind === "regex") ? "hex" : "string";
      return `${mark}(${hint})`;
    }
    case "ZodNumber": {
      const checks = (def?.checks as { kind?: string; value?: number }[] | undefined) ?? [];
      const min = checks.find((check) => check.kind === "min")?.value;
      const max = checks.find((check) => check.kind === "max")?.value;
      const range = min !== undefined && max !== undefined ? `${min}-${max}` : "number";
      return `${mark}(${range})`;
    }
    case "ZodEnum": {
      const values = ((def?.values as string[] | undefined) ?? []).join("|");
      return `${mark}(${values})`;
    }
    case "ZodBoolean":
      return `${mark}(bool)`;
    default:
      return mark;
  }
}

/** A compact param hint for one effect, e.g. `intensity(0-100), style(film|vivid)`. */
function describeEffectParams(effect: TimelineEffectDefinition): string {
  return effect.params
    .map((param) => {
      if (param.type === "select") {
        return `${param.key}(${param.options.map((option) => option.value).join("|")})`;
      }
      if (param.type === "curve" || param.type === "wheels" || param.type === "hueCurves" || param.type === "secondary") {
        // Don't hand-author these — the color-grade skill compiles a GradeIntent into real values.
        return `${param.key}(authored by the color-grade skill; do NOT set directly)`;
      }
      return param.key;
    })
    .join(", ");
}

/**
 * A fixed primer on the action pairs most often confused, so the planner picks the
 * MOST SPECIFIC capability. Prepended to the capability description.
 */
const DISAMBIGUATION = [
  "INTENT NOTES (pick the most specific):",
  "- 'add/create/insert/draw a shape/box/circle' → addShape (new shape layer; takes color). NEVER updateText.",
  "- 'add/write text' → addText (new text layer). 'change/recolor/resize/bold/italic the text' → updateText (existing layer; bold/italic are booleans).",
  "- 'reposition/center an existing text layer on screen' → updateText with x/y (0-100). 're-time/delay a layer' → moveLayer (startSeconds/deltaSeconds).",
  "- 'move/put track (or layer) VN on top / above VM / to the bottom' with NO clip named → reorderTrack (moves the whole track; top = drawn above everything). A clip named ('clip 1 to V3') → moveLayer with trackId.",
  "- 'remove/delete a whole layer' → deleteLayer. But 'remove the blur/grade/<effect>' → removeEffect (resolve effectId from the layer's effects in the slice). 'remove the fade' → removeTransition. NEVER deleteLayer for an effect/fade.",
  "- 'remove the background' → the background tool, not deleteLayer.",
  "- 'erase/remove a person or object from the footage' → the remove-person tool (real inpainting), NOT deleteLayer.",
  "- To target an existing clip, set params.layerId to that layer's id from the slice. 'clip 4' / 'the 4th clip' → the slice layer whose `ref` is 'clip 4'. If the user names NO clip, omit params.layerId — the editor targets the selected clip, else the clip under the playhead.",
  "- Color/grade: ANY color-grade or look request — 'fix colors / white balance / cinematic / teal & orange / crush the blacks / lift shadows / s-curve / 3-way balance / boost the reds / isolate the skin / desaturate the background' — → ONE skill step { skillId: 'color-grade', taskKind: 'color-grade', params: <GradeIntent> }. The app compiles the intent into a real editable effect stack. Do NOT emit addEffect with effectType=colorCurves/colorWheels/hueSatCurves/hslSecondary and hand-authored JSON.",
  "- For fades: addTransition kind=fadeIn and kind=fadeOut are independent and additive — emit BOTH steps when the user asks for fade in AND out.",
  "- NEVER ask the user for an internal id; resolve targets yourself from the slice (a text layer by its text, an effect by its type)."
].join("\n");

function keywordMatchTool(tool: ToolCapabilityDefinition, needle: string): boolean {
  const haystack = [tool.slug, tool.id, tool.name, tool.shortDescription, tool.aiDescription, tool.bestFor]
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

export function buildCapabilityIndex(): CapabilityIndex {
  const tools = toolCapabilityDefinitions;
  const effects = timelineEffectRegistry;
  const actions = timelineActionRegistry.list();

  return {
    tools,
    effects,
    actions,
    findTool: (intent) => {
      const needle = intent.trim().toLowerCase();
      if (!needle) {
        return undefined;
      }
      return (
        tools.find((tool) => tool.slug === needle || tool.id === needle) ??
        tools.find((tool) => keywordMatchTool(tool, needle))
      );
    },
    findEffect: (intent) => {
      const needle = intent.trim().toLowerCase();
      if (!needle) {
        return undefined;
      }
      return (
        effects.find((effect) => effect.type.toLowerCase() === needle) ??
        effects.find((effect) => `${effect.name} ${effect.description}`.toLowerCase().includes(needle))
      );
    },
    hasAction: (id) => timelineActionRegistry.has(id),
    listActionIds: () => actions.map((action) => action.id),
    validateActionParams: (actionId, params) => {
      const action = actions.find((item) => item.id === actionId);
      if (!action) {
        return { ok: false, errors: [`unknown action "${actionId}"`] };
      }
      const result = action.inputSchema.safeParse(params);
      if (result.success) {
        return { ok: true, errors: [] };
      }
      const errors = result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
      return { ok: false, errors };
    },
    describeCapability: (id) => {
      const needle = id.trim();
      if (!needle) {
        return null;
      }
      const action = actions.find((item) => item.id === needle);
      if (action) {
        const params = describeZodShape(action.inputSchema as ZodTypeAny);
        return [
          `ACTION ${action.id} (${action.name}) — ${action.description}`,
          params ? `Params: ${params}` : "Params: none",
          `Category: ${action.category}. Undoable: ${action.canUndo ? "yes" : "no"}. Free/local.`
        ].join("\n");
      }
      const effect = effects.find((item) => item.type === needle);
      if (effect) {
        const params = describeEffectParams(effect);
        return [
          `EFFECT ${effect.type} (${effect.name}) — ${effect.description}`,
          params ? `Params: ${params}` : "Params: none",
          `Apply via addEffect { layerId, effectType: "${effect.type}", params }.`
        ].join("\n");
      }
      const tool = tools.find((item) => item.slug === needle || item.id === needle);
      if (tool) {
        return [
          `TOOL ${tool.slug} (${tool.name}) — ${tool.aiDescription}`,
          tool.bestFor ? `Best for: ${tool.bestFor}` : "",
          `Adapters: ${tool.adapters.join("/")}.`
        ]
          .filter(Boolean)
          .join("\n");
      }
      const skill = getSkill(needle);
      if (skill) {
        return [`SKILL ${skill.id} (${skill.name}) — ${skill.aiSummary}`, skill.procedure].join("\n");
      }
      return null;
    },
    describeForPlanner: () =>
      [
        DISAMBIGUATION,
        "",
        describeSkillsForPlanner(),
        "",
        "TOOLS:",
        ...tools.map((tool) => `- ${tool.slug}: ${tool.aiDescription} (adapters: ${tool.adapters.join("/")})`),
        "EFFECTS (use via addEffect/updateEffect with effectType=<type>):",
        ...effects.map((effect) => {
          const params = describeEffectParams(effect);
          return `- ${effect.type}: ${effect.description}${params ? ` params: ${params}` : ""}`;
        }),
        "TIMELINE ACTIONS:",
        ...actions.map((action) => {
          const params = describeZodShape(action.inputSchema as ZodTypeAny);
          return `- ${action.id}: ${action.description}${params ? ` params: ${params}` : ""}`;
        })
      ].join("\n")
  };
}

/**
 * Classify the cost of a planned step. Browser/local adapters and pure timeline
 * actions are free; cloud adapters consume the tool's `estimatedCredits`.
 */
export function classifyToolCost(
  toolSlugOrId: string,
  options: { preferCloud?: boolean | undefined } = {}
): CostEstimate {
  const tool = toolCapabilityDefinitions.find((item) => item.slug === toolSlugOrId || item.id === toolSlugOrId);
  if (!tool) {
    return { tier: "browser", credits: 0 };
  }
  const canRunBrowser = tool.adapters.includes("browser");
  const useBrowser = canRunBrowser && !options.preferCloud;
  return useBrowser ? { tier: "browser", credits: 0 } : { tier: "cloud", credits: tool.estimatedCredits ?? 0 };
}

/** Timeline actions are always local/free. */
export function actionCost(): CostEstimate {
  return { tier: "browser", credits: 0 };
}
