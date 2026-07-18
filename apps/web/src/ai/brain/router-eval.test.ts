/**
 * Orreris Brain — router acceptance suite (B1). Run: `pnpm --filter @orreris/web brain:eval`
 *
 * Two corpora, per AI_ARCHITECTURE.md → Instrumentation:
 *  - TRANSACTIONAL: prompts that MUST resolve locally at tier 0 (plan / answer / undo);
 *  - AMBIGUITY: prompts that MUST escalate — the wrong-fast-path count must be ZERO. This is the
 *    precision-first contract: a rule that fires on any of these does not ship.
 *
 * Standalone tsx assert script (no test framework), same convention as editor:test / memory:test.
 */

import type { TimelineComposition, TimelineLayer, TimelineTrackType } from "@orreris/shared";
import { routePrompt, type BrainContext, type BrainRouteResult } from "./router";
import { clearRuleStats, recordRuleRejected } from "./feedback";
import {
  __setSemanticEmbedderForTests,
  clearSemanticStores,
  extractSkeleton,
  forgetLearnedPlan,
  learnPhrase,
  routePromptSemantic,
  storeCachedPlan
} from "./semantic";
import { clearWakePhrases, learnWakePhrase, loadWakePhrases, looksLikeWakeAttempt, matchWakeWord } from "../wake-word";
import { speakable, splitSpeakable } from "../tts";
import { arbitrateFinal, normalizeTranscript } from "../transcript-normalizer";
import { clearDecisionTrace, recordDecisionTrace } from "../decision-trace";
import { looksLikeSelfEcho } from "../echo-guard";

function layer(
  partial: Partial<TimelineLayer> & Pick<TimelineLayer, "id" | "type" | "startSeconds" | "durationSeconds">
): TimelineLayer {
  return { trackId: "t", name: partial.id, ...partial } as TimelineLayer;
}

function comp(tracks: { type: TimelineTrackType; layers: TimelineLayer[] }[]): TimelineComposition {
  return {
    id: "c",
    name: "c",
    width: 1080,
    height: 1920,
    fps: 30,
    durationSeconds: 30,
    backgroundColor: "#000000",
    tracks: tracks.map((track, index) => ({ id: `track_${index}`, type: track.type, name: `track_${index}`, layers: track.layers }))
  };
}

// clip 1 = vid_a (0–5s), clip 2 = text_1 (2–6s), clip 3 = vid_b (5–10s)
const composition = comp([
  {
    type: "video",
    layers: [
      layer({ id: "vid_a", type: "video", startSeconds: 0, durationSeconds: 5 }),
      layer({ id: "vid_b", type: "video", startSeconds: 5, durationSeconds: 5 })
    ]
  },
  { type: "text", layers: [layer({ id: "text_1", type: "text", startSeconds: 2, durationSeconds: 4 })] }
]);

const base: BrainContext = { composition, selection: [], nowSeconds: 3 };

function route(prompt: string, context: Partial<BrainContext> = {}): BrainRouteResult {
  return routePrompt(prompt, { ...base, ...context });
}

let failures = 0;

function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✕ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function answerText(result: BrainRouteResult): string {
  return result.kind === "answer" ? result.text : "";
}

/** First step of a compiled reflex plan; empty on any structural violation (which also fails checks). */
function firstAction(result: BrainRouteResult): { actionId?: string | undefined; params?: unknown } {
  if (result.kind !== "plan") {
    return {};
  }
  const plan = result.plan;
  check("  (plan is brain-labeled, free, non-empty)", plan.provider === "brain" && plan.totalCredits === 0 && plan.steps.length > 0);
  const step = plan.steps[0]!;
  return { actionId: step.actionId, params: step.params };
}

console.log("brain:eval — tier-0 reflex router\n");
console.log("TRANSACTIONAL corpus (must resolve locally):");

{
  const result = route("what are your capabilities");
  check("capabilities question → local answer, generated from registries", result.kind === "answer" && /Effects/i.test(answerText(result)));
}
check("'what can you do' → local answer", route("What can you do?").kind === "answer");
check("paraphrase 'what you can do for me' → local answer (2026-07-10 gap)", route("what you can do for me").kind === "answer");
check("paraphrase 'what are you capable of' → local answer", route("what are you capable of?").kind === "answer");
check("paraphrase 'show me what you can do' → local answer", route("show me what you can do").kind === "answer");
console.log("\nHEAR-CHECK reflex (voice sanity check — was a 4–15s LLM round-trip):");
check("'are you listening to me' → instant answer", route("are you listening to me?").kind === "answer");
check("'can you hear me' → instant answer", route("Can you hear me").kind === "answer");
check("'do you hear me?' → instant answer", route("do you hear me?").kind === "answer");
check("misheard 'you're listening to me' → instant answer", route("you're listening to me").kind === "answer");
check("'are you listening to the audio track' does NOT match (escalates)", route("are you listening to the audio track").kind === "escalate");
check("'can you hear the music' does NOT match (escalates)", route("can you hear the music in clip 2").kind === "escalate");
check("'what can i do' (about the USER, not the AI) → escalates", route("what can i do").kind === "escalate");
{
  const result = route("play the video");
  check("'play the video' → EXECUTES (transport command, not a shortcut tip)", result.kind === "command" && result.commandId === "transport");
}
{
  const result = route("enter pan mode");
  check("'enter pan mode' → EXECUTES (setTool hand, not a tip)", result.kind === "command" && result.commandId === "setTool" && (result.params as { tool?: string }).tool === "hand");
}
check("'undo' → panel undo", route("undo").kind === "undo" && route("undo that").kind === "undo");

