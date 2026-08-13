/**
 * DEBT-019 residual ATTRIBUTION, browser half. Plain JS (evaluated as a string; see pull-browser.js).
 *
 * The question this answers is NOT "how much" -- three rounds of ladders have answered that and two of
 * them attributed it wrongly. It is "WHAT HOLDS IT". The residual is ~15 MB/source at N=100 between a
 * 3s corpus and a 120s one, with every named term accounting for 0.086 MB of it.
 *
 * Per-term ABLATION. Each variant holds a provider built only as far as one construction stage, using
 * `wcAblationBuild` -- the REAL internals, not a replica of them (a replica would be the same
 * mis-attribution in a new costume). Differencing adjacent stages, on each corpus, prices each term
 * per second of source:
 *
 *   ab-bytes     sourceBlobFor only               (ranged remote / registry pass-through / whole copy)
 *   ab-index     + demuxIndex                     (mp4box parse -> typed sample columns)
 *   ab-window    + createBlobChunkWindow.ensure   (the <=24 MB feed window)
 *   ab-configure + a configured VideoDecoder      (never fed a chunk)
 *   pull1        the full provider, ONE pull      (one warmup, one GOP, no reset)
 *   pull4        the full provider, FOUR pulls    (the ladder's own shape -- GOP-crossing resets)
 *
 * pull4 minus pull1 is the term phase 2a guessed at ("decode/seek state under multi-point access") and
 * never measured. ab-configure minus ab-window prices decoder allocation with zero decode work.
 */
(async function debt019Attribution(args) {
  const held = [];
  const stats = { getFrameCalls: 0, decodeCalls: 0, nulls: 0, sampleCount: 0, byteSourceMB: 0, resets0: 0, resets1: 0 };
  const wc = await import(/* @vite-ignore */ "/src/export/webcodecs-decoder.ts");

  // BUILD IDENTITY for the file actually under measurement. `assertServingThisWorktree` fingerprints
  // scene-frame-compositor.ts, which this work does not touch, so it proves the dev server's ROOT and
  // not this module's content. The ablation entry point does not exist in any previous build, so its
  // presence is the direct positive check -- the same reasoning phase 2b used for `index ...smp`.
  if (typeof wc.wcAblationBuild !== "function") {
    throw new Error("wcAblationBuild absent -- the served build is not this worktree's webcodecs-decoder.ts");
  }

  const url = (i) => args.mediaOrigin + "/" + args.clips[i];
  const ABLATION = { "ab-bytes": "bytes", "ab-index": "index", "ab-window": "window", "ab-configure": "configure" };

  if (ABLATION[args.variant]) {
    const stage = ABLATION[args.variant];
    stats.buildNulls = 0;
    for (let i = 0; i < args.n; i += 1) {
      // `atSample` puts the feed window where the LAST pull would have left it (the ladder pulls at
      // 98% of the clip), not at sample 0 -- a window sitting on its first span has not exercised
      // `ensure` and would price a term the real provider never pays there.
      let h = await wc.wcAblationBuild(url(i), stage, 1 << 30);
      // One retry: a transient range read that misses the 20s demux race is a network event, not a
      // property of the stage. COUNTED either way -- a rung built from fewer sources than it claims
      // would silently understate its own per-source figure, which is the shape of error this whole
      // entry keeps making.
      if (!h) h = await wc.wcAblationBuild(url(i), stage, 1 << 30);
      if (!h) {
        stats.buildNulls += 1;
        continue;
      }
      stats.sampleCount += h.sampleCount;
      stats.byteSourceMB += h.byteSourceSize / 1048576;
      held.push(h);
    }
  } else {
    const sd = await import(/* @vite-ignore */ "/src/export/source-decoder.ts");
    const fractions = args.variant === "pull1" ? [0.02] : args.pullFractions;
    stats.resets0 = wc.wcDecoderResetStats.hardReset;
    for (let i = 0; i < args.n; i += 1) {
      const p = await sd.createFrameProvider(url(i), "video");
      const end = p.decodableEndSeconds || 3;
      for (const frac of fractions) {
        const f = await p.getFrame(Math.max(0, Math.min(end - 0.05, end * frac)));
        stats.getFrameCalls += 1;
        if (!f) stats.nulls += 1;
      }
      stats.decodeCalls += p.__wcDecodeCalls || 0;
      held.push(p);
    }
    stats.resets1 = wc.wcDecoderResetStats.hardReset;
    stats.streaming = wc.wcDecoderStats.streaming;
    stats.fragmented = wc.wcDecoderStats.fragmented;
  }

  const res = wc.sourceResidentBytes();
  stats.copiedBytes = res.copiedBytes;
  stats.passthroughBytes = res.passthroughBytes;
  stats.rangedBytes = res.rangedBytes;
  stats.rangedSources = res.rangedSources;
  stats.indexBytes = res.indexBytes;
  stats.indexSamples = res.indexSamples;

  window.__debt019Held = held;
  return {
    n: args.n,
    variant: args.variant,
    jsHeapMB: ((performance.memory && performance.memory.usedJSHeapSize) || 0) / 1048576,
    stats,
  };
})
