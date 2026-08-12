/**
 * Zero-leftover-browser preflight — the one copy of it.
 *
 * WHY THIS FILE EXISTS. Playwright's `browser.close()` does NOT reliably reap its Chrome tree on
 * Windows. Leftovers accumulate silently across runs and then corrupt the NEXT run in ways that do
 * not look like process hygiene:
 *
 *   - DEBT-019's residency ladder (2026-08-12) measures the sum of all chrome.exe working sets.
 *     With 16-36 corpses alive, every rung baselined against the previous rung's high-water mark;
 *     baselines read 1.4-3.3 GB instead of ~470 MB and deltas came out NEGATIVE (-694 MB). The
 *     numbers looked like data.
 *   - The same day, in a different subsystem, the keyer session lost three pixel-gate runs to a
 *     leftover headless tree colliding with Remotion's own browser launch.
 *
 * Two sessions rediscovering the same root cause independently, in one day, is the expensive
 * version of this lesson. Hence one copy, called before the launch.
 *
 * HARD REFUSAL, NOT A WARNING. A warning is read after the bad number is already in a report --
 * which is precisely how the -694 MB rung got written down before anyone questioned it. A gate
 * that cannot reach a clean floor must fail to start, loudly.
 *
 * SCOPED TO AUTOMATION BROWSERS. This deliberately does not count (or touch) the user's own Chrome:
 * refusing to run a gate because someone has a browser open would be its own kind of broken, and
 * killing their tabs would be worse. Only processes carrying automation markers -- Playwright's
 * `--remote-debugging-port`, `--enable-automation`, `--headless`, or a temp-dir `--user-data-dir` --
 * are counted.
 *
 * REFUSES BUT DOES NOT KILL, by default. Those same automation markers are carried by Remotion's own
 * headless Chrome, so a preflight that reaps cannot tell "leftover from the last run" from "the
 * browser this run is currently rendering into" -- reaping at gate start killed Remotion mid-render
 * ("ProtocolError: Target closed") while this was being built. Clearing the machine is a human's
 * call; only a measurement ladder that provably owns the machine reaps, via `assertZeroBrowserFloor`.
 */
import { execSync } from "node:child_process";

const isWindows = process.platform === "win32";

/** Automation markers. A real user-launched Chrome carries none of these. */
const AUTOMATION_MARKERS = ["--remote-debugging-port", "--enable-automation", "--headless", "--disable-blink-features=AutomationControlled"];

function looksAutomated(commandLine: string): boolean {
  if (AUTOMATION_MARKERS.some((m) => commandLine.includes(m))) return true;
  // Playwright always points --user-data-dir at a temp profile; the user's Chrome uses its real one.
  return /--user-data-dir=[^\s"]*(?:Temp|tmp|playwright)/i.test(commandLine);
}

/**
 * PIDs of automation browser processes currently alive.
 *
 * On Windows a child process of an automated launch may report an EMPTY command line (access is
 * denied for some of the sandboxed children), so a strict per-process test would miss them. We
 * therefore treat the whole chrome.exe set as automated ONLY when at least one process is provably
 * automated and NO process is provably a user browser -- otherwise we count just the provable ones
 * and leave the ambiguous children alone.
 */
export function listAutomationBrowsers(): number[] {
  try {
    if (isWindows) {
      const raw = execSync(
        'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'chrome.exe\' or Name=\'msedge.exe\' or Name=\'chromium.exe\'\\" | ForEach-Object { $_.ProcessId.ToString() + \'|\' + $_.CommandLine }"',
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
      );
      const rows = raw
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const at = l.indexOf("|");
          return { pid: Number(l.slice(0, at)), cmd: l.slice(at + 1) };
        })
        .filter((r) => Number.isFinite(r.pid));
      const automated = rows.filter((r) => looksAutomated(r.cmd));
      if (!automated.length) return [];
      const userOwned = rows.some((r) => r.cmd && !looksAutomated(r.cmd) && /User Data/i.test(r.cmd));
      // No user browser in the picture -> the ambiguous empty-command-line children belong to the
      // automated trees, and leaving them behind is what poisons the next run's baseline.
      return userOwned ? automated.map((r) => r.pid) : rows.map((r) => r.pid);
    }
    const raw = execSync("ps -eo pid=,args=", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /chrome|chromium/i.test(l) && looksAutomated(l))
      .map((l) => Number(l.split(/\s+/)[0]))
      .filter((pid) => Number.isFinite(pid));
  } catch {
    return [];
  }
}

