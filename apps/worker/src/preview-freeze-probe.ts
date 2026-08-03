/**
 * PREVIEW FREEZE PROBE — where playback stops making forward progress, in the minimal repro.
 *
 * WHY THIS EXISTS, and why `preview:profile` could not answer it. That profiler ranks CPU by self time
 * over a 10s window, which answers "what is expensive". A freeze is not an expense — it is an ABSENCE:
 * a window in which the pipeline produced nothing. Its own commit says the gap out loud:
 *
 *     "mediaFps was 0.0 in both runs — the fixture's comp reads its host clip and builds no
 *      asset-source virtual loader, so this profile barely decodes."
 *
 * So the instrument that exists measures a comp with ZERO virtual loaders, and the reported bug is a
 * comp with TWO. This probe builds that comp and measures the absence directly.
 *
 * THE FIXTURE is the reported repro, built through the product's own data:
 *   track 1: [ clip A · plain media ][ clip B · Flarex comp ]
 *   comp on B: MediaIn(host = asset B) ─┐
 *              MediaIn(sourceAssetId = asset A) → Transform ─┴→ Merge → MediaOut
 * Two MediaIns, no effects. The assets arrive through the real upload path; only the GRAPH is written
 * as data, because there is no click path that wires a second loader without a canvas drag.
 *
 * WHAT IT MEASURES. Three clocks that must agree, and the disagreement is the finding:
 *   1. rAF forward progress — the compositor's own heartbeat. A gap here is the freeze the user sees.
 *   2. `longtask` entries — main thread blocked, with duration. Answers WHETHER the thread was blocked
 *      at all, which is the fork in the whole diagnosis: a freeze WITHOUT a long task is starvation
 *      (nothing to draw), a freeze WITH one is occupancy (no turn in which to draw).
 *   3. A V8 CPU profile recorded over the SAME window, aligned onto the page clock, so every freeze
 *      window can be asked "which stack was on the CPU while nothing was presenting".
 *
 * Plus the per-source picture at the instant of each gap (`__rfSourceMap`), so a starvation freeze can
 * name the source that stopped delivering rather than being reported as "the decoder".
 *
 * Run (a server must be up):
 *   PIXEL_BROWSER_CHANNEL=chrome PROBE_BASE=http://localhost:4173 pnpm --filter @orreris/worker preview:freeze
 *   FREEZE_SECONDS=25 ...     (default 20)
 *   FREEZE_GAP_MS=50 ...      report gaps over this (default 33 — one 30fps frame)
 *   FREEZE_KEEP_OPEN=1 ...    leave the browser open at the end for manual inspection
 */
import fs from "node:fs";
import path from "node:path";
import { chromium, type CDPSession, type Page } from "playwright";
import { defaultClipPath, reachEditor } from "./browser/editor-session";

const SECONDS = Number(process.env.FREEZE_SECONDS ?? 20);
/** Which fixture to build: `two-in` (the repro), `one-in` (control), `no-comp` (baseline). */
const ARM = process.env.FREEZE_ARM ?? "two-in";
const GAP_MS = Number(process.env.FREEZE_GAP_MS ?? 33);
/** `FREEZE_PIXEL=0` disables canvas hashing — the control run for this probe's own observer effect. */
const PIXEL_SAMPLING = process.env.FREEZE_PIXEL !== "0";
const SAMPLE_INTERVAL_US = 100;
const OUT_DIR = process.env.FREEZE_OUT ?? path.resolve("tmp/freeze-probe");

const PLAY = '.viewer-controls button[title^="Play"]';
const PAUSE = '.viewer-controls button[title^="Pause"]';

interface CallFrame {
  functionName: string;
  url: string;
  lineNumber: number;
}
interface ProfileNode {
  id: number;
  callFrame: CallFrame;
  children?: number[];
  parent?: number;
}
interface CpuProfile {
  nodes: ProfileNode[];
  startTime: number;
  endTime: number;
  samples?: number[];
  timeDeltas?: number[];
}

/** A gap in rAF delivery, with everything that was true at the moment it was noticed. */
interface GapRecord {
  /** page `performance.now()` of the frame that ENDED the gap. */
  at: number;
  /** ms since the previous rAF callback. */
  dt: number;
  /** Clock state after the gap — `committed` frozen across a gap means the transport itself stalled. */
  clockBefore: { committed: number; live: number } | null;
  clockAfter: { committed: number; live: number } | null;
  statsBefore: Record<string, unknown> | null;
  sourcesBefore: Record<string, unknown> | null;
  sourcesAfter: Record<string, unknown> | null;
  holdsBefore: number;
  holdsAfter: number;
}

interface PageReport {
  /** Ground truth: how long each distinct PICTURE stayed on the preview canvas, in ms. */
  picture: { holds: { ms: number; start: number; at: number | null }[]; samples: number; fails: number; openHoldMs: number } | null;
  /**
   * Per source: how long each SERVED frame stayed on screen, from `__rfSourceMap.served`.
   *
   * The honest half of `picture` above. It costs nothing to collect, where the pixel sampler's
   * `getImageData` forces a GPU readback that was itself 207ms of a 450ms measured hold. With
   * `FREEZE_PIXEL=0` (the default) this is the ONLY forward-progress signal, which is why the
   * boundary report falls back to it for its attribution windows.
   */
  pictureStalls: Record<
    string,
    { label: string; decode: string; stalls: { end: number; ms: number; state: string; stale: number | null }[] }
  >;
  /** Per source: contiguous runs (ms) of "no decode exists for this moment". */
  awaitingRuns: Record<string, { label: string; decode: string; runs: { ms: number; start: number; at: number | null }[]; composites: number; awaitComposites: number }>;
  videoPool: unknown;
  reasons: Record<string, { label: string; decode: string; counts: Record<string, number> }> | null;
  elementClock: Record<string, { label: string; decode: string; samples: number; ready: Record<string, number>; stalls: { ms: number; at: number; ready: number; paused: boolean }[] }> | null;
  routing: Record<string, { at: number; route: string; preferNativeDecode: boolean; bailed: boolean; tolerateLag: boolean; hidden: boolean }[]> | null;
  /** Every observed change in any published counter, with the playhead it happened at. */
  events: { t: number; playhead: number | null; key: string; from: unknown; to: unknown }[];
  videos: Record<string, { samples: number; notReady: number; zeroWidth: number; pausedWhilePlaying: number; readyStates: Record<string, number>; stalls: { ms: number; at: number | null }[]; seeking: number }> | null;
  elementNudges: number;
  staleDrawKicks: number;
  strictSyncCorrections: number;
  frames: number;
  spanMs: number;
  t0: number;
  t1: number;
  gaps: GapRecord[];
  longtasks: { at: number; dur: number; name: string }[];
  finalSources: Record<string, unknown> | null;
  finalStats: Record<string, unknown> | null;
  wcPool: unknown;
  wcHeals: Record<string, number> | null;
  wcMode: unknown;
  wcStaleTime: unknown;
  wcDecoder: unknown;
  degradation: unknown;
  /** Every observed change of a source's decode path, with the page-clock moment it happened. */
  modeLog: { at: number; id: string; label: string; from: string; to: string }[];
  loaderRates: unknown;
  readahead: unknown;
}

