import type {
  ToolAdapterType,
  ToolArtifact,
  ToolCapabilityDefinition,
  ToolDiagnostic,
  ToolRun,
  ToolRunStatus,
  ToolStage
} from "./types";

export type ToolAdapterCapabilityStatus = "ready" | "available" | "unavailable" | "planned";

export interface ToolAdapterCapability {
  type: ToolAdapterType;
  status: ToolAdapterCapabilityStatus;
  label: string;
  description: string;
  diagnostics: ToolDiagnostic[];
}

export interface ToolAdapterInvocation {
  id: string;
  toolId: string;
  adapter: ToolAdapterType;
  inputAssetIds: string[];
  params: Record<string, unknown>;
  requestedOutputs: ToolArtifact["type"][];
  costPolicy: ToolCostPolicy;
  createdAt: string;
}

export interface ToolAdapterUpdate {
  status: ToolRunStatus;
  progress: number;
  stage: ToolStage;
  artifacts?: ToolArtifact[] | undefined;
  diagnostics?: ToolDiagnostic[] | undefined;
}

export interface AiToolPlan {
  id: string;
  toolId: string;
  adapter: ToolAdapterType;
  reason: string;
  params: Record<string, unknown>;
  inputAssetIds: string[];
  requiresUserConfirmation: boolean;
  estimatedCredits: number;
  requestedOutputs: ToolArtifact["type"][];
}

export type ToolCostPolicy = "metadataOnly" | "estimateOnly" | "enforceCredits";

export function createToolAdapterInvocation(input: {
  tool: ToolCapabilityDefinition;
  adapter: ToolAdapterType;
  run?: ToolRun | undefined;
  costPolicy?: ToolCostPolicy | undefined;
  now?: string | undefined;
}): ToolAdapterInvocation {
  const now = input.now ?? new Date().toISOString();
  return {
    id: `${input.adapter}_${input.tool.slug}_${Date.now()}`,
    toolId: input.tool.id,
    adapter: input.adapter,
    inputAssetIds: input.run?.inputAssetIds ?? [],
    params: input.run?.params ?? {},
    requestedOutputs: input.tool.outputs,
    costPolicy: input.costPolicy ?? "metadataOnly",
    createdAt: now
  };
}

export function createAiToolPlan(input: {
  tool: ToolCapabilityDefinition;
  adapter?: ToolAdapterType | undefined;
  reason: string;
  params?: Record<string, unknown> | undefined;
  inputAssetIds?: string[] | undefined;
}): AiToolPlan {
  const adapter = input.adapter ?? pickDefaultToolAdapter(input.tool);
  return {
    id: `ai_plan_${input.tool.slug}_${Date.now()}`,
    toolId: input.tool.id,
    adapter,
    reason: input.reason,
    params: input.params ?? {},
    inputAssetIds: input.inputAssetIds ?? [],
    requiresUserConfirmation: true,
    estimatedCredits: input.tool.estimatedCredits ?? 0,
    requestedOutputs: input.tool.outputs
  };
}

export function pickDefaultToolAdapter(tool: ToolCapabilityDefinition): ToolAdapterType {
  if (tool.adapters.includes("browser") && tool.browserMode !== "heavy") {
    return "browser";
  }
  return tool.adapters[0] ?? "mock";
}

export function createAdapterUnavailableDiagnostic(adapter: ToolAdapterType): ToolDiagnostic {
  return {
    level: "warning",
    code: "ADAPTER_UNAVAILABLE",
    message: `${adapter} adapter is not available in this runtime yet.`
  };
}

