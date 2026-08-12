/**
 * DEBT-014 — the ONE reading the entry names and nobody has taken.
 *
 * THE QUESTION, and why it is worth a probe. DEBT-014 records Host C's host clip routed to `element`
 * in 6 of 6 runs, and asks whether that is an admission DENIAL (in which case it is an instance of
 * DEBT-013 and the two entries should be merged) or an acquisition-ORDERING/attach defect (in which
 * case they are separate). The entry's own discriminator:
 *
 *   capMisses 0 with the host on `element`  ⇒ nothing refused it ⇒ ordering/attach ⇒ entries separate
 *   capMisses > 0 at that moment            ⇒ the host was genuinely denied ⇒ merge into DEBT-013
 *
 * WHAT THIS FIXES ABOUT THE ORIGINAL MEASUREMENT. The entry's evidence is void for three recorded
 * reasons, and this probe addresses all three or reports that it cannot:
 *   1. Blocker 1 — the original probe pressed play before WebCodecs routing engaged, so every mount
 *      claim was made about a subsystem that had not started. Here `awaitWebCodecsEngaged` gates the
 *      run and a VOID is reported rather than a number if it never engages.
 *   2. Blocker 2 — run-to-run routing instability (~19x) was averaged over. Here every arm is printed
 *      as its own row and the verdict is only taken where the arms AGREE; disagreement is the result.
 *   3. Staleness — the artifacts are gone and the evidence predates `ac0d9f2`, which changes exactly
 *      the competition the entry describes. So this is a FRESH measurement and is reported as one; no
 *      number here is compared against the recorded 6/6.
 *
 * THE FIXTURE IS TWO DECODE CONSUMERS ON DISTINCT FILES, which is Host C's regime and is not
 * negotiable: a MediaIn bound to the HOST's own asset is one file through two doors, which shares a
 * single session and can never be denied — a fixture in which the answer is fixed in advance.
 *
 * Run:  PIXEL_BROWSER_CHANNEL=chrome pnpm --dir apps/worker exec tsx tmp/debt014-host-routing-probe.ts
 */
import path from "node:path";
import fs from "node:fs";
import { chromium, type Page } from "playwright";
import { getFreePort, startVite, stopProcess, waitForServer, assertServingThisWorktree } from "./pull-bootstrap.js";
import { assertQuietBrowserMachine, assertZeroBrowserFloor } from "../src/browser/browser-preflight.js";

const ARMS = Number(process.env.DEBT014_ARMS ?? 3);
const SAMPLE_MS = 250;
/** Kept inside the seed clip's own duration — sampling past the material measures a stopped transport. */
const PAUSED_WINDOW_MS = 12_000;
const PLAYING_WINDOW_MS = 12_000;

interface Census {
  capMisses: number;
  admissionDenials: number;
  starved: number;
  active: number;
  activeSoftware: number;
  created: number;
}

interface Sample {
  atMs: number;
  phase: "paused" | "playing";
  host: string | null;
  loaders: string[];
  census: Census;
  /** Playhead seconds. Pressing Space is not evidence that the transport moved — see `runArm`. */
  clock: number;
}

interface ArmResult {
  arm: number;
  void?: string;
  hostLabel?: string;
  loaderLabel?: string;
  engaged?: boolean;
  /** The reading: census at the FIRST sample where the host reads `element` with a loader present. */
  atHostElement?: Sample | null;
  finalPaused?: Sample | null;
  finalPlaying?: Sample | null;
  hostModes?: string[];
}

/** The two decode consumers must be DIFFERENT files — see the fixture note in the header. */
function seedPair(): { host: string; second: string } {
  const dir = path.join(process.cwd(), "../../apps/api/storage/finals");
  const root = fs.existsSync(dir) ? dir : path.resolve("apps/api/storage/finals");
  const files = fs
    .readdirSync(root)
    .filter((n) => n.endsWith(".mp4"))
    .map((n) => ({ file: path.join(root, n), size: fs.statSync(path.join(root, n)).size }))
    .sort((a, b) => a.size - b.size);
  if (files.length < 2) throw new Error("need at least two .mp4 seeds in apps/api/storage/finals");
  return { host: files[0]!.file, second: files[1]!.file };
}

