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
  LABEL_FADE_FULL_PX,
  LABEL_FADE_ZERO_PX,
  NODE_LABEL_PX,
  labelAlphaForPx,
  placeAfterNode,
  NODE_PLACE_GAP_X,
  NODE_PLACE_STEP_Y,
  GROUP_COLLAPSED_W,
  GROUP_PADDING,
  GROUP_TITLEBAR_H,
  NODE_FOOTER_H,
  NODE_THUMB_H,
  NODE_W,
  alignFlarexNodes,
  backdropSize,
  collapsedMemberOwners,
  expandGroupDragSet,
  flarexNodeIndices,
  flarexNodeThumbnailsEnabled,
  groupMembers,
  groupRect,
  hitTest,
  nodeFooterRect,
  nodeHasThumbnail,
  nodeHeight,
  nodeSockets,
  nodeThumbRect,
  nodeWidth,
  setFlarexNodeThumbnails,
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

// --- Node tile layout, thumbnails on (Slice 6) ------------------------------
// The picture node is a FIXED TILE — [picture | footer] — with the name drawn outside above it, per
// the Resolve reference. The load-bearing property is that sockets stay inside the PICTURE band: a
// socket that drifted into the footer would put wires on the index/glyph strip, and one that drifted
// past the tile would detach wires from the body entirely.
{
  const blur = createFlarexNode("blur", "n1", 100, 100);
  const merge = createFlarexNode("merge", "n2", 400, 100);
  const backdrop = createFlarexNode("backdrop", "bd", 0, 0);
  const reroute = createFlarexNode("reroute", "rr", 0, 0);
  const grp = createFlarexNode("group", "g1", 0, 0);
  grp.params = { ...grp.params, members: JSON.stringify(["n1"]) };
  const comp = { id: "c1", name: "C", nodes: { n1: blur, n2: merge, bd: backdrop, rr: reroute, g1: grp }, edges: [], animations: [], version: 1 };
  const view: FlarexViewState = { panX: 0, panY: 0, zoom: 1 };

  const before = nodeHeight(blur);
  const groupBefore = groupRect(comp, grp).h;
  check("thumbnails default to OFF in the model (the canvas sets the mode)", !flarexNodeThumbnailsEnabled());
  check("no thumbnail rect while the mode is off", nodeThumbRect(blur) === null);
  check("no footer rect while the mode is off", nodeFooterRect(blur) === null);

  setFlarexNodeThumbnails(true);
  try {
    check("thumbnails enabled is observable", flarexNodeThumbnailsEnabled());
    check("a picture node is a fixed tile: picture + footer", nodeHeight(blur) === NODE_THUMB_H + NODE_FOOTER_H);
    check("node width is unchanged", nodeWidth(blur) === NODE_W);

    const pic = nodeThumbRect(blur);
    const foot = nodeFooterRect(blur);
    check("the picture is the TOP band", pic !== null && pic.y === blur.ui.y && pic.h === NODE_THUMB_H && pic.x === blur.ui.x);
    check("the footer sits directly under the picture, filling the tile",
      foot !== null && pic !== null && foot.y === pic.y + pic.h && foot.h === NODE_FOOTER_H && foot.y + foot.h === blur.ui.y + nodeHeight(blur));

    // Sockets: inside the picture band, and each bank centred on its own count.
    for (const node of [blur, merge]) {
      const band = nodeThumbRect(node)!;
      const sockets = nodeSockets(node, comp);
      check(`${node.type}: every socket sits inside the PICTURE band, never the footer`,
        sockets.every((s) => s.y >= band.y && s.y <= band.y + band.h));
    }
    const blurOut = nodeSockets(blur, comp).filter((s) => s.kind === "output");
    check("a lone output is centred on the picture band",
      blurOut.length === 1 && Math.abs(blurOut[0]!.y - (blur.ui.y + NODE_THUMB_H / 2)) < 0.001);
    const mergeIn = nodeSockets(merge, comp).filter((s) => s.kind === "input").map((s) => s.y);
    check("a multi-input bank is centred as a group on the picture band",
      Math.abs((Math.min(...mergeIn) + Math.max(...mergeIn)) / 2 - (merge.ui.y + NODE_THUMB_H / 2)) < 0.001);

    check("a click inside the picture hits the node", hitTest(comp, view, 110, blur.ui.y + 20).kind === "node");
    check("a click inside the footer hits the node", hitTest(comp, view, 110, blur.ui.y + NODE_THUMB_H + 5).kind === "node");

    // Chrome has no output to preview, so it stays compact (a Group that grew with its members would
    // also grow itself, recursively).
    check("backdrop has no thumbnail", !nodeHasThumbnail(backdrop) && nodeThumbRect(backdrop) === null);
    check("group has no thumbnail", !nodeHasThumbnail(grp) && nodeThumbRect(grp) === null);
    check("reroute has no thumbnail", !nodeHasThumbnail(reroute) && nodeThumbRect(reroute) === null);
    check("reroute keeps its small fixed height", nodeHeight(reroute) < 40);
    check("a group's box grows with its member's tile height",
      groupRect(comp, grp).h === groupBefore + (NODE_THUMB_H + NODE_FOOTER_H) - before);

    // Footer numbering: creation order, 1-based, picture nodes only.
    const indices = flarexNodeIndices(comp);
    check("footer numbers are 1-based creation order", indices.get("n1") === 1 && indices.get("n2") === 2);
    check("chrome nodes are not numbered",
      !indices.has("bd") && !indices.has("g1") && !indices.has("rr"));
  } finally {
    setFlarexNodeThumbnails(false);
  }
  check("turning the mode off restores the compact height", nodeHeight(blur) === before);
  check("compact mode centres a lone output on the body",
    Math.abs(nodeSockets(blur, comp).filter((s) => s.kind === "output")[0]!.y - (blur.ui.y + before / 2)) < 0.001);
}

