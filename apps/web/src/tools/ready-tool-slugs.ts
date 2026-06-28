/**
 * The AI tool slugs that have a one-click layer-effect handler registered in
 * `layer-effect-handlers.ts`. Kept as a tiny standalone constant — importing the handler module
 * just to read which slugs are "ready" would pull its whole ML graph (transcription /
 * segmentation / tracking) into the editor's initial chunk. The Effects catalog gates AI tools on
 * this list; the actual handler loads lazily only when a tool is run.
 *
 * Keep in sync with `layerToolEffectHandlers` in `layer-effect-handlers.ts`.
 */
export const READY_TOOL_SLUGS: readonly string[] = ["auto-captions", "extract-person", "smart-3d-follow-text"];
