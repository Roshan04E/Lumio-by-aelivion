/**
 * DEBT-019 residency attribution, browser half. Plain JS (Vite serves it as a string to evaluate;
 * see pull-browser.js for why this is not TS).
 *
 * DEBT-019 claims a provider's resident bytes scale with clip DURATION because `fetchSourceBlob`
 * materialises the whole file. That claim decomposes into terms that can be measured SEPARATELY,
 * which is the point of this probe -- the full-provider number alone cannot tell a duration-scaling
 * Blob apart from a duration-independent decoder DPB, and those have different fixes (or none).
 *
 *   variant "blob"     : fetch(url).blob() only, held. No demux, no decoder.
 *                        This is exactly fetchSourceBlob's residency and nothing else.
 *   variant "provider" : the real createFrameProvider, pulled across the whole clip so the chunk
 *                        window actually pages. Blob + index + window + VideoDecoder + frames.
 *
 * Running both over the same corpus at the same N attributes the difference. Running each over a
 * 3s and a 120s corpus answers the duration question per term.
 */
(async function debt019Residency(args) {
  const held = [];
  const stats = { getFrameCalls: 0, decodeCalls: 0, nulls: 0, widths: 0, blobBytes: 0, indexSamples: 0 };

  // SOURCE-KIND experiment. The local-first path does NOT hand the decoder a remote URL: OPFS
  // assets are `URL.createObjectURL(await handle.getFile())` (asset-blob-store.ts), i.e. an object
  // URL over a DISK-BACKED File that already slices lazily at zero residency. `fetchSourceBlob`
  // then does fetch(url).blob() over it. These two variants ask whether that fetch is a free
  // handle pass-through or a disk->RAM copy -- if it is a copy, the local case and the remote case
  // are different defects and the local one needs no paging at all, just a shorter path.
  if (args.variant === "opfs-file" || args.variant === "opfs-fetch") {
    const root = await navigator.storage.getDirectory();
    for (let i = 0; i < args.n; i += 1) {
      const name = "debt019-" + i + ".bin";
      // Written once per fresh browser; each rung gets its own profile so nothing is reused.
      const handle = await root.getFileHandle(name, { create: true });
      const w = await handle.createWritable();
      const CHUNK = 4 << 20;
      const chunk = new Uint8Array(CHUNK);
      for (let k = 0; k < CHUNK; k += 4096) chunk[k] = (i + k) & 255; // defeat sparse-file/dedup
      for (let written = 0; written < args.fileBytes; written += CHUNK) {
        await w.write(chunk.subarray(0, Math.min(CHUNK, args.fileBytes - written)));
      }
      await w.close();

      const file = await handle.getFile();
      stats.blobBytes += file.size;
      if (args.variant === "opfs-file") {
        // Hold the File itself, exactly as a provider would if it kept the handle instead of a
        // fetched copy. Deliberately allocates NOTHING else: an earlier version sliced a 24MB span
        // per file and measured its own 144MB of scratch ArrayBuffers rather than File residency.
        held.push(file);
      } else {
        const url = URL.createObjectURL(file);
        const copy = await (await fetch(url)).blob();
        URL.revokeObjectURL(url);
        held.push(copy); // hold what fetchSourceBlob would have held
      }
    }
  } else if (args.variant === "blob") {
    for (let i = 0; i < args.n; i += 1) {
      const r = await fetch(args.mediaOrigin + "/" + args.clips[i], { cache: "no-store" });
      const b = await r.blob();
      stats.blobBytes += b.size;
      held.push(b);
    }
  } else {
    const sd = await import(/* @vite-ignore */ "/src/export/source-decoder.ts");
    const wc = await import(/* @vite-ignore */ "/src/export/webcodecs-decoder.ts");
    for (let i = 0; i < args.n; i += 1) {
      const p = await sd.createFrameProvider(args.mediaOrigin + "/" + args.clips[i], "video");
      // PROVE THE SUBSYSTEM RAN, and prove it PAGED: pull frames at several points spread across
      // the whole clip, not one frame at 0.5s. A single early pull would leave a 120s source's
      // chunk window sitting on its first span forever -- i.e. it would measure a provider that
      // never exercised the very code path (`ensure`) whose duration-scaling is in question.
      const end = p.decodableEndSeconds || 3;
      for (const frac of args.pullFractions) {
        const f = await p.getFrame(Math.max(0, Math.min(end - 0.05, end * frac)));
        stats.getFrameCalls += 1;
        if (!f) stats.nulls += 1;
      }
      stats.decodeCalls += p.__wcDecodeCalls || 0;
      stats.widths += p.width || 0;
      held.push(p);
    }
    stats.streaming = wc.wcDecoderStats.streaming;
    stats.fragmented = wc.wcDecoderStats.fragmented;
  }

  window.__debt019Held = held;
  return {
    n: args.n,
    variant: args.variant,
    jsHeapMB: ((performance.memory && performance.memory.usedJSHeapSize) || 0) / 1048576,
    stats,
  };
})
