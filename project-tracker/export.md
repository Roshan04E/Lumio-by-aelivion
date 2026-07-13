# Export

## v1 — Seed pointers (2026-07-06)
No new export problems logged since the tracker started. Known history lives in AGENTS.md /
memories; headline invariants:
- Exports read ORIGINAL bytes, never `proxyUrl`.
- Black export clips historically trace to WebCodecs decoder warmup/flush lifecycle, not the
  encoder/codec — debug with `kimera.exportDecodeDebug`.
- Encoder wedges mid-export are recovered gaplessly via `EncoderStallRecoveredError` (re-render from
  the last muxed frame).
- The fragmented-MP4 demux fix (playback-preview.md v4) also applies to export decodes — fMP4
  sources exported before 2026-07-06 could truncate/freeze past the first fragment.
