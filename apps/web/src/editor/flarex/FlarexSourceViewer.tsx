/**
 * Source Viewer — a diagnostic A/B player for a media asset's INGEST PROXY vs its ORIGINAL bytes.
 *
 * The playback path substitutes a small keyframe-dense proxy for the original when one exists
 * (`resolvePlaybackUrl`: `proxyUrl ?? previewUrl ?? fileUrl`). When a proxy FAILS to build, playback
 * silently falls back to the original — and a large/flaky original (e.g. a 2048×1080 source streamed
 * from R2 that truncates) then freezes from the first frame while a sibling clip with a good proxy
 * plays fine. This viewer makes that visible: it plays BOTH sources so you can see which one stalls,
 * and shows the proxy's build state (built / failed / queued / none) next to it.
 *
 * Purely diagnostic — it reads the same OPFS proxy blob and the asset's original URL the engine uses,
 * and touches no render state.
 */

import { useEffect, useRef, useState } from "react";
import { getSourceProxyBlobUrl } from "../performance/sourceProxyStore";
import { getSourceProxyState, type SourceProxyState } from "../performance/sourceProxyEngine";

interface VideoStats {
  width: number;
  height: number;
  /** PRESENTED frame rate (distinct mediaTimes per media-second via rVFC) — null until playing. */
  fps: number | null;
  /**
   * DECODED frame rate — totalVideoFrames / media-seconds from getVideoPlaybackQuality. Immune to
   * presentation throttling, so it is the file's TRUE fps. If decodedFps ≈ 30 while fps ≈ 7, the file
   * is 30fps and the stutter is decode STARVATION; if both ≈ 7 the file is genuinely a 7fps encode.
   */
  decodedFps: number | null;
  /** Fraction of decoded frames the pipeline dropped (starvation signal). */
  droppedPct: number | null;
}

/**
 * Measure a video's real content frame rate via requestVideoFrameCallback: each callback carries the
 * presented frame's `mediaTime`, so counting DISTINCT media times over a media-second is the true fps
 * (independent of display refresh or playback rate). This is what exposes a 12fps stop-motion proxy vs
 * a 30fps original — the actual bug, measured, not guessed.
 */
function useVideoStats(url: string | null | undefined): [React.RefObject<HTMLVideoElement | null>, VideoStats] {
  const ref = useRef<HTMLVideoElement>(null);
  const [stats, setStats] = useState<VideoStats>({ width: 0, height: 0, fps: null, decodedFps: null, droppedPct: null });
  useEffect(() => {
    const v = ref.current;
    if (!v || !url) return undefined;
    setStats({ width: 0, height: 0, fps: null, decodedFps: null, droppedPct: null });
    const onMeta = () => setStats((s) => ({ ...s, width: v.videoWidth, height: v.videoHeight }));
    v.addEventListener("loadedmetadata", onMeta);
    if (v.videoWidth) onMeta();

    const rvfc = (v as HTMLVideoElement & { requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number; cancelVideoFrameCallback?: (h: number) => void });
    let handle = 0;
    const times: number[] = [];
    if (typeof rvfc.requestVideoFrameCallback === "function") {
      const tick = (_now: number, meta: { mediaTime: number }) => {
        const mt = meta.mediaTime;
        if (times.length === 0 || Math.abs(mt - times[times.length - 1]!) > 1e-4) times.push(mt);
        while (times.length > 1 && mt - times[0]! > 1.2) times.shift();
        if (times.length >= 2) {
          const span = times[times.length - 1]! - times[0]!;
          if (span > 0.4) setStats((s) => ({ ...s, fps: Math.round((times.length - 1) / span) }));
        }
        handle = rvfc.requestVideoFrameCallback!(tick);
      };
      handle = rvfc.requestVideoFrameCallback(tick);
    }

    // DECODED fps: getVideoPlaybackQuality().totalVideoFrames counts frames the pipeline decoded,
    // independent of how many the compositor actually PRESENTED. Measured over the LAST interval only
    // (not cumulative from playback start) so a seek / decode-flush — where the frame counter leaps
    // while currentTime barely moves — can't poison the reading. Samples whose implied rate is
    // physically impossible (>240fps, i.e. a seek discontinuity) or whose media time went backwards /
    // barely advanced are dropped, not shown.
    const vq = v as HTMLVideoElement & { getVideoPlaybackQuality?: () => { totalVideoFrames: number; droppedVideoFrames: number } };
    let lastTotal: number | null = null;
    let lastDropped = 0;
    let lastMedia = 0;
    const poll = window.setInterval(() => {
      if (typeof vq.getVideoPlaybackQuality !== "function" || v.paused) return;
      const q = vq.getVideoPlaybackQuality();
      const media = v.currentTime;
      if (lastTotal !== null) {
        const dMedia = media - lastMedia;
        const dFrames = q.totalVideoFrames - lastTotal;
        const dDropped = q.droppedVideoFrames - lastDropped;
        if (dMedia > 0.1 && dFrames >= 0) {
          const fps = dFrames / dMedia;
          if (fps <= 240) {
            setStats((s) => ({
              ...s,
              decodedFps: Math.round(fps),
              droppedPct: dFrames > 0 ? Math.round((dDropped / dFrames) * 100) : 0,
            }));
          }
        }
      }
      lastTotal = q.totalVideoFrames;
      lastDropped = q.droppedVideoFrames;
      lastMedia = media;
    }, 700);

    return () => {
      v.removeEventListener("loadedmetadata", onMeta);
      if (handle) rvfc.cancelVideoFrameCallback?.(handle);
      window.clearInterval(poll);
    };
  }, [url]);
  return [ref, stats];
}

