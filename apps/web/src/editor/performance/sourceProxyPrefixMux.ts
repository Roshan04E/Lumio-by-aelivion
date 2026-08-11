/**
 * PARTIAL (prefix) source proxies — turning a half-finished build into something playable.
 * 2026-08-11, Slice 3 of `plans/source-proxy-progressive.md`.
 *
 * Slice 1 persists a build's encoded chunks as segments; Slice 2 fills them playhead-first. Neither
 * is playable: a segment is a chunk bundle, not a container. This module muxes the contiguous
 * segment prefix `[0, k)` into ONE ordinary MP4 — the same `fastStart: "in-memory"` shape every
 * finished proxy has, so `demuxIndex` and the WebCodecs preview pool handle it with no special case.
 *
 * WHY A PREFIX AND NOT THE COVERED RUN. Slice 2 can leave a covered run that starts above zero
 * (playhead-first wraps). A file muxed from segments `[a, b)` with `a > 0` would either carry
 * timestamps starting at `a` — in which case a request below `a` clamps to the FIRST sample and
 * shows the wrong picture — or be rebased to zero, in which case every source time is off by `a`
 * and the picture is wrong everywhere. Both are silent wrong-picture bugs. Preserving the exact
 * source-time mapping is non-negotiable, and only a prefix does that with no offset anywhere.
 * The cost is real and is named in the plan: playhead-first order defers when a usable prefix
 * appears.
 *
 * WHY NO ENCODER. Muxing needs no `VideoEncoder`, and allocating one here would put a second
 * hardware encoder session against the build that is still running — this repo's recurring
 * contention shape. `mp4-muxer` is driven directly with the chunks the cache already holds.
 *
 * VIDEO ONLY. A finished proxy carries AAC muxed from one pre-decoded PCM buffer at the END of the
 * build, so no audio exists in the cache to write here. Audio layers must therefore never be routed
 * to a partial proxy — that gate lives in the preview's routing, and the plan states the exclusion.
 */

import { ArrayBufferTarget, Muxer } from "mp4-muxer";
import { decodeSegment, descriptionFromBase64, segmentToChunks, type SegmentHeader } from "./sourceProxySegments";
import { getSourceProxySegment, listSourceProxySegmentIndices, SOURCE_PROXY_VERSION } from "./sourceProxyStore";

export interface PrefixProxy {
  blob: Blob;
  /**
   * Source seconds this file covers, from 0. A layer may only be routed here when every source time
   * it can ever request is BELOW this — see `sourceProxyCoverage.ts` for why that is not a
   * conservatism but the only thing standing between this feature and a frozen tail.
   */
  coverageSeconds: number;
  segmentCount: number;
  frameCount: number;
  width: number;
  height: number;
}

/**
 * How many contiguous segments from 0 the cache holds for this asset, and their frame extent.
 * Cheap-ish (one OPFS listing + one header parse per segment) and deliberately separate from
 * `buildPrefixProxy` so callers can decide whether a re-mux is worth it before paying for one.
 */
export async function measurePrefixCoverage(
  assetId: string,
  sourceByteSize: number,
  segmentFrames: number
): Promise<{ segmentCount: number; endFrame: number } | null> {
  const present = new Set(await listSourceProxySegmentIndices(assetId));
  if (!present.has(0)) return null;
  let segmentCount = 0;
  let endFrame = 0;
  for (let index = 0; present.has(index); index += 1) {
    const header = await readHeader(assetId, index, sourceByteSize, segmentFrames);
    if (!header) break;
    segmentCount += 1;
    endFrame = header.endFrame;
  }
  return segmentCount > 0 ? { segmentCount, endFrame } : null;
}

