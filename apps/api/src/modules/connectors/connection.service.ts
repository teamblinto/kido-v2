import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import type {
  CompleteInstallRequest,
  Connection as ConnectionContract,
  ConnectorProvider,
  RepositoryPage,
  RepositoryQuery,
  SupabaseCompleteRequest,
} from '@repo/contracts';
import type { Connection, ConnectorOperation } from '@repo/db';

import { CLOCK, type ClockPort } from '../../common/clock/clock.port';
import { type Plaintext, plaintext, revealPlaintext } from '../../common/crypto/branded';
import { DekService } from '../../common/crypto/dek.service';
import { DomainError, NotFoundError } from '../../common/errors/domain-error';
import type { Environment } from '../../config/environment';
import type { TenantTransaction } from '../../database/database.types';
import { AuditService } from '../audit/audit.service';
import {
  OauthExchangeError,
  OauthProviderNotConfiguredError,
  OauthStateError,
} from '../identity/services/oauth.service';
import { isOpen, retryAfterSeconds } from '../../common/circuit/circuit';
import { type ConnectionRecord, ConnectionRepository } from './connection.repository';
import {
  connectorRefusal,
  githubRefusal,
  PROVIDER_DISPLAY_NAMES,
  providerUnavailable,
  RETRY_AFTER_SECONDS,
  syncConflict,
} from './connectors.errors';
import {
  GITHUB_APP_CLIENT,
  GithubApiError,
  type GithubAppClient,
  type GithubInstallation,
  type GithubRepositoryPage,
  REPOSITORIES_PER_PAGE,
  type MintedToken,
} from './github-app.client';
import { InstallStateStore } from './install-state';
import { OperationService } from './operation.service';
import {
  PROVIDER_VERIFIERS,
  ProviderFailure,
  type ProviderVerifiers,
  type VerifyResult,
} from './providers/provider';
import { SUPABASE_CLIENT, type SupabaseClient } from './providers/supabase/supabase.client';
import {
  type SupabaseSealedGrant,
  supabaseGrantSchema,
} from './providers/supabase/supabase.schemas';
import { RepoLinkRepository } from './repo-link.repository';

/** The one new `secrets.purpose` (data-model.md): bound into the seal with the org id. */
export const TOKEN_PURPOSE = 'connector:github:installation-token';

/** Spec 030 data-model § 6: each provider credential's `secrets.purpose`, bound into its seal. */
const CREDENTIAL_PURPOSES: Readonly<Record<ConnectorProvider, string>> = {
  cloudflare: 'connector:cloudflare:api-token',
  github: TOKEN_PURPOSE,
  neon: 'connector:neon:api-key',
  netlify: 'connector:netlify:token',
  resend: 'connector:resend:api-key',
  supabase: 'connector:supabase:oauth-grant',
};

export function credentialPurpose(provider: ConnectorProvider): string {
  return CREDENTIAL_PURPOSES[provider];
}

/** Spec 030 R2: a GitHub row always carries its installation (`connections_github_shape`). */
function installationOf(row: Connection): number {
  if (row.installationId === null) {
    throw new Error(`connection ${row.id}: a GitHub row without an installation`);
  }

  return row.installationId;
}

/** R15: a token this close to expiry is re-minted rather than handed out. */
const REMINT_FLOOR_MS = 5 * 60_000;
/** R9: the daily check re-mints a token that would otherwise expire before the next sweep. */
const HEALTH_REMINT_MS = 24 * 3_600_000;

/**
 * R3: the cached org-wide token lists and creates repositories and verifies health; a push or
 * pull mints its own one-repository token through {@link ConnectionService.repositoryToken}.
 */
const ORG_TOKEN_PERMISSIONS = { administration: 'write', contents: 'read', metadata: 'read' };
const REPO_TOKEN_BASE_PERMISSIONS = { contents: 'write', metadata: 'read' };
/** Spec 044: a push touching `.github/workflows` needs this; an App not yet updated lacks it. */
const REPO_TOKEN_PERMISSIONS = { ...REPO_TOKEN_BASE_PERMISSIONS, workflows: 'write' };

/** R9: the installation gone (404) or the App refused (401) — only a reinstall repairs it. */
function isRevoked(error: GithubApiError): boolean {
  return error.category === 'unauthorized' || error.category === 'not-found';
}

/**
 * An organisation's GitHub connection (spec 018 US1): the install dance (R8), the sealed token
 * (R2) and its single-flight refresh (R15), removal (R13), and the one gate every operation passes
 * (`ensureUsable`, R10/R12). The token leaves this class only as a {@link Plaintext}, and never in
 * a contract row.
 */
