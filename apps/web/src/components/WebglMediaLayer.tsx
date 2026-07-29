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
import { colorPipelineCacheKey, MediaWebGLRenderer, registerContextDisposer, resolveGraphicAnimation, graphicToAnimatedDataUrl, graphicAnimationBakeTime, graphicAnimationFrameAt, type ColorPipeline, type GraphicAnimationPlan, type LayerGraphic, type MatteRef, type MediaEffects, type MediaTransition, type TimelineKeyframeV2 } from "@orreris/shared";
import { acquireVideo } from "../lib/video-element-pool";
import { markHotSpot } from "../lib/perfDiagnostics";
import { STILL_PROXY_EDGES, getStillProxyBlob } from "../editor/performance/stillProxyStore";
import { recordMediaFrame } from "../editor/performance/frame-stats";
import { acquirePreviewFrameProvider } from "../playback/preview-frame-pool";
import { getLivePlaybackTime, subscribePlaybackClock } from "../playback/playback-clock";
import { setMediaPlaybackRate } from "../playback/media-rate";
import { ELEMENT_FALLBACK_MAX_LAG_S, sourceFramePeriodSeconds, stalenessSeconds } from "../playback/temporal-coherence";
import { yieldTask } from "../playback/yield-task";
import { traceAsset, traceEvent, type ProviderTraceReason } from "../playback/provider-lifecycle-trace";
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
// SUSTAINED-HOLD BAIL (2026-07-25): a WC provider held continuously (> WC_HOLD_LAG_S behind) for this long
// while PLAYING is not converging — a HIGH-FPS proxy the seek-on-demand pool can't sustain sits at ~0.35–1s
// lag forever, which the 3s/10s WC_DIVERGE bail never catches, so the canvas holds = the frozen-clip bug.
// Hand off to the native <video> element (continuous hardware decode plays any fps, exactly what a paused
// settle already does). The hold streak (`wcHoldStartRef`) resets the instant lag drops below WC_HOLD_LAG_S,
// so a genuinely converging catch-up never trips this — only a non-converging hold does. 1.2s bounds the
// visible hitch while staying above a transient GPU hiccup.
const WC_SUSTAINED_HOLD_BAIL_MS = 1200;
// Sources this session that already proved unservable by the WC preview pool (sustained-hold bail while
// playing). Checked at ACQUISITION so a re-mount (scrub between clips / replay after the layer unmounts)
// skips WC and goes straight to the native element — no repeated 1.2s hitch. Session-scoped; a proxy's
// object URL is stable per asset per session. NOT persisted: a reload re-probes (hardware/flags may differ).
const wcBailedSources = new Set<string>();

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
    if (localStorage.getItem("orreris.perfLog") === "1") {
      console.warn(`[perf] wc self-heal: ${kind} → element fallback`);
    }
  } catch {
    /* storage unavailable — counter still recorded */
  }
}

/**
 * STALE-CLOCK PROBE (2026-07-26). A layer whose `currentTime` prop stops updating while the transport
 * plays keeps requesting ONE constant source time, so the decoder serves the same frame forever — the
 * picture freezes with `lastFrameLagSeconds` ≈ 0, which is invisible to EVERY heal here (they are all
 * lag- or failure-driven). That is exactly how the multi-source Flarex freeze hid behind four rounds of
 * decode-side fixes (a memo skipped the virtual loaders' re-renders — see arePreviewLayerPropsEqual).
 * The live-clock divergence guard rejecting the module clock is the one observable symptom, so count it
 * per source. Diagnostic ONLY — the guard's behavior is unchanged, because rejecting a foreign playhead
 * is legitimate on tool pages / fixtures that mount their own VideoPreview transport.
 */
function recordWcStaleTime(src: string) {
  if (typeof window === "undefined") return;
  const w = window as unknown as { __rfWcStaleTime?: Record<string, number> };
  const stats = (w.__rfWcStaleTime ??= {});
  const key = src.length > 48 ? `…${src.slice(-48)}` : src;
  stats[key] = (stats[key] ?? 0) + 1;
}

/**
 * DECODE-PATH PROBE (2026-07-27). Which path each source actually ended up on:
 *   `wc-hw`   pooled WebCodecs on the GPU video block  — what a host/timeline clip wants;
 *   `wc-sw`   pooled WebCodecs in software (CPU thread) — what a Flarex virtual loader wants;
 *   `element` native `<video>` fallback — for a comp source this is the ~16-context cap and a
 *             permanent freeze, and for the host it means it lost a pool slot or got bailed.
 *
 * Added because "which decoder is this layer on?" was unanswerable from the console, and the two
 * multi-source freezes (loaders frozen, then the HOST frozen) were both mis-diagnosed for rounds on
 * end without it. Pure telemetry — keyed per source, like `recordWcHeal`/`recordWcStaleTime`.
 */
function wcModeKey(src: string): string {
  return src.length > 48 ? `…${src.slice(-48)}` : src;
}

/**
 * LIVENESS (2026-07-28). The table is keyed by source URL and used to be write-only, so entries
 * outlived the layers that wrote them. One asset legitimately changes url mid-session — the original
 * plays until its ingest proxy lands, then `mediaUrl` becomes the proxy blob and the layer remounts —
 * which left the ORIGINAL's row sitting next to the proxy's, both reading as current. One asset,
 * two rows, one of them describing a decoder that no longer exists. That already caused one wrong
 * diagnosis: the dead `element` row was read as a live source stuck on the fallback path.
 *
 * Refcounted rather than "delete on unmount": two layers can legitimately share one url (the same
 * clip twice on the timeline), and the last one out must be the one that clears it.
 *
 * Rule (same as v32l's decode column, and v32o's build check): an instrument must not present dead
 * state as live. A stale row is worse than a missing one — a missing row prompts a question, a stale
 * row answers it wrongly.
 */
const wcModeLive = new Map<string, number>();

function recordWcMode(src: string, mode: "wc-hw" | "wc-sw" | "element") {
  if (typeof window === "undefined") return;
  const w = window as unknown as { __rfWcMode?: Record<string, string> };
  const stats = (w.__rfWcMode ??= {});
  stats[wcModeKey(src)] = mode;
}

function retainWcMode(src: string): void {
  const key = wcModeKey(src);
  wcModeLive.set(key, (wcModeLive.get(key) ?? 0) + 1);
}

function releaseWcMode(src: string): void {
  if (typeof window === "undefined") return;
  const key = wcModeKey(src);
  const next = (wcModeLive.get(key) ?? 0) - 1;
  if (next > 0) {
    wcModeLive.set(key, next);
    return;
  }
  wcModeLive.delete(key);
  const w = window as unknown as { __rfWcMode?: Record<string, string> };
  if (w.__rfWcMode) delete w.__rfWcMode[key];
}

/** Preview raster edge for baked animation frames — smaller than the 1024px export bake to bound GPU
 *  memory (frameCount × edge² × 4 bytes per animated graphic); vector scales, so this stays crisp on screen. */
const GRAPHIC_ANIM_PREVIEW_EDGE = 512;

/**
 * Pre-bake an animated vector graphic's SMIL cycle into flipped frame bitmaps (one per
 * graphicAnimationFrame index) by rasterizing the deep-linked SVG at each sample time. Main-thread only
 * (needs an <img> decode). `flipY` matches the still/export upload convention for preview↔export parity.
 */
