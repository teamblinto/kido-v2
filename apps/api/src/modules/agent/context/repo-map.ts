/**
 * The repository map (research R3): an indented tree, one line per file, sorted so the same
 * paths and exports render byte-identically in any input order. Source files carry
 * `  · exports: a, b`. Over budget, the deepest (then largest) directory collapses to
 * `dir/ (n files)` until it fits, and the map ends with `[trimmed]`. Pure; no I/O.
 */
import { MAP_BUDGET_BYTES } from '../agent.constants';
import { DEFAULT_DAYTONA_TIMINGS } from '../../sandbox/sandbox.constants';

export const EMPTY_MAP_NOTICE = '(no files in the workspace)';
const TRIMMED = '[trimmed]';

interface Dir {
  readonly dirs: Map<string, Dir>;
  readonly files: Map<string, string[]>;
  collapsed: boolean;
}

const dir = (): Dir => ({ dirs: new Map(), files: new Map(), collapsed: false });

export function renderMap(
  files: { path: string; exports: string[] }[],
  budget = MAP_BUDGET_BYTES,
): string {
  const root = dir();
  for (const f of files) {
    const path = f.path.replace(/^\.?\//, '');
    if (DEFAULT_DAYTONA_TIMINGS.searchExcludes.some((x) => path.startsWith(x))) continue;
    const parts = path.split('/');
    let cur = root;
    for (const part of parts.slice(0, -1)) {
      let next = cur.dirs.get(part);
      if (!next) cur.dirs.set(part, (next = dir()));
      cur = next;
    }
    cur.files.set(parts[parts.length - 1] ?? '', [...new Set(f.exports)].sort());
  }
  if (root.dirs.size === 0 && root.files.size === 0) return EMPTY_MAP_NOTICE;

  let out = render(root, 0).join('\n');
  if (Buffer.byteLength(out) <= budget) return out;
  // ponytail: re-render after each collapse, O(dirs × files); fine at map scale.
  for (;;) {
    const victim = deepestLargest(root, 0, [0, undefined, 0, ''])[1];
    if (!victim) break;
    victim.collapsed = true;
    out = `${render(root, 0).join('\n')}\n${TRIMMED}`;
    if (Buffer.byteLength(out) <= budget) break;
  }
  return out;
}

const sorted = <V>(m: Map<string, V>) =>
  [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

function render(d: Dir, depth: number): string[] {
  const pad = '  '.repeat(depth);
  const lines: string[] = [];
  for (const [name, exports] of sorted(d.files)) {
    lines.push(
      exports.length ? `${pad}${name}  · exports: ${exports.join(', ')}` : `${pad}${name}`,
    );
  }
  for (const [name, sub] of sorted(d.dirs)) {
    if (sub.collapsed) lines.push(`${pad}${name}/ (${count(sub)} files)`);
    else lines.push(`${pad}${name}/`, ...render(sub, depth + 1));
  }
  return lines;
}

function count(d: Dir): number {
  let n = d.files.size;
  for (const sub of d.dirs.values()) n += count(sub);
  return n;
}

/** Deepest not-yet-collapsed directory, ties broken by file count then by name. */
function deepestLargest(
  d: Dir,
  depth: number,
  best: [number, Dir | undefined, number, string],
): [number, Dir | undefined, number, string] {
  for (const [name, sub] of sorted(d.dirs)) {
    if (sub.collapsed) continue;
    const n = count(sub);
    if (depth + 1 > best[0] || (depth + 1 === best[0] && n > best[2]))
      best = [depth + 1, sub, n, name];
    best = deepestLargest(sub, depth + 1, best);
  }
  return best;
}
