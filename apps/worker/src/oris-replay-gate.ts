/**
 * ORIS Stage A — THE ACCEPTANCE GATE.
 *
 * Stage A is not complete when the editor producer is written. It is complete when a real
 * editing session can be reconstructed **from the Experience Stream alone**. This script is
 * that definition, executable:
 *
 *   drive a scripted session of KNOWN gestures  →  read only the corpus  →  assert the replay
 *
 * The corpus is read from localStorage, deliberately. Reading it through the module's own
 * exported functions would let a bug in the reader hide a bug in the writer; the persisted
 * bytes are what a later analysis would actually have.
 *
 * Run: pnpm --filter @orreris/worker oris:replay      (dev server must be up)
 *   PROBE_EDITOR_URL=<open project url>   (preferred)  or  PROBE_MEDIA=<video file>
 *
 * ── EXPECTED TO FAIL AT STAGE 0 ──────────────────────────────────────────────────────────
 * Written BEFORE the producer exists, so assertions 1, 4 and 6 fail on the first run. That
 * failure is the specification: it names exactly what the producer must make true.
 */
import fs from "node:fs";
import { chromium, type Page } from "playwright";

const BASE = process.env.PROBE_BASE ?? "http://localhost:5173";
const STORAGE_KEY = "orreris.oris.experience.v4";
const PERSIST_SETTLE_MS = 2000; // stream debounce is 750ms; leave margin

// ── The scripted session ─────────────────────────────────────────────────────────────────
// Deterministic and countable. Each entry is one gesture a human would call "a change".
const EXPECTED_COMMITS = 3; // clip drag · parameter drag · AI apply
const EXPECTED_UNDO = 1;
const EXPECTED_REDO = 1;
const EXPECTED_ACTION_ROWS = EXPECTED_COMMITS + EXPECTED_UNDO + EXPECTED_REDO;

/** Signal kinds that are DERIVED (ADR-016 I3) and must therefore never appear stored. */
const DERIVED_SIGNAL_KINDS = ["intent-class-change", "outcome-error", "idle-gap"];

interface Envelope {
  id: string;
  seq: number;
  sessionId: string;
  t: number;
  producer: string;
  kind: string;
  refs: string[];
  signals: { kind: string }[];
  payload: Record<string, unknown>;
}

let failures = 0;
let passes = 0;

