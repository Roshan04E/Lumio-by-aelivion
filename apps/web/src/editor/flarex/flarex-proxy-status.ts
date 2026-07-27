/**
 * Which Flarex comps are currently PLAYING FROM A PROXY — a tiny external store.
 *
 * The fact is produced deep inside the preview (`useFlarexCompProxies`) and consumed on the timeline
 * (the clip's fx badge). Threading it through EditorPage would mean a new prop on the monolith plus a
 * re-render of the whole editor tree every time a proxy starts or stops serving; the timeline's
 * performance architecture is deliberately built to avoid exactly that. A store lets the one badge that
 * cares subscribe directly.
 *
 * One-way: the preview REPORTS, the timeline displays. Nothing here is ever read back as a command.
 */

let serving: readonly string[] = [];
const listeners = new Set<() => void>();

/**
 * Publish the serving set. The caller must pass an identity-stable array when nothing changed —
 * `useSyncExternalStore` re-renders on reference inequality, and a fresh array every frame would make
 * this the very re-render storm it exists to prevent. Guarded here too, so a careless caller is cheap.
 */
export function setFlarexProxyServing(next: readonly string[]): void {
  if (next === serving) return;
  if (next.length === serving.length && next.every((id, index) => id === serving[index])) return;
  serving = next;
  for (const listener of listeners) listener();
}

export function subscribeFlarexProxyServing(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getFlarexProxyServing(): readonly string[] {
  return serving;
}
