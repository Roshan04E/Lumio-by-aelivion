/**
 * Render queue contract — shared by the API (producer) and worker (consumer) so the queue name and
 * message shape can never drift between them. Pure constants/types, no Redis/BullMQ deps, so this is
 * safe to live in @orreris/shared.
 *
 * The message intentionally carries ONLY the RenderJob id: the DB row is the source of truth for the
 * job's manifest/progress/status/cancellation. BullMQ is just the push channel that tells a worker
 * "this job is ready to render" (replacing the DB poll).
 */

/** BullMQ queue name for render (preview/final) jobs. */
export const RENDER_QUEUE_NAME = "orreris-jobs";

export interface RenderQueueJobData {
  /** The `RenderJob.id` to render. */
  renderJobId: string;
}
