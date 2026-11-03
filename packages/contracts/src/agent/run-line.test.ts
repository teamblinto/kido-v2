import { describe, expect, it } from 'vitest';

import {
  RUN_LINE_LIMIT,
  runLineConflictReasonSchema,
  runLineEntrySchema,
  runLineResponseSchema,
} from './run-line';

const USER = { email: 'a@example.com', userId: '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5a' };
const entry = (position: number) => ({
  createdAt: '2026-09-23T10:00:00.000Z',
  position,
  runId: '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5b',
  startedBy: USER,
});
const HOLDER = {
  runId: '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5c',
  startedBy: USER,
  status: 'running',
};

describe('runLineEntrySchema', () => {
  it('accepts a waiting run at the head of the line', () => {
    expect(runLineEntrySchema.parse(entry(1))).toEqual(entry(1));
  });

  it('refuses position 0 and an undeclared key', () => {
    expect(runLineEntrySchema.safeParse(entry(0)).success).toBe(false);
    expect(runLineEntrySchema.safeParse({ ...entry(1), prompt: 'x' }).success).toBe(false);
    expect(
      runLineEntrySchema.safeParse({ ...entry(1), startedBy: { ...USER, name: 'A' } }).success,
    ).toBe(false);
  });
});

describe('runLineResponseSchema', () => {
  it('accepts a held line and an unheld one (holder null)', () => {
    const held = { holder: HOLDER, waiting: [entry(1)] };

    expect(runLineResponseSchema.parse(held)).toEqual(held);
    expect(runLineResponseSchema.parse({ holder: null, waiting: [] })).toEqual({
      holder: null,
      waiting: [],
    });
  });

  it('refuses an absent holder', () => {
    expect(runLineResponseSchema.safeParse({ waiting: [] }).success).toBe(false);
  });

  it(`holds at most RUN_LINE_LIMIT (${RUN_LINE_LIMIT}) waiting runs`, () => {
    const full = Array.from({ length: RUN_LINE_LIMIT }, (_, i) => entry(i + 1));

    expect(RUN_LINE_LIMIT).toBe(5);
    expect(runLineResponseSchema.safeParse({ holder: null, waiting: full }).success).toBe(true);
    expect(
      runLineResponseSchema.safeParse({ holder: null, waiting: [...full, entry(6)] }).success,
    ).toBe(false);
  });

  it('is strict', () => {
    expect(runLineResponseSchema.safeParse({ holder: null, total: 0, waiting: [] }).success).toBe(
      false,
    );
  });
});

describe('runLineConflictReasonSchema', () => {
  it('is queue-full only', () => {
    expect(runLineConflictReasonSchema.options).toEqual(['queue-full']);
  });
});
