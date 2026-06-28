/**
 * Local export — WebGL2 perspective-quad compositor (Phase #2: 3D tilt).
 *
 * Canvas 2D only has an affine matrix, so it can't reproduce the editor's CSS
 * `perspective()/rotateX/rotateY` tilt. This draws a layer's already-rendered (flat, graded)
 * comp-size buffer as a textured quad, projecting its 4 corners through the SAME transform CSS
 * applies — `perspective · translateZ · rotateZ · rotateX · rotateY · scale`, about the layer's
 * center — with a perspective-correct vertex `w` so the texture doesn't shear. Output is a
 * transparent comp-size canvas the caller composites onto the frame with drawImage.
 *
 * Texture orientation matches MediaWebGLRenderer (UNPACK_FLIP_Y = true), so a quad with no tilt
 * is pixel-identical to the 2D drawImage path.
 */

export interface Quad3DTransform {
  centerX: number; // layer center in comp pixels (transform.x% · width)
  centerY: number;
  // The ELEMENT box half-extents in comp px (unscaled). Use the text/shape's own size — NOT the
  // full comp — so a short perspective doesn't push far corners behind the camera (which would
  // clamp and distort). Media's element IS comp-size, so it passes width/2, height/2.
  halfWidth: number;
  halfHeight: number;
  scale: number;
  rotation: number; // deg, in-plane (rotateZ)
  rotateX: number; // deg
  rotateY: number; // deg
  perspective: number; // px (0 = none)
  z: number; // translateZ px
}

