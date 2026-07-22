/**
 * Flarex workspace (FLAREX.md Part 5) — the CG page body that replaces the timeline area while the
 * Flarex page is active. Layout: node toolbar (top) → node canvas (center) → inspector (right).
 * The MAIN editor viewer stays mounted above and IS the Flarex viewer: the selected clip's comp
 * output renders live through the `build-scene-draws` lowering hook, so scrubbing/params update the
 * one preview both pages share (the Resolve "one viewer across pages" model).
 *
 * Monolith containment: EditorPage passes only { graph, layer, onUpdateGraph } — everything else
 * lives in this subtree.
 */

import { useEffect, useRef, useState } from "react";
import { usePlaybackClock } from "../../playback/playback-clock";
import { BottomWorkspace } from "../graph/BottomWorkspace";
import { applyFlarexGraphLayer, buildFlarexGraphLayer } from "./flarex-graph-bridge";
import {
  createFlarexComp,
  createFlarexNode,
  flarexNodeDefs,
  getLayerFlarexComp,
  stampCompositionRegistry,
  stampFlarexComp,
  type FlarexComp,
  type FlarexNode,
  type FlarexNodeType,
  type ProjectGraph,
  type TimelineLayer,
} from "@orreris/shared";
import { FlarexInspector } from "./FlarexInspector";
import { FlarexNodeCanvas, GROUP_COLORS, flarexPaletteDrag, nextNodePosition } from "./FlarexNodeCanvas";
import { alignFlarexNodes, type FlarexAlignMode } from "./flarex-canvas-model";

/** F5.2: align/distribute toolbar buttons — pure position math via `alignFlarexNodes`. */
const ALIGN_BUTTONS: Array<{ mode: FlarexAlignMode; label: string; title: string }> = [
  { mode: "left", label: "L", title: "Align left" },
  { mode: "centerH", label: "C↔", title: "Align center (horizontal)" },
  { mode: "right", label: "R", title: "Align right" },
  { mode: "top", label: "T", title: "Align top" },
  { mode: "middleV", label: "C↕", title: "Align middle (vertical)" },
  { mode: "bottom", label: "B", title: "Align bottom" },
  { mode: "distributeH", label: "↔ Dist", title: "Distribute horizontally (3+ nodes)" },
  { mode: "distributeV", label: "↕ Dist", title: "Distribute vertically (3+ nodes)" },
];

/** Phase-1 palette, grouped Fusion-style (node-defs' `phase` gates what ships). */
const PALETTE_GROUPS: Array<{ label: string; types: FlarexNodeType[] }> = [
  { label: "Composite", types: ["merge", "transform"] },
  { label: "Color", types: ["colorCorrect", "colorCurves", "hueSat"] },
  { label: "Filter", types: ["blur", "glow", "sharpen", "filter"] },
  { label: "Key/Mask", types: ["chromaKey", "lumaKey", "rectMask", "ellipseMask", "polygonMask", "bezierMask", "matteControl"] },
  { label: "Layout", types: ["backdrop", "reroute"] },
];

export interface FlarexWorkspaceProps {
  graph: ProjectGraph;
  /** The active clip (Edit-page selection; falls back to the last inspected clip). */
  layer: TimelineLayer | null;
  /** The single write path — receives the full next graph (EditorPage stamps history/persistence). */
  onUpdateGraph: (nextGraph: ProjectGraph) => void;
  /** Shared transport playhead (seconds); comp-local time = timeSeconds − layer.startSeconds. */
  timeSeconds: number;
  /** Seek the shared transport to an absolute time (keyframe prev/next nav). */
  onSeek: (seconds: number) => void;
  /** Transport playing state — the frame ruler's resume-glitch latch needs it. */
  isPlaying?: boolean;
  /** Graph-editor drawer open state (shared with the Edit page's toggle button) + its closer. */
  graphOpen?: boolean;
  onCloseGraph?: () => void;
}

