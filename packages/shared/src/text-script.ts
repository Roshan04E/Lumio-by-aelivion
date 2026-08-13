/**
 * Script detection for text layers — ONE detector, two consumers.
 *
 * It answers exactly two questions about a layer's text, and it answers them together on purpose:
 *
 *  1. **Does this text need shaping?** (ADR-023 T-12, stage S0.) Warp lays text out with
 *     `opentype.js` `getPath()`, which is glyph LOOKUP, not shaping — no cursive joining, no
 *     contextual forms, no reordering, no mark positioning. For a script that needs those, warp
 *     renders the wrong glyphs, silently, and has since it shipped. Warp reads `shapingDependent`
 *     and refuses itself when it is true.
 *  2. **Which way does the line run?** (ADR-023 D6a/T-13, stage S0b.) The Unicode Bidi Algorithm
 *     needs a paragraph base direction, and that is not derivable from the glyph stream — nothing
 *     in this package supplies one today, so every layer renders at the CSS initial `ltr`.
 *
 * **Why one function returns both, when today only the first field has a caller.** The standing rule
 * here forbids building infrastructure ahead of its milestone, and this is the case that rule
 * exempts: the second consumer is named, specified and next (plan S0b, immediately after S0). The
 * alternative to a wider return type is not less code — it is two detectors answering one question
 * about the same string, which is how they drift apart. ADR-023 T-12 states this as an obligation.
 *
 * **Not a rendering decision.** `direction` here is an AUTHORING-TIME reading — what a text layer's
 * base direction should DEFAULT to when it is created. No renderer may call this at paint time to
 * infer direction from content (T-13): direction is carried in the manifest and `"auto"` is
 * delegated to the browser's own first-strong rule via `unicode-bidi: plaintext`. We hand the engine
 * its input; we do not reimplement the UBA.
 *
 * Detection is by Unicode script property (`\p{Script=…}`) rather than a hand-maintained block
 * table: both renderers are Chromium and the property data is already in the engine, correct and
 * current, which a table transcribed by hand would not stay.
 */

/**
 * The scripts this detector names. Deliberately only the ones that change one of the two answers:
 * everything else — Latin, Greek, Cyrillic, CJK, Hangul, Kana — is `"other"`, because they share the
 * same answers (left-to-right, no shaping dependency) and naming them individually would imply this
 * function knows something about them that it does not.
 */
export type TextScript =
  | "arabic"
  | "hebrew"
  | "syriac"
  | "thaana"
  | "nko"
  | "adlam"
  | "hanifi-rohingya"
  | "devanagari"
  | "bengali"
  | "gurmukhi"
  | "gujarati"
  | "oriya"
  | "tamil"
  | "telugu"
  | "kannada"
  | "malayalam"
  | "sinhala"
  | "thai"
  | "lao"
  | "tibetan"
  | "myanmar"
  | "khmer"
  | "javanese"
  | "balinese"
  | "mongolian"
  /** A ZWJ / variation-selector sequence — an emoji whose glyph is chosen by the sequence, not the code point. */
  | "emoji-sequence"
  /** A combining mark whose placement is a shaping decision (Latin-with-diacritics and friends). */
  | "combining-marks"
  /** No script that changes either answer. */
  | "other";

export type TextDirection = "ltr" | "rtl";

export interface TextScriptReading {
  /**
   * The first script in the text that changes either answer, or `"other"` when none does. "First"
   * is by position in the string, not by table order, so mixed content names the script that
   * actually appears first.
   */
  script: TextScript;
  /** True when ANY character in the text needs shaping — the whole string, not just `script`. */
  shapingDependent: boolean;
  /**
   * Base direction by the UBA's first-strong rule (P2/P3): the first strongly-directional character
   * decides, and neutrals (punctuation, digits, whitespace) do not. `"ltr"` when there is no strong
   * character at all, which is also the CSS initial value.
   */
  direction: TextDirection;
}

interface ScriptEntry {
  script: TextScript;
  /** Matches exactly one character of this script. */
  match: RegExp;
  shapingDependent: boolean;
  /** Absent for scripts that are not strongly directional (emoji, marks). */
  direction?: TextDirection;
}

/**
 * Order within this table is a tie-break for a single character, not a scan order — the scan is by
 * string position. `combining-marks` sits last so a script that owns its own marks (Devanagari,
 * Arabic) names itself rather than the generic entry.
 */
