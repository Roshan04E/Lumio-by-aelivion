import { KERNEL_FLAGS, readKernelFlag } from "./kernel-flags";

/**
 * Settle window vs. frame completion (ADR-012 slice S2.2) — the flag, and the pure decisions.
 *
 * ## What the settle window is, and why it is a guess
 *
 * After any change the viewer keeps compositing for `SCENE_SETTLE_MS` (600ms), because async work — a
 * graded media frame, a text raster, a font load — may still be arriving and nothing tells the viewer
 * when it has all landed. The number is a guess at "long enough". It is the same guess five separate
 * timeouts in this runtime make, and ADR-012 I-30/I-31 exist because a bounded wait whose expiry is
 * indistinguishable from its success cannot be reasoned about: when the window closes, the viewer does
 * not know whether it closed because everything arrived or because time ran out.
 *
 * S2.1 gave frames identity. This slice gives them **completion**, so the window can be replaced by an
 * answer: composite until a frame *settles* — presents with no stale source and no unready layer — and
 * then stop, because there is provably nothing left to wait for.
 *
 * ## Why this ships measuring before it ships switching
 *
 * Collapsing the window is only safe if every async producer re-arms it on arrival (`requestDraw`).
 * Most do — a late raster explicitly does. But "most" is not a property, and the failure mode of being
 * wrong is a frame that never repaints, which is worse than a frame that repaints too often.
 *
 * So the flag is **off by default** and the instrument runs in **both** states. With the flag off we can
 * measure exactly what turning it on would have broken: {@link classifyComposite} labels every
 * settle-window composite, and the label that decides the question is `load-bearing` — a composite that
 * was NOT settled, in a window that had NOT been re-armed since the last settlement. Every one of those
 * is a repaint that closing the window would have lost. **Zero of them across a real soak is the
 * evidence that flipping the flag is safe**; a non-zero count names the producer that fails to re-arm,
 * which is a bug to fix rather than a reason to keep guessing.
 *
 * This is the same discipline the coherence barrier was held to (`temporal-coherence.ts`): do not
 * retire a mechanism, or adopt one, on anything but a measurement taken in a sound rig.
 */

/**
 * Is completion allowed to CLOSE the settle window? Flag (repo convention): `?kernelFrames=1` →
 * localStorage `orreris.kernelFrames` → **OFF**.
 *
 * Exclusive, per the programme: with it on the window is owned by the completion signal, with it off by
 * the timer. Never both — two mechanisms driving one window is regression G5, and the whole point is
 * that there be one answer to "is this frame done".
 *
 * Measurement is independent of the flag, so `?kernelFrames=0` still gives a fully instrumented
 * comparison run rather than a blind one.
 */
export function getFrameCompletionEnabled(): boolean {
  return readKernelFlag(KERNEL_FLAGS.frames);
}

/**
 * Do thumbnail and capture frames get their OWN caches? (ADR-012 I-32, slice S2.3.)
 * Flag: `?kernelScopes=1` → localStorage `orreris.kernelScopes` → **OFF**.
 *
 * ## What it is protecting
 *
 * A thumbnail is not a small live frame; it is a different frame that happens to look similar. It runs
 * at a different time, for a different consumer, on a different layer set — and today it runs through
 * the LIVE matte cache, the live nested-matte caches, the live Flarex source-draw cache and the live
 * grade renderers. So generating node thumbnails re-keys and evicts entries the live frame is about to
 * need, and the live frame pays for work it did not ask for. That is I-32, and it is invisible in
 * profiles because the cost lands on the *next* live frame rather than on the thumbnail.
 *
 * ## Why it is pixel-neutral, and why that is the whole safety argument
 *
 * These caches are memoization: an entry is derivable from its key. Giving a scratch pass its own
 * cache changes hit rates and nothing else — every pixel is identical, just occasionally recomputed.
 * The pixel gate is therefore a real check here rather than a formality, and a diff would mean a cache
 * was carrying state that was never a pure function of its key, which is a finding in itself.
 *
 * The cost is duplicated GPU memory while a capture handle is alive. It is bounded by disposing the
 * scratch scope with the handle — the same lifetime rule the `capture:`/`thumb:` grade-renderer pools
 * already follow, which is the precedent this generalises rather than a new idea.
 */
