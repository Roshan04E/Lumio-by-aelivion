/**
 * BROWSER EVIDENCE for the Flarex key-colour eyedropper.
 *
 * Claims under test, in the real editor:
 *   1. A wired chromaKey node offers a Pick affordance; an UNWIRED one refuses (nothing to sample).
 *   2. Clicking the input image writes the SAMPLED colour into `chromaKey.color`.
 *   3. The sampled colour comes from the node's INPUT buffer, not the composited viewer output —
 *      demonstrated by keying the plate first, so the viewer at that point is transparent/black while
 *      the picked value is the plate's own colour.
 *   4. Sample RADIUS is real: two different box sizes over textured footage give different means.
 *   5. Picking is REFUSED while the transport is playing (a still frame is the only honest sample).
 *
 * Requires: `pnpm dev` up on :5173 and PIXEL_BROWSER_CHANNEL=chrome (SwiftShader composites at ~8fps,
 * where the capture handle's readiness gates behave nothing like a real GPU).
 *
 *   PIXEL_BROWSER_CHANNEL=chrome pnpm --filter @orreris/worker exec tsx tmp/flarex-eyedropper-probe.ts
 */
import { chromium, type Browser, type Page } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { reachEditor } from "../src/browser/editor-session.js";

const OUT = path.resolve(process.cwd(), "tmp/eyedropper");
fs.mkdirSync(OUT, { recursive: true });

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ok  ${name}${detail ? `  ${detail}` : ""}`);
  else {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? `  ${detail}` : ""}`);
  }
}
function note(name: string, detail: string): void {
  console.log(`  ··  ${name}  ${detail}`);
}

/**
 * Canvas world → page coords.
 *
 * The node canvas AUTO-FITS once per comp (`fitView`, keyed on `comp.id` — so it runs on the default
 * mediaIn/mediaOut graph and never again), which is why a hardcoded pan/zoom put every click on empty
 * canvas the first time this probe ran. Replicated here from the same constants rather than guessed:
 *   bounds of {mediaIn(0,0), mediaOut(320,0)}, both 132×91 with a 6+8px label headroom above
 *   → x0=0, x1=452, y0=-14, y1=91, pad=60
 */
interface CanvasBox {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface View {
  zoom: number;
  panX: number;
  panY: number;
}
function fittedView(box: CanvasBox): View {
  const x0 = 0;
  const x1 = 452;
  const y0 = -14;
  const y1 = 91;
  const pad = 60;
  const zoom = Math.min(2.5, Math.max(0.25, Math.min(box.width / (x1 - x0 + pad * 2), box.height / (y1 - y0 + pad * 2), 1)));
  return { zoom, panX: (x0 + x1) / 2 - box.width / (2 * zoom), panY: (y0 + y1) / 2 - box.height / (2 * zoom) };
}
const w2s = (box: CanvasBox, view: View, wx: number, wy: number): { x: number; y: number } => ({
  x: box.x + (wx - view.panX) * view.zoom,
  y: box.y + (wy - view.panY) * view.zoom,
});

/** Read the chromaKey node's `color` param straight off the inspector's colour row. */
async function keyColor(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>(".flarex-inspector input[type=color]");
    return input ? input.value.toLowerCase() : null;
  });
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  // Several intermediate moves: the canvas gesture machine arms on the first move, and a single jump
  // has been enough to miss the socket hit-test in past probes.
  for (let i = 1; i <= 6; i += 1) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / 6, from.y + ((to.y - from.y) * i) / 6);
    await page.waitForTimeout(30);
  }
  await page.mouse.up();
  await page.waitForTimeout(350);
}

