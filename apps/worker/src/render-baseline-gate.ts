/**
 * SAME-RENDERER, ACROSS-COMMIT still gate ("did the picture change?").
 *
 * `render:compare:pixels` is a DIFFERENTIAL instrument: it renders each fixture through Remotion AND
 * the web preview and asserts the two agree. That answers "do the renderers agree?", which is a
 * different question from "did the picture change?", and it is structurally blind to any change both
 * renderers share — DEBT-017's class. The concrete cost: a glow whose kernel truncated at 96 px
 * agreed perfectly across both renderers for two months, and every sweep in that window read 0.000%
 * and passed.
 *
 * This gate renders ONE renderer (Remotion, the export path — the one that produces what a user
 * ships) and diffs it against a COMMITTED baseline PNG captured at an earlier commit. It is the only
 * check in this repo that can assert "existing projects render exactly as they did before", which is
 * the safety claim the linear-light programme is gated on (plans/linear-light-effect-stage.md §4.1).
 *
 * The bar is ZERO differing pixels. Not "under a ratio" — a change that moves the picture a little is
 * exactly what this exists to catch, and a per-fixture slack bar would hide it. Measured before
 * relying on it: rendering the same fixture twice at the same commit is not merely pixel-identical
 * but BYTE-identical (sha256 of the PNG stable across re-renders), even on a machine at 84% CPU. So
 * zero is achievable rather than aspirational, and the committed baseline can be a HASH.
 *
 * That is why `baseline.json` stores a sha256 per fixture and the PNGs stay local (gitignored): 63
 * stills is ~70 MB of binary, and the hash carries exactly the same zero-tolerance verdict in a form
 * a reviewer can actually read in a diff — "which fixture's picture changed" becomes one line.
 * The PNGs are still written locally, so a failure can be LOOKED AT: when a baseline PNG is present
 * the gate also writes a pixel diff and reports the differing-pixel count.
 *
 *   pnpm --filter @orreris/worker render:baseline --capture   # write/refresh baselines
 *   pnpm --filter @orreris/worker render:baseline             # assert nothing moved
 *
 * Scope a run with BASELINE_FIXTURES=blur,glow (same convention as PIXEL_FIXTURES). A capture records
 * the commit it was taken at, so a failure can say WHICH commit the picture last agreed with rather
 * than only that it disagrees with something.
 *
 * IMPORTANT — what a green run does and does not prove. It proves the RENDERED PICTURE is unchanged
 * for the fixtures swept, at the frame swept. It says nothing about a fixture that does not exist:
 * this gate can only defend behaviour somebody wrote a fixture for. When adding a project-level
 * setting whose OFF path must be inert, the fixtures must exercise the OFF path (i.e. leave the
 * setting absent), or a green run is measuring the new path against itself.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRenderManifest } from "@orreris/render-templates";
import {
  createRenderComparisonFixture,
  renderComparisonFixtureKeys,
  renderComparisonFixtureRelations,
  renderComparisonFrameSeconds,
  type RenderComparisonFixtureKey
} from "@orreris/shared";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { renderManifestStill } from "./remotion-renderer";
import { assertFreeDisk, assertQuietBrowserMachine, describeFreeDisk } from "./browser/browser-preflight";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const baselineDir = path.join(repoRoot, "tmp", "render-baseline");
const currentDir = path.join(baselineDir, "current");
const manifestPath = path.join(baselineDir, "baseline.json");

const capture = process.argv.includes("--capture");
const rendererMode = (process.env.RENDERER_MODE === "legacy" ? "legacy" : "webgl") as "legacy" | "webgl";

/**
 * Pixel comparison runs at threshold 0 — every channel difference counts. The perceptual threshold
 * the parity gate uses (0.16) exists to absorb cross-RENDERER rasterization jitter; there is no
 * second renderer here, so absorbing anything would only hide the signal.
 */
const DIFF_THRESHOLD = 0;

const fixtureKeys: RenderComparisonFixtureKey[] = (() => {
  const raw = process.env.BASELINE_FIXTURES;
  if (!raw) return renderComparisonFixtureKeys;
  const wanted = new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
  const valid = renderComparisonFixtureKeys.filter((key) => wanted.has(key));
  if (!valid.length) {
    throw new Error(`BASELINE_FIXTURES had no known fixtures. Known: ${renderComparisonFixtureKeys.join(", ")}`);
  }
  return valid;
})();

