import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * AUTOMATIC render-pipeline fingerprint (PREVIEW_PIPELINE.md P1).
 *
 * Hash of every source file whose changes can alter rendered/decoded PIXELS. It feeds the preview
 * render-cache signature (`baseCompositionSignature`), so any render-affecting code change
 * invalidates cached proxy spans automatically — no hand-bumped version constant to forget
 * (2026-07-03 incident: spans generated before a decoder fix kept serving FROZEN video because the
 * manual version wasn't bumped). Evaluated when the vite config loads (build / dev-server start);
 * a file edited mid-dev-session flips it on the next restart, which is acceptable — the constant
 * fallback path still exists for non-vite consumers (tests).
 *
 * Keep this list in sync with the render-critical modules; ADDING here is cheap, missing one
 * recreates the incident class.
 */
const RENDER_FINGERPRINT_SOURCES = [
  "apps/web/src/export/webcodecs-decoder.ts",
  "apps/web/src/export/source-decoder.ts",
  "apps/web/src/export/scene-frame-compositor.ts",
  "apps/web/src/export/export-core.ts",
  "packages/shared/src/color/scene-compositor.ts",
  "packages/shared/src/color/media-renderer.ts",
  "packages/shared/src/color/gl-context.ts",
  "packages/shared/src/scene/build-scene-draws.ts",
  "packages/shared/src/scene/scene-text-raster.ts",
  "packages/shared/src/scene/scene-mask-matte.ts",
  "packages/shared/src/composition-style.ts",
  "packages/shared/src/effects.ts",
  "packages/shared/src/clip-masks.ts",
  "packages/shared/src/animation.ts",
  "packages/shared/src/timeline.ts",
  "packages/shared/src/nesting.ts"
];

function renderPipelineFingerprint(): string {
  const hash = createHash("sha1");
  for (const rel of RENDER_FINGERPRINT_SOURCES) {
    try {
      hash.update(rel).update("\0").update(readFileSync(resolve(repoRoot, rel)));
    } catch {
      // A moved/renamed file must still flip the fingerprint rather than throw the build.
      hash.update(`${rel}:missing`);
    }
  }
  return hash.digest("hex").slice(0, 16);
}

export default defineConfig({
  define: {
    __KIMERA_RENDER_FINGERPRINT__: JSON.stringify(renderPipelineFingerprint())
  },
  plugins: [
    react(),
    // Durable chunk cache without eager precaching — we do NOT precache *.js; only the small
    // shell (html/css/fonts) is precached.
    //
    // JS/wasm chunks are NetworkFirst, NOT CacheFirst (2026-07-06): the SW intercepts module-worker
    // chunk fetches too (`new Worker(new URL(...), { type: "module" })` — the span-proxy generator
    // and the new source-proxy transcoder), and CacheFirst answering those from Cache Storage was a
    // build-only staleness/hang surface no dev session ever exercises (the SW is disabled in dev).
    // NetworkFirst always serves the deployed bytes when the server is reachable and only falls
    // back to the cached copy when it isn't (offline, or a chunk deleted by a redeploy mid-session).
    VitePWA({
      registerType: "autoUpdate",
      manifest: false,
      devOptions: { enabled: false },
      workbox: {
        globPatterns: ["**/*.{css,html,woff2}"],
        runtimeCaching: [
          {
            urlPattern: ({ url, sameOrigin }) =>
              sameOrigin && /\/assets\/.*\.(?:js|wasm)$/.test(url.pathname),
            handler: "NetworkFirst",
            options: {
              cacheName: "js-chunks",
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 250, maxAgeSeconds: 60 * 60 * 24 * 60 },
              cacheableResponse: { statuses: [200] }
            }
          },
          {
            urlPattern: ({ url, sameOrigin }) =>
              sameOrigin && /\.(?:woff2?|ttf|otf)$/.test(url.pathname),
            handler: "CacheFirst",
            options: {
              cacheName: "fonts",
              expiration: { maxEntries: 60, maxAgeSeconds: 60 * 60 * 24 * 180 },
              cacheableResponse: { statuses: [0, 200] }
            }
          }
        ]
      }
    })
  ],
  // Read env from the repo root so a single `.env` serves both the web app and the API
  // (the API already loads the root `.env`). VITE_-prefixed vars there are exposed to the client.
  envDir: repoRoot,
  // The local-export worker is a module worker (`new Worker(url, { type: "module" })`). ES output is
  // required so it (and the lazily code-split editor) can share chunks — the default "iife" cannot
  // code-split.
  worker: {
    format: "es"
  },
  server: {
    port: 5173
  }
});
