/**
 * Phase 2 — Stage 1 parity probe (`media:shared-probe`). POSITIVE CONTROL.
 *
 * Proves the new ADDITIVE shared-context capability of `MediaWebGLRenderer` produces byte-identical output to
 * the existing own-canvas mode for the same input — so wiring it into the export (Stage 2) is a pixel-safe swap.
 *
 * It renders the SAME source + color grade + media effects + opacity two ways:
 *   (A) own-canvas mode  — `new MediaWebGLRenderer(canvas)`            → read its default framebuffer
 *   (B) shared-context   — `new MediaWebGLRenderer({ sharedGl })` into → read the caller-owned RenderTarget
 * Both are read via `gl.readPixels` (same bottom-left origin), so the buffers are directly comparable with no
 * flip/alpha-method skew. They must match (~0% differing pixels).
 *
 * Additive + OFF by default: a hidden diagnostic route; it does not change any default behavior, does not touch
 * the editor preview, FrameCompositor, or buildSceneDraws. Needs real WebGL2 → `PIXEL_BROWSER_CHANNEL=chrome`.
 */

import { useEffect, useState } from "react";
import {
  MediaWebGLRenderer,
  RenderTarget,
  createGl,
  getCompositionColorPipeline,
  type MediaEffects,
  type MediaRendererDrawParams,
  type TimelineLayer,
} from "@lumio-by-aelivion/shared";

const W = 256;
const H = 256;

/** A deterministic, high-contrast source pattern (bright highlights + color blocks) to grade. */
function makeSource(): OffscreenCanvas {
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("probe: source 2D context unavailable");
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, "#1a2b6b");
  g.addColorStop(0.5, "#e08a3c");
  g.addColorStop(1, "#0b0b0b");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#fffbe8";
  ctx.beginPath();
  ctx.arc(W * 0.42, H * 0.38, W * 0.18, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#2ec26a";
  ctx.fillRect(W * 0.1, H * 0.62, W * 0.35, H * 0.25);
  ctx.fillStyle = "#c0334d";
  ctx.fillRect(W * 0.55, H * 0.6, W * 0.32, H * 0.3);
  return c;
}

/** A representative non-identity grade (brightness/contrast/sat/temp/tint) via the shared pipeline builder. */
function makePipeline() {
  const layer = {
    id: "probe_layer",
    trackId: "t",
    type: "video",
    name: "probe",
    startSeconds: 0,
    durationSeconds: 1,
    assetId: "a",
    fit: "cover",
    transform: { position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 100 },
    effects: [
      {
        id: "grade",
        type: "brightnessContrast",
        name: "Grade",
        enabled: true,
        intensity: 100,
        params: { exposure: 10, contrast: 28, saturation: 120, temperature: -18, tint: 10 },
      },
    ],
    keyframes: [],
  } as unknown as TimelineLayer;
  return getCompositionColorPipeline(layer, { currentTimeSeconds: 0 });
}

export function MediaSharedContextProbePage() {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState("");
  const [diffPct, setDiffPct] = useState(0);
  const [maxChannelDiff, setMaxChannelDiff] = useState(0);

  useEffect(() => {
    try {
      const source = makeSource();
      const pipeline = makePipeline();
      const effects: MediaEffects = { vignette: { amount: 0.6, size: 0.5 }, timeSeconds: 0 } as MediaEffects;
      const drawBase: Omit<MediaRendererDrawParams, "target"> = {
        source,
        sourceWidth: W,
        sourceHeight: H,
        pipeline,
        opacity: 0.85,
        mediaEffects: effects,
      };

      // (A) own-canvas mode.
      const ownRenderer = new MediaWebGLRenderer(document.createElement("canvas"));
      ownRenderer.setPipeline(pipeline);
      ownRenderer.draw(drawBase);
      const ownBuf = new Uint8Array(W * H * 4);
      ownRenderer.readPixelsInto(ownBuf, W, H);

      // (B) shared-context mode → caller-owned RenderTarget on a separate (shared) context.
      const sharedGl = createGl(document.createElement("canvas"));
      const target = new RenderTarget(sharedGl, W, H);
      const sharedRenderer = new MediaWebGLRenderer({ sharedGl });
      sharedRenderer.setPipeline(pipeline);
      sharedRenderer.draw({ ...drawBase, target });
      const sharedBuf = new Uint8Array(W * H * 4);
      sharedRenderer.readPixelsInto(sharedBuf, W, H, target);

      // Compare (both bottom-left origin via readPixels → no flip needed).
      let differing = 0;
      let maxDiff = 0;
      for (let i = 0; i < ownBuf.length; i += 1) {
        const d = Math.abs(ownBuf[i]! - sharedBuf[i]!);
        if (d > maxDiff) maxDiff = d;
        if (i % 4 !== 3 && d > 2) differing += 1; // count RGB-channel mismatches > 2 (skip alpha)
      }
      const pct = (differing / (W * H * 3)) * 100;

      ownRenderer.dispose();
      sharedRenderer.dispose();
      target.dispose();
      // sharedGl context: lose it explicitly (createGl counted it); its canvas is detached/offscreen.
      sharedGl.getExtension("WEBGL_lose_context")?.loseContext();

      setDiffPct(Number(pct.toFixed(4)));
      setMaxChannelDiff(maxDiff);
      console.log(`[media-probe] shared-context vs own-canvas: maxChannelDiff=${maxDiff} differingRGB%=${pct.toFixed(4)}`);
      setState("ready");
    } catch (error) {
      console.error("MediaSharedContextProbePage failed", error);
      setMessage(String(error));
      setState("error");
    }
  }, []);

  return (
    <section
      className="media-shared-context-probe-page"
      data-probe-state={state}
      data-diff-pct={diffPct}
      data-max-channel-diff={maxChannelDiff}
      style={{ margin: 0, padding: 16, background: "#000", color: "#fff", fontFamily: "monospace" }}
    >
      <pre>state={state} diffPct={diffPct}% maxChannelDiff={maxChannelDiff}</pre>
      {state === "error" ? <pre data-probe-error>{message}</pre> : null}
    </section>
  );
}
