import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

/**
 * The grep gate behind §09's one non-negotiable rule about tenant context.
 *
 * With PgBouncer in transaction mode the connection is handed to the next request the moment a
 * transaction commits, so a session-scoped setting outlives the request that set it. A plain
 * `SET` — or the same thing spelled `set_config(..., false)` — therefore leaks one tenant's
 * `app.org_id` into the next tenant's query, which is precisely the bug row-level security exists
 * to prevent. Only the transaction-scoped form is safe.
 *
 * This is a scanner rather than an ESLint rule because half the surface it has to cover is SQL:
 * the hand-written migrations under `packages/db/migrations` are not TypeScript and no lint rule
 * looks at them.
 */

export type PlainSetReason = 'session-scoped-set-config' | 'plain-set';

export interface PlainSetMatch {
  readonly column: number;
  readonly line: number;
  readonly reason: PlainSetReason;
  readonly statement: string;
}

export interface PlainSetFinding extends PlainSetMatch {
  readonly file: string;
}

/**
 * `SET app.org_id = …`, `SET SESSION app.org_id = …` — anything that writes an `app.*` setting
 * without `LOCAL`. `SET LOCAL` is the safe spelling and is deliberately not matched.
 *
 * The negative lookahead is what makes the rule narrow enough to be true: it flags the tenant
 * GUCs this codebase actually uses and leaves `offset`, `.set(`, `Set<T>` and `settings` alone,
 * none of which put a word boundary before `set` followed by whitespace.
 */
const PLAIN_SET = /\bset\s+(?!local\b)(?:session\s+)?"?app"?\s*\.\s*[a-z_]+/gi;

const SET_CONFIG_CALL = /\bset_config\s*\(/gi;

const SCANNED_EXTENSIONS = ['.sql', '.ts'];

const IGNORED_DIRECTORIES = new Set(['.turbo', 'dist', 'node_modules']);

/**
 * The scanner and its spec are the two files in the repository that contain a plain `SET` on
 * purpose — one as a regex, one as the fixtures that prove the regex fires. Excluding them by
 * name keeps the gate honest about everything else; neither file is compiled into the API.
 */
const IGNORED_FILES = new Set(['plain-set-scanner.ts', 'no-plain-set.spec.ts']);

function positionOf(source: string, index: number): { column: number; line: number } {
  const before = source.slice(0, index);
  const lines = before.split('\n');

  return { column: (lines.at(-1)?.length ?? 0) + 1, line: lines.length };
}

function closingParen(source: string, open: number): number {
  let depth = 0;

  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '(') {
      depth += 1;
    } else if (source[index] === ')') {
      depth -= 1;

      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function splitArguments(argumentList: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';

  for (const character of argumentList) {
    if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth -= 1;
    }

    if (character === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }

    current += character;
  }

  parts.push(current);

  return parts.map((part) => part.trim());
}

/** Every tenant-context hazard in one string of TypeScript or SQL. */
export function findPlainSetStatements(source: string): PlainSetMatch[] {
  const matches: PlainSetMatch[] = [];

  for (const match of source.matchAll(PLAIN_SET)) {
    matches.push({ ...positionOf(source, match.index), reason: 'plain-set', statement: match[0] });
  }

  for (const call of source.matchAll(SET_CONFIG_CALL)) {
    const open = call.index + call[0].length - 1;
    const close = closingParen(source, open);

    if (close === -1) {
      continue;
    }

    const args = splitArguments(source.slice(open + 1, close));

    // Two arguments is the session-scoped overload; three with anything but a literal `true`
    // is the same hazard spelled out. Only `set_config(name, value, true)` is transaction-scoped.
    if (args.length !== 3 || args[2] !== 'true') {
      matches.push({
        ...positionOf(source, call.index),
        reason: 'session-scoped-set-config',
        statement: source.slice(call.index, close + 1),
      });
    }
  }

  return matches.sort((a, b) => a.line - b.line || a.column - b.column);
}

async function* walk(directory: string): AsyncGenerator<string> {
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) {
        yield* walk(path);
      }

      continue;
    }

    if (IGNORED_FILES.has(entry.name)) {
      continue;
    }

    if (SCANNED_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
      yield path;
    }
  }
}

/** Every file the gate below reads, repository-relative and slash-separated. */
export async function collectScannedFiles(
  repositoryRoot: string,
  roots: readonly string[],
): Promise<string[]> {
  const files: string[] = [];

  for (const root of roots) {
    for await (const path of walk(join(repositoryRoot, root))) {
      files.push(relative(repositoryRoot, path).replaceAll('\\', '/'));
    }
  }

  return files.sort();
}

export async function scanForPlainSet(
  repositoryRoot: string,
  roots: readonly string[],
): Promise<PlainSetFinding[]> {
  const files = await collectScannedFiles(repositoryRoot, roots);
  const findings: PlainSetFinding[] = [];

  for (const file of files) {
    const source = await readFile(join(repositoryRoot, file), 'utf8');

    findings.push(...findPlainSetStatements(source).map((match) => ({ ...match, file })));
  }

  return findings;
}
