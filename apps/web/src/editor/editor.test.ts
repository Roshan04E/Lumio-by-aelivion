/**
 * Standalone assert script for the editor foundation (Phase 3). Repo convention:
 * no test framework — exits non-zero on first failure.
 *
 *   pnpm --filter @kimera-by-aelivion/web editor:test
 */
import { applyLayerAttributes, buildKimeraPackageZip, buildSceneDraws, buildTimelineTemplatePackage, clipCompositionToWorkArea, collectEditPoints, copyLayerAttributes, createBoxMask, createDefaultComposition, deriveNestBreadcrumb, ensureComposition, expandNestedCompositions, exportCompositionToFcpxml, findRootCompositionId, getCompositionVolume, getLayerSpeed, getLayerSpeedAt, getNestedSourceDurationSeconds, hasClipboardAttributes, healCompositionRegistry, isKimeraPackageZipBytes, layerSourceTimeSeconds, mapExternalTransition, nestLayersIntoComposition, nestParentClipId, parseExternalTimelineFile, parseKimeraPackageZip, pasteLayerAttributes, rippleTrimLayer, rollEditAtCut, rollEditLimits, slideLayer, snapshotLayerAttributes, splitLayerAtTime, stampCompositionRegistry, trimLayerEdgeTo, trimLayerKeyframesTo, unnestClip, wouldCreateCompositionCycle, type ProjectGraph, type TimelineLayer, type SourceAsset } from "@kimera-by-aelivion/shared";
import { editorStore } from "./state/editorStore";
import { moduleRegistry } from "./registry/modules";
import { commandRegistry } from "./registry/commands";
import { inspectorRegistry } from "./registry/inspector";
import { seedBuiltinRegistries } from "./registry/builtins";
import {
  baseCompositionSignature,
  compositionCacheLayers,
  compositionCacheSignature,
  createFrameCache,
  createPreviewCacheController,
  createPreviewRenderCacheStore,
  planAdaptiveCacheSpans,
  previewCacheRulerSegments,
  summarizePreviewCacheStatus,
  type TimelineCacheLayerInput
} from "./performance/renderCache";
import { layersInRange, playheadRange } from "./performance/visibleRange";
import { getPreviewQualityProfile } from "./performance/previewQuality";

