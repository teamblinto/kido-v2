import type { RunEvent, RunResponse } from '@repo/contracts';
import { RotateCwIcon } from 'lucide-react';
import { Link } from 'react-router-dom';

import { CopyCommand } from '@/features/settings/local-agents/copy-command';
import { START_COMMAND, loginCommand } from '@/features/settings/local-agents/local-agent-copy';
import { routes } from '@/lib/routes';
import { cn } from '@/lib/utils';
import { runPhases, statusToPhase, toneDot, toneSurface } from '../lib/run-phase';
import type { Connection, TranscriptSource } from '../lib/transcript';
import type { RunTone } from '../types';

/**
 * The strip under the transcript that says what the transcript *is*: a run being watched, a run
 * being read back, a connection coming and going, or one that has gone.
 *
 * SC-004 is a glance test — "a person can always tell" — so the answer is one line in one place,
 * tinted by the same tone table as the topbar chip, rather than something to be inferred from
 * whether new entries have appeared lately. That inference is exactly what FR-010 forbids: a
 * stalled transcript and a quiet healthy one look identical, and only the connection knows which
 * is which.
 */

interface RunStateCardProps {
  className?: string;
  /** What the transport is doing (data-model.md § Connection). */
  connection: Connection;
  /** The failed `state` event's data, when the run failed. */
  failure?: Extract<RunEvent, { type: 'state' }>['data'];
  /** Open the stream again after it was given up on. Offered only for `lost`. */
  onRetry: () => void;
  /** The run being reported on, once it has been read. */
  run: RunResponse | undefined;
  /** Streamed, or read back from the store (FR-011). */
  source: TranscriptSource;
}

interface CardCopy {
  body: string;
  /** Whether the dot breathes: something is still expected to arrive. */
  isLive: boolean;
  title: string;
  tone: RunTone;
}

/**
 * Four of the five connection values, in words.
 *
 * `idle` is absent deliberately: nothing has been opened, so there is nothing to report and the
 * strip does not render. Saying "not connected" before a run exists would put a warning on a
 * screen where nothing is wrong. `closed` is here as a fallback only — a closed connection means
 * the run is terminal, so its own phase is the better sentence and takes over below.
 */
const CONNECTION_COPY = {
  closed: {
    body: 'Nothing more will arrive.',
    isLive: false,
    title: 'Finished',
    tone: 'neutral',
  },
  lost: {
    body: 'The connection could not be restored, so this may not be the whole run. Try again to pick it back up.',
    isLive: false,
    title: 'Not receiving updates',
    tone: 'danger',
  },
  open: {
    body: 'Watching this run as it works.',
    isLive: true,
    title: 'Live',
    tone: 'info',
  },
  retrying: {
    body: 'The connection dropped. Reconnecting and carrying on from the last thing received.',
    isLive: true,
    title: 'Reconnecting',
    tone: 'warning',
  },
} as const satisfies Record<Exclude<Connection, 'idle'>, CardCopy>;

/**
 * What to say, from the connection and — when the connection has closed — the run's own ending.
 *
 * A finished run is described by what it did rather than by the fact that its socket is shut:
 * "Ready" and "Needs a fix" are the words the rest of the screen already uses for it, and
 * "Finished" would be true of both while distinguishing neither.
 */
function copy(
  connection: Connection,
  run: RunResponse | undefined,
  source: TranscriptSource,
): CardCopy | undefined {
  if (connection === 'idle') {
    return undefined;
  }

  if (connection !== 'closed' || run === undefined) {
    return CONNECTION_COPY[connection];
  }

  const phase = runPhases[statusToPhase(run.status)];

  return {
    // FR-011, in the one place a person could otherwise mistake a stored record for a live run:
    // both are still, and only one of them is still *happening*.
    body:
      source === 'history'
        ? 'Reading the record this run left behind.'
        : 'This run has ended. Nothing more will arrive.',
    isLive: false,
    title: phase.label,
    tone: phase.tone,
  };
}

/** Fallback for `state` events written before `localAgentFailure`: the reason names the command. */
const FIX_COMMAND = /baios-companion (?:login (?:claude|codex)|start)(?![\w-])/u;

/**
 * Spec 041: where the failed CLI ran — the person's own `device` or their cloud `subscription`.
 * Events written before `origin` existed keep the earlier rule: a Claude sign-in failure came from
 * the subscription (the composer's Claude runs go there), anything else from a device.
 */
function failureOrigin(
  failure: RunStateCardProps['failure'],
): 'device' | 'subscription' | undefined {
  const local = failure?.localAgentFailure;
  if (local === undefined) return undefined;

  return (
    local.origin ??
    (local.class === 'auth' && local.provider === 'claude' ? 'subscription' : 'device')
  );
}

/**
 * Spec 040: the command that fixes a local agent's failure — sign in, or start the companion —
 * offered as a copyable command rather than left in a sentence. Never for a cloud subscription,
 * which has no computer to run it on.
 */
function fixCommand(failure: RunStateCardProps['failure']): string | undefined {
  const local = failure?.localAgentFailure;

  if (local === undefined) return FIX_COMMAND.exec(failure?.reason ?? '')?.[0];
  if (failureOrigin(failure) === 'subscription') return undefined;
  if (local.class === 'auth') return loginCommand(local.provider);
  if (local.class === 'transport') return START_COMMAND;

  return undefined;
}

export function RunStateCard({
  className,
  connection,
  failure,
  onRetry,
  run,
  source,
}: RunStateCardProps): React.JSX.Element | null {
  const card = copy(connection, run, source);

  if (card === undefined) {
    return null;
  }

  const failed = run?.status === 'failed';
  const fix = failed ? fixCommand(failure) : undefined;
  // A cloud subscription's failure is fixed in Settings or by waiting, never by a command.
  const cloud =
    failed && failureOrigin(failure) === 'subscription'
      ? failure?.localAgentFailure?.class
      : undefined;

  return (
    <section
      aria-label="Connection"
      // Announced rather than merely drawn: losing the stream is the one thing on this screen a
      // person needs told without having been looking at it.
      aria-live="polite"
      className={cn(
        'flex items-center gap-[9px] rounded-xl px-3.5 py-[13px]',
        toneSurface[card.tone],
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'size-[9px] shrink-0 rounded-full',
          toneDot[card.tone],
          card.isLive && 'animate-breathe',
        )}
      />

      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <h2 className="text-label-sm text-foreground font-semibold">{card.title}</h2>
        <p className="text-caption text-subdued">{card.body}</p>
        {fix === undefined ? null : (
          <p className="text-caption text-subdued flex flex-wrap items-center gap-1.5">
            On your computer, run <CopyCommand command={fix} />
          </p>
        )}
        {cloud === 'auth' ? (
          <p className="text-caption text-subdued">
            <Link
              to={`${routes.accountSettings}#claude-subscription`}
              className="text-brand-text underline-offset-4 hover:underline"
            >
              Reconnect your Claude subscription
            </Link>
          </p>
        ) : null}
        {cloud === 'transport' ? (
          <p className="text-caption text-subdued">
            Your cloud workspace could not be reached — try again in a minute.
          </p>
        ) : null}
      </div>

      {connection === 'lost' ? (
        <button
          type="button"
          onClick={onRetry}
          className={cn(
            'bg-canvas border-line text-label-xs text-foreground hover:bg-subtle shrink-0',
            'inline-flex items-center gap-1.5 rounded-[7px] border px-[9px] py-[5px] font-medium',
            'transition-colors',
          )}
        >
          <RotateCwIcon className="size-3" aria-hidden="true" />
          Try again
        </button>
      ) : null}
    </section>
  );
}