const VERTEX_SHADER = `#version 300 es
in vec3 a_posw;   // ndc.x, ndc.y, projective w
in vec2 a_uv;
out vec2 v_uv;
void main() {
  v_uv = a_uv;
  float w = a_posw.z;
  // Pre-multiply by w so the GPU's perspective divide restores ndc and interpolates v_uv
  // perspective-correctly across the tilted quad.
  gl_Position = vec4(a_posw.xy * w, 0.0, w);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
out vec4 fragColor;
void main() {
  fragColor = texture(u_tex, v_uv);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("quad-3d: createShader failed");
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`quad-3d: shader compile failed: ${log ?? "unknown"}`);
  }
  return shader;
}

const DEG = Math.PI / 180;

export class Quad3DCompositor {
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly vbo: WebGLBuffer;
  private readonly tex: WebGLTexture;
  private readonly width: number;
  private readonly height: number;
  // 6 vertices (2 triangles) × (ndcX, ndcY, w, u, v).
  private readonly data = new Float32Array(6 * 5);
  private disposed = false;

  constructor(width: number, height: number, canvas: HTMLCanvasElement | OffscreenCanvas) {
    this.width = width;
    this.height = height;
    this.canvas = canvas;
    canvas.width = width;
    canvas.height = height;
    const gl = canvas.getContext("webgl2", { premultipliedAlpha: false, alpha: true }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error("quad-3d: WebGL2 unavailable");
    this.gl = gl;

    const vs = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    const program = gl.createProgram();
    if (!program) throw new Error("quad-3d: createProgram failed");
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`quad-3d: link failed: ${gl.getProgramInfoLog(program) ?? "unknown"}`);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    this.program = program;

    const vao = gl.createVertexArray();
    const vbo = gl.createBuffer();
    if (!vao || !vbo) throw new Error("quad-3d: buffer alloc failed");
    this.vao = vao;
    this.vbo = vbo;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
    const stride = 5 * 4;
    const aPosw = gl.getAttribLocation(program, "a_posw");
    const aUv = gl.getAttribLocation(program, "a_uv");
    gl.enableVertexAttribArray(aPosw);
    gl.vertexAttribPointer(aPosw, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(aUv);
    gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, stride, 3 * 4);
    gl.bindVertexArray(null);

    const tex = gl.createTexture();
    if (!tex) throw new Error("quad-3d: texture alloc failed");
    this.tex = tex;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  }

  /** Project one comp-corner (relative to the layer center) to clip space + projective w. */
  private project(localX: number, localY: number, t: Quad3DTransform): [number, number, number] {
    const s = t.scale;
    let x = localX * s;
    let y = localY * s;
    let z = 0;

    // CSS list `rotate(rot) rotateX(rx) rotateY(ry) scale(s)` applied to a point is
    // Rz·Rx·Ry·S·p — so after scale, apply rotateY, then rotateX, then rotateZ.
    const cy = Math.cos(t.rotateY * DEG);
    const sy = Math.sin(t.rotateY * DEG);
    let nx = cy * x + sy * z;
    let nz = -sy * x + cy * z;
    x = nx;
    z = nz;

    const cx = Math.cos(t.rotateX * DEG);
    const sx = Math.sin(t.rotateX * DEG);
    let ny = cx * y - sx * z;
    nz = sx * y + cx * z;
    y = ny;
    z = nz;

    const cz = Math.cos(t.rotation * DEG);
    const sz = Math.sin(t.rotation * DEG);
    nx = cz * x - sz * y;
    ny = sz * x + cz * y;
    x = nx;
    y = ny;

    // CSS `translate3d(-50%,-50%,z)` is applied in 3D BEFORE the perspective divide (it sits
    // inside perspective() in the transform list), using the element's border-box half-extents.
    // The transform-origin (box center) is then added back AFTER the divide. Omitting this term
    // is why perspective tilt didn't match (the term is 0 only when w=1, i.e. no perspective).
    const tx = x - t.halfWidth;
    const ty = y - t.halfHeight;
    const tz = z + t.z;

    // CSS perspective: homogeneous w = 1 - z/P; clamp so a corner near/behind the camera
    // doesn't blow up to infinity (CSS clips those; we just avoid NaNs).
    const w = t.perspective > 0 ? Math.max(1 - tz / t.perspective, 0.01) : 1;
    const screenX = t.centerX + t.halfWidth + tx / w;
    const screenY = t.centerY + t.halfHeight + ty / w;
    const ndcX = (screenX / this.width) * 2 - 1;
    const ndcY = 1 - (screenY / this.height) * 2;
    return [ndcX, ndcY, w];
  }

  /** Draw `source` (a flat comp-size layer buffer) tilted into this.canvas. */
  draw(source: TexImageSource, t: Quad3DTransform): void {
    if (this.disposed) return;
    const gl = this.gl;

    // Render a hair beyond the element box so strokes/shadows that bleed past the border box
    // aren't clipped. The projection's translate term still uses the REAL box half-extents
    // (t.halfWidth/Height inside project()), so this padding only extends coverage along the
    // same plane — it does NOT change the geometry/perspective.
    const RENDER_PAD = 1.12;
    const phw = t.halfWidth * RENDER_PAD;
    const phh = t.halfHeight * RENDER_PAD;

    // The drawn rectangle within the (comp-size) source buffer → its sub-rectangle UVs.
    const left = t.centerX - phw;
    const right = t.centerX + phw;
    const top = t.centerY - phh;
    const bottom = t.centerY + phh;
    const uL = left / this.width;
    const uR = right / this.width;
    const vTop = 1 - top / this.height; // FLIP_Y upload: source top → v = 1
    const vBot = 1 - bottom / this.height;

    // Corners projected on the element's plane (extrapolated past the box by RENDER_PAD), so a
    // short perspective stays in front of the camera and matches CSS instead of clamping.
    const tl = this.project(-phw, -phh, t);
    const tr = this.project(phw, -phh, t);
    const br = this.project(phw, phh, t);
    const bl = this.project(-phw, phh, t);
    const v = this.data;
    const put = (i: number, p: [number, number, number], u: number, vv: number) => {
      v[i] = p[0];
      v[i + 1] = p[1];
      v[i + 2] = p[2];
      v[i + 3] = u;
      v[i + 4] = vv;
    };
    // Triangle 1: TL, TR, BR — Triangle 2: TL, BR, BL.
    put(0, tl, uL, vTop);
    put(5, tr, uR, vTop);
    put(10, br, uR, vBot);
    put(15, tl, uL, vTop);
    put(20, br, uR, vBot);
    put(25, bl, uL, vBot);

    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);

    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND); // single quad onto a cleared surface — write straight RGBA

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, v);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(gl.getUniformLocation(this.program, "u_tex"), 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    gl.deleteTexture(this.tex);
    gl.deleteBuffer(this.vbo);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.program);
  }
}
