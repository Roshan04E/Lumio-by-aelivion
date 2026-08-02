/**
 * Console handle for the kernel's point-in-time STATE (ADR-012 Phase 3).
 *
 * `__rfKernel` (diagnostics.ts) exposes the event ring: what happened. That is most of the story, but
 * it is the wrong shape for the numbers Phase 3 is judged on, which are *state* rather than events —
 * "how many sessions are open right now with nothing declared needing them" is not something a ring of
 * past events can answer, and it is precisely the number that must read zero.
 *
 * So this is the second half: one handle, the three Phase 3 ledgers, read live off `defaultSession`.
 * It exists because a soak that cannot be read is not a soak — the S3.3/S3.4/S3.5 safety arguments all
 * end in a number someone has to be able to type a name and see.
 *
 * Query-path only. Every call allocates and sorts; nothing here is on a frame path.
 */

import { decoderLedger } from "./decoder-manager";
import { getMediaSources } from "./media-manager";
import { resourceLedger } from "./resource-manager";
import { defaultSession } from "./session";

function now(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

/**
 * Everything Phase 3 asks of a running editor, in one object.
 *
 * The three fields that decide whether the phase is safe to build on are called out here rather than
 * left to be inferred from the sub-objects, because a soak reads this at 2am:
 *
 *  - `decoder.orphaned` — sessions alive with nothing declared needing them. **Must be empty.** This is
 *    the leak S3.3's retention could introduce.
 *  - `decoder.unmet` — sources that want a session and have none. Transient is normal (a session takes a
 *    demux and an index); persistent is starvation, and retention must never be what hides it.
 *  - `resources.reclaimedWhileUnpresented` — the I-33 census. **Non-zero is the finding**, not the
 *    failure: every one is memory the old prune would have held until a frame presented.
 */
export function kernelState() {
  const at = now();
  const media = getMediaSources(defaultSession);
  return {
    media: {
      declared: media.declared.length,
      demoted: media.demoted,
      suppressed: media.suppressed,
      /** Under S3.5 this should be empty and `demoted` should carry the count instead. */
      active: media.active.length,
    },
    decoder: decoderLedger(defaultSession),
    resources: resourceLedger(defaultSession, at),
  };
}

// Same convention and the same reasoning as `__rfKernel` / `__rfFlarexDegradation`: discoverability beats
// tidiness, because the whole point is that someone can open a real project and read the number without
// reading any source.
if (typeof globalThis !== "undefined") {
  Object.defineProperty(globalThis, "__rfKernelState", {
    configurable: true,
    get: () => kernelState(),
  });
}
