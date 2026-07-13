/**
 * Auto-ducking (Premiere Essential-Sound model): analyze a SIDECHAIN track's loudness (dialog/VO),
 * find the regions where it's audible, and GENERATE clip volume keyframes on the target track
 * (music) that dip under those regions.
 *
 * Deliberately keyframe-generation, not live sidechain compression: the result is ordinary
 * `volume` effect gain keyframes — visible on the clip's rubber band, hand-editable afterwards,
 * and rendered bit-identically by all three renderers through the existing `getCompositionVolume`
 * path. No new renderer surface, no live-analysis cost during playback (the low-end contract).
 *
 * Re-applying replaces the previously generated envelope: apply CLEARS all volume keyframes on the
 * target track's clips first (the base gain is kept as the un-ducked level), same as Premiere's
 * "Generate Keyframes" re-run.
 */

import { layerSourceTimeSeconds, type TimelineComposition, type TimelineLayer } from "@kimera-by-aelivion/shared";
import { addVolumePoint, getVolumeBase, getVolumeEffectId } from "./audioVolume";

export interface DuckingOptions {
  /** Sidechain RMS (dBFS) above which the voice counts as speaking. */
  thresholdDb: number;
  /** How far the target dips while the voice is active (positive dB of reduction). */
  duckDb: number;
  /** Ramp length into/out of each dip, seconds. */
  fadeSeconds: number;
  /** Silences shorter than this stay ducked (bridges pauses between phrases), seconds. */
  holdSeconds: number;
}

export const DEFAULT_DUCKING: DuckingOptions = { thresholdDb: -40, duckDb: 12, fadeSeconds: 0.3, holdSeconds: 0.4 };

/** RMS analysis hop. 20ms ≈ the resolution ducking needs; keeps a 10-min track at ~30k hops. */
const HOP_SECONDS = 0.02;
/** Active bursts shorter than this are ignored (coughs, clicks). */
const MIN_REGION_SECONDS = 0.15;

export interface DuckRegion {
  start: number;
  end: number;
}

/**
 * Decode the sidechain track's clips and return the composition-time regions where they're louder
 * than `thresholdDb`. Analysis is on the RAW source signal (before clip/track gain), like a
 * hardware sidechain tap — turning the VO clip down shouldn't change where the music ducks.
 */
export async function analyzeSidechainRegions(
  composition: TimelineComposition,
  sidechainTrackId: string,
  urlForAsset: (assetId: string) => string | undefined,
  options: DuckingOptions
): Promise<DuckRegion[]> {
  const track = composition.tracks.find((t) => t.id === sidechainTrackId);
  if (!track) return [];
  const clips = track.layers.filter((layer) => layer.type === "audio" && layer.assetId && !layer.muted);
  if (!clips.length) return [];

  const totalHops = Math.ceil(composition.durationSeconds / HOP_SECONDS);
  const active = new Uint8Array(totalHops);
  const thresholdLin = Math.pow(10, options.thresholdDb / 20);

  const ctx = new AudioContext({ sampleRate: 48_000 });
  try {
    const decoded = new Map<string, AudioBuffer | null>();
    for (const clip of clips) {
      const assetId = clip.assetId!;
      if (!decoded.has(assetId)) {
        try {
          const url = urlForAsset(assetId);
          if (!url) {
            decoded.set(assetId, null);
            continue;
          }
          // cache:"no-store" for the same dev-server range-response reason as the export mixer.
          const bytes = await (await fetch(url, { cache: "no-store" })).arrayBuffer();
          decoded.set(assetId, await ctx.decodeAudioData(bytes));
        } catch {
          decoded.set(assetId, null);
        }
      }
      const buffer = decoded.get(assetId);
      if (!buffer) continue;

      const data = buffer.getChannelData(0);
      const rate = buffer.sampleRate;
      const firstHop = Math.max(0, Math.floor(clip.startSeconds / HOP_SECONDS));
      const lastHop = Math.min(totalHops, Math.ceil((clip.startSeconds + clip.durationSeconds) / HOP_SECONDS));
      for (let hop = firstHop; hop < lastHop; hop += 1) {
        if (active[hop]) continue;
        const local = hop * HOP_SECONDS - clip.startSeconds;
        // Speed/ramp-aware: the hop's source window is [map(local), map(local + hop)] via the shared mapper.
        const srcStart = Math.floor(layerSourceTimeSeconds(clip, local) * rate);
        const srcEnd = Math.min(data.length, Math.max(srcStart + 1, Math.floor(layerSourceTimeSeconds(clip, local + HOP_SECONDS) * rate)));
        if (srcStart < 0 || srcStart >= data.length) continue;
        let sumSq = 0;
        for (let i = srcStart; i < srcEnd; i += 1) sumSq += data[i]! * data[i]!;
        const rms = Math.sqrt(sumSq / Math.max(1, srcEnd - srcStart));
        if (rms >= thresholdLin) active[hop] = 1;
      }
    }
  } finally {
    await ctx.close().catch(() => undefined);
  }

  // Booleans → regions: bridge gaps ≤ holdSeconds, drop bursts < MIN_REGION_SECONDS.
  const regions: DuckRegion[] = [];
  let runStart = -1;
  for (let hop = 0; hop <= totalHops; hop += 1) {
    const on = hop < totalHops && active[hop] === 1;
    if (on && runStart === -1) runStart = hop;
    if (!on && runStart !== -1) {
      regions.push({ start: runStart * HOP_SECONDS, end: hop * HOP_SECONDS });
      runStart = -1;
    }
  }
  const merged: DuckRegion[] = [];
  for (const region of regions) {
    const last = merged[merged.length - 1];
    if (last && region.start - last.end <= options.holdSeconds) {
      last.end = region.end;
    } else {
      merged.push({ ...region });
    }
  }
  return merged.filter((region) => region.end - region.start >= MIN_REGION_SECONDS);
}

