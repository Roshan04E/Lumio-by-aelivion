# Orreris Plugin Architecture

This tracker turns effects, looks, transitions, and full timeline templates into portable packages instead of hardcoded editor features. The north star is simple: the editor should not care whether an item came from built-in code, the backend database, an imported local package, or a future creator marketplace.

## Principles

- **Canonical first.** Orreris uses its own versioned manifest format internally. Other formats are imported through adapters into that format.
- **Adapters at the edge.** Premiere/FCPXML/LUT/GLSL importers should translate into Orreris manifests, not leak foreign project assumptions into the renderer.
- **Renderer-safe.** Dynamic effects and transitions must declare their engine and compatibility. No arbitrary code execution.
- **Timeline-action compatible.** Applying a plugin item should still route through the existing timeline action registry wherever a timeline mutation happens.
- **Graceful degradation.** Unsupported imported features should be reported as warnings, not silently dropped.

## Package Shape

Orreris packages use a zipped folder format, named `.orreris`.

```txt
example.orreris
  manifest.json
  timeline.json
  assets/
  previews/
```

The root `manifest.json` identifies the package kind, version, author, compatibility, entry files, assets, and warnings. The individual entries are validated against shared schemas before registration.

Status: Complete - `packages/shared/src/plugin-package-zip.ts` (fflate) builds/parses real `.orreris` ZIPs with embedded media: `manifest.json` + `timeline.json` (the full bare `OrrerisTimelineTemplatePackage`) + `assets/<assetId>.<ext>` + an optional `previews/` image. `isOrrerisPackageZipBytes` sniffs the ZIP magic so bare `.orreris-template.json` (no media) keeps working unchanged. The editor's export button (Shift+click) builds the ZIP with every referenced asset's real bytes (local blob store first, `fetch(fileUrl)` fallback) and downloads `.orreris`; import detects the ZIP (by extension or magic), creates a real local `SourceAsset` per embedded file via the normal upload path, and remaps `layer.assetId` (root + auxiliary compositions) from the package's ids to the newly created ones - no relink-by-warning. `examples/plugin-manifests/sample-template.orreris` is a worked example. `effects/`/`transitions/`/`looks/` subfolders from the original sketch above are not used - manifests are embedded in `timeline.json`'s `graph.plugins`, not as separate zip entries.

## Task 1 - Shared Manifest Contract

Goal: Define the versioned JSON contract for plugin packages.

Implementation:

- Add shared Zod schemas and TypeScript types for package manifests.
- Support these package kinds: `effect`, `transition`, `look`, `timeline-template`, `look-pack`, and `bundle`.
- Model metadata, author, license, tags, thumbnails, preview media, compatibility, declared assets, editable params, warnings, and entries.
- Keep the schema renderer-agnostic, so backend and frontend can use the same validator.
- Export the manifest module from `@orreris/shared`.

Status: Complete - initial shared contract added in `packages/shared/src/plugin-manifest.ts` and exported from `@orreris/shared`.

TODO: Manually verify `packages/shared/src/plugin-manifest.ts` has the expected package fields and rejects malformed manifests.

## Task 2 - Built-In Provider Layer

Goal: Stop UI code from reading only hardcoded arrays.

Implementation:

- Introduce `EffectProvider`, `TransitionProvider`, `LookProvider`, and `TemplateProvider` interfaces.
- Wrap existing hardcoded effects/transitions/looks as built-in providers.
- Add provider aggregation functions such as `listEffects()`, `listTransitions()`, and `listLooks()`.
- Preserve the current public behavior while changing the data source boundary.

Status: Complete - provider interfaces and built-in/manifest provider factories added in `packages/shared/src/plugin-library.ts`; the Effects catalog now reads built-in effects/looks through provider-backed library functions. Transition tiles still use curated presets over registered transition IDs until Task 4 adds dynamic transition manifests.

TODO: Manually verify the Effects tab still shows the current built-in effects and transitions after provider wrapping.

## Task 3 - Dynamic Effect Definitions

Goal: Allow database/imported effects to register without code edits.

