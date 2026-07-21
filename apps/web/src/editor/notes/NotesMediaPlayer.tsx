/**
 * Custom media players for Notes asset cards (video + audio) with a real waveform scrubber.
 * The waveform comes from the codebase's existing peak extractor (`lib/audioPeaks` — the same LOD
 * decode the timeline uses, cached per URL), rendered as a two-layer bar strip: a muted base layer
 * and an accent "played" layer revealed by a `clip-path` inset driven by playback progress (so the
 * progress paint costs one style write per frame, never a per-bar re-render). The strip doubles as
 * the seek surface.
 *
 * Theme rule: every colored surface uses `var(--nle-accent)` — no hardcoded accents.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Music, Pause, Play, Volume2, VolumeX } from "lucide-react";
import { useAudioPeaks } from "../../lib/audioPeaks";

function fmt(t: number): string {
  if (!Number.isFinite(t) || t < 0) return "0:00";
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function WaveScrubber({
  peaksUrl,
  progress,
  onSeek,
  buckets = 80,
}: {
  peaksUrl: string;
  progress: number;
  onSeek: (frac: number) => void;
  buckets?: number;
}) {
  const peaks = useAudioPeaks(peaksUrl, buckets);
  const ref = useRef<HTMLDivElement | null>(null);
  const bars = useMemo(() => {
    if (!peaks) return [];
    return peaks.max.map((m, i) => {
      const amp = Math.max(m, -(peaks.min[i] ?? 0));
      return Math.max(0.08, Math.min(1, amp));
    });
  }, [peaks]);

  const seekAt = (clientX: number) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    onSeek(Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)));
  };

  return (
    <div
      ref={ref}
      className="notes-wave"
      onPointerDown={(e) => {
        e.stopPropagation();
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        seekAt(e.clientX);
      }}
      onPointerMove={(e) => {
        if (e.buttons & 1) seekAt(e.clientX);
      }}
    >
      {bars.length === 0 ? (
        // No decodable waveform (peaks still loading, or the media has no audio track) → a clean
        // progress track so playback position is ALWAYS visible (esp. for video).
        <div className="notes-wave-track">
          <div className="notes-wave-track-fill" style={{ width: `${progress * 100}%` }} />
          <div className="notes-wave-track-thumb" style={{ left: `${progress * 100}%` }} />
        </div>
      ) : (
        <>
          <div className="notes-wave-layer">
            {bars.map((h, i) => (
              <span key={i} className="notes-wave-bar" style={{ height: `${h * 100}%` }} />
            ))}
          </div>
          <div className="notes-wave-layer notes-wave-layer-fill" style={{ clipPath: `inset(0 ${100 - progress * 100}% 0 0)` }}>
            {bars.map((h, i) => (
              <span key={i} className="notes-wave-bar" style={{ height: `${h * 100}%` }} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function NotesMediaPlayer({
  variant,
  src,
  peaksUrl,
  poster,
  name,
}: {
  variant: "video" | "audio";
  src: string;
  peaksUrl: string;
  poster?: string | undefined;
  name: string;
}) {
  const ref = useRef<HTMLMediaElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const [muted, setMuted] = useState(false);

  // Smooth progress while playing (rAF), with the media's own timeupdate as a paused-state fallback.
  useEffect(() => {
    if (!playing) return undefined;
    let raf = 0;
    const tick = () => {
      const m = ref.current;
      if (m) setCur(m.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const toggle = () => {
    const m = ref.current;
    if (!m) return;
    if (m.paused) void m.play().catch(() => undefined);
    else m.pause();
  };
  const seek = (frac: number) => {
    const m = ref.current;
    if (m && dur > 0) {
      m.currentTime = frac * dur;
      setCur(frac * dur);
    }
  };
  const progress = dur > 0 ? cur / dur : 0;

  const mediaProps = {
    src,
    muted,
    onLoadedMetadata: (e: React.SyntheticEvent<HTMLMediaElement>) => setDur(e.currentTarget.duration || 0),
    onTimeUpdate: (e: React.SyntheticEvent<HTMLMediaElement>) => {
      if (!playing) setCur(e.currentTarget.currentTime);
    },
    onPlay: () => setPlaying(true),
    onPause: () => setPlaying(false),
    onEnded: () => setPlaying(false),
  };

  if (variant === "video") {
    return (
      <div className="notes-player notes-player-video">
        <video
          ref={(el) => {
            ref.current = el;
          }}
          className="notes-player-video-surface"
          poster={poster}
          playsInline
          onClick={toggle}
          {...mediaProps}
        />
        <div className="notes-player-bar" onPointerDown={(e) => e.stopPropagation()}>
          <button type="button" className="notes-player-btn" onClick={toggle} title={playing ? "Pause" : "Play"}>
            {playing ? <Pause size={13} /> : <Play size={13} />}
          </button>
          <WaveScrubber peaksUrl={peaksUrl} progress={progress} onSeek={seek} buckets={64} />
          <span className="notes-player-time">{fmt(cur)}</span>
          <button type="button" className="notes-player-btn" onClick={() => setMuted((v) => !v)} title={muted ? "Unmute" : "Mute"}>
            {muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="notes-player notes-player-audio">
      <audio
        ref={(el) => {
          ref.current = el;
        }}
        {...mediaProps}
      />
      <div className="notes-player-audio-head">
        <Music size={13} />
        <span className="notes-player-audio-name">{name}</span>
      </div>
      <div className="notes-player-audio-main">
        <button type="button" className="notes-player-play" onClick={toggle} onPointerDown={(e) => e.stopPropagation()} title={playing ? "Pause" : "Play"}>
          {playing ? <Pause size={15} /> : <Play size={15} />}
        </button>
        <WaveScrubber peaksUrl={peaksUrl} progress={progress} onSeek={seek} buckets={96} />
      </div>
      <div className="notes-player-audio-foot">
        <span className="notes-player-time">
          {fmt(cur)} / {fmt(dur)}
        </span>
        <button type="button" className="notes-player-btn" onClick={() => setMuted((v) => !v)} onPointerDown={(e) => e.stopPropagation()} title={muted ? "Unmute" : "Mute"}>
          {muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
        </button>
      </div>
    </div>
  );
}
