import type { BuiltInTransitionKind, SourceAsset, TimelineComposition, TimelineLayer } from "./types";

/**
 * FCPXML 1.10 export (Task 2.4) — the hand-off direction for `external-timeline-adapter.ts`'s import.
 * Writes clips, titles, and transitions so a Kimera timeline can round-trip through Premiere/Resolve/Final
 * Cut and back (verified by re-importing the output with `parseFcpxml` in `editor.test.ts`). Unsupported
 * constructs (masks, warps, plugin fragment effects, blend modes, keyframed motion) are listed in
 * `report.unsupported` rather than silently dropped — never a false "everything exported cleanly".
 */

export interface ExternalExportReportItem {
  code: string;
  message: string;
  layerId?: string | undefined;
}

export interface ExternalExportReport {
  mapped: ExternalExportReportItem[];
  unsupported: ExternalExportReportItem[];
}

export interface ExportCompositionToFcpxmlResult {
  xml: string;
  report: ExternalExportReport;
}

/** Reverse of `mapExternalTransition` (Task 2.1) — a registry transition kind -> the FCPXML name closest to it. */
const TRANSITION_KIND_TO_FCPXML_NAME: Partial<Record<BuiltInTransitionKind, string>> = {
  crossDissolve: "Cross Dissolve",
  dip: "Dip to Color",
  wipe: "Wipe",
  push: "Push",
  slide: "Slide",
  zoom: "Cross Zoom",
  iris: "Iris"
};

