# Notes page — Sonnet 5 execution plan, round 2 (multi-board + NLE linking + creativity layer)

> Same ground rules + FENCE as `plans/flarex-sonnet-execution.md` and
> `plans/notes-sonnet-execution.md` (read both first). Round 1 (M1–M6) is complete, verified,
> green (`notes:test`, full typecheck, board fully wired: page union, Shift+N, `is-notes-page`
> layout, `NotesWorkspace` mount, page-bar button). This round is still **pure UI + shared data
> model + one deterministic intent compiler** — it never touches the render path, so nothing here
> needs `render:compare:pixels`. Verification loop per task: `pnpm --filter @orreris/web typecheck`
> + shared typecheck + `notes:test`; the P1 AI task adds `notes:intent:test`.
>
> **Round-2 FENCE (Fable-only, do NOT attempt):** Brain router / tier integration and
> `AiChatPanel` runSkillStep wiring for Notes (the *routing* — the deterministic intent compiler
> below IS yours); anything in `scene-compositor.ts` / `build-scene-draws.ts`; the timeline
> transport internals. Where a task says "raise an event to EditorPage," reuse the EXISTING
> event/callback idiom (grep how `onOpenFlarexForClip` reaches EditorPage) — do not invent a new
> monolith seam.

## Why this round

Round 1 shipped a single-board Miro/Milanote board. The user's ask was "max creativity,
productivity, research" and a creative organizer that lives INSIDE the editor. The unique value
over a standalone Miro is the NLE integration + AI — that's this round. Priority order below is
value order; P1–P3 are the spine, P4–P6 are the creativity/polish layer.

## P1 — AI: prompt → board (deterministic intent compiler, the grade-intent template)

Mirror `packages/shared/src/flarex/node-graph-intent.ts` EXACTLY (which itself cloned
`grade-intent.ts`).

1. `packages/shared/src/notes/notes-intent.ts`: a `.strict()` Zod `notesIntentSchema` — a discriminated
   union of ops the LLM may emit, deterministic + local + token-free to compile:
   - `addNote { text, color?, x?, y? }`
   - `addFrame { title, x?, y?, w?, h? }`
   - `connect { fromRef, toRef, label? }` (refs = 1-based indices into the ops' created items, the
     same "created-so-far" indexing node-graph-intent uses — NOT board ids)
   - `mindmap { root, branches: string[] | { text, children? }[] }` (compiles to a laid-out tree of
     connected note cards — auto-position with a simple radial/rightward layout helper; this is the
     "generate a mindmap from a prompt" killer op)
   - `todo { title, items: string[] }`
   Cap `ops` at min(1)/max(24). `compileNotesIntent(intent, base?: NotesBoard): NotesBoard` appends
   real items+edges (fresh ids, layout applied) — output is the SAME editable board the user could
   build by hand (grade-intent invariant: the LLM never sets pixel coordinates that matter; the
   compiler owns layout).
2. Export from `packages/shared/src/index.ts`. Add `notes:intent:test` (package.json, tsx pattern
   like `notes:test`): schema round-trips; a mindmap op with 3 branches produces 1 root + 3 children
   + 3 edges, non-overlapping rects; `connect` ref out of range → the op is skipped (never throws);
   compiling onto a `base` board preserves existing items.
