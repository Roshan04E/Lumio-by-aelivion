/**
 * State Registry (ADR-012 3.2, slice S3.1) — the kernel's observable store.
 *
 * ## The problem it exists to end
 *
 * Runtime state currently lives in React refs, hooks and memos: which sources exist, which decoders are
 * alive, how big the caches are, whether the context is lost. That is regression **G1**, and it is the
 * single largest contributor to the ownership tangle the audits found — a `useMemo` recompute becomes a
 * decoder teardown, a component unmount becomes a resource release, and no non-React caller (export,
 * worker, a headless harness, a future native host) can reach any of it.
 *
 * This is the container that state moves INTO. S3.1 builds it and moves nothing; S3.2 onward move
 * ownership one subsystem at a time, which is the only way to do it without a flag day.
 *
 * ## Why notification is coalesced
 *
 * A registry that notified synchronously on every `set` would re-introduce exactly the coupling it is
 * meant to remove: a subscriber that renders would render once per write, and a frame writes many keys.
 * So writes are collected and subscribers are notified ONCE per microtask, per key. This is the same
 * discipline `playback/playback-clock.ts` arrived at independently — imperative writes, coalesced
 * notification — and that pattern is proven in this codebase under real playback load, which is why it
 * is copied rather than redesigned.
 *
 * The consequence a caller must know: **a subscriber sees the latest value, not every value.** Two
 * writes in one turn produce one notification. That is correct for state (you want what IS) and wrong
 * for events (you want what HAPPENED) — events belong in the diagnostics sink, which is a ring and
 * keeps every one.
 *
 * ## Why values are compared before notifying
 *
 * A frame re-writes most of its state with the same value it already had. Notifying on those would make
 * "subscribe" mean "wake me every frame", which is what a rAF loop is for. Equality is reference
 * equality by design: the registry does not know what its values mean, and a deep compare would make
 * write cost a function of value size on the hot path (programme risk R1).
 */

export type StateListener<T> = (value: T) => void;

interface Entry {
  value: unknown;
  /** Bumped on every CHANGE, not every write. Lets a poller detect staleness without subscribing. */
  version: number;
  listeners: Set<StateListener<never>>;
}

/**
 * Schedules the coalesced flush. A microtask rather than a timer: state must be visible to whoever asks
 * within the same turn's tail, and a timer would push subscriber updates a frame behind the writes that
 * caused them — the exact one-frame lag that makes UI state look intermittently wrong.
 */
const schedule: (fn: () => void) => void =
  typeof queueMicrotask === "function" ? queueMicrotask : (fn) => void Promise.resolve().then(fn);

export class StateRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly dirty = new Set<string>();
  private flushing = false;
  private scheduled = false;
  private disposed = false;

  /** Current value, or `fallback` when nothing has been written. */
  get<T>(key: string, fallback: T): T {
    const entry = this.entries.get(key);
    return entry === undefined ? fallback : (entry.value as T);
  }

  /** How many times this key has CHANGED. 0 = never written. */
  versionOf(key: string): number {
    return this.entries.get(key)?.version ?? 0;
  }

  /**
   * Write a value. Notifies subscribers once per microtask if it actually changed.
   *
   * Returns whether it changed, so a caller that also wants to log or account for the change does not
   * have to re-read and compare — which would be a second, divergent definition of "changed".
   */
  set<T>(key: string, value: T): boolean {
    if (this.disposed) return false;
    const entry = this.entries.get(key);
    if (entry === undefined) {
      this.entries.set(key, { value, version: 1, listeners: new Set() });
      this.markDirty(key);
      return true;
    }
    if (Object.is(entry.value, value)) return false;
    entry.value = value;
    entry.version += 1;
    this.markDirty(key);
    return true;
  }

  /**
   * Subscribe to a key. Returns the unsubscribe.
   *
   * The listener is NOT called on subscribe: the caller already has `get()` and calling it here would
   * make every subscription a write-shaped event, which is how a store starts driving renders it was
   * only meant to inform.
   */
  subscribe<T>(key: string, listener: StateListener<T>): () => void {
    let entry = this.entries.get(key);
    if (entry === undefined) {
      entry = { value: undefined, version: 0, listeners: new Set() };
      this.entries.set(key, entry);
    }
    const set = entry.listeners as Set<StateListener<T>>;
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  /** Keys that have ever been written. Query path — allocates. */
  keys(): string[] {
    const out: string[] = [];
    for (const [key, entry] of this.entries) if (entry.version > 0) out.push(key);
    return out.sort();
  }

  /**
   * Flush pending notifications now instead of on the microtask.
   *
   * Exists for the headless harness and for tests, where "the next microtask" is not a thing a
   * synchronous assertion can wait for. Product code should never need it; if it does, that is a sign
   * something is reading state it should have subscribed to.
   */
  flush(): void {
    this.scheduled = false;
    if (this.flushing || this.dirty.size === 0) return;
    this.flushing = true;
    try {
      // Drained into an array first: a listener may write, which would otherwise grow the set being
      // iterated and turn a cascade into an unbounded loop. Writes made during a flush land in the
      // NEXT flush, which is what keeps one turn's notification finite.
      const keys = [...this.dirty];
      this.dirty.clear();
      for (const key of keys) {
        const entry = this.entries.get(key);
        if (entry === undefined || entry.listeners.size === 0) continue;
        for (const listener of [...entry.listeners]) {
          try {
            (listener as StateListener<unknown>)(entry.value);
          } catch {
            // A subscriber that throws must not stop the others from being told, and must not take down
            // the writer — which is usually the draw loop.
          }
        }
      }
    } finally {
      this.flushing = false;
      if (this.dirty.size > 0) this.markDirty();
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.entries.values()) entry.listeners.clear();
    this.entries.clear();
    this.dirty.clear();
  }

  private markDirty(key?: string): void {
    if (key !== undefined) this.dirty.add(key);
    if (this.scheduled) return;
    this.scheduled = true;
    schedule(() => this.flush());
  }
}
