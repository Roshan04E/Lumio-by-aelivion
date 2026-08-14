import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  catalogueFaces,
  createRenderComparisonFixture,
  fontIndex,
  renderComparisonFixtureKeys,
  renderSafeFonts,
  type FontIndexFamily,
  type TimelineComposition,
  type RenderComparisonFixtureKey
} from "@orreris/shared";
import { VideoPreview } from "../components/VideoPreview";
import { fontReferenceId, fontReferenceResolver, type FontPickerValue } from "../editor/controls/FontPicker";
import { PropertyFieldList } from "../editor/inspector/PropertyFieldList";
import {
  cataloguePreviewVersion,
  isPreviewLoaded,
  loadCataloguePreviews,
  previewFamily,
  previewSample,
  previewState,
  requestPreview,
  subscribeCataloguePreviews
} from "../lib/font-catalogue-preview";

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

/**
 * ADR-023 T-17 — the picker's previews, standalone, so a gate can photograph them.
 *
 * T-17 forbids asserting a fact about the host ("this machine does not have Anton"), because that
 * silently makes the gate depend on the font folder it stands in. The shape that works is to make
 * the machine demonstrate the difference: each catalogue face is rendered TWICE with identical text,
 * size and layout — once through its loaded preview face, once through a family name that cannot
 * resolve to anything. Whatever the host has installed, those two must differ, or the preview is
 * showing the fallback while claiming to show the font.
 *
 * That is the empty-`warpFontCatalog` incident expressed as an assertion: a font surface that
 * silently shows the fallback looks exactly like one that works.
 */
function CataloguePreviewProbe() {
  useEffect(() => {
    loadCataloguePreviews();
  }, []);
  useSyncExternalStore(subscribeCataloguePreviews, cataloguePreviewVersion, cataloguePreviewVersion);

  const faces = catalogueFaces();
  return (
    <section data-render-fixture="ready" data-catalogue-probe="ready" style={{ background: "#fff", padding: 16 }}>
      {faces.map(({ family, face }) => {
        const ready = isPreviewLoaded(family, face);
        const common = { fontSize: 64, lineHeight: 1.2, color: "#000", background: "#fff", width: 320, height: 90 } as const;
        return (
          <div key={`${family}-${face.weight}`} style={{ display: "flex", gap: 12 }}>
            <div
              data-testid={`catalogue-preview-${family}-${face.weight}`}
              data-preview-ready={ready ? "true" : "false"}
              style={{ ...common, fontFamily: `'${previewFamily(family)}'`, fontWeight: face.weight }}
            >
              Hamburg
            </div>
            {/* The control: same string, same box, a family that resolves to nothing. This is what
                "the preview is broken" looks like, produced deliberately so it can be compared to. */}
            <div
              data-testid={`catalogue-fallback-${family}-${face.weight}`}
              style={{ ...common, fontFamily: "'Orreris No Such Face'", fontWeight: face.weight }}
            >
              Hamburg
            </div>
          </div>
        );
      })}
    </section>
  );
}

/**
 * ADR-023 S2.6 / T-17 — the same proof, at index scale.
 *
 * `CataloguePreviewProbe` covers the five BUNDLED faces, which load from disk and work offline. This
 * one covers the other ~1900: families whose bytes we do not hold, previewed by fetching from
 * Google's CSS API through the batched loader the real picker uses. Same shape as T-17 demands —
 * each family drawn twice, once through its loaded preview face and once through a family name that
 * resolves to nothing — because the number of rows changes nothing about the failure mode. A list
 * showing the fallback looks exactly like a list that works whether it has five rows or two thousand.
 *
 * The sample is STRIDED across the popularity order rather than taken from the top, so it spans
 * Latin workhorses, display faces and the non-Latin scripts. A sample of the first N would be ten
 * Latin sans-serifs, which is the easiest case and the least informative.
 */