@Injectable()
export class ConnectionService {
  private readonly installUrl: string;
  private readonly logger = new Logger(ConnectionService.name);
  private readonly slug: string | undefined;

  constructor(
    @Inject(GITHUB_APP_CLIENT) private readonly github: GithubAppClient,
    @Inject(ConnectionRepository) private readonly repository: ConnectionRepository,
    @Inject(RepoLinkRepository) private readonly links: RepoLinkRepository,
    @Inject(InstallStateStore) private readonly states: InstallStateStore,
    @Inject(DekService) private readonly dek: DekService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(PROVIDER_VERIFIERS) private readonly verifiers: ProviderVerifiers,
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    @Inject(OperationService) private readonly operations: OperationService,
    config: ConfigService<Environment, true>,
  ) {
    this.installUrl = config.get('GITHUB_INSTALL_URL', { infer: true }).replace(/\/+$/, '');
    this.slug = config.get('GITHUB_APP_SLUG', { infer: true });
  }

  async beginInstall(orgId: string, userId: string): Promise<{ installUrl: string }> {
    if (this.slug === undefined || !this.github.isConfigured()) {
      throw new OauthProviderNotConfiguredError('github');
    }

    const state = await this.states.issue(orgId, userId);

    return {
      installUrl: `${this.installUrl}/apps/${this.slug}/installations/new?state=${state}`,
    };
  }

  async completeInstall(
    tx: TenantTransaction,
    orgId: string,
    userId: string,
    { installationId, state }: CompleteInstallRequest,
  ): Promise<Connection> {
    const stored = await this.states.consume(state, { orgId, provider: 'github', userId });

    if (stored === undefined) {
      this.logger.warn(`Install refused: unrecognised state [orgId=${orgId}]`);

      throw new OauthStateError();
    }

    const { installation, minted } = await this.verified(installationId);
    const previous = await this.repository.byProvider(tx, orgId, 'github');
    const secretId = await this.seal(tx, orgId, minted);
    const row = await this.repository.upsert(tx, {
      accountId: installation.account.id,
      accountLogin: installation.account.login,
      accountType: installation.account.type === 'Organization' ? 'organization' : 'user',
      connectedBy: userId,
      health: 'healthy',
      installationId,
      lastVerifiedAt: this.clock.now(),
      orgId,
      provider: 'github',
      secretId,
      tokenExpiresAt: minted.expiresAt,
    });

    if (previous !== undefined) {
      await this.repository.deleteSecret(tx, orgId, previous.secretId);
    }

    // R13: after a removal the old row, and the links' pointer to it, are gone; the links whose
    // owner is the new account come back. A different account leaves them `disconnected`.
    const reconnected = previous?.accountId === installation.account.id;
    const relinked = await this.links.repointConnection(
      tx,
      orgId,
      row.id,
      installation.account.login,
    );

    await this.audit.record(tx, {
      action: reconnected || relinked > 0 ? 'connector.reconnected' : 'connector.connected',
      actorId: userId,
      metadata: {
        accountId: installation.account.id,
        accountLogin: installation.account.login,
        provider: 'github',
        relinked,
      },
      orgId,
      target: row.id,
    });

    return row;
  }

  /**
   * Spec 030 R3, contracts/bindings.md § 1: connect a pasted-token provider. The token is verified
   * before anything is stored: a missing scope or a refused token is a 422 naming why, a provider
   * that does not answer is a 503; only a verified token is sealed under the provider's purpose and
   * upserted, replacing a previous connection of the same provider (`connector.reconnected`).
   */
  async connectWithToken(
    tx: TenantTransaction,
    orgId: string,
    userId: string,
    provider: ConnectorProvider,
    token: string,
  ): Promise<ConnectionRecord> {
    const verifier = this.verifiers.get(provider);

    // GitHub connects by App installation; a provider with no registered adapter is not offered.
    if (provider === 'github' || verifier === undefined) {
      throw new DomainError(
        'oauth-provider-not-configured',
        `${PROVIDER_DISPLAY_NAMES[provider]} cannot be connected with a pasted token here.`,
      );
    }

    const credential = plaintext(token);

    return this.store(tx, orgId, userId, provider, credential, await verifier.verify(credential));
  }

