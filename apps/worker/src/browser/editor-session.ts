/**
 * Getting a Playwright page into the editor — the one copy of it.
 *
 * WHY THIS FILE EXISTS. Every browser gate that needs a real editor (rather than a `/@fs/` module
 * import of the compositor) has to perform the same product flow first, and each one carried its own
 * copy. `playback-probe.ts`'s copy had rotted: it clicked a "Use template" button on `/create` that the
 * page no longer renders, then fell through and asserted against the marketing landing page — reporting
 * on a page with no transport at all.
 *
 * A stale reach helper is worse than a missing one: the probe still runs, still prints a verdict, and
 * the verdict is about the wrong page. Hence one copy, which fails loudly.
 *
 * `pause-coherence-gate.ts` deliberately keeps its OWN version and should: it requires real footage
 * (`PROBE_EDITOR_URL` / `PROBE_MEDIA`) and refuses to run without it, because a pause-coherence number
 * measured on a tiny synthetic clip proves nothing about a 4K sparse-GOP source. That is a stricter
 * contract than this helper offers, not a duplicate of it.
 *
 * THE ACTUAL FLOW (verified against a live dev server, 2026-08-02):
 *
 *   /create  →  input[type=file]  →  metadata probe (~5s)  →  "Edit it myself"  →  "Continue"
 *            →  template picker  →  "Blank Project"  →  /editor/project_local_…
 *
 * No auth: `/create` is reachable signed-out and mints a LOCAL project, which is also the cheaper
 * fixture — nothing touches Postgres, so a gate cannot leave rows behind.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import type { Page } from "playwright";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

export const EDITOR_BASE = process.env.PROBE_BASE ?? "http://localhost:5173";

export interface ReachEditorOptions {
  /** Video to seed the project with. Defaults to a small clip from the API's render output. */
  clipPath?: string;
  /** Extra query string appended to the editor URL (engine flags), without the leading `?`. */
  flags?: string;
  /** Time to let the editor settle after arrival. Media mounts and decoder leases need this. */
  settleMs?: number;
}

/**
 * Duration in seconds from the mp4 `mvhd` box, or null if it cannot be read. Deliberately dependency-free
 * — a seed-file chooser must not need ffprobe on the PATH to work.
 */
function mp4DurationSeconds(file: string): number | null {
  try {
    const bytes = fs.readFileSync(file);
    const at = bytes.indexOf(Buffer.from("mvhd"));
    if (at < 0) return null;
    const version = bytes[at + 4];
    if (version === 0) {
      const timescale = bytes.readUInt32BE(at + 16);
      return timescale > 0 ? bytes.readUInt32BE(at + 20) / timescale : null;
    }
    const timescale = bytes.readUInt32BE(at + 24);
    return timescale > 0 ? Number(bytes.readBigUInt64BE(at + 28)) / timescale : null;
  } catch {
    return null;
  }
}

/**
 * A real mp4 to seed a project with. Chosen by **duration first**, which is not a detail: the first
 * version of this picked the smallest file, which turned out to be ~1s long, so a 10s measurement run
 * spent 9 of those seconds past the end of its own material — decoding nothing, compositing nothing, and
 * reporting a beautifully reproducible 75.0fps in both arms of an A/B that was measuring an empty
 * timeline. A seed clip must outlast the window that samples it.
 *
 * Among clips long enough, the SMALLEST wins: the upload is setup, not the thing being measured.
 */
export function defaultClipPath(minimumSeconds = 20): string {
  const explicit = process.env.PROBE_CLIP;
  if (explicit) return explicit;
  const dir = path.join(repoRoot, "apps/api/storage/finals");
  const candidates = fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((name) => name.endsWith(".mp4"))
        .map((name) => path.join(dir, name))
        .map((file) => ({ file, size: fs.statSync(file).size, seconds: mp4DurationSeconds(file) }))
        .filter((entry) => entry.seconds != null && entry.seconds >= minimumSeconds)
        .sort((a, b) => a.size - b.size)
    : [];
  if (candidates.length === 0) {
    throw new Error(
      `no seed clip of at least ${minimumSeconds}s: set PROBE_CLIP=<path to an .mp4> ` +
        "(searched apps/api/storage/finals)"
    );
  }
  return candidates[0]!.file;
}

/**
 * Drive a fresh page into a working editor. Idempotent: a page already on `/editor/` is left alone, so
 * a gate can call this defensively without re-creating a project.
 *
 * Throws rather than returning a boolean. A gate that proceeds after failing to reach the editor
 * produces a verdict about the landing page, which is the failure mode this file exists to end.
 */
