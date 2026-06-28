import { captionStylePresets, createAutoCaptionPrompt, type TranscriptArtifactData } from "./captions";
import { createAiToolPlan, type AiToolPlan } from "./tool-adapters";
import { toolCapabilityDefinitions } from "./tools";
import type { SourceAsset, ToolAdapterType } from "./types";

export interface AutoCaptionAssistantPlan {
  plan: AiToolPlan;
  missingInputs: string[];
  suggestedStylePresetId: string;
  suggestedHighlightedWords: string[];
  suggestedLanguage: "auto" | "english" | "hindi" | "hinglish";
  confirmationSummary: string;
  externalPrompt: string;
}

export function createAutoCaptionAssistantPlan(input: {
  asset?: Pick<SourceAsset, "id" | "fileName" | "fileType" | "durationSeconds"> | undefined;
  transcript?: TranscriptArtifactData | undefined;
  userGoal?: string | undefined;
  preferredAdapter?: ToolAdapterType | undefined;
}): AutoCaptionAssistantPlan {
  const tool = toolCapabilityDefinitions.find((candidate) => candidate.slug === "auto-captions") ?? toolCapabilityDefinitions[0]!;
  const missingInputs = input.asset || input.transcript?.segments.length ? [] : ["Upload/select media or paste a transcript."];
  const suggestedLanguage = inferCaptionLanguage(input.userGoal, input.transcript?.language);
  const suggestedStylePresetId = inferCaptionStyle(input.userGoal);
  const suggestedHighlightedWords = inferHighlightedWords(input.userGoal, input.transcript);
  const adapter = input.preferredAdapter ?? (input.asset ? "cloud" : "mock");
  const prompt = createAutoCaptionPrompt({
    assetName: input.asset?.fileName,
    durationSeconds: input.asset?.durationSeconds ?? input.transcript?.durationSeconds,
    language: suggestedLanguage,
    highlightedWords: suggestedHighlightedWords.join(", "),
    styleGoal: captionStylePresets.find((preset) => preset.id === suggestedStylePresetId)?.name
  });

  return {
    plan: createAiToolPlan({
      tool,
      adapter,
      reason: missingInputs.length
        ? "Auto Captions needs source speech or a transcript before it can create editable caption layers."
        : "Auto Captions can turn this source into editable timed captions with style and highlighted words.",
      inputAssetIds: input.asset ? [input.asset.id] : [],
      params: {
        captionStyle: suggestedStylePresetId,
        highlightedWords: suggestedHighlightedWords,
        language: suggestedLanguage,
        prompt,
        requiresUserConfirmation: true
      }
    }),
    missingInputs,
    suggestedStylePresetId,
    suggestedHighlightedWords,
    suggestedLanguage,
    confirmationSummary: missingInputs.length
      ? missingInputs[0]!
      : `Create editable captions using ${adapter} transcription, ${suggestedLanguage} language mode, and ${suggestedHighlightedWords.length} highlighted words.`,
    externalPrompt: prompt
  };
}

function inferCaptionLanguage(goal: string | undefined, transcriptLanguage: string | undefined): AutoCaptionAssistantPlan["suggestedLanguage"] {
  const text = `${goal ?? ""} ${transcriptLanguage ?? ""}`.toLowerCase();
  if (text.includes("hinglish")) {
    return "hinglish";
  }
  if (text.includes("hindi") || text.includes("devanagari")) {
    return "hindi";
  }
  if (text.includes("english")) {
    return "english";
  }
  return "auto";
}

function inferCaptionStyle(goal: string | undefined) {
  const text = (goal ?? "").toLowerCase();
  if (text.includes("subtitle") || text.includes("clean") || text.includes("minimal")) {
    return "lower-third-clean";
  }
  if (text.includes("box") || text.includes("busy")) {
    return "boxed-subtitle";
  }
  if (text.includes("karaoke") || text.includes("word")) {
    return "karaoke-pop";
  }
  return "punchy-center";
}

function inferHighlightedWords(goal: string | undefined, transcript: TranscriptArtifactData | undefined) {
  const seed = ["wait", "proof", "save", "important"];
  const goalWords = (goal ?? "")
    .split(/[,\s]+/)
    .map((word) => normalizeWord(word))
    .filter((word) => word.length >= 4);
  const transcriptWords = (transcript?.segments ?? [])
    .flatMap((segment) => segment.text.split(/\s+/))
    .map((word) => normalizeWord(word))
    .filter((word) => word.length >= 4);
  return Array.from(new Set([...goalWords, ...transcriptWords, ...seed])).slice(0, 8);
}

function normalizeWord(word: string) {
  return word.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}
