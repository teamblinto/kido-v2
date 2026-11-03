import { describe, expect, it, vi } from 'vitest';

import type { TenantTransaction } from '../../../database/database.types';
import type { OutboxWriter } from '../../outbox/outbox-writer';
import type { MembershipService } from '../../tenancy/services/membership.service';
import { DomainNotices } from './domain-notices';

const ORG_ID = '0b7d3c1a-2e4f-4a5b-8c6d-7e8f9a0b1c2d';
const DOMAIN_ID = '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d';
const OWNER = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const ADDER = '2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a';

/**
 * Spec 028 research R14: the settle's side of a notice. Recipients come from tenancy's
 * `noticeRecipients` (stubbed here; its own cases are in `membership.service.spec.ts`), and each
 * gets its own `mail.domain` event on the settle's transaction, carrying ids only.
 */
describe('DomainNotices', () => {
  const tx = { settle: true } as unknown as TenantTransaction;

  function notices(recipients: string[]) {
    const noticeRecipients = vi.fn().mockResolvedValue(recipients);
    const append = vi.fn().mockResolvedValue({ eventId: 'e' });
    const service = new DomainNotices(
      { noticeRecipients } as unknown as MembershipService,
      { append } as unknown as OutboxWriter,
    );

    return { append, noticeRecipients, service };
  }

  it('asks tenancy for the owners and the member who added the domain, on the same transaction', async () => {
    const { noticeRecipients, service } = notices([OWNER]);

    await service.append(tx, { addedBy: ADDER, id: DOMAIN_ID, orgId: ORG_ID }, 'drifted');

    expect(noticeRecipients).toHaveBeenCalledWith(tx, ORG_ID, ADDER);
  });

  it('appends one mail.domain event per recipient, on the settle’s transaction', async () => {
    const { append, service } = notices([OWNER, ADDER]);

    const recipients = await service.append(
      tx,
      { addedBy: ADDER, id: DOMAIN_ID, orgId: ORG_ID },
      'released',
    );

    expect(recipients).toEqual([OWNER, ADDER]);
    expect(append).toHaveBeenCalledTimes(2);
    for (const recipient of [OWNER, ADDER]) {
      expect(append).toHaveBeenCalledWith(tx, {
        aggregateId: DOMAIN_ID,
        orgId: ORG_ID,
        payload: { domainId: DOMAIN_ID, notice: 'released', recipient },
        type: 'mail.domain',
      });
    }
  });

  it('passes a null added_by through, and appends nothing when nobody is left to tell', async () => {
    const { append, noticeRecipients, service } = notices([]);

    await service.append(tx, { addedBy: null, id: DOMAIN_ID, orgId: ORG_ID }, 'failed');

    expect(noticeRecipients).toHaveBeenCalledWith(tx, ORG_ID, null);
    expect(append).not.toHaveBeenCalled();
  });
});
