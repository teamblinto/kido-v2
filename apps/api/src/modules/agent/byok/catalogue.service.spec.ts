import { ConfigService } from '@nestjs/config';
import { MODEL_CATALOGUE, modelCatalogueResponseSchema } from '@repo/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { Environment } from '../../../config/environment';
import type { TenantTransaction } from '../../../database/database.types';
import type { OrgService } from '../../tenancy/services/org.service';
import type { ByosProviders } from '../byos/byos-providers';
import type { LinkedAccountRepository } from '../byos/linked-account.repository';
import { FakeClock } from '../../../common/clock/fake-clock';
import { CatalogueService } from './catalogue.service';
import type { ProviderKeyRecord, ProviderKeyRepository } from './provider-key.repository';

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-09-24T10:00:00.000Z');
const LATER = new Date('2026-09-24T12:00:00.000Z');

interface Linked {
  provider: 'anthropic' | 'openai';
  health?: 'healthy' | 'needs_reauth';
  limitedUntil?: Date | null;
}
const TX = { tag: 'tx' } as unknown as TenantTransaction;
const ANTHROPIC = MODEL_CATALOGUE.filter((m) => m.provider === 'anthropic').map((m) => m.id);
const OPENAI = MODEL_CATALOGUE.filter((m) => m.provider === 'openai').map((m) => m.id);

function key(provider: 'anthropic' | 'openai', health: 'healthy' | 'needs_reauth') {
  return { health, provider } as ProviderKeyRecord;
}

function build(
  keys: ProviderKeyRecord[],
  {
    defaultModel = 'claude-sonnet-5',
    linked = [] as Linked[],
    offered = ['anthropic', 'openai'] as ('anthropic' | 'openai')[],
    allowed = true,
  } = {},
) {
  const forOrg = vi.fn().mockResolvedValue(keys);
  const list = vi.fn().mockResolvedValue(
    linked.map((row) => ({
      accountLabel: 'ada@example.com',
      health: row.health ?? 'healthy',
      limitedUntil: row.limitedUntil ?? null,
      provider: row.provider,
    })),
  );
  const service = new CatalogueService(
    new ConfigService({ AGENT_DEFAULT_MODEL: defaultModel }) as unknown as ConfigService<
      Environment,
      true
    >,
    { forOrg } as unknown as ProviderKeyRepository,
    { personalAccountsAllowed: () => Promise.resolve(allowed) } as unknown as OrgService,
    { offeredList: () => Promise.resolve(offered) } as unknown as ByosProviders,
    { listOn: list } as unknown as LinkedAccountRepository,
    new FakeClock(NOW),
  );

  return { forOrg, list, service };
}

