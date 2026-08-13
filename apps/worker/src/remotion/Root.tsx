import React, { useEffect, useRef, useState } from "react";
import { Composition, continueRender, delayRender, staticFile } from "remotion";
import type { RenderManifest } from "@orreris/render-templates";
import { configureFontResolver, fontFaceCss, fontLoadSpec, warpFontFile, type InstalledFontFace } from "@orreris/shared";
import { SceneStage, getRemotionCompositor } from "./SceneStage";

// Text-warp outline engine: resolve warp font families to the binaries served from the
// Remotion public/ dir, so the exported warp matches the editor preview exactly.
configureFontResolver((family, weight) => staticFile(warpFontFile(family, weight)));

export const compositionId = "OrrerisTimeline";

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
    engine: "orreris-manifest",
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
      // `fonts` defaults to empty so every existing caller — and the fallback composition — behaves
      // exactly as before. A legacy project resolves to zero pinned fonts (D1a), so this whole path
      // is inert for them rather than merely harmless.
      defaultProps={{ manifest: fallbackManifest, fonts: [] as InstalledFontFace[] }}
      calculateMetadata={({ props }) => ({
        durationInFrames: props.manifest.output.durationInFrames,
        fps: props.manifest.output.fps,
        width: props.manifest.output.width,
        height: props.manifest.output.height
      })}
    />
  );
}

/**
 * ADR-023 D3/T-2 — the browser half of "install before rendering".
 *
 * The worker has already proven the bytes exist and refused the render if they did not; what is left
 * is making Chromium actually have them BEFORE frame zero. `delayRender` is the only thing that can
 * say that: without it Remotion is entitled to paint the moment React commits, and a face still
 * loading paints as fallback — a silent substitution in an export, which is the exact defect this
 * whole stage exists to remove.
 *
 * `document.fonts.load` is awaited per face rather than `document.fonts.ready` alone, because
 * `ready` resolves against the faces the document currently knows it needs, and a face used only by
 * a canvas raster (which is where BOTH renderers get their text pixels) is not in that set.
 */
function InstallFonts({ fonts }: { fonts: InstalledFontFace[] }) {
  const [handle] = useState(() => (fonts.length ? delayRender(`Installing ${fonts.length} pinned font(s)`) : undefined));
  // `fonts` arrives as a fresh array identity on every render, so without this the effect re-runs and
  // continues the SAME handle more than once. Remotion treats that as an error, and it would surface
  // as an unrelated-looking render failure on exactly the compositions this feature is for.
  const continued = useRef(false);

  useEffect(() => {
    if (handle === undefined || continued.current) return;
    void (async () => {
      try {
        await Promise.all(fonts.map((face) => document.fonts.load(fontLoadSpec(face))));
        await document.fonts.ready;
      } finally {
        // In a `finally`, so a font that rejects at the very last moment cannot wedge the render
        // forever. That is NOT a silent fallback: the bytes were already proven to exist worker-side
        // before the browser was started, so reaching here with a rejection means something broke
        // after resolution, and a hung render would tell the user less than a rendered frame does.
        if (!continued.current) {
          continued.current = true;
          continueRender(handle);
        }
      }
    })();
  }, [fonts, handle]);

  if (!fonts.length) return null;
  return <style dangerouslySetInnerHTML={{ __html: fontFaceCss(fonts) }} />;
}

function TimelineComposition({ manifest, fonts }: { manifest: RenderManifest; fonts?: InstalledFontFace[] }) {
  if (getRemotionCompositor() === "legacy") {
    console.warn("REMOTION_COMPOSITOR=legacy requested, but the legacy visual compositor has been retired; using SceneStage.");
  }
  return (
    <>
      <InstallFonts fonts={fonts ?? []} />
      <SceneStage manifest={manifest} />
    </>
  );
}
