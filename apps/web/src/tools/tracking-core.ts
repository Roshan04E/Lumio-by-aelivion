/**
 * Pure, DOM-free point-tracking math shared by the main thread
 * (local-tracking.ts, for the no-Worker fallback) and the tracking worker.
 * No imports from anywhere that touches `document`/`canvas`/`Worker`, so this
 * module is safe to import from a Worker entry file.
 *
 * Tracking method: normalized cross-correlation (NCC) template matching with
 * subpixel parabola refinement. NCC (unlike raw SSD) is invariant to
 * brightness/contrast shifts between frames, which was the single biggest
 * source of drift in the previous SSD-based corner tracker. The template is
 * anchored once (the patch around the point when tracking starts) and never
 * silently replaced - this is a deliberately "rigid" tracker: predictable,
 * non-drifting, matching how a basic point tracker (e.g. DaVinci's default
 * mode) behaves, at the cost of not adapting to the point's appearance
 * changing over time (rotation/scale/lighting of the tracked surface itself).
 */

export interface GrayImage {
  data: Float32Array;
  width: number;
  height: number;
}

export interface PreparedTemplate {
  /** Zero-mean template values (sums to ~0). */
  norm: Float32Array;
  /** sqrt(sum(norm^2)) - precomputed template energy for the NCC denominator. */
  energy: number;
  radius: number;
}

export interface SearchPoint {
  x: number;
  y: number;
}

export interface SearchResult {
  x: number;
  y: number;
  /** NCC score in [-1, 1], 1 = perfect match. */
  score: number;
}

export function downsampleGrayHalf(image: GrayImage): GrayImage {
  const halfWidth = Math.max(1, Math.floor(image.width / 2));
  const halfHeight = Math.max(1, Math.floor(image.height / 2));
  const out = new Float32Array(halfWidth * halfHeight);
  for (let y = 0; y < halfHeight; y += 1) {
    for (let x = 0; x < halfWidth; x += 1) {
      const x0 = x * 2;
      const y0 = y * 2;
      const a = image.data[y0 * image.width + x0] ?? 0;
      const b = image.data[y0 * image.width + Math.min(image.width - 1, x0 + 1)] ?? 0;
      const c = image.data[Math.min(image.height - 1, y0 + 1) * image.width + x0] ?? 0;
      const d = image.data[Math.min(image.height - 1, y0 + 1) * image.width + Math.min(image.width - 1, x0 + 1)] ?? 0;
      out[y * halfWidth + x] = (a + b + c + d) / 4;
    }
  }
  return { data: out, width: halfWidth, height: halfHeight };
}

/** Extracts a (2*radius+1)^2 patch centered at (cx,cy), rounded to the nearest pixel. Returns undefined if the patch would fall outside the image. */
export function extractPatch(image: GrayImage, cx: number, cy: number, radius: number): Float32Array | undefined {
  const px = Math.round(cx);
  const py = Math.round(cy);
  if (px - radius < 0 || py - radius < 0 || px + radius >= image.width || py + radius >= image.height) {
    return undefined;
  }
  const size = radius * 2 + 1;
  const patch = new Float32Array(size * size);
  let idx = 0;
  for (let oy = -radius; oy <= radius; oy += 1) {
    for (let ox = -radius; ox <= radius; ox += 1) {
      patch[idx] = image.data[(py + oy) * image.width + (px + ox)] ?? 0;
      idx += 1;
    }
  }
  return patch;
}

export function prepareTemplate(patch: Float32Array, radius: number): PreparedTemplate {
  let sum = 0;
  for (let i = 0; i < patch.length; i += 1) {
    sum += patch[i] ?? 0;
  }
  const mean = sum / patch.length;
  const norm = new Float32Array(patch.length);
  let energy = 0;
  for (let i = 0; i < patch.length; i += 1) {
    const v = (patch[i] ?? 0) - mean;
    norm[i] = v;
    energy += v * v;
  }
  return { norm, energy: Math.sqrt(energy), radius };
}

/** NCC of the prepared template against the image patch centered at (cx,cy). Returns -Infinity if the patch is out of bounds. */
function nccAt(template: PreparedTemplate, image: GrayImage, cx: number, cy: number): number {
  const radius = template.radius;
  if (cx - radius < 0 || cy - radius < 0 || cx + radius >= image.width || cy + radius >= image.height) {
    return -Infinity;
  }
  let sum = 0;
  let sumI = 0;
  let sumSqI = 0;
  let idx = 0;
  for (let oy = -radius; oy <= radius; oy += 1) {
    const rowBase = (cy + oy) * image.width + cx;
    for (let ox = -radius; ox <= radius; ox += 1) {
      const v = image.data[rowBase + ox] ?? 0;
      sumI += v;
      sumSqI += v * v;
      sum += (template.norm[idx] ?? 0) * v;
      idx += 1;
    }
  }
  const n = idx;
  const meanI = sumI / n;
  // template.norm already sums to ~0, so sum(norm[i]*v[i]) === sum(norm[i]*(v[i]-meanI)) - no extra cross term needed.
  const denomI = Math.sqrt(Math.max(1e-6, sumSqI - n * meanI * meanI));
  return sum / (template.energy * denomI + 1e-6);
}

