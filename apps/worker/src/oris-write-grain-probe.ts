/**
 * ORIS Q5 — what does the editor actually COMMIT, and at what grain?
 *
 * `plans/oris-outcome-seam-design.md` Q5 is the last open question before ADR-017, and it is
 * the one most likely to force a trade-off between provenance and practicality (pre-registered
 * pressure point #1, ORIS_RESEARCH_PROGRAMME.md §11.4). It is an empirical question, so this
 * measures it instead of arguing it.
 *
 * It drives the real editor through the real product flow and performs real gestures — a slider
 * drag, a scrub, repeated adjustments, an undo/redo cycle — then reads the graph-write probe
 * (`?orisWriteProbe=1`, apps/web/src/editor/oris-write-probe.ts).
 *
 * The question each gesture answers:
 *   drag    → one write per pointer-move, or one per gesture?  (does coalescing already exist)
 *   scrub   → does moving the playhead mutate the graph at all? (is transport a mutation)
 *   repeat  → do N discrete edits produce N undo entries?       (is the grain a human "change")
 *   undo    → does undo/redo itself write?                      (does it need its own row)
 *
 * Run: pnpm --filter @orreris/worker exec tsx src/oris-write-grain-probe.ts
 *   PROBE_EDITOR_URL=<open project url>   (preferred)  or  PROBE_MEDIA=<video file>
 */
import assert from "node:assert";
import fs from "node:fs";
import { chromium, type Page } from "playwright";

const BASE = process.env.PROBE_BASE ?? "http://localhost:5173";

interface GraphWriteSample {
  at: number;
  changed: boolean;
  undoDepth: number;
  recordsHistory: boolean;
  initiator: "ai" | "user" | null;
  actionIds: string[] | null;
}

function withProbe(url: string): string {
  return url.includes("?") ? `${url}&orisWriteProbe=1` : `${url}?orisWriteProbe=1`;
}

async function settleEditor(page: Page) {
  await page.waitForFunction(() => "__rfClock" in window, undefined, { timeout: 120000 });
  await page.waitForTimeout(3000);
}

async function reachEditor(page: Page) {
  const direct = process.env.PROBE_EDITOR_URL;
  if (direct) {
    if (!process.env.PROBE_AUTH_TOKEN) {
      await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1200);
      await page.fill('input[type="email"]', process.env.PROBE_AUTH_EMAIL ?? "demo@pesamee.studio");
      await page.fill('input[type="password"]', process.env.PROBE_AUTH_PASSWORD ?? "password123");
      await page.getByRole("button", { name: /^sign in$/i }).first().click().catch(() => undefined);
      await page.waitForTimeout(3000);
    }
    await page.goto(withProbe(direct), { waitUntil: "domcontentloaded" });
    await settleEditor(page);
    assert.ok(!/\/login/.test(page.url()), `Not signed in — ${direct} redirected to ${page.url()}`);
    return;
  }

  const media = process.env.PROBE_MEDIA;
  assert.ok(media && fs.existsSync(media), "Set PROBE_EDITOR_URL to an open project, or PROBE_MEDIA to a video file.");

  // "Try the demo" provisions a fresh account; the documented demo login is not seeded in every
  // dev database, and a 401 here reads as a mysterious mount failure 30s later.
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);
  await page.getByRole("button", { name: /try the demo/i }).first().click().catch(() => undefined);
  await page.waitForTimeout(3500);

  await page.goto(`${BASE}/create`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await page.locator('input[type="file"]').first().setInputFiles(media!);
  await page.getByText(/Detected\s+\d+\s*×\s*\d+/i).first().waitFor({ state: "visible", timeout: 120000 });
  await page.getByRole("button", { name: /^continue$/i }).first().click().catch(() => undefined);
  const blank = page.getByRole("button", { name: /blank project/i }).first();
  await blank.waitFor({ state: "visible", timeout: 120000 });
  await blank.click();
  await page.waitForURL(/\/editor\//, { timeout: 180000 });
  // The project URL was reached WITHOUT the probe flag (the app navigated), so reload with it.
  await page.goto(withProbe(page.url()), { waitUntil: "domcontentloaded" });
  await settleEditor(page);
}

async function probeReady(page: Page): Promise<boolean> {
  return page.evaluate(() => "__orisWriteProbe" in window);
}

async function reset(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { __orisWriteProbe: { reset: () => void } }).__orisWriteProbe.reset();
  });
}

