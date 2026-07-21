/**
 * Markdown-lite PARSER for note bodies (plans/notes-sonnet-execution-3.md Q3.1) — pure string→data,
 * no React (shared is framework-agnostic; the UI layer maps this AST to elements). Deterministic,
 * no markdown library, no HTML: supports `**bold**`, `*italic*`, `- ` bullets, `# `/`## ` headings.
 * Anything else renders as plain text — this is a lightweight formatter, not a CommonMark parser.
 */

export type NoteMarkdownInline = { kind: "text" | "bold" | "italic"; value: string };

export type NoteMarkdownBlock =
  | { kind: "heading"; level: 1 | 2; inline: NoteMarkdownInline[] }
  | { kind: "bullet"; inline: NoteMarkdownInline[] }
  | { kind: "paragraph"; inline: NoteMarkdownInline[] };

/** `**bold**` / `*italic*` tokenizer for one line's text (non-nested, first-match-wins). */
export function parseNoteMarkdownInline(text: string): NoteMarkdownInline[] {
  const tokens: NoteMarkdownInline[] = [];
  const re = /\*\*([^*]+)\*\*|\*([^*]+)\*/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) tokens.push({ kind: "text", value: text.slice(lastIndex, match.index) });
    if (match[1] !== undefined) tokens.push({ kind: "bold", value: match[1] });
    else if (match[2] !== undefined) tokens.push({ kind: "italic", value: match[2] });
    lastIndex = re.lastIndex;
  }
  if (lastIndex < text.length) tokens.push({ kind: "text", value: text.slice(lastIndex) });
  return tokens.length > 0 ? tokens : [{ kind: "text", value: "" }];
}

/** Line-by-line block parser: each line becomes one block (headings/bullets detected by prefix). */
export function parseNoteMarkdown(text: string): NoteMarkdownBlock[] {
  return text.split("\n").map((line) => {
    if (line.startsWith("## ")) return { kind: "heading" as const, level: 2 as const, inline: parseNoteMarkdownInline(line.slice(3)) };
    if (line.startsWith("# ")) return { kind: "heading" as const, level: 1 as const, inline: parseNoteMarkdownInline(line.slice(2)) };
    if (line.startsWith("- ")) return { kind: "bullet" as const, inline: parseNoteMarkdownInline(line.slice(2)) };
    return { kind: "paragraph" as const, inline: parseNoteMarkdownInline(line) };
  });
}
