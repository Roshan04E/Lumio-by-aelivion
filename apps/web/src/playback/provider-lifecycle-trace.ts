/**
 * DECODER PROVIDER LIFECYCLE TRACE — diagnosis instrument, 2026-07-28. Records events only; it never
 * changes a decision. `?providerTrace=1` (or localStorage `orreris.providerTrace`), OFF by default,
 * and every entry point short-circuits on a single boolean when off.
 *
 * WHY IT EXISTS. A 30s scrub created 32 decoder providers (`__rfWcPool.created` 6 → 38, only 16
 * reused), each re-parsing a 14–16MB moov on the main thread, with three
 * `InvalidStateError: Cannot call 'decode' on a closed codec` — a provider disposed while one of its
 * own `getFrame` calls was still awaiting inside the decode loop. That churn, not decode cost, is what
 * saturates the event loop and leaves sources unable to converge (a rebuilt provider restarts from a
 * keyframe, so it is legitimately seconds behind; one failure logged `micros=24100000`, the same 24.1s
 * that read as "24.3s staleness" in the coherence probe).
 *
 * Two hypotheses were already falsified by measurement — a frozen-tail spin (overshoot was 13ms
 * against a 350ms threshold) and idle churn (nothing moves at rest). Both were plausible and both were
 * wrong, which is why this exists: the remaining question — WHAT INITIATES each release/acquire cycle
 * — is answered by recording it, not by reading the code again.
 *
 * Read it with `__rfProviderTrace.report()` after one scrub gesture.
 */

export type ProviderTraceEvent =
  | "acquire"
  | "warm-reuse"
  | "cap-miss"
  | "create"
  | "release"
  | "park"
  | "evict"
  | "dispose"
  | "preempt"
  | "getFrame:start"
  | "getFrame:end"
  | "layer:effect"
  | "layer:cleanup";

/**
 * Why a lifecycle transition happened. The whole point of the exercise: `layer:effect` /
 * `layer:cleanup` carry the REACT-side cause (mount / src-change / epoch-bump), and the pool-side
 * events carry the POOL cause (eviction / preemption / cap). Pairing them across one gesture names
 * the initiator.
 */
export type ProviderTraceReason =
  | "mount"
  | "unmount"
  | "src-change"
  | "epoch-bump"
  | "preempt"
  | "pool-evict-idle-cap"
  | "pool-evict-mode-cap"
  | "pool-evict-total-cap"
  | "preempt-during-init"
  | "released-during-init"
  | "init-failed"
  | "explicit"
  | "unknown";

export interface ProviderTraceEntry {
  seq: number;
  /** ms since the trace was reset. */
  t: number;
  event: ProviderTraceEvent;
  /** Stable per-provider id (`p3`), or null before one exists. */
  provider: string | null;
  /** Short asset identity derived from the media URL. */
  asset: string;
  reason: ProviderTraceReason;
  /** Transport position at the moment of the event, when the caller knows it. */
  currentTime: number | null;
  /** `getFrame` calls outstanding on this provider AT THIS INSTANT. */
  inFlight: number;
  /** dispose/evict only: was work still in flight when the decoder was closed? */
  disposedWithInFlight?: boolean;
  /** getFrame:end only: did this call outlive its provider's disposal? (the confirmed race) */
  resolvedAfterDispose?: boolean;
  note?: string;
}

const MAX_ENTRIES = 4000;

function readFlag(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.has("providerTrace")) {
      const v = params.get("providerTrace");
      return v === "1" || v === "true";
    }
    return window.localStorage?.getItem("orreris.providerTrace") === "1";
  } catch {
    return false;
  }
}

const enabled = readFlag();

let seq = 0;
let origin = typeof performance !== "undefined" ? performance.now() : 0;
const entries: ProviderTraceEntry[] = [];

/** Provider identity + in-flight bookkeeping, keyed by the provider object itself. */
const providerIds = new WeakMap<object, string>();
const inFlightByProvider = new WeakMap<object, number>();
const disposedProviders = new WeakSet<object>();
let providerCounter = 0;

/** Stable short id for a provider object; assigned on first sight. */
export function traceProviderId(provider: object | null | undefined): string | null {
  if (!enabled || !provider) return null;
  let id = providerIds.get(provider);
  if (!id) {
    providerCounter += 1;
    id = `p${providerCounter}`;
    providerIds.set(provider, id);
  }
  return id;
}

/** Mirror one provider's identity onto its wrapper, so the serialize wrapper traces as the same id. */
export function traceAliasProvider(from: object | null | undefined, to: object | null | undefined): void {
  if (!enabled || !from || !to) return;
  const id = traceProviderId(from);
  if (id) providerIds.set(to, id);
}

/** Media URL → a short readable asset tag (`…/forest.mp4` → `forest.mp4`). */
export function traceAsset(url: string | null | undefined): string {
  if (!url) return "-";
  const clean = url.split("?")[0] ?? url;
  const tail = clean.split("/").pop() || clean;
  return tail.length > 28 ? `…${tail.slice(-27)}` : tail;
}

