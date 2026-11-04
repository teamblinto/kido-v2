import { scrubSecrets } from '../../common/telemetry/scrubber';

/**
 * The git surface of spec 016 as pure functions (research R1, R3, R5–R7): each step is one
 * string `checkCommand` admits — no `&&`, no `;`, no pipe — and each parser reads one exec's
 * output. Nothing here touches the port; the service sequences the calls.
 */

/** git's empty tree — the parent of the baseline's diff (R7). */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** A file's patch in `GET …/diff` is cut here (R7). */
export const DIFF_FILE_CAP_BYTES = 1024 * 1024;

const SHA = /^[0-9a-f]{40}$/;

/** What `checkCommand` refuses (`SHELL_OPERATOR`), plus the quote that closes `-m "…"` and the backslash that would escape it. */
const UNSAFE = /["\\;&|`$<>\n]/g;

const sha = (value: string): string => {
  if (!SHA.test(value)) throw new Error(`Not a git sha: ${value}`);
  return value;
};

/** A label that survives `-m "…"` on the daemon's bash: no quote, no operator, never empty. */
export const sanitiseLabel = (label: string): string =>
  label.replace(UNSAFE, '').trim() || 'Checkpoint';

/** A commit subject's conventional width (spec 044 decision 6). */
const SUBJECT_CHARS = 72;

/**
 * Spec 044 decision 6: a turn's commit subject from the run's prompt, ` (turn n)` inside the width
 * past the first, `Turn n` when nothing usable is left. It runs before a commit and a message must
 * never block one, so whatever goes wrong here is the fallback.
 */
export const turnLabel = (summary: string | null | undefined, turn: number): string => {
  const fallback = `Turn ${String(turn)}`;

  try {
    const first = summary?.split(/\r?\n/).find((line) => line.trim() !== '') ?? '';
    const scrubbed = scrubSecrets(first).replace(/[\p{Cc}\s]+/gu, ' ');

    if (scrubbed.replace(UNSAFE, '').trim() === '') return fallback;

    const line = sanitiseLabel(scrubbed).replace(/ +/g, ' ');
    const suffix = turn > 1 ? ` (turn ${String(turn)})` : '';
    const room = SUBJECT_CHARS - suffix.length;

    if (line.length <= room) return `${line}${suffix}`;

    const space = line.lastIndexOf(' ', room);

    return `${line.slice(0, space > 0 ? space : room).trimEnd()}${suffix}`;
  } catch {
    return fallback;
  }
};

/** Spec 044 decision 8: `status --porcelain` as a subject, `Update a.ts, b.ts and 2 more`. */
export const filesLabel = (status: string): string => {
  const names = status
    .split('\n')
    .filter((line) => line.trim() !== '')
    // `XY path`, `R  old -> new`; a directory of untracked files ends in a slash.
    .map((line) =>
      line
        .replace(/^\s*\S+\s+/, '')
        .split(' -> ')
        .at(-1)!,
    )
    .map((path) => path.replace(/^"|"$/g, '').replace(/\/$/, '').split('/').at(-1)!);
  const [first, second] = names;

  if (names.length === 1) return `Update ${first!}`;
  if (names.length === 2) return `Update ${first!} and ${second!}`;

  return `Update ${first!}, ${second!} and ${String(names.length - 2)} more`;
};

export const gitInit = (): string => 'git init -q';
export const gitAdd = (): string => 'git add -A';
export const gitCommit = (label: string): string =>
  `git -c user.name=forge -c user.email=forge@forge.local commit -q -m "${sanitiseLabel(label)}"`;
export const gitRevParse = (): string => 'git rev-parse HEAD';
export const gitGitDir = (): string => 'git rev-parse --git-dir';
export const gitStatus = (): string => 'git status --porcelain';
export const gitDiffTree = (parent: string | null, head: string): string =>
  `git diff-tree --name-status -r -M ${sha(parent ?? EMPTY_TREE)} ${sha(head)}`;
export const gitDiff = (parent: string | null, head: string): string =>
  `git diff ${sha(parent ?? EMPTY_TREE)} ${sha(head)}`;
export const gitDiffQuiet = (a: string, b: string): string =>
  `git diff --quiet ${sha(a)} ${sha(b)}`;
export const gitReadTree = (target: string): string => `git read-tree -u --reset ${sha(target)}`;
export const gitBundle = (): string => 'git bundle create .git/forge-mirror.bundle --all';
export const gitLsTree = (tree: string): string => `git ls-tree -r -l ${sha(tree)}`;

/** A path under `.git/` with no space, quote or operator — the only place a pull's upload lands (018 R6). */
const GIT_DIR_PATH = /^\.git\/[\w./-]+$/;
const gitDirPath = (path: string): string => {
  if (!GIT_DIR_PATH.test(path) || path.includes('..')) throw new Error(`Not a .git path: ${path}`);
  return path;
};

// The pull's in-sandbox steps (018 R6): fetch the uploaded bundle, fast-forward onto it, list
// the new commits oldest first, name each by its subject, and drop the bundle.
export const gitFetchBundle = (path: string): string => `git fetch -q ${gitDirPath(path)}`;
export const gitMergeFfOnly = (): string => 'git merge -q --ff-only FETCH_HEAD';
export const gitRevList = (from: string, to: string): string =>
  `git rev-list --reverse ${sha(from)}..${sha(to)}`;
export const gitLogSubject = (commit: string): string => `git log -1 --format=%s ${sha(commit)}`;
export const gitRemoveFile = (path: string): string => `rm -f ${gitDirPath(path)}`;

/** `rev-parse HEAD` printed a sha, or it printed an error. */
export const parseSha = (output: string): string => sha(output.trim());

/** `status --porcelain` prints nothing for a clean tree. */
export const isClean = (output: string): boolean => output.trim() === '';

export type FileStatus = 'A' | 'M' | 'D' | 'R';

export interface NameStatusFile {
  readonly path: string;
  readonly status: FileStatus;
}

/** The first letter of a `--name-status` line; a type change is a modification, a rename carries a score. */
const statusOf = (letter: string): FileStatus => {
  if (letter === 'A' || letter === 'M' || letter === 'D' || letter === 'R') return letter;
  if (letter === 'T') return 'M';
  throw new Error(`Unknown name-status: ${letter}`);
};

/** `diff-tree --name-status -r`: `A\tpath`, `R087\told\tnew` — the new path is the file's. */
export const parseNameStatus = (output: string): NameStatusFile[] =>
  output
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const parts = line.split('\t');
      return { path: parts[parts.length - 1]!, status: statusOf(parts[0]!.charAt(0)) };
    });

