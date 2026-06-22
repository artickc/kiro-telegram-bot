/**
 * Convert standard Markdown (as produced by the agent) into Telegram
 * MarkdownV2, with correct escaping and graceful handling of code blocks,
 * headings, lists, quotes, links and inline styles.
 */
import { escapeCode, escapeMdV2, escapeUrl } from "./escape.js";

const FENCE = /```([^\n`]*)\n([\s\S]*?)```/g;

/** Main entry: returns a MarkdownV2-safe string. */
export function toTelegramMarkdown(src: string): string {
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  FENCE.lastIndex = 0;

  while ((m = FENCE.exec(src)) !== null) {
    out += renderTextBlock(src.slice(last, m.index));
    const lang = (m[1] ?? "").trim();
    const code = (m[2] ?? "").replace(/\n$/, "");
    out += "```" + lang + "\n" + escapeCode(code) + "\n```\n";
    last = FENCE.lastIndex;
  }
  out += renderTextBlock(src.slice(last));

  return out.replace(/\n{3,}/g, "\n\n").trim();
}

function renderTextBlock(text: string): string {
  if (!text) return "";
  return text
    .split("\n")
    // Drop stray orphan backtick lines (` or ``) left by an unbalanced/partial
    // code fence — they otherwise render as a broken-looking lone "`". A real
    // fence is ``` (3+) and is handled by the FENCE pass, so it's never seen here.
    .filter((line) => !/^\s*`{1,2}\s*$/.test(line))
    .map((line) => renderLine(line))
    .join("\n");
}

function renderLine(line: string): string {
  // Heading -> bold
  const heading = /^(#{1,6})\s+(.*)$/.exec(line);
  if (heading) return "*" + renderInline((heading[2] ?? "").replace(/#+\s*$/, "").trim()) + "*";

  // Horizontal rule
  if (/^\s*([-*_])\1{2,}\s*$/.test(line)) return "\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014";

  // Blockquote (keep '>' literal so Telegram renders the quote)
  const quote = /^>\s?(.*)$/.exec(line);
  if (quote) return ">" + renderInline(quote[1] ?? "");

  // Unordered list
  const ul = /^(\s*)[-*+]\s+(.*)$/.exec(line);
  if (ul) return (ul[1] ?? "") + "\u2022 " + renderInline(ul[2] ?? "");

  // Ordered list
  const ol = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
  if (ol) return (ol[1] ?? "") + (ol[2] ?? "") + "\\. " + renderInline(ol[3] ?? "");

  return renderInline(line);
}

/** Render inline markdown spans into MarkdownV2. */
function renderInline(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;

  while (i < n) {
    const c = text[i]!;
    const next = text[i + 1];

    // Inline code
    if (c === "`") {
      const end = text.indexOf("`", i + 1);
      if (end !== -1) {
        out += "`" + escapeCode(text.slice(i + 1, end)) + "`";
        i = end + 1;
        continue;
      }
    }

    // Bold ** ** or __ __
    if ((c === "*" && next === "*") || (c === "_" && next === "_")) {
      const marker = c + c;
      const end = text.indexOf(marker, i + 2);
      if (end !== -1 && end > i + 2) {
        out += "*" + renderInline(text.slice(i + 2, end)) + "*";
        i = end + 2;
        continue;
      }
    }

    // Strikethrough ~~ ~~
    if (c === "~" && next === "~") {
      const end = text.indexOf("~~", i + 2);
      if (end !== -1 && end > i + 2) {
        out += "~" + renderInline(text.slice(i + 2, end)) + "~";
        i = end + 2;
        continue;
      }
    }

    // Italic * * (single)
    if (c === "*") {
      const end = text.indexOf("*", i + 1);
      if (end !== -1 && end > i + 1) {
        out += "_" + renderInline(text.slice(i + 1, end)) + "_";
        i = end + 1;
        continue;
      }
    }

    // Link [text](url)
    if (c === "[") {
      const link = /^\[([^\]]*)\]\(([^)\s]+)\)/.exec(text.slice(i));
      if (link) {
        out += "[" + renderInline(link[1] ?? "") + "](" + escapeUrl(link[2] ?? "") + ")";
        i += link[0].length;
        continue;
      }
    }

    out += escapeMdV2(c);
    i += 1;
  }

  return out;
}