async function read(page: Page): Promise<GraphWriteSample[]> {
  return page.evaluate(
    () => (window as unknown as { __orisWriteProbe: { samples: () => GraphWriteSample[] } }).__orisWriteProbe.samples()
  );
}

function report(label: string, samples: GraphWriteSample[], question: string) {
  const changed = samples.filter((s) => s.changed);
  const historic = samples.filter((s) => s.recordsHistory);
  const depths = samples.map((s) => s.undoDepth);
  const undoGrowth = depths.length > 0 ? Math.max(...depths) - Math.min(...depths) : 0;
  const gaps = changed.slice(1).map((s, i) => s.at - changed[i]!.at);
  const medianGap = gaps.length > 0 ? gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)]! : 0;
  console.log(`\n── ${label} ─────────────────────────────────────────`);
  console.log(`   ${question}`);
  console.log(`   graph writes:        ${samples.length}   (changed ${changed.length} · history-recording ${historic.length} · suppressed ${samples.length - historic.length})`);
  console.log(`   undo entries added:  ${undoGrowth}`);
  console.log(`   median gap between writes: ${medianGap}ms`);
  const declared = samples.reduce<Record<string, number>>((acc, s) => {
    const key = s.initiator ?? "undeclared";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`   initiator declared:  ${JSON.stringify(declared)}`);
}

/** The inspector only renders controls for a SELECTED layer — no selection, no sliders. */
async function selectAClip(page: Page): Promise<boolean> {
  for (const selector of [".timeline-clip", "[data-clip-id]", ".timeline-track .clip", ".editor-timeline-dock [role='button']"]) {
    const clip = page.locator(selector).first();
    if ((await clip.count().catch(() => 0)) > 0 && (await clip.isVisible().catch(() => false))) {
      await clip.click().catch(() => undefined);
      await page.waitForTimeout(1500);
      return true;
    }
  }
  return false;
}

