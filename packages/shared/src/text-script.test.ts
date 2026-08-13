/**
 * Standalone assert script for the text script detector (repo convention: no test framework —
 * exits non-zero on first failure).
 *
 *   pnpm --filter @orreris/shared textscript:test
 *
 * This detector has two consumers with different needs (warp's refusal gate, ADR-023 T-12; base
 * direction, D6a/S0b), so both fields are locked here rather than only the one with a caller today.
 * The direction cases are the ones worth reading: they encode the UBA's first-strong rule, where
 * digits and punctuation are NOT strong and therefore must not decide.
 */
import assert from "node:assert/strict";
import { detectTextScript } from "./text-script";

const ARABIC = "مرحبا";
const HEBREW = "שלום";
const DEVANAGARI = "नमस्ते";
const THAI = "สวัสดี";

// Latin: neither answer is interesting, and that is the point — the common case must stay inert.
assert.deepEqual(detectTextScript("Warp"), { script: "other", shapingDependent: false, direction: "ltr" });
assert.deepEqual(detectTextScript(""), { script: "other", shapingDependent: false, direction: "ltr" });
assert.deepEqual(detectTextScript(undefined), { script: "other", shapingDependent: false, direction: "ltr" });

// The scripts warp renders wrong today.
assert.deepEqual(detectTextScript(ARABIC), { script: "arabic", shapingDependent: true, direction: "rtl" });
assert.deepEqual(detectTextScript(HEBREW), { script: "hebrew", shapingDependent: true, direction: "rtl" });
assert.deepEqual(detectTextScript(DEVANAGARI), { script: "devanagari", shapingDependent: true, direction: "ltr" });
assert.deepEqual(detectTextScript(THAI), { script: "thai", shapingDependent: true, direction: "ltr" });

// `shapingDependent` is about the WHOLE string, not the first script found: a Latin-first line with
// Arabic later still cannot be warped. This is the case a "detect the first script" reading gets
// wrong, and it is the reading warp depends on.
const mixed = detectTextScript(`Brand ${ARABIC}`);
assert.equal(mixed.shapingDependent, true, "Arabic anywhere in the line must suppress warp.");
assert.equal(mixed.script, "arabic", "the first script that changes an answer names the reading.");
assert.equal(mixed.direction, "ltr", "first-strong: a leading Latin word makes the base direction ltr.");

// …and the mirror image, which is what makes the first-strong rule a rule rather than a coincidence.
assert.equal(detectTextScript(`${ARABIC} Brand`).direction, "rtl");

// Neutrals must not decide. A digit or a quote before the first letter is weak/neutral under the
// UBA, so a rule that let them settle the direction would call this line left-to-right.
assert.equal(detectTextScript(`123 ${ARABIC}`).direction, "rtl", "digits are not strong.");
assert.equal(detectTextScript(`"${ARABIC}"`).direction, "rtl", "punctuation is not strong.");
assert.equal(detectTextScript("123 456").direction, "ltr", "no strong character at all → the CSS initial.");

// Combining marks: placement is a shaping decision even over Latin bases.
// NOTE the escape: this is "cafe" + U+0301 COMBINING ACUTE, not the precomposed U+00E9. Written
// literally, the two are indistinguishable on screen and only one of them exercises this rule.
const combining = detectTextScript("cafe\u0301");
assert.equal(combining.shapingDependent, true, "a combining acute needs mark positioning.");
assert.equal(combining.direction, "ltr");

// Emoji ZWJ sequences: the sequence picks the glyph, which glyph lookup cannot see.
assert.equal(detectTextScript("\u{1F469}\u200D\u{1F680}").shapingDependent, true, "a ZWJ sequence needs shaping.");

// A plain emoji is NOT a sequence and needs no shaping — the control that keeps the rule above from
// being "any emoji", which would refuse warp on a large share of real captions.
assert.equal(detectTextScript("hi \u{1F680}").shapingDependent, false, "a lone emoji is not a shaping case.");

process.stdout.write("text-script: OK\n");
