/**
 * Headless smoke test for the playback-clock decoupling (Phase C).
 *
 * Drives the real dev editor, presses Play, and samples the transport time readout + the timeline
 * playhead position over ~2.5s. Asserts the clock advances smoothly (monotonic, ~real-time) and the
 * console stays clean — i.e. moving the high-frequency tick into the external store didn't break the
 * preview/transport wiring.
 *
 * Run: pnpm --filter @orreris/worker exec tsx src/playback-probe.ts   (dev server must be up)
 */
import { chromium } from "playwright";
import { reachEditor, EDITOR_BASE as BASE } from "./browser/editor-session";

async function main() {
  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  const browser = await chromium.launch(channel ? { channel } : {});
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await reachEditor(page);

  // The transport readout: the <span>…s</span> in .viewer-controls (PlayheadTimeReadout).
  const readout = () =>
    page.evaluate(() => {
      const spans = Array.from(document.querySelectorAll(".viewer-controls span"));
      const tag = spans.find((s) => /[0-9]+\.[0-9]+s/.test(s.textContent ?? ""));
      const ph = document.querySelector(".editor-timeline-dock .timeline-playhead") as HTMLElement | null;
      return {
        t: tag ? Number.parseFloat((tag.textContent ?? "").replace(/[^0-9.]/g, "")) : Number.NaN,
        playheadPct: ph ? getComputedStyle(ph).getPropertyValue("--playhead-percent") : "",
      };
    });

  const play = page.getByRole("button", { name: /play/i }).first();
  const found = await play.count().catch(() => 0);
  console.log(`url=${page.url()}  playButtonFound=${Boolean(found)}`);
  await play.click().catch(() => undefined);

  const samples: { t: number; pct: string }[] = [];
  for (let i = 0; i < 25; i++) {
    const r = await readout();
    samples.push({ t: r.t, pct: r.playheadPct.trim() });
    await page.waitForTimeout(100);
  }
  // Pause.
  await page.getByRole("button", { name: /pause/i }).first().click().catch(() => undefined);

  const times = samples.map((s) => s.t).filter(Number.isFinite);
  const advanced = times.length >= 2 ? times[times.length - 1]! - times[0]! : 0;
  let monotonic = true;
  for (let i = 1; i < times.length; i++) if (times[i]! < times[i - 1]! - 0.001) monotonic = false;
  const distinct = new Set(times.map((t) => t.toFixed(2))).size;

  console.log(`samples t: ${times.map((t) => t.toFixed(2)).join(" ")}`);
  console.log(`[playback] advanced=${advanced.toFixed(2)}s over ~2.5s  monotonic=${monotonic}  distinctValues=${distinct}`);
  console.log(
    `[playback] ${advanced > 0.8 && monotonic && distinct >= 6 ? "ADVANCES SMOOTHLY ✅" : "PROBLEM ❌"}  | console errors: ${errors.length}`
  );
  if (errors.length) console.log(errors.slice(0, 5).map((e) => `  [err] ${e}`).join("\n"));

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
