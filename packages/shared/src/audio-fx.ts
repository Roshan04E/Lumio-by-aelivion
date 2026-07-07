/**
 * Clip audio FX — ONE DSP implementation for all three renderers.
 *
 * The chain is declared as ordinary `TimelineEffect`s on an audio layer (types `audioEq` /
 * `audioCompressor` / `audioGate` / `audioLimiter`, registry entries in effects.ts), resolved here
 * into plain parameter structs, and processed by {@link createAudioFxProcessor}:
 *
 *  - web preview: an AudioWorklet whose module source EMBEDS `createAudioFxProcessor.toString()`
 *    (see apps/web/src/playback/audio-fx-worklet.ts) — the factory must therefore stay fully
 *    self-contained: no imports, no outer-scope references, or the worklet breaks at runtime
 *    while typecheck stays green.
 *  - local export: apps/web/src/export/audio-mixer.ts renders FX'd clips through the same factory
 *    before scheduling them into the OfflineAudioContext.
 *  - cloud export: apps/worker/src/audio-post-mix.ts runs it in Node on the ffmpeg-decoded PCM.
 *
 * Chain position (all renderers): source → [FX in the layer's effect order] → clip volume/fades →
 * track fader/pan → mix bus. FX process in TIMELINE time, i.e. after rate-stretch varispeed, so an
 * EQ band stays at its dialed frequency regardless of clip speed.
 *
 * v1 scope: params are static per clip (not keyframeable) and `intensity` is ignored — dynamics
 * with a wet/dry blend stop behaving like dynamics. Filters are RBJ/Audio-EQ-Cookbook biquads
 * (bit-identical math to Web Audio's BiquadFilterNode); dynamics are stereo-linked one-pole
 * envelope followers with soft knee — deliberately lookahead-free so the preview worklet adds
 * zero latency.
 */

/* eslint-disable @typescript-eslint/no-non-null-assertion */

export interface AudioEqParams {
  kind: "eq";
  /** Highpass cutoff Hz; 0 disables the band. */
  lowCutHz: number;
  lowShelfHz: number;
  lowShelfDb: number;
  midHz: number;
  midDb: number;
  midQ: number;
  highShelfHz: number;
  highShelfDb: number;
  /** Lowpass cutoff Hz; 0 disables the band. */
  highCutHz: number;
}

export interface AudioCompressorParams {
  kind: "compressor";
  thresholdDb: number;
  ratio: number;
  kneeDb: number;
  attackMs: number;
  releaseMs: number;
  makeupDb: number;
}

export interface AudioGateParams {
  kind: "gate";
  thresholdDb: number;
  /** Attenuation applied while closed (positive dB of reduction; 80 ≈ silence). */
  reduceDb: number;
  attackMs: number;
  holdMs: number;
  releaseMs: number;
}

export interface AudioLimiterParams {
  kind: "limiter";
  ceilingDb: number;
  releaseMs: number;
}

export type AudioFxStep = AudioEqParams | AudioCompressorParams | AudioGateParams | AudioLimiterParams;

export const AUDIO_FX_EFFECT_TYPES = ["audioEq", "audioCompressor", "audioGate", "audioLimiter"] as const;

/** Structural layer shape — accepts TimelineLayer and manifest layers alike (both carry effects[]). */
interface EffectsCarrier {
  effects?: unknown[] | undefined;
}

