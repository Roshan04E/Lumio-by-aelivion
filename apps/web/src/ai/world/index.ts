/**
 * Kimera OS — World Model entry point (K1). Registers the built-in observers, owns the
 * WorldContext assembly (live editor assets via a host-registered provider, falling back to
 * the local-first asset records), and exposes the debug handle (`window.__kimeraWorld`)
 * the verification flow uses.
 */

import type { SourceAsset, TimelineComposition } from "@kimera-by-aelivion/shared";
import { listLocalAssetRecords } from "../../lib/api";
import { clearFactStore, listFacts } from "./fact-store";
import { registerObserver, listObservers } from "./observers";
import { metadataObserver } from "./observers/metadata";
import { lookObserver } from "./observers/look";
import { textSummaryObserver } from "./observers/text-summary";
import { perceptionQueueDepth } from "./scheduler";
import type { WorldContext } from "./types";

registerObserver(metadataObserver);
registerObserver(lookObserver);
registerObserver(textSummaryObserver);

// Host-registered live asset list (EditorPage state — includes server/stock assets the
// local-first records don't). Absent → local records alone still serve local imports.
let assetProvider: (() => SourceAsset[]) | null = null;

export function setWorldAssetProvider(provider: (() => SourceAsset[]) | null): void {
  assetProvider = provider;
}

export function buildWorldContext(composition?: TimelineComposition): WorldContext {
  const live = assetProvider?.() ?? [];
  const local = safeLocalAssets();
  // Live wins on id collision (it carries fresher proxy/cloud URLs).
  const byId = new Map<string, SourceAsset>();
  for (const asset of local) {
    byId.set(asset.id, asset);
  }
  for (const asset of live) {
    byId.set(asset.id, asset);
  }
  return { composition, assets: Array.from(byId.values()) };
}

function safeLocalAssets(): SourceAsset[] {
  try {
    return listLocalAssetRecords();
  } catch {
    return []; // node/eval or storage-less environments
  }
}

// Debug handle, matching the repo's window telemetry convention (__rfBgGate etc.).
if (typeof window !== "undefined") {
  Object.defineProperty(window, "__kimeraWorld", {
    configurable: true,
    get: () => ({
      facts: listFacts(),
      observers: listObservers().map((observer) => ({
        id: observer.id,
        fidelity: observer.fidelity,
        estCostMs: observer.estCostMs,
        factTypes: observer.factTypes
      })),
      queueDepth: perceptionQueueDepth(),
      clear: clearFactStore
    })
  });
}
