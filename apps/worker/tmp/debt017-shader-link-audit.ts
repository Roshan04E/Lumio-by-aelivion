/**
 * DEBT-017 AUDIT PROBE — does every registered shader actually LINK?
 *
 * ## The question, and why a pixel gate cannot answer it
 *
 * `6d58690` found that all four multi-pass transitions had never compiled, in any renderer, for the
 * whole life of the feature. Nothing caught it: `render:compare:pixels` compares two renderers and
 * NEITHER ran the code, `render:baseline` compares a picture to its past and there was no picture.
 * The defect survived because **no fixture referenced them**, and a gate's universe is its fixture
 * list.
 *
 * Coverage measured 2026-08-13 (`tmp/debt017-shader-link-audit.ts --coverage`, same walk this file
 * performs): **3 of 29 transitions and 14 of 29 timeline effects** appear in any fixture. So the
 * exact conditions that hid the four dead transitions still hold for everything else in both
 * registries.
 *
 * ## Why this probe is cheap, and why it is not a pixel test
 *
 * `buildFragmentEffectShader` / `buildFragmentEffectPassShader` / `buildTransitionFragmentShader` /
 * `PipelineAssembler.assemblePassShader` are PURE STRING BUILDERS — they need no GPU and no React.
 * So the sources are generated here in Node, shipped to a page as data, and compiled there against a
 * real WebGL2 context. Nothing about the scene, the timeline, or either renderer is involved.
 *
 * That means this answers exactly one question — *does the GLSL the renderers would compile actually
 * compile?* — and deliberately not "is the picture right", which is the absolute-ground-truth
 * instrument DEBT-017 names and nobody has built. A shader that links can still be wrong. A shader
 * that does not link is wrong in every renderer at once, and that is the class this catches.
 *
 * ## Reading the output
 *
 * A FAIL here is a defect that ships: every consumer (web preview, browser export, Remotion) builds
 * from these same functions, so a source that does not compile here does not compile anywhere.
 * BOTH light spaces are compiled, because `effectLight` selects between two different assembled
 * programs and a fixture exercising one says nothing about the other.
 *
 *   PIXEL_BROWSER_CHANNEL=chrome npx tsx tmp/debt017-shader-link-audit.ts
 *   npx tsx tmp/debt017-shader-link-audit.ts --coverage   # registry-vs-fixture coverage only
 */
import { chromium } from "playwright";
import {
  buildFragmentEffectShader,
  buildFragmentEffectPassShader,
  buildTransitionFragmentShader,
  createRenderComparisonFixture,
  listFragmentEffects,
  listTransitions,
  renderComparisonFixtureKeys,
  timelineEffectRegistry,
} from "@orreris/shared";
import { FULLSCREEN_TRI_VS, GLSL_TYPE, PipelineAssembler } from "@orreris/shared";

type Light = "display" | "linear";
const LIGHTS: Light[] = ["display", "linear"];

interface ShaderCase {
  label: string;
  light: Light;
  source: string;
}

// ---------------------------------------------------------------------------------------------
// Coverage: which registry entries any fixture actually renders.
// ---------------------------------------------------------------------------------------------

function coverage(): { effects: Set<string>; transitions: Set<string> } {
  const effects = new Set<string>();
  const transitions = new Set<string>();
  // Widened to `string` deliberately: these are membership tests against arbitrary walked JSON, not
  // typed lookups, and narrowing them to the registry's own union makes `.has(someString)` a type
  // error without making the check any more correct.
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

// ---------------------------------------------------------------------------------------------
// Every shader source both renderers could be asked to compile.
// ---------------------------------------------------------------------------------------------

function collectCases(): ShaderCase[] {
  const cases: ShaderCase[] = [];

  for (const def of listFragmentEffects()) {
    for (const light of LIGHTS) {
      if (def.passes && def.passes.length > 0) {
        // Multi-pass: every pass is its own program, so every pass must be compiled. Note the second
        // argument is the pass OBJECT, not its index — passing an index yields `pass.glsl ===
        // undefined` and an assembled source containing the literal text `undefined`, which fails as
        // `'undefined' : syntax error` and looks exactly like a real defect in the effect.
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
        // Exactly what `prepareTransition` hands the assembler — the arrangement 6d58690 found broken.
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

// ---------------------------------------------------------------------------------------------

/**
 * The PRODUCT'S OWN fullscreen-triangle vertex shader, imported rather than written here.
 *
 * A hand-rolled stub that only wrote `gl_Position` produced `0/128 linked`, every one reporting
 * `FRAGMENT varying v_uv does not match any VERTEX varying` — including `crossDissolve`, which
 * demonstrably renders in green fixtures today. A probe that fails uniformly is measuring itself:
 * the link stage is a contract between TWO shaders, so the vertex half has to be the real one or
 * every result is about the stub.
 */
const VERTEX = FULLSCREEN_TRI_VS;

async function main(): Promise<void> {
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

  if (process.argv.includes("--coverage")) return;

  const cases = collectCases();
  console.log(`\n── compiling ${cases.length} shader source(s) against a real WebGL2 context ──`);

  const channel = process.env.PIXEL_BROWSER_CHANNEL;
  const browser = await chromium.launch(channel ? { channel } : {});
  try {
    const page = await browser.newPage();
    await page.goto("about:blank");
    const results = await page.evaluate(
      ({ cases, VERTEX }: { cases: ShaderCase[]; VERTEX: string }) => {
        const canvas = document.createElement("canvas");
        const gl = canvas.getContext("webgl2");
        if (!gl) return [{ label: "(context)", light: "display", ok: false, log: "no webgl2 context" }];
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
      { cases, VERTEX }
    );

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
