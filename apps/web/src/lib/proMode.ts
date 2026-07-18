import { useSyncExternalStore } from "react";

/**
 * Pro-mode entitlement flag — the gate for features that cost real COGS (AI planning, generation,
 * cloud) while the editor itself stays free forever. Today it's a client-side toggle (Navbar) so we
 * can build and A/B free vs. Pro flows without wiring billing yet; later this reads a real
 * subscription. Persisted per-browser and broadcast so every component (Navbar toggle, /create AI
 * gate, …) stays in sync.
 */

const PRO_KEY = "orreris.pro.enabled.v1";
const PRO_EVENT = "orreris:pro-changed";

export function isProEnabled(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(PRO_KEY) === "1";
  } catch {
    return false;
  }
}

export function setProEnabled(on: boolean): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(PRO_KEY, on ? "1" : "0");
    }
  } catch {
    // best-effort — fall back to the event so in-memory listeners still update
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(PRO_EVENT));
  }
}

function subscribe(callback: () => void): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }
  window.addEventListener(PRO_EVENT, callback);
  window.addEventListener("storage", callback); // keep tabs in sync
  return () => {
    window.removeEventListener(PRO_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

/** `[enabled, setEnabled]` — reactive Pro flag for any component. */
export function usePro(): [boolean, (on: boolean) => void] {
  const enabled = useSyncExternalStore(subscribe, isProEnabled, () => false);
  return [enabled, setProEnabled];
}
