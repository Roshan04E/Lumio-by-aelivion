import {
  createAdapterUnavailableDiagnostic,
  createToolAdapterInvocation,
  createMockToolRun,
  pickDefaultToolAdapter,
  type ToolArtifact,
  type ToolAdapterCapability,
  type ToolAdapterType,
  type ToolCapabilityDefinition,
  type ToolDiagnostic,
  type ToolRun,
  type ToolStage
} from "@orreris/shared";
import { createToolArtifactStore, type ToolArtifactStore } from "./artifact-store";
import { browserCapabilityDiagnostics, detectBrowserToolCapabilities, type BrowserToolCapabilities } from "./capabilities";

export interface ToolRuntimeState {
  capabilities: BrowserToolCapabilities;
  diagnostics: ToolDiagnostic[];
  artifactStoreKind: ToolArtifactStore["kind"];
  adapters: ToolAdapterCapability[];
}

export interface ToolRunController {
  cancel: () => void;
}

export interface RunToolOptions {
  tool: ToolCapabilityDefinition;
  run?: ToolRun | undefined;
  adapterType?: ToolAdapterType | undefined;
  onUpdate: (run: ToolRun) => void;
}

interface ToolAdapterContext {
  store: ToolArtifactStore;
  capabilities: BrowserToolCapabilities;
}

interface WebToolAdapter {
  type: ToolAdapterType;
  capability: (tool: ToolCapabilityDefinition, context: ToolAdapterContext) => ToolAdapterCapability;
  run: (options: RunToolOptions, context: ToolAdapterContext) => Promise<ToolRunController>;
}

export async function createToolRuntimeState(): Promise<ToolRuntimeState> {
  const capabilities = detectBrowserToolCapabilities();
  const artifactStore = await createToolArtifactStore();
  const context = { capabilities, store: artifactStore };
  return {
    capabilities,
    artifactStoreKind: artifactStore.kind,
    adapters: toolAdapters.map((adapter) => adapter.capability({ adapters: ["mock", "browser", "cloud", "desktop"] } as ToolCapabilityDefinition, context)),
    diagnostics: [
      ...browserCapabilityDiagnostics(capabilities),
      {
        level: "info",
        code: "ARTIFACT_STORE",
        message:
          artifactStore.kind === "opfs"
            ? "Tool artifacts will be stored in OPFS when generated."
            : "Tool artifacts will use memory fallback until OPFS is available."
      }
    ]
  };
}

export async function runToolAdapter(options: RunToolOptions): Promise<ToolRunController> {
  const store = await createToolArtifactStore();
  const capabilities = detectBrowserToolCapabilities();
  const adapterType = options.adapterType ?? pickDefaultToolAdapter(options.tool);
  const adapter = toolAdapters.find((candidate) => candidate.type === adapterType);
  const context = { capabilities, store };
  const capability = adapter?.capability(options.tool, context);

  if (!adapter || capability?.status === "unavailable" || !options.tool.adapters.includes(adapterType)) {
    return runUnavailableAdapter(options, adapterType);
  }

  return adapter.run(options, context);
}

export async function runMockBrowserTool(options: RunToolOptions): Promise<ToolRunController> {
  return runToolAdapter({ ...options, adapterType: "mock" });
}