async function bakeAnimatedGraphicFrames(
  graphic: LayerGraphic,
  plan: GraphicAnimationPlan,
  edge: number,
  isCancelled: () => boolean
): Promise<ImageBitmap[]> {
  const aspect = (graphic.naturalWidth ?? 1) / (graphic.naturalHeight ?? 1);
  const w = Math.max(1, aspect >= 1 ? edge : Math.round(edge * aspect));
  const h = Math.max(1, aspect >= 1 ? Math.round(edge / aspect) : edge);
  // Baked SPARSELY on purpose: frame selection indexes the result by FRAME NUMBER, so a failed frame
  // must never be dropped — a shorter array silently shifts every later frame, and the preview would
  // then run a different phase than the export (which bakes its own sequence and can't skip, since its
  // Promise.all rejects instead). Gaps are backfilled from the nearest baked neighbour below, keeping
  // index === frame number. A near-duplicate frame is a far better failure than a desynced animation.
  const baked: Array<ImageBitmap | undefined> = new Array(plan.frameCount);
  for (let i = 0; i < plan.frameCount; i += 1) {
    if (isCancelled()) break;
    const img = new Image();
    img.decoding = "async";
    img.src = graphicToAnimatedDataUrl(graphic, graphicAnimationBakeTime(plan, i));
    try {
      await img.decode();
      if (isCancelled()) break;
      baked[i] = await createImageBitmap(img, { imageOrientation: "flipY", resizeWidth: w, resizeHeight: h, resizeQuality: "high" });
    } catch {
      /* bad decode, or an engine without bitmap options — leave the gap for the backfill */
    }
  }
  const first = baked.find(Boolean);
  if (isCancelled() || !first) {
    // Nothing usable (or we were cancelled mid-bake): no aligned sequence is possible, so report none
    // rather than a partial one. Closing here keeps a cancelled bake from leaking its bitmaps.
    for (const frame of baked) frame?.close();
    return [];
  }
  // Backfilled entries repeat a bitmap reference, so the caller's dispose closes some twice — which is
  // a no-op on an already-detached ImageBitmap, not an error.
  const frames: ImageBitmap[] = [];
  let last = first; // leading gaps hold the first baked frame until a real one arrives
  for (let i = 0; i < plan.frameCount; i += 1) {
    last = baked[i] ?? last;
    frames.push(last);
  }
  return frames;
}

interface BaseProps {
  /**
   * Human-resolvable name for the diagnostic tables (`__rfSourceMap.asset`). Falls back to the url
   * tail, which is a FILENAME for a library asset but an opaque `createObjectURL` UUID for anything
   * OPFS-backed — regenerated every page load, joinable to nothing. A whole project of proxied
   * sources therefore reported a fresh set of meaningless ids on each reload, which read as assets
   * being re-created per session and sent one investigation down the wrong path (2026-07-28).
   */
  assetLabel?: string | undefined;
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
   * Single-context preview (Phase 5, `orreris.singleCtxPreview`): when set, this layer creates NO
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
  /** Vector-graphic layer source. When it carries SMIL animation, the layer plays it live: pre-baked
   *  frames selected against the playhead (see graphicAnimationFrame), instead of the static still. */
  graphic?: LayerGraphic | undefined;
  /** Clip start (timeline seconds) — clip-local time drives animated-graphic frame selection. */
  graphicStartSeconds?: number | undefined;
  /** The layer's keyframes — `graphicProgress` / `graphicDuration` keys drive the animation's phase. */
  graphicAnimations?: TimelineKeyframeV2[] | undefined;
  fullResSrc?: never;
  preferNativeDecode?: never;
  currentTime?: never;
  isPlaying?: never;
  layerStartSeconds?: never;
  sourceInSeconds?: never;
  speedFactor?: never;
  prerollSeconds?: never;
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
  /**
   * Frame hold ("on twos", 2026-07-18): while PLAYING, the layer publishes/redraws only when the
   * hold bucket (floor(localSeconds·holdFps)) advances — the last drawn frame stays on screen, so
   * the preview shows the same N-images-per-second feel the export bakes exactly. Paused repaints
   * (grade edits, scrub, settle) bypass the skip so editing stays live.
   */
  holdFps?: number | undefined;
  /**
   * R3.2: this clip's resolved transition PRE-ROLL (seconds of timeline before `layerStartSeconds`
   * during which it must already play its head-handle material — see `resolveTransitionWindowSides`).
   * Every internal source-time mapping here allows local time down to −preroll instead of clamping at
   * 0; without it the watchdog/WC/reprime paths pin the incoming clip to its in-point frame for the
   * whole pre-roll ("frozen initial frames", 2026-07-17 report). 0/absent → exact legacy behavior.
   */
  prerollSeconds?: number | undefined;
  /**
   * This clip's asset is stacked with another active layer (same-source stack). On the WebCodecs
   * path both request the frame at the shared transport clock (already locked); on the <video>
   * ELEMENT fallback, native play() free-runs each element's own clock so twins can drift a few
   * frames apart → a ghost. When set, the live watchdog corrects element drift at a tight (~1.5
   * frame) threshold instead of its 1s freeze threshold, keeping the stack aligned. Only stacked
   * clips get this — single clips keep the smooth, correction-free element path.
   */
  strictSourceSync?: boolean | undefined;
  /**
   * Lag-tolerant decode (Flarex virtual loaders / in-sync composited sources). Normally a WC provider
   * lagging the transport by > WC_HOLD_LAG_S HOLDS the canvas (freezes) to avoid showing a stale frame
   * mid-seek. But a Flarex comp composites MANY sources at once, and the ~3 hardware seek-on-demand
   * decoders can't all keep up — the non-winners then freeze permanently. When this is set, the layer
   * NEVER freeze-holds: it presents the latest advancing frame and keeps pulling, so an overloaded source
   * degrades to smooth-but-slightly-behind instead of frozen. Graceful degradation that scales to many
   * sources (3 → smooth, 1000 → each advances as fast as the GPU allows, none frozen).
   */
  tolerateLag?: boolean | undefined;
  /**
   * Decode this source in SOFTWARE (CPU) instead of on the GPU's hardware video block. The integrated
   * GPU exposes only one H.264 decode block; ~3 concurrent SEEK-ON-DEMAND streams (host + Flarex virtual
   * loaders) serialize on it and the non-primary streams STARVE — their frames stop advancing → frozen
   * (measured: host smooth, asset-source loaders frozen, `__rfWcDecoder` reset counts near-zero = they
   * weren't even decoding). Routing the virtual loaders to software decode takes them OFF the contended
   * hardware block onto their own CPU threads (WebCodecs software decode runs off-main-thread, so it stays
   * off the DOM — no `<video>` 16-context cap), leaving the hardware block for the host/timeline. Paired
   * with `tolerateLag`, a slightly-slower software stream presents advancing frames instead of freezing.
   */
  preferSoftwareDecode?: boolean | undefined;
  /**
   * Never share a decode session for this source — this layer reads it at a time no other consumer
   * will ask for. Set by RETIMED Flarex loaders, whose whole purpose is to read the host's own file at
   * a different `t`; see `AcquireOptions.exclusive`.
   */
  exclusiveDecode?: boolean | undefined;
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

    // ── SINGLE-CTX PREVIEW (Phase 5, orreris.singleCtxPreview) ────────────────
    // Sink presence IS the mode: no own renderer/context; draws become raw-frame publishes. Read
    // through a ref inside the (hoisted, per-render) draw functions and the mount effect.
    const sceneSinkRef = useRef(sceneMediaSink);
    sceneSinkRef.current = sceneMediaSink;
    const singleCtx = Boolean(sceneMediaSink);
    // Monotonic content version for the compositor's re-grade skip (bumped per published frame).
    const frameVersionRef = useRef(0);
    // Frame hold ("on twos"): last hold bucket drawn — draws within the same bucket are skipped
    // while playing (see VideoProps.holdFps).
    const holdBucketRef = useRef(-1);
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

