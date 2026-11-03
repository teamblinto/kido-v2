import { Inject, Injectable } from '@nestjs/common';
import {
  type NeonBindingConfig,
  neonBindingConfigSchema,
  resendBindingConfigSchema,
  type SupabaseBindingConfig,
  supabaseBindingConfigSchema,
} from '@repo/contracts';
import type { ConnectorResource } from '@repo/db';

import { CLOCK, type ClockPort } from '../../common/clock/clock.port';
import { type Plaintext, plaintext } from '../../common/crypto/branded';
import type { TenantTransaction } from '../../database/database.types';
import { AuditService } from '../audit/audit.service';
import { type BindingRecord, BindingRepository } from './binding.repository';
import type { ResourceReleaser } from './connection-remove.handler';
import { ConnectionService } from './connection.service';
import {
  type OperationContext,
  OperationFailure,
  type OperationHandler,
} from './connector-ops.consumer';
import { NEON_CLIENT, type NeonClient } from './providers/neon/neon.client';
import { ProviderFailure } from './providers/provider';
import { RESEND_CLIENT, type ResendClient } from './providers/resend/resend.client';
import { SUPABASE_CLIENT, type SupabaseClient } from './providers/supabase/supabase.client';
import { ResourceReleaseHandler } from './resource-release.handler';
import { ResourceRepository } from './resource.repository';
import { ResourceSecrets } from './resource-secrets';

/** data-model § 4: a sending key is named after the project, so a re-run finds its own key. */
export function sendingKeyName(projectId: string): string {
  return `forge-${projectId}`;
}

/** data-model § 4: the preview branch's name is the project's, so a re-run finds its own branch. */
export function previewBranchName(projectId: string): string {
  return `forge-preview-${projectId}`;
}

type Context = Pick<
  OperationContext,
  'connection' | 'credential' | 'inTenant' | 'lastAttempt' | 'operation'
>;

/** The operation's binding, bound, with its config parsed; `disconnected` otherwise. */
async function boundBinding(context: Context): Promise<BindingRecord> {
  const { bindingId, orgId } = context.operation;
  const binding =
    bindingId === null
      ? undefined
      : await context.inTenant((tx) => new BindingRepository().byId(tx, orgId, bindingId));

  if (binding?.state !== 'bound') throw new OperationFailure('disconnected');

  return binding;
}

/**
 * Shared by the handlers below: the resource rows and their sealed values, and a terminal failure
 * leaving the row `failed` rather than `provisioning` for ever.
 */
abstract class PreviewResourceWork {
  constructor(
    protected readonly resources: ResourceRepository,
    protected readonly secrets: ResourceSecrets,
    protected readonly audit: AuditService,
    protected readonly clock: ClockPort,
  ) {}

  /** The binding's `provisioning` row of `kind`, or a new one. */
  protected async provisioningRow(
    context: Context,
    binding: BindingRecord,
    kind: ConnectorResource['kind'],
    name: string,
    scopeRef: string,
  ): Promise<ConnectorResource> {
    const { orgId } = context.operation;

    return context.inTenant(async (tx) => {
      const existing = (
        await this.resources.listForBinding(tx, orgId, binding.id, { liveOnly: true })
      ).find((row) => row.kind === kind && row.state === 'provisioning');

      if (existing !== undefined) {
        await this.resources.update(tx, orgId, existing.id, { scopeRef });

        return { ...existing, scopeRef };
      }

      return this.resources.insert(tx, {
        bindingId: binding.id,
        connectionId: context.connection.id,
        kind,
        name,
        orgId,
        scopeRef,
      });
    });
  }

  /** `provisioning → live` with its value sealed; false when a removal released it meanwhile. */
  protected async goLive(
    context: Context,
    resource: ConnectorResource,
    kind: 'neon_branch' | 'resend_sending_key' | 'supabase_publishable_key',
    externalId: string | null,
    value: Plaintext,
  ): Promise<boolean> {
    const { orgId } = context.operation;

    return context.inTenant(async (tx) => {
      const secretId = await this.secrets.seal(tx, orgId, kind, value);
      const moved = await this.resources.transition(tx, orgId, resource.id, 'live', {
        externalId,
        secretId,
      });

      if (!moved) {
        await this.secrets.delete(tx, orgId, secretId);

        return false;
      }

      await this.secrets.delete(tx, orgId, resource.secretId);
      await this.audit.record(tx, {
        action: 'connector.resource-created',
        actorId: context.operation.requestedBy,
        metadata: { kind, name: resource.name, projectId: context.operation.projectId },
        orgId,
        target: resource.id,
      });

      return true;
    });
  }

