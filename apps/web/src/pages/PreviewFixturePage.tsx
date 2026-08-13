import {
  createRenderComparisonFixture,
  renderComparisonFixtureKeys,
  type TimelineComposition,
  type RenderComparisonFixtureKey
} from "@orreris/shared";
import { VideoPreview } from "../components/VideoPreview";

function fixtureKeyFromUrl(): RenderComparisonFixtureKey {
  if (typeof window === "undefined") return "default";
  const raw = new URLSearchParams(window.location.search).get("fixture");
  return renderComparisonFixtureKeys.includes(raw as RenderComparisonFixtureKey)
    ? (raw as RenderComparisonFixtureKey)
    : "default";
}

/**
 * ADR-023 T-16 — stage the degraded states so they can be PHOTOGRAPHED.
 *
 * T-16 exists because a marker that silently fails to paint is the purest form of the bug it guards
 * against, and S0 shipped exactly that: a badge nested inside an element carrying `opacity: 0` that
 * reported a full rect, `opacity: 1` and `visibility: visible` to every naive assertion. So the
 * markers have to be provable in PIXELS, which means something has to put a layer into each
 * degraded state on demand.
 *
 * `?marker=both` builds ONE layer that is simultaneously in both states under test: a two-colour
 * Arabic line (S0c's multi-run marker — canvas 2D cannot reorder a line it must place run by run)
 * whose font is ALSO a pinned ref the store cannot serve (D3's substitution marker). That is the
 * plan's point about efficiency made literal — authoring the two-colour Arabic layer costs the same
 * whether it proves one marker or two.
 *
 * `?marker=hidden-control` is the FALSIFIER for the checker rather than for the app: the same layer,
 * in the same states, inside an ancestor at `opacity: 0`. Both markers are present in the DOM and
 * report themselves perfectly healthy. A check that cannot fail on this one has not earned the right
 * to pass on the other, which is precisely how S0's first two attempts got through.
 */
type MarkerMode = "none" | "both" | "hidden-control";

function markerModeFromUrl(): MarkerMode {
  if (typeof window === "undefined") return "none";
  const raw = new URLSearchParams(window.location.search).get("marker");
  return raw === "both" || raw === "hidden-control" ? raw : "none";
}

/** A hash no store will ever hold, so the install fails and the substitution surface fires. */
const UNRESOLVABLE_HASH = "f".repeat(64);

function withMarkerLayer(composition: TimelineComposition): TimelineComposition {
  return {
    ...composition,
    tracks: composition.tracks.map((track) => ({
      ...track,
      layers: track.layers.map((layer) =>
        layer.type === "text"
          ? {
              ...layer,
              // Two runs with genuinely different styles: the raster must place them individually,
              // in logical order, so the line cannot be bidi-reordered (T-13a).
              text: undefined,
              textRuns: [{ text: "مرحبا " }, { text: "بالعالم", color: "#ff5252" }],
              fontRef: {
                source: "catalogue" as const,
                family: "Nothing Here",
                weight: 400,
                style: "normal" as const,
                fileHash: UNRESOLVABLE_HASH
              }
            }
          : layer
      )
    }))
  };
}

export function PreviewFixturePage() {
  // The fixture variant (?fixture=), the renderer mode (?rendererMode=) and the marker mode
  // (?marker=) are read from the URL so the harnesses can drive every variant they need.
  const fixture = createRenderComparisonFixture(fixtureKeyFromUrl());
  const markerMode = markerModeFromUrl();
  const composition = fixture.graph.composition;

  if (!composition) {
    return null;
  }

  const staged = markerMode === "none" ? composition : withMarkerLayer(composition);

  const preview = (
    <VideoPreview
      assets={fixture.assets}
      composition={staged}
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
  );

  return (
    <section className="pixel-fixture-page" data-render-fixture="ready" data-marker-mode={markerMode}>
      {markerMode === "hidden-control" ? (
        // Deliberately invisible, and deliberately NOT via `display:none` or `visibility:hidden` —
        // those are the easy cases any check catches. `opacity: 0` on an ANCESTOR is the one that
        // fooled S0: the marker itself still measures a full rect and reports opacity 1.
        <div style={{ opacity: 0 }} data-testid="deliberately-hidden-wrapper">
          {preview}
        </div>
      ) : (
        preview
      )}
    </section>
  );
}
