vec4 transition(vec2 uv) {
  float edge = smoothstep(progress - 0.12, progress + 0.12, uv.x);
  return mix(getFromColor(uv), getToColor(uv), edge);
}
