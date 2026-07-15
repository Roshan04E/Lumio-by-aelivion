# Waveform Renderer — Visual Regression Baseline

**Status: Phase 1 (visual fidelity) — COMPLETE / FROZEN.**

The timeline audio waveform renderer is considered visually production-ready (DaVinci Resolve
class) and confirmed against a Resolve reference at high zoom (2026-07-14). Any further *visual*
tuning should be driven by user testing, not subjective iteration.

Phase 2 (behavior) is also shipped: worker extraction + LOD pyramid (2A, default-on) and a
flag-gated WebGL2 surface (2B, `?glWaveform=1`, default-off; Canvas remains the shipping path).

Remaining differences vs Resolve are expected to come from **source audio, zoom level, track
height, and Resolve's proprietary DSP/display tuning** — not the renderer.

---

## What the renderer does (so reviewers know the invariants)

- **Data** ([apps/web/src/lib/waveform/peakDsp.ts](apps/web/src/lib/waveform/peakDsp.ts), cached by
  [apps/web/src/lib/audioPeaks.ts](apps/web/src/lib/audioPeaks.ts)): one decode per source →
  **bipolar** `HiresPeaks { max, min, rms }` (true signed +/- excursions, not a mirrored abs-peak —
  this is what yields the DaVinci-grade fine structure on sustained audio) at a fixed **200 peaks/sec**
  (`Float32Array`), **99th-percentile** normalization, dB display-compression (**`-42 dB` floor**),
  `-60 dB` silence gate, byte-budget LRU. Purely display-domain — never alters audio. The 99th-pct +
  −42 dB pairing (was 97th / −48 dB) gives dynamic contrast: transients stay full-height while quiet
  passages collapse toward the baseline, readable at high zoom.
- **LOD** (Phase 2A, [peakDsp.ts](apps/web/src/lib/waveform/peakDsp.ts) `buildPyramid`): halving
  pyramid preserving the top via pairwise-max and the bottom via pairwise-min; decoded off-thread in
  [peaks.worker.ts](apps/web/src/lib/waveform/peaks.worker.ts) (main-thread fallback if
  `OfflineAudioContext` is unavailable in a Worker).
- **Render** (`Waveform` in [apps/web/src/components/TimelineStrip.tsx](apps/web/src/components/TimelineStrip.tsx)):
  bipolar peak fill between the real top (max) and bottom (min) contours + RMS body (tinted core) +
  separate top/bottom peak-edge rims + faint baseline; clip-color tint; DPR-crisp. A flag-gated WebGL2
  surface (Phase 2B, `?glWaveform=1` — [WaveformGLRenderer.ts](apps/web/src/components/waveform/WaveformGLRenderer.ts))
  reproduces the same look on the GPU; default OFF, Canvas is the shipping path.

### Tunable constants (the only visual dials — module scope in TimelineStrip.tsx)

| Constant | Value | Range | Effect |
|---|---|---|---|
| `WF_MAX_AMP` | 0.43 | 0.40–0.46 | height vs padding |
| `WF_DISPLAY_GAIN` | 1.18 | 1.10–1.30 | speech confidence (clamped ≤1, no clip) |
| `WF_BODY_SMOOTH` | 0 | 0–2 | 0 = max syllable detail |
| `WF_PEAK_FLOOR_PX` | 0.5 | 0.4–0.8 | quiet/silence hairline |
| peak edge α | 0.4 | 0.4–0.6 | rim integration vs prominence |
| peak fill α | 0.55 | 0.45–0.65 | outer mass presence |
| body α | 0.95 | 0.85–1.0 | body solidity |
| baseline α | 0.05 | 0.04–0.08 | spine visibility |

---

## Regression matrix — capture a screenshot per cell

Compare Kimera vs Resolve. Rows = content, Columns = zoom (px/sec). Save PNGs under
`docs/waveform-baseline/<content>-<pxps>.png` so any future renderer diff can be A/B'd.

| Content \ Zoom | 8 px/s | 20 px/s | 50 px/s | 100 px/s | 300 px/s |
|---|---|---|---|---|---|
| Speech (dialogue) | | | | | |
| Music (full mix) | | | | | |
| Loud percussion / transients | | | | | |
| Silence / room tone | | | | | |
| Stereo clip | | | | | |
| Very short clip (< 0.5 s) | | | | | |
| Very long clip (> 30 min) | | | | | |

## Visual invariants to verify in each cell (must not regress)

- [ ] **Silhouette** reads as one integrated shape — the peak rim is part of the edge, not a
  drawn outline/box around it (no full-height vertical caps at clip ends).
- [ ] **Two-tone hierarchy** visible: brighter RMS mass inside a fainter peak envelope.
- [ ] **Geometry** is tight/beveled at the tips — no bubbly pill ends, even in quiet regions.
- [ ] **Speech articulation**: individual syllables/consonants distinguishable, not a melted ribbon.
- [ ] **Silence** is a near-invisible hairline on a barely-visible baseline (no fat ribbon, no
  noise-floor fuzz).
- [ ] **Loud passages flat-top** at ~86% lane height — never clip into the top/bottom padding.
- [ ] **Padding** symmetric; waveform vertically centered.
- [ ] **Tint** derives from the clip label color; not flat white.
- [ ] **Crisp at DPR** (retina) — no aliasing/blur.
- [ ] Consistent across zoom (no diamonds/triangles on long-source clips; density holds).

## How to capture

Run the editor (`pnpm dev`), drop the content types onto audio tracks, set the zoom to each
px/sec step, and screenshot the same clip region in Kimera and Resolve side by side. Keep track
height fixed (note which preset) so comparisons are apples-to-apples.
