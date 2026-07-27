/**
 * Node align/distribute (Sonnet round 3, F5.2) — standalone assert script (repo convention: no
 * test framework, exits non-zero on failure).
 *
 *   pnpm --filter @orreris/web flarex:align:test
 *
 * `alignFlarexNodes` is pure position math; the caller applies the result as ONE `onUpdateComp`
 * commit. Also covers `nodeWidth`/`hitTest` for the F2 backdrop/reroute geometry deviations.
 */

import { createFlarexNode } from "@orreris/shared";
import {
  GROUP_COLLAPSED_W,
  GROUP_PADDING,
  GROUP_TITLEBAR_H,
  alignFlarexNodes,
  backdropSize,
  collapsedMemberOwners,
  expandGroupDragSet,
  groupMembers,
  groupRect,
  hitTest,
  nodeWidth,
  socketAnchor,
  type FlarexViewState,
} from "./flarex-canvas-model";

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
  // Fewer than 2 nodes is a no-op (nothing to align relative to).
  const solo = createFlarexNode("blur", "b1", 0, 0);
  check("align with <2 nodes is a no-op", Object.keys(alignFlarexNodes([solo], "left")).length === 0);
}

{
  const a = createFlarexNode("blur", "a", 0, 0);
  const b = createFlarexNode("blur", "b", 200, 80);
  const c = createFlarexNode("blur", "c", 400, 160);

  const left = alignFlarexNodes([a, b, c], "left");
  check("align left: all share the min x", left.a?.x === 0 && left.b?.x === 0 && left.c?.x === 0);
  check("align left: y unchanged", left.a?.y === 0 && left.b?.y === 80 && left.c?.y === 160);

  const top = alignFlarexNodes([a, b, c], "top");
  check("align top: all share the min y", top.a?.y === 0 && top.b?.y === 0 && top.c?.y === 0);

  const centerH = alignFlarexNodes([a, b, c], "centerH");
  const centers = [a, b, c].map((n) => centerH[n.id]!.x + nodeWidth(n) / 2);
  check("align centerH: all horizontal centers match", Math.abs(centers[0]! - centers[1]!) < 1 && Math.abs(centers[1]! - centers[2]!) < 1);

  // Distribute needs 3+; evenly spaces the sorted nodes' left edges.
  const distributeH = alignFlarexNodes([a, b, c], "distributeH");
  check("distributeH: first node unchanged", distributeH.a?.x === 0);
  check("distributeH: last node unchanged", distributeH.c?.x === 400);
  check("distributeH: middle node is exactly between", distributeH.b?.x === 200);

  const onlyTwo = alignFlarexNodes([a, b], "distributeH");
  check("distribute with only 2 nodes is a no-op (no meaningful middle)", Object.keys(onlyTwo).length === 0);
}

{
  // nodeWidth/backdropSize deviations (F2): reroute is small+fixed, backdrop reads its own params.
  const reroute = createFlarexNode("reroute", "r1", 0, 0);
  check("reroute width is the small fixed size, not NODE_W", nodeWidth(reroute) < 40);

  const backdrop = createFlarexNode("backdrop", "bd1", 0, 0);
  backdrop.params = { ...backdrop.params, w: 500, h: 300 };
  check("backdrop width reads its own w param", nodeWidth(backdrop) === 500);
  check("backdrop size reads both w/h params", backdropSize(backdrop).w === 500 && backdropSize(backdrop).h === 300);
}

{
  // hitTest: a backdrop's BODY (not titlebar/resize-handle) must register as background, so a
  // marquee-select drag starting over it is never swallowed (the F2 "don't swallow marquee" rule).
  const backdrop = createFlarexNode("backdrop", "bd1", 0, 0);
  backdrop.params = { ...backdrop.params, w: 400, h: 300 };
  const comp = { id: "c1", name: "C", nodes: { bd1: backdrop }, edges: [], animations: [], version: 1 };
  const view: FlarexViewState = { panX: 0, panY: 0, zoom: 1 };
  check("click in the backdrop BODY (not titlebar) is background", hitTest(comp, view, 200, 200).kind === "background");
  check("click in the backdrop TITLEBAR is a node hit (move)", hitTest(comp, view, 50, 5).kind === "node");
  check("click on the backdrop RESIZE HANDLE is a dedicated hit", hitTest(comp, view, 396, 296).kind === "backdropResize");
}

