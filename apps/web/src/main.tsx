import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { registerSW } from "virtual:pwa-register";
import { configureFontResolver, warpFontFile } from "@kimera-by-aelivion/shared";
import App from "./App";
import { AuthProvider } from "./lib/auth";
import { initAnalyticsPersistence } from "./ai/analytics-store";
import { installPerfDiagnostics } from "./lib/perfDiagnostics";
import { installCrashTelemetry } from "./lib/crash-telemetry";
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
registerSW({ immediate: true });
if (typeof navigator !== "undefined" && navigator.storage?.persist) {
  void navigator.storage.persist();
}

// Text-warp outline engine: resolve warp font families to the served binaries in
// /public/fonts. The catalog (warpFontFile) is the seam for the future font library.
configureFontResolver((family, weight) => `/${warpFontFile(family, weight)}`);

// Kimera AI — hydrate + persist the action/AI analytics counters (P7) across reloads.
initAnalyticsPersistence();

// Main-thread responsiveness telemetry (__rfLongTasks / __rfClickLatency / __rfLoopLag on window;
// verbose logs behind localStorage kimera.perfLog="1") — laggy-UI reports get data, not theories.
installPerfDiagnostics();

// Crash forensics: onerror/unhandledrejection → localStorage ring buffer (survives a hard crash);
// the next boot surfaces the previous session's tail. Read via window.__rfCrashLog.
installCrashTelemetry();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>
);
