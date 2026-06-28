import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export default defineConfig({
  plugins: [
    react(),
    // Durable chunk cache without eager precaching: hashed assets are immutable, so a
    // CacheFirst runtime rule keeps each chunk after its first download (served from Cache
    // Storage until the user clears site data) while preserving lazy loading — we do NOT
    // precache *.js. Only the small shell (html/css/fonts) is precached.
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
            handler: "CacheFirst",
            options: {
              cacheName: "js-chunks",
              expiration: { maxEntries: 250, maxAgeSeconds: 60 * 60 * 24 * 60 },
              cacheableResponse: { statuses: [0, 200] }
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