export async function reachEditor(page: Page, options: ReachEditorOptions = {}): Promise<string> {
  if (page.url().includes("/editor/")) return page.url();
  const clip = options.clipPath ?? defaultClipPath();

  await page.goto(`${EDITOR_BASE}/create`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);

  const fileInput = page.locator("input[type=file]").first();
  await fileInput.waitFor({ state: "attached", timeout: 15_000 });
  await fileInput.setInputFiles(clip);

  // The upload path probes duration/dimensions off a hidden <video> before it will enable Continue.
  // Waiting on the button's enabled state (rather than a fixed sleep) keeps this honest on a slow box.
  const cont = page.getByRole("button", { name: /^continue$/i }).first();
  await cont.waitFor({ state: "visible", timeout: 30_000 });
  await page
    .waitForFunction(
      () =>
        Array.from(document.querySelectorAll("button")).some(
          (b) => /^continue$/i.test((b.textContent ?? "").trim()) && !(b as HTMLButtonElement).disabled
        ),
      undefined,
      { timeout: 30_000 }
    )
    .catch(() => undefined);

  // "Edit it myself" — the non-AI branch. The AI branch needs a Pro toggle and a planner round-trip,
  // neither of which any gate wants in its measurement.
  const mine = page.getByRole("button", { name: /edit it myself/i }).first();
  if (await mine.count().catch(() => 0)) await mine.click().catch(() => undefined);

  await cont.click();
  await page.getByRole("button", { name: /blank project/i }).first().click({ timeout: 20_000 });

  await page.waitForURL(/\/editor\//, { timeout: 40_000 });
  if (options.flags) {
    const url = new URL(page.url());
    for (const pair of options.flags.split("&")) {
      const [key, value = "1"] = pair.split("=");
      if (key) url.searchParams.set(key, value);
    }
    await page.goto(url.toString(), { waitUntil: "domcontentloaded" });
    await page.waitForURL(/\/editor\//, { timeout: 20_000 });
  }
  await page.waitForTimeout(options.settleMs ?? 6_000);
  return page.url();
}

/**
 * Give the project a Flarex comp with a BUILT PROXY — the fixture the demotion path needs.
 *
 * Without this, a probe measuring `kernelProxySource` is measuring nothing: a blank project has no comp,
 * so nothing is ever demoted and both arms are identical by construction. The first runs of
 * `preview-budget-probe` reported a beautifully reproducible null result for exactly that reason.
 *
 * The flow is the product's own: select the clip → Flarex page → "Create Flarex comp" (which wires a
 * MediaIn → MediaOut graph over the clip's own media) → "Prepare proxy" → wait for "Proxy ready" → back
 * to Edit. Nothing is injected into stores; if the product's path breaks, the fixture breaks loudly,
 * which is the point of building it this way rather than reaching into the graph.
 *
 * Returns false when the fixture could not be built, so a caller can report a VOID run rather than a
 * confident number about a comp that does not exist.
 */
/**
 * Which gate a fixture step stopped at — the discriminator these helpers used to lack.
 *
 * WHY THIS EXISTS. `addAssetSourceMediaIn` had five distinct `return false` points and reported one
 * boolean. When it failed during ADR-013 Phase 0 / M0 the run was void and the cause was unnameable:
 * no clip, no comp, no trigger, no tile and a pick that silently did not land are five different
 * repairs, and a caller could only say "FAILED". That is ADR-012's fourth learning — *count the
 * reasons; never infer which branch fired* — applied to the harness rather than to the runtime, and
 * the harness is where it bites hardest, because a void run costs the whole measurement.
 *
 * `unbound-host-clip` is the interesting one and the reason a boolean was never enough: the node WAS
 * created, so every structural check passes, but it declares no asset — it opens no decoder, and the
 * fixture is silently the old comp-with-no-sources that three slices' worth of measurement already
 * came back reading zero on.
 */
export type FixtureGate =
  | "ok"
  /** No `.timeline-clip` — the project has no clip to hang a comp on. */
  | "no-timeline-clip"
  /** The Flarex page never offered "Add MediaIn": the comp was not created, or the tab did not open. */
  | "no-add-mediain-button"
  /** The node exists but its inspector row never rendered. */
  | "no-source-trigger"
  /** The asset bin had no tile at the requested index — usually an import that did not land. */
  | "no-asset-tile"
  /** The trigger rendered without a `title`; the bind cannot be confirmed either way. */
  | "bound-title-unreadable"
  /** The pick did not land: node created, still reading the host clip, declaring no source. */
  | "unbound-host-clip";

export interface FixtureStep {
  readonly ok: boolean;
  readonly gate: FixtureGate;
  /** What was actually observed at the gate — the bound title, the tile index. Never load-bearing. */
  readonly detail?: string | undefined;
}

function step(gate: FixtureGate, detail?: string): FixtureStep {
  return { ok: gate === "ok", gate, detail };
}

export async function buildFlarexProxyFixture(page: Page, timeoutMs = 180_000): Promise<boolean> {
  const clip = page.locator(".timeline-clip").first();
  if (!(await clip.count().catch(() => 0))) return false;
  await clip.click().catch(() => undefined);
  await page.waitForTimeout(500);

  await page.getByRole("tab", { name: /flarex/i }).first().click({ timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(1_500);

  const create = page.getByRole("button", { name: /create flarex comp/i }).first();
  if (await create.count().catch(() => 0)) {
    await create.click().catch(() => undefined);
    await page.waitForTimeout(2_500);
  }

  const proxyButton = page.locator(".flarex-proxy-btn").first();
  if (!(await proxyButton.count().catch(() => 0))) return false;
  const label = (await proxyButton.textContent().catch(() => "")) ?? "";
  if (!/proxy ready/i.test(label)) {
    await proxyButton.click().catch(() => undefined);
    // The render walks the clip's whole span, so this is minutes on a long source, not seconds. Waiting
    // on the button's own state is what keeps that honest instead of a guessed sleep.
    await page
      .locator(".flarex-proxy-btn", { hasText: /proxy ready/i })
      .first()
      .waitFor({ state: "visible", timeout: timeoutMs })
      .catch(() => undefined);
  }
  const ready = await page
    .locator(".flarex-proxy-btn", { hasText: /proxy ready/i })
    .first()
    .count()
    .catch(() => 0);

  await page.getByRole("tab", { name: /^edit$/i }).first().click({ timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(2_000);
  return ready > 0;
}

/**
 * Add an ASSET-SOURCE MediaIn to the selected clip's comp, bound to the project's own asset — the
 * topology every open decoder question needs, and the one no fixture has had.
 *
 * WHY THIS SPECIFIC SHAPE. `buildFlarexProxyFixture` alone produces a comp whose MediaIn reads its HOST
 * clip, and `collectFlarexVirtualLayers` builds a loader only for MediaIn nodes carrying a
 * `sourceAssetId`. So that fixture declares no sources, demotes nothing, and borrows nothing: three
 * slices' worth of measurement all came back reading zero on it. Binding a MediaIn to the same asset the
 * host clip already plays gives **one file read through two doors**, which is simultaneously:
 *
 *   · the duplicate-decode case session sharing was BUILT for (S4.7 must keep it sharing),
 *   · a declared source the Media Manager can demote (S3.5's C1 question), and
 *   · the identity match that made the 2026-08-02 harm reachable at all (S4.7's done-when).
 *
 * Wiring is deliberately not attempted: virtual loaders are collected from `comp.nodes` regardless of
 * reachability, so an unwired MediaIn still opens a decoder — which is the whole subject here. Dragging
 * a wire in Playwright would add flake for no measurement.
 *
 * Returns false if the graph could not be built, so a caller reports a void run rather than a confident
 * number about a topology that is not there.
 */
export async function addAssetSourceMediaIn(page: Page): Promise<FixtureStep> {
  // Selects the clip and creates the comp if needed, so this can run BEFORE the proxy is rendered.
  // Ordering is not cosmetic: `comp.version` is the proxy's cache key, so a MediaIn added after a build
  // invalidates it immediately and the run would measure a comp with no usable proxy.
  const clip = page.locator(".timeline-clip").first();
  if (!(await clip.count().catch(() => 0))) return step("no-timeline-clip");
  await clip.click().catch(() => undefined);
  await page.waitForTimeout(500);

  await page.getByRole("tab", { name: /flarex/i }).first().click({ timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(1_200);

  const create = page.getByRole("button", { name: /create flarex comp/i }).first();
  if (await create.count().catch(() => 0)) {
    await create.click().catch(() => undefined);
    await page.waitForTimeout(2_500);
  }

  const add = page.locator('[aria-label="Add MediaIn"]').first();
  if (!(await add.count().catch(() => 0))) return step("no-add-mediain-button");
  await add.click().catch(() => undefined);
  await page.waitForTimeout(1_000);

  // The node's inspector row. Its label is the bound asset's name, or "Host clip" while unbound — which
  // is exactly the state we are here to change.
  const trigger = page.locator(".flarex-source-trigger").first();
  if (!(await trigger.count().catch(() => 0))) return step("no-source-trigger");
  await trigger.click().catch(() => undefined);
  await page.waitForTimeout(800);

  // Replace mode routes a DOUBLE click to `onPickReplacement`; a single click only selects (deliberate
  // product behaviour since 2026-07-04 — a single click used to be a silent composition edit).
  const tile = page.locator(".asset-tile").first();
  const tiles = await tile.count().catch(() => 0);
  if (!tiles) return step("no-asset-tile");
  await tile.dblclick().catch(() => undefined);
  await page.waitForTimeout(1_500);

  const bound = await trigger.getAttribute("title").catch(() => null);
  await page.getByRole("tab", { name: /^edit$/i }).first().click({ timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(2_500);
  // "Host clip" means the pick did not land — the node exists but declares no asset, so it opens no
  // decoder and the fixture would silently be the old one again.
  if (bound == null) return step("bound-title-unreadable");
  if (/host clip/i.test(bound)) return step("unbound-host-clip", bound);
  return step("ok", bound);
}

/**
 * Cut the timeline's clip in two at the playhead — the preload crossing.
 *
 * WHY. The two-MediaIn fixture reproduces the duplicate-decode SHARE (one file, two doors, both at the
 * same moment) but not the HARM. The 2026-08-02 finding needed a third participant: a **preload** — the
 * pre-roll shell that mounts ~1.2s before a cut and acquires the upcoming clip's asset while a different
 * consumer is already serving that same asset live. Identity matched, times did not, and the incumbent
 * paid two hardware resets for it.
 *
 * A CUT is the smallest arrangement that produces it, and the most ordinary: as the playhead nears the
 * boundary, the second half's shell asks for a time ~a lookahead ahead of what the first half is
 * serving. Exactly the pair `sessionSatisfaction` is supposed to keep apart, and — with the flag off —
 * exactly what `noteDivergence` is supposed to detach four bad frames later.
 *
 * WHY NOT "add the asset again", which is what this helper used to do. `Add video only` puts the new
 * clip on a NEW TRACK STARTING AT ZERO: two clips of one asset playing the same moment on top of each
 * other. That is CO-LOCATION — the case sharing was built for and which by construction can never
 * diverge — so the fixture reported a healthy `shared 5` while the harm it existed to reproduce was
 * arithmetically impossible. Two runs of "detaches 0 in both arms" were that, not a working guard.
 *
 * Without a real cut the slice's *done when* ("zero divergence firings across a soak") is satisfied
 * trivially, by a fixture in which nothing could ever diverge. That is not evidence, it is an absence
 * of it.
 *
 * Returns the cut position in seconds, or null.
 */
export async function cutClipAtFraction(page: Page, fraction = 0.55): Promise<number | null> {
  await page.getByRole("tab", { name: /^edit$/i }).first().click({ timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(800);
  const before = await page.locator(".timeline-clip").count().catch(() => 0);
  if (before === 0) return null;

  const box = await page.evaluate(() => {
    const ruler = document.querySelector(".timeline-ruler");
    const clip = document.querySelector(".timeline-clip");
    if (!(ruler instanceof HTMLElement) || !(clip instanceof HTMLElement)) return null;
    const r = ruler.getBoundingClientRect();
    const c = clip.getBoundingClientRect();
    return { rulerY: r.top + r.height / 2, clipLeft: c.left, clipWidth: c.width, clipY: c.top + c.height / 2 };
  });
  if (!box || box.clipWidth < 20) return null;

  // Park the playhead inside the clip, then select the clip, then split. The order matters: clicking a
  // clip deliberately does NOT move the playhead (startScrub returns early on `.timeline-clip`), so
  // selecting after seeking keeps the position that was just set.
  const cutX = box.clipLeft + box.clipWidth * fraction;
  await page.mouse.click(cutX, box.rulerY);
  await page.waitForTimeout(300);
  await page.mouse.click(cutX, box.clipY);
  await page.waitForTimeout(300);

  const split = page.locator('button[title^="Split at playhead"]').first();
  if (!(await split.count().catch(() => 0))) return null;
  await split.click({ timeout: 5_000 }).catch(() => undefined);
  await page.waitForTimeout(1_500);

  // Two clips is not enough: the old helper produced two clips that started at the same x. The cut is
  // only real if their LEFT EDGES differ.
  const edges = await page.evaluate(() => {
    const lefts = Array.from(document.querySelectorAll(".timeline-clip"))
      .map((el) => el.getBoundingClientRect().left)
      .sort((a, b) => a - b);
    return lefts.filter((x, i) => i === 0 || x - lefts[i - 1]! > 4).length;
  });
  if (edges < 2) return null;
  return page.evaluate(
    () => (window as unknown as { __rfClock?: { committed: number } }).__rfClock?.committed ?? null
  );
}

export interface CutSeekResult {
  /** Where the two clips meet, in seconds, as the editor itself reports it. */
  cutSeconds: number;
  /** Where the playhead actually landed. Snapping means this is not exactly `cut - lead`. */
  parkedSeconds: number;
  pixelsPerSecond: number;
}

/**
 * Park the playhead just before the cut, so the sample window CONTAINS the preload crossing.
 *
 * {@link addSecondClipOfSameAsset} makes the crossing reachable; it does not make the run visit it.
 * The second clip appends after the first, so a 25s sample starting at t=0 on a ~28s first clip never
 * gets within the ~1.2s pre-roll lookahead of the boundary — the shell never mounts, nothing borrows
 * across two times, and `shareDetaches` reads 0 in the arm that still contains the defect. A criterion
 * satisfied by the unfixed arm is not evidence of a fix, it is an absence of one, so the run has to
 * start where the interesting thing happens.
 *
 * HOW. Timeline x↔time is a zoom-, scroll- and duration-dependent mapping, and this deliberately does
 * not reimplement it: it CALIBRATES against the editor. Click the ruler at two known x, read the
 * resulting time from `__rfClock` each time, and the slope between them is pixels-per-second as the
 * app actually applies it today. Anything derived from that is right even if the timeline's zoom
 * defaults change — and if the mapping ever stops being affine, the verification read at the end
 * catches it rather than silently parking somewhere else.
 */
export async function seekBeforeCut(page: Page, leadSeconds = 2.5): Promise<CutSeekResult | null> {
  const geometry = await page.evaluate(() => {
    const ruler = document.querySelector(".timeline-ruler");
    if (!(ruler instanceof HTMLElement)) return null;
    const lefts = Array.from(document.querySelectorAll(".timeline-clip"))
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 2)
      .map((r) => r.left)
      .sort((a, b) => a - b);
    // Distinct edges: a linked video+audio pair puts two clips at the SAME x, and treating the twin
    // as "the second clip" would put the cut at the start of the timeline.
    const distinct = lefts.filter((x, i) => i === 0 || x - lefts[i - 1]! > 4);
    if (distinct.length < 2) return null;
    const r = ruler.getBoundingClientRect();
    return { cutX: distinct[1]!, rulerY: r.top + r.height / 2, rulerLeft: r.left, rulerRight: r.right };
  });
  if (!geometry) return null;

  const clickAt = async (x: number): Promise<number | null> => {
    if (x < geometry.rulerLeft + 2 || x > geometry.rulerRight - 2) return null;
    await page.mouse.click(x, geometry.rulerY);
    await page.waitForTimeout(250);
    return page.evaluate(
      () => (window as unknown as { __rfClock?: { committed: number } }).__rfClock?.committed ?? null
    );
  };

  // Two-point calibration. The reference click is 200px back from the cut — far enough that snapping
  // (which quantises both reads to the frame grid) is small against the span, near enough to stay on
  // screen at any sane zoom.
  const cutSeconds = await clickAt(geometry.cutX);
  const refX = geometry.cutX - 200;
  const refSeconds = await clickAt(refX);
  if (cutSeconds == null || refSeconds == null || !(cutSeconds > refSeconds)) return null;
  const pixelsPerSecond = 200 / (cutSeconds - refSeconds);

  const parkedSeconds = await clickAt(geometry.cutX - leadSeconds * pixelsPerSecond);
  if (parkedSeconds == null) return null;
  return { cutSeconds, parkedSeconds, pixelsPerSecond };
}

/** Re-open an existing project id under a different flag set — the A/B seam. Keeps the same profile. */
export async function reopenWithFlags(page: Page, projectUrl: string, flags: string, settleMs = 6_000): Promise<void> {
  const url = new URL(projectUrl);
  url.search = "";
  for (const pair of flags.split("&").filter(Boolean)) {
    const [key, value = "1"] = pair.split("=");
    if (key) url.searchParams.set(key, value);
  }
  await page.goto(url.toString(), { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(settleMs);
}

/**
 * Wait until at least one source is actually decoding through WebCodecs.
 *
 * ## The precondition every WebCodecs soak has silently skipped
 *
 * `preferNativeDecode` is `mediaUrl !== proxyUrl && !hasMeasuredDenseGop(assetId)`, and it forces the
 * `<video>` element path. A freshly imported clip has no ingest proxy, so it is element-routed BY
 * DESIGN — the WC preview pool is built for keyframe-dense proxies and a sparse-GOP camera original
 * wedges it (2026-07-06). WebCodecs becomes eligible only once the proxy lands, which is ~10s after
 * import on this box.
 *
 * And proxy builds SUSPEND during any playback. So a soak that presses play on arrival pins
 * `preferNativeDecode` true forever, routes every source to the element path, and then reports
 * `shared 0 · refusals 0 · wcProvider 0%` — numbers that look like a decoder bug and are actually a
 * measurement of a subsystem that was never allowed to start. Two S4.7 runs were lost to that, and the
 * cause was recorded as a suspected "WebCodecs init hang" that does not exist: `__rfWcHeals` was null
 * and `pool.created` was 0, so nothing was ever built, let alone hung.
 *
 * Call this BEFORE playing, and treat a false return as VOID rather than as a result.
 */
export async function awaitWebCodecsEngaged(page: Page, timeoutMs = 60_000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const engaged = await page.evaluate(() => {
      const modes = (globalThis as unknown as { __rfWcMode?: Record<string, string> }).__rfWcMode ?? {};
      const values = Object.values(modes);
      return values.length > 0 && values.some((mode) => mode !== "element");
    });
    if (engaged) return true;
    await page.waitForTimeout(1_000);
  }
  return false;
}

/**
 * Import extra media into the project's asset bin — the S4.3 fixture's raw material.
 *
 * WHY DISTINCT FILES. Source admission ranks CANDIDATES FOR A DECODER SLOT, and a slot is keyed by
 * decoder identity (today, the URL). Adding the same asset eight times therefore produces eight doors
 * onto ONE session — the duplicate-decode share, which by construction can never exceed the budget and
 * so can never be denied. An over-budget comp needs eight DIFFERENT files or the fixture measures
 * sharing while claiming to measure admission. This is the same trap `cutClipAtFraction` documents for
 * S4.7, one subsystem along.
 *
 * Returns the asset-tile count actually reached, so a caller can report a VOID run rather than a
 * confident number about a comp that never went over budget.
 */
export async function importAssets(page: Page, files: readonly string[]): Promise<number> {
  await page.getByRole("tab", { name: /^edit$/i }).first().click({ timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(600);
  const input = page.locator(".asset-upload-button input[type=file]").first();
  if (!(await input.count().catch(() => 0))) return 0;
  await input.setInputFiles([...files]).catch(() => undefined);
  // Import probes duration/dimensions off a hidden <video> per file, so the settle scales with count.
  await page.waitForTimeout(2_000 + files.length * 1_500);
  return page.locator(".asset-tile").count().catch(() => 0);
}

/**
 * The timeline's x↔time mapping, MEASURED rather than derived.
 *
 * Zoom, scroll and composition duration all move it, and no probe should reimplement that arithmetic —
 * `seekBeforeCut` already learned this one subsystem along. Two ruler clicks, two `__rfClock` reads, and
 * the slope between them is what the app is applying right now.
 */
export interface RulerCalibration {
  readonly rulerY: number;
  readonly xAt: number;
  readonly tAt: number;
  readonly pixelsPerSecond: number;
}

export async function calibrateRuler(page: Page): Promise<RulerCalibration | null> {
  const geometry = await page.evaluate(() => {
    const ruler = document.querySelector(".timeline-ruler");
    if (!(ruler instanceof HTMLElement)) return null;
    const r = ruler.getBoundingClientRect();
    if (r.width < 120) return null;
    return { y: r.top + r.height / 2, left: r.left, width: r.width };
  });
  if (!geometry) return null;

  const readAt = async (x: number): Promise<number | null> => {
    await page.mouse.click(x, geometry.y);
    await page.waitForTimeout(250);
    return page.evaluate(() => (window as unknown as { __rfClock?: { committed: number } }).__rfClock?.committed ?? null);
  };

  const xA = geometry.left + geometry.width * 0.15;
  const xB = geometry.left + geometry.width * 0.35;
  const tA = await readAt(xA);
  const tB = await readAt(xB);
  if (tA == null || tB == null || !(tB > tA)) return null;
  return { rulerY: geometry.y, xAt: xA, tAt: tA, pixelsPerSecond: (xB - xA) / (tB - tA) };
}

/** Screen x for a playhead time, under a measured calibration. */
export function rulerXForTime(cal: RulerCalibration, seconds: number): number {
  return cal.xAt + (seconds - cal.tAt) * cal.pixelsPerSecond;
}

/**
 * Park the playhead at a time and CONFIRM where it landed. Returns the committed time, or null if the
 * click did not move it there — a scrub past the end of the composition is IGNORED, not clamped, so a
 * caller that trusts the request rather than the read-back can sample one frame repeatedly and never
 * know (measured 2026-08-16; it manufactured two "findings").
 */
export async function parkPlayhead(page: Page, cal: RulerCalibration, seconds: number, toleranceSeconds = 0.2): Promise<number | null> {
  let landed: number | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const target = attempt === 0 ? seconds : seconds + (seconds - (landed ?? seconds));
    await page.mouse.click(rulerXForTime(cal, target), cal.rulerY);
    await page.waitForTimeout(250);
    landed = await page.evaluate(() => (window as unknown as { __rfClock?: { committed: number } }).__rfClock?.committed ?? null);
    if (landed == null) return null;
    if (Math.abs(landed - seconds) <= toleranceSeconds) return landed;
  }
  return landed;
}

/** Delete every clip on the timeline. Returns how many remain — non-zero means the caller should VOID. */
export async function clearTimelineClips(page: Page, maxDeletes = 24): Promise<number> {
  await page.getByRole("tab", { name: /^edit$/i }).first().click({ timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(600);
  for (let i = 0; i < maxDeletes; i += 1) {
    const clips = page.locator(".timeline-clip");
    if ((await clips.count().catch(() => 0)) === 0) break;
    await clips.first().click({ timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(200);
    await page.keyboard.press("Delete").catch(() => undefined);
    await page.waitForTimeout(350);
  }
  return page.locator(".timeline-clip").count().catch(() => -1);
}

/** Which step of the deterministic fixture stopped, when one did. A boolean would name none of them. */
export type DeterministicFixtureGate =
  | "ok"
  | "no-ruler"
  | "clips-not-cleared"
  | "shape-tool-missing"
  | "shape-not-added"
  | "playhead-not-parked"
  | "comp-not-created";

export interface DeterministicFixture {
  readonly ok: boolean;
  readonly gate: DeterministicFixtureGate;
  readonly detail?: string | undefined;
  /** Playhead times, in seconds, at which each shape clip is the whole picture. */
  readonly stopSeconds: readonly number[];
}

/** Distinct shapes, so consecutive stops cannot possibly hash the same. Labels are the select's own. */
const FIXTURE_SHAPES = ["Rectangle", "Ellipse", "Triangle", "Diamond", "Pentagon", "Line"] as const;

/**
 * A Flarex fixture with NO DECODE IN IT — N shape clips tiled along the timeline, each wrapped in its
 * own Flarex comp.
 *
 * WHY THIS EXISTS, and it is the whole point of it. `addAssetSourceMediaIn` builds the fixture that
 * answers "does the frame cache work over live footage", and that fixture cannot answer the question
 * the cache is actually on trial for. A Flarex comp on live footage does not re-render byte-identically
 * at a fixed `t` — measured, with disk free and the instrument's own defects fixed, at 1–2 unstable
 * positions of 6 and NOT converging with a longer settle. So the ORACLE is unreliable there, and an
 * unreliable oracle can neither convict the cache nor acquit it.
 *
 * Those are two questions, and only one of them is the cache's. A Flarex comp is eligible because the
 * COMPILER stamps a content token; it does not need a MediaIn to be eligible. A shape layer rasterizes
 * deterministically, so:
 *
 *   · the picture at a fixed `t` is genuinely reproducible → the oracle is sound;
 *   · `storable` (`staleIds`/`notReadyIds` both empty) is trivially true → no settle race;
 *   · every stop is a DIFFERENT shape → a frame served for the wrong `t` is visible, not silent.
 *
 * The last one is not decoration. A frame cache's characteristic failure is serving the right-looking
 * picture for the wrong moment, and a fixture whose frames all look alike is trivially "correct" — the
 * defect the mechanism gate found in its own edit fixture, one layer up.
 *
 * The seeded video clip is DELETED, not merely left off screen: a frame is eligible only if EVERY draw
 * in it carries a content token, so one plain clip anywhere in the frame makes the whole run measure a
 * switched-off cache and report a flawless pass.
 */
export async function buildDeterministicFlarexFixture(
  page: Page,
  count = 6,
  spacingSeconds = 3,
  /**
   * Wrap each shape clip in a Flarex comp. FALSE is the ADR-021 step-4a fixture: the very same six
   * clips with no comp on any of them, so the only thing that can make a frame eligible is the
   * TIMELINE layer's own content token. It is the smallest possible difference between "the compiler
   * stamps the identity" and "the timeline stamps it", which is what makes it an acceptance gate for
   * 4a rather than a second test of 3b.
   */
  withComps = true,
): Promise<DeterministicFixture> {
  const fail = (gate: DeterministicFixtureGate, detail?: string): DeterministicFixture => ({ ok: false, gate, detail, stopSeconds: [] });

  const remaining = await clearTimelineClips(page);
  if (remaining !== 0) return fail("clips-not-cleared", `${remaining} clip(s) still on the timeline`);

  // AFTER the clear, never before: removing the seeded clip can rescale the ruler, and a calibration
  // taken on the old scale would place every shape somewhere else.
  const cal = await calibrateRuler(page);
  if (!cal) return fail("no-ruler");

  const stops: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const start = i * spacingSeconds;
    const landed = await parkPlayhead(page, cal, start);
    if (landed == null || Math.abs(landed - start) > 0.35) {
      return fail("playhead-not-parked", `wanted ${start}s, landed ${landed ?? "null"}`);
    }

    // PICKING THE SHAPE *IS* THE ADD (`TimelineStrip.tsx:3176` — the select's `onChange` calls
    // `onAddLayer`, it does not merely arm the button beside it). Clicking the repeat button as well
    // adds a SECOND clip at the same start, and the pair then overlaps for its whole 2s: two draws in
    // one frame where the fixture promised one. That is not cosmetic here — a frame is cacheable only
    // if EVERY draw carries a content token, so the un-comped twin made every frame ineligible and the
    // first run of this fixture reported the 3b wiring inert in the product. The clip COUNT is what
    // caught it; `after > before` was too weak to, so this now demands exactly one.
    const shape = FIXTURE_SHAPES[i % FIXTURE_SHAPES.length]!;
    const before = await page.locator(".timeline-clip").count().catch(() => 0);
    const trigger = page.locator(".timeline-shape-select .themed-select-trigger").first();
    if (!(await trigger.count().catch(() => 0))) return fail("shape-tool-missing");
    await trigger.click().catch(() => undefined);
    await page.waitForTimeout(300);
    const option = page.locator('.themed-select-menu [role="option"]', { hasText: new RegExp(`^${shape}$`) }).first();
    if (!(await option.count().catch(() => 0))) return fail("shape-tool-missing", shape);
    await option.click().catch(() => undefined);
    await page.waitForTimeout(900);
    const after = await page.locator(".timeline-clip").count().catch(() => 0);
    if (after !== before + 1) return fail("shape-not-added", `${shape} at ${start}s took the count ${before} → ${after}, wanted ${before + 1}`);

    // A shape clip is 2s long (`createEditorLayer`), so its own middle is the one time at which it — and
    // nothing else — is the picture.
    stops.push(start + 1);
  }

  // One comp per clip. Every clip needs one: a stop over a comp-less shape is an INELIGIBLE frame, and
  // the probe's eligibility read would then depend on which stop happened to be last.
  for (let i = 0; withComps && i < count; i += 1) {
    await page.getByRole("tab", { name: /^edit$/i }).first().click({ timeout: 10_000 }).catch(() => undefined);
    await page.waitForTimeout(400);
    const clip = page.locator(".timeline-clip").nth(i);
    if (!(await clip.count().catch(() => 0))) return fail("comp-not-created", `no clip at index ${i}`);
    await clip.click({ timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(400);

    await page.getByRole("tab", { name: /flarex/i }).first().click({ timeout: 10_000 }).catch(() => undefined);
    await page.waitForTimeout(900);
    const create = page.getByRole("button", { name: /create flarex comp/i }).first();
    if (await create.count().catch(() => 0)) {
      await create.click().catch(() => undefined);
      await page.waitForTimeout(1_200);
    }
    // The button is gone once the comp exists — that, not a sleep, is the confirmation.
    if (await page.getByRole("button", { name: /create flarex comp/i }).first().count().catch(() => 0)) {
      return fail("comp-not-created", `clip ${i}`);
    }
  }

  await page.getByRole("tab", { name: /^edit$/i }).first().click({ timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(1_500);
  return { ok: true, gate: "ok", stopSeconds: stops };
}

/**
 * Add ONE MediaIn bound to the asset-bin tile at `assetIndex`, on a comp that already exists.
 *
 * Split from {@link addAssetSourceMediaIn} rather than folded into it because that helper is written to
 * build the FIRST node (it creates the comp when absent and always takes the first trigger and the first
 * tile). Reusing it in a loop would rebind node #1 eight times and report success each time — a comp
 * with one source, dressed as eight. Here the new node is addressed with `.last()` and the asset with
 * `.nth()`, which are the two things that have to differ per call.
 */
export async function addMediaInBoundTo(page: Page, assetIndex: number): Promise<FixtureStep> {
  await page.getByRole("tab", { name: /flarex/i }).first().click({ timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(900);

  const add = page.locator('[aria-label="Add MediaIn"]').first();
  if (!(await add.count().catch(() => 0))) return step("no-add-mediain-button");
  await add.click().catch(() => undefined);
  await page.waitForTimeout(900);

  const trigger = page.locator(".flarex-source-trigger").last();
  if (!(await trigger.count().catch(() => 0))) return step("no-source-trigger");
  await trigger.click().catch(() => undefined);
  await page.waitForTimeout(700);

  const tile = page.locator(".asset-tile").nth(assetIndex);
  if (!(await tile.count().catch(() => 0))) return step("no-asset-tile", `index ${assetIndex}`);
  await tile.dblclick().catch(() => undefined);
  await page.waitForTimeout(1_200);

  // "Host clip" means the pick did not land: the node exists but declares no asset, so it opens no
  // decoder and contributes nothing to the budget the fixture is trying to exceed.
  const bound = await trigger.getAttribute("title").catch(() => null);
  if (bound == null) return step("bound-title-unreadable");
  if (/host clip/i.test(bound)) return step("unbound-host-clip", bound);
  return step("ok", bound);
}
