import { useMemo, useRef, useState } from "react";
import {
  getSkillTaskForToolSlug,
  resolveExecutors,
  type SourceAsset,
  type TimelineComposition,
  type TimelineLayer,
  type ToolCapabilityDefinition
} from "@orreris/shared";
import { currentExecutorAvailability } from "./executor-availability";
import { getLayerToolEffectHandler, type LayerToolEffectOptionField } from "./layer-effect-handlers";

/**
 * Single source of truth for running a "ready" AI tool against a timeline layer:
 * resolve the registered handler (layer-effect-handlers.ts), drive its
 * run → progress → cancel → applyResult lifecycle, and surface UI-ready state.
 *
 * Both editor surfaces should consume this hook so a tool is wired exactly once:
 * the editor's `ToolEffectRunnerModal` uses it today; the multi-stage
 * `/tools/:slug` page is the next migration target (its bespoke per-tool "Apply"
 * logic should call the same handler contract instead of re-implementing it).
 * Anything tool-specific lives in the handler, never in the surface.
 */
export interface LayerToolEffectRunnerState {
  status: string;
  running: boolean;
  error: string | undefined;
  hasHandler: boolean;
  optionFields: LayerToolEffectOptionField[];
  selectedOptions: Record<string, string>;
  setOption: (key: string, value: string) => void;
  /**
   * `optionOverrides` merge over the user's selected options for this one call —
   * how a surface models multi-stage flows (e.g. the tools page's fast preview vs
   * high-quality bake buttons both drive the same extract-person handler).
   */
  run: (optionOverrides?: Record<string, string>) => Promise<void>;
  cancel: () => void;
}

/**
 * Executor-availability gate shared by every tool surface (this hook + the
 * /tools page's direct handler runs): returns the user-facing blocker message,
 * or undefined when the tool can run on this device.
 */
export function assertToolRunnable(toolSlug: string, toolName: string): string | undefined {
  const task = getSkillTaskForToolSlug(toolSlug);
  if (!task) {
    return undefined;
  }
  const ranked = resolveExecutors({ taskKind: task.id }, currentExecutorAvailability(), "localFirst");
  const best = ranked[0];
  if (!best || best.executor.kind !== "browser-real") {
    return `This device can't run ${toolName} locally (Web Workers unavailable), and cloud isn't enabled yet.`;
  }
  return undefined;
}

export function useLayerToolEffectRunner({
  tool,
  layer,
  asset,
  composition,
  editableFields,
  onApplied
}: {
  tool: ToolCapabilityDefinition;
  layer: TimelineLayer;
  asset: SourceAsset;
  composition: TimelineComposition;
  /** The project graph's durable per-tool artifacts — feeds the cross-tool mask-reuse lookup. */
  editableFields?: Record<string, unknown> | undefined;
  /**
   * `editableFieldsPatch` (from the handler's describeEditableFields) is the durable
   * artifact patch — masks/tracking — the surface should merge into
   * `projectGraph.editableFields` alongside the composition so later sessions (and
   * the reuse lookup) can find them. Undefined when the handler has none.
   */
  onApplied: (nextComposition: TimelineComposition, editableFieldsPatch?: Record<string, unknown>) => void;
}): LayerToolEffectRunnerState {
  const handler = useMemo(() => getLayerToolEffectHandler(tool.slug), [tool.slug]);
  const optionFields = handler?.optionFields ?? [];
  const [status, setStatus] = useState(`Apply ${tool.name} to "${layer.name}"?`);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [selectedOptions, setSelectedOptions] = useState<Record<string, string>>(() =>
    Object.fromEntries(optionFields.map((field) => [field.key, field.defaultValue]))
  );
  const cancelledRef = useRef(false);

  const setOption = (key: string, value: string) => setSelectedOptions((current) => ({ ...current, [key]: value }));

  async function run(optionOverrides?: Record<string, string>) {
    if (!handler) {
      setError(`No runner is registered for ${tool.name} yet.`);
      return;
    }
    const blocker = assertToolRunnable(tool.slug, tool.name);
    if (blocker) {
      setError(blocker);
      return;
    }
    const runOptions = optionOverrides ? { ...selectedOptions, ...optionOverrides } : selectedOptions;
    setRunning(true);
    setError(undefined);
    cancelledRef.current = false;
    try {
      const result = await handler.run({
        asset,
        layer,
        fps: composition.fps,
        composition,
        editableFields,
        options: runOptions,
        onProgress: (message) => {
          if (!cancelledRef.current) {
            setStatus(message);
          }
        },
        isCancelled: () => cancelledRef.current
      });
      if (cancelledRef.current) {
        return;
      }
      setStatus("Applying result to the timeline...");
      const applyArgs = { composition, layer, asset, result, options: runOptions };
      onApplied(handler.applyResult(applyArgs), handler.describeEditableFields?.(applyArgs));
    } catch (caught) {
      if (cancelledRef.current) {
        return;
      }
      setError(caught instanceof Error ? caught.message : `${tool.name} failed.`);
    } finally {
      if (!cancelledRef.current) {
        setRunning(false);
      }
    }
  }

  function cancel() {
    cancelledRef.current = true;
  }

  return {
    status,
    running,
    error,
    hasHandler: Boolean(handler),
    optionFields,
    selectedOptions,
    setOption,
    run,
    cancel
  };
}
