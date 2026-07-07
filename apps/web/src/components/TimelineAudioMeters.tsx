/**
 * Premiere-style timeline audio meters (stereo peak + RMS), docked right of the timeline.
 *
 * Performance contract — this must NEVER cost playback smoothness:
 *  - Signal analysis is on the AUDIO thread (AnalyserNodes in preview-audio-bus.ts); the only main-
 *    thread work per frame is `readPreviewMeter` (two preallocated 2048-float copies + a scan) and a
 *    tiny 2-bar canvas paint — tens of microseconds.
 *  - Fully imperative: the rAF loop paints the canvas directly, NO React state, NO re-renders.
 *  - The loop only runs while the transport is playing (plus a short decay tail so bars fall to
 *    silence instead of freezing); paused/idle it costs literally nothing.
 *
 * Ballistics (Premiere-style PPM): the BAR is peak-driven (instant attack, timed release) — NOT RMS,
 * whose 10–20dB crest-factor gap would leave the peak-hold cap floating far above the bar. The cap is
 * the held max peak (~1.4s hold, then falls), so it rides just above the bar top like a hardware
 * meter. An inner brighter core shows RMS (perceived loudness). Clip LED latches 2s at 0dBFS.
 * Scale −60..0 dBFS with ticks at 0/−6/−12/−24/−48; green → yellow (−12dB) → red (−3dB) segments.
 */

import { useEffect, useRef } from "react";
import { readPreviewMeter, type MeterLevels } from "../playback/preview-audio-bus";

const DB_FLOOR = -60;
const RELEASE_PER_S = 26; // dB/s fall for the RMS bar
const PEAK_HOLD_MS = 1400;
const PEAK_FALL_PER_S = 14; // dB/s fall for the peak-hold tick after the hold
const CLIP_HOLD_MS = 2000;
const TAIL_MS = 1600; // keep painting briefly after pause so bars decay instead of freezing

const TICK_DBS = [0, -6, -12, -24, -48];

function toDb(linear: number): number {
  return linear <= 0 ? DB_FLOOR : Math.max(DB_FLOOR, 20 * Math.log10(linear));
}

/** 0 (floor) → 1 (0 dBFS), linear in dB. */
function dbNorm(db: number): number {
  return Math.min(1, Math.max(0, (db - DB_FLOOR) / -DB_FLOOR));
}

interface ChannelState {
  /** Peak-ballistic bar level (instant attack, timed release). */
  barDb: number;
  /** RMS core level (loudness), drawn as a brighter inner bar. */
  rmsDb: number;
  holdDb: number;
  holdAt: number;
  clipAt: number;
}

