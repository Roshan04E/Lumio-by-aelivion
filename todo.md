Setup
pnpm dev, open the editor, log in (demo@reelforge.studio / password123).
Keep two browser tabs of the same project: one with ?compositor=scene in the URL, one with ?compositor=dom. Open DevTools console in the scene tab — it must stay clean (no ScenePreviewCanvas: GPU compositor … failed log).
A. Graded text on the GPU (4.1c fold 2)
Add a Text clip; type something large/bright.
Apply a color grade to it (Inspector → effects → Brightness/Contrast or Curves; push exposure/temperature hard so the shift is obvious).

✅ Scene tab: the text takes the grade (tinted), identical to the DOM tab.
Scrub the playhead / play → grade stays correct; no console fallback log.
B. Masked text — the new cross-renderer feature
Select the text clip → add a clip mask (rectangle or ellipse), position it so it clips off part of the text.
✅ DOM tab: the text is now actually clipped (before this session it showed unmasked/full text — this was the bug you flagged).
✅ Scene tab: identical clipping.
Scale the text up ~3–5× with the mask in place → the hidden portion stays hidden in comp space (the mask doesn't scale with the text) — same in both tabs.
Move the mask / animate mask keyframes → both tabs track together.
C. Masked shape (same path as text)
Add a Shape clip, give it a clip mask.
✅ Shape clips in both DOM and scene tabs (shapes use the identical code path as text).
D. 3D-tilted text (4.1c fold 3)
Text clip → set rotateX / rotateY / perspective (3D tilt).
✅ Scene tab tilts the text on the GPU, matching DOM; no fallback log.
E. No-fallback confirmation (4.1d)
With a text clip that's graded + masked + tilted all at once, watch the scene-tab console.
✅ It never logs the DOM-fallback message — text now always composites on the GPU.
F. Export parity (the real payoff)
Local export (Ctrl+M) a short clip containing graded / masked / tilted text → the saved MP4 shows the grade, the mask clip, and the tilt.
Cloud export (Ctrl+Shift+M) the same → matches the local export and the preview.
G. Regressions (should look unchanged)
Plain text / captions with no mask/grade/tilt → identical to before in both tabs.
A normal masked media clip → unchanged.