console.log("\nWHY reflex (K5 explainability — the decision trace as an instant answer):");
{
  clearDecisionTrace();
  const empty = route("why did you do that?");
  check("no trace yet → honest empty answer", empty.kind === "answer" && /No AI decision recorded/i.test(answerText(empty)));
  recordDecisionTrace({
    prompt: "make it moody",
    route: "🌐 World Model hypothesis planner (k4.mood-blueprint)",
    zeroTokens: true,
    notes: ["World Model consulted: composition-text (measured) · 0 tokens", `look "moody" → Noir @ 55%`],
    steps: ["Base grade (Noir)"],
    applied: 1,
    failed: 0,
    at: Date.now()
  });
  const why = route("why did you do that?");
  check(
    "'why did you do that?' → trace answer with route + provenance + operations",
    why.kind === "answer" && /hypothesis planner/.test(answerText(why)) && /composition-text/.test(answerText(why)) && /Base grade/.test(answerText(why))
  );
  check("'what did you just do' → same trace answer", route("what did you just do").kind === "answer");
  check("'explain the last edit' → same trace answer", /Noir/.test(answerText(route("explain the last edit"))));
  check("MUST NOT: 'why is clip 2 dark' escalates (a real question, not a why-ask)", route("why is clip 2 dark").kind === "escalate");
  check("MUST NOT: 'explain color grading' escalates", route("explain color grading").kind === "escalate");
  clearDecisionTrace();
}
{
  const result = route("what is clip 2");
  check("'what is clip 2' → local description of the text layer", result.kind === "answer" && /text/.test(answerText(result)));
}
{
  const step = firstAction(route("delete clip 3"));
  check("'delete clip 3' → deleteLayer(vid_b) plan", step.actionId === "deleteLayer" && (step.params as { layerId?: string }).layerId === "vid_b");
}
{
  const step = firstAction(route("remove the second clip"));
  check("'remove the second clip' → deleteLayer(text_1) plan", step.actionId === "deleteLayer" && (step.params as { layerId?: string }).layerId === "text_1");
}
{
  const result = route("delete clip 9");
  check("'delete clip 9' (doesn't exist) → honest local answer, no plan", result.kind === "answer" && /no clip 9/i.test(answerText(result)));
}
console.log("\nAPPLY-LOOK reflex (K3 follow-up — preset asks used to buy a 15–20s LLM round):");
{
  const step = firstAction(route("apply the noir look to clip 1"));
  const params = step.params as { effectType?: string; params?: { look?: string } };
  check(
    "'apply the noir look to clip 1' → addEffect(creativeLook, Noir) plan, 0 tokens",
    step.actionId === "addEffect" && params.effectType === "creativeLook" && params.params?.look === "Noir"
  );
}
{
  const step = firstAction(route("apply a moody look", { selection: ["vid_a"] }));
  const params = step.params as { params?: { look?: string; intensity?: number } };
  check(
    "'apply a moody look' (selection) → alias-repaired Noir @ 55",
    step.actionId === "addEffect" && params.params?.look === "Noir" && params.params?.intensity === 55
  );
}
{
  const result = route("apply the vaporwave look to clip 1");
  check(
    "'apply the vaporwave look' → instant capability-gap answer listing BOTH libraries (no model loop)",
    result.kind === "answer" && /Color looks/.test(answerText(result)) && /Noir/.test(answerText(result)) && /Text looks/.test(answerText(result))
  );
}
{
  const step = firstAction(route("apply the neon look to clip 2"));
  const params = step.params as { look?: string };
  check("'apply the neon look to clip 2' (text clip) → applyTextLook(Neon) plan", step.actionId === "applyTextLook" && params.look === "Neon");
}
{
  const result = route("apply the neon look to clip 1");
  check(
    "'apply the neon look' on a VIDEO clip → honest type answer, no plan",
    result.kind === "answer" && /text look/.test(answerText(result))
  );
}
{
  const step = firstAction(route("apply the lower third look to clip 2"));
  const params = step.params as { look?: string };
  check("'apply the lower third look' → applyTextLook(Lower Third)", step.actionId === "applyTextLook" && params.look === "Lower Third");
}
check("'apply the noir look to the intro' (vague target) → escalates", route("apply the noir look to the intro").kind === "escalate");
check("'apply the noir look' with no unique target → escalates", route("apply the noir look", { nowSeconds: 20 }).kind === "escalate");
{
  const result = route("apply the noir look to clip 9");
  check("'apply the noir look to clip 9' (doesn't exist) → honest bounds answer", result.kind === "answer" && /no clip 9/i.test(answerText(result)));
}

console.log("\nAPPLY-MOTION reflex (K5 follow-up — 'pop in clip 2' used to buy an LLM round):");
{
  const step = firstAction(route("pop in clip 1"));
  const params = step.params as { kind?: string; style?: string; layerId?: string };
  check(
    "'pop in clip 1' → applyMotion(entrance, pop, vid_a)",
    step.actionId === "applyMotion" && params.kind === "entrance" && params.style === "pop" && params.layerId === "vid_a"
  );
}
{
  const step = firstAction(route("make clip 3 slide in from the left"));
  const params = step.params as { kind?: string; style?: string; direction?: string; layerId?: string };
  check(
    "'make clip 3 slide in from the left' → applyMotion(entrance, slide, left, vid_b)",
    step.actionId === "applyMotion" && params.style === "slide" && params.direction === "left" && params.layerId === "vid_b"
  );
}
{
  const step = firstAction(route("zoom out clip 1"));
  const params = step.params as { kind?: string; style?: string };
  check("'zoom out clip 1' → applyMotion(exit, scale via zoom alias)", step.actionId === "applyMotion" && params.kind === "exit" && params.style === "scale");
}
{
  const step = firstAction(route("make clip 2 pulse"));
  const params = step.params as { kind?: string; style?: string };
  check("'make clip 2 pulse' → applyMotion(emphasis, pulse)", step.actionId === "applyMotion" && params.kind === "emphasis" && params.style === "pulse");
}
check("'make it pop in' (deictic) → escalates", route("make it pop in").kind === "escalate");
check("'pop out clip 1' (pop is entrance-only) → escalates", route("pop out clip 1").kind === "escalate");
{
  const result = route("fade in clip 1");
  const isMotion = result.kind === "plan" && result.plan.steps.some((step) => step.actionId === "applyMotion");
  check("'fade in clip 1' still routes to the transition family, NOT applyMotion", !isMotion);
}

