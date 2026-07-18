/**
 * Crash telemetry ring buffer (Phase 4): capture the WHY behind a hard reload.
 *
 * crash-recovery restores the user's project after a tab dies; this records what was going wrong
 * beforehand so a post-crash session can explain it. `window.onerror` + `unhandledrejection`
 * append to a small localStorage ring buffer that SURVIVES the crash (in-memory telemetry doesn't).
 *
 * Reading it: `window.__rfCrashLog` (this session + persisted), and on boot any entries from the
 * previous ~30 minutes are surfaced once via console.warn — so "the page died, reopened, what
 * happened?" is answered by the console of the NEW session.
 */

const STORAGE_KEY = "orreris.crashLog";
const MAX_ENTRIES = 20;
const BOOT_SURFACE_WINDOW_MS = 30 * 60_000;

type CrashEntry = {
  at: string; // ISO timestamp
  type: "error" | "unhandledrejection";
  message: string;
  stack?: string | undefined;
  source?: string | undefined; // file:line for onerror
};

function readLog(): CrashEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as CrashEntry[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function append(entry: CrashEntry): void {
  try {
    const log = readLog();
    log.push(entry);
    while (log.length > MAX_ENTRIES) log.shift();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(log));
  } catch {
    /* storage unavailable/full — nothing to do, this is best-effort forensics */
  }
}

const clip = (value: unknown, max: number): string => String(value ?? "").slice(0, max);

export function installCrashTelemetry(): void {
  if (typeof window === "undefined") return;
  const w = window as unknown as Record<string, unknown>;
  if (w.__rfCrashTelemetryInstalled) return;
  w.__rfCrashTelemetryInstalled = true;

  // Surface the previous session's tail once: if the page hard-crashed, these entries are the
  // only record of why (the old console is gone).
  const previous = readLog().filter((e) => Date.now() - Date.parse(e.at) < BOOT_SURFACE_WINDOW_MS);
  if (previous.length > 0) {
    console.warn(
      `[crash-telemetry] ${previous.length} error(s) recorded in the last 30min (possibly from the previous session):`,
      previous.map((e) => `${e.at} ${e.type}: ${e.message}`)
    );
  }

  window.addEventListener("error", (event) => {
    append({
      at: new Date().toISOString(),
      type: "error",
      message: clip(event.message, 300),
      stack: clip(event.error instanceof Error ? event.error.stack : "", 600) || undefined,
      source: event.filename ? `${event.filename.split("/").pop()}:${event.lineno}` : undefined,
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    append({
      at: new Date().toISOString(),
      type: "unhandledrejection",
      message: clip(reason instanceof Error ? reason.message : reason, 300),
      stack: clip(reason instanceof Error ? reason.stack : "", 600) || undefined,
    });
  });

  Object.defineProperty(window, "__rfCrashLog", {
    configurable: true,
    get: () => readLog(),
  });
}
