import type { TemplateVersion } from '@repo/db';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import type { ForgeDatabase } from '../../database/database.types';
import { TemplateVersions, type VersionKey } from './template-versions';

const NOW = new Date('2026-09-17T10:00:00.000Z');
const STALE_BEFORE = new Date('2026-09-17T09:45:00.000Z');
const DEF: VersionKey = {
  digest: 'a'.repeat(64),
  id: 'nextjs',
  snapshot: 'forge-tpl-nextjs-aaaaaaaaaaaa',
};

const row = (patch: Partial<TemplateVersion>): TemplateVersion => ({
  createdAt: NOW,
  current: false,
  digest: DEF.digest,
  failedAt: null,
  failureReason: null,
  readyAt: null,
  retiredAt: null,
  snapshot: DEF.snapshot,
  state: 'building',
  template: DEF.id,
  updatedAt: NOW,
  ...patch,
});

/** One builder chain as the service sees it: the verb, then every method and its arguments. */
interface Statement {
  readonly calls: { readonly args: unknown[]; readonly method: string }[];
  readonly verb: string;
}

/**
 * A drizzle stand-in: every builder method records itself and returns the chain, `await` answers
 * the next queued result, `transaction` runs the callback against the same fake and records that
 * it did. The `where`/`set` arguments are real drizzle objects, rendered below with the Postgres
 * dialect so a branch is checked by the SQL it would issue, not by the method it happened to call.
 */
function fakeDb(results: unknown[]) {
  const statements: Statement[] = [];
  const queue = [...results];

  const chain = (statement: Statement): unknown =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (typeof prop === 'symbol') return undefined;
          // A chain used as a subquery (`notExists(db.select()…)`) renders as a placeholder.
          if (prop === 'getSQL') return () => sql`(subquery)`;
          if (prop === 'then') {
            return (resolve: (value: unknown) => void) => resolve(queue.shift() ?? []);
          }
          return (...args: unknown[]) => {
            statement.calls.push({ args, method: prop });
            return chain(statement);
          };
        },
      },
    );

  const db = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'transaction') {
          return (fn: (tx: unknown) => Promise<unknown>) => {
            statements.push({ calls: [], verb: 'transaction' });
            return fn(db);
          };
        }
        return (...args: unknown[]) => {
          const statement: Statement = {
            calls: [{ args, method: String(prop) }],
            verb: String(prop),
          };
          statements.push(statement);
          return chain(statement);
        };
      },
    },
  );

  return { db: db as unknown as ForgeDatabase, statements };
}

const dialect = new PgDialect();
const render = (statement: Statement, method: string): string => {
  const call = statement.calls.find((c) => c.method === method);
  if (!call) throw new Error(`no ${method} on ${statement.verb}`);
  return dialect.sqlToQuery(call.args[0] as never).sql;
};
const setOf = (statement: Statement): Record<string, unknown> =>
  statement.calls.find((c) => c.method === 'set')!.args[0] as Record<string, unknown>;
const verbs = (statements: Statement[]) => statements.map((s) => s.verb);

/**
 * Contract § 2 over a mocked database: each of `begin`'s five rows takes the branch the table
 * names and issues the statement it names. The flip's atomicity against a second concurrent
 * publish is proved over the real database by the e2e (T024); here it is one transaction with
 * two updates in the right order.
 */