console.log("\nREMOVE-LOOK reflex (real transcript 2026-07-18 — the fast lane invented applyTextLook('new look') and removeEffect('neonLook')):");
{
  // Same layout as the base fixture, but clip 3 carries a creative look to remove.
  const graded = comp([
    {
      type: "video",
      layers: [
        layer({ id: "vid_a", type: "video", startSeconds: 0, durationSeconds: 5 }),
        layer({
          id: "vid_b",
          type: "video",
          startSeconds: 5,
          durationSeconds: 5,
          effects: [{ id: "fx_look", type: "creativeLook", params: { look: "Noir", intensity: 55 } }]
        } as unknown as TimelineLayer)
      ]
    },
    {
      type: "text",
      layers: [
        // Text layer carrying a creativeLook EFFECT (applyLook allows this) — bare removal
        // must remove the effect, not lecture about baked text looks (probe-caught 2026-07-18).
        layer({
          id: "text_1",
          type: "text",
          startSeconds: 2,
          durationSeconds: 4,
          effects: [{ id: "fx_text_look", type: "creativeLook", params: { look: "Noir", intensity: 55 } }]
        } as unknown as TimelineLayer)
      ]
    }
  ]);
  const gradedRoute = (prompt: string) => routePrompt(prompt, { composition: graded, selection: [], nowSeconds: 3 });
  {
    const step = firstAction(gradedRoute("remove the look from clip 2"));
    const params = step.params as { effectId?: string };
    check(
      "bare 'remove the look' on a TEXT clip WITH a creativeLook effect → removes the effect",
      step.actionId === "removeEffect" && params.effectId === "fx_text_look"
    );
  }
  {
    const step = firstAction(gradedRoute("remove the noir look from clip 3"));
    const params = step.params as { layerId?: string; effectId?: string };
    check("'remove the noir look from clip 3' → removeEffect(fx_look) plan", step.actionId === "removeEffect" && params.layerId === "vid_b" && params.effectId === "fx_look");
  }
  {
    const step = firstAction(gradedRoute("remove the moody look from clip 3"));
    check("'remove the moody look' → alias resolves to the stored Noir, same plan", step.actionId === "removeEffect");
  }
  {
    const step = firstAction(gradedRoute("remove the look from clip 3"));
    check("bare 'remove the look from clip 3' → removes whatever is applied", step.actionId === "removeEffect");
  }
  {
    const step = firstAction(gradedRoute("remove the color grade from clip 3"));
    check("'remove the color grade' phrasing works too", step.actionId === "removeEffect");
  }
  {
    const result = gradedRoute("remove the teal & orange look from clip 3");
    check(
      "asked look ≠ stored look → honest answer naming what's ACTUALLY applied, no plan",
      result.kind === "answer" && /Noir/.test(answerText(result))
    );
  }
  {
    const result = gradedRoute("remove the noir look from clip 1");
    check("'remove the noir look' on an ungraded clip → honest 'nothing to remove'", result.kind === "answer" && /no creative look/i.test(answerText(result)));
  }
  {
    const result = gradedRoute("remove the neon look from clip 2");
    check(
      "'remove the neon look' on a TEXT clip → honest bake answer offering undo/restyle",
      result.kind === "answer" && /bake/i.test(answerText(result)) && /undo/i.test(answerText(result))
    );
  }
  {
    const result = gradedRoute("remove the vaporwave look from clip 3");
    check("unknown look name → instant gap answer listing both libraries", result.kind === "answer" && /Color looks/.test(answerText(result)));
  }
  check("MUST NOT: 'remove clip 3' still deletes the clip (delete handler untouched)", firstAction(gradedRoute("remove clip 3")).actionId === "deleteLayer");
  check("MUST NOT: 'remove the noir look from the intro' (vague target) → escalates", gradedRoute("remove the noir look from the intro").kind === "escalate");
}

