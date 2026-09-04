/**
 * DEBT-034 — WHY DO LOCAL IMPORTS SILENTLY LOSE THEIR BYTES, AND IS IT A LIMIT OR PRESSURE?
 *
 * The reproduction is size-shaped (DEBT-033 update (g)): same import path, same count, same content,
 * same durations — ~120MB assets lost 4 of 11, ~24MB assets lost 0 of 11. The loss surfaces only much
 * later, at proxy time, as `"no local bytes"`.
 *
 * THE MECHANISM FOR THE SILENCE IS ALREADY LOCATED, in `api.ts`'s `persistLocally`:
 *
 *     try { await store.put(id, file, …); liveUrl = await store.getObjectUrl(id) ?? …; }
 *     catch { liveUrl = createTrackedObjectUrl(file); }   // ← swallowed
 *
 * The asset is then recorded with `fileUrl: LOCAL_BLOB_PREFIX + id` — a marker that ASSERTS bytes
 * exist in OPFS under that id — and `status: "ready"`. In-session everything works off the object URL,
 * so the import reports success; the absence appears at proxy time, or after a refresh. An error path
 * that ships completion (DEBT-015's registered class).
 *
 * WHAT THIS PROBE ANSWERS — the founder's distinction, which decides the fix:
 *   - Is it always the SAME assets? DETERMINISTIC → a hard limit (quota, a size ceiling).
 *     Does it MOVE between runs? NON-DETERMINISTIC → pressure/exhaustion, a different fix entirely.
 *   - What quota does the browser actually GRANT (`navigator.storage.estimate()`), rather than what we
 *     assume from 228GB of free disk?
 *   - Does `usage` grow by the bytes we handed over, or stop short?
 *
 * Each Playwright launch gets a fresh profile, so every run starts from an empty OPFS — runs are
 * independent by construction rather than by cleanup.
 *
 * Run:
 *   PROBE_MEDIA_DIR=<dir> PROBE_RUNS=2 PIXEL_BROWSER_CHANNEL=chrome \
 *     pnpm --filter @orreris/worker tsx src/debt034-import-persist-probe.ts
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { assertQuietBrowserMachine } from "./browser/browser-preflight";
import { defaultClipPath, importAssets, reachEditor } from "./browser/editor-session.js";

const N = Number(process.env.PROBE_N ?? 11);
const RUNS = Number(process.env.PROBE_RUNS ?? 2);

interface AssetRow {
  id: string;
  fileName: string;
  sizeBytes: number | null;
  fileUrl: string;
  status: string;
  flagged?: boolean;
  bytesOnDevice: boolean;
}

function mediaFiles(count: number): string[] {
  const dir = process.env.PROBE_MEDIA_DIR;
  if (!dir) throw new Error("PROBE_MEDIA_DIR must point at a directory of distinct clips");
  const files = fs.readdirSync(dir).filter((n) => n.endsWith(".mp4")).map((n) => path.join(dir, n)).sort();
  if (files.length < count) throw new Error(`need ${count} clips, found ${files.length}`);
  return files.slice(0, count);
}

/** Page-side as SOURCE TEXT — tsx's `keepNames` wraps function-valued consts in `__name()`, which does
 *  not exist in the page (the trap already on file). */
