/**
 * ADR-023 S9a — a variable axis, on the RASTER.
 *
 * ## Why this module exists at all, and why the obvious route is not in it
 *
 * S5 deferred `font-variation-settings` and the reason was good: **the canvas 2D context exposes no
 * `fontVariationSettings`, and its `font` shorthand rejects an inline `font-variation-settings`
 * declaration** (measured, `apps/worker/tmp/oq2-probe.mjs`). Since T-13's correction the canvas raster
 * is where BOTH renderers get their text pixels, so an axis authored that way would move the editor's
 * DOM overlay and ship nothing — the exact "wrong pixels that look like a working feature" shape this
 * ADR keeps returning to.
 *
 * Both of those facts are about **draw time**. The axis does not have to be applied at draw time.
 * A `FontFace` carries a `variationSettings` DESCRIPTOR, which instances the axis at **registration**
 * time — and CSS has the same descriptor inside an `@font-face` block, which is the route the worker
 * takes because the worker installs faces as CSS. Measured 2026-08-16 (`apps/worker/tmp/oq6-spike.mjs`):
 * two aliases over ONE variable file measure **331.98 vs 368.08 on canvas**, with a DOM control on the
 * same face at 331.98 vs 368.09 proving the file is variable and the engine can instance it — so the
 * canvas number is a fact about canvas and not about the probe.
 *
 * The consequence shapes everything below: **an axis instance is a separate registered FAMILY**, not
 * a property of a draw. `fontRefCss` emits the alias, the raster resolves it by name like any other
 * family, and no code on the drawing path needs to know that variable fonts exist.
 *
 * ## ⚠ THE FEATURE DETECT THAT LIES — read this before writing one
 *
 * `FontFace.variationSettings` **does not reflect back**. Construct a face with
 * `{ variationSettings: "'wght' 700" }` and read the property: in Chromium it comes back empty, while
 * the face renders at 700 perfectly well. A feature detect written against the reflected value
 * therefore reports a WORKING API as unsupported, and would have deleted this whole feature on a
 * browser that implements it. Measured in the same spike. **Detect by RENDERING** — register two
 * instances of one file at opposite ends of an axis and measure that they differ — or do not detect
 * at all. There is no cheap correct property read here.
 *
 * ## The boundary with S2.7, which must not be crossed in either direction
 *
 * S2.7 picks between FILES: "Bold" over a pinned family rewrites the `FontRef` to the family's bold
 * cut, because Google's index enumerates *instances* and its CDN serves a static file per weight.
 * This stage picks WITHIN one file. They are not alternatives and they must not fight:
 *
 * - An axis never rewrites the ref. The `fileHash` is untouched, so S2.7's pick and this stage's
 *   instance compose: pin the file you meant, then move the axis inside it.
 * - A weight/style pick never clears the axis, and a `fontWeight`/Bold toggle is still S2.7's
 *   business. The alias face carries the ref's own `font-weight` descriptor, so the emitted
 *   `font-weight` is byte-identical to what it was without an axis — only the family token moves.
 * - **Cairo's nine enumerated instances must not be collapsed.** The plan's S9 note flags this and
 *   `font:index-test` asserts it; that assertion protects THIS stage, because collapsing the
 *   enumeration to one variable row would make S2.7's file pick unable to name a weight at all.
 */

/**
 * The axes this stage exposes, and only these.
 *
 * ADR-003's kind taxonomy is frozen and has no map kind, so a general `Record<axisTag, number>` has
 * nowhere to live in a `PropertySchema` — the `lut` precedent and S8's two-fields-not-a-list are the
 * standing answers, and this is the same answer a third time. `wght` and `wdth` are the two
 * registered axes with a settled meaning, a settled range, and a control anyone can operate without
 * reading the foundry's documentation. `opsz`, `slnt`, `GRAD` and the custom axes are **refused**,
 * not approximated: an axis whose meaning is per-foundry cannot be given a labelled slider, and a
 * blind numeric box over an unknown tag is a worse product than not shipping it.
 */
export const FONT_VARIATION_AXES = ["wght", "wdth"] as const;
export type FontVariationAxisTag = (typeof FONT_VARIATION_AXES)[number];

/** An authored axis instance. Absent tags are NOT defaulted — see {@link resolveFontVariationAxes}. */
export type FontVariationAxes = Partial<Record<FontVariationAxisTag, number>>;

/** One axis a FILE actually exposes, read from its `fvar` table. */
export interface FontAxisRange {
  tag: string;
  min: number;
  default: number;
  max: number;
}

