import type { TextRun, TimelineComposition, TimelineLayer } from "./types";

export interface TranscriptWord {
  id: string;
  text: string;
  startSeconds: number;
  endSeconds: number;
  confidence?: number | undefined;
}

export interface TranscriptSegment {
  id: string;
  text: string;
  startSeconds: number;
  endSeconds: number;
  words: TranscriptWord[];
  confidence?: number | undefined;
}

export interface TranscriptArtifactData {
  language?: string | undefined;
  durationSeconds: number;
  segments: TranscriptSegment[];
  source: "manual" | "srt" | "vtt" | "mock" | "browser" | "cloud";
}

export interface CaptionStylePreset {
  id: string;
  name: string;
  description: string;
  color: string;
  strokeColor: string;
  strokeWidth: number;
  fontSize: number;
  fontFamily: string;
  positionY: number;
  highlightColor: string;
  backgroundColor?: string | undefined;
}

export type CaptionEmphasisMode = "none" | "pop-word" | "zoom-phrase" | "shake-warning";

export interface CaptionSegmentStyleOverride {
  stylePresetId?: string | undefined;
  color?: string | undefined;
  highlightColor?: string | undefined;
  strokeColor?: string | undefined;
  strokeWidth?: number | undefined;
  backgroundColor?: string | undefined;
  backgroundPaddingEm?: number | undefined;
  fontSize?: number | undefined;
  fontFamily?: string | undefined;
  positionX?: number | undefined;
  positionY?: number | undefined;
  textWidthPercent?: number | undefined;
  emphasis?: CaptionEmphasisMode | undefined;
  highlightBold?: boolean | undefined;
  highlightItalic?: boolean | undefined;
  highlightFontSizeMultiplier?: number | undefined;
  highlightFontFamily?: string | undefined;
}

export interface CaptionTrackData {
  id: string;
  transcriptId: string;
  stylePresetId: string;
  segments: TranscriptSegment[];
  highlightedWords: string[];
  segmentStyleOverrides?: Record<string, CaptionSegmentStyleOverride> | undefined;
}

export interface CaptionInterchangeArtifact {
  kind: "orreris.caption-artifact";
  version: 1;
  transcript: TranscriptArtifactData;
  captionTrack: CaptionTrackData;
  style: {
    presetId: string;
    highlightedWords: string[];
    segmentStyleOverrides?: Record<string, CaptionSegmentStyleOverride> | undefined;
  };
  exportedAt: string;
}

export interface TranscriptValidationIssue {
  level: "warning" | "error";
  code: string;
  message: string;
  segmentId?: string | undefined;
}

export const captionStylePresets: CaptionStylePreset[] = [
  {
    id: "minimal",
    name: "Minimal",
    description: "Clean white captions. No stroke, no motion — the safe default.",
    color: "#FFFFFF",
    strokeColor: "#000000",
    strokeWidth: 0,
    fontSize: 52,
    fontFamily: "Arial, Helvetica, sans-serif",
    positionY: 82,
    highlightColor: "#4D9FFF"
  },
  {
    id: "subtitle",
    name: "Subtitle",
    description: "Readable broadcast-style lower-third captions.",
    color: "#F4F4F5",
    strokeColor: "#000000",
    strokeWidth: 2,
    fontSize: 48,
    fontFamily: "Arial, Helvetica, sans-serif",
    positionY: 86,
    highlightColor: "#4D9FFF"
  },
  {
    id: "bold-center",
    name: "Bold Center",
    description: "Large hook captions centered over the subject.",
    color: "#FFFFFF",
    strokeColor: "#000000",
    strokeWidth: 6,
    fontSize: 80,
    fontFamily: "Arial, Helvetica, sans-serif",
    positionY: 70,
    highlightColor: "#FFD23F"
  },
  {
    id: "bold-outline",
    name: "Bold Outline",
    description: "Thick outline, no fill — high-engagement creator style.",
    color: "#FFFFFF",
    strokeColor: "#000000",
    strokeWidth: 9,
    fontSize: 76,
    fontFamily: "Arial, Helvetica, sans-serif",
    positionY: 74,
    highlightColor: "#FFD23F"
  },
  {
    id: "karaoke",
    name: "Karaoke",
    description: "Short bursts built for word-by-word highlighting.",
    color: "#FFFFFF",
    strokeColor: "#000000",
    strokeWidth: 4,
    fontSize: 66,
    fontFamily: "Arial, Helvetica, sans-serif",
    positionY: 76,
    highlightColor: "#4D9FFF"
  },
  {
    id: "boxed",
    name: "Boxed",
    description: "Caption pill for busy or bright footage.",
    color: "#FFFFFF",
    strokeColor: "#000000",
    strokeWidth: 0,
    fontSize: 46,
    fontFamily: "Arial, Helvetica, sans-serif",
    positionY: 86,
    highlightColor: "#FFD23F",
    backgroundColor: "#16161A"
  }
];

