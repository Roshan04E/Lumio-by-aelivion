/**
 * Animated (SMIL) vector graphic primitives — assertion script (no test framework; exits non-zero on failure).
 *
 * Locks the SHARED contract every renderer depends on: cycle detection, the SMIL deep-link rewrite
 * (shifted `begin` + an immediate `end`/`fill="freeze"` so the bake is TIME-INVARIANT), and the
 * frame-selection math. Preview, local export, and Remotion all call these, so a regression here
 * silently desyncs all three (or freezes animation back to the settled frame).
 *
 * Run: pnpm --filter @orreris/worker graphic:test
 */

import {
  getGraphicAnimationCycleSeconds,
  graphicAnimationBakeTime,
  graphicAnimationFrameAt,
  graphicAnimationFrameFromPhase,
  graphicAnimationPhase,
  GRAPHIC_DURATION_PROPERTY,
  GRAPHIC_PROGRESS_PROPERTY,
  graphicAnimationFrameCount,
  graphicAnimationLoopsByDefault,
  graphicIsAnimated,
  graphicToAnimatedDataUrl,
  graphicToDataUrl,
  normalizeGraphicSvg,
  resolveGraphicAnimation,
  shiftSvgSmilBegin,
  GRAPHIC_ANIM_MAX_FRAMES,
  type TimelineKeyframeV2,
} from "@orreris/shared";

