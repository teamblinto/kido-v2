import type { PreviewStage } from '@repo/contracts';
import { describe, expect, it } from 'vitest';

import { previewStage, type StageRow } from './preview-stage';

const PORT = 3000;
const SETTLED: StageRow = {
  lostAt: null,
  ports: {},
  state: 'active',
  transition: null,
  workspaceRoot: '/home/daytona/workspace',
};

const reported = (state: string): StageRow['ports'] => ({
  [PORT]: { observedAt: '2026-11-03T10:00:00.000Z', state },
});

describe('previewStage', () => {
  it('answers no-sandbox for a project that has never had a sandbox row', () => {
    expect(previewStage(undefined, PORT)).toBe('no-sandbox');
  });

  it('answers no-sandbox for a template with no devPort, whatever its sandbox is doing', () => {
    expect(previewStage(undefined, null)).toBe('no-sandbox');
    expect(previewStage({ ...SETTLED, ports: reported('listening') }, null)).toBe('no-sandbox');
    expect(previewStage({ ...SETTLED, transition: 'creating' }, null)).toBe('no-sandbox');
  });

  it('answers no-sandbox for a lost row, even mid-transition', () => {
    expect(previewStage({ ...SETTLED, lostAt: new Date(), transition: 'resuming' }, PORT)).toBe(
      'no-sandbox',
    );
  });

  // Each in-flight transition, over every state a row can hold while it runs.
  it.each<[NonNullable<StageRow['transition']>, PreviewStage]>([
    ['creating', 'creating'],
    ['resuming', 'starting'],
    ['hibernating', 'asleep'],
    ['releasing', 'no-sandbox'],
  ])('maps the %s transition to %s regardless of state or reports', (transition, stage) => {
    for (const state of ['active', 'idle', 'hibernated'] as const) {
      expect(
        previewStage({ ...SETTLED, ports: reported('listening'), state, transition }, PORT),
      ).toBe(stage);
    }
  });

  it('answers asleep for a settled hibernated row, whatever its last report said', () => {
    for (const ports of [{}, reported('listening'), reported('failed')]) {
      expect(previewStage({ ...SETTLED, ports, state: 'hibernated' }, PORT)).toBe('asleep');
    }
  });

  it('answers no-sandbox for the states a project row never settles in', () => {
    expect(previewStage({ ...SETTLED, state: 'pooled' }, PORT)).toBe('no-sandbox');
    expect(previewStage({ ...SETTLED, state: 'archived' }, PORT)).toBe('no-sandbox');
  });

  it('answers failed for a settled row with no work dir: its create dead-lettered', () => {
    expect(previewStage({ ...SETTLED, workspaceRoot: null }, PORT)).toBe('failed');
  });

  // Each running state × each dev server report, and no report at all.
  it.each<['active' | 'idle', string | undefined, PreviewStage]>([
    ['active', undefined, 'starting'],
    ['active', 'starting', 'starting'],
    ['active', 'listening', 'ready'],
    ['active', 'failed', 'failed'],
    ['idle', undefined, 'starting'],
    ['idle', 'starting', 'starting'],
    ['idle', 'listening', 'ready'],
    ['idle', 'failed', 'failed'],
  ])('maps a settled %s row whose dev server reported %s to %s', (state, report, stage) => {
    const ports = report === undefined ? {} : reported(report);
    expect(previewStage({ ...SETTLED, ports, state }, PORT)).toBe(stage);
  });

  it('reads only the declared port, and treats an unreadable entry as no report yet', () => {
    expect(previewStage({ ...SETTLED, ports: { 9999: { state: 'listening' } } }, PORT)).toBe(
      'starting',
    );
    expect(previewStage({ ...SETTLED, ports: { [PORT]: { state: 'installed' } } }, PORT)).toBe(
      'starting',
    );
    expect(previewStage({ ...SETTLED, ports: { [PORT]: 'listening' } }, PORT)).toBe('starting');
    expect(previewStage({ ...SETTLED, ports: null }, PORT)).toBe('starting');
  });
});
