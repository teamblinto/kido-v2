import type { INestApplication } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { sessionListResponseSchema } from '@repo/contracts';
import { schema } from '@repo/db';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { APP_DATABASE } from '../src/database/database.constants';
import type { ForgeDatabase } from '../src/database/database.types';
import { TenantTransactionRunner } from '../src/database/tenant-transaction';
import { MemoryObjectStore } from '../src/common/object-store/memory-object-store';
import { ATTACHMENT_STORE } from '../src/modules/agent/attachments/attachment.service';
import { RunService } from '../src/modules/agent/run.service';
import { RunStore } from '../src/modules/agent/run-store';
import type { Environment } from '../src/config/environment';
import { AuditService } from '../src/modules/audit/audit.service';
import { CheckpointRepository } from '../src/modules/checkpoints/checkpoint.repository';
import { ConnectionRepository } from '../src/modules/connectors/connection.repository';
import { SyncRepository } from '../src/modules/connectors/sync.repository';
import { DeploymentRepository } from '../src/modules/deploy/deployment.repository';
import type { CustomHostnamePort } from '../src/modules/deploy/domains/custom-hostname.port';
import type { DnsPort } from '../src/modules/deploy/domains/dns.port';
import { EndpointService } from '../src/modules/webhooks/outbound/endpoint.service';
import { WebhookAttemptConsumer } from '../src/modules/webhooks/outbound/attempt.consumer';
import { EndpointRepository } from '../src/modules/webhooks/outbound/endpoint.repository';
import type { SafeTransport } from '../src/modules/webhooks/outbound/safe-transport';
import { SendRepository } from '../src/modules/webhooks/outbound/send.repository';
import { SigningSecrets } from '../src/modules/webhooks/outbound/signing-secret';
import { DomainRepository } from '../src/modules/deploy/domains/domain.repository';
import { DomainCheckConsumer } from '../src/modules/deploy/domains/domain-check.consumer';
import { DomainChecker } from '../src/modules/deploy/domains/domain-checker';
import { DomainNotices } from '../src/modules/deploy/domains/domain-notices';
import { ownershipToken } from '../src/modules/deploy/domains/ownership-token';
import type { Envelope } from '../src/modules/outbox/envelope';
import { OutboxWriter } from '../src/modules/outbox/outbox-writer';
import { PermissionCache } from '../src/modules/rbac/permission-cache';
import { ProjectService } from '../src/modules/tenancy/services/project.service';
import { WorkspaceService } from '../src/modules/tenancy/services/workspace.service';
import { unsafe } from './support/csrf-client';
import { holdOutboxSuiteLock } from './support/outbox-suite-lock';
import { seedProviderKey } from './support/seed-provider-key';
import {
  type EnumeratedRoute,
  enumerateRoutes,
  fillRoutePath,
  partitionRoutes,
} from './support/route-enumerator';
import {
  type Principal,
  type Tenant,
  type TwoTenantWorld,
  createTwoTenantWorld,
  destroyTwoTenantWorld,
  http,
  tenantOwnedTables,
} from './support/two-tenant-fixture';

vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SWAGGER_ENABLED = 'false';
  process.env.ARGON2_MEMORY_KIB = '8192';
  process.env.ARGON2_PARALLELISM = '1';
  process.env.ARGON2_TIME_COST = '1';
  process.env.LOGIN_THROTTLE_ACCOUNT_BURST = '100';
  process.env.LOGIN_THROTTLE_IP_BURST = '4000';
  // This suite sends every route three times over. The global throttle is not what it is testing,
  // and a `429` in the middle of the sweep would be a refusal that proves nothing about tenancy —
  // it would look exactly like isolation working while the request never reached the guard.
  process.env.THROTTLE_LIMIT = '100000';
});

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

/**
 * How the suite points a route parameter at the *other* tenant.
 *
 * This map, and not a list of URLs, is what the gate is built on. The route list comes from the
 * router; a route added later is swept the moment it is mounted, with no edit here — unless it
 * introduces a parameter nobody has classified, which fails `the route table` below rather than
 * being skipped. That is the whole difference between a gate and a snapshot: the default for
 * something new is *covered*, and the exceptions have to be argued for in this file.
 */
const TENANT_PARAMETERS: Readonly<Record<string, (target: Tenant, world: SweepWorld) => string>> = {
  /** `…/attachments/:attachmentId` (spec 048): a pending file in beta's project, row and bytes. */
  attachmentId: (_target, world) => world.betaAttachmentId,
  /** `…/checkpoints/:checkpointId` (spec 016): a checkpoint in beta's project, inserted as a row. */
  checkpointId: (_target, world) => world.betaCheckpointId,
  /** `…/connectors/:connectionId` (spec 018): beta's GitHub connection, inserted as a row. */
  connectionId: (_target, world) => world.betaConnectionId,
  /** `…/deployments/:deploymentId` (spec 027): a queued deployment in beta's project, inserted as a row. */
  deploymentId: (_target, world) => world.betaDeploymentId,
  /** `…/domains/:domainId` (spec 028): a pending domain on beta's project, inserted as a row. */
  domainId: (_target, world) => world.betaDomainId,
  /** `…/deliveries/:deliveryId` (spec 029 US4): a `not_sent` delivery of beta's endpoint, its body held. */
  deliveryId: (_target, world) => world.betaDeliveryId,
  /** `…/webhooks/endpoints/:endpointId` (spec 029): beta's webhook endpoint, created through the service. */
  endpointId: (_target, world) => world.betaEndpointId,
  grantId: (_target, world) => world.betaMcpGrantId,
  /** `DELETE /auth/sessions/:id`. Not org-scoped, but a resource that belongs to another principal. */
  id: (_target, world) => world.betaSessionId,
  /** `…/invitations/:invitationId` (spec 031): an open invitation to beta's project, inserted as a row. */
  invitationId: (_target, world) => world.betaInvitationId,
  /** `…/sync/:operationId` (spec 018): a queued sync operation in beta's project, inserted as a row. */
  operationId: (_target, world) => world.betaOperationId,
  orgId: (target) => target.orgId,
  projectId: (target) => target.projectId,
  /** `…/runs/:runId` (spec 008): a run in beta's project, created through the service. */
  runId: (_target, world) => world.betaRunId,
  userId: (target) => target.owner.userId,
  workspaceId: (target) => target.workspaceId,
};

/**
 * Parameters that name nothing a tenant owns, and so cannot be aimed at one, with the fixed value
 * a probe fills them with.
 *
 * `:provider` is `github` or `google` on the OAuth routes and `anthropic` or `openai` on the
 * provider-key routes (spec 020). Substituting another tenant's anything for it produces a `501`
 * about an OAuth provider or a `404` about a model provider, which is a fact about the catalogue
 * and not about isolation; the org-scoped routes it sits on are still swept through `:orgId`. It
 * is listed rather than ignored so that the next parameter of this kind has to be looked at by a
 * person.
 */
const NON_TENANT_PARAMETERS: Readonly<Record<string, string>> = {
  provider: 'anthropic',
};

/**
 * Routes that address no tenant-owned resource, and the reason each one does not.
 *
 * Every entry is a claim, and `the route table` checks both directions of it: a route here that is
 * no longer mounted fails, and a route that is mounted, takes no tenant parameter and is *not* here
 * fails. So adding a controller cannot quietly widen this list, and deleting one cannot quietly
 * leave a stale excuse behind.
 *
 * The pattern is that all of them are either unauthenticated, or scoped to the caller's own account
 * rather than to an organisation. None of them takes an identifier a caller could point at somebody
 * else's data — which is exactly what makes them unreachable for a cross-tenant probe, and is why
 * `DELETE /auth/sessions/:id`, which *does* take one, is not here.
 */