function specLabel(s: VideoStats): string {
  const res = s.width > 0 ? `${s.width}×${s.height}` : "—";
  if (s.fps == null && s.decodedFps == null) return `${res} · play to measure fps`;
  const presented = s.fps != null ? `presented ~${s.fps}` : "presented —";
  const decoded =
    s.decodedFps != null
      ? ` · decoded ~${s.decodedFps} fps${s.droppedPct != null && s.droppedPct > 5 ? ` (${s.droppedPct}% dropped)` : ""}`
      : "";
  return `${res} · ${presented} fps${decoded}`;
}

export interface FlarexSourceViewerProps {
  assetId: string;
  name: string;
  /** The asset's ORIGINAL media URL (fileUrl ?? previewUrl) — what playback falls back to with no proxy. */
  originalUrl: string | undefined;
  /** Force a fresh proxy rebuild for this asset (deletes the on-disk blob + re-transcodes). Diagnostic. */
  onRebuild?: (() => Promise<void>) | undefined;
  onClose: () => void;
}

const STATE_LABEL: Record<SourceProxyState, string> = {
  building: "building…",
  queued: "queued",
  built: "built",
  failed: "failed",
  skipped: "skipped",
  none: "none",
};

const STATE_COLOR: Record<SourceProxyState, string> = {
  building: "#e0b341",
  queued: "#8a8f98",
  built: "#3fb950",
  failed: "#f85149",
  skipped: "#8a8f98",
  none: "#8a8f98",
};

