import type { ZodTypeAny } from "zod";
import { timelineEffectRegistry, type TimelineEffectDefinition } from "./effects";
import { timelineActionRegistry } from "./timeline-actions";
import type { TimelineActionDefinition } from "./timeline-actions";
import { describeSkillsForPlanner } from "./skills";
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
      if (param.type === "curve") {
        return `${param.key}(graph curves; apply at default, user shapes it in the panel)`;
      }
      if (param.type === "wheels") {
        return `${param.key}(3-way color wheels; apply at default, user balances them in the panel)`;
      }
      if (param.type === "hueCurves") {
        return `${param.key}(Lumetri hue/sat curves; apply at default, user shapes them in the panel)`;
      }
      if (param.type === "secondary") {
        return `${param.key}(HSL secondary key+grade; apply at default, user keys the color in the panel)`;
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
  "- 'remove/delete a whole layer' → deleteLayer. But 'remove the blur/grade/<effect>' → removeEffect (resolve effectId from the layer's effects in the slice). 'remove the fade' → removeTransition. NEVER deleteLayer for an effect/fade.",
  "- 'remove the background' → the background tool, not deleteLayer.",
  "- Color: 'fix colors / exposure / contrast / white balance / cinematic / grade' → addEffect effectType=brightnessContrast (Basic Color Correction). 'curves / contrast curve / s-curve / lift shadows with a curve' → addEffect effectType=colorCurves (graph curves). 'color wheels / lift gamma gain / 3-way / balance shadows/mids/highlights' → addEffect effectType=colorWheels. 'hue curves / shift a color's hue / boost saturation of one color / hue vs sat/luma' → addEffect effectType=hueSatCurves. 'isolate/key a color / change only the reds/skin/sky / qualifier / secondary' → addEffect effectType=hslSecondary. Curves/wheels/hue-curves/secondary apply at default — the user shapes them in the panel.",
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
