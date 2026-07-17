import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  getTransition,
  resolveSpecParams,
  type TransitionDirection,
  type TransitionParam,
  type TransitionSpec,
} from "@kimera-by-aelivion/shared";
import { ThemedSelect, type ThemedSelectOption } from "../editor/inspector/controls/ThemedSelect";

/**
 * Junction transition parameter popover — opened by a motionless click on the on-timeline transition
 * element (drag still resizes duration, double-click still removes; see finishCrossDrag in
 * TimelineStrip). Controls are SCHEMA-DRIVEN off `getTransition(kind).params` (registry-driven, never a
 * switch on kind — plugin transitions get their params for free).
 *
 * PERF DOCTRINE (timeline strip): all scrub-time state is a local draft here — slider drags never
 * re-render TimelineStrip. Commits go through `onApply` (→ the shared applyJunctionTransition, one undo
 * step) only on release/change, mirroring the strip's commit-on-release gestures.
 *
 * Legacy-field folding: `direction`/`mode`/`softness`/`color` on the spec fold into named registry
 * params at render time (see composition-style's transitionOverrides). Where a def declares one of those
 * params, the popover edits the TOP-LEVEL spec field (and clears any raw param override) so specs stay
 * legible/serializable; only params with no legacy twin get raw `spec.params[name]` rows.
 */

interface JunctionTransitionPopoverProps {
  spec: TransitionSpec;
  leftDurationSeconds: number;
  rightDurationSeconds: number;
  frameStepSeconds: number;
  /** Pointer position of the opening click — the panel is clamped into the viewport from here. */
  anchor: { x: number; y: number };
  onApply: (spec: TransitionSpec) => void;
  onRemove: () => void;
  onClose: () => void;
}

const DIRECTION_OPTIONS: ThemedSelectOption<TransitionDirection>[] = [
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
  { value: "up", label: "Up" },
  { value: "down", label: "Down" },
];

const MODE_OPTIONS: ThemedSelectOption<"in" | "out">[] = [
  { value: "in", label: "In" },
  { value: "out", label: "Out" },
];

const ALIGNMENT_OPTIONS: ThemedSelectOption<NonNullable<TransitionSpec["alignment"]>>[] = [
  { value: "auto", label: "Auto (recommended)" },
  { value: "center", label: "Center at cut" },
  { value: "start", label: "Start at cut" },
  { value: "end", label: "End at cut" },
];

/** Color params covered by the top-level `spec.color` legacy field (transitionOverrides fold). */
const LEGACY_COLOR_PARAMS = new Set(["dipColor", "flashColor", "leakColor"]);

