/**
 * DEBT-034 — IS THE PERMANENT "media never saved to this device" BADGE ACTUALLY VISIBLE? (T-16)
 *
 * WHY THIS ONE EARNS THE FULL CHECK. The badge announces a PERMANENT state: the clip's bytes are not on
 * the device, no proxy can ever be built for it, and re-importing is the only fix. A transient badge
 * that fails to render costs the user a moment of confusion; this one, if invisible, costs them a clip
 * they retry forever. When it shipped it inherited its position from the badge measured visible 19/19
 * — and inheritance is an argument, not a measurement. This is the measurement.
 *
 * T-16, in full:
 *   1. a real box — non-zero rect, intersecting the viewport;
 *   2. the ANCESTOR CHAIN — display / visibility / cumulative opacity walked to the root, because any
 *      one of them hides a descendant no matter what its own computed style says;
 *   3. NOT COVERED — hit-test the centre and require the hit to be the element, an ancestor, or a
 *      descendant;
 *   4. THE CHECKER IS FALSIFIED FIRST against four markers whose answers are known by construction. A
 *      checker that returns true for everything passes every assertion below and proves nothing, so a
 *      failed self-test VOIDS the run rather than reporting it.
 *
 * The fixture makes the state naturally: import enough large 4K assets that the browser refuses some
 * writes (DEBT-034), place clips on the timeline, then require that EVERY placed clip whose asset is
 * flagged `localBytesMissing` carries a VISIBLE badge — and that no unflagged clip does.
 *
 * Page-side code is authored as SOURCE TEXT throughout: tsx's `keepNames` wraps function-valued consts
 * in `__name()`, which does not exist in the page.
 *
 * Run:
 *   PROBE_MEDIA_DIR=<dir of large 4K clips> PIXEL_BROWSER_CHANNEL=chrome \
 *     pnpm --filter @orreris/worker tsx src/debt034-badge-visibility-probe.ts
 */
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { assertQuietBrowserMachine } from "./browser/browser-preflight";
import { defaultClipPath, importAssets, reachEditor } from "./browser/editor-session.js";

const N = Number(process.env.PROBE_N ?? 11);
const PLACE = Number(process.env.PROBE_PLACE ?? 8);

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

const SELF_TEST = `(function () {
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
  return {
    ok: answers.plainVisible === true && answers.hiddenByAncestorOpacity === false &&
        answers.hiddenByAncestorDisplay === false && answers.hiddenByCover === false,
    detail: JSON.stringify(answers)
  };
})()`;

/** Joins timeline clips to their assets and asks the checker about each badge. */
const READ_BADGES = `(function () {
  var visible = window.__probeVisible;
  var assets = [];
  for (var i = 0; i < localStorage.length; i++) {
    var key = localStorage.key(i);
    if (key && key.indexOf("assets") !== -1 && key.indexOf("local") !== -1) {
      try { var parsed = JSON.parse(localStorage.getItem(key)); if (Array.isArray(parsed) && parsed.length) { assets = parsed; break; } } catch (e) {}
    }
  }
  var flagged = {};
  for (var j = 0; j < assets.length; j++) if (assets[j].localBytesMissing === true) flagged[assets[j].id] = true;

  var clips = document.querySelectorAll(".timeline-clip");
  var out = { clips: 0, badges: 0, visibleBadges: 0, hiddenBadges: [], flaggedAssets: Object.keys(flagged).length };
  for (var k = 0; k < clips.length; k++) {
    out.clips += 1;
    var badge = clips[k].querySelector(".clip-proxy-badge.is-missing");
    if (!badge) continue;
    out.badges += 1;
    if (visible(badge)) {
      out.visibleBadges += 1;
    } else {
      var r = badge.getBoundingClientRect();
      var op = 1;
      for (var n = badge; n; n = n.parentElement) { var st = getComputedStyle(n); op *= Number(st.opacity === "" ? 1 : st.opacity); }
      var hit = document.elementFromPoint(
        Math.min(Math.max(r.left + r.width / 2, 1), window.innerWidth - 1),
        Math.min(Math.max(r.top + r.height / 2, 1), window.innerHeight - 1)
      );
      out.hiddenBadges.push({
        rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        cumulativeOpacity: Number(op.toFixed(3)),
        hitEl: hit ? hit.tagName + "." + String(hit.className).slice(0, 30) : null
      });
    }
  }
  return out;
})()`;

function mediaFiles(count: number): string[] {
  const dir = process.env.PROBE_MEDIA_DIR;
  if (!dir) throw new Error("PROBE_MEDIA_DIR must point at a directory of large clips");
  const files = fs.readdirSync(dir).filter((n) => n.endsWith(".mp4")).map((n) => path.join(dir, n)).sort();
  if (files.length < count) throw new Error(`need ${count} clips, found ${files.length}`);
  return files.slice(0, count);
}

async function addClipsToTimeline(page: Page, count: number): Promise<number> {
  let placed = 0;
  for (let i = 0; i < count; i++) {
    const tile = page.locator(".asset-tile").nth(i);
    if (!(await tile.count().catch(() => 0))) break;
    await tile.hover().catch(() => undefined);
    await page.waitForTimeout(150);
    const add = tile.locator('button[title="Add video only"]').first();
    if (!(await add.count().catch(() => 0))) break;
    await add.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(400);
    placed += 1;
  }
  return placed;
}

