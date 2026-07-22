import { z } from "zod";
import { gradeIntentSchema } from "../color/grade-intent";
import { nodeGraphIntentSchema } from "../flarex/node-graph-intent";
import { notesIntentSchema } from "../notes/notes-intent";
import type { Skill, SkillTaskKind } from "./skill-types";

/**
 * Skill registry — the always-disclosed catalog the planner reads. Only the asset
 * generation skill is implemented today; future skills register here the same way.
 */

const ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4"] as const;
const VIDEO_ASPECT_RATIOS = ["16:9", "9:16", "1:1"] as const;

/** Fields every generation task shares. */
const baseImageParams = {
  prompt: z.string().min(1),
  negativePrompt: z.string().optional(),
  aspectRatio: z.enum(ASPECT_RATIOS).default("1:1"),
  seed: z.number().int().optional(),
  variations: z.number().int().min(1).max(4).default(1)
};

/** A reference image: a data URL, http(s) URL, or an existing SourceAsset id. */
const imageRef = z.string().min(1);

const textToImageSchema = z.object({ ...baseImageParams });

const imageToImageSchema = z.object({
  ...baseImageParams,
  referenceImage: imageRef,
  strength: z.number().min(0).max(1).default(0.65)
});

const inpaintSchema = z.object({
  ...baseImageParams,
  referenceImage: imageRef,
  mask: imageRef
});

const outpaintSchema = z.object({
  ...baseImageParams,
  referenceImage: imageRef,
  mask: imageRef
});

const upscaleSchema = z.object({
  referenceImage: imageRef,
  scale: z.enum(["2x", "4x"]).default("2x")
});

const textToVideoSchema = z.object({
  prompt: z.string().min(1),
  negativePrompt: z.string().optional(),
  aspectRatio: z.enum(VIDEO_ASPECT_RATIOS).default("16:9"),
  durationSeconds: z.number().min(1).max(10).default(5),
  seed: z.number().int().optional()
});

const imageToVideoSchema = z.object({
  prompt: z.string().optional(),
  referenceImage: imageRef,
  aspectRatio: z.enum(VIDEO_ASPECT_RATIOS).default("16:9"),
  durationSeconds: z.number().min(1).max(10).default(5),
  seed: z.number().int().optional()
});

const taskKinds: SkillTaskKind[] = [
  {
    id: "text-to-image",
    label: "Text to Image",
    modality: "image",
    inputs: ["text"],
    inputSchema: textToImageSchema,
    outputArtifact: "generatedImage",
    capabilityReq: { modality: "image", inputs: ["text"] }
  },
  {
    id: "image-to-image",
    label: "Image to Image",
    modality: "image",
    inputs: ["text", "image"],
    inputSchema: imageToImageSchema,
    outputArtifact: "generatedImage",
    capabilityReq: { modality: "image", inputs: ["text", "image"] }
  },
  {
    id: "inpaint",
    label: "Inpaint",
    modality: "image",
    inputs: ["text", "image", "mask"],
    inputSchema: inpaintSchema,
    outputArtifact: "generatedImage",
    capabilityReq: { modality: "image", inputs: ["text", "image", "mask"] }
  },
  {
    id: "outpaint",
    label: "Outpaint",
    modality: "image",
    inputs: ["text", "image", "mask"],
    inputSchema: outpaintSchema,
    outputArtifact: "generatedImage",
    capabilityReq: { modality: "image", inputs: ["text", "image", "mask"] }
  },
  {
    id: "upscale",
    label: "Upscale",
    modality: "image",
    inputs: ["image"],
    inputSchema: upscaleSchema,
    outputArtifact: "generatedImage",
    capabilityReq: { modality: "image", inputs: ["image"] }
  },
  {
    id: "text-to-video",
    label: "Text to Video",
    modality: "video",
    inputs: ["text"],
    inputSchema: textToVideoSchema,
    outputArtifact: "generatedVideo",
    capabilityReq: { modality: "video", inputs: ["text"] }
  },
  {
    id: "image-to-video",
    label: "Image to Video",
    modality: "video",
    inputs: ["text", "image"],
    inputSchema: imageToVideoSchema,
    outputArtifact: "generatedVideo",
    capabilityReq: { modality: "video", inputs: ["text", "image"] }
  }
];