function rgb01ToHex(rgb: number[]): string {
  const channel = (v: number) =>
    Math.max(0, Math.min(255, Math.round((v ?? 0) * 255)))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(rgb[0] ?? 0)}${channel(rgb[1] ?? 0)}${channel(rgb[2] ?? 0)}`;
}

function hexToRgb01(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  const int = Number.parseInt(full, 16);
  if (!Number.isFinite(int)) return [0, 0, 0];
  return [((int >> 16) & 255) / 255, ((int >> 8) & 255) / 255, (int & 255) / 255];
}

/** Strip a raw param override so the top-level legacy field wins the fold again. */
function withoutParam(params: TransitionSpec["params"], name: string): TransitionSpec["params"] {
  if (!params || params[name] === undefined) return params;
  const next = { ...params };
  delete next[name];
  return Object.keys(next).length > 0 ? next : undefined;
}

export function JunctionTransitionPopover({
  spec,
  leftDurationSeconds,
  rightDurationSeconds,
  frameStepSeconds,
  anchor,
  onApply,
  onRemove,
  onClose,
}: JunctionTransitionPopoverProps) {
  const def = getTransition(spec.kind);
  const [draft, setDraft] = useState<TransitionSpec>(spec);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // External change (another commit landed, undo, tile drop) → re-seed the draft.
  useEffect(() => {
    setDraft(spec);
  }, [spec]);

  // Viewport clamp — same pattern as the strip's clip context menu (measure after mount, then show).
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [panelPos, setPanelPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 8;
    setPanelPos({
      left: Math.max(margin, Math.min(anchor.x, window.innerWidth - rect.width - margin)),
      top: Math.max(margin, Math.min(anchor.y + 6, window.innerHeight - rect.height - margin)),
    });
  }, [anchor.x, anchor.y]);

  if (!def) return null;

  const resolved = resolveSpecParams(def, draft);
  const maxDuration = Math.max(frameStepSeconds, Math.min(leftDurationSeconds, rightDurationSeconds));

  /** Commit the current draft (one undo step). Called on release/change, never per input event. */
  function commit(next?: TransitionSpec) {
    const value = next ?? draftRef.current;
    setDraft(value);
    onApply(value);
  }

  function setDurationDraft(value: number) {
    const clamped = Math.max(frameStepSeconds, Math.min(maxDuration, value));
    setDraft((current) => ({ ...current, durationSeconds: clamped }));
  }

  /** A param covered by a top-level legacy spec field renders that field's control instead of a raw row. */
  function renderParamRow(param: TransitionParam) {
    if (param.name === "direction") {
      return (
        <div className="junction-popover-row" key={param.name}>
          <span className="junction-popover-label">{param.label ?? "Direction"}</span>
          <ThemedSelect
            value={draft.direction ?? "right"}
            options={DIRECTION_OPTIONS}
            ariaLabel="Transition direction"
            onChange={(direction) =>
              commit({ ...draftRef.current, direction, params: withoutParam(draftRef.current.params, "direction") })
            }
          />
        </div>
      );
    }
    if (param.name === "reverse" && param.type === "bool") {
      return (
        <div className="junction-popover-row" key={param.name}>
          <span className="junction-popover-label">{param.label ?? "Mode"}</span>
          <ThemedSelect
            value={draft.mode ?? "in"}
            options={MODE_OPTIONS}
            ariaLabel="Transition mode"
            onChange={(mode) =>
              commit({ ...draftRef.current, mode, params: withoutParam(draftRef.current.params, "reverse") })
            }
          />
        </div>
      );
    }
    if (param.name === "softness" && param.type === "float") {
      const value = typeof resolved.softness === "number" ? resolved.softness : param.default as number;
      return renderFloatRow(param, value, (softness) => ({
        ...draftRef.current,
        softness,
        params: withoutParam(draftRef.current.params, "softness"),
      }));
    }
    if (param.type === "vec3" && LEGACY_COLOR_PARAMS.has(param.name)) {
      const raw = resolved[param.name];
      const hex = draft.color ?? (Array.isArray(raw) ? rgb01ToHex(raw) : "#000000");
      return (
        <div className="junction-popover-row" key={param.name}>
          <span className="junction-popover-label">{param.label ?? "Color"}</span>
          <input
            type="color"
            value={hex}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                color: event.target.value,
                params: withoutParam(current.params, param.name),
              }))
            }
            onBlur={() => commit()}
          />
        </div>
      );
    }
    if (param.type === "float") {
      const raw = resolved[param.name];
      const value = typeof raw === "number" ? raw : (param.default as number);
      return renderFloatRow(param, value, (next) => ({
        ...draftRef.current,
        params: { ...(draftRef.current.params ?? {}), [param.name]: next },
      }));
    }
    if (param.type === "bool") {
      const checked = Boolean(resolved[param.name]);
      return (
        <label className="junction-popover-row" key={param.name}>
          <span className="junction-popover-label">{param.label ?? param.name}</span>
          <input
            type="checkbox"
            checked={checked}
            onChange={(event) =>
              commit({
                ...draftRef.current,
                params: { ...(draftRef.current.params ?? {}), [param.name]: event.target.checked },
              })
            }
          />
        </label>
      );
    }
    if (param.type === "vec3") {
      const raw = resolved[param.name];
      const hex = Array.isArray(raw) ? rgb01ToHex(raw) : "#000000";
      return (
        <div className="junction-popover-row" key={param.name}>
          <span className="junction-popover-label">{param.label ?? param.name}</span>
          <input
            type="color"
            value={hex}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                params: { ...(current.params ?? {}), [param.name]: hexToRgb01(event.target.value) },
              }))
            }
            onBlur={() => commit()}
          />
        </div>
      );
    }
    // vec2 params other than the legacy-folded `direction` have no matching control yet (same gap as
    // buildPluginShaderParamDefinitions) — skip rather than expose a raw vector.
    return null;
  }

  function renderFloatRow(param: TransitionParam, value: number, build: (next: number) => TransitionSpec) {
    const min = param.min ?? 0;
    const max = param.max ?? 1;
    const step = param.step ?? 0.01;
    return (
      <div className="junction-popover-row" key={param.name}>
        <span className="junction-popover-label">{param.label ?? param.name}</span>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => setDraft(build(Number(event.target.value)))}
          onPointerUp={() => commit()}
          onKeyUp={(event) => {
            if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "ArrowUp" || event.key === "ArrowDown") {
              commit();
            }
          }}
        />
        <input
          type="number"
          className="junction-popover-number"
          min={min}
          max={max}
          step={step}
          value={Number(value.toFixed(3))}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (Number.isFinite(next)) setDraft(build(Math.max(min, Math.min(max, next))));
          }}
          onBlur={() => commit()}
        />
      </div>
    );
  }

  return (
    <div
      className="timeline-context-backdrop"
      onClick={() => {
        // Outside click: commit a dirty draft (a slider left mid-scrub) before closing. Content
        // compare, not identity — a just-committed draft is a different object with equal content,
        // and re-applying it would push a no-op undo step.
        if (JSON.stringify(draftRef.current) !== JSON.stringify(spec)) {
          onApply(draftRef.current);
        }
        onClose();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div
        ref={panelRef}
        className="timeline-junction-popover"
        style={{
          left: `${panelPos?.left ?? anchor.x}px`,
          top: `${panelPos?.top ?? anchor.y}px`,
          visibility: panelPos ? "visible" : "hidden",
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="junction-popover-head">
          <span className="junction-popover-title">{def.name}</span>
          <span className="junction-popover-kind">{def.category}</span>
        </div>
        <div className="junction-popover-row">
          <span className="junction-popover-label">Duration</span>
          <input
            type="range"
            min={frameStepSeconds}
            max={maxDuration}
            step={frameStepSeconds}
            value={Math.min(draft.durationSeconds, maxDuration)}
            onChange={(event) => setDurationDraft(Number(event.target.value))}
            onPointerUp={() => commit()}
            onKeyUp={(event) => {
              if (event.key.startsWith("Arrow")) commit();
            }}
          />
          <input
            type="number"
            className="junction-popover-number"
            min={frameStepSeconds}
            max={maxDuration}
            step={frameStepSeconds}
            value={Number(draft.durationSeconds.toFixed(2))}
            onChange={(event) => {
              const next = Number(event.target.value);
              if (Number.isFinite(next)) setDurationDraft(next);
            }}
            onBlur={() => commit()}
          />
          <span className="junction-popover-unit">s</span>
        </div>
        <div className="junction-popover-row">
          <span className="junction-popover-label">Alignment</span>
          <ThemedSelect
            value={draft.alignment ?? "auto"}
            options={ALIGNMENT_OPTIONS}
            ariaLabel="Transition alignment"
            onChange={(alignment) => commit({ ...draftRef.current, alignment })}
          />
        </div>
        {def.params.map(renderParamRow)}
        <div className="junction-popover-foot">
          <button
            type="button"
            className="junction-popover-remove"
            onClick={() => {
              onRemove();
            }}
          >
            Remove transition
          </button>
        </div>
      </div>
    </div>
  );
}
