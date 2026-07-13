/**
 * Standalone assert script for the P11 Memory OS client logic (extractor +
 * retriever). Pure logic — no DB, no localStorage. Repo convention: exits
 * non-zero on first failure.
 *
 *   pnpm --filter @kimera-by-aelivion/web memory:test
 */
import { extractFacts } from "./memory-extractor";
import { selectMemorySlice } from "./memory-retriever";
import type { MemoryFact } from "./memory";
import type { AiPlan, PlanStep } from "./types";

let failures = 0;
function check(name: string, condition: boolean): void {
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${name}`);
  }
}

const cost = { tier: "browser" as const, credits: 0 };
function planOf(steps: PlanStep[]): AiPlan {
  return { id: "p", prompt: "x", steps, totalCredits: 0, confidence: "Exact", notes: [] };
}

// --- Extractor: distils creator + project facts from an applied plan ----------
{
  const plan = planOf([
    { id: "s1", kind: "timelineAction", actionId: "addText", params: { text: "SALE", color: "#facc15" }, summary: "", cost },
    { id: "s2", kind: "timelineAction", actionId: "addEffect", params: { layerId: "l1", effectType: "colorGrade" }, summary: "", cost },
    { id: "s3", kind: "tool", toolSlug: "auto-captions", summary: "", cost }
  ]);
  const facts = extractFacts(plan, { projectId: "proj1", qualityMode: "best", permissionMode: "professional" });

  const find = (scope: string, key: string) => facts.find((f) => f.scope === scope && f.key === key);
  check("extracts creator textColor", find("creator", "textColor")?.value === "#facc15");
  check("extracts project textColor (scoped)", find("project", "textColor")?.projectId === "proj1");
  check("extracts creator colorGrade", find("creator", "colorGrade")?.value === "colorGrade");
  check("extracts usesCaptions", find("creator", "usesCaptions")?.value === true);
  check("extracts non-default qualityMode", find("creator", "qualityMode")?.value === "best");
  check("project fact has higher confidence than creator", (find("project", "textColor")?.confidence ?? 0) > (find("creator", "textColor")?.confidence ?? 1));
}

// --- Extractor: no projectId → creator facts only -----------------------------
{
  const plan = planOf([{ id: "s1", kind: "timelineAction", actionId: "addShape", params: { color: "#ff0000" }, summary: "", cost }]);
  const facts = extractFacts(plan, {});
  check("no project scope without projectId", facts.every((f) => f.scope !== "project"));
  check("shape color learned as creator textColor", facts.some((f) => f.scope === "creator" && f.key === "textColor" && f.value === "#ff0000"));
}

// --- Retriever: bounded, high-confidence first, project overrides creator ------
{
  const now = new Date().toISOString();
  const facts: MemoryFact[] = [
    { scope: "creator", key: "textColor", value: "#ffffff", confidence: 0.9, source: "inferred", lastUsedAt: now },
    { scope: "project", projectId: "proj1", key: "textColor", value: "#facc15", confidence: 0.6, source: "inferred", lastUsedAt: now },
    { scope: "creator", key: "captionStyle", value: "bold_yellow", confidence: 0.8, source: "inferred", lastUsedAt: now },
    { scope: "creator", key: "weak", value: "ignore", confidence: 0.2, source: "inferred", lastUsedAt: now },
    { scope: "project", projectId: "other", key: "textColor", value: "#000000", confidence: 0.99, source: "inferred", lastUsedAt: now }
  ];
  const slice = selectMemorySlice(facts, { projectId: "proj1" });

  check("project textColor overrides creator on collision", slice.preferences.textColor === "#facc15");
  check("creator captionStyle retained", slice.preferences.captionStyle === "bold_yellow");
  check("low-confidence fact dropped", !slice.note.includes("weak"));
  check("other project's fact excluded", !slice.note.includes("#000000"));
  check("note is non-empty", slice.note.length > 0);
}

// --- Retriever: respects the limit --------------------------------------------
{
  const now = new Date().toISOString();
  const many: MemoryFact[] = Array.from({ length: 12 }, (_, i) => ({
    scope: "creator",
    key: `k${i}`,
    value: `v${i}`,
    confidence: 0.5 + i * 0.04,
    source: "inferred",
    lastUsedAt: now
  }));
  const slice = selectMemorySlice(many, { limit: 4 });
  check("slice is bounded to the limit", slice.note.split(";").length <= 4);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll memory OS checks passed");
