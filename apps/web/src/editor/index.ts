/**
 * Lumio editor foundation (Phase 3). Shell + registries + store + performance
 * primitives that the monolith migrates onto in Phase 4+. See
 * EDITOR_REFACTOR_PLAN.md.
 */
export * from "./state/editorStore";
export * from "./registry/modules";
export * from "./registry/inspector";
export * from "./registry/commands";
export { seedBuiltinRegistries } from "./registry/builtins";
export * from "./performance/previewQuality";
export * from "./performance/visibleRange";
export * from "./performance/renderCache";
export * from "./performance/workerPool";