const ROUTES_WITH_NO_TENANT_RESOURCE = new Set([
  // The service root and the health probe. Neither reads a tenant, and health is deliberately
  // reachable without a session at all.
  'GET /api/v1',
  'GET /api/v1/health',
  // The running build (spec 025 FR-033, read by 027's deploy confirmation): `@Public()`, three
  // values baked into the image, nothing about any tenant (`version.controller.ts`).
  'GET /api/v1/version',
  // Identity. Every one of these is about the caller's own account or about no account yet: there
  // is no identifier in any of their paths, so there is nothing to point at another tenant.
  'GET /api/v1/auth/oauth/:provider',
  'GET /api/v1/auth/oauth/:provider/callback',
  'GET /api/v1/auth/me',
  'GET /api/v1/auth/sessions',
  'POST /api/v1/auth/login',
  'POST /api/v1/auth/logout',
  'POST /api/v1/auth/mfa/challenge',
  'POST /api/v1/auth/mfa/step-up',
  'POST /api/v1/auth/mfa/totp',
  'POST /api/v1/auth/mfa/totp/confirm',
  'DELETE /api/v1/auth/mfa/totp',
  'POST /api/v1/auth/password/change',
  'POST /api/v1/auth/password/reset',
  'POST /api/v1/auth/password/reset/confirm',
  'POST /api/v1/auth/signup',
  'POST /api/v1/auth/verify',
  'POST /api/v1/auth/verify/resend',
  // Tenancy's two routes that name no organisation. `POST` makes one — it does not exist until the
  // handler runs — and `GET` returns the caller's own memberships, so in both cases there is no
  // `:orgId` to aim anywhere (ADR 007, ADR 023, `org.controller.ts`).
  //
  // `GET /orgs` is the one route in the table that reads across tenants at all, so being excused
  // from the sweep is not the whole of its coverage: `tenancy.e2e-spec.ts` asserts that a member of
  // one organisation never sees another's in it, and `org.service.spec.ts` asserts the same against
  // the service directly.
  'GET /api/v1/orgs',
  'POST /api/v1/orgs',
  // A person's own linked subscription accounts (spec 032 FR-008, `linked-account.controller.ts`):
  // no `:orgId`, no permission, and every read and write names the session's own user id; the
  // `:provider` is the catalogue, not an identifier. `byos.e2e-spec.ts` proves another person and
  // an organisation owner see none of them, through their own list and every org read.
  'GET /api/v1/me/linked-accounts',
  'POST /api/v1/me/linked-accounts/:provider/begin',
  'POST /api/v1/me/linked-accounts/:provider/complete',
  'POST /api/v1/me/linked-accounts/:provider/verify',
  'DELETE /api/v1/me/linked-accounts/:provider',
  // The template catalogue (spec 015) is deployment-wide, read from the manifests and one
  // `template_versions` query, with no `:orgId` to aim anywhere (`templates.controller.ts`). The
  // model catalogue was its precedent until 020 moved it under `/orgs/:orgId/models`.
  'GET /api/v1/templates',
  // The grant exchange (spec 017 US2) names no organisation in its path: the caller presents a
  // label and the org is derived from it, so there is no `:orgId` for a probe to swap. Its
  // cross-tenant answer is proved by `preview.e2e-spec.ts` ("non-member refused identically to
  // unknown label"): a member of another organisation gets the same 404 as an unknown label.
  'POST /api/v1/preview/authorize',
  // The callback broker (spec 017 US5) is reached by a sandbox with a bearer token, not by a
  // member with a session: org, project and sandbox are read from the verified claims and re-checked
  // against the row, never from the path or body. `preview.e2e-spec.ts` ("a foreign project id is
  // refused and audited") proves a token that names another tenant's project is refused.
  'POST /api/v1/internal/sandbox-callbacks',
  // The inbound GitHub webhook (spec 026 US3; in `webhooks/inbound/` and also served on
  // `HOOKS_HOST` since spec 029 US6) is reached by GitHub with a signature, not by a member with a
  // session: there is no `:orgId` in its path and no session to swap. The
  // organisation is derived from the delivery's installation id, matched against `connections`
  // under forced RLS, and `webhook.consumer.spec.ts` ("SC-013: two organisations holding the
  // installation advance independently; a third is untouched") proves a delivery naming another
  // tenant's installation changes nothing in this one.
  'POST /api/v1/webhooks/github',
  // The agent home's runner (spec 041, on spec 040's bridge): its routes are reached with the
  // home's device token, never a session, and name no organisation; the run-events route takes
  // `:runId` and so is swept above, where a session without a device token is refused.
  // `agent-home.e2e-spec.ts` proves another person's token cannot post for someone else's run.
  'GET /api/v1/local-agent/connect',
  'POST /api/v1/local-agent/status',
  // The runner's sign-in report, a device-token route like `status`.
  'POST /api/v1/local-agent/auth',
  // Spec 041, a person's own subscription (`subscription.controller.ts`): no `:orgId`, no
  // parameter at all, and every read and write names the session's own user id, as
  // `/me/linked-accounts` does; `claude` is the catalogue, not an identifier. There is nothing a
  // caller could point at another person's home.
  'GET /api/v1/me/subscriptions',
  'POST /api/v1/me/subscriptions/claude/connect',
  'POST /api/v1/me/subscriptions/claude/code',
  'POST /api/v1/me/subscriptions/claude/cancel',
  'DELETE /api/v1/me/subscriptions/claude',
  // Spec 046, the MCP endpoint and its OAuth server. Discovery is public and names nothing. The
  // MCP endpoint takes a bearer token whose grant fixes the organisation, never the path or body;
  // each tool re-checks the person's permission on the project it names, and `mcp.e2e-spec.ts`
  // proves a tool aimed at another tenant's project is refused. Registration, token and revocation
  // authenticate by what the body proves (a code and its PKCE verifier, a refresh token), and
  // consent names the organisation in the body, where the service checks the caller belongs to it
  // (`mcp.e2e-spec.ts`: "refuses to let a person connect an organization they do not belong to").
  'GET /.well-known/oauth-authorization-server',
  'GET /.well-known/oauth-protected-resource',
  'GET /.well-known/oauth-protected-resource/api/v1/mcp',
  'DELETE /api/v1/mcp',
  'GET /api/v1/mcp',
  'POST /api/v1/mcp',
  'POST /api/v1/oauth/authorize',
  'POST /api/v1/oauth/authorize/preview',
  'POST /api/v1/oauth/register',
  'POST /api/v1/oauth/revoke',
  'POST /api/v1/oauth/token',
]);

/**
 * Reads that beta's own owner cannot complete in this world, so the control below does not demand
 * a 2xx of them. The diff (spec 016) runs `git diff` in the project's sandbox, and this world has
 * none — beta's read ends `no-sandbox` (404) after the row lookup under RLS. Alpha's probes still
 * sweep the route for leaks; that a foreign member is refused *before* the sandbox is reached is
 * `checkpoints.e2e-spec.ts`'s cross-tenant case, against a sandbox that exists.
 */
const READS_BETA_CANNOT_COMPLETE_HERE = new Set([
  'GET /api/v1/orgs/:orgId/projects/:projectId/checkpoints/:checkpointId/diff',
  // The repository list (spec 018) calls GitHub; beta's connection here is `needs_reauth`, so the
  // read ends `needs-reauth` (409) after the row lookup under RLS, with no GitHub in the loop.
  'GET /api/v1/orgs/:orgId/connectors/:connectionId/repositories',
  // Spec 030's listings are per provider, and `:connectionId` here is beta's GitHub connection:
  // beta's own read finds its row under RLS and ends `404` on the provider mismatch. Excused from
  // the control only; alpha and the outsider still sweep all four for leaks, and
  // `connectors-030.e2e-spec.ts` lists each against its provider's fixture.
  'GET /api/v1/orgs/:orgId/connectors/:connectionId/netlify/sites',
  'GET /api/v1/orgs/:orgId/connectors/:connectionId/neon/projects',
  'GET /api/v1/orgs/:orgId/connectors/:connectionId/supabase/projects',
  'GET /api/v1/orgs/:orgId/connectors/:connectionId/resend/domains',
  // Spec 022's two file reads need a live sandbox for the same reason the diff does, and this world
  // has none: beta's own read ends `no-sandbox` (404) after the row lookup under RLS. This excuses
  // them from the *control* only — alpha and the outsider still sweep both routes for leaks, and
  // `files.e2e-spec.ts` exercises them against a sandbox that exists.
  'GET /api/v1/orgs/:orgId/projects/:projectId/files',
  'GET /api/v1/orgs/:orgId/projects/:projectId/files/content',
  // Spec 045: the migration status reads the project's bound database, and beta's project here has
  // no Neon or Supabase binding: its own read ends `404` after the binding lookup under RLS.
  // Excused from the control only; alpha and the outsider still sweep it for leaks.
  'GET /api/v1/orgs/:orgId/projects/:projectId/connectors/:provider/migrations',
]);

