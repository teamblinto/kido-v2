import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { collectScannedFiles } from '../../../test/support/plain-set-scanner';

/** Vitest runs from `apps/api`; the gate covers application code across the repository. */
const REPOSITORY_ROOT = join(process.cwd(), '..', '..');

/**
 * Application code, which is exactly the scope of the criterion. `packages/db/migrations` is left
 * out on purpose: hand-written SQL is where the *grant* lives, and 0003 says the words "no UPDATE
 * and no DELETE" in prose that this scanner would otherwise flag.
 */
const SCANNED_ROOTS = ['apps/api/src', 'packages/db/src'];

/**
 * The two files that name a write against `audit_log` on purpose — one as the fixtures below, one
 * as `packages/db/src/schema/rls.spec.ts`, which connects as `forge_app` and proves the database
 * refuses the statement. Excluding them by name is what keeps the gate honest about everything else.
 */
const IGNORED_FILES = new Set(['append-only.spec.ts', 'rls.spec.ts']);

/** `.update(auditLog)` / `.delete(auditLog)` — the Drizzle spelling. */
const DRIZZLE_WRITE = /\.\s*(?:update|delete)\s*\(\s*auditLog\b/gi;

/** `update audit_log …` / `delete from audit_log` — the raw-SQL spelling. */
const SQL_WRITE = /\b(?:update\s+"?audit_log"?|delete\s+from\s+"?audit_log"?)/gi;

export interface Mutation {
  readonly line: number;
  readonly statement: string;
}

export function findAuditLogMutations(source: string): Mutation[] {
  const found: Mutation[] = [];

  for (const pattern of [DRIZZLE_WRITE, SQL_WRITE]) {
    for (const match of source.matchAll(pattern)) {
      found.push({
        line: source.slice(0, match.index).split('\n').length,
        statement: match[0],
      });
    }
  }

  return found.sort((a, b) => a.line - b.line);
}

/**
 * T10 · "No update or delete path exists in application code (and the grant from T05 prevents one)."
 *
 * Two independent things, deliberately not collapsed into one. `migrations/0003_grants.sql` gives
 * `forge_app` `SELECT` and `INSERT` on `audit_log` and nothing else, and `packages/db/src/schema/
 * rls.spec.ts` proves the database answers an UPDATE with 42501 — that is the enforcement, and this
 * file does not duplicate it as a runtime guard in the service.
 *
 * What this file adds is the other half of the sentence: that no application code *tries*. A
 * statement the database refuses still aborts the transaction that issued it, so a well-meaning
 * "correct the actor id on that row" written a year from now would not tamper with the trail — it
 * would break whatever mutation it was attached to, at runtime, in production. Catching it at
 * `pnpm check` is cheaper, and it is the same argument `no-plain-set.spec.ts` makes for its rule.
 *
 * Fixtures first: a gate that cannot be shown to fail is not a gate.
 */
describe('the append-only scanner', () => {
  it('flags a Drizzle update against the trail', () => {
    const source = `await tx.update(auditLog).set({ action: 'corrected' });`;

    expect(findAuditLogMutations(source)).toEqual([
      expect.objectContaining({ line: 1, statement: '.update(auditLog' }),
    ]);
  });

  it('flags a Drizzle delete against the trail', () => {
    expect(findAuditLogMutations(`await tx.delete(auditLog).where(older);`)).toEqual([
      expect.objectContaining({ statement: '.delete(auditLog' }),
    ]);
  });

  it('flags the raw-SQL spellings of both', () => {
    const source = [
      `update audit_log set action = 'tampered'`,
      `delete from "audit_log" where at < now()`,
    ].join('\n');

    expect(findAuditLogMutations(source).map((match) => match.line)).toEqual([1, 2]);
  });

  it('leaves the appends and the reads alone', () => {
    const source = [
      `await tx.insert(auditLog).values(entry);`,
      `select action from audit_log where org_id = $1`,
      `await tx.update(workspaces).set({ name });`,
      `await tx.delete(orgs).where(inArray(orgs.id, ids));`,
    ].join('\n');

    expect(findAuditLogMutations(source)).toEqual([]);
  });
});

describe('application code', () => {
  it('contains no update or delete against audit_log, anywhere', async () => {
    const files = (await collectScannedFiles(REPOSITORY_ROOT, SCANNED_ROOTS)).filter(
      (file) => !IGNORED_FILES.has(file.split('/').at(-1)!),
    );

    const findings: string[] = [];

    for (const file of files) {
      const source = await readFile(join(REPOSITORY_ROOT, file), 'utf8');

      findings.push(
        ...findAuditLogMutations(source).map((match) => `${file}:${match.line} ${match.statement}`),
      );
    }

    expect(
      findings,
      'the audit trail is append-only (§09) and application code must not try',
    ).toEqual([]);
  });

  /**
   * An empty finding list is also what a scan that read nothing returns. These are the files that
   * write to and define the trail; if the walker cannot reach them it is measuring silence.
   */
  it('reaches the files that touch the trail, so an empty result means something', async () => {
    const files = await collectScannedFiles(REPOSITORY_ROOT, SCANNED_ROOTS);

    expect(files).toEqual(
      expect.arrayContaining([
        'apps/api/src/modules/audit/audit.service.ts',
        'packages/db/src/schema/audit.ts',
      ]),
    );
  });
});
