/**
 * A unified diff in the shape `git diff --no-index` prints (spec 010, research R6): the `---`/`+++`
 * header, `@@ -a,b +c,d @@` hunks with three lines of context, and git's `\ No newline at end of
 * file` marker. In-module because `apps/api` has no diff library and one is not worth a dependency
 * for the four shapes `EditResult.diff` needs.
 */
const CONTEXT = 3;

interface Op {
  readonly line: string;
  readonly tag: ' ' | '-' | '+';
}

/** Lines with their newline kept, so a final line without one is its own token and diffs as git does. */
function tokens(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/**
 * The edit script between two line lists by longest common subsequence, deletions before
 * insertions at every fork, which is the order git prints.
 *
 * ponytail: O(n·m) table. The caller has already stripped the common prefix and suffix, which is
 * all a single-anchor edit ever leaves, so this only sees the changed middle; switch to Myers if a
 * full-file rewrite of 2 MiB ever makes it slow.
 */
function script(a: readonly string[], b: readonly string[]): Op[] {
  const lcs: Uint32Array[] = Array.from(
    { length: a.length + 1 },
    () => new Uint32Array(b.length + 1),
  );

  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;

  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push({ line: a[i]!, tag: ' ' });
      i++;
      j++;
    } else if (j >= b.length || (i < a.length && lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      ops.push({ line: a[i]!, tag: '-' });
      i++;
    } else {
      ops.push({ line: b[j]!, tag: '+' });
      j++;
    }
  }

  return ops;
}

const range = (start: number, count: number): string =>
  count === 1 ? String(start) : `${String(start)},${String(count)}`;

const render = (op: Op): string =>
  op.line.endsWith('\n')
    ? `${op.tag}${op.line}`
    : `${op.tag}${op.line}\n\\ No newline at end of file\n`;

/** Changes closer than `2 * CONTEXT` share a hunk, exactly as git merges them. */
function hunks(ops: readonly Op[]): string {
  const changes = ops.flatMap((op, index) => (op.tag === ' ' ? [] : [index]));
  const groups: [number, number][] = [];

  for (const change of changes) {
    const last = groups.at(-1);
    if (last !== undefined && change - last[1] - 1 <= 2 * CONTEXT) last[1] = change;
    else groups.push([change, change]);
  }

  // Old and new line counts consumed before each op, for the hunk headers.
  const oldAt: number[] = [];
  const newAt: number[] = [];
  let oldLines = 0;
  let newLines = 0;
  for (const op of ops) {
    oldAt.push(oldLines);
    newAt.push(newLines);
    if (op.tag !== '+') oldLines++;
    if (op.tag !== '-') newLines++;
  }

  return groups
    .map(([first, last]) => {
      const from = Math.max(0, first - CONTEXT);
      const to = Math.min(ops.length, last + CONTEXT + 1);
      const slice = ops.slice(from, to);
      const oldCount = slice.filter((op) => op.tag !== '+').length;
      const newCount = slice.filter((op) => op.tag !== '-').length;
      const header = `@@ -${range(oldCount === 0 ? oldAt[from]! : oldAt[from]! + 1, oldCount)} +${range(
        newCount === 0 ? newAt[from]! : newAt[from]! + 1,
        newCount,
      )} @@\n`;

      return header + slice.map(render).join('');
    })
    .join('');
}

/**
 * `before` is `null` for a file that did not exist, which is the `--- /dev/null` header; an empty
 * string is an existing empty file. Returns `''` when the two are identical.
 */
export function unifiedDiff(before: string | null, after: string, path: string): string {
  const a = tokens(before ?? '');
  const b = tokens(after);

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }

  const context = (line: string): Op => ({ line, tag: ' ' });
  const ops: Op[] = [
    ...a.slice(0, head).map(context),
    ...script(a.slice(head, a.length - tail), b.slice(head, b.length - tail)),
    ...a.slice(a.length - tail).map(context),
  ];

  if (ops.every((op) => op.tag === ' ')) return '';

  return `--- ${before === null ? '/dev/null' : `a/${path}`}\n+++ b/${path}\n${hunks(ops)}`;
}
