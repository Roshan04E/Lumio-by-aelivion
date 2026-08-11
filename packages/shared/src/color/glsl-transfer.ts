/**
 * The shared GLSL transfer pair — one definition, for the same reason `glsl-hash.ts` has one.
 *
 * The linear-light effect stage (`plans/linear-light-effect-stage.md`) decodes at its entry and
 * encodes at its exit, and those two conversions appear in more than one shader: the compositor's
 * plate/blur/pyramid passes, and the fragment-effect harness. Written twice, they can drift by a
 * segment or a constant, and the resulting picture looks like a grading bug rather than a
 * colour-space bug — so whoever debugs it looks in the wrong subsystem. `glsl-hash.ts` exists because
 * exactly that happened with a `sin`-based hash; this is the same lesson applied before the fact.
 *
 * These are the exact GLSL twins of `rec709CodeToLinear` / `rec709LinearToCode`
 * (`color-management.ts`), which the GRADE stage already uses — so "linear" means one thing in this
 * product rather than one thing per stage.
 *
 * A second property makes the boundary exact rather than merely consistent: this piecewise curve IS
 * the sRGB transfer function, which is what `SRGB8_ALPHA8` hardware applies on every sample and
 * write. A shader decode followed by the fixed-function encode is therefore an identity round trip,
 * and an intermediate stores the source's original bytes back.
 *
 * Included in an assembled shader ONLY when that shader runs in linear light. A display-referred
 * shader's source stays byte-identical to what it was before this file existed, which is what lets
 * the display path's byte-identity be a property of the source rather than an argument about
 * optimiser behaviour.
 */
export const GLSL_TRANSFER_PRELUDE = `
vec3 sceneToLinear(vec3 c){
  return mix(c / 12.92, pow(max(c + 0.055, vec3(0.0)) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
vec3 sceneToDisplay(vec3 c){
  vec3 hi = 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
  return mix(c * 12.92, hi, step(vec3(0.0031308), c));
}`;
