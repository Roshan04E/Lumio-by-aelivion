/**
 * Local export — audio mixdown.
 *
 * Renders every audio track (and video clips' audio) into one mixed buffer via an
 * OfflineAudioContext, honoring each clip's start, source in-point, trim length, and
 * mute (layer or track). The result is sliced into `AudioData` frames for the encoder.
 */

import { getCompositionVolume, getLayerSpeed, getTrackAudioGainAt, getTrackPan, getTrackPanAt, isTrackEnabled, layerSourceTimeSeconds, processAudioFxBuffer, resolveAudioFxChain, trackHasAudioAutomation, type AudioFxStep, type SpeedKeyframe, type TimelineComposition, type TimelineLayer, type TimelineTrack } from "@orreris/shared";
import type { MediaEncoder } from "./video-encoder";

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
// Gain envelope sampling rate for keyframed volume (fades). 60 Hz is smooth for short fades.
const GAIN_SAMPLE_HZ = 60;
// Same value/rationale as export-core.ts's SOURCE_LOAD_TIMEOUT_MS for the same class of operation
// (a network media fetch) — this file can't import that module's private constant, so it's
// duplicated locally, matching this repo's existing convention for the `withTimeout` helper itself
// (already independently duplicated in export-core.ts / LocalExportPage.tsx / world/observers/look.ts).
const AUDIO_SOURCE_FETCH_TIMEOUT_MS = 25_000;

/**
 * Thrown when an audio layer's SOURCE BYTES can't be fetched — dead network, 404, or a request that
 * never resolves. Deliberately distinct from a decodeAudioData failure (bytes arrived, but the file
 * has no audio track — that stays the existing, documented "contributes nothing" leniency below):
 * a fetch failure is a real failure the export must report, not a silent per-layer no-op.
 */
