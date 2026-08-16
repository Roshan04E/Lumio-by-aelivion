/**
 * GOLDEN gate for CAPTION TRACK → TIMELINE LAYERS (ADR-023 S6's last item).
 *
 *   pnpm --filter @orreris/shared caption:golden            # assert nothing moved
 *   pnpm --filter @orreris/shared caption:golden --capture  # re-record (deliberate changes only)
 *
 * ## WHY THIS EXISTS, AND WHY IT WAS CAPTURED BEFORE THE REFACTOR RATHER THAN AFTER
 *
 * Folding `captionStylePresets` into the `text-style` envelope touches the one thing in this
 * programme that is PERSISTED PROJECT DATA: `CaptionTrackData.stylePresetId` names a preset by id,
 * and `CaptionSegmentStyleOverride` is a second saved bag layered on top of it. Every stage since S1
 * has held the same line — **absent means absent, permanently; a project authored before a stage
 * renders exactly as it did** — and here that line is the entire risk. A caption track saved last
 * month must produce byte-identical layers after the fold, with no migration script.
 *
 * "Byte-identical" is a claim about output, so it is asserted against output RECORDED FROM THE CODE
 * BEFORE THE CHANGE. The golden in `caption-track.golden.json` was captured at `ad02e8a` — the commit
 * before the fold — and the fold is only correct if it reproduces that file without `--capture` being
 * run again. Capturing after the refactor would have recorded whatever the refactor did and called it
 * the baseline, which is the laundering shape this repo has a standing rule about one gate over.
 *
 * ## WHAT IT COVERS, AND WHY EACH CASE IS HERE
 *
 * The full layer objects, serialized — not a summary and not a hash, so a failure names the field.
 * Every one of the six shipped presets, because the preset list is exactly what is being replaced;
 * plus the two shapes that reach into the preset from persisted data and would break differently:
 *
 *  - a per-segment `stylePresetId` override, which is the SECOND id-to-preset lookup in the file and
 *    the one a refactor is most likely to leave pointing at the old list;
 *  - a full override bag, which must keep winning over the preset for every field it names.
 *
 * The transcript and all ids are FIXED — no `Date.now()`, no random — because a golden that moved on
 * its own would be re-captured until it stopped, and then it would be a picture of nothing.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyCaptionTrackToComposition,
  captionStylePresets,
  type CaptionSegmentStyleOverride,
  type CaptionTrackData,
  type TranscriptArtifactData
} from "./captions";
import type { TimelineComposition } from "./types";

const goldenPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "caption-track.golden.json");
const capture = process.argv.includes("--capture");

/** A fixed transcript. Two segments so a per-segment override has something to be per-segment ABOUT. */
const transcript: TranscriptArtifactData = {
  durationSeconds: 3.2,
  source: "manual",
  segments: [
    {
      id: "seg_1",
      text: "Wait this part is important",
      startSeconds: 0.2,
      endSeconds: 1.7,
      words: []
    },
    {
      id: "seg_2",
      text: "Here is the proof",
      startSeconds: 1.8,
      endSeconds: 3.2,
      words: []
    }
  ]
};

const composition: TimelineComposition = {
  id: "comp_golden",
  name: "Caption golden",
  width: 1080,
  height: 1920,
  fps: 30,
  durationSeconds: 4,
  tracks: []
} as unknown as TimelineComposition;

/**
 * A caption track in the shape a project SAVED BEFORE THIS CHANGE carries: a `stylePresetId` string,
 * a highlighted-word list, and an optional flat override bag. Nothing here is constructed through the
 * new code path, on purpose — it is what is already on disk.
 */
function track(
  stylePresetId: string,
  segmentStyleOverrides?: Record<string, CaptionSegmentStyleOverride>
): CaptionTrackData {
  return {
    id: "caption_track_golden",
    transcriptId: "transcript_golden",
    stylePresetId,
    segments: transcript.segments,
    highlightedWords: ["important", "proof"],
    segmentStyleOverrides
  };
}

