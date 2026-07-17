/**
 * Standalone assert script for Frames (Phase 1 foundation — see FRAMES.md). Repo convention: no test
 * framework — exits non-zero on first failure.
 *
 *   pnpm --filter @kimera-by-aelivion/web frames:test
 *
 * Covers the pure generators (unit-box path `d`), param defaults, and the built-in catalogue.
 */
import {
  FRAME_BORDER_LAYER_SUFFIX,
  builtInFrames,
  expandFrameBorders,
  findFrameDefinition,
  frameBorderShapeLayer,
  frameBoxPercent,
  frameBoxRect,
  frameChromeParams,
  frameClipMask,
  frameEffectiveParams,
  frameGroupScaleFactor,
  frameMaskId,
  frameOutlinePathD,
  frameParamDefaults,
  frameParamSchema,
  frameParamSections,
  frameToShapeLayer,
  makeLayerFrame,
  mediaRectInFrame,
  setFrameBoxAxis,
  setFrameBoxFromResize,
  snapMediaRectToBox,
  type FrameDefinition,
  type LayerFrame,
  type TimelineComposition,
  type TimelineLayer
} from "@kimera-by-aelivion/shared";

let failures = 0;
function check(name: string, condition: boolean): void {
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${name}`);
  }
}

// --- rounded-rect generator ------------------------------------------------------------
{
  const box = frameOutlinePathD({ generatorId: "rounded-rect", params: { roundness: 0 } });
  check("rounded-rect roundness 0 → full unit box", box === "M0 0H1V1H0Z");
  const rounded = frameOutlinePathD({ generatorId: "rounded-rect", params: { roundness: 100 } });
  check("rounded-rect roundness 100 → arcs at radius 0.5", rounded.includes("A0.5 0.5") && rounded.startsWith("M0.5 0") && rounded.trim().endsWith("Z"));
  const mid = frameOutlinePathD({ generatorId: "rounded-rect", params: { roundness: 20 } });
  check("rounded-rect roundness 20 → radius 0.1 arcs", mid.includes("A0.1 0.1"));
}

// --- ellipse generator -----------------------------------------------------------------
{
  const e = frameOutlinePathD({ generatorId: "ellipse", params: {} });
  check("ellipse → two half arcs", (e.match(/A0.5 0.5/g) ?? []).length === 2 && e.trim().endsWith("Z"));
}

// --- polygon generator -----------------------------------------------------------------
{
  const hex = frameOutlinePathD({ generatorId: "polygon", params: { sides: 6, rotation: 0 } });
  check("polygon sides 6 → 5 line segments (6 verts)", (hex.match(/L/g) ?? []).length === 5 && hex.startsWith("M") && hex.trim().endsWith("Z"));
  const tri = frameOutlinePathD({ generatorId: "polygon", params: { sides: 3, rotation: 0 } });
  check("polygon sides 3 → 2 line segments", (tri.match(/L/g) ?? []).length === 2);
  const clampedLow = frameOutlinePathD({ generatorId: "polygon", params: { sides: 1, rotation: 0 } });
  check("polygon sides < 3 clamps to 3", (clampedLow.match(/L/g) ?? []).length === 2);
}

// --- svg-path generator (creator static art) -------------------------------------------
{
  const custom = frameOutlinePathD({ generatorId: "svg-path", params: {}, staticPath: "M0.5 0 L1 1 L0 1 Z" });
  check("svg-path returns the static path", custom === "M0.5 0 L1 1 L0 1 Z");
  const empty = frameOutlinePathD({ generatorId: "svg-path", params: {}, staticPath: "  " });
  check("svg-path blank → safe full box", empty === "M0 0H1V1H0Z");
}

// --- unknown / not-yet-implemented generators degrade safely ---------------------------
{
  check("blob (Phase 2) → full box fallback", frameOutlinePathD({ generatorId: "blob", params: {} }) === "M0 0H1V1H0Z");
  check("torn-paper (Phase 2) → full box fallback", frameOutlinePathD({ generatorId: "torn-paper", params: {} }) === "M0 0H1V1H0Z");
}

// --- param defaults + makeLayerFrame ---------------------------------------------------
{
  const def = findFrameDefinition("kimera.rounded-rect")!;
  check("findFrameDefinition resolves built-in", def && def.generatorId === "rounded-rect");
  const defaults = frameParamDefaults(def);
  check("frameParamDefaults picks schema defaults", defaults.roundness === 20);
  const frame = makeLayerFrame(def);
  check("makeLayerFrame carries id + generator + defaults", frame.definitionId === "kimera.rounded-rect" && frame.generatorId === "rounded-rect" && frame.params.roundness === 20);

  const hex = findFrameDefinition("kimera.hexagon")!;
  check("hexagon defaults: sides 6, rotation 0", frameParamDefaults(hex).sides === 6 && frameParamDefaults(hex).rotation === 0);
  check("circle declares no generator params of its own", (findFrameDefinition("kimera.circle") as FrameDefinition).params.length === 0);
}

// --- Tier 2 chrome: every frame gets a box, even one with no generator params (QA round 1) ------
{
  const circle = findFrameDefinition("kimera.circle")!;
  const schema = frameParamSchema(circle);
  check("circle's FULL schema is the chrome (was: 'no adjustment in effects tab')", schema.length === frameChromeParams.length && schema.some((p) => p.key === "width"));
  check("chrome exposes width/height/aspectLock", ["width", "height", "aspectLock"].every((key) => frameChromeParams.some((p) => p.key === key)));

  const defaults = frameParamDefaults(circle);
  check("boolean defaults are no longer dropped", defaults.aspectLock === true);
  check("chromeDefaults override the shared default", frameParamDefaults(findFrameDefinition("kimera.rounded-rect")!).aspectLock === false);
  check("box defaults to the full comp", defaults.width === 100 && defaults.height === 100);

  const sections = frameParamSections(findFrameDefinition("kimera.rounded-rect")!);
  check("sections group Shape then Box then Border", sections.length === 3 && sections[0]!.title === "Shape" && sections[1]!.title === "Box" && sections[2]!.title === "Border");
  check("Shape section holds only the generator's own params", sections[0]!.params.every((p) => p.key === "roundness"));
  const circleSections = frameParamSections(circle);
  check("a frame with no generator params shows Box + Border", circleSections.length === 2 && circleSections[0]!.title === "Box" && circleSections[1]!.title === "Border");

  // Border chrome (Step E): every frame gets border/borderWidth/borderColor, default OFF.
  check("chrome exposes the border tier", ["border", "borderWidth", "borderColor"].every((key) => frameChromeParams.some((p) => p.key === key)));
  check("border defaults off", defaults.border === false && defaults.borderWidth === 8 && defaults.borderColor === "#ffffff");

  // A definition may not shadow a chrome key — chrome semantics stay identical across all frames.
  const rogue: FrameDefinition = { id: "acme.rogue", name: "Rogue", generatorId: "rounded-rect", params: [{ key: "width", label: "Nope", type: "number", min: 0, max: 5, step: 1, defaultValue: 3 }] };
  check("a pack cannot shadow a chrome param key", frameParamSchema(rogue).filter((p) => p.key === "width").length === 1 && frameParamDefaults(rogue).width === 100);
}

// --- frameBoxRect: the frame's own box (root cause of "circle is not circle") -------------------
{
  const full = frameBoxRect({ params: { width: 100, height: 100 } }, { width: 1920, height: 1080 });
  check("box 100% → the full comp box", full.x === 0 && full.y === 0 && full.width === 1920 && full.height === 1080);

  const half = frameBoxRect({ params: { width: 50, height: 50 } }, { width: 1920, height: 1080 });
  check("box 50% → half size, CENTERED", half.width === 960 && half.height === 540 && half.x === 480 && half.y === 270);

  // The actual circle fix: aspectLock squares the box in PIXELS, so it holds at ANY comp aspect.
  const wide = frameBoxRect({ params: { width: 100, height: 100, aspectLock: true } }, { width: 1920, height: 1080 });
  check("aspectLock in a 16:9 comp → square box (was an oval)", wide.width === wide.height && wide.width === 1080);
  check("aspectLock square is centered", wide.x === 420 && wide.y === 0);
  const tall = frameBoxRect({ params: { width: 100, height: 100, aspectLock: true } }, { width: 1080, height: 1920 });
  check("aspectLock in a 9:16 comp → square box", tall.width === tall.height && tall.width === 1080);
  const square = frameBoxRect({ params: { width: 100, height: 100, aspectLock: true } }, { width: 800, height: 800 });
  check("aspectLock in a 1:1 comp → unchanged", square.width === 800 && square.height === 800);

  const clamped = frameBoxRect({ params: { width: 0, height: 500 } }, { width: 1000, height: 1000 });
  check("box percentages clamp to 1..100", clamped.width === 10 && clamped.height === 1000);
}

// --- frameBoxPercent + setFrameBoxAxis: the inspector fields must never lie (QA round 2) --------
{
  const comp = { width: 1920, height: 1080 };
  const locked = { definitionId: "kimera.circle", generatorId: "ellipse" as const, params: { width: 100, height: 100, aspectLock: true } };

  // The bug: params say 100/100, but the squared box really occupies 56.25% × 100% of a 16:9 comp.
  const shown = frameBoxPercent(locked, comp);
  check("locked box reports its EFFECTIVE width (not the stored 100)", Math.abs(shown.width - 56.25) < 0.001);
  check("locked box reports its effective height", Math.abs(shown.height - 100) < 0.001);
  check("unlocked box reports its stored values", frameBoxPercent({ params: { width: 40, height: 70 } }, comp).width === 40);

  // Dragging Width while locked must move the PARTNER too, or frameBoxRect's min() pins the square.
  const narrowed = setFrameBoxAxis(locked, "width", 25, comp);
  check("locked width edit writes both axes", narrowed.width === 25 && Math.abs((narrowed.height as number) - (25 * 1920) / 1080) < 0.001);
  const after = frameBoxPercent({ ...locked, params: narrowed }, comp);
  check("→ and the box then actually reports that width back", Math.abs(after.width - 25) < 0.001);
  const box = frameBoxRect({ ...locked, params: narrowed }, comp);
  check("→ and it is still SQUARE in pixels", Math.abs(box.width - box.height) < 0.001 && Math.abs(box.width - 480) < 0.001);

  // Height drives the partner the other way.
  const shorter = setFrameBoxAxis(locked, "height", 50, comp);
  check("locked height edit writes both axes", shorter.height === 50 && Math.abs((shorter.width as number) - (50 * 1080) / 1920) < 0.001);
  check("→ box stays square", (() => { const b = frameBoxRect({ ...locked, params: shorter }, comp); return Math.abs(b.width - b.height) < 0.001; })());

  // Unlocked: the partner must NOT move.
  const free = setFrameBoxAxis({ params: { width: 100, height: 100, aspectLock: false } }, "width", 30, comp);
  check("unlocked width edit leaves height alone", free.width === 30 && free.height === 100);

  // Impossible square (100% width needs 177% height in 16:9) → partner clamps, field snaps to truth.
  const capped = setFrameBoxAxis(locked, "width", 100, comp);
  check("over-large locked square clamps the partner at 100", capped.height === 100);
  check("→ field snaps back to the largest square that fits", Math.abs(frameBoxPercent({ ...locked, params: capped }, comp).width - 56.25) < 0.001);

  // A 9:16 comp locks the other way round.
  const tallComp = { width: 1080, height: 1920 };
  check("locked box in a 9:16 comp reports height as the constrained axis", Math.abs(frameBoxPercent(locked, tallComp).height - 56.25) < 0.001);
}

// --- QA round 3: "width and height should be the same when locked" -----------------------------
// They are — in PIXELS. Reported as Width 29 / Height 51 with Lock Aspect on, which looks broken but is
// a UNITS artifact: width is a % of the comp's WIDTH, height a % of its HEIGHT (51/29 ≈ 16/9, the comp
// aspect). The inspector now shows px so a square reads the same both ways; this pins the geometry.
{
  const comp = { width: 1920, height: 1080 };
  const frame = { definitionId: "kimera.rounded-rect", generatorId: "rounded-rect" as const, params: { width: 100, height: 100, aspectLock: true } };
  const params = setFrameBoxAxis(frame, "height", 51, comp);
  check("the reported 29/51 case stores width ≈ 28.6875%", Math.abs((params.width as number) - 28.6875) < 0.0001);
  const box = frameBoxRect({ ...frame, params }, comp);
  check("→ the box really IS square (550.8px each way)", Math.abs(box.width - box.height) < 1e-9 && Math.abs(box.width - 550.8) < 1e-9);
  check("→ the differing percentages are the comp aspect (51/29 ≈ 16/9)", Math.abs(51 / (params.width as number) - 1920 / 1080) < 0.0001);
}

// --- setFrameBoxFromResize: on-canvas handle drags (Step C / D2) --------------------------------
{
  const comp = { width: 1920, height: 1080 };
  const free = { params: { width: 100, height: 100, aspectLock: false } };
  const locked = { definitionId: "kimera.circle", generatorId: "ellipse" as const, params: { width: 100, height: 100, aspectLock: true } };

  // Unlocked: an EDGE handle moves only its own axis (shearing the shape from an edge would be wrong).
  const east = setFrameBoxFromResize(free, { width: 40, height: 77 }, "x", comp);
  check("unlocked E/W handle moves width only", east.width === 40 && east.height === 100);
  const south = setFrameBoxFromResize(free, { width: 77, height: 40 }, "y", comp);
  check("unlocked N/S handle moves height only", south.height === 40 && south.width === 100);

  // Unlocked CORNER = PROPORTIONAL (uniform scale, preserves the box aspect; edges change proportions).
  // From a square box (w0=h0=100 %) the dominant axis (60 > 40) drives BOTH to 60 → aspect preserved.
  const corner = setFrameBoxFromResize(free, { width: 40, height: 60 }, "both", comp);
  check("unlocked corner scales proportionally (dominant axis)", corner.width === 60 && corner.height === 60);
  // A non-square start box keeps its ratio: 80×20 → dominant fx=0.5 vs fy=2 → factor 2, but clamped so
  // height 20·2=40 ≤100 and width 80·2=160 >100 → factor caps at 100/80=1.25 → (100, 25), ratio 80:20 kept.
  const rect = { params: { width: 80, height: 20, aspectLock: false } };
  const rectCorner = setFrameBoxFromResize(rect, { width: 999, height: 999 }, "both", comp);
  check("proportional corner preserves a non-square ratio (clamped by factor)", Math.abs(rectCorner.width as number - 100) < 1e-9 && Math.abs(rectCorner.height as number - 25) < 1e-9);
  check("→ ratio identical to the start box", Math.abs((rectCorner.width as number) / (rectCorner.height as number) - 80 / 20) < 1e-9);

  // Locked: the square follows the axis the user actually dragged.
  const lockedEast = setFrameBoxFromResize(locked, { width: 25, height: 99 }, "x", comp);
  check("locked E/W handle drives the square from WIDTH", lockedEast.width === 25);
  check("→ stays square in pixels", (() => { const b = frameBoxRect({ ...locked, params: lockedEast }, comp); return Math.abs(b.width - b.height) < 0.001; })());
  const lockedSouth = setFrameBoxFromResize(locked, { width: 99, height: 25 }, "y", comp);
  check("locked N/S handle drives the square from HEIGHT", lockedSouth.height === 25);
  check("→ stays square in pixels", (() => { const b = frameBoxRect({ ...locked, params: lockedSouth }, comp); return Math.abs(b.width - b.height) < 0.001; })());

  // Locked corner: takes the LARGER requested pixel extent, so a drag in either direction grows it.
  const lockedCorner = setFrameBoxFromResize(locked, { width: 10, height: 50 }, "both", comp);
  const cornerBox = frameBoxRect({ ...locked, params: lockedCorner }, comp);
  check("locked corner square = larger requested extent", Math.abs(cornerBox.width - 540) < 0.001 && Math.abs(cornerBox.height - 540) < 0.001);

  // Edge resize clamps its own axis to 1..100.
  check("edge resize percentages clamp to 1..100", setFrameBoxFromResize(free, { width: 0, height: 900 }, "x", comp).width === 1);
}

// --- frameEffectiveParams: stored params are an OVERRIDE layer over the definition --------------
{
  const stale: LayerFrame = { definitionId: "kimera.circle", generatorId: "ellipse", params: {} };
  check("a frame saved before chrome existed inherits it", frameEffectiveParams(stale).aspectLock === true);
  const box = frameBoxRect(stale, { width: 1920, height: 1080 });
  check("→ so an old saved circle self-heals to a CIRCLE", box.width === box.height);

  const overridden: LayerFrame = { definitionId: "kimera.circle", generatorId: "ellipse", params: { aspectLock: false } };
  check("an explicit stored value still wins over the default", frameEffectiveParams(overridden).aspectLock === false);
  const unknown: LayerFrame = { definitionId: "acme.not-installed", generatorId: "ellipse", params: { width: 40 } };
  check("an uninstalled pack renders from what the layer stored", frameEffectiveParams(unknown).width === 40);
}

// --- catalogue integrity ---------------------------------------------------------------
{
  check("built-ins have unique ids", new Set(builtInFrames.map((f) => f.id)).size === builtInFrames.length);
  check("every built-in has a name + generator", builtInFrames.every((f) => f.name && f.generatorId));
}

// --- frameClipMask: the render bridge (synthesized clip Mask, inscribed in the comp box) ------
{
  const layer = (frame?: LayerFrame) => ({ id: "L1", frame });
  check("no frame → null", frameClipMask(layer(undefined), { width: 1920, height: 1080 }) === null);

  const rr = frameClipMask(layer({ definitionId: "kimera.rounded-rect", generatorId: "rounded-rect", params: { roundness: 50 } }), { width: 1920, height: 1080 })!;
  check("rounded-rect → rectangle mask, 4 corner points", rr.shape === "rectangle" && rr.points.length === 4);
  check("rounded-rect corners span the comp box", rr.points[1]!.x === 1920 && rr.points[2]!.y === 1080);
  check("rounded-rect cornerRadius = min/2 × roundness%", rr.cornerRadius === (Math.min(1920, 1080) / 2) * 0.5);
  check("frame mask id is deterministic", rr.id === frameMaskId("L1") && rr.mode === "add" && rr.enabled === true);

  const el = frameClipMask(layer({ definitionId: "kimera.circle", generatorId: "ellipse", params: {} }), { width: 800, height: 800 })!;
  check("ellipse → ellipse mask", el.shape === "ellipse" && el.points.length === 4);

  // THE bug from QA round 1: an ellipse inscribed in a 16:9 comp box is an oval. The circle's
  // aspectLock must square the mask box so the clip is round on a 16:9 timeline.
  const circle16x9 = frameClipMask(layer({ definitionId: "kimera.circle", generatorId: "ellipse", params: {} }), { width: 1920, height: 1080 })!;
  const cw = circle16x9.points[1]!.x - circle16x9.points[0]!.x;
  const ch = circle16x9.points[2]!.y - circle16x9.points[1]!.y;
  check("circle in a 16:9 comp → SQUARE mask box (round, not oval)", cw === ch && cw === 1080);
  check("circle mask box is centered in the comp", circle16x9.points[0]!.x === 420 && circle16x9.points[0]!.y === 0);

  const poly = frameClipMask(layer({ definitionId: "kimera.hexagon", generatorId: "polygon", params: { sides: 6, rotation: 0 } }), { width: 1000, height: 1000 })!;
  check("polygon → polygon mask with 6 verts", poly.shape === "polygon" && poly.points.length === 6);

  // A frame box smaller than the comp must inscribe the shape, not span the whole frame.
  const inset = frameClipMask(layer({ definitionId: "kimera.rounded-rect", generatorId: "rounded-rect", params: { roundness: 0, width: 50, height: 50 } }), { width: 1000, height: 1000 })!;
  check("a 50% box inscribes the mask (centered, half size)", inset.points[0]!.x === 250 && inset.points[0]!.y === 250 && inset.points[2]!.x === 750 && inset.points[2]!.y === 750);
  const insetPoly = frameClipMask(layer({ definitionId: "kimera.hexagon", generatorId: "polygon", params: { sides: 4, rotation: 0, width: 50, height: 50, aspectLock: false } }), { width: 1000, height: 1000 })!;
  check("polygon verts stay inside the frame box", insetPoly.points.every((p) => p.x >= 249.9 && p.x <= 750.1 && p.y >= 249.9 && p.y <= 750.1));

  const svg = frameClipMask(layer({ definitionId: "acme.torn", generatorId: "svg-path", params: {}, staticPath: "M0 0H1V1H0Z" }), { width: 100, height: 100 });
  check("svg-path → null (Phase 2 render; no clip yet)", svg === null);
}

// --- QA round 5: mediaRectInFrame — where the SOURCE clip actually sits (content mode hug) ------
{
  const approx = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

  // Identity: same aspect, fit fills, no zoom/pan → the media exactly fills the layer box.
  const id = mediaRectInFrame({ sourceAspect: 16 / 9, compAspect: 16 / 9, fit: "cover", contentScale: 1, contentOffset: { x: 0, y: 0 } });
  check("no zoom/pan, matching aspect → fills the box", approx(id.x, 0) && approx(id.y, 0) && approx(id.width, 1) && approx(id.height, 1));

  // Contain a SQUARE source in a 16:9 comp → 56.25% width, full height, centred (matches contentBoxSizeOverride).
  const contain = mediaRectInFrame({ sourceAspect: 1, compAspect: 16 / 9, fit: "contain", contentScale: 1, contentOffset: { x: 0, y: 0 } });
  check("contain square in 16:9 → 0.5625 wide, full height", approx(contain.width, 0.5625) && approx(contain.height, 1));
  check("→ and centred", approx(contain.x, (1 - 0.5625) / 2) && approx(contain.y, 0));

  // Cover a square source in 16:9 → full width, overflows height (taller than the box).
  const cover = mediaRectInFrame({ sourceAspect: 1, compAspect: 16 / 9, fit: "cover", contentScale: 1, contentOffset: { x: 0, y: 0 } });
  check("cover square in 16:9 → full width, overflow height", approx(cover.width, 1) && approx(cover.height, 1 / 0.5625));

  // Content zoom shrinks the visible source window → the rect grows (media appears bigger).
  const zoomed = mediaRectInFrame({ sourceAspect: 16 / 9, compAspect: 16 / 9, fit: "cover", contentScale: 2, contentOffset: { x: 0, y: 0 } });
  check("content.scale 2 → the media rect doubles", approx(zoomed.width, 2) && approx(zoomed.height, 2));

  // Pan: offsetX moves the rect RIGHT; offsetY is Y-UP in the compositor so +offsetY moves it UP (screen −y).
  const panned = mediaRectInFrame({ sourceAspect: 16 / 9, compAspect: 16 / 9, fit: "cover", contentScale: 1, contentOffset: { x: 0.4, y: 0.4 } });
  check("offsetX 0.4 → centre shifts +0.2 in x", approx(panned.x + panned.width / 2, 0.5 + 0.2));
  check("offsetY 0.4 → centre shifts UP (−0.2 in screen y)", approx(panned.y + panned.height / 2, 0.5 - 0.2));
}

// --- QA round 5: snapMediaRectToBox — edges + centre snap while panning --------------------------
{
  const approx = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;
  const box = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 };

  // Left edge 0.01 short of the box's left, within a 0.02 threshold → snaps to align exactly.
  const nearLeft = snapMediaRectToBox({ x: 0.26, y: 0.25, width: 0.5, height: 0.5 }, box, 0.02, 0.02);
  check("media left near frame left → snaps left edges together", nearLeft.snappedX && approx(nearLeft.dx, -0.01));
  check("→ y already aligned snaps to 0 shift", nearLeft.snappedY && approx(nearLeft.dy, 0));

  // Outside the threshold → no snap, no shift (a deliberate drag wins).
  const far = snapMediaRectToBox({ x: 0.4, y: 0.25, width: 0.5, height: 0.5 }, box, 0.02, 0.02);
  check("beyond the threshold → no snap", !far.snappedX && far.dx === 0);

  // Centre alignment: a media rect wider than the box snaps its CENTRE to the box centre.
  // rect centre x = 0.09 + 0.8/2 = 0.49, one edge each side is >0.03 away, so the CENTRE (0.01 off) wins.
  const centred = snapMediaRectToBox({ x: 0.09, y: 0.25, width: 0.8, height: 0.5 }, box, 0.03, 0.03);
  check("wide media near-centred → snaps centre to centre", centred.snappedX && approx(0.49 + centred.dx, 0.5));
}

// --- QA round 5: frameGroupScaleFactor (D6) — corner resize scales the inner media too ----------
{
  const approx = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;
  const comp = { width: 1920, height: 1080 };
  const prev = { params: { width: 100, height: 100, aspectLock: false } };

  // Uniform shrink to half on both axes → factor 0.5 (media keeps its coverage).
  const half = frameGroupScaleFactor(prev, { width: 50, height: 50, aspectLock: false }, comp);
  check("D6: box halved uniformly → content scale ×0.5", approx(half, 0.5));

  // Non-uniform (0.5 × 0.8) → geometric mean preserves area coverage.
  const nonUniform = frameGroupScaleFactor(prev, { width: 50, height: 80, aspectLock: false }, comp);
  check("D6: non-uniform corner → geometric-mean factor", approx(nonUniform, Math.sqrt(0.5 * 0.8)));

  // Degenerate box → safe identity.
  check("D6: degenerate → factor 1", frameGroupScaleFactor({ params: { width: 0, height: 0 } }, { width: 0, height: 0 }, comp) === 1);
}

// --- Step F (D4): frameToShapeLayer — the ONE frame→shape translation table -------------------
{
  const comp = { width: 1920, height: 1080 };
  const base = (frame: LayerFrame): TimelineLayer =>
    ({
      id: "L1",
      trackId: "T1",
      type: "image",
      name: "clip",
      startSeconds: 0,
      durationSeconds: 5,
      assetId: "asset_1",
      fit: "cover",
      content: { scale: 2, offsetX: 0.3 },
      transform: { x: 50, y: 50, scale: 1, rotation: 0, opacity: 100 },
      effects: [],
      animations: [],
      frame
    }) as unknown as TimelineLayer;

  // rounded-rect → native rounded-rectangle + borderRadius (roundness stays a live shape slider).
  const rr = frameToShapeLayer(base({ definitionId: "kimera.rounded-rect", generatorId: "rounded-rect", params: { roundness: 50, width: 50, height: 50 } }), comp);
  check("rounded-rect → shape rounded-rectangle", rr.type === "shape" && rr.shapeKind === "rounded-rectangle");
  // box = 50% → 960×540 px; borderRadius = min/2 × 50% = 540/2 × 0.5 = 135.
  check("rounded-rect → borderRadius from roundness", Math.abs((rr.borderRadius ?? 0) - 135) < 1e-6);
  check("box carried over as width/height %", Math.abs((rr.widthPercent ?? 0) - 50) < 1e-6 && Math.abs((rr.heightPercent ?? 0) - 50) < 1e-6);

  // The conversion is one-way: frame + media-only fields dropped, shape gets its own paint.
  check("frame + media dropped", rr.frame === undefined && rr.assetId === undefined && rr.content === undefined && rr.fit === undefined);
  check("shape gets a fill + stroke", typeof rr.color === "string" && typeof rr.strokeColor === "string" && rr.strokeWidth === 0);
  check("identity preserved (id/track/timing/transform)", rr.id === "L1" && rr.trackId === "T1" && rr.durationSeconds === 5 && rr.transform.x === 50);

  // circle → native ellipse.
  const circle = frameToShapeLayer(base({ definitionId: "kimera.circle", generatorId: "ellipse", params: {} }), comp);
  check("circle → shape ellipse", circle.shapeKind === "ellipse");
  // aspectLock circle in 16:9 → square box, so width% (56.25) ≠ height% (100) but pixels are equal.
  check("circle box % is the effective (squared) box", Math.abs((circle.widthPercent ?? 0) - 56.25) < 1e-6 && circle.heightPercent === 100);

  // polygon → pen + shapePath (vertices in 0..100 shape-box coords, 0° → a vertex at the top).
  const hex = frameToShapeLayer(base({ definitionId: "kimera.hexagon", generatorId: "polygon", params: { sides: 6, rotation: 0 } }), comp);
  check("polygon → pen + shapePath", hex.shapeKind === "pen" && (hex.shapePath?.length ?? 0) === 6);
  check("shapePath verts are in 0..100", (hex.shapePath ?? []).every((p) => p.x >= -0.01 && p.x <= 100.01 && p.y >= -0.01 && p.y <= 100.01));
  check("first hex vertex sits at the top (x=50, y≈0)", Math.abs((hex.shapePath?.[0]?.x ?? 0) - 50) < 1e-6 && Math.abs(hex.shapePath?.[0]?.y ?? 99) < 1e-6);

  // exotic (svg-path/blob/torn-paper) → honest full box (they don't clip today).
  const svg = frameToShapeLayer(base({ definitionId: "acme.torn", generatorId: "svg-path", params: {}, staticPath: "M0 0H1V1H0Z" }), comp);
  check("svg-path → rectangle fallback (matches its current unclipped visual)", svg.shapeKind === "rectangle" && svg.shapePath === undefined);
}

// --- Step E: frameBorderShapeLayer + expandFrameBorders (border = derived stroke-only shape) ----
{
  const comp = { width: 1080, height: 1920 };
  const framed = (params: Record<string, LayerFrame["params"][string]>): LayerFrame => ({
    definitionId: "kimera.rounded-rect",
    generatorId: "rounded-rect",
    params
  });
  const mediaLayer = (frame?: LayerFrame): TimelineLayer =>
    ({
      id: "L1",
      trackId: "T1",
      type: "image",
      name: "clip",
      startSeconds: 0,
      durationSeconds: 5,
      assetId: "asset_1",
      fit: "cover",
      transform: { x: 50, y: 50, scale: 1, rotation: 0, opacity: 100 },
      effects: [{ id: "fx1", type: "blur", name: "Blur", enabled: true, intensity: 100, params: { amount: 5 } }],
      animations: [],
      masks: [],
      frame
    }) as unknown as TimelineLayer;

  // Off by default → no clone.
  check("no frame → no border clone", frameBorderShapeLayer(mediaLayer(undefined), comp) === null);
  check("border off → no border clone", frameBorderShapeLayer(mediaLayer(framed({ roundness: 40 })), comp) === null);
  check("border on but zero width → no clone", frameBorderShapeLayer(mediaLayer(framed({ border: true, borderWidth: 0 })), comp) === null);

  // On → a stroke-only shape clone.
  const on = mediaLayer(framed({ roundness: 40, width: 78, height: 60, border: true, borderWidth: 16, borderColor: "#ffd24a" }));
  const clone = frameBorderShapeLayer(on, comp)!;
  check("border clone is a shape with the derived suffix", clone !== null && clone.type === "shape" && clone.id === `L1${FRAME_BORDER_LAYER_SUFFIX}`);
  check("border clone is stroke-only (transparent fill)", clone.color === "transparent" && clone.strokeColor === "#ffd24a" && clone.strokeWidth === 16);
  check("border clone reuses the D1 outline mapping", clone.shapeKind === "rounded-rectangle" && (clone.borderRadius ?? 0) > 0);
  check("border clone box = the frame box %", Math.abs((clone.widthPercent ?? 0) - 78) < 1e-9 && Math.abs((clone.heightPercent ?? 0) - 60) < 1e-9);
  check("media-only + effect fields are stripped", clone.assetId === undefined && clone.effects.length === 0 && clone.masks === undefined && clone.frame === undefined && clone.transitionIn === undefined);
  check("transform rides (same position/scale)", clone.transform.x === 50 && clone.transform.scale === 1);

  // Composition expansion: clone directly after its layer; unchanged composition returns the SAME object.
  const compo = {
    id: "c1",
    name: "c",
    width: 1080,
    height: 1920,
    fps: 30,
    durationSeconds: 5,
    backgroundColor: "#000",
    tracks: [{ id: "T1", type: "video", name: "V", layers: [on] }]
  } as unknown as TimelineComposition;
  const expanded = expandFrameBorders(compo);
  check("expandFrameBorders inserts the clone after its layer", expanded.tracks[0]!.layers.length === 2 && expanded.tracks[0]!.layers[1]!.id === `L1${FRAME_BORDER_LAYER_SUFFIX}`);
  const noBorder = { ...compo, tracks: [{ ...compo.tracks[0]!, layers: [mediaLayer(framed({ roundness: 40 }))] }] } as TimelineComposition;
  check("nothing to expand → SAME composition reference", expandFrameBorders(noBorder) === noBorder);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll frames checks passed");