export const assetGenerationSkill: Skill = {
  id: "asset-generation",
  name: "AI Asset Generation",
  summary: "Generate images and video clips from a prompt or reference, ready to drop on the timeline.",
  aiSummary:
    "Generates net-new image and video assets from text and/or a reference image. Task kinds: text-to-image, image-to-image, inpaint, outpaint, upscale, text-to-video, image-to-video. Output lands as a SourceAsset in the media bin and can be placed as a layer.",
  procedure: [
    "1. Resolve the task kind from the user's intent (image vs video; whether a reference image or mask is provided).",
    "2. Build the task's params against its input schema (prompt, aspect ratio, duration, references).",
    "3. Resolve a capable + available model via the model registry (local-first for image when a local endpoint is reachable; cloud fal.ai otherwise; video is always cloud).",
    "4. Run generation (local: browser→localhost; cloud: server→fal, async job for video).",
    "5. Ingest the result as a SourceAsset (source=\"ai\") so it appears in the media library AI tab.",
    "6. Optionally place it on the timeline via createAssets/createLayers (one undo entry)."
  ].join("\n"),
  category: "generation",
  taskKinds
};

// ---------------------------------------------------------------------------------------------
// Tool skills — wrap the existing editor tools (packages/shared/src/tools.ts) as Skills so the
// planner sees them with the same progressive-disclosure model as generation: an always-on
// `aiSummary` plus an on-demand `procedure`. Unlike generation, these do NOT go through the
// model registry/resolveModels — execution stays on the existing `tool` plan-step → `openTool`
// bridge (see PlanExecutor.ts). `execution: "tool"` + `toolSlug` + `executorReq` let the web
// runtime route via `resolveExecutor` (browser-real vs cloud vs mock) instead of a crude guess.
// ---------------------------------------------------------------------------------------------

const emptyToolParams = z.object({});
const qualityToolParams = z.object({ quality: z.enum(["fast", "quality"]).default("fast").optional() });
const backgroundModeToolParams = z.object({ mode: z.enum(["timelineMask", "greenScreen"]).default("timelineMask").optional() });
const followModeToolParams = z.object({
  mode: z.enum(["follow", "stabilize"]).default("follow").optional(),
  quality: z.enum(["fast", "quality"]).default("fast").optional()
});

const captioningTaskKinds: SkillTaskKind[] = [
  {
    id: "auto-caption",
    label: "Auto Caption",
    modality: "video",
    inputs: ["text"],
    inputSchema: emptyToolParams,
    outputArtifact: "captionTrack",
    capabilityReq: { modality: "video", inputs: ["text"] },
    execution: "tool",
    toolSlug: "auto-captions",
    toolOptions: {},
    executorReq: { deviceFlags: ["webWorkers"] }
  }
];

export const captioningSkill: Skill = {
  id: "captioning",
  name: "Auto Captions",
  summary: "Transcribe the selected clip's speech and apply styled, editable captions.",
  aiSummary:
    "Transcribes speech from the selected video/audio layer and applies an editable caption track. Task kind: auto-caption.",
  procedure: [
    "1. Take the selected clip with an audio track (falls back to the first video/image layer with media).",
    "2. Run local transcription (Whisper, in-browser) to get word/segment timing.",
    "3. Build a caption track with the default style preset via createCaptionTrack.",
    "4. Apply it to the composition via applyCaptionTrackToComposition (one undo entry).",
    "5. The result is editable timeline text — the user can restyle/retime it afterward."
  ].join("\n"),
  category: "captioning",
  taskKinds: captioningTaskKinds
};

const personMatteTaskKinds: SkillTaskKind[] = [
  {
    id: "extract-person",
    label: "Extract Person",
    modality: "video",
    inputs: ["image"],
    inputSchema: qualityToolParams,
    outputArtifact: "maskSequence",
    capabilityReq: { modality: "video", inputs: ["image"] },
    execution: "tool",
    toolSlug: "extract-person",
    toolOptions: { quality: "fast" },
    executorReq: { deviceFlags: ["webWorkers"] }
  }
];

