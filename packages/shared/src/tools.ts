import type { ToolCapabilityDefinition, ToolDefinition, ToolRun, ToolStage } from "./types";

export const toolCapabilityDefinitions: ToolCapabilityDefinition[] = [
  {
    id: "tool_auto_captions",
    name: "Auto Captions",
    slug: "auto-captions",
    icon: "captions",
    shortDescription: "Generate punchy captions with highlighted words and zoom emphasis.",
    userDescription:
      "Turn speech into editable creator captions. Import or generate a transcript, style the captions, preview timing, and apply the result as normal timeline text layers.",
    aiDescription:
      "Creates editable caption tracks from video, audio, imported transcript, SRT, or VTT. Outputs word/segment timing, highlighted words, caption style metadata, and timeline patches with text layers and optional emphasis keyframes.",
    category: "captions",
    moduleType: "AUTO_CAPTIONS",
    accepts: ["video", "audio", "transcript"],
    outputs: ["transcript", "captionTrack", "timelinePatch", "diagnostics"],
    stages: ["upload", "transcribe", "style", "preview", "apply", "export"],
    browserMode: "progressive",
    adapters: ["mock", "browser", "cloud"],
    timelineActions: ["createLayers", "addKeyframes"],
    estimatedCredits: 10,
    bestFor: "Podcasts, explainers, Hindi reels, talking-head clips, and hook-heavy shorts",
    limitations: [
      "Browser transcription will use small/proxy models first.",
      "Word-level timing may need manual correction before AI/cloud transcription is wired.",
      "Generated captions should remain editable timeline text, not baked video."
    ]
  },
  {
    id: "tool_extract_person",
    name: "Extract Person",
    slug: "extract-person",
    icon: "person-extraction",
    shortDescription: "Create person masks, cutouts, and tracking metadata for reuse in templates.",
    userDescription:
      "Find the primary person in a clip, inspect the mask, and save reusable cutout/tracking artifacts for templates such as text-behind-person and follow text.",
    aiDescription:
      "Analyzes video or image assets to identify a primary person. Outputs mask sequences, subject bounds, subject center tracking, optional pose metadata, reusable cutout assets, and timeline patches for person-forward templates.",
    category: "masking",
    moduleType: "PERSON_EXTRACTION",
    accepts: ["video", "image"],
    outputs: ["maskSequence", "trackingPath", "subjectBounds", "alphaClip", "timelinePatch", "diagnostics"],
    stages: ["upload", "extract", "inspect", "preview", "apply", "export"],
    browserMode: "heavy",
    adapters: ["mock", "browser", "cloud", "desktop"],
    timelineActions: ["createAssets", "createLayers"],
    estimatedCredits: 9,
    bestFor: "Text-behind-person, subject cutouts, background removal, and reusable creator templates",
    limitations: [
      "Browser mode should preview low-resolution masks before full quality.",
      "Crowds, fast motion, hair, and low contrast backgrounds may need cloud/desktop quality later.",
      "Mask artifacts must be inspectable and reusable by other tools."
    ]
  },
  {
    id: "tool_ai_roto",
    name: "AI Roto",
    slug: "ai-roto",
    icon: "person-extraction",
    shortDescription: "Point at a subject — and anything it's holding — to auto-mask it across the clip.",
    userDescription:
      "Click the person and any object they hold (bike, notebook, cup) to build a precise subject matte that follows the clip. Add or subtract clicks to refine, then apply it as an editable matte.",
    aiDescription:
      "Point-promptable, any-object segmentation (SlimSAM, in-browser). Consumes a video plus include/exclude point prompts (auto-seeded on the detected person) and outputs a per-frame luma matte sequence, a reusable MatteRef, and a timeline patch attaching it to the source layer. Unlike person-only matting it can include arbitrary held objects.",
    category: "masking",
    moduleType: "PERSON_EXTRACTION",
    accepts: ["video", "image"],
    outputs: ["maskSequence", "timelinePatch", "diagnostics"],
    stages: ["upload", "mask", "preview", "apply", "export"],
    browserMode: "heavy",
    adapters: ["browser", "cloud"],
    timelineActions: ["createAssets", "createLayers"],
    estimatedCredits: 10,
    bestFor: "Isolating a person plus the objects they hold, product cutouts, and any-subject masks",
    limitations: [
      "Runs SlimSAM in the browser; first use lazy-loads the model (self-hosted weights).",
      "Propagation v1 holds the prompt across frames — fast subject motion can drift until SAM2 video tracking lands.",
      "Multiple separate objects on one prompt may need add-clicks on each; very small objects can be missed."
    ]
  },
  {
    id: "tool_remove_background",
    name: "Remove Background",
    slug: "remove-background",
    icon: "background-removal",
    shortDescription: "Generate a transparent or green-screen-ready clip from a portrait video.",
    userDescription:
      "Use a person mask to separate subject from background, preview the matte, tune edges, and apply a transparent or green-screen-ready result.",
    aiDescription:
      "Consumes or creates person mask artifacts to separate foreground subject from background. Outputs editable mask settings, mask sequences, transparent/alpha derivative clips where supported, green-screen clips, and timeline patches.",
    category: "compositing",
    moduleType: "BACKGROUND_REMOVAL",
    accepts: ["video", "image", "mask"],
    outputs: ["maskSequence", "alphaClip", "greenScreenClip", "timelinePatch", "diagnostics"],
    stages: ["upload", "mask", "preview", "apply", "export"],
    browserMode: "heavy",
    adapters: ["mock", "browser", "cloud", "desktop"],
    timelineActions: ["createAssets", "createLayers", "addEffects"],
    estimatedCredits: 12,
    bestFor: "Product shots, memes, talking heads, and creator overlays",
    limitations: [
      "Should reuse Extract Person artifacts when available.",
      "Alpha video export depends on renderer capability.",
      "Browser preview should use proxy masks and defer full baking to export."
    ]
  },
  {
    id: "tool_remove_person",
    name: "Remove Person",
    slug: "remove-person",
    icon: "background-removal",
    shortDescription: "Select a person or object, track it, and remove it with a clean inpainted background.",
    userDescription:
      "Tap or brush the person/object you want gone, preview the cleaned clip, and apply a single inpainted video layer to the timeline. Re-edit the selection any time.",
    aiDescription:
      "Consumes a video plus an interactive selection (tap snapping to the MediaPipe-detected subject, or a freehand brush mask). Runs a real LaMa generative inpainting model (ONNX, in-browser) over a centered square crop per frame to reconstruct the background, with a cheaper diffusion fallback for any leftover hole pixels outside that crop or if the model can't load on-device. Outputs a full-frame inpainted clip plus a timeline patch placing it as a plain video layer.",
    category: "masking",
    moduleType: "PERSON_REMOVAL",
    accepts: ["video", "image", "mask"],
    outputs: ["maskSequence", "inpaintedClip", "timelinePatch", "diagnostics"],
    stages: ["upload", "mask", "track", "preview", "apply", "export"],
    browserMode: "heavy",
    adapters: ["mock", "browser", "cloud"],
    timelineActions: ["createAssets", "createLayers"],
    estimatedCredits: 12,
    bestFor: "Removing photobombers, unwanted people, logos, or objects from short clips",
    limitations: [
      "Real inpainting runs on a centered square crop (the model's fixed 512x512 input); hole pixels outside that crop on non-square clips fall back to a cheaper diffusion fill.",
      "First run downloads a ~200MB model and is slow on CPU/WASM; faster with WebGPU.",
      "Brush selection is a single static region (not tracked across motion) until real SAM2 point-prompt tracking lands.",
      "Cloud adapter offload for low-power devices is still a contract-only stub."
    ]
  },
  {
    id: "tool_smart_3d_follow_text",
    name: "Smart 3D Follow Text",
    slug: "smart-3d-follow-text",
    icon: "follow-text",
    shortDescription: "Track one or more targets and lock text or stabilize the subject to them in 3D.",
    userDescription:
      "Auto-detect a subject or draw your own track box(es) on the real video frame, choose fast or quality tracking, then either attach editable text that follows the tracked surface (position, scale, rotation, perspective tilt) or stabilize the subject itself. Multi-target tracking runs several boxes in one local pass.",
    aiDescription:
      "Consumes trackingPath, subjectBounds, pose, face, or object tracking metadata. Runs a local AI-assisted planar track (AI-detected subject and/or user-placed boxes, tracked via worker-offloaded optical flow with coarse-to-fine multi-scale search and automatic re-acquisition on occlusion) and generates editable text layers (position, scale, rotation, perspective-tilt keyframes) or, in stabilize mode, an inverse-transform layer that holds the subject steady.",
    category: "motion",
    moduleType: "SMART_3D_FOLLOW_TEXT",
    accepts: ["video", "trackingPath", "mask"],
    outputs: ["trackingPath", "subjectBounds", "timelinePatch", "diagnostics"],
    stages: ["upload", "track", "tune", "preview", "apply", "export"],
    browserMode: "progressive",
    adapters: ["browser", "cloud"],
    timelineActions: ["createLayers", "addKeyframes"],
    estimatedCredits: 0,
    bestFor: "Sports, travel, dance, fashion, multi-subject edits, and shaky handheld footage (stabilize mode)",
    limitations: [
      "Real 3D track is planar (homography-based), not a full camera/lens solve.",
      "Browser adapter runs fully locally (free) via worker-offloaded optical flow + AI-detected/user-placed targets; tracking quality depends on texture and lighting.",
      "Occlusion recovery re-acquires automatically only for the AI-detected target; manually-placed targets hold their last good position until the tracked region reappears.",
      "Multi-target candidate suggestion (picking between several auto-detected subjects) isn't available yet - add extra targets manually by drawing additional boxes."
    ]
  },
  {
    id: "tool_text_behind_person",
    name: "Text Behind Person",
    slug: "text-behind-person",
    icon: "text-behind",
    shortDescription: "Layer bold typography behind a subject with a cinematic 9:16 preview.",
    userDescription:
      "Create a layered composite where the background stays behind text and the cutout subject renders on top. Edit the text, style, mask, and layer stack afterward.",
    aiDescription:
      "Consumes a video/image plus person mask. Creates a composite timeline where background stays behind text, text sits behind the cutout subject, and foreground subject renders on top. Outputs editable text, mask references, and layer-stack timeline patches.",
    category: "compositing",
    moduleType: "TEXT_BEHIND_PERSON",
    accepts: ["video", "image", "mask"],
    outputs: ["maskSequence", "timelinePatch", "thumbnail", "diagnostics"],
    stages: ["upload", "text", "preview", "apply", "export"],
    browserMode: "progressive",
    adapters: ["mock", "browser", "cloud"],
    timelineActions: ["createLayers", "addEffects", "addKeyframes"],
    estimatedCredits: 14,
    bestFor: "Music edits, action reels, cinematic hooks, and bold typography templates",
    limitations: [
      "Requires mask artifacts for the real composite path.",
      "MVP can create a mock layer stack before real mask rendering.",
      "Preview/export parity needs a masked-frame comparison fixture later."
    ]
  },
  {
    id: "tool_generative_stylize",
    name: "Generative Stylize",
    slug: "generative-stylize",
    icon: "generic",
    shortDescription: "Redraw a frame as anime, comic, watercolor, or CG art — your AI, your style.",
    userDescription:
      "Turn any frame or image into a genuinely re-drawn illustration: pick a style, copy the crafted prompt into your own chat AI (free), and bring the redrawn image back as a media-library asset for posters, thumbnails, and stylized freeze-frames. For styling full VIDEO, use the deterministic Stylize effect instead — it's temporally stable; generative redraw is per-frame only.",
    aiDescription:
      "Single-frame generative restyling: builds a fidelity-locked style prompt (preserve composition, pose, identity, aspect ratio; change rendering style only) for an input image. Two working paths — prompt bridge (user runs the prompt in their own chat AI and pastes the result back) and integrated BYO-key (direct browser call to a Gemini image-output model with the user's own API key, stored on-device only). Results save as local-first ai-source assets carrying their prompt metadata. Cloud adapter (Orreris-managed keys) remains a contract stub. Explicitly NOT a video path — direct video requests to the stylize timeline effect.",
    category: "compositing",
    moduleType: "GENERATIVE_STYLIZE",
    accepts: ["image"],
    outputs: ["generatedImage", "diagnostics"],
    stages: ["upload", "style", "preview", "apply"],
    browserMode: "instant",
    adapters: ["browser", "cloud"],
    timelineActions: ["createAssets"],
    estimatedCredits: 0,
    bestFor: "Anime/comic poster frames, thumbnails, stylized intro stills, and cover art from your own footage",
    limitations: [
      "Single frames only — generative video redraw boils frame-to-frame; the Stylize effect is the stable video path.",
      "Free path relies on your own chat AI's image quality and its content rules.",
      "Integrated path needs your own Gemini API key (stored on-device; billed to your Google account, nothing added on top).",
      "Orreris-managed cloud rendering is a contract stub today (will be priced per use, at cost, when wired)."
    ]
  }
];