  /**
   * Spec 030 research R1: begin a Supabase OAuth install. The PKCE verifier is generated here and
   * kept only in the single-use state; the browser carries the S256 challenge. Without the
   * deployment's OAuth client pair the install is `501 oauth-provider-not-configured`.
   */
  async beginSupabaseInstall(orgId: string, userId: string): Promise<{ url: string }> {
    if (!this.supabase.isConfigured()) {
      throw new DomainError(
        'oauth-provider-not-configured',
        'Supabase is not configured on this deployment.',
        { provider: 'supabase' },
      );
    }

    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const state = await this.states.issue(orgId, userId, { pkce: verifier, provider: 'supabase' });

    return { url: this.supabase.authorizeUrl(state, challenge) };
  }

  /**
   * The Supabase redirect's `code` and `state`: the state is spent for this org, user and
   * provider, the code exchanged with its verifier, the access token verified, and the grant sealed
   * as one JSON secret under `connector:supabase:oauth-grant` with its expiry (research R10).
   */
  async completeSupabaseInstall(
    tx: TenantTransaction,
    orgId: string,
    userId: string,
    { code, state }: SupabaseCompleteRequest,
  ): Promise<ConnectionRecord> {
    const stored = await this.states.consume(state, { orgId, provider: 'supabase', userId });

    if (stored?.pkce === undefined) {
      this.logger.warn(`Supabase install refused: unrecognised state [orgId=${orgId}]`);

      throw new OauthStateError();
    }

    let grant: Awaited<ReturnType<SupabaseClient['exchange']>>;

    try {
      grant = await this.supabase.exchange(code, stored.pkce);
    } catch (error) {
      if (!(error instanceof ProviderFailure)) throw error;

      throw new DomainError(
        'oauth-exchange-failed',
        'Supabase did not complete the authorisation. Try again in a moment.',
        { provider: 'supabase' },
      );
    }

    const result = await this.supabase.verify(plaintext(grant.accessToken));

    return this.store(
      tx,
      orgId,
      userId,
      'supabase',
      sealedGrant(grant),
      result,
      new Date(this.clock.now().getTime() + grant.expiresInSeconds * 1000),
    );
  }

  /**
   * What a connect proved, stored: a refusal stores nothing; a verified credential is sealed under
   * the provider's purpose and upserted, replacing a previous connection of the same provider.
   */
  private async store(
    tx: TenantTransaction,
    orgId: string,
    userId: string,
    provider: ConnectorProvider,
    credential: Plaintext,
    result: VerifyResult,
    tokenExpiresAt: Date | null = null,
  ): Promise<ConnectionRecord> {
    switch (result.kind) {
      case 'missing-scope':
        throw connectorRefusal('missing-scope', {
          detail: `The ${PROVIDER_DISPLAY_NAMES[provider]} credential is missing: ${result.missing.join(', ')}.`,
          missing: [...result.missing],
        });
      case 'revoked':
        throw connectorRefusal('provider-refused', {
          detail: `${PROVIDER_DISPLAY_NAMES[provider]} did not accept that credential.`,
        });
      case 'failed':
        throw result.category === 'forbidden-scope' || result.category === 'unauthorized'
          ? connectorRefusal('provider-refused', {
              detail: `${PROVIDER_DISPLAY_NAMES[provider]} did not accept that credential.`,
            })
          : providerUnavailable(result.retryAfterSeconds ?? RETRY_AFTER_SECONDS, provider);
      case 'verified':
        break;
    }

    const previous = await this.repository.byProvider(tx, orgId, provider);
    const purpose = credentialPurpose(provider);
    const sealed = await this.dek.sealSecret(tx, orgId, purpose, credential);
    const secretId = await this.repository.insertSecret(tx, orgId, purpose, sealed);
    const row = await this.repository.upsert(tx, {
      accountLogin: result.accountName,
      accountRef: result.accountRef,
      authType: provider === 'supabase' ? 'oauth' : 'token',
      connectedBy: userId,
      grantedScopes: [...result.scopes],
      health: 'healthy',
      lastVerifiedAt: this.clock.now(),
      orgId,
      provider,
      secretId,
      tokenExpiresAt,
    });

    if (previous !== undefined) {
      await this.repository.deleteSecret(tx, orgId, previous.secretId);
    }

    await this.audit.record(tx, {
      action: previous === undefined ? 'connector.connected' : 'connector.reconnected',
      actorId: userId,
      metadata: {
        accountLogin: result.accountName,
        accountRef: result.accountRef,
        provider,
        scopes: [...result.scopes],
      },
      orgId,
      target: row.id,
    });

    return this.byId(tx, orgId, row.id);
  }

