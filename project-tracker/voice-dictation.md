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