export const mockTranscriptText = `1
00:00:00,200 --> 00:00:01,700
Wait, this part is important

2
00:00:01,800 --> 00:00:03,200
Here is the proof

3
00:00:03,300 --> 00:00:05,000
Save this before you forget`;

export function parseTranscriptInput(input: string): TranscriptArtifactData {
  const trimmed = input.trim();
  if (!trimmed) {
    return {
      durationSeconds: 0,
      segments: [],
      source: "manual"
    };
  }

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const parsed = parseTranscriptJson(trimmed);
    if (parsed) {
      return parsed;
    }
  }

  if (trimmed.includes("-->")) {
    return parseTimedCaptionText(trimmed);
  }

  const sentences = trimmed
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const segments = sentences.map((text, index) => {
    const startSeconds = index * 2;
    const endSeconds = startSeconds + Math.max(1.4, Math.min(3.4, text.split(/\s+/).length * 0.42));
    return createTranscriptSegment(`manual_${index + 1}`, text, startSeconds, endSeconds);
  });

  return {
    durationSeconds: segments.at(-1)?.endSeconds ?? 0,
    segments,
    source: "manual"
  };
}

export function createAutoCaptionPrompt(input: {
  assetName?: string | undefined;
  durationSeconds?: number | undefined;
  language?: string | undefined;
  styleGoal?: string | undefined;
  highlightedWords?: string | undefined;
}): string {
  const duration = input.durationSeconds ? `${input.durationSeconds.toFixed(2)} seconds` : "the full media duration";
  return `You are creating short-form video captions for Orreris.

Return ONLY valid JSON. Do not include markdown.

Media:
- Name: ${input.assetName ?? "uploaded media"}
- Duration: ${duration}
- Language: ${input.language ?? "auto-detect, Hinglish/Hindi/English friendly"}
- Caption style goal: ${input.styleGoal ?? "punchy creator captions, short readable segments"}
- Highlight these words if present: ${input.highlightedWords ?? "important hook words"}

Rules:
- Use 1-8 words per caption segment.
- Keep each segment readable on a phone screen.
- Avoid overlapping timestamps.
- Cover the full important spoken content.
- If exact timing is unknown, estimate timings evenly across the media duration.

JSON schema:
{
  "language": "english | hindi | hinglish | unknown",
  "durationSeconds": number,
  "source": "manual",
  "segments": [
    {
      "id": "seg_1",
      "text": "caption text",
      "startSeconds": 0,
      "endSeconds": 1.6,
      "confidence": 0.8,
      "words": [
        {
          "id": "seg_1_word_1",
          "text": "caption",
          "startSeconds": 0,
          "endSeconds": 0.4,
          "confidence": 0.8
        }
      ]
    }
  ]
}`;
}

