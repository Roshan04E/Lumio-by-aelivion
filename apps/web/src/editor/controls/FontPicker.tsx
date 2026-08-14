/**
 * ADR-023 S2.5 / S2.6 — the font picker. The half of S2 a user can point at.
 *
 * S2.5 replaced the five-item `renderSafeFonts` dropdown with a list of the five BUNDLED faces. That
 * changed the KIND of ceiling — system stacks the export box was assumed to have became pinned faces
 * that render identically everywhere — and left the size exactly where it was. S2.6 is the size:
 * ~1900 families from the index, searchable, filterable by script, and pinned on pick.
 *
 * ## The list is the engineering, not the metadata
 *
 * A thousand rows each wanting its own face is the entire problem, and it is why font pickers feel
 * broken. Two mechanisms, both load-bearing:
 *
 *  - **Virtualized.** Only the rows inside the scroll window (plus a small overscan) are mounted.
 *    1942 families is 1942 DOM subtrees otherwise, and the browser will not lay that out at speed.
 *  - **Lazy, batched face loading.** A face is requested only for rows near the viewport, and a
 *    window of twenty is ONE network request (`font-catalogue-preview`). Rows further away render in
 *    the UI font and SAY they are not ready — never silently, because a row showing the fallback
 *    while claiming to show the font is the empty-`warpFontCatalog` incident (T-17).
 *
 * ## Three kinds of row, and the distinctions are D1a rather than decoration
 *
 *  - **System** — the legacy CSS stacks, unchanged and still selectable. Choosing one clears the ref
 *    to `undefined`: the layer returns to having no ref at all, which is the state D1a calls
 *    "authored before this existed" and the one a legacy project must be able to reach.
 *  - **Bundled** — the five faces shipped in `public/fonts`. Pinned instantly, offline, no server.
 *  - **Catalogue** — everything else. Picking one MIRRORS it first (`font-pin`), so the row shows a
 *    resolving state and then either pins or says why it could not. A failed pin writes nothing.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Check, ChevronDown, Search, Type } from "lucide-react";
import {
  catalogueFontRef,
  fontCatalogue,
  FONT_SCRIPT_FILTERS,
  isPinnedFontRef,
  queryFontIndex,
  renderSafeFonts,
  resolveFamilyFace,
  type FontIndexFamily,
  type FontRef,
  type PinnedFontRef
} from "@orreris/shared";
import {
  cataloguePreviewVersion,
  previewFamily,
  previewSample,
  previewState,
  requestPreview,
  subscribeCataloguePreviews
} from "../../lib/font-catalogue-preview";
import { clearFontPinState, fontPinState, fontPinVersion, pinFont, subscribeFontPins } from "../../lib/font-pin";
import type { ReferenceResolver, ResolvedReference } from "../inspector/controls/ReferenceControl";
import {
  addUserFont,
  listUserFonts,
  subscribeUserFonts,
  UserFontError,
  userFontRef,
  userFontsVersion,
  type UserFontRecord
} from "../../lib/user-fonts";

/**
 * S4b. The picker is now the canonical editor for `refType: "font"` — one arm of the shared
 * `reference` kind (ADR-003) rather than a bespoke widget behind ADR-002's escape hatch. Two things
 * changed and no more: the row's LABEL comes from a resolver instead of being derived in here, and
 * the widget is reached through `PropertyFieldList`. The list, the virtualization, the batched face
 * loading and every write are untouched — a shared picker that wrote a different shape is the entire
 * risk of consolidating.
 */
export interface FontPickerValue {
  /** The layer's CSS stack — what a system pick sets and what a legacy layer already has. */
  fontFamily: string;
  /** The layer's pinned ref, if it has one. */
  fontRef: FontRef | undefined;
  /**
   * The layer's current weight/italic, so a pick resolves to the matching cut.
   *
   * A pinned ref's weight comes from the REF, not from the layer (`fontRefCss`), because it
   * describes the file. That is deliberate and settled — but it means the picker is where weight is
   * actually chosen, so it has to know what the layer is asking for.
   */
  weight?: number | undefined;
  italic?: boolean | undefined;
}

/** The ref a layer is actually pinned to, if any — a `system` ref is the legacy CSS stack, not a pin. */
function pinnedRefOf(value: FontPickerValue): PinnedFontRef | undefined {
  return value.fontRef && isPinnedFontRef(value.fontRef) ? value.fontRef : undefined;
}

/**
 * The id a font reference serializes as (ADR-003: a reference serializes as an id): the FILE for a
 * pinned ref, the CSS stack for a legacy one. Those are the two identities a text layer can carry,
 * and D1a is the reason the second still exists.
 */
export function fontReferenceId(value: FontPickerValue): string {
  const pinned = pinnedRefOf(value);
  return pinned ? pinned.fileHash : value.fontFamily;
}

