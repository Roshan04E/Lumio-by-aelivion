/**
 * ADR-023 S10 — does a PASTE ever smuggle a `data-font-ref` past the rich-text run model?
 *
 * `RichTextEditor.tsx`'s `onPaste` handler is exactly this (quoted verbatim, 2026-08-16, so a future
 * reader can diff this comment against the real file if it drifts):
 *
 *   onPaste={(event) => {
 *     event.preventDefault();
 *     const text = event.clipboardData.getData("text/plain");
 *     if (text) document.execCommand("insertText", false, text);
 *   }}
 *
 * The claim under test: reading ONLY `text/plain` and inserting it via `execCommand("insertText", …)`
 * means the browser's clipboard HTML (`text/html`) is never parsed, never touches `innerHTML`, and so
 * a `data-font-ref` attribute on pasted markup — whether it names another project's file, another
 * ACCOUNT's `user` FontRef, or is simply hand-written — can never reach the DOM `rich-text-serialize.ts`
 * later parses. `readFontRefAttr` only ever sees what is already in the editor's own DOM; if paste
 * cannot put a `data-font-ref` THERE, the parser's own trustworthiness is moot for this vector.
 *
 * WHY A BARE PAGE, not the full running editor: the claim is about a DOM PRIMITIVE — what
 * `execCommand("insertText", …)` does with a paste event whose clipboardData carries both
 * `text/html` and `text/plain` — not about anything React or this app's UI contributes. A bare
 * contentEditable exercising the exact three lines above is a faithful, self-contained test of that
 * primitive; it does not exercise the surrounding React component, which is why the handler is quoted
 * above rather than reimplemented from memory, and why this probe is paired with a citation of the real
 * file rather than standing in for it.
 *
 * Run: pnpm --filter @orreris/worker font:paste-sanitization-probe
 */
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { assertQuietBrowserMachine } from "./browser/browser-preflight";

async function main(): Promise<void> {
  assertQuietBrowserMachine({ label: "font:paste-sanitization-probe", scriptMarker: "font-ref-paste-sanitization-probe" });

  const browser = await chromium.launch({ channel: process.env.PIXEL_BROWSER_CHANNEL ?? "chrome", headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`<!doctype html><html><body><div id="editor" contenteditable="true"></div></body></html>`);

    const result = await page.evaluate(() => {
      const editor = document.getElementById("editor")!;
      editor.focus();

      // A malicious/foreign paste: HTML carrying a `data-font-ref` naming a DIFFERENT owner's pinned
      // font, alongside the plain-text fallback every real clipboard also carries.
      const foreignRef = JSON.stringify({ source: "user", family: "Stolen", weight: 400, style: "normal", fileHash: "deadbeef", ownerId: "someone-elses-account" });
      const html = `<span data-font-ref="${encodeURIComponent(foreignRef)}" style="font-family:'Stolen'">PWNED</span>`;
      const plain = "PWNED";

      const clipboardData = new DataTransfer();
      clipboardData.setData("text/html", html);
      clipboardData.setData("text/plain", plain);

      const pasteEvent = new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true });

      // `RichTextEditor.tsx`'s onPaste handler, verbatim (see this file's own doc comment).
      editor.addEventListener("paste", (event) => {
        event.preventDefault();
        const text = (event as ClipboardEvent).clipboardData!.getData("text/plain");
        if (text) document.execCommand("insertText", false, text);
      });

      editor.dispatchEvent(pasteEvent);

      return { html: editor.innerHTML, text: editor.textContent };
    });

    console.log(`resulting DOM: ${result.html}`);

    assert.ok(!result.html.includes("data-font-ref"), `FALSIFIER FAILED — data-font-ref survived the paste handler into the DOM: ${result.html}`);
    assert.ok(!result.html.includes("<span"), `FALSIFIER FAILED — pasted HTML markup survived at all (expected plain text only): ${result.html}`);
    assert.ok(!result.html.toLowerCase().includes("stolen"), `FALSIFIER FAILED — the foreign font-family name leaked into the DOM even without the ref: ${result.html}`);
    assert.equal(result.text, "PWNED", "the plain-text fallback itself must still land — a paste that inserted NOTHING would also pass the assertions above for the wrong reason.");

    console.log("PASS — a paste's text/html (including a foreign data-font-ref) never reaches the DOM; only text/plain lands, as plain text.");
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${String(error?.stack ?? error)}\n`);
  process.exit(1);
});