export const personMatteSkill: Skill = {
  id: "person-matte",
  name: "Extract Person",
  summary: "Find the primary person in a clip and produce a reusable mask/cutout.",
  aiSummary:
    "Segments the primary person out of the selected clip into a reusable mask sequence, for reuse by other person-forward tools/templates. Task kind: extract-person.",
  procedure: [
    "1. Take the selected clip with visual media.",
    "2. Run local person segmentation (fast or quality tier) to get a per-frame matte.",
    "3. Store the matte as a derived asset (createAsset) and build a MaskSequenceArtifactData.",
    "4. Apply it via applyExtractPersonComposition (insert mode; one undo entry).",
    "5. The mask artifact is reusable by text-behind-person, background-removal, and templates."
  ].join("\n"),
  category: "masking",
  taskKinds: personMatteTaskKinds
};

const subjectRotoTaskKinds: SkillTaskKind[] = [
  {
    id: "roto-subject",
    label: "AI Roto",
    modality: "video",
    inputs: ["image"],
    inputSchema: emptyToolParams,
    outputArtifact: "maskSequence",
    capabilityReq: { modality: "video", inputs: ["image"] },
    execution: "tool",
    toolSlug: "ai-roto",
    toolOptions: {},
    executorReq: { deviceFlags: ["webWorkers"] }
  }
];

export const subjectRotoSkill: Skill = {
  id: "subject-roto",
  name: "AI Roto",
  summary: "Point at a subject (and anything it's holding) to auto-mask it across the clip.",
  aiSummary:
    "Point-promptable any-object segmentation (SlimSAM, in-browser) — masks a subject plus held objects, not just a person. Task kind: roto-subject.",
  procedure: [
    "1. Take the selected clip with visual media.",
    "2. Auto-seed a center-frame positive point prompt (one-click path; the full tool page lets the user place their own points).",
    "3. Run segmentVideoPrompted with the seeded prompt to propagate the matte across frames.",
    "4. Store the matte as a derived asset and build a MaskSequenceArtifactData.",
    "5. Apply it via applyExtractPersonComposition (insert mode; one undo entry)."
  ].join("\n"),
  category: "masking",
  taskKinds: subjectRotoTaskKinds
};

const backgroundRemovalTaskKinds: SkillTaskKind[] = [
  {
    id: "remove-background-transparent",
    label: "Remove Background (transparent)",
    modality: "video",
    inputs: ["image"],
    inputSchema: backgroundModeToolParams,
    outputArtifact: "alphaClip",
    capabilityReq: { modality: "video", inputs: ["image"] },
    execution: "tool",
    toolSlug: "remove-background",
    toolOptions: { mode: "timelineMask" },
    executorReq: { deviceFlags: ["webWorkers"] }
  },
  {
    id: "remove-background-greenscreen",
    label: "Remove Background (green screen)",
    modality: "video",
    inputs: ["image"],
    inputSchema: backgroundModeToolParams,
    outputArtifact: "greenScreenClip",
    capabilityReq: { modality: "video", inputs: ["image"] },
    execution: "tool",
    toolSlug: "remove-background",
    toolOptions: { mode: "greenScreen" },
    executorReq: { deviceFlags: ["webWorkers"] }
  }
];

export const backgroundRemovalSkill: Skill = {
  id: "background-removal",
  name: "Remove Background",
  summary: "Separate the subject from its background — transparent matte or green screen.",
  aiSummary:
    "Segments the SUBJECT out of a real-world background (person extraction): remove-background-transparent = transparent timeline matte; remove-background-greenscreen = REPLACES the background WITH solid green (outputs green-screen-ready footage — it does NOT key green out). To key OUT footage that ALREADY has a green/blue screen, use the flarex-comp skill's chroma key instead.",
  procedure: [
    "1. Take the selected clip with visual media.",
    "2. Run local person segmentation to get a per-frame matte (reuses the extract-person pass).",
    "3. Store the matte as a derived asset and build a MaskSequenceArtifactData.",
    "4. Apply via applyRemoveBackgroundComposition with mode=timelineMask (transparent) or mode=greenScreen.",
    "5. One undo entry; alpha video export depends on renderer capability."
  ].join("\n"),
  category: "compositing",
  taskKinds: backgroundRemovalTaskKinds
};

