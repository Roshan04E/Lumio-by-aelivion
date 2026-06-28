/**
 * Professional Color System (Phase 3) — WebGL shader source for the 3D-LUT backbone.
 * Shared so the web preview and the Remotion export run the IDENTICAL program (both are
 * Chromium) — parity by construction, like the SVG path. The fragment shader samples the
 * baked 3D LUT with hardware trilinear filtering (WebGL2 `sampler3D`, LINEAR), at float
 * precision. `mix` lets the effect's intensity blend toward the original.
 *
 * Only strings + a texture packer live here (no GL context); the renderer creates the
 * context, uploads the LUT via `texImage3D`, and draws the layer frame through this.
 */

import type { Lut3d } from "./lut3d";

/** Fullscreen-quad vertex shader (WebGL2 / GLSL ES 3.00). */
export const COLOR_VERTEX_SHADER = `#version 300 es
in vec2 a_position;
out vec2 v_uv;
void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

/**
 * Fragment shader: sample the source frame, then look up the 3D LUT with **manual
 * trilinear** interpolation (8 `texelFetch` taps + blend). Manual — not hardware
 * `LINEAR` — so it works with float 3D textures even where `OES_texture_float_linear`
 * is absent (e.g. headless Chromium / SwiftShader on the render farm). This mirrors the
 * CPU `sampleLut3d` exactly. `u_amount` blends toward the graded result (effect intensity).
 */
export const COLOR_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_frame;
uniform sampler3D u_lut;
uniform float u_lutSize;
uniform float u_amount;

vec3 lutLookup(vec3 c) {
  float n = u_lutSize;
  vec3 p = clamp(c, 0.0, 1.0) * (n - 1.0);
  ivec3 b0 = ivec3(floor(p));
  ivec3 b1 = min(b0 + ivec3(1), ivec3(int(n) - 1));
  vec3 f = p - vec3(b0);
  vec3 c000 = texelFetch(u_lut, ivec3(b0.x, b0.y, b0.z), 0).rgb;
  vec3 c100 = texelFetch(u_lut, ivec3(b1.x, b0.y, b0.z), 0).rgb;
  vec3 c010 = texelFetch(u_lut, ivec3(b0.x, b1.y, b0.z), 0).rgb;
  vec3 c110 = texelFetch(u_lut, ivec3(b1.x, b1.y, b0.z), 0).rgb;
  vec3 c001 = texelFetch(u_lut, ivec3(b0.x, b0.y, b1.z), 0).rgb;
  vec3 c101 = texelFetch(u_lut, ivec3(b1.x, b0.y, b1.z), 0).rgb;
  vec3 c011 = texelFetch(u_lut, ivec3(b0.x, b1.y, b1.z), 0).rgb;
  vec3 c111 = texelFetch(u_lut, ivec3(b1.x, b1.y, b1.z), 0).rgb;
  vec3 c00 = mix(c000, c100, f.x);
  vec3 c10 = mix(c010, c110, f.x);
  vec3 c01 = mix(c001, c101, f.x);
  vec3 c11 = mix(c011, c111, f.x);
  return mix(mix(c00, c10, f.y), mix(c01, c11, f.y), f.z);
}

void main() {
  vec4 src = texture(u_frame, v_uv);
  fragColor = vec4(mix(src.rgb, lutLookup(src.rgb), u_amount), src.a);
}`;

/**
 * Pack a `Lut3d` (RGB triples) into an RGBA Float32 buffer for `gl.texImage3D`
 * (alpha = 1). Layout matches `bakePipelineToLut3d`: r fastest, then g, then b.
 */
export function lut3dToRgbaFloat(lut: Lut3d): Float32Array {
  const { size, data } = lut;
  const out = new Float32Array(size * size * size * 4);
  const count = size * size * size;
  for (let i = 0; i < count; i += 1) {
    out[i * 4] = data[i * 3]!;
    out[i * 4 + 1] = data[i * 3 + 1]!;
    out[i * 4 + 2] = data[i * 3 + 2]!;
    out[i * 4 + 3] = 1;
  }
  return out;
}
