/**
 * Preview-side clip audio FX — an AudioWorklet running the SHARED DSP.
 *
 * Parity strategy: instead of approximating the export chain with native nodes (BiquadFilterNode
 * matches, but DynamicsCompressorNode has its own adaptive-release curve and a gate doesn't exist),
 * the worklet module source EMBEDS `createAudioFxProcessor.toString()` from packages/shared — the
 * byte-identical function the local export mixer and the cloud worker post-mix execute. What you
 * hear in the editor IS the export DSP. The factory is self-contained by contract (see its doc
 * comment); this file is the reason.
 *
 * Loaded as a Blob URL so no bundler worklet plumbing is needed (worklet module scripts can't be
 * statically discovered by Vite the way `new Worker(new URL(...))` is). One module per
 * AudioContext, added lazily the first time a clip actually has FX — compositions without audio FX
 * never pay for it.
 *
 * Cost model (low-end contract): one AudioWorkletNode per FX'd clip, a few biquads + envelope
 * followers per 128-frame quantum on the AUDIO thread — microseconds, no main-thread work.
 */

import { createAudioFxProcessor, type AudioFxStep } from "@kimera-by-aelivion/shared";

const WORKLET_NAME = "kimera-audio-fx";

function buildModuleSource(): string {
  return `
// esbuild's keep-names transform (tsx always; Vite depending on config) injects \`__name(fn, "fn")\`
// helper CALLS into function bodies — the serialized factory would then reference an undefined
// outer helper. Shim it as identity; it only tags function names.
const __name = (fn) => fn;
const createAudioFxProcessor = ${createAudioFxProcessor.toString()};
class KimeraAudioFxProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const chain = (options && options.processorOptions && options.processorOptions.chain) || [];
    this.dsp = createAudioFxProcessor(chain, sampleRate);
    this.port.onmessage = (event) => {
      if (event.data && Array.isArray(event.data.chain)) {
        this.dsp = createAudioFxProcessor(event.data.chain, sampleRate);
      }
    };
  }
  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    if (!input || input.length === 0) {
      for (let c = 0; c < output.length; c += 1) output[c].fill(0);
      return true;
    }
    for (let c = 0; c < output.length; c += 1) {
      output[c].set(input[Math.min(c, input.length - 1)]);
    }
    this.dsp.process(output, output[0].length);
    return true;
  }
}
registerProcessor(${JSON.stringify(WORKLET_NAME)}, KimeraAudioFxProcessor);
`;
}

// One addModule per AudioContext (addModule is idempotent-ish but not free; cache the promise).
const moduleReady = new WeakMap<AudioContext, Promise<boolean>>();

/** Load the FX worklet module into `ctx` once. Resolves false where AudioWorklet is unavailable. */
export function ensureAudioFxWorklet(ctx: AudioContext): Promise<boolean> {
  const existing = moduleReady.get(ctx);
  if (existing) return existing;
  const ready = (async () => {
    if (typeof AudioWorkletNode === "undefined" || !ctx.audioWorklet) return false;
    const blob = new Blob([buildModuleSource()], { type: "text/javascript" });
    const url = URL.createObjectURL(blob);
    try {
      await ctx.audioWorklet.addModule(url);
      return true;
    } catch {
      return false; // CSP or platform quirk — preview simply skips FX; exports still apply them
    } finally {
      URL.revokeObjectURL(url);
    }
  })();
  moduleReady.set(ctx, ready);
  return ready;
}

/** Create an FX node for a resolved chain. Call only after {@link ensureAudioFxWorklet} resolved true. */
export function createAudioFxNode(ctx: AudioContext, chain: AudioFxStep[]): AudioWorkletNode {
  return new AudioWorkletNode(ctx, WORKLET_NAME, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: { chain },
  });
}

/** Swap the running chain (rebuilds the DSP on the audio thread; state resets, which is correct after an edit). */
export function updateAudioFxNode(node: AudioWorkletNode, chain: AudioFxStep[]): void {
  node.port.postMessage({ chain });
}
