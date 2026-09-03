/**
 * DEBT-033 — DOES THE PRODUCT'S OWN STORY MATCH THE CANVAS?
 *
 * This chapter's rule: a claim about what the user SEES needs a measurement taken WHERE THE USER
 * LOOKS. `flarex-canvas-truth-probe.ts` established that for the freeze itself. This probe applies the
 * same rule one layer up, to the things the product SAYS about the freeze:
 *
 *   A notice asserting readiness while the canvas is frozen is the same defect as a delivery counter
 *   reading 67fps while the canvas is frozen. Both count something true about the internals and
 *   report it as if it were the user's experience.
 *
 * So the instrument samples, at the SAME instants: the preview canvas bytes (hashed — the ground
 * truth), the toast text, the preview's proxy-state overlay, the count of clip proxy badges, and the
 * engine's own counters. Then it asserts the four claims of the notice commit against those samples:
 *
 *   A. The completion notice never claims success it did not have (counts must match the engine).
 *   B. The in-progress notice never says "softer" over a 4K source (the measured truth is frozen).
 *   C. A frozen canvas is never unexplained — a badge or the overlay is on screen saying "proxy not
 *      ready", so the reading available to the user is not "the app is broken".
 *   D. The copy tells the user that PLAYING PAUSES THE BUILDS, i.e. that waiting is the winning move.
 *      Without it the user's instinct (press play again, scrub) extends the very window that causes
 *      the freeze, which is the difference between a slow feature and a trap.
 *
 * Deliberately COLD (no proxy wait) and deliberately 4K: that is the only regime where all four
 * claims are load-bearing at once.
 *
 * Run:
 *   PROBE_4K_DIR=<dir> PIXEL_BROWSER_CHANNEL=chrome pnpm --filter @orreris/worker tsx src/debt033-notice-truth-probe.ts
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { assertQuietBrowserMachine } from "./browser/browser-preflight";
import { importAssets, reachEditor } from "./browser/editor-session.js";

const N = Number(process.env.PROBE_N ?? 3);
const CANVAS_SELECTOR = "canvas.preview-scene-canvas";
const SAMPLE_INTERVAL_MS = 500;
const PLAY_SAMPLES = 20; // 10s of playback while builds are pending
const PARKED_SAMPLES = Number(process.env.PROBE_PARKED_SAMPLES ?? 12);
const DRAIN_TIMEOUT_MS = Number(process.env.PROBE_DRAIN_TIMEOUT_MS ?? 420_000);

interface Surface {
  toast: string | null;
  overlay: string | null;
  badges: { total: number; failed: number };
  proxy: { built: number; failed: number; skipped: number; queued: number; active: string | null } | null;
  drain: { total: number; built: number; failed: number; skipped: number } | null;
}

interface PlaySample extends Surface {
  t: number;
  hash: string;
  changed: boolean | null;
  clock: number | null;
}

let passed = 0;
let failedChecks = 0;
function check(label: string, condition: boolean, evidence?: string): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}${evidence ? ` — ${evidence}` : ""}`);
  } else {
    failedChecks += 1;
    console.log(`  FAIL  ${label}${evidence ? ` — ${evidence}` : ""}`);
  }
}

function clips(count: number): string[] {
  const dir = process.env.PROBE_4K_DIR;
  if (!dir) throw new Error("PROBE_4K_DIR must point at a directory of distinct 4K clips");
  const files = fs.readdirSync(dir).filter((n) => n.endsWith(".mp4")).map((n) => path.join(dir, n)).sort();
  if (files.length < count) throw new Error(`need ${count} clips, found ${files.length} in ${dir}`);
  return files.slice(0, count);
}

/**
 * T-16. A marker read out of the DOM is NOT a marker the user can see, and this probe's whole purpose
 * is to check what reaches the user — asserting `textContent` would repeat, one layer up, the exact
 * defect this chapter exists to catch. So visibility is established in the page:
 *
 *   1. a real box — non-zero rect, intersecting the viewport;
 *   2. the ANCESTOR CHAIN — `display:none`, `visibility:hidden/collapse` or a cumulative opacity at or
 *      below 0.01 anywhere up the tree hides a descendant no matter what its own style says;
 *   3. NOT COVERED — hit-test the element's centre and require the hit to be the element itself, an
 *      ancestor of it, or a descendant of it. An opaque panel drawn over a "visible" badge is exactly
 *      the failure a style-only check waves through.
 *
 * Installed as a page global so the sampler and the self-test share ONE implementation — a checker
 * verified in one form and used in another is not a verified checker.
 */