  /**
   * Opens a non-GitHub connection's sealed credential for one call; the plaintext never leaves the
   * caller. GitHub's token goes through {@link currentToken}, which re-mints it.
   */
  async openCredential(tx: TenantTransaction, row: Connection): Promise<Plaintext> {
    const sealed =
      row.secretId === null
        ? undefined
        : await this.repository.sealedSecret(tx, row.orgId, row.secretId);

    if (sealed === undefined) {
      throw connectorRefusal('needs-reauth');
    }

    return this.dek.openSecret(tx, row.orgId, credentialPurpose(row.provider), sealed);
  }

  /**
   * Every connection of the organisation. A GitHub connection being removed is left out: it has no
   * resources, so its removal finishes in one job and the frozen GitHub arm gains no field
   * (contracts/bindings.md § 1).
   */
  async list(tx: TenantTransaction, orgId: string): Promise<ConnectionRecord[]> {
    const rows = await this.repository.forOrg(tx, orgId);

    return rows.filter((row) => row.provider !== 'github' || row.removalRequestedAt === null);
  }

  async byId(tx: TenantTransaction, orgId: string, id: string): Promise<ConnectionRecord> {
    const row = await this.repository.byId(tx, orgId, id);

    if (row === undefined) {
      throw new NotFoundError('No such connection.');
    }

    return row;
  }

  /**
   * Spec 030 contracts/bindings.md § 1, provider-adapters.md § 7: removal is requested, not done
   * here. The row is marked (so `ensureUsable` refuses it with `removing` from now on) and one
   * `connection_remove` operation is queued; the handler releases every live resource with the
   * credential still sealed, then revokes, deletes the secret and the row, and audits.
   */
  async requestRemoval(
    tx: TenantTransaction,
    orgId: string,
    userId: string,
    id: string,
  ): Promise<ConnectorOperation> {
    const row = await this.byId(tx, orgId, id);

    if (!(await this.repository.requestRemoval(tx, orgId, row.id, this.clock.now()))) {
      throw connectorRefusal('in-flight', {
        detail: `The ${PROVIDER_DISPLAY_NAMES[row.provider]} connection is already being removed.`,
      });
    }

    // `connector_operations` has no connection column: the connection rides `external_ref`.
    return this.operations.request(tx, orgId, {
      externalRef: row.id,
      kind: 'connection_remove',
      requestedBy: userId,
    });
  }

  /**
   * The provider half of a removal, after every resource is released (§ 7): GitHub's installation
   * deleted, or Supabase's grant revoked — both best effort, a refusal logged and not retried.
   */
  async revokeAtProvider(row: Connection, credential: Plaintext): Promise<void> {
    if (row.provider === 'github') {
      try {
        await this.github.deleteInstallation(installationOf(row));
      } catch (error) {
        if (!(error instanceof GithubApiError)) throw error;
        this.logger.warn(`Installation not revoked at GitHub [category=${error.category}]`);
      }

      return;
    }

    if (row.provider === 'supabase') {
      const grant = parseGrant(credential);

      try {
        if (grant !== undefined) await this.supabase.revoke(grant.refreshToken);
      } catch (error) {
        if (!(error instanceof ProviderFailure)) throw error;
        this.logger.warn(`Supabase grant not revoked [category=${error.category}]`);
      }
    }
  }

  /**
   * The last step of a removal: the links and bindings `disconnected`, the row and its secret
   * deleted, and `connector.removed` audited naming any resource left `failed`.
   */
  async finishRemoval(
    tx: TenantTransaction,
    row: Connection,
    actorId: string | null,
    failed: readonly { readonly kind: string; readonly name: string }[],
  ): Promise<void> {
    const { orgId, id } = row;

    await this.links.disconnectAllFor(tx, orgId, id);
    await this.repository.disconnectBindings(tx, orgId, id);
    // Spec 030 T076: what a Neon branch or a Supabase key left sealed goes with the connection.
    await this.repository.dropResourceValues(tx, orgId, id);
    await this.repository.delete(tx, orgId, id);
    await this.repository.deleteSecret(tx, orgId, row.secretId);
    await this.audit.record(tx, {
      action: 'connector.removed',
      actorId,
      metadata: {
        accountId: row.accountId,
        accountLogin: row.accountLogin,
        ...(failed.length > 0 ? { failedResources: failed.map((r) => ({ ...r })) } : {}),
        provider: row.provider,
      },
      orgId,
      target: id,
    });
  }

