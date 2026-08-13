export * from "./blueprint";
export * from "./motion/motion-intent";
export * from "./text-look";
export * from "./catalog";
export * from "./ai-prompts";
export * from "./animation";
export * from "./audio-fx";
export * from "./billing/pricing";
export * from "./color";
export * from "./auto-caption-assistant";
export * from "./graphics/catalog";
export * from "./graphics/layer-graphic";
export * from "./capability-index";
export * from "./captions";
export * from "./clip-masks";
export * from "./clip-reference";
export * from "./cloud-transcription";
export * from "./composition-style";
export * from "./dependencies";
export * from "./effects";
export * from "./external-cube-adapter";
export * from "./flarex/types";
export * from "./flarex/compile-flarex";
export * from "./flarex/node-graph-intent";
export * from "./flarex/node-defs";
export * from "./flarex/registry";
export * from "./flarex/virtual-layers";
export * from "./flarex/time-transform";
export * from "./flarex/source-draw-cache";
// Mask-node outline payload + the ONE site that resolves it at a time (the editor bridge and the
// compiler must read and write the same form, or the overlay shows a shape the render disagrees with).
export * from "./flarex/mask-shape";
// Node content hashing (ADR-009) — the editor's node thumbnails key their cache on it.
export * from "./flarex/content-hash";
// Lowering degradation vocabulary (ADR-012 I-34, slice S0.2) — observability out-channel only.
export * from "./flarex/degradation";
// Runtime kernel (ADR-012) — framework-free; see packages/shared/src/kernel/index.ts.
export * from "./kernel";
export * from "./notes/types";
export * from "./notes/registry";
export * from "./notes/notes-intent";
export * from "./notes/notes-layout";
export * from "./notes/notes-markdown";
export * from "./external-gl-transition-adapter";
export * from "./external-timeline-adapter";
export * from "./external-timeline-exporter";
export * from "./export-settings";
export * from "./render-queue";
export * from "./export-stress-fixture";
export * from "./masks";
export * from "./nesting";
export * from "./matte";
export * from "./plugin-catalog";
export * from "./plugin-library";
export * from "./plugin-effect-adapter";
export * from "./plugin-look-adapter";
export * from "./plugin-manifest";
export * from "./plugin-package-zip";
export * from "./plugin-template-package";
export * from "./plugin-safety";
export * from "./plugin-transition-adapter";
export * from "./frames";
export * from "./render-comparison-fixture";
export * from "./responsive-pin";
export * from "./scene";
export * from "./schemas";
export * from "./skills";
export * from "./templates";
export * from "./text-styles";
export * from "./text-script";
export * from "./text-warp";
export * from "./text-warp-mesh";
export * from "./font-outlines";
export * from "./font-catalogue";
// The remote index (S2.6). `font-index-data` — the generated ~100KB literal — is NOT re-exported,
// but be clear-eyed about what that does and does not buy: `font-index.ts` imports it statically, so
// the text is in the bundle regardless. What stays lazy is the DECODE (~2k rows → objects), which
// happens on the first query rather than at import. Picker startup is measured in `font:picker-perf`.
export * from "./font-index";
export * from "./font-ingest";
export * from "./font-install";
export * from "./font-store";
export * from "./fonts";
export * from "./media-manifest";
export * from "./timeline";
export * from "./timeline-actions";
export * from "./track-fusion";
export * from "./timeline-ops";
export * from "./tool-adapters";
export * from "./tools";
export * from "./types";
