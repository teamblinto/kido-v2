import { describe, expect, it, vi } from 'vitest';

import type { TenantTransaction } from '../../database/database.types';
import type { CheckpointService } from '../checkpoints/checkpoint.service';
import type { Envelope } from '../outbox/envelope';
import { AutoSyncConsumer, CONNECTOR_AUTOSYNC_QUEUE } from './autosync.consumer';
import type { SyncService } from './sync.service';

const REF = { orgId: 'org', projectId: 'project' };
const EVENT = {
  payload: { ...REF, checkpointId: 'cp' },
} as Envelope<'checkpoint.created'>;

function build(kind: string) {
  const execute = vi.fn(() => Promise.resolve());
  const byId = vi.fn(() => Promise.resolve({ id: 'cp', kind }));
  const requestAuto = vi.fn(() => Promise.resolve(null));
  const consumer = new AutoSyncConsumer(
    { byId } as unknown as CheckpointService,
    { requestAuto } as unknown as SyncService,
  );
  const tx = { execute } as unknown as TenantTransaction;

  return { byId, consumer, execute, requestAuto, tx };
}

describe('AutoSyncConsumer', () => {
  it('rides its own queue on the events lane, for the one event', () => {
    const { consumer } = build('turn');

    expect(consumer).toMatchObject({
      profile: 'events',
      queue: CONNECTOR_AUTOSYNC_QUEUE,
      types: ['checkpoint.created'],
    });
    expect(CONNECTOR_AUTOSYNC_QUEUE).toBe('connector.autosync');
  });

  it.each(['turn', 'edit', 'revert', 'baseline'])(
    'a %s checkpoint asks for a push, with the tenant set first',
    async (kind) => {
      const { byId, consumer, execute, requestAuto, tx } = build(kind);

      await consumer.handle(EVENT, tx);

      expect(execute).toHaveBeenCalledOnce();
      expect(execute.mock.invocationCallOrder[0]).toBeLessThan(byId.mock.invocationCallOrder[0]!);
      expect(byId).toHaveBeenCalledWith(tx, REF, 'cp');
      expect(requestAuto).toHaveBeenCalledWith(tx, REF);
    },
  );

  it('a pull came from GitHub and never goes back', async () => {
    const { consumer, requestAuto, tx } = build('pull');

    await consumer.handle(EVENT, tx);

    expect(requestAuto).not.toHaveBeenCalled();
  });

  it('a redelivery is harmless: the second ask is the service answering null', async () => {
    const { consumer, requestAuto, tx } = build('turn');

    await consumer.handle(EVENT, tx);
    await expect(consumer.handle(EVENT, tx)).resolves.toBeUndefined();

    expect(requestAuto).toHaveBeenCalledTimes(2);
  });
});
