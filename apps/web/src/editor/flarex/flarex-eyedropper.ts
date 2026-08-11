/**
 * Flarex key-colour EYEDROPPER — the pure half.
 *
 * A keyer's colour is PICKED, never typed. Two things separate a pro picker from `<input type="color">`:
 *
 *  1. **It samples the node's INPUT, not the viewer's output.** The viewer shows the composited comp —
 *     post-key, and post any grade downstream of the keyer. A colour picked there is a colour that no
 *     longer exists in the data the keyer is measuring, so the key it produces is not the key the number
 *     predicted. `flarexNodeImageInputId` names the node whose picture IS the keyer's input, and the
 *     caller renders THAT through the viewer's own compositor (the same `renderFlarexNodeThumbnail`
 *     re-root the node thumbnails already use). Upstream colour nodes are correctly included — they are
 *     part of the data being keyed; everything from the keyer forward is correctly excluded.
 *
 *  2. **It averages a REGION.** A single pixel picks sensor noise, and on compressed footage it picks
 *     chroma-subsampled noise — 4:2:0 stores one chroma sample per 2×2 block, so neighbouring pixels of
 *     a "flat" green screen differ by several units and two clicks a pixel apart give two different keys.
 *     An odd-sized box mean around the click is the standard fix and is what `sampleAverageHex` does.
 *
 * Everything here is pure: no React, no GL, no DOM. The component drives it.
 */

import { getFlarexNodeDefinition, type FlarexComp } from "@orreris/shared";

/** A top-origin RGBA readback, exactly the shape `SceneViewerCaptureHandle` hands back. */
export interface FlarexPickFrame {
  pixels: Uint8Array;
  width: number;
  height: number;
}

/**
 * Sample-box sizes offered in the UI, in pixels of the sampled frame. 1 is kept — it is the honest
 * "give me exactly this pixel" and is occasionally what you want on a graphic — but 5 is the default
 * because it is the smallest box that survives 4:2:0 chroma subsampling (a 2×2 chroma block plus its
 * neighbours) without smearing across a real edge.
 */
export const FLAREX_PICK_SIZES = [1, 3, 5, 9] as const;
export const FLAREX_PICK_DEFAULT_SIZE = 5;

/**
 * The node feeding `nodeId`'s first IMAGE input, or null when nothing is wired there.
 *
 * NODE-BLIND (ADR-010): the socket is found by reading the definition's declared `inputs` and taking the
 * first one of type `image` — there is no `if (node.type === "chromaKey")` here, and any other node with
 * a picture input gets a working eyedropper for free. Matte sockets are skipped by construction, which
 * is why this cannot accidentally sample the garbage matte.
 */
export function flarexNodeImageInputId(comp: FlarexComp, nodeId: string): string | null {
  const node = comp.nodes[nodeId];
  if (!node) return null;
  const socket = getFlarexNodeDefinition(node.type).inputs.find((input) => input.type === "image");
  if (!socket) return null;
  const edge = comp.edges.find((e) => e.to.nodeId === nodeId && e.to.socket === socket.id);
  return edge ? edge.from.nodeId : null;
}

const clamp = (value: number, lo: number, hi: number): number => (value < lo ? lo : value > hi ? hi : value);

/**
 * Mean colour of the `size`×`size` box centred on the normalized point (`u`, `v`), as `#rrggbb`.
 *
 * `u`/`v` are 0..1 with v measured TOP-DOWN, matching both the readback's row order and a pointer
 * event's offset within its element — so the caller never converts a coordinate space and cannot get
 * the picture flipped.
 *
 * The box is CLAMPED to the frame rather than wrapped or zero-padded: a pick near the edge averages the
 * pixels that exist, instead of pulling the sample toward black (which would read as "the screen is
 * darker at the edges" and quietly detune the key).
 *
 * ALPHA-WEIGHTED. A transparent pixel has no colour to contribute — its RGB is whatever the compositor
 * left in the buffer — so weighting by coverage keeps a pick that overlaps a keyed hole or the letterbox
 * from being dragged toward that garbage. A fully transparent box has nothing to say and returns null.
 */
export function sampleAverageHex(frame: FlarexPickFrame, u: number, v: number, size: number): string | null {
  const { pixels, width, height } = frame;
  if (width <= 0 || height <= 0 || pixels.length < width * height * 4) return null;
  const half = Math.floor(Math.max(1, size) / 2);
  const cx = clamp(Math.floor(u * width), 0, width - 1);
  const cy = clamp(Math.floor(v * height), 0, height - 1);
  let r = 0;
  let g = 0;
  let b = 0;
  let weight = 0;
  for (let y = cy - half; y <= cy + half; y += 1) {
    const yy = clamp(y, 0, height - 1);
    for (let x = cx - half; x <= cx + half; x += 1) {
      const xx = clamp(x, 0, width - 1);
      const i = (yy * width + xx) * 4;
      const a = pixels[i + 3]! / 255;
      if (a <= 0) continue;
      r += pixels[i]! * a;
      g += pixels[i + 1]! * a;
      b += pixels[i + 2]! * a;
      weight += a;
    }
  }
  if (weight <= 0) return null;
  const hex = (n: number) => clamp(Math.round(n / weight), 0, 255).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}
