import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { registerSW } from "virtual:pwa-register";
import { configureFontResolver, kernelDiagnostics, warpFontFile } from "@orreris/shared";
import App from "./App";
import { AuthProvider } from "./lib/auth";
import { initAnalyticsPersistence } from "./ai/analytics-store";
import { installPerfDiagnostics } from "./lib/perfDiagnostics";
import { installCrashTelemetry } from "./lib/crash-telemetry";
import { resolveKernelDiagnosticsEnabled } from "./playback/frame-completion";
import { migrateBrandLocalStorage, migrateBrandBlobStores } from "./lib/brand-migration";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
import "./styles/global.css";
import "./styles/marketing.css";

// Durable chunk cache: the service worker runtime-caches hashed JS/wasm/fonts (CacheFirst) so a
// chunk downloads once and persists until the user clears site data. `persist()` marks Cache
// Storage / OPFS / the HF transformers model cache non-evictable. No-op in dev (SW disabled there).
// Brand rename (Kimera → Orreris Pro): carry persisted state forward from the old `kimera*` keys.
// localStorage runs first — synchronously, before AuthProvider reads the auth token below; the
// blob-store copy (imported media) is best-effort and non-blocking.
migrateBrandLocalStorage();
void migrateBrandBlobStores();

registerSW({ immediate: true });
if (typeof navigator !== "undefined" && navigator.storage?.persist) {
  void navigator.storage.persist();
}

// Text-warp outline engine: resolve warp font families to the served binaries in
// /public/fonts. The catalog (warpFontFile) is the seam for the future font library.
configureFontResolver((family, weight) => `/${warpFontFile(family, weight)}`);

// Orreris AI — hydrate + persist the action/AI analytics counters (P7) across reloads.
initAnalyticsPersistence();

// Main-thread responsiveness telemetry (__rfLongTasks / __rfClickLatency / __rfLoopLag on window;
// verbose logs behind localStorage orreris.perfLog="1") — laggy-UI reports get data, not theories.
installPerfDiagnostics();

// Crash forensics: onerror/unhandledrejection → localStorage ring buffer (survives a hard crash);
// the next boot surfaces the previous session's tail. Read via window.__rfCrashLog.
installCrashTelemetry();

// The kernel diagnostics flag, resolved by the HOST (ADR-012 I-36, slice S3.1). The kernel used to read
// `window` for this itself, which made it behave differently under React than under the worker or the
// harness — the one thing I-36 forbids, and a breach of the standing rule that `packages/shared` never
// reads `window`. Now the app looks and the kernel is told, exactly like `precision` and
// `regionPassModel`. Before `createRoot`, so the very first frame is already recorded correctly.
kernelDiagnostics.enabled = resolveKernelDiagnosticsEnabled();
// S5.3, same reason: the compositor ages caches on wall-clock, but it runs in the export Worker too,
// where there is no `window` to ask. The host looks; the module is told.

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>
);
