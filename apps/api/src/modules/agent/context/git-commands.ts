/**
 * The git surface of 021's map (research R2, R3), in the `checkpoints/git-commands.ts` idiom:
 * one string `checkCommand` admits, one parser per exec's output. Nothing here touches the port.
 */
import { createHash } from 'node:crypto';

/** The files the project owns: tracked plus untracked, less what `.gitignore` excludes (R3). */
export const gitLsFiles = (): string => 'git ls-files --cached --others --exclude-standard';

const ESCAPE = /\\(?:([0-7]{3})|(.))/g;
const CONTROL: Record<string, string> = { n: '\n', t: '\t' };

/** git's C-style quoting: `"…"` around a path with a special or non-ASCII byte, each such byte as `\ooo`. */
const unquote = (line: string): string => {
  if (!line.startsWith('"') || !line.endsWith('"')) return line;
  const bytes = line
    .slice(1, -1)
    .replace(ESCAPE, (_, oct: string | undefined, ch: string) =>
      oct === undefined ? (CONTROL[ch] ?? ch) : String.fromCharCode(parseInt(oct, 8)),
    );
  return Buffer.from(bytes, 'latin1').toString('utf8');
};

/** `ls-files`: one path per line, quoted when needed; sorted for a deterministic map. */
export const parseLsFiles = (output: string): string[] =>
  output
    .split('\n')
    .filter((line) => line !== '')
    .map(unquote)
    .sort();

/** `status --porcelain` as a tree-state fingerprint: sha-256 over its sorted lines (R2). */
export const porcelainDigest = (output: string): string =>
  createHash('sha256')
    .update(
      output
        .split('\n')
        .filter((line) => line !== '')
        .sort()
        .map((line) => `${line}\n`)
        .join(''),
    )
    .digest('hex');
