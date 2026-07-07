import { useEffect, useRef, type CSSProperties } from "react";

/**
 * Native-proxy playback substitution (double-buffered).
 *
 * The live preview composites many layers through WebGL on the main thread; when the main thread stalls
 * (GC, a big React reconcile), that compositor's frame loop is starved while the source `<video>` races
 * ahead — so the picture visibly jumps. This overlay sidesteps that entirely: for timeline ranges that
 * already have a flattened proxy (a full-composite webm the background generator produced), it plays that
 * proxy as a PLAIN `<video>` element. A `<video>` is decoded and presented by the browser's media/compositor
 * threads, so it keeps playing smoothly straight through main-thread jank — real "no-skip" playback.
 *
 * It only takes over while playing and only where a ready proxy covers the playhead; elsewhere it's
 * transparent and the live compositor shows through. The proxy is the whole composite (media + overlays),
 * so when visible it fully replaces the live picture. Sync is trivial because the playback clock is
 * real-time wall-clock: the proxy `<video>` free-runs at real time and stays aligned with the playhead.
 *
 * Why TWO elements: proxy spans are cut EXACTLY at clip/transition boundaries, so the playhead switches
 * proxy `src` right on those lines — and at that same instant the live compositor is briefly black (the
 * incoming clip's source hasn't decoded its first frame yet). A single element must go transparent while it
 * loads/seeks the new src, exposing that black live frame → the reported "goes black at the next clip /
 * transition" flash. With a front/back pair we PRE-ROLL the next span into the back element and keep the
 * front element (frozen on its last frame) visible until the back has actually decoded and aligned, then
 * swap. The picture holds for the ~decode gap instead of flashing black; if the back never becomes ready
 * (a failed/pending proxy) we release to the live compositor after a short hold.
 */
export interface ProxyPlaybackHit {
  url: string;
  spanStartSeconds: number;
  spanId: string;
}

type BufferKey = "A" | "B";

/** Soak telemetry (__rf* convention): how often a coverage exit triggered a live re-prime. */
function bumpSpanExitReprimes(): void {
  if (typeof window === "undefined") return;
  const w = window as { __rfSpanExitReprimes?: number };
  w.__rfSpanExitReprimes = (w.__rfSpanExitReprimes ?? 0) + 1;
}

