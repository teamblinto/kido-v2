/*
 * Cutting streamed Markdown into blocks, so a growing message re-renders only its last one
 * (spec 043; the rule follows t3code's markdownStreamBlocks).
 */

// Definitions, footnotes, raw HTML and display math can tie blocks together across blank lines.
const DOCUMENT_WIDE = /^ {0,3}(?:\[[^\]\n]+\]:|<[A-Za-z!?/]|\$\$)|\[\^/m;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
// After a blank line these still continue the block before: a list item or indented content.
const CONTINUATION = /^(?:[ \t]|(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$))/;

/**
 * Cuts at blank lines that close every open block, so each piece renders exactly as it would
 * inside the whole text. One piece (the whole text) when the text uses syntax that spans blocks.
 */
export function splitMarkdownBlocks(text: string): string[] {
  if (text.includes('\r') || DOCUMENT_WIDE.test(text)) return [text];

  const blocks: string[] = [];
  let blockStart = 0;
  let lineStart = 0;
  let fence: string | null = null;
  let afterBlank = false;

  for (const line of text.split('\n')) {
    const opener = FENCE.exec(line)?.[1];

    if (fence !== null) {
      if (
        opener !== undefined &&
        opener.startsWith(fence.charAt(0)) &&
        opener.length >= fence.length &&
        line.trim() === opener
      ) {
        fence = null;
      }
    } else if (line.trim() === '') {
      afterBlank = true;
    } else {
      if (afterBlank && lineStart > blockStart && !CONTINUATION.test(line)) {
        blocks.push(text.slice(blockStart, lineStart));
        blockStart = lineStart;
      }
      afterBlank = false;
      fence = opener ?? null;
    }

    lineStart += line.length + 1;
  }

  blocks.push(text.slice(blockStart));

  return blocks;
}
