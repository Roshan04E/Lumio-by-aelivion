/**
 * Professional Color System (Phase 3, 13C.4) — .cube LUT file import control.
 *
 * Renders a styled file-picker button. On selection, parses the .cube file via
 * `parseCubeFile` and serialises the result to base64 via `lut3dToBase64`. The
 * serialised string is stored in the `importedLut` effect param and deserialised
 * by `composition-style.ts → getCompositionColorPipeline` at render time.
 *
 * Shows filename + an error badge on parse failure; shows "No LUT" + Import button
 * when the param value is empty.
 */

import { useRef, useState } from "react";
import { Upload, X } from "lucide-react";
import { lut3dToBase64, parseCubeFile } from "@reelforge/shared";

interface Props {
  value: string;
  onChange: (value: string) => void;
}

export function LutFileImport({ value, onChange }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [filename, setFilename] = useState<string | null>(null);

  // Detect whether there's already a loaded LUT (non-empty base64 string)
  const hasLut = value.length > 3 && value.includes(":");

  function handleFile(file: File) {
    if (!file.name.toLowerCase().endsWith(".cube")) {
      setError("Only .cube files are supported.");
      return;
    }
    setFilename(file.name);
    const reader = new FileReader();
    reader.onload = (evt) => {
      const text = evt.target?.result as string;
      const result = parseCubeFile(text);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      onChange(lut3dToBase64(result.lut));
    };
    reader.readAsText(file);
  }

  function handleInputChange(evt: React.ChangeEvent<HTMLInputElement>) {
    const file = evt.target.files?.[0];
    if (file) handleFile(file);
    // Reset so the same file can be re-selected if the user clears and re-opens
    evt.target.value = "";
  }

  function handleClear() {
    setFilename(null);
    setError(null);
    onChange("");
  }

  function handleDrop(evt: React.DragEvent) {
    evt.preventDefault();
    const file = evt.dataTransfer.files?.[0];
    if (file) handleFile(file);
  }

  return (
    <div
      className="lut-import"
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDrop}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".cube"
        style={{ display: "none" }}
        onChange={handleInputChange}
      />

      {hasLut ? (
        <div className="lut-import-loaded">
          <span className="lut-import-name" title={filename ?? "LUT loaded"}>
            {filename ?? "LUT loaded"}
          </span>
          <button
            className="lut-import-btn lut-import-btn--swap"
            type="button"
            onClick={() => inputRef.current?.click()}
            title="Replace LUT"
          >
            <Upload size={12} />
            Replace
          </button>
          <button
            className="lut-import-btn lut-import-btn--clear"
            type="button"
            onClick={handleClear}
            title="Remove LUT"
          >
            <X size={12} />
          </button>
        </div>
      ) : (
        <button
          className="lut-import-btn lut-import-btn--primary"
          type="button"
          onClick={() => inputRef.current?.click()}
        >
          <Upload size={13} />
          Import .cube LUT
        </button>
      )}

      {error && <p className="lut-import-error">{error}</p>}
    </div>
  );
}