function shortUrl(url: string): string {
  if (!url) return "(native)";
  const withoutQuery = url.split("?")[0] ?? url;
  const deps = /\/(?:node_modules|deps|\.vite)\/(.+)$/.exec(withoutQuery);
  if (deps) return `dep:${deps[1]}`;
  const src = /\/(src\/.+)$/.exec(withoutQuery);
  if (src) return src[1]!;
  const assets = /\/(assets\/[^/]+)$/.exec(withoutQuery);
  if (assets) return `bundle:${assets[1]}`;
  return withoutQuery.replace(/^https?:\/\/[^/]+\//, "");
}

/**
 * Build the two-clip / two-MediaIn fixture from the project's own persisted data.
 *
 * Returns a description of what was built so a failed fixture reports VOID rather than a confident
 * number about a project that does not contain the bug.
 */
async function buildTwoMediaInFixture(page: Page, assetBName: string): Promise<Record<string, unknown>> {
  // Passed as a STRING EXPRESSION with the argument INLINED, not as a function. Two constraints meet
  // here: tsx compiles with esbuild's `keepNames`, which rewrites named inner functions to call a
  // `__name` helper the page does not have (so a real function cannot be shipped); and Playwright
  // ignores the `arg` parameter when the first argument is a string (so the value must be baked in).
  // Each clip must outlast the measurement window with margin for warm-up and the pause click.
  const clipSeconds = Math.ceil(SECONDS / 2) + 4;
  return page.evaluate(`(${FIXTURE_FN})(${JSON.stringify({ assetBName, clipSeconds, arm: ARM })})`) as Promise<
    Record<string, unknown>
  >;
}

const FIXTURE_FN = String.raw`function (arg) {
  var assetBName = arg.assetBName;
  var read = function (key, fallback) {
    try { var raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; }
    catch (e) { return fallback; }
  };
  var projects = read("orreris_local_projects", []);
  var assets = read("orreris_local_assets", []);
  var m = /\/editor\/([^/?#]+)/.exec(location.pathname);
  var id = m ? m[1] : "";
  var project = projects.filter(function (p) { return p.id === id; })[0] || projects[0];
  if (!project) return { ok: false, why: "no local project" };

  var composition = project.projectGraph && project.projectGraph.composition;
  if (!composition) return { ok: false, why: "no composition" };

  // Clip A: the first video layer the upload flow placed on the timeline.
  var clipA = null, trackA = null;
  (composition.tracks || []).forEach(function (track) {
    (track.layers || []).forEach(function (layer) {
      if (layer.type === "video" && !clipA) { clipA = layer; trackA = track; }
    });
  });
  if (!clipA || !trackA) return { ok: false, why: "no video layer on the timeline" };

  // Asset B: the second import. Matched by name so a re-run cannot pick the seed clip.
  var assetB = assets.filter(function (a) {
    return String(a.originalName || a.name || "").indexOf(assetBName) >= 0;
  })[0] || assets.filter(function (a) { return a.id !== clipA.assetId; })[0];
  if (!assetB) {
    return { ok: false, why: "second asset not in the pool", want: assetBName,
             pool: assets.map(function (a) { return a.name || a.originalName || a.id; }) };
  }

  var armIsTwoIn = arg.arm.indexOf("two-in") === 0;
  var compId = "freeze_probe_comp";
  // The clips must OUTLAST the measurement window, and the composition must not outlast the clips.
  // Run 4 measured 40s over a composition with 20s of media and a 145s duration, so half of it
  // sampled an empty timeline, where a frozen picture is the CORRECT picture. That is the same trap
  // defaultClipPath() documents for the seed file, one level up.
  var assetSeconds = function (a) {
    var d = a && (a.durationSeconds || a.duration);
    return typeof d === "number" && isFinite(d) && d > 0 ? d : null;
  };
  var aSeconds = assetSeconds(assets.filter(function (x) { return x.id === clipA.assetId; })[0]) || clipA.durationSeconds || 30;
  var bSeconds = assetSeconds(assetB) || 30;
  var duration = Math.max(4, Math.min(arg.clipSeconds, aSeconds, bSeconds));

  // Clip A shortened so the probe reaches clip B quickly, and clip B placed straight after it.
  clipA.durationSeconds = duration;
  var clipB = JSON.parse(JSON.stringify(clipA));
  clipB.id = "freeze_probe_clip_b";
  clipB.name = "Flarex comp clip";
  clipB.assetId = assetB.id;
  clipB.startSeconds = duration;
  clipB.durationSeconds = duration;
  clipB.sourceInSeconds = 0;
  if (arg.arm.indexOf("no-comp") !== 0) clipB.flarexCompId = compId;
  trackA.layers = [clipA, clipB];

  // The comp: host MediaIn + one asset-source MediaIn, merged. No effects — the reported repro.
  var node = function (type, nodeId, x, y, params) {
    return { id: nodeId, type: type, label: "", x: x, y: y, enabled: true, params: params || {} };
  };
  var hostIn = compId + "_in", compOut = compId + "_out", srcIn = compId + "_srcin";
  var tf = compId + "_tf", merge = compId + "_merge";
  // THREE ARMS, so the reported cause can be tested rather than assumed:
  //   two-in  the reported repro - host MediaIn + one asset-source MediaIn, merged
  //   one-in  the same comp with the second MediaIn REMOVED (host straight to output)
  //   no-comp clip B as a plain media clip, no Flarex at all
  // Same seed clips, same window, same machine. Without the other two arms, any number the
  // two-MediaIn arm produces is a measurement of "this editor", not of "the second MediaIn".
  var nodes = {};
  nodes[hostIn] = node("mediaIn", hostIn, 0, 0, { sourceAssetId: "" });
  nodes[compOut] = node("mediaOut", compOut, 620, 60, {});
  var edges;
  if (armIsTwoIn) {
    nodes[srcIn] = node("mediaIn", srcIn, 0, 180, { sourceAssetId: clipA.assetId });
    nodes[tf] = node("transform", tf, 200, 180, { scale: 0.5, y: -10 });
    nodes[merge] = node("merge", merge, 400, 60, {});
    edges = [
      { id: compId + "_e1", from: { nodeId: hostIn, socket: "out" }, to: { nodeId: merge, socket: "bg" } },
      { id: compId + "_e2", from: { nodeId: srcIn, socket: "out" }, to: { nodeId: tf, socket: "in" } },
      { id: compId + "_e3", from: { nodeId: tf, socket: "out" }, to: { nodeId: merge, socket: "fg" } },
      { id: compId + "_e4", from: { nodeId: merge, socket: "out" }, to: { nodeId: compOut, socket: "in" } }
    ];
  } else {
    edges = [{ id: compId + "_e1", from: { nodeId: hostIn, socket: "out" }, to: { nodeId: compOut, socket: "in" } }];
  }
  var comp = {
    id: compId,
    name: "Freeze probe - 2 MediaIn",
    nodes: nodes,
    edges: edges,
    animations: [],
    version: 1
  };
  project.projectGraph.flarexComps = Object.assign({}, project.projectGraph.flarexComps || {});
  project.projectGraph.flarexComps[compId] = comp;
  // EXACTLY the two clips, not the seed file's own length: a composition longer than its media lets
  // the transport run off the end, where "the picture did not change" is correct behaviour.
  composition.durationSeconds = duration * 2;
  project.durationSeconds = composition.durationSeconds;
  project.updatedAt = new Date().toISOString();
  localStorage.setItem("orreris_local_projects", JSON.stringify(projects));

  return {
    ok: true,
    projectId: project.id,
    clipA: { id: clipA.id, assetId: clipA.assetId, start: clipA.startSeconds, dur: clipA.durationSeconds },
    clipB: { id: clipB.id, assetId: clipB.assetId, start: clipB.startSeconds, dur: clipB.durationSeconds },
    arm: arg.arm,
    mediaIns: armIsTwoIn ? 2 : arg.arm.indexOf("one-in") === 0 ? 1 : 0,
    clipSecondsEach: duration,
    assetMediaInReads: clipA.assetId,
    hostMediaInReads: clipB.assetId,
    compositionSeconds: composition.durationSeconds
  };
}`;

/**
 * Install the in-page recorder. Everything here runs on the page's own clock.
 *
 * Serialized as a string for the same reason the fixture is — see {@link FIXTURE_FN}.
 */
const RECORDER_FN = String.raw`function (arg) {
  var w = window;
  if (w.__freezeRec) return;
  var snap = function (o) {
    try { return JSON.parse(JSON.stringify(o == null ? null : o)); } catch (e) { return null; }
  };
  var clock = function () {
    return w.__rfClock ? { committed: w.__rfClock.committed, live: w.__rfClock.live } : null;
  };
  var rec = {
    gapMs: arg.gapMs, frames: 0,
    t0: performance.now(), t1: performance.now(),
    gaps: [], longtasks: [], modeLog: [], stop: false
  };
  w.__freezeRec = rec;

  var last = performance.now();
  var lastClock = clock();
  var lastSources = snap(w.__rfSourceMap);
  var lastStats = snap(w.__rfFrameStats);
  var lastHolds = w.__rfWcHolds || 0;

  // PICTURE forward progress, per source. The rAF gap above measures whether the COMPOSITOR is
  // running; this measures whether what it composites is a new frame. They are different failures
  // and the first run showed them disagreeing: 73 rAF callbacks/s while a source delivered 11.7 new
  // frames/s. A viewer watching that sees a frozen picture on a loop that never missed a beat, so
  // an instrument that only watched the loop would report the freeze as healthy.
  // GROUND TRUTH. Everything else in this probe reads the runtime's own account of itself, and two of
  // those accounts are already known to be unreliable on the ELEMENT path: servedSourceTime is
  // stamped only by the WebCodecs present, and frameVersion counts publishes. A freeze diagnosed
  // from those alone would be a freeze diagnosed from the suspect's testimony. So: sample the actual
  // preview canvas into a 32x32 2D canvas and hash the pixels. A picture that does not change is a
  // frozen picture, whatever any counter says, and the cost is ~0.1ms per composite.
  var probe = document.createElement("canvas");
  probe.width = 32; probe.height = 32;
  var pctx = probe.getContext("2d", { willReadFrequently: true });
  var findCanvas = function () {
    var list = document.querySelectorAll("canvas");
    var best = null;
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (c === probe) continue;
      if (!best || c.width * c.height > best.width * best.height) best = c;
    }
    return best;
  };
  var lastHash = null, lastHashAt = performance.now(), pixelHolds = [], hashSamples = 0, hashFails = 0;
  var mapAtLastChange = null;
  // Reason tallies per source: the whole point of the rebuild. Counted over AWAITING composites only.
  var reasons = {};
  w.__freezeReasons = function () { return reasons; };
  var noteReasons = function (map) {
    if (!map) return;
    for (var id in map) {
      var row = map[id];
      if (!row || !row.why) continue;
      var r = reasons[id] || (reasons[id] = { label: row.asset, decode: row.decode, counts: {} });
      r.label = row.asset; r.decode = row.decode;
      r.counts[row.why] = (r.counts[row.why] || 0) + 1;
    }
  };
  // ELEMENT CLOCK. A pooled <video> is never in the document, so this is the only view of it. A
  // frozen currentTime at readyState 4 is the BROWSER failing to decode; an advancing currentTime
  // under a frozen picture is US failing to consume.
  var elClock = {};
  w.__freezeElClock = function () { return elClock; };
  var noteElementClock = function (now, map) {
    if (!map) return;
    for (var id in map) {
      var row = map[id];
      if (!row || row.elTime == null) continue;
      var st = elClock[id] || (elClock[id] = { label: row.asset, decode: row.decode, last: row.elTime, since: now, stalls: [], ready: {}, samples: 0 });
      st.label = row.asset; st.decode = row.decode; st.samples++;
      st.ready[row.elReady] = (st.ready[row.elReady] || 0) + 1;
      if (row.elTime !== st.last) {
        if (now - st.since > 60) st.stalls.push({ ms: now - st.since, at: row.elTime, ready: row.elReady, paused: row.elPaused });
        st.last = row.elTime;
        st.since = now;
      }
    }
  };
  var samplePicture = function (now) {
    // OBSERVER EFFECT (measured 2026-08-02). drawImage(webglCanvas) + getImageData forces a GPU
    // readback sync, and the CPU profile attributed 207ms of a 450ms "hold" to getImageData itself -
    // roughly half the very thing being measured. The hash stays (it is the only ground truth for
    // what is on screen) but it must be switchable, so any conclusion can be checked against a run
    // that did not pay for it. See the served-time signal, which costs nothing and is valid on the
    // WebCodecs path.
    if (!arg.pixel) return;
    var c = findCanvas();
    if (!c || !pctx || c.width === 0) { hashFails++; return; }
    var h = 0;
    try {
      pctx.drawImage(c, 0, 0, 32, 32);
      var d = pctx.getImageData(0, 0, 32, 32).data;
      for (var i = 0; i < d.length; i += 4) { h = (h * 31 + d[i]) | 0; h = (h * 31 + d[i + 1]) | 0; }
      hashSamples++;
    } catch (e) { hashFails++; return; }
    if (lastHash === null) { lastHash = h; lastHashAt = now; return; }
    if (h === lastHash) return; // the same picture is still on screen — this hold is still open
    pixelHolds.push({
      ms: now - lastHashAt,
      start: lastHashAt,
      // The two ends of the hold. Comparing them answers, per source, whether anything moved while
      // the picture did not - which is the Case A / Case B question at the exact moment it mattered.
      mapStart: mapAtLastChange,
      mapEnd: snap(w.__rfSourceMap),
      // The playhead at the START of the hold. A freeze at 9.9s is a freeze AT THE CUT and one at 4s
      // is not; without this every hold is an anonymous duration.
      at: w.__rfClock ? w.__rfClock.committed : null
    });
    lastHash = h;
    lastHashAt = now;
    mapAtLastChange = snap(w.__rfSourceMap);
  };
  w.__freezePicture = function () {
    return { holds: pixelHolds, samples: hashSamples, fails: hashFails, openHoldMs: performance.now() - lastHashAt };
  };

  // How long each source stays continuously AWAITING — "no decode exists for this moment", the state
  // that makes the compositor hold its previous texture.
  var awaiting = {};
  w.__freezeAwaiting = awaiting;
  var noteAwaiting = function (now, map) {
    if (!map) return;
    for (var id in map) {
      var row = map[id];
      if (!row) continue;
      var st = awaiting[id] || (awaiting[id] = { label: row.asset, decode: row.decode, since: null, runs: [], composites: 0, awaitComposites: 0 });
      st.label = row.asset; st.decode = row.decode;
      st.composites++;
      var isAwaiting = row.state === "AWAITING";
      if (isAwaiting) st.awaitComposites++;
      if (isAwaiting && st.since === null) { st.since = now; st.sinceClock = w.__rfClock ? w.__rfClock.committed : null; }
      if (!isAwaiting && st.since !== null) {
        st.runs.push({ ms: now - st.since, start: st.since, at: st.sinceClock });
        st.since = null;
      }
    }
  };

  // WHY a source reports AWAITING. selectVideoDrawSource returns null when there is no settle frame,
  // no WebCodecs frame, and no usable element - and "no usable element" is three different failures
  // (no lease at all / readyState < 2 / videoWidth 0) that the snapshot collapses into one boolean.
  // The elements are real DOM nodes, so their state can be read directly instead of inferred.
  var vids = {};
  w.__freezeVideos = vids;
  var noteVideos = function (now) {
    var list = document.querySelectorAll("video");
    for (var i = 0; i < list.length; i++) {
      var v = list[i];
      var key = (v.currentSrc || v.src || "?").split("/").pop().slice(-24) + "#" + i;
      var st = vids[key] || (vids[key] = {
        samples: 0, notReady: 0, zeroWidth: 0, pausedWhilePlaying: 0,
        readyStates: {}, stalls: [], lastTime: v.currentTime, lastAdvanceAt: now, seeking: 0
      });
      st.samples++;
      st.readyStates[v.readyState] = (st.readyStates[v.readyState] || 0) + 1;
      if (v.readyState < 2) st.notReady++;
      if (v.videoWidth === 0) st.zeroWidth++;
      if (v.seeking) st.seeking++;
      var playing = w.__rfClock != null;
      if (playing && v.paused) st.pausedWhilePlaying++;
      // Does this element's OWN clock advance? A <video> that stops advancing is the decoder
      // stopping, whatever its readyState says.
      if (v.currentTime !== st.lastTime) {
        if (now - st.lastAdvanceAt > 60) st.stalls.push({ ms: now - st.lastAdvanceAt, at: w.__rfClock ? w.__rfClock.committed : null });
        st.lastTime = v.currentTime;
        st.lastAdvanceAt = now;
      }
    }
  };

  // BOUNDARY EVENT LOG. Every subsystem here already publishes COUNTERS; none publishes EVENTS, so
  // "what changed, and exactly when" has never been answerable. Sampling the counters once per
  // composite and recording only the DIFFS turns all of them into a timeline without touching a line
  // of app code - and at rAF resolution, which is finer than the 300-500ms thing being explained.
  var counters = {};
  var events = [];
  w.__freezeEvents = events;
  var flat = function (prefix, obj, into) {
    if (!obj) return;
    for (var k in obj) {
      var v = obj[k];
      if (typeof v === "number" || typeof v === "boolean" || typeof v === "string") into[prefix + "." + k] = v;
    }
  };
  var noteEvents = function (now) {
    var next = {};
    flat("wcPool", w.__rfWcPool, next);
    flat("videoPool", w.__rfVideoPoolStats, next);
    flat("wcDecoder", w.__rfWcDecoder, next);
    next["glContexts"] = w.__rfActiveGlContexts != null ? Number(w.__rfActiveGlContexts) : 0;
    next["staleDrawKicks"] = w.__rfStaleDrawKicks || 0;
    next["elementNudges"] = w.__rfElementNudges || 0;
    next["wcHolds"] = w.__rfWcHolds || 0;
    // The LAYER SET itself is the most important "counter": a mount is the event this is hunting.
    var map = w.__rfSourceMap || {};
    var ids = Object.keys(map).sort();
    next["layers"] = ids.join(",");
    next["layerCount"] = ids.length;
    // Per-source route/state, so a supplier change shows up as its own event.
    for (var i = 0; i < ids.length; i++) {
      var row = map[ids[i]];
      next["decode[" + ids[i] + "]"] = String(row.decode);
      next["state[" + ids[i] + "]"] = String(row.state);
    }
    // Routing evaluations are append-only; their COUNT rising is a mount/remount.
    var routing = w.__rfRouting || {};
    var routeTotal = 0;
    for (var rk in routing) routeTotal += routing[rk].length;
    next["routingEvaluations"] = routeTotal;

    var clock = w.__rfClock ? w.__rfClock.committed : null;
    for (var key in next) {
      if (counters[key] !== next[key]) {
        if (Object.prototype.hasOwnProperty.call(counters, key)) {
          events.push({ t: now, playhead: clock, key: key, from: counters[key], to: next[key] });
        }
        counters[key] = next[key];
      }
    }
  };

  var served = {};
  w.__freezeServed = served;
  var noteServed = function (now, map) {
    if (!map) return;
    for (var id in map) {
      var row = map[id];
      if (!row) continue;
      var st = served[id];
      if (!st) { served[id] = { last: row.served, since: now, stalls: [], label: row.asset, decode: row.decode }; continue; }
      if (st.decode !== row.decode) {
        // A source changing decode path mid-playback is an EVENT, not a state: it means an escape
        // hatch fired (recordWcHeal). The readahead table reports only the LAST mode seen, which
        // reads as if the source had always been on it.
        rec.modeLog.push({ at: now, id: id, label: row.asset, from: st.decode, to: row.decode });
      }
      st.label = row.asset; st.decode = row.decode;
      // Quantise to the source frame grid: the WC path re-stamps served time on every republish, so
      // raw inequality counts float wobble as a new frame (the mistake readahead-probe.ts documents).
      var grid = 30;
      var a = row.served == null ? null : Math.round(row.served * grid);
      var b = st.last == null ? null : Math.round(st.last * grid);
      var advanced = a == null || b == null ? row.served !== st.last : a !== b;
      if (!advanced) continue; // the held frame is still on screen — this stall is still open
      st.stalls.push({ end: now, ms: now - st.since, state: row.state, stale: row.staleMs });
      st.last = row.served;
      st.since = now;
    }
  };

  var tick = function () {
    if (rec.stop) return;
    var now = performance.now();
    var dt = now - last;
    rec.frames += 1;
    rec.t1 = now;
    noteServed(now, w.__rfSourceMap);
    noteAwaiting(now, w.__rfSourceMap);
    if (arg.videos) noteVideos(now);
    noteEvents(now);
    noteReasons(w.__rfSourceMap);
    noteElementClock(now, w.__rfSourceMap);
    samplePicture(now);
    if (dt > rec.gapMs) {
      rec.gaps.push({
        at: now, dt: dt,
        clockBefore: lastClock, clockAfter: clock(),
        statsBefore: lastStats,
        sourcesBefore: lastSources, sourcesAfter: snap(w.__rfSourceMap),
        holdsBefore: lastHolds, holdsAfter: w.__rfWcHolds || 0
      });
    }
    last = now;
    lastClock = clock();
    lastSources = snap(w.__rfSourceMap);
    lastStats = snap(w.__rfFrameStats);
    lastHolds = w.__rfWcHolds || 0;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  try {
    var po = new PerformanceObserver(function (list) {
      var entries = list.getEntries();
      for (var i = 0; i < entries.length; i++) {
        rec.longtasks.push({ at: entries[i].startTime, dur: entries[i].duration, name: entries[i].name });
      }
    });
    po.observe({ entryTypes: ["longtask"] });
  } catch (e) { /* longtask unsupported — the rAF gap log still stands */ }
}`;

const COLLECT_FN = String.raw`function () {
  var w = window;
  var rec = w.__freezeRec;
  rec.stop = true;
  var snap = function (o) {
    try { return JSON.parse(JSON.stringify(o == null ? null : o)); } catch (e) { return null; }
  };
  var pictureStalls = {};
  if (w.__freezeServed) {
    for (var id in w.__freezeServed) {
      var st = w.__freezeServed[id];
      pictureStalls[id] = { label: st.label, decode: st.decode, stalls: st.stalls };
    }
  }
  var awaitingRuns = {};
  if (w.__freezeAwaiting) {
    for (var aid in w.__freezeAwaiting) {
      var a = w.__freezeAwaiting[aid];
      // Close the run that is still open at stop, otherwise the longest one is always missing.
      var runs = a.runs.slice();
      if (a.since !== null) runs.push({ ms: performance.now() - a.since, start: a.since, at: a.sinceClock });
      awaitingRuns[aid] = { label: a.label, decode: a.decode, runs: runs, composites: a.composites, awaitComposites: a.awaitComposites };
    }
  }
  return {
    picture: w.__freezePicture ? w.__freezePicture() : null,
    awaitingRuns: awaitingRuns,
    videoPool: snap(w.__rfVideoPoolStats),
    videos: snap(w.__freezeVideos),
    reasons: snap(w.__freezeReasons ? w.__freezeReasons() : null),
    elementClock: snap(w.__freezeElClock ? w.__freezeElClock() : null),
    routing: snap(w.__rfRouting),
    events: w.__freezeEvents || [],
    elementNudges: w.__rfElementNudges || 0,
    staleDrawKicks: w.__rfStaleDrawKicks || 0,
    strictSyncCorrections: w.__rfStrictSyncCorrections || 0,
    pictureStalls: pictureStalls,
    frames: rec.frames,
    spanMs: rec.t1 - rec.t0,
    t0: rec.t0,
    t1: rec.t1,
    gaps: rec.gaps,
    longtasks: rec.longtasks,
    finalSources: snap(w.__rfSourceMap),
    finalStats: snap(w.__rfFrameStats),
    wcPool: snap(w.__rfWcPool),
    wcHeals: snap(w.__rfWcHeals),
    wcMode: snap(w.__rfWcMode),
    wcStaleTime: snap(w.__rfWcStaleTime),
    wcDecoder: snap(w.__rfWcDecoder),
    degradation: snap(w.__rfDegradation),
    modeLog: rec.modeLog,
    loaderRates: snap(w.__rfFlarexLoaderRate),
    readahead: snap(w.__rfReadahead ? w.__rfReadahead.headroom : null)
  };
}`;

async function installRecorder(page: Page, gapMs: number): Promise<void> {
  await page.evaluate(`(${RECORDER_FN})(${JSON.stringify({ gapMs, pixel: PIXEL_SAMPLING, videos: false })})`);
}

async function collectRecorder(page: Page): Promise<PageReport> {
  return page.evaluate(`(${COLLECT_FN})()`) as Promise<PageReport>;
}

/**
 * Which stacks were on the CPU during each freeze window.
 *
 * The profile's own clock is aligned onto the page clock by the recording bracket: `Profiler.start`
 * and `Profiler.stop` happen inside the page-clock window we captured, so mapping
 * [profile.startTime, profile.endTime] → [pageStart, pageEnd] linearly is accurate to well under the
 * length of anything worth calling a freeze.
 */
function stacksDuringWindows(
  profile: CpuProfile,
  windows: { start: number; end: number; dt: number }[],
  pageStart: number,
  pageEnd: number
): { window: { start: number; end: number; dt: number }; total: number; top: { name: string; file: string; ms: number }[] }[] {
  const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
  const span = profile.endTime - profile.startTime;
  const pageSpan = pageEnd - pageStart;
  const toPage = (us: number) => pageStart + ((us - profile.startTime) / Math.max(span, 1)) * pageSpan;

  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  // Absolute time of each sample, in profile µs.
  const times: number[] = [];
  let cursor = profile.startTime;
  for (let i = 0; i < samples.length; i++) {
    cursor += deltas[i] ?? 0;
    times.push(cursor);
  }

  return windows.map((win) => {
    const byKey = new Map<string, number>();
    let total = 0;
    for (let i = 0; i < samples.length; i++) {
      const t = toPage(times[i]!);
      if (t < win.start || t > win.end) continue;
      const node = nodes.get(samples[i]!);
      if (!node) continue;
      const ms = (deltas[i] ?? 0) / 1000;
      total += ms;
      const key = `${node.callFrame.functionName || "(anonymous)"} ${shortUrl(node.callFrame.url)}`;
      byKey.set(key, (byKey.get(key) ?? 0) + ms);
    }
    const top = [...byKey.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([key, ms]) => {
        const [name, file] = key.split(" ");
        return { name: name!, file: file!, ms };
      });
    return { window: win, total, top };
  });
}

function pct(n: number, of: number): string {
  return `${((n / Math.max(of, 1)) * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  const browser = await chromium.launch(channel ? { channel } : {});
  const page: Page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on("console", (m) => {
    const t = m.text();
    if (/error|fail|lost|wedge|bail/i.test(t)) console.log(`  [page] ${t.slice(0, 200)}`);
  });

  const clipA = defaultClipPath(SECONDS + 10);
  // A DIFFERENT file for the second MediaIn: two loaders on one file share a decoder session
  // (`wcShare`), which is a different case from the reported one and would understate contention.
  const clipB = process.env.PROBE_CLIP_B ?? pickSecondClip(clipA, Math.ceil(SECONDS / 2) + 6);
  console.log(`clip A: ${path.basename(clipA)}`);
  console.log(`clip B: ${path.basename(clipB)}`);

  await reachEditor(page, { clipPath: clipA });
  const projectUrl = page.url();
  console.log(`editor: ${projectUrl}`);

  // Import clip B into the media pool through the product's own upload control.
  const upload = page.locator(".asset-upload-button input[type=file]").first();
  await upload.waitFor({ state: "attached", timeout: 20_000 });
  await upload.setInputFiles(clipB);
  await page.waitForTimeout(6_000);

  console.log(`arm: ${ARM}`);
  const fixture = await buildTwoMediaInFixture(page, path.basename(clipB).slice(0, 20));
  console.log("fixture:", JSON.stringify(fixture, null, 2));
  if (!(fixture as { ok?: boolean }).ok) {
    console.error("FIXTURE FAILED — the run would measure a project without the bug. Stopping.");
    await browser.close();
    process.exit(2);
  }

  // Reload onto the mutated project. `previewRing=probe` turns on the per-source delivery counters,
  // which are measurement-only and cost a map lookup per composite.
  const url = new URL(projectUrl);
  url.searchParams.set("previewRing", "probe");
  await page.goto(url.toString(), { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(8_000);

  // ── ARM 4: the controlling-variable test ────────────────────────────────────────────────────────
  // Same project, same media, same timeline, same machine as `two-in`. The ONLY difference is which
  // decode path the timeline clips are routed to, and it is not forced by a debug flag: we wait for
  // the product's own ingest proxies to finish, which makes `mediaUrl === asset.proxyUrl`, which
  // makes `preferNativeDecode` false, which routes the clips to the pool. Changing the routing by
  // waiting rather than by patching is what keeps every other variable constant.
  //
  // If the proxies never land the arm reports VOID. A run that measured the element path while
  // claiming to measure the pool would invert the conclusion, which is the one failure mode this
  // whole experiment cannot tolerate.
  if (ARM.endsWith("-proxy")) {
    const budgetMs = Number(process.env.FREEZE_PROXY_WAIT_MS ?? 240_000);
    console.log(`waiting up to ${(budgetMs / 1000).toFixed(0)}s (paused) for ingest proxies to route the clips onto the pool…`);
    const routed = await page
      .waitForFunction(
        () => {
          const map = (window as unknown as { __rfSourceMap?: Record<string, { decode?: string }> }).__rfSourceMap;
          if (!map) return false;
          const modes = Object.values(map).map((r) => r.decode ?? "-");
          // Every VIDEO source the viewer currently has must be off the element path.
          return modes.length > 0 && modes.every((m) => m !== "element");
        },
        undefined,
        { timeout: budgetMs, polling: 1000 }
      )
      .then(() => true)
      .catch(() => false);
    const modes = await page.evaluate(
      () => JSON.parse(JSON.stringify((window as unknown as { __rfSourceMap?: unknown }).__rfSourceMap ?? {}))
    );
    console.log(`  routed: ${routed} · decode modes now ${JSON.stringify(Object.values(modes as Record<string, { decode?: string }>).map((r) => r.decode))}`);
    if (!routed) {
      console.error("VOID: proxies did not land, so this arm would measure the element path under a pool label.");
      await browser.close();
      process.exit(3);
    }
  }

  const sourcesBefore = await page.evaluate(() => JSON.parse(JSON.stringify((window as any).__rfSourceMap ?? null)));
  console.log("\nsources the viewer sees BEFORE playing:");
  console.log(JSON.stringify(sourcesBefore, null, 2));

  await page.locator(PLAY).first().click({ timeout: 10_000 });
  const started = await page
    .locator(PAUSE)
    .first()
    .waitFor({ state: "visible", timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
  if (!started) throw new Error("transport did not start — nothing to measure");

  await page.waitForTimeout(1_200); // decoder spin-up is real but is not the sustained freeze

  const cdp: CDPSession = await page.context().newCDPSession(page);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: SAMPLE_INTERVAL_US });

  await installRecorder(page, GAP_MS);
  const pageStart = await page.evaluate(() => performance.now());
  await cdp.send("Profiler.start");
  await page.waitForTimeout(SECONDS * 1_000);
  const { profile } = (await cdp.send("Profiler.stop")) as { profile: CpuProfile };
  const pageEnd = await page.evaluate(() => performance.now());

  const report = await collectRecorder(page);
  await page.locator(PAUSE).first().click({ timeout: 5_000 }).catch(() => undefined);

  // ───────────────────────────────────────────────────────────────────────────────────────────────
  const wall = report.spanMs;
  const expected = Math.round(wall / 16.7);
  console.log(`\n════ FORWARD PROGRESS · ${(wall / 1000).toFixed(1)}s of playback ════`);
  console.log(`  rAF callbacks delivered : ${report.frames}  (≈${(report.frames / (wall / 1000)).toFixed(1)}/s)`);
  console.log(`  at 60Hz we would expect : ${expected}`);
  if (report.finalStats) {
    const s = report.finalStats as Record<string, number | string>;
    console.log(
      `  HUD at stop             : fps ${Number(s.fps).toFixed(1)} · mediaFps ${Number(s.mediaFps).toFixed(1)} · ` +
        `frame ${Number(s.avgFrameMs).toFixed(1)}ms · draw ${Number(s.avgDrawMs).toFixed(2)}ms · ` +
        `dropped ${(Number(s.droppedRatio) * 100).toFixed(0)}% · scale ${s.renderScale}`
    );
  }

  const buckets = [5, 10, 16, 33, 100, 250, 500];
  console.log(`\n  GAP HISTOGRAM (rAF delivery, > ${GAP_MS}ms recorded)`);
  for (let i = 0; i < buckets.length; i++) {
    const lo = buckets[i]!;
    const hi = buckets[i + 1];
    const n = report.gaps.filter((g) => g.dt >= lo && (hi == null || g.dt < hi)).length;
    if (n > 0 || lo >= GAP_MS) console.log(`    ${hi == null ? `≥${lo}ms` : `${lo}–${hi}ms`}`.padEnd(16) + `${n}`);
  }
  const lost = report.gaps.reduce((a, g) => a + Math.max(0, g.dt - 16.7), 0);
  console.log(`    time inside gaps: ${lost.toFixed(0)}ms of ${wall.toFixed(0)}ms (${pct(lost, wall)})`);

  console.log(`\n  MAIN-THREAD LONG TASKS`);
  const lt = report.longtasks.slice().sort((a, b) => b.dur - a.dur);
  console.log(`    count ${lt.length} · total ${lt.reduce((a, b) => a + b.dur, 0).toFixed(0)}ms · worst ${lt[0]?.dur.toFixed(0) ?? 0}ms`);
  for (const e of lt.slice(0, 10)) console.log(`      ${e.dur.toFixed(0).padStart(6)}ms  at t+${(e.at - report.t0).toFixed(0)}ms  ${e.name}`);

  // The fork in the diagnosis: is each freeze covered by a long task (occupancy) or not (starvation)?
  const worst = report.gaps.slice().sort((a, b) => b.dt - a.dt).slice(0, 12);
  console.log(`\n════ THE ${worst.length} LONGEST STALLS ════`);
  const windows = worst.map((g) => ({ start: g.at - g.dt, end: g.at, dt: g.dt }));
  const stacks = stacksDuringWindows(profile, windows, pageStart, pageEnd);
  worst.forEach((g, i) => {
    const s = stacks[i]!;
    const covering = report.longtasks.filter((t) => t.at < g.at && t.at + t.dur > g.at - g.dt);
    const covered = covering.reduce((a, t) => a + t.dur, 0);
    const clockAdvanced =
      g.clockBefore && g.clockAfter ? (g.clockAfter.committed - g.clockBefore.committed) * 1000 : null;
    console.log(`\n  ── stall ${g.dt.toFixed(0)}ms at t+${(g.at - report.t0).toFixed(0)}ms`);
    console.log(`     main thread blocked : ${covered.toFixed(0)}ms across ${covering.length} long task(s)  → ${covered > g.dt * 0.5 ? "OCCUPANCY" : "STARVATION (thread was free)"}`);
    console.log(`     CPU sampled in gap  : ${s.total.toFixed(0)}ms of ${g.dt.toFixed(0)}ms (${pct(s.total, g.dt)} of the gap was JS on-CPU)`);
    if (clockAdvanced != null) {
      console.log(`     transport clock     : advanced ${clockAdvanced.toFixed(0)}ms across the gap ${Math.abs(clockAdvanced) < 1 ? "→ THE CLOCK ITSELF STOPPED" : "→ clock kept running (picture stalled, time did not)"}`);
    }
    console.log(`     wc catch-up holds   : +${g.holdsAfter - g.holdsBefore}`);
    if (s.top.length) {
      console.log(`     on-CPU during the gap:`);
      for (const t of s.top) console.log(`        ${t.ms.toFixed(1).padStart(7)}ms  ${t.name}  ${t.file}`);
    }
    const before = g.sourcesBefore as Record<string, any> | null;
    const after = g.sourcesAfter as Record<string, any> | null;
    if (before && after) {
      console.log(`     sources across the gap:`);
      for (const id of Object.keys(after)) {
        const b = before[id];
        const a = after[id];
        if (!a) continue;
        const advanced = b && a.served != null && b.served != null ? a.served - b.served : null;
        console.log(
          `        ${(a.asset ?? id).toString().slice(0, 26).padEnd(28)} ${String(a.decode).padEnd(10)} ` +
            `state=${String(a.state).padEnd(8)} stale=${a.staleMs ?? "-"}ms shared=${a.shared} ` +
            `served ${advanced == null ? "?" : advanced === 0 ? "DID NOT ADVANCE" : `+${(advanced * 1000).toFixed(0)}ms`}`
        );
      }
    }
  });

  console.log(`
════ GROUND TRUTH · DID THE PICTURE ON THE CANVAS CHANGE? ════`);
  const pic = report.picture;
  if (!pic || pic.samples === 0) {
    console.log(`  no pixel samples (${pic?.fails ?? "?"} failures) — canvas unreadable, this run proves nothing about the picture.`);
  } else {
    const holds = pic.holds.filter((h) => h.ms > 0);
    const totalHeld = holds.reduce((a, b) => a + b.ms, 0);
    const over = (n: number) => holds.filter((h) => h.ms >= n).length;
    console.log(`  ${pic.samples} pixel samples · ${holds.length} DISTINCT pictures → ${(holds.length / Math.max(totalHeld / 1000, 0.001)).toFixed(1)} new pictures/second`);
    console.log(`  picture held longer than: >33ms ${over(33)} · >100ms ${over(100)} · >250ms ${over(250)} · >500ms ${over(500)} · >1000ms ${over(1000)}`);
    const frozen = holds.filter((h) => h.ms >= 250).reduce((a, b) => a + b.ms, 0);
    console.log(`  time the SAME picture was on screen ≥250ms: ${frozen.toFixed(0)}ms (${pct(frozen, totalHeld)} of playback)`);
    console.log(`  still-open hold at stop: ${pic.openHoldMs.toFixed(0)}ms`);
    console.log(`  every hold ≥150ms, with the playhead it began at:`);
    for (const h of holds.filter((x) => x.ms >= 250).sort((a, b) => b.ms - a.ms).slice(0, 8)) {
      console.log(`
     ${h.ms.toFixed(0)}ms frozen from playhead ${h.at == null ? "?" : h.at.toFixed(2) + "s"} (t+${(h.start - report.t0).toFixed(0)}ms)`);
      const a = (h as unknown as { mapStart: Record<string, any> | null }).mapStart;
      const b = (h as unknown as { mapEnd: Record<string, any> | null }).mapEnd;
      if (!a || !b) continue;
      for (const sid of Object.keys(b)) {
        const s0 = a[sid];
        const s1 = b[sid];
        if (!s1) continue;
        const elMoved = s0 && s0.elTime != null && s1.elTime != null ? s1.elTime - s0.elTime : null;
        console.log(
          `        ${String(s1.asset ?? sid).slice(0, 26).padEnd(28)} [${String(s1.decode).padEnd(7)}] ` +
            `${String(s1.state).padEnd(8)} why=${String(s1.why ?? "-").padEnd(22)} ` +
            `elReady=${s1.elReady ?? "-"} elClock ${elMoved == null ? "?" : elMoved === 0 ? "FROZEN" : "+" + (elMoved * 1000).toFixed(0) + "ms"}`
        );
      }
    }
  }

  // ── THE FORK: does the browser fail to produce, or do we fail to acquire? ────────────────
  const OURS = new Set(["NO_LEASE", "ELEMENT_REJECTED_STALE", "WC_DECODE_IN_FLIGHT", "WC_FRAME_CLOSED"]);
  // ── THE CLIP BOUNDARY ──────────────────────────────────────────────────
  const cut = Number((fixture as { clipSecondsEach?: number }).clipSecondsEach ?? 0);
  if (cut > 0) {
    const inWindow = (ph: number | null | undefined) => ph != null && ph >= cut - 3 && ph <= cut + 2;
    console.log(`
════ CLIP BOUNDARY · cut at playhead ${cut.toFixed(2)}s · preload lookahead mounts at ${(cut - 1.2).toFixed(2)}s ════`);

    const holdsNear = (report.picture?.holds ?? []).filter((h) => inWindow(h.at) && h.ms >= 100).sort((a, b) => b.ms - a.ms);
    console.log(`
  PICTURE HOLDS in the boundary window (>=100ms):`);
    for (const h of holdsNear) {
      const end = (h.at ?? 0) + h.ms / 1000;
      console.log(
        `    ${h.ms.toFixed(0).padStart(6)}ms  playhead ${h.at?.toFixed(2)}s → ${end.toFixed(2)}s  ` +
          `(cut${((h.at ?? 0) - cut).toFixed(2)}s → cut${(end - cut).toFixed(2)}s)`
      );
    }
    if (holdsNear.length === 0) console.log("    none");

    console.log(`
  SUPPLY STALLS in the boundary window, from SERVED TIME (no readback, no observer effect):`);
    let anyServed = false;
    for (const [id, entry] of Object.entries(report.pictureStalls ?? {})) {
      const near = (entry.stalls ?? []).filter((x) => x.ms >= 100);
      for (const st of near) {
        anyServed = true;
        console.log(`    ${st.ms.toFixed(0).padStart(6)}ms  ${(entry.label ?? id).slice(0, 34).padEnd(36)} [${entry.decode}] state=${st.state}`);
      }
    }
    if (!anyServed) console.log("    none >=100ms");
    console.log(`    (pixel hashing this run: ${PIXEL_SAMPLING ? "ON" : "OFF"})`);

    console.log(`
  EVERY COUNTER CHANGE in the boundary window (rAF resolution):`);
    const evs = (report.events ?? []).filter((e) => inWindow(e.playhead));
    if (evs.length === 0) console.log("    none");
    for (const e of evs) {
      const from = typeof e.from === "string" && e.from.length > 40 ? `…${e.from.slice(-40)}` : String(e.from);
      const to = typeof e.to === "string" && e.to.length > 40 ? `…${e.to.slice(-40)}` : String(e.to);
      console.log(`    playhead ${e.playhead?.toFixed(3)}s (cut${((e.playhead ?? 0) - cut).toFixed(2)}s)  ${e.key.padEnd(34)} ${from} → ${to}`);
    }

    // What was on the CPU while the picture was held. Same alignment machinery the freeze probe used
    // for rAF gaps, pointed at PICTURE holds instead - the gap log is silent here by construction,
    // since the compositor never missed a beat during any of these.
    // Windows to attribute. With pixel hashing off (the honest configuration) there are no pixel
    // holds, so fall back to the SERVED-TIME stalls, which carry their own end timestamp and cost
    // nothing to collect. Same alignment machinery either way.
    let windows = holdsNear.slice(0, 4).map((h) => ({ start: h.start, end: h.start + h.ms, dt: h.ms }));
    if (windows.length === 0) {
      const served: { start: number; end: number; dt: number }[] = [];
      for (const entry of Object.values(report.pictureStalls ?? {})) {
        for (const st of entry.stalls ?? []) {
          if (st.ms >= 90) served.push({ start: st.end - st.ms, end: st.end, dt: st.ms });
        }
      }
      windows = served.sort((a, b) => b.dt - a.dt).slice(0, 4);
    }
    const stacks = stacksDuringWindows(profile, windows, pageStart, pageEnd);
    console.log(`
  ON-CPU DURING THE BOUNDARY HOLDS:`);
    stacks.forEach((s, i) => {
      const w = windows[i]!;
      console.log(`    ── ${w.dt.toFixed(0)}ms supply stall · ${s.total.toFixed(0)}ms JS on-CPU (${pct(s.total, w.dt)})`);
      for (const t of s.top) console.log(`        ${t.ms.toFixed(1).padStart(7)}ms  ${t.name}  ${t.file}`);
      const covering = report.longtasks.filter((t) => t.at < w.end && t.at + t.dur > w.start);
      console.log(`        long tasks covering: ${covering.length} (${covering.reduce((a, b) => a + b.dur, 0).toFixed(0)}ms)`);
      const gaps = report.gaps.filter((g) => g.at > w.start && g.at < w.end + 50);
      console.log(`        rAF gaps inside: ${gaps.length} (worst ${Math.max(0, ...gaps.map((g) => g.dt)).toFixed(0)}ms)`);
    });
  }

  console.log(`
════ WHY THERE WAS NO FRAME · reason attribution per source ════`);
  console.log("  BROWSER = a frame did not exist yet.  ORRERIS = a frame existed and we did not take it.");
  for (const [id, r] of Object.entries(report.reasons ?? {})) {
    const entries = Object.entries(r.counts).sort((a, b) => b[1] - a[1]);
    const total = entries.reduce((a, b) => a + b[1], 0);
    if (total === 0) continue;
    let ours = 0;
    for (const [why, n] of entries) if (OURS.has(why)) ours += n;
    console.log(`
  ${(r.label ?? id).slice(0, 50)}   [${r.decode}]`);
    for (const [why, n] of entries) {
      console.log(`    ${String(n).padStart(6)}  ${pct(n, total).padStart(6)}  ${why.padEnd(24)} ${OURS.has(why) ? "ORRERIS" : "BROWSER"}`);
    }
    console.log(`    → ${pct(ours, total)} ORRERIS · ${pct(total - ours, total)} BROWSER`);
  }

  console.log(`
════ THE <video> ELEMENT'S OWN CLOCK (invisible from outside the app) ════`);
  for (const [id, e] of Object.entries(report.elementClock ?? {})) {
    const stalls = e.stalls.slice().sort((a, b) => b.ms - a.ms);
    const total = stalls.reduce((a, b) => a + b.ms, 0);
    console.log(
      `  ${(e.label ?? id).slice(0, 44).padEnd(46)} [${e.decode}] readyState ${JSON.stringify(e.ready)}`
    );
    console.log(
      `    currentTime stalled >60ms: ${stalls.length}× · total ${total.toFixed(0)}ms · worst ${stalls[0]?.ms.toFixed(0) ?? 0}ms ` +
        `(readyState ${stalls[0]?.ready ?? "-"}, paused ${stalls[0]?.paused ?? "-"}) · top: ${stalls.slice(0, 8).map((x) => x.ms.toFixed(0)).join(" ")}`
    );
  }

  console.log(`
════ ROUTING STABILITY · did any source change decode route? ════`);
  for (const [key, entries] of Object.entries(report.routing ?? {})) {
    const routes = [...new Set(entries.map((e) => e.route))];
    console.log(
      `  ${key.slice(-40).padEnd(42)} ${entries.length} evaluation(s) · route(s) ${routes.join(",")} ` +
        `${routes.length > 1 ? "← FLIPPED" : ""}`
    );
    for (const e of entries) {
      console.log(
        `      t+${String(e.at).padStart(7)}ms  ${e.route.padEnd(8)} preferNative=${e.preferNativeDecode} bailed=${e.bailed} tolerateLag=${e.tolerateLag} hidden=${e.hidden}`
      );
    }
  }

  console.log(`
════ "NO DECODE FOR THIS MOMENT" (awaitingFrame) PER SOURCE ════`);
  for (const [id, a] of Object.entries(report.awaitingRuns ?? {})) {
    const runs = a.runs.filter((r) => r.ms > 0).sort((x, y) => y.ms - x.ms);
    const total = runs.reduce((x, y) => x + y.ms, 0);
    console.log(
      `  ${(a.label ?? id).slice(0, 44).padEnd(46)} ${String(a.decode).padEnd(9)} ` +
        `AWAITING in ${a.awaitComposites}/${a.composites} composites (${pct(a.awaitComposites, a.composites)}) · ` +
        `${runs.length} runs · worst ${runs[0]?.ms.toFixed(0) ?? 0}ms @ playhead ${runs[0]?.at?.toFixed(2) ?? "?"}s · total ${total.toFixed(0)}ms`
    );
  }
  console.log(`  <video> element pool: ${JSON.stringify(report.videoPool)}`);
  console.log(`
  EVERY <video> ELEMENT IN THE DOM (does its own clock advance?)`);
  for (const [key, v] of Object.entries(report.videos ?? {})) {
    const stalls = v.stalls.slice().sort((a, b) => b.ms - a.ms);
    const total = stalls.reduce((a, b) => a + b.ms, 0);
    console.log(
      `    ${key.padEnd(30)} samples ${String(v.samples).padStart(5)} · readyState ${JSON.stringify(v.readyStates)} · ` +
        `notReady ${v.notReady} · w=0 ${v.zeroWidth} · seeking ${v.seeking} · paused-while-playing ${v.pausedWhilePlaying}`
    );
    console.log(
      `      element clock stalled >60ms: ${stalls.length}× · total ${total.toFixed(0)}ms · ` +
        `worst ${stalls[0]?.ms.toFixed(0) ?? 0}ms @ playhead ${stalls[0]?.at?.toFixed(2) ?? "?"}s · ` +
        `top: ${stalls.slice(0, 8).map((x) => x.ms.toFixed(0)).join(" ")}`
    );
  }
  console.log(`  self-heal nudges: element ${report.elementNudges} · stale-draw kicks ${report.staleDrawKicks} · strict-sync seeks ${report.strictSyncCorrections}`);

  // ── The finding the rAF log cannot express: the picture, not the loop. ────────────────────────
  console.log(`\n════ PICTURE FORWARD PROGRESS · how long ONE frame stayed on screen ════`);
  console.log("  A 30fps source should change every 33ms. Longer means the viewer is looking at a held frame.");
  for (const [id, entry] of Object.entries(report.pictureStalls ?? {})) {
    const stalls = (entry.stalls ?? []).filter((s) => s.ms > 0);
    if (stalls.length === 0) continue;
    const sorted = stalls.slice().sort((a, b) => b.ms - a.ms);
    const total = stalls.reduce((a, b) => a + b.ms, 0);
    const over = (n: number) => stalls.filter((s) => s.ms >= n).length;
    const held = stalls.filter((s) => s.ms >= 100).reduce((a, b) => a + b.ms, 0);
    console.log(`\n  ${entry.label ?? id}`);
    console.log(
      `    decode ${entry.decode} · ${stalls.length} distinct frames over ${(total / 1000).toFixed(1)}s ` +
        `→ ${(stalls.length / Math.max(total / 1000, 0.001)).toFixed(1)} frames/s ON SCREEN`
    );
    console.log(
      `    frame held longer than:  >16ms ${over(16)} · >33ms ${over(33)} · >50ms ${over(50)} · ` +
        `>100ms ${over(100)} · >250ms ${over(250)} · >500ms ${over(500)}`
    );
    console.log(`    worst holds (ms): ${sorted.slice(0, 12).map((s) => s.ms.toFixed(0)).join(" ")}`);
    console.log(`    time on a frame held ≥100ms: ${held.toFixed(0)}ms (${pct(held, total)} of playback)`);
  }

  console.log(`\n════ DECODE-PATH CHANGES DURING PLAYBACK ════`);
  if ((report.modeLog ?? []).length === 0) console.log("  none — every source stayed on the path it started on.");
  for (const e of report.modeLog ?? []) {
    console.log(`  t+${(e.at - report.t0).toFixed(0).padStart(6)}ms  ${e.label ?? e.id}  ${e.from} → ${e.to}`);
  }
  console.log(`  self-heals (__rfWcHeals): ${JSON.stringify(report.wcHeals)}`);
  console.log(`  decoder resets (__rfWcDecoder): ${JSON.stringify(report.wcDecoder)}`);

  console.log(`\n════ PER-SOURCE DELIVERY OVER THE WHOLE RUN ════`);
  console.log(JSON.stringify(report.readahead, null, 2));
  console.log(`\n════ DECODER POOL ════`);
  console.log(JSON.stringify(report.wcPool, null, 2));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "page-report.json"), JSON.stringify({ fixture, sourcesBefore, ...report }, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, "cpu-profile.cpuprofile"), JSON.stringify(profile));
  console.log(`\nwrote ${OUT_DIR}/page-report.json and cpu-profile.cpuprofile`);

  if (process.env.FREEZE_KEEP_OPEN === "1") {
    console.log("FREEZE_KEEP_OPEN=1 — leaving the browser open. Ctrl-C to exit.");
    await new Promise(() => {});
  }
  await browser.close();
}

