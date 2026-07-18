/**
 * Reproduces the reported local-export failure: an AUDIO clip longer than the (image) visual content.
 *
 * Drives the real dev app in Chromium, dynamically imports the export pipeline, builds a composition
 * with a 2s image + an 8s audio layer (comp duration 8s), and runs `exportLocally`. Detects the three
 * outcomes: completes (blob bytes), throws (clean error message — the real cause), or HANGS (the bug).
 *
 * Run: pnpm --filter @orreris/worker exec tsx src/export-audio-probe.ts   (dev server must be up)
 */
import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE ?? "http://localhost:5173";

// 1×1 red PNG (valid for createImageBitmap).
const pngUrl =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** Build an ~8s stereo 48kHz sine WAV as a data URL (so decodeAudioData can fetch it). */
function makeWavDataUrl(secs: number): string {
  const sr = 48000;
  const n = sr * secs;
  const blockAlign = 4; // 2ch * 16-bit
  const dataLen = n * blockAlign;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + dataLen, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * blockAlign, 28); buf.writeUInt16LE(blockAlign, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(dataLen, 40);
  let off = 44;
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 220 * i) / sr) * 12000);
    buf.writeInt16LE(v, off); buf.writeInt16LE(v, off + 2); off += 4;
  }
  return `data:audio/wav;base64,${buf.toString("base64")}`;
}

// Matches the reported case: a short VIDEO clip (2–6s) with audio spanning the whole 12s comp
// (360 frames @30fps), so most of the timeline is the empty/audio-only tail after the video ends.
const composition = {
  id: "probe_comp", name: "probe", width: 1280, height: 720, fps: 30,
  durationSeconds: 12, backgroundColor: "#000000",
  tracks: [
    { id: "v", type: "video", name: "Video", layers: [
      { id: "vid", trackId: "v", type: "video", name: "vid", startSeconds: 2, durationSeconds: 4,
        assetId: "vidAsset", fit: "cover", sourceInSeconds: 0,
        transform: { position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 100 },
        effects: [], keyframes: [] },
    ]},
    { id: "a", type: "audio", name: "Audio", layers: [
      { id: "aud", trackId: "a", type: "audio", name: "aud", startSeconds: 0, durationSeconds: 12,
        assetId: "audAsset", volume: 100, effects: [], keyframes: [] },
    ]},
  ],
};

async function main() {
  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  const browser = await chromium.launch(channel ? { channel } : {});
  const page = await browser.newPage();
  // tsx/esbuild `keepNames` wraps arrows passed to page.evaluate in a `__name(...)` helper the browser
  // lacks → "__name is not defined". Shim it as identity (string init script bypasses esbuild).
  await page.addInitScript("window.__name = window.__name || function (f) { return f; };");
  page.on("console", (m) => { if (m.type() === "error" || m.text().includes("export")) process.stdout.write(`[page:${m.type()}] ${m.text()}\n`); });
  page.on("pageerror", (e) => process.stdout.write(`[pageerror] ${String(e)}\n`));
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  const args = { composition, pngUrl, wavUrl: makeWavDataUrl(8) };
  const result = await page.evaluate(async (a) => {
    // Generate a real 4s MP4 video (120 frames) in-page via the app's own encoder, then feed it back
    // as the export's video source — so we exercise the WebCodecs decoder path, not an image.
    // Non-literal specifiers so TS (worker package) doesn't try to resolve these browser-runtime URLs.
    const vePath = "/src/export/video-encoder.ts";
    const encMod = await import(/* @vite-ignore */ vePath);
    const enc = new encMod.MediaEncoder({ width: 1280, height: 720, fps: 30, format: "mp4" });
    const vc = new OffscreenCanvas(1280, 720);
    const vctx = vc.getContext("2d")!;
    for (let i = 0; i < 120; i++) {
      vctx.fillStyle = `hsl(${(i * 3) % 360}, 70%, 50%)`;
      vctx.fillRect(0, 0, 1280, 720);
      await enc.addVideoFrame(vc, i);
    }
    const videoUrl = URL.createObjectURL(await enc.finalize());
    const urls: Record<string, string | undefined> = { vidAsset: videoUrl, audAsset: a.wavUrl };
    const lePath = "/src/export/local-export.ts";
    const mod = await import(/* @vite-ignore */ lePath);
    let lastProgress = 0;
    const exportPromise = mod
      .exportLocally({
        composition: a.composition,
        urlForAsset: (id: string) => urls[id],
        format: "mp4",
        fps: 30,
        onProgress: (f: number) => { lastProgress = f; },
      })
      .then((blob: Blob) => ({ kind: "done", bytes: blob.size, lastProgress }))
      .catch((e: unknown) => ({ kind: "threw", message: e instanceof Error ? e.message : String(e), lastProgress }));
    const timeout = new Promise((res) => setTimeout(() => res({ kind: "HANG", lastProgress }), 75000));
    return Promise.race([exportPromise, timeout]) as Promise<{ kind: string; bytes?: number; message?: string; lastProgress: number }>;
  }, args);

  console.log(`\n[export probe] outcome=${result.kind}  lastProgress=${Number(result.lastProgress).toFixed(2)}`);
  if (result.kind === "done") console.log(`  exported ${result.bytes} bytes (no hang) ✅`);
  if (result.kind === "threw") console.log(`  clean error (no hang) ⚠️: ${result.message}`);
  if (result.kind === "HANG") console.log(`  HUNG ❌ — froze at progress ${Number(result.lastProgress).toFixed(2)}`);
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