async function readHeader(
  assetId: string,
  index: number,
  sourceByteSize: number,
  segmentFrames: number
): Promise<SegmentHeader | null> {
  const blob = await getSourceProxySegment(assetId, index);
  if (!blob) return null;
  const parsed = await decodeSegment(blob);
  if (!parsed) return null;
  const { header } = parsed;
  // The same guards `collectResumeSegments` applies. A partial proxy is played, not just replayed,
  // so a mismatch here would put the wrong footage on screen rather than merely waste a rebuild.
  if (
    header.assetId !== assetId ||
    header.sourceByteSize !== sourceByteSize ||
    header.version !== SOURCE_PROXY_VERSION ||
    header.segmentIndex !== index ||
    header.startFrame !== index * segmentFrames ||
    header.endFrame <= header.startFrame
  ) {
    return null;
  }
  return header;
}

/**
 * Mux the contiguous prefix into a playable MP4. Returns null when there is nothing usable — every
 * failure path here is a MISS, never a partial file: the caller then leaves the asset on the
 * original, which is exactly today's behaviour.
 */
export async function buildPrefixProxy(
  assetId: string,
  sourceByteSize: number,
  segmentFrames: number
): Promise<PrefixProxy | null> {
  const present = new Set(await listSourceProxySegmentIndices(assetId));
  if (!present.has(0)) return null;

  let muxer: Muxer<ArrayBufferTarget> | null = null;
  let target: ArrayBufferTarget | null = null;
  let frameCount = 0;
  let segmentCount = 0;
  let fps = 0;
  let width = 0;
  let height = 0;

  for (let index = 0; present.has(index); index += 1) {
    const blob = await getSourceProxySegment(assetId, index);
    if (!blob) break;
    const parsed = await decodeSegment(blob);
    if (!parsed) break;
    const { header } = parsed;
    if (
      header.assetId !== assetId ||
      header.sourceByteSize !== sourceByteSize ||
      header.version !== SOURCE_PROXY_VERSION ||
      header.segmentIndex !== index ||
      header.startFrame !== index * segmentFrames ||
      header.endFrame <= header.startFrame
    ) {
      break;
    }
    // Every segment must agree on geometry/cadence — they are one encode, so a disagreement means
    // the cache is mixed and none of it can be trusted for playback.
    if (index === 0) {
      fps = header.fps;
      width = header.width;
      height = header.height;
      if (!fps || !width || !height || !header.codec || !header.descriptionBase64) return null;
      target = new ArrayBufferTarget();
      muxer = new Muxer({
        target,
        fastStart: "in-memory",
        video: { codec: "avc", width, height },
      });
    } else if (header.fps !== fps || header.width !== width || header.height !== height) {
      break;
    }
    if (!muxer) return null;

    const chunks = segmentToChunks(header, parsed.payloads);
    for (let c = 0; c < chunks.length; c += 1) {
      muxer.addVideoChunk(
        chunks[c]!,
        // Only the first chunk of the file carries a decoderConfig — that is what becomes `avcC`
        // (and, through its colorSpace, `colr`). Every segment stamps the same pinned config.
        frameCount === 0
          ? {
              decoderConfig: {
                codec: header.codec!,
                description: descriptionFromBase64(header.descriptionBase64)!,
                codedWidth: width,
                codedHeight: height,
                ...(header.colorSpace ? { colorSpace: header.colorSpace } : {}),
              },
            }
          : undefined
      );
      frameCount += 1;
    }
    segmentCount += 1;
    // Release as we go: the prefix and the muxer's buffer then sum to one bitstream rather than
    // holding two copies, the same property Slice 2's deferred mux relies on.
    parsed.payloads.length = 0;
    // Yield between segments — this runs on the MAIN thread (the build worker is busy) and a
    // 15-segment prefix is tens of MB of copying. One yield per segment keeps input responsive.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  if (!muxer || !target || frameCount === 0) return null;
  try {
    muxer.finalize();
  } catch {
    return null;
  }
  return {
    blob: new Blob([target.buffer], { type: "video/mp4" }),
    // Coverage is stated in SOURCE SECONDS from the muxed frame count, never from the segment count
    // times a nominal length: a short final segment (tail overshoot) would otherwise overstate it,
    // and an overstated coverage is precisely a frozen tail.
    coverageSeconds: frameCount / fps,
    segmentCount,
    frameCount,
    width,
    height,
  };
}
