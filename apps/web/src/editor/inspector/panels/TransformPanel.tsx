import {
  Box,
  Crosshair,
  Diamond,
  Eye,
  Maximize2,
  Move,
  Rotate3d,
  RotateCw,
  SlidersHorizontal,
  Sparkles
} from "lucide-react";
import {
  evaluateTimelineTransform,
  getLayerAnimations,
  type BlendMode,
  type KeyframeInterpolation
} from "@kimera-by-aelivion/shared";
import { ScrubNumberInput } from "../../../components/ScrubNumberInput";

// ── Perspective control mapping ─────────────────────────────────────────────────────────────────────
// All renderers store CSS `perspective(N px)`, where a SMALLER N = STRONGER 3D foreshortening (it's a camera
// DISTANCE) and N=0 = flat (omitted). Correct, but counter-intuitive as a control: a raw 0→4000 px slider
// feels inverted (more value = flatter) AND jumps flat→extreme the instant it leaves 0. So the inspector
// exposes a monotonic "depth" 0..100 (0 = flat → 100 = strongest tilt) and converts to/from the stored px
// here — the stored `transform.perspective` field, the three renderers, and keyframes are all unchanged.
const PERSPECTIVE_DEPTH_MAX = 100;
const PERSPECTIVE_PX_FLAT = 4000; // near-flat (camera far) — the depth just above 0
const PERSPECTIVE_PX_STRONG = 350; // strongest tilt (camera close) — depth = max

/** Stored CSS-perspective px → display depth 0..100 (0 = flat). Inverse of {@link perspectiveDepthToPx}. */
function perspectivePxToDepth(px: number): number {
  if (!(px > 0)) return 0;
  const d = (PERSPECTIVE_DEPTH_MAX * (PERSPECTIVE_PX_FLAT - px)) / (PERSPECTIVE_PX_FLAT - PERSPECTIVE_PX_STRONG);
  return Math.round(Math.max(0, Math.min(PERSPECTIVE_DEPTH_MAX, d)));
}

/** Display depth 0..100 → stored CSS-perspective px (0 = flat/omitted; monotonic: more depth = stronger). */
function perspectiveDepthToPx(depth: number): number {
  if (depth <= 0) return 0;
  const d = Math.min(PERSPECTIVE_DEPTH_MAX, depth);
  return Math.round(PERSPECTIVE_PX_FLAT - (d / PERSPECTIVE_DEPTH_MAX) * (PERSPECTIVE_PX_FLAT - PERSPECTIVE_PX_STRONG));
}

/**
 * Blend-mode options shown in the inspector, grouped the way creators expect
 * (Photoshop/Premiere ordering). Every entry below is fully implemented in all
 * three renderers (preview CSS, browser-export canvas, Remotion) — see
 * BLEND_CSS / BLEND_CANVAS in `@kimera-by-aelivion/shared`. To expose a new mode later,
 * add it to the BlendMode union + those maps, then list it here.
 */
const BLEND_MODE_GROUPS: { label: string; options: { value: BlendMode; label: string }[] }[] = [
  { label: "Normal", options: [{ value: "normal", label: "Normal" }] },
  {
    label: "Darken",
    options: [
      { value: "darken", label: "Darken" },
      { value: "multiply", label: "Multiply" },
      { value: "color-burn", label: "Color Burn" }
    ]
  },
  {
    label: "Lighten",
    options: [
      { value: "lighten", label: "Lighten" },
      { value: "screen", label: "Screen" },
      { value: "color-dodge", label: "Color Dodge" },
      { value: "add", label: "Linear Dodge (Add)" }
    ]
  },
  {
    label: "Contrast",
    options: [
      { value: "overlay", label: "Overlay" },
      { value: "soft-light", label: "Soft Light" },
      { value: "hard-light", label: "Hard Light" }
    ]
  },
  {
    label: "Inversion",
    options: [
      { value: "difference", label: "Difference" },
      { value: "exclusion", label: "Exclusion" }
    ]
  },
  {
    label: "Component",
    options: [
      { value: "hue", label: "Hue" },
      { value: "saturation", label: "Saturation" },
      { value: "color", label: "Color" },
      { value: "luminosity", label: "Luminosity" }
    ]
  }
];
import type { InspectorPanelProps } from "../../registry/inspector";
import { InspectorSection } from "../InspectorSection";
import { NumberControl } from "../controls/NumberControl";
import { PropertyRowGroup } from "../controls/PropertyRow";
import { ThemedSelect } from "../controls/ThemedSelect";
import {
  animationPresets,
  applyAnimationPreset,
  applyTransformValueAtTime,
  clamp,
  clearTransformKeyframes,
  findTransformKeyframe,
  getActiveTransformKeyframe,
  getTransformKeyframes,
  getTransformPropertyValue,
  setTransformKeyframeInterpolation,
  toggleTransformKeyframe,
  type AnimationPresetId,
  type TransformAnimationProperty
} from "../keyframeUtils";

