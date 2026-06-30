/**
 * Export-compositor parity fixture (Method 3, Phase 5 — `export:compare:scene` gate).
 *
 * Drives ONE of the two LOCAL-EXPORT compositors over a render-comparison fixture and paints the resulting
 * frame to a 1:1 canvas, so a Playwright harness can screenshot `?exportCompositor=frame` vs
 * `?exportCompositor=scene` and assert they match. This proves the new `SceneFrameCompositor` (GPU, shared
 * with the preview) reproduces the proven canvas2D `FrameCompositor` the user already trusts — the green
 * light to flip the export default to "scene".
 *
 * It mirrors `runExportCore`'s setup EXACTLY (even-dim rounding + `expandEffectRegionMasks` + `buildSourceUrlMap`
 * + `createFrameProvider`) so the only variable between the two captures is the compositor class. Sibling of
 * `PreviewFixturePage`; runs in-browser because both compositors need WebGL2/WebCodecs (use a real Chrome,
 * `PIXEL_BROWSER_CHANNEL=chrome` — bundled Chromium lacks WebGL2 and would silently render nothing).
 */

import { useEffect, useRef, useState } from "react";
import {
  createRenderComparisonFixture,
  expandEffectRegionMasks,
  renderComparisonFixtureKeys,
  renderComparisonFrameSeconds,
  type RenderComparisonFixtureKey,
} from "@reelforge/shared";
import { buildSourceUrlMap } from "../export/export-core";
import { createFrameProvider, type FrameProvider } from "../export/source-decoder";
import { FrameCompositor } from "../export/frame-compositor";
import { SceneFrameCompositor } from "../export/scene-frame-compositor";

function fixtureKeyFromUrl(): RenderComparisonFixtureKey {
  if (typeof window === "undefined") return "default";
  const raw = new URLSearchParams(window.location.search).get("fixture");
  return renderComparisonFixtureKeys.includes(raw as RenderComparisonFixtureKey)
    ? (raw as RenderComparisonFixtureKey)
    : "default";
}

function exportCompositorFromUrl(): "frame" | "scene" {
  if (typeof window === "undefined") return "frame";
  return new URLSearchParams(window.location.search).get("exportCompositor") === "scene" ? "scene" : "frame";
}

interface ExportCompositorLike {
  renderFrame(timeSeconds: number): Promise<void>;
  dispose(): void;
}

/**
 * The render-comparison fixtures back their image layer with an SVG data URL. The real export's
 * `createImageSource` decodes via `createImageBitmap(blob)`, which Chrome can't do for an SVG blob (raster
 * uploads are fine — SVG is a fixture-only artifact). So rasterize an SVG data URL to a PNG data URL via
 * `<img>`→canvas here; everything else (real raster URLs, videos) passes through untouched, keeping the
 * actual `createFrameProvider` decode path under test.
 */
async function bitmapDecodableUrl(url: string): Promise<string> {
  if (!url.startsWith("data:image/svg")) return url;
  const img = new Image();
  img.decoding = "async";
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("fixture SVG failed to decode"));
    img.src = url;
  });
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth || 1080;
  canvas.height = img.naturalHeight || 1920;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("fixture SVG raster: 2D context unavailable");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

export function ExportFixturePage() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    const sources = new Map<string, FrameProvider>();
    let compositor: ExportCompositorLike | null = null;

    async function run() {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const fixture = createRenderComparisonFixture(fixtureKeyFromUrl());
      const composition = fixture.graph.composition;
      if (!composition) throw new Error("fixture has no composition");

      // Mirror runExportCore: even dims for the encoder + region-mask expansion into base/duplicate layers.
      const width = Math.max(2, composition.width - (composition.width % 2));
      const height = Math.max(2, composition.height - (composition.height % 2));
      const renderComposition = expandEffectRegionMasks(
        width === composition.width && height === composition.height ? composition : { ...composition, width, height }
      );

      // Resolve fixture assets → URLs, then build the same source providers the real export uses.
      const assetUrl = new Map(fixture.assets.map((asset) => [asset.id, asset.fileUrl]));
      const urlMap = buildSourceUrlMap(renderComposition, (id) => assetUrl.get(id));
      await Promise.all(
        Object.entries(urlMap).map(async ([key, { url, kind }]) => {
          try {
            const decodable = kind === "image" ? await bitmapDecodableUrl(url) : url;
            sources.set(key, await createFrameProvider(decodable, kind));
          } catch (error) {
            if (!key.startsWith("matte:")) throw error;
          }
        })
      );
      if (cancelled) return;

      canvas.width = width;
      canvas.height = height;
      compositor =
        exportCompositorFromUrl() === "scene"
          ? new SceneFrameCompositor(renderComposition, canvas, (id) => sources.get(id))
          : new FrameCompositor(renderComposition, canvas, (id) => sources.get(id));

      await compositor.renderFrame(renderComparisonFrameSeconds);
      // A second pass: WebCodecs/raster grades can land a frame late on the very first call; rendering the
      // same time twice guarantees a fully-populated, deterministic frame for the screenshot.
      await compositor.renderFrame(renderComparisonFrameSeconds);
      if (cancelled) return;
      setState("ready");
    }

    run().catch((error) => {
      if (cancelled) return;
      console.error("ExportFixturePage render failed", error);
      setMessage(String(error));
      setState("error");
    });

    return () => {
      cancelled = true;
      compositor?.dispose();
      for (const source of sources.values()) source.dispose();
    };
  }, []);

  return (
    <section
      className="export-fixture-page"
      data-render-fixture={state === "ready" ? "ready" : state}
      style={{ margin: 0, padding: 0, background: "#000" }}
    >
      {/* 1:1 canvas (no CSS scaling) so the Playwright screenshot is the exact composited frame. */}
      <canvas ref={canvasRef} style={{ display: "block" }} />
      {state === "error" ? <pre data-export-error>{message}</pre> : null}
    </section>
  );
}
