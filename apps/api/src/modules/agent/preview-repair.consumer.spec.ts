import type { RunConfig } from '@repo/contracts';
import { describe, expect, it, vi } from 'vitest';

import { DomainError } from '../../common/errors/domain-error';
import type { TenantTransaction } from '../../database/database.types';
import type { TenantTransactionRunner } from '../../database/tenant-transaction';
import type { AuditService } from '../audit/audit.service';
import type { Envelope } from '../outbox/envelope';
import type { SandboxPort } from '../sandbox/sandbox.port';
import { PreviewRepairConsumer, repairPrompt } from './preview-repair.consumer';
import type { RunService } from './run.service';
import type { RunStore } from './run-store';

const ORG = '0b4f7b7e-1a37-4b8e-9c3d-0f3b8a4d2a11';
const PROJECT = '9c2a3c3e-5f6d-4a1b-8e2f-7d6c5b4a3f21';
const USER = '5d2a3c3e-5f6d-4a1b-8e2f-7d6c5b4a3f99';

const profile: RunConfig = {
  build: null,
  dev: 'npm run dev -- --host 0.0.0.0 --port 3000 --strictPort',
  env: ['DATABASE_URL'],
  install: 'npm ci --no-audit --no-fund',
  port: 3000,
  repairs: 1,
  root: '.',
  source: 'detected',
  stack: { framework: 'vite-react', language: 'typescript', packageManager: 'npm' },
};

const event = (attempt = 1): Envelope<'project.preview.failed'> =>
  ({
    id: 'evt',
    payload: { attempt, orgId: ORG, projectId: PROJECT },
    type: 'project.preview.failed',
  }) as unknown as Envelope<'project.preview.failed'>;

/**
 * A transaction whose selects answer `rows` in order, whatever the chain: the consumer's reads are
 * the project, then (when it gets that far) the last run, then the import.
 */
function txAnswering(...rows: unknown[][]): TenantTransaction {
  const queue = [...rows];
  const chain = (): unknown => {
    const result = queue.shift() ?? [];
    const link: Record<string, unknown> = {
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
    };
    for (const method of ['from', 'where', 'orderBy', 'limit']) link[method] = () => link;
    return link;
  };
  return {
    execute: () => Promise.resolve(undefined),
    select: chain,
  } as unknown as TenantTransaction;
}

function build({
  create = vi.fn(),
  holder,
  line = [],
}: { create?: ReturnType<typeof vi.fn>; holder?: unknown; line?: unknown[] } = {}) {
  const record = vi.fn();
  const consumer = new PreviewRepairConsumer(
    { create } as unknown as RunService,
    {
      holder: () => Promise.resolve(holder),
      line: () => Promise.resolve(line),
    } as unknown as RunStore,
    {
      previewLogs: () => Promise.resolve('Error: Cannot find module "vite"'),
    } as unknown as SandboxPort,
    { record } as unknown as AuditService,
    {
      runInTenantScope: (_scope: unknown, fn: (tx: TenantTransaction) => Promise<unknown>) =>
        fn({} as TenantTransaction),
    } as unknown as TenantTransactionRunner,
  );
  return { consumer, create, record };
}

describe('PreviewRepairConsumer', () => {
  it('plans a repair paid for by whoever last ran the project', async () => {
    const { consumer } = build();

    await expect(
      consumer.handle(event(), txAnswering([{ runConfig: profile }], [{ userId: USER }])),
    ).resolves.toEqual({ config: profile, userId: USER });
  });

  it('falls back to the person who imported it when nobody has run it yet', async () => {
    const { consumer } = build();

    await expect(
      consumer.handle(event(), txAnswering([{ runConfig: profile }], [], [{ userId: USER }])),
    ).resolves.toEqual({ config: profile, userId: USER });
  });

  it('never repairs a template project, nor while a run is working or waiting', async () => {
    expect(
      await build().consumer.handle(event(), txAnswering([{ runConfig: null }])),
    ).toBeUndefined();
    expect(
      await build({ holder: { id: 'run' } }).consumer.handle(
        event(),
        txAnswering([{ runConfig: profile }]),
      ),
    ).toBeUndefined();
    expect(
      await build({ line: [{ id: 'run' }] }).consumer.handle(
        event(),
        txAnswering([{ runConfig: profile }]),
      ),
    ).toBeUndefined();
  });

  it('starts the run on the subscription first, and audits it', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'run-1' });
    const { consumer, record } = build({ create });

    await consumer.effect(event(2), { config: profile, userId: USER });

    expect(create).toHaveBeenCalledOnce();
    const [org, project, user, prompt, model, credential, subscription] = create.mock
      .calls[0] as unknown[];
    expect([org, project, user, model, credential, subscription]).toEqual([
      ORG,
      PROJECT,
      USER,
      undefined,
      undefined,
      { provider: 'claude' },
    ]);
    expect(prompt).toContain('failed to start again');
    expect(prompt).toContain('Cannot find module "vite"');
    expect(record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'project.preview-repair-started' }),
    );
  });

  it('falls back to the organisation’s key when there is no subscription, and gives up quietly after', async () => {
    const refused = new DomainError(
      'subscription-not-connected',
      'Connect your Claude subscription.',
    );
    const create = vi.fn().mockRejectedValueOnce(refused).mockResolvedValueOnce({ id: 'run-2' });
    await build({ create }).consumer.effect(event(), { config: profile, userId: USER });

    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1]![6]).toBeUndefined();

    const never = vi.fn().mockRejectedValue(refused);
    await expect(
      build({ create: never }).consumer.effect(event(), { config: profile, userId: USER }),
    ).resolves.toBeUndefined();
    expect(never).toHaveBeenCalledTimes(2);
  });
});

describe('repairPrompt', () => {
  it('names the stack, the profile and the expected variables, and fences the log as output', () => {
    const prompt = repairPrompt(profile, 'boom', 1);

    expect(prompt).toContain('vite-react · typescript · npm');
    expect(prompt).toContain('dev=`npm run dev -- --host 0.0.0.0 --port 3000 --strictPort`');
    expect(prompt).toContain('DATABASE_URL');
    expect(prompt).toContain('```text\nboom\n```');
  });

  it('says plainly when the runtime cannot be installed here', () => {
    const ruby = {
      ...profile,
      dev: null,
      port: null,
      stack: { framework: 'rails', language: 'ruby', packageManager: null },
    };

    expect(repairPrompt(ruby, '', 1)).toContain('no ruby toolchain');
    expect(repairPrompt(ruby, '', 1)).toContain('(no output yet)');
  });

  it('keeps only the tail of a huge log', () => {
    expect(repairPrompt(profile, `${'x'.repeat(20_000)}END`, 1).length).toBeLessThan(10_000);
  });
});
