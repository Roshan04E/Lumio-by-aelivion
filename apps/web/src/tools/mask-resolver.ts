import type {
  MaskSequenceArtifactData,
  MatteRef,
  TimelineComposition,
  TrackingPathArtifactData
} from "@orreris/shared";

/**
 * Cross-tool artifact reuse ("extract once, reuse everywhere"): finds a real,
 * previously-produced subject mask (or tracking path) for a source asset so
 * Text Behind Person / Remove Background / Follow Text can pick it up instead
 * of fabricating a mock or re-running segmentation from scratch.
 *
 * Pure lookup logic only — no DOM, no OPFS, no network — so the editor test
 * suite can drive it headlessly. Producers register their artifacts via
 * `registerMaskForAsset`/`registerTrackingForAsset` right after a successful
 * bake; consumers call `findReusableMask`/`findReusableTrackingPath` before
 * deciding to run a fresh analysis.
 */

export interface ReusableMask {
  mask: MaskSequenceArtifactData;
  /** Where the mask was found — surfaced in progress text and useful in tests. */
  origin: "session" | "editableFields" | "composition";
}

export interface ReusableTrackingPath {
  trackingPath: TrackingPathArtifactData;
  origin: "session" | "editableFields";
}

// Session index: full-fidelity artifacts produced in this tab (URIs still alive
// here even when the upload failed). Keyed by sourceAssetId; last write wins per
// edge mode, and lookups prefer the higher-quality "clean" entry.
const sessionMasksByAsset = new Map<string, MaskSequenceArtifactData[]>();
const sessionTracksByAsset = new Map<string, TrackingPathArtifactData>();

export function registerMaskForAsset(sourceAssetId: string, mask: MaskSequenceArtifactData): void {
  if (!sourceAssetId || !mask.matteVideoUri) {
    return;
  }
  const entry = { ...mask, sourceAssetId };
  const existing = sessionMasksByAsset.get(sourceAssetId) ?? [];
  sessionMasksByAsset.set(sourceAssetId, [entry, ...existing.filter((item) => item.edgeMode !== mask.edgeMode)]);
}

export function registerTrackingForAsset(sourceAssetId: string, trackingPath: TrackingPathArtifactData): void {
  if (!sourceAssetId || !trackingPath.points.length) {
    return;
  }
  sessionTracksByAsset.set(sourceAssetId, { ...trackingPath, sourceAssetId });
}

/** Test-only escape hatch so checks can run against a clean session index. */
export function clearSessionArtifactIndex(): void {
  sessionMasksByAsset.clear();
  sessionTracksByAsset.clear();
}

/**
 * True when the URI survives a reload and is fetchable by the Remotion worker.
 * blob:/opfs:// URIs are tab- or browser-local and never qualify.
 */
export function isDurableMatteUri(uri: string | undefined): boolean {
  return typeof uri === "string" && /^https?:\/\//i.test(uri);
}

export interface FindReusableMaskInput {
  sourceAssetId: string;
  /** Asset dimensions for reconstructing a mask from a bare MatteRef. */
  asset?: { width?: number | null | undefined; height?: number | null | undefined; durationSeconds?: number | null | undefined } | undefined;
  composition?: TimelineComposition | undefined;
  editableFields?: Record<string, unknown> | undefined;
}

/**
 * Lookup order (first hit wins), preferring `edgeMode: "clean"` at each tier:
 * 1. session index — freshest, full artifact, URIs alive in this tab;
 * 2. `editableFields.maskSequence` — the /tools page's durable per-project copy,
 *    only trusted when its URI is durable (a persisted blob: URI is dead after reload);
 * 3. composition scan — a layer already compositing this asset through a durable
 *    matte; reconstructed from the MatteRef (inspector `frames` stay empty, which
 *    is fine: the apply builders only read id/dims/fps/duration).
 */
