/**
 * Flarex key-colour eyedropper (the UI half — see `flarex-eyedropper.ts` for the reasoning and the
 * pure sampling).
 *
 * WHICH BUFFER, AND HOW WE KNOW IT IS THE RIGHT ONE
 * -------------------------------------------------
 * The surface you click is the KEYER'S INPUT, rendered through the viewer's OWN compositor by
 * `SceneViewerCaptureHandle.renderFlarexNodeThumbnail` — the same mechanism that draws the node
 * thumbnails, which re-roots the comp at a node id via `flarexPreviewRootNodeId` and composites that
 * node ALONE (`layers: [host]`, no transitions, and deliberately without the comp-proxy path, which
 * would replace every node's picture with the comp's final frame).
 *
 * We ask it for `flarexNodeImageInputId(comp, keyerId)` — the node wired into the keyer's image
 * socket — so the pixels are, by construction, exactly what the keyer's shader will read:
 *   • everything UPSTREAM is included (an upstream grade is part of the data being keyed);
 *   • the key itself, and everything downstream of it, is excluded (re-rooting stops there);
 *   • the composited viewer output never enters it at all.
 * If the socket is unwired there is no input to sample and the affordance is disabled rather than
 * quietly falling back to the viewer.
 *
 * STILL FRAMES ONLY. `renderIsolated` (behind that handle) hard-refuses while the transport is playing
 * — playback owns the compositor — so a pick during playback could only ever be a stale frame. Rather
 * than sample one, the button disables and says why. Pausing re-enables it.
 */

import { useEffect, useRef, useState } from "react";
import { Pipette } from "lucide-react";
import type { FlarexComp } from "@orreris/shared";
import { ColorControl } from "../../components/ColorControl";
import { PropertyRow } from "../inspector/controls/PropertyRow";
import type { SceneViewerCaptureHandle } from "../../components/ScenePreviewCanvas";
import {
  FLAREX_PICK_DEFAULT_SIZE,
  FLAREX_PICK_SIZES,
  flarexNodeImageInputId,
  sampleAverageHex,
  type FlarexPickFrame,
} from "./flarex-eyedropper";

/**
 * Capture box, in pixels, for the sampled input frame. The handle CONTAINS the project aspect inside
 * the box, so a square box yields `640` on the long edge for both landscape and portrait projects.
 *
 * Big enough that a 5×5 sample box is a real region of the picture rather than a region of the
 * downscale filter, small enough that the readback is ~1.6 MB and lands in one idle frame.
 */
const PICK_BOX = 640;

/** One reusable readback buffer for the life of the page (the thumbnail pass does the same). */
let pickBuffer: Uint8Array | null = null;

export interface FlarexKeyColorPickerProps {
  comp: FlarexComp;
  nodeId: string;
  label: string;
  icon?: React.ReactNode | undefined;
  value: string;
  onChange: (hex: string) => void;
  /** The clip carrying the comp — the capture handle resolves live media through this id. */
  hostLayerId: string | null;
  captureRef?: React.MutableRefObject<SceneViewerCaptureHandle | null> | undefined;
  isPlaying: boolean;
}

