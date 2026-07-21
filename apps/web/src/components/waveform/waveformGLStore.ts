/**
 * Shared registry between per-clip `Waveform` components (GL mode) and the single
 * `WaveformGLLayer` overlay. Each audio clip registers its host element + waveform data here
 * instead of drawing its own <canvas>; the overlay reads the live DOM rects (pixel-accurate, no
 * duplicated timeline layout math) and draws every clip on the GPU. Flag-gated (Phase 2B).
 */

export type WaveformGLEntry = {
  element: HTMLElement;
  url: string;
  /** Stable persistence key (asset id) for the IndexedDB peak cache — blob: URLs change per session. */
  peaksKey?: string | undefined;
  sourceInSeconds: number;
  durationSeconds: number;
  tint: [number, number, number];
};

const entries = new Map<string, WaveformGLEntry>();
const listeners = new Set<() => void>();

export function registerWaveformClip(layerId: string, entry: WaveformGLEntry): void {
  entries.set(layerId, entry);
  for (const listener of listeners) listener();
}

export function unregisterWaveformClip(layerId: string): void {
  if (entries.delete(layerId)) {
    for (const listener of listeners) listener();
  }
}

export function getWaveformEntries(): IterableIterator<WaveformGLEntry> {
  return entries.values();
}

export function subscribeWaveformClips(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