3. UI entry (NOT brain routing — that's fenced): a small "✦ Generate" button in the notes toolbar
   opens a one-line prompt input; on submit, call a host callback `onNotesPrompt(text)` threaded
   from EditorPage. EditorPage's handler is a STUB for now that just logs + shows a notice
   ("Notes AI coming soon") — leave a `// TODO(fable): route through brain tier` marker. The point
   this round is the *compiler + schema + test*; wiring the real LLM is the fenced Fable step. Do
   NOT fake it with a hardcoded response.

## P2 — Timeline linking (the NLE-native superpower)

A note can point at a moment in the edit. This is what makes Notes part of the editor, not a
detached whiteboard.

1. Data: `NoteItem` gains `linkedTime?: number` (seconds, board-local to the main composition) and
   `linkedLayerId?: string`. Both optional; older boards unaffected. Bump the shared types + a
   `notes:test` round-trip check.
2. Card affordance: any card shows a small clock chip when `linkedTime` is set ("@ 12.4s"); clicking
   it seeks the transport. Thread an `onSeek(seconds)` callback from EditorPage (it already exposes
   `setEditorCurrentTime` — reuse it, same value passed to FlarexWorkspace). Setting the link:
   a card context affordance "Pin to playhead" writes `linkedTime = currentTime` (thread
   `currentTime` in, like FlarexWorkspace gets it via `ColdTime`).
3. Reverse direction (timeline → notes): when a clip has ≥1 note linked to `linkedLayerId`, show a
   tiny note glyph badge on the clip (same pattern as the flarex `fx` badge — a direct child of the
   clip, NOT inside `.clip-label`; grep `clip-flarex-badge`). Double-click the badge → switch to the
   Notes page and select/center those notes (raise via the existing EditorPage event idiom used by
   `onOpenFlarexForClip`). Single-click unchanged.
4. `notes:test`: helper `notesForLayer(board, layerId)` returns the linked notes; test it.

## P3 — Multiple boards + board switcher

Round 1 hardcodes one default board. Creators need boards per topic (research / script / shot list).

1. Toolbar: a board dropdown (name + caret) listing `graph.notesBoards`, plus "New board" and
   "Rename"/"Delete" (delete guarded: never delete the last board; confirm inline). Switching sets
   `graph.activeNotesBoardId` through one `onUpdateGraph`. The workspace already resets view +
   selection on `board.id` change (verified) — no board-switch churn to fix.
2. `registry.ts` helpers (pure, tested): `createNotesBoard` already exists — add
   `deleteNotesBoard(graph, boardId)` (no-op on last board; clears `activeNotesBoardId` to another
   board's id) and `renameNotesBoard(graph, boardId, name)`. Tests for both.
3. The module-level `notesClipboard` already clears on board-id change (verified) — confirm cross-
   board paste stays impossible and note it in the switcher code comment.

## P4 — Image/media depth + drawing primitives

1. **Image card from paste/URL**: Ctrl+V with an image in the system clipboard (or a pasted image
   URL string) creates an `asset`-like card. Since there's no SourceAsset for a raw pasted image,
   add item type `image` with a `dataUrl?` param (small images inline as data URL; guard >~2MB with
   a notice — do NOT bloat the project graph, note the limit in a comment). Bin-dragged media stays
   the `asset` type (already works).
2. **Shape/arrow cards**: item type `shape` with `shapeKind: "rect" | "ellipse" | "arrow"` +
   `color`. Pure visual organizers (backdrops, call-outs). Arrows are a straight styled line with a
   head — reuse the SVG overlay the connectors already draw into (grep `edgeCubicPath`). Shapes sit
   in the low z-band like frames.
3. Card color palette: round 1 stores `color` on notes — extend the hover toolbar swatch row to
   frames/shapes/images too (one shared `<ColorSwatches>` sub-component; theme-aware — the SELECTED
   swatch ring uses `var(--nle-accent)`, per the standing theme rule).

## P5 — Productivity: search, group, templates

1. **Search/jump** (Ctrl+F on the board, guard inputs): a floating search box filters cards by
   title/body/todo text; matches get an accent outline and Enter cycles + centers each match
   (reuse `fitViewFor` on a single item). Escape closes.
2. **Group as frame**: with a multi-selection, a toolbar/keyboard action ("Frame selection") creates
   a frame sized to the selection bounds + 24px padding, placed in the low z-band so the members sit
   on top and move with it (the drag-captures-contained-items behavior already exists via
   `itemsInsideFrame` — verify it captures the freshly framed items).
3. **Board templates**: a "＋ from template" menu that stamps a starter layout via `compileNotesIntent`
   (reuse P1!) — Mindmap, Kanban (3 frames "To do / Doing / Done"), Moodboard (a grid of empty
   image cards), Shot list (a todo + frame). Each template = a fixed `NotesIntent` object; no new
   compiler path. One test: each template compiles to a non-empty board without throwing.

## P6 — Small wins (any order, optional)

1. Board export: "Export outline" copies a Markdown outline of the board (frames = headings, notes =
   bullets, todos = checkboxes, edges ignored) to the clipboard. Pure string build — testable helper
   `boardToMarkdown(board)` in `registry.ts`; one test.
2. `1`..`8` sets the selected cards' color from the palette (guard inputs).
3. Minimap: SKIP for this round unless trivial — note and move on.
4. Double-click a connector's midpoint already edits its label (verified) — add: Alt+drag a card
   onto another creates a connection (shortcut for the connector-dot drag). SKIP if it complicates
   the gesture machine; note the decision.

## Definition of done (whole round)

Every task: `pnpm --filter @orreris/web typecheck` + shared typecheck + `notes:test` green; P1 also
`notes:intent:test`. Manual pass in Chrome: generate a mindmap from a prompt (compiler only — the
stub notice is expected), pin a note to the playhead and click to seek, see the clip's note badge +
double-click to jump back, create/switch/rename/delete boards, paste an image, draw a shape+arrow,
search+jump, frame a selection, stamp a Kanban template, export an outline. Theme switch re-tints
every accent (swatch rings, search outline, badges). Edit/Flarex pages unaffected. Update
`architecture.md` with one [x] round-2 entry; tracker notes only for real problem/solution learnings.
Do NOT commit — Fable reviews and commits, then wires P1 through the brain router.