    // Same-source-stack flag, read inside the watchdog interval closure (which doesn't re-subscribe
    // when this prop flips). Element-path only; the WC path is already transport-frame-locked.
    const strictSourceSyncRef = useRef(false);
    strictSourceSyncRef.current = props.mediaType === "video" ? (props.strictSourceSync ?? false) : false;

    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const rendererRef = useRef<MediaWebGLRenderer | null>(null);
    const sourceVideoRef = useRef<HTMLVideoElement | null>(null);
    const matteVideoRef = useRef<HTMLVideoElement | null>(null);
    // Decoded still source. Preferred form is a pre-flipped, downscale-capped ImageBitmap (see the
    // image effect below); the raw <img> element is the fallback for engines without bitmap options.
    const imageRef = useRef<{ source: TexImageSource; width: number; height: number } | null>(null);
    // Animated (SMIL) vector graphics: pre-baked frame bitmaps + the cycle they were sampled over. The
    // playhead selects a frame at composite time (graphicAnimationFrame) — identical math to local
    // export + Remotion, so preview stays pixel-aligned. `epoch` invalidates the compositor's re-grade
    // skip when a recolor re-bakes the sequence (same frame index, different pixels).
    const graphicFramesRef = useRef<{ frames: ImageBitmap[]; epoch: number } | null>(null);
    const graphicBakeEpochRef = useRef(0);
    const graphic = mediaType === "image" ? props.graphic : undefined;
    const graphicStartSeconds = mediaType === "image" ? (props.graphicStartSeconds ?? 0) : 0;
    const graphicPlan =
      mediaType === "image"
        ? resolveGraphicAnimation(graphic, { animations: props.graphicAnimations })
        : null;
    // Re-bake signature: recolor (fill/palette), a new SVG, or anything that changes the BAKED SEQUENCE.
    // Loop mode changes the bake times ([0,cycle) wrapping vs [0,cycle] inclusive) and keyframes change
    // frameCount (via the slowest cycle) — phase itself is read live, so keyframe TIMES/VALUES don't
    // need a re-bake beyond that.
    const graphicBakeSig = graphic && graphicPlan
      ? `${graphic.svg.length}|${graphic.fill}|${JSON.stringify(graphic.palette ?? [])}|${graphicPlan.naturalCycleSeconds}|${graphicPlan.loop}|${graphicPlan.frameCount}`
      : "";
    // The compositor's snapshot() closure is created once per (singleCtx, mediaType) — it would otherwise
    // pin the plan + clip start from THAT render, so live keyframe edits (and a clip drag) never reached
    // frame selection. Frames are baked from the signature above; the PHASE is always read live.
    const graphicPlanRef = useRef<GraphicAnimationPlan | null>(null);
    graphicPlanRef.current = graphicPlan;
    const graphicStartRef = useRef(0);
    graphicStartRef.current = graphicStartSeconds;
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
    /**
     * TEMPORAL COHERENCE (2026-07-28): the source-media time the CURRENTLY HELD WC frame represents.
     * Null until the first frame is presented.
     *
     * Derived at PRESENT time as `requestedSourceTime − lastFrameLagSeconds`, not read at snapshot time.
     * That matters: `lastFrameLagSeconds` describes how far the served frame trailed the request that
     * produced it, so reading it later would answer "how stale was that frame when it arrived", not
     * "how stale is what I'm showing now". Recording it at present time means a request still IN FLIGHT
     * for a newer playhead leaves this pinned at the older served time — which is exactly the staleness
     * the present gate has to see. Reading the lag lazily would silently understate it to zero.
     */
    const servedSourceTimeRef = useRef<number | null>(null);
    // TRACE ONLY: previous lease-effect inputs, so a re-run can be classified (mount / src-change /
    // epoch-bump). Never read by any decision.
    const leaseRunRef = useRef(0);
    const leaseSrcRef = useRef<string | null>(null);
    const leaseEpochRef = useRef(-1);
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
      // Drop the served-time stamp with the frame it described, so a cleared/re-leased provider can
      // never leave a stale time attached to whatever frame arrives next. Set on present (below).
      if (!next) servedSourceTimeRef.current = null;
    }
    const wcBusyRef = useRef(false);
    const wcRerequestRef = useRef(false);
    const wcNullCountRef = useRef(0);
    // Wall-clock start of the current in-flight getFrame (null = none). A promise that never
    // settles wedges the layer with total silence — the watchdog uses this to detect it.
    const wcInFlightSinceMsRef = useRef<number | null>(null);
    // Pending retry timer for the paused null-frame march (see the null branch in requestWcFrame).
    const wcNullRetryTimerRef = useRef<number | null>(null);
    /**
     * Consecutive backed-off retries on a `tolerateLag` layer that can neither converge nor bail.
     *
     * Those layers must never take the <video> path (the ~16-context cap = the permanent freeze), so
     * their stale-bail and null branches re-probe WebCodecs forever instead of falling back. That is
     * right, but both were unpaced: the stale-bail set `wcRerequestRef`, which the SAME `.then()`
     * consumes a few lines later and re-requests synchronously — a zero-delay recursion, not a retry.
     * Paused, on a source that cannot converge, it spins the main thread indefinitely; combined with a
     * fast scrub (which resets the decoder on nearly every tick) that is a large share of the "page
     * isn't responding" stall. Retries now back off geometrically and reset the moment a frame
     * actually presents, so a source that recovers pays nothing and one that never does costs ~1/s.
     */
    const wcTolerateRetryRef = useRef(0);
    const wcTolerateRetryTimerRef = useRef<number | null>(null);
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
    const wcTimeRef = useRef({ currentTime: 0, start: 0, sourceIn: 0, speed: 1, preroll: 0, isPlaying: false });
    if (mediaType === "video") {
      wcTimeRef.current = {
        currentTime: props.currentTime,
        start: props.layerStartSeconds,
        sourceIn: props.sourceInSeconds ?? 0,
        speed: props.speedFactor ?? 1,
        preroll: props.prerollSeconds ?? 0,
        isPlaying: props.isPlaying,
      };
    }

    // R3.2: the ONE source-time mapping every internal consumer (WC frame requests, watchdog,
    // reprime, settle, matte sync, late fallback) must use — timeline time → source-media seconds,
    // pre-roll-aware. Local time may go down to −preroll (the clip plays its head-handle material
    // ahead of its own start during a transition pre-roll); the outer floor at 0 is the ASSET's real
    // start (repeated frames only when material is truly absent). With preroll 0 this is exactly the
    // legacy `sourceIn + max(0, t − start) · speed`. MUST stay equivalent to the parent PreviewLayer's
    // `resolveSourceSeconds`, which drives the element's play/seek — a divergent mapping here makes
    // the watchdog fight the parent and yank the picture back to the in-point.
    const mapSourceTime = (tp: { currentTime: number; start: number; sourceIn: number; speed: number; preroll: number }, timelineTime = tp.currentTime) =>
      Math.max(0, tp.sourceIn + Math.max(-tp.preroll, timelineTime - tp.start) * tp.speed);

    /**
     * TEMPORAL COHERENCE (2026-07-28): how far the held frame is from the one the LIVE playhead asks
     * for, in TIMELINE seconds — the signal `ScenePreviewMediaSnapshot.stalenessSeconds` carries to
     * the present gate. The math (and the reasoning behind subtracting a frame period) lives in
     * `playback/temporal-coherence.ts` so it stays pure and testable; this only supplies the inputs
     * this layer owns: the request mapping, the playback rate, and the provider's own frame rate.
     */
    const computeStalenessSeconds = (servedSourceTime: number | null): number | null => {
      const tp = wcTimeRef.current;
      // Media end for the tail clamp. The provider's demuxed `decodableEndSeconds` is the TRUE last
      // decodable sample (the same value `scene-frame-compositor` treats as the asset's media end);
      // the element's `duration` is the fallback when no provider exists. Either may be absent, and
      // absent simply skips the clamp.
      const el = sourceVideoRef.current;
      const elDuration = el && Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null;
      const mediaEndSeconds = wcProviderRef.current?.decodableEndSeconds ?? elDuration;
      return stalenessSeconds({
        requestedSourceTime: mapSourceTime(tp),
        servedSourceTime,
        framePeriodSeconds: sourceFramePeriodSeconds(wcProviderRef.current?.nominalFps),
        speed: tp.speed,
        mediaEndSeconds,
      });
    };

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
      // TRACE ONLY (2026-07-28): classify WHY this lease effect is running. It is the ONLY place a
      // preview decoder lease is taken, so its reason IS the initiator of a provider acquire/release
      // cycle — which is the one thing the measurements so far could not name.
      //
      // Deps are [mediaType, src] (NOT wcEpoch — that drives the element-bound effects below), and
      // `src` is this component's React `key` upstream (`key={mediaUrl}` in VideoPreview). So a URL
      // change tears the instance down and builds a new one: it shows up as a fresh "mount", not a
      // "src-change" re-run. Reading the timeline:
      //   repeated "mount" for one asset  → the layer is being REMOUNTED under a changing mediaUrl
      //                                     (the proxy↔original swap hypothesis)
      //   "src-change"                    → a re-run without a remount, i.e. some path is NOT keyed
      //   pool evict/preempt with no      → the POOL is initiating, not React
      //     layer event nearby
      // `wcEpoch` is carried in the note so a bump that does NOT re-run this effect is still visible.
      const leaseReason: ProviderTraceReason =
        leaseRunRef.current === 0
          ? "mount"
          : leaseSrcRef.current !== src
            ? "src-change"
            : leaseEpochRef.current !== wcEpoch
              ? "epoch-bump"
              : "unknown";
      leaseRunRef.current += 1;
      leaseSrcRef.current = src;
      leaseEpochRef.current = wcEpoch;
      traceEvent({
        event: "layer:effect",
        asset: traceAsset(src),
        reason: leaseReason,
        currentTime: wcTimeRef.current.currentTime,
        note: `run#${leaseRunRef.current} epoch=${wcEpoch}`,
      });
      cleanups.push(() =>
        traceEvent({
          event: "layer:cleanup",
          asset: traceAsset(src),
          reason: disposed ? "unmount" : "unknown",
          currentTime: wcTimeRef.current.currentTime,
          note: `run#${leaseRunRef.current}`,
        })
      );

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
            setMediaPlaybackRate(lease.video, tp.speed);
            lease.video.currentTime = mapSourceTime(tp);
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
      // `wcBailedSources` is keyed by media URL and module-global, so a HOST clip that bailed poisons
      // every other layer on the same asset — including a Flarex virtual loader (a comp routinely loads
      // the same file as both host and MediaIn source). Sending a loader to a native <video> is the
      // ~16-context cap → permanent freeze this whole path exists to avoid, so `tolerateLag` layers
      // ignore the bail list; their own heals never add to it either (see requestWcFrame).
      // `tolerateLag` marks a Flarex virtual loader, and the rule stated forty lines below — "virtual
      // loaders must NEVER take the <video> path" — was enforced on the BAILED branch only. The
      // `preferNativeDecode` branch bypassed it, so any condition setting that flag put every loader in
      // a comp onto native elements at once, straight through the browser's ~16 hardware-decode-context
      // cap. Full-quality playback is exactly such a condition: it swaps `mediaUrl` to the original, and
      // `preferNativeDecode` is `mediaUrl !== proxyUrl`, so selecting "1" moved EVERY source in the comp
      // to the element path in one step (2026-07-28).
      //
      // For a loader the choice is not element-vs-pool, it is which failure: a sparse-GOP original on the
      // pool seeks slowly, but `tolerateLag` is built for exactly that and presents advancing frames. The
      // element path has no such degradation — it hits a hard cap and freezes. A slow source is a
      // degradation; a capped one is an outage.
      const forceElementPath =
        mediaType === "video" &&
        !props.tolerateLag &&
        (props.preferNativeDecode || wcBailedSources.has(src));
      const wcLease = forceElementPath
        ? null
        : acquirePreviewFrameProvider(src, {
            priority: hiddenAtMountRef.current ? "preload" : "playhead",
            onPreempted: () => wcFallbackRef.current(),
            // Virtual loaders decode in SOFTWARE so they don't contend with the host for the one
            // hardware H.264 block (the confirmed multi-source freeze cause — see preferSoftwareDecode).
            preferSoftware: props.preferSoftwareDecode,
            // A retimed loader shares the host's URL and by construction never its time.
            exclusive: props.exclusiveDecode,
          });
      wcLeaseRef.current = wcLease;
      if (mediaType === "video") {
        // The SESSION's mode, not `preferSoftwareDecode`. A loader that attached to the host's
        // hardware session asked for software and got hardware; reporting the request made a share
        // invisible in the exact table you would read to see one (2026-07-28).
        wcModeRef.current = !wcLease ? "element" : wcLease.session.software ? "wc-sw" : "wc-hw";
        retainWcMode(src);
        cleanups.push(() => releaseWcMode(src));
        recordWcMode(src, wcModeRef.current);
      }
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
          wcModeRef.current = "element";
          recordWcMode(src, "element");
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
          if (wcTolerateRetryTimerRef.current !== null) {
            window.clearTimeout(wcTolerateRetryTimerRef.current);
            wcTolerateRetryTimerRef.current = null;
          }
          if (wcRerequestRafRef.current !== null) {
            cancelAnimationFrame(wcRerequestRafRef.current);
            wcRerequestRafRef.current = null;
            wcRerequestPendingRef.current = false;
          }
          wcTolerateRetryRef.current = 0;
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

    // Media-fps telemetry (HUD "Media" row): count NEW presented video frames via
    // requestVideoFrameCallback while PLAYING. The compositor's FPS row runs at display refresh and
    // redraws unchanged frames — this is the number that exposes a low-cadence source/proxy
    // (30fps proxy under a 75Hz compositor: FPS 75, Media 30 — the 2026-07-19 report's gap).
    useEffect(() => {
      const video = sourceVideoRef.current as VideoFrameCapableElement | null;
      const playing = "isPlaying" in props ? props.isPlaying === true : false;
      if (!video || mediaType !== "video" || !playing || !video.requestVideoFrameCallback) return;
      let cancelled = false;
      let handle = 0;
      const tick = () => {
        if (cancelled) return;
        recordMediaFrame();
        handle = video.requestVideoFrameCallback!(tick);
      };
      handle = video.requestVideoFrameCallback(tick);
      return () => {
        cancelled = true;
        video.cancelVideoFrameCallback?.(handle);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, ["isPlaying" in props ? props.isPlaying : false, mediaType, src, wcEpoch]);

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
    const pipelineKey = useMemo(() => colorPipelineCacheKey(pipeline), [pipeline]);
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
      // Animated graphics own the image source via their pre-baked frame sequence (below) — skip the
      // static still decode so the two don't fight over imageRef.
      if (graphicPlan) return undefined;
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
            if (!cancelled) console.warn("[orreris] still decode failed — layer stays empty:", src.slice(0, 128), error);
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

    // ── ANIMATED GRAPHIC: pre-bake the SMIL cycle, select a frame per playhead ─────────────────────
    // Bake the frame sequence once (re-bake on recolor / svg change via graphicBakeSig). The playhead
    // then selects a frame at composite time (selectGraphicFrame) — no per-frame SVG decode on the hot path.
    useEffect(() => {
      if (mediaType !== "image" || !graphic || !graphicPlan) return undefined;
      let cancelled = false;
      const epoch = (graphicBakeEpochRef.current += 1);
      const plan = graphicPlan;
      void (async () => {
        const frames = await bakeAnimatedGraphicFrames(graphic, plan, GRAPHIC_ANIM_PREVIEW_EDGE, () => cancelled);
        if (cancelled) {
          for (const f of frames) f.close();
          return;
        }
        const prev = graphicFramesRef.current;
        graphicFramesRef.current = frames.length ? { frames, epoch } : null;
        for (const f of prev?.frames ?? []) f.close();
        const sel = selectGraphicFrame();
        if (sel) imageRef.current = { source: sel.source, width: sel.width, height: sel.height };
        if (singleCtx) publishSceneFrame();
        else drawImage();
      })();
      return () => {
        cancelled = true;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mediaType, graphicBakeSig]);

    // Close baked frames on unmount.
    useEffect(
      () => () => {
        for (const f of graphicFramesRef.current?.frames ?? []) f.close();
        graphicFramesRef.current = null;
      },
      []
    );

    // Re-select the animated-graphic frame as the playhead moves (playback AND scrub): single-ctx just
    // re-arms the compositor (its snapshot reads selectGraphicFrame live); the legacy path repaints.
    useEffect(() => {
      if (mediaType !== "image" || !graphicPlan) return undefined;
      return subscribePlaybackClock(() => {
        if (!graphicFramesRef.current) return;
        if (singleCtx) sceneSinkRef.current?.onFrame();
        else drawImage();
      });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mediaType, graphicPlan === null, singleCtx]);

    /** The animated-graphic frame for the current playhead (clip-local time → shared frame math), or null
     *  when the layer isn't an animated graphic / hasn't baked yet. */
    function selectGraphicFrame(): { source: ImageBitmap; width: number; height: number; frameIndex: number; epoch: number } | null {
      const baked = graphicFramesRef.current;
      // LIVE plan + start (not the baked plan): a keyframe edit changes the phase without changing the
      // frame sequence, so selection must read current values while the bitmaps stay cached.
      const plan = graphicPlanRef.current;
      if (!baked || !plan || baked.frames.length === 0) return null;
      const frameIndex = graphicAnimationFrameAt(plan, getLivePlaybackTime() - graphicStartRef.current);
      const bmp = baked.frames[Math.min(frameIndex, baked.frames.length - 1)]!;
      return { source: bmp, width: bmp.width, height: bmp.height, frameIndex, epoch: baked.epoch };
    }

    function drawImage() {
      if (failedRef.current) return;
      // Animated graphic → the playhead-selected frame; otherwise the decoded still.
      const animated = selectGraphicFrame();
      const still = animated ?? imageRef.current;
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
    const prerollSeconds = mediaType === "video" ? (props.prerollSeconds ?? 0) : 0;

    // Sync matte video time to source video (speed-aware, same mapping as the source element).
    useEffect(() => {
      if (mediaType !== "video" || !matte?.uri) return;
      const matteVideo = matteVideoRef.current;
      if (!matteVideo) return;
      setMediaPlaybackRate(matteVideo, speedFactor);
      // A windowed matte (Remove Background "Used in timeline") is 0-based over [startSeconds, …] of
      // the source, so shift the source time by the matte's own start. 0/absent = full-source matte.
      const matteStart = matte?.startSeconds ?? 0;
      const nextTime = Math.max(0, sourceInSeconds - matteStart + Math.max(-prerollSeconds, currentTime - layerStartSeconds) * speedFactor);
      if (Number.isFinite(nextTime) && Math.abs(matteVideo.currentTime - nextTime) > 0.08 * Math.max(1, speedFactor)) {
        matteVideo.currentTime = nextTime;
      }
    }, [currentTime, layerStartSeconds, mediaType, matte?.uri, matte?.startSeconds, sourceInSeconds, speedFactor, prerollSeconds]);

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
    /** Can this layer ever produce a full-res settle frame? See the assignment in the singleCtx block. */
    const settleCapableRef = useRef(false);
    /**
     * This layer's live decode path, mirrored onto the scene snapshot (2026-07-28).
     *
     * `__rfWcMode` records the same value keyed by SOURCE URL, while the frame profiler names a
     * stalled source by its NODE id — and nothing joined the two, so "which decode path is the
     * stalling node on?" could not be answered from the console at all. The node id is not visible in
     * the graph UI either, so the question was unanswerable from both ends at once. Carrying the mode
     * on the snapshot lets the consumer key it by the same id it already uses for everything else.
     */
    const wcModeRef = useRef<"wc-hw" | "wc-sw" | "element" | null>(null);
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
        const target = mapSourceTime(tp);
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
    // Counter+ring only; console output behind `orreris.perfLog`.
    useEffect(() => {
      if (mediaType !== "video" || hidden) return undefined;
      const FREEZE_BEHIND_S = 1.0;
      // Same defect v32q fixed in `__rfSourceMap`: a url tail is a filename for a library asset and an
      // opaque per-session blob UUID for anything OPFS-backed, so the ONE line that names a frozen
      // source named nothing. Two reproductions of the same wedge printed two unrelated-looking ids.
      const srcTail = props.assetLabel ?? (src.length > 48 ? `…${src.slice(-48)}` : src);
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
          if (localStorage.getItem("orreris.perfLog") === "1") {
            console.warn(`[perf] live layer frozen ${behind.toFixed(2)}s behind @ t=${timelineS.toFixed(2)}s (${String(detail.mode)})`, detail);
          }
        } catch {
          /* storage unavailable — counters still recorded */
        }
      };
      // Element-path nudge rate limit (SELF-HEAL 3 below) — per effect lifetime is fine: a src/epoch
      // change re-arms it, which is exactly when a fresh nudge should be allowed anyway.
      let elementNudgeAtMs = 0;
      // Same-source-stack sync rate limit (see strictSourceSyncRef). Independent of the freeze nudge
      // so a stacked twin can re-align without waiting on the 1s/2.5s freeze machinery.
      let strictSyncAtMs = 0;
      const STRICT_SYNC_DRIFT_S = 0.05; // ~1.5 frames at 30fps — below this the ghost isn't visible
      const STRICT_SYNC_MIN_INTERVAL_MS = 700; // gentle: at most ~1 corrective seek/sec while drifting
      const interval = window.setInterval(() => {
        const tp = wcTimeRef.current;
        const nowMs = performance.now();
        const expected = mapSourceTime(tp);
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
          // Virtual loaders (tolerateLag) must NEVER take the <video> path: a comp composites many
          // sources at once, and native elements blow the browser's ~16 hardware-decode-context cap —
          // which is the very freeze we're fixing. A wedge here is a SLOW decode (contended / software),
          // not a permanent hang (the decode loop is guard-bounded and its flush races a 5s timeout), so
          // just clear the stuck-busy flag and let the rAF loop re-request on WC. The slow decode drains
          // and the picture advances at a lower frame rate instead of freezing on a dead native element.
          if (!props.tolerateLag) wcFallbackRef.current();
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

        // SAME-SOURCE STACK SYNC: a clip stacked over itself (same asset on 2+ active layers) ghosts
        // when one layer is on the <video> element path and its clock free-runs a few frames off its
        // twin. Keep the element tight to the transport's LIVE clock (what the WC path targets), hard-
        // seeking only past ~1.5 frames of drift and rate-limited. Runs BEFORE the freeze early-return
        // so a sub-1s drift still corrects; gated to stacked assets so single clips never pay for it.
        if (strictSourceSyncRef.current && video && tp.isPlaying && !video.ended && video.readyState >= 1) {
          let liveTime = tp.currentTime;
          const live = getLivePlaybackTime();
          if (Math.abs(live - tp.currentTime) < WC_LIVE_CLOCK_MAX_DIVERGENCE_S) liveTime = live;
          const expectedLive = mapSourceTime(tp, liveTime);
          if (Math.abs(expectedLive - video.currentTime) > STRICT_SYNC_DRIFT_S && nowMs - strictSyncAtMs > STRICT_SYNC_MIN_INTERVAL_MS) {
            strictSyncAtMs = nowMs;
            if (typeof window !== "undefined") {
              const w = window as { __rfStrictSyncCorrections?: number };
              w.__rfStrictSyncCorrections = (w.__rfStrictSyncCorrections ?? 0) + 1;
            }
            try {
              video.currentTime = expectedLive;
            } catch {
              /* transient seek failure — next watchdog tick retries */
            }
            if (video.paused) void video.play().catch(() => undefined);
            drawVideoFrameRef.current();
          }
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
            // Virtual loaders never go native (16-context cap → freeze) — clear the wedge and re-request
            // on WC below instead of bailing. See the watchdog's busyWedge heal for the full rationale.
            if (!props.tolerateLag) {
              wcFallbackRef.current();
              return;
            }
          }
          requestWcFrameRef.current();
          return;
        }
        const video = sourceVideoRef.current;
        if (!video) return;
        const expected = mapSourceTime(tp);
        // Reprime is an explicit "snap NOW" signal (coverage-exit, track-visibility toggle), not a
        // per-frame path — so use a TIGHT threshold (~1.5 frames) instead of the watchdog's coarse
        // 0.3s. This is what re-aligns a freshly-revealed overlay with a same-source base clip whose
        // element kept decoding: a 3–4 frame drift ghosts under a soft-light stack, and 0.3s let it
        // slide. The cost is at most one extra element seek per reprime event (never during normal
        // playback), so it can't reintroduce the seek-storm the 0.3s guard was protecting against.
        const REPRIME_MAX_DRIFT_S = 0.05; // ~1.5 frames at 30fps — tight enough to kill the ghost
        if (video.readyState >= 1 && Math.abs(video.currentTime - expected) > REPRIME_MAX_DRIFT_S) {
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
     *
     * `servedSourceTime` is the source-media time the returned frame actually represents (null when the
     * path can't know) — the temporal-coherence signal the scene snapshot forwards to the present gate.
     * It is per-BRANCH because each source knows its own time differently: the settle/element paths park
     * a real `<video>` whose `currentTime` IS the served time, while the WC path has to derive it from
     * the request that produced the held frame (see `servedSourceTimeRef`).
     */
    function selectVideoDrawSource(
      /**
       * ATOMIC FULL-RES SWAP (2026-07-28). The legacy own-canvas path passes true and keeps the
       * original behaviour: this layer applies its own settle frame as soon as it lands. The
       * single-context path passes FALSE and publishes the settle frame separately as
       * `fullResFrame`, because there the swap is a viewer-wide decision — several MediaIn sources
       * must sharpen in ONE composite, and only `ScenePreviewCanvas` knows the participating set.
       */
      includeSettle = true
    ): { source: CanvasImageSource; width: number; height: number; servedSourceTime: number | null } | null {
      const wcFrame = wcFrameRef.current;
      // Belt-and-braces: a closed VideoFrame reports format:null — never hand it to texImage2D.
      const wcFrameClosed =
        wcFrame !== null && typeof VideoFrame !== "undefined" && wcFrame.source instanceof VideoFrame && wcFrame.source.format === null;
      // Source selection order: full-res settle frame (paused only) → WC frame → element. The settle
      // ref is cleared synchronously on any transport movement (see the settle effect), so the paused
      // check is belt-and-braces against a draw racing the play flip.
      const settle = includeSettle ? settleSourceRef.current : null;
      if (settle && !wcTimeRef.current.isPlaying && settle.width > 0 && settle.height > 0) {
        // The settle source IS a pooled <video> parked on the requested frame by an exact native seek,
        // so its own currentTime is the served time — no derivation needed.
        const el = settle.source as HTMLVideoElement;
        const served = typeof el.currentTime === "number" ? el.currentTime : null;
        return { source: settle.source, width: settle.width, height: settle.height, servedSourceTime: served };
      }
      if (wcFrame && !wcFrameClosed && wcFrame.width > 0 && wcFrame.height > 0) {
        return { source: wcFrame.source, width: wcFrame.width, height: wcFrame.height, servedSourceTime: servedSourceTimeRef.current };
      }
      const video = sourceVideoRef.current;
      if (!video || video.readyState < 2 || video.videoWidth === 0) return null;
      // STALE FALLBACK ELEMENT (2026-07-28). A pooled element sits wherever its last owner left it.
      // When a WC provider exists this element is only a stopgap, and drawing it while it is seconds
      // from the requested time paints a different shot entirely — measured 21.0s out, and the cause
      // of 141 of 144 per-source write-offs (the barrier refused to call it coherent, then timed out).
      // Refusing it hands the not-ready path a HOLD instead, which keeps the last graded texture
      // rather than painting the wrong one. See ELEMENT_FALLBACK_MAX_LAG_S for why the bound is loose.
      if (wcProviderRef.current) {
        const requested = mapSourceTime(wcTimeRef.current);
        if (Number.isFinite(requested) && Math.abs(video.currentTime - requested) > ELEMENT_FALLBACK_MAX_LAG_S) {
          return null;
        }
      }
      return { source: video, width: video.videoWidth, height: video.videoHeight, servedSourceTime: video.currentTime };
    }

    function drawVideoFrame() {
      if (failedRef.current || mediaType !== "video") return;
      // Frame hold ("on twos"): while playing, only the first frame of each hold bucket draws —
      // the previous graded/published frame stays on screen (its version doesn't bump, so the
      // compositor reuses the cached texture). Paused repaints bypass so edits stay live.
      if (props.mediaType === "video" && props.holdFps && props.isPlaying) {
        const video = sourceVideoRef.current;
        if (video && video.readyState >= 2) {
          const speed = Math.abs(props.speedFactor || 1) || 1;
          const local = Math.max(0, (video.currentTime - (props.sourceInSeconds ?? 0)) / speed);
          const bucket = Math.floor(local * props.holdFps);
          if (bucket === holdBucketRef.current) return;
          holdBucketRef.current = bucket;
        }
      }
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

    /**
     * Re-probe WebCodecs after a geometric delay, for the `tolerateLag` paths that must never fall back
     * to a <video> element (see wcTolerateRetryRef). 100ms doubling to a 1s ceiling: a source that is
     * one slow decode away recovers on the first retry, and one that never converges settles at about
     * one probe per second instead of spinning. Idempotent — a pending timer is never stacked.
     */
    function scheduleTolerantRetry() {
      if (wcTolerateRetryTimerRef.current !== null) return;
      const attempt = wcTolerateRetryRef.current;
      wcTolerateRetryRef.current = Math.min(attempt + 1, 4);
      const delayMs = Math.min(1000, 100 * 2 ** attempt);
      wcTolerateRetryTimerRef.current = window.setTimeout(() => {
        wcTolerateRetryTimerRef.current = null;
        if (wcProviderRef.current) requestWcFrameRef.current();
      }, delayMs);
    }

    // WebCodecs frame request (stage 2): single in-flight decode, latest transport time wins.
    // A resolved frame belongs to the provider (valid until its NEXT getFrame), so we draw it
    // immediately and keep it referenced for paused repaints (pipeline/effect changes).
    /**
     * Re-arm the frame request after a macrotask, instead of synchronously inside the `.then()`.
     *
     * Coalescing is the point of the pending flag: several sources of a re-request (scrub tick,
     * paused hold, stale bail) can all fire before the yield lands, and they must produce ONE
     * follow-up request, not a queue of them — a queue would restore the occupancy this fixes.
     * `requestWcFrame` reads the LIVE playhead when it runs, so a coalesced re-request is not a
     * dropped one: the single follow-up asks for the newest time, which is what the viewer wants
     * anyway during a scrub.
     */
    const wcRerequestPendingRef = useRef(false);
    /**
     * `"task"` = a real request arrived while one was in flight; the follow-up should run as soon as
     * the loop allows, because something outside asked for a newer time.
     *
     * `"frame"` = the layer is re-asking on its OWN behalf (the lag-tolerant degraded path and the
     * catch-up holds). Those are paced to the DISPLAY, and the reason is a hard bound rather than a
     * tuning preference: a layer can only show one frame per composite, so a self-driven retry that
     * runs faster than the display is producing frames nothing will ever see.
     *
     * Measured 2026-07-29, and it is not a small effect. A 2× retimed loader sits permanently above
     * `WC_HOLD_LAG_S` — a seek-on-demand decoder trails its request by roughly one decode, and at rate
     * R that trail is R× further in source seconds — so the tolerant branch presented AND re-armed on
     * every single iteration. Paced only by a macrotask, it ran ~70 times per composited frame
     * (`__rfSourceMap` frame versions: v1820 → v6154 over 62 composites, against exactly 1/frame for
     * both un-retimed sources beside it). Every one of those publishes a frame version and re-arms a
     * scene recomposite. That is the residual stutter: not decode, not GPU, just a loop with no bound.
     *
     * This does NOT weaken "never freeze-hold" (v30): the layer still re-requests continuously and
     * still presents the latest advancing frame — once per displayed frame, which is all a display can
     * take. A source that converges never sets the flag at all and is untouched.
     *
     * APPLIES TO THE CATCH-UP HOLD BRANCHES TOO (2026-07-29). They were left on task pacing one round
     * earlier because they do not present per pass, so they churn no frame versions — and I said in
     * the tracker that I had not measured them doing harm. Then I measured them: `__rfWcHolds` at
     * 658,265 and `scheduleWcRerequest` as 53 of 71 samples inside a 1.6s MAIN THREAD BLOCKED report.
     * Not presenting is not the same as not costing; the loop alone was the stall.
     *
     * The tail clamp in `requestWcFrame` removes the condition that made them unsatisfiable, so this
     * is now defence in depth rather than the fix. Keeping it: any future non-convergent state should
     * degrade to one retry per displayed frame, not saturate the main thread. The hidden-tab caveat
     * stands (rAF does not fire when hidden, a macrotask does) and is the right trade — a backgrounded
     * tab has nothing to show, and the freeze watchdog still heals on return.
     */
    const wcRerequestPaceRef = useRef<"task" | "frame">("task");
    const wcRerequestRafRef = useRef<number | null>(null);
    function scheduleWcRerequest() {
      if (wcRerequestPendingRef.current) return;
      wcRerequestPendingRef.current = true;
      const fire = () => {
        wcRerequestPendingRef.current = false;
        wcRerequestRafRef.current = null;
        // Back to the SAFE default. "frame" is a claim about one specific retry, not a mode the layer
        // stays in — leaving it latched would slow a genuine external request behind a display frame.
        wcRerequestPaceRef.current = "task";
        // The provider can be disposed across the yield (unmount, src change, pool eviction); the
        // null check is the same guard the null-frame retry timer already uses.
        if (wcProviderRef.current) requestWcFrameRef.current();
      };
      if (wcRerequestPaceRef.current === "frame" && typeof requestAnimationFrame === "function") {
        wcRerequestRafRef.current = requestAnimationFrame(fire);
        return;
      }
      void yieldTask().then(fire);
    }

    function requestWcFrame() {
      const provider = wcProviderRef.current;
      if (!provider || mediaType !== "video") return;
      if (wcBusyRef.current) {
        wcRerequestPaceRef.current = "task"; // an OUTSIDE request arrived mid-decode — not self-driven
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
        else recordWcStaleTime(src);
      }
      // TAIL CLAMP ON THE REQUEST (2026-07-29). `mapSourceTime` floors at 0 and at −preroll but has
      // NO ceiling, so once the playhead passes a clip's material the requested source time keeps
      // climbing while the decoder — correctly — serves the last decodable frame forever. The gap is
      // reported as `lastFrameLagSeconds` and it grows without bound: measured 6.07s behind, worst
      // 18.47s, on a source that was showing exactly the right picture.
      //
      // That manufactured lag is what drove the hold policy: permanently over `WC_HOLD_LAG_S`,
      // permanently re-arming, `__rfWcHolds` at 658,265 and `scheduleWcRerequest` as 53 of 71 samples
      // in a 1.6s main-thread block. The picture was never wrong; the ERROR SIGNAL was.
      //
      // `temporal-coherence.ts` already made exactly this correction for the staleness INSTRUMENT and
      // wrote down why: "a request outside the material in EITHER direction is served by the nearest
      // real frame, and that frame is correct." The request path never got it, so the instrument read
      // clean while the policy it shares a cause with span. Same clamp, same source of truth
      // (`decodableEndSeconds`), now applied where the lag is actually generated.
      //
      // A retime is what made this reachable: at rate R a clip runs off the end of its material R×
      // sooner, so 2× found in seconds what 1× would take minutes of tail to reach.
      const mediaEnd = provider.decodableEndSeconds;
      const rawSourceTime = mapSourceTime(tp, timelineTime);
      const sourceTime =
        mediaEnd != null && Number.isFinite(mediaEnd) && mediaEnd > 0 ? Math.min(rawSourceTime, mediaEnd) : rawSourceTime;
      void provider
        .getFrame(sourceTime)
        .then((frame) => {
          wcBusyRef.current = false;
          wcInFlightSinceMsRef.current = null;
          if (wcProviderRef.current !== provider) return; // released/fell back mid-decode
          if (frame) {
            wcNullCountRef.current = 0;
            // S2 REVERSE (Premiere-style smooth reverse): sustained reverse playback is EXPECTED
            // backward motion, not a scrub-back transient. mapSourceTime with a signed (negative)
            // speed already walks the source target DOWNWARD, and the decoder's reverse-shuttle cache
            // serves those decreasing targets — so present each returned frame DIRECTLY and skip the
            // forward-only rewind hold below (which would freeze/fast-forward-pan every reverse tick).
            // Degrades by dropping frames when decode can't keep up, never by freezing — like Premiere.
            const reversedPlayback = tp.isPlaying && tp.speed < 0;
            if (reversedPlayback) wcHoldStartRef.current = null;
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
            //
            // NORMALIZED TO TIMELINE SECONDS (2026-07-29). `lastFrameLagSeconds` is measured in SOURCE
            // seconds — requested source time minus the served frame's own timestamp — while
            // `WC_HOLD_LAG_S` is a tolerance for how far behind the VIEWER the picture may fall. Those
            // are the same number only at rate 1. At rate R a physically identical delay of one decode
            // reads R× larger, so a 2× loader crossed a 0.35s bar at 0.175s of real lateness and sat
            // permanently on the degraded branch — presenting stale-but-advancing frames forever, which
            // is precisely the "left plume freeze-plays while the right one is smooth" report, the two
            // being the same file at 2× and 1×.
            //
            // `stalenessSeconds` already states this rule and applies it ("Playback rate; converts
            // source seconds to timeline seconds so sources are comparable"). The hold POLICY simply
            // never got the same treatment, because until TimeSpeed no preview source ran at a rate
            // other than its clip's own — and a clip's rate reaches this file through `speedFactor`,
            // which the pre-retime code had no reason to consult here.
            //
            // `sourceLag` stays RAW and is the only thing allowed near `servedSourceTimeRef`: that ref
            // is a SOURCE time, and it feeds `stalenessSeconds`, which divides by the rate itself.
            // Stamping it with an already-normalized lag would divide twice and quietly under-report
            // staleness to the coherence gate — a gate reading clean while the picture is wrong is
            // worse than no gate.
            const sourceLag = provider.lastFrameLagSeconds ?? 0;
            const lagRate = Math.abs(tp.speed) > 0 && Number.isFinite(tp.speed) ? Math.abs(tp.speed) : 1;
            const lag = sourceLag / lagRate;
            const nowMs = performance.now();
            if (wcHoldStartRef.current !== null) {
              const streakMs = nowMs - wcHoldStartRef.current;
              const stalled = tp.isPlaying
                ? // Catastrophic divergence (3s behind / 10s), OR a SUSTAINED moderate hold: a high-fps
                  // proxy the pool can't sustain never reaches 3s but sits > WC_HOLD_LAG_S for seconds.
                  (lag > WC_DIVERGE_LAG_S && streakMs > WC_DIVERGE_MAX_MS) ||
                  (lag > WC_HOLD_LAG_S && streakMs > WC_SUSTAINED_HOLD_BAIL_MS)
                : lag > WC_PAUSED_STALE_LAG_S && streakMs > WC_PAUSED_STALE_MAX_MS;
              if (stalled) {
                // This source can't be served by WebCodecs here (diverging / non-converging hold while
                // playing, or unable to close a fixed gap while paused) — hand the layer to the element
                // path. Remember it (playing case) so a re-mount skips WC and avoids repeating the hitch.
                recordWcHeal(tp.isPlaying ? "divergence" : "pausedStall");
                // Virtual loaders never go native (the ~16-context cap = the permanent freeze this whole
                // path exists to avoid). Now that a PAUSED loader can reach this branch (see the hold
                // scoping above), the guard matters here too: keep probing WC so it converges on its own
                // instead of being handed a <video> element it may not even be able to allocate.
                if (props.tolerateLag) {
                  scheduleTolerantRetry();
                  return;
                }
                if (tp.isPlaying) wcBailedSources.add(src);
                wcFallbackRef.current();
                return;
              }
            }
            const presentFrame = () => {
              // A frame reached the canvas: whatever the layer was retrying for is over, so the backoff
              // starts clean next time. Without this a source that recovers keeps its old (long) delay.
              wcTolerateRetryRef.current = 0;
              // Stamp the served time of the frame we are about to hold (see `servedSourceTimeRef`).
              // `sourceTime` is the target THIS request asked for and `sourceLag` is how far the
              // provider's answer trailed it IN SOURCE SECONDS, so their difference is the source time
              // actually on screen. Deliberately NOT the rate-normalized `lag` — see its definition.
              servedSourceTimeRef.current = sourceTime - sourceLag;
              // Clone before holding: our copy survives the provider closing its original.
              let held: CanvasImageSource = frame;
              if (typeof VideoFrame !== "undefined" && frame instanceof VideoFrame) {
                try { held = frame.clone(); } catch { held = frame; }
              }
              setWcHeldFrame({ source: held, width: provider.width, height: provider.height });
              drawVideoFrameRef.current();
            };
            // PAUSED = COHERENT, PLAYING = SMOOTH (2026-07-27). `tolerateLag` exists to survive PLAYBACK
            // contention: many comp sources share ~3 decoders, so a loader that freeze-holds never
            // recovers. Paused, that race does not exist — every loader can converge on the exact
            // requested time. Presenting intermediate frames there produced visible staggered updates
            // while scrubbing (source A at t, source B still at t−0.1): a compositor was showing a frame
            // that is not a real frame of the comp. So the never-hold rule is now scoped to playback;
            // paused, loaders fall through to the normal hold path and present only once converged.
            // Both export paths already enforce exactly this barrier, so this closes a preview/export gap.
            if (lag > WC_HOLD_LAG_S && !reversedPlayback && props.tolerateLag && tp.isPlaying) {
              // LAG-TOLERANT (Flarex virtual loader): NEVER freeze-hold. A comp composites many sources
              // and the ~3 hardware decoders can't all keep up; holding = a permanent freeze on the
              // non-winners. Present the latest advancing frame and keep pulling — the source degrades to
              // smooth-but-slightly-behind, in sync "enough", and scales (none freeze). No hold streak, so
              // the sustained-hold native bail above never fires for these either.
              wcHoldStartRef.current = null;
              wcRerequestPaceRef.current = "frame"; // self-driven: one present per display is the ceiling
              wcRerequestRef.current = true;
              presentFrame();
            } else if (lag > WC_HOLD_LAG_S && !reversedPlayback) {
              // The hold STREAK ends only when lag actually recovers (below), never on a present:
              // the old logic reset the streak after the window expired and one frame presented, so
              // sustained divergence re-armed a fresh 5s freeze per frame — "picture pauses in live
              // regions" (2026-07-04 __rfLiveFreeze capture: holding:true chained 10s+, 15s behind).
              if (wcHoldStartRef.current === null) wcHoldStartRef.current = nowMs;
              if (nowMs - wcHoldStartRef.current < WC_HOLD_MAX_MS) {
                wcRerequestPaceRef.current = "frame"; // self-driven catch-up hold — see the pace ref
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
                wcRerequestPaceRef.current = "frame"; // self-driven degraded march — see the pace ref
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
            if (props.tolerateLag) {
              // Virtual loaders never go native (16-context cap → freeze). A null is a transient "no frame
              // decoded yet" (cold start / mid-catch-up), not a dead source — keep probing WC forever so
              // the loader recovers on its own thread instead of falling to a native element that can't be
              // allocated. Backed off (see wcTolerateRetryRef): a source that never yields a frame used to
              // re-probe at a flat 150ms indefinitely, which is a real cost when several loaders do it.
              scheduleTolerantRetry();
            } else if (wcNullCountRef.current >= 8) {
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
            // PACED RE-ENTRY (2026-07-28). This used to call straight back into requestWcFrame from
            // inside the resolved promise — a microtask, so the next ≤24ms decode began before the
            // event loop got a turn. Per-call budgets bound latency, not occupancy: 3–4 sources
            // re-entering like this is ~100% main-thread occupancy and the tab stops responding
            // (measured: STALL 2641ms, 88× getFrame < requestWcFrame). One macrotask yield between
            // decodes costs a fraction of the budget and hands the loop back. See playback/yield-task.
            scheduleWcRerequest();
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
      // ATOMIC FULL-RES SWAP: is a settle upgrade EXPECTED for this layer at all? Mirrors the settle
      // effect's own bail conditions exactly — a layer whose proxy IS its original, a still, a
      // pre-roll shell or a hidden layer never produces one, and the compositor must not wait on it.
      // Refreshed per render because `snapshot()` is created once (deps [singleCtx, mediaType]) and
      // would otherwise close over stale props.
      settleCapableRef.current = mediaType === "video" && !!fullResSrc && fullResSrc !== src && !hidden;
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
          // Animated graphic → the playhead-selected baked frame; its version encodes (bake epoch, frame
          // index) so the compositor re-uploads on frame change AND after a recolor re-bake, but skips
          // within a held frame. Falls back to the decoded still.
          let animatedVersion: number | null = null;
          // TEMPORAL COHERENCE: video layers report how far the held frame is from the one the live
          // playhead asks for. Non-video (still / generator raster) leaves it null — time-invariant,
          // so it is coherent at every playhead and must never gate a present.
          let stalenessSeconds: number | null = null;
          // ATOMIC FULL-RES SWAP: offered to the compositor, never applied here — see the field docs
          // on `fullResFrame`. `paused` gates both halves so a play flip can never leave a stale
          // full-res frame on offer.
          let fullResFrame: ScenePreviewMediaFrame | null = null;
          let fullResPending = false;
          // See `awaitingFrame`: a VIDEO with no frame for this time is definitely not showing the
          // requested moment, and the compositor would otherwise hold its previous texture silently.
          let awaitingFrame = false;
          if (mediaType === "video") {
            // false: exclude the settle frame from the base pick. The base is what this layer shows
            // until the whole viewer agrees to upgrade.
            const picked = selectVideoDrawSource(false);
            if (picked) {
              frame = { source: picked.source as TexImageSource, width: picked.width, height: picked.height };
              stalenessSeconds = computeStalenessSeconds(picked.servedSourceTime);
            } else {
              // No settle, no WC frame, no usable element — the decode for this time has not landed.
              awaitingFrame = true;
            }
            const paused = !wcTimeRef.current.isPlaying;
            const settle = settleSourceRef.current;
            if (paused && settle && settle.width > 0 && settle.height > 0) {
              fullResFrame = { source: settle.source as TexImageSource, width: settle.width, height: settle.height };
            } else if (paused && settleCapableRef.current) {
              // Expected but not landed: the 300ms debounce is running, or the native seek is in
              // flight. This is what the compositor waits on.
              fullResPending = true;
            }
          } else {
            const sel = selectGraphicFrame();
            if (sel) {
              frame = { source: sel.source, width: sel.width, height: sel.height };
              animatedVersion = sel.epoch * 100000 + sel.frameIndex;
            } else {
              const still = imageRef.current;
              if (still && still.width > 0 && still.height > 0) frame = { source: still.source, width: still.width, height: still.height };
            }
          }
          const gi = gradeInputsRef.current;
          const matteVideo = matteVideoRef.current;
          return {
            frame,
            frameVersion: animatedVersion ?? frameVersionRef.current,
            pipeline: gi.pipeline,
            pipelineKey: gi.pipelineKey,
            mediaEffects: gi.mediaEffects,
            mediaEffectsKey: gi.mediaEffectsKey,
            amount: gi.amount,
            bakedOpacity: gi.bakedOpacity,
            matte: gi.hasMatte && matteVideo ? { source: matteVideo as TexImageSource, invert: gi.matteInvert, opacity: gi.matteOpacity } : null,
            transition: gi.transition,
            transitionKey: gi.transitionKey,
            stalenessSeconds,
            fullResFrame,
            fullResPending,
            awaitingFrame,
            decodeMode: mediaType === "video" ? wcModeRef.current : null,
            // Read live from the lease, not snapshotted at mount: the host acquires FIRST and is
            // alone at that instant, so a mount-time value would report 0 for the very lease that
            // ends up sharing.
            decodeSharedWith: wcLeaseRef.current?.session.sharedWith ?? 0,
            // A real asset name when the caller knows one; url tail otherwise (a filename for a
            // library asset, an opaque per-session UUID for a blob — see `assetLabel`).
            sourceLabel:
              props.assetLabel ??
              (typeof src === "string" ? (src.split("?")[0] ?? src).split("/").pop() ?? null : null),
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
