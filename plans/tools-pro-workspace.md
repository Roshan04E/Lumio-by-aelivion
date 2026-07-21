# Tools → Pro Workspace overhaul

**Goal:** turn the `/tools` surface from a set of marketing-styled, one-off demo pages into a single
compact, dark, professional tool workspace — the DaVinci Resolve register: dense controls, a real
full-size viewer, keyboard-driven, zero fluff — while keeping every product rule intact (prompt-bridge
AND integrated path per tool, results always editable timeline data, pricing metadata only, local-first
media).

## Audit — why the tools feel "noobish" today

**Structure**
- `/tools` (ToolsPage) is a **marketing page**: hero with `clamp(32-52px)` headline, "Best for:" copy,
  big airy cards. Fine for visitors; wrong as the daily launcher.
- `/tools/:slug` (ToolDetailPage) is a **2,824-line monolith** with per-tool `isX` branching. Generic
  tools get a fake "stages" rail + mock-adapter progress bar (`TL6 adapters`, dev diagnostics in the UI).
- Four mature tools each built their **own bespoke layout**: SmartFollowText (1,397 lines, tabbed,
  closest to pro), RemovePerson (467), AiRoto (483), GenerativeStylize (separate standalone page,
  its own inline styles). Four different tab schemes, asset pickers, preview players, status lines.

**Look**
- Working pages reuse `mkt-*` marketing CSS (hero type, eyebrow labels, credit pills) instead of the
  editor's design language (compact 24px inspector rows, dark chrome, tokenized controls).
- Previews are small boxes inside cards: AI Roto renders the interactive frame at **300 CSS px wide**
  and bakes mattes at **12 fps**; RemovePerson similar. A masking tool where you can't see the mask.
- Vertical space burned by headers/copy before any work surface appears (back-link + icon + h1 + para
  + stage chips + credits before the first control).

**Usability**
- No keyboard shortcuts anywhere (editor has a full map).
- No persistence: leave the page → selection, points, tracks, transcripts gone (only applied results
  survive). Each page refetches assets independently.
- Statuses are prose strings dropped into random corners; long ML runs have no unified progress/job UI.
- Tools don't see each other's artifacts in the UI (an Extract Person matte can't be picked up in
  Text Behind Person; Remove Background silently runs on MOCK data until you re-extract).
- Text Behind Person / Remove Background panels are 2 controls on top of `createMockSubjectAnalysis`.

**Functionality gaps**
- Generic shell tools (remove-background, text-behind-person) still run the mock adapter with fake
  progress — placeholder theater.
- No before/after wipe, no matte view modes (alpha / overlay / checkerboard), no edge refine
  (choke/feather/spill) controls at apply time, no zoom/pan in any tool viewer.
- Apply always creates a NEW draft project (`applyMockToTimeline` → createProject) — no "apply into
  the project I came from / have open".

## Design direction (the Resolve register)

One shared **ToolWorkspace shell**, built from the EDITOR's design system (reuse
`editor/inspector/controls`, ThemedSelect, KeyframeButtons-style affordances, the editor's CSS
variables — not `mkt-*`):

```
┌──────────────────────────────────────────────────────────────────────────┐
│ toolbar: [Tool ▾] [asset chip ▾ / drop] [engine: Browser|Cloud|Bridge]   │ 36px
│          ────────────────────── spacer ─────────── [credits] [Apply ▸]   │
├───────────────────────────────────────────────┬──────────────────────────┤
│                                               │ INSPECTOR (right, 300px) │
│         VIEWER — real renderer, full size     │ compact 24px rows,       │
│         zoom/fit/100%, pan, overlays          │ collapsible sections,    │
│         (mask tint, points, track boxes,      │ scrubbable number fields │
│          caption text — per tool)             │ section order = workflow │
│                                               │ (Source → Tool → Refine  │
│                                               │  → Output)               │
├───────────────────────────────────────────────┴──────────────────────────┤
│ transport / context strip: play, scrub bar with per-frame markers        │ 40px
│ (matte coverage, caption segments, track confidence), time, view modes   │
├──────────────────────────────────────────────────────────────────────────┤
│ status bar: job state · progress · cancel · device (WebGPU/CPU) · log ▸  │ 24px
└──────────────────────────────────────────────────────────────────────────┘
```

