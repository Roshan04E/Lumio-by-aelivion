/**
 * ADR-023 S2.5 / S2.6 / T-17 — load faces so the picker can PREVIEW them in their own typeface.
 *
 * A font list that shows every family's name set in the same fallback is worse than useless: it
 * looks exactly like one that works, and picking from it is guesswork. That is not hypothetical —
 * `warpFontCatalog` shipped empty once and every warped family silently rendered as Roboto, which
 * reached a user as "changing the font did nothing".
 *
 * **These bytes are for PREVIEW, and deliberately not for rendering.** Every face is installed under
 * a distinct `<family> Preview` CSS family so it can never be picked up by a layer's CSS by
 * accident. A layer's own font still installs through `installPinnedFont`, which reads the store and
 * reports `missing` when it cannot — because an editor that quietly rendered preview bytes while the
 * worker aborted on the same project would be the editor and the export disagreeing, which is
 * exactly what S2 exists to prevent.
 *
 * ## S2.6: two sources, and the reason the split is not an optimisation
 *
 * - **Bundled** (`font-catalogue.ts`) — five families shipped as files in `public/fonts`. Offline,
 *   instant, hash-verified against the catalogue by `font:catalogue-test`.
 * - **Remote** (the index's ~1900 others) — fetched from Google's CSS API on demand, in batches, and
 *   only for rows the user can actually see.
 *
 * Loading 1942 families' faces to draw a list is the whole reason font pickers feel broken, so
 * nothing here loads until something asks for a specific family — which the virtualized list does
 * only for rows near the viewport. The batching matters as much as the laziness: a window of twenty
 * rows is ONE request, not twenty.
 *
 * A remote preview that fails leaves the family `unavailable`, and the row SAYS so rather than
 * quietly falling back to the UI font (T-17). Offline, that is every remote family — correct and
 * visible, rather than a list of names all set in Helvetica pretending to be a font picker.
 */
import { fontCatalogue, fontIndexFamily, type CatalogueFace, type FontIndexFamily } from "@orreris/shared";

/** The CSS family a preview is installed under. Never the bare family name — see the module note. */
export function previewFamily(family: string): string {
  return `${family} Preview`;
}

export type PreviewState = "pending" | "loaded" | "unavailable";

const states = new Map<string, PreviewState>();
const loadedHashes = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

