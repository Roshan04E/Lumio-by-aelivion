import { RotateCcw } from "lucide-react";

export function ResetButton({ onReset }: { onReset: () => void }) {
  return (
    <button
      className="control-reset-button"
      type="button"
      title="Reset"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onReset();
      }}
    >
      <RotateCcw size={11} />
    </button>
  );
}