const objectRemovalTaskKinds: SkillTaskKind[] = [
  {
    id: "remove-person",
    label: "Remove Person",
    modality: "video",
    inputs: ["image"],
    inputSchema: emptyToolParams,
    outputArtifact: "inpaintedClip",
    capabilityReq: { modality: "video", inputs: ["image"] },
    execution: "tool",
    toolSlug: "remove-person",
    toolOptions: {},
    executorReq: { deviceFlags: ["webWorkers"] }
  }
];

export const objectRemovalSkill: Skill = {
  id: "object-removal",
  name: "Remove Person",
  summary: "Select a person or object, and remove it with a clean inpainted background.",
  aiSummary:
    "Removes a person/object from the selected clip and reconstructs the background via real generative inpainting (LaMa, in-browser). Task kind: remove-person.",
  procedure: [
    "1. Take the selected clip with visual media.",
    "2. Auto-seed a centered selection mask (one-click path; the full tool page lets the user brush/tap a precise selection).",
    "3. Run runVideoInpaint (LaMa on a centered crop, diffusion fallback for pixels outside it).",
    "4. Save the reconstructed clip as a new derived asset via createAsset.",
    "5. Apply via applyRemovePersonComposition as a plain video layer (one undo entry)."
  ].join("\n"),
  category: "object-removal",
  taskKinds: objectRemovalTaskKinds
};

const followTextTaskKinds: SkillTaskKind[] = [
  {
    id: "follow-text",
    label: "Follow Text",
    modality: "video",
    inputs: ["image"],
    inputSchema: followModeToolParams,
    outputArtifact: "trackingPath",
    capabilityReq: { modality: "video", inputs: ["image"] },
    execution: "tool",
    toolSlug: "smart-3d-follow-text",
    toolOptions: { mode: "follow", quality: "fast" },
    executorReq: { deviceFlags: ["webWorkers"] }
  },
  {
    id: "stabilize-subject",
    label: "Stabilize Subject",
    modality: "video",
    inputs: ["image"],
    inputSchema: followModeToolParams,
    outputArtifact: "trackingPath",
    capabilityReq: { modality: "video", inputs: ["image"] },
    execution: "tool",
    toolSlug: "smart-3d-follow-text",
    toolOptions: { mode: "stabilize", quality: "fast" },
    executorReq: { deviceFlags: ["webWorkers"] }
  }
];

export const followTextSkill: Skill = {
  id: "follow-text",
  name: "Smart 3D Follow Text",
  summary: "Track a subject and lock text to it in 3D, or stabilize the subject itself.",
  aiSummary:
    "Runs a local AI-assisted planar track on the selected clip and either attaches text that follows the tracked subject or stabilizes the subject's motion. Task kinds: follow-text, stabilize-subject.",
  procedure: [
    "1. Take the selected clip with visual media.",
    "2. Auto-detect the subject and run worker-offloaded planar tracking (fast or quality tier).",
    "3. In follow mode: create an editable text layer with position/scale/rotation/perspective keyframes via applySmartFollowTextComposition (seeded text placeholder, user edits after).",
    "4. In stabilize mode: create an inverse-transform layer that holds the subject steady via applyStabilizationComposition.",
    "5. One undo entry either way."
  ].join("\n"),
  category: "motion",
  taskKinds: followTextTaskKinds
};

const textBehindTaskKinds: SkillTaskKind[] = [
  {
    id: "text-behind-person",
    label: "Text Behind Person",
    modality: "video",
    inputs: ["image", "text"],
    inputSchema: emptyToolParams,
    outputArtifact: "timelinePatch",
    capabilityReq: { modality: "video", inputs: ["image", "text"] },
    execution: "tool",
    toolSlug: "text-behind-person",
    toolOptions: {},
    executorReq: { deviceFlags: ["webWorkers"] }
  }
];

