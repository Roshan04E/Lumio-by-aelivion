/**
 * Kimera Brain — tier-0 EDITOR COMMANDS (the command plane's compiler). Turns exact spoken/typed
 * control phrases into editor commands ("pan mode" → setTool(hand), "pause" → transport,
 * "select clip 3" → selectClip) for the EditorPage dispatcher to execute. Zero tokens, <5 ms —
 * the latency class always-on voice needs.
 *
 * PRECISION CONTRACT (router.ts): whole-string anchored patterns only; anything else returns
 * null and the prompt escalates. Bare risky words don't fire: "cut" alone could mean cutting a
 * clip (escalates); "cut tool" / "blade" are unambiguous. Every pattern here has brain:eval
 * coverage before it ships. Rules are 👎-gated per ruleId (t0.cmd.*) like every brain rule.
 */

import type { TimelineComposition } from "@kimera-by-aelivion/shared";
import { computeLayerOrdinals, layerIdForOrdinal } from "@kimera-by-aelivion/shared";
import type { EditorCommandId } from "../../editor/editor-commands";

export interface CompiledCommand {
  kind: "command";
  commandId: EditorCommandId;
  params: unknown;
  ruleId: string;
  /** Confirmation line the panel speaks after the dispatcher succeeds. */
  say: string;
}

export interface CommandAnswer {
  kind: "answer";
  text: string;
  ruleId: string;
}

export interface CommandContext {
  composition: TimelineComposition;
  nowSeconds: number;
}

const ORDINAL_WORDS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10
};