export function validateTranscriptArtifact(transcript: TranscriptArtifactData): TranscriptValidationIssue[] {
  const issues: TranscriptValidationIssue[] = [];
  if (!transcript.segments.length) {
    issues.push({
      level: "error",
      code: "NO_SEGMENTS",
      message: "No caption segments were found."
    });
    return issues;
  }

  transcript.segments.forEach((segment, index) => {
    if (!segment.text.trim()) {
      issues.push({
        level: "error",
        code: "EMPTY_SEGMENT",
        message: "Caption segment has no text.",
        segmentId: segment.id
      });
    }

    if (segment.endSeconds <= segment.startSeconds) {
      issues.push({
        level: "error",
        code: "INVALID_TIMING",
        message: "Caption end time must be after start time.",
        segmentId: segment.id
      });
    }

    if (segment.text.split(/\s+/).filter(Boolean).length > 12) {
      issues.push({
        level: "warning",
        code: "LONG_CAPTION",
        message: "Caption is long for short-form mobile viewing.",
        segmentId: segment.id
      });
    }

    const wordsPerSecond = segment.text.split(/\s+/).filter(Boolean).length / Math.max(0.1, segment.endSeconds - segment.startSeconds);
    if (wordsPerSecond > 4.2) {
      issues.push({
        level: "warning",
        code: "READING_SPEED_FAST",
        message: "Caption may be too fast to read comfortably.",
        segmentId: segment.id
      });
    }

    const previous = transcript.segments[index - 1];
    if (previous && segment.startSeconds < previous.endSeconds) {
      issues.push({
        level: "warning",
        code: "OVERLAP",
        message: "Caption overlaps the previous segment.",
        segmentId: segment.id
      });
    }
  });

  if (transcript.durationSeconds > 0 && transcript.segments.at(-1) && transcript.segments.at(-1)!.endSeconds > transcript.durationSeconds + 1) {
    issues.push({
      level: "warning",
      code: "BEYOND_DURATION",
      message: "Caption timing extends beyond the source media duration."
    });
  }

  return issues;
}

export function createCaptionInterchangeArtifact(input: {
  transcript: TranscriptArtifactData;
  captionTrack: CaptionTrackData;
  stylePresetId: string;
}): CaptionInterchangeArtifact {
  return {
    kind: "orreris.caption-artifact",
    version: 1,
    transcript: input.transcript,
    captionTrack: input.captionTrack,
    style: {
      presetId: input.stylePresetId,
      highlightedWords: input.captionTrack.highlightedWords,
      segmentStyleOverrides: input.captionTrack.segmentStyleOverrides
    },
    exportedAt: new Date().toISOString()
  };
}

export function parseCaptionInterchangeArtifact(input: string): CaptionInterchangeArtifact | undefined {
  try {
    const parsed = JSON.parse(input) as Partial<CaptionInterchangeArtifact>;
    if (parsed.kind !== "orreris.caption-artifact" || parsed.version !== 1 || !parsed.transcript || !parsed.captionTrack) {
      return undefined;
    }
    return parsed as CaptionInterchangeArtifact;
  } catch {
    return undefined;
  }
}

export function exportTranscriptToSrt(transcript: TranscriptArtifactData): string {
  return transcript.segments
    .map((segment, index) => `${index + 1}\n${formatSrtTimestamp(segment.startSeconds)} --> ${formatSrtTimestamp(segment.endSeconds)}\n${segment.text}`)
    .join("\n\n");
}

export function exportTranscriptToVtt(transcript: TranscriptArtifactData): string {
  return `WEBVTT\n\n${transcript.segments
    .map((segment) => `${formatVttTimestamp(segment.startSeconds)} --> ${formatVttTimestamp(segment.endSeconds)}\n${segment.text}`)
    .join("\n\n")}`;
}

export function createCaptionTrack(
  transcript: TranscriptArtifactData,
  stylePresetId: string,
  highlightedWordsInput: string,
  segmentStyleOverrides?: Record<string, CaptionSegmentStyleOverride>
): CaptionTrackData {
  return {
    id: `caption_track_${Date.now()}`,
    transcriptId: `transcript_${Date.now()}`,
    stylePresetId,
    segments: transcript.segments,
    highlightedWords: highlightedWordsInput
      .split(",")
      .map((word) => word.trim().toLowerCase())
      .filter(Boolean),
    segmentStyleOverrides
  };
}

export function applyCaptionTrackToComposition(
  composition: TimelineComposition,
  captionTrack: CaptionTrackData,
  stylePreset: CaptionStylePreset
): TimelineComposition {
  const captionTrackId = `${composition.id}_track_captions`;
  const captionLayers = captionTrack.segments.map((segment, index) =>
    createCaptionLayer(captionTrackId, segment, stylePreset, captionTrack.highlightedWords, index, captionTrack.segmentStyleOverrides?.[segment.id])
  );
  const nextDuration = Math.max(composition.durationSeconds, ...captionLayers.map((layer) => layer.startSeconds + layer.durationSeconds));
  const existingTrack = composition.tracks.find((track) => track.id === captionTrackId);

  return {
    ...composition,
    durationSeconds: nextDuration,
    tracks: existingTrack
      ? composition.tracks.map((track) =>
          track.id === captionTrackId
            ? {
                ...track,
                layers: captionLayers
              }
            : track
        )
      : [
          {
            id: captionTrackId,
            type: "video",
            name: "Captions",
            layers: captionLayers
          },
          ...composition.tracks
        ]
  };
}

