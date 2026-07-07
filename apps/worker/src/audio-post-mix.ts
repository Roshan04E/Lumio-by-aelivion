/**
 * Cloud-export audio post-mix (track-pan parity, 2026-07-03).
 *
 * Remotion's <Audio> has no stereo-pan prop, so when a composition uses the track mixer's pan the
 * worker takes over the ENTIRE audio mix: Remotion renders the video MUTED, this module decodes
 * every audio source with ffmpeg, mixes in JS using the SAME shared helpers the preview and local
 * WebCodecs export use (`getCompositionVolume` for keyframed fades, Web Audio's StereoPannerNode
 * stereo pan law, varispeed for rate stretch), and ffmpeg muxes the mixed PCM back with the video.
 *
 * Deliberately JS-mixed rather than an ffmpeg filtergraph: our volume keyframes have arbitrary
 * easings — sampling them through the shared evaluator gives EXACT parity with the other two
 * renderers instead of a filtergraph approximation.
 *
 * Activation: only when a layer actually has non-zero trackPan (see {@link manifestNeedsAudioPostMix})
 * — compositions that never touch pan keep the untouched Remotion audio path byte-identical.
 * Escape hatch: WORKER_AUDIO_POST_MIX=0.
 */

import { spawn } from "node:child_process";
import { rename, rm } from "node:fs/promises";
import ffmpegPath from "ffmpeg-static";
import { getCompositionVolume, getTrackAudioGainAt, getTrackPanAt, layerSourceTimeSeconds, processAudioFxBuffer, resolveAudioFxChain, type TimelineLayer } from "@lumio-by-aelivion/shared";
import type { RenderManifest, RenderManifestLayer } from "@lumio-by-aelivion/render-templates";

const SAMPLE_RATE = 48_000;
// Volume-envelope sampling rate — matches the local mixer's GAIN_SAMPLE_HZ for identical fades.
const GAIN_SAMPLE_HZ = 60;

function audioLayers(manifest: RenderManifest): RenderManifestLayer[] {
  return manifest.layers.filter((layer) => layer.type === "audio" && !!layer.assetUrl);
}

function layerSpeed(layer: Pick<RenderManifestLayer, "speed">): number {
  const raw = layer.speed;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return 1;
  return Math.min(16, Math.max(0.05, raw));
}

function layerTrackPan(layer: Pick<RenderManifestLayer, "trackPan">): number {
  const raw = layer.trackPan;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
  return Math.min(1, Math.max(-1, raw));
}

/**
 * True when the manifest's audio needs the worker-side mix: non-center pan, keyframed pan, OR clip
 * audio FX (Remotion's <Audio> can't run the DSP chain, so the worker mix takes over — same shared
 * implementation as the preview worklet and the local export, so all three stay in sync).
 */
export function manifestNeedsAudioPostMix(manifest: RenderManifest): boolean {
  if (process.env.WORKER_AUDIO_POST_MIX === "0") return false;
  return audioLayers(manifest).some(
    (layer) =>
      layerTrackPan(layer) !== 0 ||
      (layer.trackPanKeyframes?.length ?? 0) > 0 ||
      resolveAudioFxChain(layer).length > 0 ||
      // Speed ramps: Remotion's <Audio playbackRate> is constant-only — the worker mix time-remaps.
      (layer.speedKeyframes?.length ?? 0) > 0
  );
}

