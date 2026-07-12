/**
 * Lumio Brain — tier-0 FAQ (B1). Answers registry-answerable questions locally, instantly, for
 * zero tokens: capability questions are GENERATED from the live registries (so the answer is
 * always current), and editor how-tos come from a small table of REAL Lumio shortcuts (the
 * timeline cheat sheet is the source of truth — the LLM used to invent generic-NLE answers).
 * Precision-first: anchored patterns only; anything else returns null and escalates.
 */

import { buildCapabilityIndex, skillRegistry } from "@lumio-by-aelivion/shared";

/**
 * Capability questions — the ONE place a slightly wider net is safe: the response is a local
 * read-only answer (no mutation), and it's 👎-gated like every brain result. Covers the exact
 * forms AND common paraphrases ("what you can do for me", "what are you capable of", "show me
 * what you can do") — a real user paraphrase that slipped to the LLM on 2026-07-10.
 */
const CAPABILITIES_RE =
  /^(?:so |ok(?:ay)? )?what(?: all| else)?(?: things)? (?:are your capabilities|(?:you )?can you (?:do|help(?: me)?(?: with)?)|you (?:can|could) do|do you (?:do|know how to do)|are you (?:able|capable) (?:of|to do)?)(?: for me| here| in (?:this|the) editor)?\s*\??$/;
const CAPABILITIES_ALT_RE =
  /^(?:your capabilities|capabilities|list (?:your )?(?:capabilities|tools|skills)|what tools do you have|(?:show|tell) me (?:what you can do|your capabilities)|what are you capable of|how can you help(?: me)?)\s*\??$/;

/** "how does the blade tool work", "how does blur work" → the capability's own doc. */
const HOW_DOES_RE = /^how (?:does|do) (?:the |a |an )?(.{2,60}?)(?: tool| effect| action| skill)? works?\s*\??$/;

interface EditorKnowledgeEntry {
  pattern: RegExp;
  answer: string;
}

/**
 * Real Lumio shortcuts only (mirrors the timeline cheat sheet in TimelineStrip.tsx). Every entry
 * is verified against that sheet — do not add folklore.
 */
/** NOTE: playback/pan-mode IMPERATIVES used to live here as shortcut tips — they now EXECUTE
 * via the editor command plane (ai/brain/commands.ts), checked before this FAQ. Only genuine
 * how-do-I questions remain. */
const EDITOR_KNOWLEDGE: EditorKnowledgeEntry[] = [
  {
    pattern: /^how (?:do|can) i pan(?: the timeline)?\??$/,
    answer:
      "Press **H** for the Hand tool, then drag to pan the timeline (**V** gets back to Select) — or just tell me “pan mode”."
  },
  {
    pattern: /^how (?:do|can) i (?:undo|redo)(?: (?:that|an edit))?\??$/,
    answer:
      "**⌘Z / Ctrl+Z** undoes, **⌘⇧Z / Ctrl+Shift+Z** redoes. If I made the last edit, you can also just tell me “undo”."
  },
  {
    pattern: /^how (?:do|can) i (?:split|cut) (?:a )?clips?(?: manually)?\??$/,
    answer:
      "Two ways by hand: select a clip and press **S** to split it at the playhead, or press **C** for the Blade tool and click where you want the cut. Or just tell me — e.g. “split clip 2 at playhead”."
  },
  {
    pattern: /^how (?:do|can) i (?:add|drop) (?:a )?markers?\??$/,
    answer: "Press **M** to add/remove a marker at the playhead (right-click a marker to name or recolor it). Or tell me “add a marker”."
  },
  {
    pattern: /^how (?:do|can) i export(?: the video| my video| this)?\??$/,
    answer: "**⌘M / Ctrl+M** exports on this device (local render); **⌘⇧M / Ctrl+Shift+M** exports to the cloud."
  }
];

let cachedCapabilitiesAnswer: string | null = null;

/** Compose the capabilities answer FROM the registries — always current, zero tokens. */
function capabilitiesAnswer(): string {
  if (cachedCapabilitiesAnswer) {
    return cachedCapabilitiesAnswer;
  }
  const index = buildCapabilityIndex();
  const categories = [...new Set(index.actions.map((action) => action.category))];
  const effectNames = index.effects.map((effect) => effect.name);
  const toolNames = index.tools.map((tool) => tool.name);
  const skillNames = skillRegistry.map((skill) => skill.name);
  cachedCapabilitiesAnswer = [
    "Straight from the editor's registries — everything I do lands as editable, undoable timeline data:",
    "",
    `**Timeline edits** — ${index.actions.length} actions across ${categories.join(", ")}: add/restyle text and shapes, move/trim/split/delete clips, transitions, keyframes, markers, and more.`,
    `**Effects** (${effectNames.length}): ${effectNames.join(", ")}.`,
    `**Tools** (${toolNames.length}): ${toolNames.join(", ")}.`,
    `**Skills** (${skillNames.length}): ${skillNames.join(", ")}.`,
    "**Editor control** — say it and it happens: switch tools (“pan mode”, “blade tool”), transport (“play”, “pause”, “rewind”), the playhead (“go to 12 seconds”, “next marker”), selection (“select clip 3”), preview quality (“half resolution”, “auto quality”), panels (“open effects tab”, “open inspector”), snapping, undo/redo, export.",
    "",
    "Ask in plain words (“cut clip 2 on the beats”, “make the title cinematic”) — I'll pick the tools and show every step."
  ].join("\n");
  return cachedCapabilitiesAnswer;
}