Principles:
- **Viewer is the page.** Everything else is chrome. Viewer uses the same preview renderer/scene
  pipeline as the editor wherever composition previews are shown (parity + free quality).
- **Density like the editor inspector:** 24px rows, 12px type, icon buttons with tooltips, no
  paragraphs. Explanatory copy lives behind an `ⓘ` popover, not in the layout.
- **Marketing copy stays on `/tools` only** (and even there gets a "workspace mode").
- **Honest state:** one status-bar job model (queued/running % /done/failed + cancel) shared by all
  tools; no fake stages, no mock progress theater in real tools.

## Phases

### Phase T0 — Shell + design foundation (the unlock)
1. `ToolWorkspace` component (toolbar / viewer / inspector / transport / status-bar slots) + CSS
   (new `tool-workspace-*` classes on editor tokens; no `mkt-*` inside).
2. Shared pieces, each replacing N copies:
   - `ToolAssetChip` — toolbar asset picker: current asset thumb + name, dropdown of compatible
     media (reuses editor Media-library data), drag-drop + upload; ONE fetch, cached across tools.
   - `ToolViewer` — zoom/fit/pan canvas host with overlay plug-in surface (points, boxes, matte
     tint) and view modes (source / result / matte-alpha / overlay / wipe compare).
   - `ToolTransport` — play/pause, frame step, scrub with marker lanes; keyboard: space, ←/→, J/K/L.
   - `ToolJobBar` — the single job/status model + cancel; adapters report into it (wrap the
     existing onProgress plumbing; no adapter changes needed).
   - `EngineSwitch` — Browser / Cloud / Prompt-bridge selector with capability detection states
     (replaces the "adapters" button row + dev chips).
3. Route both `/tools/:slug` variants through the shell behind a flag (`?toolsWorkspace=1` during
   the migration, flip default when the first two tools land).

### Phase T1 — `/tools` launcher: from brochure to springboard
- Compact dark launcher (keeps a slim marketing strip up top for logged-out visitors only):
  dense tool tiles (icon, name, one line, engine badges, credits), search + category filter
  (Captions / Masking / Motion / Compositing / Generative), **Recent runs** rail (artifact +
  "resume"), **recent media** rail (click media → opens compatible tool preloaded).
- Tool switcher in the workspace toolbar makes `/tools` optional for daily use (switch tools
  without going "back").

### Phase T2 — Migrate the mask family into ONE workspace (biggest win)
Extract Person, AI Roto, Remove Background, Text Behind Person are one workflow (make a matte →
use it) presented as four disconnected pages, two of them on mock data.
- **"Subject / Matte" workspace**: full-size viewer, point-prompt (SAM) + auto-person seeds as two
  seed modes on the SAME surface; add/subtract clicks; fast preview tier → quality bake tier
  (existing handlers, unchanged ML).
- Viewer matte modes: overlay tint / alpha / checkerboard / edge wipe; per-frame coverage lane on
  the transport scrub.
- **Refine section** (inspector): feather, choke/expansion, smoothing — applied to the artifact.
- **Output section** = today's downstream tools as *apply recipes* on the SAME baked matte:
  Cutout (extract), Remove background (transparent / green screen), Text behind subject (text +
  style fields inline). Kills the mock-data panels; Text Behind Person and Remove Background stop
  being separate noob pages and become one-click recipes over a REAL matte.
- Raise AI Roto's interactive frame from 300px to the full viewer; matte bake fps selectable
  (12 preview / clip-fps quality).
- Old slugs stay as routes that open the workspace with the recipe preselected (deep-link compat).