function runProgressiveArtifactAdapter(
  options: RunToolOptions,
  context: ToolAdapterContext,
  adapterType: ToolAdapterType,
  config: {
    tickSize: number;
    tickMs: number;
    diagnostic: ToolDiagnostic;
    source: string;
  }
): ToolRunController {
  const startedAt = new Date().toISOString();
  let cancelled = false;
  let tick = 0;
  const stageCount = Math.max(1, options.tool.stages.length);
  const invocation = createToolAdapterInvocation({
    tool: options.tool,
    adapter: adapterType,
    run: options.run,
    costPolicy: "metadataOnly",
    now: startedAt
  });
  const baseRun: ToolRun = {
    ...(options.run ?? createMockToolRun(options.tool, startedAt)),
    status: "running",
    progress: 1,
    stage: options.tool.stages[0] ?? "upload",
    params: {
      ...(options.run?.params ?? {}),
      adapter: adapterType,
      invocationId: invocation.id,
      costPolicy: invocation.costPolicy
    },
    updatedAt: startedAt
  };

  options.onUpdate(baseRun);

  const intervalId = window.setInterval(async () => {
    if (cancelled) {
      return;
    }

    tick += 1;
    const progress = Math.min(100, tick * config.tickSize);
    const stageIndex = Math.min(stageCount - 1, Math.floor((progress / 100) * stageCount));
    const stage = options.tool.stages[stageIndex] ?? options.tool.stages[stageCount - 1] ?? "upload";
    const completed = progress >= 100;
    const artifacts = completed ? await createMockArtifacts(options.tool, baseRun.id, context.store, config.source, adapterType) : baseRun.artifacts;
    const nextRun: ToolRun = {
      ...baseRun,
      status: completed ? "completed" : "running",
      progress,
      stage,
      artifacts,
      diagnostics: [
        ...baseRun.diagnostics,
        config.diagnostic
      ],
      updatedAt: new Date().toISOString()
    };

    options.onUpdate(nextRun);

    if (completed) {
      window.clearInterval(intervalId);
    }
  }, config.tickMs);

  return {
    cancel: () => {
      cancelled = true;
      window.clearInterval(intervalId);
      options.onUpdate({
        ...baseRun,
        status: "cancelled",
        diagnostics: [
          ...baseRun.diagnostics,
          {
            level: "warning",
            code: "TOOL_RUN_CANCELLED",
            message: "Tool run cancelled before artifacts were generated."
          }
        ],
        updatedAt: new Date().toISOString()
      });
    }
  };
}

function runQueuedCloudAdapter(options: RunToolOptions, context: ToolAdapterContext, adapterType: ToolAdapterType): ToolRunController {
  const startedAt = new Date().toISOString();
  let cancelled = false;
  const invocation = createToolAdapterInvocation({
    tool: options.tool,
    adapter: adapterType,
    run: options.run,
    costPolicy: "metadataOnly",
    now: startedAt
  });
  const baseRun: ToolRun = {
    ...(options.run ?? createMockToolRun(options.tool, startedAt)),
    status: "queued",
    progress: 0,
    stage: options.tool.stages[0] ?? "upload",
    params: {
      ...(options.run?.params ?? {}),
      adapter: adapterType,
      invocationId: invocation.id,
      costPolicy: invocation.costPolicy
    },
    diagnostics: [
      ...(options.run?.diagnostics ?? []),
      cloudAdapterDiagnostic(options.tool)
    ],
    updatedAt: startedAt
  };

  options.onUpdate(baseRun);

  const timeoutId = window.setTimeout(async () => {
    if (cancelled) {
      return;
    }

    const artifacts = await createMockArtifacts(options.tool, baseRun.id, context.store, "cloud-contract-adapter", adapterType);
    options.onUpdate({
      ...baseRun,
      status: "completed",
      progress: 100,
      stage: options.tool.stages.at(-1) ?? baseRun.stage,
      artifacts,
      diagnostics: [
        ...baseRun.diagnostics,
        {
          level: "info",
          code: "CLOUD_CONTRACT_COMPLETED",
          message: "Cloud adapter contract completed with schema-compatible placeholder artifacts. Real AI service wiring can replace this adapter."
        }
      ],
      updatedAt: new Date().toISOString()
    });
  }, 720);

  return {
    cancel: () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
      options.onUpdate({
        ...baseRun,
        status: "cancelled",
        diagnostics: [
          ...baseRun.diagnostics,
          {
            level: "warning",
            code: "TOOL_RUN_CANCELLED",
            message: "Tool run cancelled before cloud hand-off completed."
          }
        ],
        updatedAt: new Date().toISOString()
      });
    }
  };
}

function runUnavailableAdapter(options: RunToolOptions, adapterType: ToolAdapterType): ToolRunController {
  const now = new Date().toISOString();
  const baseRun = options.run ?? createMockToolRun(options.tool, now);
  options.onUpdate({
    ...baseRun,
    status: "failed",
    progress: 0,
    diagnostics: [...baseRun.diagnostics, createAdapterUnavailableDiagnostic(adapterType)],
    updatedAt: now
  });
  return {
    cancel: () => undefined
  };
}

