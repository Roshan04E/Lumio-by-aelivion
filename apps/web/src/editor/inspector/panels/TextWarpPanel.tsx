import { AlertTriangle, MoveHorizontal, MoveVertical, Spline } from "lucide-react";
import { defaultTextWarp, detectTextScript, getCompositionTextRuns, type TextWarp, type TextWarpStyle } from "@orreris/shared";
import type { InspectorPanelProps } from "../../registry/inspector";
import { NumberControl } from "../controls/NumberControl";
import { ThemedSelect } from "../controls/ThemedSelect";

/**
 * Text warp inspector panel — the first panel migrated out of the EditorPage
 * monolith into a registered, lazy-loaded inspector module (Phase 4). Same UI
 * and behavior as before; it now lives behind `inspectorRegistry` and is loaded
 * only when a text layer is selected.
 */
const textWarpStyleOptions: Array<{ value: TextWarpStyle; label: string }> = [
  { value: "none", label: "None" },
  { value: "arc", label: "Arc" },
  { value: "arcLower", label: "Arc Lower" },
  { value: "arch", label: "Arch" },
  { value: "bulge", label: "Bulge / Lens" },
  { value: "wave", label: "Wave" },
  { value: "flag", label: "Flag" },
  { value: "fisheye", label: "Fisheye" }
];

export default function TextWarpPanel({ layer, onChange }: InspectorPanelProps) {
  const warp = layer.textWarp ?? defaultTextWarp;
  const isActive = warp.style !== "none";
  // S0 / ADR-023 T-12 (INTERIM): warp's outline engine does glyph lookup, not shaping, so it is
  // suppressed for scripts that need shaping. Say so HERE, where warp is controlled — the incident
  // this guards against (`font-outlines.ts:45-50`) was a wrong render nobody could see was wrong.
  const shapingBlocked = detectTextScript(getCompositionTextRuns(layer).map((run) => run.text).join("")).shapingDependent;

  function updateWarp(patch: Partial<TextWarp>) {
    onChange((item) => ({ ...item, textWarp: { ...(item.textWarp ?? defaultTextWarp), ...patch } }));
  }

  return (
    <div className="graphic-controls">
      {shapingBlocked ? (
        <p className="warp-shaping-notice" role="status" data-testid="warp-shaping-notice">
          <AlertTriangle size={14} aria-hidden="true" />
          <span>
            Warp is unavailable for this text. It uses a script that needs shaping (Arabic, Hebrew, Devanagari, Thai and
            similar), which the warp engine cannot lay out correctly yet — so it renders unwarped rather than with the
            wrong letters.
          </span>
        </p>
      ) : null}
      <label className="number-row-select">
        <span className="effect-slider-label">
          <span className="control-icon">
            <Spline size={14} />
          </span>
          <span className="effect-slider-label-text">Style</span>
        </span>
        <ThemedSelect
          ariaLabel="Warp style"
          value={warp.style}
          options={textWarpStyleOptions}
          onChange={(style) => updateWarp({ style: style as TextWarpStyle, bend: warp.bend || 50 })}
        />
      </label>
      {isActive ? (
        <div className="icon-control-row">
          <NumberControl
            icon={<Spline size={14} />}
            label="Bend"
            value={warp.bend}
            min={-100}
            max={100}
            step={1}
            onReset={() => updateWarp({ bend: defaultTextWarp.bend })}
            onChange={(value) => updateWarp({ bend: value })}
          />
          <NumberControl
            icon={<MoveHorizontal size={14} />}
            label="Distort H"
            value={warp.distortH}
            min={-100}
            max={100}
            step={1}
            onReset={() => updateWarp({ distortH: defaultTextWarp.distortH })}
            onChange={(value) => updateWarp({ distortH: value })}
          />
          <NumberControl
            icon={<MoveVertical size={14} />}
            label="Distort V"
            value={warp.distortV}
            min={-100}
            max={100}
            step={1}
            onReset={() => updateWarp({ distortV: defaultTextWarp.distortV })}
            onChange={(value) => updateWarp({ distortV: value })}
          />
        </div>
      ) : null}
    </div>
  );
}
