/**
 * Standalone assert script for Text Styles (§2) capture/apply. Repo convention: no test framework —
 * exits non-zero on first failure.
 *
 *   pnpm --filter @orreris/web text-style:test
 */
import { applyTextStyle, captureTextStyle, createTextStyleFromLayer, type TimelineLayer } from "@orreris/shared";

let failures = 0;
function check(name: string, condition: boolean): void {
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${name}`);
  }
}

function textLayer(over: Partial<TimelineLayer>): TimelineLayer {
  return {
    id: "t1",
    trackId: "tr1",
    type: "text",
    name: "Text",
    startSeconds: 0,
    durationSeconds: 3,
    transform: { position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 100 },
    effects: [],
    keyframes: [],
    ...over
  } as TimelineLayer;
}

// --- capture: picks the look fields, drops undefined -----------------------------------
{
  const source = textLayer({ fontFamily: "Futura", fontSize: 80, color: "#ff0000", strokeWidth: 4, textAlign: "center" });
  const style = captureTextStyle(source);
  check("capture: keeps set look fields", style.fontFamily === "Futura" && style.fontSize === 80 && style.color === "#ff0000" && style.strokeWidth === 4 && style.textAlign === "center");
  check("capture: drops unset fields (no undefined keys)", !("lineHeight" in style) && !("shadowBlur" in style));
  check("capture: never carries text CONTENT or transform", !("text" in style) && !("transform" in style));
}

// --- apply: bakes fields, leaves content/geometry untouched ----------------------------
{
  const source = textLayer({ fontFamily: "Futura", fontSize: 80, color: "#ff0000" });
  const target = textLayer({
    id: "t2",
    text: "Different words",
    textWidthPercent: 40,
    transform: { position: { x: 10, y: 90 }, scale: 3, rotation: 45, opacity: 50 },
    fontFamily: "Arial",
    fontSize: 32,
    color: "#000000"
  });
  const out = applyTextStyle(target, captureTextStyle(source));
  check("apply: look fields overwritten from the style", out.fontFamily === "Futura" && out.fontSize === 80 && out.color === "#ff0000");
  check("apply: text content untouched", out.text === "Different words");
  check("apply: width untouched", out.textWidthPercent === 40);
  check("apply: transform untouched", out.transform.position.x === 10 && out.transform.scale === 3 && out.transform.rotation === 45);
  check("apply: id/timing untouched", out.id === "t2" && out.durationSeconds === 3);
}

// --- createTextStyleFromLayer: named, fresh id -----------------------------------------
{
  const a = createTextStyleFromLayer(textLayer({ fontFamily: "Inter" }), "Heading");
  const b = createTextStyleFromLayer(textLayer({ fontFamily: "Inter" }), "Heading");
  check("create: carries the name", a.name === "Heading");
  check("create: captures the look", a.style.fontFamily === "Inter");
  check("create: ids are unique", a.id !== b.id && a.id.startsWith("style_"));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll text-style checks passed");
