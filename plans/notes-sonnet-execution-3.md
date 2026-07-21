# Notes page — Sonnet 5 execution plan, round 3 (media-card quality + depth + cross-page links)

> Same ground rules + FENCE as rounds 1 & 2 (`plans/notes-sonnet-execution.md`, `...-2.md`) — read
> them first. Still **pure UI + shared model + deterministic helpers**; no render path, so no
> `render:compare:pixels`. Verify per task: `pnpm --filter @orreris/web typecheck` + shared
> typecheck + `notes:test` (+ `notes:intent:test` if you touch the compiler). **Round-3 FENCE
> (Fable-only):** brain-router / `runSkillStep` wiring for the "✦ Generate" prompt (P1's routing —
> still Fable's; the stub stays); anything in `scene-compositor.ts`/`build-scene-draws.ts`; the
> transport engine. Rounds 1 & 2 are complete, verified, green (32 `notes:test` + 20
> `notes:intent:test`).

## Why this round

Round 2 shipped the multi-board + AI-compiler + NLE-linking + creativity layer. Real use surfaced
rough edges — the biggest is **media cards render badly** (audio cards inherit the generic
260×160 asset size, so the waveform is stretched into a cramped vertical block; see the user's
2026-07-22 screenshot). This round is a quality + depth pass: fix media cards, harden the things a
manual click-through would catch, and add the cross-page links that make Notes uniquely an *editor*
board.

## Q1 — Media cards render like real players (highest priority — user-flagged)

`NotesCards.tsx` routes assets through `NotesMediaPlayer`, but every `asset`/`image` item uses the
one `DEFAULT_SIZE.asset = { w:260, h:160 }`, so audio (a horizontal waveform) is squeezed into a
tall box and video/doc get the wrong proportions.

1. **Per-kind default size** at creation (both the bin-drag drop path AND paste): resolve the
   item's media kind (`assetKind`) at add-time and pick the size — audio ≈ `{ w:300, h:96 }`
   (short + wide, like the Edit page's audio chip), video ≈ 16:9 from the asset's real
   `width/height` when known (fallback `{ w:280, h:158 }`), image ≈ the asset aspect capped to a
   sane max, doc/file ≈ `{ w:240, h:72 }`. Put a `defaultSizeForAsset(asset)` helper next to the
   drop handler; the generic 260×160 stays only as the last-resort fallback.
2. **Audio card layout**: the waveform must fill width and stay a fixed comfortable height; the play
   button + time readout sit in a compact row beneath it (mirror the Edit-page audio-clip look —
   grep how the timeline/inspector renders an audio clip's waveform; reuse the peaks/waveform
   component if one is cleanly importable, else a simple horizontal bar-strip). It must not stretch
   when the card is resized taller — cap the waveform band and center it.
3. **Resize keeps media sane**: corner-resize on a media card preserves aspect for image/video
   (shift breaks it, as round 1); audio resizes width freely but locks height to its natural row
   height. Missing/failed media still shows the round-1 dashed "missing media" placeholder, never a
   broken `<img>`/`<video>`.
4. No test needed for the visual, but add a `notes:test` check on `defaultSizeForAsset` (audio →
   wide-short, image → aspect-derived) since it's a pure helper.

## Q2 — Cross-page links (Notes ↔ Edit ↔ Flarex — the editor-native payoff)

Round 2 linked notes to a clip time. Extend the linking so a board becomes a real index of the
project.

1. **Open the linked clip's Flarex comp from a note**: if a note is linked to a clip
   (`linkedLayerId`) that has a `flarexCompId`, its clock-chip row also shows a small node glyph
   button → switches to the Flarex page for that clip (reuse the existing
   `onOpenFlarexForClip`/focus-request idiom threaded in round 2; do NOT invent a new seam).
2. **Asset card → source**: double-clicking an `asset` card opens that asset in the Source Monitor
   (thread the existing `onOpenSourceMonitor` the bin already uses; guard when unavailable/responsive
   overlay mode). Single-click keeps selecting.
3. **"Add linked notes" discoverability**: the round-2 clip badge already jumps clip→notes. Add the
   reverse affordance in the note's hover toolbar when NOT yet linked: "Link to selected clip"
   (writes `linkedLayerId` from the current timeline selection if exactly one clip is selected —
   thread the selected layer id in as a prop, read-only). No-op with a notice when selection isn't
   a single clip.

## Q3 — Richer note content

1. **Markdown-lite rendering** for note bodies in the NON-editing state: render `**bold**`,
   `*italic*`, `- ` bullets, and `# `/`## ` headings via a tiny deterministic
   string→React formatter (NO markdown lib, NO `dangerouslySetInnerHTML` — build spans/elements).
   Editing still shows the raw textarea (round 1). Add a `notes:test` for the formatter
   (bold/italic/bullet/heading/escaping).
2. **Link card favicon + title**: a link card shows the site favicon via the zero-CORS trick
   `https://<host>/favicon.ico` in an `<img>` with an `onError` fallback to the round-1 globe icon
   (no metadata fetch). Title stays user-editable.
3. **Auto-grow note height**: while editing, the textarea grows to fit content and the card height
   follows (commit the final height with the text). Cap at a max; scroll past it.

## Q4 — Board robustness + organization

1. **Duplicate board**: `duplicateNotesBoard(graph, boardId)` pure helper (fresh board id, all item/
   edge ids remapped via the existing `cloneNoteItems`, name "… copy") + BoardSwitcher entry + test.
2. **Board cover/color**: `NotesBoard.color?` — a small accent dot in the switcher + a faint tint on
   that board's dot-grid, so boards are visually distinguishable. Theme-aware (swatch selected ring
   = `var(--nle-accent)`).
3. **Lock item**: round 1 has `locked` on the model (used for frames) — expose a lock toggle in the
   hover toolbar for ANY item (locked = not draggable/resizable/deletable until unlocked; still
   selectable). `itemsInsideFrame` already excludes locked items — verify a locked member isn't
   dragged by its frame. Add a test that a locked item is excluded from a frame drag-capture set.
4. **Select-all / Escape**: Ctrl+A on the board selects all items (guard inputs); Escape clears
   selection + closes search/edge-label editors. (Ctrl+A must NOT leak to the timeline — it can't,
   the board is its own listener, but confirm.)

## Q5 — Presentation / focus (Milanote-style, optional-but-valuable)

1. **Focus a frame**: double-clicking a frame's title fits the view to that frame (uses
   `fitViewFor` on the frame rect). Fast way to move between board regions.