/**
 * A STRING, not a function, and that is load-bearing. tsx compiles with esbuild `keepNames`, which
 * wraps every function-valued const/arrow in a `__name(...)` call that does not exist in the page —
 * so a checker written as TypeScript and handed to `page.evaluate` dies with "__name is not defined"
 * and takes the whole run with it. Page-side code in this repo's probes is authored as source text.
 */
/**
 * TOAST RECORDER. Sampling at 2Hz can only report on the instants it sampled, and this probe's first
 * two runs concluded "no toast ever appeared" from exactly that — a claim a short-lived toast would
 * survive untouched. It matters here because `NoticeToast` renders NOTHING for the strings "Saved" and
 * "Unsaved", so any autosave landing after a progress update blanks the toast; the notice could be
 * firing correctly and living for 200ms between two samples.
 *
 * A MutationObserver sees every appearance regardless of when it happens, with timestamps and
 * lifetimes, so "the user was never told" and "the user was told for 200ms" become distinguishable —
 * they are different defects with different fixes.
 */
const INSTALL_TOAST_RECORDER = `
  window.__probeToasts = [];
  window.__probeToastObserver = new MutationObserver(function () {
    var el = document.querySelector(".editor-toast");
    var text = el ? (el.textContent || "").trim() : null;
    var log = window.__probeToasts;
    var last = log.length ? log[log.length - 1] : null;
    if (last && last.text === text) { last.lastSeen = performance.now(); return; }
    log.push({ text: text, firstSeen: performance.now(), lastSeen: performance.now() });
  });
  window.__probeToastObserver.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
`;

const INSTALL_VISIBILITY_CHECKER = `
  window.__probeVisible = function (el) {
    if (!(el instanceof HTMLElement)) return false;
    var rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= window.innerHeight || rect.left >= window.innerWidth) return false;
    var opacity = 1;
    for (var node = el; node; node = node.parentElement) {
      var style = getComputedStyle(node);
      if (style.display === "none") return false;
      if (style.visibility === "hidden" || style.visibility === "collapse") return false;
      opacity *= Number(style.opacity === "" ? 1 : style.opacity);
      if (opacity <= 0.01) return false;
    }
    var x = Math.min(Math.max(rect.left + rect.width / 2, 1), window.innerWidth - 1);
    var y = Math.min(Math.max(rect.top + rect.height / 2, 1), window.innerHeight - 1);
    var hit = document.elementFromPoint(x, y);
    if (!hit) return false;
    return hit === el || el.contains(hit) || hit.contains(el);
  };
`;

/**
 * FALSIFY THE CHECKER BEFORE TRUSTING IT. A visibility test that returns true for everything would
 * pass every assertion in this probe and prove nothing — so it is run against four markers whose
 * answers are known by construction: one genuinely visible, and three hidden by the three distinct
 * mechanisms above. If any answer is wrong the visibility claims are VOID rather than reported.
 */
async function selfTestVisibilityChecker(page: Page): Promise<{ ok: boolean; detail: string }> {
  // Page-side body as source text — same `keepNames` reason as INSTALL_VISIBILITY_CHECKER above.
  return page.evaluate(`(function () {
    var visible = window.__probeVisible;
    var host = document.createElement("div");
    host.style.cssText = "position:fixed;left:40px;top:40px;z-index:2147483000;";
    document.body.appendChild(host);
    var mk = [];
    var wraps = ["", "opacity:0;", "display:none;", "position:relative;"];
    for (var i = 0; i < wraps.length; i++) {
      var outer = document.createElement("div");
      outer.style.cssText = wraps[i];
      var inner = document.createElement("div");
      inner.style.cssText = "width:24px;height:24px;background:#0f0;";
      outer.appendChild(inner);
      host.appendChild(outer);
      mk.push(inner);
    }
    var lid = document.createElement("div");
    lid.style.cssText = "position:fixed;left:0;top:0;width:100vw;height:100vh;background:#fff;z-index:2147483600;";
    document.body.appendChild(lid);
    var coveredAnswer = visible(mk[3]);
    lid.remove();
    var answers = {
      plainVisible: visible(mk[0]),
      hiddenByAncestorOpacity: visible(mk[1]),
      hiddenByAncestorDisplay: visible(mk[2]),
      hiddenByCover: coveredAnswer
    };
    host.remove();
    var ok = answers.plainVisible === true && answers.hiddenByAncestorOpacity === false &&
      answers.hiddenByAncestorDisplay === false && answers.hiddenByCover === false;
    return { ok: ok, detail: JSON.stringify(answers) };
  })()`) as Promise<{ ok: boolean; detail: string }>;
}

