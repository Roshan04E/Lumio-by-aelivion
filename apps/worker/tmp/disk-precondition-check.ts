/**
 * Falsifier for the free-disk precondition. Cheap: no browser, no vite.
 *
 * Asserts BOTH directions, because a guard that only ever throws is indistinguishable from a guard
 * that is hard-wired to throw:
 *   1. at a floor above the machine's real free space it must REFUSE;
 *   2. at GATE_MIN_FREE_DISK_GB=0 it must PASS (the escape hatch works, so it cannot wedge a machine).
 */
import { assertDiskHeadroom, freeDiskBytes } from "../src/browser/browser-preflight";

const free = freeDiskBytes(process.cwd());
if (free == null) {
  console.error("VOID: could not read free disk on this machine — the guard would no-op here.");
  process.exit(1);
}
const freeGb = free / 1024 ** 3;
console.log(`free on repo volume: ${freeGb.toFixed(2)} GB`);

// 1. Floor set just above actual free space -> must refuse.
process.env.GATE_MIN_FREE_DISK_GB = String(freeGb + 1);
let refused = false;
try {
  assertDiskHeadroom("disk-precondition-check");
} catch (error) {
  refused = true;
  const message = String(error instanceof Error ? error.message : error);
  if (!/REFUSING TO RUN/.test(message)) {
    console.error(`FAIL: threw, but not with the refusal message:\n${message}`);
    process.exit(1);
  }
  console.log(`ok: refused below floor — ${message.split("\n")[0]}`);
}
if (!refused) {
  console.error(`FAIL: floor ${(freeGb + 1).toFixed(2)} GB > free ${freeGb.toFixed(2)} GB and it did NOT refuse.`);
  process.exit(1);
}

// 2. Escape hatch -> must pass.
process.env.GATE_MIN_FREE_DISK_GB = "0";
try {
  assertDiskHeadroom("disk-precondition-check");
  console.log("ok: GATE_MIN_FREE_DISK_GB=0 disables the floor");
} catch (error) {
  console.error(`FAIL: floor disabled but it still refused: ${String(error)}`);
  process.exit(1);
}

console.log("disk precondition: both directions hold");