/**
 * The canonical `refType: "font"` resolver. It closes over the layer's ref because a `FontRef` is
 * SELF-DESCRIBING — the file it names may be absent from every store, but what it claims to be is in
 * the ref itself, which is exactly why D1 made the ref the render identity.
 *
 * **`missing` is therefore never true here, and that is not an oversight.** Whether a pinned file can
 * actually be installed is answered by `fontPinState` / the substitution surface S2 already ships,
 * on its own schedule and with its own wording. Teaching this resolver to also declare a font missing
 * would put two different answers to that question on screen; S4b is a refactor and does not get to
 * introduce a second one.
 */
export function fontReferenceResolver(value: FontPickerValue): ReferenceResolver {
  const pinned = pinnedRefOf(value);
  return (refId) => {
    if (pinned && refId === pinned.fileHash) {
      return { label: `${pinned.family}${pinned.weight >= 600 ? " Bold" : ""}`, missing: false, badge: "pinned" };
    }
    return { label: renderSafeFonts.find((font) => font.family === refId)?.label ?? refId, missing: false };
  };
}

/** Row geometry. Fixed height is what makes the window computable without measuring anything. */
const ROW_HEIGHT = 34;
const VIEWPORT_HEIGHT = 320;
/** Rows kept mounted beyond each edge. Enough to cover a fast flick without mounting the list. */
const OVERSCAN = 8;

type Row =
  | { kind: "header"; key: string; label: string }
  | { kind: "system"; key: string; family: string; label: string }
  | { kind: "family"; key: string; entry: FontIndexFamily; bundled: boolean }
  /** ADR-023 D5 (S3) — a font this account uploaded. Local-first; the cloud copy is opt-in. */
  | { kind: "user"; key: string; record: UserFontRecord };

const bundledFamilies = new Set(fontCatalogue.map((entry) => entry.family));

