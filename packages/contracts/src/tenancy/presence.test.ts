import { describe, expect, it } from 'vitest';

import {
  presenceHeartbeatRequestSchema,
  presenceLocationSchema,
  presenceResponseSchema,
} from './presence';

const ID = '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5a';

describe('presenceLocationSchema', () => {
  it.each([
    { view: 'preview' },
    { view: 'code' },
    { path: 'src/app.tsx', view: 'code' },
    { view: 'history' },
    { runId: ID, view: 'run' },
  ])('accepts %j', (location) => {
    expect(presenceLocationSchema.parse(location)).toEqual(location);
  });

  it.each(['../etc/passwd', 'src/../../x', '..', '/etc/passwd'])('refuses the path %s', (path) => {
    expect(presenceLocationSchema.safeParse({ path, view: 'code' }).success).toBe(false);
  });

  it('refuses an unknown view', () => {
    expect(presenceLocationSchema.safeParse({ view: 'settings' }).success).toBe(false);
  });

  it('refuses an extra key', () => {
    expect(presenceLocationSchema.safeParse({ path: 'x', view: 'preview' }).success).toBe(false);
    expect(presenceLocationSchema.safeParse({ runId: ID, title: 'x', view: 'run' }).success).toBe(
      false,
    );
  });
});

describe('presenceHeartbeatRequestSchema', () => {
  it('carries a location and nothing else', () => {
    expect(presenceHeartbeatRequestSchema.parse({ location: { view: 'preview' } })).toEqual({
      location: { view: 'preview' },
    });
    expect(
      presenceHeartbeatRequestSchema.safeParse({ location: { view: 'preview' }, userId: ID })
        .success,
    ).toBe(false);
  });
});

describe('presenceResponseSchema', () => {
  it('accepts people and the unavailable answer', () => {
    const body = {
      available: true,
      people: [
        {
          email: 'a@example.com',
          location: { view: 'history' },
          seenAt: '2026-09-23T10:00:00.000Z',
          userId: ID,
        },
      ],
    };

    expect(presenceResponseSchema.parse(body)).toEqual(body);
    expect(presenceResponseSchema.parse({ available: false, people: [] })).toEqual({
      available: false,
      people: [],
    });
    expect(presenceResponseSchema.safeParse({ ...body, extra: 1 }).success).toBe(false);
  });
});
