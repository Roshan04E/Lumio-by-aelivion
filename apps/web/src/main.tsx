import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { registerSW } from "virtual:pwa-register";
import { configureFontResolver, warpFontFile } from "@lumio-by-aelivion/shared";
import App from "./App";
import { AuthProvider } from "./lib/auth";
import { initAnalyticsPersistence } from "./ai/analytics-store";
import "./styles/global.css";

// Durable chunk cache: the service worker runtime-caches hashed JS/wasm/fonts (CacheFirst) so a
// chunk downloads once and persists until the user clears site data. `persist()` marks Cache
// Storage / OPFS / the HF transformers model cache non-evictable. No-op in dev (SW disabled there).
registerSW({ immediate: true });
if (typeof navigator !== "undefined" && navigator.storage?.persist) {
  void navigator.storage.persist();
}

// Text-warp outline engine: resolve warp font families to the served binaries in
// /public/fonts. The catalog (warpFontFile) is the seam for the future font library.
configureFontResolver((family) => `/${warpFontFile(family)}`);

// Lumio AI — hydrate + persist the action/AI analytics counters (P7) across reloads.
initAnalyticsPersistence();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>
);
