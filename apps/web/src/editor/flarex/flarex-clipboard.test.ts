/**
 * Node clipboard (Sonnet round 2, N3) — standalone assert script (repo convention: no test
 * framework, exits non-zero on failure).
 *
 *   pnpm --filter @orreris/web flarex:clipboard:test
 *
 * `cloneFlarexNodes` is the pure remap function copy/paste/duplicate all share: fresh ids,
 * +24/+24 position offset, internal edges preserved, external/dangling edges dropped, MediaIn/Out
 * never clonable.
 */

import { createFlarexComp, createFlarexNode } from "@orreris/shared";
import { cloneFlarexNodes } from "./flarex-canvas-model";

let failures = 0;
function check(name: string, condition: boolean): void {
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${name}`);
  }
}

{
  // Two wired nodes (blur -> glow) clone to fresh ids with the internal edge preserved.
  const comp = createFlarexComp("c1", "Clip");
  const blur = createFlarexNode("blur", "b1", 100, 200);
  const glow = createFlarexNode("glow", "g1", 260, 200);
  comp.nodes[blur.id] = blur;
  comp.nodes[glow.id] = glow;
  comp.edges = [
    { id: "e1", from: { nodeId: "c1_in", socket: "out" }, to: { nodeId: "b1", socket: "in" } },
    { id: "e2", from: { nodeId: "b1", socket: "out" }, to: { nodeId: "g1", socket: "in" } },
    { id: "e3", from: { nodeId: "g1", socket: "out" }, to: { nodeId: "c1_out", socket: "in" } },
  ];
  const selected = [blur, glow];
  const internalEdges = comp.edges.filter((e) => e.from.nodeId === "b1" && e.to.nodeId === "g1");
  const { nodes, edges } = cloneFlarexNodes(selected, comp.edges, "clone1");

  check("clones both selected nodes", nodes.length === 2);
  check("cloned ids are fresh (never collide with originals)", nodes.every((n) => n.id !== "b1" && n.id !== "g1"));
  check("cloned ids are distinct from each other", nodes[0]!.id !== nodes[1]!.id);
  check("position offset +24/+24 from the original", nodes[0]!.ui.x === blur.ui.x + 24 && nodes[0]!.ui.y === blur.ui.y + 24);
  check("only the internal edge survives (external MediaIn/Out edges dropped)", edges.length === internalEdges.length && edges.length === 1);
  const clonedBlur = nodes.find((n) => n.type === "blur")!;
  const clonedGlow = nodes.find((n) => n.type === "glow")!;
  check("cloned edge points at the CLONED ids, not the originals", edges[0]!.from.nodeId === clonedBlur.id && edges[0]!.to.nodeId === clonedGlow.id);
  check("edge id is fresh too", !comp.edges.some((e) => e.id === edges[0]!.id));
}

{
  // MediaIn/Out passed in are never clonable, even if the caller forgot to filter them out.
  const comp = createFlarexComp("c2", "Guard");
  const blur = createFlarexNode("blur", "b1");
  comp.nodes[blur.id] = blur;
  comp.edges = [
    { id: "e1", from: { nodeId: "c2_in", socket: "out" }, to: { nodeId: "b1", socket: "in" } },
    { id: "e2", from: { nodeId: "b1", socket: "out" }, to: { nodeId: "c2_out", socket: "in" } },
  ];
  const selected = [comp.nodes["c2_in"]!, blur, comp.nodes["c2_out"]!];
  const { nodes, edges } = cloneFlarexNodes(selected, comp.edges, "clone2");
  check("MediaIn/Out are never cloned even if selected", nodes.length === 1 && nodes[0]!.type === "blur");
  check("edges touching the excluded MediaIn/Out endpoints are dropped", edges.length === 0);
}

{
  // Duplicate (Ctrl+D) is copy+paste in one step — calling clone twice on the same source never
  // produces colliding ids (fresh idPrefix each call, mirroring Date.now()+random in the caller).
  const a = createFlarexNode("sharpen", "s1", 0, 0);
  const { nodes: firstPaste } = cloneFlarexNodes([a], [], "dup_1");
  const { nodes: secondPaste } = cloneFlarexNodes([a], [], "dup_2");
  check("repeated clones of the same source never collide", firstPaste[0]!.id !== secondPaste[0]!.id);
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nflarex clipboard: all checks passed");
