import { describe, expect, it } from 'vitest';

import {
  CONNECTOR_HEALTH,
  CONNECTOR_PROVIDERS,
  completeInstallRequestSchema,
  connectionListSchema,
  connectionSchema,
  installResponseSchema,
  repositoryPageSchema,
  repositoryQuerySchema,
  repositorySchema,
} from './connection';

const UUID = '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5a';

const connection = {
  account: { id: 42, login: 'acme', type: 'organization' },
  canCreateRepositories: true,
  circuitOpenUntil: null,
  connectedAt: '2026-09-20T10:00:00.000Z',
  connectedBy: { id: UUID, name: 'Ada' },
  credentialFingerprint: 'sha256:abc',
  health: 'healthy',
  id: UUID,
  lastVerifiedAt: null,
  provider: 'github',
};

const repository = {
  defaultBranch: 'main',
  fullName: 'acme/app',
  id: 7,
  name: 'app',
  owner: 'acme',
  private: true,
};

describe('connection enums', () => {
  it('match contracts § 1', () => {
    expect(CONNECTOR_PROVIDERS).toEqual([
      'github',
      'netlify',
      'supabase',
      'neon',
      'resend',
      'cloudflare',
    ]);
    expect(CONNECTOR_HEALTH).toEqual(['healthy', 'needs_reauth', 'unavailable']);
  });
});

const providerConnection = {
  account: { name: 'Acme', ref: 'org-acme' },
  authType: 'token',
  connectedAt: '2026-09-23T10:00:00.000Z',
  connectedBy: { id: UUID, name: 'Ada' },
  credentialFingerprint: 'sha256:def',
  failedResources: [],
  health: 'healthy',
  id: UUID,
  lastVerifiedAt: null,
  provider: 'neon',
  removalRequestedAt: null,
  scopes: ['projects:read'],
};

describe('connectionSchema, the spec 030 provider arm', () => {
  it('accepts a pasted-token connection and never a token field', () => {
    expect(connectionSchema.safeParse(providerConnection)).toEqual({
      data: providerConnection,
      success: true,
    });
    expect(connectionSchema.safeParse({ ...providerConnection, token: 'napi_x' }).success).toBe(
      false,
    );
  });

  it('keeps the arms apart: a GitHub shape under a new provider, or the reverse, is refused', () => {
    expect(connectionSchema.safeParse({ ...connection, provider: 'neon' }).success).toBe(false);
    expect(connectionSchema.safeParse({ ...providerConnection, provider: 'github' }).success).toBe(
      false,
    );
  });

  it('carries a removal in progress and the resources a removal could not release', () => {
    const removing = {
      ...providerConnection,
      failedResources: [{ kind: 'neon_branch', name: 'forge-preview-x' }],
      removalRequestedAt: '2026-09-23T11:00:00.000Z',
    };

    expect(connectionSchema.parse(removing)).toEqual(removing);
  });
});

describe('connectionSchema', () => {
  it('accepts a healthy connection and never a token field', () => {
    expect(connectionSchema.safeParse(connection)).toEqual({ data: connection, success: true });
    expect(connectionSchema.safeParse({ ...connection, token: 'ghs_x' }).success).toBe(false);
  });

  it('refuses an unknown health or account type', () => {
    expect(connectionSchema.safeParse({ ...connection, health: 'broken' }).success).toBe(false);
    expect(
      connectionSchema.safeParse({ ...connection, account: { ...connection.account, type: 'bot' } })
        .success,
    ).toBe(false);
  });

  it('lists connections strictly', () => {
    expect(connectionListSchema.safeParse({ connections: [connection] }).success).toBe(true);
    expect(connectionListSchema.safeParse({ connections: [], extra: 1 }).success).toBe(false);
  });
});

describe('installResponseSchema / completeInstallRequestSchema', () => {
  it('carries the install url', () => {
    expect(installResponseSchema.safeParse({ installUrl: 'https://github.com/x' }).success).toBe(
      true,
    );
    expect(installResponseSchema.safeParse({ installUrl: 'not a url' }).success).toBe(false);
  });

  it('accepts a positive integer installation id and a state', () => {
    expect(completeInstallRequestSchema.safeParse({ installationId: 1, state: 's' }).success).toBe(
      true,
    );
    expect(completeInstallRequestSchema.safeParse({ installationId: 0, state: 's' }).success).toBe(
      false,
    );
    expect(
      completeInstallRequestSchema.safeParse({ installationId: 1.5, state: 's' }).success,
    ).toBe(false);
    expect(completeInstallRequestSchema.safeParse({ installationId: 1, state: '' }).success).toBe(
      false,
    );
  });

  it('refuses an undeclared field', () => {
    expect(
      completeInstallRequestSchema.safeParse({ code: 'x', installationId: 1, state: 's' }).success,
    ).toBe(false);
  });
});

describe('repositorySchema / repositoryPageSchema / repositoryQuerySchema', () => {
  it('accepts a repository and a page', () => {
    expect(repositorySchema.safeParse(repository).success).toBe(true);
    expect(repositoryPageSchema.safeParse({ repositories: [repository] }).success).toBe(true);
    expect(
      repositoryPageSchema.safeParse({ nextCursor: 'abc', repositories: [repository] }).success,
    ).toBe(true);
  });

  it('refuses an undeclared field', () => {
    expect(repositorySchema.safeParse({ ...repository, extra: 1 }).success).toBe(false);
    expect(repositoryPageSchema.safeParse({ extra: 1, repositories: [] }).success).toBe(false);
  });

  it('takes an optional query and cursor, nothing else', () => {
    expect(repositoryQuerySchema.safeParse({}).success).toBe(true);
    expect(repositoryQuerySchema.safeParse({ cursor: 'abc', query: 'app' }).success).toBe(true);
    expect(repositoryQuerySchema.safeParse({ limit: 5 }).success).toBe(false);
  });
});