/**
 * B5 — capability-gap pre-check. Known-impossible asks get an instant honest answer with the
 * nearest supported alternative, instead of the model burning a full reasoning run re-discovering
 * the gap (the refinement log paid this three times for "keyframe the blur"). Precision rule:
 * only fire when the named thing IS an effect — layer properties (opacity/position/scale/
 * rotation/pan/zoom) ARE keyframeable, so those questions pass through to the model untouched.
 */
const KEYFRAME_EFFECT_RE =
  /^(?:can (?:you|i) )?(?:keyframe|animate) (?:the )?(.{2,40}?)(?: (?:amount|intensity|strength|effect))?(?: (?:of|on|for) .{1,40})?(?: over time)?\s*\??$/;

const KEYFRAMEABLE_PROPS = /^(?:opacity|position|scale|rotation|size|pan|zoom|crop|x|y|transform)$/;

function capabilityGapAnswer(normalized: string): string | null {
  const match = KEYFRAME_EFFECT_RE.exec(normalized);
  if (!match) {
    return null;
  }
  const subject = match[1]!.trim();
  if (KEYFRAMEABLE_PROPS.test(subject)) {
    return null; // real keyframe territory — let the model/editor handle it
  }
  // Exact type/name match only — findEffect's keyword fallback would wrongly claim phrases
  // like "animate the text" (matched inside some effect's description) as effect gaps.
  const effect = buildCapabilityIndex().effects.find(
    (item) => item.type.toLowerCase() === subject || item.name.toLowerCase() === subject
  );
  if (!effect) {
    return null;
  }
  return [
    `Honest limit: **${effect.name}**'s parameters can't be keyframed yet — keyframes currently animate clip properties (opacity, position, scale, rotation, pan/zoom/crop), not effect params.`,
    `Nearest alternatives: split the clip and set a different ${effect.name.toLowerCase()} amount on each piece, or animate the clip's opacity/transform with keyframes for a similar feel.`
  ].join("\n");
}

/**
 * Voice-session sanity check ("are you listening?", "can you hear me?") — a REAL user reflex
 * that was burning a 4–15s LLM round-trip (2026-07-12 transcript). Includes the mishearing
 * shapes Web Speech produced for it ("you're listening to me"). Anchored to the whole
 * utterance and to "me" — "are you listening to the audio track" passes through untouched.
 */
// NOTE: the router's normalize() strips leading "can you / could you / please" — so "can you
// hear me" arrives as "hear me". The subjectless branch requires "me" (a lone "listening" or
// "hear" must not match).
const HEAR_CHECK_RE =
  /^(?:hey |so |ok(?:ay)? )?(?:(?:are you|do you|you)(?:'re| are)? (?:listening|hear(?:ing)?)(?: to)?(?: me)?|(?:listening|hear(?:ing)?)(?: to)? me)(?: now| right now)?\s*[?.!]?$/;

const HEAR_CHECK_ANSWERS = [
  "Yes — I hear you. What would you like to do?",
  "Loud and clear. What's the edit?",
  "I'm listening — go ahead."
];

export interface FaqAnswer {
  text: string;
  /** What matched, for the ledger/debugging. */
  matched: "capabilities" | "editor" | "capability-doc" | "capability-gap" | "hear-check";
}

/**
 * Answer a registry/editor question locally, or return null to escalate. `normalized` must be
 * lowercased + trimmed (the router owns normalization).
 */
export function answerFaq(normalized: string): FaqAnswer | null {
  if (HEAR_CHECK_RE.test(normalized)) {
    return { text: HEAR_CHECK_ANSWERS[Math.floor(Math.random() * HEAR_CHECK_ANSWERS.length)]!, matched: "hear-check" };
  }

  if (CAPABILITIES_RE.test(normalized) || CAPABILITIES_ALT_RE.test(normalized)) {
    return { text: capabilitiesAnswer(), matched: "capabilities" };
  }

  for (const entry of EDITOR_KNOWLEDGE) {
    if (entry.pattern.test(normalized)) {
      return { text: entry.answer, matched: "editor" };
    }
  }

  const gap = capabilityGapAnswer(normalized);
  if (gap) {
    return { text: gap, matched: "capability-gap" };
  }

  const howDoes = HOW_DOES_RE.exec(normalized);
  if (howDoes) {
    const needle = howDoes[1]!.trim();
    const index = buildCapabilityIndex();
    const doc =
      index.describeCapability(needle) ??
      (() => {
        const tool = index.findTool(needle);
        return tool ? index.describeCapability(tool.slug) : null;
      })() ??
      (() => {
        const effect = index.findEffect(needle);
        return effect ? index.describeCapability(effect.type) : null;
      })();
    if (doc) {
      return { text: doc, matched: "capability-doc" };
    }
    // Unknown capability → let the model handle it (it may be a UI concept we don't document).
  }

  return null;
}
