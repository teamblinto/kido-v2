import { MIGRATION_DIRECTORIES } from '@repo/contracts';

import type { PreviewEnvKey } from './sandbox.constants';

/**
 * What a run is told about the project's connected services: which ones are live and the names of
 * the environment variables the dev server already has. Names only — a value never enters a
 * prompt. `''` when nothing is connected, so a project without integrations sends nothing extra.
 */
export function integrationNote(keys: Iterable<string>): string {
  const present = new Set<string>(keys);
  const has = (key: PreviewEnvKey) => present.has(key);
  const sections: string[] = [];

  if (has('SUPABASE_URL')) {
    sections.push(
      [
        '- Supabase (database, auth, storage). Use `@supabase/supabase-js` and create the client from env:',
        '  Vite: `import.meta.env.VITE_SUPABASE_URL` and `import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY`;',
        '  Next.js: `process.env.NEXT_PUBLIC_SUPABASE_URL` and `process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`;',
        '  Node: `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`. (`*_SUPABASE_ANON_KEY` aliases hold the same key.)',
        '  The key is the public one: protect every table with row level security policies. There is no service-role key.',
        `  Schema changes: write SQL to \`${MIGRATION_DIRECTORIES.supabase}/<YYYYMMDDHHMMSS>_<name>.sql\` (new file per change, never edit an applied one), enable RLS in the same file, then tell the user to apply it from Integrations → Supabase.`,
      ].join('\n'),
    );
  }

  if (has('DATABASE_URL')) {
    sections.push(
      [
        '- Neon Postgres (a preview branch). `DATABASE_URL` is set on the server side only; use it from server code',
        '  (e.g. `@neondatabase/serverless` or `pg`), never in browser code.',
        `  Schema changes: write SQL to \`${MIGRATION_DIRECTORIES.neon}/<YYYYMMDDHHMMSS>_<name>.sql\` (new file per change), then tell the user to apply it from Integrations → Neon.`,
      ].join('\n'),
    );
  }

  if (has('RESEND_API_KEY')) {
    sections.push(
      [
        '- Resend (email). `RESEND_API_KEY` is a sending-only key, server side only; send with the `resend` SDK',
        '  from an address at `RESEND_FROM_DOMAIN` (e.g. `hello@${process.env.RESEND_FROM_DOMAIN}`). Never call it from browser code.',
      ].join('\n'),
    );
  }

  if (sections.length === 0) return '';

  return [
    "Connected services for this project (the preview's dev server already has these environment variables; never print, log or hard-code their values, and do not create .env files for them):",
    ...sections,
  ].join('\n');
}
