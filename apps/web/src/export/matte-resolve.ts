import type { MaskSequenceArtifactData, ProjectGraph, TimelineComposition } from "@kimera-by-aelivion/shared";
import { isDurableMatteUri } from "../tools/mask-resolver";

/**
 * Pre-submit matte resolution — the guaranteed choke point that keeps a cloud
 * render job from ever carrying a matte URI the Remotion worker can't fetch.
 *
 * Tool flows upload their baked matte at bake time (matte-store.ts
 * `uploadMatteForExport`), but that upload is best-effort: offline runs keep a
 * this-tab-only blob: URL, and the OPFS copy (`opfs://…`) is never fetchable.
 * A manifest that reaches the worker with such a URI hangs the frame silently
 * (SceneStage's composite gate waits forever for matte pixels). So before a
 * render job is created — and opportunistically on every background sync —
 * `resolveGraphMattes` walks every `layer.matte`, recovers the bytes
 * (live blob: URL, else the OPFS artifact store), uploads them, and rewrites
 * the graph to the durable http(s) URL. Anything unrecoverable is reported so
 * the export gate can fail loud with the layer's name instead of hanging.
 *
 * The pure helpers (`collectUnresolvedMattes`, `rewriteMatteUris`) have no
 * browser dependencies so the editor test suite drives them headlessly; the IO
 * lives only in `resolveGraphMattes`, which imports its dependencies lazily.
 */

export interface UnresolvedMatte {
  layerId: string;
  layerName: string;
  artifactId: string;
  uri: string | undefined;
}

/** Every matte reference in the composition whose URI is not durable http(s). */
export function collectUnresolvedMattes(composition: TimelineComposition | undefined): UnresolvedMatte[] {
  const unresolved: UnresolvedMatte[] = [];
  for (const track of composition?.tracks ?? []) {
    for (const layer of track.layers) {
      if (layer.matte && !isDurableMatteUri(layer.matte.uri)) {
        unresolved.push({
          layerId: layer.id,
          layerName: layer.name,
          artifactId: layer.matte.artifactId,
          uri: layer.matte.uri
        });
      }
    }
  }
  return unresolved;
}

/**
 * Rewrites `layer.matte.uri` for every matte whose artifactId has a resolved
 * URL. Surgical: untouched tracks/layers keep reference equality, and all other
 * matte fields (invert/opacity/feather/…) are preserved.
 */
export function rewriteMatteUris(
  composition: TimelineComposition,
  uriByArtifactId: Record<string, string>
): TimelineComposition {
  let changed = false;
  const tracks = composition.tracks.map((track) => {
    let trackChanged = false;
    const layers = track.layers.map((layer) => {
      const nextUri = layer.matte ? uriByArtifactId[layer.matte.artifactId] : undefined;
      if (!layer.matte || !nextUri || layer.matte.uri === nextUri) {
        return layer;
      }
      trackChanged = true;
      return { ...layer, matte: { ...layer.matte, uri: nextUri } };
    });
    if (!trackChanged) {
      return track;
    }
    changed = true;
    return { ...track, layers };
  });
  return changed ? { ...composition, tracks } : composition;
}

export interface MatteResolveReport {
  graph: ProjectGraph;
  resolvedCount: number;
  failures: UnresolvedMatte[];
}

export class MatteResolveError extends Error {
  failures: UnresolvedMatte[];

  constructor(failures: UnresolvedMatte[]) {
    const names = failures.map((failure) => `"${failure.layerName}"`).join(", ");
    super(
      `Export needs the subject mask for ${names}, but its data is no longer on this device. ` +
        `Re-run the extraction tool on that clip (use its "Re-analyze" option), then export again.`
    );
    this.name = "MatteResolveError";
    this.failures = failures;
  }
}

/**
 * Uploads every non-durable matte in the graph and rewrites it to the http(s)
 * URL. Byte recovery order per matte: the live blob: URL (same tab, exact
 * bytes), then the OPFS artifact store (survives reloads). Never throws for a
 * single matte — unrecoverable ones land in `failures` and the caller decides
 * whether that's fatal (export gate) or fine (background sync).
 */
export async function resolveGraphMattes(graph: ProjectGraph): Promise<MatteResolveReport> {
  const composition = graph.composition;
  const unresolved = collectUnresolvedMattes(composition);
  if (!composition || unresolved.length === 0) {
    return { graph, resolvedCount: 0, failures: [] };
  }

  const [{ createAsset }, { createToolArtifactStore }] = await Promise.all([
    import("../lib/api"),
    import("../tools/artifact-store")
  ]);

  const uriByArtifactId: Record<string, string> = {};
  const failures: UnresolvedMatte[] = [];
  // Multiple layers can share one artifact — resolve each artifact once.
  const byArtifact = new Map<string, UnresolvedMatte>();
  for (const item of unresolved) {
    if (!byArtifact.has(item.artifactId)) {
      byArtifact.set(item.artifactId, item);
    }
  }

  for (const item of byArtifact.values()) {
    const blob = await recoverMatteBytes(item, createToolArtifactStore);
    if (!blob) {
      failures.push(item);
      continue;
    }
    try {
      const matteAsset = await createAsset({
        file: new File([blob], `${item.artifactId}.webm`, { type: blob.type || "video/webm" }),
        source: "timeline-generated",
        folder: "generated/mattes",
        originalName: "Subject matte"
      });
      uriByArtifactId[item.artifactId] = matteAsset.fileUrl;
    } catch {
      failures.push(item);
    }
  }

  // Layers sharing a failed artifact all count as failures for reporting.
  const failedIds = new Set(failures.map((failure) => failure.artifactId));
  const allFailures = unresolved.filter((item) => failedIds.has(item.artifactId));

  if (Object.keys(uriByArtifactId).length === 0) {
    return { graph, resolvedCount: 0, failures: allFailures };
  }

  const nextComposition = rewriteMatteUris(composition, uriByArtifactId);
  const nextGraph: ProjectGraph = { ...graph, composition: nextComposition };

  // Keep the /tools page's durable editableFields copy consistent (it also
  // feeds the cross-tool mask-reuse lookup).
  const fieldsMask = nextGraph.editableFields?.maskSequence as MaskSequenceArtifactData | undefined;
  const fieldsMaskUri = fieldsMask ? uriByArtifactId[fieldsMask.id] : undefined;
  if (fieldsMask && fieldsMaskUri) {
    nextGraph.editableFields = {
      ...nextGraph.editableFields,
      maskSequence: { ...fieldsMask, matteVideoUri: fieldsMaskUri }
    };
  }

  return { graph: nextGraph, resolvedCount: Object.keys(uriByArtifactId).length, failures: allFailures };
}

async function recoverMatteBytes(
  item: UnresolvedMatte,
  createStore: () => Promise<{ get: (artifactId: string) => Promise<{ blob?: Blob | undefined } | undefined> }>
): Promise<Blob | undefined> {
  if (item.uri?.startsWith("blob:")) {
    try {
      const response = await fetch(item.uri);
      if (response.ok) {
        return await response.blob();
      }
    } catch {
      // Dead blob: URL (page reloaded since the bake) — fall through to OPFS.
    }
  }
  try {
    const store = await createStore();
    const artifact = await store.get(item.artifactId);
    return artifact?.blob;
  } catch {
    return undefined;
  }
}