/** Strip every volume-gain keyframe from a layer (the generated envelope replaces them wholesale). */
function clearVolumeKeyframes(layer: TimelineLayer): TimelineLayer {
  const effectId = getVolumeEffectId(layer);
  if (!effectId || !layer.animations?.length) return layer;
  return {
    ...layer,
    animations: layer.animations.filter(
      (kf) => !(kf.target.scope === "effect" && kf.target.effectId === effectId && kf.target.property === "gain")
    ),
  };
}

/**
 * Write the ducking envelope onto every audio clip of `targetTrackId`: for each analyzed region,
 * base → (fade) → base−duckDb → (fade) → base, as ordinary volume keyframes. Regions are padded by
 * the fade and re-merged first so overlapping ramps can't interleave. Pure function — the caller
 * persists via its usual composition-update path (undo covers it for free).
 */
export function applyDuckingKeyframes(
  composition: TimelineComposition,
  targetTrackId: string,
  regions: DuckRegion[],
  options: DuckingOptions
): TimelineComposition {
  if (!regions.length) return composition;
  const fade = Math.max(0.05, options.fadeSeconds);
  const padded: DuckRegion[] = [];
  for (const region of regions) {
    const grown = { start: region.start - fade, end: region.end + fade };
    const last = padded[padded.length - 1];
    if (last && grown.start <= last.end) {
      last.end = Math.max(last.end, grown.end);
    } else {
      padded.push(grown);
    }
  }

  const duckFactor = Math.pow(10, -Math.max(0, options.duckDb) / 20);

  return {
    ...composition,
    tracks: composition.tracks.map((track) => {
      if (track.id !== targetTrackId) return track;
      return {
        ...track,
        layers: track.layers.map((layer) => {
          if (layer.type !== "audio") return layer;
          const clipStart = layer.startSeconds;
          const clipEnd = clipStart + layer.durationSeconds;
          const overlapping = padded.filter((region) => region.end > clipStart && region.start < clipEnd);
          let next = clearVolumeKeyframes(layer);
          if (!overlapping.length) return next;
          const base = getVolumeBase(next);
          const ducked = Math.max(0, Math.round(base * duckFactor));
          // Ramp corners in layer-local time, clamped onto the clip. Corners that clamp onto the
          // same instant (a region hanging off the clip's edge) collapse to ONE keyframe keeping
          // the DUCKED value — a clip that starts mid-region starts ducked.
          const byTime = new Map<number, number>();
          for (const region of overlapping) {
            const corners: Array<[number, number]> = [
              [region.start - clipStart, base],
              [region.start + fade - clipStart, ducked],
              [region.end - fade - clipStart, ducked],
              [region.end - clipStart, base],
            ];
            for (const [t, gain] of corners) {
              const key = Math.round(Math.min(layer.durationSeconds, Math.max(0, t)) * 1000);
              byTime.set(key, Math.min(byTime.get(key) ?? gain, gain));
            }
          }
          for (const [key, gain] of [...byTime.entries()].sort((a, b) => a[0] - b[0])) {
            next = addVolumePoint(next, key / 1000, gain).layer;
          }
          return next;
        }),
      };
    }),
  };
}