// ---------------------------------------------------------------------------
// TransformPanel — registered inspector panel
// ---------------------------------------------------------------------------

function defaultPositionY(type: InspectorPanelProps["layer"]["type"]) {
  return type === "text" ? 62 : 50;
}

function defaultOpacity(type: InspectorPanelProps["layer"]["type"]) {
  return type === "shape" ? 82 : 100;
}

export default function TransformPanel({ layer, onChange, currentTime = 0, onSeek, autoKeyframe }: InspectorPanelProps) {
  const layerTime = clamp(currentTime - layer.startSeconds, 0, layer.durationSeconds);
  const animatedTransform = evaluateTimelineTransform({
    transform: layer.transform,
    startSeconds: layer.startSeconds,
    keyframes: layer.keyframes,
    animations: layer.animations,
    timeSeconds: currentTime
  });

  const keyframeCount = getLayerAnimations(layer).length;
  const fallbackSeek = (_: number) => {};
  const seek = onSeek ?? fallbackSeek;

  // BROADCAST SAFETY: `onChange` may fan the updater out to EVERY selected clip (multiselect
  // broadcast in EditorPage). Anything derived from the layer — its local playhead time, its
  // evaluated value — must therefore be computed INSIDE the updater against `item`, never captured
  // from the primary above. Capturing the primary's value/time keyframed other clips to the
  // primary's value at the primary's time (2026-07-16 report).
  const itemLayerTime = (item: InspectorPanelProps["layer"]) => clamp(currentTime - item.startSeconds, 0, item.durationSeconds);

  function transformKeyframe(property: TransformAnimationProperty) {
    const activeKeyframe = getActiveTransformKeyframe(layer, property, layerTime);
    return {
      active: Boolean(activeKeyframe),
      hasAny: getTransformKeyframes(layer, property).length > 0,
      hasNext: Boolean(findTransformKeyframe(layer, property, layerTime, 1)),
      hasPrevious: Boolean(findTransformKeyframe(layer, property, layerTime, -1)),
      interpolation: activeKeyframe?.interpolation,
      onClearAll: () => onChange((item) => clearTransformKeyframes(item, property)),
      onChangeInterpolation: (interpolation: KeyframeInterpolation) =>
        onChange((item) => setTransformKeyframeInterpolation(item, property, itemLayerTime(item), interpolation)),
      onToggle: () =>
        onChange((item) => {
          const itemTransform = evaluateTimelineTransform({
            transform: item.transform,
            startSeconds: item.startSeconds,
            keyframes: item.keyframes,
            animations: item.animations,
            timeSeconds: currentTime
          });
          return toggleTransformKeyframe(item, property, itemLayerTime(item), getTransformPropertyValue(itemTransform, property));
        }),
      onNext: () => {
        const next = findTransformKeyframe(layer, property, layerTime, 1);
        if (next) seek(layer.startSeconds + next.timeSeconds);
      },
      onPrevious: () => {
        const previous = findTransformKeyframe(layer, property, layerTime, -1);
        if (previous) seek(layer.startSeconds + previous.timeSeconds);
      }
    };
  }

  function changeTransformProperty(property: TransformAnimationProperty, value: number) {
    onChange((item) => applyTransformValueAtTime(item, property, itemLayerTime(item), value, { autoKeyframe }));
  }

  // "Fit"/"Fill" canvas: resets scale/position to canonical (matching the object-fit box the renderer
  // already computes) and sets the fit mode, so a mismatched-aspect clip snaps back to a known-good frame
  // in one click instead of the user hand-tuning scale + position to approximate it.
  function fitToCanvas(fit: "contain" | "cover") {
    onChange((item) => {
      const time = itemLayerTime(item);
      let next = applyTransformValueAtTime(item, "transform.position.x", time, 50, { autoKeyframe });
      next = applyTransformValueAtTime(next, "transform.position.y", time, defaultPositionY(next.type), { autoKeyframe });
      next = applyTransformValueAtTime(next, "transform.scale", time, 1, { autoKeyframe });
      return { ...next, fit };
    });
  }

  // 3D tilt is static (not keyframed) for now — set the base transform field directly. Both the
  // preview (CSS) and the local/cloud export (WebGL perspective quad) read these fields.
  function changeTilt(field: "rotateX" | "rotateY" | "perspective", value: number) {
    onChange((item) => ({ ...item, transform: { ...item.transform, [field]: value } }));
  }

  const visiblePresets = animationPresets.filter(
    (preset) => !("textOnly" in preset && preset.textOnly) || layer.type === "text"
  );

  return (
    <>
      <InspectorSection title="Transform" icon={<Move size={13} />} collapsible={false}>
      <div className="control-grid">
        <PropertyRowGroup
          icon={<Move size={14} />}
          label="Position"
          fields={[
            {
              tag: "X",
              keyframe: transformKeyframe("transform.position.x"),
              onReset: () => changeTransformProperty("transform.position.x", 50),
              value: (
                <ScrubNumberInput
                  aria-label="Position X"
                  className="effect-slider-number"
                  inputMode="decimal"
                  min={-200}
                  max={300}
                  step={1}
                  value={animatedTransform.position.x.toFixed(0)}
                  onScrubChange={(value) => changeTransformProperty("transform.position.x", clamp(value, -200, 300))}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    if (Number.isFinite(next)) changeTransformProperty("transform.position.x", clamp(next, -200, 300));
                  }}
                />
              )
            },
            {
              tag: "Y",
              keyframe: transformKeyframe("transform.position.y"),
              onReset: () => changeTransformProperty("transform.position.y", defaultPositionY(layer.type)),
              value: (
                <ScrubNumberInput
                  aria-label="Position Y"
                  className="effect-slider-number"
                  inputMode="decimal"
                  min={-200}
                  max={300}
                  step={1}
                  value={animatedTransform.position.y.toFixed(0)}
                  onScrubChange={(value) => changeTransformProperty("transform.position.y", clamp(value, -200, 300))}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    if (Number.isFinite(next)) changeTransformProperty("transform.position.y", clamp(next, -200, 300));
                  }}
                />
              )
            }
          ]}
        />
        <PropertyRowGroup
          icon={<Crosshair size={14} />}
          label="Anchor"
          fields={[
            {
              tag: "X",
              keyframe: transformKeyframe("transform.anchor.x"),
              onReset: () => changeTransformProperty("transform.anchor.x", 50),
              value: (
                <ScrubNumberInput
                  aria-label="Anchor X"
                  className="effect-slider-number"
                  inputMode="decimal"
                  min={-100}
                  max={200}
                  step={1}
                  value={(animatedTransform.anchor?.x ?? 50).toFixed(0)}
                  onScrubChange={(value) => changeTransformProperty("transform.anchor.x", clamp(value, -100, 200))}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    if (Number.isFinite(next)) changeTransformProperty("transform.anchor.x", clamp(next, -100, 200));
                  }}
                />
              )
            },
            {
              tag: "Y",
              keyframe: transformKeyframe("transform.anchor.y"),
              onReset: () => changeTransformProperty("transform.anchor.y", 50),
              value: (
                <ScrubNumberInput
                  aria-label="Anchor Y"
                  className="effect-slider-number"
                  inputMode="decimal"
                  min={-100}
                  max={200}
                  step={1}
                  value={(animatedTransform.anchor?.y ?? 50).toFixed(0)}
                  onScrubChange={(value) => changeTransformProperty("transform.anchor.y", clamp(value, -100, 200))}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    if (Number.isFinite(next)) changeTransformProperty("transform.anchor.y", clamp(next, -100, 200));
                  }}
                />
              )
            }
          ]}
        />
        <NumberControl
          icon={<Maximize2 size={14} />}
          keyframe={transformKeyframe("transform.scale")}
          label="Scale"
          value={animatedTransform.scale}
          min={0.01}
          max={100}
          step={0.05}
          onReset={() => changeTransformProperty("transform.scale", 1)}
          onChange={(value) => changeTransformProperty("transform.scale", value)}
        />
        <NumberControl
          icon={<RotateCw size={14} />}
          keyframe={transformKeyframe("transform.rotation")}
          label="Rotate"
          value={animatedTransform.rotation}
          min={-3600}
          max={3600}
          step={1}
          onReset={() => changeTransformProperty("transform.rotation", 0)}
          onChange={(value) => changeTransformProperty("transform.rotation", value)}
        />
        <NumberControl
          icon={<Eye size={14} />}
          keyframe={transformKeyframe("transform.opacity")}
          label="Opacity"
          value={animatedTransform.opacity}
          min={0}
          max={100}
          step={1}
          onReset={() => changeTransformProperty("transform.opacity", defaultOpacity(layer.type))}
          onChange={(value) => changeTransformProperty("transform.opacity", value)}
        />
        <div className="number-row-select">
          <span className="effect-slider-label">
            <span className="effect-slider-label-text">Blend</span>
          </span>
          <ThemedSelect
            ariaLabel="Blend mode"
            value={layer.blendMode ?? "normal"}
            groups={BLEND_MODE_GROUPS}
            onChange={(blendMode) => onChange((item) => ({ ...item, blendMode }))}
          />
        </div>
        <div className="number-row-select">
          <span className="effect-slider-label">
            <span className="effect-slider-label-text" title="Use the clip directly above as this clip's matte (its alpha or brightness cuts this clip out). The matte clip stops drawing on its own while consumed.">
              Matte
            </span>
          </span>
          <ThemedSelect
            ariaLabel="Track matte"
            value={
              layer.trackMatte
                ? `${layer.trackMatte.mode}${layer.trackMatte.invert ? "-invert" : ""}`
                : "off"
            }
            options={[
              { value: "off", label: "Off" },
              { value: "alpha", label: "Alpha (clip above)" },
              { value: "alpha-invert", label: "Alpha Inverted" },
              { value: "luma", label: "Luma (clip above)" },
              { value: "luma-invert", label: "Luma Inverted" }
            ]}
            onChange={(value) =>
              onChange((item) => {
                if (value === "off") {
                  const { trackMatte: _off, ...rest } = item;
                  return rest as typeof item;
                }
                const [mode, invert] = value.split("-") as ["alpha" | "luma", string | undefined];
                return { ...item, trackMatte: { mode, ...(invert ? { invert: true } : {}) } };
              })
            }
          />
        </div>
        {layer.type === "video" || layer.type === "image" ? (
          <>
            <div className="number-row-select">
              <span className="effect-slider-label">
                <span className="effect-slider-label-text">Fit</span>
              </span>
              <ThemedSelect
                ariaLabel="Fit"
                value={layer.fit ?? "cover"}
                options={[
                  { value: "cover", label: "Cover" },
                  { value: "contain", label: "Contain" },
                  { value: "fill", label: "Stretch" }
                ]}
                onChange={(fit) => onChange((item) => ({ ...item, fit: fit as typeof layer.fit }))}
              />
            </div>
            <div className="fit-canvas-actions">
              <button type="button" title="Fit whole clip inside the canvas, letterboxed if needed" onClick={() => fitToCanvas("contain")}>
                Fit canvas
              </button>
              <button type="button" title="Fill the canvas edge-to-edge, cropping if needed" onClick={() => fitToCanvas("cover")}>
                Fill canvas
              </button>
            </div>
          </>
        ) : null}
      </div>
      </InspectorSection>

      <InspectorSection title="3D Tilt" icon={<Box size={13} />} defaultOpen={false}>
      <div className="control-grid">
        <PropertyRowGroup
          icon={<Rotate3d size={14} />}
          label="Tilt"
          fields={[
            {
              tag: "X",
              keyframe: transformKeyframe("transform.rotateX"),
              onReset: () => changeTransformProperty("transform.rotateX", 0),
              value: (
                <ScrubNumberInput
                  aria-label="Rotate X"
                  className="effect-slider-number"
                  inputMode="decimal"
                  min={-180}
                  max={180}
                  step={1}
                  value={(animatedTransform.rotateX ?? 0).toFixed(0)}
                  onScrubChange={(value) => changeTransformProperty("transform.rotateX", clamp(value, -180, 180))}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    if (Number.isFinite(next)) changeTransformProperty("transform.rotateX", clamp(next, -180, 180));
                  }}
                />
              )
            },
            {
              tag: "Y",
              keyframe: transformKeyframe("transform.rotateY"),
              onReset: () => changeTransformProperty("transform.rotateY", 0),
              value: (
                <ScrubNumberInput
                  aria-label="Rotate Y"
                  className="effect-slider-number"
                  inputMode="decimal"
                  min={-180}
                  max={180}
                  step={1}
                  value={(animatedTransform.rotateY ?? 0).toFixed(0)}
                  onScrubChange={(value) => changeTransformProperty("transform.rotateY", clamp(value, -180, 180))}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    if (Number.isFinite(next)) changeTransformProperty("transform.rotateY", clamp(next, -180, 180));
                  }}
                />
              )
            }
          ]}
        />
        <NumberControl
          icon={<Box size={14} />}
          keyframe={transformKeyframe("transform.perspective")}
          label="Perspective"
          // Monotonic depth 0..100 (0 = flat → 100 = strongest); stored as CSS-perspective px (see mapping above).
          value={perspectivePxToDepth(animatedTransform.perspective ?? 0)}
          min={0}
          max={100}
          step={1}
          onReset={() => changeTransformProperty("transform.perspective", 0)}
          onChange={(value) => changeTransformProperty("transform.perspective", perspectiveDepthToPx(value))}
        />
      </div>
      </InspectorSection>

      <InspectorSection
        title="Graph Editor"
        icon={<SlidersHorizontal size={13} />}
        count={keyframeCount}
        active={keyframeCount > 0}
      >
        {/* The interactive graph moved to the bottom workspace (Shift+G) — a full
            canvas surface beats the old 320px SVG buried in this panel. */}
        <button
          className="graph-open-button"
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent("kimera:open-graph-editor"))}
        >
          <SlidersHorizontal size={13} />
          Open Graph Editor
          <kbd>Shift+G</kbd>
        </button>
      </InspectorSection>

      <InspectorSection
        title="Animation Presets"
        icon={<Sparkles size={13} />}
        count={visiblePresets.length}
        defaultOpen={false}
      >
        <div className="animation-preset-grid">
          {visiblePresets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => onChange((item) => applyAnimationPreset(item, preset.id as AnimationPresetId))}
            >
              {preset.label}
            </button>
          ))}
        </div>
        {/* Typewriter SPEED moved to the Effects subtab: an applied Typewriter now shows as an
            effect card there with the "Reveal duration (s)" control (user request 2026-07-12). */}
      </InspectorSection>

      <InspectorSection
        title="Keyframes"
        icon={<Diamond size={13} />}
        count={keyframeCount}
        active={keyframeCount > 0}
        defaultOpen={false}
      >
        {keyframeCount > 0 ? (
          <div className="keyframe-list">
            {getLayerAnimations(layer).map((keyframe) => (
              <div className="keyframe-row" key={keyframe.id}>
                <strong>{shortKeyframePropertyLabel(keyframe.target.property)}</strong>
                <span>{keyframe.timeSeconds.toFixed(2)}s</span>
                <small>{keyframe.interpolation}</small>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-mini">
            <Diamond size={16} />
            No keyframes yet
          </div>
        )}
      </InspectorSection>
    </>
  );
}

function shortKeyframePropertyLabel(property: string) {
  const map: Record<string, string> = {
    "transform.position.x": "X",
    "transform.position.y": "Y",
    "transform.scale": "Scale",
    "transform.rotation": "Rotate",
    "transform.opacity": "Opacity",
    textRevealProgress: "Reveal"
  };
  return map[property] ?? property;
}