export class AudioSourceFetchError extends Error {
  constructor(public readonly assetId: string, public readonly url: string, cause: string) {
    super(`failed to fetch audio source (assetId=${assetId}, url=${url}) — ${cause}`);
    this.name = "AudioSourceFetchError";
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

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
  /** Clip playback rate (rate stretch). 1 = normal; consumes durationSeconds*speed of source. */
  speed: number;
  muted: boolean;
  /** Constant gain multiplier (1 = unchanged) when not animated. INCLUDES the track fader. */
  gain: number;
  /** Sampled gain automation (absolute comp seconds) when clip volume OR the track fader is keyframed. INCLUDES the track fader. */
  envelope?: GainEnvelope | undefined;
  /** Track stereo pan (−1..1, 0 = center) when static. */
  trackPan: number;
  /** Sampled pan automation (−1..1, absolute comp seconds) when the track pan is keyframed. */
  panEnvelope?: GainEnvelope | undefined;
  /** Clip audio FX chain (EQ/compressor/gate/limiter), resolved from the layer's effects. Empty = untouched path. */
  fxChain: AudioFxStep[];
  /** Speed ramp points (layer-local, linear). Presence routes the clip through the pre-render path. */
  speedKeyframes?: SpeedKeyframe[] | undefined;
}

/**
 * Sample the layer's `volume` effect × the TRACK fader into a constant gain or an envelope, reusing
 * the shared `getCompositionVolume`/`getTrackAudioGainAt` so the local mix matches preview + cloud.
 * Constant when neither varies across the clip; otherwise finely sampled for smooth fades/automation.
 */
function resolveLayerGain(layer: TimelineLayer, track: TimelineTrack): { gain: number; envelope?: GainEnvelope } {
  const start = layer.startSeconds;
  const end = start + layer.durationSeconds;
  const probe = (t: number) => getCompositionVolume(layer, { currentTimeSeconds: t }) * getTrackAudioGainAt(track, t);
  const gStart = probe(start);
  const gMid = probe(start + layer.durationSeconds / 2);
  const gEnd = probe(Math.max(start, end - 1e-4));
  if (gStart === gMid && gMid === gEnd && !trackHasAudioAutomation(track)) {
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

/** Sampled track-pan automation over the clip span (null when the pan is static). */
function resolveLayerPan(layer: TimelineLayer, track: TimelineTrack): GainEnvelope | null {
  if (!track.panKeyframes?.length) return null;
  const start = layer.startSeconds;
  const steps = Math.max(2, Math.ceil(layer.durationSeconds * GAIN_SAMPLE_HZ));
  const times: number[] = [];
  const gains: number[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = start + (layer.durationSeconds * i) / steps;
    times.push(t);
    gains.push(getTrackPanAt(track, t));
  }
  return { times, gains };
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
      const { gain, envelope } = resolveLayerGain(layer, track);
      const panEnvelope = resolveLayerPan(layer, track);
      layers.push({
        assetId: layer.assetId,
        url,
        startSeconds: layer.startSeconds,
        durationSeconds: layer.durationSeconds,
        sourceInSeconds: layer.sourceInSeconds ?? 0,
        speed: getLayerSpeed(layer),
        muted: Boolean(layer.muted) || Boolean(layer.disabled) || !isTrackEnabled(track, composition.tracks),
        gain,
        trackPan: getTrackPan(track),
        fxChain: resolveAudioFxChain(layer),
        speedKeyframes: layer.speedKeyframes,
        ...(envelope ? { envelope } : {}),
        ...(panEnvelope ? { panEnvelope } : {}),
      });
    }
  }
  return layers;
}

export const audioConfig = { sampleRate: SAMPLE_RATE, channels: CHANNELS };

/**
 * Pre-render an FX'd clip to a TIMELINE-domain stereo buffer: the clip's source span is varispeed-
 * resampled (linear, the same interpolation the cloud post-mix uses) so the FX run AFTER rate
 * stretch — an EQ band stays at its dialed frequency regardless of clip speed — then the shared
 * DSP chain processes the PCM in place. The caller schedules the result at playbackRate 1.
 * Mono sources are duplicated to stereo first, matching ffmpeg's `-ac 2` upmix on the cloud path
 * (and keeping the StereoPanner in its STEREO pan law for parity).
 */
function renderFxClipChannels(buffer: AudioBuffer, layer: AudioLayerInput): Float32Array[] {
  const frames = Math.max(1, Math.ceil(layer.durationSeconds * SAMPLE_RATE));
  const srcL = buffer.getChannelData(0);
  const srcR = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : srcL;
  const sourceFrames = buffer.length;
  const outL = new Float32Array(frames);
  const outR = new Float32Array(frames);
  // Timeline→source through the SHARED mapper: closed-form ramp integral when speedKeyframes are
  // present, sourceIn + t×speed otherwise — identical math to the worker post-mix.
  const mapper = { speed: layer.speed, sourceInSeconds: layer.sourceInSeconds, speedKeyframes: layer.speedKeyframes };
  // decodeAudioData resamples to the decode context's 48k, so source PCM is already at SAMPLE_RATE.
  for (let frame = 0; frame < frames; frame += 1) {
    const srcPos = layerSourceTimeSeconds(mapper, frame / SAMPLE_RATE) * SAMPLE_RATE;
    const i0 = Math.floor(srcPos);
    if (i0 < 0 || i0 >= sourceFrames - 1) continue;
    const frac = srcPos - i0;
    outL[frame] = srcL[i0]! * (1 - frac) + srcL[i0 + 1]! * frac;
    outR[frame] = srcR[i0]! * (1 - frac) + srcR[i0 + 1]! * frac;
  }
  const channels = [outL, outR];
  processAudioFxBuffer(layer.fxChain, channels, SAMPLE_RATE);
  return channels;
}

/** Mix all audio layers into a single AudioBuffer over [0, durationSeconds].
 *  `onProgress` (0..1), when given, is called once per layer decode plus once at completion — cheap,
 *  not a per-sample callback; the render phase itself (`startRendering()`) has no native progress API
 *  and is fast enough (measured, see DEBT-015's mixdown-scaling probe) not to need one. */
export async function mixTimelineAudio(
  layers: AudioLayerInput[],
  durationSeconds: number,
  onProgress?: (fraction: number) => void
): Promise<AudioBuffer | null> {
  const audible = layers.filter((layer) => !layer.muted);
  if (audible.length === 0 || durationSeconds <= 0) return null;

  const decodeCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
  const cache = new Map<string, AudioBuffer | null>();
  async function decode(layer: AudioLayerInput): Promise<AudioBuffer | null> {
    if (cache.has(layer.assetId)) return cache.get(layer.assetId) ?? null;
    // FETCH failures (dead network, 404, a request that hangs forever) are a REAL failure and must
    // be reported, distinct from "this source has no audio track" (a legitimate, documented no-op
    // below) — DEBT-015 originally guarded the whole mixdown with one wall-clock race that couldn't
    // tell the two apart; that race is gone (see mixTimelineAudio's caller), so the fetch itself now
    // carries its own bound and its own name. `response.ok` is checked explicitly: fetch() resolves
    // (does not reject) on a 404, and decodeAudioData on an HTML error body would otherwise have been
    // silently absorbed as "no audio track" below.
    let bytes: ArrayBuffer;
    try {
      bytes = await withTimeout(
        (async () => {
          // cache:"no-store" bypasses the HTTP cache — the dev server's /storage range responses
          // otherwise trip Chromium's ERR_CACHE_OPERATION_NOT_SUPPORTED, which silently dropped the
          // audio track.
          const response = await fetch(layer.url, { cache: "no-store" });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.arrayBuffer();
        })(),
        AUDIO_SOURCE_FETCH_TIMEOUT_MS,
        `audio source fetch (assetId=${layer.assetId})`
      );
    } catch (error) {
      throw new AudioSourceFetchError(layer.assetId, layer.url, error instanceof Error ? error.message : String(error));
    }
    let buffer: AudioBuffer | null = null;
    try {
      buffer = await decodeCtx.decodeAudioData(bytes);
    } catch {
      buffer = null; // a source without an audio track (silent video) just contributes nothing
    }
    cache.set(layer.assetId, buffer);
    return buffer;
  }

  let decodedCount = 0;
  const decoded = await Promise.all(
    audible.map(async (layer) => {
      const buffer = await decode(layer);
      decodedCount += 1;
      onProgress?.((decodedCount / audible.length) * 0.9);
      return { layer, buffer };
    })
  );
  await decodeCtx.close();

  const totalFrames = Math.ceil(durationSeconds * SAMPLE_RATE);
  const offline = new OfflineAudioContext(CHANNELS, totalFrames, SAMPLE_RATE);

  let scheduled = 0;
  for (const { layer, buffer } of decoded) {
    if (!buffer) continue;
    const node = offline.createBufferSource();
    // Clip FX and/or speed RAMPS: swap in the pre-processed timeline-domain buffer (FX → gain →
    // pan, pre-fader inserts). Varispeed/ramp/trim are baked into it, so the node plays it plainly
    // from 0 at rate 1 — AudioBufferSourceNode can't follow a rate curve deterministically.
    // S2: REVERSED constant speed also takes the pre-render path — the per-sample shared mapper
    // walks source PCM backward (true reversed audio), while AudioBufferSourceNode.playbackRate
    // can't go negative. (Reversed RAMPS were already here via speedKeyframes.)
    const hasFx = layer.fxChain.length > 0 || (layer.speedKeyframes?.length ?? 0) > 0 || layer.speed < 0;
    if (hasFx) {
      const channels = renderFxClipChannels(buffer, layer);
      const fxBuffer = offline.createBuffer(CHANNELS, channels[0]!.length, SAMPLE_RATE);
      fxBuffer.copyToChannel(channels[0]! as Float32Array<ArrayBuffer>, 0);
      fxBuffer.copyToChannel(channels[1]! as Float32Array<ArrayBuffer>, 1);
      node.buffer = fxBuffer;
    } else {
      node.buffer = buffer;
    }
    // GainNode per source applies the clip's volume / fade. Constant gain sets a single value;
    // a keyframed envelope schedules linear ramps in absolute comp time (aligned with node.start).
    const gainNode = offline.createGain();
    // Gain/envelope already includes the track fader (resolveLayerGain samples the product).
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
    // Track pan (StereoPanner) between the clip gain and the mix bus — mirrors the preview's
    // element → gain → pan → master-bus graph. Keyframed pan schedules linear ramps.
    const wantsPan = layer.trackPan !== 0 || (layer.panEnvelope?.times.length ?? 0) > 0;
    if (wantsPan && typeof offline.createStereoPanner === "function") {
      const panNode = offline.createStereoPanner();
      if (layer.panEnvelope && layer.panEnvelope.times.length) {
        const { times, gains } = layer.panEnvelope;
        panNode.pan.setValueAtTime(gains[0]!, Math.max(0, times[0]!));
        for (let i = 1; i < times.length; i += 1) {
          panNode.pan.linearRampToValueAtTime(gains[i]!, Math.max(0, times[i]!));
        }
      } else {
        panNode.pan.value = Math.min(1, Math.max(-1, layer.trackPan));
      }
      gainNode.connect(panNode);
      panNode.connect(offline.destination);
    } else {
      gainNode.connect(offline.destination);
    }
    // Rate stretch: playbackRate scales source consumption (varispeed — pitch shifts, matching the
    // preview's preservesPitch=false). start()'s duration arg is in SOURCE/buffer seconds, so a clip
    // occupying durationSeconds of timeline consumes durationSeconds * speed of buffer.
    // (FX'd clips baked speed/trim into their pre-rendered buffer above — they play plain.)
    if (hasFx) {
      node.start(layer.startSeconds, 0, layer.durationSeconds);
    } else {
      node.playbackRate.value = layer.speed;
      node.start(layer.startSeconds, layer.sourceInSeconds, layer.durationSeconds * layer.speed);
    }
    scheduled += 1;
  }
  if (scheduled === 0) {
    onProgress?.(1);
    return null;
  }

  const rendered = await offline.startRendering();
  onProgress?.(1);
  return rendered;
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