Implementation:

- Define a resolved runtime effect definition separate from the saved manifest.
- Support effect engines: `native`, `color-pipeline`, `lut3d`, `css-filter`, `webgl-fragment`, and `composite`.
- Map compatible dynamic effects into existing `TimelineEffect` instances.
- Add clear unsupported-engine warnings.
- Keep built-in effect IDs backwards compatible.

Status: Complete for safe V1, and `webgl-fragment` is now REAL (flagship gap closed) - `packages/shared/src/plugin-effect-adapter.ts` resolves imported effect manifests into existing renderable Orreris timeline effects, applies creator-defined params/intensity/name, checks layer compatibility, and reports unsupported-engine warnings. A `webgl-fragment` manifest's GLSL registers as a `FragmentEffectDefinition` (`packages/shared/src/color/fragment-effects/registry.ts`, the same registry+harness pattern as the transition engine) and produces a `pluginShader` `TimelineEffect`; `SceneCompositor` runs it as a real fragment-shader pass (`packages/shared/src/color/scene-compositor.ts` `renderLayerWithRegionPasses`/`runFragmentPass`) in preview, local export, AND Remotion (`apps/worker/src/remotion/SceneStage.tsx` now calls `registerEffectManifests`), so a user's own GLSL renders identically everywhere - verified by `render:compare:pixels` at 0.000% for the `plugin-shader` fixture. `css-filter` and `composite` remain deferred.

TODO: Manually import one JSON effect manifest and verify it appears in the Effects tab without adding a hardcoded entry. For a `webgl-fragment` manifest (e.g. `examples/plugin-manifests/invert.effect.json`), verify the shader renders live in preview, scrubs with intensity/params, and matches in a local export.

## Task 4 - Dynamic Transition Definitions

Goal: Load transition manifests into the existing GPU transition engine.

Implementation:

- Convert current transition registry definitions into provider-backed definitions.
- Accept `webgl-transition` manifests with params, easing, default duration, category, and GLSL body.
- Validate GLSL bodies against the expected transition harness contract.
- Add a registration boundary that prevents ID collisions unless explicitly overridden by trusted built-ins.

Status: Complete - `packages/shared/src/plugin-transition-adapter.ts` validates `webgl-transition` manifests, converts them into GPU `TransitionDefinition`s, and registers them with collision protection. The Effects panel can import a transition manifest JSON, register it, show it in the transition library, preview it, favourite it, and apply it to a junction. Backend catalog wiring is tracked separately in Task 7.

TODO: Manually verify a manifest-defined transition can be previewed, favorited, and applied to a junction.

## Task 5 - Looks Gallery In Effects Tab

Goal: Move creative looks out of the Color dropdown experience and into browsable tiles.

Implementation:

- Add a Looks strip to the Effects panel beside Transitions and AI Tools.
- Reuse the transition-gallery modal pattern for a full Looks browser.
- Add categories such as Cinematic, Film, Clean, Vintage, Social, and Creator Packs.
- Allow applying directly to the selected clip.
- Add an alternate apply path that creates an adjustment clip/layer.

Status: Complete - the Effects tab now has a Looks strip and full Looks gallery; look tiles preview the selected/available frame with an approximate grade, and looks apply directly to the selected visual layer or as a new adjustment clip. Safe V1 look manifests are now importable from the Looks gallery, persisted in `ProjectGraph.plugins.looks`, hydrated into the color pipeline, and render through the existing `creativeLook` effect.

TODO: Manually import `examples/plugin-manifests/warm-cinema.look.json`, verify it appears under Uploaded Looks, apply it directly to a clip, then apply it as an adjustment layer.

## Task 6 - Template Import/Export V1

Goal: Export and import full Orreris timeline templates.

Implementation:

- Export composition, layers, tracks, effects, transitions, keyframes, masks, and text styles.
- Include media placeholders/slots for replaceable assets.
- Include package assets and preview metadata.
- Import into a new project or current project.
- Report missing assets and unsupported entries clearly.

