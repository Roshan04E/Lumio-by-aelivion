/**
 * WebGL2 shaders for the timeline waveform surface (Phase 2B). The fragment shader reproduces the
 * FROZEN Phase-1 Canvas look (WAVEFORM_QA.md): a peak-fill mass, a brighter tinted RMS body with a
 * subtle vertical sheen, an integrated peak-edge rim, and a faint zero baseline — composited in the
 * same bottom→top order as the Canvas renderer so pixels match. It samples the source's peak/rms
 * texture with a bounded MAX over each pixel's texel span (not GPU linear averaging) so the peak
 * envelope is preserved exactly like the Canvas max-per-pixel resample.
 *
 * Per-instance geometry is a unit quad expanded to each visible clip's viewport rect; per-source
 * data is a single RGBA8 texture (R=peak, G=rms). Constants mirror the Canvas WF_* values.
 */

export const WAVEFORM_VERT = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aUnit;    // shared unit quad corner (0..1, 0..1)
layout(location = 1) in vec4 aRect;    // x, width, laneTop, laneHeight (px, canvas space)
layout(location = 2) in vec2 aTrim;    // inFrac, outFrac (source-fraction window under the clip)
layout(location = 3) in vec3 aTint;    // clip tint (0..1 rgb)
layout(location = 4) in float aState;  // state alpha (muted 0.35, else 1)

uniform vec2 uViewport;                // canvas width, height (px)

out float vU;
out float vY;
out vec2 vTrim;
out vec3 vTint;
out float vState;
out float vLaneHeight;

void main() {
  float px = aRect.x + aUnit.x * aRect.y;
  float py = aRect.z + aUnit.y * aRect.w;
  vec2 clip = vec2(px / uViewport.x * 2.0 - 1.0, 1.0 - py / uViewport.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
  vU = aUnit.x;
  vY = aUnit.y;
  vTrim = aTrim;
  vTint = aTint;
  vState = aState;
  vLaneHeight = aRect.w;
}`;

export const WAVEFORM_FRAG = /* glsl */ `#version 300 es
precision highp float;

in float vU;
in float vY;
in vec2 vTrim;
in vec3 vTint;
in float vState;
in float vLaneHeight;

uniform sampler2D uSampler;
uniform float uTexWidth;

out vec4 outColor;

const float GAIN = 1.18;   // WF_DISPLAY_GAIN
const float AMP = 0.86;    // WF_MAX_AMP (0.43) expressed in half-lane units

vec3 lighten(vec3 c, float t) { return c + (1.0 - c) * t; }

// Straight-alpha "source over destination" compositing (matches Canvas layering).
vec4 over(vec4 s, vec4 d) {
  float a = s.a + d.a * (1.0 - s.a);
  if (a <= 0.0) return vec4(0.0);
  vec3 rgb = (s.rgb * s.a + d.rgb * d.a * (1.0 - s.a)) / a;
  return vec4(rgb, a);
}

void main() {
  float t = mix(vTrim.x, vTrim.y, vU);
  float dtdx = abs(dFdx(t));
  float span = dtdx * uTexWidth;            // texels this pixel spans
  int steps = int(clamp(ceil(span), 1.0, 16.0));
  float t0 = t - dtdx * 0.5;
  float mx = 0.0;  // top excursion (R)
  float mn = 0.0;  // bottom excursion magnitude (B)
  float rms = 0.0; // body (G)
  for (int i = 0; i < 16; i++) {
    if (i >= steps) break;
    float tt = t0 + (float(i) + 0.5) / float(steps) * dtdx;
    vec3 texel = texture(uSampler, vec2(clamp(tt, 0.0, 1.0), 0.5)).rgb;
    mx = max(mx, texel.r);
    rms = max(rms, texel.g);
    mn = max(mn, texel.b);
  }

  // Signed vertical coordinate: -1 at the top edge, 0 at centre, +1 at the bottom edge.
  float ys = (vY - 0.5) * 2.0;
  float aa = fwidth(ys) + 1e-4;
  float floorN = 1.0 / max(vLaneHeight, 1.0); // ~0.5px hairline
  float topAmp = max(min(1.0, mx * GAIN) * AMP, floorN);   // extends upward (negative ys)
  float botAmp = max(min(1.0, mn * GAIN) * AMP, floorN);   // extends downward (positive ys)
  float rmsAmp = min(1.0, rms * GAIN) * AMP;
  float yabs = abs(ys);

  vec3 bodyRgb = lighten(vTint, 0.34);
  vec3 peakFillRgb = lighten(vTint, 0.55);
  vec3 peakEdgeRgb = lighten(vTint, 0.6);

  // Bipolar peak fill: inside the [-topAmp, +botAmp] band.
  float peakMask = smoothstep(-topAmp - aa, -topAmp + aa, ys) * (1.0 - smoothstep(botAmp - aa, botAmp + aa, ys));
  float bodyMask = 1.0 - smoothstep(rmsAmp - aa, rmsAmp + aa, yabs);
  // Edge rim just inside each contour (top uses topAmp, bottom uses botAmp).
  float edgeW = 3.0 * floorN;
  float topEdge = (1.0 - smoothstep(-topAmp + aa, -topAmp, ys)) * smoothstep(-topAmp, -topAmp + edgeW + aa, ys);
  float botEdge = smoothstep(botAmp - aa, botAmp, ys) * (1.0 - smoothstep(botAmp - edgeW - aa, botAmp, ys));
  float edgeMask = clamp(topEdge + botEdge, 0.0, 1.0);
  float sheen = mix(0.92, 1.0, clamp(yabs / max(rmsAmp, 1e-3), 0.0, 1.0));

  // Thin zero-crossing seam splitting the top/bottom halves (DaVinci-style), ~1px at centre.
  float seamW = 1.2 * floorN;
  float seamMask = 1.0 - smoothstep(seamW - aa, seamW + aa, yabs);

  vec4 acc = vec4(0.0, 0.0, 0.0, 0.0);
  acc = over(vec4(peakFillRgb, 0.42 * peakMask), acc);        // bipolar peak fill
  acc = over(vec4(bodyRgb, 0.78 * sheen * bodyMask), acc);    // RMS body
  acc = over(vec4(peakEdgeRgb, 0.3 * edgeMask), acc);         // edge rim
  acc = over(vec4(0.0, 0.0, 0.0, 0.22 * seamMask), acc);     // zero-crossing seam (top)

  outColor = vec4(acc.rgb, acc.a * vState);
}`;
