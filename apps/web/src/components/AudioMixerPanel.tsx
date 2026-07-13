/**
 * Audio Track Mixer (Premiere-style, minimal): one strip per audio track — fader (0..200%),
 * pan (−100..100), mute/solo, and auto-ducking. Lives in the timeline dock row next to the
 * master meters. Collapsed by default to a slim toggle so it costs no space until opened.
 *
 * UI: uses the shared EffectSliderControl (same slider as the effect tabs — tonal track,
 * number field, reset).
 *
 * Parity contract: fader/pan write `track.volume`/`track.pan`, read everywhere through the
 * shared `getTrackAudioGain`/`getTrackPan` helpers: preview graph (element → clip gain → track
 * pan → master bus), local export mixer, and cloud export (non-zero pan routes the Remotion
 * render through the worker's ffmpeg audio post-mix for exact parity).
 *
 * Ducking: "Duck" analyzes another audio track's loudness and writes ordinary clip volume
 * keyframes on THIS track (editor/audio-ducking.ts) — editable afterwards, rendered identically
 * everywhere because it's just keyframe data.
 */
import { useState } from "react";
import { ArrowDownWideNarrow, SlidersHorizontal, Volume2, VolumeX, X } from "lucide-react";
import type { TimelineComposition, TimelineTrack } from "@kimera-by-aelivion/shared";
import { getTrackAudioGainAt, getTrackPanAt } from "@kimera-by-aelivion/shared";
import { DEFAULT_DUCKING, type DuckingOptions } from "../editor/audio-ducking";
import { EffectSliderControl } from "./EffectSliderControl";

interface AudioMixerPanelProps {
  composition: TimelineComposition;
  /** Playhead time — slider values show the AUTOMATED value here; keyframes toggle here. */
  currentTime: number;
  /** Responsive sheets should expose the mixer immediately; desktop dock keeps its compact toggle. */
  forceOpen?: boolean | undefined;
  onChangeTrackAudio: (trackId: string, patch: { volume?: number | undefined; pan?: number | undefined }) => void;
  onToggleTrackKeyframe: (trackId: string, property: "volume" | "pan") => void;
  /** Remove every fader/pan automation keyframe on a track, baking the current value back to static. */
  onClearTrackKeyframes: (trackId: string, property: "volume" | "pan") => void;
  /** Absolute (composition) seconds — track keyframes aren't layer-relative. */
  onSeek: (seconds: number) => void;
  onToggleTrack: (trackId: string, patch: Partial<Pick<TimelineTrack, "muted" | "solo">>) => void;
  /** Generate ducking keyframes on `trackId`, sidechained from `sidechainTrackId`. Resolves when applied. */
  onAutoDuck?: ((trackId: string, sidechainTrackId: string, options: DuckingOptions) => Promise<void>) | undefined;
}

function hasKeyframeAt(keyframes: { timeSeconds: number }[] | undefined, timeSeconds: number, fps: number): boolean {
  const epsilon = 1 / Math.max(1, fps) / 2;
  return Boolean(keyframes?.some((k) => Math.abs(k.timeSeconds - timeSeconds) <= epsilon));
}

function findKeyframeTime(
  keyframes: { timeSeconds: number }[] | undefined,
  timeSeconds: number,
  fps: number,
  direction: -1 | 1
): number | undefined {
  const epsilon = 1 / Math.max(1, fps) / 2;
  const sorted = [...(keyframes ?? [])].sort((a, b) => a.timeSeconds - b.timeSeconds);
  if (direction < 0) {
    return [...sorted].reverse().find((k) => k.timeSeconds < timeSeconds - epsilon)?.timeSeconds;
  }
  return sorted.find((k) => k.timeSeconds > timeSeconds + epsilon)?.timeSeconds;
}

/**
 * Build the shared keyframe-control descriptor for an audio-track fader/pan. Audio automation is a
 * separate per-track keyframe model (volumeKeyframes/panKeyframes, ABSOLUTE composition seconds —
 * tracks aren't layer-scoped) — same NumberControl/EffectSliderControl affordance (diamond + prev/
 * next/clear), wired to the real keyframe array instead of layer.animations.
 */
function audioKeyframeControl(
  keyframes: { timeSeconds: number }[] | undefined,
  currentTime: number,
  fps: number,
  onToggle: () => void,
  onSeek: (seconds: number) => void,
  onClearAll: () => void
) {
  const nextTime = findKeyframeTime(keyframes, currentTime, fps, 1);
  const previousTime = findKeyframeTime(keyframes, currentTime, fps, -1);
  return {
    active: hasKeyframeAt(keyframes, currentTime, fps),
    hasAny: Boolean(keyframes?.length),
    hasNext: nextTime !== undefined,
    hasPrevious: previousTime !== undefined,
    onToggle,
    onNext: () => {
      if (nextTime !== undefined) onSeek(nextTime);
    },
    onPrevious: () => {
      if (previousTime !== undefined) onSeek(previousTime);
    },
    onClearAll
  };
}

