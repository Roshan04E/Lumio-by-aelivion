/**
 * Frame render cache (Phase 3 interface + a small LRU impl; wired in Phase 5).
 * Memoizes rendered preview frames keyed by (composition signature, time,
 * quality) so scrubbing back over unchanged regions is free. Any edit changes
 * the signature and naturally invalidates stale frames.
 */
export interface RenderCacheKey {
  /** Cheap signature of the inputs that affect this frame (layer hashes, quality). */
  signature: string;
  timeSeconds: number;
}

export interface FrameCache<T> {
  get: (key: RenderCacheKey) => T | undefined;
  set: (key: RenderCacheKey, value: T) => void;
  clear: () => void;
  readonly size: number;
}

function keyString(key: RenderCacheKey): string {
  return `${key.signature}@${key.timeSeconds.toFixed(3)}`;
}

/** Simple LRU. Generic over the frame payload (ImageBitmap, canvas, dataURL, …). */
export function createFrameCache<T>(capacity = 60): FrameCache<T> {
  const map = new Map<string, T>();
  return {
    get(key) {
      const id = keyString(key);
      const value = map.get(id);
      if (value !== undefined) {
        map.delete(id);
        map.set(id, value); // bump to most-recent
      }
      return value;
    },
    set(key, value) {
      const id = keyString(key);
      map.delete(id);
      map.set(id, value);
      while (map.size > capacity) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        map.delete(oldest);
      }
    },
    clear() {
      map.clear();
    },
    get size() {
      return map.size;
    }
  };
}
