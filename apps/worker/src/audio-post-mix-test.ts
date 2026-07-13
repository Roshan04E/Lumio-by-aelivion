/**
 * Standalone assert script for the cloud audio post-mix (repo convention: no framework,
 * exits non-zero on failure).
 *
 *   pnpm --filter @kimera-by-aelivion/worker audio:postmix:test
 *
 * Part 1 (pure): mixManifestAudioPcm with an injected decoder — trim/speed/gain/pan math.
 * Part 2 (integration): real ffmpeg — synthesize a sine WAV + a color video, run the full
 * postMixManifestAudio, then measure per-channel loudness of the muxed mp4 (hard-left pan
 * must leave the right channel silent).
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import type { RenderManifest, RenderManifestLayer } from "@kimera-by-aelivion/render-templates";
import { manifestNeedsAudioPostMix, mixManifestAudioPcm, postMixManifestAudio } from "./audio-post-mix";

let failures = 0;
function check(name: string, condition: boolean): void {
  if (condition) console.log(`  ok  ${name}`);
  else {
    failures += 1;
    console.error(`FAIL  ${name}`);
  }
}

const RATE = 48_000;

function makeManifest(layers: Partial<RenderManifestLayer>[], durationSeconds: number): RenderManifest {
  return {
    output: { durationSeconds },
    layers: layers.map((layer, i) => ({
      id: `a${i}`,
      type: "audio",
      assetUrl: layer.assetUrl ?? "mem://ramp",
      startSeconds: 0,
      durationSeconds,
      effects: [],
      keyframes: [],
      animations: [],
      ...layer,
    })),
  } as never as RenderManifest;
}

/** Interleaved stereo ramp: L[i] = i/N, R[i] = -i/N — position-decodable for exact assertions. */
function rampPcm(seconds: number): Float32Array {
  const frames = Math.ceil(seconds * RATE);
  const pcm = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    pcm[i * 2] = i / frames;
    pcm[i * 2 + 1] = -i / frames;
  }
  return pcm;
}

async function pureChecks() {
  const source = rampPcm(10);
  const decode = async () => source;
  const near = (a: number, b: number, eps = 1e-3) => Math.abs(a - b) < eps;

  // Identity: pan 0, speed 1, sourceIn 0 → passthrough.
  const identity = (await mixManifestAudioPcm(makeManifest([{}], 2), decode))!;
  const probe = Math.round(1.0 * RATE);
  check("identity passthrough (L)", near(identity[probe * 2]!, source[probe * 2]!));
  check("identity passthrough (R)", near(identity[probe * 2 + 1]!, source[probe * 2 + 1]!));

  // Source-in trim: sourceIn 2 → output t reads source t+2.
  const trimmed = (await mixManifestAudioPcm(makeManifest([{ sourceInSeconds: 2 }], 2), decode))!;
  check("sourceIn trim offsets reads", near(trimmed[probe * 2]!, source[Math.round(3 * RATE) * 2]!));

  // Rate stretch: speed 2 → output t reads source 2t.
  const sped = (await mixManifestAudioPcm(makeManifest([{ speed: 2 }], 2), decode))!;
  check("speed 2 reads source at 2x position", near(sped[probe * 2]!, source[Math.round(2 * RATE) * 2]!));

  // Track fader halves.
  const faded = (await mixManifestAudioPcm(makeManifest([{ trackGain: 0.5 }], 2), decode))!;
  check("track fader scales gain", near(faded[probe * 2]!, source[probe * 2]! * 0.5));

  // Hard-left pan (StereoPanner stereo law): L' = L + R, R' = 0.
  const left = (await mixManifestAudioPcm(makeManifest([{ trackPan: -1 }], 2), decode))!;
  check("hard-left pan sums R into L", near(left[probe * 2]!, source[probe * 2]! + source[probe * 2 + 1]!));
  check("hard-left pan silences R", near(left[probe * 2 + 1]!, 0));

  // Hard-right pan: R' = R + L, L' = 0.
  const right = (await mixManifestAudioPcm(makeManifest([{ trackPan: 1 }], 2), decode))!;
  check("hard-right pan silences L", near(right[probe * 2]!, 0));
  check("hard-right pan sums L into R", near(right[probe * 2 + 1]!, source[probe * 2 + 1]! + source[probe * 2]!));

  // Clip delay: startSeconds 1 → silence before 1s, ramp after.
  const delayed = (await mixManifestAudioPcm(makeManifest([{ startSeconds: 1, durationSeconds: 1 }], 2), decode))!;
  check("delayed clip is silent before its start", delayed[Math.round(0.5 * RATE) * 2] === 0);
  check("delayed clip plays source from its in-point", near(delayed[Math.round(1.5 * RATE) * 2]!, source[Math.round(0.5 * RATE) * 2]!));

  // Two clips sum.
  const summed = (await mixManifestAudioPcm(makeManifest([{}, {}], 2), decode))!;
  check("overlapping clips sum", near(summed[probe * 2]!, source[probe * 2]! * 2));

  // Speed ramp (time remap): 1→2 over [0,2] ⇒ at t=1 the closed-form integral has consumed
  // ∫₀¹(1→1.5) = 1.25 source seconds — the mix must read the source there, not at t*speed.
  const rampManifest = makeManifest([{ speedKeyframes: [{ timeSeconds: 0, value: 1 }, { timeSeconds: 2, value: 2 }] } as never], 2);
  check("speed ramp triggers post-mix", manifestNeedsAudioPostMix(rampManifest));
  const ramped = (await mixManifestAudioPcm(rampManifest, decode))!;
  check("speed ramp reads the trapezoid-integral source position", near(ramped[probe * 2]!, source[Math.round(1.25 * RATE) * 2]!));

  await fxChecks();
}

