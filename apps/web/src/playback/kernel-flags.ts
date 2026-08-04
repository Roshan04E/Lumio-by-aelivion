/**
 * The one place a kernel flag is resolved. After S7.2 exactly one flag remains, and it is not a
 * rollout flag.
 *
 * ## Rollout flags vs observability controls
 *
 * ADR-012 shipped eleven **rollout flags** — `kernelProxySource`, `kernelSessionSatisfaction`,
 * `kernelFrames`, `coherenceUnified` and the rest. Each one selected between two implementations of
 * the same behaviour so a slice could be merged before it was trusted and reverted from a URL at 2am.
 * Every one of them is gone (S7.2): the kernel is the runtime now, there is no second path to select,
 * and a flag that can only be set to its own value is a lie about what the editor will do.
 *
 * `kernelDiagnostics` is a different kind of switch and survives on purpose. It selects nothing. Every
 * site it guards was audited (25 of them, table in `plans/adr-012-phase3-soak.md`) and each has the
 * same shape: the state change happens OUTSIDE the guard and only `kernelDiagnostics.record(...)` sits
 * inside it. `rankAdmission` decides admission whether or not anyone is watching; the guard covers the
 * denial record. Turning it off changes what the runtime SAYS, never what it does.
 *
 * That distinction is what earns it a place in a codebase that just deleted every other flag: an
 * observability control is not a rollback path, and this programme's findings — the blind-share
 * detach, the `dc1319d` topology regression — were all read off instruments that had to be switchable
 * because R1 says an instrument must not charge the runtime while switched off.
 *
 * ## The key shape is DATA
 *
 * The storage key is declared, not derived from the query name. The four pre-consolidation readers had
 * already drifted into two namespaces (`orreris.${name}` and `orreris.kernel.${name}`), and a saved
 * browser profile or soak profile that pinned the key it was given must keep the setting it has.
 * Renaming a key silently resets it — a behavioural change smuggled in as cleanup.
 */

import { KERNEL_DIAGNOSTICS_FLAG_QUERY, KERNEL_DIAGNOSTICS_FLAG_STORAGE } from "@orreris/shared";

/**
 * How a stored/queried value becomes a boolean. Absent is NOT false — it means "not set", which is what
 * lets a default exist at all. Only `1`/`true` are true, so a typo reads as off for an opt-in flag and
 * off for a kill switch, which is the safe direction in both cases.
 */
const truthy = (value: string | null | undefined): boolean => value === "1" || value === "true";

export interface KernelFlag {
  /** URL query parameter, e.g. `?kernelDiagnostics=0`. Highest precedence — a link overrides a profile. */
  readonly query: string;
  /** localStorage key. Deliberately NOT derived from `query`; see the header. */
  readonly storage: string;
  /** What the flag reads when nothing is set. ON = kill switch, OFF = opt-in. */
  readonly defaultOn: boolean;
}

/**
 * The surviving flag. Default ON because the instruments are how this subsystem is diagnosed, and R1
 * makes that affordable: with diagnostics off the guarded sites allocate nothing.
 *
 * The diagnostics NAMES come from the kernel, so the module that owns the switch and the host that
 * reads it cannot disagree about what to look for.
 */
export const KERNEL_FLAGS = {
  diagnostics: { query: KERNEL_DIAGNOSTICS_FLAG_QUERY, storage: KERNEL_DIAGNOSTICS_FLAG_STORAGE, defaultOn: true },
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
