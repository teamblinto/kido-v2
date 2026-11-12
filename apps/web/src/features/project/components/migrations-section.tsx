import {
  MIGRATION_DIRECTORIES,
  type MigrationProvider,
  parseMigrationFileName,
} from '@repo/contracts';
import { Loader2 } from 'lucide-react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ApiProblem, messageFor } from '@/lib/api/problem';
import { isAsleep, useDirectory } from '../hooks/use-files';
import {
  type PendingMigration,
  useApplyMigrations,
  useMigrationStatus,
} from '../hooks/use-integrations';

/** Shown when the files cannot be listed because the sandbox is asleep. */
export const MIGRATIONS_ASLEEP = 'Open the preview to load migrations.';
export const NO_MIGRATIONS = 'No migrations yet.';

/** Digits only, so the longer version is the later one, and equal lengths compare as text. */
const byVersion = (a: PendingMigration, b: PendingMigration): number =>
  a.version.length - b.version.length || a.version.localeCompare(b.version);

interface MigrationsSectionProps {
  readonly canManage: boolean;
  /** The provider's own copy of a refusal (reasons such as `needs-reauth`), with any link. */
  readonly errorCopy: (error: unknown) => React.ReactNode;
  readonly orgId: string;
  readonly projectId: string;
  readonly provider: MigrationProvider;
}

/**
 * The bound database's SQL migrations: the files the agent wrote, each marked applied or pending
 * by what the database itself records, and — for whoever manages connectors — the pending ones
 * applied in version order.
 */
export function MigrationsSection({
  canManage,
  errorCopy,
  orgId,
  projectId,
  provider,
}: MigrationsSectionProps): React.JSX.Element {
  const directory = MIGRATION_DIRECTORIES[provider];
  const status = useMigrationStatus(orgId, projectId, provider);
  const files = useDirectory(orgId, projectId, directory);
  const apply = useApplyMigrations(orgId, projectId, provider);

  const migrations = (files.data?.entries ?? [])
    .filter((entry) => entry.kind === 'file')
    .flatMap((entry) => {
      const parsed = parseMigrationFileName(entry.name);

      return parsed === undefined ? [] : [{ ...parsed, fileName: entry.name }];
    })
    .sort(byVersion);
  const applied = new Set(status.data?.applied ?? []);
  // shortcut: one request carries at most 100 migrations; the rest go on the next press.
  const pending = migrations.filter((row) => !applied.has(row.version)).slice(0, 100);
  // A directory the agent has not written yet is answered as a bad or missing path.
  const missing = ApiProblem.is(files.error) && [400, 404].includes(files.error.status);
  const result = apply.data;

  return (
    <div className="flex flex-col gap-2" aria-labelledby={`${provider}-migrations-heading`}>
      <h4 id={`${provider}-migrations-heading`} className="text-body-sm font-semibold">
        SQL migrations
      </h4>
      <p className="text-body-sm text-subdued">
        The agent writes migrations to <code className="font-mono">{directory}</code>; you apply
        them here.
        {provider === 'neon' ? ' They apply to the preview database.' : null}
      </p>
      {status.isLoading || files.isLoading ? (
        <div className="flex items-center gap-2" role="status">
          <Loader2 className="text-subdued size-4 animate-spin" aria-hidden="true" />
          <span className="text-body-sm text-subdued">Loading migrations…</span>
        </div>
      ) : status.isError ? (
        <Alert variant="warning">{errorCopy(status.error)}</Alert>
      ) : isAsleep(files.error) ? (
        <p className="text-body-sm text-subdued">{MIGRATIONS_ASLEEP}</p>
      ) : files.isError && !missing ? (
        <p className="text-body-sm text-danger" role="alert">
          {messageFor(files.error, 'Migrations could not be loaded.')}
        </p>
      ) : migrations.length === 0 ? (
        <p className="text-body-sm text-subdued">{NO_MIGRATIONS}</p>
      ) : (
        <>
          <ul className="flex flex-col gap-1" aria-label="Migrations">
            {migrations.map((row) => (
              <li key={row.fileName} className="text-body-sm flex items-center gap-2">
                <Badge variant="outline">{applied.has(row.version) ? 'Applied' : 'Pending'}</Badge>
                <span className="font-mono break-all">{row.fileName}</span>
              </li>
            ))}
          </ul>
          {canManage && pending.length > 0 ? (
            <div>
              <Button
                size="sm"
                disabled={apply.isPending}
                onClick={() => {
                  apply.mutate(pending);
                }}
              >
                {apply.isPending ? 'Applying…' : `Apply ${String(pending.length)} pending`}
              </Button>
            </div>
          ) : null}
        </>
      )}
      {result === undefined ? null : (
        <p className="text-body-sm text-subdued" role="status">
          Applied {result.applied.length}
          {result.skipped.length > 0 ? `, ${String(result.skipped.length)} already applied` : ''}.
        </p>
      )}
      {result?.failed == null ? null : (
        <Alert variant="danger">
          {result.failed.version} failed: {result.failed.message}
        </Alert>
      )}
      {apply.error === null ? null : (
        <Alert variant="danger">
          {ApiProblem.is(apply.error) ? errorCopy(apply.error) : apply.error.message}
        </Alert>
      )}
    </div>
  );
}