/**
 * Bodies for the routes where an empty one would stop the probe short of the tenancy decision.
 *
 * Almost every unsafe route here is behind `@RequirePermission()`, and Nest runs guards before
 * pipes — so `{}` reaches the permission check and is refused there, which is the decision this
 * suite wants to observe. The exception is invitation acceptance, which deliberately carries no
 * permission guard (the caller is not a member yet), and would otherwise be refused by validation
 * before it ever opened a tenant transaction.
 *
 * `the sweep` asserts that no probed route answered `validation-failed`, so a route added later
 * whose body matters cannot quietly join the shallow-probe list.
 */
const BODIES: Readonly<Record<string, unknown>> = {
  'POST /api/v1/orgs/:orgId/invitations/accept': { token: `not-a-real-token-${randomUUID()}` },
  // Spec 031: the project invitation's accept, which also runs before any membership.
  'POST /api/v1/orgs/:orgId/project-invitations/accept': {
    token: `not-a-real-token-${randomUUID()}`,
  },
  'POST /api/v1/orgs/:orgId/workspaces': { name: 'probe' },
  'PATCH /api/v1/orgs/:orgId/workspaces/:workspaceId': { name: 'probe' },
  'POST /api/v1/orgs/:orgId/workspaces/:workspaceId/projects': {
    name: 'probe',
    template: 'vite-react',
  },
  'PATCH /api/v1/orgs/:orgId/workspaces/:workspaceId/projects/:projectId': { name: 'probe' },
  'POST /api/v1/orgs/:orgId/projects/:projectId/runs': { prompt: 'x', model: 'claude-sonnet-5' },
  'POST /api/v1/orgs/:orgId/projects/:projectId/runs/:runId/input': { message: 'probe' },
};

/**
 * Query strings for the routes whose required query members are no part of the tenancy decision.
 *
 * The same reasoning as `BODIES`, one layer out. Spec 022's file reads take a mandatory `path`, and
 * Nest runs the validation pipe on a query before the handler — so without one the probe is refused
 * `validation-failed` and never reaches the permission layer, which is the decision this suite
 * exists to observe. `''` is the contract's spelling of the workspace root, so the listing is aimed
 * at the most revealing thing it can return rather than at some corner of the tree.
 *
 * Relaxing the route's validation would be the wrong repair — `path` is a jailed input at a trust
 * boundary — and excusing the route would be worse: it names `:orgId` and `:projectId`, which is
 * exactly the shape this gate exists for.
 */
const QUERIES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'GET /api/v1/orgs/:orgId/projects/:projectId/files': { path: '' },
  'GET /api/v1/orgs/:orgId/projects/:projectId/files/content': { path: 'package.json' },
};

/** The world plus the two identifiers that only exist once the fixture has signed everybody in. */
interface SweepWorld extends TwoTenantWorld {
  readonly betaAttachmentId: string;
  readonly betaCheckpointId: string;
  readonly betaConnectionId: string;
  readonly betaDeliveryId: string;
  readonly betaDeploymentId: string;
  readonly betaDomainId: string;
  readonly betaEndpointId: string;
  readonly betaInvitationId: string;
  readonly betaDomainHostname: string;
  readonly betaMcpGrantId: string;
  readonly betaOperationId: string;
  readonly betaRunId: string;
  readonly betaSessionId: string;
}

/** One probe: what was sent, and what came back with the correlation members removed. */
interface Probe {
  readonly body: Record<string, unknown>;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly text: string;
  readonly url: string;
}