/** Interleaved stereo sine at `freq`/`amp` — spectral/dynamics fixture for the FX chain checks. */
function sinePcm(freq: number, seconds: number, amp: number): Float32Array {
  const frames = Math.ceil(seconds * RATE);
  const pcm = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    const v = amp * Math.sin((2 * Math.PI * freq * i) / RATE);
    pcm[i * 2] = v;
    pcm[i * 2 + 1] = v;
  }
  return pcm;
}

/** RMS (dB) of the mixed LEFT channel over [0.5s, 1.5s] — skips FX attack/settle transients. */
function mixRmsDb(mix: Float32Array): number {
  const start = Math.round(0.5 * RATE);
  const end = Math.round(1.5 * RATE);
  let sumSq = 0;
  for (let i = start; i < end; i += 1) sumSq += mix[i * 2]! * mix[i * 2]!;
  return 20 * Math.log10(Math.max(1e-9, Math.sqrt(sumSq / (end - start))));
}

function fxEffect(type: string, params: Record<string, number>) {
  return { id: `fx-${type}`, type, name: type, enabled: true, intensity: 100, params };
}

/** Clip audio FX through the SHARED DSP (packages/shared/audio-fx.ts) — the new post-mix trigger + chain. */
async function fxChecks() {
  // Trigger: FX (like pan) must route the render through the post-mix; a plain manifest must not.
  check("plain manifest needs no post-mix", !manifestNeedsAudioPostMix(makeManifest([{}], 2)));
  check(
    "audio FX triggers post-mix",
    manifestNeedsAudioPostMix(makeManifest([{ effects: [fxEffect("audioEq", { highCutHz: 1000 })] } as never], 2))
  );

  // EQ high-cut at 1kHz kills an 8kHz tone (2nd-order lowpass, 3 octaves up ≈ −36dB) but passes 200Hz.
  const hi = sinePcm(8000, 2, 0.5);
  const eqManifest = (pcm: Float32Array) =>
    mixManifestAudioPcm(makeManifest([{ effects: [fxEffect("audioEq", { highCutHz: 1000 })] } as never], 2), async () => pcm);
  const eqHi = (await eqManifest(hi))!;
  const eqLo = (await eqManifest(sinePcm(200, 2, 0.5)))!;
  check(`EQ high-cut attenuates 8kHz (${mixRmsDb(eqHi).toFixed(1)} dB)`, mixRmsDb(eqHi) < -30);
  check(`EQ high-cut passes 200Hz (${mixRmsDb(eqLo).toFixed(1)} dB)`, mixRmsDb(eqLo) > -12);

  // Limiter: −6dB ceiling caps a 0.9-amp tone to ≈0.5 linear peak.
  const limited = (await mixManifestAudioPcm(
    makeManifest([{ effects: [fxEffect("audioLimiter", { ceilingDb: -6, releaseMs: 50 })] } as never], 2),
    async () => sinePcm(440, 2, 0.9)
  ))!;
  let peak = 0;
  for (let i = Math.round(0.5 * RATE); i < Math.round(1.5 * RATE); i += 1) peak = Math.max(peak, Math.abs(limited[i * 2]!));
  check(`limiter caps peaks at the ceiling (peak ${peak.toFixed(3)})`, peak <= 0.51);

  // Gate: a −50dB tone under a −30dB threshold gates to (near) silence; a loud tone passes.
  const gate = fxEffect("audioGate", { thresholdDb: -30, reduceDb: 80, attackMs: 2, holdMs: 10, releaseMs: 50 });
  const gatedQuiet = (await mixManifestAudioPcm(makeManifest([{ effects: [gate] } as never], 2), async () => sinePcm(440, 2, 0.003)))!;
  const gatedLoud = (await mixManifestAudioPcm(makeManifest([{ effects: [gate] } as never], 2), async () => sinePcm(440, 2, 0.5)))!;
  check(`gate silences below threshold (${mixRmsDb(gatedQuiet).toFixed(1)} dB)`, mixRmsDb(gatedQuiet) < -70);
  check(`gate passes above threshold (${mixRmsDb(gatedLoud).toFixed(1)} dB)`, mixRmsDb(gatedLoud) > -12);

  // Compressor: −6dBFS tone over a −20dB threshold at 4:1 → roughly 10dB of reduction (soft knee).
  const compressed = (await mixManifestAudioPcm(
    makeManifest([{ effects: [fxEffect("audioCompressor", { thresholdDb: -20, ratio: 4, kneeDb: 0, attackMs: 1, releaseMs: 100, makeupDb: 0 })] } as never], 2),
    async () => sinePcm(440, 2, 0.5)
  ))!;
  const inputDb = mixRmsDb((await mixManifestAudioPcm(makeManifest([{}], 2), async () => sinePcm(440, 2, 0.5)))!);
  const outputDb = mixRmsDb(compressed);
  const reduction = inputDb - outputDb;
  check(`compressor reduces gain above threshold (${reduction.toFixed(1)} dB reduction)`, reduction > 6 && reduction < 14);
}

