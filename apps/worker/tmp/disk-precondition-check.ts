/**
 * Falsifier for the leaked-profile reaper. Cheap: no browser, no vite.
 *
 * The free-disk REFUSAL (`assertFreeDisk`) is a sibling session's and carries its own coverage; this
 * asserts the COLLECTOR that keeps that refusal honest. Age is the reaper's only safety guard, so both
 * directions matter: a reaper that spared nothing would eat a live run's browser profile, and one that
 * deleted nothing would leave the free-disk check refusing on garbage forever.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { reapStaleBrowserProfiles } from "../src/browser/browser-preflight";

// --- reaper: must delete OLD profile dirs and must NOT touch young ones ------------------------
// Age is the reaper's only safety guard, so it is the thing that has to be proven. A reaper that
// deleted a live run's profile would corrupt the very gates this file exists to protect.
// NOTE ON HOW AGE IS FAKED HERE. The reaper deletes only when BOTH mtime and birthtime are past the
// cutoff -- deliberately conservative, because a live Chrome writes into SUBDIRECTORIES and a
// profile's top-level mtime can go stale while the browser is very much alive. `fs.utimesSync` cannot
// backdate birthtime on Windows, so this test does not backdate at all: it creates the "old" dirs,
// waits, creates the "young" one, and reaps with a short max-age. Real clock, real semantics.
// Isolated scratch dir, NOT the machine's temp: see the `dir` note in reapStaleBrowserProfiles.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reaper-selftest-"));
const stamp = `selftest-${process.pid}`;
const oldDir = path.join(tmp, `puppeteer_dev_chrome_profile-${stamp}-old`);
const unrelatedDir = path.join(tmp, `some-unrelated-dir-${stamp}`);
const youngDir = path.join(tmp, `puppeteer_dev_chrome_profile-${stamp}-young`);
for (const dir of [oldDir, unrelatedDir]) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "Local State"), "x");
}
await new Promise((resolve) => setTimeout(resolve, 400));
fs.mkdirSync(youngDir, { recursive: true });
fs.writeFileSync(path.join(youngDir, "Local State"), "x");

const reapResult = reapStaleBrowserProfiles(200, tmp);
const oldStat = fs.existsSync(oldDir) ? fs.statSync(oldDir) : null;
console.log(`reap: ${JSON.stringify(reapResult)}`);
if (oldStat) {
  console.log(
    `  oldDir age: mtime ${Math.round(Date.now() - oldStat.mtimeMs)}ms ago, birthtime ${Math.round(Date.now() - oldStat.birthtimeMs)}ms ago`
  );
}

let reaperOk = true;
if (fs.existsSync(oldDir)) {
  console.error("FAIL: reaper left a stale profile dir behind");
  reaperOk = false;
}
if (!fs.existsSync(youngDir)) {
  console.error("FAIL: reaper deleted a FRESH profile dir — that is a live run's browser");
  reaperOk = false;
}
if (!fs.existsSync(unrelatedDir)) {
  console.error("FAIL: reaper deleted a non-profile directory — it is matching too broadly");
  reaperOk = false;
}
// Disabled reaper must be a true no-op, so the escape hatch cannot cost anyone their profiles.
// youngDir is by now well past the 200ms max-age used above, so only the `0` can spare it.
await new Promise((resolve) => setTimeout(resolve, 400));
reapStaleBrowserProfiles(0, tmp);
if (!fs.existsSync(youngDir)) {
  console.error("FAIL: reapStaleBrowserProfiles(0) still deleted something");
  reaperOk = false;
}
fs.rmSync(tmp, { recursive: true, force: true });
// Exact counts are assertable now that the scratch dir holds only these three.
if (reapResult.removed !== 1 || reapResult.skippedYoung !== 1 || reapResult.failed !== 0) {
  console.error(`FAIL: expected removed=1 skippedYoung=1 failed=0, got ${JSON.stringify(reapResult)}`);
  reaperOk = false;
}
if (!reaperOk) process.exit(1);
console.log("ok: reaper removes stale profiles, spares fresh ones and non-profiles, no-ops when disabled");

console.log("profile reaper: both directions hold");