describe('Tenant isolation (e2e) — the §17 gate', () => {
  describe.skipIf(!postgres || !redis)('against Postgres and both Redis roles', () => {
    let app: INestApplication;
    let database: ForgeDatabase;
    let transactions: TenantTransactionRunner;
    let permissions: PermissionCache;
    let world: SweepWorld;

    let application: EnumeratedRoute[];
    let scaffolding: EnumeratedRoute[];
    let addressable: EnumeratedRoute[];

    /** The same sweep from three principals, plus beta's own run as the control. */
    let byAlpha: Probe[];
    let byOutsider: Probe[];
    let byBeta: Probe[];
    const attachmentStore = new MemoryObjectStore();

    /** Beta's tenant-owned rows, bracketed around every probe the suite makes. */
    let before: Record<string, string>;
    let after: Record<string, string>;
    let suiteLock: { release: () => Promise<void> } | undefined;

    beforeAll(async () => {
      // The probe run below is an outbox row; a relay in a concurrent suite would dispatch it and
      // a worker would claim it before the cancel. Held for the suite, like every suite that writes
      // the outbox and asserts on what happens to its rows.
      suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL ?? '');

      // Spec 048: beta's attachment needs bytes for its own download to succeed (the control).
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(ATTACHMENT_STORE)
        .useValue(attachmentStore)
        .compile();

      app = moduleRef.createNestApplication();
      configureApplication(app);
      await app.init();

      database = app.get<ForgeDatabase>(APP_DATABASE);
      transactions = app.get(TenantTransactionRunner);
      permissions = app.get(PermissionCache);

      const seeded = await createTwoTenantWorld(app);
      // Beta's probe run below resolves a credential: beta's own key (platform credits are
      // retired), which the run never reaches — it is cancelled before any worker sees it.
      await seedProviderKey(app, seeded.beta);
      const listed = await http(app)
        .get('/api/v1/auth/sessions')
        .set('Cookie', seeded.beta.owner.cookie)
        .expect(200);

      const run = await transactions.runInTenantScope(
        { orgId: seeded.beta.orgId, userId: seeded.beta.owner.userId },
        () =>
          app
            .get(RunService)
            .create(seeded.beta.orgId, seeded.beta.projectId, seeded.beta.owner.userId, 'probe'),
      );

      // The outbox table is shared with the suites that relay; a worker in one of them would
      // otherwise run this row and move it while the sweep is bracketing beta's tables. Marked
      // published rather than deleted: `forge_app` holds no DELETE on the outbox.
      await database
        .update(schema.outbox)
        .set({ publishedAt: new Date() })
        .where(eq(schema.outbox.aggregateId, run.id));

      // Ended, so `GET …/runs/:runId/stream` (009) replays and closes instead of tailing a run
      // that no worker will ever finish — the sweep reads every route to its end.
      await transactions.runInTenantTransaction(seeded.beta.orgId, (tx) =>
        app.get(RunStore).transition(tx, {
          from: 'queued',
          orgId: seeded.beta.orgId,
          runId: run.id,
          to: 'cancelled',
        }),
      );

      // A baseline row, so `…/checkpoints/:checkpointId` (016) aims at something beta owns.
      const checkpoint = await transactions.runInTenantTransaction(seeded.beta.orgId, (tx) =>
        app.get(CheckpointRepository).insertOrGetBySha(tx, {
          files: [],
          gitSha: '0'.repeat(40),
          kind: 'baseline',
          label: 'probe',
          orgId: seeded.beta.orgId,
          projectId: seeded.beta.projectId,
        }),
      );

      // Beta's GitHub connection and one queued sync operation (018), so `…/connectors/:connectionId`
      // and `…/sync/:operationId` aim at rows beta owns. `needs_reauth` keeps GitHub out of the sweep.
      // An import, requested by beta's owner (spec 047): `…/imports/:operationId` serves only the
      // requester's own import, and the sync read serves any kind, so one row is a real target —
      // and a real control — for both routes that take `:operationId`.
      const connection = await transactions.runInTenantTransaction(seeded.beta.orgId, (tx) =>
        app.get(ConnectionRepository).upsert(tx, {
          accountId: 1,
          accountLogin: 'probe',
          accountType: 'organization',
          connectedBy: seeded.beta.owner.userId,
          health: 'needs_reauth',
          installationId: 1,
          orgId: seeded.beta.orgId,
          provider: 'github',
        }),
      );
      const operation = await transactions.runInTenantTransaction(seeded.beta.orgId, (tx) =>
        app.get(SyncRepository).insertQueued(tx, {
          kind: 'import',
          orgId: seeded.beta.orgId,
          projectId: seeded.beta.projectId,
          requestedBy: seeded.beta.owner.userId,
        }),
      );

      // One queued deployment (027), so `…/deployments/:deploymentId` aims at a row beta owns.
      const deployment = await transactions.runInTenantTransaction(seeded.beta.orgId, (tx) =>
        app.get(DeploymentRepository).insertQueued(tx, {
          checkpointId: checkpoint.id,
          orgId: seeded.beta.orgId,
          projectId: seeded.beta.projectId,
          requestedBy: seeded.beta.owner.userId,
          template: 'vite-react',
        }),
      );

      // One pending domain (028), so `…/domains/:domainId` aims at a row beta owns. Its checks are
      // due only far ahead, so no domain sweep in a concurrent suite claims it and moves the row
      // while the sweep is bracketing beta's tables.
      const domain = await transactions.runInTenantTransaction(seeded.beta.orgId, (tx) =>
        app.get(DomainRepository).insert(tx, {
          addedBy: seeded.beta.owner.userId,
          hostname: `probe-${randomUUID().slice(0, 8)}.isolation.example.test`,
          now: new Date('2100-01-01T00:00:00.000Z'),
          orgId: seeded.beta.orgId,
          ownershipToken: ownershipToken(),
          projectId: seeded.beta.projectId,
        }),
      );

      // One webhook endpoint (029), so `…/webhooks/endpoints/:endpointId` aims at a row beta owns.
      // Disabled, so a sweep that reaches its `test` route sends nothing anywhere.
      const endpoint = await transactions.runInTenantTransaction(seeded.beta.orgId, async (tx) => {
        const service = app.get(EndpointService);
        const created = await service.create(tx, seeded.beta.orgId, seeded.beta.owner.userId, {
          description: '',
          eventTypes: ['deploy.succeeded'],
          projectIds: [],
          url: 'https://hooks.isolation.example.test/in',
        });
        return service.update(
          tx,
          seeded.beta.orgId,
          seeded.beta.owner.userId,
          created.endpoint.id,
          {
            enabled: false,
          },
        );
      });

      // One delivery of that endpoint (029 US4), so `…/deliveries/:deliveryId` aims at a row beta
      // owns. `not_sent` with its body held: replayable, so a replay that crossed the tenancy would
      // move it, and no redelivery sweep in a concurrent suite ever claims it.
      const [delivery] = await transactions.runInTenantTransaction(seeded.beta.orgId, (tx) =>
        app.get(SendRepository).insertFanout(tx, [
          {
            body: '{}',
            endpointId: endpoint.id,
            eventId: randomUUID(),
            eventType: 'deploy.succeeded',
            now: new Date(),
            occurredAt: new Date(),
            orgId: seeded.beta.orgId,
            projectId: null,
            state: 'not_sent',
          },
        ]),
      );

      // One open project invitation (031), so `…/invitations/:invitationId` aims at a row beta owns.
      // The hash is random, so no token anywhere redeems it.
      const [invitation] = await transactions.runInTenantTransaction(seeded.beta.orgId, (tx) =>
        tx
          .insert(schema.projectInvitations)
          .values({
            email: `probe-${randomUUID().slice(0, 8)}@isolation.example.test`,
            expiresAt: new Date('2100-01-01T00:00:00.000Z'),
            invitedBy: seeded.beta.owner.userId,
            orgId: seeded.beta.orgId,
            projectId: seeded.beta.projectId,
            role: 'viewer',
            tokenHash: randomUUID(),
          })
          .returning({ id: schema.projectInvitations.id }),
      );

      // One MCP grant of beta's owner (046), so `…/mcp/grants/:grantId` aims at a row beta owns. The
      // token hashes are random, so no bearer anywhere matches them.
      const [mcpClient] = await app
        .get<ForgeDatabase>(APP_DATABASE)
        .insert(schema.mcpClients)
        .values({ clientName: 'Isolation probe', redirectUris: ['https://probe.example.test/cb'] })
        .returning({ id: schema.mcpClients.id });
      const [mcpGrant] = await transactions.runInTenantTransaction(seeded.beta.orgId, (tx) =>
        tx
          .insert(schema.mcpGrants)
          .values({
            accessExpiresAt: new Date('2100-01-01T00:00:00.000Z'),
            accessTokenHash: randomUUID(),
            clientId: mcpClient!.id,
            orgId: seeded.beta.orgId,
            refreshExpiresAt: new Date('2100-01-01T00:00:00.000Z'),
            refreshTokenHash: randomUUID(),
            scopes: ['projects:read'],
            userId: seeded.beta.owner.userId,
          })
          .returning({ id: schema.mcpGrants.id }),
      );

      // One pending attachment of beta's (048), so `…/attachments/:attachmentId` aims at a row and an
      // object beta owns.
      const attachmentKey = `attachments/${seeded.beta.orgId}/${seeded.beta.projectId}/probe`;
      const [attachment] = await transactions.runInTenantTransaction(seeded.beta.orgId, (tx) =>
        tx
          .insert(schema.attachments)
          .values({
            extractedText: 'beta attachment',
            kind: 'text',
            mimeType: 'text/plain',
            name: 'beta.txt',
            objectKey: attachmentKey,
            orgId: seeded.beta.orgId,
            projectId: seeded.beta.projectId,
            sha256: '0'.repeat(64),
            sizeBytes: 15,
            uploadedBy: seeded.beta.owner.userId,
          })
          .returning({ id: schema.attachments.id }),
      );
      await attachmentStore.put(attachmentKey, Buffer.from('beta attachment'), {});

      world = {
        ...seeded,
        betaAttachmentId: attachment!.id,
        betaInvitationId: invitation!.id,
        betaMcpGrantId: mcpGrant!.id,
        betaDeliveryId: delivery!.id,
        betaEndpointId: endpoint.id,
        betaCheckpointId: checkpoint.id,
        betaConnectionId: connection.id,
        betaDeploymentId: deployment!.id,
        betaDomainHostname: domain.hostname,
        betaDomainId: domain.id,
        betaOperationId: operation.id,
        betaRunId: run.id,
        betaSessionId: sessionListResponseSchema.parse(listed.body).sessions[0]!.id,
      };

      const table = partitionRoutes(enumerateRoutes(app));

      application = table.application;
      scaffolding = table.scaffolding;
      addressable = application.filter(isTenantAddressable);

      before = await snapshotTenant(transactions, world.beta.orgId);

      // The control first, and reads only. It proves the URLs are real and that a caller who *is*
      // entitled sees beta's data through them — without which "alpha saw nothing" would be equally
      // true of a suite pointing at paths that do not exist.
      byBeta = await sweep(
        app,
        addressable.filter((route) => route.method === 'GET'),
        world,
        world.beta.owner,
      );

      byAlpha = await sweep(app, addressable, world, world.alpha.owner);
      byOutsider = await sweep(app, addressable, world, world.outsider);

      after = await snapshotTenant(transactions, world.beta.orgId);
    }, 600_000);

    afterAll(async () => {
      await destroyTwoTenantWorld(app, world);
      await app?.close();
      await suiteLock?.release();
    });

    /**
     * ## The property this task exists for
     *
     * Everything below sweeps a list. These four assertions are about where the list comes from, and
     * they are the reason the gate does not decay: the list is the router's, every parameter in it
     * is classified, every route is either probed or excused in writing, and nothing was quietly
     * dropped on the way.
     */
    describe('the route table', () => {
      it('is read from the router the application actually serves', () => {
        // Landmarks from four different modules, so a router read that returned a plausible subset
        // — one controller, say, or only the routes registered first — fails here.
        expect(pathsOf(application)).toEqual(
          expect.arrayContaining([
            'GET /api/v1/health',
            'POST /api/v1/auth/login',
            'GET /api/v1/orgs/:orgId',
            'GET /api/v1/orgs/:orgId/projects/:projectId',
            'PUT /api/v1/orgs/:orgId/projects/:projectId/grants/:userId',
          ]),
        );

        // Post-prefix and post-version. A path missing `/api/v1` would mean the suite was probing a
        // URL space nobody serves, and every probe would be refused for the wrong reason. The one
        // exception is spec 046's OAuth discovery, which RFC 8414 and 9728 fix at the origin root.
        for (const route of application) {
          expect(
            route.path.startsWith('/api') || route.path.startsWith('/.well-known/oauth-'),
          ).toBe(true);
        }
      });

      /**
       * The scaffolding `setGlobalPrefix` registers, named so that it stays exactly this much. A
       * third wildcard appearing here is a change to how Nest mounts the prefix, and the suite
       * should be looked at before it is trusted again.
       *
       * Both catch-all middlewares — `CsrfModule`'s and the request logger's — land on the same two
       * paths because both spell the wildcard `*splat`. A `/api/{*path}` here is the tell that one
       * of them went back to a bare `'*'` and Nest auto-converted it (see `app.module.ts`).
       */
      it('skips only the prefix wildcards, and names them', () => {
        // Plus the one the prefix's `.well-known` exclusion mounts the same middlewares on (046).
        expect([...new Set(scaffolding.map((route) => route.path))].sort()).toEqual([
          '/.well-known/{*path}',
          '/api$',
          '/api/*splat',
        ]);
      });

      it('knows how to point every route parameter at the other tenant, or why it cannot', () => {
        const unclassified = application.flatMap((route) =>
          route.parameters
            .filter((name) => !(name in TENANT_PARAMETERS) && !(name in NON_TENANT_PARAMETERS))
            .map((name) => `:${name} on ${label(route)}`),
        );

        // A route added later with a parameter nobody has thought about lands here. The message is
        // the instruction: decide whether it names a tenant-owned resource, then say so in one of
        // the two maps at the top of this file.
        expect(unclassified).toEqual([]);
      });

      it('probes every route that names a tenant-owned resource, and excuses the rest in writing', () => {
        const unexplained = application
          .filter((route) => !isTenantAddressable(route))
          .map(label)
          .filter((name) => !ROUTES_WITH_NO_TENANT_RESOURCE.has(name));

        expect(unexplained).toEqual([]);
      });

      it('keeps no excuse for a route that no longer exists', () => {
        const mounted = new Set(pathsOf(application));
        const stale = [...ROUTES_WITH_NO_TENANT_RESOURCE].filter((name) => !mounted.has(name));

        expect(stale).toEqual([]);
      });

      it('found routes to probe at all', () => {
        // Without this, an enumerator that returned only the routes taking no parameters would make
        // every assertion below pass over an empty list.
        expect(addressable.length).toBeGreaterThanOrEqual(6);
      });

      it('sweeps Settings › Usage through :orgId, not as an excused route', () => {
        // The caller's own runs, read under the path's organisation: the classification is
        // `:orgId`'s, so beta's list is the control and alpha's probe the refusal. Its other
        // boundary — another member's runs never appear — is `usage.e2e-spec.ts`'s.
        expect(pathsOf(addressable)).toContain('GET /api/v1/orgs/:orgId/usage/runs');
        expect(ROUTES_WITH_NO_TENANT_RESOURCE.has('GET /api/v1/orgs/:orgId/usage/runs')).toBe(
          false,
        );
      });
    });

    /**
     * ## Criterion 13, through every route
     *
     * The sweep runs the whole addressable route table three times: as beta's owner (the control),
     * as alpha's owner, and as an account with no organisation at all.
     */
    describe('the sweep', () => {
      it('reaches a real handler on every probe', () => {
        // An unmatched URL is answered by Express's default 404 in HTML, not by
        // `ProblemDetailsFilter` — so a mis-substituted path would be refused with a document this
        // assertion rejects, rather than passing the leak check by never reaching the application.
        for (const probe of [...byAlpha, ...byOutsider, ...byBeta]) {
          expect({ probe: describeProbe(probe), shape: shapeOf(probe) }).toEqual({
            probe: describeProbe(probe),
            shape: probe.status < 300 ? 'success' : 'problem-details',
          });
        }
      });

      it('is not refused for a reason that has nothing to do with tenancy', () => {
        // A `csrf-check-failed` or a `401` would mean the probe never reached the permission layer,
        // and "alpha saw nothing" would be a statement about the CSRF helper instead.
        const wrongRefusal = [...byAlpha, ...byOutsider].filter((probe) =>
          ['csrf-check-failed', 'rate-limited', 'unauthorized'].includes(slugOf(probe)),
        );

        expect(wrongRefusal.map(describeProbe)).toEqual([]);
      });

      it('probes deeply enough that no route was stopped by its body', () => {
        // The tripwire on {@link BODIES}. A route added later whose handler is reached only with a
        // valid body shows up here rather than becoming a silently shallow probe.
        const shallow = [...byAlpha, ...byOutsider].filter(
          (probe) => slugOf(probe) === 'validation-failed',
        );

        expect(shallow.map(describeProbe)).toEqual([]);
      });

      /** The control. Without it, every assertion below is also true of a suite that tests nothing. */
      it('shows beta’s own owner the data the probes are hunting for', () => {
        const revealed = byBeta.filter((probe) => leaksIn(probe, world.beta).length > 0);

        expect(revealed.length).toBeGreaterThan(0);

        // And every read succeeded for them, so a refusal in alpha's run is a decision about alpha
        // rather than a route that refuses everybody.
        for (const probe of byBeta) {
          if (READS_BETA_CANNOT_COMPLETE_HERE.has(`${probe.method} ${probe.path}`)) continue;
          expect({ probe: describeProbe(probe), ok: probe.status < 300 }).toEqual({
            probe: describeProbe(probe),
            ok: true,
          });
        }
      });

      it('shows alpha none of it, through any route', () => {
        const leaks = byAlpha.flatMap((probe) =>
          leaksIn(probe, world.beta).map((secret) => `${describeProbe(probe)} leaked ${secret}`),
        );

        expect(leaks).toEqual([]);
      });

      it('shows an account with no organisation none of it either', () => {
        const leaks = byOutsider.flatMap((probe) =>
          leaksIn(probe, world.beta).map((secret) => `${describeProbe(probe)} leaked ${secret}`),
        );

        expect(leaks).toEqual([]);
      });

      /**
       * The write half of criterion 13. Snapshotted from every table the schema marks tenant-owned,
       * bracketed around all three runs — so a probe that mutated beta shows up as a diff whatever
       * route it went through and whatever it answered.
       */
      it('changes nothing that belongs to beta', () => {
        expect(after).toEqual(before);
      });

      /**
       * Sessions live in Redis, not Postgres, so the snapshot above cannot see them. `DELETE
       * /auth/sessions/:id` is in the sweep pointed at beta's live session id, which is the one
       * cross-principal write in the route table.
       */
      it('leaves beta signed in on the session alpha tried to revoke', async () => {
        await http(app)
          .get('/api/v1/auth/sessions')
          .set('Cookie', world.beta.owner.cookie)
          .expect(200);
      });

      /**
       * Invitation acceptance is the one route that deliberately opens a transaction in an
       * organisation the caller is not a member of — it is how somebody becomes one. It is worth
       * naming because "no route opens another tenant's transaction" would be a false description of
       * this system; the property is that doing so discloses nothing and changes nothing without a
       * token, which the two assertions above already carry for it.
       */
      it('refuses invitation acceptance on a token alpha does not hold', () => {
        const probe = byAlpha.find(
          (candidate) => candidate.path === '/api/v1/orgs/:orgId/invitations/accept',
        );

        expect(probe).toBeDefined();
        expect(slugOf(probe!)).toBe('token-invalid');
      });
    });

    /**
     * ## Spec 028's domain routes (T083, SC-011)
     *
     * The sweep above reaches them through `:projectId` and `:domainId` with no edit here. These
     * name all six, so a route that stopped being mounted, or stopped taking a tenant parameter,
     * fails by name — and they hunt for the domain's own hostname, which `Tenant.secrets` does not
     * carry.
     */
    describe('the domain routes (spec 028)', () => {
      const DOMAIN_ROUTES = [
        'GET /api/v1/orgs/:orgId/projects/:projectId/domains',
        'POST /api/v1/orgs/:orgId/projects/:projectId/domains',
        'GET /api/v1/orgs/:orgId/projects/:projectId/domains/:domainId',
        'POST /api/v1/orgs/:orgId/projects/:projectId/domains/:domainId/check',
        'POST /api/v1/orgs/:orgId/projects/:projectId/domains/:domainId/retry',
        'DELETE /api/v1/orgs/:orgId/projects/:projectId/domains/:domainId',
      ];

      function domainProbes(probes: readonly Probe[]): Probe[] {
        return probes.filter((probe) => DOMAIN_ROUTES.includes(`${probe.method} ${probe.path}`));
      }

      it('are all swept, from alpha and from an account with no organisation', () => {
        expect(pathsOf(addressable)).toEqual(expect.arrayContaining(DOMAIN_ROUTES));

        for (const probes of [byAlpha, byOutsider]) {
          expect(
            domainProbes(probes)
              .map((probe) => `${probe.method} ${probe.path}`)
              .sort(),
          ).toEqual([...DOMAIN_ROUTES].sort());
        }
      });

      it('show beta’s own owner beta’s domain, so the hunt below is for something real', () => {
        const reads = domainProbes(byBeta);

        expect(reads.map((probe) => `${probe.method} ${probe.path} → ${probe.status}`)).toEqual([
          'GET /api/v1/orgs/:orgId/projects/:projectId/domains → 200',
          'GET /api/v1/orgs/:orgId/projects/:projectId/domains/:domainId → 200',
        ]);
        for (const probe of reads) {
          expect(probe.text).toContain(world.betaDomainHostname);
        }
      });

      it('refuse alpha and the outsider on every one, and disclose neither id nor hostname', () => {
        // The body with `instance` stripped, as `leaksIn` reads it: the request's own URL carries
        // the id the probe chose.
        const answered = [...domainProbes(byAlpha), ...domainProbes(byOutsider)].filter(
          (probe) =>
            probe.status < 400 ||
            JSON.stringify(probe.body).includes(world.betaDomainHostname) ||
            JSON.stringify(probe.body).includes(world.betaDomainId),
        );

        expect(answered.map(describeProbe)).toEqual([]);
      });

      /**
       * A replayed or mis-addressed `domain.check-requested`: alpha's organisation on the envelope
       * and in the payload, beta's domain id beside it. The consumer checks in the payload's tenant,
       * so the claim runs under alpha's RLS and finds no row — nothing is resolved, nothing asked of
       * the edge, and beta's row is byte-for-byte what it was. The same event in beta's own scope
       * then claims and settles that row, so the no-op is the tenancy and not a row that was never
       * due.
       *
       * The consumer is the app's, over a checker built from the app's repository, transactions,
       * audit and outbox, with a clock of its own: the domain is inserted due only in 2100, so no
       * domain sweep in a concurrent suite can claim it, while this checker's clock finds it due.
       */
      describe('a replayed domain.check-requested for beta’s domain', () => {
        const at = new Date('2100-06-01T00:00:00.000Z');
        const asked: string[] = [];
        let consumer: DomainCheckConsumer;
        let domainId: string;

        const dns: DnsPort = {
          resolveCaa: (name) => (asked.push(`caa ${name}`), Promise.resolve({ kind: 'empty' })),
          resolveCnameChain: (name) => (
            asked.push(`cname ${name}`),
            Promise.resolve({ kind: 'empty' })
          ),
          resolveSoaOwner: (name) => (
            asked.push(`soa ${name}`),
            Promise.resolve({ kind: 'empty' })
          ),
          resolveTxt: (name) => (asked.push(`txt ${name}`), Promise.resolve({ kind: 'empty' })),
        };
        const edge: CustomHostnamePort = {
          deregister: (id) => (asked.push(`edge deregister ${id}`), Promise.resolve()),
          findByHostname: (hostname) => (
            asked.push(`edge find ${hostname}`),
            Promise.resolve(undefined)
          ),
          register: (hostname) => (
            asked.push(`edge register ${hostname}`),
            Promise.reject(new Error('not in this suite'))
          ),
          status: (id) => (
            asked.push(`edge status ${id}`),
            Promise.reject(new Error('not in this suite'))
          ),
        };

        function envelope(orgId: string): Envelope<'domain.check-requested'> {
          return {
            aggregate: 'domain',
            aggregateId: domainId,
            eventId: randomUUID(),
            occurredAt: at.toISOString(),
            orgId,
            payload: { domainId, orgId, projectId: world.beta.projectId },
            traceId: null,
            type: 'domain.check-requested',
          };
        }

        function readRow(): Promise<unknown> {
          return transactions.runInTenantTransaction(world.beta.orgId, async (tx) => {
            const [row] = await tx
              .select()
              .from(schema.domains)
              .where(eq(schema.domains.id, domainId));

            return row;
          });
        }

        beforeAll(async () => {
          const domain = await transactions.runInTenantTransaction(world.beta.orgId, (tx) =>
            app.get(DomainRepository).insert(tx, {
              addedBy: world.beta.owner.userId,
              hostname: `replay-${randomUUID().slice(0, 8)}.isolation.example.test`,
              now: at,
              orgId: world.beta.orgId,
              ownershipToken: ownershipToken(),
              projectId: world.beta.projectId,
            }),
          );
          domainId = domain.id;

          const config = {
            get: (key: string) =>
              key === 'CUSTOM_HOSTNAME_TARGET' ? 'customers.forge-edge.test' : undefined,
          } as unknown as ConfigService<Environment, true>;

          consumer = new DomainCheckConsumer(
            new DomainChecker(
              transactions,
              app.get(DomainRepository),
              app.get(AuditService),
              app.get(OutboxWriter),
              { now: () => new Date(at.getTime() + 5000) },
              dns,
              edge,
              config,
              app.get(DomainNotices),
            ),
          );
        });

        afterAll(async () => {
          // Whatever the control's settle wrote to the shared outbox is not for a relay elsewhere.
          await database
            .update(schema.outbox)
            .set({ publishedAt: new Date() })
            .where(eq(schema.outbox.aggregateId, domainId));
        });

        it('in alpha’s scope, has no effect on beta’s row and asks nothing of DNS or the edge', async () => {
          const rowBefore = await readRow();

          expect(rowBefore).toBeDefined();

          await consumer.effect(envelope(world.alpha.orgId));

          expect(await readRow()).toEqual(rowBefore);
          expect(asked).toEqual([]);
        });

        it('in beta’s own scope, does check that row — the control', async () => {
          const rowBefore = (await readRow()) as { lastCheck: unknown; nextCheckAt: Date };

          await consumer.effect(envelope(world.beta.orgId));

          const rowAfter = (await readRow()) as { lastCheck: unknown; nextCheckAt: Date };

          expect(asked.length).toBeGreaterThan(0);
          expect(rowAfter.lastCheck).not.toEqual(rowBefore.lastCheck);
          expect(rowAfter.nextCheckAt.getTime()).toBeGreaterThan(rowBefore.nextCheckAt.getTime());
        });
      });
    });

    /**
     * ## Spec 029's webhook routes (T093)
     *
     * The sweep above reaches them through `:orgId` and `:endpointId` with no edit here. These name
     * every one, so a route that stopped being mounted, or stopped taking a tenant parameter, fails
     * by name — and they hunt for the endpoint's own URL and id, which `Tenant.secrets` does not
     * carry. The delivery-log routes (US4) are named too, and hunted for the delivery's id.
     */
    describe('the webhook routes (spec 029)', () => {
      const WEBHOOK_ROUTES = [
        'GET /api/v1/orgs/:orgId/webhooks/endpoints',
        'POST /api/v1/orgs/:orgId/webhooks/endpoints',
        'GET /api/v1/orgs/:orgId/webhooks/endpoints/:endpointId',
        'PATCH /api/v1/orgs/:orgId/webhooks/endpoints/:endpointId',
        'DELETE /api/v1/orgs/:orgId/webhooks/endpoints/:endpointId',
        'POST /api/v1/orgs/:orgId/webhooks/endpoints/:endpointId/test',
        'GET /api/v1/orgs/:orgId/webhooks/endpoints/:endpointId/deliveries',
        'GET /api/v1/orgs/:orgId/webhooks/endpoints/:endpointId/deliveries/:deliveryId',
        'POST /api/v1/orgs/:orgId/webhooks/endpoints/:endpointId/deliveries/:deliveryId/replay',
      ];
      const DELIVERY_READS = [
        'GET /api/v1/orgs/:orgId/webhooks/endpoints/:endpointId/deliveries',
        'GET /api/v1/orgs/:orgId/webhooks/endpoints/:endpointId/deliveries/:deliveryId',
      ];
      const BETA_URL = 'https://hooks.isolation.example.test/in';

      function webhookProbes(probes: readonly Probe[]): Probe[] {
        return probes.filter((probe) => WEBHOOK_ROUTES.includes(`${probe.method} ${probe.path}`));
      }

      it('are all swept, from alpha and from an account with no organisation', () => {
        expect(pathsOf(addressable)).toEqual(expect.arrayContaining(WEBHOOK_ROUTES));

        for (const probes of [byAlpha, byOutsider]) {
          expect(
            webhookProbes(probes)
              .map((probe) => `${probe.method} ${probe.path}`)
              .sort(),
          ).toEqual([...WEBHOOK_ROUTES].sort());
        }
      });

      it('show beta’s own owner beta’s endpoint, so the hunt below is for something real', () => {
        const reads = webhookProbes(byBeta);

        expect(
          reads.map((probe) => `${probe.method} ${probe.path} → ${probe.status}`).sort(),
        ).toEqual(
          [
            'GET /api/v1/orgs/:orgId/webhooks/endpoints → 200',
            'GET /api/v1/orgs/:orgId/webhooks/endpoints/:endpointId → 200',
            ...DELIVERY_READS.map((route) => `${route} → 200`),
          ].sort(),
        );
        for (const probe of reads) {
          if (DELIVERY_READS.includes(`${probe.method} ${probe.path}`)) {
            // A delivery names neither its endpoint nor the URL; it is found by its own id.
            expect(probe.text).toContain(world.betaDeliveryId);
          } else {
            expect(probe.text).toContain(world.betaEndpointId);
            expect(probe.text).toContain(BETA_URL);
          }
        }
      });

      it('refuse alpha and the outsider on every one, and disclose neither id nor URL', () => {
        const answered = [...webhookProbes(byAlpha), ...webhookProbes(byOutsider)].filter(
          (probe) =>
            probe.status < 400 ||
            JSON.stringify(probe.body).includes(BETA_URL) ||
            JSON.stringify(probe.body).includes(world.betaEndpointId) ||
            JSON.stringify(probe.body).includes(world.betaDeliveryId),
        );

        expect(answered.map(describeProbe)).toEqual([]);
      });

      /**
       * A replayed or mis-addressed `webhook.attempt-due`: alpha's organisation on the envelope and
       * in the payload, beta's send id beside it. The consumer claims in the payload's tenant, so
       * the claim runs under alpha's RLS and finds no row: nothing is claimed, nothing is sent, and
       * beta's row is what it was. The same event in beta's own scope then claims that row (and,
       * the endpoint being disabled, settles it `not_sent`), so the no-op is the tenancy and not a
       * row that was never due.
       *
       * The consumer is the app's repositories and transactions with a clock of its own and a
       * transport that records: the send is due only in 2100, so no redelivery sweep in a
       * concurrent suite can claim it, while this consumer's clock finds it due.
       */
      describe('a replayed webhook.attempt-due for beta’s send', () => {
        const at = new Date('2100-06-01T00:00:00.000Z');
        const sent: string[] = [];
        let consumer: WebhookAttemptConsumer;
        let sendId: string;

        function envelope(orgId: string): Envelope<'webhook.attempt-due'> {
          return {
            aggregate: 'webhook-send',
            aggregateId: sendId,
            eventId: randomUUID(),
            occurredAt: at.toISOString(),
            orgId,
            payload: { orgId, sendId },
            traceId: null,
            type: 'webhook.attempt-due',
          };
        }

        function readRow(): Promise<unknown> {
          return transactions.runInTenantTransaction(world.beta.orgId, async (tx) => {
            const [row] = await tx
              .select()
              .from(schema.webhookSends)
              .where(eq(schema.webhookSends.id, sendId));

            return row;
          });
        }

        async function replay(orgId: string): Promise<void> {
          const event = envelope(orgId);
          const plan = await transactions.runInTenantTransaction(orgId, (tx) =>
            consumer.handle(event, tx),
          );
          await consumer.effect(event, plan);
        }

        beforeAll(async () => {
          const [send] = await transactions.runInTenantTransaction(world.beta.orgId, (tx) =>
            app.get(SendRepository).insertFanout(tx, [
              {
                body: '{}',
                endpointId: world.betaEndpointId,
                eventId: randomUUID(),
                eventType: 'deploy.succeeded',
                now: at,
                occurredAt: at,
                orgId: world.beta.orgId,
                projectId: null,
                state: 'pending',
              },
            ]),
          );
          sendId = send!.id;

          const transport = {
            send: (request: { url: string }) => (
              sent.push(request.url),
              Promise.reject(new Error('not in this suite'))
            ),
          } as unknown as SafeTransport;

          consumer = new WebhookAttemptConsumer(
            app.get(SendRepository),
            app.get(EndpointRepository),
            app.get(SigningSecrets),
            transport,
            transactions,
            { now: () => new Date(at.getTime() + 5000) },
            app.get(OutboxWriter),
            app.get(AuditService),
          );
        });

        afterAll(async () => {
          // Whatever the control wrote to the shared outbox is not for a relay elsewhere.
          await database
            .update(schema.outbox)
            .set({ publishedAt: new Date() })
            .where(eq(schema.outbox.aggregateId, sendId));
        });

        it('in alpha’s scope, has no effect on beta’s send and sends nothing', async () => {
          const rowBefore = await readRow();

          expect(rowBefore).toBeDefined();

          await replay(world.alpha.orgId);

          expect(await readRow()).toEqual(rowBefore);
          expect(sent).toEqual([]);
        });

        it('in beta’s own scope, does claim that send — the control', async () => {
          await replay(world.beta.orgId);

          expect(await readRow()).toMatchObject({ state: 'not_sent' });
          expect(sent).toEqual([]);
        });
      });
    });

    /**
     * ## Criterion 13's other vectors
     *
     * §17 names a background job, an export path and a cache key alongside the routes. None of the
     * three has an HTTP surface here — §10's queue is deferred and there is no export endpoint — so
     * each is exercised where it actually lives.
     */
    describe('a background-style job', () => {
      /**
       * What a worker is: a service call with no request in front of it, holding an org id that came
       * from a payload rather than from a URL. The dangerous version is a job that opens its own
       * tenant scope and then queries with an id from somewhere else — a stale message, a replayed
       * queue entry, a bug in whoever enqueued it.
       */
      it('sees nothing of beta when it runs in alpha’s scope with beta’s ids', async () => {
        const projects = app.get(ProjectService);
        const workspaces = app.get(WorkspaceService);

        const seen = await transactions.runInTenantScope(
          { orgId: world.alpha.orgId, userId: world.alpha.owner.userId },
          async () => ({
            projects: await projects.list(world.beta.orgId, world.beta.owner.userId),
            workspaces: await workspaces.list(world.beta.orgId, world.beta.owner.userId),
          }),
        );

        expect(seen).toEqual({ projects: [], workspaces: [] });
      });

      /** And the same job in beta's own scope does see them, so the emptiness above is the policy. */
      it('sees them when it runs in beta’s scope', async () => {
        const projects = app.get(ProjectService);

        const seen = await transactions.runInTenantScope(
          { orgId: world.beta.orgId, userId: world.beta.owner.userId },
          () => projects.list(world.beta.orgId, world.beta.owner.userId),
        );

        expect(seen.map((project) => project.id)).toEqual([world.beta.projectId]);
      });
    });

    describe('an export path', () => {
      /**
       * What an export is, stripped of its file format: an unfiltered read of every tenant-owned
       * table. The tables come from the schema rather than a list, so one added later is exported —
       * and therefore checked — without anybody remembering to add it here.
       */
      it('reads every tenant-owned table in alpha’s transaction and finds no row of beta’s', async () => {
        const tables = tenantOwnedTables();

        expect(tables.length).toBeGreaterThan(0);

        const foreign = await transactions.runInTenantTransaction(world.alpha.orgId, async (tx) => {
          const found: string[] = [];

          for (const { name, table } of tables) {
            const rows = (await tx.select().from(table)) as { orgId?: string }[];

            found.push(
              ...rows
                .filter((row) => row.orgId === world.beta.orgId)
                .map(() => `${name} carried a row of beta's`),
            );
          }

          return found;
        });

        expect(foreign).toEqual([]);
      });
    });

    describe('a cache key', () => {
      /**
       * §11 puts the cache in the isolation table as "every key prefixed with the org id → key
       * collision impossible by construction". The sweep has just driven alpha's principal through
       * every one of beta's routes, which is exactly what would populate a badly keyed entry.
       */
      it('holds no permission for alpha in beta’s organisation, after the whole sweep', async () => {
        const cached = await permissions.read(world.beta.orgId, world.alpha.owner.userId);

        expect(cached === null ? [] : [...cached]).toEqual([]);
      });

      it('holds beta’s owner’s permissions under beta’s key and nobody else’s', async () => {
        const own = await permissions.read(world.beta.orgId, world.beta.owner.userId);

        expect(own === null ? [] : [...own]).toContain('org:read');

        // The same user id under the other tenant's prefix is a different entry, which is what the
        // `o:{org_id}` key shape buys. If the two ever collided, this would carry beta's set.
        const crossed = await permissions.read(world.alpha.orgId, world.beta.owner.userId);

        expect(crossed === null ? [] : [...crossed]).toEqual([]);
      });

      it('flushes one tenant without touching the other', async () => {
        await permissions.write(world.alpha.orgId, world.alpha.owner.userId, new Set(['org:read']));
        await permissions.write(world.beta.orgId, world.beta.owner.userId, new Set(['org:read']));

        await permissions.invalidateOrg(world.alpha.orgId);

        expect(await permissions.read(world.alpha.orgId, world.alpha.owner.userId)).toBeNull();
        expect(await permissions.read(world.beta.orgId, world.beta.owner.userId)).not.toBeNull();
      });
    });

    /**
     * ## Criterion 14, re-asserted where the requests happen
     *
     * T06 proves this against a bare connection. Here it is proved against the pool the HTTP
     * application has been serving requests on, after the sweep has run every route three times —
     * which is the state §09's PgBouncer warning is about: a connection handed back to the pool
     * still carrying the last request's tenant.
     */
    describe('a query outside a tenant transaction', () => {
      it('returns zero rows from every tenant-owned table', async () => {
        for (const { name, table } of tenantOwnedTables()) {
          const rows = await database.select().from(table);

          expect({ rows: rows.length, table: name }).toEqual({ rows: 0, table: name });
        }
      });

      /**
       * And the rows are demonstrably there. Without this the assertion above is equally true of an
       * empty database, a dropped schema, or a fixture that never wrote anything.
       */
      it('while the same query inside beta’s transaction returns them', async () => {
        const workspaces = await transactions.runInTenantTransaction(world.beta.orgId, (tx) =>
          tx.select().from(schema.workspaces),
        );
        const projects = await transactions.runInTenantTransaction(world.beta.orgId, (tx) =>
          tx.select().from(schema.projects),
        );

        expect(workspaces.map((row) => row.id)).toContain(world.beta.workspaceId);
        expect(projects.map((row) => row.id)).toContain(world.beta.projectId);
      });
    });
  });
});

