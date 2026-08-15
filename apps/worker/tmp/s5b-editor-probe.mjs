/**
 * ADR-023 S5b — does the EDITOR actually let you author an image fill?
 *
 * The stage's premise is "a look you cannot author", so every other gate here answers the wrong half:
 * the schema gate proves a fill round-trips through Save Style, the falsifier proves it reaches the
 * renderer, and neither can tell you whether a row appears in the panel. That is the half that was
 * broken for four months while the renderer worked perfectly.
 *
 *   node apps/worker/tmp/s5b-editor-probe.mjs
 */
import { chromium } from "playwright";

const browser = await chromium.launch({ channel: process.env.PIXEL_BROWSER_CHANNEL || "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const results = [];
const check = (name, ok, detail = "") => {
  results.push([name, ok, detail]);
  console.log(`${ok ? "  ok" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

try {
  const { reachEditor } = await import("../src/browser/editor-session.ts");
  await reachEditor(page, {});

  // Add a text layer, select it, open the Text inspector.
  const addText = page.getByRole("button", { name: /add text|^text$/i }).first();
  await addText.click({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  const textClip = page.locator(".timeline-clip").filter({ hasText: /text/i }).first();
  if (await textClip.count()) await textClip.click();
  await page.waitForTimeout(1200);

  // The inspector is a TOGGLE and starts closed — the first run of this probe reported "no Image fill
  // row" against a panel that was not on screen, which is the instrument answering about itself.
  const inspectorToggle = page.getByRole("button", { name: /inspector/i }).first();
  if (await inspectorToggle.count()) {
    await inspectorToggle.click();
    await page.waitForTimeout(1500);
  }
  check("the inspector panel is open", await page.locator("text=/Fill & stroke/i").first().isVisible().catch(() => false));

  const fillRow = page.locator("text=Image fill").first();
  const rowVisible = await fillRow.isVisible().catch(() => false);
  check("the Image fill row exists in the Text inspector", rowVisible);

  if (rowVisible) {
    // The row's trigger enters media-pool pick mode — the same "Replace asset" flow Flarex's MediaIn
    // uses. Assert the MODE, not the click: a trigger that does nothing is the defect being fixed.
    await fillRow.click();
    await page.waitForTimeout(1200);
    const notice = await page.locator("text=Pick an image for the text fill").first().isVisible().catch(() => false);
    check("clicking it puts the media pool into pick-one mode", notice);
  }
} catch (error) {
  check("probe ran", false, String(error?.message ?? error));
}

await page.screenshot({ path: "tmp/s5b-editor.png", fullPage: false });
await browser.close();
console.log("\nstill: apps/worker/tmp/s5b-editor.png");
if (results.some(([, ok]) => !ok)) process.exit(1);
