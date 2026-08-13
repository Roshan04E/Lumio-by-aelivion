/**
 * LINK GATE — DEBT-017 axis 3: does every registered shader compile and link, whether or not any
 * pixel fixture ever exercises it.
 *
 * ## Why this gate exists, and why it is not `render:compare:pixels` or `render:baseline`
 *
 * Both of those read `renderComparisonFixtureKeys` — the SAME array — so their passing is not two
 * independent facts, it is one fact (this fixture set renders without incident) counted twice. Their
 * universe is whatever the fixtures happen to build, and at the point this gate was written
 * (`project-tracker/architectural-debt.md`, DEBT-017 third axis) that was **3 of 29 transitions and
 * 14 of 24 visual effects exercised by any fixture at all**, out of 76. Run with `--coverage` for the
 * current numbers — the three monolith-vs-pipeline fixtures added the same day this gate landed moved
 * transition coverage to 6/29 and the fixture count to 82; this comment is not the source of truth for
 * either number and will drift as more are added. The other 26 (now) and 10 are invisible to both
 * gates for a reason that has nothing to do with whether the two renderers agree — the code is never
 * executed by either one.
 *
 * `6d58690` is the reason this exists rather than staying a finding: all four multi-pass transitions
 * failed to link in `SceneCompositor` for the entire life of the feature, and nothing caught it — "a
 * shader that never links is invisible to every pixel gate we have." This gate is what would have
 * caught it on the day it broke.
 *
 * ## What it checks, and what it deliberately does not
 *
 * Every registered transition (monolith and pipeline, every pass) and every registered fragment
 * effect (single- and multi-pass, every pass), assembled through the SAME builder functions every
 * renderer calls, in BOTH light spaces (`effectLight` selects between two different assembled
 * programs — a case exercising one says nothing about the other), compiled and LINKED against a real
 * WebGL2 context. No rendering, no fixtures, no baselines, no pixels read back. This is the cheap,
 * total half of the standard split in any renderer project: a total gate for "everything builds", and
 * golden images (`render:compare:pixels` / `render:linear-gate`) for a curated, expensive subset.
 * Compiling proves nothing about whether the PICTURE is right — only that it exists at all.
 *
 * ## The self-check, and why it is mandatory rather than nice-to-have
 *
 * The audit that found the coverage numbers above hit two probe defects on the way, both of which
 * produced a confident, plausible, WRONG report — caught only because they happened to land on
 * effects a green fixture could contradict:
 *
 *   1. A hand-written stub vertex shader read **0/128**, every case failing with the same varying-
 *      mismatch error — including `crossDissolve`, which renders correctly today. The probe was
 *      measuring its own vertex shader, not the registries.
 *   2. Passing a pass INDEX where the real API takes the pass OBJECT produced 18 failures reading
 *      `'undefined' : syntax error` in two effects that demonstrably work. The probe was reporting its
 *      own argument-shape bug as a product defect.
 *
 * Both failures were plausible specifically because nothing contradicted them for the 26 transitions
 * and 10 effects THIS GATE EXISTS to watch — there is no green fixture standing by to catch the next
 * one. So the gate proves its own construction is sound, every run, before trusting any result it
 * reports: four REAL sentinel sources (one per builder shape — transition monolith, transition
 * pipeline pass, fragment single-pass, fragment multi-pass), each checked twice — once as-built
 * (must LINK; if it does not, the harness itself is broken, not the product) and once corrupted with
 * a guaranteed-invalid top-level GLSL statement (must FAIL; if it does not, the compile/link
 * detection itself is broken and every green result below is unearned). All eight self-checks must
 * match their expectation before the main sweep is even attempted — a mismatch aborts with exit 2 and
 * reports NOTHING about the registries, because a probe that cannot certify itself has nothing to say
 * about anything else.
 *
 *     pnpm --filter @orreris/worker render:link-gate
 *     pnpm --filter @orreris/worker render:link-gate --coverage   # coverage report only, no browser
 */
import assert from "node:assert/strict";
import { chromium } from "playwright";
import {
  FULLSCREEN_TRI_VS,
  GLSL_TYPE,
  PipelineAssembler,
  buildFragmentEffectPassShader,
  buildFragmentEffectShader,
  buildTransitionFragmentShader,
  createRenderComparisonFixture,
  getFragmentEffect,
  getTransition,
  listFragmentEffects,
  listTransitions,
  renderComparisonFixtureKeys,
  timelineEffectRegistry,
} from "@orreris/shared";
import { assertQuietBrowserMachine } from "./browser/browser-preflight";

type Light = "display" | "linear";
const LIGHTS: Light[] = ["display", "linear"];

interface ShaderCase {
  label: string;
  light: Light;
  source: string;
}

interface SelfCheckCase extends ShaderCase {
  expectLink: boolean;
}

// -------------------------------------------------------------------------------------------------
// Coverage: which registry entries any pixel fixture actually renders. Read-only, no browser needed.
// -------------------------------------------------------------------------------------------------