export function FlarexKeyColorPicker({
  comp,
  nodeId,
  label,
  icon,
  value,
  onChange,
  hostLayerId,
  captureRef,
  isPlaying,
}: FlarexKeyColorPickerProps) {
  const [frame, setFrame] = useState<FlarexPickFrame | null>(null);
  const [size, setSize] = useState<number>(FLAREX_PICK_DEFAULT_SIZE);
  const [hover, setHover] = useState<{ hex: string; x: number; y: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const inputNodeId = flarexNodeImageInputId(comp, nodeId);
  const disabledReason = !captureRef
    ? "The viewer is not available."
    : isPlaying
      ? "Pause to pick — while playing, the only frame available would be a stale one."
      : !hostLayerId
        ? "No clip is carrying this comp."
        : !inputNodeId
          ? "Nothing is wired into this node's image input, so there is no picture to sample."
          : null;

  const capture = () => {
    setError(null);
    const handle = captureRef?.current;
    if (!handle || !hostLayerId || !inputNodeId) return;
    pickBuffer ??= new Uint8Array(PICK_BOX * PICK_BOX * 4);
    const shot = handle.renderFlarexNodeThumbnail({
      hostLayerId,
      // THE NODE'S INPUT, not this node and not the viewer — see the file docstring.
      nodeId: inputNodeId,
      targetWidth: PICK_BOX,
      targetHeight: PICK_BOX,
      buffer: pickBuffer,
    });
    if (!shot) {
      // The handle's documented "not ready, try later": playing, no composited frame yet, host clip off
      // screen, or an upstream MediaIn whose own source has not decoded. All four are honest refusals.
      setError("Couldn't read this node's input yet — scrub to a frame that has decoded, then try again.");
      return;
    }
    // `shot.pixels` IS the shared buffer; copy before it is handed to state.
    setFrame({
      pixels: new Uint8Array(shot.pixels.subarray(0, shot.width * shot.height * 4)),
      width: shot.width,
      height: shot.height,
    });
  };

  // Paint the captured input into the visible canvas.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !frame) return;
    canvas.width = frame.width;
    canvas.height = frame.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(frame.pixels), frame.width, frame.height), 0, 0);
  }, [frame]);

  // Escape closes, like every other transient surface in the editor.
  useEffect(() => {
    if (!frame) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFrame(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [frame]);

  const uvOf = (event: React.PointerEvent<HTMLCanvasElement>): { u: number; v: number } => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      u: (event.clientX - rect.left) / Math.max(1, rect.width),
      // v is TOP-DOWN in both spaces (readback row order and pointer offset), so no flip.
      v: (event.clientY - rect.top) / Math.max(1, rect.height),
    };
  };

  return (
    <>
      <ColorControl label={label} icon={icon} value={value} onChange={onChange} />
      <PropertyRow
        label="Eyedropper"
        icon={<Pipette size={14} />}
        className="flarex-eyedropper-row"
        control={
          <div className="flarex-eyedropper">
            <button
              type="button"
              className="flarex-eyedropper-btn"
              data-testid="flarex-eyedropper-pick"
              disabled={disabledReason !== null}
              title={disabledReason ?? "Sample the key colour off this node's INPUT image (not the composited viewer output)"}
              onClick={capture}
            >
              <Pipette size={13} />
              Pick input
            </button>
            <label className="flarex-eyedropper-size" title="Sample box. A single pixel picks noise — on compressed footage a 5×5 mean is a visibly better key.">
              <span>Sample</span>
              <select
                data-testid="flarex-eyedropper-size"
                value={size}
                onChange={(event) => setSize(Number(event.target.value))}
              >
                {FLAREX_PICK_SIZES.map((n) => (
                  <option key={n} value={n}>
                    {n}×{n}
                  </option>
                ))}
              </select>
            </label>
          </div>
        }
      />
      {error ? <div className="flarex-eyedropper-error">{error}</div> : null}
      {frame ? (
        <div className="flarex-eyedropper-overlay" data-testid="flarex-eyedropper-overlay">
          <div className="flarex-eyedropper-backdrop" onPointerDown={() => setFrame(null)} />
          <div className="flarex-eyedropper-panel">
            <div className="flarex-eyedropper-head">
              <strong>Pick key colour</strong>
              <span className="flarex-eyedropper-note">
                This is the keyer&apos;s <em>input</em> — before the key, before any grade below it.
              </span>
              <button type="button" className="flarex-eyedropper-close" onClick={() => setFrame(null)}>
                Close
              </button>
            </div>
            <canvas
              ref={canvasRef}
              className="flarex-eyedropper-canvas"
              data-testid="flarex-eyedropper-canvas"
              onPointerMove={(event) => {
                const { u, v } = uvOf(event);
                const hex = sampleAverageHex(frame, u, v, size);
                setHover(hex ? { hex, x: u, y: v } : null);
              }}
              onPointerLeave={() => setHover(null)}
              onPointerDown={(event) => {
                const { u, v } = uvOf(event);
                const hex = sampleAverageHex(frame, u, v, size);
                if (!hex) return;
                onChange(hex);
                setFrame(null);
              }}
            />
            <div className="flarex-eyedropper-readout">
              <span className="flarex-eyedropper-swatch" style={{ background: hover?.hex ?? value }} data-testid="flarex-eyedropper-swatch" />
              <code data-testid="flarex-eyedropper-hex">{hover?.hex ?? value}</code>
              <span className="flarex-eyedropper-note">{size}×{size} mean</span>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

export default FlarexKeyColorPicker;
