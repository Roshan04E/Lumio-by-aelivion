export interface FrameSample {
  timestampSeconds: number;
  width: number;
  height: number;
  blob: Blob;
}

export interface AudioSample {
  durationSeconds: number;
  sampleRate: number;
  peaks: number[];
  channelCount: number;
}

export interface FrameSampleOptions {
  count?: number | undefined;
  width?: number | undefined;
  quality?: number | undefined;
}

export async function sampleVideoFrames(file: File, options: FrameSampleOptions = {}): Promise<FrameSample[]> {
  const count = Math.max(1, Math.min(options.count ?? 5, 24));
  const width = options.width ?? 360;
  const quality = options.quality ?? 0.72;
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "metadata";
  video.src = url;

  try {
    await waitForVideoMetadata(video);
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 1;
    const aspect = video.videoWidth > 0 && video.videoHeight > 0 ? video.videoHeight / video.videoWidth : 16 / 9;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = Math.max(1, Math.round(width * aspect));
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) {
      return [];
    }

    const frames: FrameSample[] = [];
    for (let index = 0; index < count; index += 1) {
      const timestampSeconds = count === 1 ? 0 : (duration * index) / (count - 1);
      await seekVideo(video, Math.min(duration, timestampSeconds));
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await canvasToBlob(canvas, quality);
      frames.push({
        timestampSeconds,
        width: canvas.width,
        height: canvas.height,
        blob
      });
    }
    return frames;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function sampleAudioPeaks(file: File, peakCount = 96): Promise<AudioSample> {
  const audioContext = createAudioContext();
  const arrayBuffer = await file.arrayBuffer();
  const decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0));
  const channel = decoded.getChannelData(0);
  const safePeakCount = Math.max(16, Math.min(peakCount, 512));
  const windowSize = Math.max(1, Math.floor(channel.length / safePeakCount));
  const peaks: number[] = [];

  for (let index = 0; index < safePeakCount; index += 1) {
    let peak = 0;
    const start = index * windowSize;
    const end = Math.min(channel.length, start + windowSize);
    for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
      peak = Math.max(peak, Math.abs(channel[sampleIndex] ?? 0));
    }
    peaks.push(Number(peak.toFixed(4)));
  }

  await audioContext.close().catch(() => undefined);

  return {
    durationSeconds: decoded.duration,
    sampleRate: decoded.sampleRate,
    peaks,
    channelCount: decoded.numberOfChannels
  };
}

function waitForVideoMetadata(video: HTMLVideoElement) {
  return new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () => reject(new Error("Unable to load video metadata"));
  });
}

function seekVideo(video: HTMLVideoElement, timestampSeconds: number) {
  return new Promise<void>((resolve, reject) => {
    video.onseeked = () => resolve();
    video.onerror = () => reject(new Error("Unable to seek video"));
    video.currentTime = timestampSeconds;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, quality: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error("Unable to create frame sample"));
        }
      },
      "image/jpeg",
      quality
    );
  });
}

function createAudioContext() {
  const AudioContextConstructor =
    globalThis.AudioContext ??
    (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

  if (!AudioContextConstructor) {
    throw new Error("AudioContext is unavailable");
  }

  return new AudioContextConstructor();
}
