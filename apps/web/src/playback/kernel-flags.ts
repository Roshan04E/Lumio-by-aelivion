/**
 * The one place a kernel feature flag is resolved (ADR-012 programme risk R7 — flag discipline).
 *
 * ## Why this exists
 *
 * The 2026-08-03 conformance review found the resolution order — query param → localStorage → default —
 * implemented **four times**: twice as helpers in `frame-completion.ts` (`readFlag`, `readFlagDefaultOn`)
 * and twice inline in `preview-frame-pool.ts`, each with its own copy of `truthy`, its own try/catch and
 * its own default. Four implementations of one rule is four places for it to drift, and the drift had
 * already started: the helper composes its storage key as `orreris.${name}` while the inline readers use
 * a dotted `orreris.kernel.${name}` namespace.
 *
 * A flag nobody can predict the resolution of is worse than no flag, because the rollback path in R7 is
 * the thing you reach for when something is on fire at 2am.
 *
 * ## The keys are DATA, not a convention to be tidied
 *
 * This consolidation is deliberately behaviour-preserving, and that means **keeping both key shapes**.
 * A user (or a soak profile, or a saved browser session) that set `orreris.kernel.decoderLifetime` must
 * keep the setting it has; renaming it to match the other convention would silently reset every flag
 * anyone had pinned — a behavioural change smuggled in as cleanup, and precisely the kind of "while I
 * was in there" edit that makes a rollback path untrustworthy.
 *
 * So every flag declares its own query name and its own storage key, and the table below is the
 * authoritative record of both. Unifying the key shapes is a separate, migration-bearing change.
 */

import { KERNEL_DIAGNOSTICS_FLAG_QUERY, KERNEL_DIAGNOSTICS_FLAG_STORAGE } from "@orreris/shared";

/**
 * How a stored/queried value becomes a boolean. Absent is NOT false — it means "not set", which is what
 * lets a default exist at all. Only `1`/`true` are true, so a typo reads as off for an opt-in flag and
 * off for a kill switch, which is the safe direction in both cases.
 */
const truthy = (value: string | null | undefined): boolean => value === "1" || value === "true";

export interface KernelFlag {
  /** URL query parameter, e.g. `?kernelProxySource=1`. Highest precedence — a link overrides a profile. */
  readonly query: string;
  /** localStorage key. Deliberately NOT derived from `query`; see the header. */
  readonly storage: string;
  /** What the flag reads when nothing is set. ON = kill switch, OFF = opt-in. */
  readonly defaultOn: boolean;
}

/**
 * Every kernel flag in the programme, with its declared rollback default.
 *
 * The defaults are not stylistic. `kernelProxySource` and `kernelSessionSatisfaction` ship OFF under
 * risk **R2** (never ship two decoder slices in one release; soak before every merge in Phases 3–4) —
 * off by default means the merge carries no behavioural risk while the arms are measured, and the flip
 * is a separate evidenced decision. `kernelResources` and `kernelDecoderLifetime` ship ON because for
 * those the flag-OFF state is the one carrying risk: they reclaim resources that would otherwise leak
 * and give sessions an owner that would otherwise be a component unmount.
 */
export const KERNEL_FLAGS = {
  // The diagnostics NAMES come from the kernel, so the module that owns the switch and the host that
  // reads it cannot disagree about what to look for. Every other flag is host-owned and names itself.
  diagnostics: { query: KERNEL_DIAGNOSTICS_FLAG_QUERY, storage: KERNEL_DIAGNOSTICS_FLAG_STORAGE, defaultOn: true },
  decoderLifetime: { query: "kernelDecoderLifetime", storage: "orreris.kernel.decoderLifetime", defaultOn: true },
  resources: { query: "kernelResources", storage: "orreris.kernelResources", defaultOn: true },
  // ONE exclusive flag for S4.5+S4.6 (ADR-012 §4, atomic group). They cannot be separated: deleting
  // the host-clip fallback exposes every readiness gap the substitution was hiding, and only the
  // unified barrier — one coherence mechanism across both transport states, answering with a moment
  // instead of a boolean — covers them. S4.4 is NOT in this group; it is additive and shipped alone.
  coherenceUnified: { query: "kernelCoherenceUnified", storage: "orreris.kernel.coherenceUnified", defaultOn: false },
  // S5.3. OFF by default: flag-off is the pre-slice behaviour EXACTLY (frame-counted TTLs, prunes only
  // at the tail of a composited frame), and the declared risk is over-aggressive reclamation causing
  // re-upload churn — which only a soak can rule out.
  // S5.4. OFF by default: the upload pass is a new GL draw per proxied comp per decoded version, and
  // "low risk" in the programme is an argument about correctness, not about frame budget.
} as const satisfies Record<string, KernelFlag>;

/**
 * Resolve one flag: query param → localStorage → declared default.
 *
 * The try/catch is not defensive padding. SSR has no `window`, and a browser with storage disabled
 * *throws* on `localStorage` access rather than returning null — a flag reader that propagates that
 * takes down whatever called it, which for these flags is module initialisation.
 */
export function readKernelFlag(flag: KernelFlag): boolean {
  if (typeof window !== "undefined") {
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.has(flag.query)) return truthy(params.get(flag.query));
      const stored = window.localStorage?.getItem(flag.storage);
      if (stored != null) return truthy(stored);
    } catch {
      /* SSR / restricted storage — fall through to the declared default */
    }
  }
  return flag.defaultOn;
}
