/**
 * "Prepare proxy" — the Flarex comp render cache's control (plans/flarex-comp-proxy.md).
 *
 * Renders the active comp over its host clip's span and stores it; the EDIT page then plays that file
 * instead of evaluating the node graph every frame (the Flarex page always shows the live graph). A wand
 * on the clip's `fx` badge marks a clip currently being played from its proxy.
 *
 * Every state here is DERIVED from the store against the comp's current identity — there is no
 * invalidation path for anyone to keep in sync, and no way to present a proxy that no longer matches:
 *   ready    a proxy exists under exactly this key; the Edit page is using it.
 *   stale    a proxy exists under a DIFFERENT key — the comp or clip changed since it was built, so
 *            playback has already fallen back to live evaluation.
 *   unbuilt  no proxy at all.
 *
 * "Save…" writes the rendered file out, which is how the render itself gets eyeballed.
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
import { getFlarexCompProxy, peekFlarexCompProxy, removeFlarexCompProxy } from "./flarex-comp-proxy-store";

/**
 * `stale` is the state that matters. Before it existed, editing a comp after preparing a proxy silently
 * dropped playback back to live evaluation — correct (the key cannot match, so stale pixels can never be
 * shown) but mute: the button still read "Prepare proxy", identical to never having built one, so the
 * one action worth offering — re-render it — looked like a first-time build.
 */
type ProxyState =
  | { status: "unbuilt" }
  | { status: "stale"; renderedAt: number }
  | { status: "rendering"; fraction: number }
  | { status: "ready" }
  | { status: "error"; message: string };

/** "4 min ago" — enough to judge whether a stale proxy is worth rebuilding. */
function agoLabel(renderedAt: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - renderedAt) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

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
    // One read answers both questions: whether a proxy exists at all, and whether it is the CURRENT
    // one. Asking `has(key)` alone cannot distinguish "never built" from "built, then edited".
    void peekFlarexCompProxy(comp.id).then((stored) => {
      if (cancelled) return;
      // Never stomp a render in flight — it is about to write the record this check just missed.
      setState((current) => {
        if (current.status === "rendering") return current;
        if (!stored) return { status: "unbuilt" };
        return stored.key === key ? { status: "ready" } : { status: "stale", renderedAt: stored.renderedAt };
      });
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
    await saveExportedFile(stored.blob, `${comp.name || comp.id}-proxy.${stored.blob.type === "video/webm" ? "webm" : "mp4"}`);
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
          className={`flarex-toolbar-btn flarex-proxy-btn${state.status === "ready" ? " is-ready" : ""}${state.status === "stale" ? " is-stale" : ""}`}
          title={
            state.status === "ready"
              ? "The Edit page is playing this comp from its cached render. Click to rebuild it."
              : state.status === "stale"
                ? `This comp changed since its proxy was built (${agoLabel(state.renderedAt)}), so the Edit page is evaluating the graph live again. Click to re-render.`
                : "Render this comp over its clip's span so the Edit page can play it back instead of evaluating the graph every frame."
          }
          onClick={() => void prepare()}
        >
          {state.status === "ready" ? "Proxy ready" : state.status === "stale" ? "Proxy out of date" : "Prepare proxy"}
        </button>
      )}
      {state.status === "ready" ? (
        <button type="button" className="flarex-toolbar-btn flarex-proxy-btn" title="Save the rendered proxy to disk to check it" onClick={() => void save()}>
          Save…
        </button>
      ) : null}
      {/* Clear is offered for STALE too: an out-of-date proxy is dead weight on disk, and reclaiming it
          shouldn't require rendering a new one first. */}
      {state.status === "ready" || state.status === "stale" ? (
        <button type="button" className="flarex-toolbar-btn flarex-proxy-btn" title="Delete the cached proxy" onClick={() => void clear()}>
          Clear
        </button>
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
