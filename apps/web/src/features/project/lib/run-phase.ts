import type { RunStatus } from '@repo/contracts';

import type { RunPhase, RunTone } from '../types';

/*
 * The vocabulary shared by everything that reports on a run: the topbar chip,
 * the preview's address bar and the chat's state cards. Keeping the wording and
 * the colour in one table is what stops them drifting apart.
 */

export const runPhases = {
  asleep: { isLive: false, label: 'Asleep', tone: 'neutral' },
  building: { isLive: true, label: 'Building', tone: 'info' },
  'needs-a-fix': { isLive: false, label: 'Needs a fix', tone: 'danger' },
  paused: { isLive: false, label: 'Paused', tone: 'warning' },
  queued: { isLive: false, label: 'Queued', tone: 'neutral' },
  ready: { isLive: false, label: 'Ready', tone: 'success' },
  starting: { isLive: true, label: 'Starting', tone: 'warning' },
  'waiting-for-you': { isLive: true, label: 'Waiting for you', tone: 'warning' },
} as const satisfies Record<RunPhase, { isLive: boolean; label: string; tone: RunTone }>;

/** The tone a phase paints with, so dots elsewhere can match its chip. */
export function runPhaseTone(phase: RunPhase): RunTone {
  return runPhases[phase].tone;
}

/** Solid fills, for dots and markers. */
export const toneDot = {
  danger: 'bg-danger',
  info: 'bg-info',
  neutral: 'bg-neutral',
  success: 'bg-success',
  warning: 'bg-warning',
} as const satisfies Record<RunTone, string>;

/** Soft fills, for the panels a tone tints. */
export const toneSurface = {
  danger: 'bg-danger-soft',
  info: 'bg-info-soft',
  neutral: 'bg-neutral-soft',
  success: 'bg-success-soft',
  warning: 'bg-warning-soft',
} as const satisfies Record<RunTone, string>;

/*
 * The wire's nine statuses, spoken in the eight words this screen already uses.
 *
 * Two vocabularies rather than one because they answer different questions. `run_status` is the
 * job's state as the worker records it — `tool_error` and `failed` are different rows to page
 * through and different things to bill. A person reading the chip only needs to know whether
 * something is wanted from them, so both arrive as "Needs a fix". Renaming the phases to match
 * the enum would put the worker's distinctions on the screen, which is the opposite trade.
 *
 * Stated where it is lossy: `tool_error` and `failed` both map to `needs-a-fix`, so nothing may
 * read a phase back to decide what a run did. `isTerminal` is asked of the status for that reason
 * — `asleep` is what `cancelled` looks like, not a test for it.
 */
const STATUS_PHASES = {
  awaiting_input: 'waiting-for-you',
  cancelled: 'asleep',
  failed: 'needs-a-fix',
  paused: 'paused',
  queued: 'queued',
  running: 'building',
  starting: 'starting',
  succeeded: 'ready',
  tool_error: 'needs-a-fix',
} as const satisfies Record<RunStatus, RunPhase>;

/** The phase word for a run status. Total over the contract's enum, by construction. */
export function statusToPhase(status: RunStatus): RunPhase {
  return STATUS_PHASES[status];
}

/**
 * The three statuses a run never leaves.
 *
 * What decides whether a stream is opened at all: a terminal run is rebuilt from history and gets
 * no connection (FR-014). `paused` and `awaiting_input` are deliberately not here — both are runs
 * that are still going and still have events to deliver.
 */
const TERMINAL: ReadonlySet<RunStatus> = new Set<RunStatus>(['cancelled', 'failed', 'succeeded']);

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL.has(status);
}