function parseTimedCaptionText(input: string): TranscriptArtifactData {
  const blocks = input
    .replace(/^WEBVTT[^\n]*\n/i, "")
    .split(/\n\s*\n/g)
    .map((block) => block.trim())
    .filter(Boolean);
  const segments: TranscriptSegment[] = [];

  for (const [index, block] of blocks.entries()) {
    const lines = block.split(/\n/g).map((line) => line.trim()).filter(Boolean);
    const timeLineIndex = lines.findIndex((line) => line.includes("-->"));
    if (timeLineIndex < 0) {
      continue;
    }

    const [startRaw, endRaw] = lines[timeLineIndex]!.split("-->").map((value) => value.trim());
    const startSeconds = parseTimestamp(startRaw ?? "0");
    const endSeconds = parseTimestamp((endRaw ?? "0").split(/\s+/)[0] ?? "0");
    const text = lines.slice(timeLineIndex + 1).join(" ").replace(/<[^>]+>/g, "").trim();
    if (!text) {
      continue;
    }

    segments.push(createTranscriptSegment(`caption_${index + 1}`, text, startSeconds, Math.max(startSeconds + 0.2, endSeconds)));
  }

  return {
    durationSeconds: segments.at(-1)?.endSeconds ?? 0,
    segments,
    source: input.trim().toUpperCase().startsWith("WEBVTT") ? "vtt" : "srt"
  };
}

function parseTranscriptJson(input: string): TranscriptArtifactData | undefined {
  try {
    const parsed = JSON.parse(input) as Partial<TranscriptArtifactData> | TranscriptSegment[];
    const rawSegments = Array.isArray(parsed) ? parsed : parsed.segments;
    if (!Array.isArray(rawSegments)) {
      return undefined;
    }

    const segments = rawSegments
      .map((segment, index) => normalizeTranscriptSegment(segment as Partial<TranscriptSegment>, index))
      .filter((segment): segment is TranscriptSegment => Boolean(segment));
    if (!segments.length) {
      return undefined;
    }

    return {
      language: Array.isArray(parsed) ? undefined : parsed.language,
      durationSeconds: Array.isArray(parsed) ? segments.at(-1)?.endSeconds ?? 0 : Number(parsed.durationSeconds ?? segments.at(-1)?.endSeconds ?? 0),
      segments,
      source: "manual"
    };
  } catch {
    return undefined;
  }
}

function normalizeTranscriptSegment(segment: Partial<TranscriptSegment>, index: number): TranscriptSegment | undefined {
  const text = String(segment.text ?? "").trim();
  const startSeconds = Number(segment.startSeconds);
  const endSeconds = Number(segment.endSeconds);
  if (!text || !Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)) {
    return undefined;
  }

  const id = segment.id ?? `json_${index + 1}`;
  const normalized = createTranscriptSegment(id, text, startSeconds, Math.max(startSeconds + 0.2, endSeconds));
  if (Array.isArray(segment.words) && segment.words.length) {
    return {
      ...normalized,
      words: segment.words.map((word, wordIndex) => ({
        id: word.id ?? `${id}_word_${wordIndex + 1}`,
        text: String(word.text ?? "").trim(),
        startSeconds: Number(word.startSeconds ?? normalized.startSeconds),
        endSeconds: Number(word.endSeconds ?? normalized.endSeconds),
        confidence: typeof word.confidence === "number" ? word.confidence : undefined
      })).filter((word) => word.text && Number.isFinite(word.startSeconds) && Number.isFinite(word.endSeconds))
    };
  }
  return normalized;
}