export const textBehindSkill: Skill = {
  id: "text-behind",
  name: "Text Behind Person",
  summary: "Layer bold typography behind a subject with the subject cut out on top.",
  aiSummary:
    "Builds a layered composite where text sits behind the cutout subject and in front of the background, from the selected clip. Task kind: text-behind-person.",
  procedure: [
    "1. Take the selected clip with visual media.",
    "2. Run local person segmentation to get a per-frame matte (reuses the extract-person pass).",
    "3. Store the matte as a derived asset and build a MaskSequenceArtifactData.",
    "4. Apply via applyTextBehindPersonComposition, which layers background < text < cutout subject (seeded placeholder text, user edits after).",
    "5. One undo entry."
  ].join("\n"),
  category: "compositing",
  taskKinds: textBehindTaskKinds
};

// ---------------------------------------------------------------------------------------------
// Color grade skill — the AI colorist. Unlike generation/tool skills, this is compiled LOCALLY:
// the planner emits a compact GradeIntent and the web runtime (AiChatPanel.runSkillStep) expands
// it into an editable stack of real color effects via color/grade-intent.ts. No model, no cloud,
// no tokens for the heavy structure work. Progressive disclosure: the one-line aiSummary is always
// in the planner prompt; the full intent vocabulary rides in `procedure`, loaded only when a color
// grade is actually selected.
// ---------------------------------------------------------------------------------------------

const colorGradeTaskKinds: SkillTaskKind[] = [
  {
    id: "color-grade",
    label: "Color Grade",
    modality: "image",
    inputs: ["text"],
    inputSchema: gradeIntentSchema,
    outputArtifact: "timelinePatch",
    capabilityReq: { modality: "image", inputs: ["text"] },
    execution: "grade"
  }
];

export const colorGradeSkill: Skill = {
  id: "color-grade",
  name: "Color Grade",
  summary: "Grade a clip like a colorist — primary, curves, 3-way wheels, hue-selective, secondary keys.",
  aiSummary:
    "Authors a full color grade on the target clip from a compact GradeIntent — {look?, primary?, tone?, balance?, hue?, secondary?} — which the app compiles locally into a real, editable effect stack (Basic Correction + Curves + 3-way Wheels + Hue/Sat Curves + HSL Secondary). Use this for ANY color/look request; do NOT hand-author curve JSON. Task kind: color-grade.",
  procedure: [
    "Emit ONE skill step { skillId: 'color-grade', taskKind: 'color-grade', params: <GradeIntent> }. All fields optional; include only what the user asked for.",
    "GradeIntent fields:",
    "  look?: a preset base — one of Teal & Orange, Faded Film, Noir, Warm Sunset, Cold Morning, Cinematic, Bleach Bypass, Cross Process. lookIntensity?: 0..100.",
    "  primary?: { exposure, contrast, highlights, shadows, whites, blacks, saturation(0..220, neutral 100), vibrance, temperature, tint } — all -100..100 except saturation.",
    "  tone?: { contrast(-1..1 S-curve), lift(0..1 raise blacks), crush(0..1 deepen blacks), rolloff(0..1 soften highlights) }.",
    "  balance?: { shadows?, midtones?, highlights? } each { hue: <name>, strength: 0..1, luma?: -1..1 } — the 3-way wheels (e.g. teal shadows + orange highlights).",
    "  hue?: [ { target: <name>, sat?: -1..1, hueShift?: -0.5..0.5, luma?: -1..1 } ] — hue-selective (boost/shift one color).",
    "  secondary?: [ { target: <name>, sat?, hueShift?, luma?, invert? } ] — isolate a color/skin/sky and grade only it (invert = everything else).",
    "  <name> ∈ red, orange, yellow, green, teal, cyan, blue, purple, magenta, skin, sky, foliage.",
    "Examples:",
    "  'teal and orange, crush the blacks' → { balance: { shadows: { hue:'teal', strength:0.5 }, highlights: { hue:'orange', strength:0.4 } }, tone: { crush:0.4, contrast:0.3 } }.",
    "  'warm filmic look, lift the shadows' → { look:'Cinematic', tone:{ lift:0.3 }, primary:{ temperature:15 } }.",
    "  'keep skin warm, desaturate the background' → { secondary: [ { target:'skin', sat:0.1 }, { target:'skin', invert:true, sat:-0.6 } ] }."
  ].join("\n"),
  category: "color",
  taskKinds: colorGradeTaskKinds
};

