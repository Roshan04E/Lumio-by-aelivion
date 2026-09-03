/**
 * React bindings for the source-proxy engine's per-asset state.
 *
 * WHY THIS EXISTS (DEBT-033, 2026-08-17): `getSourceProxyState` has had a `failed` member — and a
 * comment saying it exists so a frozen preview reads as "proxy not ready" rather than "the app is
 * broken" — since it was written, and until now it was consumed in exactly ONE place: the Flarex
 * Source Viewer, which is not where anyone looks when the preview freezes. The state was correct and
 * invisible. These hooks put it on the two surfaces the user is actually staring at (the timeline
 * clip and the preview), driven by the engine's change notification rather than a poll.
 */
import { useMemo, useSyncExternalStore } from "react";
import {
  getSourceProxyState,
  sourceProxyStateRevision,
  subscribeSourceProxyState,
  type SourceProxyState,
} from "./sourceProxyEngine";

/** Bumps whenever ANY asset's proxy state changes. Derive with `useMemo` on the returned revision. */
export function useSourceProxyRevision(): number {
  return useSyncExternalStore(subscribeSourceProxyState, sourceProxyStateRevision, () => 0);
}

export function useSourceProxyState(assetId: string | undefined): SourceProxyState {
  const revision = useSourceProxyRevision();
  return useMemo(() => (assetId ? getSourceProxyState(assetId) : "none"), [assetId, revision]);
}

/**
 * The worst proxy state among the given assets, ranked by how much it explains a stuck preview:
 * failed > building > queued > (built/skipped/none → "none", i.e. nothing to say).
 * `skipped` is deliberately NOT surfaced: it means the source needs no proxy, so it is not a reason
 * the preview would be struggling and a badge for it would be noise on most projects.
 */
export function useWorstSourceProxyState(assetIds: readonly string[]): SourceProxyState {
  const revision = useSourceProxyRevision();
  const key = assetIds.join(",");
  return useMemo(() => {
    let worst: SourceProxyState = "none";
    for (const id of assetIds) {
      const state = getSourceProxyState(id);
      if (state === "failed") return "failed";
      if (state === "building") worst = "building";
      else if (state === "queued" && worst !== "building") worst = "queued";
    }
    return worst;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the stable identity of `assetIds`
  }, [key, revision]);
}