  /** Closes a resource released without a provider call, and drops its sealed value. */
  protected async closeReleased(tx: TenantTransaction, resource: ConnectorResource): Promise<void> {
    const { orgId } = resource;

    if (resource.state === 'live') {
      await this.resources.transition(tx, orgId, resource.id, 'releasing');
    }

    // The value goes with the resource: the FK is `no action`, so the row lets go of it first.
    await this.resources.transition(tx, orgId, resource.id, 'released', {
      releasedAt: this.clock.now(),
      secretId: null,
    });
    await this.secrets.delete(tx, orgId, resource.secretId);
    await this.audit.record(tx, {
      action: 'connector.resource-released',
      actorId: null,
      metadata: { kind: resource.kind, name: resource.name },
      orgId,
      target: resource.id,
    });
  }

  /** A terminal failure (or the last attempt) leaves the row `failed`; a retryable one keeps it. */
  protected async failed(context: Context, resource: ConnectorResource, error: unknown) {
    const terminal = !(error instanceof ProviderFailure) || !error.retryable || context.lastAttempt;

    if (terminal) {
      await context.inTenant((tx) =>
        this.resources.transition(tx, context.operation.orgId, resource.id, 'failed'),
      );
    }
  }
}

/**
 * `neon_branch_create` and `neon_branch_reset` (spec 030 R9, contracts/provider-adapters.md § 3):
 * one preview branch per binding, named after the project so a re-run adopts the branch an earlier
 * attempt made (`findBranch`) rather than making a second. A re-bind's old branches — rows moved to
 * `releasing` by the bind, or left `live` in another Neon project — are deleted first. The value is
 * the branch's pooled URI, sealed as `connector:neon:branch-uri`.
 */
@Injectable()
export class NeonBranchHandler extends PreviewResourceWork implements OperationHandler {
  constructor(
    @Inject(NEON_CLIENT) private readonly neon: NeonClient,
    @Inject(ResourceRepository) resources: ResourceRepository,
    @Inject(ResourceSecrets) secrets: ResourceSecrets,
    @Inject(AuditService) audit: AuditService,
    @Inject(CLOCK) clock: ClockPort,
  ) {
    super(resources, secrets, audit, clock);
  }

  async run(context: OperationContext): Promise<void> {
    const binding = await boundBinding(context);
    const config = neonBindingConfigSchema.parse(binding.config);
    const reset = context.operation.kind === 'neon_branch_reset';

    await this.releaseStale(context, binding, config, reset);

    const current = await this.current(context, binding);

    if (current?.state === 'live') return;

    const resource = await this.provisioningRow(
      context,
      binding,
      'neon_branch',
      previewBranchName(binding.projectId),
      config.projectId,
    );

    try {
      const branch =
        (await this.neon.findBranch(context.credential, config.projectId, resource.name)) ??
        (await this.neon.createBranch(
          context.credential,
          config.projectId,
          config.parentBranchId,
          resource.name,
        ));

      await context.inTenant((tx) =>
        this.resources.update(tx, context.operation.orgId, resource.id, { externalId: branch.id }),
      );

      const uri = await this.neon.connectionUri(
        context.credential,
        config.projectId,
        branch.id,
        config.databaseName,
        config.roleName,
      );

      if (!(await this.goLive(context, resource, 'neon_branch', branch.id, plaintext(uri)))) {
        // A removal released the row while this ran: what was made here goes too (§ Edge cases).
        await this.neon.deleteBranch(context.credential, config.projectId, branch.id);
        throw new OperationFailure('disconnected');
      }
    } catch (error) {
      if (!(error instanceof OperationFailure)) await this.failed(context, resource, error);
      throw error;
    }

    if (reset) {
      await context.inTenant((tx) =>
        this.audit.record(tx, {
          action: 'connector.database-reset',
          actorId: context.operation.requestedBy,
          metadata: { projectId: binding.projectId },
          orgId: context.operation.orgId,
          target: binding.id,
        }),
      );
    }
  }

  private async current(
    context: Context,
    binding: BindingRecord,
  ): Promise<ConnectorResource | undefined> {
    const rows = await context.inTenant((tx) =>
      this.resources.listForBinding(tx, context.operation.orgId, binding.id, { liveOnly: true }),
    );

    return rows.find((row) => row.kind === 'neon_branch');
  }