export function findReusableMask(input: FindReusableMaskInput): ReusableMask | undefined {
  const sessionHits = sessionMasksByAsset.get(input.sourceAssetId) ?? [];
  const sessionHit = preferClean(sessionHits);
  if (sessionHit) {
    return { mask: sessionHit, origin: "session" };
  }

  const fieldsMask = maskFromEditableFields(input.editableFields, input.sourceAssetId);
  if (fieldsMask) {
    return { mask: fieldsMask, origin: "editableFields" };
  }

  if (input.composition) {
    const matteHits: MaskSequenceArtifactData[] = [];
    for (const track of input.composition.tracks) {
      for (const layer of track.layers) {
        // AI Roto mattes (`mask_browser_sam_*`) key an arbitrary prompted OBJECT,
        // not the person mask the reuse consumers expect — never offer them.
        if (
          layer.assetId === input.sourceAssetId &&
          layer.matte &&
          isDurableMatteUri(layer.matte.uri) &&
          !layer.matte.artifactId.includes("_sam_")
        ) {
          matteHits.push(maskFromMatteRef(layer.matte, input.sourceAssetId, input.asset));
        }
      }
    }
    const compositionHit = preferClean(matteHits);
    if (compositionHit) {
      return { mask: compositionHit, origin: "composition" };
    }
  }

  return undefined;
}

export interface FindReusableTrackingPathInput {
  sourceAssetId: string;
  /** The tracking must cover at least this much of the clip to be reusable. */
  minimumDurationSeconds?: number | undefined;
  editableFields?: Record<string, unknown> | undefined;
}

export function findReusableTrackingPath(input: FindReusableTrackingPathInput): ReusableTrackingPath | undefined {
  const covers = (path: TrackingPathArtifactData) =>
    input.minimumDurationSeconds === undefined || path.durationSeconds >= input.minimumDurationSeconds - 0.05;

  const sessionHit = sessionTracksByAsset.get(input.sourceAssetId);
  if (sessionHit && covers(sessionHit)) {
    return { trackingPath: sessionHit, origin: "session" };
  }

  const fields = input.editableFields;
  const candidate = fields?.trackingPath as TrackingPathArtifactData | undefined;
  if (
    candidate &&
    Array.isArray(candidate.points) &&
    candidate.points.length > 0 &&
    candidate.sourceAssetId === input.sourceAssetId &&
    covers(candidate)
  ) {
    return { trackingPath: candidate, origin: "editableFields" };
  }

  return undefined;
}

/**
 * Rebuilds a compositable mask artifact from a layer's `MatteRef` plus the
 * asset's dimensions. `frames` (inspector scrubber previews) are unavailable
 * from a bare ref and stay empty — real compositing only needs `matteVideoUri`.
 */
export function maskFromMatteRef(
  matte: MatteRef,
  sourceAssetId: string,
  asset?: FindReusableMaskInput["asset"]
): MaskSequenceArtifactData {
  return {
    id: matte.artifactId,
    sourceAssetId,
    width: asset?.width || 720,
    height: asset?.height || 1280,
    fps: matte.fps,
    durationSeconds: asset?.durationSeconds || 0,
    frames: [],
    matteVideoUri: matte.uri,
    feather: matte.feather,
    edgeMode: matte.edgeMode,
    source: "browser"
  };
}

function maskFromEditableFields(
  editableFields: Record<string, unknown> | undefined,
  sourceAssetId: string
): MaskSequenceArtifactData | undefined {
  const candidate = editableFields?.maskSequence as MaskSequenceArtifactData | undefined;
  if (
    candidate &&
    typeof candidate === "object" &&
    candidate.sourceAssetId === sourceAssetId &&
    isDurableMatteUri(candidate.matteVideoUri)
  ) {
    return candidate;
  }
  return undefined;
}

function preferClean(masks: MaskSequenceArtifactData[]): MaskSequenceArtifactData | undefined {
  return masks.find((mask) => mask.edgeMode === "clean") ?? masks[0];
}