export function FlarexWorkspace({ graph, layer, onUpdateGraph, timeSeconds, onSeek, isPlaying = false, graphOpen = false, onCloseGraph }: FlarexWorkspaceProps) {
  const comp = layer ? getLayerFlarexComp(graph, layer) : undefined;
  const layerStart = layer?.startSeconds ?? 0;
  const compTime = Math.max(0, timeSeconds - layerStart);
  // Multi-select (marquee/shift-click); the inspector shows the node only when exactly one is selected.
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);

  // Selection resets when the active comp changes (a different clip's graph).
  useEffect(() => {
    setSelectedNodeIds([]);
  }, [comp?.id]);

  const updateComp = (updater: (comp: FlarexComp) => FlarexComp) => {
    if (!comp) return;
    const current = graph.flarexComps?.[comp.id];
    if (!current) return;
    const next = updater(current);
    if (next === current) return;
    // stampFlarexComp bumps comp.version (the render dirty key); graph.version bumps for sync.
    onUpdateGraph({ ...stampFlarexComp(graph, next), version: graph.version + 1 });
  };

  const handleCreateComp = () => {
    if (!layer || !graph.composition) return;
    const compId = `flarex_${layer.id}_${Date.now().toString(36)}`;
    const created = createFlarexComp(compId, `${layer.name || "Clip"} Comp`);
    const nextComposition = {
      ...graph.composition,
      tracks: graph.composition.tracks.map((track) => ({
        ...track,
        layers: track.layers.map((item) => (item.id === layer.id ? { ...item, flarexCompId: compId } : item)),
      })),
    };
    onUpdateGraph({
      ...stampCompositionRegistry({ ...stampFlarexComp({ ...graph, composition: nextComposition }, created) }),
      version: graph.version + 1,
    });
  };

  /** F5.2: align/distribute the selection. `alignFlarexNodes` is pure; this is the ONE commit. */
  const handleAlign = (mode: FlarexAlignMode) => {
    updateComp((current) => {
      const nodes = selectedNodeIds.map((id) => current.nodes[id]).filter((n): n is FlarexNode => Boolean(n));
      const positions = alignFlarexNodes(nodes, mode);
      if (Object.keys(positions).length === 0) return current;
      const nextNodes = { ...current.nodes };
      for (const [id, pos] of Object.entries(positions)) {
        const n = nextNodes[id];
        if (n) nextNodes[id] = { ...n, ui: pos };
      }
      return { ...current, nodes: nextNodes };
    });
  };

  const handleAddNode = (type: FlarexNodeType) => {
    updateComp((current) => {
      const id = `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const pos = nextNodePosition(current);
      const node = createFlarexNode(type, id, pos.x, pos.y);
      setSelectedNodeIds([id]);
      return { ...current, nodes: { ...current.nodes, [id]: node } };
    });
  };

  if (!layer) {
    return (
      <div className="flarex-workspace flarex-workspace-empty">
        <p>Select a clip on the Edit page, then switch back — its node comp opens here.</p>
      </div>
    );
  }

  if (!comp) {
    return (
      <div className="flarex-workspace flarex-workspace-empty">
        <p>
          <strong>{layer.name || "This clip"}</strong> has no Flarex comp yet.
        </p>
        <button type="button" className="flarex-create-btn" onClick={handleCreateComp}>
          Create Flarex comp
        </button>
        <p className="flarex-hint">A MediaIn → MediaOut graph is created; the clip renders its MediaOut everywhere.</p>
      </div>
    );
  }

  // Frame-ruler keyframe ticks (N4): union of keyframe times across every param of the ONE
  // selected node, deduped (several params can share a time). Comp-local seconds, same space the
  // ruler already scrubs in.
  const selectedNodeKeyframeTimes: number[] =
    selectedNodeIds.length === 1
      ? Array.from(
          new Set(
            comp.animations
              .filter((kf) => kf.target.scope === "flarexNode" && kf.target.effectId === selectedNodeIds[0])
              .map((kf) => kf.timeSeconds),
          ),
        ).sort((a, b) => a - b)
      : [];

  // Graph drawer (shared GraphEditor via the bridge): the ONE selected node's keyframeable params
  // become effect-kind targets on a synthetic layer; edits map back to comp.animations.
  const graphNode = selectedNodeIds.length === 1 ? comp.nodes[selectedNodeIds[0]!] ?? null : null;
  const graphBridge = graphNode ? buildFlarexGraphLayer(comp, graphNode, layer.durationSeconds, layerStart) : null;
  // Route the shared GraphEditor's layer-updater back onto the comp: rebuild the synthetic layer
  // from the CURRENT node (avoids stale closures), apply the updater, translate to comp.animations.
  const handleGraphChange = (nodeId: string) => (updater: (l: TimelineLayer) => TimelineLayer) =>
    updateComp((current) => {
      const node = current.nodes[nodeId];
      if (!node) return current;
      const built = buildFlarexGraphLayer(current, node, layer.durationSeconds, layerStart).layer;
      return applyFlarexGraphLayer(current, node, updater(built));
    });

  return (
    <div className="flarex-workspace">
      <div className="flarex-toolbar">
        <FlarexCompNameField comp={comp} onUpdateComp={updateComp} />
        {PALETTE_GROUPS.map((group) => (
          <div key={group.label} className="flarex-toolbar-group">
            <span className="flarex-toolbar-group-label">{group.label}</span>
            {group.types.map((type) => (
              <button
                key={type}
                type="button"
                className="flarex-toolbar-btn"
                style={{ borderLeft: `3px solid ${GROUP_COLORS[flarexNodeDefs[type].group] ?? "#8a8f98"}` }}
                title={`Add ${flarexNodeDefs[type].label} (click, or drag onto the canvas / a wire)`}
                onClick={() => handleAddNode(type)}
                draggable
                onDragStart={(e) => {
                  flarexPaletteDrag.current = type;
                  e.dataTransfer.setData("text/plain", type); // required by some browsers to start a drag
                  e.dataTransfer.effectAllowed = "copy";
                }}
                onDragEnd={() => {
                  flarexPaletteDrag.current = null;
                }}
              >
                {flarexNodeDefs[type].label}
              </button>
            ))}
          </div>
        ))}
        {selectedNodeIds.length >= 2 ? (
          <div className="flarex-toolbar-group flarex-align-group">
            <span className="flarex-toolbar-group-label">Align</span>
            {ALIGN_BUTTONS.map((b) => (
              <button key={b.mode} type="button" className="flarex-toolbar-btn flarex-align-btn" title={b.title} onClick={() => handleAlign(b.mode)}>
                {b.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <FlarexFrameRuler
        durationSeconds={layer.durationSeconds}
        fps={graph.composition?.fps ?? 30}
        layerStart={layerStart}
        fallbackTime={timeSeconds}
        isPlaying={isPlaying}
        keyframeTimes={selectedNodeKeyframeTimes}
        onSeekCompTime={(t) => onSeek(layerStart + t)}
      />
      <div className="flarex-body">
        <FlarexNodeCanvas comp={comp} selectedNodeIds={selectedNodeIds} onSelectNodes={setSelectedNodeIds} onUpdateComp={updateComp} />
        <FlarexInspector
          comp={comp}
          node={selectedNodeIds.length === 1 ? comp.nodes[selectedNodeIds[0]!] ?? null : null}
          onUpdateComp={updateComp}
          compTime={compTime}
          onSeekCompTime={(t) => onSeek(layerStart + t)}
        />
      </div>
      {graphOpen ? (
        graphBridge && graphNode ? (
          <BottomWorkspace
            layer={graphBridge.layer}
            overrideTargets={graphBridge.targets}
            onChange={handleGraphChange(graphNode.id)}
            currentTime={timeSeconds}
            onSeek={onSeek}
            fps={graph.composition?.fps ?? 30}
            onClose={() => onCloseGraph?.()}
          />
        ) : (
          <section className="bottom-workspace bottom-workspace--flarex-hint">
            <div className="bottom-workspace-empty">Select a single node to edit its animation curves.</div>
          </section>
        )
      ) : null}
    </div>
  );
}

/** Inline-editable comp name in the toolbar — local draft, commits on blur/Enter (one undo step per
 *  rename, not per keystroke); Escape reverts. Draft resyncs when the comp identity changes. */
function FlarexCompNameField({ comp, onUpdateComp }: { comp: FlarexComp; onUpdateComp: (updater: (comp: FlarexComp) => FlarexComp) => void }) {
  const [draft, setDraft] = useState(comp.name);
  useEffect(() => {
    setDraft(comp.name);
  }, [comp.id, comp.name]);
  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== comp.name) {
      onUpdateComp((current) => ({ ...current, name: trimmed }));
    } else {
      setDraft(comp.name);
    }
  };
  return (
    <input
      className="flarex-toolbar-comp-input"
      title={comp.id}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        else if (e.key === "Escape") {
          setDraft(comp.name);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

/**
 * Fusion-style frame ruler above the node canvas: the CLIP's local frame range on the shared
 * transport (scrub = seek the one viewer). Ticks every second, amber playhead, current-frame
 * readout (frames, like Fusion — not timecode).
 *
 * Live playhead: subscribes to the HIGH-FREQUENCY playback clock directly (the
 * PlayheadTimeReadout pattern) so the line moves smoothly during playback while only THIS tiny
 * component re-renders — never the workspace tree (clock-tier doctrine; the workspace itself
 * stays on ColdTime). Scrubs are FRAME-QUANTIZED and deduped, so a drag issues at most one seek
 * per crossed frame instead of one per pointer event (the "laggy drag" fix).
 */
function FlarexFrameRuler({
  durationSeconds,
  fps,
  layerStart,
  fallbackTime,
  isPlaying,
  keyframeTimes,
  onSeekCompTime,
}: {
  durationSeconds: number;
  fps: number;
  layerStart: number;
  fallbackTime: number;
  isPlaying: boolean;
  /** Comp-local keyframe times (seconds) of the currently-selected node, for the amber tick row. */
  keyframeTimes: number[];
  onSeekCompTime: (t: number) => void;
}) {
  const liveTime = usePlaybackClock(fallbackTime, true);
  const dur = Math.max(0.001, durationSeconds);
  const raw = Math.max(0, Math.min(liveTime - layerStart, dur));
  // Resume-glitch latch: right after play starts, the committed clock can step a few frames BACK
  // (audio-anchor start latency — same known symptom as the main timeline playhead) before moving
  // forward. While PLAYING, the displayed playhead is monotonic: small backward steps (<0.35s)
  // hold the previous position; a bigger jump is a real seek/loop and passes through. Paused
  // scrubs/seeks always pass through untouched.
  const latchRef = useRef(raw);
  let clamped = raw;
  if (isPlaying && raw < latchRef.current && latchRef.current - raw < 0.35) {
    clamped = latchRef.current;
  }
  latchRef.current = clamped;
  const frame = Math.round(clamped * fps);
  const lastFrame = Math.max(1, Math.round(dur * fps));
  const lastSentFrameRef = useRef<number | null>(null);
  const scrub = (event: React.PointerEvent) => {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
    const targetFrame = Math.round(frac * dur * fps);
    if (lastSentFrameRef.current === targetFrame) return;
    lastSentFrameRef.current = targetFrame;
    onSeekCompTime(targetFrame / fps);
  };
  const seconds = Math.floor(dur);
  const labels: number[] = [];
  for (let s = 0; s <= seconds; s += Math.max(1, Math.ceil(seconds / 12))) labels.push(s);
  return (
    <div className="flarex-framebar">
      <div
        className="flarex-framebar-ruler"
        style={{ ["--tick-w" as string]: `${100 / dur}%` }}
        onPointerDown={(e) => {
          (e.target as Element).setPointerCapture(e.pointerId);
          scrub(e);
        }}
        onPointerMove={(e) => {
          if (e.buttons & 1) scrub(e);
        }}
        onPointerUp={() => {
          lastSentFrameRef.current = null;
        }}
      >
        {labels.map((s) => (
          <span key={s} className="flarex-framebar-label" style={{ left: `${(s / dur) * 100}%` }}>
            {Math.round(s * fps)}
          </span>
        ))}
        <div className="flarex-framebar-playhead" style={{ left: `${(clamped / dur) * 100}%` }} />
        {keyframeTimes
          .filter((t) => t >= 0 && t <= dur)
          .map((t) => (
            <span
              key={t}
              className="flarex-framebar-keyframe"
              title={`Keyframe at frame ${Math.round(t * fps)}`}
              style={{ left: `${(t / dur) * 100}%` }}
              onPointerDown={(e) => {
                // A diamond click seeks exactly to it — never falls through to the ruler's scrub.
                e.stopPropagation();
              }}
              onClick={(e) => {
                e.stopPropagation();
                onSeekCompTime(t);
              }}
            />
          ))}
      </div>
      <span className="flarex-framebar-readout" title={`Frame ${frame} of ${lastFrame} (${fps} fps)`}>
        {frame}
      </span>
    </div>
  );
}

export default FlarexWorkspace;