export type DiffFile =
  | {
      readonly binary: false;
      readonly path: string;
      readonly patch: string;
      readonly status: FileStatus;
      readonly truncated: boolean;
    }
  | { readonly binary: true; readonly path: string; readonly status: FileStatus };

/**
 * `git diff <a> <b>` split at each `diff --git` header: the `b/` path names the file, the
 * extended headers give its status, a `Binary files … differ` line marks it binary, and a
 * text patch over the cap is cut. ponytail: the cut is by byte, so a multibyte character at the
 * edge may end as U+FFFD; the patch is display-only.
 */
export const splitDiff = (output: string): DiffFile[] => {
  const chunks = output.split(/^(?=diff --git )/m).filter((chunk) => chunk !== '');
  return chunks.map((chunk) => {
    const lines = chunk.split('\n');
    const path = lines[0]!.replace(/^diff --git a\/.* b\//, '');
    const status: FileStatus = lines.some((line) => line.startsWith('new file mode'))
      ? 'A'
      : lines.some((line) => line.startsWith('deleted file mode'))
        ? 'D'
        : lines.some((line) => line.startsWith('rename to '))
          ? 'R'
          : 'M';
    if (lines.some((line) => line.startsWith('Binary files ') || line === 'GIT binary patch')) {
      return { binary: true, path, status };
    }
    const bytes = Buffer.from(chunk, 'utf8');
    const truncated = bytes.length > DIFF_FILE_CAP_BYTES;
    return {
      binary: false,
      path,
      patch: truncated ? bytes.subarray(0, DIFF_FILE_CAP_BYTES).toString('utf8') : chunk,
      status,
      truncated,
    };
  });
};

/**
 * `ls-tree -r -l <sha>`: `<mode> <type> <sha> <size>\t<path>` — a blob's size in bytes by path;
 * a non-blob (a submodule commit) prints `-` and is skipped. The service joins it with
 * `parseNameStatus` for `files[].bytes` (a deletion is 0).
 */
export const parseLsTree = (output: string): Map<string, number> => {
  const sizes = new Map<string, number>();
  for (const line of output.split('\n')) {
    const match = /^\S+ blob \S+ +(\d+)\t(.+)$/.exec(line);
    if (match) sizes.set(match[2]!, Number(match[1]));
  }
  return sizes;
};
