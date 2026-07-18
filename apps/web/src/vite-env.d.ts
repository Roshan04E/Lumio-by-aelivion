/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

/**
 * Build-time hash of the render-critical sources (vite.config.ts `define`) — the automatic
 * render-cache invalidation root (PREVIEW_PIPELINE.md P1). Undefined outside vite (tsx test
 * scripts); consumers must guard with `typeof`.
 */
declare const __ORRERIS_RENDER_FINGERPRINT__: string | undefined;