async function createMockArtifacts(
  tool: ToolCapabilityDefinition,
  runId: string,
  store: ToolArtifactStore,
  source: string,
  adapterType: ToolAdapterType
): Promise<ToolArtifact[]> {
  const artifacts: ToolArtifact[] = [];

  for (const [index, type] of tool.outputs.slice(0, 3).entries()) {
    const artifact = await store.put({
      id: `artifact_${adapterType}_${tool.slug}_${type}`,
      type,
      metadata: {
        runId,
        adapter: adapterType,
        source,
        order: index + 1,
        editable: true
      }
    });
    artifacts.push(artifact);
  }

  return artifacts;
}

function cloudAdapterDiagnostic(tool: ToolCapabilityDefinition): ToolDiagnostic {
  if (tool.outputs.includes("transcript") || tool.outputs.includes("captionTrack")) {
    return {
      level: "info",
      code: "CLOUD_TRANSCRIPTION_ADAPTER",
      message: "Cloud transcription adapter contract queued. It will later call speech-to-text and return transcript/caption artifacts."
    };
  }
  if (tool.outputs.includes("maskSequence") || tool.outputs.includes("alphaClip")) {
    return {
      level: "info",
      code: "CLOUD_SEGMENTATION_ADAPTER",
      message: "Cloud segmentation adapter contract queued. It will later return mask, alpha, and subject artifacts."
    };
  }
  if (tool.outputs.includes("trackingPath") || tool.outputs.includes("subjectBounds")) {
    return {
      level: "info",
      code: "CLOUD_TRACKING_ADAPTER",
      message: "Cloud tracking adapter contract queued. It will later return subject/object tracking artifacts."
    };
  }
  return {
    level: "info",
    code: "CLOUD_TOOL_ADAPTER",
    message: "Cloud tool adapter contract queued."
  };
}

const toolAdapters: WebToolAdapter[] = [
  {
    type: "mock",
    capability: () => ({
      type: "mock",
      status: "ready",
      label: "Mock",
      description: "Fast schema-compatible adapter for product flows and UI testing.",
      diagnostics: []
    }),
    run: async (options, context) =>
      runProgressiveArtifactAdapter(options, context, "mock", {
        tickSize: 8,
        tickMs: 260,
        source: "mock-browser-runtime",
        diagnostic: {
          level: "info",
          code: "MOCK_ADAPTER",
          message: "Mock adapter completed the tool contract without heavy AI processing."
        }
      })
  },
  {
    type: "browser",
    capability: (tool, context) => {
      const unavailable = !context.capabilities.webWorkers && tool.browserMode !== "instant";
      return {
        type: "browser",
        status: unavailable ? "unavailable" : "available",
        label: "Browser",
        description: "Runs browser-friendly tool work locally with workers/proxy artifacts where possible.",
        diagnostics: unavailable
          ? [
              {
                level: "error",
                code: "BROWSER_ADAPTER_NEEDS_WORKERS",
                message: "Browser adapter needs Web Workers for progressive and heavy tools."
              }
            ]
          : []
      };
    },
    run: async (options, context) =>
      runProgressiveArtifactAdapter(options, context, "browser", {
        tickSize: options.tool.browserMode === "heavy" ? 5 : 10,
        tickMs: options.tool.browserMode === "heavy" ? 320 : 220,
        source: "browser-contract-adapter",
        diagnostic: {
          level: "info",
          code: "BROWSER_ADAPTER",
          message: "Browser adapter contract completed with local/proxy artifacts."
        }
      })
  },
  {
    type: "cloud",
    capability: () => ({
      type: "cloud",
      status: "available",
      label: "Cloud",
      description: "Queues transcription, segmentation, and tracking work against the shared artifact contract.",
      diagnostics: [
        {
          level: "info",
          code: "CLOUD_CONTRACT_ONLY",
          message: "Cloud adapter is contract-only in dev; credits are metadata and not enforced."
        }
      ]
    }),
    run: async (options, context) => runQueuedCloudAdapter(options, context, "cloud")
  },
  {
    type: "desktop",
    capability: () => ({
      type: "desktop",
      status: "planned",
      label: "Desktop",
      description: "Future local renderer/AI adapter that consumes the same manifest and artifacts.",
      diagnostics: []
    }),
    run: async (options) => runUnavailableAdapter(options, "desktop")
  }
];

export function currentStageIndex(stages: ToolStage[], stage: ToolStage) {
  return Math.max(0, stages.indexOf(stage));
}
