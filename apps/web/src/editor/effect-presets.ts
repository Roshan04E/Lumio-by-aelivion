/**
 * Saved effect presets ("looks") — Premiere-style Save Preset for a clip's effect stack.
 *
 * A preset stores a {@link LayerAttributes} snapshot with `transform` (and transform keyframes)
 * deliberately stripped: applying a look must never move/scale the target clip (that's what
 * paste-attributes ⌃⌥C/⌃⌥V is for). Effect-param keyframes DO travel with the preset. Application
 * goes through the same shared `applyAttributesToLayer` as paste, so effect ids are re-minted per
 * target layer (keyframes remapped with them) and editing one applied preset never aliases another.
 * Presets saved before keyframe support (no `animations` field) apply exactly as before.
 *
 * Persistence: localStorage `kimera.effectPresets` (device-local, like the rest of the editor's
 * lightweight prefs). Corrupt/legacy payloads are dropped silently — presets are convenience data.
 */

import type { LayerAttributes, TimelineLayer } from "@kimera-by-aelivion/shared";
import { snapshotLayerAttributes } from "@kimera-by-aelivion/shared";

export interface EffectPreset {
  id: string;
  name: string;
  createdAt: string;
  attributes: LayerAttributes;
}

const STORAGE_KEY = "kimera.effectPresets";

function readAll(): EffectPreset[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is EffectPreset =>
        !!p &&
        typeof (p as EffectPreset).id === "string" &&
        typeof (p as EffectPreset).name === "string" &&
        Array.isArray((p as EffectPreset).attributes?.effects)
    );
  } catch {
    return [];
  }
}

const listeners = new Set<() => void>();
let cache: EffectPreset[] | null = null;

function writeAll(presets: EffectPreset[]): void {
  cache = presets;
  try {
    window.localStorage?.setItem(STORAGE_KEY, JSON.stringify(presets));
  } catch {
    /* quota/private mode — keep the in-memory cache working for this session */
  }
  for (const listener of listeners) listener();
}

export function listEffectPresets(): EffectPreset[] {
  cache ??= readAll();
  return cache;
}

/** Save the layer's current effect stack (+fit +effect keyframes, NOT transform) under `name`. Returns the preset. */
export function saveEffectPreset(name: string, layer: TimelineLayer): EffectPreset {
  const attributes = snapshotLayerAttributes(layer);
  attributes.transform = undefined; // looks must not reposition, reshape, or reframe targets
  attributes.masks = undefined;
  attributes.content = undefined;
  attributes.speed = undefined;
  attributes.animations = attributes.animations?.filter((keyframe) => keyframe.target.scope === "effect");
  const preset: EffectPreset = {
    id: `preset_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    name: name.trim() || "Untitled preset",
    createdAt: new Date().toISOString(),
    attributes
  };
  writeAll([preset, ...listEffectPresets()]);
  return preset;
}

export function deleteEffectPreset(id: string): void {
  writeAll(listEffectPresets().filter((p) => p.id !== id));
}

/** Subscribe to preset list changes (for React `useSyncExternalStore`). */
export function subscribeEffectPresets(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
