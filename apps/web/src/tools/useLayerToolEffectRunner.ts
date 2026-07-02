import { useMemo, useRef, useState } from "react";
import type { SourceAsset, TimelineComposition, TimelineLayer, ToolCapabilityDefinition } from "@lumio-by-aelivion/shared";
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
  run: () => Promise<void>;
  cancel: () => void;
}

export function useLayerToolEffectRunner({
  tool,
  layer,
  asset,
  composition,
  onApplied
}: {
  tool: ToolCapabilityDefinition;
  layer: TimelineLayer;
  asset: SourceAsset;
  composition: TimelineComposition;
  onApplied: (nextComposition: TimelineComposition) => void;
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

  async function run() {
    if (!handler) {
      setError(`No runner is registered for ${tool.name} yet.`);
      return;
    }
    setRunning(true);
    setError(undefined);
    cancelledRef.current = false;
    try {
      const result = await handler.run({
        asset,
        layer,
        fps: composition.fps,
        options: selectedOptions,
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
      onApplied(handler.applyResult({ composition, layer, asset, result, options: selectedOptions }));
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
