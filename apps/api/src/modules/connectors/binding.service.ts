import { Inject, Injectable } from '@nestjs/common';
import {
  type Binding,
  BIND_REQUEST_SCHEMAS,
  type NetlifyBindRequest,
  type ResendBindRequest,
  type BindingProvider,
  type ConnectorOpKind,
  neonBindingConfigSchema,
  netlifyBindingConfigSchema,
  type Operation,
  resendBindingConfigSchema,
  supabaseBindingConfigSchema,
} from '@repo/contracts';
import type { ConnectorOperation } from '@repo/db';
import type { z } from 'zod';

import { ConflictError, DomainError, NotFoundError } from '../../common/errors/domain-error';
import { OrgCacheKey } from '../../common/redis/cache-key';
import { OrgCache } from '../../common/redis/org-cache';
import type { TenantTransaction } from '../../database/database.types';
import { AuditService } from '../audit/audit.service';
import { ReleaseReader } from '../deploy/release-reader';
import type { SandboxRef } from '../sandbox/sandbox.port';
import { type BindingRecord, BindingRepository } from './binding.repository';
import { ConnectionService } from './connection.service';
import { ConnectorListings } from './connector-listings';
import { OperationRepository } from './operation.repository';
import { OperationService } from './operation.service';
import { RepoLinkRepository } from './repo-link.repository';
import { ResourceRepository } from './resource.repository';

/** data-model § 3: `config` is Zod-parsed on every write and every read. */
export const BINDING_CONFIG_SCHEMAS = {
  neon: neonBindingConfigSchema,
  netlify: netlifyBindingConfigSchema,
  resend: resendBindingConfigSchema,
  supabase: supabaseBindingConfigSchema,
} as const satisfies Record<BindingProvider, z.ZodType>;

/**
 * What a bind stores and enqueues, per provider. Neon and Supabase are this story's (US3); the
 * Netlify and Resend stories add theirs here (contracts/bindings.md § 2).
 */
export interface BindPlan {
  readonly config: Record<string, unknown>;
  readonly enqueue: ConnectorOpKind | null;
}

type Planner = (body: unknown) => BindPlan;

const PLANNERS: Partial<Record<BindingProvider, Planner>> = {
  neon: (body) => ({
    config: BIND_REQUEST_SCHEMAS.neon.parse(body),
    enqueue: 'neon_branch_create',
  }),
  supabase: (body) => ({
    config: BIND_REQUEST_SCHEMAS.supabase.parse(body),
    enqueue: 'supabase_key_fetch',
  }),
  // US4: `{ siteId }` or `{ createSite }`; the site is read or created in the request (below).
  netlify: (body) => ({ config: BIND_REQUEST_SCHEMAS.netlify.parse(body), enqueue: null }),
  // US5: the domain is read in the request; the key is minted now only if it is `verified`.
  resend: (body) => ({ config: BIND_REQUEST_SCHEMAS.resend.parse(body), enqueue: null }),
};

/** T095: a `pending` Resend domain is re-read at most once a minute per binding. */
const RESEND_STATUS_TTL_SECONDS = 60;

function resendStatusKey(orgId: string, bindingId: string): OrgCacheKey {
  return OrgCacheKey.build(orgId, 'resend-domain', bindingId);
}

function sameConfig(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = Object.keys(a).sort();

  return keys.length === Object.keys(b).length && keys.every((key) => Object.is(a[key], b[key]));
}

/**
 * A project's bindings to provider resources (spec 030 US3–US5, contracts/bindings.md § 2). Bind
 * and unbind are `org:connectors.manage` at the route; the connection is checked usable from its
 * row before anything is written (FR-008, no provider call, < 1 s). The provider work itself is an
 * operation (`OperationService`); a re-bind to a different resource moves the old resources to
 * `releasing` in the same transaction, so the preview stops receiving their values at once and the
 * enqueued create releases them at the provider before it makes the new one.
 */
