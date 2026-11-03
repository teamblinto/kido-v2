import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LinkedAccountRow } from '@repo/db';

import { FakeClock } from '../../../common/clock/fake-clock';
import { plaintext } from '../../../common/crypto/branded';
import type { DekService } from '../../../common/crypto/dek.service';
import type { TenantTransaction } from '../../../database/database.types';
import type { OrgService } from '../../tenancy/services/org.service';
import type { ByosProviders } from '../byos/byos-providers';
import type { ByosTokenService } from '../byos/byos-token.service';
import type { LinkedAccountRepository } from '../byos/linked-account.repository';
import { SubscriptionFailure } from '../byos/subscription-client.port';
import type { CredentialContext } from '../llm-provider.port';
import { CredentialResolver } from './credential-resolver';
import type { ProviderKeyRecord, ProviderKeyRepository } from './provider-key.repository';

const ORG = '00000000-0000-0000-0000-00000000000a';
const TX = {} as TenantTransaction;
const ORG_KEY = 'sk-ant-org-key-0123456789abcdefghij';
const USER = '00000000-0000-0000-0000-0000000000a1';
const NOW = new Date('2026-09-24T10:00:00.000Z');
const LATER = new Date('2026-09-24T12:00:00.000Z');

function linkedRow(
  provider: 'anthropic' | 'openai',
  options: { health?: 'healthy' | 'needs_reauth'; limitedUntil?: Date | null } = {},
): LinkedAccountRow {
  return {
    accessExpiresAt: LATER,
    accountLabel: 'ada@example.com',
    createdAt: new Date(0),
    grantSealed: Buffer.from('sealed'),
    health: options.health ?? 'healthy',
    healthChanges: 0,
    id: `linked-${provider}`,
    lastCheckedAt: NOW,
    limitedUntil: options.limitedUntil ?? null,
    linkedAt: NOW,
    provider,
    updatedAt: new Date(0),
    userId: USER,
  };
}

function byosCredential(provider: 'anthropic' | 'openai'): CredentialContext {
  return {
    accountLabel: 'ada@example.com',
    apiKey: `sub-token-${provider}`,
    endpoint: { baseURL: 'https://sub.test/api', headers: {} },
    expiresAt: LATER,
    mode: 'BYOS',
    provider,
  };
}

function keyRow(
  provider: 'anthropic' | 'openai',
  health: ProviderKeyRecord['health'] = 'healthy',
): ProviderKeyRecord {
  return {
    addedBy: null,
    addedByName: null,
    createdAt: new Date(0),
    fingerprint: 'fp',
    health,
    id: `key-${provider}`,
    lastFour: 'ghij',
    lastVerifiedAt: null,
    orgId: ORG,
    provider,
    secretId: `secret-${provider}`,
    updatedAt: new Date(0),
  };
}

function harness(
  options: {
    keys?: ProviderKeyRecord[];
    linked?: LinkedAccountRow[];
    offered?: ('anthropic' | 'openai')[];
    allowed?: boolean;
    current?: () => Promise<CredentialContext>;
  } = {},
) {
  const keys = options.keys ?? [];
  const linked = options.linked ?? [];
  const accounts = {
    byProviderOn: vi.fn((_tx: TenantTransaction, _userId: string, provider: string) =>
      Promise.resolve(linked.find((row) => row.provider === provider)),
    ),
  };
  const providers = {
    offered: vi.fn((provider: 'anthropic' | 'openai') =>
      Promise.resolve((options.offered ?? ['anthropic', 'openai']).includes(provider)),
    ),
  };
  const orgs = { personalAccountsAllowed: vi.fn(() => Promise.resolve(options.allowed ?? true)) };
  const tokens = {
    current: vi.fn(
      options.current ??
        ((_userId: string, provider: 'anthropic' | 'openai') =>
          Promise.resolve(byosCredential(provider))),
    ),
  };
  const repository = {
    byProvider: vi.fn((_tx: TenantTransaction, _orgId: string, provider: string) =>
      Promise.resolve(keys.find((key) => key.provider === provider)),
    ),
    sealedSecret: vi.fn(() =>
      Promise.resolve({ ciphertext: Buffer.from('sealed'), dekId: 'dek-1' }),
    ),
  };
  const dek = { openSecret: vi.fn(() => Promise.resolve(plaintext(ORG_KEY))) };
  const resolver = new CredentialResolver(
    repository as unknown as ProviderKeyRepository,
    dek as unknown as DekService,
    orgs as unknown as OrgService,
    providers as unknown as ByosProviders,
    accounts as unknown as LinkedAccountRepository,
    tokens as unknown as ByosTokenService,
    new FakeClock(NOW),
  );

  return { accounts, dek, repository, resolver, tokens };
}