describe('TemplateVersions', () => {
  it('current answers the ready, current row of the template, or null', async () => {
    const hit = fakeDb([[row({ current: true, state: 'ready' })]]);
    expect(await new TemplateVersions(hit.db).current('nextjs')).toMatchObject({ current: true });
    expect(render(hit.statements[0]!, 'where')).toMatch(
      /"template" = \$1 and .*"current" = \$2 and .*"state" = \$3/,
    );

    const miss = fakeDb([[]]);
    expect(await new TemplateVersions(miss.db).current('nextjs')).toBeNull();
  });

  it('currentTemplates names every template with a ready, current row in one query', async () => {
    const { db, statements } = fakeDb([[{ template: 'nextjs' }, { template: 'vite-react' }]]);
    expect(await new TemplateVersions(db).currentTemplates()).toEqual(['nextjs', 'vite-react']);
    expect(statements).toHaveLength(1);
    expect(render(statements[0]!, 'where')).toMatch(/"current" = \$1 and .*"state" = \$2/);
  });

  it('list orders newest reservation first', async () => {
    const { db, statements } = fakeDb([[row({}), row({ digest: 'b'.repeat(64) })]]);
    expect(await new TemplateVersions(db).list('nextjs')).toHaveLength(2);
    expect(render(statements[0]!, 'orderBy')).toMatch(/"created_at" desc/);
  });

  describe('begin', () => {
    it('reserves an unseen digest: insert building, on conflict do nothing', async () => {
      const { db, statements } = fakeDb([[], [{ digest: DEF.digest }]]);

      expect(await new TemplateVersions(db).begin(DEF, NOW, STALE_BEFORE)).toBe('reserved');

      expect(verbs(statements)).toEqual(['select', 'insert']);
      const insert = statements[1]!;
      expect(insert.calls.map((c) => c.method)).toEqual([
        'insert',
        'values',
        'onConflictDoNothing',
        'returning',
      ]);
      expect(insert.calls[1]!.args[0]).toEqual({
        createdAt: NOW,
        digest: DEF.digest,
        snapshot: DEF.snapshot,
        state: 'building',
        template: 'nextjs',
        updatedAt: NOW,
      });
    });

    it('a reservation that lost the insert race is building-elsewhere', async () => {
      const { db } = fakeDb([[], []]);
      expect(await new TemplateVersions(db).begin(DEF, NOW, STALE_BEFORE)).toBe(
        'building-elsewhere',
      );
    });

    it('a ready, current row is already-current and writes nothing', async () => {
      const { db, statements } = fakeDb([[row({ current: true, state: 'ready' })]]);
      expect(await new TemplateVersions(db).begin(DEF, NOW, STALE_BEFORE)).toBe('already-current');
      expect(verbs(statements)).toEqual(['select']);
    });

    it('a ready row that is not current is flipped in one transaction: clear, then set', async () => {
      const { db, statements } = fakeDb([[row({ state: 'ready' })]]);

      expect(await new TemplateVersions(db).begin(DEF, NOW, STALE_BEFORE)).toBe('made-current');

      expect(verbs(statements)).toEqual(['select', 'transaction', 'update', 'update']);
      expect(setOf(statements[2]!)).toEqual({ current: false, updatedAt: NOW });
      expect(render(statements[2]!, 'where')).toMatch(/"template" = \$1 and .*"current" = \$2/);
      expect(setOf(statements[3]!)).toEqual({ current: true, updatedAt: NOW });
      expect(render(statements[3]!, 'where')).toMatch(
        /"template" = \$1 and .*"digest" = \$2.* and .*"state" = \$3/,
      );
    });

    it('a building row younger than staleBefore is building-elsewhere', async () => {
      const { db, statements } = fakeDb([[row({ createdAt: STALE_BEFORE })]]);
      expect(await new TemplateVersions(db).begin(DEF, NOW, STALE_BEFORE)).toBe(
        'building-elsewhere',
      );
      expect(verbs(statements)).toEqual(['select']);
    });

    it('a stale building row is taken over by a conditional update on its age', async () => {
      const stale = new Date(STALE_BEFORE.getTime() - 1);
      const { db, statements } = fakeDb([[row({ createdAt: stale })], [{ digest: DEF.digest }]]);

      expect(await new TemplateVersions(db).begin(DEF, NOW, STALE_BEFORE)).toBe('reserved');

      expect(verbs(statements)).toEqual(['select', 'update']);
      expect(setOf(statements[1]!)).toEqual({
        createdAt: NOW,
        failureReason: null,
        readyAt: null,
        retiredAt: null,
        state: 'building',
        updatedAt: NOW,
      });
      expect(render(statements[1]!, 'where')).toMatch(/"state" = \$3 and .*"created_at" < \$4/);
    });

    it.each(['failed', 'retired'] as const)(
      'a %s row is taken over on its state alone',
      async (state) => {
        const { db, statements } = fakeDb([
          [row({ failureReason: 'x', state })],
          [{ digest: DEF.digest }],
        ]);

        expect(await new TemplateVersions(db).begin(DEF, NOW, STALE_BEFORE)).toBe('reserved');

        const where = render(statements[1]!, 'where');
        expect(where).toMatch(/"state" = \$3/);
        expect(where).not.toContain('created_at');
      },
    );

    it('a takeover that matched no row (someone else took it) is building-elsewhere', async () => {
      const { db } = fakeDb([[row({ failureReason: 'x', state: 'failed' })], []]);
      expect(await new TemplateVersions(db).begin(DEF, NOW, STALE_BEFORE)).toBe(
        'building-elsewhere',
      );
    });
  });

  it('ready marks the row ready and flips it current in one transaction', async () => {
    const { db, statements } = fakeDb([]);

    await new TemplateVersions(db).ready(DEF, NOW);

    expect(verbs(statements)).toEqual(['transaction', 'update', 'update', 'update']);
    expect(setOf(statements[1]!)).toEqual({
      failureReason: null,
      readyAt: NOW,
      state: 'ready',
      updatedAt: NOW,
    });
    expect(setOf(statements[2]!)).toMatchObject({ current: false });
    expect(setOf(statements[3]!)).toMatchObject({ current: true });
  });

  it('fail records the reason and the time, and touches nothing else', async () => {
    const { db, statements } = fakeDb([]);

    await new TemplateVersions(db).fail(DEF, 'npm ci exited 1', NOW);

    expect(verbs(statements)).toEqual(['update']);
    expect(setOf(statements[0]!)).toEqual({
      failedAt: NOW,
      failureReason: 'npm ci exited 1',
      state: 'failed',
      updatedAt: NOW,
    });
    expect(render(statements[0]!, 'where')).toMatch(/"template" = \$1 and .*"digest" = \$2/);
  });

  it('retirable is ready, not current, and unreferenced by any sandbox_pool row', async () => {
    const { db, statements } = fakeDb([[row({ state: 'ready' })]]);

    expect(await new TemplateVersions(db).retirable('nextjs')).toHaveLength(1);

    const where = render(statements[0]!, 'where');
    expect(where).toMatch(/"state" = \$2/);
    expect(where).toMatch(/not "template_versions"\."current"/);
    expect(where).toMatch(/not exists \(subquery\)/);
  });

  it('retire takes a definition or a version row and never a current one', async () => {
    const { db, statements } = fakeDb([]);
    const versions = new TemplateVersions(db);

    await versions.retire(DEF, NOW);
    await versions.retire(row({ state: 'ready' }), NOW);

    for (const statement of statements) {
      expect(setOf(statement)).toEqual({ retiredAt: NOW, state: 'retired', updatedAt: NOW });
      const where = render(statement, 'where');
      expect(where).toMatch(/"template" = \$1 and .*"digest" = \$2.* and .*"state" = \$3/);
      expect(where).toMatch(/not "template_versions"\."current"/);
    }
  });
});
