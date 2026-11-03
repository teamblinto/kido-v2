import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { EMAIL_MAX_LENGTH, emailSchema } from './email';

describe('emailSchema', () => {
  it('normalises before it validates, so a pasted address is not a rejection', () => {
    expect(emailSchema.parse('  Ada@Example.COM  ')).toBe('ada@example.com');
  });

  it('accepts the sub-addressing users actually rely on', () => {
    expect(emailSchema.parse('ada+forge@example.co.uk')).toBe('ada+forge@example.co.uk');
  });

  it('rejects a value that is not a mailbox', () => {
    expect(emailSchema.safeParse('ada@').success).toBe(false);
    expect(emailSchema.safeParse('example.com').success).toBe(false);
    expect(emailSchema.safeParse('').success).toBe(false);
  });

  it('rejects an address longer than a forward-path can carry', () => {
    const domain = '@example.com';
    const local = 'a'.repeat(EMAIL_MAX_LENGTH - domain.length);

    expect(emailSchema.safeParse(`${local}${domain}`).success).toBe(true);
    expect(emailSchema.safeParse(`a${local}${domain}`).success).toBe(false);
  });

  it('documents the mailbox format its input side cannot express', () => {
    expect(z.toJSONSchema(emailSchema, { io: 'input', target: 'openapi-3.0' })).toMatchObject({
      format: 'email',
      maxLength: EMAIL_MAX_LENGTH,
      type: 'string',
    });
  });
});
