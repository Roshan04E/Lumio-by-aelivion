/**
 * ORIS / ADR-016 — the acceptance suites are part of the TRUSTED COMPUTING BASE.
 * Run: `pnpm --filter @orreris/web typecheck:tests`
 *
 * `tsconfig.json` excludes `src/**\/*.test.ts`, so every eval script in this package sits
 * outside the compiler. That produces the worst kind of failure — not a red build, but
 * **false confidence**: a check can assert against a property that no longer exists and still
 * report green. It is how `world-eval` came to build a `SourceAsset` with `source: "stock"`,
 * a value `AssetSource` does not contain, and pass.
 *
 * Architectural correctness now rests on these suites (ORIS-19 was validated by them; the
 * schema v4 correction was found by them). Evidence is only as trustworthy as the machinery
 * that certifies it, so the machinery needs certifying too.
 *
 * A big-bang fix would mean editing eval files across unrelated subsystems in one pass. This
 * is the incremental alternative: measure the debt, and **fail if it grows**. Lower BASELINE
 * as suites are cleaned; it may never rise.
 *
 * ── A NOTE ON THIS FILE'S OWN HISTORY ────────────────────────────────────────────────────
 * The first two versions of this script REPORTED SUCCESS WITHOUT RUNNING TSC. v1 spawned
 * `npx` with `shell: true` (a deprecation warning and an injection surface); removing the
 * shell broke the spawn outright, because Node >= 20 refuses to execute `.cmd` files without
 * one — so tsc never ran, the output was empty, and "0 errors" was printed as "debt reduced".
 *
 * A checker that reports success when it did not run is the *exact* failure it exists to
 * prevent. Hence §"proof of life" below: this script must prove tsc executed before it is
 * allowed to report anything at all.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Known type errors in the excluded suites, as of 2026-08-02.
 *
 * 17 = 18 found on first measurement, minus the one genuine DRIFT (world-eval's impossible
 * `source: "stock"` fixture), which was fixed rather than baselined. The remainder are
 * strictness gaps — `possibly undefined`, `unknown`, stale fixture shapes — which weaken the
 * suites without making them test fictions, and are cleaned incrementally.
 */
const BASELINE = 17;

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "../../..");

/**
 * Invoke tsc's JS entrypoint with the current node binary — never `npx`. `npx` resolves to
 * `npx.cmd` on Windows, which Node refuses to spawn without a shell; going direct sidesteps
 * both the shell and the platform difference.
 */
const tscEntry = [
  resolve(packageRoot, "node_modules/typescript/lib/tsc.js"),
  resolve(packageRoot, "../../node_modules/typescript/lib/tsc.js")
].find((candidate) => existsSync(candidate));

if (!tscEntry) {
  console.error("\n❌ could not locate typescript/lib/tsc.js — cannot verify the suites.\n");
  process.exit(1);
}

const result = spawnSync(process.execPath, [tscEntry, "-p", "tsconfig.tests.json", "--noEmit"], {
  cwd: packageRoot,
  encoding: "utf8"
});

const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

// ── Proof of life ────────────────────────────────────────────────────────────────────────
// A clean run is `status === 0`. Anything else must have produced diagnostics; if it did not,
// tsc did not execute and reporting "0 errors" would be a lie.
if (result.error || result.status === null || (result.status !== 0 && output.trim() === "")) {
  console.error(
    `\n❌ tsc did not run (status=${String(result.status)}${result.error ? `, ${result.error.message}` : ""}).\n` +
      `   Reporting 0 errors here would be false confidence — the very thing this script guards.\n`
  );
  process.exit(1);
}

const errors = output.split(/\r?\n/).filter((line) => /error TS\d+/.test(line));

// Second proof of life: tsc exited non-zero, so it MUST have found something parseable. A
// mismatch means the output format changed and the parser is silently matching nothing.
if (result.status !== 0 && errors.length === 0) {
  console.error(
    `\n❌ tsc exited ${result.status} but no diagnostics parsed — the output format changed.\n` +
      `   First lines:\n${output.split(/\r?\n/).slice(0, 3).join("\n")}\n`
  );
  process.exit(1);
}

const byFile = new Map<string, number>();
for (const line of errors) {
  const file = /^([^(]+)\(/.exec(line)?.[1] ?? "(unknown)";
  byFile.set(file, (byFile.get(file) ?? 0) + 1);
}

console.log("\nORIS — acceptance-suite typecheck (trusted computing base)\n");
if (byFile.size === 0) {
  console.log("  no type errors in the eval suites");
} else {
  for (const [file, count] of Array.from(byFile).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(3)}  ${file}`);
  }
}

const total = errors.length;
console.log(`\n  total ${total} · baseline ${BASELINE}`);

if (total > BASELINE) {
  console.error(
    `\n❌ suite type errors rose ${BASELINE} → ${total}. An eval outside the compiler can pass ` +
      `while asserting against something that no longer exists — fix the new error, or justify ` +
      `raising BASELINE in the commit message.\n`
  );
  process.exit(1);
}

if (total < BASELINE) {
  console.log(`\n✅ debt reduced ${BASELINE} → ${total}. Lower BASELINE to ${total} to hold the gain.\n`);
  process.exit(0);
}

console.log(`\n✅ suite type debt held at ${BASELINE}. It may never rise.\n`);
