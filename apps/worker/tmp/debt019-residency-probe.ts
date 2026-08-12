/**
 * DEBT-019 — is provider residency really a function of clip DURATION?
 *
 * Re-runs the ADR-021 N-rung memory ladder (`pull-memory-probe.ts`, same instrument, same rules:
 * sum of every chrome.exe working set from the OS, FRESH BROWSER PER RUNG, baseline taken in that
 * same browser before the providers exist) over TWO corpora that differ in exactly one axis --
 * 3-second clips vs 120-second clips, otherwise byte-identical recipe -- and over two VARIANTS
 * that split the residency into its terms (see debt019-residency-browser.js).
 *
 * The 3s ladder alone cannot see this debt's defining property. That is the whole reason this file
 * exists next to pull-memory-probe.ts rather than replacing it.
 *
 * Preconditions this probe reports rather than assumes (see the measurement-preconditions rule):
 *   - PIXEL_BROWSER_CHANNEL: SwiftShader is a different machine and races/decoders behave differently
 *   - process hygiene: leftover chrome.exe from earlier runs inflate a working-set sum directly
 *   - build identity: the dev server is serving THIS worktree (assertServingThisWorktree)
 *   - subsystem liveness: providers demuxed via the streaming path and really decoded (never inferred
 *     from the memory number the probe is trying to prove)
 *
 * Run:
 *   PIXEL_BROWSER_CHANNEL=chrome DEBT019_MEDIA_SHORT=<dir> DEBT019_MEDIA_LONG=<dir> \
 *     pnpm --dir apps/worker exec tsx tmp/debt019-residency-probe.ts
 */
import { execSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createReadStream, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { assertServingThisWorktree, getFreePort, startVite, stopProcess, waitForServer } from "./pull-bootstrap.js";
import { assertZeroBrowserFloor, reapAutomationBrowsers } from "../src/browser/browser-preflight.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SHORT_DIR = process.env.DEBT019_MEDIA_SHORT ?? "";
const LONG_DIR = process.env.DEBT019_MEDIA_LONG ?? "";
const LADDER = (process.env.DEBT019_N ?? "1,25,50,100").split(",").map(Number);
const VARIANTS = (process.env.DEBT019_VARIANTS ?? "provider").split(",");
/** Where in each clip to pull frames. Spread across the WHOLE clip so the chunk window pages. */
const PULL_FRACTIONS = (process.env.DEBT019_PULL ?? "0.02,0.35,0.7,0.98").split(",").map(Number);
/** Synthetic per-file size for the opfs-* source-kind variants; matches the 120s corpus (76.8 MB). */
const FILE_BYTES = Number(process.env.DEBT019_FILE_BYTES ?? 76.8 * 1048576);

interface Row {
  corpus: string;
  variant: string;
  n: number;
  baseMB: number;
  heldMB: number;
  deltaMB: number;
  perSrcMB: number;
  jsHeapMB: number;
  note: string;
}

/** Total working set of every chrome.exe, in MB, from the OS. */
function chromeMemoryMB(): number {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq chrome.exe" /FO CSV /NH', { encoding: "utf8" });
    let kb = 0;
    for (const line of out.split(/\r?\n/)) {
      const m = /"([\d.,\s]+) K"\s*$/.exec(line.trim());
      if (m) kb += Number(m[1]!.replace(/[.,\s]/g, ""));
    }
    return kb / 1024;
  } catch {
    return Number.NaN;
  }
}

function processCount(image: string): number {
  try {
    const out = execSync(`tasklist /FI "IMAGENAME eq ${image}" /FO CSV /NH`, { encoding: "utf8" });
    return out.split(/\r?\n/).filter((l) => l.includes(image)).length;
  } catch {
    return -1;
  }
}

/**
 * Reaping now lives in `src/browser/browser-preflight.ts` (promoted there after this probe and the
 * keyer session's pixel-gate failures turned out to be the same root cause on the same day). This
 * ladder reaps between EVERY rung rather than once at startup: a rung that inherits the previous
 * rung's corpses measures a high-water mark, not a residency.
 */
function reapChrome(): void {
  reapAutomationBrowsers();
}

const LAUNCH_ARGS = [
  "--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights",
];

/**
 * Persistent Chrome profile per corpus, so the LOCAL variant's OPFS seed survives across rungs
 * (fresh PROCESS per rung is what the baseline needs; a fresh PROFILE would mean re-seeding 7.7 GB
 * every rung). `--unlimited-storage` only lifts the origin quota — it does not change how the
 * browser accounts for or retains memory, which is what is being measured.
 */
