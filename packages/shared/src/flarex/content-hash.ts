/**
 * Flarex node content hashing — ADR-009 (Content Version Contract), rules R1 + R3.
 *
 * `NodeContentHash` is a Merkle content hash of a node:
 *   node.type + enabled + every param RESOLVED to its value at comp-local time t
 *   (R1 — resolve drivers to values: a keyframed param contributes its evaluated value, never its
 *   keyframe track, so two nodes that resolve equal at t hash equal)
 *   folded with the content hashes of its wired upstream inputs, in the node def's fixed socket
 *   order (R3 — topology explicit: a rewire changes every downstream hash; fan-in order is content).
 *
 * It is PURE node content. It does NOT read render resolution, frame time, or any environment
 * value — those are the CONTEXT axis, a SEPARATE component of the cache key
 * (ADR-009: CacheKey = (ContractVersion, ContextVersion, NodeContentHash)), owned by the cache
 * layer, never folded in here. Numbers serialize at full precision — no quantization (ADR-009
 * rejects it; a spurious miss is wasted work, never a wrong pixel).
 *
 * Node-type-blind (ADR-010): this reads a node's declared param map and input sockets uniformly;
 * it contains no per-node-type branch. The returned token is opaque and immutable (ADR-010 §6) —
 * the FNV-1a digest below can be swapped for a cryptographic hash with no contract change.
 */
import { evaluateFlarexNodeParam } from "../animation";
import { frameProfiler } from "../color/frame-profiler";
import { getFlarexNodeDefinition } from "./node-defs";
import type { FlarexComp, FlarexNode } from "./types";

/** Bump when the MEANING of the hash changes (a new folded input class, a fold-algorithm change) —
 *  the ADR-009 ContractVersion escape hatch that invalidates every cached content at once. */
export const FLAREX_CONTENT_HASH_CONTRACT_VERSION = 2;

// FNV-1a, 64-bit (BigInt) — deterministic, dependency-free, well-distributed. The token is opaque
// (ADR-010 §6): callers never interpret it, so the digest is an implementation detail.
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

function fnv1a64(input: string): string {
  let h = FNV_OFFSET;
  for (let i = 0; i < input.length; i += 1) {
    h ^= BigInt(input.charCodeAt(i));
    h = (h * FNV_PRIME) & MASK64;
  }
  return h.toString(16).padStart(16, "0");
}

/** Canonical, unambiguous serialization of a resolved param value. JSON quoting keeps strings from
 *  colliding with numbers/delimiters; full-precision numbers avoid quantization. */
function canonicalValue(value: unknown): string {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : `#${String(value)}`;
  if (typeof value === "boolean") return value ? "T" : "F";
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null || value === undefined) return "∅";
  return JSON.stringify(value);
}

/**
 * Content hash for every node in a comp at comp-local time `timeSeconds`. Memoized backwards DFS
 * over the wiring (mirrors the compiler's `edgeInto`); cycles fold a stable sentinel so the hash is
 * always defined (matching the compiler's cycle soft-degrade). The map is keyed by node id, but the
 * hash VALUE is identity-free — two structurally identical nodes (same type/params/upstream content)
 * hash equal regardless of their ids.
 */
/**
 * ADR-023 D11/T-8 — resolve a font FAMILY to the identity of the bytes it will actually rasterize
 * with (a `fileHash`, or any stable token for "these bytes"). Optional: a caller that supplies none
 * gets exactly the hashes it got before this parameter existed, because the term is then empty
 * rather than a placeholder. Absent stays absent (D1a), here as everywhere.
 */
export type FlarexFontIdentityResolver = (family: string) => string | undefined;

