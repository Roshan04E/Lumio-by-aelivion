# Background tasks / scheduling

## v1 — Single background-work gate (Phase 2, 2026-07-06)
**Problem:** Deferrable work (ingest transcodes, span generation, filmstrips, waveform decodes,
still proxies) each had its own partial notion of "may I run now" — the gaps produced the Phase-1
freeze family and general jank ("background tasks must be light", editor crashed under load).
**Fix:** `apps/web/src/editor/performance/backgroundScheduler.ts` — one gate closed by `playing`,
`gesture` (any pointer press inside `.timeline-workspace`, capture-phase so the imperative gesture
code stays untouched), and `exporting` (local export). Producers consume it two ways:
`waitWhileBackgroundBlocked()` inside work loops (parks within one unit), `whenBackgroundIdle()`
before task starts (600ms debounce from gate-open, measured from the transition so long-open gates
cost nothing). Wired: source-proxy engine suspension (whole gate, not just isPlaying), span
generation (loop condition + gate-reopen re-kick), filmstrip/poster extraction, audio-peak decode,
still-proxy generation. Worker transcode also parks its audio/finalize tail now, not just the frame
loop. Telemetry: `window.__rfBgGate` ({reasons, holds}).
**Verify:** typecheck + editor:test + build clean; harness soak — proxies built only during the
paused phase, playback clean.
**Deferred (intentionally):** OPFS persistence for filmstrips/peaks (cache keys are session blob
URLs for local media — needs assetId plumbing first); IntersectionObserver-lazy filmstrips; scopes
readback decimation was found ALREADY solved (scopes tick rides <ColdTime>, which is suspended
during playback since the 2026-07-05 cold-clock work).

## v2 — Degradation controller + crash telemetry (Phase 4, 2026-07-06)
**Problem:** Under sustained load the editor could still die with "page unresponsive" (nothing shed
load), and a hard crash left no record of WHY (in-memory telemetry dies with the tab).
**Fix:** `degradation.ts` — two guards feeding the Phase-2 gate with new reasons:
- `pressure`: perfDiagnostics' longtask observer feeds `onLongTask`; when >30% of the trailing 5s
  was inside >50ms tasks → suspend background work, `forceAdaptiveStepDown()` (one rung, only when
  transport Auto is on, same cooldown as frame-drop steps), one-shot "Performance mode" notice.
  Released after 8s with zero long tasks.
- `memory` (Chrome `performance.memory`): heap >85% of limit → clear regenerable LRUs
  (`clearThumbnailCaches` / `clearAudioPeakCaches` — new exports) + suspend background until under.
Started idempotently from EditorPage mount. Telemetry: `window.__rfDegradation`.
`crash-telemetry.ts` (installed in main.tsx): onerror/unhandledrejection → 20-entry localStorage
ring buffer (`orreris.crashLog`) that SURVIVES the crash; next boot console.warns the previous
session's last-30-min tail; read via `window.__rfCrashLog`.
**Verify:** typecheck + editor:test + build clean. Field check: `__rfDegradation` counters move
under artificial load; `__rfCrashLog` captures a thrown error across a reload.
