/**
 * CONDITION 1 - are the two loader readings two defects, or one misread?
 *
 *   reading A (sibling, and my own supervisor-abc arm 1): freshly BOUND MediaIn, mid-session
 *                -> wc-sw / AWAITING / NO_LEASE / wcProvider:false / served:null
 *   reading B (the user's flicker trace):                 comp PERSISTED, loader mounts on page load
 *                -> wc-sw / ok / wcProvider:true / served:0
 *
 * Same asset, same routing, same comp. The only difference either of us can name is WHEN the loader
 * first mounts. This runs both in one session so the answer is a comparison, not two anecdotes:
 *
 *   arm 1  bind the MediaIn mid-session, read the loader
 *   arm 2  RELOAD the same project (comp now persisted, loader mounts during initial render), read again
 *
 * Same loader id in both arms - so if they disagree, mount timing is the variable and there are two
 * defects. If they agree, one of the two original readings was a fixture artefact.
 */
import { chromium, type Browser, type Page } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { reachEditor } from "../src/browser/editor-session.js";

const OUT = path.resolve(process.cwd(), "tmp/condition1");
fs.mkdirSync(OUT, { recursive: true });
const BIN_CLIP = path.resolve("../../apps/api/storage/uploads/1781868184015-beach.mp4");

async function loaderState(page: Page) {
  return page.evaluate(() => {
    const map = ((globalThis as any).__rfSourceMap ?? {}) as Record<string, any>;
    const out: Record<string, unknown> = {};
    for (const [id, v] of Object.entries(map)) {
      if (!id.startsWith("flarexsrc:")) continue;
      out[id.slice(-28)] = { decode: v.decode, state: v.state, why: v.why, wcProvider: v.wcProvider, served: v.served };
    }
    const pool = (globalThis as any).__rfWcPool;
    return { loaders: out, pool: pool ? { created: pool.created, active: pool.active, capMisses: pool.capMisses, denials: pool.admissionDenials } : null };
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
  await page.locator('[aria-label="Add MediaIn"]').first().click().catch(() => undefined);
  await page.waitForTimeout(1_200);
  const trigger = page.locator(".flarex-source-trigger").last();
  await trigger.click().catch(() => undefined);
  await page.waitForTimeout(900);
  const idx = (await page.locator(".asset-tile").evaluateAll((els) => els.map((e) => (e.textContent ?? "").toLowerCase()))).findIndex((t) => t.includes("beach"));
  if (idx < 0) {
    console.log("VOID: no beach tile");
    await browser.close();
    return;
  }
  await page.locator(".asset-tile").nth(idx).dblclick().catch(() => undefined);

  // ARM 1 - mid-session bind. Sampled repeatedly: "never arrives" and "arrives slowly" are different
  // diseases and a single late read cannot tell them apart.
  for (const wait of [3_000, 5_000, 10_000, 15_000]) {
    await page.waitForTimeout(wait === 3_000 ? 3_000 : 5_000);
    console.log(`ARM1 @${String(wait).padStart(6)}ms  ${JSON.stringify(await loaderState(page))}`);
  }
  await page.screenshot({ path: path.join(OUT, "arm1.png") });

  // ARM 2 - same project, reloaded. The comp is persisted, so the loader mounts during initial render.
  const reload = new URL(url);
  reload.search = "";
  reload.searchParams.set("flarexTrace", "1");
  reload.searchParams.set("kernelDiagnostics", "1");
  await page.goto(reload.toString(), { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(10_000);
  await page.locator(".timeline-clip").first().click().catch(() => undefined);
  await page.waitForTimeout(600);
  await page.getByRole("tab", { name: /flarex/i }).first().click().catch(() => undefined);
  for (const wait of [4_000, 5_000, 10_000]) {
    await page.waitForTimeout(wait === 4_000 ? 4_000 : 5_000);
    console.log(`ARM2 @${String(wait).padStart(6)}ms  ${JSON.stringify(await loaderState(page))}`);
  }
  await page.screenshot({ path: path.join(OUT, "arm2.png") });

  await context.close();
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
