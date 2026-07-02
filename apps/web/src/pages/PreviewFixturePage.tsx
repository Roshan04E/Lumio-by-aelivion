import { createRenderComparisonFixture, renderComparisonFixtureKeys, type RenderComparisonFixtureKey } from "@lumio-by-aelivion/shared";
import { VideoPreview } from "../components/VideoPreview";

function fixtureKeyFromUrl(): RenderComparisonFixtureKey {
  if (typeof window === "undefined") return "default";
  const raw = new URLSearchParams(window.location.search).get("fixture");
  return renderComparisonFixtureKeys.includes(raw as RenderComparisonFixtureKey)
    ? (raw as RenderComparisonFixtureKey)
    : "default";
}

export function PreviewFixturePage() {
  // Both the fixture variant (?fixture=) and the renderer mode (?rendererMode=) are read from
  // the URL so the pixel-comparison harness can sweep every variant in both render paths.
  const fixture = createRenderComparisonFixture(fixtureKeyFromUrl());
  const composition = fixture.graph.composition;

  if (!composition) {
    return null;
  }

  return (
    <section className="pixel-fixture-page" data-render-fixture="ready">
      <VideoPreview
        assets={fixture.assets}
        composition={composition}
        currentTime={fixture.currentTime}
        graph={fixture.graph}
        isPlaying={false}
        onSelectLayer={() => undefined}
        previewQuality="quality"
        selectedLayerId={undefined}
        sourceAsset={null}
        viewMode="fit"
        manualScale={1}
      />
    </section>
  );
}
