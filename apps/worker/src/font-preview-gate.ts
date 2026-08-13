/**
 * ADR-023 T-17 / S2.5 — **do the picker's previews render in the face they name?**
 *
 * The precedent is specific. `warpFontCatalog` shipped EMPTY, every warped family fell through to
 * the Roboto fallback, and the symptom that reached a user was "changing the font did nothing". A
 * font surface showing the fallback looks exactly like one that works, so the only way to know is to
 * compare against what "broken" actually looks like.
 *
 * T-17 forbids the tempting shortcut — asserting the host does not have these fonts — because that
 * makes the gate depend on the font folder it is standing in and turns green on a machine that
 * happens to have them. So the machine demonstrates the difference instead: each catalogue face is
 * drawn twice, identical text and box, once through its loaded preview face and once through a
 * family name that resolves to nothing. Those two must DIFFER.
 *
 * Two further arms, because "differs from the fallback" alone is not enough:
 *  - every face must differ from every OTHER face, or one loaded font is standing in for all of them
 *    (the empty-catalogue failure with one row filled in);
 *  - the fallback controls must all be IDENTICAL to each other, which proves the control really is
 *    one unstyled baseline rather than N different things that happen not to match their subjects.
 *
 * Run: PIXEL_BROWSER_CHANNEL=chrome pnpm --filter @orreris/worker font:preview-gate
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import { catalogueFaces } from "@orreris/shared";
import { assertQuietBrowserMachine, listAutomationBrowsers } from "./browser/browser-preflight";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const artifactDir = path.join(repoRoot, "tmp", "font-preview");

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

/** Screenshot one element and hash the PNG. Pixels, not computed style — T-16's lesson, reused. */
async function shotHash(page: Page, testId: string, file: string): Promise<string> {
  const target = page.locator(`[data-testid="${testId}"]`);
  await target.waitFor({ state: "visible", timeout: 20_000 });
  const buffer = await target.screenshot({ path: path.join(artifactDir, `${file}.png`) });
  return createHash("sha256").update(buffer).digest("hex");
}

