import { Fragment, type ReactNode } from "react";

/**
 * A tiny, dependency-free, injection-safe Markdown renderer for AI chat messages
 * (Talk mode replies use headings, bold, and bullet/numbered lists). It builds
 * React elements directly — never `dangerouslySetInnerHTML` — so model output can
 * never inject HTML. Supports: headings, bullet and numbered lists, blank-line
 * paragraphs, and inline bold, italic, and inline code.
 */

let keySeq = 0;
const key = () => `md_${(keySeq += 1)}`;

/** Inline: split on bold, italic, and inline code spans. */
function renderInline(text: string): ReactNode[] {
  const pattern = /(\*\*([^*]+)\*\*|`([^`]+)`|\*([^*]+)\*|_([^_]+)_)/g;
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    if (match[2] !== undefined) nodes.push(<strong key={key()}>{match[2]}</strong>);
    else if (match[3] !== undefined) nodes.push(<code key={key()}>{match[3]}</code>);
    else if (match[4] !== undefined) nodes.push(<em key={key()}>{match[4]}</em>);
    else if (match[5] !== undefined) nodes.push(<em key={key()}>{match[5]}</em>);
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes;
}

const BULLET = /^\s*[-*]\s+(.*)$/;
const NUMBERED = /^\s*\d+\.\s+(.*)$/;
const HEADING = /^(#{1,3})\s+(.*)$/;

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const joined = paragraph.join(" ");
    blocks.push(<p key={key()}>{renderInline(joined)}</p>);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    const items = list.items.map((item) => <li key={key()}>{renderInline(item)}</li>);
    blocks.push(list.ordered ? <ol key={key()}>{items}</ol> : <ul key={key()}>{items}</ul>);
    list = null;
  };

  for (const line of lines) {
    const heading = HEADING.exec(line);
    const bullet = BULLET.exec(line);
    const numbered = NUMBERED.exec(line);

    if (line.trim() === "") {
      flushParagraph();
      flushList();
      continue;
    }
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1]!.length;
      const Tag = (`h${Math.min(4, level + 2)}`) as "h3" | "h4";
      blocks.push(<Tag key={key()}>{renderInline(heading[2]!)}</Tag>);
      continue;
    }
    if (bullet || numbered) {
      flushParagraph();
      const ordered = Boolean(numbered);
      const content = (bullet?.[1] ?? numbered?.[1])!;
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push(content);
      continue;
    }
    flushList();
    paragraph.push(line.trim());
  }
  flushParagraph();
  flushList();

  return <Fragment>{blocks}</Fragment>;
}
