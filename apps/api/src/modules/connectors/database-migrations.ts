import { Inject, Injectable } from '@nestjs/common';
import {
  type ApplyMigrationsResponse,
  type Migration,
  MIGRATION_DIRECTORIES,
  type MigrationProvider,
  type MigrationStatus,
} from '@repo/contracts';
import { schema } from '@repo/db';
import { and, eq } from 'drizzle-orm';
import pg from 'pg';

import { revealPlaintext } from '../../common/crypto/branded';
import { ConflictError, NotFoundError } from '../../common/errors/domain-error';
import { scrubSecrets } from '../../common/telemetry/scrubber';
import type { TenantTransaction } from '../../database/database.types';
import { AuditService } from '../audit/audit.service';
import type { SandboxRef } from '../sandbox/sandbox.port';
import { BindingRepository } from './binding.repository';
import { ConnectionService } from './connection.service';
import { connectorRefusal, providerUnavailable } from './connectors.errors';
import { ProviderFailure } from './providers/provider';
import {
  SUPABASE_CLIENT,
  type SupabaseClient,
  type SqlOutcome,
} from './providers/supabase/supabase.client';
import { ResourceSecrets } from './resource-secrets';

/** Where each provider records what it applied; `supabase_migrations` is Supabase CLI's own. */
export const MIGRATION_SCHEMAS: Readonly<Record<MigrationProvider, string>> = {
  neon: 'forge_migrations',
  supabase: 'supabase_migrations',
};

const MESSAGE_MAX = 1_000;
const CONNECT_TIMEOUT_MS = 15_000;
const QUERY_TIMEOUT_MS = 120_000;

/** One open database session: `run` answers the SQL's own error instead of throwing it. */
export interface SqlTarget {
  run(sql: string): Promise<SqlOutcome>;
  close(): Promise<void>;
}

/** Digit strings, ordered as numbers (no leading-zero tricks: shorter is smaller). */
export function byVersion(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * One migration as one transaction, recorded in the same transaction it ran in. `version` and
 * `name` are inlined: the contract holds them to digits and `[A-Za-z0-9_-]`. The `;` on its own
 * line closes a file whose last statement has none, after a trailing `--` comment too.
 */
export function migrationSql(schemaName: string, migration: Migration): string {
  return [
    'begin;',
    `create schema if not exists ${schemaName};`,
    `create table if not exists ${schemaName}.schema_migrations (version text primary key, statements text[], name text);`,
    migration.sql,
    ';',
    `insert into ${schemaName}.schema_migrations (version, name) values ('${migration.version}', '${migration.name}');`,
    'commit;',
  ].join('\n');
}

/** The versions the database records, ascending; none before the first apply. */
export async function readApplied(target: SqlTarget, schemaName: string): Promise<string[]> {
  const probe = await target.run(
    `select to_regclass('${schemaName}.schema_migrations') is not null as present`,
  );
  if (!probe.ok) throw refusedRead(probe.message);
  if (probe.rows[0]?.present !== true) return [];

  const rows = await target.run(
    `select version from ${schemaName}.schema_migrations order by version`,
  );
  if (!rows.ok) throw refusedRead(rows.message);

  return rows.rows.map((row) => String(row.version)).sort(byVersion);
}

/**
 * Applies what the database does not already record, in version order, stopping at the first
 * failure. Re-reads the applied set first, so a stale panel or a double click skips, not repeats.
 */
export async function applyPending(
  target: SqlTarget,
  schemaName: string,
  migrations: readonly Migration[],
): Promise<ApplyMigrationsResponse> {
  const done = new Set(await readApplied(target, schemaName));
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const migration of [...migrations].sort((a, b) => byVersion(a.version, b.version))) {
    if (done.has(migration.version)) {
      skipped.push(migration.version);
      continue;
    }

    const outcome = await target.run(migrationSql(schemaName, migration));

    if (!outcome.ok) {
      return {
        applied,
        failed: { message: clip(outcome.message), version: migration.version },
        skipped,
      };
    }

    done.add(migration.version);
    applied.push(migration.version);
  }

  return { applied, failed: null, skipped };
}

/** The database's own words for the person, minus anything shaped like a credential. */
function clip(message: string): string {
  return scrubSecrets(message).slice(0, MESSAGE_MAX);
}

function refusedRead(message: string): ConflictError {
  return new ConflictError(`The database refused to list its migrations: ${clip(message)}`, {
    reason: 'provider-refused',
  });
}

/**
 * A project's SQL migrations against its bound database: the Neon preview branch (over Postgres,
 * with the branch's own sealed connection URI) or the Supabase project (the Management API's SQL
 * endpoint, with the org's OAuth grant). The files come from the person's panel — they read the
 * workspace — and only what the database does not record is run.
 *
 * shortcut: the SQL runs inside the request (as the bind form's listings call providers); move it
 * to a `connector.ops` job if migrations grow past the request timeout.
 */
