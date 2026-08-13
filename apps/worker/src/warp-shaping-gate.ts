/**
 * S0 / ADR-023 T-12 — does warp REFUSE a shaping-dependent script, VISIBLY, in the real editor?
 *
 * Two arms on ONE layer, differing only in the text:
 *
 *   A (control)  "Warp"          Latin        → warp APPLIES: an SVG <path> overlay exists, no marker.
 *   B (subject)  "مرحبا بالعالم"  Arabic       → warp REFUSES: no overlay, and the marker is on screen.
 *
 * The control is the load-bearing half and the reason this is a gate rather than a screenshot. Arm B
 * alone cannot distinguish "warp refused because the script needs shaping" from "warp never worked
 * here" — a font that failed to fetch, a warp style that never armed, a layer that was never
 * selected. All of those produce an identical unwarped picture. Only a run where the SAME layer,
 * with the SAME warp, warps for Latin and refuses for Arabic says anything about the script.
 *
 * The marker has two independent surfaces and both are asserted, because they are different code
 * paths and the founder-visible failure is that one of them silently stops rendering:
 *   - the preview badge   (`.preview-warp-suppressed`, VideoPreview) — seen without opening a panel;
 *   - the inspector notice (`.warp-shaping-notice`, TextWarpPanel)   — seen where warp is controlled.
 *
 * Run: pnpm --filter @orreris/worker warp:shaping-gate
 * Needs a Chrome channel (PIXEL_BROWSER_CHANNEL=chrome); SwiftShader is not required here but the
 * editor is measurably better behaved on real Chrome, and the preflight refusal is the same either
 * way. Screenshots land in tmp/warp-shaping/.
 *
 * DELETE THIS FILE with S0 itself, when the D9a rasterize-then-deform rework lands (T-12 retires the
 * whole interim gate — there is no shaping gap left to guard once shaping happens before deform).
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import { assertQuietBrowserMachine, listAutomationBrowsers } from "./browser/browser-preflight";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const artifactDir = path.join(repoRoot, "tmp", "warp-shaping");

/** Arabic. Cursive-joining: every letter's shape depends on its neighbours, so glyph lookup is wrong. */
const ARABIC = "مرحبا بالعالم";
const LATIN = "Warp";

interface ArmReading {
  /** Did the warp engine produce its SVG <path> overlay? */
  warpPathCount: number;
  /** Is the preview badge on screen? */
  previewBadge: boolean;
  /** Is the inspector notice on screen? */
  inspectorNotice: boolean;
  /** What the layer's text actually is, read back — proves the arm is the arm it claims to be. */
  text: string;
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

function startWebServer(port: number) {
  // shell:true so Windows resolves `pnpm` → `pnpm.cmd` (see render-pixel-comparison for the why).
  const child = spawn(
    "pnpm",
    ["--dir", path.join(repoRoot, "apps/web"), "exec", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    { cwd: repoRoot, env: { ...process.env, BROWSER: "none" }, stdio: ["ignore", "pipe", "pipe"], shell: true }
  );
  child.stdout.on("data", (data) => process.stdout.write(`[web] ${data}`));
  child.stderr.on("data", (data) => process.stderr.write(`[web] ${data}`));
  return child;
}

/**
 * Reap the vite tree. `child.kill()` is not enough: `shell:true` makes the direct child a shell, so
 * killing it orphans the node process actually holding the port. Two of those survived an
 * interrupted run of this gate while it was being written, and a leftover vite is the documented
 * cause of a later gate hanging with no output and no browser.
 */
function stopWebServer(child: { pid?: number | undefined; kill: () => void }): void {
  if (child.pid && process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
      return;
    } catch {
      // fall through to the portable kill
    }
  }
  child.kill();
}

async function waitForServer(url: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`web server never answered at ${url}`);
}

/** Replace the selected text layer's content through the product's own rich-text editor. */
async function setLayerText(page: Page, text: string): Promise<void> {
  const editor = page.getByRole("textbox", { name: /text content/i }).first();
  await editor.waitFor({ state: "visible", timeout: 20_000 });
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  // `insertText` rather than type(): the commit path reads the contentEditable on input/blur, and a
  // per-key type() on an RTL run is where a flaky harness would come from.
  await page.keyboard.insertText(text);
  await editor.blur();
  await page.waitForTimeout(1_200);
}