function createTranscriptSegment(id: string, text: string, startSeconds: number, endSeconds: number): TranscriptSegment {
  const words = text.split(/\s+/).filter(Boolean);
  const duration = Math.max(0.2, endSeconds - startSeconds);
  return {
    id,
    text,
    startSeconds,
    endSeconds,
    words: words.map((word, index) => {
      const wordStart = startSeconds + (duration * index) / Math.max(1, words.length);
      const wordEnd = startSeconds + (duration * (index + 1)) / Math.max(1, words.length);
      return {
        id: `${id}_word_${index + 1}`,
        text: word,
        startSeconds: wordStart,
        endSeconds: wordEnd,
        confidence: 0.92
      };
    }),
    confidence: 0.9
  };
}

function createCaptionLayer(
  trackId: string,
  segment: TranscriptSegment,
  preset: CaptionStylePreset,
  highlightedWords: string[],
  index: number,
  override?: CaptionSegmentStyleOverride | undefined
): TimelineLayer {
  const presetOverride = override?.stylePresetId ? captionStylePresets.find((item) => item.id === override.stylePresetId) : undefined;
  const resolvedPreset = presetOverride ?? preset;
  const resolvedColor = override?.color ?? resolvedPreset.color;
  const resolvedFontSize = override?.fontSize ?? resolvedPreset.fontSize;
  const resolvedFontFamily = override?.fontFamily ?? resolvedPreset.fontFamily;
  const resolvedStrokeColor = override?.strokeColor ?? resolvedPreset.strokeColor;
  const resolvedStrokeWidth = override?.strokeWidth ?? resolvedPreset.strokeWidth;
  const resolvedBackgroundColor = override?.backgroundColor ?? resolvedPreset.backgroundColor;
  const resolvedBackgroundPadding = override?.backgroundPaddingEm;
  const resolvedPositionX = override?.positionX ?? 50;
  const resolvedPositionY = override?.positionY ?? resolvedPreset.positionY;
  const resolvedTextWidth = override?.textWidthPercent ?? 0;
  const resolvedHighlightColor = override?.highlightColor ?? resolvedPreset.highlightColor;
  const text = segment.text;
  const textRuns = buildCaptionTextRuns(text, highlightedWords, {
    color: resolvedHighlightColor,
    bold: override?.highlightBold ?? true,
    italic: override?.highlightItalic ?? false,
    fontSizeMultiplier: override?.highlightFontSizeMultiplier ?? 1,
    fontFamily: override?.highlightFontFamily
  });
  const animations = createCaptionAnimations(trackId, index, override?.emphasis ?? "none");
  return {
    id: `${trackId}_layer_${index + 1}`,
    trackId,
    type: "text",
    name: `Caption ${index + 1}`,
    text,
    textRuns,
    startSeconds: segment.startSeconds,
    durationSeconds: Math.max(0.2, segment.endSeconds - segment.startSeconds),
    fontFamily: resolvedFontFamily,
    fontSize: resolvedFontSize,
    textWidthPercent: resolvedTextWidth,
    textAlign: "center",
    color: resolvedColor,
    strokeColor: resolvedStrokeColor,
    strokeWidth: resolvedStrokeWidth,
    backgroundColor: resolvedBackgroundColor,
    backgroundPaddingEm: resolvedBackgroundPadding,
    shadowColor: "#000000",
    shadowBlur: resolvedPreset.backgroundColor ? 0 : 16,
    shadowOffsetX: 0,
    shadowOffsetY: resolvedPreset.backgroundColor ? 0 : 5,
    transform: {
      position: { x: resolvedPositionX, y: resolvedPositionY },
      scale: 1,
      rotation: 0,
      opacity: 100
    },
    effects: [
      {
        id: `${trackId}_caption_shadow_${index + 1}`,
        type: "shadow",
        name: "Caption readability",
        enabled: true,
        intensity: resolvedPreset.backgroundColor ? 28 : 52,
        params: {
          color: "#000000",
          blur: resolvedPreset.backgroundColor ? 4 : 18,
          x: 0,
          y: resolvedPreset.backgroundColor ? 2 : 6
        }
      }
    ],
    keyframes: [],
    animations
  };
}

