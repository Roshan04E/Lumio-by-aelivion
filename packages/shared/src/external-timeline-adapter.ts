import type { BuiltInTransitionKind, ProjectGraph, TimelineComposition, TimelineKeyframeV2, TimelineLayer, TimelineTrack, TransitionSpec } from "./types";

export type ExternalTimelineFormat = "edl" | "fcpxml" | "xmeml" | "prproj";
export type TimelineImportReportSection = "imported" | "mapped" | "skipped" | "unsupported";

export interface TimelineImportReportItem {
  section: TimelineImportReportSection;
  code: string;
  message: string;
  sourceId?: string | undefined;
  targetId?: string | undefined;
}

export interface TimelineImportReport {
  format: ExternalTimelineFormat;
  fileName: string;
  title: string;
  fps: number;
  width: number;
  height: number;
  durationSeconds: number;
  counts: {
    clips: number;
    videoClips: number;
    audioClips: number;
    placeholders: number;
    transitionsMapped: number;
    skipped: number;
    unsupported: number;
  };
  imported: TimelineImportReportItem[];
  mapped: TimelineImportReportItem[];
  skipped: TimelineImportReportItem[];
  unsupported: TimelineImportReportItem[];
  /** Present when the source is a multi-sequence project (Task 2.3); lets a report modal offer a picker. */
  availableSequences?: TimelineImportSequenceOption[] | undefined;
}

export interface ImportedExternalTimeline {
  graph: ProjectGraph;
  composition: TimelineComposition;
  report: TimelineImportReport;
}

export interface ParseExternalTimelineInput {
  fileName: string;
  contents: string;
  projectId: string;
  projectTitle?: string | undefined;
  /** Force a specific `.prproj` sequence (from `report.availableSequences[].id`) instead of the "most clips" heuristic. */
  sequenceId?: string | undefined;
}

/** One candidate sequence in a multi-sequence project (Task 2.3) — lets a report modal offer a picker. */
export interface TimelineImportSequenceOption {
  id: string;
  name: string;
  clipCount: number;
  selected: boolean;
}

interface ParsedTimelineClip {
  id: string;
  name: string;
  type: "video" | "audio" | "text";
  trackIndex: number;
  startSeconds: number;
  durationSeconds: number;
  sourceInSeconds?: number | undefined;
  sourceName?: string | undefined;
  text?: string | undefined;
  nestedTimelineId?: string | undefined;
  transitionIn?: TransitionSpec | undefined;
  /** Title-layer style overrides (FCPXML `<title>`/`<text-style-def>`) — absent = the existing hardcoded defaults. */
  textStyle?:
    | {
        fontFamily?: string | undefined;
        fontSize?: number | undefined;
        fontWeight?: number | undefined;
        italic?: boolean | undefined;
        color?: string | undefined;
        textAlign?: "left" | "center" | "right" | undefined;
      }
    | undefined;
  /** Motion/opacity keyframes lifted from `<adjust-transform>`/`<adjust-opacity>` (layer-local seconds). */
  keyframes?: TimelineKeyframeV2[] | undefined;
}

interface ParsedTimeline {
  format: ExternalTimelineFormat;
  id?: string | undefined;
  title: string;
  width?: number | undefined;
  height?: number | undefined;
  fps?: number | undefined;
  clips: ParsedTimelineClip[];
  reportItems: TimelineImportReportItem[];
  nestedTimelines?: ParsedTimeline[] | undefined;
  /** Every candidate sequence found in a multi-sequence project (Task 2.3), for a report-modal picker. */
  availableSequences?: TimelineImportSequenceOption[] | undefined;
}

type XmlElement = Element | SimpleXmlElement;
type XmlRoot = Document | SimpleXmlElement;
type PrprojObjectIndex = Map<string, XmlElement>;

const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;
const DEFAULT_FPS = 30;
const PREMIERE_TICKS_PER_SECOND = 254_016_000_000;

export function isExternalTimelineFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return lower.endsWith(".edl") || lower.endsWith(".fcpxml") || lower.endsWith(".xml") || lower.endsWith(".prproj");
}

export function parseExternalTimelineFile(input: ParseExternalTimelineInput): ImportedExternalTimeline {
  const parsed = parseExternalTimeline(input.fileName, input.contents, { sequenceId: input.sequenceId });
  const composition = buildCompositionFromParsedTimeline({
    parsed,
    projectId: input.projectId,
    projectTitle: input.projectTitle ?? parsed.title
  });
  const report = buildTimelineImportReport(input.fileName, parsed, composition);
  const compositions = buildNestedCompositionsFromParsedTimeline({
    parsed,
    rootComposition: composition,
    projectId: input.projectId
  });
  const graph: ProjectGraph = {
    projectId: input.projectId,
    effects: [],
    editableFields: {},
    composition,
    ...(Object.keys(compositions).length ? { compositions } : {}),
    version: 1
  };
  return { graph, composition, report };
}

export function parseExternalTimeline(fileName: string, contents: string, options: { sequenceId?: string | undefined } = {}): ParsedTimeline {
  const lower = fileName.toLowerCase();
  const trimmed = contents.trim();
  if (lower.endsWith(".edl") || looksLikeEdl(trimmed)) {
    return parseEdl(trimmed, fileName);
  }
  if (lower.endsWith(".fcpxml") || /<fcpxml[\s>]/i.test(trimmed)) {
    return parseFcpxml(trimmed, fileName);
  }
  if (lower.endsWith(".prproj") || /<premieredata[\s>]/i.test(trimmed)) {
    return parsePrproj(trimmed, fileName, options.sequenceId);
  }
  if (lower.endsWith(".xml") || /<(xmeml|sequence)[\s>]/i.test(trimmed)) {
    return parseXmeml(trimmed, fileName);
  }
  throw new Error("Unsupported timeline file. Import .edl, .fcpxml, Final Cut/Premiere XML, or .prproj.");
}

function parseEdl(contents: string, fileName: string): ParsedTimeline {
  const lines = contents.replace(/\r/g, "").split("\n");
  const reportItems: TimelineImportReportItem[] = [
    reportItem("mapped", "edl.placeholder_media", "EDL carries media names/timecodes only. Lumio creates placeholder clips that can be relinked.")
  ];
  const titleLine = lines.find((line) => /^TITLE:/i.test(line));
  const title = titleLine?.replace(/^TITLE:\s*/i, "").trim() || stripExtension(fileName);
  const clips: ParsedTimelineClip[] = [];
  let pendingClip: ParsedTimelineClip | undefined;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("*")) {
      if (pendingClip) {
        const clipName = readEdlCommentValue(trimmed, ["FROM CLIP NAME", "SOURCE FILE", "LOC", "ASC_SOP"]);
        if (clipName && !/^ASC_/i.test(trimmed)) {
          pendingClip.sourceName = clipName;
          pendingClip.name = clipName;
        }
      }
      continue;
    }
    if (/^(TITLE|FCM):/i.test(trimmed)) {
      continue;
    }
    const parts = trimmed.split(/\s+/);
    if (parts.length < 8 || !/^\d+$/.test(parts[0] ?? "")) {
      reportItems.push(reportItem("skipped", "edl.unparsed_line", `Skipped EDL line: ${truncate(trimmed, 96)}`));
      continue;
    }

    const eventId = parts[0] ?? `${clips.length + 1}`;
    const reel = parts[1] ?? "AX";
    const trackToken = parts[2] ?? "V";
    const transitionCode = (parts[3] ?? "C").toUpperCase();
    const hasTransitionDuration = transitionCode !== "C" && parts.length >= 9;
    const sourceInToken = parts[hasTransitionDuration ? 5 : 4];
    const sourceOutToken = parts[hasTransitionDuration ? 6 : 5];
    const recordInToken = parts[hasTransitionDuration ? 7 : 6];
    const recordOutToken = parts[hasTransitionDuration ? 8 : 7];
    if (!sourceInToken || !sourceOutToken || !recordInToken || !recordOutToken) {
      reportItems.push(reportItem("skipped", "edl.missing_timecode", `Skipped EDL event ${eventId}; it is missing one or more timecodes.`, eventId));
      continue;
    }

    const startSeconds = parseTimecode(recordInToken, DEFAULT_FPS);
    const endSeconds = parseTimecode(recordOutToken, DEFAULT_FPS);
    const sourceInSeconds = parseTimecode(sourceInToken, DEFAULT_FPS);
    const durationSeconds = Math.max(1 / DEFAULT_FPS, endSeconds - startSeconds);
    const type = trackToken.toUpperCase().includes("V") ? "video" : "audio";
    const transitionFrames = hasTransitionDuration ? Number.parseInt(parts[4] ?? "0", 10) : 0;
    const transitionIn = readEdlTransition(transitionCode, transitionFrames, DEFAULT_FPS, reportItems, eventId);
    const clip: ParsedTimelineClip = {
      id: `edl_${eventId}`,
      name: reel,
      sourceName: reel,
      type,
      trackIndex: 0,
      startSeconds,
      durationSeconds,
      sourceInSeconds,
      ...(transitionIn ? { transitionIn } : {})
    };
    clips.push(clip);
    pendingClip = clip;
  }

  return {
    format: "edl",
    title,
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    fps: DEFAULT_FPS,
    clips,
    reportItems
  };
}