export function TimelineAudioMeters({ isPlaying }: { isPlaying: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return undefined;
    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) return undefined;

    const levels: MeterLevels = { peakL: 0, peakR: 0, rmsL: 0, rmsR: 0 };
    const chans: [ChannelState, ChannelState] = [
      { barDb: DB_FLOOR, rmsDb: DB_FLOOR, holdDb: DB_FLOOR, holdAt: 0, clipAt: 0 },
      { barDb: DB_FLOOR, rmsDb: DB_FLOOR, holdDb: DB_FLOOR, holdAt: 0, clipAt: 0 },
    ];
    let raf = 0;
    let running = false;
    let lastTs = 0;
    let tailUntil = 0;
    let width = 0;
    let height = 0;
    let dpr = 1;

    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      dpr = Math.min(2, window.devicePixelRatio || 1);
      width = Math.max(1, Math.round(rect.width));
      height = Math.max(1, Math.round(rect.height));
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      paint(performance.now()); // repaint at the new size even when idle
    };

    const paint = (now: number) => {
      ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx2d.clearRect(0, 0, width, height);
      const padTop = 10;
      const padBottom = 6;
      const labelW = 17;
      const barGap = 3;
      const barsX = labelW;
      const barW = Math.max(3, (width - labelW - barGap - 2) / 2);
      const trackH = Math.max(10, height - padTop - padBottom);
      const yFor = (db: number) => padTop + (1 - dbNorm(db)) * trackH;

      // Scale ticks + labels.
      ctx2d.font = "8px ui-monospace, Menlo, Consolas, monospace";
      ctx2d.textAlign = "right";
      ctx2d.textBaseline = "middle";
      for (const db of TICK_DBS) {
        const y = yFor(db);
        ctx2d.fillStyle = "rgba(255,255,255,0.34)";
        ctx2d.fillText(db === 0 ? "0" : String(db), labelW - 4, y);
        ctx2d.fillStyle = "rgba(255,255,255,0.14)";
        ctx2d.fillRect(barsX, y, width - barsX - 1, 1);
      }

      for (let c = 0; c < 2; c++) {
        const chan = chans[c]!;
        const x = barsX + c * (barW + barGap);
        // Track.
        ctx2d.fillStyle = "rgba(255,255,255,0.07)";
        ctx2d.fillRect(x, padTop, barW, trackH);
        // PEAK bar in dB-segmented colors: green below −12, yellow −12..−3, red above −3. Peak (not
        // RMS) so the hold cap rides the bar top instead of floating a crest-factor above it.
        const top = yFor(chan.barDb);
        const y12 = yFor(-12);
        const y3 = yFor(-3);
        const seg = (from: number, to: number, color: string, sx: number, sw: number) => {
          const h = Math.max(0, from - to);
          if (h > 0) {
            ctx2d.fillStyle = color;
            ctx2d.fillRect(sx, to, sw, h);
          }
        };
        const bottom = padTop + trackH;
        seg(bottom, Math.max(top, y12), "#357f46", x, barW);
        if (top < y12) seg(y12, Math.max(top, y3), "#b39a45", x, barW);
        if (top < y3) seg(y3, top, "#b34a4a", x, barW);
        // Brighter RMS core (perceived loudness) inside the peak bar.
        const rmsTop = Math.max(yFor(chan.rmsDb), top);
        const coreX = x + Math.max(1, Math.floor(barW * 0.25));
        const coreW = Math.max(1, barW - 2 * Math.max(1, Math.floor(barW * 0.25)));
        seg(bottom, Math.max(rmsTop, y12), "#4fc06a", coreX, coreW);
        if (rmsTop < y12) seg(y12, Math.max(rmsTop, y3), "#e6c356", coreX, coreW);
        if (rmsTop < y3) seg(y3, rmsTop, "#e05f5f", coreX, coreW);
        // Peak-hold tick.
        if (chan.holdDb > DB_FLOOR + 0.5) {
          ctx2d.fillStyle = "rgba(255,255,255,0.85)";
          ctx2d.fillRect(x, Math.max(padTop, yFor(chan.holdDb)) - 1, barW, 2);
        }
        // Clip LED.
        const clipped = now - chan.clipAt < CLIP_HOLD_MS;
        ctx2d.fillStyle = clipped ? "#ff3b30" : "rgba(255,255,255,0.12)";
        ctx2d.fillRect(x, 2, barW, 4);
      }
    };

    const step = (ts: number) => {
      raf = 0;
      const dt = lastTs > 0 ? Math.min(0.1, (ts - lastTs) / 1000) : 0;
      lastTs = ts;

      const playing = isPlayingRef.current;
      const hasSignal = playing && readPreviewMeter(levels);
      const inputs: [number, number][] = hasSignal
        ? [
            [levels.peakL, levels.rmsL],
            [levels.peakR, levels.rmsR],
          ]
        : [
            [0, 0],
            [0, 0],
          ];
      for (let c = 0; c < 2; c++) {
        const chan = chans[c]!;
        const [peak, rms] = inputs[c]!;
        const rmsDb = toDb(rms);
        const peakDb = toDb(peak);
        // Instant attack, timed release — for BOTH the peak bar and the RMS core.
        chan.barDb = peakDb >= chan.barDb ? peakDb : Math.max(peakDb, chan.barDb - RELEASE_PER_S * dt);
        chan.rmsDb = rmsDb >= chan.rmsDb ? rmsDb : Math.max(rmsDb, chan.rmsDb - RELEASE_PER_S * dt);
        if (peakDb >= chan.holdDb || ts - chan.holdAt > PEAK_HOLD_MS) {
          if (peakDb >= chan.holdDb) {
            chan.holdDb = peakDb;
            chan.holdAt = ts;
          } else {
            chan.holdDb = Math.max(peakDb, chan.holdDb - PEAK_FALL_PER_S * dt);
          }
        }
        if (peak >= 0.999) chan.clipAt = ts;
      }
      paint(ts);

      if (playing) tailUntil = ts + TAIL_MS;
      const settled = chans.every((c) => c.barDb <= DB_FLOOR + 0.5 && c.rmsDb <= DB_FLOOR + 0.5 && c.holdDb <= DB_FLOOR + 0.5);
      if (playing || (ts < tailUntil && !settled)) {
        raf = requestAnimationFrame(step);
      } else {
        running = false;
        lastTs = 0;
      }
    };

    const ensureRunning = () => {
      if (running) return;
      running = true;
      lastTs = 0;
      raf = requestAnimationFrame(step);
    };
    // Expose to the isPlaying effect below via a mutable handle on the element (avoids re-creating
    // this whole effect — and losing meter state — on every play/pause).
    (wrap as { __ensureMeterLoop?: () => void }).__ensureMeterLoop = ensureRunning;

    const observer = new ResizeObserver(resize);
    observer.observe(wrap);
    resize();
    if (isPlayingRef.current) ensureRunning();

    return () => {
      observer.disconnect();
      if (raf) cancelAnimationFrame(raf);
      delete (wrap as { __ensureMeterLoop?: () => void }).__ensureMeterLoop;
    };
  }, []);

  // Kick the loop on play; the loop stops itself after the decay tail on pause.
  useEffect(() => {
    if (!isPlaying) return;
    (wrapRef.current as { __ensureMeterLoop?: () => void } | null)?.__ensureMeterLoop?.();
  }, [isPlaying]);

  return (
    <div ref={wrapRef} className="timeline-audio-meters" aria-label="Audio meters" title="Master audio meters (peak / RMS, dBFS)">
      <canvas ref={canvasRef} />
    </div>
  );
}