function fxNum(params: Record<string, unknown>, key: string, fallback: number): number {
  const value = params[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Resolve a layer's enabled audio FX (in the layer's effect order) into processor params.
 * Returns [] when the layer has no audio FX — every call site treats that as "untouched path".
 */
export function resolveAudioFxChain(layer: EffectsCarrier): AudioFxStep[] {
  const chain: AudioFxStep[] = [];
  for (const raw of layer.effects ?? []) {
    const effect = raw as { type?: unknown; enabled?: unknown; params?: unknown } | null;
    if (!effect || effect.enabled === false) continue;
    const params = (effect.params ?? {}) as Record<string, unknown>;
    switch (effect.type) {
      case "audioEq":
        chain.push({
          kind: "eq",
          lowCutHz: fxNum(params, "lowCutHz", 0),
          lowShelfHz: fxNum(params, "lowShelfHz", 120),
          lowShelfDb: fxNum(params, "lowShelfDb", 0),
          midHz: fxNum(params, "midHz", 1000),
          midDb: fxNum(params, "midDb", 0),
          midQ: fxNum(params, "midQ", 1),
          highShelfHz: fxNum(params, "highShelfHz", 8000),
          highShelfDb: fxNum(params, "highShelfDb", 0),
          highCutHz: fxNum(params, "highCutHz", 0),
        });
        break;
      case "audioCompressor":
        chain.push({
          kind: "compressor",
          thresholdDb: fxNum(params, "thresholdDb", -24),
          ratio: Math.max(1, fxNum(params, "ratio", 3)),
          kneeDb: Math.max(0, fxNum(params, "kneeDb", 6)),
          attackMs: Math.max(0.05, fxNum(params, "attackMs", 10)),
          releaseMs: Math.max(5, fxNum(params, "releaseMs", 150)),
          makeupDb: fxNum(params, "makeupDb", 0),
        });
        break;
      case "audioGate":
        chain.push({
          kind: "gate",
          thresholdDb: fxNum(params, "thresholdDb", -50),
          reduceDb: Math.max(0, fxNum(params, "reduceDb", 80)),
          attackMs: Math.max(0.05, fxNum(params, "attackMs", 2)),
          holdMs: Math.max(0, fxNum(params, "holdMs", 50)),
          releaseMs: Math.max(5, fxNum(params, "releaseMs", 120)),
        });
        break;
      case "audioLimiter":
        chain.push({
          kind: "limiter",
          ceilingDb: Math.min(0, fxNum(params, "ceilingDb", -1)),
          releaseMs: Math.max(5, fxNum(params, "releaseMs", 50)),
        });
        break;
      default:
        break;
    }
  }
  return chain;
}

/** True when the layer has at least one enabled audio FX effect (cheap needs-processing probe). */
export function layerHasAudioFx(layer: EffectsCarrier): boolean {
  return resolveAudioFxChain(layer).length > 0;
}

export interface AudioFxProcessor {
  /**
   * Process planar channels IN PLACE, `frameCount` frames from each channel's start. Stateful and
   * streaming: call repeatedly over consecutive blocks of the same signal. Mono input is processed
   * as one channel; dynamics stereo-link when two channels are present.
   */
  process(channels: Float32Array[], frameCount: number): void;
}

/**
 * Build a streaming processor for a resolved chain.
 *
 * SELF-CONTAINED BY CONTRACT: the preview worklet embeds this function via `.toString()` into a
 * Blob module, so its body must not reference ANY outer-scope identifier (imports, module helpers,
 * other exports). Everything it needs is defined inside. Keep it that way or the preview silently
 * loses FX while exports keep them.
 */
export function createAudioFxProcessor(chain: AudioFxStep[], sampleRate: number): AudioFxProcessor {
  type Biquad = { b0: number; b1: number; b2: number; a1: number; a2: number; x1: number[]; x2: number[]; y1: number[]; y2: number[] };

  const dbToLin = (db: number) => Math.pow(10, db / 20);

  // RBJ Audio EQ Cookbook — the exact formulas the Web Audio spec uses for BiquadFilterNode.
  function makeBiquad(type: "highpass" | "lowpass" | "lowshelf" | "highshelf" | "peaking", freq: number, q: number, gainDb: number): Biquad {
    const f = Math.min(sampleRate / 2 - 1, Math.max(1, freq));
    const w0 = (2 * Math.PI * f) / sampleRate;
    const cosW0 = Math.cos(w0);
    const sinW0 = Math.sin(w0);
    const A = Math.pow(10, gainDb / 40);
    const alpha = sinW0 / (2 * Math.max(1e-4, q));
    let b0 = 1;
    let b1 = 0;
    let b2 = 0;
    let a0 = 1;
    let a1 = 0;
    let a2 = 0;
    if (type === "highpass") {
      b0 = (1 + cosW0) / 2;
      b1 = -(1 + cosW0);
      b2 = (1 + cosW0) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cosW0;
      a2 = 1 - alpha;
    } else if (type === "lowpass") {
      b0 = (1 - cosW0) / 2;
      b1 = 1 - cosW0;
      b2 = (1 - cosW0) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cosW0;
      a2 = 1 - alpha;
    } else if (type === "peaking") {
      b0 = 1 + alpha * A;
      b1 = -2 * cosW0;
      b2 = 1 - alpha * A;
      a0 = 1 + alpha / A;
      a1 = -2 * cosW0;
      a2 = 1 - alpha / A;
    } else {
      // Shelves use the cookbook's fixed S=1 slope (matches BiquadFilterNode).
      const twoSqrtAAlpha = 2 * Math.sqrt(A) * sinW0 * Math.SQRT1_2;
      if (type === "lowshelf") {
        b0 = A * (A + 1 - (A - 1) * cosW0 + twoSqrtAAlpha);
        b1 = 2 * A * (A - 1 - (A + 1) * cosW0);
        b2 = A * (A + 1 - (A - 1) * cosW0 - twoSqrtAAlpha);
        a0 = A + 1 + (A - 1) * cosW0 + twoSqrtAAlpha;
        a1 = -2 * (A - 1 + (A + 1) * cosW0);
        a2 = A + 1 + (A - 1) * cosW0 - twoSqrtAAlpha;
      } else {
        b0 = A * (A + 1 + (A - 1) * cosW0 + twoSqrtAAlpha);
        b1 = -2 * A * (A - 1 + (A + 1) * cosW0);
        b2 = A * (A + 1 + (A - 1) * cosW0 - twoSqrtAAlpha);
        a0 = A + 1 - (A - 1) * cosW0 + twoSqrtAAlpha;
        a1 = 2 * (A - 1 - (A + 1) * cosW0);
        a2 = A + 1 - (A - 1) * cosW0 - twoSqrtAAlpha;
      }
    }
    return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0, x1: [0, 0], x2: [0, 0], y1: [0, 0], y2: [0, 0] };
  }

  function runBiquad(bq: Biquad, channels: Float32Array[], frameCount: number): void {
    for (let c = 0; c < channels.length; c += 1) {
      const data = channels[c]!;
      const s = Math.min(c, 1);
      let x1 = bq.x1[s]!;
      let x2 = bq.x2[s]!;
      let y1 = bq.y1[s]!;
      let y2 = bq.y2[s]!;
      for (let i = 0; i < frameCount; i += 1) {
        const x = data[i]!;
        const y = bq.b0 * x + bq.b1 * x1 + bq.b2 * x2 - bq.a1 * y1 - bq.a2 * y2;
        x2 = x1;
        x1 = x;
        y2 = y1;
        y1 = y;
        data[i] = y;
      }
      bq.x1[s] = x1;
      bq.x2[s] = x2;
      bq.y1[s] = y1;
      bq.y2[s] = y2;
    }
  }

  // One stage = a closure that processes a block in place, holding its own state.
  type Stage = (channels: Float32Array[], frameCount: number) => void;
  const stages: Stage[] = [];

  for (const step of chain) {
    if (step.kind === "eq") {
      const biquads: Biquad[] = [];
      if (step.lowCutHz >= 20) biquads.push(makeBiquad("highpass", step.lowCutHz, Math.SQRT1_2, 0));
      if (step.lowShelfDb !== 0) biquads.push(makeBiquad("lowshelf", step.lowShelfHz, 1, step.lowShelfDb));
      if (step.midDb !== 0) biquads.push(makeBiquad("peaking", step.midHz, step.midQ, step.midDb));
      if (step.highShelfDb !== 0) biquads.push(makeBiquad("highshelf", step.highShelfHz, 1, step.highShelfDb));
      if (step.highCutHz >= 200) biquads.push(makeBiquad("lowpass", step.highCutHz, Math.SQRT1_2, 0));
      if (biquads.length) {
        stages.push((channels, frameCount) => {
          for (const bq of biquads) runBiquad(bq, channels, frameCount);
        });
      }
    } else if (step.kind === "compressor") {
      // Stereo-linked peak follower in linear domain; gain computed in dB with a soft knee.
      const attackCoef = Math.exp(-1 / ((step.attackMs / 1000) * sampleRate));
      const releaseCoef = Math.exp(-1 / ((step.releaseMs / 1000) * sampleRate));
      const makeupLin = dbToLin(step.makeupDb);
      const threshold = step.thresholdDb;
      const knee = step.kneeDb;
      const slope = 1 - 1 / step.ratio;
      let env = 0;
      stages.push((channels, frameCount) => {
        const left = channels[0]!;
        const right = channels[1] ?? channels[0]!;
        for (let i = 0; i < frameCount; i += 1) {
          const peak = Math.max(Math.abs(left[i]!), Math.abs(right[i]!));
          env = peak > env ? attackCoef * env + (1 - attackCoef) * peak : releaseCoef * env + (1 - releaseCoef) * peak;
          const envDb = 20 * Math.log10(Math.max(1e-6, env));
          const over = envDb - threshold;
          let reductionDb = 0;
          if (knee > 0 && over > -knee / 2 && over < knee / 2) {
            const t = over + knee / 2;
            reductionDb = (slope * t * t) / (2 * knee);
          } else if (over >= knee / 2) {
            reductionDb = slope * over;
          }
          const gain = dbToLin(-reductionDb) * makeupLin;
          for (let c = 0; c < channels.length; c += 1) channels[c]![i] = channels[c]![i]! * gain;
        }
      });
    } else if (step.kind === "gate") {
      const attackCoef = Math.exp(-1 / ((step.attackMs / 1000) * sampleRate));
      const releaseCoef = Math.exp(-1 / ((step.releaseMs / 1000) * sampleRate));
      const holdSamples = Math.round((step.holdMs / 1000) * sampleRate);
      const thresholdLin = dbToLin(step.thresholdDb);
      const floor = dbToLin(-step.reduceDb);
      // Fast detector follower + separate smoothed gate gain (open fast, close after hold).
      let env = 0;
      let gateGain = 1;
      let holdLeft = 0;
      stages.push((channels, frameCount) => {
        const left = channels[0]!;
        const right = channels[1] ?? channels[0]!;
        for (let i = 0; i < frameCount; i += 1) {
          const peak = Math.max(Math.abs(left[i]!), Math.abs(right[i]!));
          env = peak > env ? 0.5 * env + 0.5 * peak : 0.9995 * env;
          let target: number;
          if (env >= thresholdLin) {
            target = 1;
            holdLeft = holdSamples;
          } else if (holdLeft > 0) {
            holdLeft -= 1;
            target = 1;
          } else {
            target = floor;
          }
          gateGain = target > gateGain ? attackCoef * gateGain + (1 - attackCoef) * target : releaseCoef * gateGain + (1 - releaseCoef) * target;
          for (let c = 0; c < channels.length; c += 1) channels[c]![i] = channels[c]![i]! * gateGain;
        }
      });
    } else {
      // Limiter: instant-attack gain computer with smoothed release, then a hard safety clamp at
      // the ceiling (no lookahead — the clamp catches the first-sample overshoot).
      const releaseCoef = Math.exp(-1 / ((step.releaseMs / 1000) * sampleRate));
      const ceilingLin = dbToLin(step.ceilingDb);
      let gain = 1;
      stages.push((channels, frameCount) => {
        const left = channels[0]!;
        const right = channels[1] ?? channels[0]!;
        for (let i = 0; i < frameCount; i += 1) {
          const peak = Math.max(Math.abs(left[i]!), Math.abs(right[i]!));
          const needed = peak * gain > ceilingLin ? ceilingLin / Math.max(1e-6, peak) : 1;
          gain = needed < gain ? needed : releaseCoef * gain + (1 - releaseCoef) * Math.min(1, needed);
          for (let c = 0; c < channels.length; c += 1) {
            const v = channels[c]![i]! * gain;
            channels[c]![i] = v > ceilingLin ? ceilingLin : v < -ceilingLin ? -ceilingLin : v;
          }
        }
      });
    }
  }

  return {
    process(channels: Float32Array[], frameCount: number): void {
      if (!channels.length || frameCount <= 0) return;
      for (const stage of stages) stage(channels, frameCount);
    },
  };
}

/** One-shot convenience for offline paths: run the whole chain over full planar channels in place. */
export function processAudioFxBuffer(chain: AudioFxStep[], channels: Float32Array[], sampleRate: number): void {
  if (!chain.length || !channels.length) return;
  createAudioFxProcessor(chain, sampleRate).process(channels, channels[0]!.length);
}