function profileDir(corpusLabel: string): string {
  return path.join(process.env.TEMP ?? here, `debt019-profile-${corpusLabel}`);
}

function startMediaServer(port: number, root: string): Promise<Server> {
  const base = path.resolve(root);
  const server = createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? "/").split("?")[0]!).replace(/^\//, "");
    const file = path.resolve(base, name);
    if (!file.startsWith(base)) return void res.writeHead(403).end();
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      return void res.writeHead(404).end();
    }
    const head: Record<string, string> = {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "video/mp4",
      "Accept-Ranges": "bytes",
    };
    const m = req.headers.range ? /bytes=(\d*)-(\d*)/.exec(req.headers.range) : null;
    if (m) {
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Number(m[2]) : size - 1;
      res.writeHead(206, { ...head, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) });
      createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { ...head, "Content-Length": String(size) });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

async function main() {
  const corpora = [
    { label: "3s", dir: SHORT_DIR },
    { label: "120s", dir: LONG_DIR },
  ].filter((c) => c.dir);
  if (!corpora.length) throw new Error("set DEBT019_MEDIA_SHORT and/or DEBT019_MEDIA_LONG");

  console.log("PRECONDITIONS");
  console.log(`  PIXEL_BROWSER_CHANNEL : ${process.env.PIXEL_BROWSER_CHANNEL ?? "(unset -> chrome default)"}`);
  console.log(`  chrome.exe before run : ${processCount("chrome.exe")}`);
  console.log(`  node.exe before run   : ${processCount("node.exe")}`);
  for (const c of corpora) {
    const files = readdirSync(c.dir).filter((f) => /^src\d+\.mp4$/.test(f));
    const bytes = files.reduce((a, f) => a + statSync(path.join(c.dir, f)).size, 0);
    console.log(`  corpus ${c.label.padEnd(5)}         : ${files.length} files, ${(bytes / 1048576).toFixed(0)} MB total, ${(bytes / files.length / 1048576).toFixed(1)} MB/file`);
  }

  const vitePort = await getFreePort();
  const vite = startVite(vitePort);
  const origin = `http://127.0.0.1:${vitePort}`;
  const browserSrc = readFileSync(path.join(here, "debt019-residency-browser.js"), "utf8");
  const rows: Row[] = [];

  try {
    await waitForServer(origin);
    console.log(`  build identity        : ${await assertServingThisWorktree(origin)}\n`);

    for (const corpus of corpora) {
      const clips = readdirSync(corpus.dir).filter((f) => /^src\d+\.mp4$/.test(f)).sort();
      const mediaPort = await getFreePort();
      const mediaServer = await startMediaServer(mediaPort, corpus.dir);
      const mediaOrigin = `http://127.0.0.1:${mediaPort}`;
      try {
        for (const variant of VARIANTS) {
          for (const n of LADDER) {
            if (n > clips.length) continue;
            // LOCAL variant: seed OPFS in a throwaway browser FIRST, over the same persistent
            // profile the measured browser will use. Seeding must fetch the bytes once, and that
            // transient copy is precisely what this ladder measures — so it cannot happen inside
            // the measured process. The measured browser only reads OPFS.
            if (variant === "local") {
              assertZeroBrowserFloor(`debt019 seed ${corpus.label}/N=${n}`);
              const seeder = await chromium.launchPersistentContext(profileDir(corpus.label), {
                channel: process.env.PIXEL_BROWSER_CHANNEL ?? "chrome",
                args: [...LAUNCH_ARGS, "--unlimited-storage"],
              });
              const seedPage = await seeder.newPage();
              await seedPage.route(`${origin}/__pull_probe`, (r) =>
                r.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>seed</title><body>" })
              );
              await seedPage.goto(`${origin}/__pull_probe`);
              await seedPage.evaluate(
                `(${browserSrc})(${JSON.stringify({ n, variant: "local-seed", mediaOrigin, clips, pullFractions: PULL_FRACTIONS, fileBytes: FILE_BYTES })})`
              );
              await seeder.close();
            }

            assertZeroBrowserFloor(`debt019 ${corpus.label}/${variant}/N=${n}`);
            const context =
              variant === "local"
                ? await chromium.launchPersistentContext(profileDir(corpus.label), {
                    channel: process.env.PIXEL_BROWSER_CHANNEL ?? "chrome",
                    args: [...LAUNCH_ARGS, "--unlimited-storage"],
                  })
                : null;
            const browser = context ?? (await chromium.launch({
              channel: process.env.PIXEL_BROWSER_CHANNEL ?? "chrome",
              args: LAUNCH_ARGS,
            }));
            const page = context ? await context.newPage() : await (browser as import("playwright").Browser).newPage();
            await page.route(`${origin}/__pull_probe`, (r) =>
              r.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>debt019</title><body>" })
            );
            await page.goto(`${origin}/__pull_probe`);
            await page.evaluate("1"); // force the renderer process to exist before baselining
            await new Promise((r) => setTimeout(r, 2500));
            const baseMB = chromeMemoryMB();
            const baseProcs = processCount("chrome.exe");

            const info = (await page.evaluate(
              `(${browserSrc})(${JSON.stringify({ n, variant, mediaOrigin, clips, pullFractions: PULL_FRACTIONS, fileBytes: FILE_BYTES })})`
            )) as { jsHeapMB: number; stats: Record<string, number> };

            await new Promise((r) => setTimeout(r, 2500)); // let allocation settle before sampling
            const heldMB = chromeMemoryMB();
            const s = info.stats;
            const residency =
              s.copiedBytes === undefined
                ? ""
                : ` copied ${(s.copiedBytes / 1048576).toFixed(0)}MB/${s.copiedSources}src` +
                  ` passthru ${(s.passthroughBytes! / 1048576).toFixed(0)}MB/${s.passthroughSources}src`;
            const note = variant.startsWith("opfs")
              ? `fileBytes ${(s.blobBytes! / 1048576).toFixed(0)}MB sliced ${(s.indexSamples! / 1048576).toFixed(0)}MB procs ${baseProcs}`
              : variant === "blob"
                ? `blobBytes ${(s.blobBytes! / 1048576).toFixed(0)}MB procs ${baseProcs}->${processCount("chrome.exe")}`
                : `streaming ${s.streaming} frag ${s.fragmented} getFrame ${s.getFrameCalls} null ${s.nulls} decodes ${s.decodeCalls}${residency}`;
            rows.push({
              corpus: corpus.label,
              variant,
              n,
              baseMB,
              heldMB,
              deltaMB: heldMB - baseMB,
              perSrcMB: (heldMB - baseMB) / Math.max(1, n),
              jsHeapMB: info.jsHeapMB,
              note,
            });
            console.log(
              `  ${corpus.label.padEnd(5)} ${variant.padEnd(8)} N=${String(n).padStart(3)}  ` +
                `base ${baseMB.toFixed(0)}MB -> held ${heldMB.toFixed(0)}MB  (Δ ${(heldMB - baseMB).toFixed(0)}MB, ` +
                `${((heldMB - baseMB) / Math.max(1, n)).toFixed(1)}MB/src)  [${note}]`
            );
            await browser.close();
          }
        }
      } finally {
        mediaServer.close();
      }
    }

    console.log(`\n${"=".repeat(104)}`);
    console.log("DEBT-019 — resident cost of N live sources, by corpus DURATION and residency VARIANT");
    console.log(`${"=".repeat(104)}`);
    console.log("corpus  variant     N   baseline(MB)  held(MB)  delta(MB)  per-source(MB)  JS heap(MB)  liveness");
    console.log("-".repeat(104));
    for (const r of rows) {
      console.log(
        `${r.corpus.padEnd(7)} ${r.variant.padEnd(9)} ${String(r.n).padStart(3)}   ${r.baseMB.toFixed(0).padStart(11)}  ` +
          `${r.heldMB.toFixed(0).padStart(8)}  ${r.deltaMB.toFixed(0).padStart(9)}  ${r.perSrcMB.toFixed(2).padStart(14)}  ` +
          `${r.jsHeapMB.toFixed(1).padStart(11)}  ${r.note}`
      );
    }
    console.log("-".repeat(104));
    for (const variant of VARIANTS) {
      for (const n of LADDER) {
        const a = rows.find((r) => r.corpus === "3s" && r.variant === variant && r.n === n);
        const b = rows.find((r) => r.corpus === "120s" && r.variant === variant && r.n === n);
        if (a && b) {
          console.log(
            `PASS CONDITION  ${variant} N=${n}: per-source 3s ${a.perSrcMB.toFixed(2)}MB vs 120s ${b.perSrcMB.toFixed(2)}MB ` +
              `= ${(b.perSrcMB / Math.max(0.01, a.perSrcMB)).toFixed(2)}x  (duration is 40x; FLAT means ~1x)`
          );
        }
      }
    }
    console.log(`\n  chrome.exe after run  : ${processCount("chrome.exe")}`);
  } finally {
    await stopProcess(vite);
    reapChrome();
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
