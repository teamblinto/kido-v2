import type { RunApprovalDecision, RunApprovalKind, RunEvent } from '@repo/contracts';
import { useMutation } from '@tanstack/react-query';
import { FileTextIcon, ShieldQuestionIcon, TerminalIcon, WrenchIcon } from 'lucide-react';
import { useId } from 'react';

import { Button } from '@/components/ui/button';
import { messageFor } from '@/lib/api/problem';
import { cn } from '@/lib/utils';
import { decideApproval } from '../api';
import type { ApprovalResolution } from '../lib/transcript';

const KIND = {
  command: { icon: TerminalIcon, label: 'Run a command' },
  file_change: { icon: FileTextIcon, label: 'Change files' },
  tool: { icon: WrenchIcon, label: 'Use a tool' },
} as const satisfies Record<RunApprovalKind, unknown>;

function resolutionText(resolution: ApprovalResolution): string {
  const { by, decision } = resolution.data;

  if (by === 'timeout') return 'No answer in time, so it was denied.';
  if (by === 'run-ended') return 'The run ended before it was answered.';

  return decision === 'allow' ? 'Allowed by you.' : 'Denied by you.';
}

interface ApprovalCardProps {
  readonly event: Extract<RunEvent, { type: 'approval.request' }>;
  /** Absent until the organisation is known; the buttons wait for it. */
  readonly orgId: string | undefined;
  readonly projectId: string | undefined;
  readonly resolution: ApprovalResolution | undefined;
}

/**
 * A local agent asking before it acts (spec 040 § 3 decision 7). The answer is sent once; the card
 * settles when the run's own `approval.resolved` arrives, so a timeout or the run ending is shown
 * the same way as the person's own click.
 */
export function ApprovalCard({
  event,
  orgId,
  projectId,
  resolution,
}: ApprovalCardProps): React.JSX.Element {
  const id = useId();
  const { detail, kind, requestId, title } = event.data;
  const Icon = KIND[kind].icon;
  const decide = useMutation({
    mutationFn: (decision: RunApprovalDecision) =>
      decideApproval(orgId ?? '', projectId ?? '', event.run, requestId, { decision }),
  });
  // Optimistic: from the click until the run says so, the answer is shown as sent.
  const sent = decide.isPending || decide.isSuccess ? decide.variables : undefined;
  const open = resolution === undefined && sent === undefined;
  const canAnswer = open && orgId !== undefined && projectId !== undefined;

  return (
    <section
      aria-labelledby={`${id}-title`}
      className={cn(
        'bg-raised flex flex-col gap-2 rounded-[10px] border px-[11px] py-[9px]',
        resolution === undefined ? 'border-brand-border' : 'border-line-subtle',
      )}
    >
      <div className="flex items-center gap-[9px]">
        <Icon className="text-subdued size-3.5 shrink-0" aria-hidden="true" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="text-caption text-faint flex items-center gap-1">
            <ShieldQuestionIcon className="size-3" aria-hidden="true" />
            Permission requested · {KIND[kind].label}
          </p>
          <h3 id={`${id}-title`} className="text-label-sm text-foreground font-medium break-words">
            {title}
          </h3>
        </div>
      </div>

      {detail.length === 0 ? null : (
        <pre
          tabIndex={0}
          aria-label="Details"
          className="bg-muted text-mono-sm text-foreground max-h-48 overflow-auto rounded-md p-2 font-mono whitespace-pre-wrap"
        >
          {detail}
        </pre>
      )}

      {resolution === undefined ? (
        sent === undefined ? (
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={!canAnswer}
              onClick={() => {
                decide.mutate('allow');
              }}
            >
              Allow
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!canAnswer}
              onClick={() => {
                decide.mutate('deny');
              }}
            >
              Deny
            </Button>
          </div>
        ) : (
          <p className="text-caption text-subdued" role="status">
            {sent === 'allow' ? 'Allowing…' : 'Denying…'} waiting for the agent.
          </p>
        )
      ) : (
        <p className="text-caption text-subdued" role="status">
          {resolutionText(resolution)}
        </p>
      )}

      {decide.isError ? (
        <p className="text-caption text-danger" role="alert">
          {messageFor(decide.error, 'That answer was not sent. Try again.')}
        </p>
      ) : null}
    </section>
  );
}