function DuckingForm({
  track,
  otherTracks,
  onApply,
}: {
  track: TimelineTrack;
  otherTracks: TimelineTrack[];
  onApply: (sidechainTrackId: string, options: DuckingOptions) => Promise<void>;
}) {
  const [sidechainId, setSidechainId] = useState(otherTracks[0]?.id ?? "");
  const [duckDb, setDuckDb] = useState(DEFAULT_DUCKING.duckDb);
  const [thresholdDb, setThresholdDb] = useState(DEFAULT_DUCKING.thresholdDb);
  const [fadeMs, setFadeMs] = useState(Math.round(DEFAULT_DUCKING.fadeSeconds * 1000));
  const [busy, setBusy] = useState(false);

  return (
    <div className="audio-mixer-ducking" aria-label={`Ducking settings for ${track.name}`}>
      <label>
        Against
        <select value={sidechainId} onChange={(event) => setSidechainId(event.target.value)}>
          {otherTracks.map((other) => (
            <option key={other.id} value={other.id}>
              {other.name}
            </option>
          ))}
        </select>
      </label>
      <EffectSliderControl label="Duck by" value={duckDb} min={3} max={30} step={1} tone="light" onChange={setDuckDb} onReset={() => setDuckDb(DEFAULT_DUCKING.duckDb)} />
      <EffectSliderControl label="Sensitivity" value={thresholdDb} min={-60} max={-20} step={1} tone="neutral" onChange={setThresholdDb} onReset={() => setThresholdDb(DEFAULT_DUCKING.thresholdDb)} />
      <EffectSliderControl label="Fade" value={fadeMs} min={50} max={1000} step={50} tone="neutral" onChange={setFadeMs} onReset={() => setFadeMs(Math.round(DEFAULT_DUCKING.fadeSeconds * 1000))} />
      <button
        type="button"
        disabled={busy || !sidechainId}
        onClick={() => {
          setBusy(true);
          void onApply(sidechainId, { thresholdDb, duckDb, fadeSeconds: fadeMs / 1000, holdSeconds: DEFAULT_DUCKING.holdSeconds }).finally(() => setBusy(false));
        }}
      >
        {busy ? "Analyzing…" : "Apply ducking"}
      </button>
    </div>
  );
}

export function AudioMixerPanel({
  composition,
  currentTime,
  forceOpen = false,
  onChangeTrackAudio,
  onToggleTrackKeyframe,
  onClearTrackKeyframes,
  onSeek,
  onToggleTrack,
  onAutoDuck
}: AudioMixerPanelProps) {
  const [open, setOpen] = useState(false);
  const [duckingTrackId, setDuckingTrackId] = useState<string | null>(null);
  const audioTracks = composition.tracks.filter((track) => track.type === "audio");
  if (!audioTracks.length) return null;

  if (!forceOpen && !open) {
    return (
      <button type="button" className="audio-mixer-toggle" title="Audio track mixer" onClick={() => setOpen(true)}>
        <SlidersHorizontal size={14} />
      </button>
    );
  }

  return (
    <div className="audio-mixer-panel">
      <div className="audio-mixer-head">
        <span>Mixer</span>
        {forceOpen ? null : (
          <button type="button" title="Close mixer" onClick={() => setOpen(false)}>
            <X size={12} />
          </button>
        )}
      </div>
      <div className="audio-mixer-strips">
        {audioTracks.map((track) => {
          const gain = getTrackAudioGainAt(track, currentTime);
          const pan = getTrackPanAt(track, currentTime);
          const otherTracks = audioTracks.filter((other) => other.id !== track.id);
          return (
            <div key={track.id} className="audio-mixer-strip">
              <div className="audio-mixer-strip-head">
                <span className="audio-mixer-track-name" title={track.name}>
                  {track.name}
                </span>
                <div className="audio-mixer-buttons">
                  <button
                    type="button"
                    className={track.muted ? "is-active" : ""}
                    title={track.muted ? "Unmute track" : "Mute track"}
                    onClick={() => onToggleTrack(track.id, { muted: !track.muted })}
                  >
                    {track.muted ? <VolumeX size={12} /> : <Volume2 size={12} />}
                  </button>
                  <button
                    type="button"
                    className={track.solo ? "is-active" : ""}
                    title={track.solo ? "Unsolo track" : "Solo track"}
                    onClick={() => onToggleTrack(track.id, { solo: !track.solo })}
                  >
                    S
                  </button>
                  {onAutoDuck && otherTracks.length > 0 ? (
                    <button
                      type="button"
                      className={duckingTrackId === track.id ? "is-active" : ""}
                      title="Auto-duck this track under another track's audio"
                      onClick={() => setDuckingTrackId(duckingTrackId === track.id ? null : track.id)}
                    >
                      <ArrowDownWideNarrow size={12} />
                    </button>
                  ) : null}
                </div>
              </div>
              <EffectSliderControl
                label="Volume"
                value={Math.round(gain * 100)}
                min={0}
                max={200}
                step={1}
                tone="light"
                keyframe={audioKeyframeControl(
                  track.volumeKeyframes,
                  currentTime,
                  composition.fps,
                  () => onToggleTrackKeyframe(track.id, "volume"),
                  onSeek,
                  () => onClearTrackKeyframes(track.id, "volume")
                )}
                onChange={(value) => onChangeTrackAudio(track.id, { volume: value / 100 })}
                onReset={() => onChangeTrackAudio(track.id, { volume: 1 })}
              />
              <EffectSliderControl
                label="Pan"
                value={Math.round(pan * 100)}
                min={-100}
                max={100}
                step={1}
                tone="neutral"
                keyframe={audioKeyframeControl(
                  track.panKeyframes,
                  currentTime,
                  composition.fps,
                  () => onToggleTrackKeyframe(track.id, "pan"),
                  onSeek,
                  () => onClearTrackKeyframes(track.id, "pan")
                )}
                onChange={(value) => onChangeTrackAudio(track.id, { pan: value / 100 })}
                onReset={() => onChangeTrackAudio(track.id, { pan: 0 })}
              />
              {onAutoDuck && duckingTrackId === track.id ? (
                <DuckingForm
                  track={track}
                  otherTracks={otherTracks}
                  onApply={async (sidechainTrackId, options) => {
                    await onAutoDuck(track.id, sidechainTrackId, options);
                    setDuckingTrackId(null);
                  }}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