Status: Complete - V1 adds a portable `.orreris-template.json` package contract for Orreris by Pesamee Studio. The package contains a validated timeline-template manifest, the reusable project graph/composition, slot metadata, referenced media metadata, preview metadata, and import warnings. The editor top bar now exports the active timeline to a package and imports a package back into the current project through the normal graph/history path.

TODO: Manually use the top-bar Export template package button, then Import template package into another project/current project and compare timeline layer count, timing, effects, transitions, masks, text styles, and missing-media warnings.

## Task 7 - Backend Catalog

Goal: Make effect/transition/look/template libraries fetchable from the database.

Implementation:

- Add backend package metadata storage for package kind, version, schema version, tags, preview URLs, compatibility, and package URL.
- Add catalog endpoints for listing and resolving packages.
- Keep package blobs in storage and metadata in the database.
- Cache fetched manifests client-side with version-aware invalidation.

Status: Complete - V1 adds a Prisma-backed `PluginPackage` catalog for effects, transitions, looks, bundles, and timeline-template manifests. The API now exposes `/api/plugin-packages` for public listing/resolution and authenticated publish/update, seeds the Soft Bloom effect and Warm Cinema look manifests, and the web client fetches the catalog through a revisioned local cache. Fetched catalog manifests hydrate the Effects tab, and any backend manifest the user applies is copied into `ProjectGraph.plugins` so local/cloud export can carry it.

TODO: Run `pnpm --filter @orreris/api prisma:migrate` and `pnpm --filter @orreris/api db:seed`, open the editor, verify Soft Bloom and Warm Cinema appear from the backend catalog, apply each, refresh, then local/cloud export to confirm the project retains only the used manifest(s).

## Task 8 - Package Import Safety

Goal: Validate and sandbox imported packages.

Implementation:

- Validate every manifest with shared schemas before registration.
- Reject unsupported schema versions unless a migration exists.
- Enforce package size and asset count limits.
- Block executable scripts in package contents.
- Add warnings for unsupported engines, missing preview assets, and unknown fields.

Status: Complete - V1 adds shared plugin safety inspection in `packages/shared/src/plugin-safety.ts`. Manual uploads and backend package publishing now validate through the same safety path: schema parsing, unsupported schema-version rejection, manifest/package byte limits, asset/entry/param count limits, executable/script-like content blocking, unsupported engine warnings, missing preview-asset warnings, and unknown top-level field warnings.

TODO: Manually import malformed effect/look/transition JSON files that cover wrong `schemaVersion`, too many assets, `<script>` content, `javascript:` URLs, wrong manifest kind, and unknown top-level fields; verify the UI/API shows specific rejection or warning text.

## Task 9 - External Format Adapters

Goal: Make external software formats usable through controlled importers.

Implementation:

- Start with `.cube` LUT packs and GL-Transitions-style GLSL transitions.
- Add FCPXML/XML/EDL timeline import before `.prproj` because they are cleaner interchange formats.
- Add limited `.prproj` import/export later for timeline structure, media references, basic transforms, cuts, and mappable transitions.
- Produce an import report with `imported`, `mapped`, `skipped`, and `unsupported` sections.

Status: Partial, with Day 2 fidelity + FCPXML export shipped - V1 adds a universal Effects upload button that auto-detects effect/look/transition manifest JSON, `.cube` LUT files, and external GL transition files. `.cube` files are parsed with the existing Orreris LUT parser, wrapped into portable `effect` manifests using the `importedLut` renderer, and imported into Uploaded Effects. Raw `.glsl`/`.frag` files and GL-transition-style JSON with a `glsl`, `fragment`, `shader`, or `transition` string are wrapped into portable `transition` manifests using the `webgl-transition` renderer. Imported LUT effects now preserve the LUT display name and blend through the LUT intensity pipeline instead of applying at full strength. Uploaded effects, looks, and transitions can be removed from their panels and stay hidden across refresh until re-uploaded. Task 9B adds external timeline import adapters for CMX-style `.edl`, FCPXML `.fcpxml`, and Final Cut/Premiere XML `.xml`: the editor's timeline/template import button now detects those files, parses them into Orreris timeline compositions with media placeholder slots, shows an import report before applying, preserves source in-points/timing, and records imported/mapped/skipped/unsupported details in `ProjectGraph.editableFields.timelineImportReport`. Task 9C adds limited `.prproj` import: the editor accepts gzip-compressed or plain XML Premiere project files, imports a readable sequence's clip timing/media placeholders, and reports effects/components, nested sequences, and other unsupported features for manual remapping.

