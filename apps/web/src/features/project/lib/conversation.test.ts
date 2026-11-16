import type { RunEvent, RunMessage } from '@repo/contracts';
import { describe, expect, it } from 'vitest';

import { recordedTurns } from './conversation';
import type { TranscriptItem } from './transcript';

const RUN = '00000000-0000-4000-8000-000000000001';
const OLDER = '00000000-0000-4000-8000-000000000002';
const NEWER = '00000000-0000-4000-8000-000000000003';

const at = (second: number): string => `2026-11-06T00:00:${String(second).padStart(2, '0')}.000Z`;

function message(
  id: string,
  role: RunMessage['role'],
  second: number,
  content: string,
  runId = RUN,
): RunMessage {
  return { at: at(second), attachments: [], content, id, role, runId };
}

function item(id: string, second: number, type: 'token' | 'usage' = 'usage'): TranscriptItem {
  const data =
    type === 'token' ? { text: 'hi' } : { costMicros: 0, inputTokens: 0, outputTokens: 0 };

  return { event: { at: at(second), data, run: RUN, seq: 1, type } as RunEvent, id };
}

describe('recordedTurns', () => {
  it('puts back a reopened run’s follow-ups and replies, in place among its events', () => {
    const turns = recordedTurns(
      [
        message('a', 'user', 1, 'first'),
        message('b', 'assistant', 5, 'done'),
        message('c', 'user', 8, 'again'),
        message('d', 'assistant', 12, 'done again'),
      ],
      RUN,
      [item('e1', 3), item('e2', 6), item('e3', 10)],
      [],
    );

    expect(turns.map(({ at: place, role, text }) => [place, role, text])).toEqual([
      [0, undefined, 'first'],
      [1, 'assistant', 'done'],
      [2, undefined, 'again'],
      [3, 'assistant', 'done again'],
    ]);
  });

  it('leads with what earlier runs said, and leaves out a newer run', () => {
    const turns = recordedTurns(
      [
        message('a', 'user', 1, 'old prompt', OLDER),
        message('b', 'assistant', 2, 'old reply', OLDER),
        message('c', 'user', 3, 'this run'),
        message('d', 'user', 9, 'later run', NEWER),
      ],
      RUN,
      [],
      [],
    );

    expect(turns.map(({ at: place, text }) => [place, text])).toEqual([
      [-1, 'old prompt'],
      [-1, 'old reply'],
      [0, 'this run'],
    ]);
  });

  it('skips a message sent from this screen, once each', () => {
    const turns = recordedTurns(
      [message('a', 'user', 1, 'fix it'), message('b', 'user', 5, 'fix it')],
      RUN,
      [],
      [{ runId: RUN, text: 'fix it' }],
    );

    expect(turns.map(({ id }) => id)).toEqual(['m-a']);
  });

  it('skips a reply whose tokens streamed here, and only that turn’s', () => {
    const turns = recordedTurns(
      [
        message('a', 'user', 1, 'first'),
        message('b', 'assistant', 5, 'from an earlier session'),
        message('c', 'user', 6, 'second'),
        message('d', 'assistant', 10, 'streamed just now'),
      ],
      RUN,
      [item('t', 8, 'token')],
      [],
    );

    expect(turns.map(({ id }) => id)).toEqual(['m-a', 'm-b', 'm-c']);
  });
});
