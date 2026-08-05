/**
 * ACCEPTANCE for the prune-latch fix - and the fixture shape is the whole point.
 *
 * The previous attempt (flarex-flicker-acceptance.ts) ADDED a MediaIn, which lands unwired: a node no
 * edge reaches is never compiled, so its loader is never asked for, so the failure under test cannot
 * occur and a green run means nothing. Fix: bind the comp's EXISTING, already-wired MediaIn to a second
 * asset. Now the loader is on screen with no wiring gesture at all, which is also the user's original
 * report ("the mediain node is producing black screen").
 *
 * Two triggers are measured because they enter through DIFFERENT doors and only one of them was ever
 * touched by the comp.version fix:
 *
 *   node drag  -> a ui-only comp write (the version fix's territory)
 *   playhead   -> never calls stampFlarexComp at all; enters via resolveSourceDraw's early returns
 *
 * The symptom is the PICTURE, so the assertion is luma: the beach loader and the host clip are visually
 * unmistakable, and a swing back toward the host's value during a gesture IS the flash. The handle
 * counter rides along as the mechanism witness, but it is not what passes or fails this run.
 */
import { chromium, type Browser, type Page } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { reachEditor } from "../src/browser/editor-session.js";

const OUT = path.resolve(process.cwd(), "tmp/latch-acceptance");
fs.mkdirSync(OUT, { recursive: true });
const BIN_CLIP = path.resolve("../../apps/api/storage/uploads/1781868184015-beach.mp4");

async function luma(page: Page): Promise<number> {
  return page.evaluate(() => {
    const el = document.querySelector("canvas.preview-scene-canvas") as HTMLCanvasElement | null;
    if (!el) return -1;
    const w = 120;
    const h = 68;
    const off = document.createElement("canvas");
    off.width = w;
    off.height = h;
    const ctx = off.getContext("2d")!;
    try {
      ctx.drawImage(el, 0, 0, w, h);
    } catch {
      return -2;
    }
    const d = ctx.getImageData(0, 0, w, h).data;
    let s = 0;
    for (let i = 0; i < w * h; i += 1) s += 0.2126 * d[i * 4]! + 0.7152 * d[i * 4 + 1]! + 0.0722 * d[i * 4 + 2]!;
    return +(s / (w * h)).toFixed(2);
  });
}

async function mediaHandleFailures(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (((globalThis as any).__rfFlarexTrace?.events ?? []) as Array<Record<string, any>>).filter(
        (e) => e.kind === "HANDLE" && String(e.detail?.key ?? "").startsWith("media/flarexsrc:")
      ).length
  );
}

/**
 * THE SYMPTOM, in the runtime's own words.
 *
 * Mean luma was the wrong instrument: it measured 14 units between the host and the bound loader, which
 * is inside the range ordinary video motion covers, so it could not separate "flashed the host" from
 * "the shot moved". The compiler already reports the exact event - when a MediaIn cannot produce, it
 * SUBSTITUTES the host and says so. Every host flash the user sees is one of these; nothing else emits
 * them once the MediaIn is bound (`no-loader` belongs to an UNBOUND host MediaIn, and this fixture's
 * only MediaIn is bound). So this is the symptom counted directly, not a proxy for it.
 */
async function hostSubstitutions(page: Page): Promise<number> {
  return page.evaluate(() => {
    const subs = ((globalThis as any).__rfFlarexDegradation?.substitutions ?? []) as Array<{ reason: string; count: number }>;
    return subs.filter((s) => String(s.reason).startsWith("host-substituted")).reduce((n, s) => n + (s.count ?? 0), 0);
  });
}

