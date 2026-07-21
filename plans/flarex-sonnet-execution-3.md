# Flarex — Sonnet 5 execution plan, round 3 (Fusion-parity UX + breadth + AI reach)

> Same ground rules + FENCE as rounds 1 & 2 (`plans/flarex-sonnet-execution.md`,
> `...-2.md`) — read the "How to work" section and the FENCE first. Rounds 1 & 2 are complete,
> verified, green (`flarex:test` 92 + `flarex:clipboard:test` + 5-pkg typecheck; new pixel
> fixtures 0.000%). This round is **UX + deterministic lowering + AI schema** — the depth items
> stay OFF-LIMITS.
>
> **Round-3 FENCE (Fable-only — do NOT attempt):** everything in `scene-compositor.ts` and
> `build-scene-draws.ts`; the Phase 2 `renderNodeGraphInto` interpreter, per-node RTT/thumbnail
> caching, VRAM LRU; `SceneFragmentPass.auxInputs`/Displace; **Text node lowering**, **aiMatte
> node**, **Tracker node** (their palette entries stay hidden — do not wire their `lower()`);
> **multi-clip MediaIn**; the S2b GraphEditor `flarexNode` curve adapter (still needs the
> `EditSubject` refactor — see tracker editor-ui v7); brain-router / `runSkillStep` wiring for any
> new AI op (you write the schema + deterministic compiler + tests; **Fable** routes it through the
> Brain). Order below is value order.

## Why this round

Flarex's *engine* depth is Fable-fenced, but its *editing experience* and *reach* have clear,
non-fenced gaps: you can only add nodes by dragging the palette (no Fusion-style search), the graph
has no organization primitives (backdrops/reroutes), masks are edited through a raw JSON textarea,
and the AI intent can't touch masks/mattes/curves. Closing those makes Flarex feel like a real
compositor without touching the render substrate.

## F1 — Add-node search menu (the #1 Fusion-parity gap)

Today nodes only arrive via palette drag. Add Fusion's core interaction:

1. In `FlarexNodeCanvas.tsx`: pressing **Tab** (canvas focused, not in an input) OR right-clicking
   empty canvas opens a small searchable node menu anchored at the cursor. Type to fuzzy-filter the
   addable node types by `def.label`/`def.group` (reuse the same list the toolbar palette builds
   from — grep how `FlarexWorkspace` enumerates palette entries; exclude mediaIn/mediaOut and the
   three fenced types text/aiMatte/tracker exactly as the palette already does). Arrow keys +
   Enter select; Escape closes.
2. Insert at the cursor world position via the existing `createFlarexNode` + one `onUpdateComp`
   commit (mirror the palette-drop insert path at `FlarexNodeCanvas.tsx` ~line 609). If a single
   node is selected when the menu opens, auto-wire the new node's first compatible input from the
   selected node's output (Fusion "insert after selected") — reuse `isValidFlarexEdge`; skip the
   auto-wire silently if types don't match.
3. Right-clicking ON a node keeps/introduces a minimal node context menu: Rename, Enable/Disable
   (Ctrl+P already toggles — same action), Delete, and "View" (toggle `previewNodeId`). Keep it
   tiny; do not duplicate the inspector.

## F2 — Graph organization: backdrop + reroute nodes

Both are UI-only in effect and must **lower to pass-through** so they never alter output — that's
what keeps this off the render fence.

1. Shared model: add node types `backdrop` and `reroute` to the `FlarexNodeType` union + `node-defs`
   (group `"io"` or a new `"layout"` group). `reroute`: one image `in`, one image `out`; `lower()`
   returns its input value unchanged (pure pass-through — add a `flarex:test` check that a reroute
   between two nodes produces a draw identical to a direct wire). `backdrop`: NO sockets; carries
   `title`, `color`, `w`, `h` params; the compiler IGNORES it entirely (never appears in the DFS
   from mediaOut — test that a comp with a stray backdrop lowers identically to one without).
2. Canvas rendering: `reroute` draws as a small dot node (just the two sockets, no body label).
   `backdrop` draws as a large translucent titled rectangle in a LOW z-order (behind all nodes),
   is move/resize-able like a normal node, and dragging its titlebar moves the nodes visually on top
   of it (optional: capture-contained-nodes like the Notes frame — reuse the same center-inside
   geometry idea; SKIP the capture if it complicates the gesture machine and note it). Selection/
   marquee must treat backdrops as background (don't let a full-canvas backdrop swallow marquee).
3. Inspector rows for both (title/color/size). Palette: add them under a "Layout" group.

## F3 — On-viewer mask point editing (kills the JSON textarea)

`FlarexInspector.tsx` currently edits `polygonMask.points` / `bezierMask.points` as a raw JSON
textarea (`MULTILINE_PARAMS`, with a code comment admitting on-viewer editing is missing). Replace
it with direct manipulation. **This touches the viewer OVERLAY and coordinate mapping only — NOT
the compositor.**

1. When a polygon/bezier mask node is selected AND is on the viewed path, render an interactive SVG
   overlay above the Flarex viewer (the viewer is a `ScenePreviewCanvas` — add a sibling absolutely-
   positioned `<svg>` in the viewer container, same size, `pointer-events` only on the handles).
   Map comp-normalized point coords ↔ viewer pixels using the viewer's displayed rect (grep how the
   viewer exposes its content rect / letterbox; if it isn't cleanly available, compute from the
   comp aspect vs the container rect — document the assumption).
