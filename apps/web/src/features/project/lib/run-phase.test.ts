import { RUN_STATUSES, type RunStatus } from '@repo/contracts';
import { describe, expect, it } from 'vitest';

import { isTerminal, runPhases, statusToPhase } from './run-phase';

describe('statusToPhase', () => {
  // Driven from the contract's own array rather than a list copied into the test: a status added
  // upstream arrives here as a failing case, which is the only way this stays exhaustive without
  // anyone remembering to come back.
  it.each(RUN_STATUSES)('maps every run status to a phase — %s', (status) => {
    const phase = statusToPhase(status);

    expect(Object.keys(runPhases)).toContain(phase);
  });

  it('keeps the three status words the screen already spoke', () => {
    expect(statusToPhase('queued')).toBe('queued');
    expect(statusToPhase('starting')).toBe('starting');
    expect(statusToPhase('paused')).toBe('paused');
  });

  it('says needs-a-fix for both ways a run can go wrong', () => {
    // The lossy pair, asserted rather than left to be discovered: a reader of the phase cannot
    // tell a tool error from a failure, which is why nothing branches on a phase.
    expect(statusToPhase('tool_error')).toBe('needs-a-fix');
    expect(statusToPhase('failed')).toBe('needs-a-fix');
  });

  it('distinguishes the run that is working from the one that wants an answer', () => {
    expect(statusToPhase('running')).toBe('building');
    expect(statusToPhase('awaiting_input')).toBe('waiting-for-you');
    expect(statusToPhase('succeeded')).toBe('ready');
    expect(statusToPhase('cancelled')).toBe('asleep');
  });
});

describe('isTerminal', () => {
  it('names exactly three statuses terminal', () => {
    const terminal = RUN_STATUSES.filter((status: RunStatus) => isTerminal(status));

    expect(terminal).toEqual(['cancelled', 'failed', 'succeeded']);
  });

  it('does not call a run that is merely waiting finished', () => {
    // The distinction the stream depends on: both of these still have events to deliver, so a
    // console that treated them as terminal would open no connection and sit blank (FR-014).
    expect(isTerminal('paused')).toBe(false);
    expect(isTerminal('awaiting_input')).toBe(false);
  });
});