async function sample(page: Page, phase: "paused" | "playing", t0: number): Promise<Sample> {
  return await page.evaluate(
    ({ phase, t0 }) => {
      const w = globalThis as unknown as {
        __rfSourceMap?: Record<string, { asset?: string; decode?: string }>;
        __rfWcPool?: Record<string, unknown>;
        __rfClock?: { committed?: number };
      };
      const map = w.__rfSourceMap ?? {};
      const pool = (w.__rfWcPool ?? {}) as Record<string, number | unknown[]>;
      let host: string | null = null;
      const loaders: string[] = [];
      for (const [id, row] of Object.entries(map)) {
        const mode = row?.decode ?? "-";
        // The product's own identity for a Flarex loader (`VIRTUAL_PREFIX`), so "which one is the
        // host" is not a guess about url shapes.
        if (id.startsWith("flarexsrc:")) loaders.push(`${row?.asset ?? "?"}=${mode}`);
        else host = String(mode);
      }
      // NO inner named functions in here: tsx compiles with `keepNames`, which wraps any
      // function-valued const in a `__name()` helper that does not exist in the page — the whole
      // evaluate then throws `__name is not defined` and every arm reports VOID (measured, first run).
      return {
        atMs: Math.round(performance.now() - t0),
        phase,
        host,
        loaders,
        clock: typeof w.__rfClock?.committed === "number" ? w.__rfClock.committed : -1,
        census: {
          capMisses: typeof pool.capMisses === "number" ? pool.capMisses : -1,
          admissionDenials: typeof pool.admissionDenials === "number" ? pool.admissionDenials : -1,
          starved: Array.isArray(pool.starvedKeys) ? (pool.starvedKeys as unknown[]).length : -1,
          active: typeof pool.active === "number" ? pool.active : -1,
          activeSoftware: typeof pool.activeSoftware === "number" ? pool.activeSoftware : -1,
          created: typeof pool.created === "number" ? pool.created : -1,
        },
      };
    },
    { phase, t0 }
  );
}

async function runArm(arm: number, origin: string, seeds: { host: string; second: string }): Promise<ArmResult> {
  assertZeroBrowserFloor(`debt014 arm ${arm}`);
  process.env.PROBE_BASE = origin;
  // Imported AFTER PROBE_BASE is set: `EDITOR_BASE` is a module-level const, so a static import at the
  // top of this file would capture localhost:5173 and drive a server this probe does not own.
  const { reachEditor, importAssets, addMediaInBoundTo, awaitWebCodecsEngaged } = await import("../src/browser/editor-session.js");
  const browser = await chromium.launch({ channel: process.env.PIXEL_BROWSER_CHANNEL ?? "chrome" });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
    await reachEditor(page, { clipPath: seeds.host, flags: "wcDecode=1", settleMs: 6_000 });
    const tiles = await importAssets(page, [seeds.second]);
    if (tiles < 2) return { arm, void: `asset bin has ${tiles} tiles — the second file did not import` };

    // Create the comp on the host clip, then bind ONE MediaIn to the SECOND asset.
    const clip = page.locator(".timeline-clip").first();
    if (!(await clip.count().catch(() => 0))) return { arm, void: "no timeline clip" };
    await clip.click().catch(() => undefined);
    await page.waitForTimeout(500);
    await page.getByRole("tab", { name: /flarex/i }).first().click({ timeout: 10_000 }).catch(() => undefined);
    await page.waitForTimeout(1_200);
    const create = page.getByRole("button", { name: /create flarex comp/i }).first();
    if (await create.count().catch(() => 0)) {
      await create.click().catch(() => undefined);
      await page.waitForTimeout(2_500);
    }
    // The tile INDEX is not the import order — pick the tile by name. Binding blind to index 1 bound
    // the MediaIn to the HOST's own asset on the first run of this probe, producing exactly the
    // one-file-two-doors share the header rules out, with a clean-looking 3/3 result.
    const secondName = path.basename(seeds.second);
    const tileTitles = await page.$$eval(".asset-tile", (els) =>
      els.map((el) => (el.getAttribute("title") ?? el.textContent ?? "").trim())
    );
    const tileIndex = tileTitles.findIndex((t) => t.includes(secondName) || t.includes(secondName.slice(0, 28)));
    if (tileIndex < 0) return { arm, void: `second seed not in the asset bin: ${JSON.stringify(tileTitles).slice(0, 300)}` };
    const bound = await addMediaInBoundTo(page, tileIndex);
    if (!bound.ok) return { arm, void: `MediaIn not bound: ${bound.gate}${bound.detail ? ` (${bound.detail})` : ""}` };
    await page.getByRole("tab", { name: /^edit$/i }).first().click({ timeout: 10_000 }).catch(() => undefined);
    await page.waitForTimeout(2_500);

    // BLOCKER 1. Everything below is void without this — a source is element-routed until its ingest
    // proxy lands, so a run that samples on arrival measures a subsystem that never started.
    const engaged = await awaitWebCodecsEngaged(page, 90_000);
    if (!engaged) return { arm, void: "WebCodecs never engaged (blocker 1) — no routing claim is sound", engaged };

    const t0 = Date.now();
    const samples: Sample[] = [];
    const collect = async (phase: "paused" | "playing", windowMs: number) => {
      const until = Date.now() + windowMs;
      while (Date.now() < until) {
        samples.push(await sample(page, phase, t0));
        await page.waitForTimeout(SAMPLE_MS);
      }
    };
    await collect("paused", PAUSED_WINDOW_MS);
    await page.keyboard.press("Space").catch(() => undefined);
    await collect("playing", PLAYING_WINDOW_MS);
    await page.keyboard.press("Space").catch(() => undefined);

    const withLoader = samples.filter((s) => s.loaders.length > 0);
    // FIXTURE PRECONDITION, checked on the measurement itself rather than trusted from the setup: a
    // loader on the host's own file is one session behind two doors, and a share can never be denied.
    // Asserted here so the fixture failing produces a VOID, not a confident "does not reproduce".
    const hostBase = path.basename(seeds.host);
    if (withLoader.some((s) => s.loaders.some((l) => l.startsWith(hostBase)))) {
      return { arm, void: `loader bound to the HOST's own asset (${hostBase}) — a share, not a contention` };
    }
    if (!withLoader.length) return { arm, void: "no Flarex loader ever appeared in __rfSourceMap" };
    const atHostElement = withLoader.find((s) => s.host === "element") ?? null;
    const paused = samples.filter((s) => s.phase === "paused");
    const playing = samples.filter((s) => s.phase === "playing");
    // Pressing Space is an INPUT, not a result. A keypress that lands on the wrong element (or on a
    // focused control) leaves the transport parked, and the "playing" window is then a second paused
    // window wearing a label — which is precisely the class of void this entry's blocker 1 already is.
    const advanced = (playing[playing.length - 1]?.clock ?? -1) - (playing[0]?.clock ?? 0);
    if (!(advanced > 0.5)) {
      return { arm, void: `transport never advanced during the playing window (${advanced.toFixed(2)}s) — that half is unmeasured` };
    }
    return {
      arm,
      engaged,
      hostLabel: `(timeline layer) playhead advanced ${advanced.toFixed(1)}s under play`,
      loaderLabel: withLoader[0]?.loaders.join(",") ?? "(none seen)",
      atHostElement,
      finalPaused: paused[paused.length - 1] ?? null,
      finalPlaying: playing[playing.length - 1] ?? null,
      hostModes: [...new Set(samples.map((s) => String(s.host)))],
    };
  } finally {
    await browser.close();
  }
}