export function exportCompositionToFcpxml(composition: TimelineComposition, assets: SourceAsset[]): ExportCompositionToFcpxmlResult {
  const mapped: ExternalExportReportItem[] = [];
  const unsupported: ExternalExportReportItem[] = [];
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));

  const usedAssetIds = new Set(
    composition.tracks.flatMap((track) => track.layers).map((layer) => layer.assetId).filter((id): id is string => Boolean(id))
  );
  const usedAssets = assets.filter((asset) => usedAssetIds.has(asset.id));

  const resourceAssetsXml = usedAssets
    .map((asset) => {
      const isAudio = asset.fileType.startsWith("audio/");
      const isImage = asset.fileType.startsWith("image/");
      return `    <asset id="${xmlAttr(asset.id)}" name="${xmlAttr(asset.originalName || asset.fileName)}" src="${xmlAttr(asset.fileUrl)}" duration="${secondsToFcpxmlTime(asset.durationSeconds)}" hasVideo="${isImage || !isAudio ? "1" : "0"}" hasAudio="${isAudio || !isImage ? "1" : "0"}"/>`;
    })
    .join("\n");

  const spineXml: string[] = [];
  for (const track of composition.tracks) {
    for (const layer of track.layers) {
      spineXml.push(...layerToFcpxmlSpineItems(layer, assetById, mapped, unsupported));
    }
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<fcpxml version="1.10">
  <resources>
    <format id="r_format" name="FFVideoFormatCustom" frameDuration="1/${Math.round(composition.fps)}s" width="${composition.width}" height="${composition.height}"/>
${resourceAssetsXml}
  </resources>
  <library>
    <event name="Kimera Export">
      <project name="${xmlAttr(composition.name)}">
        <sequence format="r_format" duration="${secondsToFcpxmlTime(composition.durationSeconds)}">
          <spine>
${spineXml.map((item) => `            ${item}`).join("\n")}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`;

  return { xml, report: { mapped, unsupported } };
}

function layerToFcpxmlSpineItems(
  layer: TimelineLayer,
  assetById: Map<string, SourceAsset>,
  mapped: ExternalExportReportItem[],
  unsupported: ExternalExportReportItem[]
): string[] {
  const items: string[] = [];

  if (layer.transitionIn) {
    const name = TRANSITION_KIND_TO_FCPXML_NAME[layer.transitionIn.kind as BuiltInTransitionKind];
    if (name) {
      mapped.push({ code: "fcpxml.export.transition", message: `Exported transition on "${layer.name}" as "${name}".`, layerId: layer.id });
    } else {
      unsupported.push({
        code: "fcpxml.export.transition_unsupported",
        message: `Transition kind "${layer.transitionIn.kind}" on "${layer.name}" has no FCPXML equivalent; exported as Cross Dissolve.`,
        layerId: layer.id
      });
    }
    items.push(`<transition name="${xmlAttr(name ?? "Cross Dissolve")}" offset="${secondsToFcpxmlTime(layer.startSeconds)}" duration="${secondsToFcpxmlTime(layer.transitionIn.durationSeconds)}"/>`);
  }

  if (layer.type === "text") {
    mapped.push({ code: "fcpxml.export.title", message: `Exported text layer "${layer.name}" as a title.`, layerId: layer.id });
    const styleAttrs = [
      layer.fontFamily ? `font="${xmlAttr(layer.fontFamily)}"` : "",
      layer.fontSize ? `fontSize="${layer.fontSize}"` : "",
      layer.fontWeight && layer.fontWeight >= 700 ? `bold="1"` : "",
      layer.italic ? `italic="1"` : "",
      layer.color ? `fontColor="${xmlAttr(hexToFcpxmlColor(layer.color))}"` : "",
      layer.textAlign ? `alignment="${xmlAttr(layer.textAlign)}"` : ""
    ]
      .filter(Boolean)
      .join(" ");
    items.push(
      `<title name="${xmlAttr(layer.name)}" offset="${secondsToFcpxmlTime(layer.startSeconds)}" duration="${secondsToFcpxmlTime(layer.durationSeconds)}"><text><text-style-def><text-style ${styleAttrs}/></text-style-def>${xmlText(layer.text ?? layer.name)}</text></title>`
    );
    reportUnsupportedLayerFeatures(layer, unsupported);
    return items;
  }

  if (layer.type === "audio" || layer.type === "video" || layer.type === "image") {
    const asset = layer.assetId ? assetById.get(layer.assetId) : undefined;
    const tag = layer.type === "audio" ? "asset-clip" : "asset-clip";
    if (asset) {
      items.push(
        `<${tag} name="${xmlAttr(layer.name)}" ref="${xmlAttr(asset.id)}" offset="${secondsToFcpxmlTime(layer.startSeconds)}" start="${secondsToFcpxmlTime(layer.sourceInSeconds ?? 0)}" duration="${secondsToFcpxmlTime(layer.durationSeconds)}"/>`
      );
    } else {
      unsupported.push({ code: "fcpxml.export.missing_asset", message: `Layer "${layer.name}" has no resolvable source asset; skipped.`, layerId: layer.id });
    }
    reportUnsupportedLayerFeatures(layer, unsupported);
    return items;
  }

  unsupported.push({ code: "fcpxml.export.layer_type_unsupported", message: `Layer type "${layer.type}" on "${layer.name}" has no FCPXML equivalent; skipped.`, layerId: layer.id });
  return items;
}

/** Constructs, keeping honesty with the plan's "never silently drop" rule, that FCPXML has no representation for. */
function reportUnsupportedLayerFeatures(layer: TimelineLayer, unsupported: ExternalExportReportItem[]): void {
  if (layer.masks?.length) {
    unsupported.push({ code: "fcpxml.export.masks", message: `Vector masks on "${layer.name}" are not representable in FCPXML; dropped.`, layerId: layer.id });
  }
  if (layer.textWarp) {
    unsupported.push({ code: "fcpxml.export.text_warp", message: `Text warp on "${layer.name}" is not representable in FCPXML; dropped.`, layerId: layer.id });
  }
  if (layer.effects.some((effect) => effect.type === "pluginShader")) {
    unsupported.push({ code: "fcpxml.export.plugin_shader", message: `Custom shader effect(s) on "${layer.name}" are not representable in FCPXML; dropped.`, layerId: layer.id });
  }
  if (layer.effects.length > 0) {
    unsupported.push({
      code: "fcpxml.export.effects",
      message: `${layer.effects.length} Kimera effect(s) on "${layer.name}" have no FCPXML equivalent and are lossy on export.`,
      layerId: layer.id
    });
  }
  if (layer.blendMode && layer.blendMode !== "normal") {
    unsupported.push({ code: "fcpxml.export.blend_mode", message: `Blend mode "${layer.blendMode}" on "${layer.name}" is not representable in FCPXML; exported as Normal.`, layerId: layer.id });
  }
  if (layer.animations?.length) {
    unsupported.push({
      code: "fcpxml.export.keyframes",
      message: `${layer.animations.length} keyframe(s) on "${layer.name}" are not exported; the layer carries its static value only.`,
      layerId: layer.id
    });
  }
}

/** Seconds -> FCPXML rational time. Plain decimal seconds parse back exactly via `parseTimelineTime`. */
function secondsToFcpxmlTime(seconds: number): string {
  return `${Math.max(0, seconds).toFixed(6)}s`;
}

function xmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function xmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** "#rrggbb" -> FCPXML's "r g b a" floats 0..1 (the inverse of the importer's `fcpxmlColorToHex`). */
function hexToFcpxmlColor(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m?.[1]) return "1 1 1 1";
  const n = Number.parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  return `${r.toFixed(4)} ${g.toFixed(4)} ${b.toFixed(4)} 1`;
}
