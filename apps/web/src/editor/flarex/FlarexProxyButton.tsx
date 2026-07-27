/**
 * "Prepare proxy" — the Flarex comp render cache's entry point (plans/flarex-comp-proxy.md, S1).
 *
 * Renders the active comp over its host clip's span and stores the result. NOTHING about playback
 * changes yet: S1 exists so the render + store + invalidation key can be proven correct on their own,
 * and so a half-built cache can never be reached by the compositor. "Save…" writes the rendered file
 * out so it can be played by hand — that is the S1 verification.
 *
 * Status is derived from the store, keyed on the CURRENT identity, so any graph or clip edit flips a
 * ready proxy back to "not built" the moment it lands — there is no separate invalidation path to keep
 * in sync.
 */

import { useEffect, useRef, useState } from "react";
import type { FlarexComp, SourceAsset, TimelineComposition, TimelineLayer } from "@orreris/shared";
import { saveExportedFile } from "../../export/local-export";
import {
  flarexCompProxyIdentity,
  flarexCompProxyKey,
  renderFlarexCompProxy,
  ProxyGenerationAborted,
} from "./flarex-comp-proxy";
import { getFlarexCompProxy, hasFlarexCompProxy, removeFlarexCompProxy } from "./flarex-comp-proxy-store";

type ProxyState =
  | { status: "unbuilt" }
  | { status: "rendering"; fraction: number }
  | { status: "ready" }
  | { status: "error"; message: string };

export function FlarexProxyButton({
  composition,
  comp,
  layer,
  assets,
}: {
  /** The composition the host clip lives on. Undefined ⇒ nothing to render against. */
  composition: TimelineComposition | undefined;
  comp: FlarexComp;
  layer: TimelineLayer;
  assets: readonly SourceAsset[];
}) {
  const [state, setState] = useState<ProxyState>({ status: "unbuilt" });
  const abortRef = useRef<AbortController | null>(null);

  // The clip as it exists on the composition — the inspector's copy can lag an edit, and the key must
  // describe what would actually be rendered.
  const hostLayer = composition?.tracks.flatMap((track) => track.layers).find((item) => item.id === layer.id);
  const fps = Math.max(1, composition?.fps || 30);
  const key =
    composition && hostLayer ? flarexCompProxyKey(flarexCompProxyIdentity(composition, comp, hostLayer, fps)) : null;

  // Re-derive readiness whenever the key changes: a node edit bumps comp.version, a clip edit changes
  // the host signature, and either one means the stored proxy no longer describes this comp.
  useEffect(() => {
    if (!key) return undefined;
    let cancelled = false;
    void hasFlarexCompProxy(comp.id, key).then((ready) => {
      if (cancelled) return;
      // Never stomp a render in flight — it is about to write the record this check just missed.
      setState((current) => (current.status === "rendering" ? current : ready ? { status: "ready" } : { status: "unbuilt" }));
    });
    return () => {
      cancelled = true;
    };
  }, [comp.id, key]);

  // Abandon an in-flight render when the workspace unmounts (page switch / clip change).
  useEffect(() => () => abortRef.current?.abort(), []);

  if (!composition || !hostLayer || !key) return null;

  const prepare = async () => {
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ status: "rendering", fraction: 0 });
    try {
      await renderFlarexCompProxy({
        composition,
        comp,
        layer: hostLayer,
        assets,
        signal: controller.signal,
        onProgress: (fraction) => setState({ status: "rendering", fraction }),
      });
      setState({ status: "ready" });
    } catch (error) {
      if (error instanceof ProxyGenerationAborted) {
        setState({ status: "unbuilt" });
        return;
      }
      // Fail open: a failed render just means there is no proxy. Surface why, don't block anything.
      setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      abortRef.current = null;
    }
  };

  const save = async () => {
    const stored = await getFlarexCompProxy(comp.id, key);
    if (!stored) {
      setState({ status: "unbuilt" });
      return;
    }
    await saveExportedFile(stored.blob, `${comp.name || comp.id}-proxy.webm`);
  };

  const clear = async () => {
    await removeFlarexCompProxy(comp.id);
    setState({ status: "unbuilt" });
  };

  return (
    <div className="flarex-toolbar-group flarex-proxy-group">
      <span className="flarex-toolbar-group-label">Proxy</span>
      {state.status === "rendering" ? (
        <button
          type="button"
          className="flarex-toolbar-btn flarex-proxy-btn is-busy"
          title="Cancel the proxy render"
          onClick={() => abortRef.current?.abort()}
        >
          {`Rendering ${Math.round(state.fraction * 100)}%`}
        </button>
      ) : (
        <button
          type="button"
          className={`flarex-toolbar-btn flarex-proxy-btn${state.status === "ready" ? " is-ready" : ""}`}
          title={
            state.status === "ready"
              ? "This comp is cached for its clip's span. Re-render to rebuild it."
              : "Render this comp over its clip's span and cache the result (playback still evaluates the graph live — that swap is the next slice)."
          }
          onClick={() => void prepare()}
        >
          {state.status === "ready" ? "Proxy ready" : "Prepare proxy"}
        </button>
      )}
      {state.status === "ready" ? (
        <>
          <button type="button" className="flarex-toolbar-btn flarex-proxy-btn" title="Save the rendered proxy to disk to check it" onClick={() => void save()}>
            Save…
          </button>
          <button type="button" className="flarex-toolbar-btn flarex-proxy-btn" title="Delete the cached proxy" onClick={() => void clear()}>
            Clear
          </button>
        </>
      ) : null}
      {state.status === "error" ? (
        <span className="flarex-proxy-error" title={state.message}>
          Proxy render failed
        </span>
      ) : null}
    </div>
  );
}

export default FlarexProxyButton;
