/**
 * Export settings — the shared contract for the unified "Export" window.
 *
 * ONE type drives BOTH export paths so the editor UI, the on-device WebCodecs encoder, and the
 * cloud Remotion renderer agree on what "export at these settings" means:
 *   - local  → apps/web/src/export (LocalExportRequest → MediaEncoderOptions)
 *   - cloud  → apps/api renderFinal writes these onto the render manifest's `output` (dims/fps) and
 *              `output.encode` (bitrate), which the worker's renderMedia reads.
 *
 * Bitrate-based (not CRF) on purpose: WebCodecs has no CRF, so a bitrate target + VBR/CBR mode is the
 * one knob both encoders share. Remotion takes the same `videoBitrate` (+ `encodingMaxRate` for a VBR
 * cap), keeping the two paths in parity.
 */

import { z } from "zod";
import type { TimelineComposition } from "./types";

export type ExportDestination = "local" | "cloud";
export type ExportFileFormat = "mp4" | "webm";
export type ExportBitrateMode = "vbr" | "cbr";
/** Which span of the timeline to export: the whole project, or the set In→Out work-area range. */
export type ExportRange = "full" | "inout";

export interface ExportSettings {
  /** Where the render runs. "cloud" forces MP4 (Remotion is H.264-only). */
  destination: ExportDestination;
  /** Container/codec. "webm" (VP9) is LOCAL-ONLY — the cloud renderer always emits MP4/H.264. */
  format: ExportFileFormat;
  /** Output-resolution multiplier of the composition size. 1 = full; 0.5 ≈ half. Presets pick this. */
  scale: number;
  /** Output frame rate. */
  fps: number;
  /**
   * Timeline span to render. "full" ignores In/Out points (whole project); "inout" honors them. Only
   * meaningful when In/Out is set — the UI offers the choice then, and defaults to "inout".
   */
  range: ExportRange;
  /**
   * Safe timeline: trim trailing frames that have no visual content (e.g. audio running past the last
   * clip), so the export doesn't end on black. Caps the out-point at the last visual layer's end.
   */
  trimTrailingBlack: boolean;
  bitrateMode: ExportBitrateMode;
  /** Target video bitrate, bits/s. */
  targetBitrate: number;
  /** VBR cap, bits/s. Ignored for CBR. */
  maxBitrate?: number;
}

/**
 * Runtime validation for the cloud export request body (POST /projects/:id/export). Bounds guard
 * against absurd values (a 0/negative scale, a 10000fps request). The inferred type matches
 * ExportSettings, so the API can pass parsed data straight into renderFinal.
 */
export const exportSettingsSchema = z.object({
  destination: z.enum(["local", "cloud"]),
  format: z.enum(["mp4", "webm"]),
  scale: z.number().positive().max(1),
  fps: z.number().positive().max(240),
  range: z.enum(["full", "inout"]),
  trimTrailingBlack: z.boolean(),
  bitrateMode: z.enum(["vbr", "cbr"]),
  targetBitrate: z.number().positive(),
  maxBitrate: z.number().positive().optional()
});

/** The encode block written onto `RenderManifest.output.encode` for the cloud worker to consume. */
export interface ManifestEncodeSettings {
  videoBitrate?: number;
  mode?: ExportBitrateMode;
  maxBitrate?: number;
}

/**
 * Default video bitrate for a resolution/fps — ~0.12 bits per pixel·frame, clamped to a sane range.
 * Shared by the on-device encoder AND the export-window UI seed AND the cloud path so all three agree
 * on "what bitrate does full quality mean" (single source of truth — no per-surface drift).
 */
export function defaultBitrate(width: number, height: number, fps: number): number {
  const bpp = 0.12;
  const raw = width * height * fps * bpp;
  return Math.round(Math.min(40_000_000, Math.max(2_000_000, raw)));
}

/** Even, ≥2 dimension after scaling — encoders reject odd dimensions. */
export function scaledEvenDimension(value: number, scale: number): number {
  const scaled = Math.round(value * scale);
  const even = scaled - (scaled % 2);
  return Math.max(2, even);
}

export interface ResolutionPreset {
  /** Multiplier applied to the composition's native size. */
  scale: number;
  /** Human label, e.g. "Full (1080×1920)" or "720p". */
  label: string;
}

/**
 * Resolution choices for a given composition size: Full plus any standard heights (1080/720/480)
 * smaller than the source, expressed as scale factors of the native size. Portrait/landscape
 * agnostic — we scale by the LONGER edge so "1080p" means "1080 on the long side".
 */
