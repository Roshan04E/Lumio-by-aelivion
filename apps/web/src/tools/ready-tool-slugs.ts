/**
 * The AI tool slugs that have a one-click layer-effect handler registered in
 * `layer-effect-handlers.ts`. Kept as a tiny standalone constant — importing the handler module
 * just to read which slugs are "ready" would pull its whole ML graph (transcription /
 * segmentation / tracking) into the editor's initial chunk. The Effects catalog gates AI tools on
 * this list; the actual handler loads lazily only when a tool is run.
 *
 * Keep in sync with `layerToolEffectHandlers` in `layer-effect-handlers.ts`.
 */
export const READY_TOOL_SLUGS: readonly string[] = [
  "auto-captions",
  "extract-person",
  "smart-3d-follow-text",
  "remove-background",
  "text-behind-person",
  "ai-roto"
];

/**
 * Tool slugs hidden from BOTH the /tools page and the editor Effects-tab AI tools. Use this to pull a
 * tool out of the product surface without deleting its code (its handler/panel stay in the tree).
 * Remove Person is disabled pending a real inpainting engine (its result is still mock/placeholder).
 */
export const DISABLED_TOOL_SLUGS: readonly string[] = ["remove-person"];
