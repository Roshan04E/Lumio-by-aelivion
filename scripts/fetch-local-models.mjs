// Downloads the self-hosted browser-ML model weights into apps/web/public/models/,
// where the web app serves them SAME-ORIGIN (no CORS) and lazy-fetches them on tool
// interaction. These files are gitignored (see .gitignore) to keep the repo lean.
//
// Why self-host: HuggingFace moved some weights (e.g. SlimSAM) onto its "Xet" CDN
// host (us.aws.cdn.hf.co), which is TLS-blocked on some networks, and the HF mirror
// is CORS-blocked. Serving the weights from our own origin makes model loading work
// regardless of which third-party CDN a user's network blocks.
//
// Usage:  node scripts/fetch-local-models.mjs   (Node 18+; needs network access to HF)
// Run this on a machine that CAN reach huggingface.co. On a blocked network, copy the
// already-populated apps/web/public/models/ directory over from another machine.

import { mkdir, writeFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "apps", "web", "public", "models");

/** Each model: HF repo id + the exact files to mirror (must match what local-sam.ts requests). */
const MODELS = [
  {
    id: "Xenova/slimsam-77-uniform", // promptable SAM for AI roto (q8 / WASM)
    files: [
      "config.json",
      "preprocessor_config.json",
      "onnx/vision_encoder_quantized.onnx",
      "onnx/prompt_encoder_mask_decoder_quantized.onnx"
    ]
  }
];

async function fetchToFile(url, dest) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, buf);
  return buf.length;
}

for (const model of MODELS) {
  for (const file of model.files) {
    const url = `https://huggingface.co/${model.id}/resolve/main/${file}`;
    const dest = join(OUT_DIR, model.id, file);
    try {
      const existing = await stat(dest).then((s) => s.size).catch(() => 0);
      const size = await fetchToFile(url, dest);
      console.log(`${existing ? "↻" : "✓"} ${model.id}/${file}  (${(size / 1e6).toFixed(2)} MB)`);
    } catch (error) {
      console.error(`✗ ${model.id}/${file}: ${error instanceof Error ? error.message : error}`);
      process.exitCode = 1;
    }
  }
}
