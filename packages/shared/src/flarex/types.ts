/**
 * Flarex — node-based compositing comps (FLAREX.md).
 *
 * A `FlarexComp` is a per-clip node graph (Fusion-style) stored first-class in
 * `ProjectGraph.flarexComps` and referenced by `TimelineLayer.flarexCompId` — the same
 * registry pattern as nested compositions (`compositions` / `nestedCompositionId`), so
 * persistence/sync/undo are inherited. Renderers never read the graph directly: a
 * deterministic lowering compiler (`compile-flarex.ts`, Phase 1) turns the comp into the
 * `SceneDraw` primitives all three renderers already agree on — parity by construction.
 *
 * Determinism rule: `FlarexNode.ui` and `FlarexComp.view` are editor-only and MUST NOT
 * influence lowering output.
 */

import type { TimelineKeyframeV2 } from "../types";

export type FlarexSocketType = "image" | "matte" | "number";

export type FlarexNodeType =
  | "mediaIn"
  | "mediaOut"
  | "merge"
  | "transform"
  | "crop"
  | "channelBoolean"
  | "color"
  | "colorCorrect"
  | "colorCurves"
  | "hueSat"
  | "colorWheels"
  | "hslQualifier"
  | "lut"
  | "look"
  | "vignette"
  | "grain"
  | "blur"
  | "directionalBlur"
  | "radialBlur"
  | "glow"
  | "sharpen"
  | "pixelate"
  | "prism"
  | "filter"
  | "rectMask"
  | "ellipseMask"
  | "polygonMask"
  | "bezierMask"
  | "matteControl"
  | "chromaKey"
  | "lumaKey"
  | "text"
  | "background"
  | "aiMatte"
  | "tracker"
  | "timeSpeed"
  | "backdrop"
  | "group"
  | "reroute";

export const flarexNodeTypes: readonly FlarexNodeType[] = [
  "mediaIn",
  "mediaOut",
  "merge",
  "transform",
  "crop",
  "channelBoolean",
  "color",
  "colorCorrect",
  "colorCurves",
  "hueSat",
  "colorWheels",
  "hslQualifier",
  "lut",
  "look",
  "vignette",
  "grain",
  "blur",
  "directionalBlur",
  "radialBlur",
  "glow",
  "sharpen",
  "pixelate",
  "prism",
  "filter",
  "rectMask",
  "ellipseMask",
  "polygonMask",
  "bezierMask",
  "matteControl",
  "chromaKey",
  "lumaKey",
  "text",
  "background",
  "aiMatte",
  "tracker",
  "timeSpeed",
  "backdrop",
  "group",
  "reroute",
] as const;

export interface FlarexNode {
  id: string;
  type: FlarexNodeType;
  label?: string | undefined;
  /** false = pass-through (Fusion Ctrl+P): the node forwards its primary input unchanged. */
  enabled: boolean;
  /** Flat scalars; complex payloads are JSON.stringify'd strings (the effect-params convention). */
  params: Record<string, string | number | boolean>;
  /** Node-canvas position. Editor-only — never read by the lowering compiler. */
  ui: { x: number; y: number };
}

export interface FlarexEdgeEndpoint {
  nodeId: string;
  /** Socket id from the node definition, e.g. "out", "bg", "fg", "mask". */
  socket: string;
}

export interface FlarexEdge {
  id: string;
  from: FlarexEdgeEndpoint;
  to: FlarexEdgeEndpoint;
}

export interface FlarexCompView {
  panX: number;
  panY: number;
  zoom: number;
}

export interface FlarexComp {
  id: string;
  name: string;
  nodes: Record<string, FlarexNode>;
  edges: FlarexEdge[];
  /**
   * Node-param keyframes. Reuses the shared keyframe model verbatim with
   * `target: { scope: "flarexNode", effectId: <nodeId>, property: <paramKey> }`.
   */
  animations: TimelineKeyframeV2[];
  /**
   * Monotonic edit counter — THE dirty/invalidation key. Every mutation (via the flarex.*
   * timeline actions) bumps it; preview memo keys include `(flarexCompId, version)` so only
   * the touched clip re-lowers.
   */
  version: number;
  /** Persisted node-canvas view state. Editor-only — never read by the lowering compiler. */
  view?: FlarexCompView | undefined;
  /**
   * Fusion "view dot": when set (and valid), the compiler roots at THIS node instead of MediaOut,
   * so the shared viewer shows that node's output everywhere (preview AND export — intentionally,
   * it's persisted state the user toggles off before delivery; the canvas marks it prominently).
   */
  previewNodeId?: string | undefined;
}
