import hljs from 'highlight.js/lib/core';
import css from 'highlight.js/lib/languages/css';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import shell from 'highlight.js/lib/languages/bash';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

/**
 * Syntax colouring for the read-only file view (research R6).
 *
 * The core build plus the grammars below, never `highlight.js` itself: the full bundle carries
 * ~190 languages for the twelve this product shows. An extension with no grammar here is not an
 * error — it renders plain monospace (`null`), which is why the caller never has to know the list.
 */
const GRAMMARS: Record<string, { language: unknown; name: string }> = {
  bash: { language: shell, name: 'bash' },
  css: { language: css, name: 'css' },
  html: { language: xml, name: 'xml' },
  js: { language: javascript, name: 'javascript' },
  json: { language: json, name: 'json' },
  jsx: { language: javascript, name: 'javascript' },
  md: { language: markdown, name: 'markdown' },
  py: { language: python, name: 'python' },
  sh: { language: shell, name: 'bash' },
  sql: { language: sql, name: 'sql' },
  ts: { language: typescript, name: 'typescript' },
  tsx: { language: typescript, name: 'typescript' },
  yaml: { language: yaml, name: 'yaml' },
  yml: { language: yaml, name: 'yaml' },
  // Fence info strings in chat Markdown name the language rather than an extension (spec 043).
  javascript: { language: javascript, name: 'javascript' },
  markdown: { language: markdown, name: 'markdown' },
  python: { language: python, name: 'python' },
  shell: { language: shell, name: 'bash' },
  typescript: { language: typescript, name: 'typescript' },
  xml: { language: xml, name: 'xml' },
};

for (const { language, name } of Object.values(GRAMMARS)) {
  hljs.registerLanguage(name, language as Parameters<typeof hljs.registerLanguage>[1]);
}

/** The lowercased extension of a path, or `''` for a name with no dot after its last slash. */
function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');

  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/**
 * The file's text as highlight.js HTML, or `null` when no grammar is registered for its extension.
 *
 * The returned HTML is safe to inject: highlight.js escapes `<`, `>` and `&` in the source text
 * itself, so nothing a file contains can become markup. Callers must not build the same HTML by
 * any other route.
 */
export function highlight(path: string, text: string): string | null {
  const grammar = GRAMMARS[extensionOf(path)];

  if (!grammar) return null;

  return hljs.highlight(text, { ignoreIllegals: true, language: grammar.name }).value;
}