function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    passes += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── Harness (reused verbatim from oris-write-grain-probe.ts — proven against this editor) ──

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
    return;
  }
  const media = process.env.PROBE_MEDIA;
  if (!media || !fs.existsSync(media)) {
    console.error("\n❌ Set PROBE_EDITOR_URL to an open project, or PROBE_MEDIA to a video file.\n");
    process.exit(1);
  }
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);
  await page.getByRole("button", { name: /try the demo/i }).first().click().catch(() => undefined);
  await page.waitForTimeout(3500);
  await page.goto(`${BASE}/create`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await page.locator('input[type="file"]').first().setInputFiles(media);
  await page.getByText(/Detected\s+\d+\s*×\s*\d+/i).first().waitFor({ state: "visible", timeout: 120000 });
  await page.getByRole("button", { name: /^continue$/i }).first().click().catch(() => undefined);
  const blank = page.getByRole("button", { name: /blank project/i }).first();
  await blank.waitFor({ state: "visible", timeout: 120000 });
  await blank.click();
  await page.waitForURL(/\/editor\//, { timeout: 180000 });
  await page.goto(withProbe(page.url()), { waitUntil: "domcontentloaded" });
  await settleEditor(page);
}

async function selectAClip(page: Page): Promise<boolean> {
  const clip = page.locator(".timeline-clip").first();
  if ((await clip.count().catch(() => 0)) > 0 && (await clip.isVisible().catch(() => false))) {
    await clip.click().catch(() => undefined);
    await page.waitForTimeout(1200);
    return true;
  }
  return false;
}

async function expandInspector(page: Page) {
  if (await page.evaluate(() => document.querySelector(".is-inspector-collapsed") !== null)) {
    await page.keyboard.press("Alt+Digit4");
    await page.waitForTimeout(1200);
  }
  if (await page.evaluate(() => document.querySelector(".is-inspector-collapsed") !== null)) {
    await page.getByRole("button", { name: /inspector/i }).first().click().catch(() => undefined);
    await page.waitForTimeout(1200);
  }
}

async function dragBy(page: Page, selector: string, dx: number, moves = 20): Promise<boolean> {
  const target = page.locator(selector).first();
  if ((await target.count().catch(() => 0)) === 0) return false;
  const box = await target.boundingBox();
  if (!box) return false;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= moves; i += 1) {
    await page.mouse.move(box.x + box.width / 2 + (dx / moves) * i, box.y + box.height / 2);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
  await page.waitForTimeout(1500);
  return true;
}

// ── The scripted session ─────────────────────────────────────────────────────────────────

async function runSession(page: Page): Promise<{ clip: boolean; param: boolean; ai: boolean }> {
  await selectAClip(page);
  await expandInspector(page);

  const clip = await dragBy(page, ".timeline-clip", 80);
  const param = await dragBy(page, ".number-row-scrubpad", 60);

  // AI apply — plan is PROPOSED then gated by ApprovalBar; the click is what commits.
  let ai = false;
  for (const name of [/ai assistant/i, /^ai$/i, /assistant/i, /chat/i]) {
    const button = page.getByRole("button", { name }).first();
    if ((await button.count().catch(() => 0)) > 0 && (await button.isVisible().catch(() => false))) {
      await button.click().catch(() => undefined);
      await page.waitForTimeout(1500);
      break;
    }
  }
  await selectAClip(page);
  const box = page.locator(".ai-composer-input").first();
  if ((await box.count().catch(() => 0)) > 0) {
    await box.click().catch(() => undefined);
    await box.fill("apply a moody look").catch(() => undefined);
    await page.keyboard.press("Enter");
    const applyButton = page.getByRole("button", { name: /^Apply(\s+\d+)?$/ }).first();
    await applyButton.waitFor({ state: "visible", timeout: 20000 }).catch(() => undefined);
    if ((await applyButton.count().catch(() => 0)) > 0) {
      await applyButton.click().catch(() => undefined);
      ai = true;
    }
    await page.waitForTimeout(6000);
  }

  await page.keyboard.press("Control+z");
  await page.waitForTimeout(1500);
  await page.keyboard.press("Control+Shift+z");
  await page.waitForTimeout(1500);

  await page.waitForTimeout(PERSIST_SETTLE_MS);
  return { clip, param, ai };
}

// ── Read the corpus, and ONLY the corpus ─────────────────────────────────────────────────

async function readCorpus(page: Page): Promise<Envelope[]> {
  const raw = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { events?: Envelope[] };
    return Array.isArray(parsed.events) ? parsed.events : [];
  } catch {
    return [];
  }
}

