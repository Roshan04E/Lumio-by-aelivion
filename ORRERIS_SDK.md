# Orreris Intelligence SDK — v1

The frozen extension surface of the intelligence runtime (ORRERIS_OS.md's rule of
engagement: *observers, recipes, and capabilities are plugins from day one*). Everything
here is importable from **one module** — `apps/web/src/ai/sdk.ts` (`SDK_VERSION = 1`).
If you extend the brain, import from the SDK, not from runtime internals.

## Extension points (v1)

| Extension | Register with | You provide | Reference implementation |
|---|---|---|---|
| **World observer** (measure a fact) | `registerObserver` | `WorldObserver`: id `name@namespace`, version, factTypes, fidelity 0–4, honest `estCostMs`/`estConfidence`, cheap sync `signature()`, async `observe()` | `world/observers/look.ts` (L1 pixels), `world/observers/faces.ts` (L3 browser-ML) |
| **Inference rule** (derive a fact from other facts) | `registerObserver` (fidelity 4) | Same contract; buy inputs via `queryFact(…, ctx, "inline")`, propagate confidence, record `dependencies` | `world/observers/character.ts` (one input), `world/observers/format.ts` (two inputs) |
| **Mood recipe** (vibe word as data) | `registerMoodRecipe` | mood word, tight aliases, `gradeLook`, optional `motion`, `textLook` | vintage/gritty rows in `blueprint/hypothesis.ts` |
| **Blueprint dialect** (new goal domain) | `registerBlueprintDialect` | id, Zod payload schema, `close()` — canonicalize, verify, compute the lowering | `blueprint/color.ts`, `blueprint/text.ts` |
| **Creative look** (grade preset as data) | `registerCreativeLook` | `CreativeLook` (wheel masters are −1..1 — NOT percent; see the Teal & Orange regression) | `color/looks.ts` built-ins |
| **Reading facts** | `queryFact` | a typed `FactQuery` with a budget | any consumer in `world/route.ts` |

Registration is **validated**: a declaration that violates its contract is rejected with a
`[orreris-sdk]` console warning and `false` — it never corrupts the planner's tables.
Duplicate ids **overwrite** (last write wins): this keeps Vite HMR re-registration and
deliberate plugin overrides working. Changing an observer's algorithm must bump its
`version` — versions are part of the memo key, so stale facts die on their own.

## The laws (every extension, no exceptions)

1. **Decline, never guess.** Can't observe here (no DOM, model failed, budget short) →
   return `[]` / `null`. A decline is an answer; the model tiers take over honestly.
2. **Price honestly.** `estCostMs` includes your worst first run (model downloads count).
   The planner buys facts by information-gain-per-cost; a lie corrupts every decision.
3. **Confidence never exceeds evidence.** Inference rules: `prior × input confidence`
   (multi-input: `prior × min(inputs)` — the weakest-link law).
4. **Derived facts record `dependencies`** (input fact ids) so truth maintenance can
   cascade-kill them when an input dies. Signatures must also composite the inputs'
   signatures — invalidation works from both directions.
5. **Nested queries inside `observe()` use `"inline"` acquisition** — a scheduled job from
   inside the perception pump deadlocks it (single concurrency; world:eval guards this).
6. **Data over code.** If your extension can be a registry row (look, recipe, alias), it
   must be. Runtime changes need an ORRERIS_OS.md entry; rows don't.
7. **Eval-gated.** New observers/rules add rows to `world:eval`; recipes/dialects to
   `blueprint:eval`; anything user-phrasing-adjacent to `brain:eval` — including the
   MUST-NOT rows (wrong-fire is worse than escalate).
8. **Honest labels downstream.** Measured facts read "measured"; inferences read as the
   system's own read with a confidence; never dress one as the other.

## Not public in v1

Tier-0 reflex handlers (router internals, trust-gated code), the fact store's storage
format, panel/executor seams, and timeline-action definitions. They will move; importing
them directly is on you.

## Versioning

Breaking a signature or a law bumps `SDK_VERSION` and adds a migration note here.
Additive changes (optional fields, new extension points) do not bump.