2. **Present mode**: a toolbar "Present" toggle that steps through the board's frames one at a time
   (fit each frame, ←/→ to move, Esc exits) — read-only overlay, no mutation. SKIP if it fights the
   gesture state machine; note the decision. This is the "board as a deck" affordance.

## Q6 — Small wins

1. Empty-board hint currently static — add quick-start chips ("＋ Mindmap", "＋ Kanban") that stamp
   the round-2 templates, so a fresh board is one click from useful.
2. Copied-outline (`boardToMarkdown`, round 2) — add an "Export board as JSON" download too (pure
   `JSON.stringify(board)` blob) for backup/interchange; testable only as a string, skip a DOM test.
3. Duplicate-item (Ctrl+D) already exists (round 2 clipboard) — ensure it also duplicates a single
   selected FRAME with its contained items (offset all). Note if out of scope.

## Definition of done (whole round)

Every task: `pnpm --filter @orreris/web typecheck` + shared typecheck + `notes:test` green
(+ `notes:intent:test` if the compiler changed). Manual Chrome pass: drag an audio + a video + an
image from the bin and confirm each renders like a proper player at a sane size; link a note to a
clip's Flarex comp and jump to it; render markdown in a note; duplicate + recolor a board; lock an
item and confirm its frame can't drag it; focus/present frames. Update `architecture.md` with one
[x] round-3 entry; tracker notes only for real problem/solution learnings. Do NOT commit — Fable
reviews, commits, and (still) wires P1's Generate prompt through the brain router.
