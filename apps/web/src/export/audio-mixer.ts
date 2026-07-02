/**
 * Local export — audio mixdown.
 *
 * Renders every audio track (and video clips' audio) into one mixed buffer via an
 * OfflineAudioContext, honoring each clip's start, source in-point, trim length, and
 * mute (layer or track). The result is sliced into `AudioData` frames for the encoder.
 */

import { getCompositionVolume, isTrackEnabled, type TimelineComposition, type TimelineLayer } from "@lumio-by-aelivion/shared";
import type { MediaEncoder } from "./video-encoder";

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
// Gain envelope sampling rate for keyframed volume (fades). 60 Hz is smooth for short fades.
const GAIN_SAMPLE_HZ = 60;

/** A gain automation curve in absolute composition seconds, or a single constant gain. */
export interface GainEnvelope {
  times: number[];
  gains: number[];
}

export interface AudioLayerInput {
  assetId: string;
  url: string;
  startSeconds: number;
  durationSeconds: number;
  sourceInSeconds: number;
  muted: boolean;
  /** Constant gain multiplier (1 = unchanged) when not animated. */
  gain: number;
  /** Sampled gain automation (absolute comp seconds) when the volume effect is keyframed. */
  envelope?: GainEnvelope | undefined;
}

/**
 * Sample a layer's `volume` effect into a constant gain or a keyframe envelope, reusing the shared
 * `getCompositionVolume` so the local mix matches preview + Remotion. Constant when the gain doesn't
 * vary across the clip; otherwise finely sampled for a smooth fade.
 */
function resolveLayerGain(layer: TimelineLayer): { gain: number; envelope?: GainEnvelope } {
  const start = layer.startSeconds;
  const end = start + layer.durationSeconds;
  const probe = (t: number) => getCompositionVolume(layer, { currentTimeSeconds: t });
  const gStart = probe(start);
  const gMid = probe(start + layer.durationSeconds / 2);
  const gEnd = probe(Math.max(start, end - 1e-4));
  if (gStart === gMid && gMid === gEnd) {
    return { gain: gStart };
  }
  const steps = Math.max(2, Math.ceil(layer.durationSeconds * GAIN_SAMPLE_HZ));
  const times: number[] = [];
  const gains: number[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = start + (layer.durationSeconds * i) / steps;
    times.push(t);
    gains.push(probe(Math.min(t, end)));
  }
  return { gain: gStart, envelope: { times, gains } };
}

/** Collect audio layers (with resolved URLs, mute, volume/fade gain). Video is visual-only — its embedded
 *  audio is intentionally NOT mixed, matching the preview (which only plays `audio` layers). */
export function collectAudioLayers(
  composition: TimelineComposition,
  urlForAsset: (assetId: string) => string | undefined
): AudioLayerInput[] {
  const layers: AudioLayerInput[] = [];
  for (const track of composition.tracks) {
    for (const layer of track.layers) {
      if (layer.type !== "audio" || !layer.assetId) continue;
      const url = urlForAsset(layer.assetId);
      if (!url) continue;
      const { gain, envelope } = resolveLayerGain(layer);
      layers.push({
        assetId: layer.assetId,
        url,
        startSeconds: layer.startSeconds,
        durationSeconds: layer.durationSeconds,
        sourceInSeconds: layer.sourceInSeconds ?? 0,
        muted: Boolean(layer.muted) || !isTrackEnabled(track, composition.tracks),
        gain,
        ...(envelope ? { envelope } : {}),
      });
    }
  }
  return layers;
}

export const audioConfig = { sampleRate: SAMPLE_RATE, channels: CHANNELS };

