/**
 * ADR-023 S2.7 — Bold picks the bold FILE, and a family without one says so.
 *
 * The plan asks for the single-style path to be ASSERTED rather than eyeballed, which is why the
 * decision lives in a pure function instead of inside a click handler. Every rule below is reachable
 * from `planFaceChange` and `faceControlBlocked` without a browser, a network, or a render.
 *
 * The defect this guards is specific and was live until this stage: a pinned ref's weight comes from
 * the REF (`fontRefCss`), so the layer's CSS `fontWeight` was unread and Bold over a pinned font did
 * nothing at all. The failure mode on the other side is worse — resolving Bold to the family's
 * regular cut, or letting the browser faux-bold it, both of which look like it worked.
 *
 * Run: pnpm --filter @orreris/worker font:face-test
 */
import assert from "node:assert/strict";
import {
  faceControlBlocked,
  familyFaces,
  familyHasBold,
  familyHasItalic,
  FACE_BOLD_WEIGHT,
  isBoldActive,
  isItalicActive,
  LEGACY_CSS_BOLD_WEIGHT,
  planFaceChange,
  registerUserFontFaces,
  resolveFamilyFace,
  type FontRef
} from "@orreris/shared";

const arimo = (weight: number, style: "normal" | "italic" = "normal"): FontRef => ({
  source: "catalogue",
  family: "Arimo",
  weight,
  style,
  fileHash: "hash-arimo"
});
const anton: FontRef = { source: "catalogue", family: "Anton", weight: 400, style: "normal", fileHash: "hash-anton" };
const cairo = (weight: number): FontRef => ({ source: "catalogue", family: "Cairo", weight, style: "normal", fileHash: "hash-cairo" });
const legacy: FontRef = { source: "system", fontFamily: "Arial, Helvetica, sans-serif" };

