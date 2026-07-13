import type { ExecutorAvailability } from "@kimera-by-aelivion/shared";
import { detectBrowserToolCapabilities } from "./capabilities";

/**
 * Maps the browser's live capability detection onto the shared `ExecutorAvailability`
 * shape `resolveExecutor` reads. The cloud tool service is a contract-only stub today
 * (see executor-registry.ts), so `cloud` is always false here.
 */
export function currentExecutorAvailability(): ExecutorAvailability {
  const capabilities = detectBrowserToolCapabilities();
  return {
    device: {
      webWorkers: capabilities.webWorkers,
      webGpu: capabilities.webGpu,
      webCodecs: capabilities.webCodecs,
      offscreenCanvas: capabilities.offscreenCanvas,
      opfs: capabilities.opfs,
      sharedArrayBuffer: capabilities.sharedArrayBuffer
    },
    cloud: false
  };
}