// ---------------------------------------------------------------------------------------------
// Audio analysis skill — real in-browser DSP (no model, no cloud, no tokens). Beat detection
// decodes the clip's audio and finds onsets/tempo locally (apps/web/src/tools/beat-detection.ts);
// the runtime (AiChatPanel.runSkillStep) can also APPLY the result — markers on every beat and/or
// cuts on every beat — in the same step via the marker/splitClipAtTimes registry actions.
// ---------------------------------------------------------------------------------------------

export const beatDetectionParamsSchema = z.object({
  /** Target clip (a slice layer id). Omit to use the selected/playhead clip. */
  layerId: z.string().optional(),
  /**
   * What to do with the detected beats: report = just return the times (for follow-up steps),
   * markers = drop a marker per beat, cuts = split the clip at every beat, both = markers + cuts.
   */
  apply: z.enum(["report", "markers", "cuts", "both"]).optional()
});

const audioAnalysisTaskKinds: SkillTaskKind[] = [
  {
    id: "beat-detection",
    label: "Beat Detection",
    modality: "audio",
    inputs: ["text"],
    inputSchema: beatDetectionParamsSchema,
    outputArtifact: "timelinePatch",
    capabilityReq: { modality: "audio", inputs: ["text"] },
    execution: "analysis"
  }
];

export const audioAnalysisSkill: Skill = {
  id: "audio-analysis",
  name: "Audio Analysis",
  summary: "Detect the beats/tempo of a clip's audio and cut or mark the timeline in sync.",
  aiSummary:
    "Detects beats + BPM of the target clip's audio locally (real DSP, free), and can APPLY the result in the same step: params.apply = 'markers' (marker per beat), 'cuts' (split the clip at every beat), 'both', or 'report' (just return the beat times for your next step). Task kind: beat-detection.",
  procedure: [
    "Emit ONE skill step { skillId: 'audio-analysis', taskKind: 'beat-detection', params: { layerId?, apply? } }.",
    "apply: 'cuts' for 'cut on the beats'; 'markers' for 'mark the beats'; 'both' for both; 'report' (default) to get the times back and decide yourself.",
    "The result line includes the BPM, beat count, and beat times (timeline seconds) — usable directly as `times` for addMarkersAtTimes / splitClipAtTimes.",
    "Works on video clips with audio and on audio clips. Speed-ramped clips are approximated at 1x."
  ].join("\n"),
  category: "motion",
  taskKinds: audioAnalysisTaskKinds
};

// ---------------------------------------------------------------------------------------------
// Flarex compositor skill — the AI compositor (FLAREX.md Part 7). Compiled LOCALLY like the
// color grade: the planner emits a compact NodeGraphIntent and the web runtime
// (AiChatPanel.runSkillStep) expands it into REAL editable nodes in the target clip's Flarex
// comp via flarex/node-graph-intent.ts. No model, no cloud, no tokens for the structure work.
// ---------------------------------------------------------------------------------------------

const flarexTaskKinds: SkillTaskKind[] = [
  {
    id: "flarex-comp",
    label: "Flarex Composite",
    modality: "image",
    inputs: ["text"],
    inputSchema: nodeGraphIntentSchema,
    outputArtifact: "timelinePatch",
    capabilityReq: { modality: "image", inputs: ["text"] },
    execution: "flarex"
  }
];

