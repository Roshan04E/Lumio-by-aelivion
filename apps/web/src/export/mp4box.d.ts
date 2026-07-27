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
    audio?: unknown;
    video?: { width: number; height: number };
    track_width?: number;
    track_height?: number;
  }

  export interface MP4Info {
    audioTracks?: MP4VideoTrackInfo[];
    videoTracks: MP4VideoTrackInfo[];
    tracks: MP4VideoTrackInfo[];
  }

  export interface MP4Sample {
    is_sync: boolean;
    cts: number;
    dts: number;
    duration: number;
    timescale: number;
    /** Present only on extraction (`onSamples`); sample-TABLE entries carry metadata only. */
    data?: Uint8Array;
    /** File position/byte length — populated by buildSampleLists (getTrackSamplesInfo entries). */
    offset?: number;
    size?: number;
    /** 0-based sample number within the track (for releaseUsedSamples). */
    number?: number;
  }

  interface BoxWritable {
    write(stream: DataStream): void;
    size: number;
  }
  /** `colr` box (ISO 14496-12) — source color signalling, parsed by mp4box.js when present. */
  interface ColrBox {
    /** 'nclx' (video), 'nclc' (legacy), 'rICC'/'prof' (ICC profile). Color codes valid for nclx/nclc. */
    colour_type: string;
    colour_primaries?: number;
    transfer_characteristics?: number;
    matrix_coefficients?: number;
    /** nclx only: 1 = full range, 0 = limited/studio range. */
    full_range_flag?: number;
  }
  /** `hvcC` (HEVC decoder config). mp4box parses the full record; we only need the bit depth. */
  interface HvcCBox extends BoxWritable {
    /** Luma bit depth is this + 8 — the field that identifies 10-bit sources. */
    bit_depth_luma_minus8?: number;
  }
  /** `avcC` (AVC decoder config). H.264 carries bit depth in the SPS, not here, but the profile
   *  indication distinguishes the 10-bit profiles (110 = High 10, 122 = High 4:2:2, 244 = High 4:4:4). */
  interface AvcCBox extends BoxWritable {
    AVCProfileIndication?: number;
  }
  interface SampleEntry {
    avcC?: AvcCBox;
    hvcC?: HvcCBox;
    vpcC?: BoxWritable;
    av1C?: BoxWritable;
    colr?: ColrBox;
  }
  /** `tkhd` (track header) — carries the 3x3 display `matrix` (9 fixed-point ints) for rotation/flip. */
  interface Tkhd {
    matrix?: number[];
  }
  interface Trak {
    tkhd?: Tkhd;
    mdia: { minf: { stbl: { stsd: { entries: SampleEntry[] } } } };
  }

  export interface MP4File {
    onReady?: (info: MP4Info) => void;
    onError?: (error: string) => void;
    onSamples?: (id: number, user: unknown, samples: MP4Sample[]) => void;
    /** Returns the file offset mp4box wants next (jumps over incomplete boxes like a tail-moov mdat). */
    appendBuffer(data: ArrayBuffer & { fileStart: number }): number;
    flush(): void;
    start(): void;
    stop(): void;
    setExtractionOptions(id: number, user?: unknown, options?: { nbSamples?: number }): void;
    getTrackById(id: number): Trak;
    /** Sample TABLE (metadata incl. offset/size/cts/is_sync) — no sample data required/held. */
    getTrackSamplesInfo?(id: number): MP4Sample[] | undefined;
    /** Frees mp4box-internal buffers for samples ≤ sampleNumber already handed to the app. */
    releaseUsedSamples?(id: number, sampleNumber: number): void;
  }

  export function createFile(): MP4File;
}
