import { promises as fs } from "node:fs";
import path from "node:path";
import {
  createCaptionInterchangeArtifact,
  createCaptionTrack,
  parseTranscriptInput,
  validateTranscriptArtifact,
  type CaptionTrackData,
  type SourceAsset,
  type TranscriptArtifactData
} from "@orreris/shared";
import { env } from "../config/env";
import { HttpError } from "../lib/http";
import { resolvePublicStoragePath } from "./storage.service";

type CaptionLanguage = "auto" | "english" | "hindi" | "hinglish";

interface GeminiFile {
  name: string;
  uri: string;
  mimeType?: string | undefined;
  state?: "PROCESSING" | "ACTIVE" | "FAILED" | string | undefined;
}

interface GeminiGenerateResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string | undefined }>;
    };
  }>;
}

export interface GeminiTranscriptionInput {
  asset: SourceAsset;
  language: CaptionLanguage;
  stylePresetId: string;
  highlightedWords: string;
  prompt?: string | undefined;
}

export interface GeminiTranscriptionOutput {
  transcript: TranscriptArtifactData;
  captionTrack: CaptionTrackData;
  captionInterchangeArtifact: ReturnType<typeof createCaptionInterchangeArtifact>;
  provider: "gemini";
  model: string;
}

export interface GeminiCaptionTransformInput {
  action: "repair" | "improve";
  transcriptText: string;
  language: CaptionLanguage;
  durationSeconds?: number | undefined;
  styleGoal?: string | undefined;
  highlightedWords?: string | undefined;
}

export async function transcribeWithGemini(input: GeminiTranscriptionInput): Promise<GeminiTranscriptionOutput> {
  if (!env.GEMINI_API_KEY) {
    throw new HttpError(501, "GEMINI_API_KEY is not configured. Add it to .env to enable real Gemini transcription.");
  }

  if (!input.asset.fileType.startsWith("audio/") && !input.asset.fileType.startsWith("video/")) {
    throw new HttpError(400, "Auto Captions transcription needs an audio or video asset.");
  }

  const filePath = resolvePublicStoragePath(input.asset.fileUrl);
  const file = await uploadGeminiFile(filePath, input.asset.fileName, input.asset.fileType);
  const readyFile = await waitForGeminiFile(file);
  const transcript = await generateTranscript(readyFile, input);
  const issues = validateTranscriptArtifact(transcript).filter((issue) => issue.level === "error");
  if (issues.length) {
    throw new HttpError(502, `Gemini returned an invalid transcript: ${issues[0]?.message ?? "unknown validation error"}`);
  }

  const captionTrack = createCaptionTrack(transcript, input.stylePresetId, input.highlightedWords);
  return {
    transcript,
    captionTrack,
    captionInterchangeArtifact: createCaptionInterchangeArtifact({
      transcript,
      captionTrack,
      stylePresetId: input.stylePresetId
    }),
    provider: "gemini",
    model: env.GEMINI_TRANSCRIPTION_MODEL
  };
}

export async function transformCaptionsWithGemini(input: GeminiCaptionTransformInput): Promise<TranscriptArtifactData> {
  if (!env.GEMINI_API_KEY) {
    throw new HttpError(501, "GEMINI_API_KEY is not configured. Add it to .env to enable Gemini caption intelligence.");
  }
  if (!input.transcriptText.trim()) {
    throw new HttpError(400, "Add transcript text before using Gemini caption intelligence.");
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_TRANSCRIPTION_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              {
                text: buildCaptionTransformPrompt(input)
              }
            ]
          }
        ],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: input.action === "improve" ? 0.25 : 0.05
        }
      })
    }
  );

  if (!response.ok) {
    throw new HttpError(502, `Gemini caption intelligence failed: ${await readErrorText(response)}`);
  }

  const payload = (await response.json()) as GeminiGenerateResponse;
  const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
  if (!text) {
    throw new HttpError(502, "Gemini returned an empty caption intelligence response.");
  }

  const parsed = parseTranscriptInput(text);
  const issues = validateTranscriptArtifact(parsed).filter((issue) => issue.level === "error");
  if (issues.length) {
    throw new HttpError(502, `Gemini returned invalid captions: ${issues[0]?.message ?? "unknown validation error"}`);
  }

  return {
    ...parsed,
    source: "cloud",
    language: parsed.language ?? input.language,
    durationSeconds: Math.max(input.durationSeconds ?? 0, parsed.durationSeconds)
  };
}