  /**
   * The cached org-wide token, re-minted under `select … for update` on the row when it is within
   * five minutes of expiry — so two concurrent callers cost one mint (R15).
   */
  async currentToken(
    tx: TenantTransaction,
    orgId: string,
    provider: 'github' | 'supabase' = 'github',
  ): Promise<Plaintext> {
    if (provider === 'supabase') {
      return this.currentSupabaseToken(tx, orgId);
    }

    const row = await this.repository.lockForUpdate(tx, orgId);

    if (row === undefined) {
      throw syncConflict('not-linked', 'This organisation has no GitHub connection.');
    }

    const usable =
      row.secretId !== null &&
      row.tokenExpiresAt !== null &&
      row.tokenExpiresAt.getTime() - this.clock.now().getTime() >= REMINT_FLOOR_MS;

    if (usable) {
      const sealed = await this.repository.sealedSecret(tx, orgId, row.secretId!);

      if (sealed !== undefined) {
        return this.dek.openSecret(tx, orgId, TOKEN_PURPOSE, sealed);
      }
    }

    return this.refresh(tx, row);
  }

  /**
   * Spec 030 research R10: the Supabase access token, refreshed single-flight under the row lock
   * when it is within `REMINT_FLOOR_MS` of expiry — ten concurrent callers cost one refresh. A
   * refused refresh grant moves the row to `needs_reauth`; a transient failure counts toward the
   * breaker. The new grant is sealed over the old one.
   */
  private async currentSupabaseToken(tx: TenantTransaction, orgId: string): Promise<Plaintext> {
    const row = await this.repository.lockForUpdate(tx, orgId, 'supabase');

    if (row === undefined) {
      throw connectorRefusal('disconnected', {
        detail: 'This organisation has no Supabase connection.',
      });
    }

    const grant = parseGrant(await this.openCredential(tx, row));

    if (grant === undefined) {
      throw connectorRefusal('needs-reauth');
    }

    const now = this.clock.now();
    const fresh =
      row.tokenExpiresAt !== null &&
      row.tokenExpiresAt.getTime() - now.getTime() >= REMINT_FLOOR_MS;

    if (fresh) {
      return plaintext(grant.accessToken);
    }

    let next: Awaited<ReturnType<SupabaseClient['refresh']>>;

    try {
      next = await this.supabase.refresh(grant.refreshToken);
    } catch (error) {
      if (!(error instanceof ProviderFailure)) throw error;

      if (error.category === 'unauthorized') {
        await this.transition(tx, row, null, () =>
          this.repository.setHealth(tx, orgId, row.id, 'needs_reauth', now),
        );

        throw connectorRefusal('needs-reauth', {
          detail: 'The Supabase connection needs to be reconnected.',
        });
      }

      await this.transition(tx, row, null, () =>
        this.repository.recordFailure(tx, orgId, row.id, now),
      );

      throw providerUnavailable(error.retryAfterSeconds ?? RETRY_AFTER_SECONDS, 'supabase');
    }

    const purpose = credentialPurpose('supabase');
    const sealed = await this.dek.sealSecret(tx, orgId, purpose, sealedGrant(next));
    const secretId = await this.repository.insertSecret(tx, orgId, purpose, sealed);

    await this.repository.setSecret(
      tx,
      orgId,
      row.id,
      secretId,
      new Date(now.getTime() + next.expiresInSeconds * 1000),
    );
    await this.repository.deleteSecret(tx, orgId, row.secretId);

    return plaintext(next.accessToken);
  }

  /**
   * R9, contracts § 1: the health check, run daily by `ConnectorHealthConsumer` and on demand by
   * `POST :connectionId/verify`. The installation looked up with the App JWT: gone or refused →
   * `needs_reauth`; a transient failure counts toward the breaker; a 200 closes it, marks the row
   * healthy and re-mints a token that expires within the day. Every health transition is audited
   * once, as `connector.health-changed`. Answers the row as it stands afterwards.
   */
  async verify(
    tx: TenantTransaction,
    orgId: string,
    id: string,
    actorId: string | null = null,
  ): Promise<ConnectionRecord> {
    const row = await this.byId(tx, orgId, id);
    const now = this.clock.now();

    if (row.provider !== 'github') {
      return this.verifyWithProvider(tx, row, actorId);
    }

    try {
      await this.github.installation(installationOf(row));
    } catch (error) {
      if (!(error instanceof GithubApiError)) {
        throw error;
      }

      await this.transition(tx, row, actorId, () =>
        isRevoked(error)
          ? this.repository.setHealth(tx, orgId, id, 'needs_reauth', now)
          : this.repository.recordFailure(tx, orgId, id, now),
      );

      return this.byId(tx, orgId, id);
    }

    await this.transition(tx, row, actorId, async () => {
      await this.repository.recordSuccess(tx, orgId, id, now);

      // The installation answered the App: a pending re-authorisation was a false alarm.
      if (row.health === 'needs_reauth') {
        await this.repository.setHealth(tx, orgId, id, 'healthy', now);
      }
    });

    const expiresSoon =
      row.tokenExpiresAt === null ||
      row.tokenExpiresAt.getTime() - now.getTime() < HEALTH_REMINT_MS;

    if (!expiresSoon) {
      return this.byId(tx, orgId, id);
    }

    // The row as the transition above left it, so the mint's own bookkeeping sees the new health.
    // A refused re-mint already moved the row (the breaker, or `needs_reauth`): the check answers
    // it rather than throwing, so a sweep over many organisations carries on.
    try {
      await this.refresh(tx, await this.byId(tx, orgId, id));
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      this.logger.warn(`connection ${id}: re-mint refused — ${error.message}`);
    }

    return this.byId(tx, orgId, id);
  }

