import type { ProjectGraph, SourceAsset, TimelineLayer } from "./types";
import { applyCaptionTrackToComposition, captionStylePresets, createCaptionTrack, parseTranscriptInput } from "./captions";

const fixtureImageSvg = encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" viewBox="0 0 1080 1920">
  <defs>
    <linearGradient id="sky" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stop-color="#f4c7a7"/>
      <stop offset="0.34" stop-color="#b28a7d"/>
      <stop offset="1" stop-color="#16100c"/>
    </linearGradient>
    <linearGradient id="hill" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0" stop-color="#5d2c16"/>
      <stop offset="0.56" stop-color="#b85b20"/>
      <stop offset="1" stop-color="#27160f"/>
    </linearGradient>
    <filter id="soft"><feGaussianBlur stdDeviation="24"/></filter>
  </defs>
  <rect width="1080" height="1920" fill="url(#sky)"/>
  <circle cx="860" cy="240" r="130" fill="#ffe1a6" opacity="0.68" filter="url(#soft)"/>
  <path d="M0 680 C230 500 330 760 560 600 C760 460 910 520 1080 430 L1080 1920 L0 1920Z" fill="#39241c" opacity="0.74"/>
  <path d="M0 980 C210 820 410 940 620 780 C800 642 940 690 1080 590 L1080 1920 L0 1920Z" fill="url(#hill)"/>
  <path d="M190 1920 C130 1580 360 1450 300 1230 C260 1080 400 920 620 820" fill="none" stroke="#090b10" stroke-width="72" stroke-linecap="round"/>
  <path d="M190 1920 C130 1580 360 1450 300 1230 C260 1080 400 920 620 820" fill="none" stroke="#d8dbe3" stroke-width="8" stroke-linecap="round" opacity="0.92"/>
  <path d="M210 1920 C150 1580 382 1450 322 1230 C282 1080 422 920 642 820" fill="none" stroke="#d8dbe3" stroke-width="5" stroke-linecap="round" opacity="0.62"/>
  ${Array.from({ length: 34 })
    .map((_, index) => {
      const x = (index * 151) % 1080;
      const y = 720 + ((index * 97) % 1000);
      const r = 28 + ((index * 19) % 58);
      const color = ["#d86f24", "#8f3f19", "#f0a545", "#4f2a16"][index % 4];
      return `<circle cx="${x}" cy="${y}" r="${r}" fill="${color}" opacity="0.58"/>`;
    })
    .join("")}
