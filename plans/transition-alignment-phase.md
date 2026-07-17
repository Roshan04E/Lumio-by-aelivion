# Transition alignment phase (planned 2026-07-17) — Sonnet-executable

Context: R3.1/R3.2 shipped handle-aware transition windows (see architecture.md). Placement is
AUTOMATIC: ideally centered, shifted toward whichever side has handle material, zebra warning +
right-click "trim clips" when repeats are unavoidable. What's missing vs Premiere is the MANUAL
alignment override (Center / Start / End at Cut). User request 2026-07-17: pill showed end-at-cut
(correct — outgoing had no tail media) but they expected centered; give them the choice.

Ground rules (repo doctrine — do not violate):
- ONE shared implementation: `resolveTransitionWindowSides` in `packages/shared/src/composition-style.ts`
  is the only place window placement math may live. Every renderer + the timeline pill already call it.
- Absent alignment MUST behave exactly like today (auto). No behavior change without the new field set.
- Run `pnpm -r typecheck` and `PIXEL_BROWSER_CHANNEL=chrome pnpm --filter @kimera-by-aelivion/worker render:compare:pixels` before finishing.

## T1 — data: `alignment` on TransitionSpec

`packages/shared/src/types.ts`: find `TransitionSpec` (the junction transition spec carried on
`layer.transitionIn`). Add:

```ts
/** Window placement relative to the cut. "auto" (default/absent) = handle-aware (R3.1): centered when
 *  both sides have media, shifted toward the side that does. Manual values force placement and may
 *  produce repeated frames (zebra warning) where material is missing — exactly Premiere's model. */
alignment?: "auto" | "center" | "start" | "end";
```

Check any zod schema / manifest serializer that round-trips TransitionSpec (grep `transitionIn` in
render-manifest building, apps/worker manifest types) — the field must survive into the worker manifest
(it should automatically if the spec is carried verbatim; verify).

## T2 — resolver: honor alignment + both-sided repeat accounting

`resolveTransitionWindowSides` (composition-style.ts): add optional `alignment` to the input struct.

```ts
const prerollSeconds =
  input.alignment === "center" ? duration / 2
  : input.alignment === "start" ? 0
  : input.alignment === "end" ? duration
  : /* auto — unchanged */ Math.max(0, Math.min(duration, Math.min(headHandleSeconds, Math.max(duration / 2, duration - tailHandleSeconds))));
const postrollSeconds = duration - prerollSeconds;
// Manual alignment can exceed EITHER side's material; auto only ever exceeds the tail.
const repeatedFramesSeconds =
  Math.max(0, prerollSeconds - headHandleSeconds) + Math.max(0, postrollSeconds - tailHandleSeconds);
```

(For auto, `preroll ≤ headHandle` by construction so the head term is 0 — value identical to today.
The scratchpad sweep `repeated-frames-sweep.ts` pattern shows how to verify; add a couple of manual-
alignment cases.)

Every caller passes the spec's alignment. All seven funnel sites (they already build the same input):
1. `apps/web/src/components/VideoPreview.tsx` — `resolveTransitionSides` (~line 747): `alignment: incoming.transitionIn?.alignment`.
2. `apps/web/src/editor/performance/viewerProxyCapture.ts` — its local `resolveSides`.
3. `apps/web/src/export/scene-frame-compositor.ts` — `transitionSides()`.
4. `apps/worker/src/remotion/SceneStage.tsx` — `manifestTransitionSides()`.
5. `apps/web/src/components/TimelineStrip.tsx` — junction pill site (~3707) AND the
   `handleClipContextMenu` insufficient-overlap computation.
6. `apps/web/src/pages/EditorPage.tsx` — `handleTrimForTransition`.

NOTE (R3.2 invariant): the incoming clip's playback pre-roll (`incomingPrerollById` in VideoPreview →
`prerollSeconds` prop → WebglMediaLayer.mapSourceTime, and PreviewLayer.resolveSourceSeconds) is fed
from the SAME resolver, so a manual "center" with no head handle automatically edge-holds via the
existing asset-floor clamp (`Math.max(0, …)`) — no extra work, but DO NOT bypass the shared map.

## T3 — UI: alignment select in the junction popover

`apps/web/src/components/JunctionTransitionPopover.tsx` (opened from the pill): add a 4-option
row — Auto (recommended) / Center at cut / Start at cut / End at cut — using the panel's existing
`ThemedSelect`. Write path: follow how the popover updates transition duration/kind
(`onSetCrossDissolve` / `applyJunctionTransition` in EditorPage) — extend that same single code path
to write `alignment` into the spec; do NOT invent a parallel setter. One `updateComposition` = one
undo step. The pill (already sides-driven) repositions automatically; zebra appears when the manual
choice forces repeats; the existing right-click trim still fixes the tail side.

## T4 — deferred (Fable-tier, do NOT attempt)

Extending "Trim clips to create overlap" to manufacture HEAD material (incoming `sourceInSeconds`
shift) — it moves content under existing local-time keyframes/markers and needs the head-trim op's
keyframe glue. Recorded in plans/effects-paint-deferred.md territory; leave the trim tail-only.

## Gates

- `pnpm -r typecheck`
- math sweep incl. manual alignments (copy scratchpad `repeated-frames-sweep.ts` into a temp run)
- `PIXEL_BROWSER_CHANNEL=chrome pnpm --filter @kimera-by-aelivion/worker render:compare:pixels`
- Add ONE new pixel fixture: two video clips, `alignment: "center"`, outgoing with NO tail handle —
  asserts the edge-hold parity across web/remotion (the repeats case must look identical).
