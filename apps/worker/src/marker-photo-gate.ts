/**
 * ADR-023 T-16 — **photograph the markers.** Discharges the debt S0c opened and named.
 *
 * T-16 exists because a marker that silently fails to paint is the purest form of the bug it guards
 * against, and S0 shipped exactly that: a badge nested inside an element carrying `opacity: 0`,
 * reporting a full rect, `opacity: 1` and `visibility: visible`. Two successive versions of that
 * check passed on an invisible element. S0c then added a third marker and argued it structurally
 * sound — same class, same sibling placement — but said plainly that it had never been
 * photographed. This is that photograph, and D3's substitution surface built in this commit is the
 * fourth marker, taken in the same shot.
 *
 * TWO MARKERS, ONE LAYER, because a two-colour Arabic line whose pinned font is also missing is
 * simultaneously in both degraded states:
 *   - `preview-visual-order-unavailable` (S0c/T-13a) — canvas 2D cannot reorder a line it must
 *     place run by run, so logical order is emitted and announced rather than emitted silently;
 *   - `preview-font-substituted`         (S2/D3)     — the pinned font did not resolve, the preview
 *     is drawing a substitute, and says so.
 *
 * THE CHECK IS FALSIFIED BEFORE IT IS TRUSTED. The `hidden-control` arm stages the identical layer
 * inside an ancestor at `opacity: 0` — not `display:none`, not `visibility:hidden`, which any naive
 * check catches, but the exact shape that fooled S0. Both markers are in the DOM and report
 * themselves healthy. If the checker passes that arm, its verdict on the real arm is worthless, so
 * the control runs FIRST and a pass there is a hard failure of this gate.
 *
 * Run: PIXEL_BROWSER_CHANNEL=chrome pnpm --filter @orreris/worker marker:photo-gate
 * Screenshots land in tmp/marker-photo/.
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
const artifactDir = path.join(repoRoot, "tmp", "marker-photo");

const MARKERS = ["preview-visual-order-unavailable", "preview-font-substituted"] as const;
type MarkerId = (typeof MARKERS)[number];

interface MarkerReading {
  present: boolean;
  /** Effective opacity: the product of every ancestor's, which is the number that decides visibility. */
  effectiveOpacity: number;
  /** Does its box actually intersect the viewport? */
  inViewport: boolean;
  width: number;
  height: number;
  painted: boolean;
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
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

/** Reap the vite TREE — `child.kill()` orphans the node process holding the port under `shell:true`. */
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