/** `GET /api/v1/orgs/:orgId` — the form the excuse list and every failure message use. */
function label(route: EnumeratedRoute): string {
  return `${route.method} ${route.path}`;
}

function pathsOf(routes: readonly EnumeratedRoute[]): string[] {
  return routes.map(label);
}

function isTenantAddressable(route: EnumeratedRoute): boolean {
  return route.parameters.some((name) => name in TENANT_PARAMETERS);
}

/** One line naming the probe, so a failure says which route and which principal without a debugger. */
function describeProbe(probe: Probe): string {
  return `${probe.method} ${probe.path} → ${probe.status}`;
}

/** The RFC 9457 slug a refusal carries, or `''` for a success. */
function slugOf(probe: Probe): string {
  const { type } = probe.body;

  return typeof type === 'string' ? (type.split('/').pop() ?? '') : '';
}

function shapeOf(probe: Probe): string {
  if (probe.status < 300) {
    return 'success';
  }

  return slugOf(probe).length > 0 ? 'problem-details' : `unrecognised: ${probe.text.slice(0, 120)}`;
}

/** Which of the target's identifiers appear in a response that should carry none of them. */
function leaksIn(probe: Probe, target: Tenant): string[] {
  const rendered = JSON.stringify(probe.body);

  return target.secrets.filter((secret) => rendered.includes(secret));
}