export const flarexSkill: Skill = {
  id: "flarex-comp",
  name: "Flarex Composite",
  summary: "Build node-based VFX on a clip — keying, glow, region blur, merges — as an editable node graph.",
  aiSummary:
    "Authors node-based compositing on the target clip from a compact NodeGraphIntent — { ops: [key|composite|grade|blur|blurRegion|glow|sharpen|transform|filter|mask|matte] } — which the app compiles locally into REAL editable nodes in the clip's Flarex comp (created if missing; appended if it exists). THE way to key OUT existing green/blue-screen footage ('remove the green screen' → chroma key op; never background-removal, whose greenscreen mode outputs green). Also: glow, region/face blur, shape masks, matte combine/feather/choke, re-compositing, stylize filters. Task kind: flarex-comp.",
  procedure: [
    "Emit ONE skill step { skillId: 'flarex-comp', taskKind: 'flarex-comp', params: { ops: [...] } }. 1–12 ops, applied in order down the clip's node chain.",
    "Ops:",
    "  { op:'key', kind:'chroma'|'luma', color?:'#rrggbb', tolerance?:0..1, softness?:0..1, spill?:0..1 } — green/blue-screen removal (chroma default #00b140).",
    "  { op:'composite', blend:<blend mode>, opacity?:0..1 } — merge the chain-so-far back OVER the clean source (use after a key to re-composite).",
    "  { op:'grade', exposure?/contrast?/temperature?/tint?: -100..100, saturation?: 0..220 } — color-correct inside the comp.",
    "  { op:'blur', sigma: 0..200 } and { op:'blurRegion', shape:'rect'|'ellipse', centerX/centerY:0..1, width/height:0..2, sigma, feather? } — whole-frame or region blur (region = 'blur his face' with an ellipse over the face area).",
    "  { op:'glow', radius:0..200, intensity?:0..2, threshold?:0..1 } · { op:'sharpen', amount:0..2 } · { op:'transform', x?/y?:-100..100 (percent), scale?:0..4, rotation?:-180..180 }.",
    "  { op:'filter', effectId: radialBlur|directionalBlur|pixelate|chromaticAberration|sketch|oldTv|glitchFx|halftone|posterize, intensity?:0..1 }.",
    "  { op:'mask', shape:'rect'|'ellipse', region:{ x,y,w,h : 0..1 } (center + size, like blurRegion), feather?:0..1, invert?:boolean } — limit the chain-so-far to a shape ('mask an oval over the subject').",
    "  { op:'matte', action:'combine'|'invert'|'feather'|'choke', amount?:0..1 } — operate on the running matte from a preceding mask/key (feather softens the edge, choke shrinks it, invert flips it).",
    "Examples:",
    "  'key out the green screen and add some glow' → { ops: [ { op:'key', kind:'chroma' }, { op:'glow', radius:30 } ] }.",
    "  'blur the center of the frame' → { ops: [ { op:'blurRegion', shape:'ellipse', centerX:0.5, centerY:0.5, width:0.5, height:0.5, sigma:24 } ] }.",
    "The result is a real node graph on the clip (Flarex page, Shift+F) the user can inspect and edit node by node."
  ].join("\n"),
  category: "compositing",
  taskKinds: flarexTaskKinds
};

// ---------------------------------------------------------------------------------------------
// Notes board skill (plans/notes-sonnet-execution-2.md P1): "make a mindmap about X", "add a
// kanban of these tasks" → a compact NotesIntent the web runtime (AiChatPanel.runSkillStep)
// compiles LOCALLY onto the active Notes board via notes/notes-intent.ts. No model, no cloud, no
// tokens for the structure work — the LLM only picks the words, the compiler owns the layout.
// ---------------------------------------------------------------------------------------------

const notesTaskKinds: SkillTaskKind[] = [
  {
    id: "notes-board",
    label: "Notes Board",
    modality: "image",
    inputs: ["text"],
    inputSchema: notesIntentSchema,
    outputArtifact: "timelinePatch",
    capabilityReq: { modality: "image", inputs: ["text"] },
    execution: "notes"
  }
];