  /**
   * Spec 030 R3: a non-GitHub health check through the provider's verifier. Revoked or short of a
   * scope → `needs_reauth`; a failure counts toward the breaker; verified closes it and clears a
   * pending re-authorisation. Each health transition is audited once.
   */
  private async verifyWithProvider(
    tx: TenantTransaction,
    row: ConnectionRecord,
    actorId: string | null,
  ): Promise<ConnectionRecord> {
    const verifier = this.verifiers.get(row.provider);

    if (verifier === undefined) {
      return row;
    }

    let credential: Plaintext;

    try {
      // Supabase's sealed secret is the grant; the probe needs a live access token from it.
      credential =
        row.provider === 'supabase'
          ? await this.currentSupabaseToken(tx, row.orgId)
          : await this.openCredential(tx, row);
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      this.logger.warn(`connection ${row.id}: not verified — ${error.message}`);

      return this.byId(tx, row.orgId, row.id);
    }

    const now = this.clock.now();
    const result = await verifier.verify(credential);

    await this.transition(tx, row, actorId, async () => {
      switch (result.kind) {
        case 'revoked':
        case 'missing-scope':
          await this.repository.setHealth(tx, row.orgId, row.id, 'needs_reauth', now);
          return;
        case 'failed':
          if (result.category === 'unauthorized' || result.category === 'forbidden-scope') {
            await this.repository.setHealth(tx, row.orgId, row.id, 'needs_reauth', now);
          } else {
            await this.repository.recordFailure(tx, row.orgId, row.id, now);
          }
          return;
        case 'verified':
          await this.repository.recordSuccess(tx, row.orgId, row.id, now);

          if (row.health === 'needs_reauth') {
            await this.repository.setHealth(tx, row.orgId, row.id, 'healthy', now);
          }
      }
    });

    return this.byId(tx, row.orgId, row.id);
  }

  /**
   * Spec 030 R5: what one provider call on a connection proved, written back to the row — revoked
   * or short of a scope → `needs_reauth`, a transient failure → the breaker (which can open the
   * circuit), a success → closes it. A health change is audited once, as `connector.health-changed`.
   */
  async recordUse(
    tx: TenantTransaction,
    row: Connection,
    outcome: 'failure' | 'needs-reauth' | 'success',
  ): Promise<void> {
    const now = this.clock.now();

    await this.transition(tx, row, null, () => {
      switch (outcome) {
        case 'needs-reauth':
          return this.repository.setHealth(tx, row.orgId, row.id, 'needs_reauth', now);
        case 'failure':
          return this.repository.recordFailure(tx, row.orgId, row.id, now);
        case 'success':
          return this.repository.recordSuccess(tx, row.orgId, row.id, now);
      }
    });
  }

  /** A fresh org-wide token sealed over the old one; the plaintext goes only to the caller. */
  private async refresh(tx: TenantTransaction, row: Connection): Promise<Plaintext> {
    const minted = await this.mintForRow(tx, row);
    const secretId = await this.seal(tx, row.orgId, minted);

    await this.repository.setSecret(tx, row.orgId, row.id, secretId, minted.expiresAt);
    await this.repository.deleteSecret(tx, row.orgId, row.secretId);

    return minted.token;
  }

