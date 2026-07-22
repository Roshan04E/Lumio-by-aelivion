/**
 * Markdown-lite PARSER for note bodies (plans/notes-sonnet-execution-3.md Q3.1) — pure string→data,
 * no React (shared is framework-agnostic; the UI layer maps this AST to elements). Deterministic,
 * no markdown library, no HTML. Supports `**bold**`, `*italic*`, `` `code` `` inline; and, per line,
 * `#`/`##`/`###` headings, `- `/`* ` bullets, `1.` ordered items, and `- [ ]`/`- [x]` task items.
 * Anything else renders as plain text — this is a lightweight formatter, not a CommonMark parser.
 *
 * Headings do NOT require a space after the hashes (`##Heading` works, not just `## Heading`) — a
 * common friction point. To keep a line LITERAL (a real leading `#`, hashtag, etc.), start it with a
 * backslash (`\# not a heading`) or wrap the run in backticks (`` `#tag` `` → inline code).
 */

export type NoteMarkdownInline = { kind: "text" | "bold" | "italic" | "code"; value: string };

export type NoteMarkdownBlock =
  | { kind: "heading"; level: 1 | 2 | 3; inline: NoteMarkdownInline[] }
  | { kind: "bullet"; inline: NoteMarkdownInline[] }
  | { kind: "ordered"; index: number; inline: NoteMarkdownInline[] }
  | { kind: "task"; checked: boolean; inline: NoteMarkdownInline[] }
  | { kind: "paragraph"; inline: NoteMarkdownInline[] };

/** `**bold**` / `*italic*` / `` `code` `` tokenizer for one line (non-nested, first-match-wins). */
export function parseNoteMarkdownInline(text: string): NoteMarkdownInline[] {
  const tokens: NoteMarkdownInline[] = [];
  const re = /\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) tokens.push({ kind: "text", value: text.slice(lastIndex, match.index) });
    if (match[1] !== undefined) tokens.push({ kind: "bold", value: match[1] });
    else if (match[2] !== undefined) tokens.push({ kind: "italic", value: match[2] });
    else if (match[3] !== undefined) tokens.push({ kind: "code", value: match[3] });
    lastIndex = re.lastIndex;
  }
  if (lastIndex < text.length) tokens.push({ kind: "text", value: text.slice(lastIndex) });
  return tokens.length > 0 ? tokens : [{ kind: "text", value: "" }];
}

/** Line-by-line block parser: each line becomes one block (prefix detects headings/lists/tasks). */
export function parseNoteMarkdown(text: string): NoteMarkdownBlock[] {
  return text.split("\n").map((line) => {
    // Escape hatch: a leading backslash keeps the line literal (`\# foo` → the paragraph "# foo"),
    // so a real leading '#'/'-'/'1.' etc. is never swallowed by the formatter.
    if (line.startsWith("\\")) return { kind: "paragraph" as const, inline: parseNoteMarkdownInline(line.slice(1)) };
    // Task items (`- [ ] ` / `- [x] `) are checked BEFORE plain bullets so the checkbox wins.
    const task = /^[-*] \[([ xX])\] (.*)$/.exec(line);
    if (task) return { kind: "task" as const, checked: task[1]!.toLowerCase() === "x", inline: parseNoteMarkdownInline(task[2]!) };
    // Headings: 1–3 '#' then OPTIONAL whitespace then content — the space after '#' is not required.
    const heading = /^(#{1,3})(?!#)[ \t]*(\S.*)$/.exec(line);
    if (heading) return { kind: "heading" as const, level: heading[1]!.length as 1 | 2 | 3, inline: parseNoteMarkdownInline(heading[2]!) };
    if (line.startsWith("- ") || line.startsWith("* ")) return { kind: "bullet" as const, inline: parseNoteMarkdownInline(line.slice(2)) };
    const ordered = /^(\d+)\. (.*)$/.exec(line);
    if (ordered) return { kind: "ordered" as const, index: Number(ordered[1]), inline: parseNoteMarkdownInline(ordered[2]!) };
    return { kind: "paragraph" as const, inline: parseNoteMarkdownInline(line) };
  });
}
