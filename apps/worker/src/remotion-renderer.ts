import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { ensureBrowser, renderMedia, renderStill, selectComposition, type CancelSignal } from "@remotion/renderer";
import type { RenderManifest } from "@orreris/render-templates";
import { compositionId } from "./remotion/Root";
import { manifestNeedsAudioPostMix, postMixManifestAudio } from "./audio-post-mix";

let bundleLocationPromise: Promise<string> | undefined;

/** Common install locations for a Chromium-based browser Remotion can drive, per platform. */
function candidateBrowserPaths(): string[] {
  if (process.platform === "win32") {
    const programFiles = process.env["ProgramFiles"] ?? "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const localAppData = process.env["LOCALAPPDATA"] ?? "";
    return [
      `${localAppData}\\Google\\Chrome\\Application\\chrome.exe`,
      `${programFiles}\\Google\\Chrome\\Application\\chrome.exe`,
      `${programFilesX86}\\Google\\Chrome\\Application\\chrome.exe`,
      `${programFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${programFilesX86}\\Microsoft\\Edge\\Application\\msedge.exe`
    ];
  }
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium"
    ];
  }
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge"
  ];
}

let resolvedExecutable: string | null | undefined;

/**
 * Resolve a Chromium executable to drive: an explicit REMOTION_BROWSER_EXECUTABLE wins, else
 * the first installed Chrome/Edge we can find. Returns null to fall back to Remotion's managed
 * Chrome Headless Shell download. Cached after the first lookup; logged once so it's obvious
 * which browser a render is using.
 */
function resolveBrowserExecutable(): string | null {
  if (resolvedExecutable !== undefined) return resolvedExecutable;
  const explicit = process.env.REMOTION_BROWSER_EXECUTABLE;
  if (explicit) {
    resolvedExecutable = explicit;
  } else {
    const found = candidateBrowserPaths().find((candidate) => candidate && existsSync(candidate));
    resolvedExecutable = found ?? null;
    if (found) {
      console.log(`[worker] Using installed browser for renders: ${found}`);
    } else {
      console.log("[worker] No installed Chrome/Edge found; will download Chrome Headless Shell.");
    }
  }
  return resolvedExecutable;
}

// Spread conditionally so we never pass `browserExecutable: undefined`.
function browserExecutableOption(): { browserExecutable: string } | Record<string, never> {
  const browserExecutable = resolveBrowserExecutable();
  return browserExecutable ? { browserExecutable } : {};
}

/**
 * Surface select worker-process env vars into the Remotion bundle as `process.env.*` (read by Root.tsx).
 * `RENDERER_MODE` is retained for older harnesses; `REMOTION_COMPOSITOR=legacy` is a retired escape-hatch hint.
 * SceneStage is the default cloud compositor. Spread conditionally so we never set empty `envVariables`.
 */
function rendererEnvVariables(rendererMode?: "legacy" | "webgl"): { envVariables: Record<string, string> } | Record<string, never> {
  const envVariables: Record<string, string> = {};
  if (rendererMode) envVariables.RENDERER_MODE = rendererMode;
  if (process.env.REMOTION_COMPOSITOR) envVariables.REMOTION_COMPOSITOR = process.env.REMOTION_COMPOSITOR;
  return Object.keys(envVariables).length ? { envVariables } : {};
}

/**
 * Ensure a usable Chromium up front, inside the caller's awaited try/catch, so a download
 * failure becomes a clean "render failed" job error rather than a later mid-render crash.
 * Skipped when an installed browser was resolved (no download needed).
 */
async function ensureBrowserReady(): Promise<void> {
  if (resolveBrowserExecutable()) return;
  await ensureBrowser();
}

/**
 * Map the manifest's managed output color space to a Remotion `colorSpace`. v1 masters only Rec.709
 * SDR → "bt709"; an unknown/future output space falls back to BT.709 with a warning (no HDR pipeline yet).
 */
function manifestOutputColorSpace(manifest: RenderManifest): "bt709" {
  const out: string | undefined = manifest.output.color?.output;
  if (out && out !== "rec709-sdr") {
    console.warn(`[render] unsupported manifest output color "${out}" → tagging BT.709`);
  }
  return "bt709";
}

