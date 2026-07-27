/**
 * Document ingestion helpers.
 *
 * Telegram delivers non-photo attachments as *documents*. The most common case
 * for this bot is a **long message that a Telegram client turned into a `.txt`
 * file** (Desktop does this when you paste more than a few thousand characters),
 * but users also drop code, logs, JSON, CSV, etc. We want the agent to actually
 * *read* those, so this module:
 *   • decides whether a downloaded file is text (mime + extension hints, plus a
 *     content sniff so mislabeled `application/octet-stream` code files work),
 *   • decodes text (stripping BOMs), and
 *   • formats a clear prompt for either a text or a binary attachment.
 *
 * Image documents are handled separately (see handlers/photo.ts).
 */

/** MIME prefixes that are always textual. */
const TEXT_MIME_PREFIXES = ["text/"];

/** Exact MIME types that are textual despite an `application/*` namespace. */
const TEXT_MIME_EXACT = new Set([
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/javascript",
  "application/x-javascript",
  "application/typescript",
  "application/x-typescript",
  "application/x-yaml",
  "application/yaml",
  "application/toml",
  "application/x-toml",
  "application/x-sh",
  "application/x-shellscript",
  "application/x-httpd-php",
  "application/sql",
  "application/graphql",
  "application/x-ndjson",
  "application/csv",
  "application/x-tex",
  "application/x-latex",
  "image/svg+xml",
]);

/** File extensions we treat as text (used when the MIME type is missing/generic). */
const TEXT_EXTENSIONS = new Set([
  "txt", "text", "md", "markdown", "mdx", "rst", "adoc", "log", "csv", "tsv",
  "json", "json5", "jsonl", "ndjson", "xml", "yaml", "yml", "toml", "ini", "cfg",
  "conf", "config", "env", "properties", "editorconfig", "gitignore", "gitattributes",
  "js", "mjs", "cjs", "jsx", "ts", "tsx", "mts", "cts", "py", "pyi", "rb", "php",
  "java", "kt", "kts", "go", "rs", "c", "h", "cpp", "cxx", "cc", "hpp", "hxx", "cs",
  "swift", "m", "mm", "sh", "bash", "zsh", "fish", "ps1", "psm1", "bat", "cmd",
  "sql", "graphql", "gql", "html", "htm", "xhtml", "css", "scss", "sass", "less",
  "vue", "svelte", "astro", "gradle", "groovy", "lua", "pl", "pm", "r", "dart",
  "scala", "clj", "cljs", "edn", "ex", "exs", "erl", "hrl", "hs", "ml", "mli",
  "fs", "fsx", "vb", "asm", "s", "proto", "tf", "tfvars", "hcl", "svg", "patch",
  "diff", "tex", "bib", "csv", "cmake", "dockerfile", "makefile", "rake", "gemfile",
]);

/** Extensions that are always binary even if the sniff is inconclusive. */
const BINARY_EXTENSIONS = new Set([
  "zip", "gz", "tar", "tgz", "rar", "7z", "bz2", "xz", "pdf", "doc", "docx",
  "xls", "xlsx", "ppt", "pptx", "png", "jpg", "jpeg", "gif", "bmp", "webp",
  "ico", "tiff", "mp3", "wav", "ogg", "flac", "mp4", "mkv", "mov", "avi", "webm",
  "exe", "dll", "so", "dylib", "bin", "dat", "db", "sqlite", "class", "jar",
  "woff", "woff2", "ttf", "otf", "eot", "psd", "ai", "sketch",
]);

const MAX_SNIFF_BYTES = 8192;

/** Lowercased extension (or a bare well-known filename like `dockerfile`). */
function extensionOf(name?: string): string {
  if (!name) return "";
  const base = name.toLowerCase().replace(/^.*[\\/]/, "");
  if (base === "dockerfile" || base === "makefile" || base === "gemfile" || base === "rakefile") return base;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1) : "";
}

/**
 * Content sniff: NUL byte or a high proportion of control characters marks a
 * buffer as binary. UTF-8 multibyte bytes (>= 0x80) are allowed, so
 * non-English text is not misclassified.
 */
function sniff(buf: Buffer): "text" | "binary" {
  const n = Math.min(buf.length, MAX_SNIFF_BYTES);
  let control = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i]!;
    if (b === 0) return "binary";
    // Allow TAB(9), LF(10), CR(13), FF(12), and everything from 0x20 up.
    if ((b < 9 || (b > 13 && b < 32)) && b !== 27 /* ESC, common in logs */) control++;
  }
  return control / n > 0.1 ? "binary" : "text";
}

/**
 * Decide whether a downloaded document is text we can inline. Combines MIME and
 * extension hints with a content sniff; the sniff is authoritative for NUL
 * bytes so a `.txt` full of binary can't slip through.
 */
export function looksLikeText(buf: Buffer, mimeType?: string, fileName?: string): boolean {
  if (buf.length === 0) return true; // empty file — harmless to inline as ""
  const mime = (mimeType ?? "").toLowerCase();
  const ext = extensionOf(fileName);

  const hintedText =
    TEXT_MIME_PREFIXES.some((p) => mime.startsWith(p)) || TEXT_MIME_EXACT.has(mime) || TEXT_EXTENSIONS.has(ext);
  const hintedBinary =
    mime.startsWith("image/") ||
    mime.startsWith("audio/") ||
    mime.startsWith("video/") ||
    mime.startsWith("font/") ||
    BINARY_EXTENSIONS.has(ext);

  const content = sniff(buf);
  if (content === "binary") return false; // NUL / control-heavy → never text
  if (hintedText) return true;
  if (hintedBinary) return false;
  // Unknown type (e.g. application/octet-stream with no extension): trust sniff.
  return content === "text";
}

/** Decode a text buffer as UTF-8 / UTF-16, stripping a leading BOM. */
export function decodeText(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString("utf8");
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString("utf16le");
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // UTF-16 BE — swap to LE for Node's decoder.
    return buf.subarray(2).swap16().toString("utf16le");
  }
  return buf.toString("utf8");
}

/** A fenced block that won't collide with backticks already in the content. */
function pickFence(content: string): string {
  let fence = "```";
  while (content.includes(fence)) fence += "`";
  return fence;
}

/** Format a human-readable byte count. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

/**
 * Build the prompt text for a text document. With a caption the file is framed
 * as an attachment to act on; without one it's treated as the user's message
 * itself (the "long message became a .txt" case).
 */
export function formatTextFilePrompt(name: string, content: string, caption: string, truncated: boolean): string {
  const fence = pickFence(content);
  const block = `${fence}\n${content}\n${fence}`;
  const note = truncated ? "\n\n(Note: the file was long and has been truncated above.)" : "";
  const cap = caption.trim();
  if (cap) {
    return `${cap}\n\nAttached file "${name}":\n${block}${note}`;
  }
  return `The user's message was sent as a file "${name}" (Telegram turns long messages into files). Its contents:\n${block}${note}`;
}

/** Build the prompt text for a binary document we can't inline. */
export function formatBinaryFilePrompt(
  name: string,
  mimeType: string | undefined,
  size: number,
  caption: string,
  savedPath: string | undefined,
): string {
  const meta = `name "${name}", type ${mimeType || "unknown"}, ${formatBytes(size)}`;
  const loc = savedPath
    ? ` It has been saved to: ${savedPath} — open it with your file tools if that helps.`
    : "";
  const cap = caption.trim();
  const head = cap ? `${cap}\n\n` : "";
  return `${head}The user sent a binary file (${meta}) whose contents can't be shown as text.${loc}`;
}
