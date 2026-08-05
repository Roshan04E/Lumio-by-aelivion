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

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { getLivePlaybackTime, usePlaybackClock } from "../../playback/playback-clock";
import { traceFlarex } from "../../playback/flarex-trace";
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
  type SourceAsset,
  type TimelineLayer,
} from "@orreris/shared";
import type { SceneViewerCaptureHandle } from "../../components/ScenePreviewCanvas";
import type { SavedTrack } from "../../lib/trackLibrary";
import { isFlarexMaskNode } from "./flarex-mask-bridge";
import { FlarexInspector } from "./FlarexInspector";
import { FlarexSourceViewer } from "./FlarexSourceViewer";
import { rebuildSourceProxy } from "../performance/sourceProxyEngine";
import { FlarexNodeIcon } from "./flarex-node-icons";
import { FlarexNodeBrowser } from "./FlarexNodeBrowser";
import { installFlarexDragTrace } from "./flarex-drag-trace";
import { FlarexProxyButton } from "./FlarexProxyButton";
import { FlarexNodeCanvas, flarexPaletteDrag, flarexTraceDragStart, nextNodePosition } from "./FlarexNodeCanvas";
import { FLAREX_PINNED_NODES, alignFlarexNodes, type FlarexAlignMode } from "./flarex-canvas-model";

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

export interface FlarexWorkspaceProps {
  graph: ProjectGraph;
  /** The active clip (Edit-page selection; falls back to the last inspected clip). */
  layer: TimelineLayer | null;
  /** The media-pool assets a MediaIn node may load (asset-source MediaIn, FLAREX.md Phase 2). */
  assets?: SourceAsset[];
  /** Enter media-pool "pick one" mode for a MediaIn node's source (reuses the timeline's Replace-asset
   *  flow — the user clicks a real media-pool tile, EditorPage writes the node's `sourceAssetId`). */
  onPickSource?: (compId: string, nodeId: string) => void;
  /**
   * REPORT (one-way) which mask node the viewer should let you edit on-canvas — the comp + node ids
   * only, never a command. EditorPage bridges those into the real mask overlay; this component keeps
   * owning selection, exactly like every other host↔panel seam in the editor (a report that could be
   * fed back as a command is the voice-mode feedback loop all over again).
   */
  onMaskNodeChange?: (target: { compId: string; nodeId: string } | null) => void;
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
  /** The main viewer's capture handle — node thumbnails render through the preview's own compositor
   *  (Slice 6). Absent ⇒ nodes render without pictures and nothing is scheduled. */
  viewerCaptureRef?: React.MutableRefObject<SceneViewerCaptureHandle | null> | undefined;
}

/** Node-thumbnail view mode, remembered across sessions. Defaults ON — it is the Fusion/Resolve
 *  default and the whole point of the feature — but it is a real switch because the honest answer to
 *  "does this cost anything?" on a weak GPU is "a little, on idle". */
const THUMBNAILS_KEY = "orreris.flarex.nodeThumbnails";
function readThumbnailPref(): boolean {
  try {
    return window.localStorage.getItem(THUMBNAILS_KEY) !== "0";
  } catch {
    return true;
  }
}

