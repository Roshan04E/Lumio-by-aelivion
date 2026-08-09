/**
 * MEASUREMENT ONLY — follow-up to ruler-jump-path-audit.ts's R1: the tested source's own routing log
 * showed a `route=pool` DECISION at the post-proxy remount, yet the final `__rfWcMode` snapshot for
 * that same key read "element". This script resolves HOW: cap-denied at acquire (never created a
 * session) vs created-then-dropped (the async `wcFallbackRef` path).
 *
 * NAMED HYPOTHESIS (self-starvation via remounts): the asset remounts across THREE distinct URLs as it
 * goes local-blob → object-URL-of-original → object-URL-of-proxy (confirmed by the prior round's R1).
 * If an earlier URL's session were left occupying a slot when the source remounts onto the next URL,
 * the live (proxy) URL could be denied a slot that nothing but its own dead predecessor is holding —
 * `capMisses` firing on a single-source fixture with zero external contention. Refuted in the same
 * reading if `created` never rises before the cap-miss (nothing to have been left behind) or if the
 * earlier URLs never actually held sessions in the first place (they were element-routed pre-proxy, so
 * `acquirePreviewFrameProvider` was never called for them — worth confirming here, not assumed).
 *
 * READINGS:
 *   A. `__rfWcPool` at/around the fallback: active, activeSoftware, idle, created, capMisses,
 *      starvedSources, starvedKeys. Does capMisses increment exactly when the subject's key appears in
 *      the routing log as `route=pool`? Is the subject's key in starvedKeys?
 *   B. Who holds sessions at that moment — inferred from active/activeSoftware/idle counts (the pool's
 *      per-lease identities are not on `window`, so this is circumstantial, not a literal enumeration;
 *      reported as such, not overstated).
 *   C. `created` vs the run's own history, sampled continuously (not just at the end) — a release-vs-park
 *      distinction isn't directly exposed either, but "was a session EVER created for this source" is,
 *      and that alone settles cap-miss-before-creation vs drop-after-creation.
 *   D. If capMisses does NOT rise and the subject's key is NOT in starvedKeys at the moment `__rfWcMode`
 *      reads "element", then a session WAS created and dropped afterwards (the async fallback path) —
 *      report that plainly instead of forcing it into the cap-miss story.
 *
 * PROBE-SIDE FIX (authorised this round, probe-only — editor-session.ts is untouched):
 *   `awaitSubjectEngaged` resolves the SUBJECT's own routing key (its first `__rfRouting` entry) and
 *   polls `__rfWcMode[thatKey]` for non-"element", instead of `awaitWebCodecsEngaged`'s any-entry
 *   predicate. And `__rfWcMode`/`__rfWcPool` are sampled as a TIMELINE across the critical window
 *   (proxy landing through settle), not read once at the end — the single end-of-run snapshot is what
 *   made the previous round's D4 finding ambiguous in the first place.
 *
 * Run: PIXEL_BROWSER_CHANNEL=chrome pnpm --filter @orreris/worker rulerjump:capaudit
 */
import os from "node:os";
import { execSync } from "node:child_process";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { defaultClipPath, reachEditor } from "./browser/editor-session";

function reportMachineState(): void {
  const freeGB = (os.freemem() / 1024 / 1024 / 1024).toFixed(2);
  const totalGB = (os.totalmem() / 1024 / 1024 / 1024).toFixed(2);
  let chromeCount = "?";
  let nodeCount = "?";
  try {
    const out = execSync("tasklist", { encoding: "utf8" });
    chromeCount = String((out.match(/chrome\.exe/gi) ?? []).length);
    nodeCount = String((out.match(/node\.exe/gi) ?? []).length);
  } catch {
    /* best effort */
  }
  console.log(`machine state: free ${freeGB}GB / ${totalGB}GB total, chrome.exe x${chromeCount}, node.exe x${nodeCount}`);
}

interface RoutingEntry {
  at: number;
  route: "element" | "pool";
  preferNativeDecode: boolean;
  bailed: boolean;
  tolerateLag: boolean;
  hidden: boolean;
}

interface PoolSnapshot {
  active: number;
  activeSoftware: number;
  idle: number;
  created: number;
  createdSoftware: number;
  capMisses: number;
  starvedSources: number;
  starvedKeys: string[];
}

