/**
 * Modular GPU Transition Pipeline types.
 *
 * Instead of a single monolith fragment shader, complex transitions
 * are defined as a sequence of passes.
 */

export type TransitionPassModuleId =
  | "sample-source"    // Basic texture sampling
  | "sample-mask"      // AI/Procedural mask sampling
  | "radial-warp"      // Spherical/Cylindrical distortion
  | "perspective-warp" // 4-point corner pin
  | "curl-noise"       // Fluid-like displacement
  | "gaussian-blur"    // High-quality blur (usually 2 passes)
  | "directional-blur" // Motion smear
  | "luma-mix"         // Luminance-weighted composite
  | "linear-mix"       // Standard blend
  | "additive-mix"     // Light leak / Glow blend
  | "chromatic-split"  // RGB offset
  | "bokeh-blur";      // Physical lens blur

export interface TransitionPass {
  /** The atomic shader module to execute. */
  moduleId: TransitionPassModuleId;
  /** Which textures are required as input (e.g., "uFrom", "uTo", "uMask", "prevPass"). */
  inputs: string[];
  /** Pass-specific parameter overrides. */
  params?: Record<string, any>;
}

export interface TransitionPipeline {
  /** The sequence of passes to execute. */
  passes: TransitionPass[];
}

/**
 * Maps atomic module IDs to their GLSL implementation fragments.
 * These fragments are expected to define a `vec4 passMain(vec2 uv, ...)`
 * or be injected into a larger shader.
 */
export const ATOMIC_MODULES: Record<TransitionPassModuleId, {
  glsl: string;
  uniforms: string[];
}> = {
  "sample-source": {
    uniforms: ["sampler2D uFrom", "sampler2D uTo"],
    glsl: `vec4 passMain(vec2 uv) {
      // This is a base pass: we usually just want the outgoing side as a starting point
      return getFromColor(uv);
    }`
  },
  "linear-mix": {
    uniforms: ["float progress"],
    glsl: `vec4 passMain(vec2 uv) {
      vec4 a = getFromColor(uv);
      vec4 b = getToColor(uv);
      return mix(a, b, progress);
    }`
  },
  // More modules will be added here as we implement the transitions
};