function coverage(): { effects: Set<string>; transitions: Set<string> } {
  const effects = new Set<string>();
  const transitions = new Set<string>();
  const effectTypes: ReadonlySet<string> = new Set<string>(timelineEffectRegistry.map((e) => e.type));
  const transitionIds: ReadonlySet<string> = new Set<string>(listTransitions().map((t) => t.id));

  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    const record = node as Record<string, unknown>;
    if (typeof record.type === "string" && effectTypes.has(record.type)) effects.add(record.type);
    if (typeof record.kind === "string" && transitionIds.has(record.kind)) transitions.add(record.kind);
    for (const key of Object.keys(record)) walk(record[key]);
  };

  for (const key of renderComparisonFixtureKeys) walk(createRenderComparisonFixture(key).graph);
  return { effects, transitions };
}

function reportCoverage(): void {
  const { effects, transitions } = coverage();
  const allEffects = timelineEffectRegistry.map((e) => e.type);
  const allTransitions = listTransitions().map((t) => t.id);
  const isAudio = (t: string): boolean => t.startsWith("audio") || t === "volume";
  const uncoveredEffects = allEffects.filter((t) => !effects.has(t) && !isAudio(t));
  const uncoveredTransitions = allTransitions.filter((t) => !transitions.has(t));

  console.log(`── fixture coverage (${renderComparisonFixtureKeys.length} fixtures) ──`);
  console.log(`  visual effects rendered by a fixture : ${effects.size}/${allEffects.filter((t) => !isAudio(t)).length}`);
  console.log(`  UNCOVERED                            : ${uncoveredEffects.join(", ") || "(none)"}`);
  console.log(`  transitions rendered by a fixture    : ${transitions.size}/${allTransitions.length}`);
  console.log(`  UNCOVERED                            : ${uncoveredTransitions.join(", ") || "(none)"}`);
}

// -------------------------------------------------------------------------------------------------
// Every shader source both renderers could be asked to compile — the main sweep.
// -------------------------------------------------------------------------------------------------

function collectCases(): ShaderCase[] {
  const cases: ShaderCase[] = [];

  for (const def of listFragmentEffects()) {
    for (const light of LIGHTS) {
      if (def.passes && def.passes.length > 0) {
        for (const pass of def.passes) {
          cases.push({
            label: `fragment ${def.id} / ${pass.id}`,
            light,
            source: buildFragmentEffectPassShader(def, pass, light),
          });
        }
      } else {
        cases.push({ label: `fragment ${def.id}`, light, source: buildFragmentEffectShader(def, light) });
      }
    }
  }

  for (const def of listTransitions()) {
    for (const light of LIGHTS) {
      if (def.pipeline && def.pipeline.passes.length > 0) {
        // Exactly what `prepareTransition` hands the assembler — the arrangement `6d58690` found broken.
        const paramDecls = def.params.map((p) => `${GLSL_TYPE[p.type]} ${p.name}`);
        for (const pass of def.pipeline.passes) {
          cases.push({
            label: `transition ${def.id} / ${pass.moduleId}`,
            light,
            source: PipelineAssembler.assemblePassShader(pass.moduleId, paramDecls, light),
          });
        }
      } else {
        cases.push({ label: `transition ${def.id}`, light, source: buildTransitionFragmentShader(def, light) });
      }
    }
  }

  return cases;
}

// -------------------------------------------------------------------------------------------------
// Self-check: one real sentinel per builder shape, each verified both as-built (must LINK) and
// corrupted (must FAIL). See the module header for why this is mandatory, not defensive extra.
// -------------------------------------------------------------------------------------------------

/**
 * A bare top-level identifier statement is not a valid top-level GLSL construct in ANY shader,
 * regardless of what the source already declares — a guaranteed, shape-independent parse failure.
 * Inserted right after the version pragma so it is never accidentally inside a string literal or a
 * comment the source might contain.
 */
function corrupt(source: string): string {
  const marker = "#version 300 es";
  assert.ok(source.includes(marker), "self-check: sentinel source does not start with #version 300 es");
  return source.replace(marker, `${marker}\n__DEBT017_SELFCHECK_UNDECLARED_IDENTIFIER__;`);
}

