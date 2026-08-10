/**
 * Gate for the animated mask outline (plans/flarex-node-maturity.md, slice 1) — the FIRST Flarex node
 * whose geometry varies per frame, and therefore the first that every cache in this subsystem was
 * built without.
 *
 * WHY A UNIT GATE AND NOT ONLY A PIXEL FIXTURE. Two independent reasons, both already on the record:
 *   - DEBT-017: `render:compare:pixels` is DIFFERENTIAL. This whole path is shared code both renderers
 *     consume verbatim, so a wrong-but-agreed shape reads 0.000%. The gate can say "they agree"; only
 *     an absolute assertion says "they are right".
 *   - DEBT-016: the pixel gate renders each fixture exactly ONCE per process, so it structurally cannot
 *     exercise a SECOND resolve against a warm cache — which is exactly the shape a stale outline takes.
 *
 * So the fixture (`flarex-animated-roto`) proves the two renderers agree at an interpolated time, and
 * this file proves the outline is actually different at different times, everywhere it is keyed.
 *
 * Run: pnpm --filter @orreris/shared maskShape:test
 */
import { compileFlarexComp, type FlarexLowerCtx } from "./compile-flarex";
import { computeFlarexContentHashes } from "./content-hash";
import { createFlarexNode } from "./node-defs";
import { createFlarexComp } from "./registry";
import {
  FLAREX_DEFAULT_MASK_POINTS,
  FLAREX_SHAPE_KEY_EPSILON,
  flarexMaskPointsToShape,
  parseFlarexShapePoints,
  readFlarexShapeKeyframes,
  resolveFlarexShapeAtTime,
  writeFlarexShapeKeyframes,
  type FlarexShapePoint,
} from "./mask-shape";
import { maskShapeToPathD } from "../clip-masks";
import type { SceneMaskMatteCache } from "../scene/scene-mask-matte";
import type { SceneLayerDraw } from "../color/scene-compositor";
import type { Mask, TimelineLayer } from "../types";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`  ok  ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const W = 1920;
const H = 1080;

const quad = (dx: number, r: number): FlarexShapePoint[] => [
  [0.28 + dx, 0.30, -r, 0, r, 0],
  [0.60 + dx, 0.30, 0, -r, 0, r],
  [0.60 + dx, 0.72, r, 0, -r, 0],
  [0.28 + dx, 0.72, 0, r, 0, -r],
];

const ANIMATED_KEYS = JSON.stringify([
  { t: 0, p: quad(0, 0.06) },
  { t: 1, p: quad(0.22, 0.14) },
]);

// ── 1. The payload form ────────────────────────────────────────────────────────────────────────────
{
  const legacy = parseFlarexShapePoints("[[0.1,0.2],[0.8,0.2],[0.5,0.9]]", FLAREX_DEFAULT_MASK_POINTS.polygonMask);
  check("a legacy 2-tuple payload still parses (saved comps do not break)",
    legacy.length === 3 && legacy[0]!.length === 2 && legacy[0]![0] === 0.1);

  const withTangents = parseFlarexShapePoints(JSON.stringify(quad(0, 0.06)), FLAREX_DEFAULT_MASK_POINTS.bezierMask);
  check("a 6-tuple payload keeps its tangents", withTangents.length === 4 && withTangents[0]!.length === 6 && withTangents[0]![4] === 0.06);

  // The round trip the mask bridge performs on every commit. Tangents used to be DROPPED here.
  const points = resolveFlarexShapeAtTime({
    points: JSON.stringify(quad(0, 0.06)),
    shapeKeyframes: "",
    fallback: FLAREX_DEFAULT_MASK_POINTS.bezierMask,
    width: W,
    height: H,
    idPrefix: "rt",
    timeSeconds: 0,
  });
  check("tangents survive the pixel round trip", Boolean(points[0]?.outTangent) && Math.abs(points[0]!.outTangent!.x - 0.06 * W) < 1e-6);
  const back = flarexMaskPointsToShape(points, W, H);
  check("…and come back as a 6-tuple, not a corner", back[0]!.length === 6 && Math.abs((back[0] as number[])[4]! - 0.06) < 1e-9);

  const plain = flarexMaskPointsToShape([{ id: "a", x: 100, y: 200 }], W, H);
  check("a point with no handles still serialises as a 2-tuple (no payload growth)", plain[0]!.length === 2);

  check("a malformed payload soft-fails to the node default, never to nothing",
    parseFlarexShapePoints("{not json", FLAREX_DEFAULT_MASK_POINTS.polygonMask).length === 3);
}

// ── 2. The outline actually moves, sampled at MORE THAN ONE TIME ───────────────────────────────────
{
  const shapeAt = (t: number) =>
    resolveFlarexShapeAtTime({
      points: JSON.stringify(quad(0, 0.06)),
      shapeKeyframes: ANIMATED_KEYS,
      fallback: FLAREX_DEFAULT_MASK_POINTS.bezierMask,
      width: W,
      height: H,
      idPrefix: "anim",
      timeSeconds: t,
    });

  const t0 = shapeAt(0);
  const t45 = shapeAt(0.45);
  const t80 = shapeAt(0.8);
  const t1 = shapeAt(1);

  check("t=0 is the first key", Math.abs(t0[0]!.x - 0.28 * W) < 1e-6);
  check("t=1 is the last key", Math.abs(t1[0]!.x - 0.5 * W) < 1e-6);
  // 0.28 + 0.45*0.22 = 0.379. Deliberately checked as a computed value, not "differs from t=0":
  // a resolver that returned the LAST key everywhere would also differ from t=0.
  check("t=0.45 is interpolated, not held at either end", Math.abs(t45[0]!.x - 0.379 * W) < 1e-3);
  check("t=0.8 is a third, distinct position", Math.abs(t80[0]!.x - 0.456 * W) < 1e-3);
  check("the tangents interpolate too, not just the anchors",
    Math.abs(t45[0]!.outTangent!.x - (0.06 + 0.45 * 0.08) * W) < 1e-3);

  // Beyond the ends HOLDS (the shared evaluator's rule, inherited rather than reinvented).
  check("before the first key holds", Math.abs(shapeAt(-5)[0]!.x - t0[0]!.x) < 1e-9);
  check("after the last key holds", Math.abs(shapeAt(99)[0]!.x - t1[0]!.x) < 1e-9);

  // Differing point counts HOLD rather than morph — this slice's documented exclusion. A test asserting
  // it keeps the exclusion honest: if morphing is ever added, this check is what has to be revisited.
  const mismatched = resolveFlarexShapeAtTime({
    points: JSON.stringify(quad(0, 0.06)),
    shapeKeyframes: JSON.stringify([
      { t: 0, p: quad(0, 0.06) },
      { t: 1, p: [[0.1, 0.1], [0.9, 0.1], [0.5, 0.9]] },
    ]),
    fallback: FLAREX_DEFAULT_MASK_POINTS.bezierMask,
    width: W,
    height: H,
    idPrefix: "mm",
    timeSeconds: 0.5,
  });
  check("a point-count change HOLDS, it does not morph (documented exclusion)",
    mismatched.length === 4 && Math.abs(mismatched[0]!.x - 0.28 * W) < 1e-6);
}

// ── 3. The compiler resolves per frame, through ONE warm cache ─────────────────────────────────────
/**
 * The DEBT-016-shaped question: can a cache warmed at one time serve its shape at another?
 *
 * `SceneMaskMatteCache` keys on `maskShapeToPathD(resolvedMask)` — the geometry itself — so the answer
 * is no PROVIDED the compiler hands it different geometry per time. That proviso is what is asserted
 * here, against the same cache instance across two compiles, which is the sequence a single-frame
 * pixel fixture cannot express.
 *
 * The real cache needs a 2D canvas (`document`/`OffscreenCanvas`), neither of which exists in node, so
 * this records what the compiler ASKS the cache for and applies the real key function to it. That is
 * the whole causal chain: different masks in ⇒ different key ⇒ no hit ⇒ no stale outline.
 */
{
  const asked: Array<{ t: number; d: string }> = [];
  const recordingCache = {
    get(layer: TimelineLayer, tLocal: number) {
      for (const mask of layer.masks ?? []) asked.push({ t: tLocal, d: maskShapeToPathD(mask as Mask) ?? "" });
      return null; // no texture: the compiler soft-degrades the matte, which this gate does not measure
    },
    versionOf: () => undefined,
  } as unknown as SceneMaskMatteCache;

  const comp = createFlarexComp("ams", "Animated mask shape");
  const shape = createFlarexNode("bezierMask", "ams_shape");
  shape.params = { ...shape.params, points: JSON.stringify(quad(0, 0.06)), shapeKeyframes: ANIMATED_KEYS, feather: 0.05, expansion: 0.02 };
  const blur = createFlarexNode("blur", "ams_blur");
  blur.params = { ...blur.params, sigma: 20 };
  comp.nodes[shape.id] = shape;
  comp.nodes[blur.id] = blur;
  comp.edges = [
    { id: "e1", from: { nodeId: "ams_in", socket: "out" }, to: { nodeId: blur.id, socket: "in" } },
    { id: "e2", from: { nodeId: shape.id, socket: "out" }, to: { nodeId: blur.id, socket: "mask" } },
    { id: "e3", from: { nodeId: blur.id, socket: "out" }, to: { nodeId: "ams_out", socket: "in" } },
  ];

  const host: SceneLayerDraw = {
    debugLayerId: "host",
    source: null,
    transform: { x: 50, y: 50, scale: 1, rotation: 0, opacity: 100 },
  } as unknown as SceneLayerDraw;
  const ctxAt = (t: number): FlarexLowerCtx => ({
    compWidth: W,
    compHeight: H,
    renderScale: 1,
    timeSeconds: t,
    frameTimeSeconds: t,
    hostSourceDraw: host,
    matteCache: recordingCache,
  });

  compileFlarexComp(comp, ctxAt(0.2));
  compileFlarexComp(comp, ctxAt(0.8));

  check("the compiler asked the matte cache for a shape at each time", asked.length === 2, `got ${asked.length}`);
  check("the two requests carried the two different times", asked[0]?.t === 0.2 && asked[1]?.t === 0.8);
  check("…and DIFFERENT geometry, so the cache's own key cannot serve the earlier frame",
    Boolean(asked[0]?.d) && asked[0]?.d !== asked[1]?.d);
  check("the geometry is a cubic path (tangents reached the rasterizer)", (asked[0]?.d ?? "").includes("C"));
}

// ── 4. The content hash follows the outline (ADR-009 R1) ───────────────────────────────────────────
/**
 * The failure this catches is invisible everywhere else: a `shapeKeyframes` STRING hashes as a
 * constant, so an animating node's `NodeContentHash` would be identical at every time. The node
 * thumbnail cache keys on `(ContractVersion, contentHash)` with NO time axis, so it would freeze on
 * whichever frame it first rendered while the shape moved underneath it.
 *
 * The second half matters as much as the first: a STATIC node must still hash stably across time, or
 * the fix would have "solved" the freeze by destroying reuse for every node these caches exist to serve.
 */
{
  const comp = createFlarexComp("hash", "Hash");
  const animated = createFlarexNode("bezierMask", "hash_anim");
  animated.params = { ...animated.params, points: JSON.stringify(quad(0, 0.06)), shapeKeyframes: ANIMATED_KEYS };
  const still = createFlarexNode("bezierMask", "hash_still");
  still.params = { ...still.params, points: JSON.stringify(quad(0, 0.06)) };
  comp.nodes[animated.id] = animated;
  comp.nodes[still.id] = still;

  const a = computeFlarexContentHashes(comp, 0.2);
  const b = computeFlarexContentHashes(comp, 0.8);
  check("an animated outline's content hash CHANGES with time", a.get("hash_anim") !== b.get("hash_anim"));
  check("a static outline's content hash does NOT (reuse is preserved)", a.get("hash_still") === b.get("hash_still"));
  check("an empty track counts as static", still.params.shapeKeyframes === "" || still.params.shapeKeyframes === undefined);

  // An explicitly-empty array is the shape the inspector writes when the last key is cleared.
  const cleared = createFlarexNode("bezierMask", "hash_cleared");
  cleared.params = { ...cleared.params, shapeKeyframes: "[]" };
  comp.nodes[cleared.id] = cleared;
  const c0 = computeFlarexContentHashes(comp, 0.2);
  const c1 = computeFlarexContentHashes(comp, 0.8);
  check("clearing every key restores a stable hash", c0.get("hash_cleared") === c1.get("hash_cleared"));
}

// ── 5. The track write path the editor composes ────────────────────────────────────────────────────
/**
 * `flarexMaskCommitPatch` (the mask bridge) and the inspector's diamond are both thin compositions of
 * `readFlarexShapeKeyframes` / `writeFlarexShapeKeyframes` over one shared epsilon. The DOM wiring is
 * not covered by any automated gate in this repo; the LOGIC those two share is covered here, because
 * the failure it would produce — a key appended a hair away from the one the diamond shows as active,
 * so the track grows silently and interpolates across a zero-length span — is invisible on inspection.
 */
{
  const entries = [
    { timeSeconds: 0, points: quad(0, 0.06), interpolation: "linear" as const },
    { timeSeconds: 1, points: quad(0.22, 0.14), interpolation: "linear" as const },
  ];
  const round = readFlarexShapeKeyframes(writeFlarexShapeKeyframes(entries));
  check("a keyframe list round-trips through the param form",
    round.length === 2 && round[1]!.timeSeconds === 1 && round[1]!.points[0]!.length === 6);

  check("an empty list serialises to the not-animated sentinel, not to \"[]\"", writeFlarexShapeKeyframes([]) === "");

  // The replace-at-playhead rule, as both callers apply it.
  const replaceAt = (t: number) =>
    readFlarexShapeKeyframes(
      writeFlarexShapeKeyframes([
        ...entries.filter((e) => Math.abs(e.timeSeconds - t) > FLAREX_SHAPE_KEY_EPSILON),
        { timeSeconds: t, points: quad(0.5, 0.2), interpolation: "linear" as const },
      ]),
    );
  check("committing AT an existing key replaces it, never stacks a duplicate", replaceAt(0).length === 2);
  check("…including a float a hair off (the epsilon is what makes this true)", replaceAt(1e-5).length === 2);
  check("committing between keys inserts a third", replaceAt(0.5).length === 3);
  check("the written track stays sorted by time", replaceAt(0.5).every((e, i, a) => i === 0 || a[i - 1]!.timeSeconds <= e.timeSeconds));
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nanimated mask shape: all checks passed");