export function resolutionPresetsFor(width: number, height: number): ResolutionPreset[] {
  const longEdge = Math.max(width, height);
  const presets: ResolutionPreset[] = [{ scale: 1, label: `Full (${width}×${height})` }];
  for (const target of [2160, 1440, 1080, 720, 480]) {
    if (target < longEdge) {
      presets.push({ scale: target / longEdge, label: `${target}p` });
    }
  }
  return presets;
}

/** Seed the export window from a composition's native size + fps (destination defaults to local). */
export function defaultExportSettings(input: { width: number; height: number; fps: number }): ExportSettings {
  const target = defaultBitrate(input.width, input.height, input.fps);
  return {
    destination: "local",
    format: "mp4",
    scale: 1,
    fps: input.fps,
    range: "full",
    trimTrailingBlack: false,
    bitrateMode: "vbr",
    targetBitrate: target,
    maxBitrate: Math.round(target * 1.45)
  };
}

/** Latest end time (seconds) of any NON-audio layer — the last frame that has visual content. */
export function lastVisualEndSeconds(composition: TimelineComposition): number {
  let end = 0;
  for (const track of composition.tracks) {
    for (const layer of track.layers) {
      if (layer.type === "audio") continue;
      end = Math.max(end, layer.startSeconds + layer.durationSeconds);
    }
  }
  return end;
}

/**
 * Resolve the effective export window (in/out seconds) from range + safe-timeline settings. "full"
 * ignores the composition's In/Out; "inout" honors them; trimTrailingBlack additionally caps the
 * out-point at the last visual frame. Undefined means "no bound on that side" (start / project end).
 */
export function resolveExportWindow(
  composition: TimelineComposition,
  settings: Pick<ExportSettings, "range" | "trimTrailingBlack">
): { inPointSeconds: number | undefined; outPointSeconds: number | undefined } {
  const total = composition.durationSeconds;
  const timeline = composition.settings?.timeline;
  const inSeconds = settings.range === "inout" ? timeline?.inPointSeconds : undefined;
  let outSeconds = settings.range === "inout" ? timeline?.outPointSeconds : undefined;
  if (settings.trimTrailingBlack) {
    const visualEnd = lastVisualEndSeconds(composition);
    if (visualEnd > 0 && visualEnd < total) {
      outSeconds = outSeconds === undefined ? visualEnd : Math.min(outSeconds, visualEnd);
    }
  }
  return { inPointSeconds: inSeconds, outPointSeconds: outSeconds };
}

/** Duration (seconds) the resolved export window covers — used for the size estimate. */
export function exportWindowDurationSeconds(
  composition: TimelineComposition,
  settings: Pick<ExportSettings, "range" | "trimTrailingBlack">
): number {
  const total = composition.durationSeconds;
  const window = resolveExportWindow(composition, settings);
  const clamp = (value: number) => Math.min(Math.max(value, 0), total);
  const inSeconds = clamp(window.inPointSeconds ?? 0);
  const outSeconds = Math.min(Math.max(window.outPointSeconds ?? total, inSeconds), total);
  return Math.max(1 / Math.max(1, composition.fps), outSeconds - inSeconds);
}

/**
 * Return a composition with its In/Out points set to the resolved export window, so the SHARED clip
 * machinery (clipCompositionToWorkArea locally, buildRenderManifest in the cloud) renders exactly
 * that span. No-op when the composition has no settings to carry the window.
 */
export function withExportWindow(
  composition: TimelineComposition,
  settings: Pick<ExportSettings, "range" | "trimTrailingBlack">
): TimelineComposition {
  const current = composition.settings;
  if (!current) return composition;
  const window = resolveExportWindow(composition, settings);
  return {
    ...composition,
    settings: {
      ...current,
      timeline: {
        ...current.timeline,
        inPointSeconds: window.inPointSeconds,
        outPointSeconds: window.outPointSeconds
      }
    }
  };
}

/** Build the manifest encode block the cloud worker reads, from user settings. */
export function toManifestEncodeSettings(settings: ExportSettings): ManifestEncodeSettings {
  return {
    videoBitrate: settings.targetBitrate,
    mode: settings.bitrateMode,
    ...(settings.bitrateMode === "vbr" && settings.maxBitrate ? { maxBitrate: settings.maxBitrate } : {})
  };
}