export function FlarexWorkspace({ graph, layer, assets = [], onPickSource, onMaskNodeChange, onUpdateGraph, timeSeconds, onSeek, isPlaying = false, graphOpen = false, onCloseGraph, viewerCaptureRef }: FlarexWorkspaceProps) {
  const comp = layer ? getLayerFlarexComp(graph, layer) : undefined;
  // Saved tracks a Tracker node may follow. Derived from the `graph` this component already holds
  // rather than threaded as a new prop: EditorPage is the 15k-line monolith the repo keeps touch
  // points down in, and `editableFields.trackLibrary` is the same source the clip-mask tracker reads.
  const trackLibrary: SavedTrack[] = useMemo(() => {
    const stored = graph.editableFields?.trackLibrary;
    return Array.isArray(stored) ? (stored as SavedTrack[]) : [];
  }, [graph.editableFields]);
  const layerStart = layer?.startSeconds ?? 0;
  const compTime = Math.max(0, timeSeconds - layerStart);

  // Asset-source MediaIn (FLAREX.md Phase 2, Fusion Loader model): the media-pool assets a MediaIn may
  // load. Self-contained — the comp loads the asset directly, so nothing is borrowed from the timeline.
  // Only visual media (image/video); audio has no picture.
  const sourceAssets = assets
    .filter((asset) => {
      const mime = asset.fileType ?? "";
      return mime.startsWith("image") || mime.startsWith("video");
    })
    .map((asset) => ({
      id: asset.id,
      name: asset.fileName || asset.id,
      thumbnailUrl: asset.thumbnailUrl,
      type: (asset.fileType ?? "").startsWith("video") ? ("video" as const) : ("image" as const),
    }));
  // Multi-select (marquee/shift-click); the inspector shows the node only when exactly one is selected.
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  // Source Viewer (proxy vs original A/B) — opened from a MediaIn's source row to verify which stream plays.
  const [inspectAssetId, setInspectAssetId] = useState<string | null>(null);
  const inspectAsset = inspectAssetId
    ? (assets.find((a) => a.id === inspectAssetId) as (SourceAsset & { previewUrl?: string }) | undefined) ?? null
    : null;
  // Toolbar "Browse" popover (the full categorized/searchable node library — the twin of the canvas
  // Tab menu). Icon-only pins cover the commons; this is the everything-else entry point. Positioned
  // with position:fixed off the button rect because the toolbar clips overflow (overflow-x:auto).
  const [browseOpen, setBrowseOpen] = useState(false);
  /** A drag out of the Browse popover: keep it mounted AND do not re-render while it is in flight.
   *  Measured on the canvas menu — a setState in `dragstart` re-renders the subtree owning the drag
   *  source and Chrome cancels the drag (start 3, over 0). Refs, mutated directly. */
  const browseElRef = useRef<HTMLDivElement | null>(null);
  const browseBackdropElRef = useRef<HTMLDivElement | null>(null);
  const browsePassthroughRafRef = useRef(0);
  /** Deferred by one frame — writing `pointer-events: none` onto the drag source's ANCESTOR during
   *  `dragstart` cancels the drag in Chrome (measured: dragstart→dragend in 2ms, zero dragovers). */
  const setBrowseDragPassthrough = (on: boolean) => {
    cancelAnimationFrame(browsePassthroughRafRef.current);
    const apply = () => {
      for (const el of [browseElRef.current, browseBackdropElRef.current]) {
        if (!el) continue;
        el.style.pointerEvents = on ? "none" : "";
      }
      if (browseElRef.current) browseElRef.current.style.opacity = on ? "0.35" : "";
    };
    if (!on) apply();
    else browsePassthroughRafRef.current = requestAnimationFrame(apply);
  };
  const [browsePos, setBrowsePos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  // Node thumbnails (Slice 6) — a view mode, persisted like a preference, not project data.
  const [thumbnails, setThumbnails] = useState(readThumbnailPref);

  // Selection resets when the active comp changes (a different clip's graph).
  useEffect(() => {
    setSelectedNodeIds([]);
  }, [comp?.id]);

  // Full document-level drag trace while the Flarex page is mounted (`window.__rfFlarexDragLog`).
  // Debug-only; see flarex-drag-trace.ts for why handler-level instrumentation was not enough.
  useEffect(() => installFlarexDragTrace(), []);



  const updateComp = (updater: (comp: FlarexComp) => FlarexComp) => {
    if (!comp) return;
    const current = graph.flarexComps?.[comp.id];
    if (!current) return;
    const next = updater(current);
    if (next === current) return;
    // stampFlarexComp bumps comp.version (the render dirty key); graph.version bumps for sync.
    const stampedGraph = stampFlarexComp(graph, next);
    // The trace's anchor event: every node add/delete/wire/param edit funnels through here, so this is
    // where "I did a thing" lands in the same timeline as what the decoder did about it.
    //
    // Reported AFTER stamping, and that ordering is now load-bearing. This used to predict the version
    // as `(next.version ?? 0) + 1`, which was true only while the seam bumped unconditionally. Now that
    // it diffs, a ui-only write deliberately keeps its version — and a trace that still predicted the
    // increment would have shown the bump the fix exists to prevent, i.e. reported the failure it was
    // being used to verify. An instrument may not model the thing it measures; it reads it.
    traceFlarex("comp", next.id, {
      version: stampedGraph.flarexComps?.[next.id]?.version ?? 0,
      nodes: Object.keys(next.nodes).length,
      edges: next.edges.length,
      types: Object.values(next.nodes).map((n) => n.type).join(","),
      viewDot: next.previewNodeId ?? null,
    });
    onUpdateGraph({ ...stampedGraph, version: graph.version + 1 });
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

  /**
   * Nodes the Group button would actually collect: the selection minus the comp's fixed endpoints and
   * any layout node. MediaIn/MediaOut are the graph's anchors and Backdrops/Groups are chrome — folding
   * either into a collapsible container would hide something the user can never get back to by wiring.
   */
  const groupableNodeIds = selectedNodeIds.filter((id) => {
    const node = comp?.nodes[id];
    return Boolean(node) && node!.type !== "mediaIn" && node!.type !== "mediaOut" && node!.type !== "backdrop" && node!.type !== "group";
  });

  /** Collapse the selection into a Group, placed at the selection's top-left (its box auto-fits). */
  const handleGroupSelection = () => {
    updateComp((current) => {
      const members = groupableNodeIds.filter((id) => current.nodes[id]);
      if (members.length < 2) return current;
      const id = `g_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const xs = members.map((m) => current.nodes[m]!.ui.x);
      const ys = members.map((m) => current.nodes[m]!.ui.y);
      const node = createFlarexNode("group", id, Math.min(...xs), Math.min(...ys));
      node.params = { ...node.params, members: JSON.stringify(members) };
      setSelectedNodeIds([id]);
      return { ...current, nodes: { ...current.nodes, [id]: node } };
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

  // The single selected node, when it is a mask node — the viewer's on-canvas editor follows THIS.
  //
  // MUST stay ABOVE the two early returns below. It is a hook, and those returns are conditional on
  // `layer`/`comp`, so with the effect underneath them the component called 11 hooks when there was no
  // comp and 12 when there was. React reads that as a changed hook order and refuses to render
  // outright: "Rendered more hooks than during the previous render."
  //
  // It fires on the most ordinary transitions there are — opening the page with no clip selected and
  // then selecting one, or pressing "Create Flarex comp" from the empty state — which is why it
  // surfaced the moment someone drove the page rather than landing on it already populated.
  //
  // Everything it reads is now null-safe rather than guarded by an early return, and reporting `null`
  // when there is no comp is the correct behaviour anyway: there is no mask node to offer.
  const maskNodeId =
    comp && selectedNodeIds.length === 1 && isFlarexMaskNode(comp.nodes[selectedNodeIds[0]!])
      ? selectedNodeIds[0]!
      : null;
  const reportMaskNode = onMaskNodeChange;
  const compId = comp?.id ?? null;
  useEffect(() => {
    if (!reportMaskNode) return undefined;
    reportMaskNode(compId && maskNodeId ? { compId, nodeId: maskNodeId } : null);
    // Leaving the page / deselecting must retract it, or the viewer keeps offering to edit a node the
    // user can no longer see.
    return () => reportMaskNode(null);
  }, [reportMaskNode, compId, maskNodeId]);

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
        {/* Icon-only pinned commons (labels removed — they overflowed the strip; the glyph + tooltip
            carry identity). A thin divider marks each category change. Everything else (and the future
            node library) is reached via the Browse popover / the canvas Tab menu. */}
        <div className="flarex-palette">
          {FLAREX_PINNED_NODES.map((type, index) => {
            const def = flarexNodeDefs[type];
            const prevGroup = index > 0 ? flarexNodeDefs[FLAREX_PINNED_NODES[index - 1]!].group : def.group;
            return (
              <Fragment key={type}>
                {index > 0 && def.group !== prevGroup ? <span className="flarex-palette-divider" aria-hidden /> : null}
                <button
                  type="button"
                  className="flarex-toolbar-btn flarex-palette-btn"
                  title={`Add ${def.label} (click, or drag onto the canvas / a wire)`}
                  aria-label={`Add ${def.label}`}
                  onClick={() => handleAddNode(type)}
                  draggable
                  onDragStart={(e) => {
                    flarexPaletteDrag.current = type;
                    flarexTraceDragStart(type);
                    e.dataTransfer.setData("text/plain", type); // required by some browsers to start a drag
                    e.dataTransfer.effectAllowed = "copy";
                  }}
                  onDragEnd={() => {
                    flarexPaletteDrag.current = null;
                  }}
                >
                  <FlarexNodeIcon type={type} size={18} />
                </button>
              </Fragment>
            );
          })}
          <span className="flarex-palette-divider" aria-hidden />
          <button
            type="button"
            className={`flarex-toolbar-btn flarex-palette-browse${browseOpen ? " is-active" : ""}`}
            title="Browse all nodes (search / categories) — or press Tab on the canvas"
            aria-expanded={browseOpen}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setBrowsePos({ x: Math.min(r.left, window.innerWidth - 280), y: r.bottom + 4 });
              setBrowseOpen((v) => !v);
            }}
          >
            <span className="flarex-palette-browse-plus">＋</span>
            <span className="flarex-palette-browse-label">Nodes</span>
          </button>
        </div>
        {browseOpen ? (
          <>
            {/* Both of these must stand down during a drag OUT of the popover: the backdrop is
                `inset: 0` and would swallow every drop, and unmounting the popover on drag start
                would destroy the drag source and abort the drag. Same fault, same fix, as the
                canvas add-node menu. */}
            <div
              ref={browseBackdropElRef}
              className="flarex-menu-backdrop flarex-menu-backdrop--fixed"
              onPointerDown={() => setBrowseOpen(false)}
            />
            <div
              ref={browseElRef}
              className="flarex-node-menu flarex-palette-browse-pop"
              style={{ left: browsePos.x, top: browsePos.y }}
            >
              <FlarexNodeBrowser
                onPick={(type) => {
                  handleAddNode(type);
                  setBrowseOpen(false);
                }}
                onClose={() => setBrowseOpen(false)}
                // Same channel the single-icon palette buttons above use, so a node found by SEARCH
                // drags and splices identically to one that happened to earn a toolbar icon.
                onDragStartType={(type) => {
                  flarexPaletteDrag.current = type;
                  flarexTraceDragStart(type);
                  // Ref mutation, NOT setState — a re-render here kills the drag.
                  setBrowseDragPassthrough(true);
                }}
                onDragEndType={() => {
                  flarexPaletteDrag.current = null;
                  setBrowseDragPassthrough(false);
                  // Safe now: by `dragend` the drop has been delivered.
                  setBrowseOpen(false);
                }}
              />
            </div>
          </>
        ) : null}
        {/* Group and Thumbnails must come BEFORE the proxy cluster — that cluster is pushed right with
            margin-left:auto, so anything after it lands on the far side of the gap. */}
        <div className="flarex-toolbar-group">
          <button
            type="button"
            className={`flarex-toolbar-btn${thumbnails ? " is-active" : ""}`}
            title={thumbnails ? "Hide node thumbnails" : "Show node thumbnails (rendered only while idle)"}
            aria-pressed={thumbnails}
            onClick={() => {
              const next = !thumbnails;
              setThumbnails(next);
              try {
                window.localStorage.setItem(THUMBNAILS_KEY, next ? "1" : "0");
              } catch {
                /* private mode / storage disabled — the session-local toggle still works */
              }
            }}
          >
            Thumbs
          </button>
        </div>
        {/*
          VIEW-DOT NOTICE (ADR-012 §0.5, slice S1.2). The view dot used to re-root the EXPORT as well as
          the preview; it no longer does. That is a real change to what an existing project delivers, so
          it has to be surfaced — but a one-time modal saying "the view dot no longer re-roots export"
          is meaningless to this product's audience, who do not know what a view dot or a root is, and
          it gets dismissed unread by the one person it was for.

          So the notice IS the affordance: it appears only while a dot is set, states the distinction in
          the words a person would use, and clears with one click. It shows up exactly when it matters,
          in the place it matters, and it keeps working after the "one time" has passed.
        */}
        {comp?.previewNodeId ? (
          <div className="flarex-toolbar-group flarex-viewdot-notice">
            <span className="flarex-viewdot-notice-text" title="You are previewing one node's output. Exports and renders always use the Output node, so what you deliver is unaffected.">
              Previewing a node · export uses Output
            </span>
            <button
              type="button"
              className="flarex-toolbar-btn"
              title="Go back to previewing the finished comp"
              onClick={() => updateComp((current) => ({ ...current, previewNodeId: undefined }))}
            >
              Show final
            </button>
          </div>
        ) : null}
        {groupableNodeIds.length >= 2 ? (
          <div className="flarex-toolbar-group">
            <button type="button" className="flarex-toolbar-btn" title="Group the selected nodes (collapse with a double-click)" onClick={handleGroupSelection}>
              Group
            </button>
          </div>
        ) : null}
        <FlarexProxyButton composition={graph.composition} comp={comp} layer={layer} assets={assets} />
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
        <FlarexNodeCanvas
          comp={comp}
          selectedNodeIds={selectedNodeIds}
          onSelectNodes={setSelectedNodeIds}
          onUpdateComp={updateComp}
          sourceAssets={sourceAssets}
          thumbnails={thumbnails}
          thumbnailCapture={viewerCaptureRef}
          hostLayerId={layer.id}
          compTime={compTime}
          isPlaying={isPlaying}
        />
        <FlarexInspector
          comp={comp}
          node={selectedNodeIds.length === 1 ? comp.nodes[selectedNodeIds[0]!] ?? null : null}
          onUpdateComp={updateComp}
          compTime={compTime}
          onSeekCompTime={(t) => onSeek(layerStart + t)}
          sourceAssets={sourceAssets}
          trackLibrary={trackLibrary}
          onPickSource={onPickSource ? (nodeId) => onPickSource(comp.id, nodeId) : undefined}
          onInspectSource={(assetId) => setInspectAssetId(assetId)}
        />
      </div>
      {inspectAsset ? (
        <FlarexSourceViewer
          assetId={inspectAsset.id}
          name={inspectAsset.fileName || inspectAsset.id}
          originalUrl={inspectAsset.fileUrl ?? inspectAsset.previewUrl}
          onRebuild={() => rebuildSourceProxy(inspectAsset)}
          onClose={() => setInspectAssetId(null)}
        />
      ) : null}
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
 * Live playhead: while PLAYING the needle is driven by its own rAF loop writing the position
 * IMPERATIVELY — the same writer the main timeline playhead uses — never by a React re-render.
 *
 * It used to follow `PlayheadTimeReadout` (`usePlaybackClock`), which was wrong for a moving line:
 * that store is the COMMITTED clock, advanced only once per `playbackCommitIntervalMs` (16/40/90ms by
 * preview quality). A text readout at 11Hz is fine; a needle at 11Hz is visible stop-motion, which is
 * exactly what it looked like on the balanced/performance tiers (user report 2026-07-26). Re-rendering
 * per rAF would not have fixed it either, since the value itself only changes at the commit tier — the
 * needle has to read `getLivePlaybackTime()` (anchor-derived, sub-commit truth) on its own clock.
 *
 * Paused, React rendering still owns the position (scrubs/seeks are discrete and cheap). Scrubs are
 * FRAME-QUANTIZED and deduped, so a drag issues at most one seek per crossed frame (the "laggy drag" fix).
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

  // ── LIVE NEEDLE (imperative, playback only) ──────────────────────────────────────────────────
  // See the component docstring: the committed clock steps at 16/40/90ms, so the needle reads the
  // anchor-derived live time on its own rAF and writes the DOM directly. The frame readout is written
  // here too — it is the same value, and letting it lag at the commit tier while the line runs smooth
  // would just move the stutter into the number.
  const playheadElRef = useRef<HTMLDivElement | null>(null);
  const readoutElRef = useRef<HTMLSpanElement | null>(null);
  const liveFloorRef = useRef(0);
  useEffect(() => {
    if (!isPlaying) return undefined;
    liveFloorRef.current = Math.max(0, Math.min(getLivePlaybackTime() - layerStart, dur));
    let raf = 0;
    const tick = () => {
      const local = Math.max(0, Math.min(getLivePlaybackTime() - layerStart, dur));
      // Same monotonic guard the React path applies: the audio anchor can nudge a few ms backward at
      // play start, and the needle must never visibly step back. A real seek/loop (>0.35s) passes.
      const next = local < liveFloorRef.current && liveFloorRef.current - local < 0.35 ? liveFloorRef.current : local;
      liveFloorRef.current = next;
      const el = playheadElRef.current;
      if (el) el.style.left = `${(next / dur) * 100}%`;
      const readout = readoutElRef.current;
      if (readout) readout.textContent = String(Math.round(next * fps));
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [isPlaying, layerStart, dur, fps]);
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
        <div ref={playheadElRef} className="flarex-framebar-playhead" style={{ left: `${(clamped / dur) * 100}%` }} />
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
      <span ref={readoutElRef} className="flarex-framebar-readout" title={`Frame ${frame} of ${lastFrame} (${fps} fps)`}>
        {frame}
      </span>
    </div>
  );
}

export default FlarexWorkspace;