/**
 * CSS-legal bounds, used only to reject nonsense before a value reaches a font.
 *
 * These are NOT the control's range. A slider bounded by the spec rather than by the FILE is the
 * "no cut, no lie" failure in miniature: dragging past the face's `fvar` maximum does nothing and
 * looks like a broken control. {@link parseFontVariationAxes} reads the real range off the bytes and
 * the inspector clamps to that; this pair is the last-resort sanity gate for data arriving from a
 * manifest, a preset or an AI plan.
 */
const AXIS_BOUNDS: Record<FontVariationAxisTag, { min: number; max: number }> = {
  wght: { min: 1, max: 1000 },
  wdth: { min: 1, max: 1000 }
};

/** `true` when the value is a real, in-bounds axis coordinate. Absence and nonsense both answer `false`. */
export function hasFontVariationAxis(tag: FontVariationAxisTag, value: number | undefined): boolean {
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  const bounds = AXIS_BOUNDS[tag];
  return value >= bounds.min && value <= bounds.max;
}

/**
 * Read a layer's authored axes.
 *
 * Returns an object with only the tags that were authored. **Absent stays absent** (D1a): a layer
 * that never named an axis must emit no `variationSettings` at all, not `'wght' 400`, because the
 * face's own `fvar` default is not necessarily 400 and writing one in would move every legacy layer
 * pinned to a variable file.
 */
export function resolveFontVariationAxes(source: {
  fontWeightAxis?: number | undefined;
  fontWidthAxis?: number | undefined;
}): FontVariationAxes | undefined {
  const axes: FontVariationAxes = {};
  if (hasFontVariationAxis("wght", source.fontWeightAxis)) axes.wght = source.fontWeightAxis!;
  if (hasFontVariationAxis("wdth", source.fontWidthAxis)) axes.wdth = source.fontWidthAxis!;
  return Object.keys(axes).length > 0 ? axes : undefined;
}

/**
 * The `variationSettings` descriptor string — for `new FontFace(..., { variationSettings })` in the
 * browser and for the `font-variation-settings:` line of an `@font-face` block in the worker.
 *
 * Tag order is {@link FONT_VARIATION_AXES}' order rather than object-key order, so the string is a
 * stable function of the VALUES. That matters because it also keys the alias family below, and a
 * key that depended on which control the user touched first would register the same instance twice.
 */
export function fontVariationSettingsCss(axes: FontVariationAxes | undefined): string | undefined {
  if (!axes) return undefined;
  const parts: string[] = [];
  for (const tag of FONT_VARIATION_AXES) {
    const value = axes[tag];
    if (hasFontVariationAxis(tag, value)) parts.push(`'${tag}' ${roundAxis(value!)}`);
  }
  return parts.length > 0 ? parts.join(",") : undefined;
}

/**
 * Axis coordinates are quantised to 2 decimals HERE, once, and everything downstream uses the result.
 *
 * Two reasons, and the second is the one that would bite. The obvious one is that no face resolves a
 * finer step. The load-bearing one is that this value ends up inside a registered family NAME: a
 * float that round-trips through JSON as `549.9999999999999` would register a second face identical
 * to the first, and S9b's animation will walk this function thousands of times.
 */
