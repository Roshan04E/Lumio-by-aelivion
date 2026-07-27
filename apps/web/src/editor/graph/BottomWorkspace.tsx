/**
 * The bottom workspace — a tabbed, height-resizable drawer docked UNDER the
 * timeline (After Effects graph-editor model): Graph | Audio | Scopes | Metadata.
 * Graph is the real surface today; the other tabs are placeholders that the
 * mixer/scopes migrate into later. Toggled with Shift+G, height persisted, with
 * magnetic snap heights (200/300/450).
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Activity, AudioLines, Info, Spline, X } from "lucide-react";
import type { TimelineLayer } from "@orreris/shared";
import { GraphEditor } from "./GraphEditor";
import { ColorScopes, type ScopeFrameSampler } from "../../components/ColorScopes";

export type BottomWorkspaceTab = "graph" | "audio" | "scopes" | "metadata";

const HEIGHT_STORAGE_KEY = "orreris.bottomWorkspace.height";
const SNAP_HEIGHTS = [200, 300, 450];
const MIN_HEIGHT = 160;
const MAX_HEIGHT = 560;

function loadHeight(): number {
  try {
    const raw = window.localStorage.getItem(HEIGHT_STORAGE_KEY);
    const value = raw ? Number(raw) : NaN;
    return Number.isFinite(value) ? Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, value)) : 260;
  } catch {
    return 260;
  }
}

export interface BottomWorkspaceProps {
  layer: TimelineLayer | null;
  onChange: (updater: (layer: TimelineLayer) => TimelineLayer) => void;
  currentTime: number;
  onSeek: (seconds: number) => void;
  fps: number;
  onClose: () => void;
  /** Property key to focus in the Graph tab (set when opened from a keyframe double-click). */
  focusTargetKey?: string | undefined;
  /** Other SELECTED clips — the graph draws their matching curves faded (read-only ghosts). */
  ghostLayers?: TimelineLayer[] | undefined;
  /** Video scopes (Scopes tab) — trustworthy scene-compositor readback + DOM-preview fallback. */
  scopeSampler?: ScopeFrameSampler | undefined;
  scopeContainerRef?: React.RefObject<HTMLElement | null> | undefined;
  /** Frame tick (re-samples the scopes) + transport state (coarser sampling while playing). */
  scopeTick?: number | undefined;
  /** Identity changes when the picture may have changed for a reason other than time (grade edits). */
  scopeChangeKey?: unknown;
  isPlaying?: boolean | undefined;
  /** Open the Scopes tab initially (e.g. when invoked from the removed Color→Scopes affordance). */
  initialTab?: BottomWorkspaceTab | undefined;
  /** Flarex: replace the layer-derived graph targets with the selected node's params (bridge). */
  overrideTargets?: import("../inspector/keyframeUtils").GraphTarget[] | undefined;
}

export function BottomWorkspace({ layer, onChange, currentTime, onSeek, fps, onClose, focusTargetKey, ghostLayers, scopeSampler, scopeContainerRef, scopeTick, scopeChangeKey, isPlaying, initialTab, overrideTargets }: BottomWorkspaceProps) {
  const [tab, setTab] = useState<BottomWorkspaceTab>(initialTab ?? "graph");
  const [height, setHeight] = useState<number>(() => loadHeight());
  const resizeRef = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(HEIGHT_STORAGE_KEY, String(height));
    } catch {
      /* private mode — height just won't persist */
    }
  }, [height]);

  function startResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeRef.current = { pointerId: event.pointerId, startY: event.clientY, startHeight: height };
  }

  function moveResize(event: ReactPointerEvent<HTMLDivElement>) {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    let next = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, resize.startHeight + (resize.startY - event.clientY)));
    for (const snap of SNAP_HEIGHTS) {
      if (Math.abs(next - snap) < 12) {
        next = snap;
        break;
      }
    }
    setHeight(next);
  }

  function endResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (resizeRef.current?.pointerId !== event.pointerId) return;
    resizeRef.current = null;
  }

  const tabs: Array<{ id: BottomWorkspaceTab; label: string; icon: ReactNode }> = [
    { id: "graph", label: "Graph", icon: <Spline size={12} /> },
    { id: "audio", label: "Audio", icon: <AudioLines size={12} /> },
    { id: "scopes", label: "Scopes", icon: <Activity size={12} /> },
    { id: "metadata", label: "Metadata", icon: <Info size={12} /> }
  ];

  return (
    <section className="bottom-workspace" style={{ height }} aria-label="Bottom workspace">
      <div
        className="bottom-workspace-resizer"
        role="separator"
        aria-orientation="horizontal"
        title="Drag to resize"
        onPointerDown={startResize}
        onPointerMove={moveResize}
        onPointerUp={endResize}
        onPointerCancel={endResize}
      />
      <div className="bottom-workspace-head">
        <div className="bottom-workspace-tabs" role="tablist">
          {tabs.map((item) => (
            <button
              className={tab === item.id ? "is-active" : ""}
              key={item.id}
              role="tab"
              aria-selected={tab === item.id}
              type="button"
              onClick={() => setTab(item.id)}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
        {layer ? <span className="bottom-workspace-clip" title={layer.name}>{layer.name}</span> : null}
        <button className="bottom-workspace-close" type="button" title="Close (Shift+G)" onClick={onClose}>
          <X size={13} />
        </button>
      </div>
      <div className="bottom-workspace-body">
        {tab === "graph" ? (
          layer ? (
            <GraphEditor
              layer={layer}
              onChange={onChange}
              currentTime={currentTime}
              onSeek={onSeek}
              fps={fps}
              focusTargetKey={focusTargetKey}
              ghostLayers={ghostLayers}
              overrideTargets={overrideTargets}
            />
          ) : (
            <div className="bottom-workspace-empty">Select a clip to edit its animation curves.</div>
          )
        ) : tab === "audio" ? (
          <div className="bottom-workspace-empty">Audio workspace — the mixer and clip audio FX move here next.</div>
        ) : tab === "scopes" ? (
          scopeContainerRef ? (
            <div className="bottom-workspace-scopes">
              <ColorScopes
                containerRef={scopeContainerRef}
                sampleSource={scopeSampler}
                tick={scopeTick ?? 0}
                changeKey={scopeChangeKey}
                isPlaying={isPlaying ?? false}
                storageKey="drawer"
                defaultLayout="two"
              />
            </div>
          ) : (
            <div className="bottom-workspace-empty">Scopes unavailable — no preview surface.</div>
          )
        ) : (
          <div className="bottom-workspace-empty">
            {layer
              ? `${layer.name} — ${layer.type}, ${layer.durationSeconds.toFixed(2)}s from ${layer.startSeconds.toFixed(2)}s, ${(layer.animations ?? []).length} keyframes, ${layer.effects.length} effects.`
              : "Select a clip to see its metadata."}
          </div>
        )}
      </div>
    </section>
  );
}
