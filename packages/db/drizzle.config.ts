import { defineConfig } from 'drizzle-kit';

import { migrationDatabaseUrl } from './src/env';

export default defineConfig({
  dbCredentials: { url: migrationDatabaseUrl() },
  dialect: 'postgresql',
  out: './migrations',
  schema: './src/schema/index.ts',
  strict: true,
  verbose: true,
});
