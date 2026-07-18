# Timeline & Multi-Select Batch — Bugs + Features

## Context

User reported ~30 issues; this plan covers the **timeline & multi-select cluster** (chosen by user). The rest are catalogued in the Roadmap section at the bottom so nothing is lost.

Scope: 5 bugs (right-click kills multi-selection, multi-drag collapses clips to one track, linked audio doesn't move live, roll can't shorten first clip, ripple/roll not live during drag) + 5 features ("d" disable toggle with group support, slip two-up viewer feedback, fade handles beyond half, per-clip markers, auto-vacant edge tracks + smart A/V drop).

**Protected constraint** (user directive, memory): the timeline's non-idiomatic imperative patterns (zero React renders during gestures, DOM-written previews, startTransition selection, ref mirrors) are deliberate. All fixes must stay inside these patterns — never re-Reactify.

**Render parity**: any change to what renders (disabled clips, fade keyframes) must land in both the web preview and the shared scene builder consumed by the Remotion worker, verified with `pnpm --filter @orreris/worker render:compare:pixels`.

## Root causes (verified in source)

1. **Linked audio doesn't move live**: `flushDragPreview` (TimelineStrip.tsx:688) iterates `current.movedLayerIds` (drag members only). Linked followers ARE in `previewStartByLayerId` (resolveGroupMove pushes them, timeline-ops.ts:871-874) but their DOM `left` is never written — audio snaps into place only on commit.
2. **Multi-drag collapse**: two hazards. (a) Double-commit: `finishDrag` and the window safety-net `commitFromWindow` (TimelineStrip.tsx:1670-1686) both fire in the same native pointerup dispatch; `setDrag(null)` clears `dragRef.current` only inside the React state updater (622-628), so the ref may still be populated when the window listener runs → second `handleMoveLayer` against stale composition, and with magnetic mode a second `commitGroupMove` compaction can re-pack tracks. (b) Legacy fallback in `handleMoveLayer` (EditorPage.tsx:3348-3375): when `targetStartByLayerId` is absent/empty it moves the primary to ONE track and merely time-shifts the rest — the concrete collapse mechanism.
3. **Right-click collapses multi-selection**: `handleClipContextMenu` (TimelineStrip.tsx:2692, guard at 2704-2709) reads the `selectedLayerSet` prop, but marquee/shift-click selections commit via `startTransition` (EditorPage.tsx:6101) and can land hundreds of ms later. Right-click in that window → `withinSelection` false → replace-select collapses everything. The imperative `is-selected` DOM classes are the instant ground truth.
4. **Roll can't shorten first clip**: `rollEditLimits` (timeline-ops.ts:419-424) clamps leftward roll by the RIGHT clip's head material `(right.sourceInSeconds ?? 0)/speed`. Correct for media at source head, but indistinguishable from "broken" (no feedback), and must be audited for drops that carry a source in-point without writing `sourceInSeconds`.
5. **Ripple/roll not live**: roll/slide drags only update a text badge (`handleTrimMove` 1576-1585, `setTrimPreview`); clips jump on release. Edge-trim already has the imperative DOM preview pattern (`flushResizePreview` 649-667) to extend.

## Implementation (5 sessions, bugs first)

### Session 1 — drag/selection bug cluster (items 1-3 above, all in the same commit path)

