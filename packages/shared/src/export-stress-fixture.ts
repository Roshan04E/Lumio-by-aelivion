/**
 * Large-timeline export stress fixture (WebGL context budget — `export:stress` gate).
 *
 * Builds a composition with MANY sequential image clips, each carrying bloom + blur + a color grade, so the
 * local-export `SceneFrameCompositor` is driven across a long timeline where each clip becomes active then
 * inactive. This is the case the per-clip-renderer accumulation used to blow up: without the media-renderer
 * pool a 24-clip export would hoard ~24 WebGL contexts and evict the preview's. The gate sweeps every clip
 * and asserts the live context count stays bounded (pool reuse) with no "lost WebGL context" errors.
 *
 * Images (not videos) keep the fixture self-contained (a data-URL SVG, no real decode) while still exercising
 * `gradeMediaLayer → mediaRendererFor` — the exact path the pool bounds.
 */

import type { ProjectGraph, SourceAsset, TimelineLayer } from "./types";

// A bright-spotted gradient so the highlights-mode glow (bloom) has something to bloom from.
const stressImageSvg = encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" viewBox="0 0 1080 1920">
  <defs>
    <radialGradient id="g" cx="0.5" cy="0.32" r="0.7">
      <stop offset="0" stop-color="#fff7e0"/>
      <stop offset="0.4" stop-color="#e08a3c"/>
      <stop offset="1" stop-color="#120a06"/>
    </radialGradient>
  </defs>
  <rect width="1080" height="1920" fill="url(#g)"/>
  <circle cx="540" cy="600" r="180" fill="#fffbe8" opacity="0.95"/>
</svg>`);

const DEFAULT_CLIP_COUNT = 24;
const CLIP_DURATION_SECONDS = 0.5;

/** Per-clip effect stack: bloom (highlights glow) + blur + a color grade — the heavy GPU path. */
function stressEffects(index: number): TimelineLayer["effects"] {
  return [
    {
      id: `stress_blur_${index}`,
      type: "blur",
      name: "Blur",
      enabled: true,
      intensity: 100,
      params: { amount: 12 },
    },
    {
      id: `stress_bloom_${index}`,
      type: "glow",
      name: "Bloom",
      enabled: true,
      intensity: 100,
      params: { radius: 32, color: "#ffe9b0", mode: "highlights", threshold: 55, strength: 80 },
    },
    {
      id: `stress_grade_${index}`,
      type: "brightnessContrast",
      name: "Grade",
      enabled: true,
      intensity: 100,
      params: { exposure: 10, contrast: 28, saturation: 120, temperature: -18, tint: 10 },
    },
  ];
}

export interface ExportStressFixture {
  graph: ProjectGraph;
  assets: SourceAsset[];
  clipCount: number;
  clipDurationSeconds: number;
  durationSeconds: number;
}

export function createExportStressFixture(clipCount: number = DEFAULT_CLIP_COUNT): ExportStressFixture {
  const imageAsset: SourceAsset = {
    id: "stress_image",
    userId: "fixture_user",
    fileName: "stress.svg",
    fileType: "image/svg+xml",
    fileUrl: `data:image/svg+xml;charset=utf-8,${stressImageSvg}`,
    durationSeconds: clipCount * CLIP_DURATION_SECONDS,
    width: 1080,
    height: 1920,
    status: "ready",
    createdAt: new Date(0).toISOString(),
  };

  const layers: TimelineLayer[] = Array.from({ length: clipCount }, (_, i) => ({
    id: `stress_clip_${i}`,
    trackId: "video_track",
    type: "image",
    name: `Stress clip ${i}`,
    startSeconds: i * CLIP_DURATION_SECONDS,
    durationSeconds: CLIP_DURATION_SECONDS,
    assetId: imageAsset.id,
    fit: "cover",
    transform: { position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 100 },
    effects: stressEffects(i),
    keyframes: [],
  }));

  const durationSeconds = clipCount * CLIP_DURATION_SECONDS;
  const graph: ProjectGraph = {
    projectId: "project_export_stress",
    effects: [],
    editableFields: {},
    version: 1,
    composition: {
      id: "composition_export_stress",
      name: "Export stress",
      width: 1080,
      height: 1920,
      fps: 30,
      durationSeconds,
      backgroundColor: "#000000",
      tracks: [
        {
          id: "video_track",
          type: "video",
          name: "Video",
          layers,
        },
      ],
    },
  };

  return { graph, assets: [imageAsset], clipCount, clipDurationSeconds: CLIP_DURATION_SECONDS, durationSeconds };
}
