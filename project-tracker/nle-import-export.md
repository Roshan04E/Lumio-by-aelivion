# NLE import/export

## v1 — Transition mapping table + FCPXML title/keyframe fidelity + FCPXML export (2026-07-07)
**Problem:** Every external-timeline importer only recognized dissolve transitions (EDL "D", prproj
name containing "dissolve"/"cross") and dropped everything else as "unsupported"; FCPXML `<title>`
elements were skipped entirely (never even placeholder text); `.prproj` multi-sequence projects
silently picked "whichever sequence has the most readable clips" with no way to choose another; there
was no export direction at all (Lumio → any NLE).

**Fix:**
- `mapExternalTransition(name)` (`packages/shared/src/external-timeline-adapter.ts`) is now the ONE
  table every importer routes through: Cross/Film Dissolve → `crossDissolve`, Dip to Black/White →
  `dip` (+ color param), Wipe* → `wipe`, Push → `push`, Slide → `slide`, Cross Zoom → `zoom`, Iris →
  `iris`; anything unrecognized still maps to `crossDissolve` (never dropped) and is reported as
  "mapped" with the original name so a review modal shows what was approximated.
- FCPXML `<title>` → an editable text layer: text content, plus font/size/weight/italic/color/alignment
  read from a nested `<text-style-def><text-style>` when present (`textStyle` field threaded through
  `createImportedLayer`).
- FCPXML `<transition>` spine elements → `transitionIn` on the FOLLOWING clip, mapped via the shared
  table (previously reported as "unsupported" unconditionally).
- FCPXML `<adjust-opacity><keyframe>` → layer `animations` (opacity keyframes only — position/scale/
  rotation motion is NOT extracted; see the known gap below).
- `.prproj` multi-sequence: `report.availableSequences` now lists every candidate sequence (id/name/
  clip count); `ParseExternalTimelineInput.sequenceId` lets a caller re-parse against any of them. The
  editor's `ExternalTimelineImportModal` renders a `<select>` picker when more than one sequence is
  found, driven by a stored raw-file-contents state (`pendingExternalTimelineSource`) so re-parsing
  doesn't need to re-prompt for the file.
- New `packages/shared/src/external-timeline-exporter.ts`: `exportCompositionToFcpxml(composition,
  assets)` writes FCPXML 1.10 (`<resources>` assets + `<spine>` asset-clips/titles/transitions), using
  the REVERSE of the same transition-name table. Masks, text-warp, `pluginShader` effects, non-normal
  blend modes, and keyframes have no FCPXML equivalent — each is reported in `report.unsupported`
  rather than silently dropped. Wired to a topbar "Export FCPXML" button.

**Verify:** `editor.test.ts` — `mapExternalTransition` unit asserts (9 cases), FCPXML title/transition/
keyframe asserts against a fixture, `.prproj` multi-sequence picker + re-parse assert, and a full
export→re-import round-trip assert (clip count, timing, title text, transition kind all survive).

**Known gap (ceiling, not a bug):** `.prproj` Position/Scale/Rotation motion-keyframe extraction is NOT
implemented. The real Premiere project format (`tmp/visualizer-full.prproj.xml`, ~28k lines) nests
motion params inside escaped, deeply-referenced object graphs that a regex-based parser can't reliably
walk — attempting it risked either silently-wrong keyframes (worse than not extracting) or a parser
rewrite far outside this pass's scope. `.prproj` transitions/multi-sequence/legacy-title-via-object-
graph (`parsePrprojTextObjectGraph`) all still work; only PRIMARY-sequence motion keyframes are the gap.
CapCut project format import is not started (deferred, no format research done yet). Essential Graphics
/MOGRT templates remain unsupported (reported, not extracted) on both import and export.