@Injectable()
export class DatabaseMigrationService {
  constructor(
    @Inject(BindingRepository) private readonly bindings: BindingRepository,
    @Inject(ConnectionService) private readonly connections: ConnectionService,
    @Inject(ResourceSecrets) private readonly secrets: ResourceSecrets,
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async status(
    tx: TenantTransaction,
    ref: SandboxRef,
    provider: MigrationProvider,
  ): Promise<MigrationStatus> {
    return this.withTarget(tx, ref, provider, async (target) => ({
      applied: await readApplied(target, MIGRATION_SCHEMAS[provider]),
      directory: MIGRATION_DIRECTORIES[provider],
    }));
  }

  async apply(
    tx: TenantTransaction,
    ref: SandboxRef,
    actorId: string,
    provider: MigrationProvider,
    migrations: readonly Migration[],
  ): Promise<ApplyMigrationsResponse> {
    const result = await this.withTarget(tx, ref, provider, (target) =>
      applyPending(target, MIGRATION_SCHEMAS[provider], migrations),
    );

    if (result.applied.length > 0 || result.failed !== null) {
      await this.audit.record(tx, {
        action: 'connector.migrations-applied',
        actorId,
        metadata: {
          applied: result.applied,
          failed: result.failed?.version ?? null,
          projectId: ref.projectId,
          provider,
        },
        orgId: ref.orgId,
        target: ref.projectId,
      });
    }

    return result;
  }

  private async withTarget<T>(
    tx: TenantTransaction,
    ref: SandboxRef,
    provider: MigrationProvider,
    work: (target: SqlTarget) => Promise<T>,
  ): Promise<T> {
    const binding = await this.bindings.forProvider(tx, ref.orgId, ref.projectId, provider);

    if (binding?.state !== 'bound') {
      throw new NotFoundError(
        `The project is not bound to a ${provider === 'neon' ? 'Neon' : 'Supabase'} database.`,
      );
    }

    await this.connections.ensureUsable(tx, ref.orgId, provider);
    const target =
      provider === 'neon'
        ? await this.neonTarget(tx, ref.orgId, binding.id)
        : await this.supabaseTarget(
            tx,
            ref.orgId,
            String((binding.config as { projectRef?: unknown }).projectRef),
          );

    try {
      return await work(target);
    } finally {
      await target.close();
    }
  }

  private async neonTarget(
    tx: TenantTransaction,
    orgId: string,
    bindingId: string,
  ): Promise<SqlTarget> {
    const [resource] = await tx
      .select({ secretId: schema.connectorResources.secretId })
      .from(schema.connectorResources)
      .where(
        and(
          eq(schema.connectorResources.orgId, orgId),
          eq(schema.connectorResources.bindingId, bindingId),
          eq(schema.connectorResources.kind, 'neon_branch'),
          eq(schema.connectorResources.state, 'live'),
        ),
      );
    const uri =
      resource?.secretId == null
        ? undefined
        : await this.secrets.open(tx, orgId, 'neon_branch', resource.secretId);

    if (uri === undefined) {
      throw new ConflictError('The preview database is not ready yet.', { reason: 'not-ready' });
    }

    const client = new pg.Client({
      connectionString: revealPlaintext(uri).toString('utf8'),
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      query_timeout: QUERY_TIMEOUT_MS,
    });

    try {
      await client.connect();
    } catch {
      await client.end().catch(() => undefined);
      throw providerUnavailable(30, 'neon');
    }

    return {
      close: () => client.end().catch(() => undefined),
      run: async (sql) => {
        try {
          const result = (await client.query(sql)) as pg.QueryResult | pg.QueryResult[];
          const last = Array.isArray(result) ? result.at(-1) : result;

          return { ok: true, rows: (last?.rows ?? []) as Record<string, unknown>[] };
        } catch (error) {
          // A failed multi-statement text leaves the session in an aborted transaction.
          await client.query('rollback').catch(() => undefined);
          if (error instanceof pg.DatabaseError) return { message: error.message, ok: false };
          throw providerUnavailable(30, 'neon');
        }
      },
    };
  }

  private async supabaseTarget(
    tx: TenantTransaction,
    orgId: string,
    projectRef: string,
  ): Promise<SqlTarget> {
    const token = await this.connections.currentToken(tx, orgId, 'supabase');

    return {
      close: () => Promise.resolve(),
      run: async (sql) => {
        try {
          return await this.supabase.query(token, projectRef, sql);
        } catch (error) {
          if (!(error instanceof ProviderFailure)) throw error;
          switch (error.category) {
            case 'unauthorized':
              throw connectorRefusal('needs-reauth');
            case 'forbidden-scope':
              throw connectorRefusal('missing-scope', {
                detail:
                  'The Supabase connection cannot change the database. Reconnect Supabase to grant database access.',
              });
            case 'not-found':
              throw connectorRefusal('not-found');
            default:
              throw providerUnavailable(error.retryAfterSeconds ?? 60, 'supabase');
          }
        }
      },
    };
  }
}
