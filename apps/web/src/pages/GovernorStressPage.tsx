/**
 * GPU preview-contention stress fixture (`governor:stress`) — the gate todo.md/GAPS.md require before
 * the context governor's default flips ON.
 *
 * Recreates the REAL historical failure shape (todo.md "Current signal"): playback mounts per-clip
 * `MediaWebGLRenderer`s in WAVES (clips entering the active window), earlier waves go idle without
 * being torn down (stale producers / `_copy_` chains / slow unmounts), then a backward seek revisits
 * an early range. Without the governor the live-context count climbs monotonically toward the
 * browser's ~16 cap; with it, `requestContextSlot` (inside the real `MediaWebGLRenderer` constructor)
 * must LRU-evict idle contexts via their registered disposers — exactly the `WebglMediaLayer`
 * contract — and revisited slots must lazily RECREATE and draw.
 *
 * A real `ScenePreviewCanvas` (root `SceneCompositor`, never evictable) composites the current wave
 * throughout; the gate asserts it survives enforcement (no `onFailure`, no lost-context errors).
 *
 * Scenarios (worker script `apps/worker/src/governor-stress.ts` drives both):
 *   - `?glGovernor=1` (enforced): peak ≤ ceiling, evictions happened, recreation clean, preview alive.
 *   - `?glGovernor=0` (control): peak EXCEEDS the hard cap — proves the fixture genuinely contends,
 *     so the enforced result is meaningful and the gate can't rot into a tautology.
 *
 * Needs a real WebGL2 GPU → run with `PIXEL_BROWSER_CHANNEL=chrome`.
 */

import { useEffect, useRef, useState } from "react";
import {
  MediaWebGLRenderer,
  getActiveGlContextCount,
  registerContextDisposer,
  setGlGovernorEnabled,
  type TimelineLayer,
} from "@lumio-by-aelivion/shared";
import { ScenePreviewCanvas } from "../components/ScenePreviewCanvas";

const WAVES = 4;
const RENDERERS_PER_WAVE = 3;
// Draw each wave a bit longer than EVICT_IDLE_MS (200ms) so the PREVIOUS wave is reliably idle when
// the next wave's constructors call requestContextSlot.
const WAVE_DRAW_MS = 450;

function boolParam(name: string): boolean {
  if (typeof window === "undefined") return false;
  const raw = new URLSearchParams(window.location.search).get(name);
  return raw === "1" || raw === "true";
}

/** A slot mirrors one clip's WebglMediaLayer: a renderer that the governor may reclaim (disposer) and
 *  that the owner lazily recreates when the clip is revisited. */
interface ClipSlot {
  id: string;
  renderer: MediaWebGLRenderer | null;
  evicted: boolean;
}

function makeSource(seed: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = `hsl(${(seed * 47) % 360} 70% 50%)`;
  ctx.fillRect(0, 0, 256, 256);
  ctx.fillStyle = "#fff";
  ctx.fillRect(32 + (seed % 4) * 24, 64, 48, 128);
  return canvas;
}

