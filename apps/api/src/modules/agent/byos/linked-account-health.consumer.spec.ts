import { Logger } from '@nestjs/common';
import type { LinkedAccountRow } from '@repo/db';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClockPort } from '../../../common/clock/clock.port';
import type { ForgeDatabase } from '../../../database/database.types';
import type { Envelope } from '../../outbox/envelope';
import { ProviderError } from '../provider-error';
import type { ByosProviders } from './byos-providers';
import type { ByosTokenService } from './byos-token.service';
import {
  BYOS_HEALTH_QUEUE,
  CHECKED_WITHIN_MS,
  LinkedAccountHealthConsumer,
  SWEEP_PAGE,
} from './linked-account-health.consumer';
import type { LinkedAccountRepository } from './linked-account.repository';

const FROZEN = new Date('2026-09-24T09:00:00.000Z');

function due(job: Envelope<'maintenance.due'>['payload']['job']): Envelope<'maintenance.due'> {
  const periodStart = FROZEN.toISOString();
  return {
    aggregate: 'maintenance',
    aggregateId: `${job}:${periodStart}`,
    eventId: randomUUID(),
    occurredAt: periodStart,
    orgId: null,
    payload: { job, periodStart },
    traceId: null,
    type: 'maintenance.due',
  };
}

function account(provider: 'anthropic' | 'openai' = 'openai'): LinkedAccountRow {
  return { id: randomUUID(), provider, userId: randomUUID() } as LinkedAccountRow;
}

/** Spec 032 T044: the daily sweep over linked accounts, with its collaborators doubled. */
describe('LinkedAccountHealthConsumer', () => {
  const db = {} as ForgeDatabase;
  let pages: LinkedAccountRow[][];
  let stale: ReturnType<typeof vi.fn<LinkedAccountRepository['staleForSweep']>>;
  let verify: ReturnType<typeof vi.fn<ByosTokenService['verify']>>;
  let consumer: LinkedAccountHealthConsumer;
  let warnings: string[];

  beforeEach(() => {
    pages = [];
    stale = vi.fn(() => Promise.resolve(pages.shift() ?? []));
    verify = vi.fn(() => Promise.resolve({} as Awaited<ReturnType<ByosTokenService['verify']>>));
    const providers = {
      offeredList: () => Promise.resolve(['anthropic', 'openai']),
    } as unknown as ByosProviders;
    const clock: ClockPort = { now: () => FROZEN };
    consumer = new LinkedAccountHealthConsumer(
      db,
      providers,
      { staleForSweep: stale } as unknown as LinkedAccountRepository,
      { verify } as unknown as ByosTokenService,
      clock,
    );
    warnings = [];
    vi.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
      warnings.push(String(message));
    });
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is on byos.health, the events profile, three attempts', () => {
    expect(consumer.queue).toBe(BYOS_HEALTH_QUEUE);
    expect(consumer.queue).toBe('byos.health');
    expect(consumer.profile).toBe('events');
    expect(consumer.attempts).toBe(3);
    expect(consumer.types).toEqual(['maintenance.due']);
  });

  it('handles byos.verify and no other job, keyed per period', async () => {
    await expect(consumer.handle(due('byos.verify'))).resolves.toBe(true);
    await expect(consumer.handle(due('byok.verify'))).resolves.toBe(false);
    expect(consumer.jobId(due('byos.verify'))).toBe(
      `byos.verify.${String(FROZEN.getTime())}.health`,
    );
  });

  it('an ignored job sweeps nothing', async () => {
    await consumer.effect(due('byok.verify'), false);
    expect(stale).not.toHaveBeenCalled();
  });

  it('verifies each stale account of an offered provider, as its owner', async () => {
    const rows = [account('openai'), account('anthropic')];
    pages = [rows];

    await consumer.effect(due('byos.verify'), true);

    expect(stale).toHaveBeenCalledWith(
      db,
      ['anthropic', 'openai'],
      new Date(FROZEN.getTime() - CHECKED_WITHIN_MS),
      SWEEP_PAGE,
    );
    expect(verify.mock.calls).toEqual(rows.map((row) => [row.userId, row.provider]));
  });

  it('walks full pages until a short one', async () => {
    const first = Array.from({ length: SWEEP_PAGE }, () => account());
    const second = [account()];
    pages = [first, second];

    expect(await consumer.sweep()).toBe(SWEEP_PAGE + 1);
    expect(stale).toHaveBeenCalledTimes(2);
  });

  it('one row failing is logged by class and the sweep carries on, never throwing', async () => {
    const rows = [account(), account()];
    pages = [rows];
    verify.mockRejectedValueOnce(new ProviderError('rate-limited'));

    expect(await consumer.sweep()).toBe(1);
    expect(verify).toHaveBeenCalledTimes(2);
    expect(warnings).toEqual([
      `BYOS sweep skipped [user=${rows[0]!.userId} provider=openai class=ProviderError]`,
    ]);
  });

  it('a full page of rows that keep failing is not walked again (no tight loop)', async () => {
    const rows = Array.from({ length: SWEEP_PAGE }, () => account());
    stale.mockImplementation(() => Promise.resolve(rows));
    verify.mockRejectedValue(new ProviderError('rate-limited'));

    expect(await consumer.sweep()).toBe(0);
    expect(stale).toHaveBeenCalledTimes(2);
    expect(verify).toHaveBeenCalledTimes(SWEEP_PAGE);
  });
});