async function readArm(page: Page): Promise<ArmReading> {
  return page.evaluate(() => {
    const button = document.querySelector(".preview-text-layer");
    /**
     * PAINTED, not merely present. `querySelector` returning non-null is a far weaker claim than the
     * one S0 makes: a marker that exists in the DOM at zero size, fully transparent, or clipped out
     * of its scroll container is exactly the silent failure this stage exists to end. Requiring real
     * area and non-zero opacity is what makes the assertion mean "the user can see it".
     *
     * Written as a LOOP, not a helper arrow function, deliberately: tsx compiles a function-valued
     * const with `keepNames`, which wraps it in `__name(...)` — a symbol that exists in the bundler's
     * output and not in the page, so every arm would die with "__name is not defined".
     */
    const painted: Record<string, boolean> = { previewBadge: false, inspectorNotice: false };
    const targets: Array<[string, string]> = [
      ["previewBadge", ".preview-warp-suppressed"],
      ["inspectorNotice", ".warp-shaping-notice"]
    ];
    for (const [key, selector] of targets) {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      // IN THE VIEWPORT, not merely laid out. An element scrolled below the fold still reports a
      // full-size rect, so without this the check passes on a marker nobody can see — which is the
      // exact failure S0 exists to end, reproduced inside its own gate. (It did: the first version
      // of this passed while both markers were off-screen.)
      if (rect.bottom <= 0 || rect.right <= 0) continue;
      if (rect.top >= window.innerHeight || rect.left >= window.innerWidth) continue;
      // EFFECTIVE opacity, walked up the ancestor chain — not the element's own. This is the check
      // that caught the real defect: the badge was nested inside the text button, which carries
      // `opacity: 0` whenever the layer is GPU-composited, so the marker reported opacity 1, a full
      // rect, `visibility: visible` — and painted nothing at all. A marker that can lie about being
      // on screen is worse than no marker, because this stage's entire claim is "visibly".
      let effective = 1;
      let visible = true;
      let node: HTMLElement | null = element;
      while (node) {
        const style = window.getComputedStyle(node);
        if (style.visibility === "hidden" || style.display === "none") visible = false;
        effective *= Number(style.opacity === "" ? 1 : style.opacity);
        node = node.parentElement;
      }
      painted[key] = visible && effective > 0.05;
    }
    return {
      warpPathCount: document.querySelectorAll("svg.warp-text-path path").length,
      previewBadge: painted.previewBadge === true,
      inspectorNotice: painted.inspectorNotice === true,
      text: (button?.textContent ?? "").trim()
    };
  });
}

