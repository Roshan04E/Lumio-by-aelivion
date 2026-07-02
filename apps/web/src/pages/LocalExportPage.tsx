import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Loader2, MonitorDown, XCircle } from "lucide-react";
import { ensureComposition, type SourceAsset } from "@lumio-by-aelivion/shared";
import { Button } from "../components/Button";
import { exportLocally, saveExportedFile } from "../export/local-export";
import type { ExportFormat } from "../export/video-encoder";
import { listLocalAssetRecords, readLocalProject, LOCAL_BLOB_PREFIX, type ProjectRecord } from "../lib/api";
import { getAssetBlobStore } from "../lib/asset-blob-store";
import {
  hydrateLookManifests,
  loadImportedPluginLibrary,
  normalizeImportedPluginLibrary,
  type ImportedPluginLibrary
} from "../editor/effects/pluginManifestStore";

function queryParam(name: string): string | null {
  return typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get(name);
}

interface ExportHandoff {
  project: ProjectRecord;
  assets?: SourceAsset[] | undefined;
  createdAt: number;
}

interface ExportStartupData {
  project: ProjectRecord;
  handoffAssets: SourceAsset[];
}

function formatFromQuery(): ExportFormat {
  return queryParam("format") === "webm" ? "webm" : "mp4";
}

