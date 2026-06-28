import type { ToolDiagnostic } from "@reelforge/shared";

export interface BrowserToolCapabilities {
  webWorkers: boolean;
  offscreenCanvas: boolean;
  webCodecs: boolean;
  webGpu: boolean;
  opfs: boolean;
  audioContext: boolean;
  sharedArrayBuffer: boolean;
  crossOriginIsolated: boolean;
}

export function detectBrowserToolCapabilities(): BrowserToolCapabilities {
  const navigatorWithStorage = navigator as Navigator & {
    gpu?: unknown;
    storage?: StorageManager & {
      getDirectory?: () => Promise<FileSystemDirectoryHandle>;
    };
  };
  const globalWithAudio = globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext };

  return {
    webWorkers: typeof Worker !== "undefined",
    offscreenCanvas: typeof OffscreenCanvas !== "undefined",
    webCodecs: typeof VideoFrame !== "undefined" && typeof VideoEncoder !== "undefined",
    webGpu: Boolean(navigatorWithStorage.gpu),
    opfs: Boolean(navigatorWithStorage.storage?.getDirectory),
    audioContext: typeof AudioContext !== "undefined" || typeof globalWithAudio.webkitAudioContext !== "undefined",
    sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
    crossOriginIsolated: Boolean(globalThis.crossOriginIsolated)
  };
}

export function browserCapabilityDiagnostics(capabilities: BrowserToolCapabilities): ToolDiagnostic[] {
  const diagnostics: ToolDiagnostic[] = [];

  if (!capabilities.webWorkers) {
    diagnostics.push({
      level: "error",
      code: "NO_WEB_WORKERS",
      message: "Web Workers are unavailable, so long-running browser tools cannot run safely."
    });
  }

  if (!capabilities.opfs) {
    diagnostics.push({
      level: "warning",
      code: "NO_OPFS",
      message: "OPFS is unavailable; generated tool artifacts will use an in-memory fallback for now."
    });
  }

  if (!capabilities.offscreenCanvas) {
    diagnostics.push({
      level: "warning",
      code: "NO_OFFSCREEN_CANVAS",
      message: "OffscreenCanvas is unavailable; preview sampling may use main-thread canvas fallback."
    });
  }

  if (!capabilities.webCodecs) {
    diagnostics.push({
      level: "info",
      code: "NO_WEBCODECS",
      message: "WebCodecs is unavailable; browser export/transcode paths should use fallback adapters."
    });
  }

  if (!capabilities.webGpu) {
    diagnostics.push({
      level: "info",
      code: "NO_WEBGPU",
      message: "WebGPU is unavailable; local AI acceleration will use CPU or cloud adapters later."
    });
  }

  if (capabilities.webWorkers && capabilities.opfs) {
    diagnostics.push({
      level: "info",
      code: "BROWSER_RUNTIME_READY",
      message: "Browser runtime can run cancellable tools and persist generated artifacts locally."
    });
  }

  return diagnostics;
}