{
  const step = firstAction(route("split clip 1 at playhead"));
  const params = step.params as { layerId?: string; atSeconds?: number };
  check("'split clip 1 at playhead' → splitClip(vid_a, 3s) plan", step.actionId === "splitClip" && params.layerId === "vid_a" && params.atSeconds === 3);
}
{
  const result = route("split clip 3 at playhead");
  check("'split clip 3 at playhead' (playhead outside) → honest bounds answer", result.kind === "answer" && /isn't inside/.test(answerText(result)));
}
{
  const step = firstAction(route("split at playhead", { selection: ["vid_a"] }));
  check("'split at playhead' with single selection → splitClip on it", step.actionId === "splitClip" && (step.params as { layerId?: string }).layerId === "vid_a");
}
{
  const step = firstAction(route("add a marker"));
  check("'add a marker' → addMarker at playhead", step.actionId === "addMarker" && (step.params as { timeSeconds?: number }).timeSeconds === 3);
}

console.log("\nEDITOR COMMAND PLANE (tier 0 — voice latency class):");

function commandOf(result: BrainRouteResult): { commandId?: string; params?: unknown } {
  return result.kind === "command" ? { commandId: result.commandId, params: result.params } : {};
}

{
  const cmd = commandOf(route("switch to the blade tool"));
  check("'switch to the blade tool' → setTool(blade)", cmd.commandId === "setTool" && (cmd.params as { tool?: string }).tool === "blade");
}
{
  const cmd = commandOf(route("razor tool"));
  check("'razor tool' → setTool(blade)", cmd.commandId === "setTool" && (cmd.params as { tool?: string }).tool === "blade");
}
{
  const cmd = commandOf(route("select tool"));
  check("'select tool' → setTool(select)", cmd.commandId === "setTool" && (cmd.params as { tool?: string }).tool === "select");
}
check("'pan' bare → hand tool", commandOf(route("pan")).commandId === "setTool");
{
  const cmd = commandOf(route("pause the video"));
  check("'pause the video' → transport(pause)", cmd.commandId === "transport" && (cmd.params as { op?: string }).op === "pause");
}
{
  const cmd = commandOf(route("rewind"));
  check("'rewind' → transport(shuttleBack)", cmd.commandId === "transport" && (cmd.params as { op?: string }).op === "shuttleBack");
}
{
  const cmd = commandOf(route("go to 12 seconds"));
  check("'go to 12 seconds' → seek(12)", cmd.commandId === "seek" && (cmd.params as { toSeconds?: number }).toSeconds === 12);
}
{
  const cmd = commandOf(route("go to 0:45"));
  check("'go to 0:45' → seek(45)", cmd.commandId === "seek" && (cmd.params as { toSeconds?: number }).toSeconds === 45);
}
check("'go to the start' → seek(start)", (commandOf(route("go to the start")).params as { target?: string })?.target === "start");
check("'next marker' → seek(nextMarker)", (commandOf(route("next marker")).params as { target?: string })?.target === "nextMarker");
{
  const cmd = commandOf(route("skip forward 5 seconds"));
  check("'skip forward 5 seconds' → seek(+5)", cmd.commandId === "seek" && (cmd.params as { deltaSeconds?: number }).deltaSeconds === 5);
}
{
  const cmd = commandOf(route("select clip 2"));
  check("'select clip 2' → selectClip(text_1)", cmd.commandId === "selectClip" && (cmd.params as { layerId?: string }).layerId === "text_1");
}
{
  const result = route("select clip 9");
  check("'select clip 9' (doesn't exist) → honest answer", result.kind === "answer" && /no clip 9/i.test(answerText(result)));
}
check("'deselect' → selectClip(clear)", (commandOf(route("deselect")).params as { clear?: boolean })?.clear === true);
{
  const cmd = commandOf(route("half resolution"));
  check("'half resolution' → setPreviewQuality(half)", cmd.commandId === "setPreviewQuality" && (cmd.params as { quality?: string }).quality === "half");
}
{
  const cmd = commandOf(route("set quality to auto"));
  check("'set quality to auto' → setPreviewQuality(auto)", cmd.commandId === "setPreviewQuality" && (cmd.params as { quality?: string }).quality === "auto");
}
check("'toggle snapping' → setSnapping", commandOf(route("toggle snapping")).commandId === "setSnapping");
{
  const cmd = commandOf(route("redo"));
  check("'redo' → editorUndoRedo(redo)", cmd.commandId === "editorUndoRedo" && (cmd.params as { op?: string }).op === "redo");
}
check("'export the video' → openExport", commandOf(route("export the video")).commandId === "openExport");
{
  const cmd = commandOf(route("open effects tab"));
  const params = cmd.params as { panel?: string; op?: string };
  check("'open effects tab' → openPanel(effects, open)", cmd.commandId === "openPanel" && params.panel === "effects" && params.op === "open");
}
{
  const cmd = commandOf(route("open inspector"));
  const params = cmd.params as { panel?: string; op?: string };
  check("'open inspector' → openPanel(inspector, open)", cmd.commandId === "openPanel" && params.panel === "inspector" && params.op === "open");
}
{
  const cmd = commandOf(route("hide the inspector"));
  const params = cmd.params as { panel?: string; op?: string };
  check("'hide the inspector' → openPanel(inspector, close)", cmd.commandId === "openPanel" && params.op === "close");
}
{
  const cmd = commandOf(route("open the media pool"));
  const params = cmd.params as { panel?: string };
  check("'open the media pool' → openPanel(assets)", cmd.commandId === "openPanel" && params.panel === "assets");
}
{
  const cmd = commandOf(route("go to the color tab"));
  const params = cmd.params as { panel?: string };
  check("'go to the color tab' → openPanel(color)", cmd.commandId === "openPanel" && params.panel === "color");
}
{
  const cmd = commandOf(route("open colours tab"));
  const params = cmd.params as { panel?: string };
  check("'open colours tab' (plural/British) → openPanel(color)", cmd.commandId === "openPanel" && params.panel === "color");
}
{
  const cmd = commandOf(route("open project settings"));
  const params = cmd.params as { panel?: string };
  check("'open project settings' → openPanel(settings)", cmd.commandId === "openPanel" && params.panel === "settings");
}
check("'show effects' (no tab/panel suffix — could mean a clip's effects) escalates", route("show effects").kind === "escalate");
check("'open color' (no suffix) escalates", route("open color").kind === "escalate");
{
  const step = firstAction(route("ripple delete clip 3"));
  const params = step.params as { layerId?: string; ripple?: boolean };
  check("'ripple delete clip 3' → deleteLayer(vid_b, ripple)", step.actionId === "deleteLayer" && params.layerId === "vid_b" && params.ripple === true);
}
{
  const step = firstAction(route("delete clip 1 and close the gap"));
  check("'delete clip 1 and close the gap' → ripple deleteLayer", (step.params as { ripple?: boolean }).ripple === true);
}
{
  clearRuleStats();
  const before = route("pan mode");
  recordRuleRejected("t0.cmd.tool");
  recordRuleRejected("t0.cmd.tool");
  const after = route("pan mode");
  clearRuleStats();
  check("command trust gate: 2×👎 on t0.cmd.tool → 'pan mode' escalates", before.kind === "command" && after.kind === "escalate");
}

console.log("\nTRANSACTIONAL corpus — tier 1 command compiler (B2):");

{
  const step = firstAction(route("change text color of clip 2 to white"));
  const params = step.params as { layerId?: string; color?: string };
  check("'change text color of clip 2 to white' → updateText(text_1, #ffffff)", step.actionId === "updateText" && params.layerId === "text_1" && params.color === "#ffffff");
}
{
  const step = firstAction(route("can you change the colour of clip 2 to white?"));
  check("politeness + British spelling → same updateText plan", step.actionId === "updateText" && (step.params as { color?: string }).color === "#ffffff");
}
{
  const step = firstAction(route("make clip 2 red"));
  check("'make clip 2 red' (suffix split) → updateText(text_1, #ef4444)", step.actionId === "updateText" && (step.params as { color?: string }).color === "#ef4444");
}
{
  const step = firstAction(route("move clip 3 5 seconds earlier"));
  const params = step.params as { layerId?: string; deltaSeconds?: number };
  check("'move clip 3 5 seconds earlier' → moveLayer(vid_b, -5s)", step.actionId === "moveLayer" && params.layerId === "vid_b" && params.deltaSeconds === -5);
}
{
  const step = firstAction(route("delay clip 1 by 2 seconds"));
  check("'delay clip 1 by 2 seconds' → moveLayer(vid_a, +2s)", step.actionId === "moveLayer" && (step.params as { deltaSeconds?: number }).deltaSeconds === 2);
}
{
  const step = firstAction(route("fade in clip 1"));
  const params = step.params as { layerId?: string; kind?: string };
  check("'fade in clip 1' → addTransition(fadeIn, vid_a)", step.actionId === "addTransition" && params.kind === "fadeIn" && params.layerId === "vid_a");
}
{
  const result = route("fade in and out clip 1");
  const kinds = result.kind === "plan" ? result.plan.steps.map((step) => (step.params as { kind?: string }).kind) : [];
  check("'fade in and out clip 1' → BOTH fadeIn and fadeOut steps (additive)", kinds.length === 2 && kinds.includes("fadeIn") && kinds.includes("fadeOut"));
}
{
  const step = firstAction(route("add a fade out to clip 2 over 2 seconds"));
  const params = step.params as { kind?: string; durationSeconds?: number };
  check("'add a fade out to clip 2 over 2 seconds' → fadeOut with duration", step.actionId === "addTransition" && params.kind === "fadeOut" && params.durationSeconds === 2);
}
{
  const step = firstAction(route("blur clip 1"));
  check("'blur clip 1' → addEffect(blur, vid_a)", step.actionId === "addEffect" && (step.params as { effectType?: string }).effectType === "blur");
}
{
  const step = firstAction(route("set the blur on clip 1 to 12"));
  const params = step.params as { effectType?: string; params?: { amount?: number } };
  check("'set the blur on clip 1 to 12' → blur with amount 12", step.actionId === "addEffect" && params.params?.amount === 12);
}

console.log("\nTRUST GATE (👎 feedback disarms a rule):");
{
  clearRuleStats();
  const before = route("make clip 2 red");
  recordRuleRejected("t1.text-color");
  recordRuleRejected("t1.text-color");
  const after = route("make clip 2 red");
  clearRuleStats();
  const recovered = route("make clip 2 red");
  check(
    "rule fires → 2×👎 → rule stops fast-pathing → cleared stats → fires again",
    before.kind === "plan" && after.kind === "escalate" && recovered.kind === "plan"
  );
}

console.log("\nAMBIGUITY corpus (must escalate — zero wrong fast paths):");

const mustEscalate: Array<[string, Partial<BrainContext>?]> = [
  ["make it pop"],
  ["do something cool"],
  ["change clip 3 to white"], // clip 3 is VIDEO — "to white" on footage is grade territory (type gate)
  ["make clip 1 white"], // same type gate, suffix-split form
  ["make it white"], // deixis with an AMBIGUOUS playhead target (two clips at 3s) → never guess
  ["move clip 3 earlier"], // no amount — structurally incomplete
  ["fade clip 2"], // no in/out direction
  ["blur it a little bit"], // fuzzy magnitude, unresolvable target phrase
  ["make the text bigger"], // size delta is not tier-1 material yet
  ["add a red circle"],
  ["delete this"], // vague delete → planners + delete guard, never a fast path
  ["delete the clip that looks bad"],
  ["remove the blur"], // effect taxonomy, not a layer delete
  ["remove background"], // tool, not deleteLayer
  ["split clip 2"], // no "at playhead" — where to cut is not structurally certain
  ["delete clip 2 and add a title"], // compound
  ["cut the boring parts"],
  ["undo the color grade but keep the blur"],
  // Several clips under the playhead + no selection → ambiguous target, never a guess.
  ["split at playhead", { nowSeconds: 3, selection: [] }],
  // Command-plane lookalikes that must NOT fire a command:
  ["play something fun"],
  ["select all the good clips"],
  ["cut it"], // bare "cut" is ambiguous (blade tool vs cutting a clip)
  ["make it faster"], // speed ramp vs performance — never guess
  ["go to the good part"]
];

for (const [prompt, context] of mustEscalate) {
  const result = route(prompt, context);
  check(`escalates: "${prompt}"`, result.kind === "escalate", `tier-0 wrongly returned "${result.kind}"`);
}

// ---------------------------------------------------------------------------
// Tier 2 — semantic layer (B3). The embedding backend is MOCKED under node (the real MiniLM
// only loads in the browser): known skeletons get handcrafted vectors so the threshold/margin
// logic is exercised; everything else gets a deterministic pseudo-random unit vector, which
// sits far below the 0.9 threshold. Real-model match quality is validated manually in the app.
// ---------------------------------------------------------------------------

function hashUnitVector(text: string, dim = 32): number[] {
  let seed = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    seed = Math.imul(seed ^ text.charCodeAt(index), 16777619);
  }
  const vector = Array.from({ length: dim }, (_, component) => {
    seed = Math.imul(seed ^ (component + 1), 2654435761) | 0;
    return ((seed >>> 8) / 0xffffff) * 2 - 1;
  });
  const norm = Math.hypot(...vector);
  return vector.map((value) => value / norm);
}

