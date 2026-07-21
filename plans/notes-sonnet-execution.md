# Notes page — Sonnet 5 execution plan (Miro/Milanote-style creative organizer)

> Read the "How to work" section + FENCE list of `plans/flarex-sonnet-execution.md` first — the
> same working rules apply (draft-per-gesture → ONE commit, no monolith spreading, typecheck after
> every task). This build is **pure UI + shared data model**: it never touches the render path, so
> nothing here needs `render:compare:pixels`. FENCE for this plan: do NOT touch
> `scene-compositor.ts`, `build-scene-draws.ts`, `sync.ts` internals, the timeline-actions
> registry (AI wiring for Notes is a later Fable round), or any playback/perf file. EditorPage
> touch points are limited to exactly: the `editorPage` union, the page-bar button, one layout
> class, one `<NotesWorkspace/>` mount + props, and the Shift+N shortcut beside Shift+F.

## What we're building

A third editor page — **Notes** — next to Edit | Flarex in the bottom page bar: an infinite
pan/zoom board (Miro/Milanote family) for creative organization, research and planning. Left side
keeps the EXISTING full-height media panel (the `.studio-panel` with the AssetBin — no new media
UI). The rest of the editor area becomes the board: sticky-note cards, media cards dragged in
from the bin, link cards, container frames, and node-editor-style connectors between cards
(mindmaps = cards + connectors + keyboard branching). Everything persists inside `ProjectGraph`
(free via the existing draft/OPFS/server sync) and is fully undoable through the same
`updateGraph` seam Flarex uses.

**Settled decisions — do not re-litigate:**
- **DOM board, not Canvas2D.** Cards need real text editing, `<img>/<video>/<audio>` media and
  CSS theming; Milanote/Miro are DOM. Structure: `.notes-viewport` (overflow hidden, gesture
  surface) → `.notes-world` (CSS `transform: translate(panX,panY) scale(zoom)`, transform-origin
  0 0) → absolutely-positioned cards + ONE inline `<svg>` overlay (world-sized, `overflow:
  visible`, `pointer-events: none` except on edge paths) for connectors. Hundreds of cards is
  fine in DOM.
- **Data model lives in `packages/shared/src/notes/`** mirroring the flarex registry pattern
  (`ProjectGraph.flarexComps`): a boards registry, v1 auto-creates one default board.
- **Gestures mirror the Flarex/Fusion model the user already approved** (left click select,
  marquee, Shift/Ctrl toggle, drag moves selection, Delete deletes, middle/Alt-drag pan, wheel
  zoom-at-cursor, F fit, Ctrl+C/V/D clipboard).
- **Theme accent rule (learned 2026-07-21, same day):** NEVER hardcode an accent color. All
  highlight/selection/active styling uses `var(--nle-accent)` or
  `color-mix(in srgb, var(--nle-accent) N%, transparent)`. The Theme selector swaps
  `--nle-accent` via `data-orreris-theme`.

## M1 — Shared data model + helpers + tests

Files: `packages/shared/src/notes/{types.ts,registry.ts,notes.test.ts}`, exports in
`packages/shared/src/index.ts`, additions in `types.ts` root.

```ts
export type NoteItemType = "note" | "asset" | "link" | "frame" | "todo";

export interface NoteItem {
  id: string;
  type: NoteItemType;
  x: number; y: number; w: number; h: number;   // world px
  z: number;                                     // stacking; bring-to-front bumps to max+1
  color?: string | undefined;                    // card accent (palette of ~8 preset swatches)
  title?: string | undefined;
  body?: string | undefined;                     // note text, plain with linebreaks (no markdown v1)
  assetId?: string | undefined;                  // type "asset" → SourceAsset id
  url?: string | undefined;                      // type "link"
  todosJson?: string | undefined;                // type "todo": JSON [{ text, done }] (repo JSON-param convention)
  locked?: boolean | undefined;                  // frame background lock (drag needs titlebar)
}

export interface NoteEdge {
  id: string;
  from: string; to: string;                      // item ids
  label?: string | undefined;
  style?: "solid" | "dashed" | undefined;
  color?: string | undefined;
}

export interface NotesBoard {
  id: string; name: string;
  items: Record<string, NoteItem>;
  edges: NoteEdge[];
  version: number;                               // bump on EVERY mutation (same contract as FlarexComp)
  view?: { panX: number; panY: number; zoom: number } | undefined;
}
```

Root `types.ts`: `ProjectGraph.notesBoards?: Record<string, NotesBoard>` +
`ProjectGraph.activeNotesBoardId?: string`.

