import type { RunEvent } from '@repo/contracts';
import { describe, expect, it } from 'vitest';

import type { TranscriptItem } from './transcript';
import { activityLines, changedPaths, previewUrl } from './stage';

const RUN = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';

function items(...events: RunEvent[]): TranscriptItem[] {
  return events.map((event, index) => ({ event, id: `i-${String(index)}` }));
}

function patch(seq: number, path: string): RunEvent {
  return {
    at: '2026-01-01T00:00:00.000Z',
    data: { diff: '--- a', path },
    run: RUN,
    seq,
    type: 'file.patch',
  };
}

function preview(seq: number, url: string): RunEvent {
  return { at: '2026-01-01T00:00:00.000Z', data: { url }, run: RUN, seq, type: 'preview.ready' };
}

describe('changedPaths', () => {
  it('names each changed file once, newest first', () => {
    // A run patches the same file repeatedly; "what changed" is the distinct set, and what was
    // just touched leads.
    const paths = changedPaths(
      items(patch(1, 'src/a.ts'), patch(2, 'src/b.ts'), patch(3, 'src/a.ts')),
    );

    expect(paths).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('is empty for a run that has changed nothing', () => {
    expect(changedPaths(items(preview(1, 'https://x.test')))).toEqual([]);
  });
});

describe('previewUrl', () => {
  it('takes the most recent preview the run announced', () => {
    // A rebuild announces a new one; showing the first would leave a person looking at a preview
    // the run has already replaced.
    const url = previewUrl(items(preview(1, 'https://one.test'), preview(2, 'https://two.test')));

    expect(url).toBe('https://two.test');
  });

  it('is undefined until the run has announced one', () => {
    expect(previewUrl(items(patch(1, 'src/a.ts')))).toBeUndefined();
  });
});

describe('activityLines', () => {
  const delta: RunEvent = {
    at: '2026-01-01T00:00:00.000Z',
    data: { chunk: 'installed recharts\n\nbuilt in 1.4s', stepId: 's1' },
    run: RUN,
    seq: 1,
    type: 'tool.delta',
  };

  const failed: RunEvent = {
    at: '2026-01-01T00:00:00.000Z',
    data: { error: "'rows' is not defined", ok: false, stepId: 's1' },
    run: RUN,
    seq: 2,
    type: 'tool.end',
  };

  it('shows what the tools wrote, a line at a time', () => {
    const lines = activityLines(items(delta));

    // The blank line between them is dropped: it is whitespace in a stream, not an entry.
    expect(lines.map((line) => line.message)).toEqual(['installed recharts', 'built in 1.4s']);
    expect(lines.every((line) => !line.isProblem)).toBe(true);
  });

  it("marks a failed tool's own words as a problem", () => {
    // The classification is the run's — `ok: false` — rather than a guess made from the text.
    const lines = activityLines(items(delta, failed));

    expect(lines.at(-1)).toMatchObject({ isProblem: true, message: "'rows' is not defined" });
  });

  it('is empty for a run that has run no tools', () => {
    expect(activityLines(items(patch(1, 'src/a.ts')))).toEqual([]);
  });
});
