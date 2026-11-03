import { describe, expect, it } from 'vitest';

import {
  STREAM_HEARTBEAT,
  STREAM_RETRY_MS,
  lastEventIdSchema,
  streamEventSchema,
  streamResetEventSchema,
} from './stream';

const RUN = '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5a';
const PROJECT = '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5b';
const USER = '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5c';
const AT = '2026-09-14T10:00:00.000Z';

const run = {
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cancelRequestedAt: null,
  contextSkips: [],
  createdAt: AT,
  endedAt: null,
  failureClass: null,
  id: RUN,
  inputTokens: 0,
  lastSeq: 3,
  model: 'fake',
  outputTokens: 0,
  projectId: PROJECT,
  promptExcerpt: 'build it',
  startedAt: AT,
  status: 'running',
  userId: USER,
};

const state = { at: AT, data: { from: null, to: 'queued' }, run: RUN, seq: 1, type: 'state' };

describe('stream constants', () => {
  it('opens with retry 2000 and heartbeats as a comment', () => {
    expect(STREAM_RETRY_MS).toBe(2_000);
    expect(STREAM_HEARTBEAT).toBe(':heartbeat');
  });
});

describe('lastEventIdSchema', () => {
  it('coerces the header to a non-negative integer', () => {
    expect(lastEventIdSchema.parse('0')).toBe(0);
    expect(lastEventIdSchema.parse('17')).toBe(17);
    expect(lastEventIdSchema.safeParse('abc').success).toBe(false);
    expect(lastEventIdSchema.safeParse('-1').success).toBe(false);
    expect(lastEventIdSchema.safeParse('1.5').success).toBe(false);
  });
});

describe('streamResetEventSchema', () => {
  const reset = { at: AT, data: { events: [state], run }, run: RUN, seq: 1, type: 'stream.reset' };

  it('accepts the run response and durable events, and an empty snapshot at seq 0', () => {
    expect(streamResetEventSchema.safeParse(reset)).toMatchObject({ success: true });
    expect(
      streamResetEventSchema.safeParse({ ...reset, data: { events: [], run }, seq: 0 }),
    ).toMatchObject({ success: true });
  });

  it('refuses a non-durable event in the snapshot and an undeclared key', () => {
    const token = { at: AT, data: { text: 'x' }, run: RUN, seq: 1, type: 'token' };

    expect(
      streamResetEventSchema.safeParse({ ...reset, data: { events: [token], run } }).success,
    ).toBe(false);
    expect(streamResetEventSchema.safeParse({ ...reset, extra: 1 }).success).toBe(false);
  });
});

describe('streamEventSchema', () => {
  it('parses a run event and a reset alike', () => {
    expect(streamEventSchema.safeParse(state)).toMatchObject({ success: true });
    expect(
      streamEventSchema.safeParse({
        at: AT,
        data: { events: [], run },
        run: RUN,
        seq: 3,
        type: 'stream.reset',
      }),
    ).toMatchObject({ success: true });
    expect(streamEventSchema.safeParse({ ...state, type: 'bogus' }).success).toBe(false);
  });
});
