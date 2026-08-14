/**
 * ADR-023 S4 — copy-paste a LOOK between two text layers, in the real editor.
 *
 *   pnpm --filter @orreris/worker text:look-probe
 *
 * WHAT THIS PROVES THAT THE UNIT GATES DO NOT. `textstyle:schema` proves capture → envelope → apply
 * moves every presetable field and that each one changes the emitted style. It does that against
 * `TimelineLayer` objects it constructs itself. This drives the product: two real text layers, the
 * real inspector, the real Copy Look / Paste Look buttons, and then reads the **computed style of the
 * rendered text in the preview** — the DOM the user is actually looking at.
 *
 * The measurement discipline is the repo's standing one: prove the instrument can tell the answers
 * apart before believing it. This probe reads the target's computed style BEFORE the paste as well as
 * after, and fails if they were already equal — a "look pasted successfully" verdict on two layers
 * that were identical to begin with is the shape of a probe measuring nothing.
 */
import { chromium } from "playwright";
import { EDITOR_BASE, reachEditor } from "./browser/editor-session";
import { assertQuietBrowserMachine } from "./browser/browser-preflight";

interface Probed {
  fontSize: string;
  color: string;
  webkitTextStrokeWidth: string;
  webkitTextStrokeColor: string;
  letterSpacing: string;
  paintOrder: string;
}