/** Decode any ffmpeg-readable source (file path or http/https URL) to interleaved stereo f32 @48k. */
async function decodeToPcm(source: string): Promise<Float32Array> {
  if (!ffmpegPath) throw new Error("ffmpeg-static binary unavailable");
  return new Promise<Float32Array>((resolve, reject) => {
    const proc = spawn(ffmpegPath as string, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      source,
      "-vn",
      "-f",
      "f32le",
      "-acodec",
      "pcm_f32le",
      "-ac",
      "2",
      "-ar",
      String(SAMPLE_RATE),
      "pipe:1",
    ]);
    const chunks: Buffer[] = [];
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg decode failed (${code}) for ${source}: ${stderr.slice(0, 400)}`));
        return;
      }
      const bytes = Buffer.concat(chunks);
      resolve(new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4)));
    });
  });
}

/**
 * Mix every audio layer into interleaved stereo f32 PCM over [0, durationSeconds].
 * Semantics mirror apps/web/src/export/audio-mixer.ts + the preview graph exactly:
 * source-in/trim, varispeed rate stretch (linear resample), keyframed clip volume ×
 * track fader, and the Web Audio StereoPannerNode STEREO pan law.
 */
export async function mixManifestAudioPcm(
  manifest: RenderManifest,
  decode: (source: string) => Promise<Float32Array> = decodeToPcm
): Promise<Float32Array | null> {
  const layers = audioLayers(manifest);
  if (!layers.length) return null;
  const durationSeconds = manifest.output.durationSeconds;
  const totalFrames = Math.ceil(durationSeconds * SAMPLE_RATE);
  const mix = new Float32Array(totalFrames * 2);

  const pcmCache = new Map<string, Float32Array | null>();
  for (const layer of layers) {
    const url = layer.assetUrl!;
    if (!pcmCache.has(url)) {
      try {
        pcmCache.set(url, await decode(url));
      } catch {
        pcmCache.set(url, null); // silent-video source etc. — contributes nothing, like the local mixer
      }
    }
    const pcm = pcmCache.get(url);
    if (!pcm || pcm.length < 2) continue;
    const sourceFrames = Math.floor(pcm.length / 2);

    const speed = layerSpeed(layer);
    const sourceIn = layer.sourceInSeconds ?? 0;
    const start = layer.startSeconds;
    const clipStartFrame = Math.max(0, Math.round(start * SAMPLE_RATE));
    const clipEndFrame = Math.min(totalFrames, Math.round((start + layer.durationSeconds) * SAMPLE_RATE));
    if (clipEndFrame <= clipStartFrame) continue;

    // Clip FX (EQ/compressor/gate/limiter): pre-render the FULL clip to timeline-domain planar PCM
    // — the exact procedure the local export mixer uses (renderFxClipChannels: linear varispeed
    // resample, then the shared DSP chain) — and read samples from it below. Processing the whole
    // clip (not just the in-composition slice) keeps the dynamics' envelope state identical to the
    // local export even when the composition truncates the clip.
    const fxChain = resolveAudioFxChain(layer);
    // Timeline→source through the SHARED mapper (ramp integral / constant speed) — identical math
    // to the local mixer's renderFxClipChannels.
    const mapper = { speed: layer.speed, sourceInSeconds: sourceIn, speedKeyframes: layer.speedKeyframes };
    let fxL: Float32Array | null = null;
    let fxR: Float32Array | null = null;
    const clipBaseFrame = Math.round(start * SAMPLE_RATE);
    if (fxChain.length || (layer.speedKeyframes?.length ?? 0) > 0) {
      const clipFrames = Math.max(1, Math.ceil(layer.durationSeconds * SAMPLE_RATE));
      fxL = new Float32Array(clipFrames);
      fxR = new Float32Array(clipFrames);
      for (let f = 0; f < clipFrames; f += 1) {
        const srcPos = layerSourceTimeSeconds(mapper, f / SAMPLE_RATE) * SAMPLE_RATE;
        const i0 = Math.floor(srcPos);
        if (i0 < 0 || i0 >= sourceFrames - 1) continue;
        const frac = srcPos - i0;
        fxL[f] = pcm[i0 * 2]! * (1 - frac) + pcm[(i0 + 1) * 2]! * frac;
        fxR[f] = pcm[i0 * 2 + 1]! * (1 - frac) + pcm[(i0 + 1) * 2 + 1]! * frac;
      }
      processAudioFxBuffer(fxChain, [fxL, fxR], SAMPLE_RATE);
    }

    // Envelopes sampled at GAIN_SAMPLE_HZ through the SHARED evaluators (exact fade/automation
    // parity), linearly interpolated per sample below — identical shape to the local
    // OfflineAudioContext ramps. Gain = clip volume × track fader (incl. fader keyframes);
    // pan envelope carries track-pan automation.
    const volumeLayer = layer as unknown as TimelineLayer;
    const trackShape = { volume: layer.trackGain, volumeKeyframes: layer.trackVolumeKeyframes, pan: layer.trackPan, panKeyframes: layer.trackPanKeyframes };
    const envSteps = Math.max(1, Math.ceil(layer.durationSeconds * GAIN_SAMPLE_HZ));
    const envelope = new Float32Array(envSteps + 1);
    const panEnvelope = new Float32Array(envSteps + 1);
    for (let s = 0; s <= envSteps; s += 1) {
      const t = start + (layer.durationSeconds * s) / envSteps;
      envelope[s] = Math.max(0, getCompositionVolume(volumeLayer, { currentTimeSeconds: t })) * getTrackAudioGainAt(trackShape, t);
      panEnvelope[s] = getTrackPanAt(trackShape, t);
    }

    for (let frame = clipStartFrame; frame < clipEndFrame; frame += 1) {
      const local = frame / SAMPLE_RATE - start;
      let inL: number;
      let inR: number;
      if (fxL && fxR) {
        const f = frame - clipBaseFrame;
        if (f < 0 || f >= fxL.length) continue;
        inL = fxL[f]!;
        inR = fxR[f]!;
      } else {
        const srcPos = (sourceIn + local * speed) * SAMPLE_RATE;
        const i0 = Math.floor(srcPos);
        if (i0 < 0 || i0 >= sourceFrames - 1) continue;
        const frac = srcPos - i0;
        inL = pcm[i0 * 2]! * (1 - frac) + pcm[(i0 + 1) * 2]! * frac;
        inR = pcm[i0 * 2 + 1]! * (1 - frac) + pcm[(i0 + 1) * 2 + 1]! * frac;
      }

      const envPos = (local / layer.durationSeconds) * envSteps;
      const e0 = Math.min(envSteps - 1, Math.max(0, Math.floor(envPos)));
      const eFrac = Math.min(1, Math.max(0, envPos - e0));
      const gain = envelope[e0]! * (1 - eFrac) + envelope[e0 + 1]! * eFrac;
      const panNow = panEnvelope[e0]! * (1 - eFrac) + panEnvelope[e0 + 1]! * eFrac;

      // Web Audio StereoPannerNode STEREO input pan law (spec) — matches the local export graph.
      const x = ((panNow <= 0 ? panNow + 1 : panNow) * Math.PI) / 2;
      const gL = Math.cos(x);
      const gR = Math.sin(x);
      let outL: number;
      let outR: number;
      if (panNow <= 0) {
        outL = inL + inR * gL;
        outR = inR * gR;
      } else {
        outL = inL * gL;
        outR = inR + inL * gR;
      }
      mix[frame * 2] = mix[frame * 2]! + outL * gain;
      mix[frame * 2 + 1] = mix[frame * 2 + 1]! + outR * gain;
    }
  }
  return mix;
}

/** Mux mixed PCM with the (muted) Remotion video: video stream copied, audio encoded AAC. */
async function muxPcmWithVideo(videoPath: string, pcm: Float32Array, outputPath: string): Promise<void> {
  if (!ffmpegPath) throw new Error("ffmpeg-static binary unavailable");
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpegPath as string, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      videoPath,
      "-f",
      "f32le",
      "-ar",
      String(SAMPLE_RATE),
      "-ac",
      "2",
      "-i",
      "pipe:0",
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-shortest",
      outputPath,
    ]);
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg mux failed (${code}): ${stderr.slice(0, 400)}`));
    });
    proc.stdin.on("error", () => undefined); // EPIPE if ffmpeg exits early — surfaced via close code
    proc.stdin.write(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
    proc.stdin.end();
  });
}

/**
 * Replace `videoPath`'s audio with the worker-side mix and write the result to `outputPath`
 * (may equal videoPath's final destination — we go through a temp name and rename).
 * If the mix comes out empty (no decodable audio), the video is moved through unchanged.
 */
export async function postMixManifestAudio(manifest: RenderManifest, videoPath: string, outputPath: string): Promise<void> {
  const pcm = await mixManifestAudioPcm(manifest);
  if (!pcm) {
    if (videoPath !== outputPath) await rename(videoPath, outputPath);
    return;
  }
  const tempOut = `${outputPath}.mixing.mp4`;
  await muxPcmWithVideo(videoPath, pcm, tempOut);
  await rm(outputPath, { force: true });
  await rename(tempOut, outputPath);
  if (videoPath !== outputPath) await rm(videoPath, { force: true });
}