/** A phrase that is EXACTLY a clip reference ("clip 3", "the 2nd clip") → its ordinal. */
function parseExactClipPhrase(phrase: string): number | undefined {
  const rest = phrase.replace(/^(?:the|my)\s+/, "").trim();
  const numeric = /^(?:clip|layer)\s*(?:#|number\s*)?(\d{1,3})$/.exec(rest);
  if (numeric) {
    return Number(numeric[1]) || undefined;
  }
  const nth = /^(\d{1,3})(?:st|nd|rd|th)\s+(?:clip|layer)$/.exec(rest);
  if (nth) {
    return Number(nth[1]) || undefined;
  }
  const word = /^([a-z]+)\s+(?:clip|layer)$/.exec(rest);
  if (word) {
    return ORDINAL_WORDS[word[1]!];
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Tools. Bare names allowed only where unambiguous (hand/pan/grab/blade);
// select/cut/roll/slide REQUIRE a "tool"/"mode" suffix (bare forms collide with edits).
// ---------------------------------------------------------------------------

const TOOL_BARE_RE = /^(?:switch to |go to |enter |activate |use |give me )?(?:the )?(hand|pan|panning|grab|blade)(?: tool| mode)?$/;
const TOOL_SUFFIXED_RE =
  /^(?:switch to |go to |enter |activate |use |give me )?(?:the )?(select(?:ion)?|pointer|arrow|cut(?:ting)?|razor|roll(?:ing)?|slide) (?:tool|mode)$/;

const TOOL_MAP: Record<string, "select" | "blade" | "hand" | "roll" | "slide"> = {
  hand: "hand",
  pan: "hand",
  panning: "hand",
  grab: "hand",
  blade: "blade",
  cut: "blade",
  cutting: "blade",
  razor: "blade",
  select: "select",
  selection: "select",
  pointer: "select",
  arrow: "select",
  roll: "roll",
  rolling: "roll",
  slide: "slide"
};

const TOOL_SAY: Record<string, string> = {
  select: "🖱 Select tool",
  hand: "🖐 Hand tool — drag to pan",
  blade: "🔪 Blade tool — click to cut",
  roll: "↔ Roll tool",
  slide: "⇆ Slide tool"
};

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

const PLAY_RE = /^(?:play|resume|play (?:the )?(?:video|timeline)|start (?:playback|playing)|keep playing)$/;
const PAUSE_RE = /^(?:pause|pause (?:the )?(?:video|playback)|stop playing)$/;
const STOP_RE = /^stop(?: playback)?$/;
const TOGGLE_PLAY_RE = /^(?:play\/pause|toggle play(?:back)?)$/;
const SHUTTLE_FWD_RE = /^(?:fast[- ]forward|shuttle forward)$/;
const SHUTTLE_BACK_RE = /^(?:rewind|shuttle back(?:wards?)?)$/;

// ---------------------------------------------------------------------------
// Seek
// ---------------------------------------------------------------------------

const SEEK_SECONDS_RE = /^(?:go|jump|seek) to (\d{1,4}(?:\.\d+)?) ?(?:s|sec|secs|seconds?)$/;
const SEEK_TIMECODE_RE = /^(?:go|jump|seek) to (\d{1,3}):([0-5]\d)$/;
const SEEK_START_RE = /^(?:go|jump|seek) to (?:the )?(?:start|beginning)$/;
const SEEK_END_RE = /^(?:go|jump|seek) to (?:the )?end$/;
const NEXT_CUT_RE = /^(?:go to (?:the )?)?next (?:cut|edit(?: point)?)$/;
const PREV_CUT_RE = /^(?:go to (?:the )?)?(?:previous|prev|last) (?:cut|edit(?: point)?)$/;
const NEXT_MARKER_RE = /^(?:go to (?:the )?)?next marker$/;
const PREV_MARKER_RE = /^(?:go to (?:the )?)?(?:previous|prev|last) marker$/;
const FRAME_STEP_RE = /^(?:step|nudge) (forward|ahead|back(?:wards?)?)(?: (?:a|one) frame)?$/;
const SKIP_RE = /^(?:skip|go|jump|move) (forward|ahead|back(?:wards?)?) (\d{1,4}(?:\.\d+)?) ?(?:s|sec|secs|seconds?)$/;

// ---------------------------------------------------------------------------
// Selection / view / app
// ---------------------------------------------------------------------------

const SELECT_CLIP_RE = /^(?:select|highlight) (.+)$/;
const DESELECT_RE = /^(?:deselect(?: everything| all)?|clear (?:the )?selection|select nothing)$/;

const QUALITY_WORD = "(quarter|1\\/4|¼|half|1\\/2|½|full|max(?:imum)?|auto)";
const QUALITY_RE = new RegExp(
  `^(?:(?:set|switch) (?:the )?)?(?:preview |playback )?(?:quality|res(?:olution)?) (?:to )?${QUALITY_WORD}$` +
    `|^${QUALITY_WORD} (?:preview )?(?:quality|res(?:olution)?)$`
);

const QUALITY_MAP: Record<string, "quarter" | "half" | "full" | "auto"> = {
  quarter: "quarter",
  "1/4": "quarter",
  "¼": "quarter",
  half: "half",
  "1/2": "half",
  "½": "half",
  full: "full",
  max: "full",
  maximum: "full",
  auto: "auto"
};

const QUALITY_SAY: Record<string, string> = {
  quarter: "◔ Quarter resolution preview",
  half: "◑ Half resolution preview",
  full: "● Full resolution preview",
  auto: "Ⓐ Auto quality — adapts while you work"
};

const SNAP_RE = /^(?:turn )?snap(?:ping)? (on|off)$|^(enable|disable) snap(?:ping)?$/;
const SNAP_TOGGLE_RE = /^toggle snap(?:ping)?$/;

const REDO_RE = /^redo(?: that| it| last)?$/;

const EXPORT_RE = /^export(?: (?:the |my )?(?:video|project|timeline))?(?: locally| on this device)?$/;

// ---------------------------------------------------------------------------
// Panels. Verb + panel noun. Ambiguity guard: "effects"/"color" need a
// tab/panel suffix (bare "show effects" could mean a clip's applied effects);
// media/assets/settings/inspector are unambiguous panel names on their own.
// ---------------------------------------------------------------------------

const PANEL_VERB_RE = /^(open|show|go to|switch to|bring up|close|hide|collapse|toggle) (.+?)( for me| please)?$/;

const PANEL_NOUNS: Array<{ re: RegExp; panel: "assets" | "effects" | "color" | "settings" | "inspector" }> = [
  { re: /^(?:the |my )?(?:media(?: pool| library| bin)?|assets?(?: bin| tab| panel| library)?)(?: tab| panel)?$/, panel: "assets" },
  { re: /^(?:the )?effects? (?:tab|panel|library|browser)$/, panel: "effects" },
  { re: /^(?:the )?colou?rs? (?:tab|panel|page)$/, panel: "color" },
  { re: /^(?:the )?(?:project )?settings(?: tab| panel| page)?$/, panel: "settings" },
  { re: /^(?:the )?inspector(?: panel)?$/, panel: "inspector" }
];

const PANEL_SAY: Record<string, string> = {
  assets: "📁 Media Pool",
  effects: "✨ Effects panel",
  color: "🎨 Color panel",
  settings: "⚙ Project settings",
  inspector: "🔍 Inspector"
};

// ---------------------------------------------------------------------------
// The compiler
// ---------------------------------------------------------------------------

function command(commandId: EditorCommandId, params: unknown, ruleId: string, say: string): CompiledCommand {
  return { kind: "command", commandId, params, ruleId, say };
}

/**
 * Compile a NORMALIZED prompt into one editor command, an honest answer, or null (→ next tier).
 * Pure — execution and its own gating live in the EditorPage dispatcher.
 */
export function compileEditorCommand(text: string, context: CommandContext): CompiledCommand | CommandAnswer | null {
  // Tools
  let match = TOOL_BARE_RE.exec(text) ?? TOOL_SUFFIXED_RE.exec(text);
  if (match) {
    const tool = TOOL_MAP[match[1]!];
    if (tool) {
      return command("setTool", { tool }, "t0.cmd.tool", TOOL_SAY[tool]!);
    }
  }

  // Transport
  if (PLAY_RE.test(text)) {
    return command("transport", { op: "play" }, "t0.cmd.transport", "▶ Playing");
  }
  if (PAUSE_RE.test(text)) {
    return command("transport", { op: "pause" }, "t0.cmd.transport", "⏸ Paused");
  }
  if (STOP_RE.test(text)) {
    return command("transport", { op: "stop" }, "t0.cmd.transport", "⏹ Stopped");
  }
  if (TOGGLE_PLAY_RE.test(text)) {
    return command("transport", { op: "toggle" }, "t0.cmd.transport", "⏯ Toggled playback");
  }
  if (SHUTTLE_FWD_RE.test(text)) {
    return command("transport", { op: "shuttleForward" }, "t0.cmd.transport", "⏩ Shuttling forward (say it again for faster)");
  }
  if (SHUTTLE_BACK_RE.test(text)) {
    return command("transport", { op: "shuttleBack" }, "t0.cmd.transport", "⏪ Shuttling back");
  }

  // Seek
  match = SEEK_SECONDS_RE.exec(text);
  if (match) {
    const seconds = Number(match[1]);
    return command("seek", { toSeconds: seconds }, "t0.cmd.seek", `⏱ Playhead → ${seconds}s`);
  }
  match = SEEK_TIMECODE_RE.exec(text);
  if (match) {
    const seconds = Number(match[1]) * 60 + Number(match[2]);
    return command("seek", { toSeconds: seconds }, "t0.cmd.seek", `⏱ Playhead → ${match[1]}:${match[2]}`);
  }
  if (SEEK_START_RE.test(text)) {
    return command("seek", { target: "start" }, "t0.cmd.seek", "⏮ At the start");
  }
  if (SEEK_END_RE.test(text)) {
    return command("seek", { target: "end" }, "t0.cmd.seek", "⏭ At the end");
  }
  if (NEXT_CUT_RE.test(text)) {
    return command("seek", { target: "nextCut" }, "t0.cmd.seek", "→ Next cut");
  }
  if (PREV_CUT_RE.test(text)) {
    return command("seek", { target: "prevCut" }, "t0.cmd.seek", "← Previous cut");
  }
  if (NEXT_MARKER_RE.test(text)) {
    return command("seek", { target: "nextMarker" }, "t0.cmd.seek", "→ Next marker");
  }
  if (PREV_MARKER_RE.test(text)) {
    return command("seek", { target: "prevMarker" }, "t0.cmd.seek", "← Previous marker");
  }
  match = FRAME_STEP_RE.exec(text);
  if (match) {
    const forward = /^(?:forward|ahead)$/.test(match[1]!);
    return command("seek", { frames: forward ? 1 : -1 }, "t0.cmd.seek", forward ? "· One frame forward" : "· One frame back");
  }
  match = SKIP_RE.exec(text);
  if (match) {
    const forward = /^(?:forward|ahead)$/.test(match[1]!);
    const seconds = Number(match[2]);
    return command(
      "seek",
      { deltaSeconds: forward ? seconds : -seconds },
      "t0.cmd.seek",
      `⏱ ${forward ? "Forward" : "Back"} ${seconds}s`
    );
  }

  // Selection (before nothing else claims "select …"; non-clip phrases fall through to escalate)
  if (DESELECT_RE.test(text)) {
    return command("selectClip", { clear: true }, "t0.cmd.select", "✕ Selection cleared");
  }
  match = SELECT_CLIP_RE.exec(text);
  if (match) {
    const ordinal = parseExactClipPhrase(match[1]!);
    if (ordinal !== undefined) {
      const layerId = layerIdForOrdinal(context.composition, ordinal);
      if (!layerId) {
        return {
          kind: "answer",
          text: `There's no clip ${ordinal} to select — I count ${computeLayerOrdinals(context.composition).size} clip(s) on the timeline.`,
          ruleId: "t0.cmd.select"
        };
      }
      return command("selectClip", { layerId }, "t0.cmd.select", `☑ Clip ${ordinal} selected`);
    }
    // "select the good clips" etc. — not structurally certain, fall through.
  }

  // Preview quality
  match = QUALITY_RE.exec(text);
  if (match) {
    const word = (match[1] ?? match[2])!;
    const quality = QUALITY_MAP[word];
    if (quality) {
      return command("setPreviewQuality", { quality }, "t0.cmd.quality", QUALITY_SAY[quality]!);
    }
  }

  // Snapping
  match = SNAP_RE.exec(text);
  if (match) {
    const on = match[1] === "on" || match[2] === "enable";
    return command("setSnapping", { on }, "t0.cmd.snap", on ? "🧲 Snapping on" : "🧲 Snapping off");
  }
  if (SNAP_TOGGLE_RE.test(text)) {
    return command("setSnapping", { toggle: true }, "t0.cmd.snap", "🧲 Snapping toggled");
  }

  // App
  if (REDO_RE.test(text)) {
    return command("editorUndoRedo", { op: "redo" }, "t0.cmd.history", "↷ Redone");
  }
  if (EXPORT_RE.test(text)) {
    return command("openExport", {}, "t0.cmd.export", "📤 Opening export — pick format and go");
  }

  // Panels
  match = PANEL_VERB_RE.exec(text);
  if (match) {
    const verb = match[1]!;
    const noun = match[2]!.trim();
    const entry = PANEL_NOUNS.find((candidate) => candidate.re.test(noun));
    if (entry) {
      const op = verb === "toggle" ? "toggle" : /^(close|hide|collapse)$/.test(verb) ? "close" : "open";
      const say =
        op === "open" ? `${PANEL_SAY[entry.panel]} open` : op === "close" ? `${PANEL_SAY[entry.panel]} closed` : `${PANEL_SAY[entry.panel]} toggled`;
      return command("openPanel", { panel: entry.panel, op }, "t0.cmd.panel", say);
    }
  }

  return null;
}
