import type { SourceAsset, TimelineComposition, TimelineLayer, ToolCapabilityDefinition } from "@reelforge/shared";
import { useLayerToolEffectRunner } from "../tools/useLayerToolEffectRunner";
import { AiActivityIndicator } from "./AiActivityIndicator";
import { Button } from "./Button";
import { Modal } from "./Modal";

/**
 * Generic "run a ready AI tool against the selected layer" popup. Carries no
 * tool-specific logic itself - it drives the shared useLayerToolEffectRunner
 * hook, which resolves whatever handler is registered for `tool.slug` in
 * layer-effect-handlers.ts, so new ready tools never need changes here.
 */
export function ToolEffectRunnerModal({
  tool,
  layer,
  asset,
  composition,
  onApplied,
  onClose
}: {
  tool: ToolCapabilityDefinition;
  layer: TimelineLayer;
  asset: SourceAsset;
  composition: TimelineComposition;
  onApplied: (nextComposition: TimelineComposition) => void;
  onClose: () => void;
}) {
  const runner = useLayerToolEffectRunner({ tool, layer, asset, composition, onApplied });
  const { status, running, error, optionFields, selectedOptions, setOption } = runner;

  function handleCancel() {
    runner.cancel();
    onClose();
  }

  return (
    <Modal title={tool.name} open onClose={handleCancel}>
      <div className="tool-effect-runner">
        <p>{tool.shortDescription}</p>
        {optionFields.map((field) => (
          <div className="tool-effect-runner-option" key={field.key}>
            <span className="tool-effect-runner-option-label">{field.label}</span>
            <div className="tool-effect-runner-option-choices">
              {field.choices.map((choice) => (
                <button
                  key={choice.value}
                  type="button"
                  className={selectedOptions[field.key] === choice.value ? "is-active" : ""}
                  title={choice.description}
                  disabled={running}
                  onClick={() => setOption(field.key, choice.value)}
                >
                  {choice.label}
                </button>
              ))}
            </div>
          </div>
        ))}
        {running ? (
          <div className="tool-effect-runner-progress">
            <AiActivityIndicator label={status} />
            <div className="tool-effect-runner-bar" role="progressbar" aria-label={status}>
              <span />
            </div>
          </div>
        ) : (
          <p className="tool-effect-runner-status">{error ?? status}</p>
        )}
        <div className="tool-effect-runner-actions">
          <Button variant="ghost" onClick={handleCancel}>
            {running ? "Cancel" : "Close"}
          </Button>
          <Button variant="primary" disabled={running} onClick={() => void runner.run()}>
            {running ? "Running..." : "Run"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