export function getFrameScopesEnabled(): boolean {
  return readKernelFlag(KERNEL_FLAGS.scopes);
}

/**
 * Is a proxy-served Flarex loader DEMOTED rather than deleted? (ADR-012 I-16/I-24, slice S3.5.)
 * Flag: `?kernelProxySource=1` → localStorage `orreris.kernelProxySource` → **OFF**.
 *
 * ## What it is protecting
 *
 * While a comp proxy serves, `VideoPreview` removes that comp's virtual loaders from the layer set.
 * That is what makes the proxy a win — a substituted comp that kept its loaders decoded N source streams
 * PLUS the proxy, measured at 75→35fps — and it is also I-16, a rendering decision changing whether a
 * source *exists*. The cost is the failure this slice is named for: a comp whose proxy falters has
 * neither a proxy nor a warm decoder, so every MediaIn soft-degrades to the host clip until N decoders
 * re-demux and re-index from cold. A cut, where the resource story should be a crossfade.
 *
 * On, the loaders stay mounted, hold their sessions at `preload` priority, hold their last frame, and
 * stop *pulling* frames. The performance win is preserved because a suspended loader's output is not
 * consumed anyway: while the proxy serves, the compiler is short-circuited and nothing reads them.
 *
 * ## Why OFF by default, unlike `kernelResources`
 *
 * Governance risk **R2**: *never ship two decoder slices in one release.* S3.3 already changed decoder
 * lifetime in this same unreleased range, and this slice keeps sessions alive that used to be freed —
 * exactly the cost the deletion existed to avoid. It needs its own soak against the 75→35fps regression
 * before it can carry a default, and a flag is what makes that soak an A/B rather than a bisect.
 */
export function getKernelProxySourceEnabled(): boolean {
  return readKernelFlag(KERNEL_FLAGS.proxySource);
}

/**
 * Does the kernel Resource Manager reclaim idle derived resources? (ADR-012 I-8/I-33, slice S3.4.)
 * Flag: `?kernelResources=0` → localStorage `orreris.kernelResources` → **ON**.
 *
 * ## What it is protecting
 *
 * The viewer's grade renderers and render targets are pruned by a set-difference loop that sits AFTER
 * the coherence-hold early return, so **a held frame reclaims nothing**. That is the amplifier in the
 * loop both runtime audits identified: slow sources → held frames → no reclamation → VRAM climbs →
 * context eviction → every cache destroyed → slow sources. The recovery mechanism feeds the failure,
 * which is why no amount of timeout tuning has ever broken the cycle (I-33).
 *
 * The kernel adds a **wall-clock idle sweep** that runs on every frame regardless of outcome. It cannot
 * race the fast path it backs up: an entry touched this frame has age zero, and the TTL is far longer
 * than the longest hold episode on record. In a healthy session it reclaims *nothing*, because the
 * set-difference prune already disposed everything it would have caught — it bites only in the failure.
 *
 * Default ON with a kill switch rather than off-by-default, unlike `kernelScopes`: this only ever
 * disposes resources that are provably unreferenced and would otherwise be leaked until a frame
 * presents, so the flag-off state is the one carrying the risk. Ownership itself (scopes replacing the
 * `capture:`/`thumb:` key-prefix sniffing) is unconditional and byte-neutral — the scope is derived from
 * the same prefix at registration, so the two sets are identical by construction.
 */
export function getKernelResourcesEnabled(): boolean {
  return readKernelFlag(KERNEL_FLAGS.resources);
}

/**
 * The kernel diagnostics flag, resolved HOST-side (ADR-012 I-36, slice S3.1).
 *
 * `?kernelDiagnostics=0` → localStorage `orreris.kernel.diagnostics` → **ON**. Default on, because the
 * sink is allocation-free while disabled at its call sites and the whole Phase 0 argument is that the
 * runtime should be observable by default rather than on request.
 *
 * The names come from the kernel so the two cannot disagree about what to look for; the *looking* is
 * the host's job, which is the entire point of the fix.
 */
export function resolveKernelDiagnosticsEnabled(): boolean {
  return readKernelFlag(KERNEL_FLAGS.diagnostics);
}



