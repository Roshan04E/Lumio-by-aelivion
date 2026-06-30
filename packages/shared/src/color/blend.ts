/**
 * Blend modes for the single GPU compositor (Method 3, Phase 1).
 *
 * The DOM/Remotion renderers blend via CSS `mix-blend-mode` and the canvas2D export via
 * `globalCompositeOperation` (both mapped in `composition-style.ts`: `cssBlendMode` / `canvasBlendOp`).
 * The GPU compositor can't use fixed-function blending for the separable/non-separable modes
 * (multiply, overlay, hue, …) — they must be computed in-shader, reading the backdrop as a texture.
 *
 * `BLEND_GLSL` is that in-shader implementation, and `blendComposeJs` is a line-for-line JS port used
 * by the parity test (`blend:test`) and available as a CPU reference. Both follow the W3C Compositing
 * and Blending Level 1 spec on **straight-alpha** colors — the same straight-alpha sRGB pixels the
 * per-clip `MediaWebGLRenderer` produces — so the GPU result matches what CSS/canvas produce today.
 *
 * `blendModeIndex` is the single mode→int mapping shared by the shader uniform and the JS port; it is
 * the GPU sibling of the `BLEND_CSS` / `BLEND_CANVAS` tables and must stay in lockstep with them.
 */

import type { BlendMode } from "../types";

/** Mode → shader uniform index. Order is the contract between `BLEND_GLSL` and `blendComposeJs`. */
export const BLEND_MODE_INDEX: Record<BlendMode, number> = {
  normal: 0,
  multiply: 1,
  screen: 2,
  overlay: 3,
  darken: 4,
  lighten: 5,
  "color-dodge": 6,
  "color-burn": 7,
  "hard-light": 8,
  "soft-light": 9,
  difference: 10,
  exclusion: 11,
  hue: 12,
  saturation: 13,
  color: 14,
  luminosity: 15,
  add: 16,
};

export function blendModeIndex(mode: BlendMode | undefined): number {
  return mode ? BLEND_MODE_INDEX[mode] ?? 0 : 0;
}

/**
 * GLSL (ES 3.00) implementation. Provides `vec4 blendCompose(int mode, vec4 dest, vec4 src)` which
 * composites `src` over `dest` (both straight-alpha) using the blend function selected by `mode`.
 */
