import {
  ATOMIC_MODULES,
  type TransitionPassModuleId,
} from "./pipeline";
import { HARNESS_PRELUDE } from "./registry";

/**
 * Standard uniforms every assembled pass shader declares. Module `uniforms` entries that collide with
 * these are skipped at assembly (GLSL ES 3.0 forbids duplicate uniform declarations) — modules may list
 * them for documentation, e.g. "sample-source" declaring `sampler2D uFrom`.
 */
const STANDARD_UNIFORM_NAMES = new Set([
  "uSrc",
  "uFrom",
  "uTo",
  "progress",
  "resolution",
  "ratio",
  "uFromFit",
  "uToFit",
]);

function uniformName(decl: string): string {
  const parts = decl.trim().split(/\s+/);
  return parts[parts.length - 1] ?? "";
}

/**
 * PipelineAssembler converts a TransitionPipeline definition into executable GPU pass shaders.
 *
 * Each pass module defines `vec4 passMain(vec2 uv)` and is wrapped in the SAME `#version 300 es`
 * harness + HARNESS_PRELUDE the monolith transitions use (getFromColor/getToColor/_fitUv/...), plus
 * `getSrcColor(uv)` which samples the PREVIOUS pass's output (`uSrc` — the ping-pong input; on the
 * first pass callers bind the outgoing side). Because the assembled source is identical across the
 * web preview, browser export, and Remotion, multi-pass transitions stay pixel-aligned by construction.
 */
export class PipelineAssembler {
  /** Assemble the full fragment shader for one pipeline pass. */
  static assemblePassShader(moduleId: TransitionPassModuleId, extraUniforms: string[] = []): string {
    const module = ATOMIC_MODULES[moduleId];
    if (!module) throw new Error(`Unknown transition module: ${moduleId}`);

    const moduleUniforms = [...module.uniforms, ...extraUniforms]
      .filter((u) => !STANDARD_UNIFORM_NAMES.has(uniformName(u)))
      .map((u) => `uniform ${u};`)
      .join("\n");

    return `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D uSrc;    // previous pass output (first pass: the outgoing side)
uniform sampler2D uFrom;   // outgoing clip, graded
uniform sampler2D uTo;     // incoming clip, graded
uniform float progress;    // 0..1, already eased
uniform vec2 resolution;
uniform float ratio;       // resolution.x / resolution.y
uniform vec2 uFromFit;     // object-fit uv scale for the outgoing texture
uniform vec2 uToFit;       // object-fit uv scale for the incoming texture
${moduleUniforms}
${HARNESS_PRELUDE}
// Previous pass output — pipeline passes chain through this (comp-sized, fit already applied upstream).
vec4 getSrcColor(vec2 uv){ return texture(uSrc, clamp(uv, 0.0, 1.0)); }

${module.glsl}

void main() {
  fragColor = passMain(v_uv);
}
`;
  }
}