function parseFcpxml(contents: string, fileName: string): ParsedTimeline {
  const document = parseXml(contents);
  if (!document) {
    throw new Error("Could not parse FCPXML. The XML appears malformed.");
  }

  const reportItems: TimelineImportReportItem[] = [];
  const assets = new Map<string, { name: string; src?: string | undefined; durationSeconds?: number | undefined }>();
  for (const asset of elementsByTag(document, "asset")) {
    const id = attr(asset, "id");
    if (!id) continue;
    assets.set(id, {
      name: attr(asset, "name") || decodeFileName(attr(asset, "src")) || id,
      src: attr(asset, "src") || undefined,
      durationSeconds: parseTimelineTime(attr(asset, "duration"), DEFAULT_FPS)
    });
  }

  const sequence = elementsByTag(document, "sequence")[0];
  const formatRef = sequence ? attr(sequence, "format") : "";
  const format = formatRef ? elementsByTag(document, "format").find((item) => attr(item, "id") === formatRef) : undefined;
  const fps = readFcpxmlFps(format, sequence) ?? DEFAULT_FPS;
  const width = readPositiveNumber(attr(format, "width")) ?? DEFAULT_WIDTH;
  const height = readPositiveNumber(attr(format, "height")) ?? DEFAULT_HEIGHT;
  const title = attr(sequence, "name") || attr(elementsByTag(document, "project")[0], "name") || stripExtension(fileName);
  const transitionCount = elementsByTag(document, "transition").length;

  const clips: ParsedTimelineClip[] = [];
  const spine = elementsByTag(document, "spine")[0] ?? sequence;
  if (spine) {
    collectFcpxmlClips(spine, { assets, clips, fps, reportItems, cursorSeconds: 0, fallbackTrack: 0 });
  }

  // Any transition elements NOT consumed by `collectFcpxmlClips` (e.g. a trailing transition with no
  // following clip) still get reported rather than silently dropped.
  const mappedTransitionCount = reportItems.filter((item) => item.code === "fcpxml.transition").length;
  if (transitionCount > mappedTransitionCount) {
    reportItems.push(
      reportItem(
        "unsupported",
        "fcpxml.transitionitem",
        `${transitionCount - mappedTransitionCount} FCPXML transition element(s) could not be mapped to a following clip.`
      )
    );
  }

  return { format: "fcpxml", title, width, height, fps, clips, reportItems };
}

function parseXmeml(contents: string, fileName: string): ParsedTimeline {
  const document = parseXml(contents);
  if (!document) {
    throw new Error("Could not parse XML timeline. The XML appears malformed.");
  }
  const sequence = elementsByTag(document, "sequence")[0];
  const title = textOf(firstChildByTag(sequence, "name")) || stripExtension(fileName);
  const fps = readPositiveNumber(textOf(firstChildByTag(firstChildByTag(sequence, "rate"), "timebase"))) ?? DEFAULT_FPS;
  const width = readPositiveNumber(textOf(firstChildByTag(firstChildByTag(sequence, "samplecharacteristics"), "width"))) ?? DEFAULT_WIDTH;
  const height = readPositiveNumber(textOf(firstChildByTag(firstChildByTag(sequence, "samplecharacteristics"), "height"))) ?? DEFAULT_HEIGHT;
  const reportItems: TimelineImportReportItem[] = [];
  const transitionCount = elementsByTag(document, "transitionitem").length;
  if (transitionCount > 0) {
    reportItems.push(
      reportItem("unsupported", "xmeml.transitionitem", `${transitionCount} XML transition item(s) were detected. V1 reports them for manual remapping.`)
    );
  }

  const clips: ParsedTimelineClip[] = [];
  const videoTracks = childElementsByTag(firstChildByTag(firstChildByTag(sequence, "media"), "video"), "track");
  const audioTracks = childElementsByTag(firstChildByTag(firstChildByTag(sequence, "media"), "audio"), "track");
  collectXmemlTrackClips(videoTracks, "video", fps, clips, reportItems);
  collectXmemlTrackClips(audioTracks, "audio", fps, clips, reportItems);
  return { format: "xmeml", title, width, height, fps, clips, reportItems };
}

function parsePrproj(contents: string, fileName: string, sequenceId?: string): ParsedTimeline {
  const document = parseXml(contents);
  if (!document) {
    throw new Error("Could not parse Premiere project. The .prproj XML appears malformed.");
  }

  const reportItems: TimelineImportReportItem[] = [
    reportItem(
      "mapped",
      "prproj.best_effort",
      "Premiere project import is best-effort. V1 imports timeline clips and reports unsupported project features."
    )
  ];
  const objectIndex = buildPrprojObjectIndex(document);
  const sequences = elementsByLocalName(document, "sequence").filter((sequence) => prprojSequenceLooksImportable(sequence));
  if (!sequences.length) {
    const textGraphParsed = parsePrprojTextObjectGraph(contents, fileName);
    if (textGraphParsed.clips.length) {
      return {
        ...textGraphParsed,
        reportItems: [
          ...reportItems,
          reportItem(
            "mapped",
            "prproj.text_object_graph",
            `Imported "${textGraphParsed.title}" through Premiere object-reference fallback parsing.`
          ),
          ...textGraphParsed.reportItems
        ]
      };
    }
    reportItems.push(
      reportItem(
        "unsupported",
        "prproj.no_sequence",
        "No importable sequence was found. Exporting Final Cut Pro XML from Premiere usually gives a cleaner interchange file."
      )
    );
    return {
      format: "prproj",
      title: readPrprojProjectTitle(document) || stripExtension(fileName),
      width: DEFAULT_WIDTH,
      height: DEFAULT_HEIGHT,
      fps: DEFAULT_FPS,
      clips: [],
      reportItems
    };
  }

  const candidates = sequences.map((sequence) => {
    const fps = readPrprojFps(sequence) ?? DEFAULT_FPS;
    const candidateReportItems: TimelineImportReportItem[] = [];
    const clips = collectPrprojSequenceClips(sequence, fps, candidateReportItems, objectIndex);
    return { sequence, id: readPrprojId(sequence), fps, clips, reportItems: candidateReportItems };
  });
  // Task 2.3 multi-sequence: an explicit `sequenceId` (from a report-modal picker re-parse) wins over the
  // "most readable clips" heuristic, so a user can select ANY sequence, not just the auto-picked one.
  const requested = sequenceId ? candidates.find((c) => c.id === sequenceId) : undefined;
  const selected =
    requested ??
    candidates.slice().sort((a, b) => b.clips.length - a.clips.length || sequences.indexOf(a.sequence) - sequences.indexOf(b.sequence))[0]!;

  const availableSequences: TimelineImportSequenceOption[] | undefined =
    sequences.length > 1
      ? candidates.map((c, index) => ({
          id: c.id || `sequence_${index}`,
          name: readPrprojName(c.sequence) || `Sequence ${index + 1}`,
          clipCount: c.clips.length,
          selected: c === selected
        }))
      : undefined;

  if (sequences.length > 1) {
    const selectedName = readPrprojName(selected.sequence) || `sequence ${sequences.indexOf(selected.sequence) + 1}`;
    reportItems.push(
      reportItem(
        "mapped",
        "prproj.multiple_sequences",
        requested
          ? `${sequences.length} sequences were detected. Imported "${selectedName}" (selected).`
          : `${sequences.length} sequences were detected. V1 imported "${selectedName}" because it has the most readable clips.`
      )
    );
  }

  const sequence = selected.sequence;
  const fps = selected.fps;
  const width = readPrprojDimension(sequence, ["width", "frameSizeHorizontal", "frameWidth", "videoFrameWidth"]) ?? DEFAULT_WIDTH;
  const height = readPrprojDimension(sequence, ["height", "frameSizeVertical", "frameHeight", "videoFrameHeight"]) ?? DEFAULT_HEIGHT;
  const title = readPrprojName(sequence) || readPrprojProjectTitle(document) || stripExtension(fileName);
  const clips = selected.clips;
  reportItems.push(...selected.reportItems);
  const textGraphParsed = parsePrprojTextObjectGraph(contents, fileName);
  if (
    textGraphParsed.clips.length >= clips.length &&
    textGraphParsed.clips.some((clip) => clip.nestedTimelineId)
  ) {
    return {
      ...textGraphParsed,
      reportItems: [
        ...reportItems.filter((item) => item.code !== "prproj.multiple_sequences"),
        reportItem(
          "mapped",
          "prproj.text_object_graph",
          `Imported "${textGraphParsed.title}" through Premiere object-reference fallback parsing.`
        ),
        ...textGraphParsed.reportItems
      ]
    };
  }
  if (!clips.length) {
    if (textGraphParsed.clips.length) {
      return {
        ...textGraphParsed,
        reportItems: [
          ...reportItems.filter((item) => item.code !== "prproj.multiple_sequences"),
          reportItem(
            "mapped",
            "prproj.text_object_graph",
            `Imported "${textGraphParsed.title}" through Premiere object-reference fallback parsing.`
          ),
          ...textGraphParsed.reportItems
        ]
      };
    }
  }
  if (!clips.length) {
    const trackGroupRefs = elementsByLocalName(sequence, "trackgroup").length;
    const clipRefCount = elementsByLocalNames(sequence, ["clipitem", "cliptrackitem", "trackitem", "clip"]).length;
    reportItems.push(
      reportItem(
        "unsupported",
        "prproj.no_clips",
        `Found a Premiere sequence but no readable timeline clips. Track-group refs: ${trackGroupRefs}; inline clip refs: ${clipRefCount}. Export Final Cut Pro XML from Premiere for the most reliable interchange.`
      )
    );
  }

  const transitionCount = elementsByLocalNames(sequence, ["transition", "transitionitem", "transitiontrackitem"]).length;
  if (transitionCount > 0 && !clips.some((clip) => clip.transitionIn)) {
    reportItems.push(
      reportItem(
        "unsupported",
        "prproj.transition",
        `${transitionCount} Premiere transition element(s) were detected. V1 reports them for manual remapping.`
      )
    );
  }
  const effectCount = elementsByLocalNames(sequence, ["effect", "filter", "component", "videoeffect", "audioeffect"]).length;
  if (effectCount > 0) {
    reportItems.push(
      reportItem(
        "unsupported",
        "prproj.effects",
        `${effectCount} Premiere effect/component element(s) were detected. V1 imports clip timing only.`
      )
    );
  }
  const nestedCount = elementsByLocalNames(sequence, ["nestedsequence", "subsequence"]).length;
  if (nestedCount > 0) {
    reportItems.push(reportItem("unsupported", "prproj.nested_sequence", `${nestedCount} nested sequence reference(s) were detected and skipped.`));
  }

  return { format: "prproj", title, width, height, fps, clips, reportItems, availableSequences };
}

