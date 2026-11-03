import { cloudflareOfferSchema } from '@repo/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { TenantContext } from '../../../database/tenant-context';
import { REQUIRES_STEP_UP } from '../../identity/decorators/step-up.decorator';
import type { AuthenticatedUser } from '../../identity/services/session.service';
import { REQUIRED_PERMISSION } from '../../rbac/decorators/require-permission.decorator';
import { ORG_ROLE_PERMISSIONS } from '../../rbac/permissions';
import type { CloudflareDnsService } from '../cloudflare-dns.service';
import { CloudflareDnsController } from './cloudflare-dns.controller';

const ORG = '11111111-1111-4111-8111-111111111111';
const DOMAIN = '22222222-2222-4222-8222-222222222222';
const USER = '66666666-6666-4666-8666-666666666666';
const TX = { tag: 'tx' } as unknown as TenantContext['tx'];
const CALLER = { userId: USER } as AuthenticatedUser;

function build(overrides: Partial<CloudflareDnsService>) {
  return new CloudflareDnsController(
    { tx: TX } as TenantContext,
    overrides as unknown as CloudflareDnsService,
  );
}

function metadataOf(key: string | symbol, handler: string): unknown {
  return Reflect.getMetadata(
    key,
    Object.getOwnPropertyDescriptor(CloudflareDnsController.prototype, handler)!.value as object,
  );
}

/** Spec 030 T057, contracts/bindings.md § 3. */
describe('CloudflareDnsController', () => {
  it('demands org:domains.manage of both routes, and step-up of the write only', () => {
    for (const handler of ['offer', 'write']) {
      expect(metadataOf(REQUIRED_PERMISSION, handler)).toMatchObject({
        permission: 'org:domains.manage',
      });
    }
    expect(metadataOf(REQUIRES_STEP_UP, 'write')).toBe(true);
    expect(metadataOf(REQUIRES_STEP_UP, 'offer')).toBeUndefined();
    expect(ORG_ROLE_PERMISSIONS.member).not.toContain('org:domains.manage');
  });

  it('offer answers the service offer for the org and domain on the request transaction', async () => {
    const answer = cloudflareOfferSchema.parse({ records: [], status: 'not-connected' });
    const offer = vi.fn().mockResolvedValue(answer);

    await expect(build({ offer }).offer(ORG, DOMAIN)).resolves.toBe(answer);
    expect(offer).toHaveBeenCalledWith(TX, ORG, DOMAIN);
  });

  it('write queues as the caller and answers the operation', async () => {
    const operation = { id: 'op', kind: 'dns_write' };
    const requestWrite = vi.fn().mockResolvedValue(operation);

    await expect(build({ requestWrite }).write(CALLER, ORG, DOMAIN)).resolves.toBe(operation);
    expect(requestWrite).toHaveBeenCalledWith(TX, ORG, USER, DOMAIN);
  });
});
