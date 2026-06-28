import type { SourceAsset, TranscriptArtifactData, TranscriptSegment, TranscriptWord } from "@reelforge/shared";

type ProgressCallback = (message: string) => void;

interface WhisperChunk {
  text?: string | undefined;
  timestamp?: [number | null, number | null] | undefined;
}

interface WhisperOutput {
  text?: string | undefined;
  chunks?: WhisperChunk[] | undefined;
}

type TransformersPipeline = (
  task: "automatic-speech-recognition",
  model: string,
  options?: Record<string, unknown>
) => Promise<(input: string, options?: Record<string, unknown>) => Promise<WhisperOutput>>;

let cachedTranscriber: Promise<(input: string, options?: Record<string, unknown>) => Promise<WhisperOutput>> | undefined;

const transformersUrls = [
  "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2",
  "https://esm.sh/@huggingface/transformers@3.7.2"
];

export async function transcribeAssetLocally(
  asset: SourceAsset,
  onProgress?: ProgressCallback,
  isCancelled?: () => boolean
): Promise<TranscriptArtifactData> {
  if (!asset.fileUrl) {
    throw new Error("Selected asset has no playable URL.");
  }

  assertNotCancelled(isCancelled);
  onProgress?.("Loading local speech model. First run can take a while.");
  const transcriber = await getTranscriber();
  assertNotCancelled(isCancelled);
  onProgress?.("Transcribing media locally. Keep this tab open.");
  const output = await transcriber(resolveTranscriptionUrl(asset.fileUrl), {
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: "word"
  });
  assertNotCancelled(isCancelled);
  const transcript = whisperOutputToTranscript(output, asset.durationSeconds);
  if (!transcript.segments.length) {
    throw new Error("Local transcription returned no words. Try audio-only input or paste transcript manually.");
  }
  onProgress?.(`Transcribed ${transcript.segments.length} caption segments locally.`);
  return transcript;
}

async function getTranscriber() {
  cachedTranscriber ??= loadTranscriber();
  return cachedTranscriber;
}

async function loadTranscriber() {
  const pipeline = await loadTransformersPipeline();
  return pipeline("automatic-speech-recognition", "Xenova/whisper-tiny.en", {
    progress_callback: (progress: { status?: string; file?: string; progress?: number }) => {
      if (progress.status === "progress" && typeof progress.progress === "number") {
        // The pipeline handles its own network fetches; UI progress is surfaced at a coarse level.
      }
    }
  });
}

async function loadTransformersPipeline(): Promise<TransformersPipeline> {
  let lastError: unknown;
  for (const url of transformersUrls) {
    try {
      const mod = (await import(/* @vite-ignore */ url)) as { pipeline?: TransformersPipeline | undefined };
      if (mod.pipeline) {
        return mod.pipeline;
      }
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`Unable to load the free local transcription runtime. ${lastError instanceof Error ? lastError.message : ""}`.trim());
}

function whisperOutputToTranscript(output: WhisperOutput, fallbackDuration: number): TranscriptArtifactData {
  const wordChunks = (output.chunks ?? []).filter((chunk) => chunk.text?.trim());
  const words: TranscriptWord[] = wordChunks.length
    ? wordChunks.map((chunk, index) => {
        const startSeconds = cleanTimestamp(chunk.timestamp?.[0], index * 0.42);
        const endSeconds = cleanTimestamp(chunk.timestamp?.[1], startSeconds + 0.42);
        return {
          id: `local_word_${index + 1}`,
          text: chunk.text?.trim() ?? "",
          startSeconds,
          endSeconds: Math.max(startSeconds + 0.08, endSeconds),
          confidence: 0.72
        };
      })
    : estimateWords(output.text ?? "", fallbackDuration);

  const segments = groupWordsIntoSegments(words);
  return {
    durationSeconds: Math.max(fallbackDuration, segments.at(-1)?.endSeconds ?? 0),
    language: "english",
    segments,
    source: "browser"
  };
}

function groupWordsIntoSegments(words: TranscriptWord[]): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  let current: TranscriptWord[] = [];

  for (const word of words) {
    current.push(word);
    const text = current.map((item) => item.text).join(" ");
    const shouldBreak = current.length >= 6 || /[.!?]$/.test(word.text) || text.length > 42;
    if (shouldBreak) {
      segments.push(createSegment(current, segments.length));
      current = [];
    }
  }

  if (current.length) {
    segments.push(createSegment(current, segments.length));
  }

  return segments;
}

function createSegment(words: TranscriptWord[], index: number): TranscriptSegment {
  return {
    id: `local_segment_${index + 1}`,
    text: words.map((word) => word.text).join(" ").replace(/\s+/g, " ").trim(),
    startSeconds: words[0]?.startSeconds ?? index * 2,
    endSeconds: words.at(-1)?.endSeconds ?? index * 2 + 1.6,
    words,
    confidence: 0.72
  };
}

function estimateWords(text: string, durationSeconds: number): TranscriptWord[] {
  const rawWords = text.split(/\s+/).map((word) => word.trim()).filter(Boolean);
  const safeDuration = Math.max(durationSeconds || rawWords.length * 0.42, rawWords.length * 0.28, 1);
  return rawWords.map((word, index) => {
    const startSeconds = (safeDuration * index) / Math.max(1, rawWords.length);
    const endSeconds = (safeDuration * (index + 1)) / Math.max(1, rawWords.length);
    return {
      id: `local_word_${index + 1}`,
      text: word,
      startSeconds,
      endSeconds,
      confidence: 0.58
    };
  });
}

function cleanTimestamp(value: number | null | undefined, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : fallback;
}

function resolveTranscriptionUrl(url: string) {
  if (url.startsWith("blob:") || url.startsWith("http://") || url.startsWith("https://")) {
    return url;
  }
  return new URL(url, window.location.origin).toString();
}

function assertNotCancelled(isCancelled?: () => boolean) {
  if (isCancelled?.()) {
    throw new Error("Local transcription cancelled.");
  }
}