// ── Auto-placement: where a node added "after" another one lands ────────────
{
  const at = (x: number, y: number) => ({ ui: { x, y } });

  // The direction the graph READS and the direction the auto-wire runs. Placing at the cursor (the
  // old rule) dropped a keyboard-driven add wherever the pointer happened to rest.
  const solo = placeAfterNode({ a: at(100, 200) }, "a")!;
  check("placed to the RIGHT of the source", solo.x === 100 + NODE_W + NODE_PLACE_GAP_X);
  check("…and vertically level with it", solo.y === 200);

  // Occupied slots step DOWN, not right: several nodes off one source is a fan-out, and a fan reads
  // as a column. Stepping right would draw a chain the graph does not have.
  const nodes = { a: at(100, 200), b: at(100 + NODE_W + NODE_PLACE_GAP_X, 200) };
  const second = placeAfterNode(nodes, "a")!;
  check("an occupied slot steps DOWN, not right", second.x === solo.x && second.y > solo.y);

  // Overlap is judged on the BODY. A near-miss must count as occupied, or nodes stack visually while
  // the slot reports free.
  const nearMiss = { a: at(100, 200), b: { ui: { x: solo.x + 4, y: 200 + 4 } } };
  check("a near-miss counts as occupied, not just an exact hit",
    placeAfterNode(nearMiss, "a")!.y > solo.y);

  // A node clear of the slot must not push it: only real overlap costs a step.
  const farBelow = { a: at(100, 200), b: at(solo.x, 200 + NODE_PLACE_STEP_Y * 4) };
  check("a distant node does not displace the placement", placeAfterNode(farBelow, "a")!.y === 200);

  check("an unknown source id yields null rather than a guessed position",
    placeAfterNode({ a: at(0, 0) }, "nope") === null);
}

// ── Label scale + fade (2026-07-29) ─────────────────────────────────────────
// Labels used to carry a screen-px FLOOR and a hard `zoom > 0.45` cutoff. Together those made
// "frame the whole graph" — the view `fitToView` lands on, near the 0.25 zoom floor — render
// anonymous rectangles. The fade replaces the cliff; these pin the shape of it.
{
  check("full opacity once the type is comfortably readable", labelAlphaForPx(12) === 1);
  check("exactly at the full-size threshold it is opaque", labelAlphaForPx(LABEL_FADE_FULL_PX) === 1);
  check("sub-pixel type is fully gone, not a grey smear", labelAlphaForPx(2) === 0);
  check("exactly at the zero threshold it is gone", labelAlphaForPx(LABEL_FADE_ZERO_PX) === 0);

  // The whole point: BETWEEN the thresholds it is partial, so zooming out dissolves rather than snaps.
  const mid = labelAlphaForPx((LABEL_FADE_ZERO_PX + LABEL_FADE_FULL_PX) / 2);
  check("between the thresholds it fades progressively", mid > 0.4 && mid < 0.6);
  check("the fade is monotonic in size", labelAlphaForPx(4) < labelAlphaForPx(5) && labelAlphaForPx(5) < labelAlphaForPx(6));

  // The regression itself, stated in zoom terms rather than pixels: at the OLD cutoff the label was
  // invisible; it must now be legible, because that is the band `fitToView` puts a big graph in.
  check("a label is visible at the old 0.45 cutoff", labelAlphaForPx(NODE_LABEL_PX * 0.45) > 0);
  check("...and at the 0.35 backdrop/group cutoff too", labelAlphaForPx(NODE_LABEL_PX * 0.35) > 0);
  check("garbage size never yields a partial alpha", labelAlphaForPx(Number.NaN) === 0);
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nflarex align/geometry: all checks passed");