/** Kill every automation browser and wait for the count to reach zero. Returns how many died. */
export function reapAutomationBrowsers(timeoutMs = 10_000): number {
  const started = Date.now();
  const initial = listAutomationBrowsers().length;
  while (Date.now() - started < timeoutMs) {
    const pids = listAutomationBrowsers();
    if (!pids.length) return initial;
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone, or not ours to kill */
      }
    }
    // Cheap synchronous settle — this runs before any measurement, never inside one.
    try {
      execSync(isWindows ? "powershell -NoProfile -Command \"Start-Sleep -Milliseconds 400\"" : "sleep 0.4", { stdio: "ignore" });
    } catch {
      /* ignore */
    }
  }
  return initial;
}

/**
 * Reap, then REFUSE unless the machine is at a zero-browser floor. Unlike
 * `assertQuietBrowserMachine` this is NOT once-per-process: it is for measurement ladders that must
 * re-establish the floor between rungs (having closed their own browser first), where inheriting
 * the previous rung's working set is the exact error being guarded against.
 */
export function assertZeroBrowserFloor(label: string): void {
  reapAutomationBrowsers();
  const alive = listAutomationBrowsers();
  if (alive.length) {
    throw new Error(`${label}: refusing to measure — ${alive.length} browser process(es) survived the reap (pids ${alive.slice(0, 8).join(", ")}).`);
  }
}

export interface BrowserPreflightOptions {
  /** Gate name, for the failure message. */
  label: string;
  /**
   * Kill leftovers rather than just refusing. DEFAULT FALSE, and that default is load-bearing.
   *
   * A gate preflight must never kill a browser: `render:compare:pixels` drives Remotion's own
   * headless Chrome, which carries the very same automation markers a leftover does, and reaping at
   * gate start killed it mid-render ("ProtocolError: Target closed"). There is no reliable way to
   * tell "leftover from the last run" from "this run's other browser" by inspection, so the safe
   * primitive is to REFUSE and let a human clear the machine. Measurement ladders that provably own
   * the machine opt in via `assertZeroBrowserFloor` instead.
   */
  reap?: boolean;
}

/**
 * Set once this process has launched (or is about to launch) its own browser.
 *
 * WITHOUT THIS THE PREFLIGHT EATS ITS OWN GATE. Several gates call `launch()` more than once —
 * `wc-decoder-gate` launches per scenario, and a probe ladder launches per rung — and a second
 * call would find the FIRST browser alive, classify it as a leftover (it is automated; it is in a
 * temp profile) and kill it mid-run. So the machine is validated once, before this process has any
 * browser of its own to confuse itself with. Ladders that genuinely need a clean floor between
 * rungs call `reapAutomationBrowsers()` explicitly, after closing their own browser.
 */
let preflightDone = false;

/**
 * Refuse to continue unless no automation browser is alive. Call at the TOP OF `main()`, before the
 * gate has launched anything of its own -- not at the launch site, where this run's other browsers
 * are already alive and indistinguishable from leftovers.
 *
 * Throws on a dirty machine. That is the point: the alternative is a gate that runs, prints a
 * verdict, and is wrong in a direction nobody checks.
 */
export function assertQuietBrowserMachine(options: BrowserPreflightOptions): void {
  if (preflightDone) return;
  preflightDone = true;
  const { label, reap = false } = options;
  let alive = listAutomationBrowsers();
  if (alive.length && reap) {
    reapAutomationBrowsers();
    alive = listAutomationBrowsers();
  }
  if (alive.length) {
    throw new Error(
      `${label}: REFUSING TO RUN — ${alive.length} leftover automation browser process(es) are still alive ` +
        `(pids ${alive.slice(0, 8).join(", ")}${alive.length > 8 ? ", …" : ""}).\n` +
        `  Playwright's browser.close() does not reliably reap its tree on Windows, and a leftover tree ` +
        `corrupts this gate: memory ladders baseline against the corpses (measured: negative deltas), and ` +
        `Remotion's own launch collides with them (measured: three lost pixel-gate runs).\n` +
        `  Fix: taskkill /F /IM chrome.exe /T   (or kill the pids above), then re-run.`
    );
  }
}
