/**
 * Build ACP prompt content blocks from a PromptInput (text + images), applying
 * the reasoning directive and any fork-priming context. Also merges multiple
 * queued inputs into one.
 */
import type { ContentBlock } from "../acp/types.js";
import type { PromptInput } from "../app/types.js";

export interface ContentOptions {
  reasoning?: string;
  priming?: string;
}

export function buildContentBlocks(input: PromptInput, opts: ContentOptions = {}): ContentBlock[] {
  const blocks: ContentBlock[] = [];

  for (const img of input.images) {
    blocks.push({ type: "image", data: img.data, mimeType: img.mimeType });
  }

  let text = input.text.trim();
  if (!text && input.images.length > 0) {
    text = input.images.length === 1 ? "Please analyze the attached image." : "Please analyze the attached images.";
  }
  if (opts.priming) {
    text = `${opts.priming}\n\n---\n\nUser's new message:\n${text}`;
  }
  if (opts.reasoning) {
    text = `(${opts.reasoning})\n\n${text}`;
  }

  blocks.push({ type: "text", text });
  return blocks;
}

/** Merge queued inputs into a single prompt (concatenated text, all images). */
export function mergeInputs(inputs: PromptInput[]): PromptInput {
  return {
    text: inputs
      .map((i) => i.text)
      .filter((t) => t.trim().length > 0)
      .join("\n\n"),
    images: inputs.flatMap((i) => i.images),
    replyTo: inputs.find((i) => i.replyTo !== undefined)?.replyTo,
  };
}

export function imageSummary(input: PromptInput): string {
  return input.images.length > 0 ? ` (+${input.images.length} image${input.images.length > 1 ? "s" : ""})` : "";
}