describe('CatalogueService.forOrg', () => {
  it('no key and no subscription → an empty catalogue, default null, read from provider_keys once', async () => {
    const { forOrg, service } = build([]);
    const body = await service.forOrg(TX, ORG, USER);

    expect(forOrg).toHaveBeenCalledTimes(1);
    expect(forOrg).toHaveBeenCalledWith(TX, ORG);
    expect(modelCatalogueResponseSchema.parse(body)).toEqual(body);
    expect(body).toEqual({ default: null, models: [] });
  });

  it('only needs_reauth keys → the entries listed, unavailable, and no default', async () => {
    const body = await build([key('anthropic', 'needs_reauth')]).service.forOrg(TX, ORG, USER);

    expect(body.models.map((m) => m.id)).toEqual(ANTHROPIC);
    expect(body.models.every((m) => !m.available)).toBe(true);
    expect(body.default).toBeNull();
  });

  it('a healthy Anthropic key → the same ids, BYOK', async () => {
    const body = await build([key('anthropic', 'healthy')]).service.forOrg(TX, ORG, USER);

    expect(body.models.map((m) => m.id)).toEqual(ANTHROPIC);
    expect(body.models.every((m) => m.credentialMode === 'BYOK' && m.available)).toBe(true);
  });

  it('an Anthropic key needs_reauth → BYOK, available: false; the default falls through', async () => {
    const body = await build([
      key('anthropic', 'needs_reauth'),
      key('openai', 'healthy'),
    ]).service.forOrg(TX, ORG, USER);

    expect(
      body.models
        .filter((m) => m.provider === 'anthropic')
        .every((m) => !m.available && m.unavailableReason === 'key-needs-reauth'),
    ).toBe(true);
    expect(body.default).toBe(OPENAI[0]);
  });

  it('an OpenAI key alone → the OpenAI models only, BYOK; no Anthropic model nothing pays for', async () => {
    const body = await build([key('openai', 'healthy')]).service.forOrg(TX, ORG, USER);

    expect(body.models.map((m) => m.id)).toEqual(OPENAI);
    expect(body.default).toBe(OPENAI[0]);
    expect(body.models.filter((m) => m.provider === 'openai')).toEqual(
      MODEL_CATALOGUE.filter((m) => m.provider === 'openai').map((m) => ({
        ...m,
        available: true,
        credentialMode: 'BYOK',
      })),
    );
  });

  it('an OpenAI key needs_reauth → present, available: false', async () => {
    const body = await build([key('openai', 'needs_reauth')]).service.forOrg(TX, ORG, USER);

    expect(body.models.filter((m) => m.provider === 'openai').map((m) => m.available)).toEqual(
      OPENAI.map(() => false),
    );
  });

  it('the default is the first available when AGENT_DEFAULT_MODEL is unavailable', async () => {
    const body = await build([key('anthropic', 'healthy')], {
      defaultModel: 'gpt-5.2',
    }).service.forOrg(TX, ORG, USER);

    expect(body.default).toBe(ANTHROPIC[0]);
  });

  describe("the caller's subscription (spec 032 R8)", () => {
    it('a healthy subscription stamps its served entries BYOS, for this caller only', async () => {
      const { list, service } = build([key('anthropic', 'healthy')], {
        linked: [{ provider: 'openai' }],
      });
      const body = await service.forOrg(TX, ORG, USER);

      expect(list).toHaveBeenCalledWith(TX, USER);
      expect(modelCatalogueResponseSchema.parse(body)).toEqual(body);
      expect(body.models.map((m) => m.id)).toEqual([...ANTHROPIC, ...OPENAI]);
      expect(
        body.models
          .filter((m) => m.provider === 'openai')
          .every((m) => m.credentialMode === 'BYOS'),
      ).toBe(true);
      expect(
        body.models
          .filter((m) => m.provider === 'anthropic')
          .every((m) => m.credentialMode === 'BYOK'),
      ).toBe(true);
    });

    it('a needs_reauth subscription → BYOS, unavailable, subscription-needs-reauth', async () => {
      const body = await build([key('anthropic', 'healthy')], {
        linked: [{ health: 'needs_reauth', provider: 'anthropic' }],
      }).service.forOrg(TX, ORG, USER);

      for (const model of body.models) {
        expect(model).toMatchObject({
          available: false,
          credentialMode: 'BYOS',
          unavailableReason: 'subscription-needs-reauth',
        });
      }
    });

    it('a limited subscription → available, limitedUntil and the alternative', async () => {
      const withKey = await build([key('anthropic', 'healthy')], {
        linked: [{ limitedUntil: LATER, provider: 'anthropic' }],
      }).service.forOrg(TX, ORG, USER);
      expect(withKey.models[0]).toMatchObject({
        alternativeMode: 'BYOK',
        available: true,
        credentialMode: 'BYOS',
        limitedUntil: LATER.toISOString(),
      });

      // No key: platform credits once stood in here; now nothing does.
      const noKey = await build([], {
        linked: [{ limitedUntil: LATER, provider: 'anthropic' }],
      }).service.forOrg(TX, ORG, USER);
      expect(noKey.models[0]).toMatchObject({ available: true, credentialMode: 'BYOS' });
      expect(noKey.models[0]).not.toHaveProperty('alternativeMode');

      const none = await build([], {
        linked: [{ limitedUntil: LATER, provider: 'openai' }],
      }).service.forOrg(TX, ORG, USER);
      const openai = none.models.find((m) => m.provider === 'openai')!;
      expect(openai.limitedUntil).toBe(LATER.toISOString());
      expect(openai).not.toHaveProperty('alternativeMode');
    });

    it('a provider not offered, or an organisation that forbids them, ignores the subscription', async () => {
      for (const options of [{ offered: [] }, { allowed: false }]) {
        const body = await build([], {
          linked: [{ provider: 'anthropic' }, { provider: 'openai' }],
          ...options,
        }).service.forOrg(TX, ORG, USER);
        expect(body).toEqual({ default: null, models: [] });
      }
    });
  });
});