**Day 2 fidelity (this pass):** a shared `mapExternalTransition(name)` table (`external-timeline-adapter.ts`) maps Premiere/FCPXML/Resolve transition NAMES to registry kinds (Cross Dissolve, Dip to Black/White, Wipe, Push, Slide, Cross Zoom, Iris; unknown names still map to Cross Dissolve rather than being dropped) — both `.prproj` and FCPXML transitions now route through it instead of the old dissolve-only check. FCPXML import gained: `<title>` → an editable text layer (text + basic font/color/alignment from `<text-style>`), `<transition>` elements → `transitionIn` on the following clip via the shared table, and `<adjust-opacity>` keyframes → layer `animations`. `.prproj` import gained a **multi-sequence picker**: every candidate sequence is now returned in `report.availableSequences` (id/name/clip count), and the report modal lets a user re-parse against any of them (`sequenceId` param) instead of only the auto-picked "most readable clips" one. New `external-timeline-exporter.ts` adds **FCPXML export** (`exportCompositionToFcpxml`) — the hand-off direction: clips, titles, and transitions (reverse of the same mapping table), with masks/text-warp/plugin-shader effects/blend-modes/keyframes honestly reported as lossy in `report.unsupported` rather than silently dropped. Round-trip verified (export → re-import via `parseFcpxml`) in `editor.test.ts`. `.prproj` motion-keyframe extraction (Position/Scale/Rotation) remains a known ceiling — the object-ref-graph parser is regex-based over an escaped/nested real-world format; see `project-tracker/nle-import-export.md`.

TODO: Manually upload `examples/plugin-manifests/warm-lift-test.cube` from the Effects tab, apply the imported LUT effect to a clip, verify the LUT field shows `Warm Lift Test` instead of `LUT loaded`, scrub LUT Intensity from 0 to 100 and confirm the grade fades in/out, upload `examples/plugin-manifests/soft-wipe.glsl` and `examples/plugin-manifests/glitch-swipe.gl-transition.json`, verify both appear under Uploaded transitions, apply them to a cut, regenerate preview proxies for a range that starts inside the transition, then verify live preview, proxy playback, local export, and cloud export preserve the embedded LUT, imported looks, and imported GL transitions. Delete one uploaded effect/look/transition and refresh to confirm it stays hidden, then re-upload it to confirm it returns. Import `examples/timeline-imports/simple-cut.edl`, `examples/timeline-imports/simple-fcpxml.fcpxml`, `examples/timeline-imports/simple-premiere.xml`, and `examples/timeline-imports/simple-premiere.prproj` from the top-bar Import timeline/template button; verify the report modal appears before applying, a title becomes editable text, a transition lands on the right cut, cancelling the report does not change the current timeline, **Append to current** preserves existing clips and places imported placeholder clips after the current timeline end, **New timeline** replaces the current composition, right-click `Replace asset...` on an imported placeholder swaps only the asset while keeping the clip start, track, duration, effects, and placement intact, and uploading/adding an MP4/MOV with no audio stream does not create a companion audio clip. Then use the topbar "Export FCPXML" button and re-import the result to confirm clips/titles/transitions survive.

## Task 10 - Creator Tools

Goal: Build effect maker and transition maker on top of the manifest system.

Implementation:

- Create a visual effect maker that exports `effect` manifests.
- Create a transition maker that exports `transition` manifests.
- Include live previews, parameter definitions, thumbnails, and package export.
- Add validation before publish/import.

Status: Pending.

TODO: Manually create a simple effect and transition through creator tools and re-import them as packages.
