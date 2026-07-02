/**
 * Export GPU-sync guard (structural regression test).
 *
 * WebGL draws are asynchronous. In a one-shot export the encoder snapshots the compositor canvas with
 * `new VideoFrame(canvas)` immediately after rendering — without a GPU sync it can capture an UNFINISHED
 * (black) frame. That was the "first-frame-only / last-clip-black" export bug. The fix: the export
 * compositor calls `gl.finish()` (via `SceneCompositor.finish()`) every frame BEFORE the encoder captures.
 *
 * A pixel/luma gate can't protect this: any luma readback itself forces the GPU sync, so it would pass even
 * with the sync removed (that's exactly why our stage-probe masked the bug). So this asserts the INVARIANT
 * structurally — the sync call is present and ordered correctly in the export path — which is cheap, runs
 * with no WebGL, and fails loudly if someone removes or reorders it.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webSrc = resolve(dirname(fileURLToPath(import.meta.url)), "../../web/src");
const sharedSrc = resolve(dirname(fileURLToPath(import.meta.url)), "../../../packages/shared/src");

const failures: string[] = [];

function check(label: string, ok: boolean, detail: string): void {
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(`${label} — ${detail}`);
    console.log(`  ✗ ${label} — ${detail}`);
  }
}

// 1. SceneCompositor.finish() is a full capture barrier: a command-completion sync (gl.finish) AND a
//    materialization readback (readPixels) — the latter is what actually makes VideoFrame(canvas) reliable on
//    drivers where finish() alone still captures an unfinished (black) buffer.
{
  const src = readFileSync(resolve(sharedSrc, "color/scene-compositor.ts"), "utf8");
  const finishBody = src.match(/\n\s{2}finish\s*\([^)]*\)\s*:\s*void\s*\{([\s\S]*?)\n\s{2}\}/);
  const body = finishBody?.[1] ?? "";
  check(
    "SceneCompositor.finish() calls gl.finish()",
    /\.finish\(\)/.test(body),
    "no gl.finish() command-completion barrier found in finish()"
  );
  check(
    "SceneCompositor.finish() does a readPixels materialization barrier",
    /\.readPixels\(/.test(body),
    "no readPixels() materialization barrier in finish() — VideoFrame(canvas) can capture an unfinished buffer"
  );
}

// 2. The export compositor syncs the GPU AFTER rendering the frame (so the caller's capture is complete).
{
  const src = readFileSync(resolve(webSrc, "export/scene-frame-compositor.ts"), "utf8");
  const renderIdx = src.indexOf("this.compositor.renderFrame(spec)");
  const finishIdx = src.indexOf("this.compositor.finish()");
  check(
    "SceneFrameCompositor.renderFrame() calls compositor.finish() after renderFrame(spec)",
    renderIdx >= 0 && finishIdx > renderIdx,
    `renderFrame(spec) idx=${renderIdx}, finish() idx=${finishIdx} (finish must come after render)`
  );
}

// 3. The export loop renders a frame BEFORE it hands the canvas to the encoder (capture order).
{
  const src = readFileSync(resolve(webSrc, "export/export-core.ts"), "utf8");
  const renderIdx = src.indexOf("compositor.renderFrame(t)");
  const encodeIdx = src.indexOf("encoder.addVideoFrame(activeCanvas");
  check(
    "export-core loop calls compositor.renderFrame(t) before encoder.addVideoFrame(activeCanvas, …)",
    renderIdx >= 0 && encodeIdx > renderIdx,
    `renderFrame(t) idx=${renderIdx}, addVideoFrame idx=${encodeIdx} (render must come first)`
  );
}

console.log("");
if (failures.length) {
  console.error(`Export GPU-sync guard FAILED (${failures.length}):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("Export GPU-sync guard passed — encoder captures a GPU-synced frame.");