/** Mix all audio layers into a single AudioBuffer over [0, durationSeconds]. */
export async function mixTimelineAudio(
  layers: AudioLayerInput[],
  durationSeconds: number
): Promise<AudioBuffer | null> {
  const audible = layers.filter((layer) => !layer.muted);
  if (audible.length === 0 || durationSeconds <= 0) return null;

  const decodeCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
  const cache = new Map<string, AudioBuffer | null>();
  async function decode(layer: AudioLayerInput): Promise<AudioBuffer | null> {
    if (cache.has(layer.assetId)) return cache.get(layer.assetId) ?? null;
    let buffer: AudioBuffer | null = null;
    try {
      // cache:"no-store" bypasses the HTTP cache — the dev server's /storage range responses otherwise
      // trip Chromium's ERR_CACHE_OPERATION_NOT_SUPPORTED, which silently dropped the audio track.
      const bytes = await (await fetch(layer.url, { cache: "no-store" })).arrayBuffer();
      buffer = await decodeCtx.decodeAudioData(bytes);
    } catch {
      buffer = null; // a source without an audio track (silent video) just contributes nothing
    }
    cache.set(layer.assetId, buffer);
    return buffer;
  }

  const decoded = await Promise.all(audible.map(async (layer) => ({ layer, buffer: await decode(layer) })));
  await decodeCtx.close();

  const totalFrames = Math.ceil(durationSeconds * SAMPLE_RATE);
  const offline = new OfflineAudioContext(CHANNELS, totalFrames, SAMPLE_RATE);

  let scheduled = 0;
  for (const { layer, buffer } of decoded) {
    if (!buffer) continue;
    const node = offline.createBufferSource();
    node.buffer = buffer;
    // GainNode per source applies the clip's volume / fade. Constant gain sets a single value;
    // a keyframed envelope schedules linear ramps in absolute comp time (aligned with node.start).
    const gainNode = offline.createGain();
    if (layer.envelope && layer.envelope.times.length) {
      const { times, gains } = layer.envelope;
      gainNode.gain.setValueAtTime(gains[0]!, Math.max(0, times[0]!));
      for (let i = 1; i < times.length; i += 1) {
        gainNode.gain.linearRampToValueAtTime(gains[i]!, Math.max(0, times[i]!));
      }
    } else {
      gainNode.gain.value = layer.gain;
    }
    node.connect(gainNode);
    gainNode.connect(offline.destination);
    node.start(layer.startSeconds, layer.sourceInSeconds, layer.durationSeconds);
    scheduled += 1;
  }
  if (scheduled === 0) return null;

  return offline.startRendering();
}

/** Planar f32 channels + sample rate — a transferable snapshot of a mixed AudioBuffer. */
export interface MixedAudioChannels {
  channels: Float32Array[];
  sampleRate: number;
}

/**
 * Copy a mixed AudioBuffer's channels into standalone Float32Arrays so their backing buffers
 * can be transferred to the export Worker (AudioContext can't run in a Worker, so mixing stays
 * on the main thread and only the PCM crosses over).
 */
export function extractAudioChannels(buffer: AudioBuffer): MixedAudioChannels {
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c += 1) {
    channels.push(new Float32Array(buffer.getChannelData(c)));
  }
  return { channels, sampleRate: buffer.sampleRate };
}

/** Slice a mixed AudioBuffer into planar f32 AudioData frames and feed the encoder. */
export function encodeMixedAudio(encoder: MediaEncoder, buffer: AudioBuffer): void {
  encodeMixedChannels(encoder, extractAudioChannels(buffer));
}

/** Slice already-extracted planar channels into AudioData frames and feed the encoder. */
export function encodeMixedChannels(encoder: MediaEncoder, mixed: MixedAudioChannels): void {
  const { channels, sampleRate } = mixed;
  const numChannels = channels.length;
  if (numChannels === 0) return;
  const length = channels[0]!.length;
  const chunkFrames = sampleRate; // ~1s per AudioData

  for (let offset = 0; offset < length; offset += chunkFrames) {
    const frames = Math.min(chunkFrames, length - offset);
    const planar = new Float32Array(frames * numChannels);
    for (let c = 0; c < numChannels; c += 1) {
      planar.set(channels[c]!.subarray(offset, offset + frames), c * frames);
    }
    const audioData = new AudioData({
      format: "f32-planar",
      sampleRate,
      numberOfFrames: frames,
      numberOfChannels: numChannels,
      timestamp: Math.round((offset / sampleRate) * 1_000_000),
      data: planar,
    });
    encoder.encodeAudio(audioData);
  }
}