`registry.ts` helpers (pure, tested): `createNotesBoard(name)`, `ensureDefaultNotesBoard(graph)`
(returns `{ graph, boardId }`, no-op when one exists), `cloneNoteItems(items, edges, idSuffix)`
(fresh ids, internal-edge remap — the clipboard core, mirror `cloneFlarexNodes`),
`itemsInsideFrame(board, frameId)` (geometric: item CENTER inside the frame rect, frames
themselves and locked items excluded — used at frame-drag start).

Tests: mirror how `flarex.test.ts` is registered (grep the `flarex:test` script in the shared
package.json and add `notes:test` the same way). Cover: ensureDefault idempotence, clone id
remap + edge preservation, itemsInsideFrame center rule, round-trip
JSON.parse(JSON.stringify(board)) deep-equal.

## M2 — Page mount + layout takeover

1. EditorPage line ~815: `useState<"edit" | "flarex" | "notes">`. Page bar (~line 8617): add a
   Notes button with the `StickyNote` lucide icon (add to the existing lucide import), same
   markup as the other two. Shift+N toggles notes ↔ edit — copy the Shift+F handler exactly
   (same input-field guard).
2. Layout (verified against global.css): `.editor-layout` is a grid —
   rows `viewer-row | 8px | timeline-row` (line ~4159), `.editor-main` columns
   `left-panel | 8px | viewer | 8px | inspector` (line ~4169). Add `is-notes-page` to the
   `.editor-layout` element's className when `editorPage === "notes"` (grep where
   `is-inspector-collapsed` is applied — same element). CSS:
   - `.editor-layout.is-notes-page { grid-template-rows: minmax(0, 1fr) 0 auto; }` — the
     timeline row collapses to just the page bar.
   - Hide `.editor-viewer`, `.pane-resizer-right`, `.editor-inspector`,
     `.pane-resizer-horizontal`, and every `.timeline-stack` child EXCEPT `.flarex-page-tabs`
     (the flarex page already hides `.timeline-dock-row` via inline style — do the notes hiding
     in CSS under `.is-notes-page`, don't multiply inline styles).
   - Mount `<NotesWorkspace/>` (new dir `apps/web/src/editor/notes/`, lazy like FlarexWorkspace)
     as a child of `.editor-main` with `grid-column: 3 / 6; grid-row: 1; min-height: 0`.
   - The left `.studio-panel` stays untouched = the user's "full height media tab on left".
3. Props seam (narrow, Flarex-style): `{ graph, onUpdateGraph, assets }` — `assets` is the same
   `SourceAsset[]` EditorPage already passes to AssetBin (needed to resolve dropped asset cards).
   NotesWorkspace resolves the active board via `ensureDefaultNotesBoard` (commit the ensure
   through `onUpdateGraph` once, in an effect, only when missing).
4. Empty state: a centered hint ("Double-click to add a note · drag media from the pool") in the
   board, not a blocking screen.

Verify: page switch keeps Edit/Flarex behavior identical; refresh on the Notes page restores it
(persist last page? NO — always open on "edit", same as today).

## M3 — Board core (the biggest task)

`NotesBoard.tsx` (viewport/world/gestures) + `notes-board-model.ts` (pure math: screen↔world,
marquee rect-hit, zoom-at-cursor — adapt `flarex-canvas-model.ts` helpers, don't import it).

- Pan: middle-drag or Alt+left-drag or Space+drag. Wheel = zoom at cursor (clamp 0.15–2.5);
  plain wheel WITHOUT ctrl also zooms (Miro convention), trackpad pinch comes free via
  ctrl+wheel. Persist `board.view` debounced (~500ms) through one updateGraph commit — view
  writes must NOT bump `version` churn more than once per settle.
- Cards: absolutely positioned divs, `transform: translate(x,y)` per card (not left/top — cheap
  compositing), width/height from the item, `z-index` from `z`. Selection ring =
  `box-shadow: 0 0 0 2px var(--nle-accent)`.
- Select: click card selects; Shift/Ctrl toggles; click background clears; background left-drag =
  marquee (accent-tinted rect div); drag any selected card moves the whole selection (draft in
  local state, ONE updateGraph commit on pointerup). Delete/Backspace removes selected items +
  their edges (guard focused inputs/textareas/contentEditable).
- Resize: 8 handles on single-selected cards (reuse the `:root` handle token design — grep
  `--handle` in global.css); asset cards keep aspect from corner handles (shift breaks aspect).
  Min size 80×48.
- Z-order: pointer-down on a card bumps it to max z+1 (part of the same gesture commit).
  Frames are the exception: they sit BELOW normal cards (frame z band 0–999, cards 1000+).
- Double-click empty board = create a note card at that point and focus its textarea.
- Background: very subtle DOT grid (CSS `radial-gradient` background-image on `.notes-world`,
  world-locked so it pans/zooms with content) — match the Flarex line-grid subtlety (alpha ~0.03).
- Fit (F key): fit all items (or selection if any) with 60px padding, zoom ≤ 1.

## M4 — Card types

1. **Note card**: title row (optional, small, semibold) + auto-growing `<textarea>` body.
   Editing: double-click enters edit (textarea focus), commit on blur / Escape — commit is ONE
   updateGraph (no per-keystroke graph writes). 8 preset color swatches in the card's hover
   toolbar (tint = `color-mix(in srgb, <color> 18%, var(--panel-bg, #1a1d23))`).
2. **Asset card** (media): created by dragging from the AssetBin — the bin ALREADY sets
   `dataTransfer` `application/x-orreris-asset` = asset id (EditorPage line ~12457); the board's
   onDragOver/onDrop accepts that type and creates an asset card at the drop point sized to the
   asset aspect (default 260px wide). Rendering by `assetKind` (grep the existing helper):
   image → `<img>` (thumbnailUrl ?? fileUrl); video → poster `<img>` (thumbnailUrl) with a
   play overlay — click swaps in a muted `<video controls>` using previewUrl ?? proxyUrl ??
   fileUrl; audio → compact `<audio controls>` row with the file name; anything else →
   document icon + name. Missing asset (deleted from bin) → dashed "missing media" card, never
   a crash. Card shows the asset display name under the media.
3. **Link card**: toolbar "Link" button + paste (Ctrl+V with a URL string in the system clipboard
   when nothing is copied on the board) → card with a globe icon, the URL, editable title;
   click-through opens in a new tab (`rel="noopener noreferrer"`). NO metadata fetching (CORS) —
   don't try.
4. **Frame** (Miro-style container): titled rectangle, tinted 4% accent, title editable inline.
   Dragging a frame ALSO moves the items captured by `itemsInsideFrame` at drag START (one
   commit). Resizing a frame never moves members. Frames render in the low z band.

## M5 — Connectors + mindmap keys

1. SVG edges: smooth cubics between the two cards' nearest edge-midpoint anchors (recompute
   which sides face each other from the card rects each render — no stored anchor sides).
   Default `stroke: color-mix(in srgb, var(--nle-accent) 55%, transparent)` 2px; `style:
   "dashed"` → dasharray; per-edge `color` override.
2. Creating: hovering a card shows 4 small connector dots at edge midpoints; drag from a dot →
   dashed preview line; release over another card creates the edge (dedupe: one edge per
   from/to pair, ignore self). Release on empty board = create a NEW note card there AND the
   edge (Miro's killer flow).
3. Edge select: click path (widen hit with a transparent 10px stroke twin path,
   `pointer-events: stroke`) → accent highlight, Delete removes. Double-click edge → small
   floating input to set the label; label renders at the curve midpoint on a bg pill.
4. **Mindmap keys** (single card selected, not editing text): `Tab` = create a connected child
   note card to the right (+240px, vertically staggered past existing children), select + edit
   it; `Enter` = sibling (same offset from the selected card's parent if it has an incoming
   edge, else plain new card below). This makes mindmapping real without a special mode.

## M6 — Clipboard, toolbar, polish

1. Ctrl+C/V/D on board selection via `cloneNoteItems` (module-level clipboard object, +24/+24
   offset, cleared when the active board changes — same idiom as the Flarex clipboard).
2. Slim board toolbar (top of the workspace, `.flarex-toolbar` styling): Add Note / Add Frame /
   Add Link / Add Todo buttons (create at viewport center), zoom −/%/+ readout, Fit button,
   board name inline-rename (copy `FlarexCompNameField`).
3. **Todo card**: checklist rows (checkbox + text, Enter adds a row, empty-row Enter removes),
   stored in `todosJson`; progress count in the card header ("3/5"). `accent-color:
   var(--nle-accent)` on the checkboxes.
4. Optional (do if smooth, skip with a note if not): press `1`..`4` to set a selected card's
   color; a tiny top-right minimap SKIP for v1.

## Definition of done (whole round)

Every task: `pnpm --filter @orreris/web typecheck` + shared typecheck + `notes:test` green.
Manual pass in Chrome: create notes/frames/links, drag 3 media kinds from the bin, connect +
label + delete edges, Tab-branch a 3-level mindmap, Ctrl+C/V/D, refresh restores everything
(board + view), theme switch re-tints all accents, Edit/Flarex pages unaffected. Update
`architecture.md` with one [x] entry; tracker notes only for real problem/solution learnings.
Do NOT commit — Fable reviews and commits the round.