const cases: Array<{ name: string; track: CaptionTrackData; presetId: string }> = [
  // Every shipped preset. The list being replaced is the thing under test, so none of it is sampled.
  ...captionStylePresets.map((preset) => ({
    name: `preset/${preset.id}`,
    track: track(preset.id),
    presetId: preset.id
  })),
  {
    // The second lookup: a SEGMENT naming a different preset than the track does. A refactor that
    // repoints the track's lookup and forgets this one produces a track that is right on segment 1
    // and wrong on segment 2, which no summary would show.
    name: "override/segment-names-another-preset",
    track: track("minimal", { seg_2: { stylePresetId: "boxed" } }),
    presetId: "minimal"
  },
  {
    // The saved bag, in full. Every field here must still beat the preset, because this is data a
    // user authored by hand and it cannot be re-derived from anything.
    name: "override/full-bag",
    track: track("bold-center", {
      seg_1: {
        color: "#FF3366",
        highlightColor: "#00FFAA",
        strokeColor: "#101010",
        strokeWidth: 3,
        backgroundColor: "#202024",
        backgroundPaddingEm: 0.3,
        fontSize: 61,
        fontFamily: "Cousine, monospace",
        positionX: 40,
        positionY: 64,
        textWidthPercent: 70,
        emphasis: "pop-word",
        highlightBold: false,
        highlightItalic: true,
        highlightFontSizeMultiplier: 1.4,
        highlightFontFamily: "Tinos, serif"
      }
    }),
    presetId: "bold-center"
  }
];