export const BLEND_GLSL = `
float _bMul(float b,float s){ return b*s; }
float _bScreen(float b,float s){ return b+s-b*s; }
float _bHard(float b,float s){ return s<=0.5 ? _bMul(b,2.0*s) : _bScreen(b,2.0*s-1.0); }
float _bOverlay(float b,float s){ return _bHard(s,b); }
float _bDodge(float b,float s){ return b<=0.0 ? 0.0 : (s>=1.0 ? 1.0 : min(1.0, b/(1.0-s))); }
float _bBurn(float b,float s){ return b>=1.0 ? 1.0 : (s<=0.0 ? 0.0 : 1.0-min(1.0,(1.0-b)/s)); }
float _bSoft(float b,float s){
  float d = b<=0.25 ? ((16.0*b-12.0)*b+4.0)*b : sqrt(b);
  return s<=0.5 ? b-(1.0-2.0*s)*b*(1.0-b) : b+(2.0*s-1.0)*(d-b);
}
float _bDiff(float b,float s){ return abs(b-s); }
float _bExcl(float b,float s){ return b+s-2.0*b*s; }

float _lum(vec3 c){ return dot(c, vec3(0.3,0.59,0.11)); }
vec3 _clipColor(vec3 c){
  float l=_lum(c);
  float n=min(min(c.r,c.g),c.b);
  float x=max(max(c.r,c.g),c.b);
  if(n<0.0) c = l + (c-l)*l/max(l-n,1e-6);
  if(x>1.0) c = l + (c-l)*(1.0-l)/max(x-l,1e-6);
  return c;
}
vec3 _setLum(vec3 c, float l){ return _clipColor(c + (l-_lum(c))); }
vec3 _setSat(vec3 c, float s){
  float mn=min(min(c.r,c.g),c.b);
  float mx=max(max(c.r,c.g),c.b);
  return mx>mn ? (c-mn)*s/(mx-mn) : vec3(0.0);
}
float _sat(vec3 c){ return max(max(c.r,c.g),c.b)-min(min(c.r,c.g),c.b); }

vec3 _blendFn(int mode, vec3 cb, vec3 cs){
  if(mode==1)  return vec3(_bMul(cb.r,cs.r), _bMul(cb.g,cs.g), _bMul(cb.b,cs.b));
  if(mode==2)  return vec3(_bScreen(cb.r,cs.r), _bScreen(cb.g,cs.g), _bScreen(cb.b,cs.b));
  if(mode==3)  return vec3(_bOverlay(cb.r,cs.r), _bOverlay(cb.g,cs.g), _bOverlay(cb.b,cs.b));
  if(mode==4)  return min(cb,cs);
  if(mode==5)  return max(cb,cs);
  if(mode==6)  return vec3(_bDodge(cb.r,cs.r), _bDodge(cb.g,cs.g), _bDodge(cb.b,cs.b));
  if(mode==7)  return vec3(_bBurn(cb.r,cs.r), _bBurn(cb.g,cs.g), _bBurn(cb.b,cs.b));
  if(mode==8)  return vec3(_bHard(cb.r,cs.r), _bHard(cb.g,cs.g), _bHard(cb.b,cs.b));
  if(mode==9)  return vec3(_bSoft(cb.r,cs.r), _bSoft(cb.g,cs.g), _bSoft(cb.b,cs.b));
  if(mode==10) return vec3(_bDiff(cb.r,cs.r), _bDiff(cb.g,cs.g), _bDiff(cb.b,cs.b));
  if(mode==11) return vec3(_bExcl(cb.r,cs.r), _bExcl(cb.g,cs.g), _bExcl(cb.b,cs.b));
  if(mode==12) return _setLum(_setSat(cs, _sat(cb)), _lum(cb));
  if(mode==13) return _setLum(_setSat(cb, _sat(cs)), _lum(cb));
  if(mode==14) return _setLum(cs, _lum(cb));
  if(mode==15) return _setLum(cb, _lum(cs));
  return cs; // mode 0 normal
}

vec4 blendCompose(int mode, vec4 dest, vec4 src){
  float ab = dest.a; vec3 cb = dest.rgb;
  float as = src.a;  vec3 cs = src.rgb;
  if(mode==16){ // add / plus-lighter compositing operator
    vec3 co = cs*as + cb*ab;
    float ao = min(1.0, as + ab);
    return vec4(ao>0.0 ? co/ao : vec3(0.0), ao);
  }
  vec3 B = _blendFn(mode, cb, cs);
  vec3 co = as*(1.0-ab)*cs + as*ab*B + (1.0-as)*ab*cb;
  float ao = as + ab*(1.0-as);
  return vec4(ao>0.0 ? co/ao : vec3(0.0), ao);
}
`;

// ---------------------------------------------------------------------------
// JS reference port — kept line-for-line with BLEND_GLSL for the parity test.
// ---------------------------------------------------------------------------

export type Rgba = [number, number, number, number];
type V3 = [number, number, number];

const mul = (b: number, s: number) => b * s;
const scr = (b: number, s: number) => b + s - b * s;
const hard = (b: number, s: number) => (s <= 0.5 ? mul(b, 2 * s) : scr(b, 2 * s - 1));
const overlay = (b: number, s: number) => hard(s, b);
const dodge = (b: number, s: number) => (b <= 0 ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s)));
const burn = (b: number, s: number) => (b >= 1 ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s));
const soft = (b: number, s: number) => {
  const d = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b);
  return s <= 0.5 ? b - (1 - 2 * s) * b * (1 - b) : b + (2 * s - 1) * (d - b);
};
const diff = (b: number, s: number) => Math.abs(b - s);
const excl = (b: number, s: number) => b + s - 2 * b * s;

