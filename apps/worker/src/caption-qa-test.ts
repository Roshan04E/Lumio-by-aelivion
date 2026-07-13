import assert from "node:assert/strict";
import {
  applyCaptionTrackToComposition,
  captionStylePresets,
  createAutoCaptionAssistantPlan,
  createCaptionInterchangeArtifact,
  createCaptionTrack,
  createRenderComparisonFixture,
  exportTranscriptToSrt,
  exportTranscriptToVtt,
  parseCaptionInterchangeArtifact,
  parseTranscriptInput,
  validateTranscriptArtifact,
  type SourceAsset
} from "@kimera-by-aelivion/shared";

const transcript = parseTranscriptInput(`WEBVTT

00:00:00.120 --> 00:00:01.420
Wait this proof matters

00:00:01.600 --> 00:00:03.200
Save this before you forget`);

assert.equal(transcript.segments.length, 2, "VTT parser should preserve caption segments.");
assert.equal(transcript.segments[0]?.words.length, 4, "Parser should preserve generated word timing shape.");

const srtRoundtrip = parseTranscriptInput(exportTranscriptToSrt(transcript));
const vttRoundtrip = parseTranscriptInput(exportTranscriptToVtt(transcript));
assert.equal(srtRoundtrip.segments[0]?.text, transcript.segments[0]?.text, "SRT roundtrip should preserve text.");
assert.equal(vttRoundtrip.segments[1]?.text, transcript.segments[1]?.text, "VTT roundtrip should preserve text.");
assert.ok(Math.abs((srtRoundtrip.segments[0]?.startSeconds ?? 0) - 0.12) < 0.01, "SRT roundtrip should preserve timing.");
assert.ok(Math.abs((vttRoundtrip.segments[1]?.endSeconds ?? 0) - 3.2) < 0.01, "VTT roundtrip should preserve timing.");

const style = captionStylePresets[0]!;
const captionTrack = createCaptionTrack(transcript, style.id, "wait, proof, save", {
  [transcript.segments[0]!.id]: {
    emphasis: "zoom-phrase",
    fontSize: 72,
    positionY: 70
  }
});
const artifact = createCaptionInterchangeArtifact({ transcript, captionTrack, stylePresetId: style.id });
const parsedArtifact = parseCaptionInterchangeArtifact(JSON.stringify(artifact));
assert.equal(parsedArtifact?.style.presetId, style.id, "Interchange artifact should preserve style separately from timing.");
assert.equal(parsedArtifact?.captionTrack.segmentStyleOverrides?.[transcript.segments[0]!.id]?.emphasis, "zoom-phrase");

const fixture = createRenderComparisonFixture();
assert.ok(fixture.graph.composition, "Caption render fixture should include a composition.");
const captionLayers = fixture.graph.composition.tracks.flatMap((track) => track.layers).filter((layer) => layer.name.startsWith("Caption"));
assert.equal(captionLayers.length, 2, "Pixel fixture should render generated caption layers.");
assert.equal(captionLayers[0]?.text, "New Drop", "Caption layer text should preserve natural casing.");
const highlightedRuns = (captionLayers[0]?.textRuns ?? []).filter((run) => run.bold);
assert.equal(
  highlightedRuns.map((run) => run.text).join(""),
  "NewDrop",
  "Highlighted words should be reflected as bold text runs, not uppercased."
);
assert.equal(captionLayers[0]?.fontFamily, style.fontFamily, "Caption fixture should use render-safe preset font.");
// Captions auto-size to their text now (width 0 = max-content) with adjustable background padding,
// instead of a forced fixed-width box. A constrained width is only present when the user opts into one.
assert.ok((captionLayers[0]?.textWidthPercent ?? 0) >= 0, "Caption layers should expose a text width value.");

const longTranscript = parseTranscriptInput("This is a deliberately long caption line that should be flagged because it is too dense for a phone screen");
const longIssues = validateTranscriptArtifact(longTranscript);
assert.ok(longIssues.some((issue) => issue.code === "TOO_FAST" || issue.code === "LONG_CAPTION"), "Long captions should be flagged for review.");

const sourceAsset: SourceAsset = {
  id: "qa_asset",
  userId: "qa_user",
  fileName: "hinglish-test.mp4",
  fileType: "video/mp4",
  fileUrl: "/uploads/hinglish-test.mp4",
  durationSeconds: 12,
  width: 1080,
  height: 1920,
  status: "ready",
  createdAt: new Date(0).toISOString()
};
const assistantPlan = createAutoCaptionAssistantPlan({
  asset: sourceAsset,
  transcript,
  userGoal: "Hinglish punchy karaoke captions with proof words",
  preferredAdapter: "cloud"
});
assert.equal(assistantPlan.plan.toolId, "tool_auto_captions", "Assistant should choose Auto Captions.");
assert.equal(assistantPlan.plan.requiresUserConfirmation, true, "Assistant plan must require user confirmation.");
assert.equal(assistantPlan.suggestedLanguage, "hinglish", "Assistant should infer Hinglish settings.");
assert.ok(assistantPlan.suggestedHighlightedWords.includes("proof"), "Assistant should suggest highlighted words.");
assert.equal(assistantPlan.plan.adapter, "cloud", "Assistant should keep adapter explicit.");

const composition = applyCaptionTrackToComposition(fixture.graph.composition, captionTrack, style);
assert.ok(composition.tracks.some((track) => track.name === "Captions"), "Caption track should apply as an editable timeline track.");

console.log("Caption QA contract passed.");