**1a. Linked audio live preview** — [apps/web/src/components/TimelineStrip.tsx:688](apps/web/src/components/TimelineStrip.tsx#L688): in `flushDragPreview`, iterate `Object.keys(current.previewStartByLayerId)` instead of `current.movedLayerIds` (placement map = members + followers). Element cache/restore (`settleDragPreviewForCommit`, `restoreDragPreviewDom`) already iterate the cache map — no change. Followers keep `previewVerticalOffsetByLayerId` 0 (they never change track) — correct.

**1b. Kill the double-commit** — in `finishDrag` (1609), `commitFromWindow` (1670), `cancelFromWindow` (1687), `cancelOnEscape` (1694): set `dragRef.current = null` synchronously alongside `setDrag(null)` so the window net sees null when the element path already handled the event (matches the stated intent of the comment at 1666, which currently isn't guaranteed). `flushDragPreview` already early-returns on null ref (683).

**1c. Harden the legacy fallback** — [apps/web/src/pages/EditorPage.tsx:3348-3375](apps/web/src/pages/EditorPage.tsx#L3348-L3375) `handleMoveLayer`: when `movedLayerIds.length > 1` but `targetStartByLayerId` is missing OR an empty object, do a pure time-shift keeping each layer's own `trackId` — never funnel multi-selections into the single-primary+targetTrack branch. Temporary `console.warn` when the legacy branch is hit with a multi-selection, run the repro matrix (below), remove before finishing.

**1d. Right-click keeps selection** — [TimelineStrip.tsx:2704](apps/web/src/components/TimelineStrip.tsx#L2704): compute `withinSelection` from committed prop OR imperative ground truth: `selectedLayerSet.has(layer.id) || event.currentTarget.classList.contains("is-selected") || pendingInstantSelectionRef.current?.includes(layer.id)`. For the menu's `selectionCount` label, count `.timeline-clip.is-selected` DOM nodes when the prop is stale. Menu actions fire later (transition landed by then) and keep reading committed state. Right-clicking a clip OUTSIDE the selection still collapses to it (existing Premiere-style behavior unchanged).

**Verify (session 1)**: linked video+audio drag → audio slides live in the same frame; Escape-cancel restores both. Multi-select 3 clips on 3 tracks, drag left, release → tracks preserved; repeat with vertical motion, magnetic mode on/off. Undo after group drag = ONE step (two steps would confirm the old double-commit). Marquee-select 3 clips, right-click one immediately → menu says "3 clips", selection survives.

### Session 2 — roll/slide/ripple

**2a. Roll first-clip limitation** — diagnose with a bladed clip (right half has head material → leftward roll must work). Fixes:
- Extend `rollEditLimits` return ([packages/shared/src/timeline-ops.ts:403](packages/shared/src/timeline-ops.ts#L403)) with optional `minReason`/`maxReason` (additive); when the drag pins at a limit, show the reason in the existing trim badge (e.g. "No head material on right clip") via `setTrimPreview` payload.
- Audit the drop path (`handleDropAsset`, `addCompanionAudioLayer`, source-viewer in/out drops) for placements that trim a source range without writing `sourceInSeconds` — if in/out points set only duration, that's the real bug; carry the in-point.

**2b. Live roll/slide/ripple preview** — extend the imperative pattern in TimelineStrip.tsx:
- New `trimPreviewElsRef` cache (element + original inline `left`/`width`) + `flushTrimPreview` rAF writer, mirroring `flushResizePreview` (649).
- In `handleTrimMove` (1576): roll → left clip `width += delta`, right clip `left += delta, width -= delta` (percent math, `timelineDurationSeconds` denominator). Slide → three clips adjust; capture neighbour ids at gesture start into `trimDragRef` (or extend `slideLayerLimits` to return them). Ripple → collect downstream nodes once at gesture start, cap ~40 live-shifted nodes for perf.
- Keep the badge state (it keeps window listeners bound). Restore originals on release/Escape before commit; commit path unchanged.
- **Risk check**: verify with React DevTools "highlight updates" that neighbour clips don't re-render mid-gesture and clobber inline styles (clip vdom props are frozen at gesture start per the file's doctrine comment 638-646 — confirm it holds for neighbours).

### Session 3 — "d" disable/enable toggle (cross-package, render parity)

- **Type**: add `disabled?: boolean` to `TimelineLayer` ([packages/shared/src/types.ts:642](packages/shared/src/types.ts#L642), beside `locked`/`muted`). Check any zod schema/serializer round-trips it.
- **Toggle**: `case "d":` in the TimelineStrip keydown switch (2450, plain key — Ctrl+D duplicate untouched) → new `onToggleLayersDisabled` prop. EditorPage handler: expand selection to linked companions (pattern at `expandLayerSelection`, EditorPage.tsx:6079), converge mixed groups (`!allCurrentlyDisabled`), one `updateComposition` = one undo step. Also add "Disable/Enable clip(s)" to the clip context menu.
- **Web preview**: gate at [VideoPreview.tsx:739/781/818](apps/web/src/components/VideoPreview.tsx#L739) (`&& !layer.disabled` beside the `layer.muted` checks); audio: `apps/web/src/export/audio-mixer.ts` mute predicates + the EditorPage audible-layer gate (~5440).
- **Shared/worker parity**: single choke point — filter `!l.disabled` at the top of `buildSceneDraws` ([packages/shared/src/scene/build-scene-draws.ts:152](packages/shared/src/scene/build-scene-draws.ts#L152)); covers worker SceneStage, web ScenePreviewCanvas, export compositor. Confirm transition-pair logic degrades sanely when one side of a cut is disabled (existing `layerById.has` guards).
- **Timeline visual**: `is-disabled` class on the clip node, CSS dim (`opacity:.45; filter:saturate(.3)`); clips stay selectable/draggable. Grep other `.layers` consumers (thumbnails, waveforms, proxy) and deliberately leave them showing content.

**Verify**: `pnpm -r typecheck`; `render:compare:pixels` with a disabled video layer (absent in both renderers); "d" on a linked pair dims both, silences audio, removes video from viewer; undo restores.

### Session 4 — fades beyond half + slip two-up viewer

**4a. Fade clamp**: replace the half-duration clamps with a combined constraint `fadeIn + fadeOut ≤ duration` (one side clamps at `duration − opposingFade`):
- [TimelineStrip.tsx:2093](apps/web/src/components/TimelineStrip.tsx#L2093) `moveTransitionDrag` (opposing fade from `getClipFades` at drag start);
- `buildTransitionKeyframes` in packages/shared/src/timeline-actions/actions/transition.ts (read opposing `_transition_` keys; crossDissolve branch keeps duration/2 each);
- audio gain re-clamp at EditorPage.tsx:~5527 (`handleSetTransition`).
- Check the SVG fade band math (`fadeInPercent`/`fadeOutPercent`, TimelineStrip.tsx:4646-4647) doesn't assume ≤50%.

**4b. Slip two-up viewer**: during slip drag, show first + last frame of the slipped range.
- Plumbing: lift slip preview to EditorPage via `onSlipPreview(layerId, sourceInSeconds | null)` from the slip move (1486-1492) and release (1617-1622), rAF-throttled (thumbnails already consume `slipPreviewSourceInSeconds` at 4866 — reuse if already lifted).
- Overlay in EditorPage ON TOP of VideoPreview (not in the scene pipeline — no render-parity obligation): two pooled `<video>` elements (reuse video-element-pool / proxy URLs) seeked to `sourceIn` and `sourceIn + duration`, reseek only when the frame changes, "IN"/"OUT" timecode labels, teardown on end/Escape. Fallback to thumbnail stills if seeks are too slow.

### Session 5 — per-clip markers + auto-vacant tracks

**5a. Per-clip markers**: add `markers?: TimelineMarker[]` to `TimelineLayer` (reuse type at types.ts:830; **layer-local seconds** so markers travel with the clip). On head-trim, shift marker times so they stay glued to content (in the head-trim op). `M` key handler: if a selected clip spans the playhead → toggle clip marker at `playhead − startSeconds`; else current ruler behavior. Render flags inside the TimelineClip body (~4596); reuse the ruler marker popover (3083-3175) with a `{scope: "ruler"|"clip", layerId?}` param for rename/recolor. Add clip markers (translated to absolute time) to snap targets (~604).

**5b. Auto-vacant edge tracks + smart A/V drop**:
- New pure `ensureVacantEdgeTracks(composition)` in timeline-ops.ts: if topmost video track has any layer, prepend an empty video track; same for bottommost audio (append); collapse multiple empty edge tracks to one. Returns the same reference when nothing changes (no render churn).
- Run it inside EditorPage's `updateComposition` wrapper (single choke point) on the outgoing composition BEFORE history commit — undo/redo replays normalized states, one undo step, and it never runs mid-gesture (track ids stay stable during drags).
- Smart drop: video lands on the user's chosen track (unchanged, respects manual placement); companion audio (`addCompanionAudioLayer`, EditorPage.tsx:8623) picks the bottom-most audio track VACANT over the clip's time range (overlap scan) instead of always the first, creating one if all occupied.

**Verify**: drop on the top empty video track → new empty appears above; undo removes clip + auto-track in one step; A/V drop with first audio track occupied → audio lands on a lower vacant track.

## Cross-cutting verification

- `pnpm -r typecheck` after each session (this repo's lint).
- `pnpm --filter @orreris/worker render:compare:pixels` after sessions 3 and 4.
- Gesture smoke suite after every session: single drag, multi-drag cross-track, linked-pair drag, Escape-cancel, marquee→instant right-click, magnetic-mode drag, keyboard nudge with multi-selection.
- `previewStartByLayerId` and `is-selected` are load-bearing imperative contracts — grep consumers before touching either.

## Roadmap — remaining reported items (not in this plan)

- **Keyframes & graph editor**: broken/unresponsive keyframes (inspector value not applying); Y-graph inverted / keyframes detaching; multi-select keyframe edit corrupting all clips' sources to one (data-loss bug — should be next batch); faded curves for other selected clips; click-keyframe shouldn't move playhead; two-view (keyframe list + DaVinci-style curve) graph editor.
- **Rendering & transitions**: stacked identical layers each flashing visible for a frame; transitions starting at clip-A end instead of spanning the cut + freeze/replay when duration grows (research Adobe's centered-on-cut model); some transitions applied B→A instead of A→B; speed ramp hangs browser; speed-ramp graph with duration control; optical-flow time interpolation.
- **Effects & paint**: texture paint on text/clips; adjustment-effect clips (sketch, HSL, old TV, glitch — must be real WebGL per repo doctrine); track matte key; pen tool broken for shapes; anchor points; roll/crawl titles; color tab inside inspector; export grade to LUT.
- **Media/project hygiene**: default folders leaking from last project into new ones; new project searching old assets (perf cost); Pexels stored as URL only (no re-upload); stock footage list view; audio sync features.
