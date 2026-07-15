# Project tracker — versioned problem/solution log

**Rule: APPEND, never rewrite.** Every problem gets an entry in its category file with a version
number, a problem statement, and a short solution. If the same problem (or symptom) comes back,
do NOT edit the old entry — add a NEW version entry stating what was wrong/incomplete about the
previous version's fix and what the new version changes. The history of wrong turns is the value:
it stops us re-walking them.

## Entry format

```
## vN — <one-line title> (YYYY-MM-DD)
**Problem:** what the user saw / what was broken, in plain words.
**Root cause:** the actual mechanism (only if known — say "suspected" otherwise).
**Fix:** what changed, which files/flags/versions.
**Verify:** how we proved it (gate, harness, user confirmation).
[if superseding an earlier version] **Why vN-1 wasn't enough:** ...
```

## Categories

| File | Covers |
|---|---|
| [playback-preview.md](playback-preview.md) | Viewer playback, freezes, WebCodecs decode, proxy overlay, quality modes |
| [assets-media.md](assets-media.md) | Media files, encodings/containers, ingest proxies, stock downloads, thumbnails/waveforms |
| [timeline.md](timeline.md) | Timeline UI, gestures, playhead/clock, clips/tracks |
| [editor-ui.md](editor-ui.md) | Editor chrome responsiveness: panels, inspector, toasts, re-render hygiene |
| [background-tasks.md](background-tasks.md) | Background scheduling, transcodes, span generation, caches |
| [export.md](export.md) | Local/worker export, encoders, muxing |
| [infrastructure.md](infrastructure.md) | Build, service worker, dev/preview origins, tooling |
| [nle-import-export.md](nle-import-export.md) | EDL/FCPXML/prproj import fidelity, transition/keyframe mapping, FCPXML export |
| [ai-tools.md](ai-tools.md) | AI tool plumbing: handler contract, cross-tool artifact reuse, matte/tracking lifecycle, tool surfaces |

Related (don't duplicate): `AGENTS.md` = live agent handoff log; `architecture.md` = product/feature
tracker. This folder is the PROBLEM history.

## Debugging assets

- Playwright repro harness: scratchpad `repro-freeze.mjs` pattern — mints a JWT from `.env`,
  opens :4173, screenshot-hashes the viewer every 500ms + dumps `__rf*` telemetry; persistent-profile
  mode builds proxies while paused, reloads warm, then plays.
- Demux probe: `demux-probe.mjs` pattern — replicates `demuxIndex()` in Node against files in
  `apps/api/storage/uploads` to measure sample-index coverage.
- Always check the console's `index-*.js` bundle hash before believing "not fixed" — the old
  CacheFirst service worker burned us twice serving pre-fix bundles.
