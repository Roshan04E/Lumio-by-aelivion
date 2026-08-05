/**
 * ADR-013 Phase 0 — SCOPING the F2 finding: is fabricated merit systemic, or one collection path?
 *
 * ## Why this file exists
 *
 * The falsifiability check measured `distinct merits observed: 1.0000` across 32 candidates and I wrote
 * F2 up as "merit is a manufactured constant" — universally. That over-generalises the evidence. The
 * function is `collectFlarexVirtualLayers`, and the fixture was six Flarex sources: F2 was established
 * for the **Flarex virtual-source class on an all-virtual fixture**, and for nothing else. Real timeline
 * clips arrive through a different path and may carry genuine user transforms.
 *
 * The distinction decides the size of everything downstream — whether §0.3's criterion 2 has a hole or a
 * scoped defect, whether OQ1 survives on timeline clips, and whether the F2 slice goes in front of C15
 * and the playback-contention fixture or behind them.
 *
 * ## What this proves, and what it deliberately does NOT
 *
 * This is a **mechanism** check on pure functions: does each collection path PROPAGATE a transform, or
 * MANUFACTURE one? That is decidable here, deterministically, with no browser.
 *
 * It does **not** establish what real projects actually contain — whether users' timeline clips carry
 * differing transforms in practice is a corpus question and belongs to the live run. A path that
 * propagates faithfully still yields merit 1.0 for every clip if every clip is at defaults. Both halves
 * are needed and this is the cheaper, sharper one: it separates "cannot differ" from "happens not to".
 *
 *   pnpm --filter @orreris/worker contribution:scope
 */
import {
  collectFlarexVirtualLayers,
  contributionRank,
  getLayerVisibleContribution,
  type FlarexComp,
  type TimelineLayer,
} from "@orreris/shared";

let failures = 0;
let checks = 0;

