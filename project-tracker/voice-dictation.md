# Voice & dictation — versioned problem/solution log

Covers: Web Speech dictation, the transcript normalizer, local-ASR refine ("better ears"),
wake-word/voice-session flows, composer↔engine text handoff.

## v1 — ASR final silently rewrote the interim the user read ("neon" → "new") (2026-07-18)

**Problem:** User dictated "apply the neon look on clip 1"; the composer showed "neon" live
(interim), but on Enter the submitted text said "new" — Web Speech's FINAL replaced the visible
interim with a worse hypothesis right at submit time. Same class of bug is observable in
ChatGPT/Gemini voice input. Two aggravators found while tracing: (a) the transcript normalizer
biased toward editor terms (clip/playhead/keyframe) but knew nothing about the look libraries, so
finals were free to clobber look names; (b) a stale-refine race — `cancelledRef` alone couldn't
kill an in-flight local-ASR refine because the next `start()` resets it, so a slow refine from
session A could overwrite the composer after session B began or after a submit cleared it.

**Solution (commit 3246d84):** Registry-anchored **final-vs-interim arbitration** — at final-time
we hold TWO engine hypotheses, so `arbitrateFinal(interim, final)` (transcript-normalizer.ts)
compares them inside known command frames (apply-the-X-look, make-it-X mood): the interim's slot
wins ONLY when it resolves against the live registries (color looks, text looks, mood recipes)
and the final's replacement does not. A resolvable final always wins; text is never invented —
both candidates came from the engine. Plus: frame-gated distance-1 fuzzy bias of look names
("neyon" → Neon; distance-2 "new" is never guessed without interim evidence), and a
session-generation counter in useDictation (start/cancel bump it; a refine only delivers if its
captured generation is current). Panel wires arbitration into `onFinal` (vs the last-read
interim) and `onRefined` (vs the visible session text). Typed input stays untouched end to end.
Eval: brain:eval +13 rows including the real report and MUST-NOT guards (resolvable final wins,
unresolvable interim never overrides, no frame → no touch).

**Watch for:** new command frames (motion phrasings, ordinal-targeted asks) should be added to
`COMMAND_FRAMES` as they gain tier-0 reflexes — arbitration only protects vocabulary it can
resolve.

## v2 — "remove the X look" had no reflex; fast lane invented invalid actions (2026-07-18)

**Problem:** Same live session as v1: "remove new look from text clip 3" → fast lane emitted
`applyTextLook("new look")` (validation fail); "remove neon look from clip 3" → `removeEffect
("neonLook")` (no such effect). There was no remove-look path at any tier, so the small model
guessed — and the v1 "watch for" fired immediately: the remove frame wasn't arbitration-protected
either, so the dictated "neon" arrived as "new" again.

**Solution:** Tier-0 REMOVE-LOOK reflex (`removeLook` in brain/router.ts, before the generic
delete handler): color looks are a `creativeLook` effect → real `removeEffect` plan (bare
"remove the look/grade" removes whatever is applied; asked-name ≠ stored-name → honest answer
naming what's actually on the clip); text looks BAKE via applyTextStyle → honest answer offering
undo / restyle. Probe-caught branch-order bug: a text layer can carry a creativeLook EFFECT too
(applyLook allows it) — the effect check must come before the bake answer. `REMOVE_LOOK_FRAME_RE`
added to `COMMAND_FRAMES`. brain:eval +12 rows; verified in-editor (apply noir → "remove the
look" → removed; text clip → bake answer).

**Still open (capability gap, deliberate):** "make the video play quicker" — there is NO speed
action in the timeline action registry; the model's "I can't" was honest. The UI's speed commit
(`handleChangeLayerSpeed`, EditorPage) re-derives duration, syncs linked groups, and clamps
against neighbors — porting that into a registry `setClipSpeed` action belongs to the S1/S2
speed-ramp phase (plans/speed-ramp-pro.md), not a quick add.
