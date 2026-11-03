import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  collectScannedFiles,
  findPlainSetStatements,
  scanForPlainSet,
} from '../../test/support/plain-set-scanner';

/** Vitest runs from `apps/api`; the gate covers the whole repository, not just this workspace. */
const REPOSITORY_ROOT = join(process.cwd(), '..', '..');

/**
 * The scanned surface: everything that can issue SQL. `packages/db/migrations` is in scope because
 * the RLS and grant migrations are hand-written SQL, which no ESLint rule would ever read.
 */
const SCANNED_ROOTS = [
  'apps/api/src',
  'apps/api/test',
  'packages/db/src',
  'packages/db/migrations',
];

/**
 * §09, and the reason task T06 exists at all.
 *
 * "With PgBouncer in transaction mode a connection is handed to another request the moment a
 * transaction commits. A plain SET would leak one tenant's context into the next request on that
 * connection — the exact bug RLS was meant to prevent."
 *
 * The rule has no exceptions, so it is enforced by a scan rather than by review. The fixtures come
 * first: a gate that cannot be shown to fail is not a gate.
 */
describe('the plain-SET scanner', () => {
  it('flags a session-scoped set_config, which is a plain SET wearing a function call', () => {
    const source = `await tx.execute(sql\`select set_config('app.org_id', \${orgId}, false)\`);`;

    expect(findPlainSetStatements(source)).toEqual([
      expect.objectContaining({ line: 1, reason: 'session-scoped-set-config' }),
    ]);
  });

  it('flags the two-argument set_config overload, which is session-scoped by omission', () => {
    const source = `select set_config('app.org_id', $1)`;

    expect(findPlainSetStatements(source)).toEqual([
      expect.objectContaining({ reason: 'session-scoped-set-config' }),
    ]);
  });

  it('flags a bare SET of a tenant setting', () => {
    const source = `BEGIN;\nSET app.org_id = '11111111-1111-1111-1111-111111111111';\nCOMMIT;`;

    expect(findPlainSetStatements(source)).toEqual([
      expect.objectContaining({ line: 2, reason: 'plain-set' }),
    ]);
  });

  it('flags SET SESSION, which is the same statement spelled at length', () => {
    expect(findPlainSetStatements(`SET SESSION app.org_id = '…'`)).toEqual([
      expect.objectContaining({ reason: 'plain-set' }),
    ]);
  });

  it('accepts the transaction-scoped form §09 mandates', () => {
    const source = `select set_config('app.org_id', $1, true)`;

    expect(findPlainSetStatements(source)).toEqual([]);
  });

  it('accepts SET LOCAL, the other spelling of the same thing', () => {
    expect(findPlainSetStatements(`SET LOCAL app.org_id = $1`)).toEqual([]);
  });

  it('does not fire on the TypeScript that merely looks like SQL', () => {
    const source = [
      'const seen = new Set<string>();',
      'const settings = { offset: 1 };',
      'response.set("content-type", "application/problem+json");',
      'const page = rows.slice(offset, offset + limit);',
      'await cache.set(key, value);',
    ].join('\n');

    expect(findPlainSetStatements(source)).toEqual([]);
  });

  it('reports every occurrence in a file, not just the first', () => {
    const source = [
      `select set_config('app.org_id', $1, false);`,
      `SET app.user_id = $2;`,
      `select set_config('app.org_id', $3, true);`,
    ].join('\n');

    expect(findPlainSetStatements(source).map((match) => match.line)).toEqual([1, 2]);
  });
});

describe('the repository', () => {
  it('contains no plain SET of tenant context, anywhere', async () => {
    const findings = await scanForPlainSet(REPOSITORY_ROOT, SCANNED_ROOTS);

    expect(
      findings.map((finding) => `${finding.file}:${finding.line} ${finding.reason}`),
      'a plain SET leaks tenant context across a PgBouncer transaction-mode connection (§09)',
    ).toEqual([]);
  });

  /**
   * An empty finding list is also what a scan that read nothing returns. These are the three files
   * that set or constrain tenant context; if the walker cannot reach them it is measuring silence.
   */
  it('reaches the files that set tenant context, so an empty result means something', async () => {
    const files = await collectScannedFiles(REPOSITORY_ROOT, SCANNED_ROOTS);

    expect(files).toEqual(
      expect.arrayContaining([
        'apps/api/src/database/tenant-transaction.ts',
        'packages/db/migrations/0002_rls_policies.sql',
        'packages/db/src/seed.ts',
      ]),
    );
  });
});