function CatalogueScaleProbe({ count }: { count: number }) {
  useSyncExternalStore(subscribeCataloguePreviews, cataloguePreviewVersion, cataloguePreviewVersion);

  const sample = useMemo(() => {
    const all = fontIndex();
    const stride = Math.max(1, Math.floor(all.length / count));
    const picked: FontIndexFamily[] = [];
    for (let index = 0; index < all.length && picked.length < count; index += stride) picked.push(all[index]!);
    return picked;
  }, [count]);

  useEffect(() => {
    for (const entry of sample) requestPreview(entry.family, previewSample(entry.subsets));
  }, [sample]);

  const ready = sample.filter((entry) => previewState(entry.family) === "loaded").length;
  const settled = sample.every((entry) => {
    const state = previewState(entry.family);
    return state === "loaded" || state === "unavailable";
  });

  return (
    <section
      data-render-fixture="ready"
      data-catalogue-probe="ready"
      data-scale-settled={settled ? "true" : "false"}
      data-scale-ready={String(ready)}
      data-scale-total={String(sample.length)}
      style={{ background: "#fff", padding: 16 }}
    >
      {sample.map((entry) => {
        const state = previewState(entry.family);
        const common = { fontSize: 56, lineHeight: 1.2, color: "#000", background: "#fff", width: 300, height: 80 } as const;
        return (
          <div key={entry.family} style={{ display: "flex", gap: 12 }}>
            <div
              data-testid={`scale-preview-${entry.family}`}
              data-preview-ready={state === "loaded" ? "true" : "false"}
              style={{ ...common, fontFamily: `'${previewFamily(entry.family)}'` }}
            >
              {previewSample(entry.subsets)}
            </div>
            {/* The control: same string, same box, a family that resolves to nothing. */}
            <div data-testid={`scale-fallback-${entry.family}`} style={{ ...common, fontFamily: "'Orreris No Such Face'" }}>
              {previewSample(entry.subsets)}
            </div>
          </div>
        );
      })}
    </section>
  );
}

/**
 * ADR-023 S2.6 — the picker, standalone, so a harness can MEASURE it.
 *
 * The plan asks for the scroll to be measured rather than eyeballed, and for picker startup to be a
 * separate number from steady-state scroll. Mounting the whole editor to get at one control would
 * fold its startup into every reading; this page is the control and nothing else, so what the
 * numbers describe is the list.
 *
 * It also carries the pick assertion: whatever the picker hands back is written into
 * `data-picked-ref` verbatim. **The whole S2 contract is downstream of that one write** — a picker
 * that produced `fontFamily: "Anton"` instead of a ref with a `fileHash` would look identical here
 * and leave the mirror, the install path and the named abort all unreachable.
 */
function PickerProbe() {
  const [value, setValue] = useState<FontPickerValue>({ fontFamily: renderSafeFonts[0]!.family, fontRef: undefined, weight: 400 });
  return (
    <section data-render-fixture="ready" data-picker-probe="ready" style={{ padding: 24, width: 420 }}>
      <div data-picked-ref={value.fontRef ? JSON.stringify(value.fontRef) : ""} data-picked-family={value.fontFamily} />
      {/* S4b: through `PropertyFieldList`, because that is now the path the editor uses. A gate
          pointed at the widget directly would keep passing after the shared renderer started
          mounting all 1,942 rows, which is the exact regression this fixture exists to catch. */}
      <PropertyFieldList
        fields={[
          {
            kind: "reference",
            refType: "font",
            key: "fontFamily",
            label: "Font",
            refId: fontReferenceId(value),
            resolve: fontReferenceResolver(value),
            emptyLabel: "None",
            value,
            onPick: (next) => setValue({ ...next, weight: value.weight })
          }
        ]}
      />
    </section>
  );
}

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

  // T-17's probe is a whole different page, not a variant of the preview — it has no composition and
  // no VideoPreview, so it must short-circuit before either is touched.
  if (typeof window !== "undefined") {
    const catalogue = new URLSearchParams(window.location.search).get("catalogue");
    if (catalogue === "probe") return <CataloguePreviewProbe />;
    if (catalogue === "picker") return <PickerProbe />;
    if (catalogue === "scale") {
      const count = Number(new URLSearchParams(window.location.search).get("count")) || 12;
      return <CatalogueScaleProbe count={count} />;
    }
  }

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