async function main() {
  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  const browser = await chromium.launch(channel ? { channel } : {});
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await reachEditor(page);

  // PROOF OF LIFE (ADR-016 I13). If the probe never installed, every count below is 0 and the
  // run would read as "no writes happen" — a measurement that reports the instrument's absence
  // as a property of the system. Refuse to print numbers we cannot attribute.
  assert.ok(
    await probeReady(page),
    "window.__orisWriteProbe is missing — the probe flag did not take effect, so every count " +
      "below would be 0 for the wrong reason. Reporting them would be false confidence."
  );
  console.log(`\nORIS Q5 — write-grain probe\n   url=${page.url()}`);

  // ── 1. Slider drag ────────────────────────────────────────────────────────────────────
  // NumberControl's pointer-move handler calls onChange per move. The question is whether that
  // reaches the graph choke point per move, or is absorbed before it.
  const selected = await selectAClip(page);
  console.log(`   clip selected: ${selected}`);

  // The inspector starts COLLAPSED (`useState(true)`), so a fresh project renders no controls
  // at all — which read as "no parameter control exists" for three runs. Alt+4 is the app's own
  // toggle; the button is used as a fallback because a keyboard shortcut can be swallowed by
  // whatever holds focus.
  if (await page.evaluate(() => document.querySelector(".is-inspector-collapsed") !== null)) {
    await page.keyboard.press("Alt+Digit4");
    await page.waitForTimeout(1200);
  }
  if (await page.evaluate(() => document.querySelector(".is-inspector-collapsed") !== null)) {
    await page.getByRole("button", { name: /inspector/i }).first().click().catch(() => undefined);
    await page.waitForTimeout(1200);
  }
  console.log(
    `   inspector expanded: ${await page.evaluate(() => document.querySelector(".is-inspector-collapsed") === null)}`
  );

  // Diagnose BEFORE driving: 0 controls previously, and "not present" is not a measurement.
  const diag = await page.evaluate(() => ({
    tablists: document.querySelectorAll(".inspector-tabs").length,
    tabs: Array.from(document.querySelectorAll('.inspector-tabs [role="tab"]')).map((t) => t.textContent?.trim() ?? ""),
    scrubpads: document.querySelectorAll(".number-row-scrubpad").length,
    ranges: document.querySelectorAll('input[type="range"]').length,
    numberRows: document.querySelectorAll(".number-row").length,
    inspector: document.querySelectorAll(".inspector, .editor-inspector, [class*='inspector']").length,
    // Why is it empty — nothing selected, or collapsed? The DOM answers directly.
    inspectorClass: (document.querySelector("[class*='inspector']") as HTMLElement | null)?.className ?? "",
    inspectorText: ((document.querySelector("[class*='inspector']") as HTMLElement | null)?.innerText ?? "").slice(0, 220),
    selectedClips: document.querySelectorAll(".timeline-clip.is-selected, .timeline-clip[aria-selected='true'], .timeline-clip.selected").length,
    clipClass: (document.querySelector(".timeline-clip") as HTMLElement | null)?.className ?? ""
  }));
  console.log(`   inspector: ${JSON.stringify(diag)}`);

  // Walk every inspector tab; the Video tab carries transform NumberControls, Effects carries
  // effect params. Stop at the first tab that actually renders a draggable control.
  for (const tabName of diag.tabs) {
    if (diag.scrubpads > 0 || diag.ranges > 0) {
      break;
    }
    await page.locator('.inspector-tabs [role="tab"]', { hasText: tabName }).first().click().catch(() => undefined);
    await page.waitForTimeout(1200);
    const after = await page.evaluate(() => ({
      scrubpads: document.querySelectorAll(".number-row-scrubpad").length,
      ranges: document.querySelectorAll('input[type="range"]').length
    }));
    console.log(`   tab "${tabName}" → ${after.scrubpads} scrubpad(s) · ${after.ranges} range input(s)`);
    if (after.scrubpads > 0 || after.ranges > 0) {
      break;
    }
  }

  // ── Parameter drag ────────────────────────────────────────────────────────────────────
  // The DIFFERENT code path from a clip drag, and the one the design doc's pressure point #1
  // is actually about: NumberControl fires onChange per pointer-move. Generalising the clip
  // drag's coalescing to this path without measuring it would be exactly the assumption this
  // whole pass exists to avoid.
  for (const [name, selector] of [["scrubpad", ".number-row-scrubpad"], ["range slider", 'input[type="range"]']] as const) {
    const control = page.locator(selector).first();
    if ((await control.count().catch(() => 0)) === 0) {
      console.log(`\n── parameter drag (${name}) ── SKIPPED: not present`);
      continue;
    }
    const box = await control.boundingBox();
    if (!box) {
      continue;
    }
    await reset(page);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 20; i += 1) {
      await page.mouse.move(box.x + box.width / 2 + i * 3, box.y + box.height / 2);
      await page.waitForTimeout(16);
    }
    await page.mouse.up();
    await page.waitForTimeout(1500);
    report(`parameter drag — ${name} (20 pointer-moves)`, await read(page), "does the PARAMETER path coalesce like the clip path?");
  }

  // A clip drag is the highest-frequency real editing gesture and tests exactly what the
  // slider would: does a continuous pointer gesture write per move, or once on commit?
  const clip = page.locator(".timeline-clip").first();
  if ((await clip.count().catch(() => 0)) > 0) {
    const box = await clip.boundingBox();
    if (box) {
      await reset(page);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      for (let i = 1; i <= 20; i += 1) {
        await page.mouse.move(box.x + box.width / 2 + i * 4, box.y + box.height / 2);
        await page.waitForTimeout(16); // ~60fps, a real drag cadence
      }
      await page.mouse.up();
      await page.waitForTimeout(1500);
      report("clip drag (20 pointer-moves)", await read(page), "per-move writes, or one per gesture?");
    }
  } else {
    console.log("\n── clip drag ── SKIPPED: no .timeline-clip found");
  }

  // ── 2. Scrub ──────────────────────────────────────────────────────────────────────────
  const ruler = page.locator(".editor-timeline-dock .timeline-ruler, .timeline-ruler").first();
  if ((await ruler.count().catch(() => 0)) > 0) {
    const box = await ruler.boundingBox();
    if (box) {
      await reset(page);
      await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
      await page.mouse.down();
      for (let i = 0; i <= 20; i += 1) {
        await page.mouse.move(box.x + box.width * (0.2 + 0.03 * i), box.y + box.height / 2);
        await page.waitForTimeout(16);
      }
      await page.mouse.up();
      await page.waitForTimeout(1200);
      report("playhead scrub (21 pointer-moves)", await read(page), "does transport mutate the graph at all?");
    }
  } else {
    console.log("\n── scrub ── SKIPPED: no timeline ruler found");
  }

  // ── 3. Undo / redo ────────────────────────────────────────────────────────────────────
  await reset(page);
  for (let i = 0; i < 3; i += 1) {
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(400);
  }
  for (let i = 0; i < 3; i += 1) {
    await page.keyboard.press("Control+Shift+z");
    await page.waitForTimeout(400);
  }
  await page.waitForTimeout(800);
  report("3× undo + 3× redo", await read(page), "does undo/redo write, and would it be visible to a producer?");

  // ── 4. AI commit — the POSITIVE case for the declaration seam ─────────────────────────
  // Absence was already measured; PRESENCE was not, and a probe that only confirms absence
  // proves nothing about presence (ADR-016 I13, turned on this instrument). The zero-token
  // local tiers apply looks without a network call, so this should commit through
  // commitComposition → updateComposition carrying the intent.
  await reset(page);
  let aiOpened = false;
  for (const name of [/ai assistant/i, /^ai$/i, /assistant/i, /chat/i]) {
    const button = page.getByRole("button", { name }).first();
    if ((await button.count().catch(() => 0)) > 0 && (await button.isVisible().catch(() => false))) {
      await button.click().catch(() => undefined);
      await page.waitForTimeout(1500);
      aiOpened = true;
      break;
    }
  }
  // The router needs a SELECTION to resolve a look onto a target (router-eval: "apply a moody
  // look" with selection → Noir @ 55). Re-select, because the undo/redo cycle above may have
  // disturbed it.
  await selectAClip(page);

  const box = page.locator(".ai-composer-input").first();
  let asked = false;
  let approved = false;
  if (aiOpened && (await box.count().catch(() => 0)) > 0) {
    await box.click().catch(() => undefined);
    await box.fill("apply a moody look").catch(() => undefined);
    await page.keyboard.press("Enter");
    asked = true;
    // The plan is PROPOSED, not applied: `ApprovalBar` gates it. Zero graph writes on the
    // previous run meant the plan was sitting there waiting for a click, which the probe read
    // as "the AI never commits" — an instrument reporting its own inaction as a system property
    // for the fifth time today.
    const applyButton = page.getByRole("button", { name: /^Apply(\s+\d+)?$/ }).first();
    await applyButton.waitFor({ state: "visible", timeout: 20000 }).catch(() => undefined);
    if ((await applyButton.count().catch(() => 0)) > 0) {
      await applyButton.click().catch(() => undefined);
      approved = true;
    }
    await page.waitForTimeout(6000);
  }
  console.log(`   approval bar clicked: ${approved}`);
  const aiSamples = await read(page);
  const declaredAi = aiSamples.filter((s) => s.initiator === "ai");
  console.log(`\n── AI commit (panel opened: ${aiOpened} · prompt sent: ${asked}) ─────────────`);
  console.log(`   graph writes: ${aiSamples.length} · declared ai: ${declaredAi.length}`);
  console.log(`   actionIds seen: ${JSON.stringify(declaredAi.map((s) => s.actionIds).filter(Boolean))}`);
  if (asked && aiSamples.length > 0 && declaredAi.length === 0) {
    console.log("   ❌ the AI committed but did NOT declare — the seam is not wired end to end");
  } else if (declaredAi.length > 0) {
    console.log("   ✅ AI commits declare initiator=ai at the choke point");
  } else {
    console.log("   ⚠️  INCONCLUSIVE — no AI commit occurred, so presence remains unverified");
  }

  console.log(`\n   page errors: ${errors.length}`);
  if (errors.length > 0) {
    console.log(errors.slice(0, 4).map((e) => `     [err] ${e}`).join("\n"));
  }
  console.log("");
  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
