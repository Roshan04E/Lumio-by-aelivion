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
import { getFlarexNodeDefinition } from "./node-defs";
import type { FlarexComp, FlarexNode } from "./types";

/** Bump when the MEANING of the hash changes (a new folded input class, a fold-algorithm change) —
 *  the ADR-009 ContractVersion escape hatch that invalidates every cached content at once. */
export const FLAREX_CONTENT_HASH_CONTRACT_VERSION = 1;

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
export function computeFlarexContentHashes(comp: FlarexComp, timeSeconds: number): Map<string, string> {
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

    // R3: upstream content hashes in the def's fixed socket order (topology + fan-in order).
    const upstreamTokens = getFlarexNodeDefinition(node.type).inputs.map((input) => {
      const from = edgeInto.get(`${nodeId}:${input.id}`);
      return `${input.id}<${from ? hashNode(from) : "∅"}`;
    });

    visiting.delete(nodeId);

    const digest = fnv1a64(
      JSON.stringify([FLAREX_CONTENT_HASH_CONTRACT_VERSION, node.type, node.enabled, paramTokens, upstreamTokens]),
    );
    hashes.set(nodeId, digest);
    return digest;
  };

  for (const nodeId of Object.keys(nodes)) hashNode(nodeId);
  return hashes;
}
