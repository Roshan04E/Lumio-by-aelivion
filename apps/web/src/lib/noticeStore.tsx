import { useSyncExternalStore } from "react";

/**
 * Module store for the editor's transient action toast ("Effect added", "Clips linked", ...).
 *
 * This used to be EditorPage useState: every one of the ~106 setNotice call sites re-rendered the
 * entire 10k-line editor tree just to swap a toast string. Now only the <NoticeToast/> leaf
 * subscribes; EditorPage renders are untouched. `setNotice` keeps its old name and signature so
 * call sites didn't change — it's just imported instead of destructured from useState.
 *
 * "Saved"/"Unsaved" are save-state markers surfaced by the status badge, not toast content —
 * NoticeToast filters them out (same filter the inline JSX had).
 */
type NoticeSnapshot = { message: string; seq: number };

let snapshot: NoticeSnapshot = { message: "Saved", seq: 0 };
const listeners = new Set<() => void>();

export function setNotice(message: string): void {
  // seq bumps even for identical text so a repeated action restarts the toast's fade animation
  // (the old `key={notice}` couldn't).
  snapshot = { message, seq: snapshot.seq + 1 };
  for (const listener of listeners) {
    listener();
  }
}

/** Non-reactive read for render-time fallbacks (e.g. getRenderNotice) — do not subscribe with this. */
export function getNotice(): string {
  return snapshot.message;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): NoticeSnapshot {
  return snapshot;
}

/** The only component that re-renders when a toast fires. Dismissal is the CSS fade animation. */
export function NoticeToast() {
  const { message, seq } = useSyncExternalStore(subscribe, getSnapshot);
  if (!message || message === "Saved" || message === "Unsaved") {
    return null;
  }
  return (
    <div className="editor-toast" key={seq} role="status">
      {message}
    </div>
  );
}