// --- Group / Compound geometry ---------------------------------------------
{
  const a = createFlarexNode("blur", "a", 100, 100);
  const b = createFlarexNode("glow", "b", 300, 180);
  const grp = createFlarexNode("group", "g1", 0, 0);
  grp.params = { ...grp.params, members: JSON.stringify(["a", "b"]) };
  const comp = { id: "c1", name: "C", nodes: { a, b, g1: grp }, edges: [], animations: [], version: 1 };
  const view: FlarexViewState = { panX: 0, panY: 0, zoom: 1 };

  // The box AUTO-FITS its members, so nothing stored can drift away from where they actually are.
  const rect = groupRect(comp, grp);
  check("group box wraps its members (left/top padded, titlebar above)",
    rect.x === 100 - GROUP_PADDING && rect.y === 100 - GROUP_PADDING - GROUP_TITLEBAR_H);
  check("group box spans to the far member's right/bottom edge",
    rect.w === 300 + nodeWidth(b, comp) - 100 + GROUP_PADDING * 2);
  // Move a member → the box follows, with no stored size to update.
  const moved = { ...comp, nodes: { ...comp.nodes, b: { ...b, ui: { x: 500, y: 180 } } } };
  check("group box follows a member that moves", groupRect(moved, moved.nodes.g1!).w > rect.w);

  check("group members parse from the JSON payload", groupMembers(grp).join(",") === "a,b");
  check("a malformed member payload degrades to empty, never throws",
    groupMembers({ ...grp, params: { ...grp.params, members: "{oops" } }).length === 0);

  // Dragging the group carries its contents.
  const dragSet = expandGroupDragSet(comp, ["g1"]).sort();
  check("dragging a group drags its members", dragSet.join(",") === "a,b,g1");
  check("expanding a plain node's drag set is just itself", expandGroupDragSet(comp, ["a"]).join(",") === "a");

  // Only the titlebar takes clicks — the body must stay marquee-selectable, like Backdrop.
  check("click in the group BODY is background (marquee is never swallowed)",
    hitTest(comp, view, 250, 200).kind === "background");
  check("click in the group TITLEBAR is a node hit (move)",
    hitTest(comp, view, rect.x + 10, rect.y + 4).kind === "node");

  // Collapsed: members are hidden from hit-testing, and the box becomes a fixed title chip.
  const collapsed = { ...comp, nodes: { ...comp.nodes, g1: { ...grp, params: { ...grp.params, collapsed: true } } } };
  check("a collapsed group is a fixed-size title chip", groupRect(collapsed, collapsed.nodes.g1!).w === GROUP_COLLAPSED_W);
  check("collapsed members are hidden from hit-testing", hitTest(collapsed, view, 110, 110).kind !== "node");
  check("collapsed membership resolves each member to its owner",
    collapsedMemberOwners(collapsed).get("a") === "g1" && collapsedMemberOwners(collapsed).get("b") === "g1");

  // …and their wires re-anchor onto the group box rather than vanishing.
  const owners = collapsedMemberOwners(collapsed);
  const anchor = socketAnchor(collapsed, owners, "a", "out", "output");
  const box = groupRect(collapsed, collapsed.nodes.g1!);
  check("a hidden member's output anchors on the group's RIGHT edge",
    anchor !== null && anchor.x === box.x + box.w && anchor.dir === 1);
  const inAnchor = socketAnchor(collapsed, owners, "b", "in", "input");
  check("a hidden member's input anchors on the group's LEFT edge",
    inAnchor !== null && inAnchor.x === box.x && inAnchor.dir === -1);
  // Expanded, the same socket resolves to the node itself.
  check("an expanded member's socket is its own, not the group's",
    socketAnchor(comp, collapsedMemberOwners(comp), "a", "out", "output")?.x !== box.x + box.w);
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nflarex align/geometry: all checks passed");