function buildNestedCompositionsFromParsedTimeline(input: {
  parsed: ParsedTimeline;
  rootComposition: TimelineComposition;
  projectId: string;
}): Record<string, TimelineComposition> {
  const compositions: Record<string, TimelineComposition> = {};
  compositions[input.rootComposition.id] = input.rootComposition;
  const nested = input.parsed.nestedTimelines ?? [];
  for (const timeline of nested) {
    const compositionId = compositionIdForParsedTimeline(input.projectId, timeline);
    if (compositionId === input.rootComposition.id || compositions[compositionId]) {
      continue;
    }
    compositions[compositionId] = buildCompositionFromParsedTimeline({
      parsed: timeline,
      projectId: `${input.projectId}_${sanitizeId(timeline.id || timeline.title)}`,
      projectTitle: timeline.title,
      compositionId
    });
  }
  return Object.keys(compositions).length > 1 ? compositions : {};
}

function buildCompositionFromParsedTimeline(input: { parsed: ParsedTimeline; projectId: string; projectTitle: string; compositionId?: string | undefined }): TimelineComposition {
  const fps = input.parsed.fps ?? DEFAULT_FPS;
  const width = input.parsed.width ?? DEFAULT_WIDTH;
  const height = input.parsed.height ?? DEFAULT_HEIGHT;
  const durationSeconds = Math.max(
    1,
    ...input.parsed.clips.map((clip) => clip.startSeconds + clip.durationSeconds)
  );
  const videoGroups = groupClips(input.parsed.clips.filter((clip) => clip.type !== "audio"));
  const audioGroups = groupClips(input.parsed.clips.filter((clip) => clip.type === "audio"));
  const tracks: TimelineTrack[] = [];

  for (const [index, clips] of videoGroups) {
    const trackId = `${input.projectId}_import_video_${index + 1}`;
    tracks.push({
      id: trackId,
      type: "video",
      name: `Video ${index + 1}`,
      layers: clips.map((clip) => createImportedLayer(clip, trackId, width, height, input.projectId))
    });
  }
  for (const [index, clips] of audioGroups) {
    const trackId = `${input.projectId}_import_audio_${index + 1}`;
    tracks.push({
      id: trackId,
      type: "audio",
      name: `Audio ${index + 1}`,
      layers: clips.map((clip) => createImportedLayer(clip, trackId, width, height, input.projectId))
    });
  }
  if (tracks.length === 0) {
    tracks.push({ id: `${input.projectId}_import_video_1`, type: "video", name: "Video 1", layers: [] });
  }

  return {
    id: input.compositionId ?? `composition_${input.projectId}`,
    name: input.projectTitle || input.parsed.title,
    width,
    height,
    fps,
    durationSeconds,
    backgroundColor: "#07080C",
    settings: {
      viewport: {
        preset: width === height ? "square_1080" : width > height ? "landscape_1920x1080" : "vertical_1080x1920",
        width,
        height,
        fps,
        backgroundColor: "#07080C",
        resizeBehavior: "keep-layout"
      },
      timeline: {
        baseDurationSeconds: durationSeconds,
        autoGrow: true,
        tailPaddingSeconds: 1,
        snapSeconds: 1 / fps,
        timeDisplay: "timecode"
      }
    },
    tracks
  };
}

function createImportedLayer(clip: ParsedTimelineClip, trackId: string, width: number, height: number, projectId: string): TimelineLayer {
  const layer: TimelineLayer = {
    id: `${trackId}_${sanitizeId(clip.id)}`,
    trackId,
    type: clip.type,
    name: clip.name || clip.sourceName || "Imported clip",
    startSeconds: roundTime(clip.startSeconds),
    durationSeconds: roundTime(clip.durationSeconds),
    sourceInSeconds: clip.sourceInSeconds !== undefined ? roundTime(clip.sourceInSeconds) : undefined,
    nestedCompositionId: clip.nestedTimelineId ? compositionIdForParsedTimelineId(projectId, clip.nestedTimelineId) : undefined,
    fit: "cover",
    transform: {
      position: { x: 50, y: 50 },
      scale: 1,
      rotation: 0,
      opacity: 100
    },
    ...(clip.nestedTimelineId
      ? {}
      : {
          slot: {
            key: `import_${sanitizeId(clip.id)}`,
            label: clip.sourceName || clip.name || "Imported media",
            kind: "media" as const,
            replaceable: true
          }
        }),
    effects: [],
    keyframes: [],
    ...(clip.keyframes?.length ? { animations: clip.keyframes } : {}),
    widthPercent: 100,
    heightPercent: 100,
    ...(clip.transitionIn ? { transitionIn: clip.transitionIn } : {})
  };
  if (clip.type === "text") {
    layer.text = clip.text || clip.name || "Text";
    layer.fontFamily = clip.textStyle?.fontFamily || "Inter, Arial, sans-serif";
    layer.fontSize = clip.textStyle?.fontSize ?? 64;
    layer.fontWeight = clip.textStyle?.fontWeight ?? 700;
    layer.italic = clip.textStyle?.italic;
    layer.textAlign = clip.textStyle?.textAlign ?? "center";
    layer.color = clip.textStyle?.color || "#FFFFFF";
    layer.widthPercent = 80;
    layer.heightPercent = undefined;
    layer.backgroundColor = "transparent";
    layer.slot = {
      key: `import_text_${sanitizeId(clip.id)}`,
      label: clip.name || "Imported text",
      kind: "text",
      replaceable: true
    };
  } else if (clip.type === "audio") {
    layer.muted = false;
  } else {
    layer.widthPercent = width > 0 ? 100 : undefined;
    layer.heightPercent = height > 0 ? 100 : undefined;
  }
  return layer;
}

function compositionIdForParsedTimeline(projectId: string, timeline: ParsedTimeline): string {
  return compositionIdForParsedTimelineId(projectId, timeline.id || timeline.title);
}

function compositionIdForParsedTimelineId(projectId: string, timelineId: string): string {
  return `composition_${projectId}_nested_${sanitizeId(timelineId)}`;
}

function buildTimelineImportReport(fileName: string, parsed: ParsedTimeline, composition: TimelineComposition): TimelineImportReport {
  const clips = parsed.clips;
  const imported = clips.map((clip) =>
    reportItem("imported", "timeline.clip", `Imported ${clip.type} placeholder "${clip.name}" at ${formatSeconds(clip.startSeconds)}.`, clip.id)
  );
  const mapped: TimelineImportReportItem[] = clips
    .filter((clip) => clip.transitionIn)
    .map((clip) =>
      reportItem("mapped", "timeline.transition.cross_dissolve", `Mapped transition on "${clip.name}" to ${clip.transitionIn?.kind}.`, clip.id)
    );
  const skipped = parsed.reportItems.filter((item) => item.section === "skipped");
  const unsupported = parsed.reportItems.filter((item) => item.section === "unsupported");
  return {
    format: parsed.format,
    fileName,
    title: parsed.title,
    fps: composition.fps,
    width: composition.width,
    height: composition.height,
    durationSeconds: composition.durationSeconds,
    counts: {
      clips: clips.length,
      videoClips: clips.filter((clip) => clip.type === "video").length,
      audioClips: clips.filter((clip) => clip.type === "audio").length,
      placeholders: clips.length,
      transitionsMapped: mapped.length,
      skipped: skipped.length,
      unsupported: unsupported.length
    },
    imported,
    mapped: [...parsed.reportItems.filter((item) => item.section === "mapped"), ...mapped],
    skipped,
    unsupported,
    ...(parsed.availableSequences?.length ? { availableSequences: parsed.availableSequences } : {})
  };
}

export interface ExternalTransitionMapping {
  kind: BuiltInTransitionKind;
  params?: Record<string, number | number[] | boolean> | undefined;
}

/**
 * Maps a Premiere/FCPXML/Resolve transition NAME to a registry transition kind (Task 2.1). Every NLE
 * importer funnels through this ONE table so the same transition name maps identically regardless of
 * source format — replaces the old per-format "dissolve or nothing" mapping. Unknown names still map
 * (to `crossDissolve`, the least-surprising fallback) rather than being silently dropped; the CALLER is
 * responsible for reporting the original name as "mapped" (not "unsupported") so a review modal shows
 * what was approximated.
 */
export function mapExternalTransition(name: string | undefined): ExternalTransitionMapping {
  const n = (name ?? "").toLowerCase().trim();
  if (n.includes("dip to black")) return { kind: "dip", params: { dipColor: [0, 0, 0] } };
  if (n.includes("dip to white")) return { kind: "dip", params: { dipColor: [1, 1, 1] } };
  if (n.includes("dip")) return { kind: "dip" };
  if (n.includes("iris")) return { kind: "iris" };
  if (n.includes("cross zoom") || (n.includes("zoom") && !n.includes("push"))) return { kind: "zoom" };
  if (n.includes("push")) return { kind: "push" };
  if (n.includes("slide")) return { kind: "slide" };
  if (n.startsWith("wipe") || n.includes(" wipe") || n.endsWith("wipe")) return { kind: "wipe" };
  // Cross Dissolve, Film Dissolve, Additive Dissolve, Constant Power/Gain (audio-only names that still
  // appear on video tracks in some exports), and anything unrecognized all fall back to Cross Dissolve —
  // the standard "safe" junction transition every NLE treats as its default.
  return { kind: "crossDissolve" };
}

function readEdlTransition(
  transitionCode: string,
  frames: number,
  fps: number,
  reportItems: TimelineImportReportItem[],
  eventId: string
): TransitionSpec | undefined {
  if (transitionCode === "C") return undefined;
  if (transitionCode === "D") {
    const durationSeconds = Math.max(1 / fps, (Number.isFinite(frames) ? frames : 0) / fps);
    reportItems.push(reportItem("mapped", "edl.dissolve", `Mapped EDL dissolve on event ${eventId} to Cross Dissolve.`, eventId));
    return { kind: "crossDissolve", durationSeconds };
  }
  reportItems.push(reportItem("unsupported", "edl.transition", `EDL transition "${transitionCode}" on event ${eventId} is not mapped yet.`, eventId));
  return undefined;
}