export function FontPicker({
  value,
  resolved,
  onPick,
  onReset
}: {
  value: FontPickerValue;
  /** What the current id points at, resolved by the shared `reference` machinery (S4b). */
  resolved: ResolvedReference;
  /** Called with the COMPLETE font identity — both fields, always, so neither can be left stale. */
  onPick: (next: FontPickerValue) => void;
  onReset?: (() => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [script, setScript] = useState<string | undefined>(undefined);
  const [scrollTop, setScrollTop] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useSyncExternalStore(subscribeCataloguePreviews, cataloguePreviewVersion, cataloguePreviewVersion);
  useSyncExternalStore(subscribeFontPins, fontPinVersion, fontPinVersion);
  useSyncExternalStore(subscribeUserFonts, userFontsVersion, userFontsVersion);
  const [uploadError, setUploadError] = useState<string | undefined>(undefined);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Close on outside click / Escape. A popup that traps the user is worse than a select.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pinned = pinnedRefOf(value);
  const weight = value.weight ?? 400;
  const style = value.italic ? ("italic" as const) : ("normal" as const);

  /**
   * The rows. Recomputed only when a filter changes — never on scroll, which is the difference
   * between a list that holds frame and one that re-filters 1942 families sixty times a second.
   */
  const rows = useMemo<Row[]>(() => {
    const matches = queryFontIndex({ search, ...(script ? { subset: script } : {}) });
    const list: Row[] = [];
    // System stacks lead only in the unfiltered view: once someone is searching, five legacy rows
    // above the answer are noise.
    if (!search && !script) {
      list.push({ kind: "header", key: "h-system", label: "System — resolves on the render machine" });
      for (const font of renderSafeFonts) list.push({ kind: "system", key: `sys-${font.family}`, family: font.family, label: font.label });
    }
    // Your own fonts lead the list when you have any: they are the ones you uploaded on purpose,
    // and a brand font buried under 1,942 Google families is a brand font you will not find.
    const mine = listUserFonts().filter((record) => !search || record.family.toLowerCase().includes(search.toLowerCase()));
    if (mine.length && !script) {
      list.push({ kind: "header", key: "h-user", label: "Your fonts — stored against your account only" });
      for (const record of mine) list.push({ kind: "user", key: `user-${record.fileHash}`, record });
    }
    list.push({
      kind: "header",
      key: "h-catalogue",
      label: `${matches.length.toLocaleString()} font${matches.length === 1 ? "" : "s"} — pinned on pick, render identically everywhere`
    });
    for (const entry of matches) {
      list.push({ kind: "family", key: `fam-${entry.family}`, entry, bundled: bundledFamilies.has(entry.family) });
    }
    return list;
  }, [search, script, userFontsVersion()]);

  // Reset the scroll when the filter changes, or the window would point past the end of a shorter
  // list and show nothing.
  useEffect(() => {
    setScrollTop(0);
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [search, script]);

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + VIEWPORT_HEIGHT) / ROW_HEIGHT) + OVERSCAN);
  const visible = rows.slice(first, last);

  /**
   * Ask for a face for what is on screen, and for nothing else. This is the "not laggy" half of the
   * brief in one effect: scrolling requests faces as rows approach, and a list nobody scrolls costs
   * one batch. `requestPreview` is idempotent, so re-running on every window change is free.
   */
  useEffect(() => {
    if (!open) return;
    // The SAMPLE is part of the request: a face is loaded per unicode-range block, so a family
    // fetched for "Ag" has no arabic glyphs. Asking with the text the row will actually draw is what
    // keeps "loaded" from meaning "loaded for something else" (T-17).
    for (const row of visible) if (row.kind === "family") requestPreview(row.entry.family, previewSample(row.entry.subsets, script));
  }, [open, script, visible]);

  /**
   * Scroll is read through rAF rather than set straight from the event. `onScroll` fires far more
   * often than the compositor paints, and a `setState` per event turns a smooth scroll into a
   * re-render queue — which is precisely the "laggy" this stage exists to avoid.
   */
  const frame = useRef(0);
  const onScroll = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      if (listRef.current) setScrollTop(listRef.current.scrollTop);
    });
  }, []);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const choose = useCallback(
    async (family: string) => {
      /**
       * Resolve to a face the family ACTUALLY has before asking for it (S2.7). The layer may be
       * asking for weight 900 while the family tops out at 700, or for an italic it does not ship;
       * `resolveFamilyFace` answers with a real cut, or with nothing when the style does not exist —
       * and asking the mirror for a face Google has never heard of is a 404, not a font.
       */
      const face = resolveFamilyFace(family, weight, style) ?? resolveFamilyFace(family, weight, "normal");
      if (!face) return;
      const bundled = catalogueFontRef(family, face.weight, face.style);
      if (bundled && bundled.weight === face.weight && bundled.style === face.style) {
        onPick({ fontFamily: family, fontRef: bundled });
        setOpen(false);
        return;
      }
      clearFontPinState(family);
      const ref = await pinFont(family, face.weight, face.style);
      // A failed pin leaves the layer alone and the row explains itself. The menu deliberately stays
      // OPEN on failure — closing it would hide the only place the reason is shown.
      if (!ref) return;
      onPick({ fontFamily: family, fontRef: ref });
      setOpen(false);
    },
    [onPick, style, weight]
  );

  return (
    <div className="font-picker" ref={rootRef}>
      <button
        type="button"
        className="font-picker-trigger"
        data-testid="font-picker-trigger"
        title="Font"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      >
        <span className="control-icon">
          <Type size={14} />
        </span>
        <span className="font-picker-current">{resolved.label}</span>
        {resolved.badge ? (
          <span className="font-picker-pin" title="Pinned to a specific font file">
            {resolved.badge}
          </span>
        ) : null}
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {onReset ? (
        <button type="button" className="font-picker-reset" title="Reset font" onClick={onReset}>
          ⟲
        </button>
      ) : null}

      {open ? (
        <div className="font-picker-menu" data-testid="font-picker-menu">
          <div className="font-picker-search">
            <Search size={13} aria-hidden="true" />
            <input
              type="text"
              value={search}
              autoFocus
              placeholder="Search fonts"
              data-testid="font-picker-search"
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          {/* Script filters. Not a nicety: an Arabic writer who cannot FIND an Arabic face has no
              use for the base-direction work S0b and S0c shipped. */}
          <div className="font-picker-scripts" data-testid="font-picker-scripts">
            <button
              type="button"
              className={`font-picker-chip ${script ? "" : "is-active"}`}
              data-testid="font-script-all"
              onClick={() => setScript(undefined)}
            >
              All
            </button>
            {FONT_SCRIPT_FILTERS.map((entry) => (
              <button
                key={entry.subset}
                type="button"
                className={`font-picker-chip ${script === entry.subset ? "is-active" : ""}`}
                data-testid={`font-script-${entry.subset}`}
                onClick={() => setScript(script === entry.subset ? undefined : entry.subset)}
              >
                {entry.label}
              </button>
            ))}
          </div>

          {/* ADR-023 D5 (S3). The bytes stay on THIS DEVICE until an explicit cloud upload — the
              asset doctrine's "one asset, two locations", reused rather than reinvented. */}
          <div className="font-picker-upload">
            <input
              ref={fileRef}
              type="file"
              accept=".ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2"
              style={{ display: "none" }}
              data-testid="font-upload-input"
              onChange={async (event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                setUploadError(undefined);
                try {
                  const { record, ref } = await addUserFont(file);
                  onPick({ fontFamily: record.family, fontRef: ref });
                  setOpen(false);
                } catch (error) {
                  // The ingest error already says what is wrong with the FILE (D2) — shown as-is
                  // rather than replaced with "upload failed", which tells the user nothing.
                  setUploadError(error instanceof UserFontError || error instanceof Error ? error.message : "Could not add that font.");
                }
              }}
            />
            <button type="button" className="font-picker-chip" data-testid="font-upload-trigger" onClick={() => fileRef.current?.click()}>
              + Upload your own font
            </button>
            {uploadError ? (
              <span className="font-picker-upload-error" data-testid="font-upload-error">
                {uploadError}
              </span>
            ) : null}
          </div>

          <div
            className="font-picker-list"
            role="listbox"
            ref={listRef}
            onScroll={onScroll}
            style={{ height: VIEWPORT_HEIGHT }}
            data-testid="font-picker-list"
            data-row-count={rows.length}
          >
            <div style={{ height: rows.length * ROW_HEIGHT, position: "relative" }}>
              {visible.map((row, offset) => {
                const top = (first + offset) * ROW_HEIGHT;
                if (row.kind === "header") {
                  return (
                    <div key={row.key} className="font-picker-group" style={{ position: "absolute", top, height: ROW_HEIGHT }}>
                      {row.label}
                    </div>
                  );
                }
                if (row.kind === "system") {
                  const selected = !pinned && value.fontFamily === row.family;
                  return (
                    <button
                      key={row.key}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      className={`font-picker-option ${selected ? "is-selected" : ""}`}
                      style={{ position: "absolute", top, height: ROW_HEIGHT }}
                      data-testid={`font-option-system-${row.label}`}
                      onClick={() => {
                        onPick({ fontFamily: row.family, fontRef: undefined });
                        setOpen(false);
                      }}
                    >
                      <span className="font-picker-sample" style={{ fontFamily: row.family }}>
                        Ag
                      </span>
                      <span className="font-picker-name">{row.label}</span>
                      <span className="font-picker-meta">system</span>
                      {selected ? <Check size={13} aria-hidden="true" /> : null}
                    </button>
                  );
                }

                if (row.kind === "user") {
                  const { record } = row;
                  const selected = pinned?.fileHash === record.fileHash;
                  return (
                    <button
                      key={row.key}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      className={`font-picker-option ${selected ? "is-selected" : ""}`}
                      style={{ position: "absolute", top, height: ROW_HEIGHT }}
                      data-testid={`font-option-user-${record.fileHash.slice(0, 8)}`}
                      title={`${record.fileName} — ${record.cloud ? "on this device and in your account" : "on this device only"}`}
                      onClick={() => {
                        onPick({ fontFamily: record.family, fontRef: userFontRef(record) });
                        setOpen(false);
                      }}
                    >
                      <span className="font-picker-sample" style={{ fontFamily: `'${record.family}'` }}>
                        Ag
                      </span>
                      <span className="font-picker-name">
                        {record.family} {record.subfamily}
                      </span>
                      <span className="font-picker-meta">{record.cloud ? "yours" : "device"}</span>
                      {selected ? <Check size={13} aria-hidden="true" /> : null}
                    </button>
                  );
                }

                const { entry } = row;
                const state = previewState(entry.family);
                const ready = state === "loaded";
                const pin = fontPinState(entry.family);
                const selected = pinned?.family === entry.family;
                return (
                  <button
                    key={row.key}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className={`font-picker-option ${selected ? "is-selected" : ""} ${pin?.status === "failed" ? "is-failed" : ""}`}
                    style={{ position: "absolute", top, height: ROW_HEIGHT }}
                    data-testid={`font-option-${entry.family}`}
                    data-font-family={entry.family}
                    data-preview-ready={ready ? "true" : "false"}
                    data-pin-state={pin?.status ?? ""}
                    title={pin?.status === "failed" ? pin.message : entry.subsets.join(", ")}
                    onClick={() => void choose(entry.family)}
                  >
                    <span
                      className="font-picker-sample"
                      // The row set in its own face. `ready` gates it: an unloaded face must NOT be
                      // drawn in the UI font as though it were the real thing (T-17).
                      style={ready ? { fontFamily: `'${previewFamily(entry.family)}'` } : undefined}
                    >
                      {ready ? previewSample(entry.subsets, script) : "·"}
                    </span>
                    <span className="font-picker-name">{entry.family}</span>
                    <span className="font-picker-meta">
                      {pin?.status === "resolving"
                        ? "adding…"
                        : pin?.status === "failed"
                          ? "unavailable"
                          : row.bundled
                            ? "bundled"
                            : entry.category}
                    </span>
                    {selected ? <Check size={13} aria-hidden="true" /> : null}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