  /**
   * Contracts § 1: one GitHub page of the installation's repositories, filtered by name. The
   * cursor is the next page number; the page size is the client's (100 — the contract says 50,
   * the client's constant is what the fixture and GitHub paginate on).
   */
  async listRepositories(
    tx: TenantTransaction,
    orgId: string,
    { cursor, query }: RepositoryQuery,
  ): Promise<RepositoryPage> {
    const page = cursor === undefined ? 1 : Number(cursor);

    if (!Number.isInteger(page) || page < 1) {
      throw new DomainError('bad-request', 'The cursor is not one this list issued.');
    }

    await this.ensureUsable(tx, orgId);

    const token = await this.currentToken(tx, orgId);
    let fetched: GithubRepositoryPage;

    try {
      fetched = await this.github.listRepositories(token, page);
    } catch (error) {
      throw error instanceof GithubApiError
        ? githubRefusal(error.category, RETRY_AFTER_SECONDS)
        : error;
    }

    const needle = query?.toLowerCase() ?? '';
    const repositories = fetched.repositories.filter((repository) =>
      repository.name.toLowerCase().includes(needle),
    );
    const seen = (page - 1) * REPOSITORIES_PER_PAGE + fetched.repositories.length;

    return {
      // Named rather than spread: `GithubRepository` grew `sizeKib` for spec 026's import gate,
      // and spec 018's `Repository` contract does not carry it (SC-014 — the contract is unchanged).
      repositories: repositories.map((repository) => ({
        defaultBranch: repository.defaultBranch,
        fullName: repository.fullName,
        id: repository.id,
        name: repository.name,
        owner: repository.owner,
        private: repository.private,
      })),
      ...(seen < fetched.totalCount ? { nextCursor: String(page + 1) } : {}),
    };
  }

  /** R3: a token that can touch only the one linked repository; held by the caller, never stored. */
  async repositoryToken(tx: TenantTransaction, orgId: string, repoId: number): Promise<Plaintext> {
    const row = await this.ensureUsable(tx, orgId);

    return (await this.mintForRow(tx, row, [repoId])).token;
  }

  /**
   * Contract § 4, R10, R12: the gate before any enqueue. A `needs_reauth` row is `conflict/
   * needs-reauth`; an open circuit is `service-unavailable/provider-unavailable` with the seconds
   * left on the window as `Retry-After`. One row read, no provider call (SC-010).
   */
  async ensureUsable(
    tx: TenantTransaction,
    orgId: string,
    provider: ConnectorProvider = 'github',
  ): Promise<ConnectionRecord> {
    const row = await this.repository.byProvider(tx, orgId, provider);
    const name = PROVIDER_DISPLAY_NAMES[provider];

    if (row === undefined) {
      throw provider === 'github'
        ? syncConflict('not-linked', 'This organisation has no GitHub connection.')
        : connectorRefusal('disconnected', {
            detail: `This organisation has no ${name} connection.`,
          });
    }

    // Spec 030 contracts/bindings.md § 5: a connection being removed takes no new work.
    if (row.removalRequestedAt !== null) {
      throw connectorRefusal('removing', { detail: `The ${name} connection is being removed.` });
    }

    if (row.health === 'needs_reauth') {
      throw provider === 'github'
        ? syncConflict('needs-reauth', 'The GitHub connection needs to be reconnected.')
        : connectorRefusal('needs-reauth', {
            detail: `The ${name} connection needs to be reconnected.`,
          });
    }

    const now = this.clock.now();

    if (isOpen(row, now)) {
      throw providerUnavailable(retryAfterSeconds(row, now), provider);
    }

    return row;
  }

  /** Contract § 1: the fingerprint is the only derivative of the credential that leaves. */
  toContract(row: ConnectionRecord): ConnectionContract {
    if (row.provider !== 'github') {
      return {
        account: { name: row.accountLogin, ref: row.accountRef ?? '' },
        authType: row.authType === 'oauth' ? 'oauth' : 'token',
        connectedAt: row.createdAt.toISOString(),
        connectedBy: { id: row.connectedBy, name: row.connectedByName },
        credentialFingerprint: row.credentialFingerprint,
        failedResources: [...row.failedResources],
        health: row.health,
        id: row.id,
        lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
        provider: row.provider,
        removalRequestedAt: row.removalRequestedAt?.toISOString() ?? null,
        scopes: [...row.grantedScopes],
      };
    }

    return {
      account: {
        // `connections_github_shape`: a GitHub row carries all three (spec 030 R2).
        id: row.accountId!,
        login: row.accountLogin,
        type: row.accountType!,
      },
      // Spec 044: an organisation creates with the installation token, a person through the App's OAuth.
      canCreateRepositories: row.accountType === 'organization' || this.github.canAuthorizeUsers(),
      circuitOpenUntil: row.circuitOpenUntil?.toISOString() ?? null,
      connectedAt: row.createdAt.toISOString(),
      connectedBy: { id: row.connectedBy, name: row.connectedByName },
      credentialFingerprint: row.credentialFingerprint,
      health: row.health,
      id: row.id,
      lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
      provider: row.provider,
    };
  }

