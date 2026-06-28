/** Minimal ambient types for mp4box.js (the package ships no .d.ts). Only what we use. */
declare module "mp4box" {
  export class DataStream {
    static BIG_ENDIAN: boolean;
    constructor(buffer?: ArrayBuffer, byteOffset?: number, endianness?: boolean);
    buffer: ArrayBuffer;
  }

  export interface MP4VideoTrackInfo {
    id: number;
    codec: string;
    timescale: number;
    nb_samples: number;
    video?: { width: number; height: number };
    track_width?: number;
    track_height?: number;
  }

  export interface MP4Info {
    videoTracks: MP4VideoTrackInfo[];
    tracks: MP4VideoTrackInfo[];
  }

  export interface MP4Sample {
    is_sync: boolean;
    cts: number;
    dts: number;
    duration: number;
    timescale: number;
    data: Uint8Array;
  }

  interface BoxWritable {
    write(stream: DataStream): void;
    size: number;
  }
  interface SampleEntry {
    avcC?: BoxWritable;
    hvcC?: BoxWritable;
    vpcC?: BoxWritable;
    av1C?: BoxWritable;
  }
  interface Trak {
    mdia: { minf: { stbl: { stsd: { entries: SampleEntry[] } } } };
  }

  export interface MP4File {
    onReady?: (info: MP4Info) => void;
    onError?: (error: string) => void;
    onSamples?: (id: number, user: unknown, samples: MP4Sample[]) => void;
    appendBuffer(data: ArrayBuffer & { fileStart: number }): number;
    flush(): void;
    start(): void;
    stop(): void;
    setExtractionOptions(id: number, user?: unknown, options?: { nbSamples?: number }): void;
    getTrackById(id: number): Trak;
  }

  export function createFile(): MP4File;
}
