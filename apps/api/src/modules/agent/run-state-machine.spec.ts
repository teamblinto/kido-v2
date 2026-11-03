import { RUN_FAILURE_CLASSES, RUN_STATUSES, type RunStatus } from '@repo/contracts';
import { describe, expect, it } from 'vitest';

import {
  IllegalTransitionError,
  TERMINAL,
  TRANSITIONS,
  isTerminal,
  transition,
} from './run-state-machine';

/**
 * The table from data-model.md § State machine, restated here as the oracle so the two cannot
 * drift apart without one of them being edited on purpose.
 */
const LEGAL: Record<RunStatus, readonly RunStatus[]> = {
  awaiting_input: ['queued', 'cancelled', 'failed'],
  cancelled: [],
  failed: [],
  paused: ['queued', 'cancelled', 'failed'],
  queued: ['starting', 'cancelled', 'failed'],
  running: ['awaiting_input', 'tool_error', 'paused', 'succeeded', 'cancelled', 'failed'],
  starting: ['running', 'cancelled', 'failed'],
  succeeded: [],
  tool_error: ['running', 'failed', 'cancelled'],
};

describe('run state machine', () => {
  it('names exactly the three terminal states', () => {
    expect([...TERMINAL].sort()).toEqual(['cancelled', 'failed', 'succeeded']);

    for (const status of RUN_STATUSES) {
      expect(isTerminal(status), status).toBe(TERMINAL.has(status));
    }
  });

  /** SC-006: every ordered pair, so a transition added to the table shows up here as a red case. */
  describe.each(RUN_STATUSES)('from %s', (from) => {
    it.each(RUN_STATUSES)('to %s', (to) => {
      if (LEGAL[from].includes(to)) {
        expect(transition(from, to)).toEqual({
          endsRun: TERMINAL.has(to),
          releasesLease:
            TERMINAL.has(to) || to === 'awaiting_input' || to === 'paused' || to === 'queued',
          setsStartedAt: to === 'starting',
        });
      } else {
        expect(() => transition(from, to)).toThrow(IllegalTransitionError);
      }
    });
  });

  it('exposes the table the store applies, matching the oracle', () => {
    for (const status of RUN_STATUSES) {
      expect([...TRANSITIONS[status]].sort(), status).toEqual([...LEGAL[status]].sort());
    }
  });

  it('says which pair was refused', () => {
    expect(() => transition('succeeded', 'running')).toThrow('succeeded → running');
  });

  /**
   * 020 research R7: a `credential` failure is the same `failed` state — the class is a label the
   * consumer copies from the outcome onto the row, and the machine takes no part in it.
   */
  it('accepts failed with the credential class as an ordinary failure (020 US3)', () => {
    expect(RUN_FAILURE_CLASSES).toContain('credential');
    const outcome = { failureClass: 'credential', kind: 'failed', reason: 'x' } as const;
    expect(transition('running', outcome.kind)).toEqual({
      endsRun: true,
      releasesLease: true,
      setsStartedAt: false,
    });
  });
});
