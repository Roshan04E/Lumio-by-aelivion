import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * Identity-stable wrapper around a handler that changes every render (the "useEvent" pattern):
 * the returned function NEVER changes identity, but always dispatches to the latest closure.
 *
 * This is what lets a `React.memo`'d subtree (AssetBin) skip re-renders caused by unrelated
 * parent state WITHOUT freezing stale state into its callbacks — the classic failure mode of
 * memoizing a panel whose handlers close over `layers`/selection/etc.
 *
 * Event/callback use ONLY — never call the returned function during render (the ref is committed
 * in a layout effect, so mid-render it can still point at the previous closure).
 */
export function useStableHandler<Args extends unknown[], Result>(handler: (...args: Args) => Result): (...args: Args) => Result {
  const latest = useRef(handler);
  useLayoutEffect(() => {
    latest.current = handler;
  });
  return useCallback((...args: Args) => latest.current(...args), []);
}

/**
 * Grouped form of useStableHandler for components that take dozens of callback props
 * (TimelineStrip receives ~50): one hook call returns an object whose every function has a
 * frozen identity but dispatches to the latest closure. Spread the result onto the memo'd child.
 *
 * Constraints (same as useStableHandler, plus one):
 * - the object literal must have the SAME keys on every render (wrappers are built once);
 * - event/callback use only — never call a returned function during render.
 */
export function useStableHandlers<T extends Record<string, (...args: never[]) => unknown>>(handlers: T): T {
  const latest = useRef(handlers);
  useLayoutEffect(() => {
    latest.current = handlers;
  });
  const stableRef = useRef<T | null>(null);
  if (stableRef.current === null) {
    const stable: Record<string, (...args: unknown[]) => unknown> = {};
    for (const key of Object.keys(handlers)) {
      stable[key] = (...args: unknown[]) => (latest.current[key] as (...args: unknown[]) => unknown)(...args);
    }
    stableRef.current = stable as unknown as T;
  }
  return stableRef.current;
}
