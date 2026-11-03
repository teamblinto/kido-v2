import type { RunEvent } from '@repo/contracts';
import { describe, expect, it } from 'vitest';

import { splitMarkdownBlocks } from './markdown-blocks';
import { buildTimeline, formatDuration, workSummary } from './timeline';
import { type TranscriptItem, joinTokens } from './transcript';

const RUN = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';
const AT = '2026-08-18T10:00:00.000Z';

let next = 0;

function item(event: Omit<RunEvent, 'at' | 'run'>): TranscriptItem {
  next += 1;

  return { event: { at: AT, run: RUN, ...event } as RunEvent, id: `i-${String(next)}` };
}

const token = (seq: number, text: string) => item({ data: { text }, seq, type: 'token' });
const start = (seq: number, stepId: string, tool: string) =>
  item({ data: { input: {}, stepId, tool }, seq, type: 'tool.start' });
const end = (seq: number, stepId: string, ok: boolean) =>
  item({
    data: { ok, stepId, ...(ok ? {} : { error: 'exit 1' }) },
    seq,
    type: 'tool.end',
  });
const patch = (seq: number, path: string) =>
  item({ data: { diff: '--- a', path }, seq, type: 'file.patch' });

describe('the chat timeline (spec 043)', () => {
  it('joins consecutive tokens into one growing message that keeps the first id', () => {
    const first = token(1, 'Adding ');
    const joined = joinTokens([
      first,
      token(1, 'the swap '),
      token(1, 'button.'),
      patch(2, 'a.ts'),
    ]);

    expect(joined).toHaveLength(2);
    expect(joined[0]?.id).toBe(first.id);
    expect(joined[0]?.event).toMatchObject({ data: { text: 'Adding the swap button.' } });
  });

  it('groups consecutive tool calls and file changes, and lets text break the group', () => {
    const rows = buildTimeline([
      start(1, 's1', 'edit_file'),
      patch(2, 'src/a.ts'),
      end(3, 's1', true),
      start(4, 's2', 'run pnpm test'),
      end(5, 's2', false),
      token(5, 'Done.'),
      start(6, 's3', 'run pnpm lint'),
    ]);

    expect(rows.map((row) => row.kind)).toEqual(['work', 'assistant', 'work']);
    const [group] = rows;
    expect(group?.kind === 'work' ? group.entries.map((entry) => entry.kind) : []).toEqual([
      'tool',
      'patch',
      'tool',
    ]);
    expect(group?.kind === 'work' ? group.entries[2] : undefined).toMatchObject({
      detail: 'exit 1',
      status: 'failed',
    });
    expect(rows[2]?.kind === 'work' ? rows[2].entries[0] : undefined).toMatchObject({
      status: 'running',
    });
  });

  it('summarises a group by what it did', () => {
    const rows = buildTimeline([
      start(1, 's1', 'edit_file'),
      patch(1, 'src/a.ts'),
      patch(1, 'src/b.ts'),
      patch(1, 'src/a.ts'),
      start(2, 's2', 'run pnpm test'),
      start(3, 's3', 'run pnpm lint'),
      start(4, 's4', 'bash ls'),
    ]);

    expect(rows[0]?.kind === 'work' ? workSummary(rows[0].entries) : '').toBe(
      'Edited 2 files · ran 3 commands',
    );
  });

  it("places the person's messages where they were sent", () => {
    const rows = buildTimeline(
      [token(1, 'What colour?'), patch(2, 'a.ts')],
      [
        { at: 0, id: 'u-1', text: 'Build a rota' },
        { at: 1, id: 'u-2', text: 'Teal' },
        { at: Number.POSITIVE_INFINITY, id: 'u-3', text: 'And a footer' },
      ],
    );

    expect(rows.map((row) => row.id)).toEqual(['u-1', rows[1]?.id, 'u-2', rows[3]?.id, 'u-3']);
    expect(rows.map((row) => row.kind)).toEqual(['user', 'assistant', 'user', 'work', 'user']);
  });

  it('says how long a turn worked', () => {
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(80_000)).toBe('1m 20s');
    expect(formatDuration(2 * 3_600_000 + 5 * 60_000)).toBe('2h 5m');
  });

  it('cuts streamed Markdown at blank lines, never inside a fence or a list', () => {
    expect(
      splitMarkdownBlocks('One.\n\nTwo.\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n'),
    ).toEqual(['One.\n\n', 'Two.\n\n', '```ts\nconst a = 1;\n\nconst b = 2;\n```\n']);
    expect(splitMarkdownBlocks('- a\n\n- b\n')).toEqual(['- a\n\n- b\n']);
    expect(splitMarkdownBlocks('See [x].\n\n[x]: https://a.test\n')).toHaveLength(1);
  });
});
