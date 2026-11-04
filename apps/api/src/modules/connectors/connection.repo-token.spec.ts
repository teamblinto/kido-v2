import type { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeClock } from '../../common/clock/fake-clock';
import { plaintext } from '../../common/crypto/branded';
import type { DekService } from '../../common/crypto/dek.service';
import type { Environment } from '../../config/environment';
import type { TenantTransaction } from '../../database/database.types';
import type { AuditService } from '../audit/audit.service';
import type { ConnectionRepository } from './connection.repository';
import { ConnectionService } from './connection.service';
import { GithubApiError, type GithubAppClient } from './github-app.client';
import type { InstallStateStore } from './install-state';
import type { OperationService } from './operation.service';
import type { ProviderVerifiers } from './providers/provider';
import type { SupabaseClient } from './providers/supabase/supabase.client';
import type { RepoLinkRepository } from './repo-link.repository';

const TX = { tag: 'tx' } as unknown as TenantTransaction;
const MINTED = { expiresAt: new Date(0), token: plaintext('ghs_test') };
const WIDE = { contents: 'write', metadata: 'read', workflows: 'write' };
const NARROW = { contents: 'write', metadata: 'read' };

/** Spec 044 "GitHub App settings": ask for `workflows`, fall back narrower, never wider. */
describe('ConnectionService.repositoryToken', () => {
  let mintToken: ReturnType<typeof vi.fn>;
  let recordFailure: ReturnType<typeof vi.fn>;
  let recordSuccess: ReturnType<typeof vi.fn>;
  let service: ConnectionService;

  beforeEach(() => {
    const row = {
      circuitOpenUntil: null,
      health: 'healthy',
      id: 'conn',
      installationId: 7,
      orgId: 'org',
      provider: 'github',
      removalRequestedAt: null,
    };

    mintToken = vi.fn(() => Promise.resolve(MINTED));
    recordFailure = vi.fn(() => Promise.resolve());
    recordSuccess = vi.fn(() => Promise.resolve());
    service = new ConnectionService(
      { mintToken } as unknown as GithubAppClient,
      {
        byId: () => Promise.resolve(row),
        byProvider: () => Promise.resolve(row),
        recordFailure,
        recordSuccess,
      } as unknown as ConnectionRepository,
      {} as RepoLinkRepository,
      {} as InstallStateStore,
      {} as DekService,
      {} as AuditService,
      new FakeClock('2026-11-04T10:00:00.000Z'),
      new Map() as ProviderVerifiers,
      {} as SupabaseClient,
      {} as OperationService,
      { get: () => 'https://github.com' } as unknown as ConfigService<Environment, true>,
    );
  });

  const mint = () => service.repositoryToken(TX, 'org', 501);

  it('asks for workflows, for the one repository', async () => {
    await expect(mint()).resolves.toBe(MINTED.token);

    expect(mintToken).toHaveBeenCalledOnce();
    expect(mintToken).toHaveBeenCalledWith(7, { permissions: WIDE, repositoryIds: [501] });
  });

  it('an App without the permission: a 422, then the narrower token, and no breaker count', async () => {
    mintToken.mockRejectedValueOnce(new GithubApiError('validation', 422));

    await expect(mint()).resolves.toBe(MINTED.token);

    expect(mintToken).toHaveBeenCalledTimes(2);
    expect(mintToken).toHaveBeenLastCalledWith(7, { permissions: NARROW, repositoryIds: [501] });
    expect(recordFailure).not.toHaveBeenCalled();
    expect(recordSuccess).toHaveBeenCalledOnce();
  });

  it('a 422 on the narrow ask too is a repository out of reach: repo-gone, not an outage', async () => {
    mintToken.mockRejectedValue(new GithubApiError('validation', 422));

    await expect(mint()).rejects.toMatchObject({ extensions: { reason: 'repo-gone' } });

    expect(mintToken).toHaveBeenCalledTimes(2);
    expect(recordFailure).not.toHaveBeenCalled();
  });

  it.each([
    ['unavailable', 503],
    ['rate-limited', 429],
  ] as const)(
    '%s is not a permissions answer: one ask, the breaker counts',
    async (category, status) => {
      mintToken.mockRejectedValueOnce(new GithubApiError(category, status));

      await expect(mint()).rejects.toMatchObject({ type: 'service-unavailable' });

      expect(mintToken).toHaveBeenCalledOnce();
      expect(recordFailure).toHaveBeenCalledOnce();
    },
  );
});