export interface GeminiHighlightSuggestionInput {
  transcriptText: string;
  language: CaptionLanguage;
}

export async function suggestHighlightWordsWithGemini(input: GeminiHighlightSuggestionInput): Promise<string[]> {
  if (!env.GEMINI_API_KEY) {
    throw new HttpError(501, "GEMINI_API_KEY is not configured. Add it to .env to enable Gemini highlight suggestions.");
  }
  if (!input.transcriptText.trim()) {
    throw new HttpError(400, "Add transcript text before suggesting highlight words.");
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_TRANSCRIPTION_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              {
                text: buildHighlightSuggestionPrompt(input)
              }
            ]
          }
        ],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.2
        }
      })
    }
  );

  if (!response.ok) {
    throw new HttpError(502, `Gemini highlight suggestion failed: ${await readErrorText(response)}`);
  }

  const payload = (await response.json()) as GeminiGenerateResponse;
  const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
  if (!text) {
    throw new HttpError(502, "Gemini returned an empty highlight suggestion response.");
  }

  const words = parseHighlightWordsResponse(text);
  if (!words.length) {
    throw new HttpError(502, "Gemini did not return any highlight words.");
  }
  return words;
}

function buildHighlightSuggestionPrompt(input: GeminiHighlightSuggestionInput) {
  return `You are choosing words to visually highlight in short-form video captions.

Read the transcript below and pick the 5-10 most important words or short phrases (1-2 words each) that deserve visual emphasis: numbers/stats, surprising claims, emotional words, calls to action, brand/product names, or punchlines. Do not pick filler words.

Return ONLY valid JSON. Do not include markdown.

Required JSON shape:
{ "words": ["word1", "word2"] }

Language mode: ${input.language}.

Transcript:
${input.transcriptText}`;
}

function parseHighlightWordsResponse(text: string): string[] {
  try {
    const cleaned = text.trim().replace(/^```json\s*/i, "").replace(/```$/, "");
    const parsed = JSON.parse(cleaned) as { words?: unknown };
    if (!Array.isArray(parsed.words)) {
      return [];
    }
    return parsed.words
      .filter((word): word is string => typeof word === "string")
      .map((word) => word.trim())
      .filter(Boolean)
      .slice(0, 10);
  } catch {
    return [];
  }
}

async function uploadGeminiFile(filePath: string, displayName: string, mimeType: string): Promise<GeminiFile> {
  const stat = await fs.stat(filePath);
  const startResponse = await fetch(`https://generativelanguage.googleapis.com/upload/v1beta/files?key=${env.GEMINI_API_KEY}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(stat.size),
      "X-Goog-Upload-Header-Content-Type": mimeType
    },
    body: JSON.stringify({
      file: {
        display_name: displayName || path.basename(filePath)
      }
    })
  });

  if (!startResponse.ok) {
    throw new HttpError(502, `Gemini file upload start failed: ${await readErrorText(startResponse)}`);
  }

  const uploadUrl = startResponse.headers.get("x-goog-upload-url");
  if (!uploadUrl) {
    throw new HttpError(502, "Gemini file upload did not return an upload URL.");
  }

  const bytes = await fs.readFile(filePath);
  const uploadResponse = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Length": String(bytes.byteLength),
      "Content-Type": mimeType,
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize"
    },
    body: bytes
  });

  if (!uploadResponse.ok) {
    throw new HttpError(502, `Gemini file upload failed: ${await readErrorText(uploadResponse)}`);
  }

  const payload = (await uploadResponse.json()) as { file?: GeminiFile | undefined };
  if (!payload.file?.uri || !payload.file.name) {
    throw new HttpError(502, "Gemini file upload returned no usable file URI.");
  }
  return payload.file;
}

async function waitForGeminiFile(file: GeminiFile): Promise<GeminiFile> {
  let current = file;
  for (let attempt = 0; attempt < 90; attempt += 1) {
    if (!current.state || current.state === "ACTIVE") {
      return current;
    }
    if (current.state === "FAILED") {
      throw new HttpError(502, "Gemini could not process the uploaded media file.");
    }

    await sleep(1000);
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/${current.name}?key=${env.GEMINI_API_KEY}`);
    if (!response.ok) {
      throw new HttpError(502, `Gemini file polling failed: ${await readErrorText(response)}`);
    }
    current = readGeminiFilePayload(await response.json(), current);
  }

  throw new HttpError(504, "Timed out waiting for Gemini to process the media file.");
}