function roundAxis(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * A marker that cannot occur in a real font family name.
 *
 * `~` is not legal in a CSS custom-ident and is vanishingly rare in a `name` table, so an alias can
 * never be confused with, or shadowed by, a face someone actually installed. It is also why every
 * alias goes through `cssFamilyToken`'s quoting path — which it does, because the marker forces the
 * quoted branch.
 */
const AXIS_FAMILY_MARKER = "~axis~";

/**
 * The alias suffix. Deliberately NOT {@link fontVariationSettingsCss}'s output, even though the two
 * carry the same numbers: that string contains apostrophes, and a family name containing an
 * apostrophe has to survive `cssFamilyToken`'s backslash-escaping, a round trip through the emitted
 * style object, and a byte-for-byte match against the `family` a `FontFace` was constructed with. A
 * single escaping discrepancy anywhere on that path does not throw — it names a family nobody
 * registered, and the text silently falls back to `sans-serif`. The suffix below has no character
 * CSS needs to escape, so there is no path for that to happen.
 */
function axisFamilySuffix(axes: FontVariationAxes): string {
  const parts: string[] = [];
  for (const tag of FONT_VARIATION_AXES) {
    const value = axes[tag];
    if (hasFontVariationAxis(tag, value)) parts.push(`${tag}${roundAxis(value!)}`);
  }
  return parts.join("-");
}

/**
 * The family name an axis instance is registered under.
 *
 * This is the whole trick. The axis is baked into the FACE at registration, so the only thing the
 * drawing path needs is a different family token — and `ctx.font`, the DOM, and an SVG `@font-face`
 * all resolve a family by name, which is why one alias satisfies all three surfaces at once.
 *
 * Derived purely from the base family and the axis coordinates, so it is deterministic across
 * processes: the worker registers `Cairo ~axis~wght550` and the manifest's emitted CSS names the
 * same string without either side coordinating.
 */
export function fontAxisInstanceFamily(family: string, axes: FontVariationAxes | undefined): string {
  if (!axes) return family;
  const suffix = axisFamilySuffix(axes);
  return suffix ? `${family} ${AXIS_FAMILY_MARKER}${suffix}` : family;
}

/** `true` if a family token is one of ours. Used by gates that assert an instance was actually named. */
export function isFontAxisInstanceFamily(family: string): boolean {
  return family.includes(AXIS_FAMILY_MARKER);
}

/**
 * Read the axes a font FILE exposes, straight from its `fvar` table.
 *
 * Hand-rolled rather than routed through opentype.js, for one reason that is not preference: this
 * has to run on `.woff2` bytes as well, and `font-outlines.ts:35` records that opentype.js cannot
 * Brotli-decode them. `fvar` sits in the uncompressed table directory of a `.ttf`/`.otf`; for a
 * `.woff`/`.woff2` container this returns `undefined`, which the caller must read as **"unknown"**
 * and never as "not variable" — see {@link fontAxisSupport}.
 *
 * Returns `undefined` for "could not tell", and `[]` for "read it, there are no axes". The two are
 * different answers and collapsing them is how a static face and an unreadable one end up sharing a
 * disabled control that means two different things.
 */
export function parseFontVariationAxes(bytes: ArrayBuffer | Uint8Array): FontAxisRange[] | undefined {
  const view =
    bytes instanceof Uint8Array
      ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : new DataView(bytes);
  try {
    if (view.byteLength < 12) return undefined;
    const tag = view.getUint32(0, false);
    // 0x00010000 (TrueType), 'OTTO' (CFF), 'true'/'ttcf'. A WOFF/WOFF2 signature is a real font we
    // simply cannot read here — same `undefined`, and the doc comment above is why that is honest.
    if (tag !== 0x00010000 && tag !== 0x4f54544f && tag !== 0x74727565) return undefined;
    const numTables = view.getUint16(4, false);
    let fvarOffset = -1;
    for (let i = 0; i < numTables; i += 1) {
      const record = 12 + i * 16;
      if (record + 16 > view.byteLength) return undefined;
      if (view.getUint32(record, false) === 0x66766172 /* 'fvar' */) {
        fvarOffset = view.getUint32(record + 8, false);
        break;
      }
    }
    if (fvarOffset < 0) return [];
    if (fvarOffset + 16 > view.byteLength) return undefined;
    const axesArrayOffset = fvarOffset + view.getUint16(fvarOffset + 4, false);
    const axisCount = view.getUint16(fvarOffset + 8, false);
    const axisSize = view.getUint16(fvarOffset + 10, false);
    const axes: FontAxisRange[] = [];
    for (let i = 0; i < axisCount; i += 1) {
      const at = axesArrayOffset + i * axisSize;
      if (at + 20 > view.byteLength) return undefined;
      const tagText = String.fromCharCode(
        view.getUint8(at),
        view.getUint8(at + 1),
        view.getUint8(at + 2),
        view.getUint8(at + 3)
      );
      // Fixed 16.16, which is what `fvar` stores and what a naive getInt32 would silently misread by
      // a factor of 65536 — producing a plausible-looking axis whose range is nonsense.
      axes.push({
        tag: tagText,
        min: view.getInt32(at + 4, false) / 65536,
        default: view.getInt32(at + 8, false) / 65536,
        max: view.getInt32(at + 12, false) / 65536
      });
    }
    return axes;
  } catch {
    return undefined;
  }
}

/** What a control may say about one axis on one face. */
export type FontAxisSupport =
  | { state: "supported"; range: FontAxisRange }
  | { state: "absent" }
  | { state: "unknown" };

/**
 * Whether a face exposes an axis, in the three-valued form a control needs.
 *
 * "No cut, no lie" (S2.7) applied to axes: a static file must not be given a slider that silently
 * does nothing. But **`unknown` must not disable the control either** — it is the answer for a
 * `.woff2`, for a face whose bytes have not arrived yet, and for a system ref, and a control that
 * disables on "I have not looked" would be off for most of a session's first seconds. The inspector
 * shows `unknown` as enabled-and-unverified; only a read `absent` disables.
 */
export function fontAxisSupport(axes: FontAxisRange[] | undefined, tag: FontVariationAxisTag): FontAxisSupport {
  if (!axes) return { state: "unknown" };
  const found = axes.find((axis) => axis.tag === tag);
  return found ? { state: "supported", range: found } : { state: "absent" };
}