async function readRouting(page: Page): Promise<Record<string, RoutingEntry[]>> {
  return page.evaluate(() => ({ ...((globalThis as Record<string, any>).__rfRouting ?? {}) }));
}

async function readWcModes(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => ({ ...((globalThis as Record<string, any>).__rfWcMode ?? {}) }));
}

async function readPool(page: Page): Promise<PoolSnapshot> {
  return page.evaluate(() => {
    const s = (globalThis as Record<string, any>).__rfWcPool ?? {};
    return {
      active: Number(s.active ?? 0),
      activeSoftware: Number(s.activeSoftware ?? 0),
      idle: Number(s.idle ?? 0),
      created: Number(s.created ?? 0),
      createdSoftware: Number(s.createdSoftware ?? 0),
      capMisses: Number(s.capMisses ?? 0),
      starvedSources: Number(s.starvedSources ?? 0),
      starvedKeys: Array.isArray(s.starvedKeys) ? [...s.starvedKeys] : [],
    };
  });
}

async function readWcDecodeLocalStorage(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    try {
      return window.localStorage?.getItem("orreris.wcDecode") ?? null;
    } catch {
      return null;
    }
  });
}

/** Wait for the FIRST subject remount that attempts the pool (route=pool) and return its key. */
async function awaitSubjectPoolAttempt(page: Page, timeoutMs = 240_000): Promise<{ key: string; atMs: number } | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const routing = await readRouting(page);
    for (const [key, entries] of Object.entries(routing)) {
      const hit = entries.find((e) => e.route === "pool");
      if (hit) return { key, atMs: Date.now() - started };
    }
    await page.waitForTimeout(1_000);
  }
  return null;
}

/**
 * PROBE-SIDE FIX: the single-subject predicate named last round, implemented here rather than in the
 * shared `awaitWebCodecsEngaged` helper (untouched — that helper's any-entry semantics are correct for
 * its existing multi-source callers).
 */
async function awaitSubjectEngaged(page: Page, subjectKey: string, timeoutMs = 15_000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const modes = await readWcModes(page);
    if (modes[subjectKey] && modes[subjectKey] !== "element") return true;
    await page.waitForTimeout(200);
  }
  return false;
}