function run(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath as string, args);
    let stderr = "";
    proc.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 ? resolve(stderr) : reject(new Error(`ffmpeg ${code}: ${stderr.slice(0, 300)}`))));
  });
}

async function meanVolumeDb(file: string, channel: 0 | 1): Promise<number> {
  const stderr = await run(["-hide_banner", "-i", file, "-map", "0:a:0", "-af", `pan=mono|c0=c${channel},volumedetect`, "-f", "null", "-"]);
  const match = stderr.match(/mean_volume:\s*(-?[\d.]+) dB/);
  if (!match) throw new Error("volumedetect produced no mean_volume");
  return Number(match[1]);
}

async function integrationChecks() {
  if (!ffmpegPath) {
    console.log("  skip integration (no ffmpeg binary)");
    return;
  }
  const dir = mkdtempSync(path.join(tmpdir(), "kimera-postmix-"));
  try {
    const wav = path.join(dir, "tone.wav");
    const video = path.join(dir, "video.mp4");
    const out = path.join(dir, "out.mp4");
    // 2s 440Hz stereo tone + 2s black 30fps video (video deliberately has NO audio stream).
    await run(["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-ac", "2", wav]);
    await run(["-y", "-f", "lavfi", "-i", "color=c=black:s=320x240:d=2:r=30", "-c:v", "libx264", "-pix_fmt", "yuv420p", video]);

    const manifest = makeManifest([{ assetUrl: wav, trackPan: -1 }], 2);
    await postMixManifestAudio(manifest, video, out);

    const leftDb = await meanVolumeDb(out, 0);
    const rightDb = await meanVolumeDb(out, 1);
    check(`muxed left channel carries the tone (${leftDb.toFixed(1)} dB)`, leftDb > -20);
    check(`muxed right channel is silent (${rightDb.toFixed(1)} dB)`, rightDb < -60);
    check("video stream survived the mux", (await run(["-hide_banner", "-i", out, "-f", "null", "-"])).includes("Video"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  await pureChecks();
  await integrationChecks();
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll audio post-mix checks passed");
}

void main().catch((error) => {
  console.error("FAILED:", error);
  process.exit(1);
});