@Injectable()
export class BindingService {
  constructor(
    @Inject(BindingRepository) private readonly bindings: BindingRepository,
    @Inject(ResourceRepository) private readonly resources: ResourceRepository,
    @Inject(OperationRepository) private readonly operationRows: OperationRepository,
    @Inject(OperationService) private readonly operations: OperationService,
    @Inject(ConnectionService) private readonly connections: ConnectionService,
    @Inject(RepoLinkRepository) private readonly projects: RepoLinkRepository,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ConnectorListings) private readonly listings: ConnectorListings,
    @Inject(ReleaseReader) private readonly releases: ReleaseReader,
    @Inject(OrgCache) private readonly cache: OrgCache,
  ) {}

  async list(tx: TenantTransaction, ref: SandboxRef): Promise<Binding[]> {
    await this.project(tx, ref);

    const rows = await this.bindings.listForProject(tx, ref.orgId, ref.projectId);

    return this.toContracts(tx, ref.orgId, rows);
  }

  async get(tx: TenantTransaction, ref: SandboxRef, provider: BindingProvider): Promise<Binding> {
    const row = await this.bindings.forProvider(tx, ref.orgId, ref.projectId, provider);

    if (row === undefined) throw new NotFoundError('The project is not bound to that provider.');

    return (await this.toContracts(tx, ref.orgId, [row]))[0]!;
  }

  /** `PUT /:provider`: bind, or re-bind (unbind-then-bind in one request). */
  async bind(
    tx: TenantTransaction,
    ref: SandboxRef,
    actorId: string,
    provider: BindingProvider,
    body: unknown,
  ): Promise<Binding> {
    const planner = PLANNERS[provider];

    if (planner === undefined) {
      throw new DomainError('validation-failed', `Binding ${provider} is not offered here.`);
    }

    const plan = planner(body);

    await this.project(tx, ref, { writable: true });

    const connection = await this.connections.ensureUsable(tx, ref.orgId, provider);
    // Netlify's site and Resend's domain are resolved now, one provider call, so the binding
    // stores their names (and Resend's status decides whether the key is minted now).
    let resolved: Record<string, unknown> = plan.config;
    let enqueue = plan.enqueue;
    let resendStatus: string | undefined;

    if (provider === 'netlify') {
      resolved = await this.listings.netlifySite(tx, connection, plan.config as NetlifyBindRequest);
    } else if (provider === 'resend') {
      const { status, ...domain } = await this.listings.resendDomain(
        tx,
        connection,
        (plan.config as ResendBindRequest).domainId,
      );
      resolved = domain;
      resendStatus = status;
      enqueue = status === 'verified' ? 'resend_key_mint' : null;
    }
    const config = BINDING_CONFIG_SCHEMAS[provider].parse(resolved) as Record<string, unknown>;
    const current = await this.bindings.forProvider(tx, ref.orgId, ref.projectId, provider);
    const unchanged =
      current?.state === 'bound' &&
      current.connectionId === connection.id &&
      sameConfig(current.config, config);

    if (current !== undefined && !unchanged) {
      // Re-bind: the old resources stop being live now; the create releases them first.
      for (const resource of await this.resources.listForBinding(tx, ref.orgId, current.id, {
        liveOnly: true,
      })) {
        if (resource.state === 'live') {
          await this.resources.transition(tx, ref.orgId, resource.id, 'releasing');
        }
      }

      await this.audit.record(tx, {
        action: 'connector.unbound',
        actorId,
        metadata: { projectId: ref.projectId, provider, rebind: true },
        orgId: ref.orgId,
        target: current.id,
      });
    }

    const row = await this.bindings.upsert(tx, {
      boundBy: actorId,
      config,
      connectionId: connection.id,
      orgId: ref.orgId,
      projectId: ref.projectId,
      provider,
    });

    if (resendStatus !== undefined) {
      await this.cache.set(
        resendStatusKey(ref.orgId, row.id),
        resendStatus,
        RESEND_STATUS_TTL_SECONDS,
      );
    }

    if (enqueue !== null) {
      await this.operations.request(tx, ref.orgId, {
        bindingId: row.id,
        kind: enqueue,
        projectId: ref.projectId,
        requestedBy: actorId,
      });
    }

    if (!unchanged) {
      await this.audit.record(tx, {
        action: 'connector.bound',
        actorId,
        metadata: { projectId: ref.projectId, provider },
        orgId: ref.orgId,
        target: row.id,
      });
    }

    return this.get(tx, ref, provider);
  }

  /**
   * `DELETE /:provider`: a `resource_release` operation for the binding; the row goes when the
   * release completes. `actorId` null is the platform (the project was archived, T075).
   */
  async unbind(
    tx: TenantTransaction,
    ref: SandboxRef,
    actorId: string | null,
    provider: BindingProvider,
  ): Promise<Operation> {
    const row = await this.bindings.forProvider(tx, ref.orgId, ref.projectId, provider);

    if (row === undefined) throw new NotFoundError('The project is not bound to that provider.');

    const operation = await this.operations.request(tx, ref.orgId, {
      bindingId: row.id,
      kind: 'resource_release',
      projectId: ref.projectId,
      requestedBy: actorId,
    });

    await this.audit.record(tx, {
      action: 'connector.unbound',
      actorId,
      metadata: { projectId: ref.projectId, provider },
      orgId: ref.orgId,
      target: row.id,
    });

    return this.operations.toContract(operation);
  }

  /**
   * `project.archived` (T075): every binding of the project released as an unbind by the platform
   * (`requestedBy` null). A redelivery finds the release it queued still open and queues none; a
   * `disconnected` binding, whose connection is gone, has nothing to release through and goes now.
   */
  async releaseForArchivedProject(
    tx: TenantTransaction,
    orgId: string,
    projectId: string,
  ): Promise<void> {
    const rows = await this.bindings.listForProject(tx, orgId, projectId);
    const latest = await this.operationRows.latestForBindings(
      tx,
      orgId,
      rows.map((row) => row.id),
    );

    for (const row of rows) {
      if (row.state === 'disconnected' || row.connectionId === null) {
        await this.bindings.delete(tx, orgId, row.id);
        continue;
      }

      const open = latest.get(row.id);

      if (
        open?.kind === 'resource_release' &&
        (open.state === 'queued' || open.state === 'running')
      ) {
        continue;
      }

      await this.unbind(tx, { orgId, projectId }, null, row.provider as BindingProvider);
    }
  }

  /** `POST /neon/reset`: `409 in-flight` when a branch change is already queued or running. */
  async requestNeonReset(
    tx: TenantTransaction,
    ref: SandboxRef,
    actorId: string,
  ): Promise<Operation> {
    await this.project(tx, ref, { writable: true });

    const row = await this.bindings.forProvider(tx, ref.orgId, ref.projectId, 'neon');

    if (row?.state !== 'bound') {
      throw new NotFoundError('The project is not bound to a Neon project.');
    }

    await this.connections.ensureUsable(tx, ref.orgId, 'neon');

    const operation: ConnectorOperation = await this.operations.request(tx, ref.orgId, {
      bindingId: row.id,
      kind: 'neon_branch_reset',
      projectId: ref.projectId,
      requestedBy: actorId,
    });

    return this.operations.toContract(operation);
  }

  /**
   * `POST /netlify/publish` (US4, R11): a `netlify_publish` of a `succeeded` release of this
   * project — another project's release is a `404` like a missing one; `409 in-flight` while a
   * publish of the binding is queued or running.
   */
  async requestNetlifyPublish(
    tx: TenantTransaction,
    ref: SandboxRef,
    actorId: string,
    deploymentId: string,
  ): Promise<Operation> {
    await this.project(tx, ref, { writable: true });

    const row = await this.bindings.forProvider(tx, ref.orgId, ref.projectId, 'netlify');

    if (row?.state !== 'bound') {
      throw new NotFoundError('The project is not bound to a Netlify site.');
    }

    if (!(await this.releases.isRelease(tx, ref.orgId, ref.projectId, deploymentId))) {
      throw new NotFoundError('No such release.');
    }

    await this.connections.ensureUsable(tx, ref.orgId, 'netlify');

    const operation: ConnectorOperation = await this.operations.request(tx, ref.orgId, {
      bindingId: row.id,
      deploymentId,
      kind: 'netlify_publish',
      projectId: ref.projectId,
      requestedBy: actorId,
    });

    return this.operations.toContract(operation);
  }

  /** The row's `config` through its provider's schema; a row that fails is a bug, not a 4xx. */
  parseConfig(row: Pick<BindingRecord, 'config' | 'provider'>): Record<string, unknown> {
    return BINDING_CONFIG_SCHEMAS[row.provider as BindingProvider].parse(row.config);
  }

  private async toContracts(
    tx: TenantTransaction,
    orgId: string,
    rows: readonly BindingRecord[],
  ): Promise<Binding[]> {
    const latest = await this.operationRows.latestForBindings(
      tx,
      orgId,
      rows.map((row) => row.id),
    );
    const out: Binding[] = [];

    for (const row of rows) {
      const resources = await this.resources.listForBinding(tx, orgId, row.id, { liveOnly: true });
      let operation = latest.get(row.id);
      let domainStatus: string | null = null;

      if (row.provider === 'resend') {
        const checked = await this.resendDomainStatus(tx, orgId, row, resources, operation);
        domainStatus = checked.status;
        operation = checked.operation;
      }

      const base = {
        boundBy: { id: row.boundBy, name: row.boundByName },
        connectionId: row.connectionId,
        createdAt: row.createdAt.toISOString(),
        id: row.id,
        latestOperation: operation === undefined ? null : this.operations.toContract(operation),
        projectId: row.projectId,
        resources: resources.map((resource) => ({
          kind: resource.kind,
          name: resource.name,
          state: resource.state,
        })),
        state: row.state,
        updatedAt: row.updatedAt.toISOString(),
      };
      const config = this.parseConfig(row);

      out.push(
        (row.provider === 'resend'
          ? { ...base, config, domainStatus, provider: row.provider }
          : { ...base, config, provider: row.provider }) as Binding,
      );
    }

    return out;
  }

  /**
   * T095: a Resend binding without a sending key shows its domain's status, re-read from Resend at
   * most once a minute (`OrgCache`); a fresh read that finds it `verified` requests the mint, unless
   * one is already open. The daily sweep stays the fallback. A key already there: `null`.
   */
  private async resendDomainStatus(
    tx: TenantTransaction,
    orgId: string,
    row: BindingRecord,
    resources: readonly { kind: string; state: string }[],
    operation: ConnectorOperation | undefined,
  ): Promise<{ status: string | null; operation: ConnectorOperation | undefined }> {
    const keyed = resources.some(
      (resource) =>
        resource.kind === 'resend_sending_key' &&
        (resource.state === 'live' || resource.state === 'provisioning'),
    );

    if (row.state !== 'bound' || row.connectionId === null || keyed) {
      return { operation, status: null };
    }

    const cacheKey = resendStatusKey(orgId, row.id);
    const cached = await this.cache.get(cacheKey);

    if (cached !== null) return { operation, status: cached };

    let status: string;

    try {
      const connection = await this.connections.byId(tx, orgId, row.connectionId);
      if (connection.health !== 'healthy') return { operation, status: null };

      const config = resendBindingConfigSchema.parse(row.config);
      status = await this.listings.resendDomainStatus(tx, connection, config.domainId);
    } catch {
      // A read that fails shows no status; the next listing (or the sweep) tries again.
      return { operation, status: null };
    }

    await this.cache.set(cacheKey, status, RESEND_STATUS_TTL_SECONDS);

    const open = operation?.state === 'queued' || operation?.state === 'running';

    if (status === 'verified' && !open) {
      const requested = await this.operations.request(tx, orgId, {
        bindingId: row.id,
        kind: 'resend_key_mint',
        projectId: row.projectId,
        requestedBy: null,
      });

      return { operation: requested, status };
    }

    return { operation, status };
  }

  private async project(
    tx: TenantTransaction,
    ref: SandboxRef,
    options: { readonly writable?: boolean } = {},
  ): Promise<void> {
    const project = await this.projects.project(tx, ref.orgId, ref.projectId);

    if (project === undefined) throw new NotFoundError('No such project.');

    if (options.writable === true && project.archived) {
      throw new ConflictError('This project is archived.');
    }
  }
}
