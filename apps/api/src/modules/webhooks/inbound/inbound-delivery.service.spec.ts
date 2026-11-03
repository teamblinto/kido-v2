import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { APP_DATABASE } from '../../../database/database.constants';
import type { ForgeDatabase } from '../../../database/database.types';
import { WebhookDeliveryRepository, type WebhookDeliveryRow } from './inbound-delivery.repository';
import { InboundDeliveryService } from './inbound-delivery.service';

const DB = { marker: 'app-database' } as unknown as ForgeDatabase;
const ID = '9f1d4c22-3f0e-4c66-9f93-2c0b7d9f5a31';

const ROW: WebhookDeliveryRow = {
  attempts: 1,
  body: { ref: 'refs/heads/main' },
  eventType: 'push',
  id: ID,
  installationId: 42_000_123,
  state: 'received',
};

/**
 * Spec 029 T086 — the one door `connectors` has onto `webhook_deliveries`. The boundaries refuse
 * `connectors` the repository itself (`no-foreign-repository`), so what the consumer reads and
 * writes of a delivery goes through here, on the application database, and nothing more.
 */
describe('InboundDeliveryService', () => {
  const repository = {
    byId: vi.fn<WebhookDeliveryRepository['byId']>(),
    settle: vi.fn<WebhookDeliveryRepository['settle']>(),
  };
  let service: InboundDeliveryService;

  beforeEach(async () => {
    vi.resetAllMocks();

    const moduleRef = await Test.createTestingModule({
      providers: [
        InboundDeliveryService,
        { provide: APP_DATABASE, useValue: DB },
        { provide: WebhookDeliveryRepository, useValue: repository },
      ],
    }).compile();

    service = moduleRef.get(InboundDeliveryService);
  });

  it('byId returns the row the repository read on the application database', async () => {
    repository.byId.mockResolvedValue(ROW);

    await expect(service.byId(ID)).resolves.toBe(ROW);
    expect(repository.byId).toHaveBeenCalledWith(DB, ID);
  });

  it('byId returns null for a delivery that is gone', async () => {
    repository.byId.mockResolvedValue(undefined);

    await expect(service.byId(ID)).resolves.toBeNull();
  });

  it('settle delegates the state, the attempt and the failure', async () => {
    repository.settle.mockResolvedValue();

    await service.settle(ID, 'failed', 5, 'processing-failed');

    expect(repository.settle).toHaveBeenCalledWith(DB, ID, 'failed', 5, 'processing-failed');
  });

  it('settle passes a null failure when none is given', async () => {
    repository.settle.mockResolvedValue();

    await service.settle(ID, 'processed', 1);

    expect(repository.settle).toHaveBeenCalledWith(DB, ID, 'processed', 1, null);
  });
});