/** Handcrafted paraphrase geometry: "blurify" ≈ the blur exemplars; "wipe" is torn between
 * blur and delete (must fail the margin). */
const MOCK_VECTORS: Record<string, number[]> = (() => {
  const blurish = hashUnitVector("cluster:blur");
  const torn = hashUnitVector("cluster:torn");
  return {
    // Clean paraphrase: only blur exemplars share this cluster → clears threshold + margin.
    "blurify <target>": blurish,
    "make <target> blurry": blurish,
    // Confusable verb: equally close to a blur exemplar AND a delete exemplar → margin fails.
    "wipe <target>": torn,
    "smooth out <target>": torn,
    "trash <target>": torn
  };
})();

async function main(): Promise<void> {
  __setSemanticEmbedderForTests(async (texts) => texts.map((text) => MOCK_VECTORS[text] ?? hashUnitVector(text)));
  clearSemanticStores();
  clearRuleStats();

  const semantic = (prompt: string, context: Partial<BrainContext> = {}) => routePromptSemantic(prompt, { ...base, ...context });

  console.log("\nTIER 2 — semantic layer (B3):");

  check(
    "slot extraction: 'move clip 3 5 seconds earlier' → skeleton + [target, time]",
    (() => {
      const { skeleton, slots } = extractSkeleton("move clip 3 5 seconds earlier");
      return skeleton === "move <target> <time> earlier" && slots.length === 2 && slots[0]!.text === "clip 3" && slots[1]!.text === "5 seconds";
    })()
  );

  {
    const step = firstAction(await semantic("soften clip 1"));
    check("'soften clip 1' (exact exemplar) → addEffect(blur, vid_a)", step.actionId === "addEffect" && (step.params as { layerId?: string }).layerId === "vid_a");
  }
  {
    const step = firstAction(await semantic("get rid of clip 3"));
    check("'get rid of clip 3' → deleteLayer(vid_b)", step.actionId === "deleteLayer" && (step.params as { layerId?: string }).layerId === "vid_b");
  }
  {
    const step = firstAction(await semantic("nudge clip 3 2 seconds later"));
    check("'nudge clip 3 2 seconds later' → moveLayer(+2s)", step.actionId === "moveLayer" && (step.params as { deltaSeconds?: number }).deltaSeconds === 2);
  }
  {
    const step = firstAction(await semantic("paint clip 2 white"));
    check("'paint clip 2 white' → updateText(text_1, #ffffff)", step.actionId === "updateText" && (step.params as { color?: string }).color === "#ffffff");
  }
  check("'paint clip 1 white' (video) → escalates through the SAME type gate", (await semantic("paint clip 1 white")).kind === "escalate");
  {
    const step = firstAction(await semantic("chop clip 1 at the playhead"));
    check("'chop clip 1 at the playhead' → splitClip(vid_a, 3s)", step.actionId === "splitClip" && (step.params as { atSeconds?: number }).atSeconds === 3);
  }
  {
    const step = firstAction(await semantic("mark this spot"));
    check("'mark this spot' → addMarker at playhead", step.actionId === "addMarker" && (step.params as { timeSeconds?: number }).timeSeconds === 3);
  }
  {
    const step = firstAction(await semantic("soften it", { selection: ["vid_a"] }));
    check("'soften it' + selection → deixis resolves through tier-1 gates", step.actionId === "addEffect" && (step.params as { layerId?: string }).layerId === "vid_a");
  }
  check("'tell me everything you can do' → capabilities answer", (await semantic("tell me everything you can do")).kind === "answer");
  {
    const result = await semantic("freeze playback");
    check("'freeze playback' (t2 exemplar) → pause COMMAND via rewrite", result.kind === "command" && result.commandId === "transport");
  }
  {
    const result = await semantic("lowest quality");
    check("'lowest quality' (t2 exemplar) → quarter-res COMMAND", result.kind === "command" && (result.params as { quality?: string }).quality === "quarter");
  }
  {
    const result = await semantic("open the media browser");
    check("'open the media browser' (t2 exemplar) → openPanel(assets) COMMAND", result.kind === "command" && result.commandId === "openPanel" && (result.params as { panel?: string }).panel === "assets");
  }
  {
    const result = await semantic("show clip properties");
    check("'show clip properties' (t2 exemplar) → openPanel(inspector) COMMAND", result.kind === "command" && result.commandId === "openPanel" && (result.params as { panel?: string }).panel === "inspector");
  }

  {
    const step = firstAction(await semantic("blurify clip 1"));
    check("embedding path: unseen 'blurify clip 1' ≈ blur exemplars → addEffect(blur)", step.actionId === "addEffect");
  }
  check("embedding margin: 'wipe clip 1' (blur ≈ delete tie) → escalates", (await semantic("wipe clip 1")).kind === "escalate");
  check("embedding threshold: 'make clip 1 sparkle' → escalates", (await semantic("make clip 1 sparkle")).kind === "escalate");

  {
    learnPhrase("defocus <target>", "t2.blur");
    const step = firstAction(await semantic("defocus clip 1"));
    check("learned phrase: 'defocus <target>' taught → 'defocus clip 1' compiles blur", step.actionId === "addEffect");
    clearSemanticStores();
  }

  console.log("\nB7 — concept → recipe (named looks compile to the color-grade skill):");
  {
    const result = await semantic("make it cinematic");
    const step = result.kind === "plan" ? result.plan.steps[0] : undefined;
    check(
      "'make it cinematic' → ONE color-grade skill step with look=Cinematic, free",
      result.kind === "plan" &&
        result.plan.steps.length === 1 &&
        step?.kind === "skill" &&
        step.skillId === "color-grade" &&
        (step.params as { look?: string }).look === "Cinematic" &&
        result.plan.totalCredits === 0
    );
  }
  check("'make it noir' → Noir recipe", (await semantic("make it noir")).kind === "plan");
  check("'make it dreamy' (no registered recipe) → escalates", (await semantic("make it dreamy")).kind === "escalate");
  check("'make it kind of cinematic' (not an exact phrase) → escalates", (await semantic("make it kind of cinematic")).kind === "escalate");

  console.log("\nB6 — learned-phrase WRITE path (LLM resolutions teach tier 2):");
  {
    const { maybeLearnPhrase } = await import("./semantic");
    // The LLM resolved "soften up clip 3" as one blur step → the skeleton generalizes.
    maybeLearnPhrase("soften up clip 3", [{ actionId: "addEffect", params: { layerId: "vid_b", effectType: "blur" }, summary: "Blur" }]);
    const step = firstAction(await semantic("soften up clip 1"));
    check("learned from LLM run: 'soften up <target>' → DIFFERENT clip compiles locally", step.actionId === "addEffect" && (step.params as { layerId?: string }).layerId === "vid_a");
    clearSemanticStores();

    // Target didn't extract as a slot → NOT generalizable → never learned.
    maybeLearnPhrase("make the intro softer", [{ actionId: "addEffect", params: { layerId: "vid_a", effectType: "blur" }, summary: "Blur" }]);
    check("non-slotted phrasing ('the intro') is NOT learned", (await semantic("make the outro softer")).kind === "escalate");
    clearSemanticStores();

    // Multi-step runs are never learned as a phrase.
    maybeLearnPhrase("tidy clip 1", [
      { actionId: "addEffect", params: { layerId: "vid_a", effectType: "blur" }, summary: "Blur" },
      { actionId: "deleteLayer", params: { layerId: "vid_b" }, summary: "Delete" }
    ]);
    check("multi-step runs are not learned", (await semantic("tidy clip 2")).kind === "escalate");
    clearSemanticStores();
  }

  {
    clearRuleStats();
    const before = await semantic("soften clip 1");
    recordRuleRejected("t2.blur");
    recordRuleRejected("t2.blur");
    const after = await semantic("soften clip 1");
    clearRuleStats();
    check("t2 trust gate: 2×👎 on t2.blur → 'soften clip 1' escalates", before.kind === "plan" && after.kind === "escalate");
  }

  {
    storeCachedPlan("make it dreamy", base, [
      { actionId: "addEffect", params: { layerId: "vid_a", effectType: "blur" }, summary: "Blur clip 1" }
    ]);
    const replay = await semantic("make it dreamy");
    const step = firstAction(replay);
    check("plan cache: same prompt + identical timeline → free replay", replay.kind === "plan" && step.actionId === "addEffect");
    const moved = await semantic("make it dreamy", { nowSeconds: 4 });
    check("plan cache: deictic prompt ('it') + playhead drift → escalates (exact context pinned)", moved.kind === "escalate");
    clearSemanticStores();
  }

  {
    // v2 retargetable cache: explicitly-targeted prompts survive UNRELATED drift, but never
    // a change to a clip the plan touches — and 👎/undo forgets them entirely.
    storeCachedPlan("blurify the whole intro section", base, [
      { actionId: "addEffect", params: { layerId: "vid_a", effectType: "blur" }, summary: "Blur clip 1" }
    ]);
    const drifted = await semantic("blurify the whole intro section", { nowSeconds: 9.5, selection: ["text_1"] });
    check("plan cache v2: explicit prompt + untouched target → replays despite playhead/selection drift", drifted.kind === "plan");
    const changedComposition = {
      ...composition,
      tracks: composition.tracks.map((track) => ({
        ...track,
        layers: track.layers.map((entry) => (entry.id === "vid_a" ? { ...entry, startSeconds: 1 } : entry))
      }))
    };
    const mutated = await semantic("blurify the whole intro section", { composition: changedComposition });
    check("plan cache v2: referenced clip changed → escalates (never wrong-target)", mutated.kind === "escalate");
    forgetLearnedPlan("blurify the whole intro section");
    const forgotten = await semantic("blurify the whole intro section");
    check("plan cache v2: 👎-forgotten plan → escalates (LLM again, never repeated)", forgotten.kind === "escalate");
    clearSemanticStores();
  }

  console.log("\nWAKE WORD (voice — fuzzy matcher + user training, ai/wake-word.ts):");
  clearWakePhrases();
  check("'Hey Orreris!' wakes", matchWakeWord("Hey Orreris!").matched);
  check("'hello orris' (short mishearing) wakes", matchWakeWord("hello orris").matched);
  check("'hello orres' (observed mishearing) wakes", matchWakeWord("hello orres").matched);
  check("'hey oris' wakes", matchWakeWord("hey oris").matched);
  check("'hay orreris' wakes", matchWakeWord("hay orreris").matched);
  check("'hey orreros' (unseen, edit-distance 1) wakes", matchWakeWord("hey orreros").matched);
  check("'heya orreris' wakes (user-requested greeting)", matchWakeWord("heya Orreris").matched);
  {
    const nameFirst = matchWakeWord("Orreris, pause the video");
    check("'Orreris, pause the video' (name-first, no greeting) wakes with command", nameFirst.matched && nameFirst.command === "pause the video");
  }
  check("'orris pause' (weak mishearing WITHOUT greeting) does NOT wake", !matchWakeWord("orris pause").matched);
  check("'hey or reris' (split name) wakes", matchWakeWord("hey or reris").matched);
  {
    const carry = matchWakeWord("hey orreris blur clip 2");
    check("carry-through: 'hey orreris blur clip 2' → command 'blur clip 2'", carry.matched && carry.command === "blur clip 2");
  }
  check("'hello there how are you' does NOT wake", !matchWakeWord("hello there how are you").matched);
  check("'hey can you help me' does NOT wake", !matchWakeWord("hey can you help me").matched);
  check("'orris come here' (no greeting) does NOT wake", !matchWakeWord("orris come here").matched);
  check("'gorris pause' (no greeting) does NOT wake", !matchWakeWord("gorris pause").matched);
  check("'hello gorris' unmatched but flagged as a wake ATTEMPT (training card)", looksLikeWakeAttempt("hello gorris"));
  check("'blur clip 2 please' is NOT a wake attempt", !looksLikeWakeAttempt("blur clip 2 please"));
  {
    learnWakePhrase("hello gorris");
    const learned = matchWakeWord("hello gorris", loadWakePhrases());
    const learnedCarry = matchWakeWord("hello gorris pause", loadWakePhrases());
    clearWakePhrases();
    check("learned phrase: 'hello gorris' wakes after training", learned.matched);
    check("learned phrase carries a command too ('… pause')", learnedCarry.matched && learnedCarry.command === "pause");
    check("cleared training → 'hello gorris' no longer wakes", !matchWakeWord("hello gorris", loadWakePhrases()).matched);
  }

  console.log("\nTTS read-back — speakable/splitSpeakable (pure; voice round 4):");
  {
    const spoken = speakable("Here are the steps:\n- **Cut** the clip\n- Add a *fade*\n3. Export it");
    check("bullet list keeps ALL points (no truncation)", /Cut the clip/.test(spoken) && /Add a fade/.test(spoken) && /Export it/.test(spoken), spoken);
    check("bullet/number markers + markdown stripped", !/[-*#`]/.test(spoken) && !/3\./.test(spoken), spoken);
    check("newline → sentence boundary (points get terminal punctuation)", /clip\./.test(spoken) && /fade\./.test(spoken), spoken);
  }
  {
    const long = speakable(Array.from({ length: 6 }, (_, i) => `Point number ${i + 1} says something genuinely useful about the edit here.`).join("\n"));
    check("no 240-char cap — every sentence of a long reply survives", /Point number 6/.test(long));
    const chunks = splitSpeakable(long);
    check("splitSpeakable chunks a long reply (each ≤ 280 chars)", chunks.length >= 2 && chunks.every((chunk) => chunk.length <= 280));
    check("splitSpeakable loses nothing", chunks.join(" ").replace(/\s+/g, " ") === long.replace(/\s+/g, " "));
  }
  check("emoji/link markdown stripped", speakable("✅ [Done](https://x.y) — nice!") === "Done — nice!", speakable("✅ [Done](https://x.y) — nice!"));
  check("splitSpeakable hard-splits a punctuation-less run-on", splitSpeakable("word ".repeat(120).trim()).every((chunk) => chunk.length <= 280));

  console.log("\nTRANSCRIPT NORMALIZER — editor-lexicon vocabulary biasing (voice round 5; precision-first):");
  check(
    "REAL corpus: 'just make lip one in lower be to layer' → 'clip 1 … V2 layer'",
    normalizeTranscript("just make lip one in lower be to layer") === "just make clip 1 in lower V2 layer",
    normalizeTranscript("just make lip one in lower be to layer")
  );
  check("'clip won' → 'clip 1'", normalizeTranscript("blur clip won a bit") === "blur clip 1 a bit");
  check("'klip 2' → 'clip 2'", normalizeTranscript("delete klip 2") === "delete clip 2");
  check("'layer we too' → 'layer V2'", normalizeTranscript("move it to layer we too") === "move it to layer V2");
  check("'play head' / 'key frame' / 'time line' join", normalizeTranscript("move the play head past the key frame on the time line") === "move the playhead past the keyframe on the timeline");
  check("fuzzy: 'opacityy' → 'opacity'", normalizeTranscript("lower the opacityy") === "lower the opacity");
  check("MUST NOT: 'lip sync the audio' untouched", normalizeTranscript("lip sync the audio") === "lip sync the audio");
  check("MUST NOT: 'trim the clip to 4 seconds' untouched", normalizeTranscript("trim the clip to 4 seconds") === "trim the clip to 4 seconds");
  check("MUST NOT: 'be to the point' untouched (no track context)", normalizeTranscript("be to the point") === "be to the point");
  check("MUST NOT: 'we two should review this' untouched", normalizeTranscript("we two should review this") === "we two should review this");
  check("MUST NOT: 'payback'/'napping' never become editor terms", normalizeTranscript("payback while napping") === "payback while napping");

  console.log("\nFINAL-vs-INTERIM ARBITRATION — registry-anchored (real report 2026-07-18: interim 'neon' → final 'new'):");
  check(
    "REAL corpus: final 'new' loses to readable interim 'neon' in the look frame",
    arbitrateFinal("apply the neon look on clip 1", "apply the new look on clip 1") === "apply the neon look on clip 1",
    arbitrateFinal("apply the neon look on clip 1", "apply the new look on clip 1")
  );
  check(
    "multi-word look survives: 'lower third' beats final 'lower bird'",
    arbitrateFinal("apply the lower third look", "apply the lower bird look") === "apply the lower third look"
  );
  check(
    "mood frame: 'make it moody' beats final 'make it moving'",
    arbitrateFinal("make it moody", "make it moving") === "make it moody"
  );
  check(
    "MUST NOT: a RESOLVABLE final always wins (engine's second thoughts trusted)",
    arbitrateFinal("apply the noir look", "apply the cinematic look") === "apply the cinematic look"
  );
  check(
    "MUST NOT: unresolvable interim never overrides ('vaporwave' stays out)",
    arbitrateFinal("apply the vaporwave look", "apply the new look") === "apply the new look"
  );
  check(
    "MUST NOT: outside a known frame the final is untouched",
    arbitrateFinal("blur clip one", "blur clip two") === "blur clip two"
  );
  check("empty interim → final unchanged", arbitrateFinal("", "apply the new look") === "apply the new look");
  check(
    "remove frame: 'remove neon look' beats final 'remove new look' (real transcript)",
    arbitrateFinal("remove neon look from text clip 3", "remove new look from text clip 3") === "remove neon look from text clip 3",
    arbitrateFinal("remove neon look from text clip 3", "remove new look from text clip 3")
  );
  check(
    "frame slot replacement is surgical (surrounding text intact)",
    arbitrateFinal("please apply the neon look to clip 2 now", "please apply the new look to clip 2 now") ===
      "please apply the neon look to clip 2 now"
  );

  console.log("\nLOOK-FRAME FUZZY BIAS — distance-1 only, frame-gated:");
  check("'neyon' → 'Neon' inside the look frame", normalizeTranscript("apply the neyon look") === "apply the Neon look", normalizeTranscript("apply the neyon look"));
  check("'noire' → 'Noir' inside the look frame", normalizeTranscript("apply the noire look") === "apply the Noir look");
  check(
    "MUST NOT: 'new' (distance 2) is never guessed at without interim evidence",
    normalizeTranscript("apply the new look") === "apply the new look"
  );
  check("MUST NOT: resolvable names pass through byte-identical", normalizeTranscript("apply the moody look") === "apply the moody look");
  check("MUST NOT: no look frame → no fuzzy ('neyon lights' untouched)", normalizeTranscript("add neyon lights") === "add neyon lights");

  console.log("\nSELF-ECHO GUARD — discard transcripts of our own TTS (voice round 9):");
  {
    const now = 100_000;
    const spoke = (text: string, agoMs: number) => [{ text, at: now - agoMs }];
    check(
      "REAL corpus: 'Move to clip 1 onto V3.' ≈ spoken 'Moved clip 1 onto V3.' → echo",
      looksLikeSelfEcho("Move to clip 1 onto V3.", spoke("Moved clip 1 onto V3.", 1_500), now)
    );
    check(
      "REAL corpus: 'Move to clip 1 to V3.' ≈ spoken 'Moved clip 1 to V3.' → echo",
      looksLikeSelfEcho("Move to clip 1 to V3.", spoke("Moved clip 1 to V3.", 800), now)
    );
    check(
      "MUST NOT: different command 'move clip 2 to V1' after 'Moved clip 1 onto V3.' passes",
      !looksLikeSelfEcho("move clip 2 to V1", spoke("Moved clip 1 onto V3.", 1_000), now)
    );
    check(
      "MUST NOT: short answers ('yes') are never filtered",
      !looksLikeSelfEcho("yes", spoke("Say yes to apply, or no to cancel.", 500), now)
    );
    check(
      "MUST NOT: same words OUTSIDE the 6s window pass (user repeating a command later)",
      !looksLikeSelfEcho("move clip 1 onto V3", spoke("Moved clip 1 onto V3.", 10_000), now)
    );
    check(
      "MUST NOT: unrelated question after an answer passes",
      !looksLikeSelfEcho("can you add captions to this video", spoke("Done — clip 1 is on V3 now.", 1_000), now)
    );
  }

  console.log("\nB5 — effect-keyframe pre-check (instant registry-derived answers):");
  {
    const result = route("keyframe the blur amount");
    check(
      "'keyframe the blur amount' → instant affirmative how-to (effect keys ship in all 3 renderers)",
      result.kind === "answer" && /diamond|can be keyframed/i.test(answerText(result)) && !/can't be keyframed/.test(answerText(result))
    );
  }
  {
    const result = route("keyframe the eq");
    check(
      "'keyframe the eq' → honest static-per-clip answer (audio dynamics stay non-keyframeable)",
      result.kind === "answer" && /static per clip/i.test(answerText(result))
    );
  }
  check("'animate the opacity' (keyframeable property) → escalates to the model", route("animate the opacity").kind === "escalate");
  check("'animate the text' (not an effect) → escalates", route("animate the text").kind === "escalate");

  console.log("\nTIER 3 — fast-lane gate (B4; economic gate only, output is Zod-gated live):");
  const { looksTransactional } = await import("./fast");
  check("gate accepts: 'rotate clip 2 by 90 degrees'", looksTransactional("rotate clip 2 by 90 degrees"));
  check("gate accepts: 'put a title saying hello at the top'", looksTransactional("put a title saying hello at the top"));
  check("gate rejects creative: 'make it cinematic'", !looksTransactional("make it cinematic"));
  check("gate rejects tools: 'add captions to the video'", !looksTransactional("add captions to the video"));
  check("gate rejects compound: 'delete clip 2 and add a title'", !looksTransactional("delete clip 2 and add a title"));
  check("gate rejects questions: 'what is the best transition here'", !looksTransactional("what is the best transition here"));

  console.log("\nAMBIGUITY corpus through tier 2 (must STILL escalate):");
  for (const [prompt, context] of mustEscalate) {
    const result = await semantic(prompt, context);
    check(`t2 escalates: "${prompt}"`, result.kind === "escalate", `tier-2 wrongly returned "${result.kind}"`);
  }

  if (failures > 0) {
    console.error(`\nbrain:eval — ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nbrain:eval — all checks passed.");
}

void main();