  /** R8: the installation must be the App's own, and its first token must mint, before a row exists. */
  private async verified(
    installationId: number,
  ): Promise<{ installation: GithubInstallation; minted: MintedToken }> {
    try {
      const installation = await this.github.installation(installationId);

      return { installation, minted: await this.mint(installationId) };
    } catch (error) {
      throw this.restated(error);
    }
  }

  private async mint(installationId: number, repositoryIds?: number[]): Promise<MintedToken> {
    if (repositoryIds === undefined) {
      return this.github.mintToken(installationId, { permissions: ORG_TOKEN_PERMISSIONS });
    }

    try {
      return await this.github.mintToken(installationId, {
        permissions: REPO_TOKEN_PERMISSIONS,
        repositoryIds,
      });
    } catch (error) {
      if (!(error instanceof GithubApiError) || error.category !== 'validation') throw error;

      // A 422 is GitHub's "permissions not granted". One retry, and narrower, never wider: the
      // client's fail-closed rule stands. What this token cannot do fails as `workflow-permission`.
      return this.github.mintToken(installationId, {
        permissions: REPO_TOKEN_BASE_PERMISSIONS,
        repositoryIds,
      });
    }
  }

  /**
   * A mint on a connected row is verify-on-use (R9, SC-009): an authorisation failure moves it to
   * `needs_reauth` at once, any other provider failure counts toward the breaker (R10), and a
   * success closes it. The transition, if any, is audited once.
   */
  private async mintForRow(
    tx: TenantTransaction,
    row: Connection,
    repositoryIds?: number[],
  ): Promise<MintedToken> {
    const now = this.clock.now();
    let minted: MintedToken;

    try {
      minted = await this.mint(installationOf(row), repositoryIds);
    } catch (error) {
      if (!(error instanceof GithubApiError)) {
        throw error;
      }

      if (isRevoked(error)) {
        await this.transition(tx, row, null, () =>
          this.repository.setHealth(tx, row.orgId, row.id, 'needs_reauth', now),
        );

        throw syncConflict('needs-reauth', 'The GitHub connection needs to be reconnected.');
      }

      // Spec 044: a 422 on the narrow ask too is GitHub's answer for a repository the installation
      // cannot reach (deleted, or dropped from its selection). The App is healthy: no breaker.
      if (repositoryIds !== undefined && error.category === 'validation') {
        throw syncConflict('repo-gone', 'The linked repository is gone from this installation.');
      }

      await this.transition(tx, row, null, () =>
        this.repository.recordFailure(tx, row.orgId, row.id, now),
      );

      throw providerUnavailable(RETRY_AFTER_SECONDS);
    }

    await this.transition(tx, row, null, () =>
      this.repository.recordSuccess(tx, row.orgId, row.id, now),
    );

    return minted;
  }

  /** `write`, then one `connector.health-changed` if the row's health is not what it was. */
  private async transition(
    tx: TenantTransaction,
    row: Connection,
    actorId: string | null,
    write: () => Promise<void>,
  ): Promise<void> {
    await write();

    const after = await this.repository.byId(tx, row.orgId, row.id);

    if (after === undefined || after.health === row.health) {
      return;
    }

    await this.audit.record(tx, {
      action: 'connector.health-changed',
      actorId,
      metadata: { from: row.health, health: after.health, provider: row.provider },
      orgId: row.orgId,
      target: row.id,
    });
  }

  private async seal(tx: TenantTransaction, orgId: string, minted: MintedToken): Promise<string> {
    const sealed = await this.dek.sealSecret(tx, orgId, TOKEN_PURPOSE, minted.token);

    return this.repository.insertSecret(tx, orgId, TOKEN_PURPOSE, sealed);
  }

  /** §05: the provider's failure is classified and re-stated, never passed through. */
  private restated(error: unknown): Error {
    if (!(error instanceof GithubApiError)) {
      return error instanceof Error ? error : new Error(String(error));
    }

    return error.category === 'not-configured'
      ? new OauthProviderNotConfiguredError('github')
      : new OauthExchangeError('github');
  }
}

/** The one JSON secret a Supabase grant is sealed as (research R10). */
function sealedGrant(grant: { accessToken: string; refreshToken: string }): Plaintext {
  const sealed: SupabaseSealedGrant = {
    accessToken: grant.accessToken,
    refreshToken: grant.refreshToken,
  };

  return plaintext(JSON.stringify(sealed));
}

/** The sealed grant, or undefined when the secret is not one (it is then re-authorised). */
export function parseGrant(credential: Plaintext): SupabaseSealedGrant | undefined {
  try {
    const parsed = supabaseGrantSchema.safeParse(
      JSON.parse(revealPlaintext(credential).toString('utf8')),
    );

    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
