import { describe, expect, it, vi } from 'vitest';

import type { TenantTransaction } from '../../database/database.types';
import type { TenantTransactionRunner } from '../../database/tenant-transaction';
import type { AuditService } from '../audit/audit.service';
import type { Envelope } from '../outbox/envelope';
import type { SandboxPort } from '../sandbox/sandbox.port';
import type { CredentialResolver } from './byok/credential-resolver';
import { ProjectNamingConsumer } from './project-naming.consumer';

const ORG = '0b4f7b7e-1a37-4b8e-9c3d-0f3b8a4d2a11';
const PROJECT = '9c2a3c3e-5f6d-4a1b-8e2f-7d6c5b4a3f21';
const USER = '5d2a3c3e-5f6d-4a1b-8e2f-7d6c5b4a3f99';

const event = {
  payload: { orgId: ORG, projectId: PROJECT },
  type: 'project.naming.requested',
} as unknown as Envelope<'project.naming.requested'>;

/** Selects answer `rows` in order; an update records its values and answers `renamed` rows. */
function tx(rows: unknown[][], renamed: unknown[] = [{ id: PROJECT }]) {
  const queue = [...rows];
  const updates: unknown[] = [];
  const chain = (): unknown => {
    const result = queue.shift() ?? [];
    const link: Record<string, unknown> = {
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
    };
    for (const method of ['from', 'where', 'orderBy', 'limit', 'innerJoin'])
      link[method] = () => link;
    return link;
  };
  const handle = {
    execute: () => Promise.resolve(undefined),
    select: chain,
    update: () => ({
      set: (values: unknown) => {
        updates.push(values);
        return { where: () => ({ returning: () => Promise.resolve(renamed) }) };
      },
    }),
  } as unknown as TenantTransaction;
  return { handle, updates };
}

function build({
  answer = 'Rota Board',
  credential = true,
  handle,
  readme,
}: {
  answer?: string;
  credential?: boolean;
  handle: TenantTransaction;
  readme?: string;
}) {
  const record = vi.fn();
  const complete = vi.fn().mockResolvedValue({ text: answer });
  const consumer = new ProjectNamingConsumer(
    {
      forModel: () =>
        Promise.resolve(
          credential
            ? { credential: { apiKey: 'k', mode: 'BYOK', provider: 'anthropic' }, kind: 'byok' }
            : { kind: 'no-credential' },
        ),
    } as unknown as CredentialResolver,
    { client: () => ({ complete }) },
    { record } as unknown as AuditService,
    {
      runInTenantScope: (_scope: unknown, fn: (t: TenantTransaction) => Promise<unknown>) =>
        fn(handle),
    } as unknown as TenantTransactionRunner,
    {
      read: (_ref: unknown, path: string) => {
        if (path === 'README.md' && readme !== undefined) return Promise.resolve(readme);
        return Promise.reject(new Error('path-not-found'));
      },
    } as unknown as SandboxPort,
  );
  return { complete, consumer, record };
}

/** The user turn of the first naming call. */
const firstPrompt = (complete: ReturnType<typeof vi.fn>): string =>
  (complete.mock.calls[0]![0] as { messages: { content: string }[] }).messages[0]!.content;

describe('ProjectNamingConsumer', () => {
  it('does nothing for a project whose name a person chose', async () => {
    const { handle } = tx([[{ namePending: false }]]);

    await expect(build({ handle }).consumer.handle(event, handle)).resolves.toBeUndefined();
  });

  it('names a prompt project from its first message, and audits the generated name', async () => {
    const { handle, updates } = tx([
      [{ namePending: true }],
      [{ content: 'A weekly on-call rota board for my team', userId: USER }],
      [],
      [],
    ]);
    const { complete, consumer, record } = build({ handle });

    const plan = await consumer.handle(event, handle);
    expect(plan).toEqual({
      prompt: 'A weekly on-call rota board for my team',
      repository: null,
      userId: USER,
    });

    await consumer.effect(event, plan);

    expect(firstPrompt(complete)).toContain('on-call rota board');
    expect(updates).toEqual([{ name: 'Rota Board', namePending: false }]);
    expect(record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'project.named' }),
    );
  });

  it('names an import from its repository and README', async () => {
    const { handle, updates } = tx([]);
    const { complete, consumer } = build({
      answer: '"Acme Rota".',
      handle,
      readme: '# Acme\n\nA rota board for engineering teams on call.',
    });

    await consumer.effect(event, { prompt: null, repository: 'acme/rota', userId: USER });

    expect(firstPrompt(complete)).toContain('Repository: acme/rota');
    expect(firstPrompt(complete)).toContain('A rota board for engineering teams');
    expect(updates).toEqual([{ name: 'Acme Rota', namePending: false }]);
  });

  it('keeps the provisional name when nothing can pay for a naming call, and stops asking', async () => {
    const { handle, updates } = tx([]);
    const { complete, consumer, record } = build({ credential: false, handle });

    await consumer.effect(event, { prompt: 'Build a chess app', repository: null, userId: USER });

    expect(complete).not.toHaveBeenCalled();
    expect(updates).toEqual([{ namePending: false }]);
    expect(record).not.toHaveBeenCalled();
  });

  it('a rename that landed first wins: the conditional update matches nothing and nothing is audited', async () => {
    const { handle } = tx([], []);
    const { consumer, record } = build({ handle });

    await consumer.effect(event, { prompt: 'Build a chess app', repository: null, userId: USER });

    expect(record).not.toHaveBeenCalled();
  });

  it('discards an answer that is not a name', async () => {
    const { handle, updates } = tx([]);
    const { consumer } = build({
      answer: 'Here are some ideas for naming your wonderful new project today',
      handle,
    });

    await consumer.effect(event, { prompt: 'Build a chess app', repository: null, userId: USER });

    expect(updates).toEqual([{ namePending: false }]);
  });
});
