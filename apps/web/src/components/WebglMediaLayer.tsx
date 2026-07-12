import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
} from "react";
import { MediaWebGLRenderer, registerContextDisposer, type ColorPipeline, type MatteRef, type MediaEffects, type MediaTransition } from "@lumio-by-aelivion/shared";
import { acquireVideo } from "../lib/video-element-pool";
import { markHotSpot } from "../lib/perfDiagnostics";
import { STILL_PROXY_EDGES, getStillProxyBlob } from "../editor/performance/stillProxyStore";
import { acquirePreviewFrameProvider } from "../playback/preview-frame-pool";
import { getLivePlaybackTime } from "../playback/playback-clock";
import type { FrameProvider } from "../export/source-decoder";
import type { SceneMediaSink, ScenePreviewMediaFrame, ScenePreviewMediaSource } from "./scene-media-source";

/**
 * Unified WebGL media layer for the editor preview (flag-gated, rendererMode=webgl).
 *
 * Replaces three legacy components in a single pass:
 *   - `WebglColorView` (image color grading)
 *   - `WebglVideoOverlay` (video color grading)
 *   - `MaskedVideoLayer` (canvas-2D matte compositing, no color)
 *
 * One `MediaWebGLRenderer` does: color grading (3D LUT) + matte compositing (luma
 * texture) + layer opacity — all in a single WebGL fragment shader pass. No
 * double-grading: the hidden source element has `skipColorFilter:true` in its style
 * so only the canvas output carries the grade.
 *
 * Object-fit, CSS transforms, and warp text overlay remain CSS/DOM (unchanged).
 * The visible `<canvas>` receives the same style as the source element would have,
 * so layout (position, transform, objectFit) is CSS-identical to the legacy path.
 *
 * Fallback: if WebGL context creation fails, `failedRef` flips to true and the caller
 * (VideoPreview.tsx) falls back to the legacy SVG-filter path. No silent failure.
 */

type VideoFrameCapableElement = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

// Catch-up policy for the WebCodecs frame source (see requestWcFrame): served frames lagging the
// transport by more than WC_HOLD_LAG_S hold the canvas (don't present the sweep) for up to
// WC_HOLD_MAX_MS per streak, then degrade to presenting the progressively advancing stale frames.
const WC_HOLD_LAG_S = 0.35;
const WC_HOLD_MAX_MS = 5000;
// DIVERGENCE bail-out: a provider still this far behind after this much continuous streak time is
// not catching up — decode is starved or wedged (2026-07-04 soak capture: 24s behind with ZERO
// frame advancement for 23s). The stage-1 <video> element path plays realtime trivially, so fall
// back to it instead of panning forever. A genuinely converging catch-up (rewind on a
// sparse-keyframe source) sees its lag SHRINK and never trips this.
const WC_DIVERGE_LAG_S = 3;
const WC_DIVERGE_MAX_MS = 10_000;
// PAUSED variant, much stricter: paused the target is FIXED, so any healthy decode closes the gap
// almost immediately — a provider still >0.5s off after 3s of streak is wedged, and the user is
// LOOKING at a wrong frame (2026-07-04 screenshots: pause showed the dome clip seconds stale while
// lag sat at 1.4–2.3s, under the playing threshold). Element fallback seeks natively and exactly.
const WC_PAUSED_STALE_LAG_S = 0.5;
const WC_PAUSED_STALE_MAX_MS = 3000;
// Self-heal net for the states the lag-based bails can NOT see (2026-07-04, "cyclist clip
// invisible while paused"): a `lease.ready` that never settles (wedged init / starved pool) left
// the layer with NO source, and a getFrame promise that never resolves left `wcBusy` stuck forever
// — no lag updates, no null counts, no bail, total silence. Both now converge to the element path.
const WC_INIT_TIMEOUT_MS = 4000;
const WC_BUSY_WEDGE_MS = 3000;
// LIVE-CLOCK SAMPLING (2026-07-06, tracker playback-preview v5→v6): the committed playback clock
// (this layer's `currentTime` prop) only advances every 16/40/90ms by quality tier, so sampling it
// in requestWcFrame capped ingest-proxy motion at ~25/11fps — "massive dropped frames" while the
// HUD showed 65–72fps (the compositor redraws the stale texture at full rate). While playing,
// requests read `getLivePlaybackTime()` (anchor-derived, sub-commit precision) instead — but ONLY
// when it agrees with the committed prop within this bound: other VideoPreview mounts (tool pages,
// fixtures) run their own transport, and the editor's module-global clock would be a foreign
// playhead there. One commit interval (90ms) + a couple of frames of grace.
const WC_LIVE_CLOCK_MAX_DIVERGENCE_S = 0.35;

// ── LIVE RE-PRIME BUS (2026-07-06) ──────────────────────────────────────────
// ProxyPlaybackLayer coverage-exit events fan out here: while the proxy overlay covers the picture,
// the live layers underneath decode unobserved and can silently wedge — the freeze only becomes
// visible at the reveal. Firing this makes every mounted video layer heal/re-seek NOW instead of
// waiting for the 500ms watchdog tick (the visible freeze window).
const liveReprimeListeners = new Set<() => void>();
export function requestLiveReprime(): void {
  for (const listener of Array.from(liveReprimeListeners)) listener();
}

/** Count + optionally log WC→element self-heals so soaks show which escape hatch fired. */
function recordWcHeal(kind: "initTimeout" | "noSource" | "busyWedge" | "divergence" | "pausedStall" | "nullFrames") {
  if (typeof window === "undefined") return;
  const w = window as unknown as { __rfWcHeals?: Record<string, number> };
  const stats = (w.__rfWcHeals ??= {});
  stats[kind] = (stats[kind] ?? 0) + 1;
  try {
    if (localStorage.getItem("lumio.perfLog") === "1") {
      console.warn(`[perf] wc self-heal: ${kind} → element fallback`);
    }
  } catch {
    /* storage unavailable — counter still recorded */
  }
}

interface BaseProps {
  pipeline: ColorPipeline | null;
  /** Pro stylize effects (vignette/grain/chroma) applied in the same shader pass. */
  mediaEffects?: MediaEffects | null;
  amount?: number;
  /** Full style from getCompositionMediaStyle(..., { skipColorFilter: true }). */
  style: CSSProperties;
  className?: string | undefined;
  dragHandlers?: HTMLAttributes<HTMLCanvasElement> | undefined;
  onWebglFailed?: (() => void) | undefined;
  /** First-frame still shown over the canvas until the first real frame paints (no black gap). */
  poster?: string | undefined;
  /** GPU wipe/iris reveal for an incoming transition clip (from getCompositionTransition). */
  transition?: MediaTransition | null | undefined;
  /**
   * Pre-roll/pending flag: hide the canvas via CSS visibility WITHOUT zeroing the shader opacity, so the
   * buffer keeps holding a real, full-opacity frame. Revealing it (hidden→false) is then a pure CSS flip
   * with correct pixels already present — no transparent-buffer flicker at the cut.
   */
  hidden?: boolean | undefined;
  /**
   * Scene-composited media: the GPU SceneCompositor draws this clip, so hide the DOM canvas via `opacity:0`
   * (NOT `visibility:hidden`) so it stays pointer-INTERACTIVE — click-to-select on the preview still works,
   * like text/shape. The shader keeps drawing the real frame (the scene path reads it as a texture). Ignored
   * while `hidden` (pending/pre-roll) is set — that needs visibility:hidden (no early paint, no interaction).
   */
  interactiveHidden?: boolean | undefined;
  /**
   * Called after each successful draw with the graded canvas, so a parent (the transition compositor) can
   * sample it as the `from`/`to` texture of a two-clip GPU mix. The canvas is sized to the SOURCE
   * resolution and carries the full grade (LUT + matte + opacity), straight-alpha sRGB.
   */
  onGradedFrame?: ((canvas: HTMLCanvasElement) => void) | undefined;
  /**
   * Whether to BAKE the layer opacity into the graded canvas (default true). The scene compositor sets
   * this false for the media it composites: it applies opacity LIVE at composite time (like
   * position/scale and like text/shape), so opacity is never stale on a seek/pause (a `currentTime`
   * change doesn't re-grade, but it DOES recomposite). DOM display + transition sources keep baking.
   */
  bakeOpacity?: boolean | undefined;
  /**
   * Single-context preview (Phase 5, `lumio.singleCtxPreview`): when set, this layer creates NO
   * `MediaWebGLRenderer` context/canvas of its own. It registers a raw frame-source descriptor
   * (element / held WC VideoFrame / settle frame / still bitmap + the live grade inputs) and pokes
   * `onFrame()` after each new frame; `ScenePreviewCanvas` uploads + grades it in-context. All the
   * frame-DRIVING machinery (WC provider, watchdogs, settle frame, matte lease) runs unchanged —
   * only the terminal draw is replaced by a publish. See scene-media-source.ts.
   */
  sceneMediaSink?: SceneMediaSink | undefined;
}

