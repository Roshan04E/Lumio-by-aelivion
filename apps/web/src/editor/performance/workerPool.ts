/**
 * Worker pool abstraction (Phase 3 interface; concrete pool in Phase 5).
 * Generalises the existing one-off `tools/tracking-worker.ts` pattern so heavy
 * jobs (segmentation, tracking, decode) run off the main thread without each
 * feature hand-rolling worker plumbing. Falls back to inline execution when
 * Web Workers / OffscreenCanvas aren't available (reuses `capabilities.ts`).
 */
export interface WorkerJob<TInput, TOutput> {
  /** Identifies the worker entry/script to run. */
  kind: string;
  input: TInput;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
  /** Inline fallback when workers are unavailable. */
  runInline: (input: TInput) => Promise<TOutput>;
}

export interface WorkerPool {
  run<TInput, TOutput>(job: WorkerJob<TInput, TOutput>): Promise<TOutput>;
  readonly concurrency: number;
}

/**
 * Default pool: until the real worker transport is built (Phase 5), it executes
 * the job's `runInline` fallback. Swapping in a real pool later is transparent
 * to callers because the `WorkerPool` contract stays the same.
 */
export function createInlineWorkerPool(concurrency = 1): WorkerPool {
  return {
    concurrency,
    async run(job) {
      return job.runInline(job.input);
    }
  };
}