const READ_STATE = `(async function () {
  var out = { estimate: null, assets: [], opfsFiles: [] };
  try {
    if (navigator.storage && navigator.storage.estimate) out.estimate = await navigator.storage.estimate();
  } catch (e) { out.estimate = { error: String(e) }; }
  try { out.persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : null; } catch (e) { out.persisted = null; }

  // Every local asset the editor believes it has.
  var raw = null;
  for (var i = 0; i < localStorage.length; i++) {
    var key = localStorage.key(i);
    if (key && key.indexOf("assets") !== -1 && key.indexOf("local") !== -1) {
      try { var parsed = JSON.parse(localStorage.getItem(key)); if (Array.isArray(parsed) && parsed.length) { raw = parsed; break; } } catch (e) {}
    }
  }
  out.assetKeyFound = !!raw;
  var assets = raw || [];

  // Walk OPFS and collect every file name that exists, at any depth (the store nests by scope).
  var names = {};
  async function walk(dir, depth) {
    if (depth > 4) return;
    for await (var entry of dir.values()) {
      if (entry.kind === "file") {
        try { var f = await entry.getFile(); names[entry.name] = f.size; } catch (e) { names[entry.name] = -1; }
      } else { await walk(entry, depth + 1); }
    }
  }
  try { await walk(await navigator.storage.getDirectory(), 0); } catch (e) { out.walkError = String(e); }
  out.opfsFiles = Object.keys(names).length;
  out.opfsBytes = Object.keys(names).reduce(function (sum, k) { return sum + Math.max(0, names[k]); }, 0);

  // BOTH BACKENDS, not just OPFS. asset-blob-store falls back OPFS -> IndexedDB ("orreris-assets") ->
  // memory, and \`estimate().usage\` counts them all. An earlier version of this probe walked only OPFS,
  // saw 0.04GB against a reported 0.74GB of usage, and called all 11 assets missing — measuring one of
  // two possible homes and reporting the answer as if it covered both.
  out.idbKeys = [];
  try {
    var db = await new Promise(function (resolve, reject) {
      var rq = indexedDB.open("orreris-assets", 1);
      rq.onsuccess = function () { resolve(rq.result); };
      rq.onerror = function () { reject(rq.error); };
      rq.onupgradeneeded = function () { /* created empty by us — means nothing was there */ };
    });
    var storeNames = Array.prototype.slice.call(db.objectStoreNames);
    out.idbStores = storeNames;
    for (var s = 0; s < storeNames.length; s++) {
      var keys = await new Promise(function (resolve) {
        try {
          var rq2 = db.transaction(storeNames[s], "readonly").objectStore(storeNames[s]).getAllKeys();
          rq2.onsuccess = function () { resolve(rq2.result || []); };
          rq2.onerror = function () { resolve([]); };
        } catch (e) { resolve([]); }
      });
      out.idbKeys = out.idbKeys.concat(keys);
    }
  } catch (e) { out.idbError = String(e); }
  for (var q = 0; q < out.idbKeys.length; q++) { if (!Object.prototype.hasOwnProperty.call(names, out.idbKeys[q])) names[out.idbKeys[q]] = 0; }

  // THE AUTHORITY on "are the bytes there": the store's own has(), via the __rfAssetBlobStore debug
  // handle. Inferring it from outside was wrong twice — an OPFS walk misses the IndexedDB backend, and
  // reading both still showed 0.04GB against 0.85GB of reported usage while disagreeing with the proxy
  // engine's own count. The directory listings above are kept only as context around this answer.
  out.persistLog = window.__rfImportPersist || null;
  out.storeKind = null;
  var api = window.__rfAssetBlobStore;
  if (api) { try { out.storeKind = await api.kind(); } catch (e) { out.storeKind = "err:" + String(e); } }

  for (var j = 0; j < assets.length; j++) {
    var a = assets[j];
    var onDevice = null;
    if (api) { try { onDevice = await api.has(a.id); } catch (e) { onDevice = null; } }
    out.assets.push({
      id: a.id,
      fileName: a.fileName || a.originalName || "?",
      sizeBytes: a.sizeBytes || null,
      fileUrl: String(a.fileUrl || "").slice(0, 40),
      status: a.status,
      flagged: a.localBytesMissing === true,
      bytesOnDevice: onDevice === null ? Object.prototype.hasOwnProperty.call(names, a.id) : onDevice,
      authority: onDevice === null ? "directory-listing (UNRELIABLE)" : "store.has()"
    });
  }
  return out;
})()`;

