/**
 * Standalone assert script for Frames (Phase 1 foundation — see FRAMES.md). Repo convention: no test
 * framework — exits non-zero on first failure.
 *
 *   pnpm --filter @kimera-by-aelivion/web frames:test
 *
 * Covers the pure generators (unit-box path `d`), param defaults, and the built-in catalogue.
 */
import {
  builtInFrames,
  findFrameDefinition,
  frameBoxPercent,
  frameBoxRect,
  frameChromeParams,
  frameClipMask,
  frameEffectiveParams,
  frameMaskId,
  frameOutlinePathD,
  frameParamDefaults,
  frameParamSchema,
  frameParamSections,
  makeLayerFrame,
  setFrameBoxAxis,
  setFrameBoxFromResize,
  type FrameDefinition,
  type LayerFrame
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
  check("sections group Shape then Box", sections.length === 2 && sections[0]!.title === "Shape" && sections[1]!.title === "Box");
  check("Shape section holds only the generator's own params", sections[0]!.params.every((p) => p.key === "roundness"));
  const circleSections = frameParamSections(circle);
  check("a frame with no generator params shows only Box", circleSections.length === 1 && circleSections[0]!.title === "Box");

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
  const corner = setFrameBoxFromResize(free, { width: 40, height: 60 }, "both", comp);
  check("unlocked corner moves both axes", corner.width === 40 && corner.height === 60);

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

  check("resize percentages clamp to 1..100", setFrameBoxFromResize(free, { width: 0, height: 900 }, "both", comp).width === 1);
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

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll frames checks passed");