async function main(): Promise<void> {
  assertQuietBrowserMachine({ label: "font:preview-gate", scriptMarker: "font-preview-gate" });
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
    const page = await browser.newPage({ viewport: { width: 900, height: 1400 } });
    page.on("pageerror", (error) => process.stdout.write(`[pageerror] ${String(error)}\n`));

    await page.goto(`${base}/editor/__preview-fixture?catalogue=probe`, { waitUntil: "networkidle" });
    await page.locator('[data-catalogue-probe="ready"]').waitFor({ state: "visible", timeout: 30_000 });
    // Font loads are async; the probe reports per-face readiness and the assertions below require it.
    await page.waitForTimeout(3_000);

    const faces = catalogueFaces();
    assert.ok(faces.length > 0, "an empty catalogue is the defect under test — the gate is void.");

    const previews = new Map<string, string>();
    const fallbacks = new Map<string, string>();

    for (const { family, face } of faces) {
      const id = `${family}-${face.weight}`;
      const ready = await page
        .locator(`[data-testid="catalogue-preview-${id}"]`)
        .getAttribute("data-preview-ready");
      assert.equal(
        ready,
        "true",
        `${id}: the preview face never loaded. The picker would show this row in the UI font, which is ` +
          `precisely the state that looks like a working font list and is not one.`
      );

      const preview = await shotHash(page, `catalogue-preview-${id}`, `preview-${id}`);
      const fallback = await shotHash(page, `catalogue-fallback-${id}`, `fallback-${id}`);
      previews.set(id, preview);
      fallbacks.set(id, fallback);

      process.stdout.write(`${id.padEnd(18)} preview=${preview.slice(0, 12)}  fallback=${fallback.slice(0, 12)}\n`);
      assert.notEqual(
        preview,
        fallback,
        `${id}: THE PREVIEW IS THE FALLBACK. Same text, same box, and the face made no difference — so ` +
          `this row is not showing ${family}. This is the empty-warpFontCatalog incident, in the surface ` +
          `built to replace it.`
      );
    }

    // One loaded font standing in for every row would pass the arm above for all but one of them.
    const distinctPreviews = new Set(previews.values());
    assert.equal(
      distinctPreviews.size,
      previews.size,
      `two catalogue rows rendered IDENTICALLY (${previews.size} rows, ${distinctPreviews.size} distinct pictures). ` +
        `Either two rows point at the same file, or one face is standing in for several.`
    );

    /**
     * The control must be one baseline PER WEIGHT — not one baseline overall.
     *
     * The first draft of this asserted a single control picture and failed with 2. The assertion was
     * wrong, not the page: each control carries its row's `font-weight`, so a 400 control and a 700
     * control are legitimately different pictures (the fallback face is synthetically bolded). That
     * is exactly what makes the per-row comparison fair — subject and control differ in the FACE and
     * in nothing else, weight included. Grouping by weight keeps the real claim: within a weight, the
     * control is one unstyled baseline, so "differs from the fallback" means "the face did something".
     */
    const fallbacksByWeight = new Map<number, Set<string>>();
    for (const { family, face } of faces) {
      const set = fallbacksByWeight.get(face.weight) ?? new Set<string>();
      set.add(fallbacks.get(`${family}-${face.weight}`)!);
      fallbacksByWeight.set(face.weight, set);
    }
    for (const [weight, set] of fallbacksByWeight) {
      assert.equal(
        set.size,
        1,
        `the unresolvable-family controls at weight ${weight} are not identical (${set.size} distinct). Within ` +
          `one weight the control is supposed to be a single unstyled baseline; if it varies, the subject ` +
          `comparisons at that weight prove nothing.`
      );
    }

    /* ---- S2.6: the same proof, at index scale. ------------------------------------------------
     *
     * The arms above cover the five BUNDLED faces, which load from disk. They say nothing about the
     * other ~1900, whose bytes arrive over the network through a batched loader — and that is where
     * a font list quietly becomes a list of names in the UI font. The number of rows changes nothing
     * about the failure mode, so the shape of the proof does not change either: each family drawn
     * twice, once through its loaded face and once through a family that resolves to nothing.
     *
     * This arm REACHES THE NETWORK, which the rest of this repo's gates deliberately do not. It has
     * to: the thing under test is a loader that fetches. `FONT_PREVIEW_OFFLINE=1` skips it, and the
     * skip is loud — an operator choosing to run without a network should know which claim they gave
     * up, rather than reading a green line that no longer means what it did.
     */
    if (process.env.FONT_PREVIEW_OFFLINE === "1") {
      process.stdout.write("\nSKIPPED the scale arm (FONT_PREVIEW_OFFLINE=1) — the ~1900 remote families are UNPROVEN this run.\n");
    } else {
      const sampleSize = Number(process.env.FONT_PREVIEW_SAMPLE) || 12;
      await page.goto(`${base}/editor/__preview-fixture?catalogue=scale&count=${sampleSize}`, { waitUntil: "networkidle" });
      const probe = page.locator('[data-catalogue-probe="ready"]');
      await probe.waitFor({ state: "visible", timeout: 30_000 });
      // Every family must reach a terminal state — loaded or unavailable — before anything is read.
      // Photographing a row mid-load would compare the fallback against the fallback and pass.
      await page.waitForFunction(
        () => document.querySelector('[data-scale-settled="true"]') !== null,
        undefined,
        { timeout: 60_000 }
      );

      const total = Number(await probe.getAttribute("data-scale-total"));
      const loaded = Number(await probe.getAttribute("data-scale-ready"));
      process.stdout.write(`\nscale sample: ${loaded}/${total} families loaded a face\n`);
      assert.ok(
        loaded >= Math.ceil(total * 0.75),
        `only ${loaded} of ${total} sampled families loaded. Either the loader is broken or this machine has no ` +
          `network — and the two are indistinguishable from here, which is exactly why they must not be papered ` +
          `over. Re-run with FONT_PREVIEW_OFFLINE=1 to skip this arm deliberately.`
      );

      const scalePreviews = new Map<string, string>();
      for (const family of await page.locator("[data-testid^='scale-preview-']").evaluateAll((nodes) =>
        nodes.filter((node) => node.getAttribute("data-preview-ready") === "true").map((node) => node.getAttribute("data-testid")!.slice("scale-preview-".length))
      )) {
        const safe = family.replace(/[^A-Za-z0-9]/g, "_");
        const preview = await shotHash(page, `scale-preview-${family}`, `scale-${safe}`);
        const fallback = await shotHash(page, `scale-fallback-${family}`, `scale-${safe}-fallback`);
        process.stdout.write(`${family.padEnd(24)} preview=${preview.slice(0, 12)}  fallback=${fallback.slice(0, 12)}\n`);
        assert.notEqual(
          preview,
          fallback,
          `${family}: THE PREVIEW IS THE FALLBACK. The row reports its face as loaded and the face made no ` +
            `difference — which is the empty-warpFontCatalog incident, in the surface built to replace it, at scale.`
        );
        scalePreviews.set(family, preview);
      }

      // One loaded font standing in for every row would pass the arm above for all but one of them —
      // the empty-catalogue failure with more rows, which is precisely what the plan warns about.
      const distinctScale = new Set(scalePreviews.values());
      assert.equal(
        distinctScale.size,
        scalePreviews.size,
        `${scalePreviews.size} sampled families rendered as only ${distinctScale.size} distinct pictures. ` +
          `One face is standing in for several rows.`
      );
      process.stdout.write(`scale arm PASS — ${scalePreviews.size} remote families, each in its own face, each distinct.\n`);
    }

    process.stdout.write(`\nPASS — ${faces.length} catalogue previews, each in its own face, each distinct, all vs one fallback baseline.\n`);
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