async function main(): Promise<void> {
  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  if (!channel) console.warn("WARNING: PIXEL_BROWSER_CHANNEL unset — SwiftShader may refuse the capture handle.");
  const browser: Browser = await chromium.launch(channel ? { channel } : {});
  const context = await browser.newContext({ viewport: { width: 1700, height: 950 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(String(err).slice(0, 300)));

  const url = await reachEditor(page, { settleMs: 9_000 });
  console.log(`editor: ${url}`);

  await page.locator(".timeline-clip").first().click().catch(() => undefined);
  await page.waitForTimeout(800);
  await page.getByRole("tab", { name: /flarex/i }).first().click({ timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(2_000);
  const create = page.getByRole("button", { name: /create flarex comp/i }).first();
  if (await create.count().catch(() => 0)) {
    await create.click().catch(() => undefined);
    await page.waitForTimeout(3_500);
  }

  const canvas = page.locator(".flarex-body canvas").first();
  await canvas.waitFor({ state: "visible", timeout: 30_000 }).catch(() => undefined);
  await page.waitForTimeout(2_000);
  const box = (await canvas.boundingBox().catch(() => null)) as CanvasBox | null;
  if (!box) {
    console.error("VOID: no node canvas");
    await browser.close();
    process.exit(1);
  }

  // ── Add a Chroma Keyer, UNWIRED first ────────────────────────────────────────────────────────
  const add = page.locator('[aria-label="Add Chroma Keyer"]').first();
  if ((await add.count().catch(() => 0)) === 0) {
    const labels = await page.locator(".flarex-palette-btn").evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")));
    console.error(`VOID: no "Add Chroma Keyer" palette button. Available: ${JSON.stringify(labels)}`);
    await browser.close();
    process.exit(1);
  }
  await add.click();
  await page.waitForTimeout(1_200);

  const pick = page.locator('[data-testid="flarex-eyedropper-pick"]').first();
  check("keyer inspector shows the eyedropper row", (await pick.count()) === 1);
  check(
    "UNWIRED keyer: picking is refused (no input to sample)",
    await pick.isDisabled(),
    `title="${(await pick.getAttribute("title")) ?? ""}"`,
  );
  await page.screenshot({ path: path.join(OUT, "01-unwired.png") });

  // ── Wire mediaIn.out → chromaKey.in, and chromaKey.out → mediaOut.in ─────────────────────────
  // The default comp is mediaIn(0,0) → mediaOut(320,0); `nextNodePosition` drops the keyer at (180,0),
  // whose output socket would then sit 8px from mediaOut's input. Move it down 160 first.
  const view = fittedView(box);
  note("fitted view", JSON.stringify({ ...view, box: { w: box.width, h: box.height } }));
  // MediaOut moves RIGHT (not the keyer down: the fitted canvas is only ~225 world px tall, so a node
  // pushed down leaves the viewport and every later click lands on whatever is still visible).
  const OUT_X = 570;
  await drag(page, w2s(box, view, 386, 40), w2s(box, view, 386 + (OUT_X - 320), 40));
  await page.waitForTimeout(600);
  // Socket bank centres in the 74px picture band: a lone socket sits at +37; a 3-input bank starts at
  // +23 and steps by 14 (`in` is slot 0).
  await drag(page, w2s(box, view, 132, 37), w2s(box, view, 180, 23));
  await drag(page, w2s(box, view, 312, 37), w2s(box, view, OUT_X, 37));
  await page.waitForTimeout(2_500);
  await page.screenshot({ path: path.join(OUT, "02-wired.png") });

  // Re-select the keyer (the wire drags may have changed selection).
  const keyerCentre = w2s(box, view, 246, 40);
  await page.mouse.click(keyerCentre.x, keyerCentre.y);
  await page.waitForTimeout(900);
  const wiredPick = page.locator('[data-testid="flarex-eyedropper-pick"]').first();
  const enabled = (await wiredPick.count()) === 1 && !(await wiredPick.isDisabled());
  check("WIRED keyer: picking is offered", enabled, `title="${(await wiredPick.getAttribute("title").catch(() => "")) ?? ""}"`);
  if (!enabled) {
    console.error("VOID: could not wire the keyer through the canvas — every claim below is unmeasurable.");
    await page.screenshot({ path: path.join(OUT, "VOID-wiring.png") });
    await browser.close();
    process.exit(1);
  }

  const before = await keyColor(page);
  note("key colour before", String(before));

  // ── PICK ─────────────────────────────────────────────────────────────────────────────────────
  await wiredPick.click();
  await page.waitForTimeout(1_500);
  const surface = page.locator('[data-testid="flarex-eyedropper-canvas"]').first();
  const surfaceUp = (await surface.count()) === 1;
  check("pick surface opens with the node's input image", surfaceUp);
  await page.screenshot({ path: path.join(OUT, "03-surface.png") });
  if (!surfaceUp) {
    const err = await page.locator(".flarex-eyedropper-error").textContent().catch(() => null);
    console.error(`VOID: no pick surface. error row: ${err ?? "(none)"}`);
    await browser.close();
    process.exit(1);
  }

  // MATTE-ONLY makes claim 3 falsifiable. With it on, the keyer's own output — and therefore the
  // viewer — is the greyscale MATTE, while the node's INPUT is still the full-colour plate. A picker
  // that sampled the composited viewer would come back grey; one that reads the input comes back
  // coloured. Without this the two pictures are near-identical and the test proves nothing.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  const matteOnly = page.locator(".flarex-inspector").getByText(/matte only/i).first();
  if (await matteOnly.count().catch(() => 0)) {
    await matteOnly.click().catch(() => undefined);
    await page.waitForTimeout(2_000);
  }
  await wiredPick.click();
  await page.waitForTimeout(1_500);
  await page.screenshot({ path: path.join(OUT, "03b-matteonly.png") });

  const sbox = await surface.boundingBox();
  if (!sbox) throw new Error("no pick surface box");
  // What the SURFACE shows at the sample point (this is the node's INPUT) …
  const at = { fx: 0.5, fy: 0.5 };
  const surfacePixel = await surface.evaluate((el, p) => {
    const c = el as HTMLCanvasElement;
    const g = c.getContext("2d")!;
    const d = g.getImageData(Math.floor(c.width * p.fx), Math.floor(c.height * p.fy), 1, 1).data;
    return `#${[d[0], d[1], d[2]].map((n) => (n ?? 0).toString(16).padStart(2, "0")).join("")}`;
  }, at);
  // … and what the VIEWER shows at the same normalized point (this is the COMPOSITED output).
  const viewerPixel = await page.evaluate((p) => {
    const c = document.querySelector<HTMLCanvasElement>("canvas.preview-scene-canvas");
    if (!c) return null;
    const off = document.createElement("canvas");
    off.width = 1;
    off.height = 1;
    const g = off.getContext("2d")!;
    try {
      g.drawImage(c, Math.floor(c.width * p.fx), Math.floor(c.height * p.fy), 1, 1, 0, 0, 1, 1);
    } catch {
      return "TAINTED";
    }
    const d = g.getImageData(0, 0, 1, 1).data;
    return `#${[d[0], d[1], d[2]].map((n) => (n ?? 0).toString(16).padStart(2, "0")).join("")}`;
  }, at);
  note("input pixel (pick surface)", String(surfacePixel));
  note("viewer pixel (composited, matte-only)", String(viewerPixel));
  const chroma = (hex: string): number => {
    const n = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return Math.max(...n) - Math.min(...n);
  };
  check(
    "the pick surface is the node's INPUT, not the composited viewer output",
    typeof viewerPixel === "string" && viewerPixel.startsWith("#") && surfacePixel !== viewerPixel && chroma(surfacePixel) > chroma(viewerPixel),
    `input=${surfacePixel} (chroma ${chroma(surfacePixel)})  viewer=${viewerPixel}${typeof viewerPixel === "string" && viewerPixel.startsWith("#") ? ` (chroma ${chroma(viewerPixel)})` : ""}`,
  );

  // Hover readout — what the component says it would sample, before committing.
  await page.mouse.move(sbox.x + sbox.width * at.fx, sbox.y + sbox.height * at.fy);
  await page.waitForTimeout(250);
  const hoverHex = (await page.locator('[data-testid="flarex-eyedropper-hex"]').textContent())?.trim().toLowerCase() ?? "";
  note("hover readout (5x5 mean)", hoverHex);

  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(900);
  const after = await keyColor(page);
  note("key colour after", String(after));
  check("clicking the input image WRITES the sampled colour into chromaKey.color", after === hoverHex, `${before} → ${after} (sampled ${hoverHex})`);
  check("the picked value actually changed the param", after !== before);
  await page.screenshot({ path: path.join(OUT, "04-picked.png") });

  // ── SAMPLE RADIUS ────────────────────────────────────────────────────────────────────────────
  // Two box sizes over the same point. On real footage the means differ; a control that ignored its
  // size would return the same string twice.
  const readAt = async (size: string, fx: number, fy: number): Promise<string> => {
    await page.locator('[data-testid="flarex-eyedropper-pick"]').first().click();
    await page.waitForTimeout(1_200);
    await page.locator('[data-testid="flarex-eyedropper-size"]').first().selectOption(size);
    const b = (await page.locator('[data-testid="flarex-eyedropper-canvas"]').first().boundingBox())!;
    await page.mouse.move(b.x + b.width * fx, b.y + b.height * fy);
    await page.waitForTimeout(250);
    const hex = (await page.locator('[data-testid="flarex-eyedropper-hex"]').textContent())?.trim().toLowerCase() ?? "";
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    return hex;
  };
  const one = await readAt("1", 0.5, 0.42);
  const nine = await readAt("9", 0.5, 0.42);
  note("1x1 sample", one);
  note("9x9 sample", nine);
  check("sample radius is real (1x1 and 9x9 disagree over textured footage)", one !== nine && one !== "" && nine !== "");

  // ── PLAYING REFUSES ──────────────────────────────────────────────────────────────────────────
  await page.keyboard.press("Space");
  await page.waitForTimeout(1_200);
  const playingPick = page.locator('[data-testid="flarex-eyedropper-pick"]').first();
  const playingDisabled = await playingPick.isDisabled().catch(() => false);
  check("picking is refused while PLAYING (never a stale frame)", playingDisabled, `title="${(await playingPick.getAttribute("title")) ?? ""}"`);
  await page.screenshot({ path: path.join(OUT, "05-playing.png") });
  await page.keyboard.press("Space");
  await page.waitForTimeout(600);

  if (errors.length) {
    console.log(`page errors (${errors.length}):`);
    for (const e of errors.slice(-10)) console.log(`  ${e}`);
  }
  console.log(failures === 0 ? "\nPROBE PASSED" : `\nPROBE FAILED (${failures})`);
  await context.close();
  await browser.close();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