export function subscribeCataloguePreviews(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function cataloguePreviewVersion(): number {
  return version;
}

export function previewState(family: string): PreviewState | undefined {
  return states.get(family);
}

/** Has this BUNDLED face's preview loaded? Kept keyed on the hash — S2.5's callers pass a face. */
export function isPreviewLoaded(family: string, face: CatalogueFace): boolean {
  return loadedHashes.has(face.fileHash);
}

/* ------------------------------------------------------------------------------------------------
 * Sample text
 * ---------------------------------------------------------------------------------------------- */

/**
 * The string a row is set in, chosen from the family's scripts.
 *
 * "Ag" tells you nothing about an Arabic face, and worse: the Latin glyphs of a Noto Naskh Arabic
 * are not what the user is picking it FOR, so a Latin-only sample makes every Arabic family in the
 * list look interchangeable. This is the same join S0b/S0c live on — the RTL work is unreachable in
 * practice if the picker cannot show you what you are choosing.
 */
const SCRIPT_SAMPLES: ReadonlyArray<{ subset: string; sample: string }> = [
  { subset: "arabic", sample: "أبجد" },
  { subset: "hebrew", sample: "אבגד" },
  { subset: "devanagari", sample: "अआइ" },
  { subset: "thai", sample: "กขคง" },
  { subset: "korean", sample: "가나다" },
  { subset: "japanese", sample: "あいう" },
  { subset: "chinese-simplified", sample: "汉字" },
  { subset: "chinese-traditional", sample: "漢字" },
  { subset: "greek", sample: "Αβγ" },
  { subset: "cyrillic", sample: "Абв" }
];

export function previewSample(subsets: readonly string[], preferred?: string | undefined): string {
  // The active SCRIPT FILTER wins, because it is the user saying what they are shopping for. Without
  // this, filtering to Arabic and then sampling every row with "Ag" — which most of those families
  // also cover — shows the one part of the face nobody filtered for.
  if (preferred) {
    const match = SCRIPT_SAMPLES.find((entry) => entry.subset === preferred);
    if (match && subsets.includes(preferred)) return match.sample;
  }
  // Otherwise Latin wins when the family has it: a family covering both is normally chosen for Latin
  // and the Latin cut is what the row is being compared against.
  if (subsets.includes("latin")) return "Ag";
  for (const entry of SCRIPT_SAMPLES) if (subsets.includes(entry.subset)) return entry.sample;
  return "Ag";
}

/* ------------------------------------------------------------------------------------------------
 * The bundled path — unchanged from S2.5, and the only path that works offline.
 * ---------------------------------------------------------------------------------------------- */

const bundledStarted = new Set<string>();

async function loadBundledFace(family: string, face: CatalogueFace): Promise<void> {
  if (bundledStarted.has(face.fileHash)) return;
  bundledStarted.add(face.fileHash);
  try {
    const fontFace = new FontFace(previewFamily(family), `url(/${face.file})`, {
      weight: String(face.weight),
      style: face.style
    });
    await fontFace.load();
    document.fonts.add(fontFace);
    loadedHashes.add(face.fileHash);
    states.set(family, "loaded");
    notify();
  } catch {
    // Left unloaded, so the row shows as unavailable rather than silently rendering its name in the
    // fallback and implying the face is what you would get.
    if (states.get(family) !== "loaded") states.set(family, "unavailable");
    notify();
  }
}

/** Load every BUNDLED face's preview. Idempotent; safe to call on every render. */
export function loadCataloguePreviews(): void {
  for (const entry of fontCatalogue) {
    for (const face of entry.faces) void loadBundledFace(entry.family, face);
  }
}

const bundledFamilies = new Set(fontCatalogue.map((entry) => entry.family));

/* ------------------------------------------------------------------------------------------------
 * The remote path — batched, lazy, and honest about failing.
 * ---------------------------------------------------------------------------------------------- */

/** Max families per CSS request. Keeps the URL well inside any proxy's limit and the batch quick. */
const BATCH_SIZE = 16;
/** How long a request waits to collect companions. One scroll tick, not a perceptible delay. */
const BATCH_DELAY_MS = 60;
/**
 * How many pending requests are kept at all. Beyond this the OLDEST are dropped.
 *
 * Scrolling a 1942-row list past a few hundred families would otherwise queue every one of them, and
 * the user is not waiting on the rows they flew past — they are waiting on the rows in front of them
 * right now.
 */
const QUEUE_LIMIT = 96;

/**
 * Pending requests, keyed by family, carrying the exact TEXT the row will draw.
 *
 * The text is part of the request rather than a detail of rendering, because loading is per
 * unicode-range subset: a family fetched for "Ag" has its latin block and not its arabic one, so
 * drawing أبجد in it would show the fallback while the row reported itself loaded. That is a T-17
 * failure introduced by an optimisation, which is exactly the shape T-17 exists to catch.
 */
const queue = new Map<string, { entry: FontIndexFamily; sample: string }>();
/** Which samples a family has actually been loaded for. */
const loadedSamples = new Map<string, Set<string>>();
let flushTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Parse a Google CSS payload into installable faces.
 *
 * `css2` answers with one `@font-face` per unicode-range SUBSET, not one per family — an Arabic
 * family comes back as arabic + latin + latin-ext blocks. All of them are installed, each with its
 * own `unicodeRange`, so the browser resolves per codepoint exactly as it would on a real page.
 * Taking only the first block would work for Latin and quietly show tofu for every script this
 * stage exists to reach.
 */
function parseFontFaceBlocks(css: string): Array<{ family: string; weight: string; style: string; url: string; unicodeRange?: string | undefined }> {
  const blocks: Array<{ family: string; weight: string; style: string; url: string; unicodeRange?: string | undefined }> = [];
  for (const match of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const body = match[1] ?? "";
    const family = /font-family:\s*'([^']+)'/.exec(body)?.[1];
    const url = /src:\s*url\((https:[^)]+)\)/.exec(body)?.[1];
    if (!family || !url) continue;
    blocks.push({
      family,
      weight: /font-weight:\s*([^;]+);/.exec(body)?.[1]?.trim() ?? "400",
      style: /font-style:\s*([^;]+);/.exec(body)?.[1]?.trim() ?? "normal",
      url,
      unicodeRange: /unicode-range:\s*([^;]+);/.exec(body)?.[1]?.trim()
    });
  }
  return blocks;
}