  /**
   * Deletes, at Neon, every branch of this binding that is not the one the config names: rows a
   * re-bind moved to `releasing`, `live` rows in another Neon project — and, for a reset, the live
   * branch itself, whose row then goes `releasing → provisioning` (the same row, R9).
   */
  private async releaseStale(
    context: Context,
    binding: BindingRecord,
    config: NeonBindingConfig,
    reset: boolean,
  ): Promise<void> {
    const { orgId } = context.operation;
    const rows = await context.inTenant((tx) =>
      this.resources.listForBinding(tx, orgId, binding.id, { liveOnly: true }),
    );

    for (const row of rows.filter((candidate) => candidate.kind === 'neon_branch')) {
      const sameProject = row.scopeRef === config.projectId;
      const resetting = reset && sameProject && row.state !== 'provisioning';
      const stale = row.state === 'releasing' || (row.state === 'live' && !sameProject);

      if (!stale && !resetting) continue;

      if (row.state === 'live') {
        await context.inTenant((tx) => this.resources.transition(tx, orgId, row.id, 'releasing'));
      }

      if (row.externalId !== null && row.scopeRef !== null) {
        await this.neon.deleteBranch(context.credential, row.scopeRef, row.externalId);
      }

      await context.inTenant(async (tx) => {
        if (resetting && sameProject) {
          await this.resources.transition(tx, orgId, row.id, 'provisioning', {
            externalId: null,
            secretId: null,
          });
          await this.secrets.delete(tx, orgId, row.secretId);

          return;
        }

        await this.closeReleased(tx, { ...row, state: 'releasing' });
      });
    }
  }
}

/**
 * `supabase_key_fetch` (spec 030 R10): the project's publishable key, read (never revealed) with the
 * connection's access token, sealed as `connector:supabase:publishable-key`. Nothing is created at
 * Supabase, so a re-bind's old key rows are closed without a provider call.
 */
@Injectable()
export class SupabaseKeyHandler extends PreviewResourceWork implements OperationHandler {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    @Inject(ConnectionService) private readonly connections: ConnectionService,
    @Inject(ResourceRepository) resources: ResourceRepository,
    @Inject(ResourceSecrets) secrets: ResourceSecrets,
    @Inject(AuditService) audit: AuditService,
    @Inject(CLOCK) clock: ClockPort,
  ) {
    super(resources, secrets, audit, clock);
  }

  async run(context: OperationContext): Promise<void> {
    const binding = await boundBinding(context);
    const config: SupabaseBindingConfig = supabaseBindingConfigSchema.parse(binding.config);
    const { orgId } = context.operation;

    await context.inTenant(async (tx) => {
      for (const row of await this.resources.listForBinding(tx, orgId, binding.id, {
        liveOnly: true,
      })) {
        if (row.kind !== 'supabase_publishable_key') continue;
        // A re-fetch replaces the value: the old row closes, a new one goes live.
        if (row.state !== 'provisioning') await this.closeReleased(tx, row);
      }
    });

    const resource = await this.provisioningRow(
      context,
      binding,
      'supabase_publishable_key',
      config.projectRef,
      config.projectRef,
    );

    try {
      const token = await context.inTenant((tx) =>
        this.connections.currentToken(tx, orgId, 'supabase'),
      );
      const key = await this.supabase.publishableKey(token, config.projectRef);

      if (
        !(await this.goLive(context, resource, 'supabase_publishable_key', null, plaintext(key)))
      ) {
        throw new OperationFailure('disconnected');
      }
    } catch (error) {
      if (!(error instanceof OperationFailure)) await this.failed(context, resource, error);
      throw error;
    }
  }
}

/**
 * `resend_key_mint` (spec 030 US5, contracts/provider-adapters.md § 5): a key that can only send,
 * and only from the bound domain, named `forge-<projectId>`, sealed as
 * `connector:resend:sending-key`. Resend returns the token only at create, so a key of that name
 * whose token was never sealed — the crash between create and seal — is deleted and minted again.
 * A re-bind's old key (another domain, or moved to `releasing`) is deleted first.
 */
@Injectable()
export class ResendKeyHandler extends PreviewResourceWork implements OperationHandler {
  constructor(
    @Inject(RESEND_CLIENT) private readonly resend: ResendClient,
    @Inject(ResourceRepository) resources: ResourceRepository,
    @Inject(ResourceSecrets) secrets: ResourceSecrets,
    @Inject(AuditService) audit: AuditService,
    @Inject(CLOCK) clock: ClockPort,
  ) {
    super(resources, secrets, audit, clock);
  }

