/**
 * Beat detection — REAL in-browser DSP (no model, no cloud, no mock).
 *
 * Pipeline: fetch + decode the media's audio (AudioContext.decodeAudioData handles both audio
 * files and audio tracks of video containers), mono mixdown, short-time energy → positive energy
 * flux (a lightweight spectral-flux stand-in that works well for percussive onsets), adaptive
 * moving-average threshold, peak-pick with a minimum inter-onset gap, then tempo from the
 * inter-onset-interval histogram folded into the 60–180 BPM octave.
 *
 * Runs on the main thread: the analysis is a single O(n) pass over PCM (a 3-minute track is
 * ~15 ms of math); the slow part is decodeAudioData, which is already off-thread internally.
 * Cancellable between stages via `isCancelled` (the `local-transcription.ts` pattern).
 */

export interface BeatDetectionResult {
  /** Estimated tempo (beats per minute), 0 when no stable tempo was found. */
  bpm: number;
  /** Onset times in SOURCE-media seconds, ascending. */
  beats: number[];
  durationSeconds: number;
}

const FRAME = 1024;
const HOP = 512;
/** Fastest musical spacing we accept between onsets (~240 BPM). */
const MIN_ONSET_GAP_SECONDS = 0.25;

export async function detectBeatsFromUrl(
  fileUrl: string,
  onProgress?: (message: string) => void,
  isCancelled?: () => boolean
): Promise<BeatDetectionResult> {
  onProgress?.("Fetching audio…");
  const response = await fetch(fileUrl);
  if (!response.ok) {
    throw new Error(`Could not fetch media (${response.status})`);
  }
  const bytes = await response.arrayBuffer();
  assertNotCancelled(isCancelled);

  onProgress?.("Decoding audio…");
  const AudioContextCtor =
    typeof AudioContext !== "undefined"
      ? AudioContext
      : (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) {
    throw new Error("AudioContext is not available in this browser.");
  }
  const audioContext = new AudioContextCtor();
  let audio: AudioBuffer;
  try {
    audio = await audioContext.decodeAudioData(bytes);
  } catch {
    await audioContext.close();
    throw new Error("This media has no decodable audio track.");
  }
  assertNotCancelled(isCancelled, audioContext);

  onProgress?.("Analyzing beats…");
  const mono = mixToMono(audio);
  const sampleRate = audio.sampleRate;
  await audioContext.close();

  // Short-time energy per hop, then positive flux (energy rises = onsets).
  const frameCount = Math.max(0, Math.floor((mono.length - FRAME) / HOP));
  if (frameCount < 8) {
    return { bpm: 0, beats: [], durationSeconds: audio.duration };
  }
  const energies = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i += 1) {
    let sum = 0;
    const start = i * HOP;
    for (let j = 0; j < FRAME; j += 1) {
      const sample = mono[start + j]!;
      sum += sample * sample;
    }
    energies[i] = sum / FRAME;
  }
  const flux = new Float32Array(frameCount);
  for (let i = 1; i < frameCount; i += 1) {
    flux[i] = Math.max(0, energies[i]! - energies[i - 1]!);
  }

  // Adaptive threshold: local mean over ±window, scaled — robust across quiet/loud sections.
  const window = 20;
  const minGapFrames = Math.round((MIN_ONSET_GAP_SECONDS * sampleRate) / HOP);
  const beats: number[] = [];
  let lastOnsetFrame = -minGapFrames;
  for (let i = 2; i < frameCount - 2; i += 1) {
    const lo = Math.max(0, i - window);
    const hi = Math.min(frameCount, i + window);
    let mean = 0;
    for (let j = lo; j < hi; j += 1) {
      mean += flux[j]!;
    }
    mean /= hi - lo;
    const threshold = mean * 1.6 + 1e-6;
    const value = flux[i]!;
    const isPeak = value > threshold && value >= flux[i - 1]! && value > flux[i + 1]!;
    if (isPeak && i - lastOnsetFrame >= minGapFrames) {
      beats.push((i * HOP) / sampleRate);
      lastOnsetFrame = i;
    }
  }

  return { bpm: estimateBpm(beats), beats, durationSeconds: audio.duration };
}

function mixToMono(audio: AudioBuffer): Float32Array {
  const channels = audio.numberOfChannels;
  if (channels === 1) {
    return audio.getChannelData(0);
  }
  const length = audio.length;
  const mono = new Float32Array(length);
  for (let channel = 0; channel < channels; channel += 1) {
    const data = audio.getChannelData(channel);
    for (let i = 0; i < length; i += 1) {
      mono[i]! += data[i]! / channels;
    }
  }
  return mono;
}

/** Tempo from the inter-onset-interval histogram, folded into the 60–180 BPM octave. */
function estimateBpm(beats: number[]): number {
  if (beats.length < 4) {
    return 0;
  }
  const buckets = new Map<number, number>();
  for (let i = 1; i < beats.length; i += 1) {
    let interval = beats[i]! - beats[i - 1]!;
    if (interval <= 0.05) {
      continue;
    }
    let bpm = 60 / interval;
    while (bpm < 60) bpm *= 2;
    while (bpm > 180) bpm /= 2;
    const bucket = Math.round(bpm / 2) * 2; // 2-BPM buckets absorb jitter
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
  }
  let best = 0;
  let bestCount = 0;
  for (const [bpm, count] of buckets) {
    if (count > bestCount) {
      best = bpm;
      bestCount = count;
    }
  }
  return best;
}

function assertNotCancelled(isCancelled: (() => boolean) | undefined, audioContext?: AudioContext) {
  if (isCancelled?.()) {
    void audioContext?.close();
    throw new Error("Beat detection cancelled.");
  }
}
