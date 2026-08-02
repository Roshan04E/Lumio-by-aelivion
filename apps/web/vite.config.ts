import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
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
  // SHADER SOURCE (added 2026-08-01). These files literally contain the GLSL that produces pixels, so
  // editing one changes output without touching any file previously on this list — which is how the
  // `fract(sin())` → integer-hash parity fix would have left pre-fix proxy spans serving speckled
  // stylize output forever. `glsl-hash.ts` is the shared prelude both registries embed: changing it
  // alone changes every effect and transition that hashes, and nothing else here would notice.
  "packages/shared/src/color/glsl-hash.ts",
  "packages/shared/src/color/fragment-effects/registry.ts",
  "packages/shared/src/color/fragment-effects/builtins.ts",
  "packages/shared/src/color/fragment-effects/stylize.ts",
  "packages/shared/src/color/transitions/registry.ts",
  "packages/shared/src/color/transitions/pipeline.ts",
  "packages/shared/src/color/transitions/pipeline-assembler.ts",
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

/**
 * BUILD-MODE ASSERTION (2026-07-28). `envDir: repoRoot` means vite reads the shared root `.env`, and
 * vite promotes a `NODE_ENV` found there into `process.env` when the shell has not set one. That
 * silently flipped `vite build` to `isProduction = false` and shipped `react-dom.development.js`:
 * DEV React commits walk the whole fiber tree (the passive-effect subtree bailout is defeated under
 * ProfileMode) which cost multi-second main-thread blocks, froze every decoder, and read downstream
 * as Flarex media "filling in one source at a time". It survived because a DEV bundle looks and runs
 * exactly like a slow production bundle — see project-tracker/playback-preview.md v32.
 *
 * Assert the PROPERTY rather than any one of its causes, so a re-added `.env` line, an exported shell
 * var, or a future env file all fail loudly at build time instead of shipping.
 */
function assertProductionBuild() {
  return {
    name: "orreris:assert-production-build",
    configResolved(config: { command: string; isProduction: boolean; mode: string }) {
      // The inconsistency IS the bug signature: an env-file leak leaves mode "production" while
      // flipping isProduction false. An intentional `vite build --mode development` moves both
      // together and is left alone.
      if (config.command === "build" && config.mode === "production" && !config.isProduction) {
        throw new Error(
          `Refusing to build: mode="${config.mode}", isProduction=false. This bundles ` +
            "react-dom.development.js into the shipped assets (~20-30% larger chunks, multi-second " +
            "React commit stalls). The cause is almost always NODE_ENV=development reaching vite: the " +
            "root .env must not contain NODE_ENV, and the shell must not export it. To build a " +
            "development bundle on purpose, run `vite build --mode development`."
        );
      }
    }
  };
}

/**
 * WHICH BODY this was (ORIS_SELF.md §6 — an upgrade is an autobiographical event).
 *
 * Deliberately NOT `renderPipelineFingerprint()`: that hashes only render-critical files, so
 * it would report identical ids across builds that differ everywhere else — a misleading
 * observation, which ADR-016 I10 forbids. Git HEAD identifies the whole tree.
 */
function buildId(): string {
  try {
    const head = execSync("git rev-parse --short HEAD", { cwd: repoRoot, encoding: "utf8" }).trim();
    const dirty = execSync("git status --porcelain", { cwd: repoRoot, encoding: "utf8" }).trim().length > 0;
    return dirty ? `${head}-dirty` : head;
  } catch {
    // No git, or not a checkout. "unknown" is the honest answer and stays distinguishable
    // from a real id — never a plausible-looking fake.
    return "unknown";
  }
}

export default defineConfig({
  define: {
    __ORRERIS_RENDER_FINGERPRINT__: JSON.stringify(renderPipelineFingerprint()),
    __ORRERIS_BUILD_ID__: JSON.stringify(buildId())
  },
  plugins: [
    assertProductionBuild(),
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
    port: 5173,
    // Enables the JS self-profiling API (`new Profiler(...)`) for the dev stall watchdog
    // (lib/perf-watchdog.ts): when the main thread freezes, it captures REAL sampled stacks and
    // prints the blocking functions to the console — evidence, not guesswork.
    headers: {
      "Document-Policy": "js-profiling"
    }
  }
});