async function flushQueue(): Promise<void> {
  flushTimer = undefined;
  /**
   * **LIFO, and this was a defect found by looking at the picker rather than at the clock.** The
   * first version took the OLDEST requests first, which is the intuitive order and the wrong one: a
   * user who scrolls through three hundred families and stops sees rows that stay blank, because the
   * families now on screen are queued behind every family they scrolled past. Screenshotting the
   * Arabic filter after a long scroll showed exactly that — one row in its own face and fifty-six
   * showing the pending dot.
   *
   * The most recent request is the one the user is looking at. Everything else is speculative.
   */
  const batch = [...queue.values()].slice(-BATCH_SIZE).reverse();
  for (const item of batch) queue.delete(item.entry.family);
  if (queue.size) scheduleFlush();
  if (!batch.length) return;

  // One request for the whole window. The weight asked for is the family's own regular-ish cut, so
  // the row is drawn in a real face rather than a synthesized one.
  const params = batch
    .map(({ entry }) => {
      const weight = entry.faces.find((face) => face.style === "normal" && face.weight === 400)?.weight ?? entry.faces[0]!.weight;
      return `family=${encodeURIComponent(entry.family)}:wght@${weight}`;
    })
    .join("&");

  try {
    const response = await fetch(`https://fonts.googleapis.com/css2?${params}&display=swap`);
    if (!response.ok) throw new Error(`css2 ${response.status}`);
    const blocks = parseFontFaceBlocks(await response.text());
    /**
     * **Register every block, download none of them yet.** A `FontFace` added to `document.fonts`
     * without `.load()` sits there unloaded and fetches only when something actually needs it, and
     * `document.fonts.load(font, TEXT)` then pulls exactly the unicode-range blocks that cover that
     * text. Asking for the sample string is the difference between one file per family and all of
     * them: an Arabic family answers with arabic + latin + latin-ext, so eagerly loading each block
     * made a batch of sixteen families into roughly fifty downloads. Measured, not assumed — the
     * picker showed one row in its own face and eight still pending two and a half seconds after the
     * Arabic filter was applied.
     */
    for (const block of blocks) {
      try {
        const descriptors: FontFaceDescriptors = { weight: block.weight, style: block.style };
        if (block.unicodeRange) descriptors.unicodeRange = block.unicodeRange;
        document.fonts.add(new FontFace(previewFamily(block.family), `url(${block.url})`, descriptors));
      } catch {
        // A malformed block is one row's problem, never the batch's.
      }
    }
    await Promise.all(
      batch.map(async ({ entry, sample }) => {
        try {
          const faces = await document.fonts.load(`16px '${previewFamily(entry.family)}'`, sample);
          if (faces.length) {
            const samples = loadedSamples.get(entry.family) ?? new Set<string>();
            samples.add(sample);
            loadedSamples.set(entry.family, samples);
            states.set(entry.family, "loaded");
          } else {
            states.set(entry.family, "unavailable");
          }
        } catch {
          states.set(entry.family, "unavailable");
        }
      })
    );
  } catch {
    // Offline, blocked, or refused. Every family in the batch is unavailable, and SAYS so.
    for (const { entry } of batch) if (states.get(entry.family) !== "loaded") states.set(entry.family, "unavailable");
  }
  notify();
}

function scheduleFlush(): void {
  if (flushTimer !== undefined) return;
  flushTimer = setTimeout(() => void flushQueue(), BATCH_DELAY_MS);
}

/**
 * Ask for one family's preview. Idempotent, and cheap enough to call from a render.
 *
 * The virtualized list calls this for rows near the viewport and for nothing else. That restraint is
 * the whole "not laggy" half of the brief: the cost of a font picker was never the filtering, it was
 * fetching a face per row for rows nobody is looking at.
 */
export function requestPreview(family: string, sample?: string): void {
  if (bundledFamilies.has(family)) {
    // Bundled faces ship whole — no unicode-range splitting — so the sample is irrelevant here.
    if (states.has(family)) return;
    states.set(family, "pending");
    const entry = fontCatalogue.find((candidate) => candidate.family === family);
    for (const face of entry?.faces ?? []) void loadBundledFace(family, face);
    return;
  }

  const indexed = fontIndexFamily(family);
  if (!indexed) return;
  const wanted = sample ?? previewSample(indexed.subsets);

  // Already loaded FOR THIS TEXT. A family loaded for "Ag" is not loaded for أبجد — different
  // unicode-range block, different file — so the sample is part of the question.
  if (loadedSamples.get(family)?.has(wanted)) return;

  // Already pending AND still queued: re-insert so it goes to the BACK of the map, which is the
  // FRONT of the LIFO drain. Without this, a family queued while the user scrolled past it keeps
  // that old position forever, and asking for it again — which is what landing on it does — has no
  // effect at all. That is the same "rows you are looking at stay blank" defect as the FIFO drain,
  // one level down, and it survived the first fix.
  if (queue.has(family)) {
    queue.delete(family);
    queue.set(family, { entry: indexed, sample: wanted });
    return;
  }
  if (states.get(family) === "pending") return;
  states.set(family, "pending");
  queue.set(family, { entry: indexed, sample: wanted });
  // Evict the oldest speculative requests. Their `pending` state is cleared too, so a row that comes
  // back into view can ask again — a family stuck `pending` with nothing queued for it would show
  // the loading dot forever, which is the pending state lying rather than reporting.
  while (queue.size > QUEUE_LIMIT) {
    const oldest = queue.keys().next().value;
    if (oldest === undefined) break;
    queue.delete(oldest);
    states.delete(oldest);
  }
  scheduleFlush();
}

/** Reset — probes and tests only. */
export function __resetPreviewsForTest(): void {
  states.clear();
  queue.clear();
  loadedSamples.clear();
}