/**
 * The kernel's own resource census. Two questions at once, and they pull in OPPOSITE directions:
 *
 *   - `total` / `media-renderer` GROWING across the run = the retention fix leaks. Two of the three
 *     changes in flight make the runtime hold more, in the subsystem whose runaway growth was ADR-012's
 *     original amplifier, so "zero handle failures" alone is not a pass.
 *   - `oldestIdleMs` climbing past RESOURCE_IDLE_MS (10_000) while everything is ON SCREEN = some
 *     resource's `lastUsedAt` is frozen, i.e. its consumer is not touching it. That is the exact
 *     mechanism by which the wall-clock sweep could reap a live loader, measured directly rather than
 *     argued from the call graph.
 */
async function census(page: Page): Promise<{ total: number; media: number; oldestIdleMs: number; reclaimed: number }> {
  return page.evaluate(() => {
    const s = (globalThis as any).__rfKernelState;
    const r = s?.resources;
    return {
      total: r?.total ?? -1,
      media: (r?.byKind ?? []).find((k: any) => k.kind === "media-renderer")?.count ?? 0,
      oldestIdleMs: Math.round(r?.oldestIdleMs ?? -1),
      reclaimed: r?.reclaimedTotal ?? -1,
      // `oldestIdleMs` is a max over ALL records, and the `permanent` sentinel is never touched BY
      // DESIGN, so its age grows with the session and dominates the aggregate. Without the scope
      // breakdown a reader cannot tell "the sentinel is old, as intended" from "a live media resource
      // has a frozen clock" - which is the entire question this arm exists to answer.
      scopes: (r?.byScope ?? []).map((s: any) => `${s.scope}:${s.count}`).join(" "),
    };
  });
}

async function compVersions(page: Page): Promise<number[]> {
  return page.evaluate(() =>
    (((globalThis as any).__rfFlarexTrace?.events ?? []) as Array<Record<string, any>>)
      .filter((e) => e.kind === "comp")
      .map((e) => e.detail?.version)
  );
}

/** The comp's node/edge shape - proof the loader under test is actually WIRED, not a stray node. */
async function topology(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const evs = (((globalThis as any).__rfFlarexTrace?.events ?? []) as Array<Record<string, any>>).filter((e) => e.kind === "comp");
    const last = evs[evs.length - 1];
    return last ? { nodes: last.detail?.nodes, edges: last.detail?.edges, types: last.detail?.types } : null;
  });
}

