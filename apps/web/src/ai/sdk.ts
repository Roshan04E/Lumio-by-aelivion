/**
 * Orreris Intelligence SDK — v1 (K5, ORRERIS_OS.md → "observers/recipes/capabilities are
 * plugins from day one"). THE import path for extending the intelligence runtime; the full
 * contract, laws, and reference implementations live in ORRERIS_SDK.md.
 *
 * Frozen v1 extension points:
 *   - World observers  → `registerObserver` (measure or infer facts; L0–L4)
 *   - Mood recipes     → `registerMoodRecipe` (vibe words as data rows)
 *   - Blueprint dialects → `registerBlueprintDialect` (capability-closed goal domains)
 *   - Creative looks   → `registerCreativeLook` (grade presets as data)
 *   - Reading facts    → `queryFact` (budgeted, decline-is-an-answer)
 *
 * NOT public in v1 (import at your own risk; they will move): tier-0 reflex handlers,
 * the fact store internals, the panel/executor seams, timeline action definitions.
 *
 * Versioning: breaking a signature or a law below bumps SDK_VERSION and gets a migration
 * note in ORRERIS_SDK.md. Additive changes (new optional fields, new extension points)
 * do not bump.
 */

export const SDK_VERSION = 1;

// World Model — observers + reading facts.
export { registerObserver, listObservers, observerContractIssue } from "./world/observers";
export { queryFact, type FactAcquisition } from "./world/knowledge";
export type { WorldObserver, ObservedFact, WorldTarget, WorldContext, FactQuery, ObserverFidelity } from "./world/types";
export { fnv1a } from "./world/types";

// Hypothesis planner — moods as data.
export { registerMoodRecipe, listMoodRecipes, type MoodRecipe } from "@orreris/shared";

// Blueprint IR — dialects (capability closure).
export { registerBlueprintDialect, listBlueprintDialects, type BlueprintDialect, type BlueprintGoal, type CloseResult } from "@orreris/shared";

// Color system — looks as data (the pixel-side registry the color dialect closes against).
export { registerCreativeLook, listCreativeLooks, type CreativeLook } from "@orreris/shared";
