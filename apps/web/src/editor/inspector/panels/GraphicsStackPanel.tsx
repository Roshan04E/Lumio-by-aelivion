/**
 * Graphics tab — layer stack (Premiere EGP-style). Lists every graphic-ish layer in the
 * composition (text, shapes, vector graphics) in DRAW order (tracks[0] renders on top), with
 * select / show-hide / rename. Direct-import component (not registry-loaded): it edits layers
 * OTHER than the selected one, which the InspectorPanelProps contract deliberately doesn't allow.
 */

import { useState } from "react";
import { Eye, EyeOff, Layers, Shapes, Square, Type } from "lucide-react";
import type { TimelineComposition, TimelineLayer } from "@lumio-by-aelivion/shared";
import { InspectorSection } from "../InspectorSection";

export interface GraphicsStackEntry {
  layer: TimelineLayer;
  trackName: string;
}

/** Text/shape/vector-graphic layers in draw order (top of the list = drawn above everything). */
export function graphicsStackEntries(composition: TimelineComposition): GraphicsStackEntry[] {
  const entries: GraphicsStackEntry[] = [];
  for (const track of composition.tracks) {
    for (const layer of track.layers) {
      if (layer.type === "text" || layer.type === "shape" || layer.graphic) {
        entries.push({ layer, trackName: track.name });
      }
    }
  }
  return entries;
}

function layerIcon(layer: TimelineLayer) {
  if (layer.type === "text") return <Type size={13} />;
  if (layer.type === "shape") return <Square size={13} />;
  return <Shapes size={13} />;
}

export default function GraphicsStackPanel({
  composition,
  currentTime,
  selectedLayerId,
  onSelectLayer,
  onChangeLayer
}: {
  composition: TimelineComposition;
  currentTime: number;
  selectedLayerId: string;
  onSelectLayer?: ((layerId: string) => void) | undefined;
  onChangeLayer?: ((layerId: string, updater: (layer: TimelineLayer) => TimelineLayer) => void) | undefined;
}) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const entries = graphicsStackEntries(composition);
  if (!entries.length) return null;

  return (
    <InspectorSection title="Layers" icon={<Layers size={13} />} count={entries.length}>
      <div className="graphics-stack">
        {entries.map(({ layer, trackName }) => {
          const active = layer.startSeconds <= currentTime && currentTime < layer.startSeconds + layer.durationSeconds;
          const hidden = layer.muted === true;
          const selected = layer.id === selectedLayerId;
          return (
            <div
              key={layer.id}
              className={`graphics-stack-row${selected ? " is-selected" : ""}${active ? "" : " is-inactive"}`}
              onClick={() => onSelectLayer?.(layer.id)}
              onDoubleClick={() => setRenamingId(layer.id)}
              title={`${trackName} · ${active ? "at playhead" : "not at playhead"}`}
            >
              <span className="graphics-stack-icon">{layerIcon(layer)}</span>
              {renamingId === layer.id ? (
                <input
                  autoFocus
                  className="graphics-stack-rename"
                  defaultValue={layer.name}
                  onClick={(event) => event.stopPropagation()}
                  onBlur={(event) => {
                    const name = event.target.value.trim();
                    if (name && name !== layer.name) onChangeLayer?.(layer.id, (item) => ({ ...item, name }));
                    setRenamingId(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") (event.target as HTMLInputElement).blur();
                    if (event.key === "Escape") setRenamingId(null);
                  }}
                />
              ) : (
                <span className="graphics-stack-name">{layer.name || layer.type}</span>
              )}
              <button
                type="button"
                className="graphics-stack-eye"
                title={hidden ? "Show layer" : "Hide layer"}
                aria-label={hidden ? "Show layer" : "Hide layer"}
                onClick={(event) => {
                  event.stopPropagation();
                  // `muted` already hides visual layers in BOTH renderers (web preview + render
                  // manifest filter on !layer.muted) — no new visibility field needed.
                  onChangeLayer?.(layer.id, (item) => ({ ...item, muted: !item.muted }));
                }}
              >
                {hidden ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
            </div>
          );
        })}
      </div>
    </InspectorSection>
  );
}