</svg>`);

export const renderComparisonFrameSeconds = 0.45;
export const renderComparisonArtifactDir = "render-comparison";

/**
 * Pixel-comparison fixture variants. Each isolates one render concern so a regression
 * points at a specific code path. `default` is the rich color fixture (curves + HSL
 * secondary, used historically); the others are added for the unified-WebGL parity sweep.
 */
export type RenderComparisonFixtureKey =
  | "default"
  | "plain-image"
  | "brightness-contrast"
  | "color-curves"
  | "object-fit-cover"
  | "object-fit-contain";

export const renderComparisonFixtureKeys: RenderComparisonFixtureKey[] = [
  "default",
  "plain-image",
  "brightness-contrast",
  "color-curves",
  "object-fit-cover",
  "object-fit-contain"
];

const fullColorEffects: TimelineLayer["effects"] = [
  {
    id: "fixture_curves",
    type: "colorCurves",
    name: "Curves",
    enabled: true,
    intensity: 100,
    params: {
      curve: JSON.stringify({
        master: [
          { x: 0, y: 0 },
          { x: 0.25, y: 0.18 },
          { x: 0.75, y: 0.82 },
          { x: 1, y: 1 }
        ],
        blue: [
          { x: 0, y: 0.06 },
          { x: 1, y: 0.94 }
        ]
      })
    }
  },
  {
    id: "fixture_secondary",
    type: "hslSecondary",
    name: "HSL Secondary",
    enabled: true,
    intensity: 100,
    params: {
      secondary: JSON.stringify({
        hueCenter: 0.07,
        hueWidth: 0.1,
        satMin: 0.12,
        satMax: 1,
        lumMin: 0.08,
        lumMax: 0.96,
        softness: 0.12,
        invert: false,
        hueShift: 0.05,
        satScale: 1.3,
        lumScale: 1,
        showMask: false
      })
    }
  }
];

const brightnessContrastEffects: TimelineLayer["effects"] = [
  {
    id: "fixture_basic_correction",
    type: "brightnessContrast",
    name: "Basic Color Correction",
    enabled: true,
    intensity: 100,
    params: {
      exposure: 18,
      contrast: 32,
      saturation: 128,
      temperature: -22,
      tint: 14
    }
  }
];

const colorCurvesEffects: TimelineLayer["effects"] = [
  {
    id: "fixture_curves_only",
    type: "colorCurves",
    name: "Curves",
    enabled: true,
    intensity: 100,
    params: {
      curve: JSON.stringify({
        master: [
          { x: 0, y: 0.04 },
          { x: 0.3, y: 0.22 },
          { x: 0.7, y: 0.8 },
          { x: 1, y: 0.97 }
        ],
        red: [
          { x: 0, y: 0.05 },
          { x: 1, y: 0.95 }
        ]
      })
    }
  }
];

interface FixtureVariant {
  effects: TimelineLayer["effects"];
  fit: "cover" | "contain";
}

function variantFor(key: RenderComparisonFixtureKey): FixtureVariant {
  switch (key) {
    case "plain-image":
      return { effects: [], fit: "cover" };
    case "brightness-contrast":
      return { effects: brightnessContrastEffects, fit: "cover" };
    case "color-curves":
      return { effects: colorCurvesEffects, fit: "cover" };
    case "object-fit-cover":
      return { effects: [], fit: "cover" };
    case "object-fit-contain":
      return { effects: [], fit: "contain" };
    case "default":
    default:
      return { effects: fullColorEffects, fit: "cover" };
  }
}

export function createRenderComparisonFixture(key: RenderComparisonFixtureKey = "default") {
  const variant = variantFor(key);
  const imageAsset: SourceAsset = {
    id: "fixture_image",
    userId: "fixture_user",
    fileName: "fixture-landscape.svg",
    fileType: "image/svg+xml",
    fileUrl: `data:image/svg+xml;charset=utf-8,${fixtureImageSvg}`,
    durationSeconds: 12,
    width: 1080,
    height: 1920,
    status: "ready",
    createdAt: new Date(0).toISOString()
  };

  const imageLayer: TimelineLayer = {
    id: "fixture_image_layer",
    trackId: "video_track",
    type: "image",
    name: "Fixture landscape",
    startSeconds: 0,
    durationSeconds: 12,
    assetId: imageAsset.id,
    fit: variant.fit,
    transform: {
      position: { x: 50, y: 50 },
      scale: 1,
      rotation: 0,
      opacity: 100
    },
    // Variant-driven (see RenderComparisonFixtureKey): the "default" fixture exercises the
    // full Phase-3 color pipeline (13C.1 graph Curves + 13C.3 HSL Secondary that ONLY the
    // WebGL float-3D-LUT engine can render); other variants isolate a single concern so a
    // parity regression points at one code path.
    effects: variant.effects,
    keyframes: []
  };

  const shapeLayer: TimelineLayer = {
    id: "fixture_shape_layer",
    trackId: "overlay_track",
    type: "shape",
    name: "Text backing",
    startSeconds: 0,
    durationSeconds: 12,
    color: "rgba(0, 0, 0, 0.18)",
    transform: {
      position: { x: 50, y: 63 },
      scale: 0.92,
      rotation: 0,
      opacity: 76
    },
    effects: [],
    keyframes: []
  };

  const transcript = parseTranscriptInput(`WEBVTT

00:00:00.000 --> 00:00:01.400
New Drop

00:00:01.400 --> 00:00:03.200
Save this style now`);
  const captionStyle = captionStylePresets[0]!;
  const captionTrack = createCaptionTrack(transcript, captionStyle.id, "new, drop, save");

  const graph: ProjectGraph = {
    projectId: "project_render_pixel_fixture",
    effects: [],
    editableFields: {
      transcript,
      captionTrack,
      captionStyle: captionStyle.id
    },
    version: 1,
    composition: {
      id: "composition_render_pixel_fixture",
      name: "Render pixel fixture",
      width: 1080,
      height: 1920,
      fps: 30,
      durationSeconds: 12,
      backgroundColor: "#000000",
      tracks: [
        {
          id: "overlay_track",
          type: "overlay",
          name: "Overlay",
          layers: [shapeLayer]
        },
        {
          id: "video_track",
          type: "video",
          name: "Video",
          layers: [imageLayer]
        }
      ]
    }
  };
  const compositionWithCaptions = applyCaptionTrackToComposition(graph.composition!, captionTrack, captionStyle);

  return {
    graph: {
      ...graph,
      composition: compositionWithCaptions
    },
    assets: [imageAsset],
    currentTime: renderComparisonFrameSeconds
  };
}