async function main(): Promise<void> {
  assertQuietBrowserMachine({ label: "warp:shaping-gate", scriptMarker: "warp-shaping-gate" });
  process.stdout.write(`preflight: ${listAutomationBrowsers().length} automation browser process(es) alive (must be 0)\n`);

  fs.mkdirSync(artifactDir, { recursive: true });
  const port = await getFreePort();
  const vite = startWebServer(port);
  const base = `http://127.0.0.1:${port}`;
  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  if (!channel) process.stdout.write("NOTE: PIXEL_BROWSER_CHANNEL unset — running on bundled Chromium.\n");

  // `editor-session` reads PROBE_BASE at MODULE LOAD, so it is imported only after this gate's own
  // server is chosen. A static import would bake in localhost:5173 and drive whatever dev server the
  // developer happens to have running — a different tree from the one this gate just built.
  process.env.PROBE_BASE = base;
  const { reachEditor } = await import("./browser/editor-session");

  const browser = await chromium.launch(channel ? { channel } : {});
  try {
    await waitForServer(base);
    const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
    page.on("pageerror", (error) => process.stdout.write(`[pageerror] ${String(error)}\n`));

    await reachEditor(page, { ...(process.env.PROBE_CLIP ? { clipPath: process.env.PROBE_CLIP } : {}), settleMs: 6_000 });
    process.stdout.write(`editor: ${page.url()}\n`);

    // A text layer, through the product's own control.
    await page.locator('button[title="Add text"]').first().click({ timeout: 20_000 });
    await page.waitForTimeout(1_500);
    const textClip = page.locator(".timeline-clip", { hasText: /text/i }).first();
    await textClip.click({ timeout: 20_000 });
    await page.waitForTimeout(1_200);

    // The inspector is a toggled panel and starts closed on a fresh project — without this the
    // whole Warp section simply is not in the DOM.
    await page.getByRole("button", { name: /^inspector$/i }).first().click({ timeout: 20_000 });
    await page.waitForTimeout(1_500);
    // The Warp section is a collapsible whose panel is lazy-loaded, so "is it open?" cannot be read
    // from the header — toggle until the control it contains actually exists. Bounded, and it fails
    // by falling through to the click below rather than by looping.
    const warpSection = page.getByRole("button", { name: /^warp$/i }).first();
    const warpStyle = page.getByRole("button", { name: /warp style/i }).first();
    for (let attempt = 0; attempt < 3 && !(await warpStyle.count().catch(() => 0)); attempt += 1) {
      await warpSection.scrollIntoViewIfNeeded().catch(() => undefined);
      await warpSection.click().catch(() => undefined);
      await page.waitForTimeout(2_000);
    }

    // Keep the Warp section in view for BOTH arms, so the screenshots differ only in the text and
    // the inspector notice is photographed rather than merely asserted.
    await page.getByRole("button", { name: /^warp$/i }).first().scrollIntoViewIfNeeded().catch(() => undefined);
    await page.waitForTimeout(500);

    // Always capture the assembled setup. Every failure this gate had while it was written was a
    // SETUP failure (inspector closed, section collapsed, panel crashed), and each one cost a run to
    // diagnose because the only artifact was a locator timeout.
    await page.screenshot({ path: path.join(artifactDir, "setup.png"), fullPage: true });

    // Arm the warp: style Arc with a real bend. Both arms share this, unchanged.
    await page.getByRole("button", { name: /warp style/i }).first().click({ timeout: 20_000 });
    await page.waitForTimeout(400);
    await page.getByRole("option", { name: /^arc$/i }).first().click({ timeout: 10_000 });
    await page.waitForTimeout(2_500);

    // ---- Arm A: Latin. Warp must APPLY. ----
    await setLayerText(page, LATIN);
    await page.waitForTimeout(3_000);
    const armA = await readArm(page);
    await page.screenshot({ path: path.join(artifactDir, "arm-a-latin-warped.png") });
    process.stdout.write(`arm A (latin)  ${JSON.stringify(armA)}\n`);

    // ---- Arm B: Arabic. Warp must REFUSE, visibly. ----
    await setLayerText(page, ARABIC);
    await page.waitForTimeout(3_000);
    await page.locator(".warp-shaping-notice").first().scrollIntoViewIfNeeded().catch(() => undefined);
    await page.waitForTimeout(600);
    const armB = await readArm(page);
    await page.screenshot({ path: path.join(artifactDir, "arm-b-arabic-refused.png") });
    // Each marker on its own, large enough to read. The full-page shot is at ~28% preview zoom, where
    // a marker that IS rendering is a few pixels tall and indistinguishable from one that is not.
    await page
      .locator(".preview-warp-suppressed")
      .first()
      .screenshot({ path: path.join(artifactDir, "arm-b-marker-preview.png") })
      .catch(() => undefined);
    await page
      .locator(".warp-shaping-notice")
      .first()
      .screenshot({ path: path.join(artifactDir, "arm-b-marker-inspector.png") })
      .catch(() => undefined);
    process.stdout.write(`arm B (arabic) ${JSON.stringify(armB)}\n`);

    // The control first: without it, arm B proves nothing.
    assert.ok(
      armA.warpPathCount > 0,
      "CONTROL FAILED — warp did not apply to LATIN text either, so this run says nothing about " +
        "shaping. The warp font never loaded, the style never armed, or the layer was not selected. " +
        "Fix the setup; do not read arm B."
    );
    assert.equal(armA.previewBadge, false, "arm A: the preview badge must NOT show for Latin text.");
    assert.equal(armA.inspectorNotice, false, "arm A: the inspector notice must NOT show for Latin text.");

    assert.equal(armB.warpPathCount, 0, "arm B: warp must not apply to a shaping-dependent script.");
    assert.equal(armB.previewBadge, true, "arm B: the preview badge must be on screen (VideoPreview).");
    assert.equal(armB.inspectorNotice, true, "arm B: the inspector notice must be on screen (TextWarpPanel).");

    process.stdout.write(`\nPASS — warp applies to Latin (${armA.warpPathCount} path(s)) and refuses Arabic, with both markers visible.\n`);
    process.stdout.write(`screenshots: ${artifactDir}\n`);
  } finally {
    await browser.close().catch(() => undefined);
    stopWebServer(vite);
  }
}

main().catch((error) => {
  process.stderr.write(`${String(error?.stack ?? error)}\n`);
  process.exit(1);
});
