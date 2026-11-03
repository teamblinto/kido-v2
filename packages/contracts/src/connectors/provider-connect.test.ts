import { describe, expect, it } from 'vitest';

import {
  PASTE_TOKEN_PROVIDERS,
  pasteTokenRequestSchema,
  supabaseCompleteRequestSchema,
  supabaseInstallResponseSchema,
} from './provider-connect';

describe('pasteTokenRequestSchema', () => {
  it('names the four pasted-token providers (research R1)', () => {
    expect(PASTE_TOKEN_PROVIDERS).toEqual(['netlify', 'neon', 'resend', 'cloudflare']);
  });

  it('trims a paste and keeps the token', () => {
    expect(pasteTokenRequestSchema.parse({ token: '  re_abc123  \n' })).toEqual({
      token: 're_abc123',
    });
  });

  it('refuses an empty token, one over 512, one with whitespace inside, and a stray field', () => {
    expect(pasteTokenRequestSchema.safeParse({ token: '   ' }).success).toBe(false);
    expect(pasteTokenRequestSchema.safeParse({ token: 'a'.repeat(513) }).success).toBe(false);
    expect(pasteTokenRequestSchema.parse({ token: 'a'.repeat(512) }).token).toHaveLength(512);
    expect(pasteTokenRequestSchema.safeParse({ token: 'two words' }).success).toBe(false);
    expect(pasteTokenRequestSchema.safeParse({ provider: 'neon', token: 'x' }).success).toBe(false);
  });
});

describe('Supabase OAuth', () => {
  it('answers the authorize URL and takes back code and state strictly', () => {
    expect(
      supabaseInstallResponseSchema.parse({ url: 'https://api.supabase.com/v1/oauth/authorize' }),
    ).toBeDefined();
    expect(supabaseCompleteRequestSchema.parse({ code: 'c', state: 's' })).toEqual({
      code: 'c',
      state: 's',
    });
    expect(supabaseCompleteRequestSchema.safeParse({ code: '', state: 's' }).success).toBe(false);
    expect(
      supabaseCompleteRequestSchema.safeParse({ code: 'c', state: 's', verifier: 'v' }).success,
    ).toBe(false);
  });
});
