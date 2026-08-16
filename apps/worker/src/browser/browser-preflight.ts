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
 *
 * IT ALSO COUNTS THE HARNESS ITSELF (2026-08-12), and that addition has its own measured cost. A
 * `wc:gate` run hung with no output and no browser for ~25 minutes; the machine was holding two
 * leftover NODE trees from earlier gate runs, and this preflight passed it, because it counts
 * browsers and a corpse that never got as far as launching one is invisible to that count. That is
 * the same failure this file was promoted to prevent -- a gate that starts on a dirty machine and
 * produces a reading nobody questions -- one process class over. So `assertQuietBrowserMachine` now
 * also refuses on a live process running THIS gate's own script, excluding this process and its
 * ancestors (the `pnpm`/`tsx` chain that launched it carries the script name in its command line too,
 * and a preflight that fails on its own launcher is worse than no preflight).
 *
 * AND IT REAPS LEAKED PROFILE DIRS (2026-08-16), which is the same lesson a third time. "The machine
 * is clean" had meant no stray browser and no stale harness; it now also means the machine can still
 * WRITE. A full disk is the quietest member of this family: it surfaces as frames that do not
 * reproduce, which reads as a renderer defect rather than an environment one -- 195.8 GB of leaked
 * profiles voided a night of field readings and nearly put a false I-P8 finding in the tracker
 * (DEBT-024/025). The free-disk REFUSAL is `assertFreeDisk`; this file also has to COLLECT, because a
 * precondition the tooling violates by design every single run is one nobody can satisfy by hand.
 *
 * THE PATTERN, for whoever adds the fourth. Each entry here was paid for by a run whose OUTPUT LOOKED
 * LIKE DATA -- negative memory deltas, a 25-minute hang, an irreproducible frame. If a precondition
 * can only be noticed after the fact by disbelieving a plausible number, it belongs in this file as a
 * hard refusal, not in a checklist someone reads afterwards.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const isWindows = process.platform === "win32";

/**
 * Leaked headless-browser profile directories, and why the reaper below is not optional.
 *
 * 13,995 of these had accumulated (195.8 GB, oldest 7 days). That is not an incident -- it is very
 * nearly EVERY browser this repo has ever launched. `remotion-renderer.ts` calls `selectComposition`,
 * `renderMedia` and `renderStill` without a shared `puppeteerInstance`, so each call opens and closes
 * its own browser; the close runs, but puppeteer's cleanup of its temp profile fails silently on
 * Windows when Chrome still holds handles under it. Two-plus profiles per fixture, ~23 fixtures, every
 * gate run, for a week.
 *
 * WITHOUT REAPING, THE FREE-DISK CHECK IS A TRAP. `assertFreeDisk` would refuse to run gates because
 * of garbage the gates themselves produced, and the operational answer would become "delete 14,000
 * directories by hand every few days", which nobody does -- so `GATE_MIN_FREE_GB` would get set to 0
 * and the guard would be worth nothing. A precondition that the tooling routinely violates by design
 * has to come with its own collector, which is why this sits in the same file and runs FIRST.
 *
 * The real fix is a shared browser instance in the renderer (DEBT-026): fewer launches, faster gates,
 * and no garbage to collect. This reaper makes that non-urgent rather than replacing it.
 */
const PROFILE_DIR_PATTERNS = [/^puppeteer_dev_chrome_profile/i, /^playwright[_-]/i, /^\.org\.chromium\.Chromium\./i];

const DEFAULT_REAP_AGE_MS = 2 * 60 * 60 * 1000;
/** Preflight must stay a preflight. Leftover garbage beyond this budget is caught by the next run. */
const REAP_TIME_BUDGET_MS = 20_000;

export interface ProfileReapResult {
  removed: number;
  failed: number;
  skippedYoung: number;
  timedOut: boolean;
}

