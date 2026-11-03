import { runLineResponseSchema } from '@repo/contracts';
import type { AgentRun } from '@repo/db';
import { describe, expect, it, vi } from 'vitest';

import type { TenantTransaction } from '../../database/database.types';
import { RunLineService } from './run-line.service';
import type { RunStore } from './run-store';

const ORG = 'c3300000-0000-4000-8000-000000000001';
const PROJECT = 'c3300000-0000-4000-8000-000000000002';
const ANA = 'c3300000-0000-4000-8000-00000000000a';
const BEN = 'c3300000-0000-4000-8000-00000000000b';
const HOLDER = 'c3300000-0000-4000-8000-000000000011';
const FIRST = 'c3300000-0000-4000-8000-000000000012';
const SECOND = 'c3300000-0000-4000-8000-000000000013';

function run(id: string, userId: string, overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    createdAt: new Date('2026-09-23T10:00:00.000Z'),
    id,
    startedAt: null,
    status: 'queued',
    userId,
    ...overrides,
  } as AgentRun;
}

function setup(holder: AgentRun | undefined, line: AgentRun[]) {
  const where = vi.fn(() =>
    Promise.resolve([
      { email: 'ana@example.test', id: ANA },
      { email: 'ben@example.test', id: BEN },
    ]),
  );
  const tx = { select: () => ({ from: () => ({ where }) }) } as unknown as TenantTransaction;
  const store = {
    holder: vi.fn(() => Promise.resolve(holder)),
    line: vi.fn(() => Promise.resolve(line)),
  };

  return { service: new RunLineService(store as unknown as RunStore), store, tx };
}

/** Spec 031 contracts/run-line.md § 2: who holds the project, and who waits behind them. */
describe('RunLineService', () => {
  it('answers holder and waiting with positions and starter emails', async () => {
    const { service, store, tx } = setup(
      run(HOLDER, ANA, { startedAt: new Date(), status: 'awaiting_input' }),
      [
        run(FIRST, BEN, { createdAt: new Date('2026-09-23T10:00:01.000Z') }),
        run(SECOND, ANA, { createdAt: new Date('2026-09-23T10:00:02.000Z') }),
      ],
    );
    const answer = await service.read(tx, ORG, PROJECT);

    expect(store.holder).toHaveBeenCalledWith(tx, ORG, PROJECT);
    expect(store.line).toHaveBeenCalledWith(tx, ORG, PROJECT);
    expect(runLineResponseSchema.parse(answer)).toEqual(answer);
    expect(answer).toEqual({
      holder: {
        runId: HOLDER,
        startedBy: { email: 'ana@example.test', userId: ANA },
        status: 'awaiting_input',
      },
      waiting: [
        {
          createdAt: '2026-09-23T10:00:01.000Z',
          position: 1,
          runId: FIRST,
          startedBy: { email: 'ben@example.test', userId: BEN },
        },
        {
          createdAt: '2026-09-23T10:00:02.000Z',
          position: 2,
          runId: SECOND,
          startedBy: { email: 'ana@example.test', userId: ANA },
        },
      ],
    });
  });

  it('answers a resumed holder whose status is queued as the holder, not as waiting', async () => {
    const { service, tx } = setup(
      run(HOLDER, ANA, { startedAt: new Date(), status: 'queued' }),
      [],
    );
    const answer = await service.read(tx, ORG, PROJECT);

    expect(answer.holder).toMatchObject({ runId: HOLDER, status: 'queued' });
    expect(answer.waiting).toEqual([]);
  });
});