describe('CredentialResolver', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('answers unknown-model for an id the catalogue does not carry', async () => {
    const { dek, resolver } = harness();

    await expect(resolver.forModel(TX, ORG, USER, 'gpt-3')).resolves.toEqual({
      kind: 'unknown-model',
    });
    expect(dek.openSecret).not.toHaveBeenCalled();
  });

  it('answers byok on an Anthropic model when the org holds a healthy key', async () => {
    const { dek, resolver } = harness({ keys: [keyRow('anthropic')] });

    await expect(resolver.forModel(TX, ORG, USER, 'claude-sonnet-5')).resolves.toEqual({
      credential: { apiKey: ORG_KEY, keyLastFour: 'ghij', mode: 'BYOK', provider: 'anthropic' },
      keyId: 'key-anthropic',
      kind: 'byok',
    });
    expect(dek.openSecret).toHaveBeenCalledWith(TX, ORG, 'byok:anthropic:api-key', {
      ciphertext: Buffer.from('sealed'),
      dekId: 'dek-1',
    });
  });

  it('answers needs_reauth with the last four when the key is needs_reauth', async () => {
    const { dek, resolver } = harness({ keys: [keyRow('anthropic', 'needs_reauth')] });

    await expect(resolver.forModel(TX, ORG, USER, 'claude-sonnet-5')).resolves.toEqual({
      kind: 'needs_reauth',
      lastFour: 'ghij',
      provider: 'anthropic',
    });
    expect(dek.openSecret).not.toHaveBeenCalled();
  });

  it('answers no-credential on an OpenAI model with no key', async () => {
    const { resolver } = harness();

    await expect(resolver.forModel(TX, ORG, USER, 'gpt-5.2')).resolves.toEqual({
      kind: 'no-credential',
      provider: 'openai',
    });
  });

  it('answers byok with provider openai on an OpenAI model with a healthy key', async () => {
    const { resolver } = harness({ keys: [keyRow('openai')] });

    await expect(resolver.forModel(TX, ORG, USER, 'gpt-5.2')).resolves.toMatchObject({
      credential: { apiKey: ORG_KEY, mode: 'BYOK', provider: 'openai' },
      keyId: 'key-openai',
      kind: 'byok',
    });
  });

  it('hands back the sealed plaintext as apiKey and logs nothing that carries it', async () => {
    const logged: unknown[] = [];
    for (const method of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      vi.spyOn(Logger.prototype, method).mockImplementation((...args: unknown[]) => {
        logged.push(args);
      });
      vi.spyOn(Logger, method).mockImplementation((...args: unknown[]) => {
        logged.push(args);
      });
    }
    for (const method of ['log', 'warn', 'error', 'debug', 'info'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args);
      });
    }
    const { resolver } = harness({ keys: [keyRow('anthropic')] });

    const answer = await resolver.forModel(TX, ORG, USER, 'claude-sonnet-5');

    expect(answer.kind === 'byok' && answer.credential.apiKey).toBe(ORG_KEY);
    expect(JSON.stringify(logged)).not.toContain(ORG_KEY);
  });

  it('answers no-credential on an Anthropic model with no key: platform credits are retired', async () => {
    const { resolver } = harness();

    await expect(resolver.forModel(TX, ORG, USER, 'claude-sonnet-5')).resolves.toEqual({
      kind: 'no-credential',
      provider: 'anthropic',
    });
  });

  it('kindOnly answers the kind without opening the secret (the run-create path)', async () => {
    const { dek, repository, resolver } = harness({ keys: [keyRow('anthropic')] });

    await expect(resolver.kindOnly(TX, ORG, USER, 'claude-sonnet-5')).resolves.toEqual({
      kind: 'byok',
    });
    await expect(resolver.kindOnly(TX, ORG, USER, 'gpt-5.2')).resolves.toEqual({
      kind: 'no-credential',
      provider: 'openai',
    });
    expect(dek.openSecret).not.toHaveBeenCalled();
    expect(repository.sealedSecret).not.toHaveBeenCalled();
  });
  describe('BYOS precedence (spec 032 R7)', () => {
    it('answers byos for a healthy subscription on an offered, allowed, served model', async () => {
      const { dek, resolver, tokens } = harness({
        keys: [keyRow('anthropic')],
        linked: [linkedRow('anthropic')],
      });

      await expect(resolver.forModel(TX, ORG, USER, 'claude-sonnet-5')).resolves.toEqual({
        credential: byosCredential('anthropic'),
        kind: 'byos',
      });
      expect(tokens.current).toHaveBeenCalledWith(USER, 'anthropic');
      expect(dek.openSecret).not.toHaveBeenCalled();
    });

    it("falls to 020's order when the model is not one a subscription serves", async () => {
      const { resolver, tokens } = harness({
        keys: [keyRow('anthropic')],
        linked: [linkedRow('anthropic')],
      });

      resolver.served = { anthropic: ['claude-opus-5'], openai: [] };

      await expect(resolver.forModel(TX, ORG, USER, 'claude-sonnet-5')).resolves.toMatchObject({
        kind: 'byok',
      });
      expect(tokens.current).not.toHaveBeenCalled();
    });

    it("falls to 020's order when the provider is not offered", async () => {
      const { resolver, tokens } = harness({
        keys: [keyRow('anthropic')],
        linked: [linkedRow('anthropic')],
        offered: [],
      });

      await expect(resolver.forModel(TX, ORG, USER, 'claude-sonnet-5')).resolves.toMatchObject({
        credential: { mode: 'BYOK' },
        kind: 'byok',
      });
      expect(tokens.current).not.toHaveBeenCalled();
    });

    it("falls to 020's order when the organisation forbids personal accounts", async () => {
      const { resolver, tokens } = harness({
        allowed: false,
        keys: [keyRow('anthropic')],
        linked: [linkedRow('anthropic')],
      });

      await expect(resolver.forModel(TX, ORG, USER, 'claude-sonnet-5')).resolves.toMatchObject({
        kind: 'byok',
      });
      expect(tokens.current).not.toHaveBeenCalled();
    });

    it('refuses subscription-needs-reauth and never falls through to the org key', async () => {
      const { dek, resolver, tokens } = harness({
        keys: [keyRow('anthropic')],
        linked: [linkedRow('anthropic', { health: 'needs_reauth' })],
      });

      await expect(resolver.forModel(TX, ORG, USER, 'claude-sonnet-5')).resolves.toEqual({
        accountLabel: 'ada@example.com',
        kind: 'subscription-needs-reauth',
        provider: 'anthropic',
      });
      expect(dek.openSecret).not.toHaveBeenCalled();
      expect(tokens.current).not.toHaveBeenCalled();
    });

    it('answers subscription-needs-reauth when the refresh is rejected at attempt time', async () => {
      const { resolver } = harness({
        linked: [linkedRow('openai')],
        current: () => Promise.reject(new SubscriptionFailure('rejected')),
      });

      await expect(resolver.forModel(TX, ORG, USER, 'gpt-5.2')).resolves.toEqual({
        accountLabel: 'ada@example.com',
        kind: 'subscription-needs-reauth',
        provider: 'openai',
      });
    });

    it('refuses subscription-limited with resetsAt and the alternative the org would give', async () => {
      const limited = { limitedUntil: LATER };
      const withKey = harness({
        keys: [keyRow('anthropic')],
        linked: [linkedRow('anthropic', limited)],
      });
      await expect(withKey.resolver.forModel(TX, ORG, USER, 'claude-sonnet-5')).resolves.toEqual({
        accountLabel: 'ada@example.com',
        alternativeMode: 'BYOK',
        kind: 'subscription-limited',
        provider: 'anthropic',
        resetsAt: LATER,
      });

      // No key: once the platform's would have been offered here; nothing is now.
      const noKey = harness({ linked: [linkedRow('anthropic', limited)] });
      await expect(
        noKey.resolver.kindOnly(TX, ORG, USER, 'claude-sonnet-5'),
      ).resolves.toMatchObject({ alternativeMode: null, kind: 'subscription-limited' });

      const nothing = harness({ linked: [linkedRow('openai', limited)] });
      await expect(nothing.resolver.kindOnly(TX, ORG, USER, 'gpt-5.2')).resolves.toMatchObject({
        alternativeMode: null,
        kind: 'subscription-limited',
      });

      const brokenKey = harness({
        keys: [keyRow('openai', 'needs_reauth')],
        linked: [linkedRow('openai', limited)],
      });
      await expect(brokenKey.resolver.kindOnly(TX, ORG, USER, 'gpt-5.2')).resolves.toMatchObject({
        alternativeMode: null,
      });
    });

    it('a limit that has passed is not a limit', async () => {
      const { resolver } = harness({
        linked: [linkedRow('anthropic', { limitedUntil: new Date(NOW.getTime() - 1) })],
      });

      await expect(resolver.kindOnly(TX, ORG, USER, 'claude-sonnet-5')).resolves.toEqual({
        kind: 'byos',
      });
    });

    it("limited plus credential: 'organisation' takes 020's order", async () => {
      const { resolver, tokens } = harness({
        keys: [keyRow('anthropic')],
        linked: [linkedRow('anthropic', { limitedUntil: LATER })],
      });

      await expect(
        resolver.forModel(TX, ORG, USER, 'claude-sonnet-5', { credential: 'organisation' }),
      ).resolves.toMatchObject({ kind: 'byok' });
      expect(tokens.current).not.toHaveBeenCalled();
    });

    it("credential: 'organisation' never skips a healthy subscription", async () => {
      const { resolver } = harness({
        keys: [keyRow('anthropic')],
        linked: [linkedRow('anthropic')],
      });

      await expect(
        resolver.kindOnly(TX, ORG, USER, 'claude-sonnet-5', { credential: 'organisation' }),
      ).resolves.toEqual({ kind: 'byos' });
    });

    it("no linked account keeps 020's order", async () => {
      const { accounts, resolver } = harness({ keys: [keyRow('openai')] });

      await expect(resolver.forModel(TX, ORG, USER, 'gpt-5.2')).resolves.toMatchObject({
        kind: 'byok',
      });
      expect(accounts.byProviderOn).toHaveBeenCalledWith(TX, USER, 'openai');
    });

    it('kindOnly never asks the token service (no plaintext at run create)', async () => {
      const { resolver, tokens } = harness({ linked: [linkedRow('anthropic')] });

      await expect(resolver.kindOnly(TX, ORG, USER, 'claude-sonnet-5')).resolves.toEqual({
        kind: 'byos',
      });
      expect(tokens.current).not.toHaveBeenCalled();
    });
  });
});