async function main() {
  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  const browser = await chromium.launch(channel ? { channel } : {});
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  await reachEditor(page);
  console.log(`\nORIS Stage A — replay gate\n   url=${page.url()}`);

  const performed = await runSession(page);
  console.log(`   gestures performed: clip=${performed.clip} param=${performed.param} ai=${performed.ai}`);

  const events = await readCorpus(page);

  // ── 7. PROOF OF LIFE (ADR-016 I13) ────────────────────────────────────────────────────
  // An empty corpus and a corpus this script failed to read are the same output. Refuse to
  // grade a replay we cannot prove we loaded — reporting "0 rows" as a finding would be the
  // instrument describing its own silence as a property of the system.
  if (events.length === 0) {
    console.error(
      `\n❌ no corpus at localStorage["${STORAGE_KEY}"].\n` +
        `   Either nothing was written, or this gate could not read it. Those are different\n` +
        `   failures and this script refuses to guess between them.\n`
    );
    await browser.close();
    process.exit(1);
  }
  if (!performed.clip || !performed.param) {
    console.error(`\n❌ the scripted session did not run (clip=${performed.clip} param=${performed.param}).\n`);
    await browser.close();
    process.exit(1);
  }

  const actions = events.filter((e) => e.kind === "action");
  const sessions = events.filter((e) => e.kind === "session");
  const commits = actions.filter((e) => e.payload.operation === "commit");
  const undos = actions.filter((e) => e.payload.operation === "undo");
  const redos = actions.filter((e) => e.payload.operation === "redo");

  console.log(`\n   corpus: ${events.length} rows · ${actions.length} action · ${sessions.length} session\n`);
  console.log("replay assertions");

  // 1 — completeness
  check(
    `1. every gesture produced exactly one action row (${EXPECTED_ACTION_ROWS} expected)`,
    actions.length === EXPECTED_ACTION_ROWS,
    `got ${actions.length}: ${commits.length} commit · ${undos.length} undo · ${redos.length} redo`
  );

  // 2 — ordering (ADR-016 I5: seq is the authority, never the clock)
  const seqs = events.map((e) => e.seq);
  const monotonic = seqs.every((s, i) => i === 0 || s > seqs[i - 1]!);
  const dense = seqs.length === 0 || seqs[seqs.length - 1]! - seqs[0]! === seqs.length - 1;
  check("2. seq is strictly increasing", monotonic);
  check("2b. seq is dense — no unexplained gap", dense, `${seqs[0]}..${seqs[seqs.length - 1]} over ${seqs.length} rows`);

  // 3 — provenance (E8/E9)
  const ids = new Set(events.map((e) => e.id));
  const dangling = events.flatMap((e) => e.refs.filter((r) => !ids.has(r)));
  check("3. every ref resolves inside the corpus", dangling.length === 0, `${dangling.length} dangling`);

  // 4 — AI identification (U7). NOT vacuous: requires at least one declared row to exist.
  const aiRows = actions.filter((e) => e.payload.initiator === "ai");
  check("4. at least one action row declares initiator=ai", aiRows.length > 0, `${aiRows.length} found`);
  check(
    "4b. every ai row carries non-empty actionIds",
    aiRows.length > 0 && aiRows.every((e) => Array.isArray(e.payload.actionIds) && (e.payload.actionIds as unknown[]).length > 0),
    JSON.stringify(aiRows.map((e) => e.payload.actionIds))
  );

  // 5 — no derivation on an evidence row (I3/I4)
  const derived = events.flatMap((e) => e.signals.filter((s) => DERIVED_SIGNAL_KINDS.includes(s.kind)));
  check("5. no derived signal is stored as evidence", derived.length === 0, `${derived.length} found`);

  // 6 — coverage (U8/I12)
  const withCoverage = sessions.filter((e) => Array.isArray(e.payload.coverage) && (e.payload.coverage as unknown[]).length > 0);
  check("6. the session row records declaration coverage", withCoverage.length > 0);
  // `.every()` on an empty array is `true`, so this needs the existence clause or it reports
  // green while nothing has coverage at all — the vacuous pass ADR-016 I13 exists to forbid.
  check(
    "6b. coverage names its policy version",
    withCoverage.length > 0 && withCoverage.every((e) => typeof e.payload.coveragePolicy === "string")
  );

  // 6c — WHICH BODY observed this (ORIS_SELF.md §6). Verified rather than assumed: U12 exists
  // because wiring that typechecks is not wiring that works.
  const builds = sessions.map((e) => e.payload.buildId);
  check(
    "6c. the session records a real build id, not \"unknown\"",
    sessions.length > 0 && builds.every((b) => typeof b === "string" && b !== "unknown"),
    JSON.stringify(builds)
  );

  // Secondary — runtime counters, NOT part of the replay (they are not in the corpus).
  const stats = await page.evaluate(() => {
    const w = window as unknown as { __orisWriteProbe?: unknown };
    return { probe: Boolean(w.__orisWriteProbe) };
  });
  console.log(`\n   (secondary, not part of the replay) write-probe present: ${stats.probe} · page errors: ${pageErrors.length}`);

  console.log(
    failures === 0
      ? `\n✅ replay gate GREEN — ${passes} assertions. The session reconstructs from the corpus alone.\n`
      : `\n❌ replay gate RED — ${failures} of ${failures + passes} assertions failed.\n`
  );
  await browser.close();
  process.exit(failures === 0 ? 0 : 1);
}

// Loud-exit guard (ADR-016 I13): if the event loop drains before main() reaches its explicit
// exit, node would exit 0 having verified nothing.
process.exitCode = 1;

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