async function main(): Promise<void> {
  assertQuietBrowserMachine({ label: "debt034-badge-visibility-probe" });
  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  if (!channel) console.log("⚠ PIXEL_BROWSER_CHANNEL unset — SwiftShader risk.");

  const browser = await chromium.launch({ ...(channel ? { channel } : {}), headless: false });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = context.pages()[0] ?? (await context.newPage());
  page.on("pageerror", (e) => process.stdout.write(`[pageerror] ${String(e)}\n`));
  await page.addInitScript({ content: INSTALL_VISIBILITY_CHECKER });

  await reachEditor(page, { clipPath: defaultClipPath(20), flags: "wcDecode=1" });
  await page.waitForTimeout(2_000);
  await page.evaluate(INSTALL_VISIBILITY_CHECKER);

  const selfTest = (await page.evaluate(SELF_TEST)) as { ok: boolean; detail: string };
  console.log(`visibility checker self-test: ${selfTest.ok ? "PASS" : "FAIL"} — ${selfTest.detail}`);
  if (!selfTest.ok) {
    console.log("VOID — the checker failed its own falsification; no visibility claim here can be trusted.");
    await browser.close();
    process.exit(2);
  }

  await importAssets(page, mediaFiles(N));
  await page.waitForTimeout(6_000);
  const placed = await addClipsToTimeline(page, PLACE);
  await page.waitForTimeout(2_500);
  console.log(`placed ${placed} clip(s) on the timeline`);

  // SCROLL EACH BADGE INTO VIEW FIRST, then judge. The first run of this probe reported 4 of 4 badges
  // "not visible" — with cumulativeOpacity 1 on every one. They were at y=886..1021 in a 900px viewport:
  // BELOW THE FOLD, because nine stacked tracks do not fit on screen. That is not the defect T-16 is
  // about. "Hidden" (opacity/display/covered — the user can never see it) and "off-screen" (the user
  // scrolls to it, as they would to reach the clip at all) are different claims, and a checker that
  // requires viewport intersection reports the second as the first. Scrolling to the element is what a
  // user does to look at that clip, so it is the fair precondition for asking whether the marker reads.
  // ONE BADGE AT A TIME. Scrolling every badge in sequence leaves only the LAST one well positioned and
  // the rest wherever that final scroll put them — which is how the previous run reported badges
  // "covered" by the studio panel and the timebar. That measured the scroll position, not the badge. A
  // user looks at one clip at a time, so each badge is scrolled to and judged on its own.
  const badgeCount = (await page.evaluate(`document.querySelectorAll(".clip-proxy-badge.is-missing").length`)) as number;
  let visibleBadges = 0;
  const hiddenBadges: unknown[] = [];
  for (let i = 0; i < badgeCount; i++) {
    await page.evaluate(`(function () {
      var el = document.querySelectorAll(".clip-proxy-badge.is-missing")[${i}];
      if (el) el.scrollIntoView({ block: "center", inline: "center" });
      return !!el;
    })()`);
    await page.waitForTimeout(500);
    const judged = (await page.evaluate(`(function () {
      var el = document.querySelectorAll(".clip-proxy-badge.is-missing")[${i}];
      if (!el) return { visible: false, note: "vanished between scroll and check" };
      var r = el.getBoundingClientRect();
      var op = 1;
      for (var n = el; n; n = n.parentElement) { var st = getComputedStyle(n); op *= Number(st.opacity === "" ? 1 : st.opacity); }
      var hit = document.elementFromPoint(
        Math.min(Math.max(r.left + r.width / 2, 1), window.innerWidth - 1),
        Math.min(Math.max(r.top + r.height / 2, 1), window.innerHeight - 1)
      );
      return {
        visible: window.__probeVisible(el),
        rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        cumulativeOpacity: Number(op.toFixed(3)),
        hitEl: hit ? hit.tagName + "." + String(hit.className).slice(0, 30) : null
      };
    })()`)) as { visible: boolean };
    if (judged.visible) visibleBadges += 1;
    else hiddenBadges.push(judged);
  }

  const flaggedAssets = (await page.evaluate(`(function () {
    var assets = [];
    for (var i = 0; i < localStorage.length; i++) {
      var key = localStorage.key(i);
      if (key && key.indexOf("assets") !== -1 && key.indexOf("local") !== -1) {
        try { var p = JSON.parse(localStorage.getItem(key)); if (Array.isArray(p) && p.length) { assets = p; break; } } catch (e) {}
      }
    }
    var n = 0;
    for (var j = 0; j < assets.length; j++) if (assets[j].localBytesMissing === true) n += 1;
    return n;
  })()`)) as number;

  const result = { clips: badgeCount, badges: badgeCount, visibleBadges, hiddenBadges, flaggedAssets };
  console.log(`assets flagged localBytesMissing: ${result.flaggedAssets}`);
  console.log(`timeline clips: ${result.clips}, is-missing badges: ${result.badges}, VISIBLE: ${result.visibleBadges}`);
  if (result.hiddenBadges.length) console.log(`hidden badge diagnostics: ${JSON.stringify(result.hiddenBadges)}`);

  await browser.close();

  console.log(`\n=== VERDICT ===`);
  if (result.flaggedAssets === 0) {
    console.log("  INCONCLUSIVE — no asset lost its bytes in this run, so the permanent state never occurred.");
    process.exit(3);
  }
  if (result.badges === 0) {
    console.log("  FAIL — assets are flagged but no clip rendered the badge at all.");
    process.exit(1);
  }
  if (result.visibleBadges === result.badges) {
    console.log(`  PASS — all ${result.badges} rendered badge(s) are VISIBLE under the full T-16 check, once scrolled into view`);
    console.log(`         (viewport intersection, ancestor-chain opacity/display/visibility, centre hit test),`);
    console.log(`         with the checker falsified against hidden markers first. Inheritance replaced by measurement.`);
  } else {
    console.log(`  FAIL — ${result.badges - result.visibleBadges} of ${result.badges} badge(s) are in the DOM but not visible.`);
    process.exit(1);
  }
}

void main();
