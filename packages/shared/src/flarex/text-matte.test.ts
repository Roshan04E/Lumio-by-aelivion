/**
 * ADR-023 S7 half A — the text matte, the widened matte value, and D11/T-8's font term.
 *
 * These are pure-function assertions and deliberately so: what half A changes is a TYPE and a KEY,
 * and both are decidable without a browser. The picture half — video inside glyphs — is a fixture
 * question and belongs with the fixtures.
 *
 * Every arm is built by taking ONE object and overriding ONE property (T-15 addendum 3): a
 * difference assertion is satisfied by any asymmetry, so the two sides must share everything else by
 * construction rather than by my remembering to keep them equal.
 *
 * Run: pnpm --filter @orreris/shared textmatte:test
 */
import assert from "node:assert/strict";
import { computeFlarexContentHashes } from "./content-hash";
import { getFlarexNodeDefinition } from "./node-defs";
import type { FlarexComp } from "../types";

const results: Array<[string, boolean]> = [];
function check(name: string, fn: () => void): void {
  try {
    fn();
    results.push([name, true]);
    console.log(`  ok  ${name}`);
  } catch (error) {
    results.push([name, false]);
    console.log(`FAIL  ${name}\n      ${String((error as Error).message).split("\n")[0]}`);
  }
}

// ── The text node's sockets (D9) ────────────────────────────────────────────────────────────────
check("Text+ emits a matte as well as an image", () => {
  const def = getFlarexNodeDefinition("text");
  const matte = def.outputs.find((o) => o.type === "matte");
  assert.ok(matte, "the text node must offer a matte output — that socket IS 'video inside text'.");
  assert.equal(matte.id, "matte");
  assert.ok(def.outputs.some((o) => o.type === "image"), "and it must still offer its image output.");
});

check("the matte socket adds no new vocabulary", () => {
  // D9's claim is that widening the VALUE means every existing matte consumer takes a text matte with
  // no new node type. So the socket's type must be the SAME `matte` the mask nodes already emit.
  const textMatte = getFlarexNodeDefinition("text").outputs.find((o) => o.type === "matte")!;
  const maskMatte = getFlarexNodeDefinition("bezierMask").outputs.find((o) => o.type === "matte")!;
  assert.equal(textMatte.type, maskMatte.type, "a text matte and a mask matte must be the same KIND of value.");
});

// ── D11/T-8: the font is part of the content hash ───────────────────────────────────────────────
const textComp = (): FlarexComp =>
  ({
    id: "comp_a",
    name: "A",
    nodes: {
      t1: { id: "t1", type: "text", enabled: true, x: 0, y: 0, params: { content: "Hi", fontFamily: "Anton", fontSize: 96 } }
    },
    edges: [],
    animations: []
  }) as unknown as FlarexComp;

check("T-8: the SAME family resolving to DIFFERENT bytes changes the hash", () => {
  const comp = textComp();
  // One comp, one time, one family name. The only declared difference is what the resolver says the
  // family's bytes ARE — which is exactly the situation D11 describes: a user font replaced in the
  // store, or a face installed after the first raster.
  const a = computeFlarexContentHashes(comp, 0, () => "sha256:aaaa");
  const b = computeFlarexContentHashes(comp, 0, () => "sha256:bbbb");
  assert.notEqual(
    a.get("t1"),
    b.get("t1"),
    "the font's identity is not in the key. A face swapped under an unchanged family name would " +
      "produce new pixels under an unchanged hash, and every consumer keyed on it would serve the old " +
      "font forever — which is the stale hit D11 exists to prevent."
  );
});

check("T-8: the same bytes hash the same (the term is identity, not noise)", () => {
  const comp = textComp();
  assert.equal(
    computeFlarexContentHashes(comp, 0, () => "sha256:aaaa").get("t1"),
    computeFlarexContentHashes(comp, 0, () => "sha256:aaaa").get("t1"),
    "a stable resolver must produce a stable hash, or the term destroys reuse instead of protecting it."
  );
});

check("D1a: no resolver → the hash is exactly what it was before D11", () => {
  const comp = textComp();
  // The absent-stays-absent rule this whole programme runs on. A caller that supplies no resolver is
  // not a caller with an unknown font — it is a caller from before this feature existed, and its
  // hashes must not move.
  const withNoResolver = computeFlarexContentHashes(comp, 0);
  const withEmptyResolver = computeFlarexContentHashes(comp, 0, () => undefined);
  assert.equal(
    withNoResolver.get("t1"),
    withEmptyResolver.get("t1"),
    "an unresolvable family must contribute NOTHING, not the string 'undefined'."
  );
});

check("the font term is node-blind: a non-text node is unaffected by the resolver", () => {
  const comp = {
    id: "comp_b",
    name: "B",
    nodes: { b1: { id: "b1", type: "background", enabled: true, x: 0, y: 0, params: { color: "#000000", opacity: 1 } } },
    edges: [],
    animations: []
  } as unknown as FlarexComp;
  assert.equal(
    computeFlarexContentHashes(comp, 0).get("b1"),
    computeFlarexContentHashes(comp, 0, () => "sha256:aaaa").get("b1"),
    "a node that declares no fontParams must hash identically whatever the resolver says — the hasher " +
      "must not have learned what a text node is (ADR-010)."
  );
});

check("fontParams is declared on the node, not branched on in the hasher", () => {
  assert.deepEqual(getFlarexNodeDefinition("text").fontParams, ["fontFamily"]);
  assert.equal(getFlarexNodeDefinition("background").fontParams, undefined);
});

const failures = results.filter(([, ok]) => !ok).length;
console.log(failures ? `\n${failures} failure(s)` : "\ntext matte + font hash: all checks passed");
if (failures) process.exitCode = 1;