2. Drag a point to move it (write back to the node's points JSON through the existing `setParam`,
   ONE commit per drag); double-click an edge to insert a point; Alt/right-click a point to delete;
   points respect keyframes if the param is keyframed (write at the current time via the existing
   keyframe-aware setter the inspector already uses).
3. **Fallback (do this if the viewer overlay proves too entangled — do NOT fork the viewer):**
   replace the textarea with a *structured* point-list editor in the inspector (a row per point with
   x/y number fields + add/remove buttons + reorder). Note the decision in the code + architecture.
   Either way the raw JSON textarea must be gone for these two node types.

## F4 — AI intent reach: mask / matte / curves ops

Extend `node-graph-intent.ts` (deterministic compiler, your lane — the Brain routing is Fable's):

1. New ops on `nodeGraphIntentSchema` (all `.strict()`, keep the min(1)/max(12) envelope):
   - `mask { shape: "rect"|"ellipse", region:{x,y,w,h}, feather?, invert? }` — inserts the matching
     mask node feeding the current tail's mask input (mirror how `blurRegion` already places a shape
     — reuse that placement helper).
   - `matte { op: "combine"|"invert"|"feather"|"choke", amount? }` — inserts a `matteControl` node.
   - `curves { intent: gradeIntentSchema }` is ALREADY covered by the `grade` op → instead add
     `colorCurves { points: [...] }`? NO — keep the LLM out of raw curve points. Skip curves; the
     `grade` op already gives token-safe color. (Document that decision in the schema comment.)
2. `compileNodeGraphIntent` handles the two new ops by appending real nodes+edges (same invariant:
   output is a graph the user could build by hand). Add `flarex:test` checks: a `mask` op yields a
   mask node wired to the right input; an unknown/again-out-of-range ref is skipped, never thrown.

## F5 — Node UX polish

1. **Inline rename**: double-click a node's label → in-place text input (an absolutely-positioned
   HTML input over the canvas at the node's screen rect; commit on blur/Enter, Escape reverts),
   writing `node.label`. (The inspector already has a Label field — this is the canvas shortcut.)
2. **Align / distribute**: with ≥2 nodes selected, toolbar buttons (or a small canvas toolbar):
   align left/center/right/top/middle/bottom, distribute H/V. Pure position math → one commit. Add a
   tested pure helper `alignFlarexNodes(nodes, mode)` in `flarex-canvas-model.ts`.
3. **Solo/View**: pressing `1` (or a node menu item) sets `previewNodeId` to the selected node
   ("solo view"); pressing it again clears back to mediaOut. (View-any-node already exists via the
   double-click dot — this is the keyboard path.)

## F6 — Parity fixtures + small wins

1. Pixel fixtures (`render-comparison-fixture.ts`, background-LAYER rule — SceneStage clear color is
   hardcoded, tracker editor-ui v8): add comps exercising **merge with a non-normal blend mode**, a
   **transform** (scale+rotate+translate), and an **ellipse mask + matteControl feather** — each
   compared across preview/local/Remotion. Zero regression required; the two fenced stylize failures
   stay known/untouched.
2. Reroute nodes must be included in one fixture to prove pass-through parity (0.000% vs the direct
   wire).
3. Small: node context-menu "Copy" wired to the existing clipboard; palette shows the Layout group;
   Tab search menu remembers the last-used node type at the top.

## Definition of done (whole round)

Every task: `pnpm --filter @orreris/web typecheck` + shared typecheck + `flarex:test` (extend, keep
green) + `flarex:clipboard:test`; F1/F2/F3/F5 are UI (manual Chrome pass — add-node search, drop a
backdrop + reroute, drag mask points on the viewer, rename/align/solo); F4/F6 add `flarex:test`
checks and F6 adds `render:compare:pixels` (only the two fenced stylize failures may remain).
Update `architecture.md` with one [x] round-3 entry; tracker notes only for real problem/solution
learnings. Do NOT commit — Fable reviews, commits, and wires F4's new ops through the Brain.
```
```

> Note: text/aiMatte/tracker nodes and the Phase 2 interpreter remain the Fable backlog. If this
> round lands clean, the next Sonnet-appropriate flarex work is thin — subsequent depth is engine
> work reserved for Fable.