const failures: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ok  ${name}${detail ? ` — ${detail}` : ""}`);
  else {
    failures.push(name);
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main(): Promise<void> {
  assertQuietBrowserMachine({ label: "text-look-clipboard-probe", scriptMarker: "text-look-clipboard-probe" });

  const browser = await chromium.launch({ channel: process.env.PIXEL_BROWSER_CHANNEL ?? "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1200 } });
  try {
    await reachEditor(page);
    console.log(`editor: ${page.url()}`);

    // The right-hand inspector is not open by default at this viewport, and every row this probe
    // reads lives in it.
    const inspectorToggle = page.getByRole("button", { name: /^inspector$/i }).first();
    if (await inspectorToggle.count().catch(() => 0)) {
      await inspectorToggle.click();
      await page.waitForTimeout(1200);
    }

    // --- two text layers ------------------------------------------------------------------
    // A new layer is placed AT THE PLAYHEAD (`handleAddLayer` → `createEditorLayer(…,
    // currentTimeRef.current)`). Adding two without moving it stacks them in one lane at 0s, where
    // each intercepts clicks meant for the other — so the playhead is moved between the two adds.
    const addText = page.locator('button[title="Add text"]').first();
    await addText.waitFor({ state: "visible", timeout: 20_000 });
    await addText.click();
    await page.waitForTimeout(1200);

    await addText.click();
    await page.waitForTimeout(1200);

    // Both landed at 0s in one lane, so the upper clip swallows every click meant for the lower one.
    // Drag the upper one down the timeline until they no longer overlap — the same gesture a user
    // would make, and the fixture is not honest until they are separately selectable.
    const upper = page.locator(".timeline-clip", { hasText: /text/i }).nth(1);
    const box = await upper.boundingBox();
    if (!box) throw new Error("no timeline clip to separate — VOID");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + box.width + 40, box.y + box.height / 2, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(900);

    const separated = await page.evaluate(() => {
      const boxes = Array.from(document.querySelectorAll(".timeline-clip-text")).map((el) => el.getBoundingClientRect());
      if (boxes.length < 2) return false;
      const [a, b] = boxes.sort((l, r) => l.left - r.left);
      return a!.right <= b!.left + 1;
    });
    check("fixture: the two text clips are separately selectable", separated);
    if (!separated) throw new Error("clips still overlap — a click would land on the wrong layer, VOID");

    const textClips = page.locator(".timeline-clip", { hasText: /text/i });
    const clipCount = await textClips.count();
    check("fixture: two text layers exist", clipCount >= 2, `${clipCount} text clip(s)`);
    if (clipCount < 2) throw new Error("cannot probe a paste without two layers — VOID");


    /**
     * The preview's rendered text nodes. The preview only draws layers live AT THE PLAYHEAD, and the
     * two clips had to be separated in time to be separately clickable — so this is read once per
     * layer, with the playhead parked over that layer, rather than as a pair.
     */
    async function renderedStyles(): Promise<Probed[]> {
      return page.evaluate(() => {
        const nodes = Array.from(document.querySelectorAll<HTMLElement>(".preview-text-layer"));
        return nodes.map((node) => {
          const s = getComputedStyle(node);
          return {
            fontSize: s.fontSize,
            color: s.color,
            webkitTextStrokeWidth: s.webkitTextStrokeWidth,
            webkitTextStrokeColor: s.webkitTextStrokeColor,
            letterSpacing: s.letterSpacing,
            paintOrder: s.paintOrder
          };
        });
      });
    }

    /** Park the playhead over a clip and read the one text layer the preview then draws. */
    async function styleOfClip(index: number): Promise<Probed> {
      const clip = await textClips.nth(index).boundingBox();
      if (!clip) throw new Error(`clip ${index} has no box — VOID`);
      const ruler = await page.locator(".timeline-ruler").first().boundingBox();
      if (!ruler) throw new Error("no ruler to seek with — VOID");
      await page.mouse.click(clip.x + clip.width / 2, ruler.y + ruler.height / 2);
      await page.waitForTimeout(900);
      const drawn = await renderedStyles();
      if (drawn.length !== 1) {
        throw new Error(`playhead over clip ${index} drew ${drawn.length} text layer(s), expected exactly 1 — VOID`);
      }
      return drawn[0]!;
    }

    /** Select a text clip and give the inspector a moment to rebuild. */
    async function selectClip(index: number): Promise<void> {
      await textClips.nth(index).click({ timeout: 15_000 });
      await page.waitForTimeout(900);
    }

    // --- give layer 0 a look nobody would arrive at by accident ---------------------------
    await selectClip(0);

    /** Every schema-driven number row is a `.effect-slider-control` carrying its label as `title`. */
    async function setNumber(label: string, value: string): Promise<boolean> {
      const row = page.locator(`.effect-slider-control[title="${label}"]`).first();
      if (!(await row.count().catch(() => 0))) return false;
      const input = row.locator("input").first();
      await input.fill(value);
      await input.press("Enter");
      await page.waitForTimeout(500);
      return true;
    }

    const setSize = await setNumber("Font size", "140");
    check("fixture: the schema-driven font size row exists and is writable", setSize);
    check("fixture: the schema-driven stroke width row exists", await setNumber("Stroke width", "9"));
    check("fixture: the schema-driven letter spacing row exists", await setNumber("Letter spacing", "12"));

    /**
     * Stroke-behind-fill — S1's field, the one T-15 was written about. SET, never toggled: new text
     * is authored `strokePaintOrder: "under"` already, so a blind click turns the feature off and
     * every downstream paint-order check then compares "normal" to "normal", passing while proving
     * nothing.
     */
    const strokeUnder = page.locator('button.inspector-toggle[title="Stroke behind fill"]').first();
    async function setStrokeUnder(on: boolean): Promise<void> {
      await strokeUnder.waitFor({ state: "visible", timeout: 10_000 });
      if (((await strokeUnder.getAttribute("aria-pressed")) === "true") !== on) {
        await strokeUnder.click();
        await page.waitForTimeout(600);
      }
    }
    await setStrokeUnder(true);
    check("fixture: stroke-behind-fill is ON for the source", (await strokeUnder.getAttribute("aria-pressed")) === "true");

    // The target gets a stroke of its own, painted the OTHER way. Without this the paint-order arm
    // would be carried by the stroke width alone — the target would go from "no stroke, so no
    // paint-order" to "stroke, so paint-order", which says nothing about whether `strokePaintOrder`
    // itself travelled. Now the only difference between the two layers on that property is the
    // property.
    await selectClip(1);
    await setNumber("Stroke width", "9");
    await setStrokeUnder(false);
    check("fixture: the target paints stroke-OVER before the paste", (await strokeUnder.getAttribute("aria-pressed")) === "false");

    const source = await styleOfClip(0);
    const targetBefore = await styleOfClip(1);
    check(
      "instrument: the two layers DIFFER before the paste (otherwise this proves nothing)",
      JSON.stringify(source) !== JSON.stringify(targetBefore),
      `source=${source.fontSize}/${source.webkitTextStrokeWidth} target=${targetBefore.fontSize}/${targetBefore.webkitTextStrokeWidth}`
    );

    // --- copy the look off layer 0 --------------------------------------------------------
    /** Text Styles ships collapsed (`defaultOpen={false}`) — expand it before reaching inside. */
    async function openTextStyles(): Promise<void> {
      if (await page.getByRole("button", { name: /copy look/i }).first().isVisible().catch(() => false)) return;
      const header = page.locator(".editor-section-header", { hasText: /text styles/i }).first();
      if (await header.count().catch(() => 0)) {
        await header.click();
        await page.waitForTimeout(600);
      }
    }

    await selectClip(0);
    await openTextStyles();
    const copy = page.getByRole("button", { name: /copy look/i }).first();
    await copy.waitFor({ state: "visible", timeout: 10_000 });
    await copy.click();
    await page.waitForTimeout(400);
    check("copy: the Copy Look button exists and fired", true);

    // --- paste onto layer 1 ---------------------------------------------------------------
    await selectClip(1);
    await openTextStyles();
    const paste = page.getByRole("button", { name: /paste look/i }).first();
    await paste.waitFor({ state: "visible", timeout: 10_000 });
    check("paste: the button is ENABLED once a look is copied", await paste.isEnabled());
    await paste.click();
    await page.waitForTimeout(1200);

    // --- the proof: the target now RENDERS as the source ----------------------------------
    const targetAfter = await styleOfClip(1);
    check("paste: the target's rendered style CHANGED", JSON.stringify(targetAfter) !== JSON.stringify(targetBefore));
    check("paste: font size now matches the source", targetAfter.fontSize === source.fontSize, `${targetBefore.fontSize} → ${targetAfter.fontSize}`);
    check(
      "paste: stroke width now matches the source",
      targetAfter.webkitTextStrokeWidth === source.webkitTextStrokeWidth,
      `${targetBefore.webkitTextStrokeWidth} → ${targetAfter.webkitTextStrokeWidth}`
    );
    check(
      "paste: letter spacing now matches the source",
      targetAfter.letterSpacing === source.letterSpacing,
      `${targetBefore.letterSpacing} → ${targetAfter.letterSpacing}`
    );
    check(
      "instrument: the source really is painting stroke-under (else the next check is vacuous)",
      // Chromium serializes the emitted `paint-order: stroke fill` back as `stroke` — the trailing
      // keywords are implied. Compared against the computed form, not the authored one.
      source.paintOrder === "stroke",
      source.paintOrder
    );
    check("paste: paint order now matches the source", targetAfter.paintOrder === source.paintOrder, `${targetBefore.paintOrder} → ${targetAfter.paintOrder}`);
    check("paste: the SOURCE layer is untouched", JSON.stringify(await styleOfClip(0)) === JSON.stringify(source));
  } finally {
    await page.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

main()
  .then(() => {
    if (failures.length) {
      console.error(`\n${failures.length} check(s) failed:\n  ${failures.join("\n  ")}`);
      process.exit(1);
    }
    console.log("\nCopy-paste of a text look: proven end-to-end in the real editor.");
    process.exit(0);
  })
  .catch((error) => {
    console.error(`\nVOID — ${error instanceof Error ? error.message : String(error)}`);
    console.error(`(base ${EDITOR_BASE}; a dev server must be running: pnpm dev)`);
    process.exit(2);
  });