interface ImageProps extends BaseProps {
  mediaType: "image";
  src: string;
  matte?: MatteRef | undefined;
  /** Max of the clip's static transform/content zoom — picks the still-proxy size tier (P2):
   *  a zoomed-in clip decodes the larger tier so it stays crisp. Absent = 1. */
  stillZoomFactor?: number | undefined;
  fullResSrc?: never;
  preferNativeDecode?: never;
  currentTime?: never;
  isPlaying?: never;
  layerStartSeconds?: never;
  sourceInSeconds?: never;
  speedFactor?: never;
  onLoadedMetadata?: never;
}

interface VideoProps extends BaseProps {
  mediaType: "video";
  src: string;
  /**
   * ORIGINAL-bytes URL for the full-res SETTLE FRAME on pause (user rule 2026-07-05): when `src` is an
   * ingest proxy (½/¼/Auto quality), ~300ms after the transport parks, the paused frame is re-decoded
   * once from THIS source and shown until the transport moves again — playback/scrub stay on the proxy.
   * Omit (or pass the same value as `src`) to disable; fixed full quality already plays originals so
   * VideoPreview passes the same URL there and this no-ops.
   */
  fullResSrc?: string | undefined;
  /**
   * TRUE when `src` is ORIGINAL bytes (no ingest proxy yet, or fixed full quality): skip the pooled
   * WebCodecs preview decoder and use the native `<video>` element directly. The WC preview path is
   * built for keyframe-dense proxies — on a sparse-GOP camera original (2026-07-06 capture: ONE sync
   * frame in 250 samples of a 31.9MB file, a just-added clip whose proxy hadn't built) any catch-up
   * decodes an entire GOP in software, lag grows, and the hold/pan machinery shows a frozen picture
   * for seconds. The element decodes forward playback of exactly these files in hardware. When the
   * proxy lands, `src` flips and the layer upgrades to the WC path automatically.
   */
  preferNativeDecode?: boolean | undefined;
  matte?: MatteRef | undefined;
  currentTime: number;
  isPlaying: boolean;
  layerStartSeconds: number;
  sourceInSeconds?: number | undefined;
  /** Clip playback rate (rate stretch). Default 1. Applied to matte sync + matte playbackRate. */
  speedFactor?: number | undefined;
  onLoadedMetadata?: ((event: React.SyntheticEvent<HTMLVideoElement>) => void) | undefined;
}

type WebglMediaLayerProps = ImageProps | VideoProps;