function collectFcpxmlClips(
  root: XmlElement,
  context: {
    assets: Map<string, { name: string; src?: string | undefined; durationSeconds?: number | undefined }>;
    clips: ParsedTimelineClip[];
    fps: number;
    reportItems: TimelineImportReportItem[];
    cursorSeconds: number;
    fallbackTrack: number;
  }
): number {
  let cursor = context.cursorSeconds;
  // A `<transition>` spine element sits BETWEEN the two clips it joins; FCPXML gives it its own
  // offset/duration rather than nesting inside either clip. Stash it here and attach it as
  // `transitionIn` to the NEXT clip pushed at this spine level (the incoming clip).
  let pendingTransition: { name: string; durationSeconds: number } | undefined;
  for (const child of Array.from(root.children as unknown as ArrayLike<XmlElement>)) {
    const tag = child.localName.toLowerCase();
    if (tag === "asset-clip" || tag === "video" || tag === "audio" || tag === "clip") {
      const ref = attr(child, "ref");
      const asset = ref ? context.assets.get(ref) : undefined;
      const durationSeconds = parseTimelineTime(attr(child, "duration"), context.fps) ?? asset?.durationSeconds ?? 1;
      const offsetSeconds = parseTimelineTime(attr(child, "offset"), context.fps) ?? cursor;
      const sourceInSeconds = parseTimelineTime(attr(child, "start"), context.fps) ?? 0;
      const lane = Number.parseInt(attr(child, "lane") || "", 10);
      const type = tag === "audio" ? "audio" : "video";
      const clipName = attr(child, "name") || asset?.name || ref || "Imported clip";
      const clipId = attr(child, "id") || `${tag}_${context.clips.length + 1}`;
      let transitionIn: TransitionSpec | undefined;
      if (pendingTransition) {
        const mapping = mapExternalTransition(pendingTransition.name);
        transitionIn = { kind: mapping.kind, durationSeconds: pendingTransition.durationSeconds, ...(mapping.params ? { params: mapping.params } : {}) };
        context.reportItems.push(
          reportItem("mapped", "fcpxml.transition", `Mapped FCPXML transition "${pendingTransition.name || "unknown"}" before "${clipName}" to ${mapping.kind}.`, clipId)
        );
        pendingTransition = undefined;
      }
      context.clips.push({
        id: clipId,
        name: clipName,
        sourceName: asset?.name ?? decodeFileName(asset?.src) ?? clipName,
        type,
        trackIndex: Number.isFinite(lane) ? Math.max(0, lane) : context.fallbackTrack,
        startSeconds: offsetSeconds,
        durationSeconds: Math.max(1 / context.fps, durationSeconds),
        sourceInSeconds,
        ...(transitionIn ? { transitionIn } : {}),
        keyframes: readFcpxmlOpacityKeyframes(child, context.fps)
      });
      cursor = Math.max(cursor, offsetSeconds + durationSeconds);
      collectFcpxmlClips(child, { ...context, cursorSeconds: offsetSeconds, fallbackTrack: context.fallbackTrack + 1 });
      continue;
    }
    if (tag === "gap") {
      const durationSeconds = parseTimelineTime(attr(child, "duration"), context.fps) ?? 0;
      cursor += durationSeconds;
      continue;
    }
    if (tag === "transition") {
      pendingTransition = {
        name: attr(child, "name") || "Cross Dissolve",
        durationSeconds: Math.max(1 / context.fps, parseTimelineTime(attr(child, "duration"), context.fps) ?? 0.5)
      };
      continue;
    }
    if (tag === "title") {
      const offsetSeconds = parseTimelineTime(attr(child, "offset"), context.fps) ?? cursor;
      const durationSeconds = Math.max(1 / context.fps, parseTimelineTime(attr(child, "duration"), context.fps) ?? 2);
      const clipId = attr(child, "id") || `title_${context.clips.length + 1}`;
      const textElement = firstChildByTag(child, "text");
      const text = textOf(textElement) || attr(child, "name") || "Title";
      const styleDef = firstChildByTag(textElement, "text-style-def") ?? firstChildByTag(child, "text-style-def");
      const style = firstChildByTag(styleDef, "text-style") ?? firstChildByTag(textElement, "text-style");
      const textStyle = style
        ? {
            fontFamily: attr(style, "font") || undefined,
            fontSize: readPositiveNumber(attr(style, "fontSize")),
            fontWeight: attr(style, "bold") === "1" ? 700 : undefined,
            italic: attr(style, "italic") === "1" ? true : undefined,
            color: fcpxmlColorToHex(attr(style, "fontColor")),
            textAlign: fcpxmlAlignment(attr(style, "alignment"))
          }
        : undefined;
      context.clips.push({
        id: clipId,
        name: attr(child, "name") || "Title",
        type: "text",
        text,
        trackIndex: context.fallbackTrack,
        startSeconds: offsetSeconds,
        durationSeconds,
        textStyle
      });
      context.reportItems.push(reportItem("mapped", "fcpxml.title", `Mapped FCPXML title "${attr(child, "name") || "Untitled"}" to an editable text layer.`, clipId));
      cursor = Math.max(cursor, offsetSeconds + durationSeconds);
      continue;
    }
    cursor = collectFcpxmlClips(child, { ...context, cursorSeconds: cursor });
  }
  return cursor;
}

/** `<adjust-opacity>` `<keyframe time="…" value="0..1">` children -> layer-local opacity keyframes (0..100). */
function readFcpxmlOpacityKeyframes(clipElement: XmlElement, fps: number): TimelineKeyframeV2[] | undefined {
  const adjustOpacity = firstChildByTag(clipElement, "adjust-opacity");
  const keyframeElements = childElementsByTag(firstChildByTag(adjustOpacity, "keyframeAnimation") ?? adjustOpacity, "keyframe");
  if (!keyframeElements.length) return undefined;
  const keyframes: TimelineKeyframeV2[] = keyframeElements.map((kf, index) => {
    const timeSeconds = parseTimelineTime(attr(kf, "time"), fps) ?? 0;
    const rawValue = Number.parseFloat(attr(kf, "value"));
    const value = Number.isFinite(rawValue) ? Math.max(0, Math.min(100, rawValue * 100)) : 100;
    return {
      id: `import_opacity_kf_${index}`,
      target: { scope: "layer" as const, property: "opacity" },
      timeSeconds,
      value,
      interpolation: "linear" as const,
      temporal: {}
    };
  });
  return keyframes;
}

function fcpxmlColorToHex(value: string): string | undefined {
  // FCPXML fontColor is "r g b a" floats 0..1.
  const parts = value.trim().split(/\s+/).map((part) => Number.parseFloat(part));
  if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return undefined;
  const toHex = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 255).toString(16).padStart(2, "0");
  return `#${toHex(parts[0]!)}${toHex(parts[1]!)}${toHex(parts[2]!)}`;
}

function fcpxmlAlignment(value: string): "left" | "center" | "right" | undefined {
  const n = value.trim().toLowerCase();
  if (n === "left" || n === "center" || n === "right") return n;
  return undefined;
}

function collectXmemlTrackClips(
  tracks: XmlElement[],
  type: "video" | "audio",
  fps: number,
  clips: ParsedTimelineClip[],
  reportItems: TimelineImportReportItem[]
) {
  tracks.forEach((track, trackIndex) => {
    for (const clipitem of childElementsByTag(track, "clipitem")) {
      const id = attr(clipitem, "id") || `${type}_${trackIndex + 1}_${clips.length + 1}`;
      const startFrame = readNumberFromChild(clipitem, "start");
      const endFrame = readNumberFromChild(clipitem, "end");
      if (startFrame === undefined || endFrame === undefined || endFrame <= startFrame) {
        reportItems.push(reportItem("skipped", "xmeml.invalid_clip_range", `Skipped XML clip ${id}; start/end frames are invalid.`, id));
        continue;
      }
      const file = firstChildByTag(clipitem, "file");
      const fileName = textOf(firstChildByTag(file, "name")) || textOf(firstChildByTag(clipitem, "name")) || "Imported clip";
      const inFrame = readNumberFromChild(clipitem, "in") ?? 0;
      clips.push({
        id,
        name: textOf(firstChildByTag(clipitem, "name")) || fileName,
        sourceName: fileName,
        type,
        trackIndex,
        startSeconds: startFrame / fps,
        durationSeconds: Math.max(1 / fps, (endFrame - startFrame) / fps),
        sourceInSeconds: inFrame / fps
      });
    }
  });
}

function prprojSequenceLooksImportable(sequence: XmlElement): boolean {
  return (
    elementsByLocalNames(sequence, ["clipitem", "clip", "trackitem", "cliptrackitem"]).length > 0 ||
    elementsByLocalNames(sequence, ["videotrack", "audiotrack", "track"]).length > 0 ||
    elementsByLocalName(sequence, "trackgroup").length > 0
  );
}

interface PrprojTextObject {
  tag: string;
  attrs: Record<string, string>;
  xml: string;
}

interface PrprojTextSequenceCandidate {
  sequence: PrprojTextObject;
  id: string;
  fps: number;
  clips: ParsedTimelineClip[];
  reportItems: TimelineImportReportItem[];
}

