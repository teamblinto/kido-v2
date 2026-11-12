import { describe, expect, it } from 'vitest';

import type { SqlOutcome } from './providers/supabase/supabase.client';
import {
  applyPending,
  byVersion,
  migrationSql,
  readApplied,
  type SqlTarget,
} from './database-migrations';

/** A database that records versions from the insert line and fails SQL containing `BOOM`. */
function fakeTarget(
  initial: string[] = [],
): SqlTarget & { readonly ran: string[]; readonly versions: Set<string> } {
  const versions = new Set(initial);
  const ran: string[] = [];

  return {
    close: () => Promise.resolve(),
    ran,
    run: (sql): Promise<SqlOutcome> => Promise.resolve(answer(sql)),
    versions,
  };

  function answer(sql: string): SqlOutcome {
    ran.push(sql);
    if (sql.includes('to_regclass')) return { ok: true, rows: [{ present: versions.size > 0 }] };
    if (sql.startsWith('select version')) {
      return { ok: true, rows: [...versions].map((version) => ({ version })) };
    }
    if (sql.includes('BOOM'))
      return { message: 'ERROR: syntax error at "BOOM" postgres://u:secretpw@h/db', ok: false };
    const inserted = /values \('(\d+)'/u.exec(sql);
    if (inserted !== null) versions.add(inserted[1]!);
    return { ok: true, rows: [] };
  }
}

describe('database migrations', () => {
  it('orders versions as numbers, not strings', () => {
    expect(['10', '9', '20261112000000', '2'].sort(byVersion)).toEqual([
      '2',
      '9',
      '10',
      '20261112000000',
    ]);
  });

  it('wraps one migration in its own transaction and records it in the same one', () => {
    const sql = migrationSql('forge_migrations', {
      name: 'todos',
      sql: 'create table t () -- end',
      version: '7',
    });
    const lines = sql.split('\n');

    expect(lines[0]).toBe('begin;');
    expect(lines.at(-1)).toBe('commit;');
    // The bare `;` closes a statement left open by a trailing comment.
    expect(lines).toContain(';');
    expect(sql).toContain(
      "insert into forge_migrations.schema_migrations (version, name) values ('7', 'todos');",
    );
  });

  it('reads nothing applied before the first apply', async () => {
    expect(await readApplied(fakeTarget(), 'supabase_migrations')).toEqual([]);
    expect(await readApplied(fakeTarget(['3', '1']), 'supabase_migrations')).toEqual(['1', '3']);
  });

  it('applies pending migrations in version order and skips what the database already has', async () => {
    const target = fakeTarget(['1']);
    const result = await applyPending(target, 'forge_migrations', [
      { name: 'c', sql: 'create table c ()', version: '3' },
      { name: 'a', sql: 'create table a ()', version: '1' },
      { name: 'b', sql: 'create table b ()', version: '2' },
    ]);

    expect(result).toEqual({ applied: ['2', '3'], failed: null, skipped: ['1'] });
    const applies = target.ran.filter((sql) => sql.startsWith('begin;'));
    expect(applies.map((sql) => /values \('(\d+)'/u.exec(sql)![1])).toEqual(['2', '3']);
  });

  it('stops at the first failure, names it, and scrubs credentials from the message', async () => {
    const target = fakeTarget();
    const result = await applyPending(target, 'forge_migrations', [
      { name: 'a', sql: 'create table a ()', version: '1' },
      { name: 'b', sql: 'BOOM', version: '2' },
      { name: 'c', sql: 'create table c ()', version: '3' },
    ]);

    expect(result.applied).toEqual(['1']);
    expect(result.failed?.version).toBe('2');
    expect(result.failed?.message).toContain('syntax error');
    expect(result.failed?.message).not.toContain('secretpw');
    expect(target.versions.has('3')).toBe(false);
  });
});