/**
 * Best-effort delete of stale browser profile directories in the temp dir.
 *
 * AGE IS THE ONLY SAFETY GUARD, and it is the right one. A live run's profile is minutes old, so a
 * 2-hour threshold cannot touch it; and unlike the process checks in this file there is no way to ask
 * a directory who owns it. Deliberately NOT gated on "no automation browser alive" -- gates run
 * concurrently with each other and with the user's own work, and a reaper that only fires on a
 * perfectly idle machine would never fire at all.
 *
 * Never throws. This is housekeeping: a failed delete (Chrome still holding a handle) is normal, and
 * a preflight that dies while tidying up would be worse than the mess.
 */
export function reapStaleBrowserProfiles(maxAgeMs = DEFAULT_REAP_AGE_MS, dir?: string): ProfileReapResult {
  const result: ProfileReapResult = { removed: 0, failed: 0, skippedYoung: 0, timedOut: false };
  if (maxAgeMs <= 0) return result;
  const startedAt = Date.now();
  const cutoff = startedAt - maxAgeMs;
  let entries: fs.Dirent[];
  // `dir` is for the self-test only. Without it the test shares the machine's real temp backlog, and
  // a large backlog eats the time budget on alphabetically-earlier names before reaching the test's
  // own fixtures -- which presents as a failing reaper (measured: two false failures while 195.8 GB
  // was being cleared). A guard's own test must not depend on how dirty the machine happens to be.
  const tmp = dir ?? os.tmpdir();
  try {
    entries = fs.readdirSync(tmp, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !PROFILE_DIR_PATTERNS.some((p) => p.test(entry.name))) continue;
    if (Date.now() - startedAt > REAP_TIME_BUDGET_MS) {
      result.timedOut = true;
      break;
    }
    const full = path.join(tmp, entry.name);
    try {
      // birthtime is unreliable across filesystems; mtime is what actually tracks last use here.
      const stat = fs.statSync(full);
      if (Math.max(stat.mtimeMs, stat.birthtimeMs) > cutoff) {
        result.skippedYoung += 1;
        continue;
      }
      fs.rmSync(full, { recursive: true, force: true, maxRetries: 1 });
      result.removed += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}

/**
 * Refuse to run when either volume a browser gate writes to is below the floor.
 *
 * BOTH volumes are checked because the writes are split: the browser's profile, its cache and its
 * crash dumps go to the TEMP volume (that is where the 195.8 GB of leaked profiles accumulated),
 * while screenshots, fixture output and the vite dep cache go to the REPO volume. On this machine
 * they are both C:, but the check must not assume that -- a gate is just as void when the drive it
 * writes screenshots to is the full one.
 *
 * Exported separately from `assertQuietBrowserMachine` so a measurement ladder can re-assert it
 * between rungs: a long ladder can EXHAUST the disk partway through, and the rungs after that point
 * are void while the rungs before are fine. That is the same reason `assertZeroBrowserFloor` exists.
 */
export function reapProfilesForPreflight(): void {
  const raw = Number(process.env.GATE_PROFILE_REAP_HOURS);
  const hours = Number.isFinite(raw) && raw >= 0 ? raw : 2;
  const reaped = reapStaleBrowserProfiles(hours * 60 * 60 * 1000);
  if (reaped.removed > 0 || reaped.timedOut) {
    process.stdout.write(
      `[preflight] reaped ${reaped.removed} stale browser profile dir(s)` +
        (reaped.skippedYoung ? `, kept ${reaped.skippedYoung} younger than ${hours}h` : "") +
        (reaped.failed ? `, ${reaped.failed} in use` : "") +
        (reaped.timedOut ? ` — hit the ${REAP_TIME_BUDGET_MS / 1000}s budget, more will go next run` : "") +
        "\n"
    );
  }
}

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

interface HarnessProcess {
  pid: number;
  cmd: string;
}

/**
 * Live node processes running `scriptMarker`, EXCLUDING this process and its ancestors.
 *
 * The exclusion is not a nicety. A gate is normally launched as pnpm -> tsx -> node, and every link
 * in that chain carries the script name in its own command line, so a naive match refuses on the
 * launcher that is currently running the check. Walking up `ParentProcessId` from `process.pid`
 * removes exactly the chain that belongs to this run and nothing else -- a sibling run's chain has a
 * different root and stays visible, which is the case worth catching.
 *
 * Returns [] on any enumeration failure: this is a guard, and a guard that cannot see the machine
 * must not invent a reason to block work.
 */
export function listStaleHarnessProcesses(scriptMarker: string): HarnessProcess[] {
  try {
    const rows: { pid: number; ppid: number; name: string; cmd: string }[] = [];
    if (isWindows) {
      // EVERY process, not just node.exe. The ancestor walk below needs an unbroken parent chain, and
      // this run's chain is not all node: `pnpm --dir … exec tsx …` puts a shell between the launcher
      // and the script. Enumerating node.exe alone left a hole in the map, the walk stopped at it, and
      // the preflight refused on its OWN two pnpm parents (measured, the first run after this change).
      const raw = execSync(
        'powershell -NoProfile -Command "Get-CimInstance Win32_Process | ForEach-Object { $_.ProcessId.ToString() + \'|\' + $_.ParentProcessId.ToString() + \'|\' + $_.Name + \'|\' + $_.CommandLine }"',
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 }
      );
      for (const line of raw.split(/\r?\n/)) {
        const parts = line.trim().split("|");
        if (parts.length < 4) continue;
        const pid = Number(parts[0]);
        const ppid = Number(parts[1]);
        if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
        rows.push({ pid, ppid, name: parts[2] ?? "", cmd: parts.slice(3).join("|") });
      }
    } else {
      const raw = execSync("ps -eo pid=,ppid=,args=", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      for (const line of raw.split(/\r?\n/)) {
        const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        if (!match) continue;
        rows.push({ pid: Number(match[1]), ppid: Number(match[2]), name: "", cmd: match[3]! });
      }
    }
    const parentOf = new Map(rows.map((r) => [r.pid, r.ppid]));
    const ownChain = new Set<number>();
    let cursor: number | undefined = process.pid;
    // Bounded: a corrupt/cyclic parent map must not hang a preflight.
    for (let hop = 0; cursor != null && hop < 64 && !ownChain.has(cursor); hop += 1) {
      ownChain.add(cursor);
      cursor = parentOf.get(cursor);
    }
    return rows
      .filter((r) => (isWindows ? /^node\.exe$/i.test(r.name) : true))
      .filter((r) => r.cmd.includes(scriptMarker) && !ownChain.has(r.pid))
      .map((r) => ({ pid: r.pid, cmd: r.cmd.slice(0, 160) }));
  } catch {
    return [];
  }
}

export interface BrowserPreflightOptions {
  /** Gate name, for the failure message. */
  label: string;
  /**
   * Source-file marker (e.g. `"wc-decoder-gate"`) for this gate's OWN process class.
   *
   * Opt-in per gate, because only the gate knows its script name. Supplying it makes the preflight
   * refuse when a previous run of the SAME gate is still alive -- a state the browser count cannot
   * see at all when the corpse never reached its `launch()` (measured: ~25 lost minutes, 2026-08-12).
   */
  scriptMarker?: string;
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
  const { label, reap = false, scriptMarker } = options;
  // FIRST, and before any free-disk check: collect this tooling's own garbage, so a gate is never
  // refused for space that 14,000 dead profile dirs are holding (DEBT-025/026).
  reapProfilesForPreflight();
  if (scriptMarker) {
    const stale = listStaleHarnessProcesses(scriptMarker);
    if (stale.length) {
      throw new Error(
        `${label}: REFUSING TO RUN — ${stale.length} earlier run(s) of this gate are still alive ` +
          `(pids ${stale.map((p) => p.pid).join(", ")}).\n` +
          `  A stalled gate holds its dev server and its fixture directory, and the next run then hangs ` +
          `with no output and no browser — which does not look like process hygiene (measured: ~25 ` +
          `minutes, 2026-08-12). The browser count above cannot see this: a run that never reached its ` +
          `own launch() leaves a node tree and no chrome.exe.\n` +
          `  Fix: taskkill /F /PID ${stale.map((p) => p.pid).join(" /PID ")} /T   then re-run.\n` +
          stale.map((p) => `    pid ${p.pid}: ${p.cmd}`).join("\n")
      );
    }
  }
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