  async run(context: OperationContext): Promise<void> {
    const binding = await boundBinding(context);
    const config = resendBindingConfigSchema.parse(binding.config);
    const { orgId } = context.operation;
    const rows = await context.inTenant((tx) =>
      this.resources.listForBinding(tx, orgId, binding.id, { liveOnly: true }),
    );
    const keys = rows.filter((row) => row.kind === 'resend_sending_key');

    for (const row of keys) {
      const stale =
        row.state === 'releasing' || (row.state === 'live' && row.scopeRef !== config.domainId);
      if (!stale) continue;

      if (row.state === 'live') {
        await context.inTenant((tx) => this.resources.transition(tx, orgId, row.id, 'releasing'));
      }
      if (row.externalId !== null) await this.resend.deleteKey(context.credential, row.externalId);
      await context.inTenant((tx) => this.closeReleased(tx, { ...row, state: 'releasing' }));
    }

    if (keys.some((row) => row.state === 'live' && row.scopeRef === config.domainId)) return;

    const resource = await this.provisioningRow(
      context,
      binding,
      'resend_sending_key',
      sendingKeyName(binding.projectId),
      config.domainId,
    );

    try {
      // Whatever key of this name exists holds a token nobody sealed: it goes, then one is minted.
      for (const existing of await this.resend.listKeys(context.credential)) {
        if (existing.name === resource.name) {
          await this.resend.deleteKey(context.credential, existing.id);
        }
      }

      const created = await this.resend.createSendingKey(
        context.credential,
        resource.name,
        config.domainId,
      );

      await context.inTenant((tx) =>
        this.resources.update(tx, orgId, resource.id, { externalId: created.id }),
      );

      if (
        !(await this.goLive(
          context,
          resource,
          'resend_sending_key',
          created.id,
          plaintext(created.token),
        ))
      ) {
        await this.resend.deleteKey(context.credential, created.id);
        throw new OperationFailure('disconnected');
      }
    } catch (error) {
      if (!(error instanceof OperationFailure)) await this.failed(context, resource, error);
      throw error;
    }
  }
}

/** A sending key's release (§ 7): deleted at Resend by id; `404` is success. */
@Injectable()
export class ResendKeyReleaser implements ResourceReleaser {
  constructor(@Inject(RESEND_CLIENT) private readonly resend: ResendClient) {}

  async release(credential: Plaintext, resource: ConnectorResource): Promise<void> {
    if (resource.externalId === null) return;

    await this.resend.deleteKey(credential, resource.externalId);
  }
}

/** A Neon branch's release (§ 7): deleted in its Neon project by id; `404` is success. */
@Injectable()
export class NeonBranchReleaser implements ResourceReleaser {
  constructor(@Inject(NEON_CLIENT) private readonly neon: NeonClient) {}

  async release(credential: Plaintext, resource: ConnectorResource): Promise<void> {
    if (resource.externalId === null || resource.scopeRef === null) return;

    await this.neon.deleteBranch(credential, resource.scopeRef, resource.externalId);
  }
}

/** A publishable key is read, not created: releasing it is forgetting it (no provider call). */
@Injectable()
export class SupabaseKeyReleaser implements ResourceReleaser {
  release(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * `resource_release` for a binding (the unbind of contracts/bindings.md § 2, and the archive of
 * T075): the shared release runs first, then the released rows let go of their sealed values and,
 * once nothing of the binding is live, the binding row goes. A domain's or a single resource's
 * release is the shared handler's alone.
 */
@Injectable()
export class BindingReleaseHandler implements OperationHandler {
  constructor(
    @Inject(ResourceReleaseHandler) private readonly release: ResourceReleaseHandler,
    @Inject(ResourceRepository) private readonly resources: ResourceRepository,
    @Inject(ResourceSecrets) private readonly secrets: ResourceSecrets,
    @Inject(BindingRepository) private readonly bindings: BindingRepository,
  ) {}

  async run(context: OperationContext): Promise<void> {
    await this.release.run(context);

    const { bindingId, orgId } = context.operation;

    if (bindingId === null || context.operation.domainId !== null) return;

    await context.inTenant(async (tx) => {
      const rows = await this.resources.listForBinding(tx, orgId, bindingId);

      for (const row of rows) {
        if (row.state !== 'released' || row.secretId === null) continue;
        await this.resources.update(tx, orgId, row.id, { secretId: null });
        await this.secrets.delete(tx, orgId, row.secretId);
      }

      if (rows.some((row) => ['provisioning', 'live', 'releasing'].includes(row.state))) return;

      await this.bindings.delete(tx, orgId, bindingId);
    });
  }
}