/** Stable serialization: key order preserved, `undefined` distinguished from absent (as S4's does). */
function serialize(value: unknown): string {
  if (value === undefined) return "<undefined>";
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(serialize).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => `${key}:${serialize(entry)}`)
      .join(",")}}`;
  }
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

const emitted: Record<string, string> = {};
for (const entry of cases) {
  const preset = captionStylePresets.find((item) => item.id === entry.presetId);
  if (!preset) {
    console.error(`Case "${entry.name}" names preset "${entry.presetId}", which is not in captionStylePresets.`);
    process.exit(1);
  }
  const applied = applyCaptionTrackToComposition(composition, entry.track, preset);
  const captionTrack = applied.tracks.find((item) => item.id === `${composition.id}_track_captions`);
  emitted[entry.name] = serialize(captionTrack?.layers);
}

if (capture) {
  fs.writeFileSync(goldenPath, `${JSON.stringify(emitted, null, 2)}\n`, "utf8");
  console.log(`Captured ${Object.keys(emitted).length} caption goldens → ${path.basename(goldenPath)}`);
  process.exit(0);
}

if (!fs.existsSync(goldenPath)) {
  console.error(`No golden at ${goldenPath}. Capture it at a commit whose output is trusted — and for this gate that means BEFORE the change under test, never after.`);
  process.exit(1);
}

const golden = JSON.parse(fs.readFileSync(goldenPath, "utf8")) as Record<string, string>;
let failures = 0;

for (const [name, value] of Object.entries(emitted)) {
  const expected = golden[name];
  if (expected === undefined) {
    console.error(`NEW   ${name} — not in the golden. A new case is fine; re-capture only if the EXISTING ones still pass.`);
    failures += 1;
  } else if (expected !== value) {
    failures += 1;
    console.error(`FAIL  ${name}`);
    console.error(`        before: ${expected}`);
    console.error(`        now:    ${value}`);
  } else {
    console.log(`  ok  ${name}`);
  }
}
for (const name of Object.keys(golden)) {
  if (!(name in emitted)) {
    console.error(`GONE  ${name} — a preset or a case disappeared. For a preset that is a project that no longer resolves its own style.`);
    failures += 1;
  }
}

if (failures > 0) {
  console.error(
    `\n${failures} caption golden(s) differ. A caption track saved before this change now renders differently, ` +
      `which is the one thing this stage said it would not do. Do NOT re-capture to make this pass: the golden ` +
      `is the pre-change behaviour, and re-capturing deletes the only evidence that it was preserved.`
  );
  process.exit(1);
}
console.log(`\nAll ${Object.keys(emitted).length} caption goldens byte-identical — a pre-change caption track produces the same layers.`);

/* ------------------------------------------------------------------------------------------------
 * THE OTHER HALF: did the fold BUY anything, or did it move a copy list?
 *
 * The goldens above prove nothing broke. Alone they would pass just as happily on a change that
 * rehoused the same nine fields in a nicer container — which is the failure mode this stage is most
 * likely to have, because "nothing moved" is the easiest thing to achieve by doing nothing.
 *
 * T-15's discipline is the answer: a field that reaches the DATA is the claim, so assert a look the
 * old struct could not express and prove it lands on the layer. Every field below was unreachable
 * from a caption preset before this change — there was no key to put it in.
 * ---------------------------------------------------------------------------------------------- */

import assert from "node:assert/strict";
import { captionPresetLook, type CaptionStylePreset } from "./captions";
import { textStylePreset } from "./text-style-schema";

const richPreset: CaptionStylePreset = {
  id: "golden-rich",
  name: "Rich",
  description: "Every capability the nine-field struct could not express.",
  category: "caption",
  origin: "first-party",
  positionY: 80,
  highlightColor: "#FFD23F",
  envelope: textStylePreset({
    color: "#FFFFFF",
    fontSize: 64,
    // S5 — the glyph gradient. S8 — the concentric ring and the arc. S1 — paint order.
    fillGradientFrom: "#FF8800",
    fillGradientTo: "#0088FF",
    strokeColor: "#101014",
    strokeWidth: 8,
    strokeOuterColor: "#F5D90A",
    strokeOuterWidth: 26,
    strokePaintOrder: "under",
    // S5 — the per-line pill and the stacked shadow.
    backgroundPerLine: true,
    backgroundRadiusEm: 0.4,
    shadowLayers: 4,
    // S9 — the per-character reveal, which did not exist when this list was written.
    clusterRiseEm: 0.8,
    clusterStaggerFraction: 0.6
  })
};

const richLayers = applyCaptionTrackToComposition(composition, track("golden-rich"), richPreset).tracks.find(
  (item) => item.id === `${composition.id}_track_captions`
)?.layers;
const richLayer = richLayers?.[0] as Record<string, unknown> | undefined;
assert.ok(richLayer, "The rich preset produced no caption layer at all.");

for (const [field, expected] of [
  ["fillGradientFrom", "#FF8800"],
  ["fillGradientTo", "#0088FF"],
  ["strokeOuterColor", "#F5D90A"],
  ["strokeOuterWidth", 26],
  ["strokePaintOrder", "under"],
  ["backgroundPerLine", true],
  ["backgroundRadiusEm", 0.4],
  ["shadowLayers", 4],
  ["clusterRiseEm", 0.8],
  ["clusterStaggerFraction", 0.6]
] as const) {
  assert.equal(
    richLayer![field],
    expected,
    `"${field}" did not reach the caption layer. The envelope carries it and the layer does not, which ` +
      `means the fold rehoused the old nine fields instead of replacing them — a caption look that ` +
      `SAYS something the renderer never hears is the copy-list defect wearing the new format.`
  );
}

// The control that stops the loop above from being vacuous: these fields are genuinely absent from a
// preset that does not name them, rather than being defaulted in by something on the way through.
const plainLayer = applyCaptionTrackToComposition(composition, track("minimal"), captionStylePresets[0]!).tracks
  .find((item) => item.id === `${composition.id}_track_captions`)
  ?.layers[0] as Record<string, unknown> | undefined;
for (const field of ["fillGradientFrom", "strokeOuterColor", "clusterRiseEm", "shadowLayers"]) {
  assert.ok(
    !(field in plainLayer!),
    `"${field}" is present on a caption layer whose preset never named it. Absent must stay absent ` +
      `(D1a) — a defaulted key here would make every caption track in every existing project carry a ` +
      `field nobody authored, which is the migration this stage promised not to write.`
  );
}

// And the boundaries, asserted rather than described: neither of the two held-out fields leaked in.
const look = captionPresetLook(richPreset) as Record<string, unknown>;
assert.ok(!("positionY" in look), "positionY leaked into the envelope — placement is not a look.");
assert.ok(!("highlightColor" in look), "highlightColor leaked into the envelope — it is a RUN style, not a layer style.");

console.log(
  "PASS — a caption preset now reaches the layer with 10 fields the nine-field struct could not express, " +
    "absent stays absent on one that names none of them, and placement/highlight stayed out of the envelope."
);