export function computeFlarexContentHashes(
  comp: FlarexComp,
  timeSeconds: number,
  resolveFontIdentity?: FlarexFontIdentityResolver
): Map<string, string> {
  const nodes = comp.nodes;

  // to-socket → from-node (a socket accepts at most one wire; the healer enforces this).
  const edgeInto = new Map<string, string>();
  for (const edge of comp.edges) {
    edgeInto.set(`${edge.to.nodeId}:${edge.to.socket}`, edge.from.nodeId);
  }

  const hashes = new Map<string, string>();
  const visiting = new Set<string>();

  const resolveParam = (node: FlarexNode, key: string, raw: unknown): unknown => {
    // R1: only numeric params can carry a keyframe driver; resolve them to the value at t. A
    // non-animated numeric returns its base, so resolving every numeric uniformly stays node-blind.
    if (typeof raw !== "number") return raw;
    return evaluateFlarexNodeParam({ animations: comp.animations, baseValue: raw, nodeId: node.id, paramKey: key, timeSeconds });
  };

  const hashNode = (nodeId: string): string => {
    const cached = hashes.get(nodeId);
    if (cached !== undefined) return cached;
    if (visiting.has(nodeId)) return "⟲"; // cycle — stable sentinel, matches the compiler's degrade
    const node = nodes[nodeId];
    if (!node) return "∅"; // dangling upstream

    visiting.add(nodeId);

    // R1: params resolved to values, in a stable (sorted) key order.
    const paramTokens = Object.keys(node.params)
      .sort()
      .map((key) => `${key}=${canonicalValue(resolveParam(node, key, node.params[key]))}`);

    const def = getFlarexNodeDefinition(node.type);

    /**
     * R1, for tracks that arrive as a serialized payload rather than as a number (ContractVersion 2).
     *
     * R1's rule is that a keyframed param contributes its EVALUATED VALUE, never its keyframe track.
     * `resolveParam` above enforces that for numeric params by running the animation evaluator. A param
     * whose value IS a track — a mask node's `shapeKeyframes` — has no numeric form to resolve, so it
     * hashed as a constant string: the node's hash was IDENTICAL at every time while its geometry
     * animated, and every consumer keyed on the hash would serve one frame's shape forever. That is
     * DEBT-016's class exactly (a key omitting an input the cached value depends on), and the node
     * thumbnail cache — which keys on `(ContractVersion, contentHash)` with no time axis at all — is
     * where it would have shown.
     *
     * The fix is a TIME TERM, added only when a declared track param actually carries a track. Folding
     * time unconditionally would put a per-frame value in every key and destroy reuse for the static
     * nodes these caches serve best (the same argument the compiler's own retime term makes at its
     * `if (at !== ctx.timeSeconds)` site). Static nodes therefore hash exactly as before.
     *
     * Node-blind (ADR-010): `trackParams` is read off the definition uniformly, like `inputs` below.
     * This function still contains no per-node-type branch and knows nothing about masks.
     */
    const animatedByTrack = (def.trackParams ?? []).some((key) => {
      const raw = node.params[key];
      return typeof raw === "string" && raw !== "" && raw !== "[]";
    });

    /**
     * D11/T-8: the identity of the BYTES this node will rasterize with, not just the family NAME.
     *
     * Node-blind, like `animatedByTrack` above: the params to look at come from the definition, and
     * this function still contains no per-node-type branch. Empty when no resolver is supplied or the
     * family is unknown, so every existing caller hashes byte-identically to before.
     */
    const fontTokens = (def.fontParams ?? [])
      .map((key) => {
        const family = node.params[key];
        if (typeof family !== "string" || !family) return "";
        const identity = resolveFontIdentity?.(family);
        return identity ? `${key}#${identity}` : "";
      })
      .filter(Boolean);

    // R3: upstream content hashes in the def's fixed socket order (topology + fan-in order).
    const upstreamTokens = def.inputs.map((input) => {
      const from = edgeInto.get(`${nodeId}:${input.id}`);
      return `${input.id}<${from ? hashNode(from) : "∅"}`;
    });

    visiting.delete(nodeId);

    const digest = fnv1a64(
      JSON.stringify([
        FLAREX_CONTENT_HASH_CONTRACT_VERSION,
        node.type,
        node.enabled,
        paramTokens,
        upstreamTokens,
        animatedByTrack ? `t:${timeSeconds.toFixed(6)}` : "",
        // Spread, not pushed as an array: an empty list contributes nothing at all, so a comp with no
        // font-bearing node — or a caller with no resolver — hashes exactly as it did before D11.
        ...fontTokens,
      ]),
    );
    hashes.set(nodeId, digest);
    // Profiler-only (no-op unless recording): the node's LOCAL token (own content, WITHOUT upstream) lets
    // the frame report say WHY a hash changed — own params vs. an upstream child's hash propagating down.
    frameProfiler.noteHashNode(
      nodeId,
      node.type,
      digest,
      // The time term belongs in the LOCAL token too, or the frame report would blame an upstream child
      // for a change that is this node's own animating outline.
      JSON.stringify([node.type, node.enabled, paramTokens, animatedByTrack ? `t:${timeSeconds.toFixed(6)}` : "", ...fontTokens]),
    );
    return digest;
  };

  for (const nodeId of Object.keys(nodes)) hashNode(nodeId);
  return hashes;
}