function fpsFromQuery(): number | undefined {
  const raw = Number(queryParam("fps"));
  return Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function mergeLibraries(a: ImportedPluginLibrary, b: ImportedPluginLibrary): ImportedPluginLibrary {
  const effects = new Map(a.effects.map((item) => [item.id, item]));
  const looks = new Map(a.looks.map((item) => [item.id, item]));
  const transitions = new Map(a.transitions.map((item) => [item.id, item]));
  for (const item of b.effects) effects.set(item.id, item);
  for (const item of b.looks) looks.set(item.id, item);
  for (const item of b.transitions) transitions.set(item.id, item);
  return { effects: [...effects.values()], looks: [...looks.values()], transitions: [...transitions.values()] };
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s.`)), ms);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function readHandoff(key: string | null): ExportStartupData | null {
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ExportHandoff;
    if (Date.now() - parsed.createdAt > 10 * 60 * 1000) {
      localStorage.removeItem(key);
      return null;
    }
    return { project: parsed.project, handoffAssets: Array.isArray(parsed.assets) ? parsed.assets : [] };
  } catch {
    return null;
  }
}

async function resolveLocalAssetRecords() {
  const assets = listLocalAssetRecords();
  if (!assets.some((asset) => asset.fileUrl?.startsWith(LOCAL_BLOB_PREFIX))) {
    return assets;
  }
  const store = await getAssetBlobStore();
  return Promise.all(
    assets.map(async (asset) => {
      if (!asset.fileUrl?.startsWith(LOCAL_BLOB_PREFIX)) return asset;
      const id = asset.fileUrl.slice(LOCAL_BLOB_PREFIX.length);
      const url = await withTimeout(store.getObjectUrl(id), 3000, `Media "${asset.fileName}"`);
      return url ? { ...asset, fileUrl: url } : asset;
    })
  );
}

async function loadProjectForExport(projectId: string, handoffKey: string | null, setLabel: (label: string) => void): Promise<ExportStartupData> {
  setLabel("Reading export handoff...");
  const handoff = readHandoff(handoffKey);
  if (handoff) {
    setLabel(handoff.handoffAssets.length ? "Loaded project and media handoff..." : "Loaded project snapshot from editor...");
    return handoff;
  }
  setLabel("Reading local project...");
  const localProject = readLocalProject(projectId);
  if (localProject) {
    setLabel("Loaded local project...");
    return { project: localProject, handoffAssets: [] };
  }
  throw new Error("Could not read the export handoff. Return to the editor and try Export again.");
}

/** A URL that only resolves inside the tab that created it — useless in this isolated export tab. */
function isTabScopedUrl(url: string | undefined): boolean {
  return !!url && (url.startsWith("blob:") || url.startsWith(LOCAL_BLOB_PREFIX));
}

async function loadAssetsForExport(handoffAssets: SourceAsset[], setLabel: (label: string) => void) {
  // Re-resolve on-device media in THIS tab: the editor handed off `blob:` object URLs, which are scoped to
  // the editor's document and are DEAD here. Local records + OPFS are shared across same-origin tabs, so we
  // re-resolve them to fresh, valid object URLs and use those wherever a handoff URL is tab-scoped.
  setLabel("Resolving local media...");
  const localResolved = await withTimeout(resolveLocalAssetRecords(), 5000, "Local media resolution").catch(() => [] as SourceAsset[]);
  const localById = new Map(localResolved.map((asset) => [asset.id, asset]));

  if (handoffAssets.length) {
    setLabel("Using media handoff from editor...");
    const repaired = handoffAssets.map((asset) => (isTabScopedUrl(asset.fileUrl) ? localById.get(asset.id) ?? asset : asset));
    // Include any local-only records the handoff didn't carry (e.g. assets added since the snapshot).
    for (const local of localResolved) {
      if (!repaired.some((asset) => asset.id === local.id)) repaired.push(local);
    }
    return repaired;
  }
  if (localResolved.length) return localResolved;
  throw new Error("No local media records were found for export.");
}

export function LocalExportPage() {
  const projectId = queryParam("projectId");
  const handoffKey = queryParam("handoff");
  const format = useMemo(formatFromQuery, []);
  const fps = useMemo(fpsFromQuery, []);
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [progress, setProgress] = useState(0);
  const [label, setLabel] = useState("Preparing isolated export...");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // NO started-once ref guard here. React StrictMode (dev) mounts effects twice (mount → cleanup → mount);
    // a guard would let the first run start, then the cleanup would abort it, and the second mount would be
    // blocked by the guard — leaving the export cancelled forever (stuck spinner). Instead each mount owns its
    // own `cancelled` flag + AbortController: the discarded first run aborts cleanly and is swallowed, and the
    // live (final) mount runs to completion. In production effects mount once, so this is a single run.
    let cancelled = false;
    const controller = new AbortController();
    const startupTimer = window.setTimeout(() => {
      if (!cancelled) {
        setError("Export startup did not begin. Close this tab and try again from the editor.");
        setStatus("error");
      }
    }, 5000);

    async function run() {
      if (!projectId) {
        throw new Error("Missing project id for isolated export.");
      }
      window.clearTimeout(startupTimer);
      setStatus("running");
      setLabel("Loading project...");
      const { project, handoffAssets } = await loadProjectForExport(projectId, handoffKey, setLabel);
      const assets = await loadAssetsForExport(handoffAssets, setLabel);
      const resolvedAssets =
        project.sourceAsset && !assets.some((asset) => asset.id === project.sourceAsset?.id)
          ? [project.sourceAsset, ...assets]
          : assets;
      const composition = ensureComposition(project.projectGraph, {
        name: project.title,
        durationSeconds: project.durationSeconds
      });
      const pluginLibrary = mergeLibraries(loadImportedPluginLibrary(), normalizeImportedPluginLibrary(project.projectGraph.plugins));
      hydrateLookManifests(pluginLibrary.looks);
      const transitionManifests = pluginLibrary.transitions;
      const lookManifests = pluginLibrary.looks;
      setLabel("Starting export engine...");
      await nextFrame();
      const blob = await exportLocally({
        composition,
        urlForAsset: (id) => resolvedAssets.find((asset) => asset.id === id)?.fileUrl,
        format,
        fps,
        transitionManifests,
        lookManifests,
        preferWorker: false,
        signal: controller.signal,
        onProgress: (fraction, nextLabel) => {
          if (cancelled) return;
          setProgress(fraction);
          setLabel(nextLabel);
        }
      });
      if (cancelled) return;
      const ext = format === "webm" ? "webm" : "mp4";
      await saveExportedFile(blob, `${project.title || "lumio"}.${ext}`);
      if (cancelled) return;
      setProgress(1);
      setLabel("Export saved.");
      setStatus("done");
    }

    void run().catch((err) => {
      if (cancelled) return;
      setError(err instanceof Error ? err.message : "Isolated export failed.");
      setStatus("error");
    });

    return () => {
      cancelled = true;
      window.clearTimeout(startupTimer);
      controller.abort();
    };
  }, [format, fps, handoffKey, projectId]);

  const percent = Math.round(progress * 100);
  return (
    <main className="isolated-export-page">
      <section className="isolated-export-panel">
        <div className="isolated-export-icon" aria-hidden="true">
          {status === "done" ? <CheckCircle2 size={28} /> : status === "error" ? <XCircle size={28} /> : status === "running" ? <Loader2 size={28} /> : <MonitorDown size={28} />}
        </div>
        <h1>Device Export</h1>
        <p>{status === "error" ? error : label}</p>
        <div className="isolated-export-progress" aria-label={`Export progress ${percent}%`}>
          <span style={{ width: `${percent}%` }} />
        </div>
        <small>{status === "running" ? `${percent}%` : status === "done" ? "You can close this tab." : "This tab runs without the editor preview mounted."}</small>
        <div className="isolated-export-actions">
          <Button variant="secondary" onClick={() => window.close()}>
            Close
          </Button>
        </div>
      </section>
    </main>
  );
}

export default LocalExportPage;
