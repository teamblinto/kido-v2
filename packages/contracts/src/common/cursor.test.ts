import { describe, expect, it } from 'vitest';

import {
  CURSOR_MAX_LENGTH,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  cursorPageQuerySchema,
  cursorSchema,
} from './cursor';

describe('cursorSchema', () => {
  it('accepts base64url and nothing that would need escaping', () => {
    expect(cursorSchema.parse('eyJpZCI6IjAxSFgifQ-_')).toBe('eyJpZCI6IjAxSFgifQ-_');
    expect(cursorSchema.safeParse('eyJpZCI6IjAxSFgifQ==').success).toBe(false);
    expect(cursorSchema.safeParse('a/b').success).toBe(false);
    expect(cursorSchema.safeParse('a b').success).toBe(false);
    expect(cursorSchema.safeParse('').success).toBe(false);
  });

  it('bounds the token', () => {
    expect(cursorSchema.safeParse('a'.repeat(CURSOR_MAX_LENGTH)).success).toBe(true);
    expect(cursorSchema.safeParse('a'.repeat(CURSOR_MAX_LENGTH + 1)).success).toBe(false);
  });
});

describe('cursorPageQuerySchema', () => {
  it('defaults the page size when the caller does not ask for one', () => {
    expect(cursorPageQuerySchema.parse({})).toStrictEqual({ limit: PAGE_SIZE_DEFAULT });
  });

  it('coerces the text a query string actually carries', () => {
    expect(cursorPageQuerySchema.parse({ cursor: 'abc', limit: '50' })).toStrictEqual({
      cursor: 'abc',
      limit: 50,
    });
  });

  it('holds the §03 page cap', () => {
    expect(cursorPageQuerySchema.safeParse({ limit: PAGE_SIZE_MAX }).success).toBe(true);
    expect(cursorPageQuerySchema.safeParse({ limit: PAGE_SIZE_MAX + 1 }).success).toBe(false);
    expect(cursorPageQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(cursorPageQuerySchema.safeParse({ limit: '12.5' }).success).toBe(false);
  });

  it('reports a misspelled parameter instead of silently returning the default page', () => {
    const result = cursorPageQuerySchema.safeParse({ limt: '50' });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.code).toBe('unrecognized_keys');
  });
});