/** Duration from the mp4 `mvhd` box — the same dependency-free read `editor-session.ts` uses. */
function mp4Seconds(file: string): number | null {
  try {
    const bytes = fs.readFileSync(file);
    const at = bytes.indexOf(Buffer.from("mvhd"));
    if (at < 0) return null;
    if (bytes[at + 4] === 0) {
      const ts = bytes.readUInt32BE(at + 16);
      return ts > 0 ? bytes.readUInt32BE(at + 20) / ts : null;
    }
    const ts = bytes.readUInt32BE(at + 24);
    return ts > 0 ? Number(bytes.readBigUInt64BE(at + 28)) / ts : null;
  } catch {
    return null;
  }
}

/**
 * A second, DIFFERENT mp4 — so the two MediaIns cannot collapse onto one shared decoder session.
 *
 * Filtered by DURATION first, for the reason `defaultClipPath` spells out and this function learned
 * the hard way: the first version picked the smallest file, drew a 4-second clip, and the fixture
 * silently shrank both clips to 4s. A 30-second measurement then spent 22 of those seconds past the
 * end of its own timeline, where a frozen picture is the correct picture.
 */
function pickSecondClip(exclude: string, minimumSeconds: number): string {
  const dir = path.dirname(exclude);
  const candidates = fs
    .readdirSync(dir)
    .filter((n) => n.endsWith(".mp4"))
    .map((n) => path.join(dir, n))
    .filter((f) => f !== exclude)
    .map((f) => ({ f, size: fs.statSync(f).size, seconds: mp4Seconds(f) }))
    .filter((c) => c.seconds != null && c.seconds >= minimumSeconds)
    .sort((a, b) => a.size - b.size);
  if (candidates.length === 0) {
    throw new Error(`no second clip of at least ${minimumSeconds}s; set PROBE_CLIP_B`);
  }
  return candidates[0]!.f;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