async function main() {
  assertQuietBrowserMachine({ label: "debt014-host-routing", scriptMarker: "debt014-host-routing-probe" });
  const seeds = seedPair();
  const port = await getFreePort();
  const vite = startVite(port);
  const origin = `http://127.0.0.1:${port}`;
  const results: ArmResult[] = [];
  try {
    await waitForServer(origin);
    console.log("PRECONDITIONS");
    console.log(`  PIXEL_BROWSER_CHANNEL : ${process.env.PIXEL_BROWSER_CHANNEL ?? "(unset -> chrome default)"}`);
    console.log(`  build identity        : ${await assertServingThisWorktree(origin)}`);
    console.log(`  host seed             : ${path.basename(seeds.host)}`);
    console.log(`  MediaIn seed          : ${path.basename(seeds.second)} (distinct file — see header)\n`);
    for (let arm = 1; arm <= ARMS; arm += 1) {
      const result = await runArm(arm, origin, seeds).catch((e) => ({ arm, void: `threw: ${String(e).slice(0, 200)}` }) as ArmResult);
      results.push(result);
      const line = (s: Sample | null | undefined, tag: string) =>
        s
          ? `    ${tag.padEnd(14)} host=${String(s.host).padEnd(8)} loaders=[${s.loaders.join(", ")}] ` +
            `capMisses=${s.census.capMisses} denials=${s.census.admissionDenials} starved=${s.census.starved} ` +
            `active=${s.census.active}/sw${s.census.activeSoftware} created=${s.census.created}`
          : `    ${tag.padEnd(14)} —`;
      console.log(`ARM ${arm}${result.void ? `  VOID: ${result.void}` : ""}`);
      if (!result.void) {
        console.log(`    host modes seen: ${result.hostModes?.join(" ")}  ${result.hostLabel}`);
        console.log(line(result.atHostElement, "@host=element"));
        console.log(line(result.finalPaused, "final paused"));
        console.log(line(result.finalPlaying, "final playing"));
      }
      console.log("");
    }
  } finally {
    await stopProcess(vite);
  }

  const usable = results.filter((r) => !r.void);
  console.log("VERDICT");
  console.log(`  usable arms: ${usable.length}/${results.length}`);
  const landed = usable.filter((r) => r.atHostElement);
  console.log(`  host reached 'element' with a loader present: ${landed.length}/${usable.length} arms`);
  if (landed.length) {
    const misses = landed.map((r) => r.atHostElement!.census.capMisses);
    console.log(`  capMisses at that instant, per arm: ${misses.join(", ")}`);
    console.log(
      misses.every((m) => m === 0)
        ? "  ⇒ nothing refused the host: ORDERING/ATTACH, not admission. DEBT-013 and DEBT-014 stay separate."
        : misses.every((m) => m > 0)
          ? "  ⇒ the host was genuinely denied: this collapses into DEBT-013 and should be MERGED."
          : "  ⇒ arms DISAGREE — blocker 2 (routing instability) is still live; no verdict."
    );
  } else if (usable.length) {
    console.log("  ⇒ the host never landed on 'element' in any usable arm: the entry's finding does not");
    console.log("    reproduce on this fixture after ac0d9f2. Not the same as 'fixed' — see the entry.");
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
