import { describe, expect, it } from 'vitest';

import { integrationNote } from './integration-note';

describe('integrationNote', () => {
  it('says nothing for a project without connected services', () => {
    expect(integrationNote([])).toBe('');
  });

  it('names each live service by its env variables and its migrations directory, never a value', () => {
    const note = integrationNote([
      'SUPABASE_URL',
      'VITE_SUPABASE_URL',
      'DATABASE_URL',
      'RESEND_API_KEY',
    ]);

    expect(note).toContain('VITE_SUPABASE_PUBLISHABLE_KEY');
    expect(note).toContain('supabase/migrations/');
    expect(note).toContain('row level security');
    expect(note).toContain('DATABASE_URL');
    expect(note).toContain('db/migrations/');
    expect(note).toContain('RESEND_FROM_DOMAIN');
    expect(note).toContain('never print');
  });

  it('mentions only the services that are live', () => {
    const note = integrationNote(['RESEND_API_KEY', 'RESEND_FROM_DOMAIN']);

    expect(note).toContain('Resend');
    expect(note).not.toContain('Supabase');
    expect(note).not.toContain('Neon');
  });
});
