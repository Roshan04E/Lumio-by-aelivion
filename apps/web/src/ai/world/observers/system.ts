/**
 * Orreris OS observer — System State (K2, L0, free). Wraps the browser capability detection
 * the tool adapters already use (tools/capabilities.ts) plus basic hardware hints behind the
 * World Model's typed query interface — so a future planner can ask "can this machine run a
 * WebGPU observer?" the same way it asks about a clip's histogram. Target: `system:browser`.
 */

import { detectBrowserToolCapabilities, type BrowserToolCapabilities } from "../../../tools/capabilities";
import type { WorldContext, WorldObserver, WorldTarget } from "../types";
import { fnv1a } from "../types";

export const SYSTEM_CAPABILITIES_FACT = "system.capabilities";
export const SYSTEM_TARGET_ID = "browser";

export interface SystemCapabilitiesFact extends BrowserToolCapabilities {
  hardwareConcurrency: number;
  /** navigator.deviceMemory (GB) where exposed — Chrome-only, coarse. */
  deviceMemoryGb?: number | undefined;
}

function detect(): SystemCapabilitiesFact | null {
  if (typeof navigator === "undefined") {
    return null;
  }
  try {
    const nav = navigator as Navigator & { deviceMemory?: number };
    return {
      ...detectBrowserToolCapabilities(),
      hardwareConcurrency: nav.hardwareConcurrency ?? 1,
      deviceMemoryGb: nav.deviceMemory
    };
  } catch {
    return null;
  }
}

function applies(target: WorldTarget): boolean {
  return target.kind === "system" && target.id === SYSTEM_TARGET_ID;
}

export const systemObserver: WorldObserver = {
  id: "system-capabilities@builtin",
  version: 1,
  factTypes: [SYSTEM_CAPABILITIES_FACT],
  fidelity: 0,
  estCostMs: 1,
  estConfidence: 0.99,
  signature(target, _ctx: WorldContext) {
    if (!applies(target)) {
      return null;
    }
    const value = detect();
    // Detection IS the signature: a browser update / flag flip changes it → fact invalidates.
    return value ? fnv1a(JSON.stringify(value)) : null;
  },
  async observe(target) {
    if (!applies(target)) {
      return [];
    }
    const value = detect();
    return value ? [{ type: SYSTEM_CAPABILITIES_FACT, value, confidence: 0.99 }] : [];
  }
};
