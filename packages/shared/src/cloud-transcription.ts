import type { SourceAsset, ToolArtifact } from "./types";
import type { CaptionTrackData, TranscriptArtifactData } from "./captions";
import { createCaptionInterchangeArtifact, createCaptionTrack } from "./captions";

export type CloudTranscriptionLanguage = "auto" | "english" | "hindi" | "hinglish";
export type CloudTranscriptionStatus = "queued" | "uploading" | "transcribing" | "aligning" | "completed" | "failed" | "cancelled";

export interface CloudTranscriptionRequest {
  id: string;
  asset: Pick<SourceAsset, "id" | "fileName" | "fileType" | "durationSeconds" | "fileUrl">;
  language: CloudTranscriptionLanguage;
  hintPrompt?: string | undefined;
  requireWordTimestamps: boolean;
  provider: string;
  createdAt: string;
}

export interface CloudTranscriptionProgress {
  status: CloudTranscriptionStatus;
  progress: number;
  message: string;
  retryable?: boolean | undefined;
}

export interface CloudTranscriptionResult {
  request: CloudTranscriptionRequest;
  transcript: TranscriptArtifactData;
  captionTrack: CaptionTrackData;
  artifacts: ToolArtifact[];
  diagnostics: string[];
}

export interface CloudTranscriptionProvider {
  id: string;
  label: string;
  supportsWordTimestamps: boolean;
  supportsLanguages: CloudTranscriptionLanguage[];
  submit: (request: CloudTranscriptionRequest) => Promise<{ jobId: string }>;
  poll: (jobId: string) => Promise<CloudTranscriptionProgress>;
  fetchResult: (jobId: string, request: CloudTranscriptionRequest, stylePresetId: string, highlightedWords: string) => Promise<CloudTranscriptionResult>;
}

export function createCloudTranscriptionRequest(input: {
  asset: CloudTranscriptionRequest["asset"];
  language: CloudTranscriptionLanguage;
  hintPrompt?: string | undefined;
  requireWordTimestamps?: boolean | undefined;
  provider?: string | undefined;
}): CloudTranscriptionRequest {
  return {
    id: `cloud_transcription_${Date.now()}`,
    asset: input.asset,
    language: input.language,
    hintPrompt: input.hintPrompt,
    requireWordTimestamps: input.requireWordTimestamps ?? true,
    provider: input.provider ?? "contract",
    createdAt: new Date().toISOString()
  };
}

export function createCloudTranscriptResult(input: {
  request: CloudTranscriptionRequest;
  transcript: TranscriptArtifactData;
  stylePresetId: string;
  highlightedWords: string;
  runId: string;
}): CloudTranscriptionResult {
  const captionTrack = createCaptionTrack(input.transcript, input.stylePresetId, input.highlightedWords);
  const interchangeArtifact = createCaptionInterchangeArtifact({
    transcript: input.transcript,
    captionTrack,
    stylePresetId: input.stylePresetId
  });
  return {
    request: input.request,
    transcript: input.transcript,
    captionTrack,
    artifacts: [
      {
        id: `${input.runId}_cloud_transcript`,
        type: "transcript",
        assetId: input.request.asset.id,
        metadata: {
          runId: input.runId,
          adapter: "cloud",
          provider: input.request.provider,
          sourceAssetId: input.request.asset.id,
          language: input.request.language,
          wordTimestamps: input.request.requireWordTimestamps,
          transcript: input.transcript
        },
        preview: {
          durationSeconds: input.transcript.durationSeconds
        }
      },
      {
        id: `${input.runId}_cloud_caption_track`,
        type: "captionTrack",
        assetId: input.request.asset.id,
        metadata: {
          runId: input.runId,
          adapter: "cloud",
          provider: input.request.provider,
          sourceAssetId: input.request.asset.id,
          captionTrack,
          interchangeArtifact
        },
        preview: {
          durationSeconds: input.transcript.durationSeconds
        }
      }
    ],
    diagnostics: [
      "Provider-neutral transcription result normalized into transcript and caption track artifacts.",
      input.request.requireWordTimestamps
        ? "Word timestamps requested and represented when available."
        : "Segment timestamps requested without word-level alignment."
    ]
  };
}

export function createMockCloudTranscript(request: CloudTranscriptionRequest): TranscriptArtifactData {
  const durationSeconds = Math.max(1, request.asset.durationSeconds || 12);
  const sample =
    request.language === "hindi"
      ? ["Yeh part dekho", "Ab proof samjho", "Isko save kar lo"]
      : request.language === "hinglish"
        ? ["Wait ye part dekho", "Ab proof samjho", "Save this before you forget"]
        : ["Wait for this part", "Here is the proof", "Save this before you forget"];
  const segmentDuration = Math.max(1.2, Math.min(2.6, durationSeconds / sample.length));
  const segments = sample.map((text, index) => {
    const startSeconds = Number(Math.min(durationSeconds - 0.2, index * segmentDuration).toFixed(3));
    const endSeconds = Number(Math.min(durationSeconds, Math.max(startSeconds + 0.6, startSeconds + segmentDuration * 0.86)).toFixed(3));
    const words = text.split(/\s+/).filter(Boolean);
    return {
      id: `cloud_segment_${index + 1}`,
      text,
      startSeconds,
      endSeconds,
      confidence: 0.88,
      words: words.map((word, wordIndex) => {
        const wordStart = startSeconds + ((endSeconds - startSeconds) * wordIndex) / Math.max(1, words.length);
        const wordEnd = startSeconds + ((endSeconds - startSeconds) * (wordIndex + 1)) / Math.max(1, words.length);
        return {
          id: `cloud_segment_${index + 1}_word_${wordIndex + 1}`,
          text: word,
          startSeconds: Number(wordStart.toFixed(3)),
          endSeconds: Number(wordEnd.toFixed(3)),
          confidence: 0.86
        };
      })
    };
  });

  return {
    durationSeconds,
    language: request.language === "auto" ? "auto" : request.language,
    source: "cloud",
    segments
  };
}
