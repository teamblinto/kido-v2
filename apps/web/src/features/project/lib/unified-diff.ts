/*
 * The smallest unified-diff reader the checkpoint view needs: enough structure to colour each line
 * and print the two gutters. No intra-line diffing, no rendering — that lives with the component.
 */

export type DiffLineKind = 'add' | 'context' | 'remove';

export interface DiffLine {
  content: string;
  kind: DiffLineKind;
  /** null on a removed line, and on git's `\ No newline` note, which numbers neither side. */
  newLine: number | null;
  /** null on an added line, and on git's `\ No newline` note. */
  oldLine: number | null;
}

export interface Hunk {
  /** The `@@ … @@` line verbatim, trailing section heading and all. */
  header: string;
  lines: DiffLine[];
  newStart: number;
  oldStart: number;
}

const HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parseUnifiedDiff(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let hunk: Hunk | undefined;
  let oldLine = 0;
  let newLine = 0;

  for (const line of patch.split('\n')) {
    const header = HEADER.exec(line);

    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      hunk = { header: line, lines: [], newStart: newLine, oldStart: oldLine };
      hunks.push(hunk);
      continue;
    }

    // Everything before the first `@@` is git's file header, and is not ours to show.
    if (!hunk) continue;

    if (line.startsWith('\\')) {
      hunk.lines.push({ content: line, kind: 'context', newLine: null, oldLine: null });
    } else if (line.startsWith('+')) {
      hunk.lines.push({ content: line.slice(1), kind: 'add', newLine: newLine++, oldLine: null });
    } else if (line.startsWith('-')) {
      hunk.lines.push({
        content: line.slice(1),
        kind: 'remove',
        newLine: null,
        oldLine: oldLine++,
      });
    } else if (line.startsWith(' ')) {
      hunk.lines.push({
        content: line.slice(1),
        kind: 'context',
        newLine: newLine++,
        oldLine: oldLine++,
      });
    }
  }

  return hunks;
}
