/**
 * Local export — fast source decode via WebCodecs + mp4box (Phase L3).
 *
 * Replaces per-frame <video> seeking (the dominant export cost) with a forward, bounded
 * `VideoDecoder` fed from an mp4box demux. Export reads time monotonically, so we decode
 * forward and hold the current frame; a backward jump (a new clip starting earlier in the
 * same source) resets to the nearest keyframe. Returns null when the file can't be
 * demuxed/decoded so the caller falls back to the <video> provider.
 */

import { createFile, DataStream, type MP4File, type MP4Sample, type MP4VideoTrackInfo } from "mp4box";
import type { FrameProvider } from "./source-decoder";

function getDescription(file: MP4File, trackId: number): Uint8Array | undefined {
  const entry = file.getTrackById(trackId)?.mdia?.minf?.stbl?.stsd?.entries?.[0];
  const box = entry?.avcC ?? entry?.hvcC ?? entry?.vpcC ?? entry?.av1C;
  if (!box) return undefined;
  const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
  box.write(stream);
  return new Uint8Array(stream.buffer, 8); // strip the 8-byte box header
}

function rejectAfter(ms: number): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error("mp4box timeout")), ms));
}

export async function createWebCodecsVideoSource(url: string): Promise<FrameProvider | null> {
  if (typeof VideoDecoder === "undefined" || typeof EncodedVideoChunk === "undefined") return null;

  let buffer: ArrayBuffer;
  try {
    buffer = await (await fetch(url)).arrayBuffer();
  } catch {
    return null;
  }

  const file = createFile();
  const samples: MP4Sample[] = [];
  const ready = new Promise<{ track: MP4VideoTrackInfo; description: Uint8Array | undefined }>((resolve, reject) => {
    file.onError = (error) => reject(new Error(error));
    file.onReady = (info) => {
      const track = info.videoTracks?.[0];
      if (!track) {
        reject(new Error("no video track"));
        return;
      }
      resolve({ track, description: getDescription(file, track.id) });
    };
  });
  file.onSamples = (_id, _user, list) => {
    for (const sample of list) samples.push(sample);
  };

  const view = buffer as ArrayBuffer & { fileStart: number };
  view.fileStart = 0;
  let track: MP4VideoTrackInfo;
  let description: Uint8Array | undefined;
  try {
    file.appendBuffer(view);
    file.flush();
    const resolved = await Promise.race([ready, rejectAfter(8000)]);
    track = resolved.track;
    description = resolved.description;
    file.setExtractionOptions(track.id, null, { nbSamples: track.nb_samples || 1_000_000 });
    file.start();
    file.flush();
    file.stop();
  } catch {
    return null;
  }
  if (!samples.length) return null;

  const timescale = track.timescale || 1;
  const toMicros = (t: number) => Math.round((t / timescale) * 1_000_000);
  const chunks = samples.map(
    (sample) =>
      new EncodedVideoChunk({
        type: sample.is_sync ? "key" : "delta",
        timestamp: toMicros(sample.cts),
        duration: toMicros(sample.duration),
        data: sample.data,
      })
  );
  samples.length = 0;

  const keyIndices: number[] = [];
  chunks.forEach((chunk, index) => {
    if (chunk.type === "key") keyIndices.push(index);
  });
  if (!keyIndices.length) keyIndices.push(0);

  const trackW = track.video?.width ?? track.track_width ?? 0;
  const trackH = track.video?.height ?? track.track_height ?? 0;

  const queue: VideoFrame[] = [];
  let failed = false;
  const decoder = new VideoDecoder({
    output: (frame) => queue.push(frame),
    error: () => {
      failed = true;
    },
  });
  const configure = () => {
    const config: VideoDecoderConfig = { codec: track.codec };
    if (trackW) config.codedWidth = trackW;
    if (trackH) config.codedHeight = trackH;
    if (description) config.description = description;
    decoder.configure(config);
  };
  try {
    configure();
  } catch {
    return null;
  }

  let fed = 0;
  let current: VideoFrame | null = null;
  let lastMicros = -1;

  const keyAtOrBefore = (chunkIndex: number) => {
    let k = keyIndices[0]!;
    for (const ki of keyIndices) {
      if (ki <= chunkIndex) k = ki;
      else break;
    }
    return k;
  };
  const chunkIndexForMicros = (micros: number) => {
    let index = 0;
    for (let i = 0; i < chunks.length; i += 1) {
      if (chunks[i]!.timestamp <= micros) index = i;
      else break;
    }
    return index;
  };
  const yieldTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  function resetTo(chunkIndex: number) {
    try {
      decoder.reset();
      configure();
    } catch {
      failed = true;
    }
    for (const frame of queue) frame.close();
    queue.length = 0;
    if (current) {
      current.close();
      current = null;
    }
    fed = keyAtOrBefore(chunkIndex);
  }

  async function getFrame(sourceTimeSeconds: number): Promise<CanvasImageSource | null> {
    if (failed) return null;
    const micros = Math.max(0, Math.round(sourceTimeSeconds * 1_000_000));
    if (lastMicros < 0) {
      fed = keyAtOrBefore(chunkIndexForMicros(micros));
    } else if (micros + 1000 < lastMicros) {
      resetTo(chunkIndexForMicros(micros)); // backward jump
    }
    lastMicros = micros;

    const MAX = 32;
    let guard = 0;
    while (!failed && guard++ < 50000) {
      if (queue.length > 0 && queue[queue.length - 1]!.timestamp > micros) break; // decoded past target
      if (fed >= chunks.length) {
        try {
          await decoder.flush();
        } catch {
          failed = true;
        }
        break;
      }
      while (fed < chunks.length && decoder.decodeQueueSize < MAX && queue.length < MAX) {
        try {
          decoder.decode(chunks[fed++]!);
        } catch {
          failed = true;
          break;
        }
      }
      await yieldTask();
    }

    while (queue.length && queue[0]!.timestamp <= micros) {
      if (current) current.close();
      current = queue.shift()!;
    }
    if (!current && queue.length) current = queue.shift()!;
    return current;
  }

  return {
    get width() {
      return current?.displayWidth ?? trackW;
    },
    get height() {
      return current?.displayHeight ?? trackH;
    },
    getFrame,
    dispose() {
      for (const frame of queue) frame.close();
      queue.length = 0;
      if (current) {
        current.close();
        current = null;
      }
      try {
        decoder.close();
      } catch {
        /* already closed */
      }
    },
  };
}