function parsePrprojTextObjectGraph(contents: string, fileName: string): ParsedTimeline {
  const reportItems: TimelineImportReportItem[] = [];
  const objectIndex = buildPrprojTextObjectIndex(contents);
  const sequences = findPrprojTextBlocks(contents, ["Sequence"]);
  if (!sequences.length) {
    return { format: "prproj", title: stripExtension(fileName), width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, fps: DEFAULT_FPS, clips: [], reportItems };
  }

  const sequenceNameToId = new Map<string, string>();
  sequences.forEach((sequence, index) => {
    const name = readPrprojTextName(sequence);
    const id = readPrprojTextSequenceId(sequence, index);
    if (name && id && !sequenceNameToId.has(name)) {
      sequenceNameToId.set(name, id);
    }
  });
  const candidates: PrprojTextSequenceCandidate[] = sequences.map((sequence, index) => {
    const fps = readPrprojTextFps(sequence) ?? DEFAULT_FPS;
    const candidateReportItems: TimelineImportReportItem[] = [];
    const clips = collectPrprojTextSequenceClips(sequence, fps, candidateReportItems, objectIndex, sequenceNameToId);
    return { sequence, id: readPrprojTextSequenceId(sequence, index), fps, clips, reportItems: candidateReportItems };
  });
  const selected = candidates
    .slice()
    .sort((a, b) => b.clips.length - a.clips.length || sequences.indexOf(a.sequence) - sequences.indexOf(b.sequence))[0]!;

  if (sequences.length > 1) {
    reportItems.push(
      reportItem(
        "mapped",
        "prproj.multiple_sequences",
        `${sequences.length} sequences were detected. V1 imported "${readPrprojTextName(selected.sequence) || "the sequence with the most readable clips"}" because it has the most readable clips.`
      )
    );
  }
  reportItems.push(...selected.reportItems);
  const nestedClipCount = selected.clips.filter((clip) => clip.nestedTimelineId).length;
  if (nestedClipCount > 0) {
    reportItems.push(
      reportItem(
        "mapped",
        "prproj.nested_sequences",
        `Preserved ${nestedClipCount} nested Premiere sequence clip(s) as linked Lumio compositions.`
      )
    );
  }

  return {
    format: "prproj",
    id: selected.id,
    title: readPrprojTextName(selected.sequence) || stripExtension(fileName),
    width: readPrprojTextDimension(selected.sequence, ["width", "frameSizeHorizontal", "frameWidth", "videoFrameWidth"]) ?? DEFAULT_WIDTH,
    height: readPrprojTextDimension(selected.sequence, ["height", "frameSizeVertical", "frameHeight", "videoFrameHeight"]) ?? DEFAULT_HEIGHT,
    fps: selected.fps,
    clips: selected.clips,
    reportItems,
    nestedTimelines: candidates
      .filter((candidate) => candidate.sequence !== selected.sequence)
      .map((candidate) => ({
        format: "prproj" as const,
        id: candidate.id,
        title: readPrprojTextName(candidate.sequence) || "Nested sequence",
        width: readPrprojTextDimension(candidate.sequence, ["width", "frameSizeHorizontal", "frameWidth", "videoFrameWidth"]) ?? DEFAULT_WIDTH,
        height: readPrprojTextDimension(candidate.sequence, ["height", "frameSizeVertical", "frameHeight", "videoFrameHeight"]) ?? DEFAULT_HEIGHT,
        fps: candidate.fps,
        clips: candidate.clips,
        reportItems: candidate.reportItems
      }))
  };
}

function buildPrprojTextObjectIndex(contents: string): Map<string, PrprojTextObject> {
  const index = new Map<string, PrprojTextObject>();
  const objectTags = [
    "Sequence",
    "VideoTrackGroup",
    "AudioTrackGroup",
    "TrackGroup",
    "VideoClipTrack",
    "AudioClipTrack",
    "ClipTrack",
    "ClipTrackItem",
    "VideoClipTrackItem",
    "AudioClipTrackItem",
    "SubClip",
    "MasterClip",
    "VideoClip",
    "AudioClip",
    "Clip",
    "Media"
  ];
  for (const object of findPrprojTextBlocks(contents, objectTags)) {
    const id = readPrprojTextObjectId(object);
    if (id && !index.has(id)) {
      index.set(id, object);
    }
  }
  return index;
}

function findPrprojTextBlocks(contents: string, tagNames: string[]): PrprojTextObject[] {
  const blocks: PrprojTextObject[] = [];
  for (const tagName of tagNames) {
    const regex = new RegExp(`<((?:[A-Za-z_][\\w.-]*:)?${escapeRegExp(tagName)})\\b([^>]*)>([\\s\\S]*?)<\\/\\1>`, "gi");
    let match: RegExpExecArray | null;
    while ((match = regex.exec(contents))) {
      const fullXml = match[0] ?? "";
      const qualifiedName = match[1] ?? tagName;
      blocks.push({ tag: localXmlName(qualifiedName), attrs: readXmlAttributes(match[2] ?? ""), xml: fullXml });
    }
  }
  return blocks;
}

function collectPrprojTextSequenceClips(
  sequence: PrprojTextObject,
  fps: number,
  reportItems: TimelineImportReportItem[],
  objectIndex: Map<string, PrprojTextObject>,
  sequenceNameToId: Map<string, string>
): ParsedTimelineClip[] {
  const clips: ParsedTimelineClip[] = [];
  const groupRefs = readPrprojTextRefs(sequence.xml, ["Second", "TrackGroup"]);
  const videoTracks: PrprojTextObject[] = [];
  const audioTracks: PrprojTextObject[] = [];

  for (const groupRef of groupRefs) {
    const group = objectIndex.get(groupRef);
    if (!group) continue;
    const kind = readPrprojTextKind(group);
    for (const trackRef of readPrprojTextRefs(group.xml, ["Track"])) {
      const track = objectIndex.get(trackRef);
      if (!track) continue;
      const trackKind = readPrprojTextKind(track) ?? kind;
      if (trackKind === "audio") {
        audioTracks.push(track);
      } else {
        videoTracks.push(track);
      }
    }
  }

  collectPrprojTextTrackClips(uniqueTextObjects(videoTracks), "video", fps, clips, reportItems, objectIndex, sequenceNameToId);
  collectPrprojTextTrackClips(uniqueTextObjects(audioTracks), "audio", fps, clips, reportItems, objectIndex, sequenceNameToId);

  if (!clips.length) {
    const inlineRefs = readPrprojTextRefs(sequence.xml, ["ClipItem", "ClipTrackItem", "TrackItem", "Clip"]);
    for (const ref of inlineRefs) {
      const clip = objectIndex.get(ref);
      if (!clip) continue;
      const parsed = readPrprojTextClip(clip, readPrprojTextKind(clip) ?? "video", 0, fps, reportItems, objectIndex, sequenceNameToId);
      if (parsed) clips.push(parsed);
    }
  }

  return clips;
}

function collectPrprojTextTrackClips(
  tracks: PrprojTextObject[],
  type: "video" | "audio",
  fps: number,
  clips: ParsedTimelineClip[],
  reportItems: TimelineImportReportItem[],
  objectIndex: Map<string, PrprojTextObject>,
  sequenceNameToId: Map<string, string>
) {
  tracks.forEach((track, trackIndex) => {
    const refs = readPrprojTextRefs(track.xml, ["ClipItem", "ClipTrackItem", "TrackItem", "Clip"]);
    for (const ref of refs) {
      const clip = objectIndex.get(ref);
      if (!clip) continue;
      const parsed = readPrprojTextClip(clip, type, trackIndex, fps, reportItems, objectIndex, sequenceNameToId);
      if (parsed) clips.push(parsed);
    }
  });
}

function readPrprojTextClip(
  clip: PrprojTextObject,
  fallbackType: "video" | "audio",
  trackIndex: number,
  fps: number,
  reportItems: TimelineImportReportItem[],
  objectIndex: Map<string, PrprojTextObject>,
  sequenceNameToId: Map<string, string>
): ParsedTimelineClip | undefined {
  const id = readPrprojTextObjectId(clip) || `${fallbackType}_${trackIndex + 1}_${reportItems.length + 1}`;
  const startSeconds = readPrprojTextTime(clip, ["start", "timelineIn", "startTime", "startTicks", "startFrame"], fps);
  const endSeconds = readPrprojTextTime(clip, ["end", "timelineOut", "endTime", "endTicks", "endFrame"], fps);
  const durationSeconds = readPrprojTextTime(clip, ["duration", "durationSeconds", "durationTicks", "durationFrames"], fps);
  const computedDuration = startSeconds !== undefined && endSeconds !== undefined ? endSeconds - startSeconds : durationSeconds;
  if (startSeconds === undefined || computedDuration === undefined || computedDuration <= 0) {
    reportItems.push(reportItem("skipped", "prproj.invalid_clip_range", `Skipped Premiere clip ${id}; start/end or duration is invalid.`, id));
    return undefined;
  }

  const name = readPrprojTextClipName(clip, objectIndex) || "Imported clip";
  const nestedTimelineId = fallbackType === "video" ? sequenceNameToId.get(name) : undefined;
  const clipType = !nestedTimelineId && isPrprojTextGraphicClip(name, clip, objectIndex)
    ? "text"
    : readPrprojTextKind(clip) ?? fallbackType;
  return {
    id,
    name,
    sourceName: readPrprojTextMediaName(clip, objectIndex) || name,
    type: clipType,
    trackIndex,
    startSeconds,
    durationSeconds: Math.max(1 / fps, computedDuration),
    sourceInSeconds: readPrprojTextTime(clip, ["in", "sourceIn", "mediaIn", "inTicks", "inFrame"], fps) ?? 0,
    ...(clipType === "text" ? { text: name === "Graphic" ? "Text" : name } : {}),
    ...(nestedTimelineId ? { nestedTimelineId } : {})
  };
}

function isPrprojTextGraphicClip(name: string, clip: PrprojTextObject, objectIndex: Map<string, PrprojTextObject>): boolean {
  if (/graphic|title|text/i.test(name)) {
    return true;
  }
  for (const ref of readPrprojTextRefs(clip.xml, ["SubClip", "Clip", "MasterClip"])) {
    const target = objectIndex.get(ref);
    if (target && /graphic|title|text|AE\.ADBE Graphic/i.test(target.xml)) {
      return true;
    }
  }
  return false;
}