function readGeminiFilePayload(payload: unknown, fallback: GeminiFile): GeminiFile {
  if (isGeminiFile(payload)) {
    return payload;
  }
  if (payload && typeof payload === "object" && "file" in payload && isGeminiFile((payload as { file?: unknown }).file)) {
    return (payload as { file: GeminiFile }).file;
  }
  return fallback;
}

function isGeminiFile(value: unknown): value is GeminiFile {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as GeminiFile).name === "string" &&
      typeof (value as GeminiFile).uri === "string"
  );
}

async function generateTranscript(file: GeminiFile, input: GeminiTranscriptionInput): Promise<TranscriptArtifactData> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_TRANSCRIPTION_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              {
                file_data: {
                  mime_type: file.mimeType ?? input.asset.fileType,
                  file_uri: file.uri
                }
              },
              {
                text: buildTranscriptPrompt(input)
              }
            ]
          }
        ],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.1
        }
      })
    }
  );

  if (!response.ok) {
    throw new HttpError(502, `Gemini transcription failed: ${await readErrorText(response)}`);
  }

  const payload = (await response.json()) as GeminiGenerateResponse;
  const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
  if (!text) {
    throw new HttpError(502, "Gemini returned an empty transcription response.");
  }

  const parsed = parseTranscriptInput(text);
  return {
    ...parsed,
    source: "cloud",
    language: parsed.language ?? input.language,
    durationSeconds: Math.max(input.asset.durationSeconds, parsed.durationSeconds)
  };
}

function buildTranscriptPrompt(input: GeminiTranscriptionInput) {
  return `Transcribe this media for a short-form video editor.

Return ONLY valid JSON. Do not include markdown.

Required JSON shape:
{
  "language": "english|hindi|hinglish|auto",
  "durationSeconds": 12.34,
  "source": "cloud",
  "segments": [
    {
      "id": "seg_1",
      "text": "caption text",
      "startSeconds": 0.12,
      "endSeconds": 1.8,
      "confidence": 0.9,
      "words": [
        {
          "id": "seg_1_word_1",
          "text": "caption",
          "startSeconds": 0.12,
          "endSeconds": 0.42,
          "confidence": 0.9
        }
      ]
    }
  ]
}

Rules:
- Language mode: ${input.language}.
- Hinglish/Hindi friendly: preserve spoken Hindi/Hinglish words naturally; do not over-translate unless needed for readability.
- Segment captions into 1-8 words each.
- Include accurate segment timestamps and word timestamps.
- Avoid overlapping timestamps.
- Use seconds as numbers, not strings.
- Keep captions readable on mobile.
- Highlight target words if spoken: ${input.highlightedWords || "none"}.
- Style goal/context: ${input.prompt ?? "creator captions with strong hooks"}.
- Source duration hint: ${input.asset.durationSeconds.toFixed(2)} seconds.
`;
}

function buildCaptionTransformPrompt(input: GeminiCaptionTransformInput) {
  const actionInstructions =
    input.action === "repair"
      ? `Repair and normalize the pasted transcript into valid timed caption JSON.
- If timestamps exist, preserve them as closely as possible.
- If timestamps are missing, estimate readable timings across the duration hint.
- Fix malformed JSON/SRT/VTT/plain text without inventing unrelated content.`
      : `Improve these captions for short-form mobile viewing.
- Keep the meaning faithful.
- Prefer punchy 1-8 word segments.
- Preserve the original timing as much as possible.
- Shorten overly long captions.
- Improve readability, casing, and line rhythm.`;

  return `${actionInstructions}

Return ONLY valid JSON. Do not include markdown.

Required JSON shape:
{
  "language": "english|hindi|hinglish|auto",
  "durationSeconds": 12.34,
  "source": "cloud",
  "segments": [
    {
      "id": "seg_1",
      "text": "caption text",
      "startSeconds": 0.12,
      "endSeconds": 1.8,
      "confidence": 0.9,
      "words": [
        {
          "id": "seg_1_word_1",
          "text": "caption",
          "startSeconds": 0.12,
          "endSeconds": 0.42,
          "confidence": 0.9
        }
      ]
    }
  ]
}

Settings:
- Language mode: ${input.language}.
- Duration hint: ${input.durationSeconds ? `${input.durationSeconds.toFixed(2)} seconds` : "unknown"}.
- Style goal: ${input.styleGoal ?? "creator captions"}.
- Highlight target words if present: ${input.highlightedWords ?? "none"}.

Input transcript:
${input.transcriptText}`;
}

async function readErrorText(response: Response) {
  return (await response.text()).slice(0, 500);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