async function main(): Promise<void> {
  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  const browser: Browser = await chromium.launch(channel ? { channel } : {});
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await context.newPage();

  const url = await reachEditor(page, { flags: "flarexTrace=1&kernelDiagnostics=1", settleMs: 8_000 });
  await page.locator(".asset-upload-button input[type=file]").first().setInputFiles([BIN_CLIP]).catch(() => undefined);
  await page.waitForTimeout(6_000);
  await page.locator(".timeline-clip").first().click().catch(() => undefined);
  await page.waitForTimeout(600);
  await page.getByRole("tab", { name: /flarex/i }).first().click().catch(() => undefined);
  await page.waitForTimeout(1_800);
  const create = page.getByRole("button", { name: /create flarex comp/i }).first();
  if (await create.count().catch(() => 0)) {
    await create.click().catch(() => undefined);
    await page.waitForTimeout(3_000);
  }

  // THE HOST'S OWN PICTURE, measured BEFORE the bind - the discriminator this run lives or dies on.
  //
  // Without it a green result is unfalsifiable: if the bind silently failed, the viewer shows the host
  // for the whole run, the host never flickers (it is the fallback, it cannot flash to itself), drift
  // reads ~0 and the probe reports PASS having measured nothing. That is precisely how the previous
  // acceptance run fooled itself. If the resting picture after binding is indistinguishable from this,
  // the run is VOID rather than green.
  const hostSamples: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    await page.waitForTimeout(200);
    hostSamples.push(await luma(page));
  }
  const hostLuma = [...hostSamples].sort((a, b) => a - b)[Math.floor(hostSamples.length / 2)]!;
  console.log(`host luma (pre-bind): ${hostLuma}  (samples ${hostSamples.join(", ")})`);

  // THE FIXTURE FIX: retarget the EXISTING MediaIn (already wired to MediaOut) rather than adding one.
  // Nodes live on a <canvas>, so there is no selector to click and no exposed graph->screen transform.
  // Scan instead: click a point, ask whether the inspector now offers a source picker (only a MediaIn
  // does). Cheaper and far more robust than reverse-engineering the pan/zoom to hit a known graph coord.
  const nodeBox = await page.locator(".flarex-body canvas").first().boundingBox();
  if (!nodeBox) {
    console.log("VOID: no node canvas");
    await browser.close();
    return;
  }
  let mediaInAt: { x: number; y: number } | null = null;
  outer: for (let gy = 0.25; gy <= 0.8; gy += 0.12) {
    for (let gx = 0.12; gx <= 0.75; gx += 0.07) {
      const x = nodeBox.x + nodeBox.width * gx;
      const y = nodeBox.y + nodeBox.height * gy;
      await page.mouse.click(x, y);
      await page.waitForTimeout(160);
      if ((await page.locator(".flarex-source-trigger").count().catch(() => 0)) > 0) {
        mediaInAt = { x, y };
        break outer;
      }
    }
  }
  if (!mediaInAt) {
    console.log("VOID: could not find the MediaIn node by scanning the canvas");
    await page.screenshot({ path: path.join(OUT, "void-no-trigger.png") });
    await browser.close();
    return;
  }
  console.log(`MediaIn found at    : ${mediaInAt.x.toFixed(0)},${mediaInAt.y.toFixed(0)}`);
  const trigger = page.locator(".flarex-source-trigger").first();
  await trigger.click().catch(() => undefined);
  await page.waitForTimeout(900);
  const tiles = await page.locator(".asset-tile").evaluateAll((els) => els.map((e) => (e.textContent ?? "").toLowerCase()));
  const idx = tiles.findIndex((t) => t.includes("beach"));
  if (idx < 0) {
    console.log(`VOID: no beach tile among ${tiles.length}`);
    await browser.close();
    return;
  }
  await page.locator(".asset-tile").nth(idx).dblclick().catch(() => undefined);
  await page.waitForTimeout(4_000);

  // RELOAD - condition 1 established that a MID-SESSION bind never acquires a lease (a SEPARATE defect).
  // Without this the loader is dead for an unrelated reason and this run could not measure the latch.
  const reload = new URL(url);
  reload.search = "";
  reload.searchParams.set("flarexTrace", "1");
  reload.searchParams.set("kernelDiagnostics", "1");
  await page.goto(reload.toString(), { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(10_000);
  await page.locator(".timeline-clip").first().click().catch(() => undefined);
  await page.waitForTimeout(600);
  await page.getByRole("tab", { name: /flarex/i }).first().click().catch(() => undefined);
  await page.waitForTimeout(8_000);

  const loader = await page.evaluate(() => {
    const map = ((globalThis as any).__rfSourceMap ?? {}) as Record<string, any>;
    const e = Object.entries(map).find(([k]) => k.startsWith("flarexsrc:"));
    return e ? { decode: e[1].decode, state: e[1].state, why: e[1].why, wcProvider: e[1].wcProvider, served: e[1].served } : null;
  });
  console.log(`loader after reload : ${JSON.stringify(loader)}`);
  console.log(`comp topology       : ${JSON.stringify(await topology(page))}`);
  if (!loader || loader.state !== "ok") {
    console.log("\nVOID - the loader is not healthy, so this run cannot measure the latch");
    await page.screenshot({ path: path.join(OUT, "void-loader.png") });
    await browser.close();
    return;
  }

  // The loader's own picture, at rest. Everything after is measured as a departure from THIS.
  const rest: number[] = [];
  for (let i = 0; i < 6; i += 1) {
    await page.waitForTimeout(200);
    rest.push(await luma(page));
  }
  const restMedian = [...rest].sort((a, b) => a - b)[Math.floor(rest.length / 2)]!;
  console.log(`resting luma        : ${restMedian}  (samples ${rest.join(", ")})`);
  await page.screenshot({ path: path.join(OUT, "rest.png") });
  console.log(`host<->loader luma separation = ${Math.abs(restMedian - hostLuma).toFixed(2)} (context only; the gate is the substitution ledger)`);
  // The loader must actually be COMPOSITING, or there is no failure available to observe and a green
  // run means nothing. A bound MediaIn that is producing has stopped substituting the host; if it is
  // still substituting at rest, the picture on screen IS the host and this fixture is void.
  const restingSubs = await hostSubstitutions(page);
  if (restingSubs > 0) {
    const before = restingSubs;
    await page.waitForTimeout(2_000);
    if ((await hostSubstitutions(page)) > before) {
      console.log(`\nVOID - the MediaIn is still substituting the host at rest (${before} and climbing).`);
      console.log("       The loader never reached the screen, so nothing here measures the latch.");
      await page.screenshot({ path: path.join(OUT, "void-substituting.png") });
      await browser.close();
      return;
    }
  }
  console.log(`resting host substitutions = ${restingSubs} (static)`);

  const worst = (vals: number[]): number => vals.reduce((m, v) => (Math.abs(v - restMedian) > Math.abs(m - restMedian) ? v : m), restMedian);

  // ── TRIGGER 1: playhead. Never writes the comp - the door the version fix cannot reach. ──
  const beforeScrub = await mediaHandleFailures(page);
  const subsBeforeScrub = await hostSubstitutions(page);
  const scrub: number[] = [];
  for (let i = 0; i < 24; i += 1) {
    await page.keyboard.press(i % 4 === 3 ? "ArrowLeft" : "ArrowRight");
    await page.waitForTimeout(120);
    scrub.push(await luma(page));
  }
  const scrubWorst = worst(scrub.filter((v) => v >= 0));
  const scrubSubs = (await hostSubstitutions(page)) - subsBeforeScrub;
  console.log(
    `\nSCRUB   hostFlashes=${scrubSubs}  handleFailures+${(await mediaHandleFailures(page)) - beforeScrub}  (luma worst=${scrubWorst})`
  );

  // ── TRIGGER 2: node drag. The ui-only comp write. ──
  const box = await page.locator(".flarex-body canvas").first().boundingBox();
  const drag: number[] = [];
  let dragged = 0;
  let dragSubs = 0;
  if (box) {
    const beforeDrag = await mediaHandleFailures(page);
    const subsBeforeDrag = await hostSubstitutions(page);
    // Aim at the MediaIn the scan LOCATED, walking it back and forth from there. The previous run guessed
    // a coordinate and landed only 2 of 6 gestures - coverage thin enough to be its own caveat.
    for (const [dx, dy] of [[0, 0], [40, 24], [-40, -24], [0, 40]] as const) {
      const x = mediaInAt.x + dx;
      const y = mediaInAt.y + dy;
      const v0 = await compVersions(page);
      await page.mouse.move(x, y);
      await page.mouse.down();
      for (let s = 1; s <= 8; s += 1) {
        await page.mouse.move(x + s * 5, y + s * 3);
        await page.waitForTimeout(45);
        drag.push(await luma(page));
      }
      await page.mouse.up();
      await page.waitForTimeout(500);
      drag.push(await luma(page));
      if ((await compVersions(page)).length > v0.length) dragged += 1;
    }
    const dragWorst = worst(drag.filter((v) => v >= 0));
    dragSubs = (await hostSubstitutions(page)) - subsBeforeDrag;
    console.log(
      `DRAG    hostFlashes=${dragSubs}  handleFailures+${(await mediaHandleFailures(page)) - beforeDrag}  gesturesThatWrote=${dragged}/4  (luma worst=${dragWorst})`
    );
  }

  // ── TRIGGER 3: replay. ──
  const beforePlay = await mediaHandleFailures(page);
  const subsBeforePlay = await hostSubstitutions(page);
  const play: number[] = [];
  await page.keyboard.press("Space");
  for (let i = 0; i < 12; i += 1) {
    await page.waitForTimeout(250);
    play.push(await luma(page));
  }
  await page.keyboard.press("Space");
  await page.waitForTimeout(800);
  const playWorst = worst(play.filter((v) => v >= 0));
  const playSubs = (await hostSubstitutions(page)) - subsBeforePlay;
  console.log(`REPLAY  hostFlashes=${playSubs}  handleFailures+${(await mediaHandleFailures(page)) - beforePlay}  (luma worst=${playWorst})`);

  // ── TRIGGER 4: TEN SECONDS. The wall-clock idle sweep fires at RESOURCE_IDLE_MS = 10_000, and every
  // arm above is far shorter than that (the replay arm is 3s), so none of them could ever have reached
  // it. The departed-prune fix retains declared loaders across the SET-DIFFERENCE reaper; it does
  // nothing about the CLOCK reaper, and if a loader's `lastUsedAt` were frozen this is where a periodic
  // hitch at ~10-20s spacing would appear. Both halves have to be right together, because the idle
  // sweep is also the backstop that makes declared-retention safe from leaking.
  //
  // Run BOTH rest states: the sweep is wall-clock, so it does not care whether the transport moves, and
  // a paused editor showing a loader is the state most likely to sit still past the TTL.
  const longArms: Array<{ name: string; playing: boolean }> = [
    { name: "LONGPLAY", playing: true },
    { name: "LONGIDLE", playing: false },
  ];
  let longFailures = 0;
  let longFlashes = 0;
  for (const arm of longArms) {
    const c0 = await census(page);
    const f0 = await mediaHandleFailures(page);
    const s0 = await hostSubstitutions(page);
    if (arm.playing) await page.keyboard.press("Space");
    let peakIdle = 0;
    for (let i = 0; i < 15; i += 1) {
      await page.waitForTimeout(1_000);
      const c = await census(page);
      if (c.oldestIdleMs > peakIdle) peakIdle = c.oldestIdleMs;
    }
    if (arm.playing) await page.keyboard.press("Space");
    await page.waitForTimeout(600);
    const c1 = await census(page);
    const df = (await mediaHandleFailures(page)) - f0;
    const ds = (await hostSubstitutions(page)) - s0;
    longFailures += df;
    longFlashes += ds;
    console.log(
      `${arm.name} (15s) hostFlashes=${ds}  handleFailures+${df}  resources ${c0.total}->${c1.total}` +
        `  media ${c0.media}->${c1.media}  peakIdle=${peakIdle}ms  reclaimed ${c0.reclaimed}->${c1.reclaimed}  scopes[${c1.scopes}]`
    );
  }

  await page.screenshot({ path: path.join(OUT, "final.png") });
  const totalFailures = await mediaHandleFailures(page);
  const versions = await compVersions(page);
  const totalFlashes = scrubSubs + dragSubs + playSubs + longFlashes;
  console.log(`\nhost flashes across all gestures = ${totalFlashes}`);
  console.log(`media handle failures (total)    = ${totalFailures}`);
  console.log(`comp versions                    = ${versions.join(", ")}`);

  // The gate is the SYMPTOM (the host was substituted for the loader's picture) and its MECHANISM (the
  // loader's media resource was forgotten under its holder). Both must be zero: a run with flashes but
  // no handle failures would mean a second, different cause, and one with handle failures but no
  // flashes would mean the latch is still live and merely got lucky about which frames presented.
  const pass = totalFlashes === 0 && totalFailures === 0;
  console.log(pass ? "\nPASS - the loader's picture held through scrub, drag and replay" : "\nFAIL - the host is still being substituted, or the teardown ladder still fires");

  await context.close();
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