function readPrprojTextClipName(clip: PrprojTextObject, objectIndex: Map<string, PrprojTextObject>): string {
  return readPrprojTextName(clip) || readPrprojTextReferencedName(clip, objectIndex) || readPrprojTextMediaName(clip, objectIndex);
}

function readPrprojTextMediaName(clip: PrprojTextObject, objectIndex: Map<string, PrprojTextObject>): string {
  return (
    readPrprojTextReferencedName(clip, objectIndex) ||
    readPrprojTextValue(clip.xml, ["sourceName", "mediaName", "fileName", "actualMediaFilePath", "filePath", "relativePath", "path", "Title"]) ||
    decodeFileName(readPrprojTextAttrAny(clip.attrs, ["source", "src", "path", "filePath", "mediaPath"])) ||
    ""
  );
}

function readPrprojTextReferencedName(clip: PrprojTextObject, objectIndex: Map<string, PrprojTextObject>): string {
  for (const tagName of ["SubClip", "MasterClip", "Clip", "Media"]) {
    const inlineName = readPrprojTextRefInlineName(clip.xml, tagName);
    if (inlineName) return inlineName;
    for (const ref of readPrprojTextRefs(clip.xml, [tagName])) {
      const target = objectIndex.get(ref);
      if (!target) continue;
      const name = readPrprojTextName(target) || readPrprojTextValue(target.xml, ["Title", "fileName", "filePath", "actualMediaFilePath"]);
      if (name) return decodeFileName(name) ?? name;
    }
  }
  return "";
}

function readPrprojTextRefInlineName(xml: string, tagName: string): string {
  const regex = new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${escapeRegExp(tagName)}\\b([^>]*)>`, "i");
  const attrs = readXmlAttributes(xml.match(regex)?.[1] ?? "");
  return readPrprojTextAttrAny(attrs, ["name", "Name", "displayName", "DisplayName"]);
}

function readPrprojTextRefs(xml: string, tagNames: string[]): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const tagName of tagNames) {
    const regex = new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${escapeRegExp(tagName)}\\b([^>]*)>`, "gi");
    let match: RegExpExecArray | null;
    while ((match = regex.exec(xml))) {
      const ref = readPrprojTextAttrAny(readXmlAttributes(match[1] ?? ""), ["ObjectRef", "ObjectURef", "ObjectUID", "ref", "Ref"]);
      if (ref && !seen.has(ref)) {
        seen.add(ref);
        refs.push(ref);
      }
    }
  }
  return refs;
}

function readPrprojTextFps(sequence: PrprojTextObject): number | undefined {
  const direct = readPositiveNumber(readPrprojTextAttrAny(sequence.attrs, ["fps", "frameRate", "frame-rate"]) || readPrprojTextValue(sequence.xml, ["fps", "frameRate", "frame-rate", "timebase"]));
  if (direct && direct <= 240) return direct;
  const timebase = readPositiveNumber(readPrprojTextAttrAny(sequence.attrs, ["timebase", "Timebase"]) || readPrprojTextValue(sequence.xml, ["timebase", "Timebase"]));
  if (timebase) {
    return timebase > 1000 ? PREMIERE_TICKS_PER_SECOND / timebase : timebase;
  }
  const frameDuration = readPrprojTextTime(sequence, ["frameDuration", "frameDurationTicks"], DEFAULT_FPS);
  return frameDuration && frameDuration > 0 ? 1 / frameDuration : undefined;
}

function readPrprojTextDimension(sequence: PrprojTextObject, names: string[]): number | undefined {
  return readPositiveNumber(readPrprojTextAttrAny(sequence.attrs, names) || readPrprojTextValue(sequence.xml, names));
}

function readPrprojTextTime(object: PrprojTextObject, names: string[], fps: number): number | undefined {
  const value = readPrprojTextAttrAny(object.attrs, names) || readPrprojTextValue(object.xml, names);
  return value ? parsePrprojTime(value, fps) : undefined;
}

function readPrprojTextKind(object: PrprojTextObject): "video" | "audio" | undefined {
  const tag = object.tag.toLowerCase();
  if (tag.includes("audio")) return "audio";
  if (tag.includes("video")) return "video";
  const value = (readPrprojTextAttrAny(object.attrs, ["type", "mediaType", "kind", "clipType", "trackType"]) || readPrprojTextValue(object.xml, ["type", "mediaType", "kind", "clipType", "trackType"])).toLowerCase();
  if (value.includes("audio")) return "audio";
  if (value.includes("video")) return "video";
  return undefined;
}

function readPrprojTextName(object: PrprojTextObject): string {
  return readPrprojTextAttrAny(object.attrs, ["name", "Name", "displayName", "DisplayName"]) || readPrprojTextValue(object.xml, ["name", "Name", "displayName", "DisplayName"]);
}

function readPrprojTextObjectId(object: PrprojTextObject): string {
  return readPrprojTextAttrAny(object.attrs, ["ObjectID", "ObjectUID"]);
}

function readPrprojTextSequenceId(sequence: PrprojTextObject, index: number): string {
  return readPrprojTextObjectId(sequence) || `sequence_${index + 1}_${sanitizeId(readPrprojTextName(sequence) || "untitled")}`;
}

function readPrprojTextAttrAny(attrs: Record<string, string>, names: string[]): string {
  for (const name of names) {
    const variants = [name, name.toLowerCase(), name.toUpperCase(), `${name[0]?.toUpperCase() ?? ""}${name.slice(1)}`];
    for (const variant of variants) {
      const value = attrs[variant]?.trim();
      if (value) return value;
    }
  }
  return "";
}