/**
 * Every route in `routes`, aimed at beta, sent as `principal`.
 *
 * Sequential rather than concurrent: the sweep shares one Postgres pool with the fixture, and a
 * burst of parallel requests turns a pool wait into a timeout that reads like a failed assertion.
 */
async function sweep(
  app: INestApplication,
  routes: readonly EnumeratedRoute[],
  world: SweepWorld,
  principal: Principal,
): Promise<Probe[]> {
  const probes: Probe[] = [];

  for (const route of routes) {
    const values = Object.fromEntries(
      route.parameters.map((name) => [
        name,
        name in TENANT_PARAMETERS
          ? TENANT_PARAMETERS[name]!(world.beta, world)
          : NON_TENANT_PARAMETERS[name]!,
      ]),
    );

    const query = QUERIES[label(route)];
    const url =
      fillRoutePath(route.path, values) +
      (query === undefined ? '' : `?${new URLSearchParams(query).toString()}`);
    const response = await issue(app, route, url, principal);

    probes.push({
      // `instance` is the request's own URL and `requestId` is per-request, so both would carry the
      // ids the probe itself chose and turn every refusal into a false leak. Stripped exactly as
      // `tenancy.e2e-spec.ts` strips them when comparing two refusals.
      body: withoutCorrelation(response.body as Record<string, unknown>),
      method: route.method,
      path: route.path,
      status: response.status,
      text: response.text,
      url,
    });
  }

  return probes;
}

