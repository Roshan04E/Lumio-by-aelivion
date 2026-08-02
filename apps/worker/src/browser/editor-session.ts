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