let failures = 0;
function check(name: string, condition: boolean): void {
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${name}`);
  }
}

// --- Store: mutation routes through the action registry, with undo/redo -------
{
  const composition = createDefaultComposition({ id: "edit", name: "Edit", durationSeconds: 12 });
  const store = editorStore.getState();
  store.setComposition(composition);

  const outcome = store.runAction("addText", { text: "WARNING", color: "#ff0000", size: 120 }, { ai: true });
  check("runAction succeeds", outcome.ok);

  const afterAdd = editorStore.getState().composition!;
  const hasWarning = afterAdd.tracks.flatMap((track) => track.layers).some((layer) => layer.text === "WARNING");
  check("store applied the action", hasWarning);
  check("undo available", editorStore.getState().canUndo());

  editorStore.getState().undo();
  const afterUndo = editorStore.getState().composition!;
  check("undo restores prior composition", afterUndo.tracks.flatMap((t) => t.layers).every((l) => l.text !== "WARNING"));
  check("redo available", editorStore.getState().canRedo());

  editorStore.getState().redo();
  check("redo re-applies", editorStore.getState().composition!.tracks.flatMap((t) => t.layers).some((l) => l.text === "WARNING"));

  store.runAction("noSuchAction", {});
  check("invalid action does not mutate", editorStore.getState().composition === editorStore.getState().composition);
}

// --- Registries: builtins seed describes shared definitions -------------------
{
  seedBuiltinRegistries();
  seedBuiltinRegistries(); // idempotent
  check("modules seeded from tools", moduleRegistry.byType("tool").length > 0);
  check("modules seeded from effects", moduleRegistry.byType("effect").length > 0);
  check("AI commands registered", commandRegistry.byCategory("AI").length === 6);

  const caps = {
    webWorkers: true,
    offscreenCanvas: false,
    webCodecs: false,
    webGpu: false,
    opfs: true,
    audioContext: true,
    sharedArrayBuffer: false,
    crossOriginIsolated: false
  };
  moduleRegistry.register({ id: "needs-gpu", name: "GPU thing", type: "engine", requiredCapabilities: ["webGpu"] });
  check("capability gating rejects unavailable", !moduleRegistry.isAvailable("needs-gpu", caps));
  check("migrated text.warp inspector panel is registered", inspectorRegistry.panelsFor("text").some((p) => p.id === "text.warp"));
  check("inspector panels are type-scoped", inspectorRegistry.panelsFor("audio").every((p) => p.id !== "text.warp"));
}

// --- Performance primitives ---------------------------------------------------
{
  const composition = createDefaultComposition({ id: "perf", name: "Perf", durationSeconds: 12 });
  const visible = layersInRange(composition, playheadRange(0, 1));
  check("visible-range returns intersecting layers", visible.length > 0);
  check("preview profiles scale down for performance", getPreviewQualityProfile("performance").resolutionScale < 1);
  const workAreaComposition = createDefaultComposition({ id: "clip-workarea", name: "Clip Work Area", durationSeconds: 60 });
  const clipped = clipCompositionToWorkArea({
    ...workAreaComposition,
    settings: {
      ...workAreaComposition.settings,
      timeline: {
        ...workAreaComposition.settings.timeline,
        inPointSeconds: 32,
        outPointSeconds: 37
      }
    }
  });
  const clippedVideo = clipped.tracks.flatMap((track) => track.layers).find((layer) => layer.type === "video");
  check("work-area clip advances implicit media source time", clippedVideo?.startSeconds === 0 && clippedVideo.sourceInSeconds === 32);
  check("work-area clip uses range duration", Math.abs(clipped.durationSeconds - 5) < 0.001 && clippedVideo?.durationSeconds === 5);

  // REGRESSION (project-tracker/timeline.md v1): the work-area clip rebased sourceInSeconds and the
  // speed ramp onto the trimmed head but left the KEYFRAMES behind, so exporting with an in-point that
  // cut into a keyframed clip rendered every key `trimmedFromHead` seconds late. Local export runs this
  // (clipCompositionToWorkArea), so the bug was export-only and invisible in the editor.
  {
    const base = createDefaultComposition({ id: "wa-kf", name: "Work Area Keyframes", durationSeconds: 60 });
    const source = base.tracks.flatMap((track) => track.layers).find((layer) => layer.type === "video")!;
    const animation = (timeSeconds: number, value: number) => ({
      id: `kf_${timeSeconds}`,
      target: { scope: "layer" as const, property: "transform.opacity" },
      timeSeconds,
      value,
      interpolation: "linear" as const,
      temporal: {}
    });
    const keyed: TimelineLayer = {
      ...source,
      startSeconds: 30,
      durationSeconds: 10,
      sourceInSeconds: 0,
      // V1 (absolute composition time): one inside the window, one before the in-point.
      keyframes: [
        { id: "v1_in", property: "opacity", timeSeconds: 34, value: 50, easing: "linear" },
        { id: "v1_cut", property: "opacity", timeSeconds: 31, value: 10, easing: "linear" }
      ],
      // V2 (layer-local): 0 and 1 fall in the removed head, 8 falls past the new tail.
      animations: [animation(0, 0), animation(1, 10), animation(2, 25), animation(5, 100), animation(8, 100)]
    };
    const clippedKf = clipCompositionToWorkArea({
      ...base,
      tracks: base.tracks.map((track, index) => (index === 0 ? { ...track, layers: [keyed] } : { ...track, layers: [] })),
      settings: { ...base.settings, timeline: { ...base.settings.timeline, inPointSeconds: 32, outPointSeconds: 37 } }
    });
    const layer = clippedKf.tracks.flatMap((track) => track.layers).find((item) => item.id === keyed.id);
    const times = (layer?.animations ?? []).map((item) => item.timeSeconds);
    // Head trim = 2s (in-point 32 into a clip starting at 30), new span = 5s.
    check("work-area clip drops v2 keys inside the removed head", !times.some((t) => t < 0));
    check("work-area clip rebases v2 keys with the content", times.length === 2 && Math.abs(times[0]! - 0) < 0.001 && Math.abs(times[1]! - 3) < 0.001);
    check("work-area clip drops v2 keys past the new tail", !times.some((t) => t > 5.001));
    // V1 keys are ABSOLUTE, so they follow the clip's move to the new t=0 origin (−inPoint), and the
    // one before the in-point is cut.
    const v1 = layer?.keyframes ?? [];
    check("work-area clip cuts v1 keys outside the window", v1.length === 1 && v1[0]!.id === "v1_in");
    check("work-area clip shifts surviving v1 keys to the new origin", Math.abs((v1[0]?.timeSeconds ?? -1) - 2) < 0.001);
    // The content rebase that already worked must not regress.
    check("work-area clip still advances source time", layer?.sourceInSeconds === 2 && layer.startSeconds === 0 && layer.durationSeconds === 5);
  }

  const cache = createFrameCache<string>(2);
  cache.set({ signature: "a", timeSeconds: 0 }, "f0");
  cache.set({ signature: "a", timeSeconds: 1 }, "f1");
  cache.set({ signature: "a", timeSeconds: 2 }, "f2"); // evicts oldest
  check("frame cache hit", cache.get({ signature: "a", timeSeconds: 2 }) === "f2");
  check("frame cache LRU eviction", cache.get({ signature: "a", timeSeconds: 0 }) === undefined);
}

// --- External timeline imports -----------------------------------------------
{
  const prproj = parseExternalTimelineFile({
    fileName: "simple-premiere.prproj",
    projectId: "prproj_test",
    projectTitle: "PRPROJ Test",
    contents: `<?xml version="1.0" encoding="UTF-8"?>
<PremiereData Version="3">
  <Project ObjectID="1" Name="Premiere Demo" />
  <Sequence ObjectID="seq_1" Name="Main Sequence" Timebase="30" Width="1920" Height="1080">
    <VideoTrack Index="0">
      <ClipItem ObjectID="v1" Name="A001_C001.mov" Start="0" End="90" In="30" MediaPath="file:///A001_C001.mov">
        <Transition Name="Cross Dissolve" Duration="15" />
      </ClipItem>
    </VideoTrack>
    <AudioTrack Index="0">
      <ClipItem ObjectID="a1" Name="A001_C001.wav" Type="audio" Start="0" End="90" In="30" MediaPath="file:///A001_C001.wav" />
    </AudioTrack>
    <Effect Name="Lumetri Color" />
  </Sequence>
  <Sequence ObjectID="seq_2" Name="B Roll">
    <VideoTrack><ClipItem ObjectID="v2" Name="B.mov" Start="0" End="30" /></VideoTrack>
  </Sequence>
</PremiereData>`
  });
  const clips = prproj.composition.tracks.flatMap((track) => track.layers);
  check("prproj import detects format", prproj.report.format === "prproj");
  check("prproj import uses first sequence", prproj.report.title === "Main Sequence");
  check("prproj import creates video/audio placeholders", prproj.report.counts.videoClips === 1 && prproj.report.counts.audioClips === 1 && clips.length === 2);
  check("prproj import converts frame times", clips.some((layer) => layer.name === "A001_C001.mov" && layer.startSeconds === 0 && layer.durationSeconds === 3 && layer.sourceInSeconds === 1));
  check("prproj import maps obvious dissolve", prproj.report.counts.transitionsMapped === 1 && clips.some((layer) => layer.transitionIn?.kind === "crossDissolve"));
  check("prproj import maps sequence selection", prproj.report.mapped.some((item) => item.code === "prproj.multiple_sequences"));
  check("prproj import reports unsupported project features", prproj.report.unsupported.some((item) => item.code === "prproj.effects"));

  // Multi-sequence picker (Task 2.3): every sequence is surfaced, and re-parsing with a chosen
  // sequenceId selects it instead of the "most clips" heuristic.
  check(
    "prproj import lists every sequence for the picker",
    prproj.report.availableSequences?.length === 2 &&
      prproj.report.availableSequences.some((s) => s.name === "Main Sequence" && s.selected) &&
      prproj.report.availableSequences.some((s) => s.name === "B Roll" && !s.selected)
  );
  const bRollSequenceId = prproj.report.availableSequences?.find((s) => s.name === "B Roll")?.id;
  const prprojReparsed = bRollSequenceId
    ? parseExternalTimelineFile({
        fileName: "simple-premiere.prproj",
        projectId: "prproj_test",
        projectTitle: "PRPROJ Test",
        sequenceId: bRollSequenceId,
        contents: `<?xml version="1.0" encoding="UTF-8"?>
<PremiereData Version="3">
  <Project ObjectID="1" Name="Premiere Demo" />
  <Sequence ObjectID="seq_1" Name="Main Sequence" Timebase="30" Width="1920" Height="1080">
    <VideoTrack Index="0">
      <ClipItem ObjectID="v1" Name="A001_C001.mov" Start="0" End="90" In="30" MediaPath="file:///A001_C001.mov">
        <Transition Name="Cross Dissolve" Duration="15" />
      </ClipItem>
    </VideoTrack>
    <AudioTrack Index="0">
      <ClipItem ObjectID="a1" Name="A001_C001.wav" Type="audio" Start="0" End="90" In="30" MediaPath="file:///A001_C001.wav" />
    </AudioTrack>
    <Effect Name="Lumetri Color" />
  </Sequence>
  <Sequence ObjectID="seq_2" Name="B Roll">
    <VideoTrack><ClipItem ObjectID="v2" Name="B.mov" Start="0" End="30" /></VideoTrack>
  </Sequence>
</PremiereData>`
      })
    : undefined;
  check("prproj re-parse with sequenceId selects that sequence", prprojReparsed?.report.title === "B Roll");

  const graphPrproj = parseExternalTimelineFile({
    fileName: "object-graph.prproj",
    projectId: "prproj_graph",
    projectTitle: "PRPROJ Graph",
    contents: `<?xml version="1.0" encoding="UTF-8"?>
<PremiereData Version="3">
  <Project ObjectID="1" Name="Object Graph Demo" />
  <Sequence ObjectUID="seq_uid" Name="Referenced Sequence" Timebase="30">
    <TrackGroups>
      <TrackGroup Index="0">
        <Second ObjectRef="video_group" />
      </TrackGroup>
      <TrackGroup Index="1">
        <Second ObjectRef="audio_group" />
      </TrackGroup>
    </TrackGroups>
  </Sequence>
  <VideoTrackGroup ObjectID="video_group">
    <Tracks>
      <Track Index="0" ObjectURef="video_track_1" />
    </Tracks>
  </VideoTrackGroup>
  <VideoClipTrack ObjectID="video_track_1">
    <Track>
      <ID>video_track_1</ID>
    </Track>
    <ClipItems>
      <ClipItem Index="0" ObjectRef="video_clip_1" />
    </ClipItems>
  </VideoClipTrack>
  <ClipTrackItem ObjectID="video_clip_1" Name="Graph Video.mov" In="15" MediaPath="file:///Graph%20Video.mov">
    <TrackItem>
      <Start>30</Start>
      <End>90</End>
    </TrackItem>
  </ClipTrackItem>
  <AudioTrackGroup ObjectID="audio_group">
    <Tracks>
      <Track Index="0" ObjectRef="audio_track_1" />
    </Tracks>
  </AudioTrackGroup>
  <AudioClipTrack ObjectID="audio_track_1">
    <ClipItems>
      <ClipItem Index="0" ObjectRef="audio_clip_1" />
    </ClipItems>
  </AudioClipTrack>
  <ClipTrackItem ObjectID="audio_clip_1" Name="Graph Audio.wav" In="15" MediaPath="file:///Graph%20Audio.wav">
    <TrackItem>
      <Start>30</Start>
      <End>90</End>
    </TrackItem>
  </ClipTrackItem>
</PremiereData>`
  });
  const graphClips = graphPrproj.composition.tracks.flatMap((track) => track.layers);
  check("prproj object graph resolves referenced clips", graphClips.length === 2 && graphPrproj.report.counts.videoClips === 1 && graphPrproj.report.counts.audioClips === 1);
  check("prproj object graph preserves referenced clip timing", graphClips.some((layer) => layer.name === "Graph Video.mov" && layer.startSeconds === 1 && layer.durationSeconds === 2 && layer.sourceInSeconds === 0.5));

  const fallbackPrproj = parseExternalTimelineFile({
    fileName: "fallback-premiere.prproj",
    projectId: "prproj_fallback",
    projectTitle: "PRPROJ Fallback",
    contents: `<?xml version="1.0" encoding="UTF-8"?>
<PremiereData Version="3">
  <Sequence ObjectUID="empty_seq" Name="Placeholder_1">
    <TrackGroupRef><Second ObjectRef="empty_group" /></TrackGroupRef>
  </Sequence>
  <Sequence ObjectUID="nested_title_seq" Name="NestedTitle">
    <TrackGroupRef><Second ObjectRef="title_group" /></TrackGroupRef>
  </Sequence>
  <Sequence ObjectUID="work_seq" Name="Work">
    <TrackGroupRef><Second ObjectRef="work_group" /></TrackGroupRef>
  </Sequence>
  <VideoTrackGroup ObjectID="empty_group">
    <Tracks><Track ObjectRef="empty_track" /></Tracks>
  </VideoTrackGroup>
  <VideoClipTrack ObjectID="empty_track"><ClipItems /></VideoClipTrack>
  <VideoTrackGroup ObjectID="title_group">
    <Tracks><Track ObjectRef="title_track" /></Tracks>
  </VideoTrackGroup>
  <VideoClipTrack ObjectID="title_track">
    <ClipItems><TrackItem ObjectRef="title_graphic_clip" /></ClipItems>
  </VideoClipTrack>
  <VideoClipTrackItem ObjectID="title_graphic_clip"><ClipTrackItem><TrackItem><Start>0</Start><End>60</End></TrackItem><SubClip ObjectRef="title_graphic_subclip" Name="Graphic" /></ClipTrackItem></VideoClipTrackItem>
  <SubClip ObjectID="title_graphic_subclip"><Name>Graphic</Name></SubClip>
  <VideoTrackGroup ObjectID="work_group">
    <Tracks><Track ObjectRef="work_track" /></Tracks>
  </VideoTrackGroup>
  <VideoClipTrack ObjectID="work_track">
    <ClipItems>
      <ClipItem ObjectRef="work_clip_1" />
      <ClipItem ObjectRef="work_clip_2" />
      <ClipItem ObjectRef="work_nested_clip" />
    </ClipItems>
  </VideoClipTrack>
  <ClipTrackItem ObjectID="work_clip_1" Name="Fallback A.mov"><TrackItem><Start>0</Start><End>30</End></TrackItem></ClipTrackItem>
  <ClipTrackItem ObjectID="work_clip_2" Name="Fallback B.mov"><TrackItem><Start>30</Start><End>60</End></TrackItem></ClipTrackItem>
  <VideoClipTrackItem ObjectID="work_nested_clip"><ClipTrackItem><TrackItem><Start>60</Start><End>120</End></TrackItem><SubClip ObjectRef="work_nested_subclip" Name="NestedTitle" /></ClipTrackItem></VideoClipTrackItem>
  <SubClip ObjectID="work_nested_subclip"><Name>NestedTitle</Name></SubClip>
</PremiereData>`
  });
  const fallbackClips = fallbackPrproj.composition.tracks.flatMap((track) => track.layers);
  const nestedLayer = fallbackClips.find((layer) => layer.name === "NestedTitle");
  const nestedComposition = nestedLayer?.nestedCompositionId ? fallbackPrproj.graph.compositions?.[nestedLayer.nestedCompositionId] : undefined;
  const nestedTextLayer = nestedComposition?.tracks.flatMap((track) => track.layers).find((layer) => layer.type === "text");
  check("prproj fallback selects the clip-heavy sequence", fallbackPrproj.report.title === "Work" && fallbackClips.length === 3);
  check("prproj fallback reports object-reference parsing", fallbackPrproj.report.mapped.some((item) => item.code === "prproj.text_object_graph"));
  check("prproj fallback preserves nested sequence clips", Boolean(nestedLayer?.nestedCompositionId && fallbackPrproj.report.mapped.some((item) => item.code === "prproj.nested_sequences")));
  check("prproj fallback maps nested graphics to text layers", nestedComposition?.name === "NestedTitle" && nestedTextLayer?.text === "Text");

  // FCPXML fidelity (Task 2.2): title -> text layer, transition mapping, opacity keyframe.
  const fcpxml = parseExternalTimelineFile({
    fileName: "titled-transition.fcpxml",
    projectId: "fcpxml_fidelity",
    projectTitle: "FCPXML Fidelity Test",
    contents: `<?xml version="1.0" encoding="UTF-8"?>
<fcpxml version="1.10">
  <resources>
    <format id="r1" name="FFVideoFormat1080p30" frameDuration="1/30s" width="1920" height="1080"/>
    <asset id="r2" name="city-wide.mov" src="file:///Volumes/Media/city-wide.mov" duration="8s"/>
    <asset id="r3" name="bus-closeup.mov" src="file:///Volumes/Media/bus-closeup.mov" duration="6s"/>
  </resources>
  <library>
    <event name="Kimera Import Tests">
      <project name="Titled Transition FCPXML">
        <sequence format="r1" duration="12s">
          <spine>
            <asset-clip name="City Wide" ref="r2" offset="0s" start="0s" duration="5s">
              <adjust-opacity>
                <keyframe time="0s" value="0"/>
                <keyframe time="1s" value="1"/>
              </adjust-opacity>
            </asset-clip>
            <transition name="Cross Dissolve" offset="4s" duration="1s"/>
            <asset-clip name="Bus Closeup" ref="r3" offset="5s" start="1s" duration="5s"/>
            <title name="Intro Title" offset="10s" duration="2s">
              <text>Hello Kimera</text>
            </title>
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>`
  });
  const fcpxmlClips = fcpxml.composition.tracks.flatMap((track) => track.layers);
  const titleLayer = fcpxmlClips.find((layer) => layer.type === "text");
  const busLayer = fcpxmlClips.find((layer) => layer.name === "Bus Closeup");
  const cityLayer = fcpxmlClips.find((layer) => layer.name === "City Wide");
  check("fcpxml import detects format", fcpxml.report.format === "fcpxml");
  check("fcpxml title maps to an editable text layer", titleLayer?.text === "Hello Kimera");
  check("fcpxml reports the title mapping", fcpxml.report.mapped.some((item) => item.code === "fcpxml.title"));
  check("fcpxml transition maps to crossDissolve on the incoming clip", busLayer?.transitionIn?.kind === "crossDissolve");
  check("fcpxml reports the transition mapping", fcpxml.report.mapped.some((item) => item.code === "fcpxml.transition"));
  check("fcpxml opacity keyframes land on the outgoing clip's animations", (cityLayer?.animations?.length ?? 0) >= 2);
}

// --- Adaptive preview cache spans --------------------------------------------
{
  const longClip: TimelineCacheLayerInput = {
    id: "clip-1",
    type: "video",
    startSeconds: 0,
    durationSeconds: 300
  };
  const longPlan = planAdaptiveCacheSpans({ durationSeconds: 300, layers: [longClip], playheadSeconds: 120 });
  check("adaptive cache uses long spans for simple media", longPlan.length <= 8);
  check("adaptive cache covers full duration", longPlan[0]?.startSeconds === 0 && longPlan.at(-1)?.endSeconds === 300);
  check("adaptive cache spans are ordered", longPlan.every((span, index) => index === 0 || longPlan[index - 1]!.endSeconds <= span.startSeconds));

  const denseLayers: TimelineCacheLayerInput[] = [
    longClip,
    {
      id: "title",
      type: "text",
      startSeconds: 95,
      durationSeconds: 25,
      effects: [{ id: "glow" }]
    },
    {
      id: "clip-2",
      type: "video",
      startSeconds: 120,
      durationSeconds: 60,
      transitionIn: { durationSeconds: 1.5 }
    }
  ];
  const densePlan = planAdaptiveCacheSpans({
    durationSeconds: 300,
    layers: denseLayers,
    playheadSeconds: 118,
    dirtyLayerIds: ["title"]
  });
  check("adaptive cache isolates dirty spans", densePlan.some((span) => span.reason === "dirty" && span.layerIds.includes("title")));
  check("adaptive cache isolates transition spans", densePlan.some((span) => span.reason === "transition" && span.startSeconds <= 120 && span.endSeconds > 120 && span.endSeconds <= 121.5));
  check("adaptive cache keeps complex spans short", densePlan.filter((span) => span.reason !== "simple").every((span) => span.endSeconds - span.startSeconds <= 8.001));

  const playheadSpan = densePlan.find((span) => span.startSeconds <= 118 && span.endSeconds > 118);
  const farSpan = densePlan.find((span) => span.startSeconds >= 240);
  check("adaptive cache prioritizes playhead area", !!playheadSpan && !!farSpan && playheadSpan.priority > farSpan.priority);
}

// --- Preview render cache manifest -------------------------------------------
{
  const composition = createDefaultComposition({ id: "cache", name: "Cache", durationSeconds: 60 });
  const layers = compositionCacheLayers(composition);
  const signature = compositionCacheSignature(composition, 0.5);
  const fullSignature = compositionCacheSignature(composition, 1);
  check("composition cache extracts layers", layers.length > 0);
  check("composition cache signature includes render scale", signature !== fullSignature);

  const plan = planAdaptiveCacheSpans({
    durationSeconds: composition.durationSeconds,
    layers,
    playheadSeconds: 5,
    maxSimpleSpanSeconds: 20
  });
  const store = createPreviewRenderCacheStore({ maxEntries: 3, maxBytes: 10_000 });
  const pending = store.reconcile(plan, signature, 0.5, 1000);
  check("preview cache manifest creates pending work", pending.length > 0);
  check("preview cache manifest chooses next pending", store.nextPending()?.id === pending[0]?.id);

  const first = pending[0]!;
  store.upsert({ ...first, status: "ready", byteSize: 4000, url: "blob:first", lastUsedAt: 2000 });
  check("preview cache hits ready span", store.getReadySpan(first.startSeconds + 0.1, signature, 0.5)?.url === "blob:first");
  check("preview cache misses wrong signature", store.getReadySpan(first.startSeconds + 0.1, fullSignature, 0.5) === undefined);
  check("preview cache dirty invalidates overlap", store.markDirty({ startSeconds: first.startSeconds, endSeconds: first.endSeconds }) === 1);
  check("preview cache dirty span no longer hits", store.getReadySpan(first.startSeconds + 0.1, signature, 0.5) === undefined);

  const synthetic = (index: number) => ({
    id: `synthetic-${index}`,
    signature,
    startSeconds: index,
    endSeconds: index + 1,
    reason: "simple" as const,
    status: "ready" as const,
    priority: 1,
    layerIds: [],
    renderScale: 0.5,
    createdAt: index,
    lastUsedAt: index,
    byteSize: 4000
  });
  store.upsert(synthetic(1));
  store.upsert(synthetic(2));
  store.upsert(synthetic(3));
  store.upsert(synthetic(4));
  check("preview cache enforces entry and byte budget", store.size <= 3 && store.byteSize <= 10_000);
}

// --- Preview cache controller -------------------------------------------------
{
  const composition = createDefaultComposition({ id: "controller", name: "Controller", durationSeconds: 90 });
  const controller = createPreviewCacheController({ maxEntries: 20 });
  const first = controller.update({
    composition,
    renderScale: 0.5,
    playheadSeconds: 10,
    maxSimpleSpanSeconds: 30,
    now: 1000
  });
  const second = controller.update({
    composition,
    renderScale: 0.5,
    playheadSeconds: 11,
    maxSimpleSpanSeconds: 30,
    now: 2000
  });
  check("preview cache controller plans from composition", first.plannedSpans.length > 0);
  check("preview cache controller does not duplicate pending spans", first.pendingSpans.length > 0 && second.pendingSpans.length === 0);
  check("preview cache controller exposes next work", !!second.nextPending);

  const playheadPending = first.pendingSpans.find((span) => span.startSeconds <= 10 && span.endSeconds > 10)!;
  controller.store.upsert({ ...playheadPending, status: "ready", byteSize: 2048, url: "blob:playhead", lastUsedAt: 3000 });
  const afterReady = controller.update({
    composition,
    renderScale: 0.5,
    playheadSeconds: 10,
    maxSimpleSpanSeconds: 30,
    now: 4000
  });
  check("preview cache controller returns ready playhead span", afterReady.readySpan?.url === "blob:playhead");
  check("preview cache controller dirties by time range", controller.markDirty({ startSeconds: playheadPending.startSeconds, endSeconds: playheadPending.endSeconds }) === 1);

  const ranged = controller.update({
    composition,
    renderScale: 0.5,
    playheadSeconds: 42,
    targetRange: { startSeconds: 30, endSeconds: 45 },
    maxSimpleSpanSeconds: 30,
    now: 5000
  });
  check("preview cache controller targets in/out range", ranged.plannedSpans.every((span) => span.startSeconds >= 30 && span.endSeconds <= 45));

  const rulerSegments = previewCacheRulerSegments({
    entries: controller.store.entries,
    durationSeconds: composition.durationSeconds,
    visibleRange: { startSeconds: 0, endSeconds: 30 }
  });
  check("preview cache ruler exposes visible proxy segments", rulerSegments.length > 0);
  check("preview cache ruler clips to visible range", rulerSegments.every((segment) => segment.startPercent >= 0 && segment.endPercent <= 100));

  const liveController = createPreviewCacheController({ maxEntries: 20 });
  const live = liveController.update({
    composition,
    renderScale: 0.5,
    playheadSeconds: 5,
    maxSimpleSpanSeconds: 30,
    now: 6000
  });
  liveController.markFrameRendered({
    signature: live.signature,
    renderScale: 0.5,
    timeSeconds: 5,
    frameDurationSeconds: 1,
    now: 6100
  });
  const liveSegments = previewCacheRulerSegments({ entries: liveController.store.entries, durationSeconds: composition.durationSeconds });
  check("preview cache live coverage does not fake ready", !liveSegments.some((segment) => segment.status === "ready"));
  check("preview cache live coverage is visible", liveSegments.some((segment) => segment.status === "live"));
  const livePending = liveController.store.nextPending();
  check("preview cache live coverage keeps generation pending", livePending !== undefined);
  const liveStatus = summarizePreviewCacheStatus(liveController.store.entries);
  check("preview cache live coverage is telemetry", liveStatus.live > 0 && liveStatus.readyWithUrl === 0);
  if (livePending) {
    liveController.store.markSpanReady({
      id: livePending.id,
      signature: live.signature,
      contentSignature: livePending.contentSignature,
      url: "blob:real-proxy",
      byteSize: 4096,
      now: 6200
    });
  }
  const realProxySegments = previewCacheRulerSegments({ entries: liveController.store.entries, durationSeconds: composition.durationSeconds });
  check("preview cache ruler shows green only for real proxy media", realProxySegments.some((segment) => segment.status === "ready"));
  check("preview cache real proxy replaces live coverage", !realProxySegments.some((segment) => segment.status === "live"));
}

// --- Local invalidation + real-time status (per-span content signatures) -----
{
  const base = "base-signature";
  const scale = 0.5;
  const clip: TimelineCacheLayerInput = { id: "clip", type: "video", startSeconds: 0, durationSeconds: 40 };

  const store = createPreviewRenderCacheStore({ maxEntries: 500, maxBytes: 1_000_000_000 });
  const plan1 = planAdaptiveCacheSpans({ durationSeconds: 40, layers: [clip], maxSimpleSpanSeconds: 8 });
  const pending1 = store.reconcile(plan1, base, scale, 1000);
  for (const span of pending1) {
    store.markSpanReady({ id: span.id, signature: base, contentSignature: span.contentSignature, url: `blob:${span.id}`, byteSize: 1000, now: 1100 });
  }
  const readyBefore = store.entries.filter((span) => span.status === "ready").length;
  check("local invalidation: baseline seals every span ready", readyBefore === pending1.length && readyBefore > 2);

  // Add a small text overlay at 20-22s — only the cell it touches should reset.
  const text: TimelineCacheLayerInput = { id: "txt", type: "text", startSeconds: 20, durationSeconds: 2 };
  const plan2 = planAdaptiveCacheSpans({ durationSeconds: 40, layers: [clip, text], maxSimpleSpanSeconds: 8 });
  store.reconcile(plan2, base, scale, 2000);
  const entries2 = store.entries;
  const distantReady = entries2.filter((span) => span.status === "ready" && (span.endSeconds <= 20 || span.startSeconds >= 22));
  const overlapping = entries2.filter((span) => span.startSeconds < 22 && span.endSeconds > 20);
  check("local invalidation: distant proxies stay ready", distantReady.length > 0);
  check("local invalidation: edit does not wipe the timeline", store.entries.some((span) => span.status === "ready"));
  check("local invalidation: only overlapping spans reset", overlapping.length > 0 && overlapping.every((span) => span.status !== "ready"));

  // Editing keeps the base signature stable (so the whole store is NOT pruned on an edit).
  const comp = createDefaultComposition({ id: "sig", name: "Sig", durationSeconds: 40 });
  check("base signature is stable across render, unaffected by layers", baseCompositionSignature(comp) === baseCompositionSignature({ ...comp, durationSeconds: 41 }));
}

// --- Duplicate layer ids heal by RE-ID, never by deletion ---------------------
// An id collision (Date.now()-based generator, two layers in one millisecond) used to render fine
// and then the DEDUPE healer silently deleted one clip on the user's next edit ("I trimmed a clip
// and it got deleted", 2026-07-04). Healing must preserve every layer and only restore uniqueness.
{
  const comp = createDefaultComposition({ id: "dup", name: "Dup", durationSeconds: 10 });
  const track0 = comp.tracks.find((track) => track.type !== "audio")!;
  const twin: TimelineLayer = {
    id: "dup_layer",
    trackId: track0.id,
    type: "text",
    name: "Twin A",
    startSeconds: 0,
    durationSeconds: 2,
    fontFamily: "Inter",
    fontSize: 64,
    color: "#ffffff",
    transform: { position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 100 },
    effects: [],
    keyframes: []
  };
  const dupComp = {
    ...comp,
    tracks: comp.tracks.map((track) =>
      track.id === track0.id ? { ...track, layers: [...track.layers, twin, { ...twin, name: "Twin B" }] } : track
    )
  };
  const before = dupComp.tracks.flatMap((track) => track.layers).length;
  const graphOf = (composition: typeof comp) => ({ composition }) as unknown as Parameters<typeof ensureComposition>[0];
  const healedComp = ensureComposition(graphOf(dupComp), { name: "Dup", durationSeconds: 10 });
  const healedLayers = healedComp.tracks.flatMap((track) => track.layers);
  check("id healing preserves every layer (re-id, never delete)", healedLayers.length === before);
  check("id healing restores uniqueness", new Set(healedLayers.map((layer) => layer.id)).size === healedLayers.length);
  check("id healing keeps both twins' content", healedLayers.filter((layer) => layer.name.startsWith("Twin")).length === 2);
  check("id healing is a same-reference no-op when ids are unique", ensureComposition(graphOf(comp), { name: "Dup", durationSeconds: 10 }) === comp);
}

// --- Quality switches reuse sharper proxies (scale is a span FIELD, not a signature) ----
// A proxy captured at 1× serves ½ and ¼ previews as-is (downscaling is free) — switching quality
// DOWN must not regenerate anything; only an UPGRADE past the stored scale queues real work.
{
  const base = "scale-signature";
  const clip: TimelineCacheLayerInput = { id: "clip", type: "video", startSeconds: 0, durationSeconds: 40 };
  const plan = planAdaptiveCacheSpans({ durationSeconds: 40, layers: [clip], maxSimpleSpanSeconds: 8 });

  const store = createPreviewRenderCacheStore({ maxEntries: 500, maxBytes: 1_000_000_000 });
  const pendingFull = store.reconcile(plan, base, 1, 1000);
  for (const span of pendingFull) {
    store.markSpanReady({
      id: span.id,
      signature: base,
      contentSignature: span.contentSignature,
      url: `blob:${span.id}`,
      byteSize: 1000,
      renderScale: 1,
      startSeconds: span.startSeconds,
      endSeconds: span.endSeconds,
      now: 1100
    });
  }
  const pendingQuarter = store.reconcile(plan, base, 0.25, 2000);
  check("quality downgrade queues no regeneration", pendingQuarter.length === 0);
  check("quality downgrade serves the sharper proxy", store.getReadySpan(1, base, 0.25)?.url !== undefined);
  check("sharper spans survive the downgrade reconcile", store.entries.length === pendingFull.length && store.entries.every((span) => span.status === "ready"));

  const storeUp = createPreviewRenderCacheStore({ maxEntries: 500, maxBytes: 1_000_000_000 });
  const pendingHalf = storeUp.reconcile(plan, base, 0.5, 1000);
  for (const span of pendingHalf) {
    storeUp.markSpanReady({
      id: span.id,
      signature: base,
      contentSignature: span.contentSignature,
      url: `blob:${span.id}`,
      byteSize: 1000,
      renderScale: 0.5,
      startSeconds: span.startSeconds,
      endSeconds: span.endSeconds,
      now: 1100
    });
  }
  const pendingUpgrade = storeUp.reconcile(plan, base, 1, 2000);
  check("quality upgrade regenerates softer spans", pendingUpgrade.length === pendingHalf.length);
  check("quality upgrade does not serve softer proxies", storeUp.getReadySpan(1, base, 1) === undefined);

  // Cross-session downgrade: a SHARPER persisted record (its id embeds the 1× scale it was planned
  // at) seals the range-equal span the new ¼ session planned — rehydration instead of regeneration.
  const storeRehydrate = createPreviewRenderCacheStore({ maxEntries: 500, maxBytes: 1_000_000_000 });
  const plannedQuarter = storeRehydrate.reconcile(plan, base, 0.25, 1000);
  const target = plannedQuarter[0]!;
  const sealed = storeRehydrate.markSpanReady({
    id: `${base}:1.000:${target.startSeconds.toFixed(3)}-${target.endSeconds.toFixed(3)}`,
    signature: base,
    contentSignature: target.contentSignature,
    url: "blob:sharper-record",
    byteSize: 1000,
    renderScale: 1,
    startSeconds: target.startSeconds,
    endSeconds: target.endSeconds,
    now: 1100
  });
  check(
    "sharper persisted record seals a softer-planned span",
    sealed?.status === "ready" && storeRehydrate.getReadySpan(target.startSeconds + 0.05, base, 0.25)?.url === "blob:sharper-record"
  );
}

// --- Real-time total tracks the current timeline (duration shrink) -----------
{
  const base = "dur-signature";
  const scale = 0.5;
  const store = createPreviewRenderCacheStore();
  const long: TimelineCacheLayerInput = { id: "music", type: "audio", startSeconds: 0, durationSeconds: 46 };
  store.reconcile(planAdaptiveCacheSpans({ durationSeconds: 46, layers: [long] }), base, scale, 1000);
  const totalLong = store.size;
  store.reconcile(planAdaptiveCacheSpans({ durationSeconds: 8, layers: [{ ...long, durationSeconds: 8 }] }), base, scale, 2000);
  const totalShort = store.size;
  check("status total shrinks when the timeline is trimmed", totalShort > 0 && totalShort < totalLong);
  const status = summarizePreviewCacheStatus(store.entries);
  check("status summary reports the current span total", status.total === totalShort && status.readyRatio === 0 && status.readyWithUrl === 0);
}

// --- Keyboard editing ops: ripple trim (Q/W) + edit-point navigation (↑/↓) ---
{
  const mkLayer = (id: string, start: number, duration: number) =>
    ({
      id,
      trackId: "t1",
      type: "video",
      name: id,
      assetId: "asset1", // media semantics: sourceIn moves with head trims, bounds head extension
      startSeconds: start,
      durationSeconds: duration,
      sourceInSeconds: 1,
      effects: [],
      keyframes: [],
      animations: [{ id: `${id}_a`, property: "opacity", timeSeconds: 3, value: 50, easing: "linear" }]
    }) as never;
  const comp = {
    id: "kbd",
    name: "kbd",
    width: 1080,
    height: 1920,
    fps: 30,
    durationSeconds: 12,
    backgroundColor: "#000",
    tracks: [{ id: "t1", type: "video", name: "V1", layers: [mkLayer("a", 0, 4), mkLayer("b", 4, 4), mkLayer("c", 8, 4)] }]
  } as never as Parameters<typeof rippleTrimLayer>[0];

  // Q at 5s inside "b": head trim removes 1s — b keeps start 4, shrinks to 3s, sourceIn 1→2; c ripples 8→7.
  const headTrimmed = rippleTrimLayer(comp, "b", 5, "head");
  const hb = headTrimmed.tracks[0]!.layers.find((l) => l.id === "b")!;
  const hc = headTrimmed.tracks[0]!.layers.find((l) => l.id === "c")!;
  check("ripple head trim shrinks the clip in place", hb.startSeconds === 4 && hb.durationSeconds === 3);
  check("ripple head trim advances sourceIn by the removed duration", hb.sourceInSeconds === 2);
  check("ripple head trim closes the gap for later clips", hc.startSeconds === 7);
  check("ripple head trim rebases local animations with the content", (hb.animations ?? [])[0]?.timeSeconds === 2);

  // W at 5s inside "b": tail trim — b becomes 1s long; c ripples left by the removed 3s.
  const tailTrimmed = rippleTrimLayer(comp, "b", 5, "tail");
  const tb = tailTrimmed.tracks[0]!.layers.find((l) => l.id === "b")!;
  const tc = tailTrimmed.tracks[0]!.layers.find((l) => l.id === "c")!;
  check("ripple tail trim cuts the clip at the playhead", tb.startSeconds === 4 && tb.durationSeconds === 1);
  check("ripple tail trim drops animations past the new end", (tb.animations ?? []).length === 0);
  check("ripple tail trim closes the gap for later clips", tc.startSeconds === 5);

  // Trim points outside the clip body are no-ops.
  check("ripple trim outside the clip is a no-op", rippleTrimLayer(comp, "b", 4, "head") as unknown === comp ? false : JSON.stringify(rippleTrimLayer(comp, "b", 4, "head")) === JSON.stringify(comp));

  const points = collectEditPoints(comp);
  check("edit points cover clip boundaries and the comp span", JSON.stringify(points) === JSON.stringify([0, 4, 8, 12]));

  // --- Roll edit (R tool / E extend): the a|b cut at 4s moves, timeline length unchanged ----
  // maxDurations follows the app's layerMaxDurations semantics: max playable duration from the
  // CURRENT sourceIn (asset length 6 − sourceIn 1 = 5 → each 4s clip has 1s of tail headroom).
  const trimOptions = { maxDurationsSeconds: { a: 5, b: 5, c: 5 }, minDurationSeconds: 1 / 30 };
  const rolled = rollEditAtCut(comp, "a", "b", 1, trimOptions);
  const ra = rolled.tracks[0]!.layers.find((l) => l.id === "a")!;
  const rb = rolled.tracks[0]!.layers.find((l) => l.id === "b")!;
  check("roll extends the left clip's tail", ra.startSeconds === 0 && ra.durationSeconds === 5);
  check("roll trims the right clip's head in place", rb.startSeconds === 5 && rb.durationSeconds === 3 && rb.sourceInSeconds === 2);
  check("roll leaves later clips alone", rolled.tracks[0]!.layers.find((l) => l.id === "c")!.startSeconds === 8);
  // Clamps: left clip has 6s of media (sourceIn 1 + duration 4 → 1s of tail headroom).
  const rolledFar = rollEditAtCut(comp, "a", "b", 99, trimOptions);
  check("roll clamps to the left clip's available media", rolledFar.tracks[0]!.layers.find((l) => l.id === "a")!.durationSeconds === 5);
  // Negative roll clamps to the right clip's head material (sourceIn 1).
  const rolledBack = rollEditAtCut(comp, "a", "b", -99, trimOptions);
  const rbBack = rolledBack.tracks[0]!.layers.find((l) => l.id === "b")!;
  check("negative roll clamps to the right clip's sourceIn", rbBack.startSeconds === 3 && rbBack.sourceInSeconds === 0);
  check("roll on a non-touching pair is a no-op", rollEditAtCut(comp, "a", "c", 1, trimOptions) === comp);

  // --- Slide edit (U tool): b moves, a/c absorb, b's content untouched ----------------------
  const slid = slideLayer(comp, "b", 1, trimOptions);
  const sa = slid.tracks[0]!.layers.find((l) => l.id === "a")!;
  const sb = slid.tracks[0]!.layers.find((l) => l.id === "b")!;
  const sc = slid.tracks[0]!.layers.find((l) => l.id === "c")!;
  check("slide moves the clip without touching its content", sb.startSeconds === 5 && sb.durationSeconds === 4 && sb.sourceInSeconds === 1);
  check("slide extends the previous clip's tail", sa.durationSeconds === 5);
  check("slide trims the next clip's head", sc.startSeconds === 9 && sc.durationSeconds === 3 && sc.sourceInSeconds === 2);
  check("slide without both neighbours is a no-op", slideLayer(comp, "a", 1, trimOptions) === comp);

  // --- Edge trim (E fallback on a free edge) -------------------------------------------------
  const edgeTrimmed = trimLayerEdgeTo(comp, "c", "tail", 10, trimOptions);
  check("edge trim moves a free tail to the target time", edgeTrimmed.tracks[0]!.layers.find((l) => l.id === "c")!.durationSeconds === 2);

  // --- Trim SQUEEZES keyframes on non-source layers (text/shape/image), unlike video/audio --
  const textLayer = {
    ...comp.tracks[0]!.layers[0]!,
    id: "txt",
    type: "text",
    assetId: undefined,
    startSeconds: 0,
    durationSeconds: 4,
    animations: [{ id: "txtkf", target: { scope: "layer", property: "transform.opacity" }, timeSeconds: 2, value: 50, interpolation: "linear", temporal: {} }]
  } as never as (typeof comp.tracks[0])["layers"][0];
  const textComp = { ...comp, tracks: [{ ...comp.tracks[0]!, layers: [textLayer] }] } as typeof comp;
  const textTailTrimmed = trimLayerEdgeTo(textComp, "txt", "tail", 2, { minDurationSeconds: 1 / 30 });
  const trimmedText = textTailTrimmed.tracks[0]!.layers.find((l) => l.id === "txt")! as never as typeof textLayer;
  check(
    "non-source tail trim squeezes (rescales) the keyframe instead of dropping it",
    trimmedText.durationSeconds === 2 && (trimmedText.animations ?? []).length === 1 && (trimmedText.animations ?? [])[0]!.timeSeconds === 1
  );

  // --- Paste attributes (⌃⌥C / ⌃⌥V) ----------------------------------------------------------
  const sourceLayer = {
    ...comp.tracks[0]!.layers[0]!,
    effects: [{ id: "src_fx", type: "brightnessContrast", name: "Look", enabled: true, intensity: 100, params: { exposure: -8 } }],
    transform: { position: { x: 40, y: 60 }, scale: 1.2, rotation: 5, opacity: 90 },
    fit: "contain"
  } as never as (typeof comp.tracks[0])["layers"][0];
  copyLayerAttributes(sourceLayer);
  check("attribute clipboard filled", hasClipboardAttributes());
  const pasted = pasteLayerAttributes(comp, ["b", "c"]);
  const pb = pasted.tracks[0]!.layers.find((l) => l.id === "b")! as never as typeof sourceLayer;
  const pc = pasted.tracks[0]!.layers.find((l) => l.id === "c")! as never as typeof sourceLayer;
  check("paste replaces target effects with the copied stack", pb.effects.length === 1 && (pb.effects[0]!.params as { exposure?: number }).exposure === -8);
  check("pasted effects get per-layer ids (no aliasing)", pb.effects[0]!.id !== pc.effects[0]!.id && pb.effects[0]!.id !== "src_fx");
  check("paste copies transform + fit", pb.transform!.scale === 1.2 && pb.fit === "contain");
  check("paste leaves timing/content alone", pb.startSeconds === 4 && pb.durationSeconds === 4 && (pb as { sourceInSeconds?: number }).sourceInSeconds === 1);
  check("paste ignores unselected clips", pasted.tracks[0]!.layers.find((l) => l.id === "a")!.effects.length === 0);

  // --- Group-filtered paste (paste-attributes chooser) ----------------------------------------
  const targetBBefore = comp.tracks[0]!.layers.find((l) => l.id === "b")!;
  const transformOnlyPasted = pasteLayerAttributes(comp, ["b"], new Set(["transform"]));
  const transformOnlyB = transformOnlyPasted.tracks[0]!.layers.find((l) => l.id === "b")! as never as typeof sourceLayer;
  check(
    "group-filtered paste (transform only) copies transform but leaves effects/fit untouched",
    transformOnlyB.transform!.scale === 1.2 && transformOnlyB.effects.length === targetBBefore.effects.length && transformOnlyB.fit === targetBBefore.fit
  );
  const effectsOnlyPasted = pasteLayerAttributes(comp, ["b"], new Set(["effects"]));
  const effectsOnlyB = effectsOnlyPasted.tracks[0]!.layers.find((l) => l.id === "b")! as never as typeof sourceLayer;
  check(
    "group-filtered paste (effects only) copies effects but leaves transform untouched",
    effectsOnlyB.effects.length === 1 && effectsOnlyB.transform === targetBBefore.transform
  );

  // --- Effect presets path: applyLayerAttributes with transform stripped ----------------------
  const snapshot = snapshotLayerAttributes(sourceLayer);
  snapshot.transform = undefined; // preset semantics: a look never moves the target
  const preset = applyLayerAttributes(comp, ["b"], snapshot);
  const presetB = preset.tracks[0]!.layers.find((l) => l.id === "b")! as never as typeof sourceLayer;
  check("preset apply replaces effects", presetB.effects.length === 1 && (presetB.effects[0]!.params as { exposure?: number }).exposure === -8);
  check("preset apply leaves transform untouched", presetB.transform === comp.tracks[0]!.layers.find((l) => l.id === "b")!.transform);
  check("snapshot is a deep copy (mutating it can't corrupt the source)", (() => {
    (snapshot.effects[0]!.params as { exposure?: number }).exposure = 99;
    return (sourceLayer.effects[0]!.params as { exposure?: number }).exposure === -8;
  })());

  // --- Keyframes travel with paste-attributes / presets ---------------------------------------
  type KfLayer = TimelineLayer & { animations?: { id: string; target: { scope: string; effectId?: string; property: string; maskId?: string }; timeSeconds: number }[] };
  const animatedSource = {
    ...sourceLayer,
    animations: [
      { id: "k_fx", target: { scope: "effect", effectId: "src_fx", property: "exposure" }, timeSeconds: 1, value: -8, interpolation: "linear", temporal: {} },
      { id: "k_stray", target: { scope: "effect", effectId: "not_in_stack", property: "amount" }, timeSeconds: 1, value: 3, interpolation: "linear", temporal: {} },
      { id: "k_tr", target: { scope: "layer", property: "transform.opacity" }, timeSeconds: 2, value: 50, interpolation: "linear", temporal: {} },
      { id: "k_mask", target: { scope: "mask", maskId: "m1", property: "feather" }, timeSeconds: 1, value: 4, interpolation: "linear", temporal: {} }
    ]
  } as never as (typeof comp.tracks[0])["layers"][0];
  const kfSnapshot = snapshotLayerAttributes(animatedSource);
  const snapKeys = (kfSnapshot.animations ?? []) as KfLayer["animations"] & {};
  check(
    "snapshot carries effect + transform keys only (mask + orphan-effect keys excluded)",
    snapKeys.length === 2 && snapKeys.some((k) => k.id === "k_fx") && snapKeys.some((k) => k.id === "k_tr")
  );
  // Target with its own keys in every scope + a legacy v1 keyframe: paste must replace the
  // effect/transform scopes, keep the mask key, and clear the legacy (transform-ish) keyframes.
  const kfTargetComp = {
    ...comp,
    tracks: comp.tracks.map((t) => ({
      ...t,
      layers: t.layers.map((l) =>
        l.id === "b"
          ? ({
              ...l,
              keyframes: [{ id: "legacy1", property: "opacity", timeSeconds: 5, value: 20, easing: "linear" }],
              animations: [
                { id: "old_fx", target: { scope: "effect", effectId: "b_fx", property: "amount" }, timeSeconds: 0.5, value: 9, interpolation: "linear", temporal: {} },
                { id: "old_tr", target: { scope: "layer", property: "transform.scale" }, timeSeconds: 0.5, value: 2, interpolation: "linear", temporal: {} },
                { id: "old_mask", target: { scope: "mask", maskId: "m9", property: "feather" }, timeSeconds: 0.5, value: 1, interpolation: "linear", temporal: {} }
              ]
            } as never)
          : l
      )
    }))
  } as typeof comp;
  const kfPasted = applyLayerAttributes(kfTargetComp, ["b", "c"], kfSnapshot);
  const kfB = kfPasted.tracks[0]!.layers.find((l) => l.id === "b")! as never as KfLayer;
  const kfC = kfPasted.tracks[0]!.layers.find((l) => l.id === "c")! as never as KfLayer;
  const bEffectKey = (kfB.animations ?? []).find((k) => k.target?.scope === "effect");
  const cEffectKey = (kfC.animations ?? []).find((k) => k.target?.scope === "effect");
  check(
    "pasted effect keys are remapped to each target's own fresh effect id",
    bEffectKey?.target.effectId === kfB.effects[0]!.id && cEffectKey?.target.effectId === kfC.effects[0]!.id && bEffectKey?.target.effectId !== cEffectKey?.target.effectId
  );
  check("multi-target paste never shares keyframe references", bEffectKey !== cEffectKey && bEffectKey?.id !== cEffectKey?.id);
  check(
    "paste replaces effect/transform-scope keys but keeps mask keys",
    !(kfB.animations ?? []).some((k) => k.id === "old_fx" || k.id === "old_tr") && (kfB.animations ?? []).some((k) => k.id === "old_mask")
  );
  check(
    "pasted transform key travels and legacy v1 keyframes are cleared (no double-animation)",
    (kfB.animations ?? []).some((k) => k.target?.property === "transform.opacity") && (kfB.keyframes ?? []).length === 0
  );
  check("orphan effect keys (unknown effect id) never paste", !(kfB.animations ?? []).some((k) => k.target?.property === "amount"));
  // Preset semantics: transform stripped → its keys must not travel; effect keys still do.
  const presetSnapshot = snapshotLayerAttributes(animatedSource);
  presetSnapshot.transform = undefined;
  presetSnapshot.animations = presetSnapshot.animations?.filter((k) => k.target?.scope === "effect");
  const kfPreset = applyLayerAttributes(kfTargetComp, ["b"], presetSnapshot);
  const kfPresetB = kfPreset.tracks[0]!.layers.find((l) => l.id === "b")! as never as KfLayer;
  check(
    "preset apply keeps the target's transform keys and legacy keyframes, applies effect keys",
    (kfPresetB.animations ?? []).some((k) => k.id === "old_tr") &&
      (kfPresetB.keyframes ?? []).length === 1 &&
      (kfPresetB.animations ?? []).some((k) => k.target?.scope === "effect" && k.target.effectId === kfPresetB.effects[0]!.id)
  );
  // Pre-keyframe snapshots (old saved presets: no animations field) leave target keys alone.
  const legacySnapshot = { ...snapshotLayerAttributes(animatedSource), animations: undefined };
  const legacyApplied = applyLayerAttributes(kfTargetComp, ["b"], legacySnapshot);
  const legacyB = legacyApplied.tracks[0]!.layers.find((l) => l.id === "b")! as never as KfLayer;
  check(
    "old presets (no animations field) apply exactly as before (target keys untouched)",
    (legacyB.animations ?? []).length === 3 && (legacyB.keyframes ?? []).length === 1
  );
  // Legacy-only sources: v1 keyframes are folded into the snapshot as layer-local transform keys.
  const legacySource = { ...animatedSource, animations: [], keyframes: [{ id: "v1k", property: "opacity", timeSeconds: 4.5, value: 10, easing: "linear" }] } as never as (typeof comp.tracks[0])["layers"][0];
  const legacySourceSnap = snapshotLayerAttributes(legacySource);
  const migrated = (legacySourceSnap.animations ?? []) as KfLayer["animations"] & {};
  check(
    "legacy v1 source keyframes snapshot as layer-local transform.* V2 keys",
    migrated.length === 1 && migrated[0]!.target.property === "transform.opacity" && migrated[0]!.timeSeconds === 4.5 - (legacySource.startSeconds ?? 0)
  );

  // --- Rate stretch (constant clip speed): source math scales by speed ------------------------
  const spedComp = {
    ...comp,
    tracks: comp.tracks.map((t) => ({
      ...t,
      layers: t.layers.map((l) => (l.id === "b" ? { ...l, speed: 2 } : l))
    }))
  } as typeof comp;
  check("getLayerSpeed normalizes absent/garbage to 1", getLayerSpeed({ speed: undefined }) === 1 && getLayerSpeed({ speed: 0 }) === 1 && getLayerSpeed({ speed: 2 }) === 2);
  // Split "b" (start 4, sourceIn 1, speed 2) at 6 → 2 timeline s consumed = 4 source s → right.sourceIn = 5.
  const spedSplit = splitLayerAtTime(spedComp, "b", 6);
  const rightHalf = spedSplit.tracks[0]!.layers.find((l) => l.id !== "a" && l.id !== "b" && l.id !== "c" && l.startSeconds === 6);
  check("split at 2x speed advances right sourceIn by local*speed", rightHalf?.sourceInSeconds === 5);
  // Ripple head trim 1 timeline s off "b" at 2x → sourceIn advances by 2.
  const spedTrim = rippleTrimLayer(spedComp, "b", 5, "head");
  check("ripple head trim at 2x advances sourceIn by delta*speed", spedTrim.tracks[0]!.layers.find((l) => l.id === "b")!.sourceInSeconds === 3);
  // Roll into "b"'s head: head material 1 source s at 2x = 0.5 timeline s.
  const spedRoll = rollEditLimits(spedComp, "a", "b", trimOptions);
  check("roll head-material bound converts source→timeline via speed", spedRoll !== null && Math.abs(spedRoll.minDelta + 0.5) < 0.001);

  // --- Speed ramps (keyframed time remap): closed-form integral + edit rebasing ----------------
  const rampLayer = { speed: 1, sourceInSeconds: 1, speedKeyframes: [{ timeSeconds: 0, value: 1 }, { timeSeconds: 2, value: 2 }] };
  check("ramp rate interpolates linearly", getLayerSpeedAt(rampLayer, 1) === 1.5 && getLayerSpeedAt(rampLayer, 0) === 1 && getLayerSpeedAt(rampLayer, 2) === 2);
  check("ramp rate holds edge values outside the points", getLayerSpeedAt(rampLayer, -1) === 1 && getLayerSpeedAt(rampLayer, 5) === 2);
  // ∫₀² (1→2) = trapezoid = 3, plus edge hold 2/s after → t=3 ⇒ sourceIn 1 + 3 + 2 = 6.
  check("ramp source time is the exact trapezoid integral", Math.abs(layerSourceTimeSeconds(rampLayer, 2) - 4) < 1e-9 && Math.abs(layerSourceTimeSeconds(rampLayer, 3) - 6) < 1e-9);
  check("ramp overrides constant speed", Math.abs(layerSourceTimeSeconds({ ...rampLayer, speed: 8 }, 2) - 4) < 1e-9);
  // Split a ramped clip: right half's sourceIn = integral at the cut; ramp rebases with the cut value first.
  const rampComp = {
    ...comp,
    tracks: comp.tracks.map((t) => ({
      ...t,
      layers: t.layers.map((l) => (l.id === "b" ? { ...l, sourceInSeconds: 1, speed: 1, speedKeyframes: [{ timeSeconds: 0, value: 1 }, { timeSeconds: 2, value: 2 }] } : l))
    }))
  } as typeof comp;
  // "b" starts at 4 → split at 6 = local 2 → sourceIn 1 + 3 = 4; rebased ramp starts at value 2.
  const rampSplit = splitLayerAtTime(rampComp, "b", 6);
  const rampRight = rampSplit.tracks[0]!.layers.find((l) => l.id !== "a" && l.id !== "b" && l.id !== "c" && l.startSeconds === 6) as
    | (TimelineLayer & { speedKeyframes?: { timeSeconds: number; value: number }[] })
    | undefined;
  check("ramped split: right sourceIn = integral at cut", Math.abs((rampRight?.sourceInSeconds ?? 0) - 4) < 1e-9);
  check(
    "ramped split: right ramp rebased to cut value at t=0",
    rampRight?.speedKeyframes?.[0]?.timeSeconds === 0 && rampRight?.speedKeyframes?.[0]?.value === 2
  );
  // Continuity: left end + right start read the SAME source instant (no frame jump at the cut).
  const rampLeft = rampSplit.tracks[0]!.layers.find((l) => l.id === "b")!;
  check(
    "ramped split is source-continuous across the cut",
    Math.abs(layerSourceTimeSeconds(rampLeft, 2) - layerSourceTimeSeconds(rampRight!, 0)) < 1e-9
  );
}

// --- Trim keyframe conventions: shared helper (drag-resize parity) -------------
{
  const layer = {
    id: "kf",
    trackId: "t",
    type: "video",
    name: "kf",
    startSeconds: 10,
    durationSeconds: 8,
    transform: { position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 100 },
    effects: [],
    keyframes: [
      { id: "v1a", property: "opacity", timeSeconds: 11, value: 0 },
      { id: "v1b", property: "opacity", timeSeconds: 17, value: 100 }
    ],
    animations: [
      { id: "a1", target: { scope: "layer", property: "opacity" }, timeSeconds: 1, value: 0, interpolation: "linear", temporal: {} },
      { id: "a2", target: { scope: "layer", property: "opacity" }, timeSeconds: 7, value: 100, interpolation: "linear", temporal: {} }
    ]
  } as unknown as TimelineLayer;
  // Tail trim 10..18 → 10..15: v2 anim at 7 and v1 at 17 are past the new end → dropped.
  const tail = trimLayerKeyframesTo(layer, 10, 5);
  check("trim conventions: tail trim drops keyframes past the new end", tail.animations?.length === 1 && tail.keyframes.length === 1);
  // Head trim to 12 (delta 2): v2 anim at 1 dropped, at 7 rebased to 5; v1 at 11 dropped.
  const head = trimLayerKeyframesTo(layer, 12, 6);
  check(
    "trim conventions: head trim drops hidden keyframes and rebases survivors",
    head.animations?.length === 1 && Math.abs((head.animations?.[0]?.timeSeconds ?? 0) - 5) < 1e-9 && head.keyframes.length === 1 && head.keyframes[0]?.id === "v1b"
  );
  // Head EXTEND to 8 (delta -2): v2 times shift right by 2 so the animation stays on its content.
  const extend = trimLayerKeyframesTo(layer, 8, 10);
  check("trim conventions: head extend keeps animations pinned to content", Math.abs((extend.animations?.[0]?.timeSeconds ?? 0) - 3) < 1e-9 && extend.animations?.length === 2);
}

// --- Span content-signature completeness (PREVIEW_PIPELINE.md P3) -------------
// Locks the 2026-07-04 soak repros: a transform edit and a TRACK REORDER must both flip the span
// signature (stale proxies replayed old scale/stacking); an audio-only track volume change must NOT
// (span proxies are picture-only).
{
  const sigLayer = (id: string, trackId: string, scale = 1): TimelineLayer => ({
    id,
    trackId,
    type: "video",
    name: id,
    startSeconds: 0,
    durationSeconds: 10,
    transform: { position: { x: 50, y: 50 }, scale, rotation: 0, opacity: 100 },
    effects: [],
    keyframes: []
  });
  const sigComp = (tracks: { id: string; layers: TimelineLayer[]; volume?: number }[]) => ({
    id: "sig",
    name: "sig",
    width: 1080,
    height: 1920,
    fps: 30,
    durationSeconds: 10,
    backgroundColor: "#000",
    tracks: tracks.map((track) => ({ id: track.id, type: "video" as const, name: track.id, layers: track.layers, ...(track.volume !== undefined ? { volume: track.volume } : {}) }))
  });
  const sigOf = (c: ReturnType<typeof sigComp>) =>
    planAdaptiveCacheSpans({ durationSeconds: 10, layers: compositionCacheLayers(c) })[0]!.contentSignature;

  const base = sigComp([
    { id: "t1", layers: [sigLayer("a", "t1")] },
    { id: "t2", layers: [sigLayer("b", "t2")] }
  ]);
  check("span signature: identical comps agree", sigOf(base) === sigOf(structuredClone(base)));
  const scaled = sigComp([
    { id: "t1", layers: [sigLayer("a", "t1", 1.4)] },
    { id: "t2", layers: [sigLayer("b", "t2")] }
  ]);
  check("span signature: transform edit flips it", sigOf(base) !== sigOf(scaled));
  const reordered = sigComp([
    { id: "t2", layers: [sigLayer("b", "t2")] },
    { id: "t1", layers: [sigLayer("a", "t1")] }
  ]);
  check("span signature: track reorder flips it", sigOf(base) !== sigOf(reordered));
  // Inserting an EMPTY track at the top shifts every layer's absolute track index without changing
  // any pixels — it must NOT flip signatures (2026-07-13 report: adding a layer via the "+" button
  // regenerated every proxy on the timeline).
  const emptyTopTrack = sigComp([
    { id: "t0", layers: [] },
    { id: "t1", layers: [sigLayer("a", "t1")] },
    { id: "t2", layers: [sigLayer("b", "t2")] }
  ]);
  check("span signature: inserting an empty track does NOT flip it", sigOf(base) === sigOf(emptyTopTrack));
  const louder = sigComp([
    { id: "t1", layers: [sigLayer("a", "t1")], volume: 1.6 },
    { id: "t2", layers: [sigLayer("b", "t2")] }
  ]);
  check("span signature: track volume (audio-only) does NOT flip it", sigOf(base) === sigOf(louder));
  const labeled = sigComp([
    { id: "t1", layers: [{ ...sigLayer("a", "t1"), label: "violet" }] },
    { id: "t2", layers: [sigLayer("b", "t2")] }
  ]);
  check("span signature: clip color label (cosmetic) does NOT flip it", sigOf(base) === sigOf(labeled));
}

// --- Nesting: shared expansion core (NESTING.md Phase A) ----------------------
{
  const mkLayer = (over: Partial<TimelineLayer> & { id: string; trackId: string }): TimelineLayer => ({
    type: "video",
    name: over.id,
    startSeconds: 0,
    durationSeconds: 4,
    transform: { position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 100 },
    effects: [],
    keyframes: [],
    ...over
  });
  const mkComp = (id: string, durationSeconds: number, layers: TimelineLayer[], dims = { width: 1080, height: 1920 }) => ({
    id,
    name: id,
    width: dims.width,
    height: dims.height,
    fps: 30,
    durationSeconds,
    backgroundColor: "#000",
    tracks: [{ id: `${id}_t1`, type: "video" as const, name: "V1", layers }]
  });

  // Nested sequence: video child 0..10 with a speed ramp, text child 2..6 with a local keyframe.
  const childVideo = mkLayer({
    id: "cv",
    trackId: "nest_t1",
    durationSeconds: 10,
    sourceInSeconds: 0.5,
    speedKeyframes: [
      { timeSeconds: 0, value: 1 },
      { timeSeconds: 4, value: 2 }
    ]
  });
  const childText = mkLayer({
    id: "ct",
    trackId: "nest_t1",
    type: "text",
    text: "Hi",
    startSeconds: 2,
    durationSeconds: 4,
    animations: [{ id: "k1", target: { scope: "layer" as const, property: "opacity" }, timeSeconds: 2, value: 50, interpolation: "linear" as const, temporal: {} }],
    transitionIn: { kind: "crossfade", durationSeconds: 1 }
  });
  const nestComp = mkComp("nestA", 10, [childVideo, childText]);

  // Parent: compound clip at t=2, trimmed 1s into the nest, playing 4s of nest time at speed 2 → 2s on the parent timeline.
  const compoundClip = mkLayer({ id: "nc1", trackId: "root_t1", nestedCompositionId: "nestA", startSeconds: 2, durationSeconds: 2, sourceInSeconds: 1, speed: 2 });
  const plain = mkLayer({ id: "plain", trackId: "root_t1", startSeconds: 0, durationSeconds: 1 });
  const rootComp = mkComp("root", 12, [plain, compoundClip]);
  const compositions = { nestA: nestComp, root: rootComp };

  const noNest = mkComp("solo", 5, [plain]);
  check("nesting: no-op keeps the same composition reference", expandNestedCompositions(noNest, compositions).composition === noNest);

  const expanded = expandNestedCompositions(rootComp, compositions);
  const outLayers = expanded.composition.tracks[0]!.layers;
  check("nesting: compound clip replaced by derived children", !outLayers.some((l) => l.id === "nc1") && outLayers.some((l) => l.id === "nc1__nest_cv"));
  check("nesting: plain layer untouched", outLayers.some((l) => l.id === "plain"));
  check("nesting: group spec records clip + nested comp dims", expanded.groups.get("nc1")?.composition.width === 1080 && expanded.groups.get("nc1")?.clip.id === "nc1");
  check("nesting: derived child id resolves its group", nestParentClipId("nc1__nest_cv") === "nc1");

  // Video child: window [1, 5] in nest time → headTrim 1, parent start 2, duration (5-1)/2 = 2.
  const dv = outLayers.find((l) => l.id === "nc1__nest_cv")!;
  check("nesting: derived start/duration mapped through the window and clip speed", Math.abs(dv.startSeconds - 2) < 1e-9 && Math.abs(dv.durationSeconds - 2) < 1e-9);
  // Source continuity: derived local l must read the SAME source instant as child local (headTrim + l*clipSpeed).
  const continuous = [0, 0.5, 1.3, 2].every(
    (l) => Math.abs(layerSourceTimeSeconds(dv, l) - layerSourceTimeSeconds(childVideo, 1 + l * 2)) < 1e-9
  );
  check("nesting: ramped child stays source-continuous through the mapping", continuous);

  // Text child: nest 2..6 clipped to window [1,5] → overlap [2,5], headTrim 0, parent start 2 + (2-1)/2 = 2.5, dur 1.5.
  const dt = outLayers.find((l) => l.id === "nc1__nest_ct")!;
  check("nesting: second child window mapping", Math.abs(dt.startSeconds - 2.5) < 1e-9 && Math.abs(dt.durationSeconds - 1.5) < 1e-9);
  check("nesting: layer-local keyframe times divided by clip speed", Math.abs((dt.animations?.[0]?.timeSeconds ?? 0) - 1) < 1e-9);
  check("nesting: untrimmed child keeps its transition, scaled to parent seconds", dt.transitionIn?.durationSeconds === 0.5);

  // Two instances of one nest → distinct derived ids (distinct decoders/caches downstream).
  const twoComp = mkComp("root2", 12, [compoundClip, { ...compoundClip, id: "nc2", startSeconds: 6 }]);
  const two = expandNestedCompositions(twoComp, compositions);
  const twoIds = two.composition.tracks[0]!.layers.map((l) => l.id);
  check("nesting: two instances expand to distinct namespaced ids", twoIds.includes("nc1__nest_cv") && twoIds.includes("nc2__nest_cv"));

  // Nest-in-nest: outer comp contains a clip of nestA's HOST — ids chain and the inner group is re-keyed.
  const midClip = mkLayer({ id: "mid", trackId: "midc_t1", nestedCompositionId: "nestA", startSeconds: 0, durationSeconds: 10 });
  const midComp = mkComp("midc", 10, [midClip]);
  const outerClip = mkLayer({ id: "outer", trackId: "o_t1", nestedCompositionId: "midc", startSeconds: 0, durationSeconds: 10 });
  const outerComp = mkComp("o", 10, [outerClip]);
  const deep = expandNestedCompositions(outerComp, { ...compositions, midc: midComp, o: outerComp });
  const deepIds = deep.composition.tracks[0]!.layers.map((l) => l.id);
  check("nesting: nests-in-nests chain ids", deepIds.includes("outer__nest_mid__nest_cv"));
  check("nesting: inner group re-keyed per instance", deep.groups.has("outer__nest_mid") && deep.groups.has("outer"));

  // Cycles: self-reference stays unexpanded; the action guard sees direct + transitive cycles.
  const selfClip = mkLayer({ id: "self", trackId: "cyc_t1", nestedCompositionId: "cyc" });
  const cycComp = mkComp("cyc", 10, [selfClip]);
  const cyc = expandNestedCompositions(cycComp, { cyc: cycComp });
  check("nesting: self-reference degrades to the unexpanded clip", cyc.composition.tracks[0]!.layers.some((l) => l.id === "self"));
  check("nesting: cycle guard flags direct self-nest", wouldCreateCompositionCycle({ cyc: cycComp }, "cyc", "cyc"));
  check(
    "nesting: cycle guard flags transitive cycle",
    wouldCreateCompositionCycle({ ...compositions, midc: midComp }, "nestA", "midc")
  );
  check("nesting: non-cycle passes the guard", !wouldCreateCompositionCycle(compositions, "root", "nestA"));
  check("nesting: compound source length = nested duration", getNestedSourceDurationSeconds(compoundClip, compositions) === 10);

  // --- Phase B: Nest / Un-nest editor actions ---------------------------------------------------
  const nestA1 = mkLayer({ id: "a1", trackId: "root_t1", startSeconds: 0, durationSeconds: 3 });
  const nestB1 = mkLayer({ id: "b1", trackId: "root_t1", startSeconds: 3, durationSeconds: 2 });
  const untouched = mkLayer({ id: "c1", trackId: "root_t1", startSeconds: 5, durationSeconds: 4 });
  const nestSourceComp = mkComp("nestsrc", 9, [nestA1, nestB1, untouched]);

  const nestResult = nestLayersIntoComposition(nestSourceComp, ["a1", "b1"]);
  check("nest: returns a result for a 2-layer selection", nestResult !== null);
  const compoundLayers = nestResult!.composition.tracks[0]!.layers;
  check("nest: selection replaced by one compound clip", compoundLayers.length === 2 && compoundLayers.some((l) => l.nestedCompositionId === nestResult!.nestedComposition.id));
  check("nest: unselected layer untouched", compoundLayers.some((l) => l.id === "c1"));
  const compound = compoundLayers.find((l) => l.nestedCompositionId)!;
  check("nest: compound clip spans the selection's combined range", compound.startSeconds === 0 && compound.durationSeconds === 5);
  check("nest: nested comp normalizes child times to t=0", nestResult!.nestedComposition.tracks[0]!.layers.find((l) => l.id === "a1")!.startSeconds === 0);
  check("nest: nested comp preserves relative offsets", nestResult!.nestedComposition.tracks[0]!.layers.find((l) => l.id === "b1")!.startSeconds === 3);
  check("nest: nested comp duration = selection span", nestResult!.nestedComposition.durationSeconds === 5);
  check("nest: fewer than 2 layers is rejected", nestLayersIntoComposition(nestSourceComp, ["a1"]) === null);
  // Block 2 (NESTING_MATURITY.md) reversed the v1 exclusion: a compound clip in the selection nests
  // into the NEW sequence too — moving existing clips into a brand-new comp can never create a
  // reference cycle, and the renderer handles recursive nests.
  const renest = nestLayersIntoComposition(nestResult!.composition, [compound.id, "c1"]);
  check(
    "nest: a compound clip in the selection nests into the new sequence (Block 2)",
    renest !== null &&
      renest!.nestedComposition.tracks.some((t) => t.layers.some((l) => l.nestedCompositionId === nestResult!.nestedComposition.id)) &&
      renest!.nestedComposition.tracks.some((t) => t.layers.some((l) => l.id === "c1"))
  );

  const nestCompositions = { [nestResult!.nestedComposition.id]: nestResult!.nestedComposition };
  const unnested = unnestClip(nestResult!.composition, nestCompositions, compound.id);
  check("un-nest: returns a result for an untrimmed/unsped compound clip", unnested !== null);
  const unnestedLayerIds = unnested!.composition.tracks.flatMap((t) => t.layers.map((l) => l.id));
  check("un-nest: compound clip removed", !unnestedLayerIds.includes(compound.id));
  const restoredA1 = unnested!.composition.tracks.flatMap((t) => t.layers).find((l) => l.startSeconds === 0 && l.durationSeconds === 3);
  const restoredB1 = unnested!.composition.tracks.flatMap((t) => t.layers).find((l) => l.startSeconds === 3 && l.durationSeconds === 2);
  check("un-nest: children reinserted at the clip's original position", Boolean(restoredA1) && Boolean(restoredB1));
  check("un-nest: sibling layer untouched", unnestedLayerIds.includes("c1"));

  const trimmedCompound = { ...compound, sourceInSeconds: 1 };
  const trimmedComp = { ...nestResult!.composition, tracks: [{ ...nestResult!.composition.tracks[0]!, layers: [trimmedCompound, ...nestResult!.composition.tracks[0]!.layers.filter((l) => l.id !== compound.id)] }] };
  check("un-nest: a trimmed compound clip is rejected (v1)", unnestClip(trimmedComp, nestCompositions, compound.id) === null);

  // --- Block 2 (NESTING_MATURITY.md): composition registry + healer ----------------------------
  {
    const graph: ProjectGraph = { projectId: "p1", effects: [], editableFields: {}, version: 1, composition: rootComp, compositions: { nestA: nestComp } };
    const stamped = stampCompositionRegistry(graph);
    check("registry: write-through mirrors the active comp into compositions", stamped.compositions?.["root"] === rootComp);
    check("registry: pointers stamped (root=active for a top-level comp)", stamped.rootCompositionId === "root" && stamped.activeCompositionId === "root");

    // Stranded graph (the pre-Block-2 refresh bug): the NEST persisted as `composition`, the real
    // root stashed in `compositions`, no pointers, breadcrumb lost.
    const stranded: ProjectGraph = { projectId: "p1", effects: [], editableFields: {}, version: 1, composition: nestComp, compositions: { root: rootComp } };
    const healed = healCompositionRegistry(stranded);
    check("healer: stranded project resolves its true root by walking nest references", healed.graph.rootCompositionId === "root");
    check("healer: active comp stays the nest (reopen where the user was)", healed.graph.activeCompositionId === "nestA");
    check("healer: breadcrumb restored (root → nest)", healed.breadcrumb.length === 1 && healed.breadcrumb[0]?.id === "root");

    // Multi-level: outer → midc → nestA.
    const midClip2 = mkLayer({ id: "mid2", trackId: "midc2_t1", nestedCompositionId: "nestA" });
    const midComp2 = mkComp("midc2", 10, [midClip2]);
    const outerClip2 = mkLayer({ id: "outer2", trackId: "o2_t1", nestedCompositionId: "midc2" });
    const outerComp2 = mkComp("o2", 10, [outerClip2]);
    const registry = { o2: outerComp2, midc2: midComp2, nestA: nestComp };
    check("registry: findRootCompositionId walks two levels up", findRootCompositionId(registry, "nestA") === "o2");
    const crumbs = deriveNestBreadcrumb(registry, "o2", "nestA");
    check("registry: multi-level breadcrumb is root→…→parent", crumbs.length === 2 && crumbs[0]?.id === "o2" && crumbs[1]?.id === "midc2");
    check("registry: breadcrumb of the root itself is empty", deriveNestBreadcrumb(registry, "o2", "o2").length === 0);
  }

  // --- Block 5 (NESTING_MATURITY.md): compound volume + nested-track fader folding ------------
  {
    const volEffect = { id: "vol1", type: "volume" as const, name: "Volume", enabled: true, intensity: 100, params: { gain: 80 } };
    const gainKey = (id: string, timeSeconds: number, value: number) => ({
      id,
      target: { scope: "effect" as const, property: "gain", effectId: "vol1" },
      timeSeconds,
      value,
      interpolation: "linear" as const,
      temporal: {}
    });
    const audioChild = mkLayer({ id: "au", trackId: "vnest_t1", type: "audio", startSeconds: 0, durationSeconds: 8 });
    const volNest = {
      ...mkComp("vnest", 8, [audioChild]),
      tracks: [{ id: "vnest_t1", type: "audio" as const, name: "A1", layers: [audioChild], volume: 0.5 }]
    };
    // Compound at t=2 with a keyframed volume effect (100% at local 0 → 50% at local 4).
    const volClip = mkLayer({
      id: "vc",
      trackId: "vroot_t1",
      nestedCompositionId: "vnest",
      startSeconds: 2,
      durationSeconds: 8,
      effects: [volEffect],
      animations: [gainKey("gk0", 0, 100), gainKey("gk1", 4, 50)]
    });
    const volRoot = mkComp("vroot", 12, [volClip]);
    const volExp = expandNestedCompositions(volRoot, { vnest: volNest, vroot: volRoot });
    const foldedChild = volExp.composition.tracks[0]!.layers.find((l) => l.id === "vc__nest_au")!;
    check("audio fold: derived child gains a synthesized volume effect", foldedChild.effects.some((e) => e.type === "volume"));
    // At parent t=2 (child local 0 == clip local 0): clip gain 100% × fader 0.5 → 0.5.
    check("audio fold: clip automation × static fader at the head", Math.abs(getCompositionVolume(foldedChild, { currentTimeSeconds: 2 }) - 0.5) < 1e-6);
    // At parent t=6 (clip local 4): clip gain 50% × fader 0.5 → 0.25.
    check("audio fold: keyframed clip gain remapped to child-local time", Math.abs(getCompositionVolume(foldedChild, { currentTimeSeconds: 6 }) - 0.25) < 1e-6);

    // A child with its OWN volume effect keeps it, scaled by clip STATIC gain × fader.
    const ownVol = { id: "ovol", type: "volume" as const, name: "Volume", enabled: true, intensity: 100, params: { gain: 200 } };
    const ownChild = mkLayer({ id: "ow", trackId: "onest_t1", type: "audio", startSeconds: 0, durationSeconds: 8, effects: [ownVol] });
    const ownNest = {
      ...mkComp("onest", 8, [ownChild]),
      tracks: [{ id: "onest_t1", type: "audio" as const, name: "A1", layers: [ownChild], volume: 0.5 }]
    };
    const ownClip = mkLayer({ id: "oc", trackId: "oroot_t1", nestedCompositionId: "onest", startSeconds: 0, durationSeconds: 8, effects: [{ ...volEffect, params: { gain: 80 } }] });
    const ownRoot = mkComp("oroot", 12, [ownClip]);
    const ownExp = expandNestedCompositions(ownRoot, { onest: ownNest, oroot: ownRoot });
    const ownFolded = ownExp.composition.tracks[0]!.layers.find((l) => l.id === "oc__nest_ow")!;
    // 200% (child) × 80% (clip static) × 0.5 (fader) = 0.8.
    check("audio fold: child's own volume scaled by clip static gain × fader", Math.abs(getCompositionVolume(ownFolded, { currentTimeSeconds: 1 }) - 0.8) < 1e-6);
    // Unity everything stays untouched (no synthesized effect on a plain nest).
    const plainExp = expandNestedCompositions(rootComp, compositions);
    const plainChild = plainExp.composition.tracks[0]!.layers.find((l) => l.id === "nc1__nest_cv")!;
    check("audio fold: unity gain adds no effect", !plainChild.effects.some((e) => e.type === "volume"));
  }
}

// --- buildSceneDraws: compound-clip GROUP folding (NESTING.md Phase C, Block 1) -----------------
{
  const mkLayer = (over: Partial<TimelineLayer> & { id: string; trackId: string }): TimelineLayer => ({
    type: "video",
    name: over.id,
    startSeconds: 0,
    durationSeconds: 4,
    assetId: "asset1",
    transform: { position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 100 },
    effects: [],
    keyframes: [],
    ...over
  });
  const mkComp = (id: string, durationSeconds: number, layers: TimelineLayer[], dims: { width: number; height: number }) => ({
    id,
    name: id,
    width: dims.width,
    height: dims.height,
    fps: 30,
    durationSeconds,
    backgroundColor: "#000",
    tracks: [{ id: `${id}_t1`, type: "video" as const, name: "V1", layers }]
  });
  const kindOf = (d: unknown): string | undefined => (d as { kind?: string }).kind;

  // Nest sized DIFFERENTLY from the parent (400x300 vs 1080x1920) so the text child's raster call proves
  // it built against the NEST's own w/h, not the parent's (check "nested-comp size reaches the child").
  const sceneNestVideo = mkLayer({ id: "sv", trackId: "sn_t1", durationSeconds: 4 });
  const sceneNestText = mkLayer({ id: "st", trackId: "sn_t1", type: "text", text: "Hi", startSeconds: 0, durationSeconds: 4 });
  const sceneNestComp = mkComp("sceneNest", 4, [sceneNestVideo, sceneNestText], { width: 400, height: 300 });

  const sceneCompound = mkLayer({
    id: "sc1",
    trackId: "sroot_t1",
    nestedCompositionId: "sceneNest",
    startSeconds: 0,
    durationSeconds: 4,
    masks: [createBoxMask("rectangle", 0, 0, 1080, 1920, 0)],
    blendMode: "screen",
    effects: [{ id: "sc1_blur", type: "blur", name: "Blur", enabled: true, intensity: 100, params: { amount: 10 } }]
  });
  const scenePlain = mkLayer({ id: "splain", trackId: "sroot_t1", startSeconds: 10, durationSeconds: 1 });
  const sceneRoot = mkComp("sroot", 12, [sceneCompound, scenePlain], { width: 1080, height: 1920 });
  const sceneCompositions = { sceneNest: sceneNestComp, sroot: sceneRoot };
  const sceneExpanded = expandNestedCompositions(sceneRoot, sceneCompositions);

  const rasterCalls: Array<{ id: string; w: number; h: number }> = [];
  const rasterizerStub = {
    get: (layer: TimelineLayer, _t: number, w: number, h: number, boxMode: boolean) => {
      rasterCalls.push({ id: layer.id, w, h });
      return { canvas: { width: 64, height: 32 }, boxHalfW: boxMode ? 32 : undefined, boxHalfH: boxMode ? 16 : undefined };
    },
    versionOf: () => 1
  };
  const matteCacheCalls: string[] = [];
  const matteCacheStub = {
    get: (layer: TimelineLayer) => {
      if (!layer.masks?.length) return null;
      matteCacheCalls.push(layer.id);
      return { width: 4, height: 4 };
    },
    versionOf: () => 1
  };
  // Ready set: the nested VIDEO child (id contains "sv") and the top-level "splain" clip. The nested TEXT
  // child is "ready" only when a real rasterizer is supplied (see the zero-ready-children case below).
  const getMediaGraded = (id: string) => (id.includes("sv") || id === "splain" ? { width: 640, height: 360 } : null);

  const draws = buildSceneDraws({
    layers: sceneExpanded.composition.tracks[0]!.layers,
    width: 1080,
    height: 1920,
    currentTime: 1,
    renderScale: 1,
    transitions: [],
    rasterizer: rasterizerStub as never,
    matteCache: matteCacheStub as never,
    gradeRenderers: new Map(),
    getMediaGraded: getMediaGraded as never,
    createCanvas: () => {
      throw new Error("unexpected createCanvas in this fixture (no color pipeline)");
    },
    regionPassModel: false,
    nestedGroups: sceneExpanded.groups
  });

  check("buildSceneDraws: exactly one group draw for one compound instance", draws.filter((d) => kindOf(d) === "group").length === 1);
  const groupDraw = draws.find((d) => kindOf(d) === "group") as unknown as
    | { children: unknown[]; nestWidth: number; nestHeight: number; shell: { mask: unknown; blurPx?: number; blendMode?: string } }
    | undefined;
  check("buildSceneDraws: group emitted at the compound's z-slot, before the plain clip", draws.length === 2 && kindOf(draws[0]) === "group");
  check("buildSceneDraws: group has both nested children (video + text) in nested order", groupDraw?.children.length === 2);
  check("buildSceneDraws: nestWidth/nestHeight carry the NESTED comp's size, not the parent's", groupDraw?.nestWidth === 400 && groupDraw?.nestHeight === 300);
  check(
    "buildSceneDraws: nested text child's raster built against the NEST's own w/h",
    rasterCalls.some((c) => c.id === "sc1__nest_st" && c.w === 400 && c.h === 300)
  );
  check("buildSceneDraws: shell carries the compound clip's own mask", Boolean(groupDraw?.shell.mask) && matteCacheCalls.includes("sc1"));
  check("buildSceneDraws: shell carries the compound clip's own blur", (groupDraw?.shell.blurPx ?? 0) > 0);
  check("buildSceneDraws: shell carries the compound clip's own blend mode", groupDraw?.shell.blendMode === "screen");

  // Zero-ready-children: no rasterizer (blocks the text child) and getMediaGraded excludes the nested video
  // child (blocks it too) — the group must emit NOTHING (not a crash), while the unrelated "splain" clip
  // (still ready) draws normally.
  const emptyDraws = buildSceneDraws({
    layers: sceneExpanded.composition.tracks[0]!.layers,
    width: 1080,
    height: 1920,
    currentTime: 1,
    renderScale: 1,
    transitions: [],
    rasterizer: null,
    matteCache: null,
    gradeRenderers: new Map(),
    getMediaGraded: ((id: string) => (id === "splain" ? { width: 640, height: 360 } : null)) as never,
    createCanvas: () => {
      throw new Error("unexpected createCanvas in this fixture");
    },
    regionPassModel: false,
    nestedGroups: sceneExpanded.groups
  });
  check(
    "buildSceneDraws: zero-ready-children group emits nothing (rest of the comp still draws)",
    emptyDraws.length === 1 && !emptyDraws.some((d) => kindOf(d) === "group")
  );

  // Nest-in-nest: outer compound clip nests a MIDDLE compound clip, which itself nests sceneNest — proves
  // hierarchical folding (the outer group's child is itself a SceneGroupDraw, not a flat layer).
  const midCompound = mkLayer({ id: "midc1", trackId: "midn_t1", nestedCompositionId: "sceneNest", startSeconds: 0, durationSeconds: 4 });
  const midNestComp = mkComp("midNest", 4, [midCompound], { width: 700, height: 500 });
  const outerCompound = mkLayer({ id: "outc1", trackId: "outer_t1", nestedCompositionId: "midNest", startSeconds: 0, durationSeconds: 4 });
  const outerRoot = mkComp("outerRoot", 4, [outerCompound], { width: 1080, height: 1920 });
  const nestInNestCompositions = { sceneNest: sceneNestComp, midNest: midNestComp, outerRoot };
  const nestInNestExpanded = expandNestedCompositions(outerRoot, nestInNestCompositions);
  const ninDraws = buildSceneDraws({
    layers: nestInNestExpanded.composition.tracks[0]!.layers,
    width: 1080,
    height: 1920,
    currentTime: 1,
    renderScale: 1,
    transitions: [],
    rasterizer: rasterizerStub as never,
    matteCache: matteCacheStub as never,
    gradeRenderers: new Map(),
    getMediaGraded: getMediaGraded as never,
    createCanvas: () => {
      throw new Error("unexpected createCanvas in this fixture");
    },
    regionPassModel: false,
    nestedGroups: nestInNestExpanded.groups
  });
  check("buildSceneDraws: exactly one TOP-LEVEL group draw for a nest-in-nest", ninDraws.length === 1 && kindOf(ninDraws[0]) === "group");
  const outerGroup = ninDraws[0] as unknown as { children: Array<{ kind?: string }> };
  check(
    "buildSceneDraws: nest-in-nest folds hierarchically (outer group's child is itself a group)",
    outerGroup.children.length === 1 && outerGroup.children[0]?.kind === "group"
  );
}

// --- .kimera ZIP package round-trip (Task 1.6: embedded-media packages) --------
{
  const layer: TimelineLayer = {
    id: "v1",
    trackId: "t1",
    type: "video",
    name: "v1",
    startSeconds: 0,
    durationSeconds: 4,
    assetId: "asset_test",
    transform: { position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 100 },
    effects: [],
    keyframes: []
  };
  const composition = {
    id: "zipTest",
    name: "zipTest",
    width: 1080,
    height: 1920,
    fps: 30,
    durationSeconds: 4,
    backgroundColor: "#000",
    tracks: [{ id: "t1", type: "video" as const, name: "V1", layers: [layer] }]
  };
  const graph = {
    projectId: "proj_zip_test",
    effects: [],
    editableFields: {},
    composition,
    version: 1
  };
  const asset = {
    id: "asset_test",
    userId: "user_test",
    fileName: "clip.mp4",
    fileType: "video/mp4",
    fileUrl: "blob:asset_test",
    durationSeconds: 4,
    width: 1080,
    height: 1920,
    status: "ready" as const,
    createdAt: new Date().toISOString()
  };
  const pkg = buildTimelineTemplatePackage({ projectId: graph.projectId, title: "Zip Test", graph, composition, assets: [asset] });
  const assetBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const zip = buildKimeraPackageZip({ pkg, assets: [{ id: "asset_test", fileName: "clip.mp4", bytes: assetBytes }] });
  check("kimera zip: produces ZIP magic bytes", isKimeraPackageZipBytes(zip));
  const parsed = parseKimeraPackageZip(zip);
  check("kimera zip: timeline layer count survives", parsed.pkg.graph.composition?.tracks[0]?.layers.length === 1);
  check("kimera zip: manifest name survives", parsed.pkg.manifest.name === "Zip Test");
  const roundTrippedBytes = parsed.assetBytes.get("asset_test");
  check(
    "kimera zip: asset bytes survive byte-for-byte",
    Boolean(roundTrippedBytes) && roundTrippedBytes!.length === assetBytes.length && roundTrippedBytes!.every((b, i) => b === assetBytes[i])
  );
  check("kimera zip: bare JSON bytes are NOT sniffed as ZIP", !isKimeraPackageZipBytes(new TextEncoder().encode(JSON.stringify(pkg))));
}

// --- Shared transition-name mapping table (Task 2.1) --------------------------
{
  check("mapExternalTransition: Cross Dissolve -> crossDissolve", mapExternalTransition("Cross Dissolve").kind === "crossDissolve");
  check("mapExternalTransition: Film Dissolve -> crossDissolve", mapExternalTransition("Film Dissolve").kind === "crossDissolve");
  check("mapExternalTransition: Dip to Black -> dip with black param", (() => {
    const m = mapExternalTransition("Dip to Black");
    const color = m.params?.dipColor;
    return m.kind === "dip" && Array.isArray(color) && color[0] === 0 && color[1] === 0 && color[2] === 0;
  })());
  check("mapExternalTransition: Dip to White -> dip with white param", (() => {
    const m = mapExternalTransition("Dip to White");
    const color = m.params?.dipColor;
    return m.kind === "dip" && Array.isArray(color) && color[0] === 1 && color[1] === 1 && color[2] === 1;
  })());
  check("mapExternalTransition: Wipe Left -> wipe", mapExternalTransition("Wipe Left").kind === "wipe");
  check("mapExternalTransition: Push -> push", mapExternalTransition("Push").kind === "push");
  check("mapExternalTransition: Slide -> slide", mapExternalTransition("Slide").kind === "slide");
  check("mapExternalTransition: Cross Zoom -> zoom", mapExternalTransition("Cross Zoom").kind === "zoom");
  check("mapExternalTransition: Iris Round -> iris", mapExternalTransition("Iris Round").kind === "iris");
  check("mapExternalTransition: unknown name falls back to crossDissolve", mapExternalTransition("Whatever").kind === "crossDissolve");
}

// --- FCPXML export round-trip (Task 2.4) --------------------------------------
{
  const clipA: TimelineLayer = {
    id: "clipA",
    trackId: "t1",
    type: "video",
    name: "Clip A",
    startSeconds: 0,
    durationSeconds: 4,
    assetId: "asset1",
    transform: { position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 100 },
    effects: [],
    keyframes: []
  };
  const clipB: TimelineLayer = {
    id: "clipB",
    trackId: "t1",
    type: "video",
    name: "Clip B",
    startSeconds: 4,
    durationSeconds: 4,
    assetId: "asset2",
    transitionIn: { kind: "crossDissolve", durationSeconds: 1 },
    transform: { position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 100 },
    effects: [],
    keyframes: []
  };
  const titleClip: TimelineLayer = {
    id: "titleClip",
    trackId: "t1",
    type: "text",
    name: "Title Clip",
    text: "Round Trip Title",
    startSeconds: 8,
    durationSeconds: 2,
    transform: { position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 100 },
    effects: [],
    keyframes: []
  };
  const exportComposition = {
    id: "exportFixture",
    name: "Export Fixture",
    width: 1920,
    height: 1080,
    fps: 30,
    durationSeconds: 10,
    backgroundColor: "#000",
    tracks: [{ id: "t1", type: "video" as const, name: "V1", layers: [clipA, clipB, titleClip] }]
  };
  const exportAssets: SourceAsset[] = [
    {
      id: "asset1",
      userId: "user_test",
      fileName: "clip-a.mp4",
      fileType: "video/mp4",
      fileUrl: "https://example.test/clip-a.mp4",
      durationSeconds: 4,
      width: 1920,
      height: 1080,
      status: "ready",
      createdAt: new Date().toISOString()
    },
    {
      id: "asset2",
      userId: "user_test",
      fileName: "clip-b.mp4",
      fileType: "video/mp4",
      fileUrl: "https://example.test/clip-b.mp4",
      durationSeconds: 4,
      width: 1920,
      height: 1080,
      status: "ready",
      createdAt: new Date().toISOString()
    }
  ];
  const exported = exportCompositionToFcpxml(exportComposition, exportAssets);
  check("fcpxml export reports the transition mapping", exported.report.mapped.some((item) => item.code === "fcpxml.export.transition"));
  check("fcpxml export reports the title mapping", exported.report.mapped.some((item) => item.code === "fcpxml.export.title"));

  const reimported = parseExternalTimelineFile({
    fileName: "roundtrip.fcpxml",
    contents: exported.xml,
    projectId: "fcpxml_export_roundtrip",
    projectTitle: "Roundtrip"
  });
  const reimportedClips = reimported.composition.tracks.flatMap((track) => track.layers);
  check("fcpxml export round-trip: clip count survives", reimportedClips.length === 3);
  const reimportedClipB = reimportedClips.find((layer) => layer.name === "Clip B");
  const reimportedTitle = reimportedClips.find((layer) => layer.type === "text");
  check(
    "fcpxml export round-trip: timing survives",
    Math.abs((reimportedClipB?.startSeconds ?? -1) - 4) < 0.01 && Math.abs((reimportedClipB?.durationSeconds ?? -1) - 4) < 0.01
  );
  check("fcpxml export round-trip: title text survives", reimportedTitle?.text === "Round Trip Title");
  check("fcpxml export round-trip: transition kind survives", reimportedClipB?.transitionIn?.kind === "crossDissolve");
}

// --- Cross-tool mask reuse: mask-resolver lookup tiers -------------------------
{
  const {
    clearSessionArtifactIndex,
    findReusableMask,
    findReusableTrackingPath,
    isDurableMatteUri,
    maskFromMatteRef,
    registerMaskForAsset,
    registerTrackingForAsset
  } = await import("../tools/mask-resolver");

  check("mask reuse: durable uri accepts http(s) only", isDurableMatteUri("https://api.test/storage/m.webm") && !isDurableMatteUri("blob:https://app/x") && !isDurableMatteUri("opfs://kimera-tool-artifacts/a.bin") && !isDurableMatteUri(undefined));

  const matte = {
    artifactId: "mask_browser_1",
    uri: "https://api.test/storage/uploads/matte.webm",
    kind: "luma" as const,
    fps: 24,
    feather: 4,
    edgeMode: "clean" as const
  };
  const maskedLayer: TimelineLayer = {
    id: "mv1",
    trackId: "mt1",
    type: "video",
    name: "Subject",
    startSeconds: 0,
    durationSeconds: 6,
    assetId: "asset_mask_src",
    matte,
    transform: { position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 100 },
    effects: [],
    keyframes: []
  };
  const blobMattedLayer: TimelineLayer = {
    ...maskedLayer,
    id: "mv2",
    assetId: "asset_blob_only",
    matte: { ...matte, artifactId: "mask_blob_1", uri: "blob:https://app/dead" }
  };
  const maskComposition = {
    id: "maskReuse",
    name: "maskReuse",
    width: 1080,
    height: 1920,
    fps: 30,
    durationSeconds: 6,
    backgroundColor: "#000",
    tracks: [{ id: "mt1", type: "video" as const, name: "V1", layers: [maskedLayer, blobMattedLayer] }]
  };
  const asset = { width: 1080, height: 1920, durationSeconds: 6 };

  clearSessionArtifactIndex();
  const compositionHit = findReusableMask({ sourceAssetId: "asset_mask_src", asset, composition: maskComposition });
  check(
    "mask reuse: composition scan finds a durable matte and rebuilds the artifact",
    compositionHit?.origin === "composition" &&
      compositionHit.mask.id === "mask_browser_1" &&
      compositionHit.mask.matteVideoUri === matte.uri &&
      compositionHit.mask.width === 1080 &&
      compositionHit.mask.durationSeconds === 6 &&
      compositionHit.mask.edgeMode === "clean"
  );
  check("mask reuse: blob: matte on a layer is never reused", findReusableMask({ sourceAssetId: "asset_blob_only", asset, composition: maskComposition }) === undefined);
  check("mask reuse: unrelated asset finds nothing", findReusableMask({ sourceAssetId: "asset_other", asset, composition: maskComposition }) === undefined);

  const durableFieldsMask = {
    id: "mask_fields_1",
    sourceAssetId: "asset_fields",
    width: 720,
    height: 1280,
    fps: 24,
    durationSeconds: 5,
    frames: [],
    matteVideoUri: "https://api.test/storage/uploads/fields.webm",
    feather: 4,
    edgeMode: "clean" as const,
    source: "browser" as const
  };
  const fieldsHit = findReusableMask({ sourceAssetId: "asset_fields", editableFields: { maskSequence: durableFieldsMask } });
  check("mask reuse: editableFields mask with matching sourceAssetId is reused", fieldsHit?.origin === "editableFields" && fieldsHit.mask.id === "mask_fields_1");
  check(
    "mask reuse: editableFields mask with a dead blob: uri is skipped",
    findReusableMask({ sourceAssetId: "asset_fields", editableFields: { maskSequence: { ...durableFieldsMask, matteVideoUri: "blob:https://app/dead" } } }) === undefined
  );
  check(
    "mask reuse: editableFields mask for a different asset is skipped",
    findReusableMask({ sourceAssetId: "asset_other", editableFields: { maskSequence: durableFieldsMask } }) === undefined
  );

  // Session index outranks everything and prefers the clean (quality) bake.
  registerMaskForAsset("asset_mask_src", { ...durableFieldsMask, id: "mask_session_fast", sourceAssetId: "asset_mask_src", edgeMode: "fast", matteVideoUri: "blob:https://app/live-fast" });
  const fastSessionHit = findReusableMask({ sourceAssetId: "asset_mask_src", asset, composition: maskComposition });
  check("mask reuse: session index outranks the composition scan", fastSessionHit?.origin === "session" && fastSessionHit.mask.id === "mask_session_fast");
  registerMaskForAsset("asset_mask_src", { ...durableFieldsMask, id: "mask_session_clean", sourceAssetId: "asset_mask_src", edgeMode: "clean", matteVideoUri: "blob:https://app/live-clean" });
  const cleanSessionHit = findReusableMask({ sourceAssetId: "asset_mask_src", asset, composition: maskComposition });
  check("mask reuse: clean session bake preferred over fast", cleanSessionHit?.mask.id === "mask_session_clean");

  const rebuilt = maskFromMatteRef(matte, "asset_mask_src", asset);
  check("mask reuse: maskFromMatteRef round-trips ref fields", rebuilt.id === matte.artifactId && rebuilt.fps === 24 && rebuilt.feather === 4 && rebuilt.frames.length === 0 && rebuilt.sourceAssetId === "asset_mask_src");

  const trackingPath = {
    id: "track_1",
    sourceAssetId: "asset_track",
    durationSeconds: 6,
    smoothing: 0.4,
    source: "browser" as const,
    points: [{ timeSeconds: 0, position: { x: 50, y: 50 }, bounds: { timeSeconds: 0, x: 40, y: 30, width: 20, height: 40, confidence: 0.9 }, confidence: 0.9 }]
  };
  registerTrackingForAsset("asset_track", trackingPath);
  check("track reuse: session tracking path found", findReusableTrackingPath({ sourceAssetId: "asset_track", minimumDurationSeconds: 6 })?.origin === "session");
  check("track reuse: too-short tracking path rejected", findReusableTrackingPath({ sourceAssetId: "asset_track", minimumDurationSeconds: 9 }) === undefined);
  check(
    "track reuse: editableFields tracking path honored",
    findReusableTrackingPath({ sourceAssetId: "asset_track2", editableFields: { trackingPath: { ...trackingPath, sourceAssetId: "asset_track2" } } })?.origin === "editableFields"
  );
  clearSessionArtifactIndex();

  // --- Matte export choke point: collect + rewrite ------------------------------
  const { collectUnresolvedMattes, rewriteMatteUris } = await import("../export/matte-resolve");

  const blobLayer: TimelineLayer = { ...maskedLayer, id: "e1", name: "Blob matte", matte: { ...matte, artifactId: "m_blob", uri: "blob:https://app/x" } };
  const opfsLayer: TimelineLayer = { ...maskedLayer, id: "e2", name: "OPFS matte", matte: { ...matte, artifactId: "m_opfs", uri: "opfs://kimera-tool-artifacts/m_opfs.bin" } };
  const missingUriLayer: TimelineLayer = { ...maskedLayer, id: "e3", name: "No uri", matte: { ...matte, artifactId: "m_none", uri: undefined } };
  const httpLayer: TimelineLayer = { ...maskedLayer, id: "e4", name: "Http matte", matte: { ...matte, artifactId: "m_http" } };
  const plainLayer: TimelineLayer = { ...maskedLayer, id: "e5", name: "No matte" };
  delete (plainLayer as { matte?: unknown }).matte;
  const exportComposition2 = {
    ...maskComposition,
    id: "matteResolve",
    tracks: [
      { id: "rt1", type: "video" as const, name: "V1", layers: [blobLayer, opfsLayer, missingUriLayer] },
      { id: "rt2", type: "video" as const, name: "V2", layers: [httpLayer, plainLayer] }
    ]
  };

  const unresolved = collectUnresolvedMattes(exportComposition2);
  check(
    "matte resolve: collect flags blob:/opfs:/missing and passes http(s)",
    unresolved.length === 3 &&
      unresolved.some((item) => item.artifactId === "m_blob") &&
      unresolved.some((item) => item.artifactId === "m_opfs") &&
      unresolved.some((item) => item.artifactId === "m_none" && item.layerName === "No uri") &&
      !unresolved.some((item) => item.artifactId === "m_http")
  );
  check("matte resolve: collect on undefined composition is empty", collectUnresolvedMattes(undefined).length === 0);

  const rewritten = rewriteMatteUris(exportComposition2, {
    m_blob: "https://api.test/storage/uploads/resolved-blob.webm",
    m_opfs: "https://api.test/storage/uploads/resolved-opfs.webm"
  });
  const rewrittenLayers = rewritten.tracks.flatMap((track) => track.layers);
  check(
    "matte resolve: rewrite swaps only matching artifact uris",
    rewrittenLayers.find((l) => l.id === "e1")?.matte?.uri === "https://api.test/storage/uploads/resolved-blob.webm" &&
      rewrittenLayers.find((l) => l.id === "e2")?.matte?.uri === "https://api.test/storage/uploads/resolved-opfs.webm" &&
      rewrittenLayers.find((l) => l.id === "e3")?.matte?.uri === undefined
  );
  check(
    "matte resolve: rewrite preserves other matte fields and untouched references",
    rewrittenLayers.find((l) => l.id === "e1")?.matte?.feather === matte.feather &&
      rewritten.tracks[1] === exportComposition2.tracks[1] &&
      rewrittenLayers.find((l) => l.id === "e4") === httpLayer
  );
  check("matte resolve: rewrite with no matches returns the same composition", rewriteMatteUris(exportComposition2, { unrelated: "https://x" }) === exportComposition2);
  check("matte resolve: no-uri matte still resolvable by artifactId", rewriteMatteUris(exportComposition2, { m_none: "https://api.test/m.webm" }).tracks[0]!.layers[2]!.matte?.uri === "https://api.test/m.webm");

  // --- Dependency resolver: durable artifacts satisfy auto-inserted prerequisites ---
  const { artifactSatisfiesModule, resolveModuleInsertions } = await import("@kimera-by-aelivion/shared");

  const durableFields = { maskSequence: durableFieldsMask, trackingPath: { ...trackingPath, sourceAssetId: "asset_fields" } };
  check(
    "dep threading: durable mask satisfies PERSON_EXTRACTION with artifact ref",
    artifactSatisfiesModule("PERSON_EXTRACTION", durableFields)?.maskSequenceId === durableFieldsMask.id
  );
  check(
    "dep threading: blob: mask never satisfies a dependency",
    artifactSatisfiesModule("PERSON_EXTRACTION", { maskSequence: { ...durableFieldsMask, matteVideoUri: "blob:https://app/x" } }) === undefined
  );
  check("dep threading: tracking path satisfies PERSON_TRACKING", artifactSatisfiesModule("PERSON_TRACKING", durableFields)?.trackingPathId === "track_1");
  check("dep threading: empty points never satisfy PERSON_TRACKING", artifactSatisfiesModule("PERSON_TRACKING", { trackingPath: { ...trackingPath, points: [] } }) === undefined);

  const threaded = resolveModuleInsertions([], "TEXT_BEHIND_PERSON", { editableFields: durableFields });
  const threadedExtract = threaded.find((effect) => effect.type === "PERSON_EXTRACTION");
  const threadedRequested = threaded.find((effect) => effect.type === "TEXT_BEHIND_PERSON");
  check(
    "dep threading: satisfied prerequisite inserts as ready with the artifact in config",
    threadedExtract?.status === "ready" && threadedExtract.config.satisfiedByArtifact === true && threadedExtract.config.maskSequenceId === durableFieldsMask.id
  );
  check("dep threading: the requested module itself always inserts idle", threadedRequested?.status === "idle");

  const unthreaded = resolveModuleInsertions([], "TEXT_BEHIND_PERSON");
  check(
    "dep threading: without artifacts the prerequisite inserts idle with default config",
    unthreaded.find((effect) => effect.type === "PERSON_EXTRACTION")?.status === "idle" &&
      unthreaded.find((effect) => effect.type === "PERSON_EXTRACTION")?.config.satisfiedByArtifact === undefined
  );
  check(
    "dep threading: follow-text threads both mask and tracking prerequisites",
    resolveModuleInsertions([], "SMART_3D_FOLLOW_TEXT", { editableFields: durableFields }).filter((effect) => effect.status === "ready").length === 2
  );

  // --- Standalone vs editor apply modes (the handler contract's `context` maps onto these) ---
  const { applyTextBehindPersonComposition } = await import("@kimera-by-aelivion/shared");
  const tbpOptions = { text: "HELLO", textColor: "#fff", maskId: durableFieldsMask.id, mask: durableFieldsMask, sourceAssetId: "asset_mask_src" };
  const editorApply = applyTextBehindPersonComposition(maskComposition, tbpOptions, "insert");
  const standaloneApply = applyTextBehindPersonComposition(maskComposition, tbpOptions, "replace");
  check(
    "apply modes: editor insert keeps existing timeline tracks, standalone replace drops them",
    editorApply.tracks.some((track) => track.id === "mt1") && !standaloneApply.tracks.some((track) => track.id === "mt1") && standaloneApply.tracks.length === 3
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll editor foundation checks passed");