### Phase T3 — Captions workspace
- Move Auto Captions into the shell: viewer = real caption preview composition (already exists),
  transport lane = caption segments (click = seek + select; drag edges = retime — replaces the
  ±0.1s nudge buttons), inspector = Transcribe (local/cloud/language) → Style (preset grid +
  overrides) → Words (highlights, AI suggest) → Export (SRT/VTT/JSON).
- Segment list becomes a compact virtualized table (in/out/text, inline edit, split/merge on
  hotkeys S/M) instead of stacked cards.
- Keep every existing capability (prompt bridge, Gemini repair/improve, interchange artifact).

### Phase T4 — Follow Text + Remove Person restyle
- Both already have real workflows; port their surfaces into the shell (their tracker/inpaint
  canvases become ToolViewer overlays; their tab flows become inspector sections + transport).
- Follow Text: confidence lane on the scrub bar (the re-track "fix marker" flow gets markers ON
  the transport, Resolve-style), target list as compact rows with per-target color chips.
- Remove Person: brush size/hardness as scrubbable fields, before/after wipe in the viewer.

### Phase T5 — Generative Stylize + prompt-bridge polish
- Port the standalone page into the shell (viewer = input/result compare wipe; inspector = style
  preset rows + custom directive + BYO-key section; prompt bridge becomes a copy-chip + paste-drop
  zone in the Output section).
- The prompt-bridge pattern (copy prompt → paste result) becomes a shared `PromptBridgePanel`
  component so every tool's free path looks identical.

### Phase T6 — Cross-cutting pro features
1. **Session persistence**: per-asset tool state (points, targets, transcript draft, chosen recipe)
   saved to OPFS/localStorage next to the artifact store; reopening a tool with the same asset
   restores the session ("resume" on the launcher's Recent runs).
2. **Artifact library**: a small "Artifacts" popover listing stored mattes/tracks/transcripts for
   the current asset (from artifact-store) — any tool can bind an existing artifact instead of
   recomputing (the registry already declares `accepts: ["mask", "trackingPath", …]`; give it UI).
3. **Apply targeting**: "Apply to → New draft / Current project" (when arriving from the editor via
   a `?project=` param) instead of always minting a new project.
4. **Keyboard map**: shared hook — space (play), ←/→ (frame), Shift+←/→ (1s), F (fit), Z (100%),
   V (cycle view modes), Enter (run), Esc (cancel), ? (cheat-sheet overlay).
5. **Decompose ToolDetailPage**: per-tool files under `apps/web/src/tools/pages/`, shell logic in
   the workspace; target ≤300 lines per tool page; delete the mock stage rail + dev-details from
   user UI (keep behind `?toolsDebug=1`).

## Non-goals / guardrails
- No ML/engine changes in T0–T5 (same handlers, adapters, artifact pipeline) — this is surface +
  workflow. Engine upgrades (SAM2 video tracking, crowd matting) stay separate tracks.
- Don't break the two-path rule: every tool keeps prompt-bridge AND integrated paths visible.
- Credits stay display-only; no gating added.
- `/tools` remains linkable marketing for logged-out users (slim hero survives there only).

## Sequencing & effort (rough)
| Phase | Scope | Size |
|---|---|---|
| T0 | shell + shared components + flag | L |
| T1 | launcher | S |
| T2 | matte workspace (4 tools folded) | XL |
| T3 | captions workspace | L |
| T4 | follow-text + remove-person port | M |
| T5 | generative stylize + bridge panel | S |
| T6 | persistence, artifacts, apply-target, keys, decompose | M-L |

Order: T0 → T1 → T2 → T3 → T4 → T5 → T6 (T1 can ride with T0; T6 items 3–4 can land early if cheap).

## Verify per phase
- `pnpm --filter @orreris/web typecheck` + editor.test.ts each phase.
- Screenshot pass per migrated tool at 1280×800 and 1920×1080 (density check: first control above
  the fold, viewer ≥60% of viewport).
- Regression: each tool's existing end-to-end flow (upload → run → apply → editor opens with
  editable layers) must still pass manually; captions keep SRT/VTT round-trip.
