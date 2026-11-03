/**
 * Exported names of a TS/JS source, by regex (research R3 — no parser).
 *
 * Covers `export default X`, `export [async] function`, `export [abstract] class`,
 * `export const|let|var`, `export interface|type`, `export [const] enum`, and the
 * `export [type] { a, b as c }` list. Pure; never throws; unparseable content answers [].
 */

const DECLARATION =
  /\bexport\s+(?:default\s+|(?:async\s+)?function\s*\*?\s*|abstract\s+class\s+|class\s+|const\s+enum\s+|enum\s+|const\s+|let\s+|var\s+|interface\s+|type\s+)([A-Za-z_$][\w$]*)/g;
const LIST = /\bexport\s+(?:type\s+)?\{([^}]*)\}/g;

export function exportedNames(source: string): string[] {
  if (typeof source !== 'string' || source === '') return [];
  const names = new Set<string>();
  for (const m of source.matchAll(DECLARATION)) if (m[1]) names.add(m[1]);
  for (const m of source.matchAll(LIST)) {
    for (const entry of (m[1] ?? '').split(',')) {
      const name = entry
        .trim()
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  return [...names].sort();
}