export function ProxyPlaybackLayer({
  currentTime,
  isPlaying,
  resolveProxyPlayback,
  onCoverageEnding,
  onCoverageEnd
}: {
  currentTime: number;
  isPlaying: boolean;
  resolveProxyPlayback: (timeSeconds: number) => ProxyPlaybackHit | undefined;
  /**
   * The current span ends into a live region within LOOKAHEAD_SECONDS (no next proxy ready). Fired
   * once per span so the live layers underneath can re-prime BEFORE the overlay reveals them — while
   * covered they decode unobserved and can silently wedge (the "plays then freezes at span exit"
   * class, 2026-07-06).
   */
  onCoverageEnding?: (() => void) | undefined;
  /** Coverage actually ended while playing (overlay was presenting last tick). Fired once per exit. */
  onCoverageEnd?: (() => void) | undefined;
}) {
  const videoARef = useRef<HTMLVideoElement | null>(null);
  const videoBRef = useRef<HTMLVideoElement | null>(null);
  // Which element is the visible front buffer; the other is the back we pre-roll the next span into.
  const frontRef = useRef<BufferKey>("A");
  // The proxy url currently loaded in each element (so we don't reload the same src every tick).
  const srcRef = useRef<Record<BufferKey, string | null>>({ A: null, B: null });
  // Wall-clock deadline while holding the front over a boundary because the back isn't decoded yet. Past it
  // we release to the live compositor rather than freeze forever (e.g. the incoming proxy failed to load).
  const holdUntilRef = useRef(0);
  // Live inputs so the media event handlers below can re-run reconciliation between clock ticks.
  const inputsRef = useRef({ currentTime, isPlaying, resolveProxyPlayback, onCoverageEnding, onCoverageEnd });
  inputsRef.current = { currentTime, isPlaying, resolveProxyPlayback, onCoverageEnding, onCoverageEnd };
  // Was the overlay actually presenting a frame last tick? Distinguishes a coverage EXIT (live layers
  // were hidden and may have wedged — fire onCoverageEnd + hold briefly) from ordinary uncovered play.
  const presentingRef = useRef(false);
  // One onCoverageEnd per exit / one onCoverageEnding per span.
  const coverageEndFiredRef = useRef(false);
  const coverageEndingSpanRef = useRef<string | null>(null);

  // Drift past which we hard-seek a proxy back onto the playhead (span switch, scrub, or a long stall).
  // Below it we let the element free-run so ordinary playback never stutters from re-seeks.
  const RESYNC_THRESHOLD_SECONDS = 0.3;
  const READY_THRESHOLD_SECONDS = 0.12;
  // Max time to hold the outgoing frame waiting for the incoming proxy to decode before giving up to live.
  const MAX_HOLD_MS = 250;
  // How far ahead of the playhead we peek to pre-roll the NEXT span's proxy into the back element, so the
  // boundary swap is instant (the incoming decoder is already warm) instead of holding the outgoing frame.
  const LOOKAHEAD_SECONDS = 0.4;

  const reconcileRef = useRef<() => void>(() => {});
  reconcileRef.current = () => {
    const A = videoARef.current;
    const B = videoBRef.current;
    if (!A || !B) {
      return;
    }
    const { currentTime: t, isPlaying: playing, resolveProxyPlayback: resolve } = inputsRef.current;
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    const el = (key: BufferKey): HTMLVideoElement => (key === "A" ? A : B);
    const other = (key: BufferKey): BufferKey => (key === "A" ? "B" : "A");
    const setOpacity = (video: HTMLVideoElement, value: "0" | "1") => {
      if (video.style.opacity !== value) {
        video.style.opacity = value;
      }
    };
    const hide = (video: HTMLVideoElement) => {
      setOpacity(video, "0");
      if (!video.paused) {
        video.pause();
      }
    };
    // Element has a real, presentable frame right now (decoded, not mid-seek, not errored).
    const decoded = (video: HTMLVideoElement): boolean => !video.error && video.readyState >= 2 && !video.seeking;
    const aligned = (video: HTMLVideoElement, localTime: number): boolean =>
      decoded(video) && Math.abs(video.currentTime - localTime) <= READY_THRESHOLD_SECONDS;

    const frontKey = frontRef.current;
    const front = el(frontKey);
    const backKey = other(frontKey);
    const back = el(backKey);

    // Keep the outgoing front (frozen on its last frame) visible across a boundary/exit so the picture
    // doesn't flash black while the incoming proxy decodes (or the live layers re-prime) — but only for
    // a short window, then release to live. Returns whether the front is still being shown.
    const holdFrontOrRelease = (): boolean => {
      if (srcRef.current[frontKey] && decoded(front)) {
        if (!holdUntilRef.current) {
          holdUntilRef.current = now + MAX_HOLD_MS;
        }
        if (now < holdUntilRef.current) {
          if (!front.paused) {
            front.pause(); // freeze on the last frame of the finished span; don't run past its range
          }
          setOpacity(front, "1");
          return true;
        }
      }
      setOpacity(front, "0");
      return false;
    };

    const hit = playing ? resolve(t) : undefined;
    if (!hit) {
      if (playing && presentingRef.current) {
        // COVERAGE EXIT while playing: the live compositor underneath decoded unobserved the whole
        // time we covered it and can silently wedge — the instant, unconditional reveal here was
        // what exposed the "plays ~4s then freezes" class (2026-07-06). Fire the re-prime hook once
        // and hold the front's last frame briefly so the live layers get a beat to produce a real
        // frame before they're on screen.
        if (!coverageEndFiredRef.current) {
          coverageEndFiredRef.current = true;
          bumpSpanExitReprimes();
          inputsRef.current.onCoverageEnd?.();
        }
        hide(back);
        if (holdFrontOrRelease()) {
          return;
        }
        presentingRef.current = false;
        holdUntilRef.current = 0;
        return;
      }
      // Paused or no ready proxy here — hand the picture back to the live compositor.
      hide(A);
      hide(B);
      holdUntilRef.current = 0;
      presentingRef.current = false;
      coverageEndFiredRef.current = false;
      coverageEndingSpanRef.current = null;
      return;
    }
    coverageEndFiredRef.current = false;

    const localTime = Math.max(0, t - hit.spanStartSeconds);

    // Load a span's proxy into an element and drive it toward `localTime`. Idempotent per src.
    const prepare = (key: BufferKey, url: string) => {
      const video = el(key);
      if (srcRef.current[key] !== url) {
        srcRef.current[key] = url;
        video.dataset.spanId = hit.spanId;
        video.src = url;
        video.load();
        setOpacity(video, "0");
      }
      if (video.error || video.readyState < 1) {
        return;
      }
      const drift = Math.abs(video.currentTime - localTime);
      if (video.paused || drift > RESYNC_THRESHOLD_SECONDS) {
        try {
          video.currentTime = localTime;
        } catch {
          // transient seek failure — retried next tick
        }
      }
      if (video.paused) {
        void video.play().catch(() => undefined);
      }
    };

    // Pre-roll the next span's proxy into an element WITHOUT showing or playing it: load its first frame
    // (span-local t=0) so its decoder is warm before we cross the boundary. Idempotent per src.
    const warm = (key: BufferKey, url: string) => {
      const video = el(key);
      if (srcRef.current[key] !== url) {
        srcRef.current[key] = url;
        video.src = url;
        video.load();
        try {
          video.currentTime = 0;
        } catch {
          // transient — the loadeddata/canplay handler re-runs reconciliation
        }
      }
      if (!video.paused) {
        video.pause();
      }
      setOpacity(video, "0");
    };

    // Case 1: the front element already holds this span — the steady state during playback.
    if (srcRef.current[frontKey] === hit.url) {
      prepare(frontKey, hit.url);
      const showing = decoded(front);
      setOpacity(front, showing ? "1" : "0");
      presentingRef.current = showing;
      // Warm the next span into the back element as the boundary approaches so its swap is seamless. If the
      // upcoming range has no ready proxy (or is the same span), leave the back idle.
      const ahead = resolve(t + LOOKAHEAD_SECONDS);
      if (ahead && ahead.url !== hit.url) {
        warm(backKey, ahead.url);
      } else {
        hide(back); // abandon any half-prepared next span; we're staying on this one
        if (!ahead && showing && coverageEndingSpanRef.current !== hit.spanId) {
          // This span ends into a LIVE region within the lookahead — give the hidden live layers a
          // head start on re-priming BEFORE the reveal (once per span).
          coverageEndingSpanRef.current = hit.spanId;
          inputsRef.current.onCoverageEnding?.();
        }
      }
      holdUntilRef.current = 0;
      return;
    }

    // Case 2: the back element is pre-rolling this span — swap once it has actually decoded and aligned.
    if (srcRef.current[backKey] === hit.url) {
      prepare(backKey, hit.url);
      if (aligned(back, localTime)) {
        setOpacity(back, "1");
        hide(front);
        frontRef.current = backKey;
        holdUntilRef.current = 0;
        presentingRef.current = true;
        return;
      }
      presentingRef.current = holdFrontOrRelease();
      return;
    }

    // Case 3: neither element holds this span (a fresh boundary) — assign it to the back and pre-roll it
    // while the front keeps showing its last frame.
    prepare(backKey, hit.url);
    presentingRef.current = holdFrontOrRelease();
  };

  // Reconcile every clock tick (currentTime changes each frame while playing) and whenever play state or
  // the resolver changes.
  useEffect(() => {
    reconcileRef.current();
  }, [currentTime, isPlaying, resolveProxyPlayback]);

  // Media readiness can land between clock ticks (a src just decoded, a seek finished). Re-run reconciliation
  // on those events so the swap / opacity flip happens the moment the incoming proxy is presentable.
  useEffect(() => {
    const A = videoARef.current;
    const B = videoBRef.current;
    if (!A || !B) {
      return;
    }
    const onEvent = () => reconcileRef.current();
    const events = ["seeked", "canplay", "loadeddata", "playing"] as const;
    for (const video of [A, B]) {
      for (const event of events) {
        video.addEventListener(event, onEvent);
      }
    }
    return () => {
      for (const video of [A, B]) {
        for (const event of events) {
          video.removeEventListener(event, onEvent);
        }
      }
    };
  }, []);

  // A failed proxy load falls back to the live compositor and lets that span be retried later: clear the
  // element's tracked src so a future tick reloads it.
  useEffect(() => {
    const A = videoARef.current;
    const B = videoBRef.current;
    if (!A || !B) {
      return;
    }
    const makeHandler = (key: BufferKey) => () => {
      el(key).style.opacity = "0";
      srcRef.current[key] = null;
      reconcileRef.current();
    };
    const el = (key: BufferKey): HTMLVideoElement => (key === "A" ? A : B);
    const onErrorA = makeHandler("A");
    const onErrorB = makeHandler("B");
    A.addEventListener("error", onErrorA);
    B.addEventListener("error", onErrorB);
    return () => {
      A.removeEventListener("error", onErrorA);
      B.removeEventListener("error", onErrorB);
    };
  }, []);

  // Stop presenting the proxy the instant playback stops (paused/scrub → live compositor is authoritative).
  useEffect(() => {
    if (isPlaying) {
      return;
    }
    holdUntilRef.current = 0;
    presentingRef.current = false;
    coverageEndFiredRef.current = false;
    coverageEndingSpanRef.current = null;
    for (const video of [videoARef.current, videoBRef.current]) {
      if (video) {
        if (!video.paused) {
          video.pause();
        }
        video.style.opacity = "0";
      }
    }
  }, [isPlaying]);

  const style: CSSProperties = {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    objectFit: "fill",
    opacity: 0,
    pointerEvents: "none",
    // Above the scene canvas + DOM layers, below the editing overlays (which live outside preview-comp-clip).
    zIndex: 6
  };

  return (
    <>
      <video ref={videoARef} className="preview-proxy-video" style={style} muted playsInline aria-hidden="true" />
      <video ref={videoBRef} className="preview-proxy-video" style={style} muted playsInline aria-hidden="true" />
    </>
  );
}
