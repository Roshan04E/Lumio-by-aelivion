import { readFileSync } from "node:fs";
import path from "node:path";
import type { RenderManifest } from "@kimera-by-aelivion/render-templates";
import { renderManifestToMp4, renderManifestStill } from "./remotion-renderer";

async function main() {
  const manifestPath = process.argv[2];
  if (!manifestPath) {
    throw new Error("Usage: tsx render-manifest-cli.ts <manifest.json>");
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as RenderManifest;
  const outDir = path.resolve(process.cwd(), "../../tmp");

  // The text layer starts at 1.9s (frame ~57). Render a still a few frames in —
  // if the old entrance spring were still there, the text would be mid-zoom (small).
  const stillFrame = 66;
  const stillOut = path.join(outDir, "render-still-text-entrance.png");
  console.log(`[still] rendering frame ${stillFrame} -> ${stillOut}`);
  await renderManifestStill({ manifest, frame: stillFrame, outputLocation: stillOut });
  console.log("[still] done");

  const mp4Out = path.join(outDir, "render-output.mp4");
  console.log(`[mp4] rendering -> ${mp4Out}`);
  await renderManifestToMp4({
    manifest,
    outputLocation: mp4Out,
    onProgress: (progress) => {
      if (Math.round(progress * 100) % 20 === 0) {
        process.stdout.write(` ${Math.round(progress * 100)}%`);
      }
    }
  });
  console.log("\n[mp4] done");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