const SCRIPT_TABLE: readonly ScriptEntry[] = [
  { script: "arabic", match: /\p{Script=Arabic}/u, shapingDependent: true, direction: "rtl" },
  { script: "hebrew", match: /\p{Script=Hebrew}/u, shapingDependent: true, direction: "rtl" },
  { script: "syriac", match: /\p{Script=Syriac}/u, shapingDependent: true, direction: "rtl" },
  { script: "thaana", match: /\p{Script=Thaana}/u, shapingDependent: true, direction: "rtl" },
  { script: "nko", match: /\p{Script=Nko}/u, shapingDependent: true, direction: "rtl" },
  { script: "adlam", match: /\p{Script=Adlam}/u, shapingDependent: true, direction: "rtl" },
  { script: "hanifi-rohingya", match: /\p{Script=Hanifi_Rohingya}/u, shapingDependent: true, direction: "rtl" },
  { script: "devanagari", match: /\p{Script=Devanagari}/u, shapingDependent: true, direction: "ltr" },
  { script: "bengali", match: /\p{Script=Bengali}/u, shapingDependent: true, direction: "ltr" },
  { script: "gurmukhi", match: /\p{Script=Gurmukhi}/u, shapingDependent: true, direction: "ltr" },
  { script: "gujarati", match: /\p{Script=Gujarati}/u, shapingDependent: true, direction: "ltr" },
  { script: "oriya", match: /\p{Script=Oriya}/u, shapingDependent: true, direction: "ltr" },
  { script: "tamil", match: /\p{Script=Tamil}/u, shapingDependent: true, direction: "ltr" },
  { script: "telugu", match: /\p{Script=Telugu}/u, shapingDependent: true, direction: "ltr" },
  { script: "kannada", match: /\p{Script=Kannada}/u, shapingDependent: true, direction: "ltr" },
  { script: "malayalam", match: /\p{Script=Malayalam}/u, shapingDependent: true, direction: "ltr" },
  { script: "sinhala", match: /\p{Script=Sinhala}/u, shapingDependent: true, direction: "ltr" },
  { script: "thai", match: /\p{Script=Thai}/u, shapingDependent: true, direction: "ltr" },
  { script: "lao", match: /\p{Script=Lao}/u, shapingDependent: true, direction: "ltr" },
  { script: "tibetan", match: /\p{Script=Tibetan}/u, shapingDependent: true, direction: "ltr" },
  { script: "myanmar", match: /\p{Script=Myanmar}/u, shapingDependent: true, direction: "ltr" },
  { script: "khmer", match: /\p{Script=Khmer}/u, shapingDependent: true, direction: "ltr" },
  { script: "javanese", match: /\p{Script=Javanese}/u, shapingDependent: true, direction: "ltr" },
  { script: "balinese", match: /\p{Script=Balinese}/u, shapingDependent: true, direction: "ltr" },
  { script: "mongolian", match: /\p{Script=Mongolian}/u, shapingDependent: true, direction: "ltr" },
  // ZWJ (U+200D), ZWNJ (U+200C) and the variation selectors: the sequence, not the code point,
  // decides the glyph. Not strongly directional, so they never set `direction`.
  // Escapes, not the literal characters: ZWJ/ZWNJ/variation selectors are invisible in an editor,
  // and a table nobody can see is a table nobody can review.
  { script: "emoji-sequence", match: /[\u200C\u200D\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/u, shapingDependent: true },
  // Any remaining combining mark — placement is a shaping decision (Latin with diacritics, and the
  // Script=Inherited marks that belong to no single script).
  { script: "combining-marks", match: /\p{M}/u, shapingDependent: true }
];

/** One character is strongly RTL when it belongs to an RTL script in the table above. */
const RTL_STRONG = /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Adlam}\p{Script=Hanifi_Rohingya}]/u;

/**
 * Strongly LTR: a letter that is not one of the RTL scripts. Marks (`\p{M}`), digits (`\p{N}`) and
 * punctuation are deliberately excluded — the UBA treats them as neutral or weak, and a first-strong
 * rule that let a leading digit decide would call `"123 مرحبا"` left-to-right.
 */
const LTR_STRONG = /\p{L}/u;

/**
 * Read a text layer's content. Single pass over code POINTS (`for…of` iterates a string by code
 * point), so astral-plane scripts are matched rather than seen as surrogate halves.
 */
export function detectTextScript(text: string | undefined): TextScriptReading {
  let script: TextScript = "other";
  let shapingDependent = false;
  let direction: TextDirection | undefined;

  for (const char of text ?? "") {
    const entry = SCRIPT_TABLE.find((candidate) => candidate.match.test(char));
    if (entry) {
      if (script === "other") script = entry.script;
      shapingDependent ||= entry.shapingDependent;
    }
    if (direction === undefined) {
      if (RTL_STRONG.test(char)) direction = "rtl";
      else if (LTR_STRONG.test(char)) direction = "ltr";
    }
    // Both answers settled and neither can change again.
    if (shapingDependent && script !== "other" && direction !== undefined) break;
  }

  return { script, shapingDependent, direction: direction ?? "ltr" };
}