export async function renderManifestToMp4(input: {
  manifest: RenderManifest;
  outputLocation: string;
  onProgress?: (progress: number) => Promise<void> | void;
  cancelSignal?: CancelSignal;
}) {
  await ensureBrowserReady();
  const serveUrl = await getBundleLocation();
  const inputProps = { manifest: input.manifest };
  const cancel = input.cancelSignal ? { cancelSignal: input.cancelSignal } : {};
  const composition = await selectComposition({
    serveUrl,
    id: compositionId,
    inputProps,
    ...browserExecutableOption(),
    ...cancel
  });

  // Track-pan parity: Remotion has no <Audio> pan, so when the mixer's pan is in play we render
  // the video MUTED and rebuild the audio ourselves (shared-evaluator JS mix + ffmpeg mux — see
  // audio-post-mix.ts). Pan-free compositions keep the untouched Remotion audio path.
  const audioPostMix = manifestNeedsAudioPostMix(input.manifest);
  const videoLocation = audioPostMix ? `${input.outputLocation}.video.mp4` : input.outputLocation;

  await renderMedia({
    codec: "h264",
    composition,
    serveUrl,
    inputProps,
    ...(audioPostMix ? { muted: true } : {}),
    // Lossless intermediate frames. Remotion defaults to imageFormat "jpeg" at jpegQuality 80, so
    // EVERY frame is JPEG-compressed before the H.264 encoder even runs — a visible "soft" quality
    // loss (fine detail/text) stacked on top of the final CRF encode. PNG makes the render → encode
    // hand-off lossless, so the only compression is the single final H.264 pass — matching the
    // on-device WebCodecs export, which encodes frames directly with no lossy intermediate.
    imageFormat: "png",
    // Without this, ffmpeg encodes the sRGB page pixels without converting/tagging for BT.709
    // limited range, and players decode the full-range data as limited → contrast/saturation
    // blowout vs the editor preview (measured up to ±19/255 on grays; see architecture.md
    // 2026-07-02 cloud-export color parity entry). "bt709" converts AND tags: measured roundtrip
    // in Chrome is then ±1 — pixel-parity with the web preview and the local WebCodecs export.
    // Driven by the manifest's managed output color space (v1 always Rec.709 SDR → bt709), so the
    // local export and this cloud render agree by construction, and future output spaces are a data change.
    colorSpace: manifestOutputColorSpace(input.manifest),
    // Remotion's parallel (pre-encoded) path converts RGB→YUV with BT.601 coefficients while the
    // container still gets tagged BT.709 — saturated colors shift hard (measured ±39/255 on pure
    // green/magenta). Disallowing it routes through the ffmpeg stitch step whose
    // `zscale=matrix=709` filter does the conversion the tag promises. Slower (frames buffered to
    // disk before encode) but color-correct; drop when Remotion fixes the pre-encode matrix.
    disallowParallelEncoding: true,
    // ANGLE backend so the in-composition WebGL2 color engine (3D-LUT grade for image
    // layers, incl. HSL hue-curves/secondary that SVG can't express) runs headless.
    chromiumOptions: { gl: "angle" },
    ...browserExecutableOption(),
    ...rendererEnvVariables(),
    ...cancel,
    outputLocation: videoLocation,
    onProgress: async ({ progress }) => {
      // Reserve the last 5% for the audio post-mix step when it runs.
      await input.onProgress?.(audioPostMix ? progress * 0.95 : progress);
    }
  });

  if (audioPostMix) {
    await postMixManifestAudio(input.manifest, videoLocation, input.outputLocation);
    await input.onProgress?.(1);
  }
}

export async function renderManifestStill(input: {
  manifest: RenderManifest;
  frame: number;
  outputLocation: string;
  /** "webgl" routes media through the shared MediaWebGLRenderer (unified path). */
  rendererMode?: "legacy" | "webgl";
}) {
  await ensureBrowserReady();
  const serveUrl = await getBundleLocation();
  const inputProps = { manifest: input.manifest };
  const composition = await selectComposition({
    serveUrl,
    id: compositionId,
    inputProps,
    ...browserExecutableOption()
  });

  await renderStill({
    composition,
    serveUrl,
    inputProps,
    frame: input.frame,
    // Match renderMedia: enable WebGL for the in-composition 3D-LUT color engine.
    chromiumOptions: { gl: "angle" },
    ...browserExecutableOption(),
    // Surfaced to the browser bundle as process.env.* (RENDERER_MODE + REMOTION_COMPOSITOR), read by Root.tsx.
    ...rendererEnvVariables(input.rendererMode),
    output: input.outputLocation
  });
}

async function getBundleLocation() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  bundleLocationPromise ??= bundle({
    entryPoint: path.join(here, "remotion", "entry.tsx"),
    // Serve apps/worker/public so staticFile() resolves the warp font binaries.
    publicDir: path.join(here, "..", "public"),
    webpackOverride: (config) => config
  });
  return bundleLocationPromise;
}
