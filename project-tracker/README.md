# Project tracker — versioned problem/solution log

**Rule: APPEND, never rewrite.** Every problem gets an entry in its category file with a version
number, a problem statement, and a short solution. If the same problem (or symptom) comes back,
do NOT edit the old entry — add a NEW version entry stating what was wrong/incomplete about the
previous version's fix and what the new version changes. The history of wrong turns is the value:
it stops us re-walking them.

## State fields vs. history (2026-08-13)

Append-only governs the PROBLEM/SOLUTION body — the reasoning trail — and that part is never
rewritten. It was never meant to cover an entry's **state fields** (in `architectural-debt.md`:
`Status` and `Expiry condition`; the equivalent in other category files is whatever line answers
"is this still a problem"). Those are current state, not history, the same way a `git status`
line is current state even though the commits under it are immutable. State fields MUST stay
accurate as of the latest update — edit them in place when the truth changes.

This split exists because the append-only reading was tried and cost real time: entries whose
last body update had already resolved the question (DEBT-013 phase 1 read, DEBT-018, DEBT-010)
kept a stale `Status:` line that said otherwise, because "append, never rewrite" was applied to a
field it was never meant to govern. Append-only protects the reasoning trail from being sanded
down into a false narrative. Leaving a status line wrong protects nothing — it just misleads the
next reader, who reasonably stops at the header before reading 40 updates deep.

**The rule going forward:** when a state field changes, edit it in place, and add one line to the
body immediately below the field block: `**Header updated <date>:** was "<old text>" — see the
<date> update below.` That line is itself append-only history (it is never later removed), so the
correction is preserved exactly the way the register already preserves everything else — the
difference is that the header a reader sees first now agrees with the entry's own conclusion.

## DEBT numbers are taken against every live branch (2026-08-16)

Two branches independently registered a different DEBT-022 the same day (`method-3-gpu-compositor`
and `artifact/adr021-step3`) — parallel sessions on parallel branches is the normal case here now,
not an edge case, so "the next free number" must be checked against every branch with tracker
changes in flight, not just the one in front of you. When a merge surfaces a collision, keep the
number already used by whichever entry is further along (shipped, retired, or otherwise load-bearing
elsewhere) and renumber the other — don't silently drop either one, and fix every cross-reference to
the renumbered entry, not just its own header.

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
| [voice-dictation.md](voice-dictation.md) | Web Speech dictation, transcript normalizer/arbitration, local-ASR refine, wake-word/voice sessions |

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
