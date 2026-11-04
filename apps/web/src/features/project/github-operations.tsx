import type { RepoLink, SyncOperation } from '@repo/contracts';

import { Badge } from '@/components/ui/badge';
import { describeAge } from './lib/describe-age';
import { commitUrl, compareUrl, REASON_COPY, shortSha } from './lib/github-sync';

const STATE: Record<SyncOperation['state'], 'danger' | 'info' | 'muted' | 'success'> = {
  failed: 'danger',
  queued: 'muted',
  running: 'info',
  succeeded: 'success',
};

function headline(op: SyncOperation, now: number): string {
  const age = describeAge(op.createdAt, now);

  if (op.trigger === 'auto') {
    return `${op.state === 'succeeded' ? 'Pushed automatically' : 'Automatic push'} after a turn · ${age}`;
  }

  return `${op.kind === 'push' ? 'Push' : op.kind === 'pull' ? 'Pull' : 'Import'} by ${op.requestedBy.name} · ${age}`;
}

function ShaRange({
  fullName,
  from,
  to,
}: {
  readonly from: string | null;
  readonly fullName: string;
  readonly to: string;
}): React.JSX.Element {
  return (
    <a
      href={from === null ? commitUrl(fullName, to) : compareUrl(fullName, from, to)}
      target="_blank"
      rel="noreferrer"
      className="text-subdued hover:text-foreground font-mono underline"
    >
      {from === null ? shortSha(to) : `${shortSha(from)}…${shortSha(to)}`}
    </a>
  );
}

/** The last few pushes and pulls, each saying who or what asked and where it went. */
export function GitHubOperations({
  link,
  now,
  operations,
}: {
  readonly link: RepoLink;
  readonly now: number;
  readonly operations: readonly SyncOperation[];
}): React.JSX.Element | null {
  if (operations.length === 0) return null;

  return (
    <ul className="text-body-sm flex flex-col gap-1" aria-label="Recent operations">
      {operations.map((op) => (
        <li key={op.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <Badge variant={STATE[op.state]}>{op.state}</Badge>
          <span className="text-subdued">{headline(op, now)}</span>
          {op.targetBranch !== null && op.targetBranch !== link.branch ? (
            <span className="text-subdued">to {op.targetBranch}</span>
          ) : null}
          {op.toSha !== null ? (
            <ShaRange from={op.fromSha} fullName={link.repository.fullName} to={op.toSha} />
          ) : null}
          {op.kind === 'push' && op.commits > 0 ? (
            <span className="text-subdued">
              {op.commits} {op.commits === 1 ? 'commit' : 'commits'}
            </span>
          ) : null}
          {op.reason !== null ? (
            <span className="text-danger">{REASON_COPY[op.reason]}</span>
          ) : null}
          {op.kind === 'pull' && op.state === 'succeeded' ? (
            <span className="text-subdued">
              {op.commits} {op.commits === 1 ? 'checkpoint' : 'checkpoints'} pulled from GitHub
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