/**
 * Integer-pixel search over a window around (centerX, centerY), then a
 * parabola fit on the NCC scores of the 4 neighbors of the best match for
 * subpixel precision. Subpixel refinement is what removes the constant
 * 1px jitter a pure integer search produces.
 */
export function searchNcc(template: PreparedTemplate, image: GrayImage, centerX: number, centerY: number, searchRadius: number): SearchResult {
  const cx0 = Math.round(centerX);
  const cy0 = Math.round(centerY);
  let bestScore = -Infinity;
  let bestX = cx0;
  let bestY = cy0;

  for (let dy = -searchRadius; dy <= searchRadius; dy += 1) {
    for (let dx = -searchRadius; dx <= searchRadius; dx += 1) {
      const cx = cx0 + dx;
      const cy = cy0 + dy;
      const score = nccAt(template, image, cx, cy);
      if (score > bestScore) {
        bestScore = score;
        bestX = cx;
        bestY = cy;
      }
    }
  }

  if (bestScore === -Infinity) {
    return { x: cx0, y: cy0, score: -1 };
  }

  const left = nccAt(template, image, bestX - 1, bestY);
  const right = nccAt(template, image, bestX + 1, bestY);
  const up = nccAt(template, image, bestX, bestY - 1);
  const down = nccAt(template, image, bestX, bestY + 1);

  const subX = parabolaOffset(left, bestScore, right);
  const subY = parabolaOffset(up, bestScore, down);

  return { x: bestX + subX, y: bestY + subY, score: bestScore };
}

function parabolaOffset(left: number, center: number, right: number): number {
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    return 0;
  }
  const denom = left - 2 * center + right;
  if (Math.abs(denom) < 1e-6) {
    return 0;
  }
  const offset = (0.5 * (left - right)) / denom;
  return Math.max(-1, Math.min(1, offset));
}

/** Maps an NCC score in [-1, 1] to a 0..1 confidence, emphasizing the high end since real matches usually score well above 0.5. */
export function nccToConfidence(score: number): number {
  return Math.max(0, Math.min(1, (score + 1) / 2));
}

/**
 * Soft-saturating map from a raw, unbounded score to 0..1, used to turn the
 * Shi-Tomasi eigenvalue (which has no natural upper bound) into a percentage.
 */
function saturate(value: number, scale: number): number {
  return 1 - Math.exp(-Math.max(0, value) / scale);
}

/** Average per-pixel image-gradient energy scale below which a patch reads as "trackable" at ~50%. Calibrated against flat vs. textured synthetic patches. */
const TRACKABILITY_SCALE = 900;

/**
 * Estimates how trackable a point is from the image alone, before any tracking
 * has run - the same "good features to track" criterion KLT/Shi-Tomasi trackers
 * use to pick corners: the minimum eigenvalue of the local gradient structure
 * tensor. A flat or uniformly-textured patch (sky, blank wall, smooth skin) has
 * a near-zero minimum eigenvalue in every direction - the template-matching
 * search this tool uses can't localize it precisely, so confidence should be
 * low. A patch with a real corner/edge-crossing/texture has gradient energy in
 * more than one direction, so the minimum eigenvalue (and the score) is high.
 *
 * Purely indicative - this never runs tracking, it's an instant local read of
 * the current frame meant to steer the user toward a better point before they
 * commit to it.
 */
export function estimateTrackability(image: GrayImage, cx: number, cy: number, radius: number): number {
  const px = Math.round(cx);
  const py = Math.round(cy);
  if (px - radius - 1 < 0 || py - radius - 1 < 0 || px + radius + 1 >= image.width || py + radius + 1 >= image.height) {
    return 0;
  }

  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  let count = 0;
  for (let oy = -radius; oy <= radius; oy += 1) {
    const row = (py + oy) * image.width + px;
    const rowUp = (py + oy - 1) * image.width + px;
    const rowDown = (py + oy + 1) * image.width + px;
    for (let ox = -radius; ox <= radius; ox += 1) {
      const ix = (image.data[row + ox + 1] ?? 0) - (image.data[row + ox - 1] ?? 0);
      const iy = (image.data[rowDown + ox] ?? 0) - (image.data[rowUp + ox] ?? 0);
      sxx += ix * ix;
      syy += iy * iy;
      sxy += ix * iy;
      count += 1;
    }
  }
  if (count === 0) {
    return 0;
  }
  sxx /= count;
  syy /= count;
  sxy /= count;

  const trace = sxx + syy;
  const disc = Math.sqrt(Math.max(0, ((sxx - syy) / 2) ** 2 + sxy * sxy));
  const minEigen = trace / 2 - disc;
  return Math.max(0, Math.min(1, saturate(minEigen, TRACKABILITY_SCALE)));
}