export const notesSkill: Skill = {
  id: "notes-board",
  name: "Notes Board",
  summary: "Populate the Notes creative board — notes, frames, mindmaps, todos — as real editable cards.",
  aiSummary:
    "Builds cards on the Notes board (the Miro/Milanote creative-organizer page) from a compact NotesIntent — { ops: [addNote|addFrame|connect|mindmap|todo] } — which the app compiles LOCALLY into real, editable, connected cards on the active board. Use for 'make a mindmap about X', 'brainstorm ideas for Y', 'add a todo list of Z', 'outline a plan for W'. NOT for timeline/clip edits. Task kind: notes-board.",
  procedure: [
    "Emit ONE skill step { skillId: 'notes-board', taskKind: 'notes-board', params: { ops: [...] } }. 1–24 ops.",
    "Do NOT set pixel coordinates unless the user is explicit — the compiler lays cards out. Prefer 'mindmap' for anything tree/brainstorm shaped.",
    "Ops:",
    "  { op:'mindmap', root:'<center idea>', branches:[ '<child>' | { text:'<child>', children:[...] } ] } — the go-to for brainstorms/outlines; compiles to a laid-out tree of connected note cards.",
    "  { op:'addNote', text:'<card text>', color?:'#rrggbb' } · { op:'addFrame', title:'<group title>' } · { op:'todo', title:'<list title>', items:['<row>', ...] }.",
    "  { op:'connect', fromRef:<n>, toRef:<n>, label?:'<edge label>' } — refs are 1-based indices into the items created by THIS intent's ops, in order (not board ids).",
    "Examples:",
    "  'mind map about photosynthesis' → { ops:[ { op:'mindmap', root:'Photosynthesis', branches:['Light reactions','Calvin cycle',{ text:'Inputs', children:['CO2','Water','Sunlight'] }] } ] }.",
    "  'todo list for the shoot' → { ops:[ { op:'todo', title:'Shoot', items:['Scout location','Charge batteries','Backup cards'] } ] }.",
    "The result is real cards on the Notes page the user can drag, edit, and connect."
  ].join("\n"),
  category: "planning",
  taskKinds: notesTaskKinds
};

export const skillRegistry: Skill[] = [
  assetGenerationSkill,
  captioningSkill,
  personMatteSkill,
  subjectRotoSkill,
  backgroundRemovalSkill,
  objectRemovalSkill,
  followTextSkill,
  textBehindSkill,
  colorGradeSkill,
  audioAnalysisSkill,
  flarexSkill,
  notesSkill
];

export function getSkill(id: string): Skill | undefined {
  return skillRegistry.find((skill) => skill.id === id);
}

/**
 * Find the tool-execution task kind (execution:"tool") whose `toolSlug` matches a
 * `toolCapabilityDefinitions` slug. Used by the web runtime to resolve a live executor
 * (`resolveExecutor`) for a one-click tool run, without hand-maintaining a slug→taskKind map.
 */
export function getSkillTaskForToolSlug(toolSlug: string): SkillTaskKind | undefined {
  for (const skill of skillRegistry) {
    const task = skill.taskKinds.find((candidate) => candidate.execution === "tool" && candidate.toolSlug === toolSlug);
    if (task) {
      return task;
    }
  }
  return undefined;
}

/**
 * Compact, always-disclosed skill description for the planner prompt. Mirrors
 * `describeForPlanner()` in the capability index — one `aiSummary` line per skill plus
 * its task-kind ids, so the planner can select generation without loading each skill's
 * full procedure (that's fetched on demand from `skill.procedure`).
 */
export function describeSkillsForPlanner(): string {
  return [
    "SKILLS (generation task kinds → a 'skill' step with skillId + taskKind + params; tool task kinds → a 'tool' step with the listed toolSlug):",
    ...skillRegistry.map((skill) => {
      const taskList = skill.taskKinds
        .map((task) => (task.execution === "tool" && task.toolSlug ? `${task.id}→${task.toolSlug}` : task.id))
        .join(", ");
      return `- ${skill.id} [${taskList}]: ${skill.aiSummary}`;
    })
  ].join("\n");
}