export const WebglMediaLayer = forwardRef<HTMLVideoElement | null, WebglMediaLayerProps>(
  function WebglMediaLayer(props, forwardedRef) {
    const {
      mediaType, src, matte, pipeline, mediaEffects = null, amount = 1, style, className,
      dragHandlers, onWebglFailed, poster, hidden = false, interactiveHidden = false, transition = null, onGradedFrame,
      bakeOpacity = true, sceneMediaSink,
    } = props;

    // ── SINGLE-CTX PREVIEW (Phase 5, lumio.singleCtxPreview) ────────────────
    // Sink presence IS the mode: no own renderer/context; draws become raw-frame publishes. Read
    // through a ref inside the (hoisted, per-render) draw functions and the mount effect.
    const sceneSinkRef = useRef(sceneMediaSink);
    sceneSinkRef.current = sceneMediaSink;
    const singleCtx = Boolean(sceneMediaSink);
    // Monotonic content version for the compositor's re-grade skip (bumped per published frame).
    const frameVersionRef = useRef(0);
    // Live grade inputs the compositor reads at composite time (single-ctx). Assigned every render (below,
    // after the memoized keys exist) so `snapshot()` always reflects current props — never a stale closure.
    const gradeInputsRef = useRef<{
      pipeline: ColorPipeline | null;
      pipelineKey: string;
      mediaEffects: MediaEffects | null;
      mediaEffectsKey: string;
      amount: number;
      bakedOpacity: number;
      hasMatte: boolean;
      matteInvert: boolean;
      matteOpacity: number;
      transition: MediaTransition | null;
      transitionKey: string;
    }>({
      pipeline: null, pipelineKey: "", mediaEffects: null, mediaEffectsKey: "", amount: 1,
      bakedOpacity: 1, hasMatte: false, matteInvert: false, matteOpacity: 1, transition: null, transitionKey: "",
    });

    // Latest onGradedFrame, read inside the draw loop (whose closure would otherwise be stale).
    const onGradedFrameRef = useRef(onGradedFrame);
    onGradedFrameRef.current = onGradedFrame;

    // The canvas is blank until the first frame is drawn; a poster covers exactly that gap so the
    // viewer never shows black (at the start, at a cut, or on seek). Reset when the source changes.
    const [firstPainted, setFirstPainted] = useState(false);
    useEffect(() => {
      setFirstPainted(false);
    }, [src]);

    // Latest stylize params, read inside the rAF/vfc draw loop (whose closure would
    // otherwise be stale) so keyframed vignette + animated grain track playback.
    const mediaEffectsRef = useRef<MediaEffects | null>(mediaEffects);
    mediaEffectsRef.current = mediaEffects;

    // The transition reveal changes every frame; the playing draw loop reads the latest from this ref.
    const transitionRef = useRef<MediaTransition | null>(transition);
    transitionRef.current = transition;

    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const rendererRef = useRef<MediaWebGLRenderer | null>(null);
    const sourceVideoRef = useRef<HTMLVideoElement | null>(null);
    const matteVideoRef = useRef<HTMLVideoElement | null>(null);
    // Decoded still source. Preferred form is a pre-flipped, downscale-capped ImageBitmap (see the
    // image effect below); the raw <img> element is the fallback for engines without bitmap options.
    const imageRef = useRef<{ source: TexImageSource; width: number; height: number } | null>(null);
    const rafRef = useRef<number | null>(null);
    const vfcRef = useRef<number | null>(null);
    const disposeTimerRef = useRef<number | null>(null);
    const failedRef = useRef(false);
    // The playback loop closes over this ref so it always invokes the CURRENT drawVideoFrame — which
    // reads live opacity/transform from `style`. Without it the loop froze the opacity captured when it
    // started (≈0 at a transition's fade-in start), leaving the incoming clip transparent → black.
    const drawVideoFrameRef = useRef<() => void>(() => {});

    // Latest onLoadedMetadata (VideoProps only), read by the native-listener effect below.
    const onLoadedMetadataRef = useRef(mediaType === "video" ? props.onLoadedMetadata : undefined);
    onLoadedMetadataRef.current = mediaType === "video" ? props.onLoadedMetadata : undefined;

    // ── DECODER POOL STAGE 2 (WebCodecs, flag `wcDecode`, default OFF) ───────
    // When a pooled WebCodecs session is available, IT is the frame source (seek-on-demand via the
    // export's FrameProvider) and no <video> element exists for this clip. Any failure — cap
    // reached at mount, init/probe failure, or repeated null frames mid-flight — falls back to the
    // stage-1 <video> lease path. `wcEpoch` bumps when the source mode changes underneath the
    // element-bound effects so they re-run against the late-mounted element.
    const wcProviderRef = useRef<FrameProvider | null>(null);
    const wcLeaseRef = useRef<ReturnType<typeof acquirePreviewFrameProvider>>(null);
    const wcFrameRef = useRef<{ source: CanvasImageSource; width: number; height: number } | null>(null);
    // The provider owns the frame it serves — valid only until its NEXT getFrame (or a cache
    // eviction). Paused repaints (grade/opacity/effect edits) redraw wcFrameRef long after that,
    // racing the closure — the "can't texture a closed VideoFrame" console spam (2026-07-04 soak).
    // Hold a clone WE own (refcounted handle, no pixel copy) and close it on replace/teardown.
    function setWcHeldFrame(next: { source: CanvasImageSource; width: number; height: number } | null) {
      const prev = wcFrameRef.current;
      if (prev && typeof VideoFrame !== "undefined" && prev.source instanceof VideoFrame) {
        try { prev.source.close(); } catch { /* already closed */ }
      }
      wcFrameRef.current = next;
    }
    const wcBusyRef = useRef(false);
    const wcRerequestRef = useRef(false);
    const wcNullCountRef = useRef(0);
    // Wall-clock start of the current in-flight getFrame (null = none). A promise that never
    // settles wedges the layer with total silence — the watchdog uses this to detect it.
    const wcInFlightSinceMsRef = useRef<number | null>(null);
    // Pending retry timer for the paused null-frame march (see the null branch in requestWcFrame).
    const wcNullRetryTimerRef = useRef<number | null>(null);
    // Consecutive watchdog samples with NO source at all (neither provider nor element).
    const wcNoneSamplesRef = useRef(0);
    // Consecutive rewind-catch-up frames HELD (not drawn) — see requestWcFrame. Bounded so a source
    // that can't converge degrades to the old progressive pan instead of holding forever.
    // Wall-clock start of the current catch-up hold streak (null = not holding). See the
    // REWIND CATCH-UP HOLD block in requestWcFrame.
    const wcHoldStartRef = useRef<number | null>(null);
    const wcFallbackRef = useRef<() => void>(() => {});
    const requestWcFrameRef = useRef<() => void>(() => {});
    // When drawVideoFrame last actually painted — the watchdog uses it to catch a layer whose draw
    // chain went quiet while the transport plays (rvfc waiting on a stalled element presents nothing;
    // the compositor keeps compositing the stale canvas at full fps, so ONLY this can see it).
    const lastDrawMsRef = useRef(0);
    const [wcEpoch, setWcEpoch] = useState(0);
    // Live pending/pre-roll flag, read at lease-acquire time (the mount effect keys on src only).
    const hiddenAtMountRef = useRef(hidden);
    hiddenAtMountRef.current = hidden;
    // Live time mapping inputs for the async frame requests (props close over stale values).
    const wcTimeRef = useRef({ currentTime: 0, start: 0, sourceIn: 0, speed: 1, isPlaying: false });
    if (mediaType === "video") {
      wcTimeRef.current = {
        currentTime: props.currentTime,
        start: props.layerStartSeconds,
        sourceIn: props.sourceInSeconds ?? 0,
        speed: props.speedFactor ?? 1,
        isPlaying: props.isPlaying,
      };
    }

    // ── DECODER POOL (P0, stage 1) ───────────────────────────────────────────
    // The hidden source/matte <video> elements come from the shared element pool instead of being
    // React-rendered: a lease per mount (the caller keys this component by src, so src never changes
    // mid-mount), released on unmount. Same-src reuse hands back a WARM decoder (buffer intact) at
    // cuts/scrub-back/replay; the pool bounds total decoders. Layout effects (declared BEFORE the
    // imperative handle below) so `sourceVideoRef` is populated by the time the handle factory and
    // every other effect — child or parent — reads it, exactly like the old declarative render commit.
    // Detached elements decode/play fine (they were display:none before — never laid out either way).
    useLayoutEffect(() => {
      if (mediaType !== "video") return undefined;
      const cleanups: (() => void)[] = [];
      let disposed = false;

      const useVideoElement = (lateFallback: boolean) => {
        const lease = acquireVideo(src);
        sourceVideoRef.current = lease.video;
        cleanups.push(() => {
          if (sourceVideoRef.current === lease.video) sourceVideoRef.current = null;
          lease.release();
        });
        if (lateFallback) {
          // The element arrived AFTER mount (async WC failure) — the parent's play/seek effects
          // already ran against a null ref, so bring the element up to the current transport state
          // here (same mapping as VideoPreview.syncVideoTime) and re-arm the element-bound effects.
          const tp = wcTimeRef.current;
          try {
            lease.video.playbackRate = tp.speed;
            lease.video.currentTime = tp.sourceIn + Math.max(0, tp.currentTime - tp.start) * tp.speed;
            if (tp.isPlaying) void lease.video.play().catch(() => undefined);
          } catch {
            /* transport catch-up is best-effort; the next play/seek re-syncs */
          }
          setWcEpoch((value) => value + 1);
        }
      };

      // Stage 2: try a pooled WebCodecs session first (null = flag off or cap reached / preload
      // denied). Pending/pre-roll shells acquire at "preload" priority: they may not spend warm
      // parks or the last free slot, and a mounting PLAYHEAD clip can preempt them (they then take
      // the same <video> fallback they'd have used on a cap miss).
      // ORIGINAL-bytes sources skip WC entirely (see preferNativeDecode): the pooled decoder is for
      // keyframe-dense proxies — a sparse-GOP original grinds whole GOPs per catch-up and freezes.
      const wcLease = (mediaType === "video" && props.preferNativeDecode)
        ? null
        : acquirePreviewFrameProvider(src, {
            priority: hiddenAtMountRef.current ? "preload" : "playhead",
            onPreempted: () => wcFallbackRef.current(),
          });
      wcLeaseRef.current = wcLease;
      if (!wcLease) {
        useVideoElement(false);
      } else {
        wcNullCountRef.current = 0;
        wcFallbackRef.current = () => {
          // Callable from ANY stuck state — including "the provider never arrived" (init hang,
          // preempt mid-init). The old `!wcProviderRef.current` guard treated exactly that state
          // as "nothing to do" and left the layer with NO frame source at all: an invisible clip
          // (2026-07-04 report — cyclist track absent from the paused composite). Idempotent via
          // the element check. Releasing the lease here (it wasn't, before) both frees the pool
          // slot a broken session was pinning AND lets a late-resolving provider park warm.
          if (disposed || sourceVideoRef.current) return;
          wcProviderRef.current = null;
          setWcHeldFrame(null);
          wcLeaseRef.current?.release();
          wcLeaseRef.current = null;
          useVideoElement(true);
        };
        // Init-hang net: `lease.ready` has no timeout of its own — a wedged decoder init or a
        // starved pool queue left the layer source-less FOREVER (nothing else can fire: no frames,
        // no nulls, no lag). Give init a fixed window, then take the element path.
        const initTimer = window.setTimeout(() => {
          if (!disposed && !wcProviderRef.current && !sourceVideoRef.current) {
            recordWcHeal("initTimeout");
            wcFallbackRef.current();
          }
        }, WC_INIT_TIMEOUT_MS);
        cleanups.push(() => window.clearTimeout(initTimer));
        cleanups.push(() => {
          if (wcNullRetryTimerRef.current !== null) {
            window.clearTimeout(wcNullRetryTimerRef.current);
            wcNullRetryTimerRef.current = null;
          }
          wcProviderRef.current = null;
          setWcHeldFrame(null);
          wcLeaseRef.current = null;
          wcLease.release();
        });
        void wcLease.ready.then((provider) => {
          if (disposed) return;
          if (sourceVideoRef.current) {
            // The element path already won (init timeout / preempt fallback) — never create a
            // second live source; the released lease parks/disposes the provider pool-side.
            return;
          }
          if (!provider) {
            useVideoElement(true);
            return;
          }
          wcProviderRef.current = provider;
          requestWcFrameRef.current(); // paint the current frame without waiting for a transport change
        });
      }
      return () => {
        disposed = true;
        for (const cleanup of cleanups.reverse()) cleanup();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mediaType, src]);
    // Pre-roll shells become live at the cut (hidden→false): promote the lease so the pool stops
    // treating this clip as a preemption victim (and vice versa if a live clip returns to pending).
    useEffect(() => {
      if (mediaType !== "video") return;
      wcLeaseRef.current?.setPriority(hidden ? "preload" : "playhead");
    }, [mediaType, hidden]);

    useLayoutEffect(() => {
      if (mediaType !== "video" || !matte?.uri) return undefined;
      const lease = acquireVideo(matte.uri);
      matteVideoRef.current = lease.video;
      return () => {
        if (matteVideoRef.current === lease.video) matteVideoRef.current = null;
        lease.release();
      };
    }, [mediaType, matte?.uri]);
    // `loadedmetadata` as a native listener (the element is no longer JSX). A WARM pooled element
    // already has metadata and will never re-fire the event for the same src — fire synchronously then.
    useEffect(() => {
      if (mediaType !== "video") return undefined;
      const video = sourceVideoRef.current;
      if (!video) return undefined;
      const fire = () => onLoadedMetadataRef.current?.({ currentTarget: video } as React.SyntheticEvent<HTMLVideoElement>);
      video.addEventListener("loadedmetadata", fire);
      if (video.readyState >= 1) fire();
      return () => video.removeEventListener("loadedmetadata", fire);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mediaType, src, wcEpoch]);

    // Expose the source video element so VideoPreview's play/pause/seek effects keep working.
    // MUST recompute on `wcEpoch`: with empty deps this snapshotted ONCE at mount — null for any
    // WC-first mount (the lease is async) — so the parent's entire transport (play/pause/seek/rate/
    // drift correction) no-op'ed FOREVER, and every WC→element fallback handed the layer a corpse:
    // a fully-loaded element nobody ever played or re-seeked. That was the "clip plays like a
    // photo" / "frozen at the previous pause position" family (2026-07-04 __rfLiveFreeze:
    // mode:element, readyState:4, paused:true while the playhead moved on). Every element-arrival
    // path bumps wcEpoch, so the handle now always reflects the CURRENT source element.
    useImperativeHandle(forwardedRef, () => sourceVideoRef.current as HTMLVideoElement, [wcEpoch, mediaType, src]);

    /**
     * Get the renderer, lazily (re)creating it when absent. Absent means either first mount OR the context
     * governor evicted this layer's context under budget pressure — in which case we transparently recreate
     * it here the next time the clip is actually drawn (it's back in the active window). A freshly created
     * context has no baked LUT, so we re-apply the current grade immediately. Returns null once `failedRef`
     * (a real WebGL failure → legacy fallback) or when there's no canvas yet.
     */
    function ensureRenderer(): MediaWebGLRenderer | null {
      if (failedRef.current) return null;
      const existing = rendererRef.current;
      if (existing) return existing;
      const canvas = canvasRef.current;
      if (!canvas) return null;
      let renderer: MediaWebGLRenderer;
      // Hot-spot probed: context creation + shader compile + LUT re-bake are synchronous GPU work
      // that runs INSIDE a rAF on the first draw after mount/eviction — the classic source of an
      // unattributed multi-second long task when a seek mounts several new clip layers at once.
      const initStart = performance.now();
      try {
        renderer = new MediaWebGLRenderer(canvas, { kind: "media-renderer", label: `preview-media:${mediaType}:${src}` });
      } catch {
        rendererRef.current = null;
        failedRef.current = true;
        onWebglFailed?.();
        return null;
      }
      rendererRef.current = renderer;
      // The pipeline effect only fires on pipelineKey CHANGES, so after a governor recreate the grade would
      // otherwise be missing until the next edit — re-bake it now.
      try { renderer.setPipeline(pipeline); } catch { /* a bad pipeline must not kill the layer */ }
      markHotSpot("webgl-renderer-init", initStart, `${mediaType}:${src.slice(-24)}`);
      // Let the governor reclaim THIS renderer's context under budget pressure. Unlike a real context loss
      // (which latches `failedRef` → legacy fallback), an eviction merely drops the renderer so `ensureRenderer`
      // lazily recreates it on the next draw once the clip is active again — the LRU dance that bounds contexts.
      const gl = renderer.governorContext;
      if (gl) {
        registerContextDisposer(gl, () => {
          // Eviction must be RECOVERABLE (unlike a real context loss): only drop the renderer —
          // ensureRenderer recreates it on the next draw. Do NOT stop the frame loop here: the
          // WC-mode rAF loop (no <video> element → no vfc ticks) had no restart path, so an evicted
          // WC layer stayed frozen until pause/play. The governor only ever picks contexts idle
          // ≥200ms, so a recreate-next-tick can't thrash a genuinely live layer.
          if (rendererRef.current === renderer) rendererRef.current = null;
          try { renderer.dispose(); } catch { /* ignore */ }
        });
      }
      return renderer;
    }

    // Create / destroy the renderer with the canvas. Keyed on `singleCtx` (constant false with the flag
    // off → still runs exactly once, unchanged) so a scene-failure fallback WHILE the single-ctx flag is
    // on re-runs it in own-renderer mode: listener attached, renderer created, current frame repainted.
    const wasSingleCtxRef = useRef(singleCtx);
    useEffect(() => {
      const wasSingleCtx = wasSingleCtxRef.current;
      wasSingleCtxRef.current = singleCtx;
      // SINGLE-CTX PREVIEW: this layer creates NO WebGL context — the SceneCompositor grades its raw
      // frame in-context. The <canvas> element stays mounted (opacity:0) only for click-selection.
      if (singleCtx) return undefined;
      const canvas = canvasRef.current;
      if (!canvas) return undefined;
      const handleContextLost = (event: Event) => {
        event.preventDefault();
        failedRef.current = true;
        stopLoop();
        const renderer = rendererRef.current;
        rendererRef.current = null;
        try { renderer?.dispose(); } catch { /* ignore */ }
        onWebglFailed?.();
      };
      canvas.addEventListener("webglcontextlost", handleContextLost);
      if (disposeTimerRef.current !== null) {
        window.clearTimeout(disposeTimerRef.current);
        disposeTimerRef.current = null;
      }
      ensureRenderer();
      // Mode flip (single-ctx → own renderer, i.e. the scene GL failure fallback): the canvas has never
      // been drawn by this layer — repaint the current frame now, or a PAUSED viewer shows a blank clip
      // until the next seek/play/edit. No-op on ordinary mounts (wasSingleCtx false).
      if (wasSingleCtx) {
        if (mediaType === "image") drawImage();
        else drawVideoFrame();
      }
      return () => {
        canvas.removeEventListener("webglcontextlost", handleContextLost);
        stopLoop();
        scheduleRendererDispose();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [singleCtx]);

    // Bake a new LUT whenever the pipeline changes. Serialization is memoized on the object's
    // identity — stringifying a full ColorPipeline on every render of every layer was measurable
    // main-thread churn during playback's cold commits.
    const pipelineKey = useMemo(() => JSON.stringify(pipeline), [pipeline]);
    useEffect(() => {
      if (failedRef.current) return;
      try {
        const bakeStart = performance.now();
        rendererRef.current?.setPipeline(pipeline);
        markHotSpot("lut-bake", bakeStart, `${mediaType}:${src.slice(-24)}`);
        if (mediaType === "image") drawImage();
        // A playing video repaints on the next rAF/vfc tick, but a PAUSED video (the usual
        // state while grading) must be repainted now or the new grade never shows.
        else if (mediaType === "video" && !(props as VideoProps).isPlaying) drawVideoFrame();
      } catch {
        failedRef.current = true;
        onWebglFailed?.();
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pipelineKey]);

    // Stylize params (vignette/grain/chroma) are plain uniforms, not a baked LUT — so a
    // change just needs a redraw. The playing video loop already redraws every frame.
    const mediaEffectsKey = useMemo(() => JSON.stringify(mediaEffects), [mediaEffects]);
    useEffect(() => {
      if (failedRef.current) return;
      if (mediaType === "image") drawImage();
      else if (mediaType === "video" && !(props as VideoProps).isPlaying) drawVideoFrame();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mediaEffectsKey]);

    // `opacity` (from `style`), effect `amount`, and the matte params are BAKED into the grade by
    // drawVideoFrame/drawImage but — unlike pipeline/mediaEffects/transition above — had NO paused-repaint
    // trigger. So editing them WHILE PAUSED re-rendered the component without repainting the canvas (it
    // only refreshed once you played, where the per-frame loop re-grades every frame). Keying on their
    // VALUES (not object identity, so no spurious redraws) repaints a paused frame on any change, making
    // every baked draw input real-time. Covers the reported opacity bug + the same class for the others.
    const bakedInputsKey = `${extractOpacity(style)}|${amount}|${matte?.invert ?? false}|${matte?.opacity ?? 1}`;
    useEffect(() => {
      if (failedRef.current) return;
      if (mediaType === "image") drawImage();
      else if (mediaType === "video" && !(props as VideoProps).isPlaying) drawVideoFrame();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [bakedInputsKey]);

    // ─── IMAGE PATH ──────────────────────────────────────────────────────────

    // Stills: decode fully OFF the paint path (img.decode()), then bake a GPU-ready ImageBitmap —
    // downscale-capped (a 4180×2776 stock photo is a ~46MB texture; nothing in the preview ever
    // needs more than ~MAX_STILL_EDGE) and PRE-FLIPPED (texImage2D ignores UNPACK_FLIP_Y_WEBGL for
    // ImageBitmap sources, so the flip our upload convention expects must be baked into the bitmap;
    // the export's createImageSource applies the same imageOrientation for parity). Previously the
    // raw full-res <img> decoded + uploaded synchronously at first draw — a 500–800ms preview
    // freeze exactly when a photo clip started (2026-07-03 report). Bitmap options unsupported →
    // keep the element (correct, just slower).
    useEffect(() => {
      if (mediaType !== "image") return undefined;
      let cancelled = false;
      const MAX_STILL_EDGE = 2560;
      const zoom = (props as ImageProps).stillZoomFactor ?? 1;
      const proxyEdge = zoom > 1.15 ? STILL_PROXY_EDGES.zoomed : STILL_PROXY_EDGES.base;
      void (async () => {
        // P2 STILL PROXY (PREVIEW_PIPELINE.md): decode a downscaled OPFS WebP proxy instead of the
        // original — a 4K still is a ~64–90MB GPU texture from ANY file size/format, and an
        // image-heavy timeline of them overwhelms an iGPU. null → original path below (image small
        // enough, OPFS unavailable, or generation failed). Export never sees proxies.
        // data: URLs (vector graphic layers) skip the proxy entirely: their baked raster is already
        // ≤ the proxy base edge so generation always returns null, but the await alone parks them
        // behind the idle-gated generation chain (no decode until ~600ms of no playback/gesture) —
        // a just-added graphic looked like it "didn't load". Decode immediately instead.
        if (!src.startsWith("data:")) {
          try {
            const proxy = await getStillProxyBlob(src, proxyEdge);
            if (cancelled) return;
            if (proxy) {
              const bitmap = await createImageBitmap(proxy, { imageOrientation: "flipY" });
              if (cancelled) {
                bitmap.close();
                return;
              }
              imageRef.current = { source: bitmap, width: bitmap.width, height: bitmap.height };
              drawImage();
              return;
            }
          } catch {
            /* fall through to the original-decode path */
          }
        }
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.src = src;
        try {
          await img.decode();
        } catch {
          // One retry (a fresh element) covers transient decode failures; a still-failing source is
          // surfaced instead of silently staying blank forever (reported: graphics "never load").
          try {
            img.src = "";
            img.src = src;
            await img.decode();
          } catch (error) {
            if (!cancelled) console.warn("[lumio] still decode failed — layer stays empty:", src.slice(0, 128), error);
            return; // poster/empty stays, same as the old onload-never-fired path
          }
        }
        if (cancelled || img.naturalWidth === 0) return;
        let entry: { source: TexImageSource; width: number; height: number } = {
          source: img,
          width: img.naturalWidth,
          height: img.naturalHeight,
        };
        const scale = Math.min(1, MAX_STILL_EDGE / Math.max(img.naturalWidth, img.naturalHeight, 1));
        try {
          const bitmap = await createImageBitmap(img, {
            imageOrientation: "flipY",
            ...(scale < 1
              ? {
                  resizeWidth: Math.max(1, Math.round(img.naturalWidth * scale)),
                  resizeHeight: Math.max(1, Math.round(img.naturalHeight * scale)),
                  resizeQuality: "high" as const,
                }
              : {}),
          });
          entry = { source: bitmap, width: bitmap.width, height: bitmap.height };
        } catch {
          /* element fallback stays in `entry` */
        }
        if (cancelled) {
          (entry.source as ImageBitmap).close?.();
          return;
        }
        imageRef.current = entry;
        drawImage();
      })();
      return () => {
        cancelled = true;
        const old = imageRef.current;
        imageRef.current = null;
        (old?.source as ImageBitmap | undefined)?.close?.();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [src, mediaType]);

    function drawImage() {
      if (failedRef.current) return;
      const still = imageRef.current;
      // SINGLE-CTX PREVIEW: publish + re-arm; the compositor grades the still in-context (snapshot reads
      // imageRef live at composite time). No own GL context is created for scene-composited stills.
      if (singleCtx) {
        if (still && still.width > 0) publishSceneFrame();
        return;
      }
      const renderer = ensureRenderer();
      if (!renderer || !still || still.width === 0) return;
      try {
        renderer.draw({
          source: still.source,
          sourceWidth: still.width,
          sourceHeight: still.height,
          pipeline,
          amount,
          opacity: bakeOpacity ? extractOpacity(style) : 1,
          mediaEffects: mediaEffectsRef.current,
          transition: transitionRef.current,
        });
        setFirstPainted(true);
        if (canvasRef.current) onGradedFrameRef.current?.(canvasRef.current);
      } catch {
        failedRef.current = true;
        onWebglFailed?.();
      }
    }

    // A wipe/iris reveal changes per frame; repaint a still image (or paused video) when it changes.
    const transitionKey = useMemo(() => JSON.stringify(transition), [transition]);
    useEffect(() => {
      if (failedRef.current) return;
      if (mediaType === "image") drawImage();
      else if (mediaType === "video" && !(props as VideoProps).isPlaying) drawVideoFrame();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [transitionKey]);

    // ─── VIDEO PATH ──────────────────────────────────────────────────────────

    const currentTime = mediaType === "video" ? props.currentTime : 0;
    const isPlaying = mediaType === "video" ? props.isPlaying : false;
    const layerStartSeconds = mediaType === "video" ? props.layerStartSeconds : 0;
    const sourceInSeconds = mediaType === "video" ? (props.sourceInSeconds ?? 0) : 0;
    const speedFactor = mediaType === "video" ? (props.speedFactor ?? 1) : 1;

    // Sync matte video time to source video (speed-aware, same mapping as the source element).
    useEffect(() => {
      if (mediaType !== "video" || !matte?.uri) return;
      const matteVideo = matteVideoRef.current;
      if (!matteVideo) return;
      matteVideo.playbackRate = speedFactor;
      const nextTime = sourceInSeconds + Math.max(0, currentTime - layerStartSeconds) * speedFactor;
      if (Number.isFinite(nextTime) && Math.abs(matteVideo.currentTime - nextTime) > 0.08 * Math.max(1, speedFactor)) {
        matteVideo.currentTime = nextTime;
      }
    }, [currentTime, layerStartSeconds, mediaType, matte?.uri, sourceInSeconds, speedFactor]);

    // Play/pause the matte video in sync with the source.
    useEffect(() => {
      if (mediaType !== "video" || !matte?.uri) return;
      const matteVideo = matteVideoRef.current;
      if (!matteVideo) return;
      if (isPlaying) {
        void matteVideo.play().catch(() => undefined);
      } else {
        matteVideo.pause();
      }
    }, [isPlaying, mediaType, matte?.uri]);

    // ── FULL-RES SETTLE FRAME on pause (user rule 2026-07-05) ────────────────
    // At ½/¼/Auto quality the frame source is the ~854px ingest proxy — right in motion, soft when
    // parked (the paused canvas already renders at scale 1, but the PIXELS were still proxy pixels).
    // ~300ms after the transport settles on a paused frame, lease the ORIGINAL bytes (`fullResSrc`)
    // from the shared element pool, seek it to the exact source time once, and prefer it as the draw
    // source while paused — so grade/mask/opacity edits repaint against full-res pixels too. Any
    // transport movement (play, scrub, src change) drops it IMMEDIATELY and playback stays proxy-fed.
    // Element pool (not the WC preview-frame pool) on purpose: acquirePreviewFrameProvider returns
    // null while the `wcDecode` flag is off (its current default), and a native element seek is exact
    // and needs no catch-up machinery for a one-shot decode. Accepted trade-off (deferred-plan terms):
    // a sparse-GOP 4K original may take 1–3s to sharpen in. Telemetry: window.__rfSettleSwaps.
    const settleLeaseRef = useRef<ReturnType<typeof acquireVideo> | null>(null);
    const settleSourceRef = useRef<{ source: CanvasImageSource; width: number; height: number } | null>(null);
    const settleTokenRef = useRef(0);
    const fullResSrc = mediaType === "video" ? props.fullResSrc : undefined;
    useEffect(() => {
      if (mediaType !== "video") return undefined;
      // Every transport/source change invalidates the in-flight settle AND the held source. This
      // effect is declared BEFORE the paused-seek redraw effect below, so on a scrub the stale
      // full-res frame is gone before anything repaints at the new time.
      settleTokenRef.current += 1;
      const token = settleTokenRef.current;
      settleSourceRef.current = null;
      if (isPlaying || hidden || !fullResSrc || fullResSrc === src) {
        // Paused-only machinery: never pin a decoder lease while playing (or for pre-roll shells).
        settleLeaseRef.current?.release();
        settleLeaseRef.current = null;
        return undefined;
      }
      const timer = window.setTimeout(() => {
        if (settleTokenRef.current !== token) return;
        let lease = settleLeaseRef.current;
        if (!lease) {
          try {
            lease = acquireVideo(fullResSrc);
          } catch {
            return; // settle is best-effort — the proxy frame stays
          }
          settleLeaseRef.current = lease;
        }
        const video = lease.video;
        const tp = wcTimeRef.current;
        const target = tp.sourceIn + Math.max(0, tp.currentTime - tp.start) * tp.speed;
        if (!Number.isFinite(target)) return;
        const present = () => {
          if (settleTokenRef.current !== token || settleLeaseRef.current !== lease) return;
          if (video.readyState < 2 || video.videoWidth === 0) return;
          settleSourceRef.current = { source: video, width: video.videoWidth, height: video.videoHeight };
          if (typeof window !== "undefined") {
            (window as { __rfSettleSwaps?: number }).__rfSettleSwaps =
              ((window as { __rfSettleSwaps?: number }).__rfSettleSwaps ?? 0) + 1;
          }
          drawVideoFrameRef.current();
        };
        const seekTo = () => {
          if (settleTokenRef.current !== token) return;
          if (video.readyState >= 2 && Math.abs(video.currentTime - target) <= 1 / 120) {
            present(); // warm pooled element already parked on this frame — no seek event will fire
            return;
          }
          // A stale {once} listener on a released element is harmless: it fires on the next owner's
          // seek and the token check no-ops it.
          video.addEventListener("seeked", present, { once: true });
          try {
            video.currentTime = target;
          } catch {
            video.removeEventListener("seeked", present);
          }
        };
        if (video.readyState >= 1) seekTo();
        else video.addEventListener("loadedmetadata", seekTo, { once: true });
      }, 300);
      return () => window.clearTimeout(timer);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mediaType, isPlaying, hidden, currentTime, src, fullResSrc]);
    // Release the settle lease on unmount (the effect above only releases on play/none transitions).
    useEffect(
      () => () => {
        settleTokenRef.current += 1;
        settleSourceRef.current = null;
        settleLeaseRef.current?.release();
        settleLeaseRef.current = null;
      },
      []
    );

    // Redraw a paused video frame on seek. WC mode requests the frame at the new source time
    // (async decode → drawn on arrival); the element path repaints synchronously as before.
    useEffect(() => {
      if (mediaType !== "video" || isPlaying) return;
      if (wcProviderRef.current) {
        requestWcFrameRef.current();
        return;
      }
      drawVideoFrame();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentTime, isPlaying, mediaType]);

    // Repaint as soon as the source video has a real frame decoded (load / seek complete).
    // Without this the canvas shows nothing until the next rAF/seek tick, so the first frame
    // of a clip — and the first frame after a cut — flashes black. Mirrors how a <video>
    // element would paint its own first frame in the legacy path.
    useEffect(() => {
      if (mediaType !== "video") return undefined;
      const video = sourceVideoRef.current;
      if (!video) return undefined;
      const repaint = () => drawVideoFrame();
      video.addEventListener("loadeddata", repaint);
      video.addEventListener("canplay", repaint);
      video.addEventListener("seeked", repaint);
      // The frame may already be available (cached/instant) before listeners attach.
      if (video.readyState >= 2) drawVideoFrame();
      return () => {
        video.removeEventListener("loadeddata", repaint);
        video.removeEventListener("canplay", repaint);
        video.removeEventListener("seeked", repaint);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mediaType, src, wcEpoch]);

    // Frame loop while playing.
    useEffect(() => {
      if (mediaType !== "video" || !isPlaying) return undefined;
      const video = sourceVideoRef.current as VideoFrameCapableElement | null;
      let active = true;

      // WC mode (or WC still probing — provider may land mid-play): rAF loop requesting the frame
      // at the live transport time. Requests coalesce (single in-flight decode, latest time wins),
      // so a slow decode degrades to a lower frame rate instead of a backlog.
      if (!video) {
        const loop = () => {
          if (!active) return;
          if (wcProviderRef.current) requestWcFrameRef.current();
          rafRef.current = requestAnimationFrame(loop);
        };
        rafRef.current = requestAnimationFrame(loop);
        return () => {
          active = false;
          stopLoop();
        };
      }

      if (video.requestVideoFrameCallback) {
        const tick = () => {
          if (!active) return;
          drawVideoFrameRef.current();
          vfcRef.current = video.requestVideoFrameCallback!(tick);
        };
        vfcRef.current = video.requestVideoFrameCallback(tick);
        return () => {
          active = false;
          if (vfcRef.current != null) video.cancelVideoFrameCallback?.(vfcRef.current);
        };
      }

      const loop = () => {
        if (!active) return;
        drawVideoFrameRef.current();
        rafRef.current = requestAnimationFrame(loop);
      };
      rafRef.current = requestAnimationFrame(loop);
      return () => {
        active = false;
        stopLoop();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isPlaying, mediaType, wcEpoch]);

    // ── LIVE-FREEZE WATCHDOG + SELF-HEAL (soak telemetry → window.__rfLiveFreeze) ────────
    // 2026-07-04 report: picture "pauses" when playback crosses out of a ready proxy span into a
    // live region — the LIVE layer under the overlay wasn't producing frames. Names the broken
    // state per layer (how far the presented frame is behind the transport, and WHY: element
    // paused/buffering vs WC decode lag/hold vs no source at all) and FIXES the two states nothing
    // else can see: no-source (init hang) and a hung getFrame (busy wedged — no lag updates, no
    // nulls, no bail, total silence). Runs while PAUSED too — the original playing-only gate made
    // every paused pathology invisible, which is exactly where the user kept catching them.
    // Counter+ring only; console output behind `lumio.perfLog`.
    useEffect(() => {
      if (mediaType !== "video" || hidden) return undefined;
      const FREEZE_BEHIND_S = 1.0;
      const srcTail = src.length > 48 ? `…${src.slice(-48)}` : src;
      const report = (behind: number, timelineS: number, detail: Record<string, unknown>) => {
        const w = window as unknown as {
          __rfLiveFreeze?: { count: number; worstBehindS: number; recent: Record<string, unknown>[] };
        };
        const stats = (w.__rfLiveFreeze ??= { count: 0, worstBehindS: 0, recent: [] });
        stats.count += 1;
        stats.worstBehindS = Math.max(stats.worstBehindS, Math.round(behind * 100) / 100);
        stats.recent.push({ at: Math.round(performance.now()), timelineS: Math.round(timelineS * 100) / 100, behindS: Math.round(behind * 100) / 100, src: srcTail, ...detail });
        if (stats.recent.length > 40) stats.recent.shift();
        try {
          if (localStorage.getItem("lumio.perfLog") === "1") {
            console.warn(`[perf] live layer frozen ${behind.toFixed(2)}s behind @ t=${timelineS.toFixed(2)}s (${String(detail.mode)})`, detail);
          }
        } catch {
          /* storage unavailable — counters still recorded */
        }
      };
      // Element-path nudge rate limit (SELF-HEAL 3 below) — per effect lifetime is fine: a src/epoch
      // change re-arms it, which is exactly when a fresh nudge should be allowed anyway.
      let elementNudgeAtMs = 0;
      const interval = window.setInterval(() => {
        const tp = wcTimeRef.current;
        const nowMs = performance.now();
        const expected = tp.sourceIn + Math.max(0, tp.currentTime - tp.start) * tp.speed;
        const video = sourceVideoRef.current;
        const provider = wcProviderRef.current;

        // SELF-HEAL 1: no source at all (init hang / preempt gap) — the layer is INVISIBLE and no
        // other path can fire (no frames, no nulls, no lag). Two consecutive samples ≈ 1s, then
        // force the element fallback.
        if (!video && !provider) {
          report(Number.POSITIVE_INFINITY, tp.currentTime, { mode: "none", playing: tp.isPlaying });
          wcNoneSamplesRef.current += 1;
          if (wcNoneSamplesRef.current >= 2) {
            wcNoneSamplesRef.current = 0;
            recordWcHeal("noSource");
            wcFallbackRef.current();
          }
          return;
        }
        wcNoneSamplesRef.current = 0;

        // SELF-HEAL 2: a getFrame that never settles leaves `wcBusy` stuck — every later request
        // just sets a flag, so lag/null/bail logic ALL go dark (the silent-wedge class behind the
        // export freeze bug). If one request has been in flight this long, the session is wedged.
        if (provider && wcInFlightSinceMsRef.current !== null && nowMs - wcInFlightSinceMsRef.current > WC_BUSY_WEDGE_MS) {
          report(Number.POSITIVE_INFINITY, tp.currentTime, { mode: "wc", wedged: true, playing: tp.isPlaying });
          wcBusyRef.current = false; // the hung promise is fenced by the provider-identity check
          wcInFlightSinceMsRef.current = null;
          recordWcHeal("busyWedge");
          wcFallbackRef.current();
          return;
        }

        let behind: number;
        let detail: Record<string, unknown>;
        if (video) {
          behind = expected - video.currentTime;
          if (video.ended) return; // legitimate: clip outlives its source, element holds the tail
          detail = { mode: "element", paused: video.paused, readyState: video.readyState, playing: tp.isPlaying };
        } else {
          behind = provider!.lastFrameLagSeconds ?? 0;
          // phase: "live" = keeping up · "hold" = canvas frozen by the catch-up hold (bounded)
          //        · "pan" = presenting delayed frames while the provider tries to converge.
          const holdStart = wcHoldStartRef.current;
          detail = {
            mode: "wc",
            phase: holdStart === null ? "live" : nowMs - holdStart < WC_HOLD_MAX_MS ? "hold" : "pan",
            playing: tp.isPlaying
          };
        }
        // SELF-HEAL 4 (2026-07-06, user finding: "HUD says 75fps but the viewer is still"): the
        // scene compositor composites at full rate even when THIS layer's draw chain is quiet (rvfc
        // waits on a video that presents nothing new — and `behind` can read ~0 at stall onset), so
        // frame-rate telemetry can't see this state. If we haven't painted for a second while the
        // transport plays, force a draw of whatever the source holds now; the nudge below (and any
        // seek) re-fires the rvfc chain.
        if (tp.isPlaying && lastDrawMsRef.current > 0 && nowMs - lastDrawMsRef.current > 1000) {
          if (typeof window !== "undefined") {
            const w = window as { __rfStaleDrawKicks?: number };
            w.__rfStaleDrawKicks = (w.__rfStaleDrawKicks ?? 0) + 1;
          }
          drawVideoFrameRef.current();
        }

        if (behind <= FREEZE_BEHIND_S) return;
        report(behind, tp.currentTime, detail);
        // SELF-HEAL 3 (2026-07-06): the ELEMENT path had report-only coverage — a <video> that
        // silently stalls mid-clip (decoder hiccup, corrupt sample range, rvfc chain death) froze
        // the picture until the clip boundary ("clip plays ~4s then freezes" report). Nudge it back
        // onto the playhead: hard re-seek to the expected source time (1s-GOP proxies resync within
        // ~1s of material) and make sure it's actually playing. Rate-limited so a source that
        // repeatedly stalls degrades to a slideshow instead of a seek storm.
        if (video && tp.isPlaying) {
          if (nowMs - elementNudgeAtMs < 2500) return;
          elementNudgeAtMs = nowMs;
          if (typeof window !== "undefined") {
            const w = window as { __rfElementNudges?: number };
            w.__rfElementNudges = (w.__rfElementNudges ?? 0) + 1;
          }
          try {
            video.currentTime = expected;
          } catch {
            /* transient seek failure — next watchdog tick retries */
          }
          if (video.paused) {
            void video.play().catch(() => undefined);
          }
          drawVideoFrameRef.current();
        }
      }, 500);
      return () => window.clearInterval(interval);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mediaType, wcEpoch, hidden, src]);

    // COVERAGE-EXIT RE-PRIME (see requestLiveReprime): the proxy overlay is about to (or just did)
    // reveal this layer — force it to produce a fresh, on-time frame immediately instead of waiting
    // for the watchdog tick / lag machinery. WC path: heal a busy-wedge on the spot, else request a
    // frame at the current transport time. Element path: hard re-seek if drifted, resume if paused.
    useEffect(() => {
      if (mediaType !== "video") return undefined;
      const reprime = () => {
        const tp = wcTimeRef.current;
        const provider = wcProviderRef.current;
        if (provider) {
          // A getFrame that wedged while hidden leaves wcBusy stuck and every later request a
          // silent no-op — apply the watchdog's busy-wedge heal now, not at its next 500ms sample.
          const inFlightSince = wcInFlightSinceMsRef.current;
          if (inFlightSince !== null && performance.now() - inFlightSince > WC_BUSY_WEDGE_MS) {
            wcBusyRef.current = false;
            wcInFlightSinceMsRef.current = null;
            recordWcHeal("busyWedge");
            wcFallbackRef.current();
            return;
          }
          requestWcFrameRef.current();
          return;
        }
        const video = sourceVideoRef.current;
        if (!video) return;
        const expected = tp.sourceIn + Math.max(0, tp.currentTime - tp.start) * tp.speed;
        if (video.readyState >= 1 && Math.abs(video.currentTime - expected) > 0.3) {
          try {
            video.currentTime = expected;
          } catch {
            /* transient seek failure — the watchdog still covers this layer */
          }
        }
        if (tp.isPlaying && video.paused) {
          void video.play().catch(() => undefined);
        }
        drawVideoFrameRef.current();
      };
      liveReprimeListeners.add(reprime);
      return () => {
        liveReprimeListeners.delete(reprime);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mediaType]);

    function stopLoop() {
      if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    }

    // SINGLE-CTX PREVIEW: a new raw frame is ready — bump the content version (drives the compositor's
    // re-grade skip: unchanged version + unchanged grade keys → the cached graded RenderTarget is reused)
    // and re-arm the scene recomposite (the analog of onGradedFrame). No pixels are touched here; the
    // compositor uploads + grades the live source at composite time.
    function publishSceneFrame() {
      frameVersionRef.current += 1;
      lastDrawMsRef.current = performance.now();
      setFirstPainted(true); // no-op re-render after the first (poster gap already closed for scene media)
      sceneSinkRef.current?.onFrame();
    }

    function scheduleRendererDispose() {
      const renderer = rendererRef.current;
      if (!renderer) return;
      if (disposeTimerRef.current !== null) window.clearTimeout(disposeTimerRef.current);
      disposeTimerRef.current = window.setTimeout(() => {
        disposeTimerRef.current = null;
        if (rendererRef.current === renderer) rendererRef.current = null;
        try { renderer.dispose(); } catch { /* ignore */ }
      }, 0);
    }

    /**
     * The current best RAW video frame source (settle → WC → element), with the same closed-frame /
     * readiness guards `drawVideoFrame` used inline. Shared by the own-canvas draw AND the single-context
     * `snapshot()` (which computes the source at COMPOSITE time, so it's never stale/closed). Returns null
     * when nothing is decoded yet (the layer draws nothing this frame).
     */
    function selectVideoDrawSource(): { source: CanvasImageSource; width: number; height: number } | null {
      const wcFrame = wcFrameRef.current;
      // Belt-and-braces: a closed VideoFrame reports format:null — never hand it to texImage2D.
      const wcFrameClosed =
        wcFrame !== null && typeof VideoFrame !== "undefined" && wcFrame.source instanceof VideoFrame && wcFrame.source.format === null;
      // Source selection order: full-res settle frame (paused only) → WC frame → element. The settle
      // ref is cleared synchronously on any transport movement (see the settle effect), so the paused
      // check is belt-and-braces against a draw racing the play flip.
      const settle = settleSourceRef.current;
      if (settle && !wcTimeRef.current.isPlaying && settle.width > 0 && settle.height > 0) {
        return { source: settle.source, width: settle.width, height: settle.height };
      }
      if (wcFrame && !wcFrameClosed && wcFrame.width > 0 && wcFrame.height > 0) {
        return { source: wcFrame.source, width: wcFrame.width, height: wcFrame.height };
      }
      const video = sourceVideoRef.current;
      if (!video || video.readyState < 2 || video.videoWidth === 0) return null;
      return { source: video, width: video.videoWidth, height: video.videoHeight };
    }

    function drawVideoFrame() {
      if (failedRef.current || mediaType !== "video") return;
      const picked = selectVideoDrawSource();
      // SINGLE-CTX PREVIEW: publish the raw frame + re-arm the scene recomposite instead of grading here.
      // The compositor reads the source LIVE via snapshot() at composite time, so we only bump the version.
      if (singleCtx) {
        if (picked) publishSceneFrame();
        return;
      }
      const renderer = ensureRenderer();
      if (!renderer) return;
      if (!picked) return;
      const matteVideo = matteVideoRef.current;
      const hasMatte = Boolean(matte?.uri) && matteVideo !== null && matteVideo.readyState >= 2;
      const source = picked.source;
      const sourceWidth = picked.width;
      const sourceHeight = picked.height;
      try {
        const drawStart = performance.now();
        renderer.draw({
          source: source as TexImageSource,
          sourceWidth,
          sourceHeight,
          matte: hasMatte ? matteVideo : null,
          matteInvert: matte?.invert ?? false,
          matteOpacity: matte?.opacity ?? 1,
          pipeline,
          amount,
          opacity: bakeOpacity ? extractOpacity(style) : 1,
          mediaEffects: mediaEffectsRef.current,
          transition: transitionRef.current,
        });
        // texImage2D of a 4K hw-decoder VideoFrame can stall on a GPU sync — if the "unknown"
        // long tasks are here, __rfHotSpots will say so with the source dimensions.
        markHotSpot("webgl-draw", drawStart, `${sourceWidth}x${sourceHeight}`);
        lastDrawMsRef.current = performance.now();
        setFirstPainted(true);
        if (canvasRef.current) onGradedFrameRef.current?.(canvasRef.current);
      } catch {
        failedRef.current = true;
        onWebglFailed?.();
      }
    }
    // Keep the loop's draw reference current so playback reads live opacity/transform every frame.
    drawVideoFrameRef.current = drawVideoFrame;

    // WebCodecs frame request (stage 2): single in-flight decode, latest transport time wins.
    // A resolved frame belongs to the provider (valid until its NEXT getFrame), so we draw it
    // immediately and keep it referenced for paused repaints (pipeline/effect changes).
    function requestWcFrame() {
      const provider = wcProviderRef.current;
      if (!provider || mediaType !== "video") return;
      if (wcBusyRef.current) {
        wcRerequestRef.current = true;
        return;
      }
      wcBusyRef.current = true;
      wcInFlightSinceMsRef.current = performance.now();
      const tp = wcTimeRef.current;
      // See WC_LIVE_CLOCK_MAX_DIVERGENCE_S: while playing, ride the live sub-commit clock so proxy
      // motion is min(proxy fps, decode rate) instead of the clock-commit cadence.
      let timelineTime = tp.currentTime;
      if (tp.isPlaying) {
        const live = getLivePlaybackTime();
        if (Math.abs(live - tp.currentTime) < WC_LIVE_CLOCK_MAX_DIVERGENCE_S) timelineTime = live;
      }
      const sourceTime = tp.sourceIn + Math.max(0, timelineTime - tp.start) * tp.speed;
      void provider
        .getFrame(sourceTime)
        .then((frame) => {
          wcBusyRef.current = false;
          wcInFlightSinceMsRef.current = null;
          if (wcProviderRef.current !== provider) return; // released/fell back mid-decode
          if (frame) {
            wcNullCountRef.current = 0;
            // REWIND CATCH-UP HOLD (2026-07-03 soak): after a backward jump on a sparse-keyframe
            // source the provider time-slices the re-decode and serves progressively ADVANCING
            // stale frames (its frameBudgetMs contract). Presenting them plays the skipped span
            // "fast-forward". Hold the canvas on its last drawn frame instead and keep requesting
            // (self-rerequest covers the paused case) until the served frame is within a beat of
            // the target; small lags are ordinary slow-decode frame-rate degradation and present
            // normally. Bounded by WALL CLOCK, not a present count: the old 60-present cap was
            // consumed at rerequest cadence in under a second, so a 20-30s rewind outlived it and
            // the tail of the catch-up presented as the fast-forward pan anyway (3rd soak report,
            // 2026-07-04). A source that truly can't converge (decode slower than the moving
            // playhead) degrades to the progressive pan after the window instead of freezing.
            const lag = provider.lastFrameLagSeconds ?? 0;
            const nowMs = performance.now();
            if (wcHoldStartRef.current !== null) {
              const streakMs = nowMs - wcHoldStartRef.current;
              const stalled = tp.isPlaying
                ? lag > WC_DIVERGE_LAG_S && streakMs > WC_DIVERGE_MAX_MS
                : lag > WC_PAUSED_STALE_LAG_S && streakMs > WC_PAUSED_STALE_MAX_MS;
              if (stalled) {
                // This source can't be served by WebCodecs here (diverging while playing, or unable
                // to close a fixed gap while paused) — hand the layer to the element path.
                recordWcHeal(tp.isPlaying ? "divergence" : "pausedStall");
                wcFallbackRef.current();
                return;
              }
            }
            const presentFrame = () => {
              // Clone before holding: our copy survives the provider closing its original.
              let held: CanvasImageSource = frame;
              if (typeof VideoFrame !== "undefined" && frame instanceof VideoFrame) {
                try { held = frame.clone(); } catch { held = frame; }
              }
              setWcHeldFrame({ source: held, width: provider.width, height: provider.height });
              drawVideoFrameRef.current();
            };
            if (lag > WC_HOLD_LAG_S) {
              // The hold STREAK ends only when lag actually recovers (below), never on a present:
              // the old logic reset the streak after the window expired and one frame presented, so
              // sustained divergence re-armed a fresh 5s freeze per frame — "picture pauses in live
              // regions" (2026-07-04 __rfLiveFreeze capture: holding:true chained 10s+, 15s behind).
              if (wcHoldStartRef.current === null) wcHoldStartRef.current = nowMs;
              if (nowMs - wcHoldStartRef.current < WC_HOLD_MAX_MS) {
                wcRerequestRef.current = true;
                // Soak telemetry (__rf* convention): proves in the field whether the rewind hold is
                // engaging (console: window.__rfWcHolds). Counter only — no logging on the hot path.
                if (typeof window !== "undefined") {
                  (window as { __rfWcHolds?: number }).__rfWcHolds = ((window as { __rfWcHolds?: number }).__rfWcHolds ?? 0) + 1;
                }
              } else {
                // Window exhausted and the source still can't converge — STAY degraded: present the
                // progressively advancing stale frames (delayed picture beats a frozen one) until
                // the provider genuinely catches up. Keep the request chain alive ourselves: while
                // PAUSED there is no rAF loop, and without a rerequest the chain dies here — the
                // 2026-07-04 paused-stale capture showed lag frozen at 1.41s across samples because
                // no further decode was ever requested (so neither convergence NOR the stall
                // bail-out above could happen).
                wcRerequestRef.current = true;
                presentFrame();
              }
            } else {
              wcHoldStartRef.current = null;
              presentFrame();
            }
          } else {
            // Repeated nulls = this source can't be served by WebCodecs here → <video> fallback.
            wcNullCountRef.current += 1;
            if (wcNullCountRef.current >= 8) {
              recordWcHeal("nullFrames");
              wcFallbackRef.current();
            } else if (wcNullRetryTimerRef.current === null) {
              // March toward a verdict even while PAUSED: with no rAF loop, a null used to be
              // terminal — the next request only came from the next user seek, so the 8-null
              // fallback could take 8 SEEKS to trigger and the layer sat invisible in between
              // (2026-07-04 report). A short timer keeps the probe going.
              wcNullRetryTimerRef.current = window.setTimeout(() => {
                wcNullRetryTimerRef.current = null;
                if (wcProviderRef.current) requestWcFrameRef.current();
              }, 150);
            }
          }
          if (wcRerequestRef.current) {
            wcRerequestRef.current = false;
            requestWcFrameRef.current();
          }
        })
        .catch(() => {
          wcBusyRef.current = false;
          wcInFlightSinceMsRef.current = null;
          wcFallbackRef.current();
        });
    }
    requestWcFrameRef.current = requestWcFrame;

    // SINGLE-CTX PREVIEW: refresh the live grade inputs every render (all keys exist by here). The grade
    // MATH is identical to this layer's own-canvas draw — same pipeline/matte/effects/amount, and the same
    // bakeOpacity split (scene-normal media → opacity applied live by the compositor = 1 here; transition
    // sources → baked). The compositor produces a byte-identical RenderTarget, only the output surface
    // differs (shared-context RTT vs own canvas) — the proven single-context export equivalence.
    if (singleCtx) {
      const matteVideo = matteVideoRef.current;
      gradeInputsRef.current = {
        pipeline,
        pipelineKey,
        mediaEffects: mediaEffectsRef.current,
        mediaEffectsKey,
        amount,
        bakedOpacity: bakeOpacity ? extractOpacity(style) : 1,
        hasMatte: Boolean(matte?.uri) && matteVideo !== null && matteVideo.readyState >= 2,
        matteInvert: matte?.invert ?? false,
        matteOpacity: matte?.opacity ?? 1,
        transition: transitionRef.current,
        transitionKey,
      };
    }

    // SINGLE-CTX PREVIEW: publish a stable frame-source descriptor to the scene compositor. `snapshot()`
    // reads only refs, so one object stays valid for the layer's life; the compositor polls it per frame.
    useEffect(() => {
      const sink = sceneSinkRef.current;
      if (!sink) return undefined;
      const source: ScenePreviewMediaSource = {
        snapshot() {
          let frame: ScenePreviewMediaFrame | null = null;
          if (mediaType === "video") {
            const picked = selectVideoDrawSource();
            if (picked) frame = { source: picked.source as TexImageSource, width: picked.width, height: picked.height };
          } else {
            const still = imageRef.current;
            if (still && still.width > 0 && still.height > 0) frame = { source: still.source, width: still.width, height: still.height };
          }
          const gi = gradeInputsRef.current;
          const matteVideo = matteVideoRef.current;
          return {
            frame,
            frameVersion: frameVersionRef.current,
            pipeline: gi.pipeline,
            pipelineKey: gi.pipelineKey,
            mediaEffects: gi.mediaEffects,
            mediaEffectsKey: gi.mediaEffectsKey,
            amount: gi.amount,
            bakedOpacity: gi.bakedOpacity,
            matte: gi.hasMatte && matteVideo ? { source: matteVideo as TexImageSource, invert: gi.matteInvert, opacity: gi.matteOpacity } : null,
            transition: gi.transition,
            transitionKey: gi.transitionKey,
          };
        },
      };
      sink.register(source);
      return () => sink.register(null);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [singleCtx, mediaType]);

    // ─── RENDER ──────────────────────────────────────────────────────────────

    // The canvas keeps the layout style (left, top, objectFit, transform) AND the stylize CSS `filter`
    // (blur / glow). Color grading is shader-baked and already excluded upstream (skipColorFilter:true), so
    // `style.filter` here is only the non-color filters — they must stay or blur/glow would never render.
    // Interaction events pass through so the existing drag/selection handlers on the parent still fire.
    // `hidden` (pre-roll) hides the canvas via visibility only — never via opacity, which the shader
    // bakes in: a transparent-drawn buffer is exactly what flickers at the reveal. visibility:hidden also
    // makes it non-interactive. The shader still draws the real frame so the buffer is reveal-ready.
    const canvasStyle: CSSProperties = {
      ...style,
      pointerEvents: dragHandlers ? undefined : "none",
      ...(hidden ? { visibility: "hidden" } : interactiveHidden ? { opacity: 0 } : {}),
    };

    // NOTE: the hidden source/matte <video> elements are NOT rendered here anymore — they are leased
    // from the shared decoder pool (see the DECODER POOL layout effects above) and live detached.
    return (
      <>
        <canvas
          ref={canvasRef}
          className={className}
          style={canvasStyle}
          aria-hidden="true"
          {...dragHandlers}
        />
        {poster && !firstPainted && !hidden ? (
          <img
            src={poster}
            alt=""
            aria-hidden="true"
            draggable={false}
            // Same positioning class as the canvas → position:absolute, so the inline
            // translate(-50%,-50%) centers it instead of shoving a static-flow image to the top-left
            // (the "footage flashes small in the corner on every cut" bug).
            className="preview-media"
            style={{ ...canvasStyle, pointerEvents: "none" }}
          />
        ) : null}
      </>
    );
  }
);

/** Extract the numeric opacity already baked into the style by getCompositionMediaStyle. */
function extractOpacity(style: CSSProperties): number {
  const v = style.opacity;
  if (v == null) return 1;
  const n = typeof v === "string" ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : 1;
}
