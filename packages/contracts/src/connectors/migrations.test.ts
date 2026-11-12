import { describe, expect, it } from 'vitest';

import { applyMigrationsRequestSchema, parseMigrationFileName } from './migrations';

describe('migrations contract', () => {
  it('reads version and name from a migration file name, and nothing else', () => {
    expect(parseMigrationFileName('20261112093000_create_todos.sql')).toEqual({
      name: 'create_todos',
      version: '20261112093000',
    });
    expect(parseMigrationFileName('20261112093000_.sql')).toEqual({
      name: '',
      version: '20261112093000',
    });
    expect(parseMigrationFileName('create_todos.sql')).toBeUndefined();
    expect(parseMigrationFileName('20261112_x.sql.bak')).toBeUndefined();
    expect(parseMigrationFileName("1_a';drop.sql")).toBeUndefined();
  });

  it('refuses a version or name that could not be inlined as a literal', () => {
    const base = { name: 'ok', sql: 'select 1', version: '1' };
    expect(applyMigrationsRequestSchema.safeParse({ migrations: [base] }).success).toBe(true);
    expect(
      applyMigrationsRequestSchema.safeParse({ migrations: [{ ...base, version: "1'" }] }).success,
    ).toBe(false);
    expect(
      applyMigrationsRequestSchema.safeParse({ migrations: [{ ...base, name: "a'b" }] }).success,
    ).toBe(false);
    expect(applyMigrationsRequestSchema.safeParse({ migrations: [] }).success).toBe(false);
  });
});
