import React from "react";
import { Composition, staticFile } from "remotion";
import type { RenderManifest } from "@lumio-by-aelivion/render-templates";
import { configureFontResolver, warpFontFile } from "@lumio-by-aelivion/shared";
import { SceneStage, getRemotionCompositor } from "./SceneStage";

// Text-warp outline engine: resolve warp font families to the binaries served from the
// Remotion public/ dir, so the exported warp matches the editor preview exactly.
configureFontResolver((family) => staticFile(warpFontFile(family)));

export const compositionId = "LumioTimeline";

const fallbackManifest: RenderManifest = {
  id: "fallback",
  schemaVersion: 1,
  animationVersion: 1,
  projectId: "fallback",
  quality: "final",
  output: {
    width: 1080,
    height: 1920,
    fps: 30,
    durationSeconds: 1,
    durationInFrames: 30,
    format: "mp4"
  },
  assets: [],
  layers: [],
  createdAt: new Date(0).toISOString(),
  renderer: {
    engine: "lumio-manifest",
    version: 1,
    note: "Fallback manifest"
  }
};

export function RemotionRoot() {
  return (
    <Composition
      id={compositionId}
      component={TimelineComposition}
      durationInFrames={fallbackManifest.output.durationInFrames}
      fps={fallbackManifest.output.fps}
      width={fallbackManifest.output.width}
      height={fallbackManifest.output.height}
      defaultProps={{ manifest: fallbackManifest }}
      calculateMetadata={({ props }) => ({
        durationInFrames: props.manifest.output.durationInFrames,
        fps: props.manifest.output.fps,
        width: props.manifest.output.width,
        height: props.manifest.output.height
      })}
    />
  );
}

function TimelineComposition({ manifest }: { manifest: RenderManifest }) {
  if (getRemotionCompositor() === "legacy") {
    console.warn("REMOTION_COMPOSITOR=legacy requested, but the legacy visual compositor has been retired; using SceneStage.");
  }
  return <SceneStage manifest={manifest} />;
}