export function GovernorStressPage() {
  const gradedRef = useRef<Record<string, HTMLCanvasElement | null>>({});
  const previewFailedRef = useRef(false);
  const [previewLayers, setPreviewLayers] = useState<TimelineLayer[]>([]);
  const [state, setState] = useState<"running" | "ready" | "error">("running");
  const [message, setMessage] = useState("");
  const [metrics, setMetrics] = useState({ peak: 0, evictions: 0, recreateFailures: 0, previewFailed: false, final: 0 });
  const governorOn = boolParam("glGovernor");

  useEffect(() => {
    let cancelled = false;
    const slots: ClipSlot[] = [];
    let evictions = 0;

    // This page doesn't mount VideoPreview (which applies the flag at module scope), so apply it here.
    setGlGovernorEnabled(governorOn);

    /** WebglMediaLayer's contract: create → register a disposer the governor may call → draw = touch. */
    function createRendererForSlot(slot: ClipSlot, source: HTMLCanvasElement): MediaWebGLRenderer {
      const renderer = new MediaWebGLRenderer(document.createElement("canvas"), { kind: "media-renderer", label: `governor-stress:${slot.id}` });
      const gl = renderer.governorContext;
      if (gl) {
        registerContextDisposer(gl, () => {
          evictions += 1;
          slot.evicted = true;
          if (slot.renderer === renderer) slot.renderer = null;
          try {
            renderer.dispose();
          } catch {
            /* ignore */
          }
        });
      }
      renderer.draw({ source, sourceWidth: source.width, sourceHeight: source.height, pipeline: null });
      return renderer;
    }

    async function run() {
      // The real preview compositor stays mounted throughout — its ROOT context must survive enforcement.
      const layers: TimelineLayer[] = Array.from({ length: RENDERERS_PER_WAVE }, (_, i) => ({
        id: `stress_layer_${i}`,
        trackId: "video_track",
        type: "image",
        name: `Stress ${i}`,
        startSeconds: 0,
        durationSeconds: 9999,
        assetId: "stress_asset",
        fit: "cover",
        transform: { position: { x: 25 + i * 25, y: 50 }, scale: 0.55, rotation: 0, opacity: 100 },
        effects: [],
        keyframes: [],
      }));
      setPreviewLayers(layers);
      await new Promise((r) => setTimeout(r, 300)); // let the scene compositor mount + composite

      let peak = getActiveGlContextCount();
      const sampler = window.setInterval(() => {
        peak = Math.max(peak, getActiveGlContextCount());
      }, 25);

      try {
        // ── Forward playback: waves of clips enter the active window and keep drawing; earlier waves
        // idle WITHOUT unmounting (the historical leak shape).
        for (let wave = 0; wave < WAVES; wave += 1) {
          if (cancelled) return;
          const waveSlots: { slot: ClipSlot; source: HTMLCanvasElement }[] = [];
          for (let i = 0; i < RENDERERS_PER_WAVE; i += 1) {
            const slot: ClipSlot = { id: `w${wave}_c${i}`, renderer: null, evicted: false };
            const source = makeSource(wave * RENDERERS_PER_WAVE + i);
            slot.renderer = createRendererForSlot(slot, source);
            slots.push(slot);
            waveSlots.push({ slot, source });
          }
          // Feed the CURRENT wave into the live scene composite (like the active clips on screen).
          waveSlots.forEach(({ slot }, i) => {
            gradedRef.current[`stress_layer_${i}`] = (slot.renderer?.canvas as HTMLCanvasElement | undefined) ?? null;
          });
          // Draw this wave every frame for WAVE_DRAW_MS (draw() touches the context — keeps it fresh).
          const until = performance.now() + WAVE_DRAW_MS;
          while (performance.now() < until) {
            await new Promise((r) => requestAnimationFrame(r));
            if (cancelled) return;
            for (const { slot, source } of waveSlots) {
              slot.renderer?.draw({ source, sourceWidth: source.width, sourceHeight: source.height, pipeline: null });
            }
            peak = Math.max(peak, getActiveGlContextCount());
          }
        }

        // ── Backward seek: the old range's draws STOP first (a real seek pauses the outgoing clips),
        // then the revisited range allocates — so the last wave is idle-evictable when recreation asks.
        await new Promise((r) => setTimeout(r, 300));
        // Revisit the FIRST wave. Its contexts were (with the governor) evicted while idle — the owner
        // must lazily recreate and draw cleanly, like WebglMediaLayer.ensureRenderer.
        let recreateFailures = 0;
        for (let i = 0; i < RENDERERS_PER_WAVE; i += 1) {
          const slot = slots[i]!;
          const source = makeSource(i);
          try {
            if (!slot.renderer) slot.renderer = createRendererForSlot(slot, source);
            slot.renderer.draw({ source, sourceWidth: source.width, sourceHeight: source.height, pipeline: null });
            const canvas = slot.renderer.canvas as HTMLCanvasElement;
            if (!canvas || canvas.width === 0) recreateFailures += 1;
          } catch {
            recreateFailures += 1;
          }
          gradedRef.current[`stress_layer_${i}`] = (slot.renderer?.canvas as HTMLCanvasElement | undefined) ?? null;
        }
        peak = Math.max(peak, getActiveGlContextCount());

        // Let the preview composite the revisited wave — a dead root context would fail here.
        await new Promise((r) => setTimeout(r, 400));
        peak = Math.max(peak, getActiveGlContextCount());

        setMetrics({ peak, evictions, recreateFailures, previewFailed: previewFailedRef.current, final: getActiveGlContextCount() });
        if (!cancelled) setState("ready");
      } finally {
        window.clearInterval(sampler);
      }
    }

    run().catch((error) => {
      if (cancelled) return;
      console.error("GovernorStressPage failed", error);
      setMessage(String(error));
      setState("error");
    });

    return () => {
      cancelled = true;
      for (const slot of slots) {
        try {
          slot.renderer?.dispose();
        } catch {
          /* ignore */
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section
      className="governor-stress-page"
      data-render-fixture={state}
      data-governor={governorOn ? "1" : "0"}
      data-peak-contexts={metrics.peak}
      data-evictions={metrics.evictions}
      data-recreate-failures={metrics.recreateFailures}
      data-preview-failed={metrics.previewFailed ? "1" : "0"}
      data-final-contexts={metrics.final}
      style={{ margin: 0, padding: 0, background: "#000", color: "#fff", fontFamily: "monospace" }}
    >
      <div style={{ position: "relative", width: 270, height: 480, overflow: "hidden" }}>
        {previewLayers.length > 0 ? (
          <ScenePreviewCanvas
            layers={previewLayers}
            width={1080}
            height={1920}
            backgroundColor="#000000"
            currentTime={0}
            isPlaying
            gradedRef={gradedRef}
            onFailure={() => {
              previewFailedRef.current = true;
            }}
          />
        ) : null}
      </div>
      <pre>
        state={state} governor={String(governorOn)} peak={metrics.peak} evictions={metrics.evictions} recreateFailures={metrics.recreateFailures}{" "}
        previewFailed={String(metrics.previewFailed)} final={metrics.final}
      </pre>
      {state === "error" ? <pre data-stress-error>{message}</pre> : null}
    </section>
  );
}
