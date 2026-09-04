/**
 * "Optimizing media" — the window the transport shows instead of playing un-optimized media.
 *
 * FOUNDER RULE (2026-09-04): never start playback until the media is optimized; if the user presses
 * play, show them the tasks and their REAL progress. This is that window.
 *
 * Everything measured in this chapter says why it exists: on a cold 4K timeline the preview is frozen
 * 100% of the time (canvas unchanged across 23 samples spanning 18.1s of advancing clock), while the
 * HUD reported 56-67fps over a picture that had not moved. Playing before the proxies exist does not
 * degrade — it collapses, and it collapses silently.
 *
 * WHAT IT WAITS FOR, AND WHAT IT REFUSES TO WAIT FOR. Only `queued`/`building` tasks are blocking:
 * those finish. `failed` and `skipped` are TERMINAL — a `skipped: "no local bytes"` asset can never be
 * proxied this session (DEBT-034) — so waiting on them would replace a freeze with a permanent block on
 * a clip the user cannot diagnose, which is the same trap one layer up. They are listed with their
 * reason and a plain statement that playback will use the original.
 *
 * PROGRESS IS REAL, NOT DECORATIVE. The percentage comes from the encoder's own frame counter
 * (`getSourceProxyTasks`, fed by `reportProgress`), and a task with no live percentage says "waiting"
 * rather than animating a bar that means nothing.
 */

import { useEffect, useMemo, useState } from "react";
import type { SourceAsset } from "@orreris/shared";
import {
  getSourceProxyTasks,
  subscribeSourceProxyState,
  type SourceProxyTask
} from "../editor/performance/sourceProxyEngine";

interface Props {
  /** Assets the composition actually uses — the only ones worth waiting for. */
  assetIds: readonly string[];
  assets: readonly SourceAsset[];
  /** Called when every blocking task has finished, so the caller can start playback itself. */
  onReady: () => void;
  /** Dismiss without playing. */
  onCancel: () => void;
  /** Play now, accepting the un-optimized picture. */
  onPlayAnyway: () => void;
}

function labelFor(assets: readonly SourceAsset[], assetId: string): string {
  const asset = assets.find((a) => a.id === assetId);
  return asset?.fileName ?? asset?.originalName ?? assetId;
}

export function ProxyOptimizationDialog({ assetIds, assets, onReady, onCancel, onPlayAnyway }: Props) {
  const [tasks, setTasks] = useState<SourceProxyTask[]>(() => getSourceProxyTasks(assetIds));

  useEffect(() => {
    const sync = () => setTasks(getSourceProxyTasks(assetIds));
    sync();
    // The engine notifies on every state change AND on each progress report (~1Hz per build), so the
    // percentages here move on their own without this component polling.
    return subscribeSourceProxyState(sync);
  }, [assetIds]);

  const blocking = useMemo(() => tasks.filter((t) => t.state === "queued" || t.state === "building"), [tasks]);
  const terminal = useMemo(() => tasks.filter((t) => t.state === "failed" || t.state === "skipped"), [tasks]);
  const done = useMemo(() => tasks.filter((t) => t.state === "built" || t.state === "none"), [tasks]);

  useEffect(() => {
    if (blocking.length === 0) onReady();
    // `onReady` is invoked once the wait is genuinely over; the caller closes this window and plays.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocking.length]);

  const total = tasks.length;
  const finished = done.length;

  return (
    <div className="proxy-optimize-backdrop" role="dialog" aria-modal="true" aria-label="Optimizing media">
      <div className="proxy-optimize-dialog">
        <header className="proxy-optimize-head">
          <h2>Optimizing media</h2>
          <p>
            Playback waits until these are ready. Playing the originals first is what freezes the preview, so this
            finishes fastest if you leave it alone.
          </p>
        </header>

        <div className="proxy-optimize-progress-summary">
          {finished} of {total} ready{blocking.length ? ` · ${blocking.length} in progress` : ""}
        </div>

        <ul className="proxy-optimize-list">
          {blocking.map((task) => (
            <li key={task.assetId} className="proxy-optimize-row is-active">
              <span className="proxy-optimize-name">{labelFor(assets, task.assetId)}</span>
              <span className="proxy-optimize-bar" aria-hidden="true">
                {/* No percentage yet = queued behind another build. A bar that animated anyway would be
                    inventing progress, which is the defect this whole chapter keeps finding. */}
                <span className="proxy-optimize-bar-fill" style={{ width: `${task.percent ?? 0}%` }} />
              </span>
              <span className="proxy-optimize-pct">{task.state === "building" && task.percent != null ? `${task.percent}%` : "waiting"}</span>
            </li>
          ))}
          {terminal.map((task) => (
            <li key={task.assetId} className="proxy-optimize-row is-terminal">
              <span className="proxy-optimize-name">{labelFor(assets, task.assetId)}</span>
              <span className="proxy-optimize-terminal">
                {/* Named, not hidden: waiting on these forever is the trap this window must not become. */}
                can’t be optimized{task.note ? ` — ${task.note}` : ""} · plays its original
              </span>
            </li>
          ))}
        </ul>

        <footer className="proxy-optimize-actions">
          <button type="button" className="proxy-optimize-secondary" onClick={onCancel}>
            Keep editing
          </button>
          <button type="button" className="proxy-optimize-secondary" onClick={onPlayAnyway}>
            Play anyway
          </button>
        </footer>
        <p className="proxy-optimize-footnote">
          “Play anyway” uses the full-resolution originals — at 4K that can freeze the preview until optimization
          finishes. Editing, cutting and arranging always work, optimized or not.
        </p>
      </div>
    </div>
  );
}