const lum = (c: V3) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
function clipColor(c: V3): V3 {
  const l = lum(c);
  const n = Math.min(c[0], c[1], c[2]);
  const x = Math.max(c[0], c[1], c[2]);
  const lo = (v: number) => (n < 0 ? l + ((v - l) * l) / Math.max(l - n, 1e-6) : v);
  let r: V3 = [lo(c[0]), lo(c[1]), lo(c[2])];
  if (x > 1) {
    const hi = (v: number) => l + ((v - l) * (1 - l)) / Math.max(x - l, 1e-6);
    r = [hi(r[0]), hi(r[1]), hi(r[2])];
  }
  return r;
}
function setLum(c: V3, l: number): V3 {
  const d = l - lum(c);
  return clipColor([c[0] + d, c[1] + d, c[2] + d]);
}
const satOf = (c: V3) => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
function setSat(c: V3, s: number): V3 {
  const mn = Math.min(c[0], c[1], c[2]);
  const mx = Math.max(c[0], c[1], c[2]);
  if (mx <= mn) return [0, 0, 0];
  const k = s / (mx - mn);
  return [(c[0] - mn) * k, (c[1] - mn) * k, (c[2] - mn) * k];
}

function blendFn(mode: number, cb: V3, cs: V3): V3 {
  const ch = (f: (b: number, s: number) => number): V3 => [f(cb[0], cs[0]), f(cb[1], cs[1]), f(cb[2], cs[2])];
  switch (mode) {
    case 1: return ch(mul);
    case 2: return ch(scr);
    case 3: return ch(overlay);
    case 4: return [Math.min(cb[0], cs[0]), Math.min(cb[1], cs[1]), Math.min(cb[2], cs[2])];
    case 5: return [Math.max(cb[0], cs[0]), Math.max(cb[1], cs[1]), Math.max(cb[2], cs[2])];
    case 6: return ch(dodge);
    case 7: return ch(burn);
    case 8: return ch(hard);
    case 9: return ch(soft);
    case 10: return ch(diff);
    case 11: return ch(excl);
    case 12: return setLum(setSat(cs, satOf(cb)), lum(cb));
    case 13: return setLum(setSat(cb, satOf(cs)), lum(cb));
    case 14: return setLum(cs, lum(cb));
    case 15: return setLum(cb, lum(cs));
    default: return cs;
  }
}

/** JS reference of `blendCompose` — composites straight-alpha `src` over `dest` in mode. */
export function blendComposeJs(mode: number, dest: Rgba, src: Rgba): Rgba {
  const ab = dest[3];
  const cb: V3 = [dest[0], dest[1], dest[2]];
  const as = src[3];
  const cs: V3 = [src[0], src[1], src[2]];
  if (mode === 16) {
    const ao = Math.min(1, as + ab);
    const co: V3 = [cs[0] * as + cb[0] * ab, cs[1] * as + cb[1] * ab, cs[2] * as + cb[2] * ab];
    return ao > 0 ? [co[0] / ao, co[1] / ao, co[2] / ao, ao] : [0, 0, 0, ao];
  }
  const B = blendFn(mode, cb, cs);
  const f = (v: number, b: number, db: number) => as * (1 - ab) * v + as * ab * b + (1 - as) * ab * db;
  const ao = as + ab * (1 - as);
  const co: V3 = [f(cs[0], B[0], cb[0]), f(cs[1], B[1], cb[1]), f(cs[2], B[2], cb[2])];
  return ao > 0 ? [co[0] / ao, co[1] / ao, co[2] / ao, ao] : [0, 0, 0, ao];
}
