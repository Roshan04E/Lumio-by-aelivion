/**
 * Shared preview audio graph: one AudioContext + a master bus with stereo metering taps.
 *
 * Before: each `AudioPreviewLayer` connected `element → GainNode → destination` directly, so the mix
 * had no single point to observe. Now every layer connects to a unity master GainNode
 * (`getPreviewMasterBusInput`) that feeds the destination — audibly IDENTICAL (unity gain, same
 * routing depth) — plus a ChannelSplitter → 2 AnalyserNodes tap for the timeline audio meters.
 *
 * Performance contract (the meters must never cost playback smoothness):
 *  - All signal analysis happens on the AUDIO thread (native AnalyserNode ring buffers).
 *  - `readPreviewMeter` is the only main-thread work: two `getFloatTimeDomainData` copies into
 *    PREALLOCATED buffers + a linear peak/RMS scan (~2×1024 floats ≈ tens of microseconds).
 *  - Nothing here ticks on its own; the meter component drives reads from its own rAF, which only
 *    runs while the transport is playing.
 *
 * The master input is forced to 2 channels ("explicit"/"speakers") so mono sources upmix and meter
 * on BOTH bars, like a hardware console — not just the left one.
 */

let sharedPreviewAudioContext: AudioContext | undefined;

/**
 * One shared AudioContext for all preview audio layers. Created lazily (and resumed on the play
 * gesture) so it satisfies the autoplay policy. Returns undefined where Web Audio is unavailable.
 * (Moved out of VideoPreview so the meters and the layers share one graph.)
 */
export function getPreviewAudioContext(): AudioContext | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) {
    return undefined;
  }
  sharedPreviewAudioContext ??= new Ctor();
  return sharedPreviewAudioContext;
}

interface MasterBus {
  input: GainNode;
  analyserL: AnalyserNode;
  analyserR: AnalyserNode;
  bufL: Float32Array;
  bufR: Float32Array;
}

let masterBus: MasterBus | undefined;

function getMasterBus(ctx: AudioContext): MasterBus {
  if (masterBus) return masterBus;
  const input = ctx.createGain();
  input.gain.value = 1; // unity — parity with the old direct-to-destination routing
  // Force stereo so mono sources upmix equally to L/R (meter on both bars, console-style).
  input.channelCount = 2;
  input.channelCountMode = "explicit";
  input.channelInterpretation = "speakers";
  input.connect(ctx.destination);
  const splitter = ctx.createChannelSplitter(2);
  input.connect(splitter);
  const makeAnalyser = () => {
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048; // ~46ms window at 44.1k — enough for honest RMS, cheap to copy
    analyser.smoothingTimeConstant = 0; // ballistics live in the meter component, not the FFT
    return analyser;
  };
  const analyserL = makeAnalyser();
  const analyserR = makeAnalyser();
  splitter.connect(analyserL, 0);
  splitter.connect(analyserR, 1);
  masterBus = { input, analyserL, analyserR, bufL: new Float32Array(2048), bufR: new Float32Array(2048) };
  return masterBus;
}

/** The node audio layers connect their gain into (replaces `ctx.destination` in the layer graph). */
export function getPreviewMasterBusInput(ctx: AudioContext): AudioNode {
  return getMasterBus(ctx).input;
}

export interface MeterLevels {
  peakL: number;
  peakR: number;
  rmsL: number;
  rmsR: number;
}

function scan(analyser: AnalyserNode, buf: Float32Array): { peak: number; rms: number } {
  analyser.getFloatTimeDomainData(buf as Float32Array<ArrayBuffer>);
  let peak = 0;
  let sumSq = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i]!;
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
    sumSq += v * v;
  }
  return { peak, rms: Math.sqrt(sumSq / buf.length) };
}

/**
 * Read the current master-mix levels (linear 0..1+) into `out`. Returns false when no audio layer has
 * ever connected (no bus yet) — the meters render silent then. Allocation-free.
 */
export function readPreviewMeter(out: MeterLevels): boolean {
  if (!masterBus) return false;
  const left = scan(masterBus.analyserL, masterBus.bufL);
  const right = scan(masterBus.analyserR, masterBus.bufR);
  out.peakL = left.peak;
  out.rmsL = left.rms;
  out.peakR = right.peak;
  out.rmsR = right.rms;
  return true;
}