export const toolDefinitionsFromCapabilities: ToolDefinition[] = toolCapabilityDefinitions.map((tool) => ({
  id: tool.id,
  name: tool.name,
  slug: tool.slug,
  description: tool.shortDescription,
  moduleType: tool.moduleType,
  steps: tool.stages.map(stageLabel),
  creditCost: tool.estimatedCredits ?? 0,
  bestFor: tool.bestFor
}));

export function getToolCapability(slugOrId: string) {
  return toolCapabilityDefinitions.find((tool) => tool.slug === slugOrId || tool.id === slugOrId);
}

export function stageLabel(stage: ToolStage) {
  switch (stage) {
    case "upload":
      return "Upload";
    case "analyze":
      return "Analyze";
    case "transcribe":
      return "Transcribe";
    case "extract":
      return "Extract";
    case "mask":
      return "Mask";
    case "track":
      return "Track";
    case "style":
      return "Style";
    case "text":
      return "Text";
    case "tune":
      return "Tune";
    case "inspect":
      return "Inspect";
    case "preview":
      return "Preview";
    case "apply":
      return "Apply";
    case "export":
      return "Export";
  }
}

export function createMockToolRun(tool: ToolCapabilityDefinition, now = new Date().toISOString()): ToolRun {
  return {
    id: `tool_run_${tool.slug}`,
    toolId: tool.id,
    status: "draft",
    progress: 0,
    stage: tool.stages[0] ?? "upload",
    inputAssetIds: [],
    params: {},
    artifacts: [],
    diagnostics: [
      {
        level: "info",
        code: "TL0_MOCK_RUN",
        message: "TL0 shell only: runtime adapters and real artifacts are planned in TL1/TL2."
      }
    ],
    createdAt: now,
    updatedAt: now
  };
}