export function providerTraceEnabled(): boolean {
  return enabled;
}

export function traceEvent(args: {
  event: ProviderTraceEvent;
  provider?: object | null;
  asset?: string | null;
  reason?: ProviderTraceReason;
  currentTime?: number | null;
  note?: string;
  disposedWithInFlight?: boolean;
  resolvedAfterDispose?: boolean;
}): void {
  if (!enabled) return;
  const provider = args.provider ?? null;
  seq += 1;
  const entry: ProviderTraceEntry = {
    seq,
    t: Math.round((typeof performance !== "undefined" ? performance.now() : 0) - origin),
    event: args.event,
    provider: provider ? traceProviderId(provider) : null,
    asset: args.asset ?? "-",
    reason: args.reason ?? "unknown",
    currentTime: args.currentTime ?? null,
    inFlight: provider ? (inFlightByProvider.get(provider) ?? 0) : 0,
  };
  if (args.disposedWithInFlight !== undefined) entry.disposedWithInFlight = args.disposedWithInFlight;
  if (args.resolvedAfterDispose !== undefined) entry.resolvedAfterDispose = args.resolvedAfterDispose;
  if (args.note !== undefined) entry.note = args.note;
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.shift();
}

/** Called by the serialize wrapper around every `getFrame`. Returns a completion callback. */
export function traceGetFrame(provider: object, asset: string, requestedTime: number): () => void {
  if (!enabled) return () => {};
  inFlightByProvider.set(provider, (inFlightByProvider.get(provider) ?? 0) + 1);
  traceEvent({ event: "getFrame:start", provider, asset, reason: "explicit", currentTime: requestedTime });
  return () => {
    const next = Math.max(0, (inFlightByProvider.get(provider) ?? 1) - 1);
    inFlightByProvider.set(provider, next);
    traceEvent({
      event: "getFrame:end",
      provider,
      asset,
      reason: "explicit",
      currentTime: requestedTime,
      // THE RACE: this call outlived the disposal of the decoder it was driving.
      resolvedAfterDispose: disposedProviders.has(provider),
    });
  };
}

/** Called immediately BEFORE a provider's decoder is closed. */
export function traceDispose(provider: object, asset: string, reason: ProviderTraceReason): void {
  if (!enabled) return;
  const inFlight = inFlightByProvider.get(provider) ?? 0;
  disposedProviders.add(provider);
  traceEvent({ event: "dispose", provider, asset, reason, disposedWithInFlight: inFlight > 0 });
}

function report(): void {
  if (!enabled) {
    console.warn("[provider-trace] disabled — reload with ?providerTrace=1");
    return;
  }
  const rows = entries.map((e) => ({
    t: e.t,
    event: e.event,
    provider: e.provider ?? "",
    asset: e.asset,
    reason: e.reason,
    at: e.currentTime == null ? "" : Number(e.currentTime.toFixed(3)),
    inFlight: e.inFlight,
    race: e.resolvedAfterDispose ? "RESOLVED-AFTER-DISPOSE" : e.disposedWithInFlight ? "DISPOSED-WITH-INFLIGHT" : "",
    note: e.note ?? "",
  }));
  console.group(`%c[provider-trace] ${entries.length} events`, "font-weight:bold");
  console.table(rows);

  // The summary that actually answers the question.
  const initiators = new Map<string, number>();
  for (const e of entries) {
    if (e.event === "layer:effect" || e.event === "layer:cleanup" || e.event === "dispose" || e.event === "preempt") {
      const key = `${e.event} · ${e.reason}`;
      initiators.set(key, (initiators.get(key) ?? 0) + 1);
    }
  }
  console.log("%cinitiators (what started each cycle):", "font-weight:bold");
  for (const [key, n] of [...initiators.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}×  ${key}`);
  }
  const races = entries.filter((e) => e.resolvedAfterDispose).length;
  const disposedBusy = entries.filter((e) => e.disposedWithInFlight).length;
  console.log(
    races > 0 || disposedBusy > 0
      ? `%cUSE-AFTER-DISPOSE: ${disposedBusy} dispose(s) with work in flight, ${races} getFrame(s) resolved after disposal`
      : "%cno use-after-dispose observed",
    races > 0 || disposedBusy > 0 ? "color:#e55;font-weight:bold" : "color:#3c3"
  );
  console.groupEnd();
}

function reset(): void {
  entries.length = 0;
  seq = 0;
  origin = typeof performance !== "undefined" ? performance.now() : 0;
  console.log("[provider-trace] cleared — perform ONE scrub gesture, then __rfProviderTrace.report()");
}

if (typeof window !== "undefined" && enabled) {
  (window as unknown as Record<string, unknown>).__rfProviderTrace = { entries, report, reset, enabled };
  console.log("[provider-trace] armed — __rfProviderTrace.reset() → scrub → .report()");
}
