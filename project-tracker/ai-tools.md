# AI tools — versioned problem/solution log

Covers: tool capability plumbing (handlers/adapters), cross-tool artifact reuse, matte/tracking
artifact lifecycle (bake → store → upload → export), ToolDetailPage/tool surfaces.

## v1 — Tools re-segmented per run + masked layers hung cloud export (2026-07-13)

**Problem:** (a) Text Behind Person / Remove Background / Follow Text never reused a prior Extract
Person result — the /tools page fell back to `createMockSubjectAnalysis` and the editor one-click
handlers re-ran `segmentVideoFast` from scratch every time ("extract once, reuse everywhere" gap).
(b) A masked layer whose matte upload had failed (offline bake) kept a `blob:`/`opfs:` URI in the
saved graph; the Remotion worker fetches `matte.uri` like any media URL, so the frame's composite
gate waited forever — cloud export hung silently with no user-facing error.

**Root cause:** (a) no artifact index by source asset anywhere: producers never stamped
`sourceAssetId` (the field existed on `MaskSequenceArtifactData` since day one, unset), the OPFS
artifact store is keyed by artifact id only with an in-memory metadata Map (not queryable after
reload), and the `apply*Composition(mask)` reuse endpoints sat unused. (b) all five matte-upload
sites were `try { createAsset } catch { keep blob: }` silent fallbacks, and nothing between "graph
saved" and "render job created" checked matte URI fetchability (`buildRenderManifest` carries
`layer.matte` verbatim by design).

**Fix:** three shared choke points instead of per-tool patches —
- `apps/web/src/tools/mask-resolver.ts` (pure, headless-testable): producers stamp
  `sourceAssetId` + register into a session index; `findReusableMask` looks up session index →
  `editableFields.maskSequence` → composition scan (durable http URIs only; `_sam_` AI-roto mattes
  excluded — they key arbitrary prompted objects, not the person). Wired into `runSegmentationMatte`,
  the extract-person fast tier (a clean bake satisfies a fast request; quality always re-runs), and
  smart-follow tracking, each with a "Re-analyze"/"Re-track" optionField escape hatch and reuse
  announced in progress text.
- `uploadMatteForExport` (`matte-store.ts`): the one matte-upload helper — never throws (local-first
  offline editing keeps working) but surfaces the failure via progress/status.
- `apps/web/src/export/matte-resolve.ts`: pre-submit resolver — background sync best-effort
  uploads any non-durable matte (bytes recovered from the live blob: URL or OPFS, whose `get()`
  now falls back to the `${id}.bin` naming convention after reload) and rewrites the graph;
  `ensureExportReady` hard-gates with `MatteResolveError` naming the layer when bytes are gone.
- ToolDetailPage migrated onto the handler contract in the same round (run paths + the three mask
  tools' applies via `context: "standalone"` + `describeEditableFields`), so the reuse/upload fixes
  hold on every surface automatically. EditorPage untouched (concurrent agent) — `MatteResolveError`
  rides the existing generic export-error toast.

**Verify:** 21 new `editor:test` checks (resolver tiers, durable-URI rules, collect/rewrite
surgical behavior, insert-vs-replace apply modes); full web typecheck; end-to-end through the REAL
Remotion renderer with an http-served matte (temp script, deleted): bare vs matted stills differ,
and an inverted-matte render flips the frame from 60% light to 100% dark — impossible unless the
worker fetched, bound, and multiplied the matte texture.

**Known limitation:** the composition-scan reuse tier can't distinguish mask provenance beyond the
`_sam_` id convention; a stale mask after a clip retrim is expected to be fixed via "Re-analyze"
(always announced, never silent).

## v2 — v1's editor-path masks weren't durable; auto-inserted prerequisites implied re-runs (2026-07-13)

**Problem:** two remainders deferred from v1: (a) editor one-click applies stored the mask ONLY as
`layer.matte` on the composition — deleting the layer (or any editableFields-tier lookup after
reload) lost the reuse source; (b) `resolveModuleInsertions` inserted prerequisite modules (e.g.
PERSON_EXTRACTION under Text Behind Person) as `status: "idle"` with default config even when the
project already had a durable mask — the effect stack implied a re-run of work that already exists.

**Root cause:** v1 deliberately skipped EditorPage (concurrent agent claim) so
`describeEditableFields` had no editor consumer; the resolver was pure metadata by original design.

**Fix:** (a) `useLayerToolEffectRunner` now passes `editableFields` into `run` and hands the
handler's `describeEditableFields` patch to `onApplied`; `ToolEffectRunnerModal` passes both
through; EditorPage's new `applyToolEffectResult` merges patch + composition in ONE `updateGraph`
(same atomic pattern as `applySmartFollowTextResult`, no stale-graph race; no-patch path unchanged).
(b) `resolveModuleInsertions(existing, type, {editableFields})` + `artifactSatisfiesModule`
(dependencies.ts): a durable artifact (http(s)-fetchable mask / non-empty tracking path) makes the
auto-inserted PREREQUISITE land as `status: "ready"` with `{satisfiedByArtifact,
maskSequenceId|trackingPathId}` in config; the requested module always inserts idle; both
`addEffect` call sites (web local fallback + API route) pass the graph's editableFields. Verified
`mockProcessing` has no effect-status state machine, so "ready" is display metadata only.

**Verify:** 8 new editor:test checks (satisfaction rules incl. blob:-never-satisfies, ready-vs-idle
insertion, requested-stays-idle, follow-text threads both prerequisites); full 5-package typecheck.
