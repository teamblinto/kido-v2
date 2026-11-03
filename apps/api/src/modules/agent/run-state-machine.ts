import type { RunStatus } from '@repo/contracts';

/**
 * The run's state machine, pure (spec 008 data-model.md § State machine).
 *
 * One table, read by `RunStore.transition` for every change of status but the claim's
 * `queued → starting`, which the claim statement applies itself. A transition not in the table is
 * a programmer error at the caller, not a request refusal: `IllegalTransitionError` is a plain
 * `Error`, and the request-side `409`s (cancel a finished run, input a running one) are decided by
 * the service reading the row, before this is consulted.
 */
export const TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = Object.freeze({
  awaiting_input: ['queued', 'cancelled', 'failed'],
  cancelled: [],
  failed: [],
  paused: ['queued', 'cancelled', 'failed'],
  queued: ['starting', 'cancelled', 'failed'],
  running: ['awaiting_input', 'tool_error', 'paused', 'succeeded', 'cancelled', 'failed'],
  starting: ['running', 'cancelled', 'failed'],
  succeeded: [],
  tool_error: ['running', 'failed', 'cancelled'],
});

export const TERMINAL: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'cancelled',
  'failed',
  'succeeded',
]);

/** The states in which no worker holds the run: a claim is what leaves them. */
const UNLEASED: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'queued',
  'awaiting_input',
  'paused',
  ...TERMINAL,
]);

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL.has(status);
}

/** Whether a worker may hold the run in this state: the only states a cancel must ask it to leave. */
export function isLeased(status: RunStatus): boolean {
  return !UNLEASED.has(status);
}

/** What the store must do to the row alongside the status change. */
export interface TransitionEffects {
  /** Set `ended_at`; the run is over. */
  readonly endsRun: boolean;
  /** Null `lease_until`; no worker holds the run in the new state. */
  readonly releasesLease: boolean;
  /** Set `started_at`; the run has been picked up for the first time. */
  readonly setsStartedAt: boolean;
}

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: RunStatus,
    readonly to: RunStatus,
  ) {
    super(`Illegal run transition ${from} → ${to}.`);
    this.name = 'IllegalTransitionError';
  }
}

export function transition(from: RunStatus, to: RunStatus): TransitionEffects {
  if (!TRANSITIONS[from].includes(to)) {
    throw new IllegalTransitionError(from, to);
  }

  return {
    endsRun: TERMINAL.has(to),
    releasesLease: UNLEASED.has(to),
    setsStartedAt: to === 'starting',
  };
}