function createCaptionAnimations(trackId: string, index: number, emphasis: CaptionEmphasisMode) {
  const prefix = `${trackId}_caption_${index + 1}`;
  const base = [
    {
      id: `${prefix}_scale_in`,
      target: {
        scope: "layer" as const,
        property: "transform.scale"
      },
      timeSeconds: 0,
      value: 0.94,
      interpolation: "easeOut" as const,
      temporal: {}
    },
    {
      id: `${prefix}_scale_hold`,
      target: {
        scope: "layer" as const,
        property: "transform.scale"
      },
      timeSeconds: 0.16,
      value: 1,
      interpolation: "easeOut" as const,
      temporal: {}
    }
  ];

  if (emphasis === "zoom-phrase") {
    return [
      ...base,
      {
        id: `${prefix}_zoom_peak`,
        target: { scope: "layer" as const, property: "transform.scale" },
        timeSeconds: 0.42,
        value: 1.07,
        interpolation: "easeOut" as const,
        temporal: {}
      },
      {
        id: `${prefix}_zoom_settle`,
        target: { scope: "layer" as const, property: "transform.scale" },
        timeSeconds: 0.74,
        value: 1,
        interpolation: "easeOut" as const,
        temporal: {}
      }
    ];
  }

  if (emphasis === "shake-warning") {
    return [
      ...base,
      {
        id: `${prefix}_shake_left`,
        target: { scope: "layer" as const, property: "transform.rotation" },
        timeSeconds: 0.18,
        value: -2,
        interpolation: "linear" as const,
        temporal: {}
      },
      {
        id: `${prefix}_shake_right`,
        target: { scope: "layer" as const, property: "transform.rotation" },
        timeSeconds: 0.3,
        value: 2,
        interpolation: "linear" as const,
        temporal: {}
      },
      {
        id: `${prefix}_shake_reset`,
        target: { scope: "layer" as const, property: "transform.rotation" },
        timeSeconds: 0.44,
        value: 0,
        interpolation: "easeOut" as const,
        temporal: {}
      }
    ];
  }

  if (emphasis === "none") {
    return [];
  }

  return base;
}

export interface CaptionHighlightRunStyle {
  color?: string | undefined;
  bold?: boolean | undefined;
  italic?: boolean | undefined;
  fontSizeMultiplier?: number | undefined;
  fontFamily?: string | undefined;
}

export function buildCaptionTextRuns(text: string, highlightedWords: string[], highlightStyle: CaptionHighlightRunStyle): TextRun[] {
  if (!highlightedWords.length) {
    return [{ text }];
  }

  const tokens = text.split(/(\s+)/).filter((token) => token.length > 0);
  return tokens.map((token) => {
    const normalized = token.toLowerCase().replace(/[^a-z0-9]/g, "");
    const isHighlighted = normalized.length > 0 && highlightedWords.includes(normalized);
    return isHighlighted
      ? {
          text: token,
          color: highlightStyle.color,
          bold: highlightStyle.bold,
          italic: highlightStyle.italic,
          fontSizeMultiplier: highlightStyle.fontSizeMultiplier,
          fontFamily: highlightStyle.fontFamily
        }
      : { text: token };
  });
}

function parseTimestamp(value: string) {
  const normalized = value.replace(",", ".");
  const parts = normalized.split(":").map(Number);
  if (parts.length === 3) {
    const [hours = 0, minutes = 0, seconds = 0] = parts;
    return hours * 3600 + minutes * 60 + seconds;
  }
  if (parts.length === 2) {
    const [minutes = 0, seconds = 0] = parts;
    return minutes * 60 + seconds;
  }
  return Number(normalized) || 0;
}

function formatSrtTimestamp(seconds: number) {
  const { hours, minutes, wholeSeconds, milliseconds } = splitTimestamp(seconds);
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(wholeSeconds)},${String(milliseconds).padStart(3, "0")}`;
}

function formatVttTimestamp(seconds: number) {
  const { hours, minutes, wholeSeconds, milliseconds } = splitTimestamp(seconds);
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(wholeSeconds)}.${String(milliseconds).padStart(3, "0")}`;
}

function splitTimestamp(seconds: number) {
  const safeSeconds = Math.max(0, seconds);
  const totalMilliseconds = Math.round(safeSeconds * 1000);
  const hours = Math.floor(totalMilliseconds / 3600000);
  const minutes = Math.floor((totalMilliseconds % 3600000) / 60000);
  const wholeSeconds = Math.floor((totalMilliseconds % 60000) / 1000);
  const milliseconds = totalMilliseconds % 1000;
  return { hours, minutes, wholeSeconds, milliseconds };
}

function pad2(value: number) {
  return String(value).padStart(2, "0");
}