async function readSurfaces(page: Page): Promise<Surface> {
  // Page-side body as source text (keepNames again — the `.find(el => …)` callbacks alone would
  // reintroduce `__name`). Every surface is filtered through the T-16 checker: a toast sitting in the
  // DOM at opacity 0 mid fade-out, or a badge behind a panel, is not something the user was told.
  return page.evaluate(`(function () {
    var visible = window.__probeVisible;
    if (!visible) return { toast: null, overlay: null, badges: { total: 0, failed: 0 }, proxy: null, drain: null, checkerMissing: true };
    var toastEl = null;
    var toasts = document.querySelectorAll(".editor-toast");
    for (var i = 0; i < toasts.length; i++) { if (visible(toasts[i])) { toastEl = toasts[i]; break; } }
    var overlayEl = null;
    var overlays = document.querySelectorAll(".preview-proxy-state");
    for (var j = 0; j < overlays.length; j++) { if (visible(overlays[j])) { overlayEl = overlays[j]; break; } }
    var badgeEls = document.querySelectorAll(".clip-proxy-badge");
    var badgeTotal = 0, badgeFailed = 0;
    for (var k = 0; k < badgeEls.length; k++) {
      if (!visible(badgeEls[k])) continue;
      badgeTotal++;
      if (badgeEls[k].classList.contains("is-failed")) badgeFailed++;
    }
    return {
      toast: toastEl ? (toastEl.textContent || "").trim() : null,
      overlay: overlayEl ? (overlayEl.textContent || "").trim() : null,
      badges: { total: badgeTotal, failed: badgeFailed },
      proxy: window.__rfSourceProxy || null,
      drain: window.__rfProxyDrainSummary || null
    };
  })()`) as Promise<Surface>;
}

async function addClipsToTimeline(page: Page, count: number): Promise<number> {
  let placed = 0;
  for (let i = 1; i < count; i++) {
    const tile = page.locator(".asset-tile").nth(i);
    if (!(await tile.count().catch(() => 0))) break;
    await tile.hover().catch(() => undefined);
    await page.waitForTimeout(150);
    const add = tile.locator('button[title="Add video only"]').first();
    if (!(await add.count().catch(() => 0))) break;
    await add.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(500);
    placed += 1;
  }
  return placed + 1;
}