async function waitForServer(url: string, timeoutMs = 120_000): Promise<void> {
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

/**
 * Read whether a marker is actually PAINTED.
 *
 * Written as one flat function with `for` loops and no inner arrow functions: tsx's `keepNames`
 * wraps a function-valued const in `__name()`, which does not exist in the page, and every arm of
 * such a probe dies with "`__name` is not defined" — a VOID run that reads like a failure.
 *
 * The three things it checks are the three that S0's naive versions missed, in order of how badly:
 *  1. EFFECTIVE opacity, multiplied up the ancestor chain. An element at `opacity: 1` inside a
 *     parent at `opacity: 0` is invisible and reports perfect health locally. This is the one that
 *     shipped.
 *  2. Viewport intersection. A marker positioned off-screen paints nothing a user can read.
 *  3. A non-degenerate box, plus `display`/`visibility` up the chain for completeness.
 */
async function readMarker(page: Page, testId: MarkerId): Promise<MarkerReading> {
  return page.evaluate((id) => {
    const node = document.querySelector(`[data-testid="${id}"]`);
    if (!node) return { present: false, effectiveOpacity: 0, inViewport: false, width: 0, height: 0, painted: false };

    let opacity = 1;
    let visible = true;
    let element: Element | null = node;
    while (element) {
      const style = window.getComputedStyle(element);
      opacity *= Number(style.opacity === "" ? "1" : style.opacity);
      if (style.display === "none" || style.visibility === "hidden") visible = false;
      element = element.parentElement;
    }

    const rect = node.getBoundingClientRect();
    const inViewport =
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < window.innerHeight &&
      rect.left < window.innerWidth;

    return {
      present: true,
      effectiveOpacity: opacity,
      inViewport,
      width: rect.width,
      height: rect.height,
      painted: visible && inViewport && opacity > 0.01 && rect.width >= 1 && rect.height >= 1
    };
  }, testId);
}

async function readArm(page: Page, base: string, marker: "both" | "hidden-control", label: string) {
  const url = `${base}/editor/__preview-fixture?fixture=scaled-text&marker=${marker}`;
  await page.goto(url, { waitUntil: "networkidle" });
  await page.locator('[data-render-fixture="ready"]').waitFor({ state: "attached", timeout: 30_000 });
  // The substitution marker only appears once the font install has RESOLVED (as missing). A check
  // that read before that would see no marker and call it hidden — a false pass on the control and a
  // false failure on the subject.
  await page.waitForTimeout(3_000);
  await page.screenshot({ path: path.join(artifactDir, `${label}.png`), fullPage: false });

  const readings: Record<string, MarkerReading> = {};
  for (const id of MARKERS) readings[id] = await readMarker(page, id);
  return readings;
}

async function main(): Promise<void> {
  assertQuietBrowserMachine({ label: "marker:photo-gate", scriptMarker: "marker-photo-gate" });
  process.stdout.write(`preflight: ${listAutomationBrowsers().length} automation browser process(es) alive (must be 0)\n`);
  fs.mkdirSync(artifactDir, { recursive: true });

  const port = await getFreePort();
  const vite = startWebServer(port);
  const base = `http://127.0.0.1:${port}`;
  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  if (!channel) process.stdout.write("NOTE: PIXEL_BROWSER_CHANNEL unset — running on bundled Chromium.\n");

  const browser = await chromium.launch(channel ? { channel } : {});
  try {
    await waitForServer(base);
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on("pageerror", (error) => process.stdout.write(`[pageerror] ${String(error)}\n`));

    /* ---- FALSIFY THE CHECK FIRST. ------------------------------------------------------------
     * Same markers, same states, ancestor at opacity 0. If `painted` comes back true here, this
     * gate cannot tell a visible marker from an invisible one and its verdict below means nothing.
     */
    const control = await readArm(page, base, "hidden-control", "control-hidden");
    for (const id of MARKERS) {
      const reading = control[id]!;
      process.stdout.write(
        `control  ${id.padEnd(34)} present=${reading.present} effOpacity=${reading.effectiveOpacity.toFixed(3)} ` +
          `inViewport=${reading.inViewport} painted=${reading.painted}\n`
      );
      assert.ok(
        reading.present,
        `CONTROL VOID — ${id} is not in the DOM on the hidden arm, so this proves nothing about the ` +
          `CHECK. The control must stage a marker that EXISTS and is merely invisible; a missing ` +
          `marker would be caught by any check at all.`
      );
      assert.equal(
        reading.painted,
        false,
        `T-16 CHECK IS BLIND — it reported ${id} as painted while an ancestor sat at opacity 0. This is ` +
          `the exact defect S0 shipped, and it means the subject result below is worthless. Fix the ` +
          `checker (walk effective opacity up the ancestor chain) before trusting any pass.`
      );
    }
    process.stdout.write("check falsified: it CAN fail on an invisible marker.\n\n");

    /* ---- Now the real thing. ------------------------------------------------------------------ */
    const subject = await readArm(page, base, "both", "subject-both-markers");
    for (const id of MARKERS) {
      const reading = subject[id]!;
      process.stdout.write(
        `subject  ${id.padEnd(34)} present=${reading.present} effOpacity=${reading.effectiveOpacity.toFixed(3)} ` +
          `inViewport=${reading.inViewport} ${Math.round(reading.width)}x${Math.round(reading.height)} painted=${reading.painted}\n`
      );
      assert.ok(reading.present, `${id} never rendered — the degraded state was not detected at all.`);
      assert.ok(
        reading.painted,
        `${id} is in the DOM but NOT PAINTED (effOpacity=${reading.effectiveOpacity}, inViewport=${reading.inViewport}, ` +
          `${reading.width}x${reading.height}). A degraded state announced only to the DOM inspector is not announced.`
      );
    }

    // Both at once, which is the plan's claim about this harness: one layer, one shot, two markers.
    assert.ok(
      MARKERS.every((id) => subject[id]!.painted),
      "both markers must be visible SIMULTANEOUSLY — one covering the other is still a marker nobody reads."
    );

    process.stdout.write("\nPASS — both markers photographed, and the check was proven able to fail first.\n");
    process.stdout.write(`screenshots: ${artifactDir}\n`);
  } finally {
    await browser.close();
    stopWebServer(vite);
  }
}

main().catch((error) => {
  process.stderr.write(`${String(error?.stack ?? error)}\n`);
  process.exit(1);
});
