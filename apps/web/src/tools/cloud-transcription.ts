import {
  createCloudTranscriptionRequest,
  type CloudTranscriptionLanguage,
  type CloudTranscriptionProgress,
  type CloudTranscriptionResult,
  type SourceAsset
} from "@lumio-by-aelivion/shared";
import {
  cancelAutoCaptionTranscriptionJob,
  getAutoCaptionTranscriptionJob,
  transcribeAutoCaptions,
  type AutoCaptionTranscriptionJob
} from "../lib/api";

type ProgressCallback = (progress: CloudTranscriptionProgress) => void;

export async function transcribeAssetWithCloudAdapter(input: {
  asset: SourceAsset;
  language: CloudTranscriptionLanguage;
  hintPrompt?: string | undefined;
  stylePresetId: string;
  highlightedWords: string;
  runId: string;
  onProgress?: ProgressCallback | undefined;
  isCancelled?: (() => boolean) | undefined;
}): Promise<CloudTranscriptionResult> {
  assertNotCancelled(input.isCancelled);
  const request = createCloudTranscriptionRequest({
    asset: input.asset,
    language: input.language,
    hintPrompt: input.hintPrompt,
    requireWordTimestamps: true,
    provider: "gemini"
  });

  input.onProgress?.({ status: "queued", progress: 5, message: "Queued Gemini transcription." });
  assertNotCancelled(input.isCancelled);

  const { job } = await transcribeAutoCaptions({
    assetId: input.asset.id,
    language: input.language,
    stylePresetId: input.stylePresetId,
    highlightedWords: input.highlightedWords,
    prompt: input.hintPrompt
  });

  let currentJob = job;
  while (currentJob.status === "queued" || currentJob.status === "processing") {
    if (input.isCancelled?.()) {
      await cancelAutoCaptionTranscriptionJob(currentJob.id).catch(() => undefined);
      assertNotCancelled(input.isCancelled);
    }
    input.onProgress?.({
      status: currentJob.status === "queued" ? "queued" : "transcribing",
      progress: currentJob.progress,
      message: currentJob.message
    });
    await sleep(1000);
    currentJob = await getAutoCaptionTranscriptionJob(currentJob.id);
  }

  assertNotCancelled(input.isCancelled);
  if (currentJob.status === "failed") {
    throw new Error(currentJob.errorMessage ?? currentJob.message);
  }
  if (currentJob.status === "cancelled") {
    throw new Error("Cloud transcription cancelled.");
  }
  const response = requireCompletedResult(currentJob);
  input.onProgress?.({ status: "completed", progress: 100, message: `Gemini transcript ready with ${response.transcript.segments.length} segments.` });

  return {
    request,
    transcript: response.transcript,
    captionTrack: response.captionTrack,
    artifacts: [
      {
        id: `${input.runId}_gemini_transcript`,
        type: "transcript",
        assetId: input.asset.id,
        metadata: {
          runId: input.runId,
          adapter: "cloud",
          provider: response.provider,
          model: response.model,
          transcript: response.transcript
        },
        preview: {
          durationSeconds: response.transcript.durationSeconds
        }
      },
      {
        id: `${input.runId}_gemini_caption_track`,
        type: "captionTrack",
        assetId: input.asset.id,
        metadata: {
          runId: input.runId,
          adapter: "cloud",
          provider: response.provider,
          model: response.model,
          captionTrack: response.captionTrack,
          captionInterchangeArtifact: response.captionInterchangeArtifact
        },
        preview: {
          durationSeconds: response.transcript.durationSeconds
        }
      }
    ],
    diagnostics: [
      `Gemini ${response.model} returned normalized transcript and caption artifacts.`,
      "No mock transcript was generated on the client."
    ]
  };
}

function requireCompletedResult(job: AutoCaptionTranscriptionJob) {
  if (!job.result) {
    throw new Error("Gemini transcription completed without a transcript result.");
  }
  return job.result;
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function assertNotCancelled(isCancelled?: () => boolean) {
  if (isCancelled?.()) {
    throw new Error("Cloud transcription cancelled.");
  }
}