function readPrprojTextValue(xml: string, names: string[]): string {
  for (const name of names) {
    const regex = new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${escapeRegExp(name)}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?${escapeRegExp(name)}>`, "i");
    const match = xml.match(regex);
    const value = stripXmlTags(match?.[1] ?? "").trim();
    if (value) return decodeXmlEntities(value);
  }
  return "";
}

function stripXmlTags(value: string): string {
  return value.replace(/<[^>]+>/g, "");
}

function uniqueTextObjects(items: PrprojTextObject[]): PrprojTextObject[] {
  const seen = new Set<PrprojTextObject>();
  const unique: PrprojTextObject[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    unique.push(item);
  }
  return unique;
}

function collectPrprojSequenceClips(sequence: XmlElement, fps: number, reportItems: TimelineImportReportItem[], objectIndex: PrprojObjectIndex): ParsedTimelineClip[] {
  const clips: ParsedTimelineClip[] = [];
  const xmemlMedia = firstChildByLocalName(sequence, "media");
  if (xmemlMedia) {
    collectXmemlTrackClips(childElementsByLocalName(firstChildByLocalName(firstChildByLocalName(sequence, "media"), "video"), "track"), "video", fps, clips, reportItems);
    collectXmemlTrackClips(childElementsByLocalName(firstChildByLocalName(firstChildByLocalName(sequence, "media"), "audio"), "track"), "audio", fps, clips, reportItems);
    if (clips.length) {
      return clips;
    }
  }

  const referencedTracks = readPrprojSequenceReferencedTracks(sequence, objectIndex);
  const trackElements = referencedTracks.length ? referencedTracks : elementsByLocalNames(sequence, ["videotrack", "audiotrack", "track"]);
  const videoTracks = trackElements.filter((track) => readPrprojTrackKind(track) === "video");
  const audioTracks = trackElements.filter((track) => readPrprojTrackKind(track) === "audio");
  collectPrprojTrackClips(videoTracks, "video", fps, clips, reportItems, objectIndex);
  collectPrprojTrackClips(audioTracks, "audio", fps, clips, reportItems, objectIndex);

  if (!clips.length) {
    const genericClips = elementsByLocalNames(sequence, ["clipitem", "cliptrackitem", "trackitem", "clip"]);
    for (const clip of genericClips) {
      const type = readPrprojClipKind(clip) ?? "video";
      const parsed = readPrprojClip(resolvePrprojReference(clip, objectIndex) ?? clip, type, 0, fps, reportItems, objectIndex);
      if (parsed) {
        clips.push(parsed);
      }
    }
  }
  return clips;
}

function collectPrprojTrackClips(
  tracks: XmlElement[],
  type: "video" | "audio",
  fps: number,
  clips: ParsedTimelineClip[],
  reportItems: TimelineImportReportItem[],
  objectIndex: PrprojObjectIndex
) {
  tracks.forEach((track, trackIndex) => {
    const clipItems = readPrprojTrackClipItems(track, objectIndex);
    for (const clipItem of clipItems) {
      const clip = resolvePrprojReference(clipItem, objectIndex) ?? clipItem;
      const parsed = readPrprojClip(clip, type, trackIndex, fps, reportItems, objectIndex);
      if (parsed) {
        clips.push(parsed);
      }
    }
  });
}

function buildPrprojObjectIndex(root: XmlRoot): PrprojObjectIndex {
  const index: PrprojObjectIndex = new Map();
  const visit = (node: XmlRoot | XmlElement | undefined) => {
    if (!node) return;
    const children = Array.from(node.children as unknown as ArrayLike<XmlElement>);
    for (const child of children) {
      for (const id of [attr(child, "ObjectID"), attr(child, "ObjectUID")]) {
        if (id && !index.has(id)) {
          index.set(id, child);
        }
      }
      visit(child);
    }
  };
  visit(root);
  return index;
}

function resolvePrprojReference(element: XmlElement, objectIndex: PrprojObjectIndex): XmlElement | undefined {
  const ref = attrAny(element, ["ObjectRef", "ObjectURef", "ObjectUID", "ref", "Ref"]);
  return ref ? objectIndex.get(ref) : undefined;
}

function readPrprojSequenceReferencedTracks(sequence: XmlElement, objectIndex: PrprojObjectIndex): XmlElement[] {
  const tracks: XmlElement[] = [];
  const trackGroups = elementsByLocalName(sequence, "trackgroup");
  for (const trackGroupRef of trackGroups) {
    const group = resolvePrprojReference(firstChildByLocalName(trackGroupRef, "second") ?? trackGroupRef, objectIndex) ?? resolvePrprojReference(trackGroupRef, objectIndex);
    if (!group) {
      continue;
    }
    const groupTracks = firstChildByLocalName(group, "tracks") ?? group;
    for (const trackRef of childElementsByLocalName(groupTracks, "track")) {
      const track = resolvePrprojReference(trackRef, objectIndex);
      if (track) {
        tracks.push(track);
      }
    }
  }
  return uniqueElements(tracks);
}

function readPrprojTrackClipItems(track: XmlElement, objectIndex: PrprojObjectIndex): XmlElement[] {
  const containers = elementsByLocalNames(track, ["clipitems", "trackitems"]);
  const refs = containers.flatMap((container) => childElementsByLocalName(container, "clipitem").concat(childElementsByLocalName(container, "trackitem")));
  const inline = elementsByLocalNames(track, ["clipitem", "cliptrackitem", "trackitem", "clip"]).filter((clip) => !isContainerClipList(clip));
  const items = refs.length ? refs : inline;
  return uniqueElements(items.map((item) => resolvePrprojReference(item, objectIndex) ?? item));
}

function uniqueElements(items: XmlElement[]): XmlElement[] {
  const seen = new Set<XmlElement>();
  const unique: XmlElement[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    unique.push(item);
  }
  return unique;
}

function readPrprojClip(
  clip: XmlElement,
  fallbackType: "video" | "audio",
  trackIndex: number,
  fps: number,
  reportItems: TimelineImportReportItem[],
  objectIndex: PrprojObjectIndex
): ParsedTimelineClip | undefined {
  const id = readPrprojId(clip) || `${fallbackType}_${trackIndex + 1}_${Math.max(1, reportItems.length)}`;
  const startSeconds = readPrprojTimeValue(clip, ["start", "timelineIn", "startTime", "startTicks", "startFrame"], fps);
  const endSeconds = readPrprojTimeValue(clip, ["end", "timelineOut", "endTime", "endTicks", "endFrame"], fps);
  const durationSeconds = readPrprojTimeValue(clip, ["duration", "durationSeconds", "durationTicks", "durationFrames"], fps);
  const inSeconds = readPrprojTimeValue(clip, ["in", "sourceIn", "mediaIn", "inTicks", "inFrame"], fps) ?? 0;
  const computedDuration =
    startSeconds !== undefined && endSeconds !== undefined
      ? endSeconds - startSeconds
      : durationSeconds;
  if (startSeconds === undefined || computedDuration === undefined || computedDuration <= 0) {
    reportItems.push(reportItem("skipped", "prproj.invalid_clip_range", `Skipped Premiere clip ${id}; start/end or duration is invalid.`, id));
    return undefined;
  }

  const name = readPrprojClipName(clip, objectIndex) || "Imported clip";
  const transitionIn = readPrprojClipTransition(clip, fps, reportItems, id);
  return {
    id,
    name,
    sourceName: readPrprojMediaName(clip, objectIndex) || name,
    type: readPrprojClipKind(clip) ?? fallbackType,
    trackIndex,
    startSeconds,
    durationSeconds: Math.max(1 / fps, computedDuration),
    sourceInSeconds: inSeconds,
    ...(transitionIn ? { transitionIn } : {})
  };
}

function readPrprojClipTransition(
  clip: XmlElement,
  fps: number,
  reportItems: TimelineImportReportItem[],
  clipId: string
): TransitionSpec | undefined {
  const transitions = elementsByLocalNames(clip, ["transition", "transitionitem", "transitiontrackitem"]);
  const transition = transitions[0];
  if (!transition) {
    return undefined;
  }
  const name = readPrprojName(transition).toLowerCase();
  const durationSeconds = Math.max(1 / fps, readPrprojTimeValue(transition, ["duration", "durationSeconds", "durationTicks", "durationFrames"], fps) ?? 0.5);
  const mapping = mapExternalTransition(name);
  reportItems.push(
    reportItem(
      "mapped",
      "prproj.transition",
      `Mapped Premiere transition "${name || "unknown"}" on clip ${clipId} to ${mapping.kind}.`,
      clipId
    )
  );
  return { kind: mapping.kind, durationSeconds, ...(mapping.params ? { params: mapping.params } : {}) };
}

function readPrprojTrackKind(track: XmlElement): "video" | "audio" | undefined {
  const name = track.localName.toLowerCase();
  if (name.includes("video")) return "video";
  if (name.includes("audio")) return "audio";
  const value = (attrAny(track, ["type", "mediaType", "kind", "trackType"]) || readTextChildAny(track, ["type", "mediaType", "kind", "trackType"])).toLowerCase();
  if (value.includes("audio")) return "audio";
  if (value.includes("video")) return "video";
  return undefined;
}

function readPrprojClipKind(clip: XmlElement): "video" | "audio" | undefined {
  const value = (attrAny(clip, ["type", "mediaType", "kind", "clipType"]) || readTextChildAny(clip, ["type", "mediaType", "kind", "clipType"])).toLowerCase();
  if (value.includes("audio")) return "audio";
  if (value.includes("video")) return "video";
  return undefined;
}

function readPrprojFps(sequence: XmlElement): number | undefined {
  const direct = readPositiveNumber(attrAny(sequence, ["fps", "frameRate", "frame-rate"]) || readTextChildAny(sequence, ["fps", "frameRate", "frame-rate", "timebase"]));
  if (direct && direct <= 240) return direct;
  const timebase = readPositiveNumber(attrAny(sequence, ["timebase", "Timebase"]) || readTextChildAny(sequence, ["timebase", "Timebase"]));
  if (timebase) {
    return timebase > 1000 ? PREMIERE_TICKS_PER_SECOND / timebase : timebase;
  }
  const frameDuration = readPrprojTimeValue(sequence, ["frameDuration", "frameDurationTicks"], DEFAULT_FPS);
  return frameDuration && frameDuration > 0 ? 1 / frameDuration : undefined;
}

function readPrprojDimension(sequence: XmlElement, names: string[]): number | undefined {
  return readPositiveNumber(attrAny(sequence, names) || readTextChildAny(sequence, names));
}

function readPrprojTimeValue(element: XmlElement, names: string[], fps: number): number | undefined {
  const value = attrAny(element, names) || readTextChildAny(element, names) || readTextDescendantAny(element, names);
  if (!value) return undefined;
  return parsePrprojTime(value, fps);
}

function parsePrprojTime(value: string, fps: number): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const timelineTime = parseTimelineTime(trimmed, fps);
  if (timelineTime !== undefined && /[/:;s]/i.test(trimmed)) {
    return timelineTime;
  }
  const number = Number.parseFloat(trimmed);
  if (!Number.isFinite(number)) {
    return undefined;
  }
  if (Math.abs(number) > 1_000_000) {
    return number / PREMIERE_TICKS_PER_SECOND;
  }
  return number / fps;
}

function readPrprojProjectTitle(document: XmlRoot): string {
  const project = elementsByLocalName(document, "project")[0];
  return readPrprojName(project) || "";
}

function readPrprojClipName(clip: XmlElement, objectIndex: PrprojObjectIndex): string {
  return readPrprojName(clip) || readPrprojReferencedName(clip, objectIndex) || readPrprojMediaName(clip, objectIndex);
}

function readPrprojMediaName(clip: XmlElement, objectIndex?: PrprojObjectIndex): string {
  const referencedName = objectIndex ? readPrprojReferencedName(clip, objectIndex) : "";
  return (
    referencedName ||
    readTextChildAny(clip, ["sourceName", "mediaName", "fileName", "actualMediaFilePath", "filePath", "relativePath", "path"]) ||
    readTextDescendantAny(clip, ["sourceName", "mediaName", "fileName", "actualMediaFilePath", "filePath", "relativePath", "path", "Title"]) ||
    decodeFileName(attrAny(clip, ["source", "src", "path", "filePath", "mediaPath"])) ||
    ""
  );
}

function readPrprojReferencedName(element: XmlElement, objectIndex: PrprojObjectIndex): string {
  for (const tagName of ["subclip", "masterclip", "clip", "media"]) {
    const refElement = firstChildByLocalName(element, tagName);
    if (!refElement) continue;
    const target = resolvePrprojReference(refElement, objectIndex);
    const name = readPrprojName(target) || (target ? readTextDescendantAny(target, ["Title", "fileName", "filePath", "actualMediaFilePath"]) : "");
    if (name) return decodeFileName(name) ?? name;
  }
  return "";
}

function readPrprojName(element: XmlElement | undefined): string {
  if (!element) return "";
  return attrAny(element, ["name", "Name", "displayName", "DisplayName"]) || readTextChildAny(element, ["name", "Name", "displayName", "DisplayName"]);
}

function readPrprojId(element: XmlElement): string {
  return attrAny(element, ["id", "ID", "ObjectID", "objectId", "ObjectRef", "ref"]) || readTextChildAny(element, ["id", "ID", "ObjectID", "objectId"]);
}

function isContainerClipList(element: XmlElement): boolean {
  const name = element.localName.toLowerCase();
  return name === "clips" || name === "clipitems" || name === "trackitems";
}

function parseTimelineTime(value: string, fps: number): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^\d{1,2}:\d{2}:\d{2}[:;]\d{2}$/.test(trimmed)) {
    return parseTimecode(trimmed, fps);
  }
  const rational = trimmed.match(/^(-?\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)s$/);
  if (rational) {
    const numerator = Number.parseFloat(rational[1] ?? "0");
    const denominator = Number.parseFloat(rational[2] ?? "1");
    return denominator ? numerator / denominator : undefined;
  }
  const seconds = trimmed.match(/^(-?\d+(?:\.\d+)?)s$/);
  if (seconds) {
    return Number.parseFloat(seconds[1] ?? "0");
  }
  const frames = Number.parseFloat(trimmed);
  return Number.isFinite(frames) ? frames / fps : undefined;
}

function parseTimecode(value: string, fps: number): number {
  const parts = value.replace(";", ":").split(":").map((part) => Number.parseInt(part, 10));
  const [hours = 0, minutes = 0, seconds = 0, frames = 0] = parts;
  return hours * 3600 + minutes * 60 + seconds + frames / fps;
}

function readFcpxmlFps(format: XmlElement | undefined, sequence: XmlElement | undefined): number | undefined {
  const frameDuration = attr(format, "frameDuration") || attr(sequence, "tcFormat");
  const match = frameDuration.match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)s$/);
  if (match) {
    const numerator = Number.parseFloat(match[1] ?? "0");
    const denominator = Number.parseFloat(match[2] ?? "0");
    return numerator > 0 && denominator > 0 ? denominator / numerator : undefined;
  }
  const seconds = parseTimelineTime(frameDuration, DEFAULT_FPS);
  return seconds && seconds > 0 ? 1 / seconds : undefined;
}

function parseXml(contents: string): XmlRoot | undefined {
  if (typeof DOMParser === "undefined") {
    return parseSimpleXml(contents);
  }
  const document = new DOMParser().parseFromString(contents, "application/xml");
  if (document.getElementsByTagName("parsererror").length > 0) {
    return undefined;
  }
  return document;
}

class SimpleXmlElement {
  readonly localName: string;
  readonly children: SimpleXmlElement[] = [];
  private readonly attributes = new Map<string, string>();
  private readonly textParts: string[] = [];

  constructor(localName: string, attributes: Record<string, string> = {}) {
    this.localName = localName;
    for (const [key, value] of Object.entries(attributes)) {
      this.attributes.set(key, value);
      const localKey = key.includes(":") ? key.split(":").pop() ?? key : key;
      this.attributes.set(localKey, value);
    }
  }

  get textContent(): string {
    return [...this.textParts, ...this.children.map((child) => child.textContent)].join("");
  }

  appendText(value: string) {
    if (value.trim()) {
      this.textParts.push(decodeXmlEntities(value));
    }
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  getElementsByTagName(tagName: string): SimpleXmlElement[] {
    const normalized = tagName.toLowerCase();
    const matches: SimpleXmlElement[] = [];
    const visit = (node: SimpleXmlElement) => {
      if (node.localName.toLowerCase() === normalized) {
        matches.push(node);
      }
      for (const child of node.children) {
        visit(child);
      }
    };
    visit(this);
    return matches;
  }
}

function parseSimpleXml(contents: string): SimpleXmlElement | undefined {
  const root = new SimpleXmlElement("#document");
  const stack: SimpleXmlElement[] = [root];
  const tokens = contents.match(/<!--[\s\S]*?-->|<[^>]+>|[^<]+/g) ?? [];
  for (const token of tokens) {
    if (token.startsWith("<!--") || token.startsWith("<?") || token.startsWith("<!")) {
      continue;
    }
    if (token.startsWith("</")) {
      const closingName = localXmlName(token.slice(2, -1).trim());
      while (stack.length > 1) {
        const current = stack.pop();
        if (current?.localName === closingName) {
          break;
        }
      }
      continue;
    }
    if (token.startsWith("<")) {
      const selfClosing = /\/>\s*$/.test(token);
      const body = token.slice(1, selfClosing ? -2 : -1).trim();
      const nameMatch = body.match(/^([^\s/>]+)/);
      if (!nameMatch?.[1]) {
        continue;
      }
      const rawName = nameMatch[1];
      const attributeSource = body.slice(rawName.length);
      const node = new SimpleXmlElement(localXmlName(rawName), readXmlAttributes(attributeSource));
      stack[stack.length - 1]?.children.push(node);
      if (!selfClosing) {
        stack.push(node);
      }
      continue;
    }
    stack[stack.length - 1]?.appendText(token);
  }
  return root.children[0] ?? root;
}

function readXmlAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const regex = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source))) {
    const key = match[1];
    if (!key) continue;
    attributes[key] = decodeXmlEntities(match[2] ?? match[3] ?? "");
  }
  return attributes;
}

function localXmlName(name: string): string {
  return (name.includes(":") ? name.split(":").pop() ?? name : name).toLowerCase();
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function elementsByTag(root: XmlRoot | XmlElement | undefined, tagName: string): XmlElement[] {
  if (!root) return [];
  return Array.from(root.getElementsByTagName(tagName) as unknown as ArrayLike<XmlElement>);
}

function elementsByLocalName(root: XmlRoot | XmlElement | undefined, tagName: string): XmlElement[] {
  if (!root) return [];
  const normalized = tagName.toLowerCase();
  const matches: XmlElement[] = [];
  const visit = (node: XmlRoot | XmlElement | undefined) => {
    if (!node) return;
    const children = Array.from(node.children as unknown as ArrayLike<XmlElement>);
    for (const child of children) {
      if (child.localName.toLowerCase() === normalized) {
        matches.push(child);
      }
      visit(child);
    }
  };
  visit(root);
  return matches;
}

function elementsByLocalNames(root: XmlRoot | XmlElement | undefined, tagNames: string[]): XmlElement[] {
  const names = new Set(tagNames.map((tagName) => tagName.toLowerCase()));
  if (!root) return [];
  const matches: XmlElement[] = [];
  const visit = (node: XmlRoot | XmlElement | undefined) => {
    if (!node) return;
    const children = Array.from(node.children as unknown as ArrayLike<XmlElement>);
    for (const child of children) {
      if (names.has(child.localName.toLowerCase())) {
        matches.push(child);
      }
      visit(child);
    }
  };
  visit(root);
  return matches;
}

function childElementsByTag(root: XmlElement | undefined, tagName: string): XmlElement[] {
  if (!root) return [];
  return Array.from(root.children as unknown as ArrayLike<XmlElement>).filter((child) => child.localName.toLowerCase() === tagName.toLowerCase());
}

function childElementsByLocalName(root: XmlElement | undefined, tagName: string): XmlElement[] {
  return childElementsByTag(root, tagName);
}

function firstChildByTag(root: XmlElement | undefined, tagName: string): XmlElement | undefined {
  return childElementsByTag(root, tagName)[0];
}

function firstChildByLocalName(root: XmlElement | undefined, tagName: string): XmlElement | undefined {
  return childElementsByLocalName(root, tagName)[0];
}

function textOf(element: XmlElement | undefined): string {
  return element?.textContent?.trim() ?? "";
}

function attr(element: XmlElement | undefined, name: string): string {
  return element?.getAttribute(name)?.trim() ?? "";
}

function attrAny(element: XmlElement | undefined, names: string[]): string {
  if (!element) return "";
  for (const name of names) {
    const variants = [name, name.toLowerCase(), name.toUpperCase(), `${name[0]?.toUpperCase() ?? ""}${name.slice(1)}`];
    for (const variant of variants) {
      const value = element.getAttribute(variant)?.trim();
      if (value) return value;
    }
  }
  return "";
}

function readTextChildAny(element: XmlElement | undefined, names: string[]): string {
  if (!element) return "";
  for (const name of names) {
    const child = firstChildByLocalName(element, name);
    const value = textOf(child);
    if (value) return value;
  }
  return "";
}

function readTextDescendantAny(element: XmlElement | undefined, names: string[]): string {
  if (!element) return "";
  const normalized = new Set(names.map((name) => name.toLowerCase()));
  const visit = (node: XmlElement): string => {
    const children = Array.from(node.children as unknown as ArrayLike<XmlElement>);
    for (const child of children) {
      if (normalized.has(child.localName.toLowerCase())) {
        const value = textOf(child);
        if (value) return value;
      }
      const nested = visit(child);
      if (nested) return nested;
    }
    return "";
  };
  return visit(element);
}

function readNumberFromChild(element: XmlElement, tagName: string): number | undefined {
  return readPositiveOrZeroNumber(textOf(firstChildByTag(element, tagName)));
}

function readPositiveNumber(value: string): number | undefined {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function readPositiveOrZeroNumber(value: string): number | undefined {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function groupClips(clips: ParsedTimelineClip[]): Array<[number, ParsedTimelineClip[]]> {
  const groups = new Map<number, ParsedTimelineClip[]>();
  for (const clip of clips) {
    const key = Math.max(0, clip.trackIndex);
    groups.set(key, [...(groups.get(key) ?? []), clip]);
  }
  return Array.from(groups.entries())
    .sort(([a], [b]) => a - b)
    .map(([index, items]) => [index, items.sort((a, b) => a.startSeconds - b.startSeconds)]);
}

function readEdlCommentValue(line: string, labels: string[]): string | undefined {
  for (const label of labels) {
    const regex = new RegExp(`^\\*\\s*${escapeRegExp(label)}\\s*:\\s*(.+)$`, "i");
    const match = line.match(regex);
    if (match?.[1]) return match[1].trim();
  }
  return undefined;
}

function decodeFileName(src: string | undefined): string | undefined {
  if (!src) return undefined;
  const withoutQuery = src.split(/[?#]/)[0] ?? src;
  const fileName = withoutQuery.split(/[\\/]/).filter(Boolean).pop();
  if (!fileName) return undefined;
  try {
    return decodeURIComponent(fileName);
  } catch {
    return fileName;
  }
}

function reportItem(section: TimelineImportReportSection, code: string, message: string, sourceId?: string): TimelineImportReportItem {
  return { section, code, message, ...(sourceId ? { sourceId } : {}) };
}

function looksLikeEdl(contents: string): boolean {
  return /^TITLE:/im.test(contents) && /^\s*\d+\s+\S+\s+\S+\s+\S+\s+\d\d:\d\d:\d\d[:;]\d\d/im.test(contents);
}

function stripExtension(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "") || "Imported timeline";
}

function sanitizeId(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "clip"
  );
}

function roundTime(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function formatSeconds(value: number): string {
  return `${roundTime(value).toFixed(3)}s`;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