let failures = 0;
function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ok  ${name}`);
    return;
  }
  failures += 1;
  console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

const DRAW_IN = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><g fill="none" stroke="currentColor"><path stroke-dasharray="48" stroke-dashoffset="48" d="M4 12L10 18L20 6"><animate attributeName="stroke-dashoffset" values="48;0" dur="1.2s" fill="freeze"/></path></g></svg>`;
const SPINNER = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 3a9 9 0 1 0 9 9"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/></path></svg>`;
const STATIC = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="50" r="42" fill="currentColor"/></svg>`;

console.log("cycle detection");
check("draw-in dur=1.2s → 1.2s cycle", getGraphicAnimationCycleSeconds(DRAW_IN) === 1.2, String(getGraphicAnimationCycleSeconds(DRAW_IN)));
check("spinner dur=1s indefinite → 1s cycle", getGraphicAnimationCycleSeconds(SPINNER) === 1, String(getGraphicAnimationCycleSeconds(SPINNER)));
check("static svg → null (no animation)", getGraphicAnimationCycleSeconds(STATIC) === null);
check("ms units parse", getGraphicAnimationCycleSeconds(DRAW_IN.replace('dur="1.2s"', 'dur="600ms"')) === 0.6);
check("finite repeatCount multiplies dur", getGraphicAnimationCycleSeconds(SPINNER.replace('repeatCount="indefinite"', 'repeatCount="3"')) === 3);
check("graphicIsAnimated(draw-in)", graphicIsAnimated({ svg: DRAW_IN, fill: "#fff" }));
check("!graphicIsAnimated(static)", !graphicIsAnimated({ svg: STATIC, fill: "#fff" }));

console.log("\nimport preserves the animation (normalizeGraphicSvg)");
// REGRESSION GUARD: normalizeGraphicSvg used to settle SMIL at IMPORT, destroying the animation before
// it was ever stored — every graphic then looked static to graphicIsAnimated() no matter what the
// renderers did. The stored svg is the source of truth and MUST keep its SMIL.
const importedDrawIn = normalizeGraphicSvg(DRAW_IN, undefined);
check("imported svg keeps <animate>", importedDrawIn.svg.includes("<animate"));
check("imported graphic reports as animated", graphicIsAnimated(importedDrawIn));
check("imported graphic keeps its cycle", getGraphicAnimationCycleSeconds(importedDrawIn.svg) === 1.2);
const importedRecolored = normalizeGraphicSvg(DRAW_IN.replace("currentColor", "#5b8def"), "#5b8def");
check("recolor-normalized import still animated", graphicIsAnimated(importedRecolored));
check("recolor-normalized import maps color to currentColor", importedRecolored.svg.includes("currentColor"));
check("imported static svg stays static", !graphicIsAnimated(normalizeGraphicSvg(STATIC, undefined)));
check("import reads viewBox dims", importedDrawIn.naturalWidth === 24 && importedDrawIn.naturalHeight === 24);

console.log("\nauthor loop intent (the DEFAULT the inspector overrides)");
check("spinner (repeatCount=indefinite) loops by default", graphicAnimationLoopsByDefault(SPINNER));
check("draw-in (fill=freeze, one-shot) does NOT loop by default", !graphicAnimationLoopsByDefault(DRAW_IN));
check("repeatDur=indefinite also loops", graphicAnimationLoopsByDefault(DRAW_IN.replace('fill="freeze"', 'repeatDur="indefinite"')));
check("finite repeatCount does not loop", !graphicAnimationLoopsByDefault(SPINNER.replace('repeatCount="indefinite"', 'repeatCount="3"')));

console.log("\nSMIL deep-link rewrite");
const shifted = shiftSvgSmilBegin(DRAW_IN, 0.5);
// THE INVARIANT (project-tracker/export.md v6): a bake must be TIME-INVARIANT. `begin="-Ts"` alone
// renders frame T only at document time 0, and an <img>'s SVG clock runs from load — so whatever the
// capture delay is, it gets ADDED to the phase. `end`+`fill="freeze"` end the animation immediately
// and hold frame T forever, so a slow/queued capture can't drift. Without this the local export's
// parallel rasterize skewed later frames by a large fraction of a cycle.
check("freezes the animation (time-invariant bake)", shifted.includes('fill="freeze"'), shifted);
check("ends the active interval immediately", /end="0\.001s"/.test(shifted), shifted);
// end MUST be > 0: end="0s" makes Chrome render the BASE state instead of the frozen value (the
// interval ends at the document start and never applies) — graphic:render catches it, this pins it.
check("bake end is strictly > 0", !shifted.includes('end="0s"'));
// begin is -(T - ε) so that end - begin = T exactly: the freeze lands on frame T, not T + ε.
check("deep-links to the target frame (ε-compensated)", shifted.includes('begin="-0.499s"'), shifted);
// The author's repeat intent MUST survive — forcing repeatCount="indefinite" here overrode
// fill="freeze" and made one-shot draw-ins loop against their author's intent.
check("does NOT force repeatCount", !shifted.includes('repeatCount="indefinite"'));
check("preserves attributeName", shifted.includes('attributeName="stroke-dashoffset"'));
check("preserves values", shifted.includes('values="48;0"'));
check("preserves dur", shifted.includes('dur="1.2s"'));
check("keeps self-closing form valid", !shifted.includes("<animate") || /<animate[^>]*\/>/.test(shifted), shifted);
check("does not duplicate begin", (shifted.match(/begin=/g) ?? []).length === 1);
check("does not duplicate end", (shifted.match(/\bend=/g) ?? []).length === 1);
// Scoped to the <animate> tag: `fill` is also a PAINT attribute elsewhere in the document (the
// wrapping <g fill="none">), so a document-wide count would measure the wrong thing.
const shiftedAnimateTag = /<animate\b[^>]*>/.exec(shifted)?.[0] ?? "";
check("does not duplicate fill on the animation", (shiftedAnimateTag.match(/\bfill=/g) ?? []).length === 1, shiftedAnimateTag);
check("leaves paint fill on other elements alone", shifted.includes('<g fill="none"'));
const reshifted = shiftSvgSmilBegin(shifted, 0.25);
check(
  "re-shift replaces (not appends) the timing attrs",
  (reshifted.match(/begin=/g) ?? []).length === 1 && (reshifted.match(/\bend=/g) ?? []).length === 1
);
// An authored delay is choreography — shift it, don't clobber it.
const delayed = shiftSvgSmilBegin(DRAW_IN.replace("<animate ", '<animate begin="0.5s" '), 0.7);
check("author's begin delay is shifted, not clobbered", delayed.includes('begin="-0.199s"'), delayed);
// A staggered icon baked BEFORE its delay elapses must show its base state: begin(0.301s) > end(ε)
// leaves no active interval at all, which renders exactly that.
const notYetStarted = shiftSvgSmilBegin(DRAW_IN.replace("<animate ", '<animate begin="0.5s" '), 0.2);
check("un-started delay bakes an inactive interval (base state)", notYetStarted.includes('begin="0.301s"'), notYetStarted);
const spinnerShifted = shiftSvgSmilBegin(SPINNER, 0.3);
check("animateTransform: begin injected", spinnerShifted.includes('begin="-0.299s"'), spinnerShifted);
check("animateTransform: frozen too (a spinner is the worst drift case)", spinnerShifted.includes('fill="freeze"') && spinnerShifted.includes('end="0.001s"'));
check("animateTransform: author repeatCount preserved", (spinnerShifted.match(/repeatCount="indefinite"/g) ?? []).length === 1);
check("animateTransform: from/to preserved", spinnerShifted.includes('from="0 12 12"') && spinnerShifted.includes('to="360 12 12"'));
check("static svg passes through unchanged", shiftSvgSmilBegin(STATIC, 0.5) === STATIC);

console.log("\nplan resolution (SVG intent + layer overrides)");
const spinnerPlan = resolveGraphicAnimation({ svg: SPINNER, fill: "#fff" })!;
const drawInPlan = resolveGraphicAnimation({ svg: DRAW_IN, fill: "#fff" })!;
check("static graphic → no plan", resolveGraphicAnimation({ svg: STATIC, fill: "#fff" }) === null);
check("spinner plan loops (author intent)", spinnerPlan.loop);
check("draw-in plan does not loop (author intent)", !drawInPlan.loop);
check("plan playDuration defaults to natural cycle", drawInPlan.playDurationSeconds === 1.2 && drawInPlan.naturalCycleSeconds === 1.2);
const forcedOnce = resolveGraphicAnimation({ svg: SPINNER, fill: "#fff", animation: { loop: "once" } })!;
check("override loop=once beats author's indefinite", !forcedOnce.loop);
const forcedLoop = resolveGraphicAnimation({ svg: DRAW_IN, fill: "#fff", animation: { loop: "infinite" } })!;
check("override loop=infinite beats author's freeze", forcedLoop.loop);
const slowed = resolveGraphicAnimation({ svg: DRAW_IN, fill: "#fff", animation: { durationSeconds: 3 } })!;
check("duration override time-scales playback", slowed.playDurationSeconds === 3 && slowed.naturalCycleSeconds === 1.2);
check("duration override drives frameCount", slowed.frameCount === graphicAnimationFrameCount(3));
check("zero/negative duration override ignored", resolveGraphicAnimation({ svg: DRAW_IN, fill: "#fff", animation: { durationSeconds: 0 } })!.playDurationSeconds === 1.2);

console.log("\nframe selection math");
check("frameCount = round(cycle*30)", drawInPlan.frameCount === 36, String(drawInPlan.frameCount));
check("frameCount >= 1 for tiny cycles", graphicAnimationFrameCount(0.001) === 1);
check("frameCount capped", graphicAnimationFrameCount(9999) === GRAPHIC_ANIM_MAX_FRAMES);
const n = drawInPlan.frameCount;

// ONE-SHOT: runs once over [0, duration] then HOLDS the completed frame.
check("once: t=0 → frame 0", graphicAnimationFrameAt(drawInPlan, 0) === 0);
check("once: t=duration → LAST frame (completed)", graphicAnimationFrameAt(drawInPlan, 1.2) === n - 1);
check("once: past the end HOLDS the last frame", graphicAnimationFrameAt(drawInPlan, 99) === n - 1);
check("once: mid → mid frame", graphicAnimationFrameAt(drawInPlan, 0.6) === Math.floor((n - 1) / 2));
check("once: negative clamps to frame 0", graphicAnimationFrameAt(drawInPlan, -5) === 0);
// Just INSIDE the active end, never exactly at it — deep-linking at exactly begin+dur rendered the
// base (blank) state in Chrome instead of the frozen final. Still ≥99.9% through = the completed look.
const lastBake = graphicAnimationBakeTime(drawInPlan, n - 1);
check("once: last baked frame is essentially the cycle end", lastBake > 1.2 * 0.99 && lastBake < 1.2, String(lastBake));

// LOOPING: wraps seamlessly; the endpoint is NOT duplicated.
check("loop: t=0 → frame 0", graphicAnimationFrameAt(spinnerPlan, 0) === 0);
check("loop: t=cycle wraps to frame 0", graphicAnimationFrameAt(spinnerPlan, 1) === 0);
check("loop: t=2*cycle wraps to frame 0", graphicAnimationFrameAt(spinnerPlan, 2) === 0);
check("loop: mid → mid frame", graphicAnimationFrameAt(spinnerPlan, 0.5) === spinnerPlan.frameCount / 2);
check("loop: just under cycle → last frame", graphicAnimationFrameAt(spinnerPlan, 1 - 1e-6) === spinnerPlan.frameCount - 1);
// Negative CLIP-LOCAL time means the playhead is before the clip starts (it isn't rendered then), so the
// static/ramp phase clamps to 0 rather than wrapping to an arbitrary mid-cycle frame. A negative PHASE —
// which only a deliberately negative progress key produces — still wraps (see below).
check("loop: negative local time → frame 0 (clip hasn't started)", graphicAnimationFrameAt(spinnerPlan, -0.5) === 0);
check("loop: negative PHASE still wraps forward", graphicAnimationFrameFromPhase(spinnerPlan, -0.5) === spinnerPlan.frameCount / 2);
check("loop: bake spreads over [0,cycle) — no duplicated endpoint", graphicAnimationBakeTime(spinnerPlan, spinnerPlan.frameCount - 1) < 1);

// The parity contract: bakeTime(frameAt(t)) must round-trip, or Remotion (which derives its deep-link
// time from the index) drifts off the pre-baked preview/export sequences.
// (The final one-shot frame is exempt: its bake time is nudged just inside the active end, so it maps
// back one frame. Renderers only ever go bakeTime(frameAt(t)) — never the inverse — so this is moot.)
check("round-trip: once", [0, 5, 17].every((i) => graphicAnimationFrameAt(drawInPlan, graphicAnimationBakeTime(drawInPlan, i)) === i));
check("round-trip: loop", [0, 5, 17, spinnerPlan.frameCount - 1].every((i) => graphicAnimationFrameAt(spinnerPlan, graphicAnimationBakeTime(spinnerPlan, i)) === i));
check("frameIndex never out of range", [0, 0.3, 0.7, 1.1, 5.9, -3.2].every((t) =>
  [drawInPlan, spinnerPlan, slowed].every((p) => {
    const i = graphicAnimationFrameAt(p, t);
    return i >= 0 && i < p.frameCount;
  })
));
// Time-scaling: a 1.2s draw-in stretched to 3s reaches its midpoint at 1.5s, not 0.6s.
check("duration override stretches selection", graphicAnimationFrameAt(slowed, 1.5) === Math.floor((slowed.frameCount - 1) / 2));
check("duration override still holds at its own end", graphicAnimationFrameAt(slowed, 3) === slowed.frameCount - 1);

console.log("\nkeyframed phase (progress keys → duration ramp → static)");
const key = (property: string, timeSeconds: number, value: number): TimelineKeyframeV2 => ({
  id: `k_${property}_${timeSeconds}`,
  target: { scope: "layer", property },
  timeSeconds,
  value,
  interpolation: "linear",
  temporal: {}
});

// STATIC (no keys) — unchanged behavior.
check("no keys → phase = t/duration", Math.abs(graphicAnimationPhase(drawInPlan, 0.6) - 0.5) < 1e-9);

// PROGRESS keys ARE the phase: hold, reverse, N cycles all fall out.
const progressPlan = resolveGraphicAnimation(
  { svg: SPINNER, fill: "#fff" },
  { animations: [key(GRAPHIC_PROGRESS_PROPERTY, 0, 0), key(GRAPHIC_PROGRESS_PROPERTY, 4, 2)] }
)!;
check("progress keys drive the phase", Math.abs(graphicAnimationPhase(progressPlan, 2) - 1) < 1e-9, String(graphicAnimationPhase(progressPlan, 2)));
check("progress keys reach 2 cycles at the last key", Math.abs(graphicAnimationPhase(progressPlan, 4) - 2) < 1e-9);
check("progress holds at the edges (evaluator edge-hold)", graphicAnimationPhase(progressPlan, 99) === 2 && graphicAnimationPhase(progressPlan, -99) === 0);
check("progress phase → wrapped frame (loop)", graphicAnimationFrameFromPhase(progressPlan, 1.5) === graphicAnimationFrameFromPhase(progressPlan, 0.5));
// REVERSE: a descending progress ramp plays the cycle backward.
const reversePlan = resolveGraphicAnimation(
  { svg: SPINNER, fill: "#fff" },
  { animations: [key(GRAPHIC_PROGRESS_PROPERTY, 0, 1), key(GRAPHIC_PROGRESS_PROPERTY, 2, 0)] }
)!;
check("progress can run BACKWARD", graphicAnimationPhase(reversePlan, 0.5) > graphicAnimationPhase(reversePlan, 1.5));
// Progress OUTRANKS a duration ramp.
const bothPlan = resolveGraphicAnimation(
  { svg: SPINNER, fill: "#fff" },
  { animations: [key(GRAPHIC_PROGRESS_PROPERTY, 0, 0), key(GRAPHIC_PROGRESS_PROPERTY, 4, 2), key(GRAPHIC_DURATION_PROPERTY, 0, 5)] }
)!;
check("progress keys outrank a duration ramp", Math.abs(graphicAnimationPhase(bothPlan, 2) - 1) < 1e-9);

// DURATION ramp → integrated phase (∫ 1/duration). A CONSTANT ramp must equal the static case exactly.
const constRamp = resolveGraphicAnimation({ svg: SPINNER, fill: "#fff" }, { animations: [key(GRAPHIC_DURATION_PROPERTY, 0, 2), key(GRAPHIC_DURATION_PROPERTY, 4, 2)] })!;
check("constant duration ramp = t/duration", Math.abs(graphicAnimationPhase(constRamp, 3) - 1.5) < 1e-9, String(graphicAnimationPhase(constRamp, 3)));
check("duration ramp holds the first value before the first key", Math.abs(graphicAnimationPhase(
  resolveGraphicAnimation({ svg: SPINNER, fill: "#fff" }, { animations: [key(GRAPHIC_DURATION_PROPERTY, 2, 2)] })!, 1
) - 0.5) < 1e-9);
// Linear 1s→3s over [0,2]: ∫₀² du/(1+u) = ln(3) ≈ 1.0986 cycles. Verifies the closed form, and that we
// did NOT trapezoid a hyperbola (that would give 2*(1/1+1/3)/2 ≈ 1.333 — 21% off).
const ramp = resolveGraphicAnimation({ svg: SPINNER, fill: "#fff" }, { animations: [key(GRAPHIC_DURATION_PROPERTY, 0, 1), key(GRAPHIC_DURATION_PROPERTY, 2, 3)] })!;
check("linear duration ramp integrates to ln(3)", Math.abs(graphicAnimationPhase(ramp, 2) - Math.log(3)) < 1e-9, String(graphicAnimationPhase(ramp, 2)));
check("ramp is NOT the trapezoid approximation", Math.abs(graphicAnimationPhase(ramp, 2) - 1.3333) > 0.2);
// THE reason the ramp is integrated: evaluating `t % duration(t)` directly would make the phase jump
// every time the duration changed. Sweep the whole ramp and assert it only ever rises, smoothly.
check("ramp phase is monotonic + continuous (no jump at the key)", (() => {
  let prev = graphicAnimationPhase(ramp, 0);
  for (let t = 0.05; t <= 4; t += 0.05) {
    const p = graphicAnimationPhase(ramp, t);
    if (p < prev - 1e-9 || p - prev > 0.2) return false; // must rise, never leap
    prev = p;
  }
  return true;
})());
check("ramp continues past the last key at the last value", Math.abs(graphicAnimationPhase(ramp, 5) - (Math.log(3) + 1)) < 1e-9);
check("duration ramp drives frameCount off the SLOWEST cycle", ramp.frameCount === graphicAnimationFrameCount(3));

console.log("\ndata URL bake");
const graphic = { svg: DRAW_IN, fill: "#ff0000", naturalWidth: 24, naturalHeight: 24 };
const animUrl = graphicToAnimatedDataUrl(graphic, 0.6);
const decoded = decodeURIComponent(animUrl.replace(/^data:image\/svg\+xml,/, ""));
check("animated url is an svg data url", animUrl.startsWith("data:image/svg+xml,"));
check("animated bake KEEPS the animation", decoded.includes("<animate"));
check("animated bake deep-links to the time", decoded.includes('begin="-0.599s"'), decoded);
check("animated bake is frozen (capture-time independent)", decoded.includes('fill="freeze"') && decoded.includes('end="0.001s"'));
check("animated bake applies fill", decoded.includes('color="#ff0000"'));
check("animated bake injects intrinsic size", /width="\d+"/.test(decoded) && /height="\d+"/.test(decoded));
const staticDecoded = decodeURIComponent(graphicToDataUrl(graphic).replace(/^data:image\/svg\+xml,/, ""));
check("static bake STRIPS the animation (settled)", !staticDecoded.includes("<animate"));
check("static bake still applies fill", staticDecoded.includes('color="#ff0000"'));
// Palette recolor must survive the animated path (parity with the settled path).
const multi = { svg: DRAW_IN.replace("currentColor", "#123456"), fill: "#000000", palette: [{ from: "#123456", to: "#abcdef" }] };
const multiDecoded = decodeURIComponent(graphicToAnimatedDataUrl(multi, 0.1).replace(/^data:image\/svg\+xml,/, ""));
check("animated bake applies palette recolor", multiDecoded.includes("#abcdef") && !multiDecoded.includes("#123456"));

console.log(failures === 0 ? "\nAll graphic-animation checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