async function main(): Promise<void> {
  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  if (channel !== "chrome") {
    console.log("REFUSING — PIXEL_BROWSER_CHANNEL=chrome is required (SwiftShader ~8fps voids this).");
    process.exit(1);
  }
  reportMachineState();

  const clip = defaultClipPath(Number(process.env.PROBE_MIN_SECONDS ?? 140));
  console.log(`seed clip: ${clip}`);

  let browser: Browser | null = null;
  let context: BrowserContext;
  if (process.env.PROBE_PROFILE) {
    context = await chromium.launchPersistentContext(process.env.PROBE_PROFILE, { channel, viewport: { width: 1600, height: 900 } });
  } else {
    browser = await chromium.launch({ channel });
    context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  }
  const page = context.pages()[0] ?? (await context.newPage());
  await page.addInitScript("window.__name = window.__name || function (f) { return f; };");

  try {
    const projectUrl = await reachEditor(page, { clipPath: clip, flags: "wcDecode=1&kernelDiagnostics=1" });
    console.log(`\nproject: ${projectUrl}`);

    const wcDecodeStorage = await readWcDecodeLocalStorage(page);
    console.log(`localStorage 'orreris.wcDecode': ${wcDecodeStorage === null ? "(not set — defaults apply)" : wcDecodeStorage}`);

    console.log(`\nwaiting for the subject's first pool-route attempt (proxy landing + remount)...`);
    const subject = await awaitSubjectPoolAttempt(page);
    if (!subject) {
      console.log("VOID — the subject never attempted the pool within 240s (no proxy landed / no remount).");
      return;
    }
    console.log(`subject key: ${subject.key}  (first pool-route attempt at t=${subject.atMs}ms probe-wall-clock)`);

    // ── TIMELINE CAPTURE — __rfWcMode[subjectKey] and __rfWcPool, sampled continuously across the
    // critical window, not read once at the end. This is the direct fix for the previous round's
    // single-snapshot ambiguity. ──────────────────────────────────────────────────────────────────
    console.log(`\n── TIMELINE (subject mode + pool stats, sampled every 300ms for 15s from the pool attempt) ──`);
    const timeline: Array<{ tMs: number; mode: string | undefined; pool: PoolSnapshot }> = [];
    const timelineStart = Date.now();
    while (Date.now() - timelineStart < 15_000) {
      const [modes, pool] = await Promise.all([readWcModes(page), readPool(page)]);
      timeline.push({ tMs: Date.now() - timelineStart, mode: modes[subject.key], pool });
      await page.waitForTimeout(300);
    }
    for (const row of timeline) {
      console.log(
        `  t=${String(row.tMs).padStart(5)}ms  mode=${row.mode ?? "(absent)"}  active=${row.pool.active} activeSw=${row.pool.activeSoftware} idle=${row.pool.idle} created=${row.pool.created} createdSw=${row.pool.createdSoftware} capMisses=${row.pool.capMisses} starved=${row.pool.starvedSources} starvedKeys=${JSON.stringify(row.pool.starvedKeys)}`
      );
    }

    // Demonstrate the probe-side fix itself: the single-subject predicate, resolved against the
    // subject's own key rather than "any entry". Informational — the timeline above already has the
    // ground truth; this just reports what the corrected predicate would have said.
    const subjectEngagedPredicate = await awaitSubjectEngaged(page, subject.key, 1_000);
    console.log(`\nsingle-subject predicate (awaitSubjectEngaged on '${subject.key}'): ${subjectEngagedPredicate}`);

    const first = timeline[0]!;
    const last = timeline[timeline.length - 1]!;
    const capMissesRoseInWindow = last.pool.capMisses > first.pool.capMisses;
    const createdRoseInWindow = last.pool.created > first.pool.created || last.pool.createdSoftware > first.pool.createdSoftware;
    const subjectEverStarved = timeline.some((row) => row.pool.starvedKeys.includes(subject.key));
    const subjectEverNonElement = timeline.some((row) => row.mode && row.mode !== "element");

    console.log(`\n── ANALYSIS ──`);
    console.log(`  A. capMisses rose during the window: ${capMissesRoseInWindow} (${first.pool.capMisses} → ${last.pool.capMisses})`);
    console.log(`     subject's key ever in starvedKeys: ${subjectEverStarved}`);
    console.log(`  B. active/activeSoftware/idle at first sample: active=${first.pool.active} activeSoftware=${first.pool.activeSoftware} idle=${first.pool.idle}`);
    console.log(`     (per-lease identities are not exposed on window — this is circumstantial, not a literal enumeration of holders)`);
    console.log(`  C. created rose during the window: ${createdRoseInWindow} (created ${first.pool.created}→${last.pool.created}, createdSoftware ${first.pool.createdSoftware}→${last.pool.createdSoftware})`);
    console.log(`  D. subject's own mode was ever non-'element' during the window: ${subjectEverNonElement}`);
    console.log(`     final mode for subject: ${last.mode ?? "(absent)"}`);

    let verdict: string;
    if (!createdRoseInWindow && capMissesRoseInWindow && subjectEverStarved) {
      verdict = "CAP-MISS — denied at acquire, no session ever created for this source in the window. Matches the hypothesis IF something else's active/idle count explains the denial (see active/idle above); if active+idle stayed at 0 throughout, the denial has no visible occupant and is a different bug than self-starvation.";
    } else if (createdRoseInWindow && !subjectEverNonElement) {
      verdict = "CREATED THEN NEVER OBSERVED NON-ELEMENT — a session was created in the window but __rfWcMode for the subject never read anything but element; the create may belong to a different key, or the mode write raced the sample interval. Inconclusive from this reading alone.";
    } else if (createdRoseInWindow && subjectEverNonElement && last.mode === "element") {
      verdict = "CREATED-THEN-DROPPED — the subject WAS on a non-element mode at some point in the window and ended on element with no cap-miss required. This is the async wcFallbackRef path, not a cap denial.";
    } else if (subjectEverNonElement && last.mode !== "element") {
      verdict = "ENGAGED AND STAYED — the subject is on a non-element mode at the end of the window. The prior round's single end-of-run snapshot was misleading (possibly a timing race in when it was taken).";
    } else {
      verdict = "NEITHER cleanly — report the raw numbers above rather than forcing a category.";
    }
    console.log(`\nVERDICT: ${verdict}`);

    console.log(`\n(A/B/C/D reported together above since they share one timeline; do not collapse into a single number without the table.)\n`);
  } finally {
    await context.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}

const exitTimer = setTimeout(() => process.exit(0), 6 * 60_000);
exitTimer.unref();

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