function main(): void {
  /* ---- The face lists these rules stand on. Asserted, because everything below is void if the
   *      index ever stops describing these families the way it does today. ---------------------- */
  assert.deepEqual(
    familyFaces("Anton").map((face) => `${face.weight}${face.style === "italic" ? "i" : ""}`),
    ["400"],
    "Anton must be single-cut — it is the standing example for the no-bold path, and a second cut voids it."
  );
  assert.ok(familyFaces("Arimo").length >= 4, "Arimo must offer several cuts including italics.");
  assert.ok(familyHasBold("Arimo") && familyHasItalic("Arimo"));
  assert.equal(familyHasBold("Anton"), false);
  assert.equal(familyHasItalic("Anton"), false);
  // Cairo: nine weights, no italics. The two axes are independent, and a family can have one and
  // not the other — which a single "has other cuts" boolean would have collapsed.
  assert.equal(familyHasBold("Cairo"), true);
  assert.equal(familyHasItalic("Cairo"), false);
  assert.equal(familyFaces("No Such Family").length, 0);

  /* ---- Resolution never crosses styles. ------------------------------------------------------ */
  assert.deepEqual(resolveFamilyFace("Arimo", FACE_BOLD_WEIGHT, "normal"), { weight: 700, style: "normal" });
  assert.deepEqual(resolveFamilyFace("Arimo", 400, "italic"), { weight: 400, style: "italic" });
  assert.equal(
    resolveFamilyFace("Anton", 400, "italic"),
    undefined,
    "an italic request on a family with no italic must answer NOTHING. `catalogueFace` and `fontIndexFace` " +
      "would hand back the roman — correct when the question is 'what do I show', a lie when it is 'does this cut exist'."
  );
  assert.equal(resolveFamilyFace("Cairo", 400, "italic"), undefined);
  // Nearest WITHIN the style, not the first listed.
  assert.equal(resolveFamilyFace("Cairo", FACE_BOLD_WEIGHT, "normal")?.weight, 700);
  assert.equal(resolveFamilyFace("Cairo", 1000, "normal")?.weight, 1000);

  /* ---- THE STAGE: Bold over a pinned family rewrites the ref to a real cut. ------------------ */
  const boldPlan = planFaceChange({ fontRef: arimo(400), fontWeight: 400, italic: false }, { bold: true });
  assert.equal(boldPlan.kind, "face", "Bold over a pinned family must pick a FILE, not emit CSS.");
  assert.deepEqual(boldPlan, { kind: "face", source: "catalogue", family: "Arimo", weight: 700, style: "normal" });

  const unboldPlan = planFaceChange({ fontRef: arimo(700), fontWeight: 400, italic: false }, { bold: false });
  assert.deepEqual(
    unboldPlan,
    { kind: "face", source: "catalogue", family: "Arimo", weight: 400, style: "normal" },
    "…and turning it off comes back."
  );

  // Italic is the same mechanism, and the two compose: bold + italic must land on the bold italic
  // file rather than on one of them plus a synthetic other.
  assert.deepEqual(planFaceChange({ fontRef: arimo(700), fontWeight: 400, italic: false }, { italic: true }), {
    kind: "face",
    source: "catalogue",
    family: "Arimo",
    weight: 700,
    style: "italic"
  });

  /* ---- NO CUT, NO LIE — the declared decision, asserted rather than eyeballed. --------------- */
  const antonBold = planFaceChange({ fontRef: anton, fontWeight: 400, italic: false }, { bold: true });
  assert.equal(
    antonBold.kind,
    "unavailable",
    "Anton has ONE weight. Planning a bold for it must refuse. Resolving to its regular cut, or letting the " +
      "browser synthesise, are both 'it looked like it worked' — smeared on screen and different in the export."
  );
  assert.match((antonBold as { reason: string }).reason, /Anton/, "and the refusal must name the family.");
  assert.equal(planFaceChange({ fontRef: anton, fontWeight: 400, italic: false }, { italic: true }).kind, "unavailable");
  assert.equal(planFaceChange({ fontRef: cairo(400), fontWeight: 400, italic: false }, { italic: true }).kind, "unavailable");

  // The control says so BEFORE it is clicked, which is the half a user actually meets.
  const antonBlocked = faceControlBlocked({ fontRef: anton, fontWeight: 400, italic: false }, "bold");
  assert.ok(antonBlocked && antonBlocked.includes("Anton"), "the disabled control must carry a reason naming the family.");
  assert.ok(faceControlBlocked({ fontRef: anton, fontWeight: 400, italic: false }, "italic"));
  assert.equal(faceControlBlocked({ fontRef: arimo(400), fontWeight: 400, italic: false }, "bold"), undefined);
  assert.equal(faceControlBlocked({ fontRef: cairo(400), fontWeight: 400, italic: false }, "bold"), undefined, "Cairo HAS bold…");
  assert.ok(faceControlBlocked({ fontRef: cairo(400), fontWeight: 400, italic: false }, "italic"), "…and has no italic.");

  /**
   * A ref already ON the cut must be able to leave it, even when the family's face list says that
   * cut is unavailable — an uploaded font whose siblings are unknown, with a bold one that could
   * never be un-bolded, would be a trap. This is the asymmetry: refusing to CREATE a cut we cannot
   * serve is honest; refusing to leave one the layer already holds is a dead end.
   */
  const userBold: FontRef = { source: "user", family: "Brand Sans", weight: 700, style: "normal", fileHash: "h", ownerId: "u1" };
  assert.equal(familyFaces("Brand Sans", "user").length, 0, "nothing registered yet — that is the case under test.");
  assert.equal(faceControlBlocked({ fontRef: userBold, fontWeight: 400, italic: false }, "bold"), undefined, "…so bold-off stays reachable.");
  const userRegular: FontRef = { ...userBold, weight: 400 };
  assert.ok(
    faceControlBlocked({ fontRef: userRegular, fontWeight: 400, italic: false }, "bold"),
    "but bold-ON for a font whose siblings we do not know must refuse rather than guess."
  );

  /* ---- S3 / T-18: an uploaded family GROUPS, and grouping does not loosen the rule. ---------- */
  registerUserFontFaces([
    { family: "Brand Sans", weight: 400, style: "normal" },
    { family: "Brand Sans", weight: 700, style: "normal" },
    // Uploaded twice — same family, weight and style. Content-addressed, so it is the same FILE.
    { family: "Brand Sans", weight: 700, style: "normal" },
    { family: "Brand Serif", weight: 400, style: "normal" }
  ]);
  assert.equal(familyFaces("Brand Sans", "user").length, 2, "a duplicate upload is one cut, not two rows pinning identical bytes.");
  assert.equal(
    faceControlBlocked({ fontRef: userRegular, fontWeight: 400, italic: false }, "bold"),
    undefined,
    "THE SEAM S2.7 LEFT: once an uploaded font has known siblings, bold stops refusing."
  );
  const userPlan = planFaceChange({ fontRef: userRegular, fontWeight: 400, italic: false }, { bold: true });
  assert.deepEqual(
    userPlan,
    { kind: "face", source: "user", family: "Brand Sans", weight: 700, style: "normal" },
    "…and the plan carries the STORE, because a user cut is one this account uploaded and can never be fetched."
  );

  /**
   * **T-18 holds for uploaded fonts too, and this is the arm the rule was written for.** The user
   * has uploaded no italic. A nearest-match resolver would answer with the roman and the layer would
   * claim a cut that does not exist — "an uploaded roman silently answers a bold request", one axis
   * over. Grouping gives the resolver more to say, never permission to guess.
   */
  assert.equal(familyHasItalic("Brand Sans", "user"), false);
  assert.equal(resolveFamilyFace("Brand Sans", 400, "italic", "user"), undefined, "no italic uploaded, no italic answered.");
  assert.ok(faceControlBlocked({ fontRef: userRegular, fontWeight: 400, italic: false }, "italic"));
  assert.equal(planFaceChange({ fontRef: userRegular, fontWeight: 400, italic: false }, { italic: true }).kind, "unavailable");
  // Brand Serif has only a regular, so it behaves exactly like Anton — the single-cut path is not
  // special-cased per store.
  const serifRef: FontRef = { source: "user", family: "Brand Serif", weight: 400, style: "normal", fileHash: "h2", ownerId: "u1" };
  assert.equal(planFaceChange({ fontRef: serifRef, fontWeight: 400, italic: false }, { bold: true }).kind, "unavailable");

  /**
   * **The two stores do not blur, and this is D4 showing up in the resolver.** A user who uploads
   * their own "Arimo" — one weight — must NOT have Google's Arimo answer for its bold, or the editor
   * would pin a catalogue file the layer never named and a render for another account would then
   * resolve it perfectly happily.
   */
  registerUserFontFaces([{ family: "Arimo", weight: 400, style: "normal" }]);
  assert.equal(familyFaces("Arimo", "user").length, 1, "the user's Arimo is theirs…");
  assert.ok(familyFaces("Arimo", "catalogue").length >= 4, "…and the catalogue's Arimo is unaffected.");
  const userArimo: FontRef = { source: "user", family: "Arimo", weight: 400, style: "normal", fileHash: "h3", ownerId: "u1" };
  assert.equal(
    planFaceChange({ fontRef: userArimo, fontWeight: 400, italic: false }, { bold: true }).kind,
    "unavailable",
    "an uploaded single-weight Arimo must not borrow Google's bold — same name, different store, different font."
  );
  assert.equal(
    planFaceChange({ fontRef: arimo(400), fontWeight: 400, italic: false }, { bold: true }).kind,
    "face",
    "…while the CATALOGUE Arimo still bolds, from its own store."
  );
  registerUserFontFaces([]);
  assert.equal(familyFaces("Arimo", "user").length, 0, "registering an empty set clears it — removing a font removes its cuts.");

  /* ---- D1a: the legacy path is UNTOUCHED, including the weight it has always written. -------- */
  const legacyInput = { fontRef: legacy, fontWeight: 400, italic: false };
  assert.deepEqual(
    planFaceChange(legacyInput, { bold: true }),
    { kind: "css", fontWeight: LEGACY_CSS_BOLD_WEIGHT, italic: false },
    "a system stack has no files to choose between; it bolds via CSS exactly as it always has."
  );
  assert.equal(
    LEGACY_CSS_BOLD_WEIGHT,
    900,
    "900 is what this editor has always written for Bold. Changing it would move every legacy render, which " +
      "render:baseline would correctly refuse — and D1a says a legacy project never moves."
  );
  assert.notEqual(LEGACY_CSS_BOLD_WEIGHT, FACE_BOLD_WEIGHT, "the CSS weight and the face weight are different questions.");
  assert.deepEqual(planFaceChange(legacyInput, { italic: true }), { kind: "css", fontWeight: 400, italic: true });
  assert.equal(faceControlBlocked(legacyInput, "bold"), undefined, "a legacy layer's controls are NEVER disabled…");
  assert.equal(faceControlBlocked(legacyInput, "italic"), undefined);
  assert.equal(planFaceChange({ fontRef: undefined, fontWeight: 400, italic: false }, { bold: true }).kind, "css", "…nor are an unset one's.");

  /* ---- Which way the toggle is lit. For a pinned layer the REF is the truth. ----------------- */
  assert.equal(
    isBoldActive({ fontRef: arimo(700), fontWeight: 400, italic: false }),
    true,
    "a pinned bold ref reads as bold even though the layer's CSS weight says 400 — the CSS weight is UNREAD, " +
      "and this is the exact mismatch that made the toggle look broken."
  );
  assert.equal(isBoldActive({ fontRef: arimo(400), fontWeight: 900, italic: false }), false, "…and the converse.");
  assert.equal(isBoldActive({ fontRef: legacy, fontWeight: 900, italic: false }), true, "a legacy layer still reads its CSS weight.");
  assert.equal(isItalicActive({ fontRef: arimo(400, "italic"), fontWeight: 400, italic: false }), true);
  assert.equal(isItalicActive({ fontRef: legacy, fontWeight: 400, italic: true }), true);

  /**
   * ---- Where S9 will meet this, recorded so the collision is not a surprise. -----------------
   *
   * Cairo is a VARIABLE family. It appears here as nine separate weights because Google's index
   * enumerates a variable font's instances and its CDN serves a static instance per weight — so
   * "Cairo 700" is a pinned static cut and this stage is picking between files, exactly as scoped.
   * S9 needs the opposite: ONE variable file plus `font-variation-settings`, because animating
   * weight by swapping pinned files means a different `fileHash` per frame, and T-8 makes each one a
   * different raster. This assertion is here to fail loudly if someone "fixes" the enumeration.
   */
  assert.ok(familyFaces("Cairo").length >= 8, "Cairo's instances are enumerated as separate faces — S9 will need to stop doing this.");

  console.log(
    `Face resolution passed. Arimo ${familyFaces("Arimo").length} cuts, Cairo ${familyFaces("Cairo").length} (no italic), ` +
      `Anton ${familyFaces("Anton").length} — bold refused, not faked; uploaded families group without loosening T-18.`
  );
}

main();
