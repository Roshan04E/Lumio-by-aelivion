/**
 * Orreris OS — Blueprint text dialect (K3, third dialect). Payload = TextLookIntent
 * (text-look.ts). Closure canonicalizes the look name (exact → case/format-insensitive →
 * alias, repairs recorded); unknown names fail with the text-look library as suggestions.
 * Lowering = one `applyTextLook` template — the style bake runs inside the action against
 * the bound layer (targets stay executor business, per the IR law).
 */

import { resolveTextLookName, textLookIntentSchema, TEXT_LOOK_NAMES, type TextLookIntent } from "../text-look";
import type { BlueprintDialect, BlueprintGoal, CloseResult } from "./types";
import { registerBlueprintDialect } from "./types";

export const TEXT_DIALECT_ID = "text";

function close(goal: BlueprintGoal<TextLookIntent>): CloseResult<TextLookIntent> {
  const resolved = resolveTextLookName(goal.payload.look);
  if (!resolved) {
    return {
      ok: false,
      issues: [
        {
          goalId: goal.id,
          code: "unknown-capability",
          message: `"${goal.payload.look}" isn't a text look.`,
          suggestions: [...TEXT_LOOK_NAMES]
        }
      ]
    };
  }
  const payload: TextLookIntent = { look: resolved.look };
  return {
    ok: true,
    closed: {
      goal: { ...goal, payload },
      actions: [{ actionId: "applyTextLook", params: { look: resolved.look }, summary: `"${resolved.look}" text look` }],
      repairs: resolved.repair ? [resolved.repair] : []
    }
  };
}

export const textBlueprintDialect: BlueprintDialect<TextLookIntent> = {
  id: TEXT_DIALECT_ID,
  schema: textLookIntentSchema,
  close
};

registerBlueprintDialect(textBlueprintDialect);