interface BaselineEntry {
  sha256: string;
  width: number;
  height: number;
}

interface BaselineManifest {
  commit: string;
  capturedAt: string;
  rendererMode: string;
  /** fixture key -> content hash of the rendered still. The committed, reviewable reference. */
  fixtures: Record<string, BaselineEntry>;
}

function sha256File(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function pngSize(file: string): { width: number; height: number } {
  const png = PNG.sync.read(fs.readFileSync(file));
  return { width: png.width, height: png.height };
}

function readManifest(): BaselineManifest | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as BaselineManifest;
    return parsed && typeof parsed.fixtures === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function headCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function renderFixture(key: RenderComparisonFixtureKey, outputPath: string): Promise<void> {
  const fixture = createRenderComparisonFixture(key);
  if (!fixture.graph.composition) throw new Error(`Fixture "${key}" must include a composition.`);
  const manifest = buildRenderManifest({
    projectId: fixture.graph.projectId,
    graph: fixture.graph,
    assets: fixture.assets,
    quality: "final",
    createdAt: new Date(0).toISOString()
  });
  const frame = Math.round(renderComparisonFrameSeconds * manifest.output.fps);
  await renderManifestStill({ manifest, frame, outputLocation: outputPath, rendererMode });
}

/** Differing-pixel count between two PNGs at threshold 0. A size mismatch is a failure, not a throw. */
function diffPngs(
  baselinePath: string,
  currentPath: string,
  diffPath: string
): { diffPixels: number; totalPixels: number; note?: string } {
  const baseline = PNG.sync.read(fs.readFileSync(baselinePath));
  const current = PNG.sync.read(fs.readFileSync(currentPath));
  if (baseline.width !== current.width || baseline.height !== current.height) {
    return {
      diffPixels: current.width * current.height,
      totalPixels: current.width * current.height,
      note: `size changed ${baseline.width}x${baseline.height} -> ${current.width}x${current.height}`
    };
  }
  const diff = new PNG({ width: baseline.width, height: baseline.height });
  const diffPixels = pixelmatch(baseline.data, current.data, diff.data, baseline.width, baseline.height, {
    threshold: DIFF_THRESHOLD
  });
  fs.writeFileSync(diffPath, PNG.sync.write(diff));
  return { diffPixels, totalPixels: baseline.width * baseline.height };
}

/**
 * CROSS-FIXTURE relations — the half of this gate that a re-capture cannot launder.
 *
 * Everything above compares a fixture to its OWN past, and the documented response to a legitimate
 * change is `--capture`. That makes it the wrong instrument for a claim about two fixtures agreeing
 * with EACH OTHER: `linear-stylize` must be byte-identical to `stylize` because the artistic family
 * opts out of the light, and if that breaks, the symptom is "a linear fixture's baseline moved" —
 * which is what this programme's linear fixtures are SUPPOSED to do. Re-capture and the evidence is
 * gone, by the book, by whoever is least likely to be suspicious.
 *
 * Both sides are hashed in the same run, so a relation is unaffected by what any baseline says.
 *
 * It runs in CAPTURE mode as well as verify, BEFORE the manifest is written, and a failure means no
 * manifest is written at all. That ordering is the whole point: capture is the laundering path.
 *
 * A relation whose partner is outside a scoped run renders the partner anyway (into `relations/`,
 * never recorded as a baseline). Otherwise `BASELINE_FIXTURES=linear-stylize --capture` would be a
 * hole shaped exactly like the failure this is here to catch.
 */
async function checkRelations(scope: Set<string>, shas: Map<string, string>): Promise<string[]> {
  const relations = renderComparisonFixtureRelations.filter((rel) => scope.has(rel.a) || scope.has(rel.b));
  if (!relations.length) {
    console.log("\nNo cross-fixture relations involve this run's fixtures.");
    return [];
  }
  const relationDir = path.join(baselineDir, "relations");
  fs.mkdirSync(relationDir, { recursive: true });

  const shaFor = async (key: RenderComparisonFixtureKey): Promise<string> => {
    const known = shas.get(key);
    if (known) return known;
    const out = path.join(relationDir, `${key}.png`);
    await renderFixture(key, out);
    const sha = sha256File(out);
    shas.set(key, sha);
    return sha;
  };

  console.log("\nCross-fixture relations (a re-capture cannot satisfy these):");
  const failures: string[] = [];
  for (const rel of relations) {
    const shaA = await shaFor(rel.a);
    const shaB = await shaFor(rel.b);
    const same = shaA === shaB;
    const ok = rel.relation === "identical" ? same : !same;
    const verb = rel.relation === "identical" ? "==" : "!=";
    const line = `${rel.a} ${verb} ${rel.b}`;
    console.log(
      `  ${line.padEnd(46)} ${ok ? "ok" : "FAILED"}   ${shaA.slice(0, 12)} ${same ? "==" : "!="} ${shaB.slice(0, 12)}`
    );
    if (!ok) failures.push(`${line} — ${rel.why}`);
  }
  return failures;
}

async function main(): Promise<void> {
  /**
   * THE PRECONDITION, which this gate did not have until 2026-08-16 — and it is the gate that paid
   * for the lesson. A full sweep died at `ENOSPC` partway through, having already printed a column of
   * `unchanged`; that column was read as a verdict and written into a commit message before the crash
   * was noticed. A second, later sweep that STARTED with 8.6 GB flagged two fixtures as CHANGED at
   * 3/2073600 and 0/2073600 pixels, and neither reproduced on a narrowed re-run — irreproducible
   * differences on a volume that was draining under the run, which is indistinguishable from a real
   * regression by inspection and therefore VOIDS rather than being subtracted.
   *
   * A zero-tolerance instrument is exactly the one that must refuse to start on a dirty machine: its
   * output is a hash comparison, so noise does not present as noise, it presents as "an existing
   * project just shifted."
   */
  assertQuietBrowserMachine({ label: "render:baseline", scriptMarker: "render-baseline-gate" });
  console.log(`preflight: ${describeFreeDisk()}`);
  fs.mkdirSync(baselineDir, { recursive: true });

  if (capture) {
    const commit = headCommit();
    console.log(`Capturing baselines at ${commit} (rendererMode=${rendererMode})`);
    // Merge into any existing entries — a scoped capture must not erase baselines it did not take.
    const fixtures: Record<string, BaselineEntry> = { ...(readManifest()?.fixtures ?? {}) };
    const captured = new Map<string, string>();
    for (const key of fixtureKeys) {
      // Same reason as the compare loop below — and worse here: a capture taken on a draining volume
      // freezes the noise into the REFERENCE, where every later run inherits it.
      assertFreeDisk("render:baseline --capture");
      const out = path.join(baselineDir, `${key}.png`);
      await renderFixture(key, out);
      fixtures[key] = { sha256: sha256File(out), ...pngSize(out) };
      captured.set(key, fixtures[key]!.sha256);
      console.log(`  captured ${key}  ${fixtures[key]!.sha256.slice(0, 12)}`);
    }
    // Before the write, never after: a capture that would freeze a broken relation into the reference
    // must not produce a reference at all.
    const relationFailures = await checkRelations(new Set<string>(fixtureKeys), captured);
    if (relationFailures.length) {
      throw new Error(
        `Refusing to write baselines: ${relationFailures.length} cross-fixture relation(s) FAILED.\n  ` +
          `${relationFailures.join("\n  ")}\n\n` +
          `These do not compare against a baseline, so re-capturing cannot make them pass — the ` +
          `pictures themselves disagree. Fix the code, then capture.\n\n` +
          `NOTE: the local PNGs in ${path.relative(repoRoot, baselineDir)} WERE overwritten by this ` +
          `run; only the manifest was withheld. Re-capture after the fix so the diagnosis diffs on a ` +
          `later failure compare against the reference the manifest actually holds.`
      );
    }
    const manifest: BaselineManifest = {
      commit,
      capturedAt: new Date().toISOString(),
      rendererMode,
      fixtures: Object.fromEntries(Object.entries(fixtures).sort(([a], [b]) => a.localeCompare(b)))
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`\nWrote ${fixtureKeys.length} baseline(s) + ${path.relative(repoRoot, manifestPath)}`);
    return;
  }

  const baselineManifest = readManifest();
  if (!baselineManifest) {
    throw new Error(
      `No baseline manifest at ${path.relative(repoRoot, manifestPath)}. Run with --capture first.`
    );
  }
  console.log(
    `Baseline: ${baselineManifest.commit.slice(0, 7)} captured ${baselineManifest.capturedAt} ` +
      `(rendererMode=${baselineManifest.rendererMode})`
  );
  console.log(`Now:      ${headCommit().slice(0, 7)} (rendererMode=${rendererMode})`);
  if (baselineManifest.rendererMode !== rendererMode) {
    throw new Error(
      `Baseline was captured with rendererMode=${baselineManifest.rendererMode} but this run is ` +
        `${rendererMode}. Comparing across renderer modes measures the mode, not the change.`
    );
  }

  fs.mkdirSync(currentDir, { recursive: true });
  const failures: string[] = [];
  const missing: string[] = [];
  const rendered = new Map<string, string>();

  for (const key of fixtureKeys) {
    const entry = baselineManifest.fixtures[key];
    if (!entry) {
      // An ABSENT baseline is reported, never silently skipped: a gate that quietly passes on the
      // fixtures it has no reference for is exactly the reassuring-null-result failure this whole
      // instrument exists to avoid.
      missing.push(key);
      continue;
    }
    /**
     * RE-CHECKED PER FIXTURE, not only at startup, and that is the whole point of the addition.
     * Remotion's per-render scratch is transient but large: a sweep can begin with headroom and run
     * out twenty fixtures in, and every row printed after that moment is suspect while looking
     * exactly like the rows before it. Voiding here costs the rest of the sweep; NOT voiding here
     * costs a verdict that gets believed.
     */
    assertFreeDisk("render:baseline");
    const currentPath = path.join(currentDir, `${key}.png`);
    await renderFixture(key, currentPath);
    const sha = sha256File(currentPath);
    rendered.set(key, sha);
    if (sha === entry.sha256) {
      console.log(`  ${key.padEnd(32)} unchanged`);
      continue;
    }
    // The hash decides the verdict. The pixel diff is DIAGNOSIS — only possible when the local PNG
    // from the capture run is still around, which it will not be on a fresh clone. Its absence
    // weakens the report, never the verdict.
    const baselinePath = path.join(baselineDir, `${key}.png`);
    let detail = `hash ${entry.sha256.slice(0, 12)} -> ${sha.slice(0, 12)}`;
    if (fs.existsSync(baselinePath)) {
      const diffPath = path.join(currentDir, `diff-${key}.png`);
      const { diffPixels, totalPixels, note } = diffPngs(baselinePath, currentPath, diffPath);
      const ratio = totalPixels > 0 ? diffPixels / totalPixels : 0;
      detail = `${diffPixels}/${totalPixels} pixels (${(ratio * 100).toFixed(3)}%)${note ? ` — ${note}` : ""}`;
    } else {
      detail += " (no local baseline PNG — re-capture at the baseline commit to see the diff)";
    }
    console.log(`  ${key.padEnd(32)} CHANGED    ${detail}`);
    failures.push(`${key}: ${detail}`);
  }

  if (missing.length) {
    console.log(`\nNo baseline for ${missing.length} fixture(s): ${missing.join(", ")}`);
    console.log("These were NOT checked. Run with --capture to add them.");
  }

  const relationFailures = await checkRelations(new Set<string>(fixtureKeys), rendered);

  if (failures.length || relationFailures.length) {
    const parts: string[] = [];
    if (failures.length) {
      parts.push(
        `The rendered picture CHANGED for ${failures.length} fixture(s) versus baseline ` +
          `${baselineManifest.commit.slice(0, 7)}:\n  ${failures.join("\n  ")}\n\n` +
          `If the change is intended, review the diff PNGs in ${path.relative(repoRoot, currentDir)} ` +
          `and re-capture. If it is not, an existing project just shifted.`
      );
    }
    if (relationFailures.length) {
      parts.push(
        `${relationFailures.length} cross-fixture relation(s) FAILED:\n  ${relationFailures.join("\n  ")}\n\n` +
          `Re-capturing will NOT clear these — they compare two fixtures rendered in this same run, ` +
          `not a fixture against its baseline.`
      );
    }
    throw new Error(parts.join("\n\n"));
  }
  const checked = fixtureKeys.length - missing.length;
  console.log(`\nPicture unchanged for all ${checked} checked fixture(s) versus ${baselineManifest.commit.slice(0, 7)}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