function issue(
  app: INestApplication,
  route: EnumeratedRoute,
  url: string,
  principal: Principal,
): request.Test {
  const agent = http(app);
  const body = BODIES[label(route)] ?? {};

  switch (route.method) {
    case 'DELETE': {
      return unsafe(agent.delete(url), [principal.cookie]).send(body);
    }
    case 'GET': {
      return agent.get(url).set('Cookie', principal.cookie);
    }
    case 'PATCH': {
      return unsafe(agent.patch(url), [principal.cookie]).send(body);
    }
    case 'POST': {
      return unsafe(agent.post(url), [principal.cookie]).send(body);
    }
    case 'PUT': {
      return unsafe(agent.put(url), [principal.cookie]).send(body);
    }
    default: {
      // Reached only if a controller starts using a verb this switch does not send. Throwing keeps
      // that route from being silently dropped from the sweep.
      throw new Error(`the isolation sweep cannot issue a ${route.method} request`);
    }
  }
}

function withoutCorrelation(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(body ?? {}).filter(
      ([member]) => member !== 'instance' && member !== 'requestId',
    ),
  );
}

/**
 * Every row of every tenant-owned table for one organisation, rendered as a stable string per table.
 *
 * Sorted rather than trusted to come back in insertion order: a diff caused by Postgres choosing a
 * different plan is a failure nobody can act on, and would make this assertion the flakiest in the
 * suite rather than the strictest.
 */
async function snapshotTenant(
  transactions: TenantTransactionRunner,
  orgId: string,
): Promise<Record<string, string>> {
  return transactions.runInTenantTransaction(orgId, async (tx) => {
    const snapshot: Record<string, string> = {};

    for (const { name, table } of tenantOwnedTables()) {
      const rows = (await tx.select().from(table)) as unknown[];

      snapshot[name] = JSON.stringify(rows.map((row) => JSON.stringify(row)).sort());
    }

    return snapshot;
  });
}