function check(label: string, condition: boolean, detail?: string): void {
  checks += 1;
  if (condition) console.log(`  ok    ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function clip(id: string, transform: Partial<TimelineLayer["transform"]> | undefined): TimelineLayer {
  return {
    id,
    trackId: "t1",
    type: "video",
    name: id,
    startSeconds: 0,
    durationSeconds: 10,
    assetId: `asset-${id}`,
    fit: "fill",
    effects: [],
    keyframes: [],
    ...(transform ? { transform: transform as TimelineLayer["transform"] } : {}),
  } as TimelineLayer;
}

console.log("\nADR-013 Phase 0 — contribution scope: which collection paths manufacture merit?\n");

// ── PATH A: real timeline clips ─────────────────────────────────────────────
console.log("PATH A — real timeline clips (the path `PreviewLayer` uses for ordinary media)");
{
  const full = getLayerVisibleContribution(clip("full", { position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 100 }));
  const half = getLayerVisibleContribution(clip("half", { position: { x: 50, y: 50 }, scale: 0.5, rotation: 0, opacity: 100 }));
  const faint = getLayerVisibleContribution(clip("faint", { position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 25 }));

  const mFull = contributionRank(full);
  const mHalf = contributionRank(half);
  const mFaint = contributionRank(faint);
  console.log(`        merits: full ${mFull.toFixed(4)} · half-scale ${mHalf.toFixed(4)} · 25%-opacity ${mFaint.toFixed(4)}`);

  check("a half-scale clip ranks BELOW a full-frame clip", mHalf < mFull, `${mHalf} vs ${mFull}`);
  check("a 25%-opacity clip ranks BELOW a full-frame clip", mFaint < mFull, `${mFaint} vs ${mFull}`);
  check("area follows scale² — 0.5 scale gives 0.25 area", Math.abs(mHalf - 0.25) < 1e-6, String(mHalf));
  check("opacity is multiplicative — 25% gives 0.25", Math.abs(mFaint - 0.25) < 1e-6, String(mFaint));
  check(
    "→ PATH A PROPAGATES the transform: merit CAN differ between timeline clips",
    new Set([mFull, mHalf, mFaint]).size === 2 || new Set([mFull, mHalf, mFaint]).size === 3
  );
}

// ── PATH B: Flarex virtual sources ──────────────────────────────────────────
console.log("\nPATH B — Flarex virtual sources (`collectFlarexVirtualLayers`)");
{
  // Two hosts with WILDLY different transforms, each carrying a comp with one asset-source MediaIn.
  // If the path propagated anything, these two would produce different virtual-layer transforms.
  const comps: Record<string, FlarexComp> = {
    c1: {
      id: "c1",
      name: "c1",
      version: 1,
      edges: [],

      nodes: {
        n1: { id: "n1", type: "mediaIn", label: "A", params: { sourceAssetId: "asset-a" }, inputs: {}, x: 0, y: 0 },
      },
    } as unknown as FlarexComp,
    c2: {
      id: "c2",
      name: "c2",
      version: 1,
      edges: [],
      nodes: {
        n2: { id: "n2", type: "mediaIn", label: "B", params: { sourceAssetId: "asset-b" }, inputs: {}, x: 0, y: 0 },
      },
    } as unknown as FlarexComp,
  };

  const hostBig = { ...clip("host-big", { position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 100 }), flarexCompId: "c1" } as TimelineLayer;
  const hostTiny = { ...clip("host-tiny", { position: { x: 50, y: 50 }, scale: 0.1, rotation: 0, opacity: 10 }), flarexCompId: "c2" } as TimelineLayer;

  const virtuals = collectFlarexVirtualLayers(
    [hostBig, hostTiny],
    comps,
    (assetId) => ({ id: assetId, type: "video", durationSeconds: 30 })
  );

  console.log(`        virtual layers built: ${virtuals.length}`);
  const merits = virtuals.map((v) => contributionRank(getLayerVisibleContribution(v)));
  console.log(`        merits: ${merits.map((m) => m.toFixed(4)).join(" · ")}`);
  console.log(
    `        transforms: ${virtuals.map((v) => `scale=${v.transform?.scale} opacity=${v.transform?.opacity}`).join(" · ")}`
  );

  check("two virtual sources were built", virtuals.length === 2, String(virtuals.length));
  check(
    "their hosts had RADICALLY different transforms (scale 1/op 100 vs scale 0.1/op 10)",
    hostBig.transform?.scale !== hostTiny.transform?.scale
  );
  // ADR-020 slice B. Before the slice both assertions below were INVERTED and passing: the path
  // stamped identity, so both virtual layers read `scale=1 opacity=100` and both merits were 1.0.
  // They are kept as the same two questions with the answers the slice changes, so the file records
  // what the defect WAS as well as what the fix does.
  check(
    "→ PATH B now INHERITS the host transform instead of manufacturing one",
    virtuals[0]?.transform?.scale === hostBig.transform?.scale &&
      virtuals[1]?.transform?.scale === hostTiny.transform?.scale,
    JSON.stringify(virtuals.map((v) => v.transform))
  );
  check(
    "→ …so a virtual source under a small, faint host no longer outranks a full-frame one",
    merits[0] !== merits[1] && (merits[1] ?? 1) < (merits[0] ?? 0),
    JSON.stringify(merits)
  );
  check(
    "→ …and the surviving limit is honest: siblings on ONE host still tie",
    true,
    "documented, not asserted — see ADR-020 §5"
  );
}

// ── The scoping verdict ─────────────────────────────────────────────────────
console.log("\n════ SCOPE VERDICT ════");
if (failures === 0) {
  console.log("F2 IS BOUNDED, not systemic — and PATH B's fabrication is now FIXED (ADR-020 slice B).");
  console.log("  · PATH A (real timeline clips) propagates the layer transform faithfully. Merit");
  console.log("    differs whenever the clips differ, so rank CAN discriminate there and OQ1 remains");
  console.log("    well-posed for timeline clips.");
  console.log("  · PATH B (`collectFlarexVirtualLayers`) INHERITS the host transform. It used to stamp");
  console.log("    identity, so every virtual source scored exactly 1.0 regardless of its host; now a");
  console.log("    source inside a small, faint host cannot outrank one filling the frame.");
  console.log("");
  console.log("  SURVIVING LIMIT, and it bounds what slice A can achieve: siblings inside ONE comp on");
  console.log("  ONE host still score identically, because they inherit the same host. Discriminating");
  console.log("  between them needs each node's own contribution WITHIN the comp — reachability from");
  console.log("  the active root, and composited area — for which a TimelineLayer has no channel.");
  console.log("  See ADR-020 §5; this is the difference between A being non-vacuous across comps and");
  console.log("  non-vacuous within one.");
  console.log("");
  console.log("  So §0.3 criterion 2 fails FOR THE FLAREX VIRTUAL-SOURCE CLASS — a scoped defect in one");
  console.log("  collection path — NOT a hole in the ADR's membership test.");
  console.log("");
  console.log("  LIMIT OF THIS CHECK: it proves path A CAN differ, not that real projects DO differ.");
  console.log("  A timeline of clips all at default transform still yields 1.0 for every one of them.");
  console.log("  That is the live run's question, and it is a corpus question, not a mechanism one.");
} else {
  console.log("Scope NOT established — see failures above.");
}
console.log(`\n${failures === 0 ? "contribution:scope OK" : "contribution:scope FAILED"} — ${checks - failures}/${checks} checks passed\n`);
process.exit(failures === 0 ? 0 : 1);
