import type { INestApplication } from '@nestjs/common';

import { CLOCK, type ClockPort } from '../../src/common/clock/clock.port';
import { DekService } from '../../src/common/crypto/dek.service';
import { TenantTransactionRunner } from '../../src/database/tenant-transaction';
import { AuditService } from '../../src/modules/audit/audit.service';
import { ProviderKeyRepository } from '../../src/modules/agent/byok/provider-key.repository';
import { ProviderKeyService } from '../../src/modules/agent/byok/provider-key.service';
import type { KeyCheck, LlmProviderName } from '../../src/modules/agent/llm-provider.port';

/** A well-shaped Anthropic key no provider ever sees: the suites' model is a fake. */
export const SEEDED_ANTHROPIC_KEY = `sk-ant-api03-${'s'.repeat(40)}seed`;

/**
 * Platform credits are retired, so a suite whose runs must reach a model gives the organisation
 * its own key, the product's way — `ProviderKeyService.put` seals, inserts and audits it — with
 * only the provider's check answered `ok`, since no suite may call a real provider. A fresh
 * service rather than `overrideProvider(KEY_VERIFIERS)`, so a suite that never stores a key over
 * HTTP needs no override and keeps the real verifiers it boots with.
 */
export async function seedProviderKey(
  app: INestApplication,
  tenant: { readonly orgId: string; readonly owner: { readonly userId: string } },
  provider: LlmProviderName = 'anthropic',
  apiKey: string = SEEDED_ANTHROPIC_KEY,
): Promise<string> {
  const ok = { verify: (): Promise<KeyCheck> => Promise.resolve('ok') };
  const service = new ProviderKeyService(
    app.get(ProviderKeyRepository),
    app.get(DekService),
    app.get(AuditService),
    app.get<ClockPort>(CLOCK),
    { anthropic: ok, openai: ok },
  );
  const { orgId, owner } = tenant;

  await app
    .get(TenantTransactionRunner)
    .runInTenantScope({ orgId, userId: owner.userId }, (tx) =>
      service.put(tx, orgId, owner.userId, provider, apiKey),
    );

  return apiKey;
}
