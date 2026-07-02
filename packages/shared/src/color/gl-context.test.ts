/**
 * Standalone assert script for the preview WebGL context GOVERNOR (todo.md Phase 2).
 * Repo convention: no test framework — exits non-zero on first failure.
 *
 *   pnpm --filter @lumio-by-aelivion/shared governor:test
 *
 * Verifies the enforcement semantics that keep large timelines under the browser context cap:
 *   - telemetry (active count) is accurate regardless of the enforcement flag;
 *   - disabled ⇒ requestContextSlot never evicts;
 *   - enabled + at hard cap ⇒ evicts the least-recently-used IDLE evictable context via its disposer;
 *   - a freshly-touched (on-screen) context is protected by the idle guard;
 *   - the root scene-compositor is never evicted;
 *   - a context without a registered disposer is skipped (not evictable).
 *
 * WebGL is faked: the governor only needs stable object identity + `isContextLost()`/`canvas.isConnected`.
 */
import {
  getActiveGlContextCount,
  getGlContextBudgetSnapshot,
  isGlBudgetOverTarget,
  noteGlContextCreated,
  noteGlContextDisposed,
  registerContextDisposer,
  requestContextSlot,
  setGlGovernorEnabled,
  touchContext,
  type GlContextOwnerInfo,
} from "./gl-context";

let failures = 0;
function check(name: string, condition: boolean): void {
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${name}`);
  }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let nextId = 1;
/** A minimal object the governor treats as a live WebGL2 context. */
function fakeGl(): WebGL2RenderingContext {
  return { __id: nextId++, canvas: { isConnected: false }, isContextLost: () => false } as unknown as WebGL2RenderingContext;
}

interface Managed {
  gl: WebGL2RenderingContext;
  disposed: boolean;
}

/** Create a governed context of `kind`, with a disposer that mimics the real teardown (decrements the count). */
function create(kind: GlContextOwnerInfo["kind"], withDisposer = true): Managed {
  const gl = fakeGl();
  noteGlContextCreated(gl, { kind, label: `${kind}:test` });
  const managed: Managed = { gl, disposed: false };
  if (withDisposer) {
    registerContextDisposer(gl, () => {
      managed.disposed = true;
      noteGlContextDisposed(gl); // the real disposer's dispose() → releaseContextIfDetached does this
    });
  }
  return managed;
}

function disposeAll(items: Managed[]): void {
  for (const item of items) {
    if (!item.disposed) {
      item.disposed = true;
      noteGlContextDisposed(item.gl);
    }
  }
}

async function main(): Promise<void> {
  // 1. Telemetry is accurate and independent of the enforcement flag.
  {
    setGlGovernorEnabled(false);
    const before = getActiveGlContextCount();
    const a = create("media-renderer");
    const b = create("media-renderer");
    check("count rises with creation", getActiveGlContextCount() === before + 2);
    disposeAll([a]);
    check("count falls with disposal", getActiveGlContextCount() === before + 1);
    disposeAll([b]);
    check("count returns to baseline", getActiveGlContextCount() === before);
    const snap = getGlContextBudgetSnapshot();
    check("snapshot reports target < hardCap", snap.target < snap.hardCap && snap.hardCap <= 8);
  }

  // 2. Disabled ⇒ requestContextSlot is a no-op (never evicts), even over the cap.
  {
    setGlGovernorEnabled(false);
    const items = [create("media-renderer"), create("media-renderer"), create("media-renderer"), create("media-renderer"), create("media-renderer")];
    await sleep(220); // all idle
    requestContextSlot();
    check("disabled governor evicts nothing", items.every((m) => !m.disposed));
    disposeAll(items);
  }

  // 3. Enabled + at hard cap + all idle ⇒ evict exactly one, the least-recently-used.
  {
    setGlGovernorEnabled(true);
    const a = create("media-renderer"); // oldest
    const b = create("media-renderer");
    const c = create("media-renderer");
    const d = create("media-renderer"); // newest
    await sleep(220); // all now idle (> EVICT_IDLE_MS)
    requestContextSlot();
    check("evicts exactly one at hard cap", [a, b, c, d].filter((m) => m.disposed).length === 1);
    check("evicts the least-recently-used (oldest)", a.disposed && !b.disposed && !c.disposed && !d.disposed);
    disposeAll([a, b, c, d]);
  }

  // 4. Idle guard: a just-touched (on-screen) context is protected; the next-oldest idle one goes instead.
  {
    setGlGovernorEnabled(true);
    const a = create("media-renderer"); // oldest by creation
    const b = create("media-renderer");
    const c = create("media-renderer");
    const d = create("media-renderer");
    await sleep(220);
    touchContext(a.gl); // a is now the FRESHEST — must not be evicted
    requestContextSlot();
    check("freshly-touched context is protected", !a.disposed);
    check("next-oldest idle context is evicted instead", b.disposed && !c.disposed && !d.disposed);
    disposeAll([a, b, c, d]);
  }

  // 5. The root scene-compositor is never evicted.
  {
    setGlGovernorEnabled(true);
    const root = create("scene-compositor");
    const m1 = create("media-renderer");
    const m2 = create("media-renderer");
    const m3 = create("media-renderer"); // 4 total → at hard cap
    await sleep(220);
    requestContextSlot();
    check("scene-compositor is never evicted", !root.disposed);
    check("a media-renderer is evicted instead", [m1, m2, m3].filter((m) => m.disposed).length === 1);
    disposeAll([root, m1, m2, m3]);
  }

  // 6. A context without a registered disposer is not evictable; the governor skips it.
  {
    setGlGovernorEnabled(true);
    const noDisposer = create("media-renderer", false); // oldest, but un-evictable
    const m1 = create("media-renderer");
    const m2 = create("media-renderer");
    const m3 = create("media-renderer");
    await sleep(220);
    requestContextSlot();
    check("context without a disposer is not evicted", !noDisposer.disposed);
    check("an evictable context is chosen instead", [m1, m2, m3].filter((m) => m.disposed).length === 1);
    disposeAll([noDisposer, m1, m2, m3]);
  }

  // 7. isGlBudgetOverTarget reflects the live count.
  {
    setGlGovernorEnabled(true);
    const base = getActiveGlContextCount();
    check("under target at baseline", base < 3 ? !isGlBudgetOverTarget() : isGlBudgetOverTarget());
    const items = [create("media-renderer"), create("media-renderer"), create("media-renderer")];
    check("over target once past the soft target", isGlBudgetOverTarget());
    disposeAll(items);
  }

  setGlGovernorEnabled(false);
  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll governor checks passed.");
}

void main();