async function main(): Promise<void> {
  assertQuietBrowserMachine({ label: "debt033-notice-truth-probe" });
  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  if (!channel) console.log("PIXEL_BROWSER_CHANNEL unset — SwiftShader risk.");
  const all = clips(N);
  console.log(`media: ${N} distinct 4K clips from ${process.env.PROBE_4K_DIR}`);

  const browser = await chromium.launch({ ...(channel ? { channel } : {}), headless: false });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = context.pages()[0] ?? (await context.newPage());
  page.on("pageerror", (e) => process.stdout.write(`[pageerror] ${String(e)}\n`));

  // Survives the SPA's own navigations (reachEditor walks /create → /editor/…), so the checker is
  // present in whatever document the sampler ends up reading.
  await page.addInitScript({ content: INSTALL_VISIBILITY_CHECKER });

  await reachEditor(page, { clipPath: all[0]!, flags: "wcDecode=1" });
  await page.waitForTimeout(3_000);
  await page.evaluate(INSTALL_VISIBILITY_CHECKER); // belt and braces for the current document
  await page.evaluate(INSTALL_TOAST_RECORDER);

  const visSelfTest = await selfTestVisibilityChecker(page);
  console.log(`visibility checker self-test: ${visSelfTest.ok ? "PASS" : "FAIL"} — ${visSelfTest.detail}`);
  if (!visSelfTest.ok) {
    // T-16: an unfalsified checker would pass every marker assertion below and prove nothing. Refuse
    // rather than report — a green run on a broken instrument is the worst outcome available here.
    console.log("VOID — the visibility checker failed its own falsification, so no marker claim can be trusted.");
    await browser.close();
    process.exit(2);
  }
  if (N > 1) await importAssets(page, all.slice(1, N));
  const placed = await addClipsToTimeline(page, N);
  console.log(`placed on timeline: ${placed}/${N}`);
  if (placed < N) {
    console.log(`VOID — only ${placed}/${N} clips landed; a probe that cannot build the scene cannot report on it.`);
    await browser.close();
    process.exit(2);
  }

  // ---------------------------------------------------------------------------------------------
  // PHASE 1 — PARKED, builds running. What does the product say while it is not ready?
  // ---------------------------------------------------------------------------------------------
  console.log("\n## PHASE 1 — parked, builds in flight");
  const parked: Surface[] = [];
  // LONG ENOUGH TO SEE A PROGRESS PING. The first run of this probe watched 6s and saw no toast at
  // all, which cannot distinguish "the copy is wrong" from "we did not watch long enough": progress
  // is reported every 30 ENCODED FRAMES, and a 4K build measured 71.7s end to end, so the first ping
  // can land many seconds in. A claim reported from a window too short to contain the event is not a
  // finding. Parked (not playing), so builds actually run.
  for (let i = 0; i < PARKED_SAMPLES; i++) {
    await page.waitForTimeout(SAMPLE_INTERVAL_MS);
    const s = await readSurfaces(page);
    parked.push(s);
    console.log(
      `  t=${((i + 1) * SAMPLE_INTERVAL_MS) / 1000}s badges=${s.badges.total}(${s.badges.failed} failed) proxy=${JSON.stringify(s.proxy)}\n        toast: ${s.toast ?? "-"}`
    );
  }

  // EVERY toast that existed during phase 1, not merely the ones a sample happened to land on.
  const toastLog = (await page.evaluate(`window.__probeToasts || []`)) as Array<{
    text: string | null;
    firstSeen: number;
    lastSeen: number;
  }>;
  console.log(`\n  toast recorder — ${toastLog.length} distinct toast state(s) during phase 1:`);
  for (const entry of toastLog) {
    console.log(`    ${(entry.lastSeen - entry.firstSeen).toFixed(0)}ms  ${entry.text === null ? "(none)" : `"${entry.text}"`}`);
  }
  const optimizingEver = toastLog.filter((e) => e.text != null && /Optimizing/i.test(e.text));

  /**
   * WHY the recorder and the sampler disagree. The recorder saw the toast in the DOM; the visibility
   * sampler rejected it at every one of hundreds of instants. Both cannot be describing the same
   * user experience, and the difference decides whether claim D is real: correct copy that is never
   * VISIBLE is the same class of defect as a correct counter nobody can act on. `.editor-toast` runs
   * a 2.6s `forwards` fade ending at opacity 0 and then STAYS in the DOM invisible, so some rejection
   * is expected — but not all of them, if updates land every ~2.5s. This reports the rejection reason
   * rather than leaving the disagreement unexplained.
   */
  const toastVisibilityDiagnosis = await page.evaluate(`(function () {
    var el = document.querySelector(".editor-toast");
    if (!el) return { present: false };
    var rect = el.getBoundingClientRect();
    var opacity = 1, hiddenBy = null;
    for (var node = el; node; node = node.parentElement) {
      var st = getComputedStyle(node);
      if (st.display === "none" && !hiddenBy) hiddenBy = "display:none on " + node.className;
      if ((st.visibility === "hidden" || st.visibility === "collapse") && !hiddenBy) hiddenBy = "visibility on " + node.className;
      opacity *= Number(st.opacity === "" ? 1 : st.opacity);
    }
    var x = Math.min(Math.max(rect.left + rect.width / 2, 1), window.innerWidth - 1);
    var y = Math.min(Math.max(rect.top + rect.height / 2, 1), window.innerHeight - 1);
    var hit = document.elementFromPoint(x, y);
    return {
      present: true,
      text: (el.textContent || "").trim().slice(0, 60),
      rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
      cumulativeOpacity: Number(opacity.toFixed(3)),
      hiddenBy: hiddenBy,
      hitIsSelfOrKin: hit ? (hit === el || el.contains(hit) || hit.contains(el)) : false,
      hitEl: hit ? hit.tagName + "." + String(hit.className).slice(0, 40) : null,
      visible: window.__probeVisible(el)
    };
  })()`);
  console.log(`  toast visibility diagnosis at end of phase 1: ${JSON.stringify(toastVisibilityDiagnosis)}`);

  const buildingSamples = parked.filter((s) => s.proxy != null && (s.proxy.queued > 0 || s.proxy.active !== null));
  const toastsWhileBuilding = buildingSamples.map((s) => s.toast).filter((t): t is string => Boolean(t));
  console.log(`\n  samples with a build in flight: ${buildingSamples.length}/${parked.length}`);

  if (buildingSamples.length === 0) {
    console.log("  VOID for the in-progress claims — no build was in flight during phase 1.");
  } else {
    check(
      "B: no in-progress notice describes 4K playback as merely 'softer'",
      !toastsWhileBuilding.some((t) => /softer/i.test(t)),
      toastsWhileBuilding.find((t) => /softer/i.test(t)) ?? `${toastsWhileBuilding.length} toasts seen`
    );
    // Asserted against the RECORDER, not the samples: whether the copy is right is a different
    // question from whether a 2Hz sampler happened to catch it, and only the recorder can separate
    // "never shown" from "shown too briefly to read".
    check(
      "D: the in-progress notice says playing pauses optimizing",
      optimizingEver.length > 0 && optimizingEver.every((e) => /Playing pauses optimizing/i.test(e.text!)),
      optimizingEver.length === 0
        ? "no 'Optimizing' toast EVER entered the DOM during phase 1 (recorder, not sampling)"
        : `${optimizingEver.length} seen, longest ${Math.max(...optimizingEver.map((e) => e.lastSeen - e.firstSeen)).toFixed(0)}ms: "${optimizingEver[0]!.text}"`
    );
    check(
      "A: no completion notice fires while builds are still in flight",
      !toastsWhileBuilding.some((t) => /finished/i.test(t)),
      toastsWhileBuilding.find((t) => /finished/i.test(t)) ?? "none"
    );
    check(
      "C: pending proxies are visible on the timeline as clip badges",
      buildingSamples.some((s) => s.badges.total > 0),
      `max badges observed: ${Math.max(...buildingSamples.map((s) => s.badges.total))}`
    );
  }

  // ---------------------------------------------------------------------------------------------
  // PHASE 2 — PLAY while builds are pending. Correlate the canvas with what is on screen.
  // ---------------------------------------------------------------------------------------------
  console.log("\n## PHASE 2 — playing 4K originals while proxies are pending (the trap regime)");
  const canvas = page.locator(CANVAS_SELECTOR).first();
  if (!(await canvas.count().catch(() => 0))) {
    console.log(`VOID — no ${CANVAS_SELECTOR}; cannot measure where the user looks.`);
    await browser.close();
    process.exit(2);
  }
  await page.keyboard.press("Home").catch(() => undefined);
  await page.waitForTimeout(300);
  await page.keyboard.press("Space").catch(() => undefined);

  const play: PlaySample[] = [];
  let prevHash: string | null = null;
  for (let i = 0; i < PLAY_SAMPLES; i++) {
    await page.waitForTimeout(SAMPLE_INTERVAL_MS);
    const shot = await canvas.screenshot({ timeout: 5_000 }).catch(() => null);
    const hash = shot ? crypto.createHash("sha1").update(shot).digest("hex").slice(0, 12) : "SHOTFAIL";
    const s = await readSurfaces(page);
    const clock = await page.evaluate(() => {
      const w = window as unknown as { __rfClock?: { committed?: number } };
      return w.__rfClock?.committed ?? null;
    });
    play.push({ ...s, t: ((i + 1) * SAMPLE_INTERVAL_MS) / 1000, hash, changed: prevHash === null ? null : hash !== prevHash, clock });
    prevHash = hash;
    console.log(
      `  t=${play[i]!.t.toFixed(1)}s canvas=${play[i]!.changed === null ? "----" : play[i]!.changed ? "CHANGED" : "SAME   "}` +
        ` clock=${clock == null ? "?" : clock.toFixed(2)} badges=${s.badges.total} overlay=${s.overlay ? "YES" : "no"}`
    );
  }
  await page.keyboard.press("Space").catch(() => undefined);

  const comparable = play.filter((s) => s.changed !== null);
  const frozen = comparable.filter((s) => s.changed === false);
  const clocks = play.map((s) => s.clock).filter((c): c is number => c != null);
  const clockAdvanced = clocks.length >= 2 ? clocks[clocks.length - 1]! - clocks[0]! : 0;
  console.log(
    `\n  canvas changed ${comparable.filter((s) => s.changed).length}/${comparable.length} samples; clock advanced ${clockAdvanced.toFixed(2)}s`
  );
  if (frozen.length === 0) {
    console.log("  (canvas never repeated a frame in this window — claim C has nothing to bind to here, reported as such)");
  } else {
    check(
      "C: every frozen-canvas sample carries an on-screen explanation (overlay or clip badge)",
      frozen.every((s) => s.overlay !== null || s.badges.total > 0),
      `${frozen.filter((s) => s.overlay !== null || s.badges.total > 0).length}/${frozen.length} explained`
    );
    check(
      "A: no sample claims optimization finished while the canvas is frozen and builds are pending",
      !frozen.some((s) => /finished/i.test(s.toast ?? "") && s.proxy != null && (s.proxy.queued > 0 || s.proxy.active !== null)),
      frozen.find((s) => /finished/i.test(s.toast ?? ""))?.toast ?? "none"
    );
    const overlays = frozen.map((s) => s.overlay).filter((o): o is string => Boolean(o));
    if (overlays.length > 0) {
      check(
        "D: the preview overlay tells the user that playing pauses the build",
        overlays.every((o) => /Playing pauses the (build|queue)/i.test(o)),
        overlays[0]!
      );
    }
  }

  // ---------------------------------------------------------------------------------------------
  // PHASE 3 — drain. The completion notice against the engine's own counts.
  // ---------------------------------------------------------------------------------------------
  console.log("\n## PHASE 3 — waiting for the queue to drain (transport parked, so builds run)");
  const start = Date.now();
  let final: Surface | null = null;
  let idleStreak = 0;
  while (Date.now() - start < DRAIN_TIMEOUT_MS) {
    await page.waitForTimeout(2_000);
    const s = await readSurfaces(page);
    const idle = s.proxy != null && s.proxy.queued === 0 && s.proxy.active === null;
    idleStreak = idle ? idleStreak + 1 : 0;
    if (idleStreak >= 3) {
      final = s;
      break;
    }
  }
  if (!final) {
    console.log(`  VOID for the completion claims — the queue never went idle within ${DRAIN_TIMEOUT_MS}ms.`);
  } else {
    console.log(`  engine: ${JSON.stringify(final.proxy)}`);
    console.log(`  drain summary: ${JSON.stringify(final.drain)}`);
    console.log(`  final toast: ${final.toast ?? "-"}`);
    console.log(`  badges left: ${final.badges.total} (${final.badges.failed} failed)`);
    const toast = final.toast ?? "";
    const drain = final.drain;
    if (!/optimization/i.test(toast)) {
      console.log("  the completion toast was not on screen at read time — reported, not asserted.");
    } else if (drain) {
      check(
        "A: the completion notice's built count matches the engine's",
        new RegExp(`(all ${drain.total} optimized|${drain.built} of ${drain.total} optimized)`).test(toast),
        toast
      );
      check(
        "A: the completion notice reports failures when there were failures",
        drain.failed === 0 ? !/failed/i.test(toast) : /failed/i.test(toast),
        `drain.failed=${drain.failed} — "${toast}"`
      );
      check(
        "A: 'all optimized' appears only when everything was optimized",
        !/all \d+ optimized/.test(toast) || drain.built === drain.total,
        toast
      );
    }
  }

  await browser.close();
  console.log(`\ndebt033-notice-truth-probe: ${passed} passed, ${failedChecks} failed`);
  if (failedChecks > 0) process.exit(1);
}

void main();