function selfCheckCases(): SelfCheckCase[] {
  const crossDissolve = getTransition("crossDissolve");
  assert.ok(crossDissolve, "self-check sentinel missing: crossDissolve (transition monolith)");

  const focusPull = getTransition("focusPull");
  assert.ok(focusPull?.pipeline?.passes.length, "self-check sentinel missing: focusPull (transition pipeline)");
  const focusPullParamDecls = focusPull!.params.map((p) => `${GLSL_TYPE[p.type]} ${p.name}`);
  const focusPullFirstPass = focusPull!.pipeline!.passes[0]!;

  const radialBlur = getFragmentEffect("builtin.radialBlur");
  assert.ok(radialBlur, "self-check sentinel missing: builtin.radialBlur (fragment single-pass)");

  const stylize = getFragmentEffect("builtin.stylize");
  assert.ok(stylize?.passes?.length, "self-check sentinel missing: builtin.stylize (fragment multi-pass)");
  const stylizeFirstPass = stylize!.passes![0]!;

  const good: ShaderCase[] = [
    {
      label: "transition monolith (crossDissolve)",
      light: "display",
      source: buildTransitionFragmentShader(crossDissolve!, "display"),
    },
    {
      label: "transition pipeline pass (focusPull / " + focusPullFirstPass.moduleId + ")",
      light: "display",
      source: PipelineAssembler.assemblePassShader(focusPullFirstPass.moduleId, focusPullParamDecls, "display"),
    },
    {
      label: "fragment single-pass (builtin.radialBlur)",
      light: "display",
      source: buildFragmentEffectShader(radialBlur!, "display"),
    },
    {
      label: "fragment multi-pass (builtin.stylize / " + stylizeFirstPass.id + ")",
      light: "display",
      source: buildFragmentEffectPassShader(stylize!, stylizeFirstPass, "display"),
    },
  ];

  const cases: SelfCheckCase[] = [];
  for (const g of good) {
    cases.push({ ...g, label: `selfcheck GOOD: ${g.label}`, expectLink: true });
    cases.push({ ...g, label: `selfcheck BAD (corrupted): ${g.label}`, source: corrupt(g.source), expectLink: false });
  }
  return cases;
}

// -------------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  if (process.argv.includes("--coverage")) {
    reportCoverage();
    return;
  }

  assertQuietBrowserMachine({ label: "render:link-gate", scriptMarker: "render-link-gate" });

  reportCoverage();

  const selfCheck = selfCheckCases();
  const mainCases = collectCases();
  console.log(
    `\n── self-check: ${selfCheck.length} case(s) (must all match expectation before anything else counts) ──`
  );
  console.log(`── main sweep: ${mainCases.length} shader source(s), both light spaces ──`);

  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  const browser = await chromium.launch(channel ? { channel } : {});
  try {
    const page = await browser.newPage();
    await page.goto("about:blank");

    const compile = async (
      cases: ShaderCase[]
    ): Promise<{ label: string; light: string; ok: boolean; log: string }[]> =>
      page.evaluate(
        ({ cases, VERTEX }: { cases: ShaderCase[]; VERTEX: string }) => {
          const canvas = document.createElement("canvas");
          const gl = canvas.getContext("webgl2");
          if (!gl) return cases.map((c) => ({ label: c.label, light: c.light, ok: false, log: "no webgl2 context" }));
          const out: { label: string; light: string; ok: boolean; log: string }[] = [];
          for (const test of cases) {
            const vs = gl.createShader(gl.VERTEX_SHADER)!;
            gl.shaderSource(vs, VERTEX);
            gl.compileShader(vs);
            const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
            gl.shaderSource(fs, test.source);
            gl.compileShader(fs);
            let ok = gl.getShaderParameter(fs, gl.COMPILE_STATUS) as boolean;
            let log = ok ? "" : String(gl.getShaderInfoLog(fs) ?? "").trim();
            if (ok) {
              // COMPILE is not LINK: a mismatched varying or a missing entry point only shows here.
              const program = gl.createProgram()!;
              gl.attachShader(program, vs);
              gl.attachShader(program, fs);
              gl.linkProgram(program);
              ok = gl.getProgramParameter(program, gl.LINK_STATUS) as boolean;
              if (!ok) log = `LINK: ${String(gl.getProgramInfoLog(program) ?? "").trim()}`;
              gl.deleteProgram(program);
            }
            gl.deleteShader(vs);
            gl.deleteShader(fs);
            out.push({ label: test.label, light: test.light, ok, log });
          }
          return out;
        },
        { cases, VERTEX: FULLSCREEN_TRI_VS }
      );

    const selfResults = await compile(selfCheck);
    const selfMismatches = selfResults
      .map((r, i) => ({ result: r, expect: selfCheck[i]!.expectLink }))
      .filter(({ result, expect }) => result.ok !== expect);

    if (selfMismatches.length > 0) {
      console.error(`\nSELF-CHECK FAILED — ${selfMismatches.length}/${selfResults.length} case(s) did not match expectation.`);
      console.error("The harness cannot be trusted, so the main sweep was NOT run and nothing below is reported.\n");
      for (const { result, expect } of selfMismatches) {
        console.error(`  ${result.ok ? "unexpectedly LINKED" : "unexpectedly FAILED"} (expected ${expect ? "link" : "fail"})  ${result.label} @${result.light}`);
        if (result.log) console.error(`    ${result.log.split("\n").slice(0, 4).join("\n    ")}`);
      }
      process.exitCode = 2;
      return;
    }
    console.log(`self-check: ${selfResults.length}/${selfResults.length} matched expectation — harness trusted.`);

    const results = await compile(mainCases);
    const failures = results.filter((r) => !r.ok);
    for (const failure of failures) {
      console.log(`\nFAIL  ${failure.label} @${failure.light}`);
      console.log(`      ${failure.log.split("\n").slice(0, 6).join("\n      ")}`);
    }
    console.log(
      `\n${failures.length === 0 ? "PASS" : "FAIL"} — ${results.length - failures.length}/${results.length} sources linked` +
        `${failures.length ? `; ${failures.length} FAILED` : ""}`
    );
    if (failures.length > 0) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

await main();
