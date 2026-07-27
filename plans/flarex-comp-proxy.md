# Flarex comp proxy ("Prepare proxy" / render cache)

**Goal.** A button that pre-renders a Flarex comp over its host clip's span, so the EDIT page plays the
clip back as ordinary media instead of lowering + evaluating the node graph every frame.

This is Fusion's render cache / Resolve's smart cache / AE's pre-render. It is the single biggest
playback win available for heavy comps, and it directly serves the north star ("same comp, smoother
playback, less hardware") — a cached comp costs one texture upload per frame instead of a graph eval.

## Why this is mostly assembly, not new machinery

Three things already exist and do the hard parts:

1. **Rendering a comp to mp4 already works and is correct.** `runExportCore` +
   `SceneFrameCompositor` lower `flarexCompId` clips through the shared compiler, and as of
   2026-07-27 they also decode/grade asset-source `MediaIn` loaders (`flarexVirtualLayers`). Rendering
   a proxy = an export clipped to the host clip's span, at proxy resolution.
2. **Swapping a playback source is a solved pattern.** The source-proxy system already plays a
   lower-cost stand-in while keeping originals for export (`SourceAsset.proxyUrl`, tracker
   `source-proxy-system`). The Flarex proxy is the same idea one level up: proxy the COMP, not the source.
3. **Invalidation is already computable.** `comp.version` (bumped by `stampFlarexComp`) plus the Slice 2
   node content hashes give an exact "is this proxy still valid?" key. No heuristics needed.

## Contract

**Proxy identity:** `(compId, comp.version, hostLayerId, spanStart, spanDuration, width, height)`.
`comp.version` is the invariant that matters — ANY graph edit bumps it, so a stale proxy can never be
shown. Store the key with the artifact and compare on read; mismatch = ignore the proxy (never "repair" it).

**Never authoritative.** The proxy is a PLAYBACK optimization only. Export must always re-render from the
graph — the render manifest is the product contract (CLAUDE.md), and a cached mp4 is a lossy derivative.
Guard this explicitly: the proxy must not be reachable from `buildRenderManifest` or `export-core`.

**Fail open.** No proxy / stale proxy / decode failure ⇒ today's live graph evaluation, silently. The
feature can only ever make playback cheaper, never break it.

## Slices

**S1 — render + store (no playback change). BUILT 2026-07-27, unverified by hand.**
`FlarexProxyButton` in the workspace toolbar → `renderFlarexCompProxy` → `flarex-comp-proxy-store`.
"Save…" writes the file out; that hand-play IS the S1 verification and has not been done yet.

Three deviations from the sketch above, all deliberate:

- **`generateSpanProxy`, not `runExportCore` directly.** The span renderer already does span-clipping,
  the export Worker, the main-thread fallback, the GL-budget defer and the black-frame guard. It only
  lacked `flarexComps`/`flarexSourceAssets` — two optional pass-through fields, and the timeline span
  proxy's behavior is unchanged (it omits them, so its comp'd clips still render plain as always).
- **webm, not mp4, and its own store.** webm is what the span-proxy system already produces and plays
  back. `artifact-store.ts` is keyed by tool RUN and its records are `ToolArtifact`s the timeline can
  reference — exactly what a disposable render cache must never be — so proxies get their own OPFS
  directory with an opaque-key sidecar. Blob first, sidecar second, so a crash reads as "no proxy".
- **Full composition resolution.** A scale knob changes what "pixel-identical" means; it needs the S2
  comparison fixture first.

**Key: `comp.version` is NOT sufficient.** The flarex hook runs at the END of `buildLayerDrawWithPasses`,
so the host clip's own transform/effects/trim are baked into the comp's MediaIn and therefore into the
proxy. The key carries a `hostSignature` digest over the whole host layer (minus `flarexCompId` and
`startSeconds` — moving a clip on the timeline doesn't change its picture). Over-broad on purpose: a
false mismatch costs one re-render, a false match shows stale pixels.

**Open question for S2 (do not guess — measure).** The proxy renders the host clip alone on its own
track, transitions stripped. That is right if the flarex hook's output is exactly the layer draw at its
z-slot, which is what `applyFlarex` reads like. What is NOT yet established is whether any TRACK-level
treatment is folded into the layer draw before the hook or composited after it — if after, keeping the
host's track object in the proxy composition double-applies it at playback. The one-frame both-ways
fixture below is what settles it.

**S2 — playback swap.** In `VideoPreview`/`buildSceneDraws` input assembly: when a `flarexCompId` layer has
a VALID proxy and we are on the edit page (not the Flarex page — there you must always see the live graph),
draw the proxy as a plain media source and skip `compileFlarexComp` entirely. This is where the win lands.
Gate behind `?flarexProxy=0` as a kill switch, matching `?wcDecode=0|1` doctrine.

**S3 — lifecycle.** Invalidate + offer re-render on `comp.version` change; show proxy state on the clip
(a badge like the existing FX chip); "Clear proxy". Budget/evict OPFS like the artifact cache.

**S4 (optional) — background + partial.** Render on idle after edits settle; per-span partial proxies so a
long comp becomes usable before the whole thing finishes.

## Verification

- A comp with a proxy must be PIXEL-IDENTICAL to the live path at proxy resolution — add a fixture that
  renders one frame both ways. This is the gate that keeps the proxy honest.
- Export with a proxy present must be byte-identical to export without one (proves S2 didn't leak into
  the export path). Run `render:compare:pixels` with a proxy built.
- `flarex:perf` before/after on `heavy-100-at-half` — the proxy should collapse compile time to ~0.

## Coordination (IMPORTANT — 2026-07-27)

Another agent is implementing the remaining node types. Keep this work OUT of `node-defs.ts`,
`compile-flarex.ts` and the evaluator: the proxy needs no compiler change — it consumes the comp's
RENDERED OUTPUT. Touch points are the workspace UI, an artifact store, and the draw-input assembly.
Rebase on their node work rather than editing alongside it.