export function FlarexSourceViewer({ assetId, name, originalUrl, onRebuild, onClose }: FlarexSourceViewerProps) {
  const [proxyUrl, setProxyUrl] = useState<string | null | undefined>(undefined); // undefined = loading
  const [proxyState, setProxyState] = useState<SourceProxyState>("none");
  const [rebuildNonce, setRebuildNonce] = useState(0);
  const [rebuilding, setRebuilding] = useState(false);
  const [proxyVideoRef, proxyStats] = useVideoStats(proxyUrl);
  const [originalVideoRef, originalStats] = useVideoStats(originalUrl);

  useEffect(() => {
    let alive = true;
    setProxyState(getSourceProxyState(assetId));
    void getSourceProxyBlobUrl(assetId).then((res) => {
      if (alive) setProxyUrl(res?.url ?? null);
    });
    return () => {
      alive = false;
    };
  }, [assetId, rebuildNonce]);

  // While a rebuild runs, poll the engine's per-asset state; when it settles, re-resolve the fresh blob
  // (removeSourceProxy revoked the old object URL, so bumping the nonce above pulls the new one).
  useEffect(() => {
    if (!rebuilding) return undefined;
    const poll = window.setInterval(() => {
      const s = getSourceProxyState(assetId);
      setProxyState(s);
      if (s === "built" || s === "failed" || s === "skipped") {
        setRebuilding(false);
        setRebuildNonce((n) => n + 1);
      }
    }, 800);
    return () => window.clearInterval(poll);
  }, [rebuilding, assetId]);

  const handleRebuild = () => {
    if (!onRebuild || rebuilding) return;
    setRebuilding(true);
    setProxyState("queued");
    setProxyUrl(undefined);
    void onRebuild().catch(() => setRebuilding(false));
  };

  // Esc to close; play/pause both together with Space for a fair A/B.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === " " && e.target === document.body) {
        e.preventDefault();
        for (const v of [proxyVideoRef.current, originalVideoRef.current]) {
          if (!v) continue;
          if (v.paused) void v.play().catch(() => undefined);
          else v.pause();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-label={`Source viewer — ${name}`}
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 4000,
        background: "rgba(0,0,0,0.72)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#12141a",
          border: "1px solid #262a33",
          borderRadius: 10,
          padding: 16,
          width: "min(1100px, 94vw)",
          maxHeight: "92vh",
          overflow: "auto",
          color: "#e6e8ec",
          boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <strong style={{ fontSize: 14, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            Source Viewer — {name}
          </strong>
          <span
            title="Ingest-proxy build state for this asset"
            style={{ fontSize: 11, padding: "2px 8px", borderRadius: 999, background: "#1c1f27", color: STATE_COLOR[proxyState], border: `1px solid ${STATE_COLOR[proxyState]}44` }}
          >
            proxy: {rebuilding ? "rebuilding…" : STATE_LABEL[proxyState]}
          </span>
          {onRebuild ? (
            <button
              type="button"
              onClick={handleRebuild}
              disabled={rebuilding}
              title="Delete this proxy and re-transcode it (logs nominalFps → encode fps to the console)"
              style={{ ...btnStyle, width: "auto", padding: "0 10px", fontSize: 11, opacity: rebuilding ? 0.5 : 1 }}
            >
              {rebuilding ? "Rebuilding…" : "↻ Rebuild proxy"}
            </button>
          ) : null}
          <button type="button" onClick={onClose} style={btnStyle} aria-label="Close">
            ✕
          </button>
        </div>

        <p style={{ margin: "0 0 12px", fontSize: 12, color: "#9aa0aa" }}>
          Playback prefers the <b>proxy</b> (<code>proxyUrl ?? fileUrl</code>). If the proxy is missing/failed, the
          clip plays the <b>original</b> — a large or flaky original can freeze while a sibling with a good proxy
          plays. Press <kbd>Space</kbd> to play/pause both. Watch which panel advances and which stalls.
        </p>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Panel title={`Proxy (preview substitution) — ${specLabel(proxyStats)}`}>
            {proxyUrl === undefined ? (
              <Placeholder>Looking for proxy…</Placeholder>
            ) : proxyUrl === null ? (
              <Placeholder>
                No proxy on disk{proxyState === "failed" ? " — build failed" : proxyState === "queued" || proxyState === "building" ? " — still building" : ""}.
                <br />
                Playback falls back to the original →
              </Placeholder>
            ) : (
              <video ref={proxyVideoRef} src={proxyUrl} controls muted playsInline style={videoStyle} />
            )}
          </Panel>

          <Panel title={`Original (full-res source) — ${specLabel(originalStats)}`}>
            {originalUrl ? (
              <video ref={originalVideoRef} src={originalUrl} controls muted playsInline crossOrigin="anonymous" style={videoStyle} />
            ) : (
              <Placeholder>No original URL for this asset.</Placeholder>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 12, color: "#c4c8d0", marginBottom: 6 }}>{title}</div>
      <div style={{ background: "#0b0d12", border: "1px solid #262a33", borderRadius: 8, aspectRatio: "16 / 9", overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center" }}>
        {children}
      </div>
    </div>
  );
}

function Placeholder({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12, color: "#8a8f98", textAlign: "center", padding: 16 }}>{children}</div>;
}

const videoStyle: React.CSSProperties = { width: "100%", height: "100%", objectFit: "contain", background: "#000" };
const btnStyle: React.CSSProperties = { background: "#1c1f27", border: "1px solid #262a33", color: "#e6e8ec", borderRadius: 6, width: 26, height: 26, cursor: "pointer" };
