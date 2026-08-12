/**
 * DEBT-019 — what did the sample index ACTUALLY cost, per shape?
 *
 * The columns commit replaced `SampleIndexEntry[]` (one JS object per sample) with five typed-array
 * columns. The saving cannot be read off the residency ladder, because the ladder measures the whole
 * chrome.exe working set and the index turned out to be well under 1% of it — a difference smaller
 * than the ladder's own rung-to-rung noise. Measuring a term inside an instrument that cannot resolve
 * it is how the term got mis-attributed in the first place, so it is measured here directly instead.
 *
 * Both shapes are constructed with the EXACT field set the decoder used, allocated the same way
 * (`.map` over a synthetic sample list for rows; `allocSampleIndex`'s widths for columns), retained
 * behind a global so nothing is collected mid-measurement, and read through `performance.memory`
 * after a forced GC (`--js-flags=--expose-gc`) so the delta is retained heap and not garbage.
 *
 * This says nothing about whether the index was worth fixing at the product level — the ladder
 * answers that, and its answer is "not much". It exists so the claim about the shape is a number.
 */
import { chromium } from "playwright";
import { assertZeroBrowserFloor } from "../src/browser/browser-preflight.js";

const SAMPLE_COUNTS = (process.env.DEBT019_SHAPE_N ?? "3600,90000,360000").split(",").map(Number);

const page_probe = `async (counts) => {
  const out = [];
  const gc = () => { if (window.gc) { window.gc(); window.gc(); } };
  const heap = () => performance.memory.usedJSHeapSize;
  for (const n of counts) {
    // ROWS — the shape that shipped until now.
    window.__hold = null; gc();
    await new Promise((r) => setTimeout(r, 300));
    const rowBase = heap();
    const rows = new Array(n);
    for (let i = 0; i < n; i += 1) {
      rows[i] = { offset: i * 21000, size: 21000, timestamp: i * 33333, duration: 33333, isKey: i % 12 === 0 };
    }
    window.__hold = rows;
    gc();
    await new Promise((r) => setTimeout(r, 300));
    const rowHeld = heap();

    // COLUMNS — the shape that ships now, same widths as allocSampleIndex.
    window.__hold = null; gc();
    await new Promise((r) => setTimeout(r, 300));
    const colBase = heap();
    const cols = {
      offset: new Float64Array(n), size: new Uint32Array(n),
      timestamp: new Float64Array(n), duration: new Uint32Array(n), isKey: new Uint8Array(n),
    };
    for (let i = 0; i < n; i += 1) {
      cols.offset[i] = i * 21000; cols.size[i] = 21000;
      cols.timestamp[i] = i * 33333; cols.duration[i] = 33333; cols.isKey[i] = i % 12 === 0 ? 1 : 0;
    }
    window.__hold = cols;
    gc();
    await new Promise((r) => setTimeout(r, 300));
    const colHeld = heap();
    out.push({ n, rowBytes: rowHeld - rowBase, colBytes: colHeld - colBase });
  }
  window.__hold = null;
  return out;
}`;

async function main() {
  assertZeroBrowserFloor("debt019-index-shape");
  const browser = await chromium.launch({
    channel: process.env.PIXEL_BROWSER_CHANNEL ?? "chrome",
    args: ["--js-flags=--expose-gc"],
  });
  const page = await browser.newPage();
  await page.route("https://debt019.invalid/probe", (r) =>
    r.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>shape</title><body>" })
  );
  await page.goto("https://debt019.invalid/probe");
  const hasMemory = await page.evaluate("Boolean(performance.memory) && Boolean(window.gc)");
  if (!hasMemory) throw new Error("performance.memory / window.gc unavailable — cannot measure retained heap");
  const rows = (await page.evaluate(`(${page_probe})(${JSON.stringify(SAMPLE_COUNTS)})`)) as {
    n: number;
    rowBytes: number;
    colBytes: number;
  }[];
  console.log("\n  samples      rows(objects)      columns(typed)     bytes/sample rows -> cols     saving");
  for (const r of rows) {
    console.log(
      `  ${String(r.n).padStart(7)}   ${(r.rowBytes / 1048576).toFixed(2).padStart(8)} MB    ` +
        `${(r.colBytes / 1048576).toFixed(2).padStart(8)} MB      ` +
        `${(r.rowBytes / r.n).toFixed(1).padStart(6)} -> ${(r.colBytes / r.n).toFixed(1).padStart(5)} B/smp` +
        `      ${(r.rowBytes / Math.max(1, r.colBytes)).toFixed(1)}x`
    );
  }
  // Extrapolate from the LARGEST run only. `performance.memory` is quantised coarsely enough that a
  // few-hundred-KB allocation lands inside its own granularity — the 3600-sample rows read 37.9 B/sample
  // and a mid-size run once read NEGATIVE (a collection landing inside the baseline). Small-N rows are
  // reported for shape, never quoted; the large run reproduces to ±0.1 B/sample and its column figure
  // lands on the analytic 25.0, which is the check that it is measuring the right object at all.
  const biggest = rows.reduce((a, b) => (b.n > a.n ? b : a));
  const perSample = { rows: biggest.rowBytes / biggest.n, cols: biggest.colBytes / biggest.n };
  console.log(
    `\n  From the ${biggest.n}-sample run: rows ${perSample.rows.toFixed(1)} B/sample, columns ${perSample.cols.toFixed(1)} B/sample` +
      `\n  Per 2-minute 30fps source (3600 samples): rows ${((perSample.rows * 3600) / 1024).toFixed(0)} KB` +
      ` -> columns ${((perSample.cols * 3600) / 1024).toFixed(0)} KB`
  );
  await browser.close();
}

void main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);
