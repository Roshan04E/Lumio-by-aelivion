/**
 * Saved graphic presets — Premiere EGP-style "save this graphic" for vector graphic layers.
 *
 * A preset stores the layer's {@link LayerGraphic} (SVG + fill + palette recolors baked into the
 * stored slots, so the preset re-adds looking exactly as saved) and a display name. Re-adding goes
 * through the same `onAddGraphic` path as a Graphics-chip pick, so a preset instance is a fully
 * editable vector layer — never a rasterized copy.
 *
 * Persistence: localStorage `kimera.graphicPresets` (device-local, mirrors effect-presets.ts).
 * Corrupt/legacy payloads are dropped silently — presets are convenience data.
 */

import type { LayerGraphic } from "@kimera-by-aelivion/shared";

export interface GraphicPreset {
  id: string;
  name: string;
  createdAt: string;
  graphic: LayerGraphic;
}

const STORAGE_KEY = "kimera.graphicPresets";

function readAll(): GraphicPreset[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is GraphicPreset =>
        !!p &&
        typeof (p as GraphicPreset).id === "string" &&
        typeof (p as GraphicPreset).name === "string" &&
        typeof (p as GraphicPreset).graphic?.svg === "string" &&
        typeof (p as GraphicPreset).graphic?.fill === "string"
    );
  } catch {
    return [];
  }
}

const listeners = new Set<() => void>();
let cache: GraphicPreset[] | null = null;

function writeAll(presets: GraphicPreset[]): void {
  cache = presets;
  try {
    window.localStorage?.setItem(STORAGE_KEY, JSON.stringify(presets));
  } catch {
    /* quota/private mode — keep the in-memory cache working for this session */
  }
  for (const listener of listeners) listener();
}

export function listGraphicPresets(): GraphicPreset[] {
  cache ??= readAll();
  return cache;
}

/** Save a graphic layer's vector under `name`. Returns the preset. */
export function saveGraphicPreset(name: string, graphic: LayerGraphic): GraphicPreset {
  const preset: GraphicPreset = {
    id: `gpreset_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    name: name.trim() || "Untitled graphic",
    createdAt: new Date().toISOString(),
    graphic: { ...graphic, palette: graphic.palette?.map((slot) => ({ ...slot })) }
  };
  writeAll([preset, ...listGraphicPresets()]);
  return preset;
}

export function deleteGraphicPreset(id: string): void {
  writeAll(listGraphicPresets().filter((p) => p.id !== id));
}

/** Subscribe to preset list changes (for React `useSyncExternalStore`). */
export function subscribeGraphicPresets(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