async function runOnce(channel: string | undefined, run: number, files: string[]) {
  const browser = await chromium.launch({ ...(channel ? { channel } : {}), headless: false });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = context.pages()[0] ?? (await context.newPage());
  page.on("pageerror", (e) => process.stdout.write(`[pageerror] ${String(e)}\n`));

  await reachEditor(page, { clipPath: defaultClipPath(20), flags: "wcDecode=1" });
  await page.waitForTimeout(2_000);

  const before = (await page.evaluate(READ_STATE)) as { estimate: { quota?: number; usage?: number } | null };
  console.log(`  [run ${run}] before import — quota ${fmtGB(before.estimate?.quota)}, usage ${fmtGB(before.estimate?.usage)}`);

  await importAssets(page, files);

  // WAIT FOR THE WRITES TO SETTLE, DO NOT GUESS A DELAY. The first version of this probe read 4s
  // after handing over 1.33GB and reported 11/11 assets missing — an artifact, not a finding: a file
  // written through `createWritable` is staged and does not appear in the directory until `close()`,
  // and `estimate().usage` was still climbing (0.03 → 0.75GB) at read time. So poll until BOTH the
  // reported usage and the visible file count stop changing, and say plainly if they never do.
  let settled = false;
  let lastUsage = -1;
  let lastFiles = -1;
  let stable = 0;
  for (let i = 0; i < 90; i++) {
    await page.waitForTimeout(2_000);
    const probe = (await page.evaluate(READ_STATE)) as { estimate: { usage?: number } | null; opfsFiles: number };
    const usage = probe.estimate?.usage ?? -1;
    if (usage === lastUsage && probe.opfsFiles === lastFiles) stable += 1;
    else stable = 0;
    lastUsage = usage;
    lastFiles = probe.opfsFiles;
    if (stable >= 3) {
      settled = true;
      break;
    }
  }
  console.log(`  [run ${run}] writes settled: ${settled} (usage ${fmtGB(lastUsage)}, ${lastFiles} opfs files)`);
  if (!settled) console.log(`  [run ${run}] ⚠ usage/file count never stopped moving — rows below are a snapshot of a moving target.`);

  const after = (await page.evaluate(READ_STATE)) as {
    estimate: { quota?: number; usage?: number } | null;
    persisted: boolean | null;
    assets: AssetRow[];
    opfsFiles: number;
    opfsBytes: number;
    assetKeyFound: boolean;
    walkError?: string;
  };

  const handed = files.reduce((sum, f) => sum + fs.statSync(f).size, 0);
  console.log(
    `  [run ${run}] after import  — quota ${fmtGB(after.estimate?.quota)}, usage ${fmtGB(after.estimate?.usage)}, ` +
      `persisted=${after.persisted}, store=${(after as any).storeKind}, opfs files ${after.opfsFiles} / ${fmtGB(after.opfsBytes)}, idb keys ${(after as any).idbKeys?.length ?? "?"}`
  );
  console.log(`  [run ${run}] bytes handed to the importer: ${fmtGB(handed)}`);
  console.log(`  [run ${run}] PERSIST OUTCOMES: ${JSON.stringify((after as any).persistLog)}`);
  if (after.walkError) console.log(`  [run ${run}] OPFS walk error: ${after.walkError}`);
  if (!after.assetKeyFound) console.log(`  [run ${run}] ⚠ no local-assets key found in localStorage — rows below may be incomplete`);

  const imported = after.assets.filter((a) => files.some((f) => path.basename(f) === a.fileName));
  const missing = imported.filter((a) => !a.bytesOnDevice);
  console.log(`  [run ${run}] imported rows: ${imported.length}, MISSING BYTES: ${missing.length}`);
  for (const a of imported) {
    console.log(
      `      ${a.bytesOnDevice ? "ok     " : "MISSING"}  ${a.fileName}  ${a.sizeBytes ? (a.sizeBytes / 1e6).toFixed(0) + "MB" : "?"}  status=${a.status}  flaggedMissing=${(a as any).flagged}`
    );
  }

  await browser.close();
  return { missing: missing.map((a) => a.fileName).sort(), imported: imported.length, after, handed };
}

function fmtGB(bytes: number | undefined): string {
  return bytes == null ? "?" : `${(bytes / 1e9).toFixed(2)}GB`;
}

async function main(): Promise<void> {
  assertQuietBrowserMachine({ label: "debt034-import-persist-probe" });
  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  if (!channel) console.log("⚠ PIXEL_BROWSER_CHANNEL unset — SwiftShader risk.");
  const files = mediaFiles(N);
  console.log(`media: ${N} clips from ${process.env.PROBE_MEDIA_DIR}`);

  const results: Array<{ missing: string[]; imported: number }> = [];
  for (let run = 1; run <= RUNS; run++) {
    console.log(`\n########## RUN ${run} ##########`);
    results.push(await runOnce(channel, run, files));
  }

  console.log(`\n=== DETERMINISM: is it the SAME assets every run? ===`);
  for (let i = 0; i < results.length; i++) {
    console.log(`  run ${i + 1}: ${results[i]!.missing.length} missing — ${JSON.stringify(results[i]!.missing)}`);
  }
  if (results.length >= 2) {
    const first = JSON.stringify(results[0]!.missing);
    const identical = results.every((r) => JSON.stringify(r.missing) === first);
    const anyMissing = results.some((r) => r.missing.length > 0);
    if (!anyMissing) {
      console.log("  no losses in any run — this configuration does not reproduce; do NOT read that as a fix.");
    } else if (identical) {
      console.log("  DETERMINISTIC — the same assets fail every run. Points at a LIMIT (quota / size ceiling).");
    } else {
      console.log("  NON-DETERMINISTIC — the failing set MOVES between runs. Points at PRESSURE/exhaustion.");
    }
  }
  console.log("\ndebt034-import-persist-probe: complete (measurement only, nothing asserted)");
}

void main();
