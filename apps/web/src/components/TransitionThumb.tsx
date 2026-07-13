import { useEffect, useRef, useState } from "react";
import { Star, Trash2 } from "lucide-react";
import type { TransitionKind } from "@kimera-by-aelivion/shared";
import { transitionPreviewStyle, type TransitionPreviewParams } from "../editor/effects/transition-preview";

/**
 * A square transition preview tile for the Effects-tab gallery. Two contrasting sample layers (A under,
 * B over) animate the transition on hover so the user sees the look before applying. The hovered tile
 * runs a single `requestAnimationFrame` loop and writes styles imperatively (no per-frame React render);
 * at rest it shows a recognisable mid-transition still (progress 0.5). Click applies; the star favourites.
 */

const A_BG = "linear-gradient(135deg, #f59e0b 0%, #ef4444 100%)"; // warm — outgoing
const B_BG = "linear-gradient(135deg, #38bdf8 0%, #8b5cf6 100%)"; // cool — incoming
const LOOP_MS = 1200;

export function TransitionThumb({
  kind,
  params,
  label,
  starred,
  aSrc,
  bSrc,
  onApply,
  onToggleStar,
  onRemove,
  dragPayload
}: {
  kind: TransitionKind;
  params: TransitionPreviewParams;
  label: string;
  starred: boolean;
  /** Real footage frames (outgoing / incoming) — fall back to sample gradients when absent. */
  aSrc?: string | undefined;
  bSrc?: string | undefined;
  onApply: () => void;
  onToggleStar: () => void;
  onRemove?: (() => void) | undefined;
  /** JSON payload for `application/x-kimera-transition` — set on junction kinds so the tile can be dragged onto a timeline cut. */
  dragPayload?: string | undefined;
}) {
  const aRef = useRef<HTMLDivElement | null>(null);
  const bRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const [hovering, setHovering] = useState(false);

  // Re-read params inside the loop without re-subscribing every frame.
  const paramsKey = `${params.direction ?? ""}|${params.mode ?? ""}|${params.color ?? ""}`;

  function applyProgress(progress: number) {
    const { a, b, overlay } = transitionPreviewStyle(kind, params, progress);
    if (aRef.current) {
      aRef.current.style.transform = (a.transform as string) ?? "none";
      aRef.current.style.opacity = String(a.opacity ?? 1);
    }
    if (bRef.current) {
      bRef.current.style.transform = (b.transform as string) ?? "none";
      bRef.current.style.opacity = String(b.opacity ?? 1);
      bRef.current.style.clipPath = (b.clipPath as string) ?? "none";
    }
    if (overlayRef.current) {
      overlayRef.current.style.background = kind === "dip" ? params.color ?? "#000000" : "transparent";
      overlayRef.current.style.opacity = String(overlay?.opacity ?? 0);
    }
  }

  // Static still at rest, and whenever the transition identity changes.
  useEffect(() => {
    if (!hovering) applyProgress(0.5);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, paramsKey, hovering]);

  useEffect(() => {
    if (!hovering) {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      return undefined;
    }
    const start = performance.now();
    const tick = (now: number) => {
      applyProgress(((now - start) % LOOP_MS) / LOOP_MS);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hovering, kind, paramsKey]);

  return (
    <div className="transition-thumb-wrap">
      <button
        type="button"
        className="transition-thumb"
        title={dragPayload ? `${label} — click to apply to the selected cut, or drag onto a cut` : `${label} — click to apply to the selected cut`}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
        onClick={onApply}
        draggable={Boolean(dragPayload)}
        onDragStart={
          dragPayload
            ? (event) => {
                event.dataTransfer.effectAllowed = "copy";
                event.dataTransfer.setData("application/x-kimera-transition", dragPayload);
                event.dataTransfer.setData("text/plain", label);
              }
            : undefined
        }
      >
        <div className="transition-thumb-a" ref={aRef} style={{ backgroundImage: aSrc ? `url("${aSrc}")` : A_BG }} />
        <div className="transition-thumb-b" ref={bRef} style={{ backgroundImage: bSrc ? `url("${bSrc}")` : B_BG }} />
        <div className="transition-thumb-overlay" ref={overlayRef} />
      </button>
      <button
        type="button"
        className={`transition-thumb-star ${starred ? "is-on" : ""}`}
        aria-label={starred ? "Remove from favourites" : "Add to favourites"}
        aria-pressed={starred}
        onClick={(event) => {
          event.stopPropagation();
          onToggleStar();
        }}
      >
        <Star size={12} fill={starred ? "currentColor" : "none"} />
      </button>
      {onRemove ? (
        <button
          type="button"
          className="transition-thumb-delete"
          aria-label={`Remove uploaded transition ${label}`}
          title="Remove uploaded transition"
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
        >
          <Trash2 size={12} />
        </button>
      ) : null}
      <span className="transition-thumb-label">{label}</span>
    </div>
  );
}
