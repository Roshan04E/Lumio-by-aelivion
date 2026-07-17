/**
 * Kimera OS — perception scheduler (K1). All observer work funnels through here so perception
 * can never fight playback for the main thread / decoder sessions (the lesson the source-proxy
 * engine learned the hard way — see sourceProxyEngine.ts SUSPEND note).
 *
 * - Concurrency 1: one observation at a time, FIFO within a priority class.
 * - `user-blocking` (the user asked a question and is waiting) runs even while the background
 *   gate is closed — it's the user's own foreground intent, same as scrubbing.
 * - `idle` / `speculative` park until the shared background gate (playing / gesture / export /
 *   pressure) has been open long enough — reusing the editor's single gate authority instead
 *   of growing a second suspension system.
 */

import { whenBackgroundIdle } from "../../editor/performance/backgroundScheduler";

export type PerceptionPriority = "user-blocking" | "idle" | "speculative";

interface QueuedJob {
  priority: PerceptionPriority;
  run: () => Promise<void>;
}

const PRIORITY_ORDER: Record<PerceptionPriority, number> = {
  "user-blocking": 0,
  idle: 1,
  speculative: 2
};

const queue: QueuedJob[] = [];
let running = false;

export function schedulePerception<T>(priority: PerceptionPriority, job: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queue.push({
      priority,
      run: async () => {
        try {
          if (priority !== "user-blocking") {
            await whenBackgroundIdle();
          }
          resolve(await job());
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
    });
    queue.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
    void pump();
  });
}

async function pump(): Promise<void> {
  if (running) {
    return;
  }
  running = true;
  try {
    for (;;) {
      const next = queue.shift();
      if (!next) {
        return;
      }
      await next.run();
    }
  } finally {
    running = false;
    if (queue.length > 0) {
      void pump();
    }
  }
}

export function perceptionQueueDepth(): number {
  return queue.length + (running ? 1 : 0);
}
