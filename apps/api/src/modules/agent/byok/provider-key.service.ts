import { Inject, Injectable } from '@nestjs/common';
import { type ProviderKey, schema } from '@repo/db';
import { and, eq } from 'drizzle-orm';

import { CLOCK, type ClockPort } from '../../../common/clock/clock.port';
import { lastFour, plaintext, revealPlaintext } from '../../../common/crypto/branded';
import { DekService } from '../../../common/crypto/dek.service';
import { NotFoundError } from '../../../common/errors/domain-error';
import type { TenantTransaction } from '../../../database/database.types';
import { AuditService } from '../../audit/audit.service';
import type { KeyVerifier, LlmProviderName } from '../llm-provider.port';
import { keyRefusal } from './byok.errors';
import { hasShape, purposeFor } from './key-shapes';
import { type ProviderKeyRecord, ProviderKeyRepository } from './provider-key.repository';

/** The two adapters keyed by provider name (`agent.module.ts`); the e2e suite doubles it. */
export const KEY_VERIFIERS = Symbol('forge.agent.key-verifiers');

export type KeyVerifiers = Record<LlmProviderName, KeyVerifier>;

/**
 * An organisation's LLM provider keys (spec 020 US1, US3, US4): verify before seal, one key per
 * provider replaced in one transaction, removal, the run-time rejection and the on-demand /
 * daily check. The key leaves this class only towards a verifier; every answer is a record whose
 * only derivatives are the fingerprint and the last four (§05).
 */
@Injectable()
export class ProviderKeyService {
  constructor(
    @Inject(ProviderKeyRepository) private readonly repository: ProviderKeyRepository,
    @Inject(DekService) private readonly dek: DekService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(KEY_VERIFIERS) private readonly verifiers: KeyVerifiers,
  ) {}

  list(tx: TenantTransaction, orgId: string): Promise<ProviderKeyRecord[]> {
    return this.repository.forOrg(tx, orgId);
  }

  /** Shape check → provider check → seal → insert → drop the previous row and secret → audit. */
  async put(
    tx: TenantTransaction,
    orgId: string,
    userId: string,
    provider: LlmProviderName,
    apiKey: string,
  ): Promise<ProviderKeyRecord> {
    if (!hasShape(provider, apiKey)) {
      throw keyRefusal('wrong-shape');
    }

    const check = await this.verifiers[provider].verify(apiKey);

    if (check === 'rejected') {
      throw keyRefusal('key-rejected');
    }
    if (check === 'unreachable') {
      throw keyRefusal('could-not-verify');
    }

    const now = this.clock.now();
    const previous = await this.repository.lockByProvider(tx, orgId, provider);
    const previousFingerprint =
      previous === undefined ? undefined : await this.fingerprintOf(tx, orgId, previous.secretId);

    // `unique (org_id, provider)` is not deferrable: the old row goes before the new one lands,
    // inside the one transaction, so the organisation never commits zero or two keys.
    if (previous !== undefined) {
      await this.repository.delete(tx, orgId, previous.id);
      await this.repository.deleteSecret(tx, orgId, previous.secretId);
    }

    const purpose = purposeFor(provider);
    const secret = plaintext(apiKey);
    const sealed = await this.dek.sealSecret(tx, orgId, purpose, secret);
    const [secretRow] = await tx
      .insert(schema.secrets)
      .values({ ...sealed, orgId, purpose })
      .returning({ id: schema.secrets.id });
    const row = await this.repository.insert(tx, {
      addedBy: userId,
      health: 'healthy',
      lastFour: lastFour(secret),
      lastVerifiedAt: now,
      orgId,
      provider,
      secretId: secretRow!.id,
    });

    await this.audit.record(tx, {
      action: previous === undefined ? 'provider-key.added' : 'provider-key.replaced',
      actorId: userId,
      metadata: {
        fingerprint: sealed.fingerprint,
        lastFour: row.lastFour,
        provider,
        ...(previousFingerprint === undefined ? {} : { previousFingerprint }),
      },
      orgId,
      target: row.id,
    });

    return (await this.repository.byProvider(tx, orgId, provider))!;
  }

  async remove(
    tx: TenantTransaction,
    orgId: string,
    userId: string,
    provider: LlmProviderName,
  ): Promise<void> {
    const row = await this.locked(tx, orgId, provider);
    const fingerprint = await this.fingerprintOf(tx, orgId, row.secretId);

    await this.repository.delete(tx, orgId, row.id);
    await this.repository.deleteSecret(tx, orgId, row.secretId);
    await this.audit.record(tx, {
      action: 'provider-key.removed',
      actorId: userId,
      metadata: { fingerprint, provider },
      orgId,
      target: row.id,
    });
  }

  /**
   * US4: open the sealed key and ask the provider. `ok` stamps `lastVerifiedAt` (and heals a
   * `needs_reauth` row); `rejected` marks it; `unreachable` says nothing about the key and
   * changes nothing (data-model.md § State).
   */
  async verify(
    tx: TenantTransaction,
    orgId: string,
    provider: LlmProviderName,
    actorId: string | null,
  ): Promise<ProviderKeyRecord> {
    const row = await this.locked(tx, orgId, provider);
    const sealed = (await this.repository.sealedSecret(tx, orgId, row.secretId))!;
    const opened = await this.dek.openSecret(tx, orgId, purposeFor(provider), sealed);
    const check = await this.verifiers[provider].verify(revealPlaintext(opened).toString('utf8'));

    if (check === 'ok') {
      await this.repository.setVerified(tx, orgId, row.id, this.clock.now());
      await this.transition(tx, row, 'healthy', actorId, { cause: 'verify' });
    } else if (check === 'rejected') {
      await this.transition(tx, row, 'needs_reauth', actorId, { cause: 'verify' });
    }

    return (await this.repository.byProvider(tx, orgId, provider))!;
  }

  /** US3: a provider 401 on a run marks the key once; already marked or absent is a no-op. */
  async markRejected(
    tx: TenantTransaction,
    orgId: string,
    provider: LlmProviderName,
    { runId }: { runId: string },
  ): Promise<void> {
    const row = await this.repository.lockByProvider(tx, orgId, provider);

    if (row === undefined) return;

    await this.transition(tx, row, 'needs_reauth', null, { cause: 'run', runId });
  }

  private async locked(
    tx: TenantTransaction,
    orgId: string,
    provider: LlmProviderName,
  ): Promise<ProviderKey> {
    const row = await this.repository.lockByProvider(tx, orgId, provider);

    if (row === undefined) {
      throw new NotFoundError('The organisation holds no key for this provider.');
    }

    return row;
  }

  /** Write the health if it changed, and audit that one transition. */
  private async transition(
    tx: TenantTransaction,
    row: ProviderKey,
    to: ProviderKey['health'],
    actorId: string | null,
    metadata: { cause: 'run' | 'verify'; runId?: string },
  ): Promise<void> {
    if (row.health === to) return;

    await this.repository.setHealth(tx, row.orgId, row.id, to, this.clock.now());
    await this.audit.record(tx, {
      action: 'provider-key.health-changed',
      actorId,
      metadata: { ...metadata, from: row.health, provider: row.provider, to },
      orgId: row.orgId,
      target: row.id,
    });
  }

  private async fingerprintOf(
    tx: TenantTransaction,
    orgId: string,
    secretId: string,
  ): Promise<string> {
    const [row] = await tx
      .select({ fingerprint: schema.secrets.fingerprint })
      .from(schema.secrets)
      .where(and(eq(schema.secrets.orgId, orgId), eq(schema.secrets.id, secretId)));

    return row?.fingerprint ?? '';
  }
}
