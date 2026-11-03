import { Inject, Injectable } from '@nestjs/common';
import { PROJECT_TEMPLATES, type ProjectTemplate } from '@repo/contracts';
import { projects, sandboxes } from '@repo/db';
import { and, eq, isNull } from 'drizzle-orm';

import { BYPASS_DATABASE } from '../../database/database.constants';
import type { ForgeDatabase } from '../../database/database.types';
import { TenantTransactionRunner } from '../../database/tenant-transaction';
import { DaytonaAdapter } from '../sandbox/daytona.adapter';
import { SANDBOX_LIFECYCLE, type SandboxLifecycle } from '../sandbox/sandbox-lifecycle';
import { TemplateCatalogue } from '../sandbox/template-catalogue';
import { ROUTE_SIGNER } from './preview.constants';
import { ROUTE_TTL_SECONDS, type RouteSigner } from './route-signer';

/** Contract § 4's host grammar: 20 admits the pre-007 rows the generator's comment mentions. */
const LABEL = /^[0-9a-f]{20,64}$/;

/**
 * Why a label did not resolve. Internal only: the wire answer is `404 {}` for every one of these
 * (contract § 3), so the gateway can tell none of them apart and neither can a visitor probing it.
 * `never-run` is a project with no `sandboxes` row at all; `unroutable` is a row in any state but
 * `active`/`idle`, mid-transition, lost or not yet started; `no-port` is a template that declares
 * no `devPort`. Two are not `404` on the wire: `resuming` — a `hibernated` row was handed to
 * `ensureReady` and the gateway renders the waking page (`202`) — and `unauthorised` — a
 * non-public preview is cold and the caller carried no grant that opens it, so nothing was woken
 * (`401`).
 */
export type RouteRefusal =
  'never-run' | 'no-port' | 'resuming' | 'unauthorised' | 'unknown-label' | 'unroutable';

/** What the gateway forwards from the visitor: its grant cookie and the bare host it was asked for. */
export interface RouteCaller {
  readonly grant?: string | undefined;
  readonly host?: string | undefined;
}

export type RouteResolution =
  | { readonly kind: 'route'; readonly route: string }
  | { readonly kind: 'refused'; readonly because: RouteRefusal };

const refused = (because: RouteRefusal): RouteResolution => ({ because, kind: 'refused' });

/**
 * Resolves a preview label to one signed route (spec 017 FR-015/FR-016). Reads `projects` and
 * `sandboxes` through the `@repo/db` schema under the tenant transaction — a schema read, never
 * another module's `*.repository.*` (016's precedent) — binds the route to the row's provider
 * identity, takes the port from the template's `devPort`, and the upstream from the provider's
 * signed per-port origin with the route's own TTL, so a token never outlives the route (R19).
 */
@Injectable()
export class RouteBrokerService {
  constructor(
    @Inject(BYPASS_DATABASE) private readonly bypass: ForgeDatabase,
    @Inject(TenantTransactionRunner) private readonly transactions: TenantTransactionRunner,
    @Inject(TemplateCatalogue) private readonly catalogue: TemplateCatalogue,
    @Inject(DaytonaAdapter) private readonly daytona: DaytonaAdapter,
    @Inject(ROUTE_SIGNER) private readonly signer: RouteSigner,
    @Inject(SANDBOX_LIFECYCLE) private readonly lifecycle: SandboxLifecycle,
  ) {}

  async resolve(label: string, caller: RouteCaller = {}): Promise<RouteResolution> {
    if (!LABEL.test(label)) return refused('unknown-label');

    const located = await this.locate(label);
    if (located === undefined) return refused('unknown-label');

    const { project, sandbox } = located;
    if (sandbox === undefined) return refused('never-run');
    // The same ladder `SandboxService.resolve` applies (data-model § Derived state), read at mint
    // time and stamped into the route, never stored.
    if (sandbox.lostAt !== null || sandbox.workspaceRoot === null) return refused('unroutable');
    // A resume already in flight — this broker's or a run's — is what `ensureReady` would answer
    // too, without touching the row; every other transition is unroutable.
    if (sandbox.transition === 'resuming') return refused('resuming');
    if (sandbox.transition !== null) return refused('unroutable');
    if (sandbox.state === 'hibernated') {
      // The gateway cannot know a cold private preview needs a grant before it asks, so the wake
      // is gated here: a public preview wakes freely; any other needs a grant that verifies for
      // this label's own host. Nothing is woken for a stranger.
      if (project.previewVisibility !== 'public' && !(await this.entitled(label, caller))) {
        return refused('unauthorised');
      }
      // The 014-promised wake trigger (research R10): the lifecycle, epoch 0, a preview-named
      // operation. At most one resume is in flight because `ensureReady` enqueues only while
      // `transition is null` and `SandboxOpsConsumer` dedupes on `${sandboxId}.${op}`; a resolve
      // that lands after the first committed is answered `resuming` by the guard above.
      await this.transactions.runInTenantTransaction(project.orgId, (tx) =>
        this.lifecycle.ensureReady(
          tx,
          { orgId: project.orgId, projectId: project.id },
          { leaseEpoch: 0, operationId: `preview/${label}` },
        ),
      );
      return refused('resuming');
    }
    if (sandbox.state !== 'active' && sandbox.state !== 'idle') return refused('unroutable');

    const port = this.devPort(project.template);
    if (port === undefined) return refused('no-port');

    const origin = await this.daytona.previewOrigin(sandbox.daytonaId, port, ROUTE_TTL_SECONDS);
    const route = await this.signer.sign({
      ...origin,
      label,
      org: project.orgId,
      ports: [port],
      project: project.id,
      sandbox: sandbox.daytonaId,
      state: sandbox.state,
      visibility: project.previewVisibility,
    });

    return { kind: 'route', route };
  }

  /** A grant that verifies (signature, `exp`, `sub`, `aud === host`) for a host that is this label's. */
  private async entitled(label: string, { grant, host }: RouteCaller): Promise<boolean> {
    if (grant === undefined || !host?.startsWith(`${label}-`)) return false;
    return (await this.signer.verifyGrant(grant, host)) !== undefined;
  }

  /** A template with no `devPort` has no routable port and its projects answer that plainly (data-model). */
  private devPort(template: string | null): number | undefined {
    if (template === null || !(PROJECT_TEMPLATES as readonly string[]).includes(template)) {
      return undefined;
    }
    const declared = this.catalogue.get(template as ProjectTemplate).manifest.devPort;
    return declared === undefined ? undefined : Number(declared);
  }

  /**
   * The label-bearing request names no tenant and `projects` is under RLS, so the org is found by
   * one index-served probe of `projects_preview_label_key` on the bypass pool — the fourth use §09
   * permits (`database.constants.ts`) — and everything after it runs under that tenant's
   * transaction. The index spans soft-deleted rows, so the `deleted_at` filter is what makes an
   * archived project's label unknown rather than routable. Public because `GrantService` makes
   * the same label → org lookup before it checks membership, and a second probe would be a second
   * bypass read to keep honest.
   */
  async locate(label: string) {
    const [hit] = await this.bypass
      .select({ orgId: projects.orgId })
      .from(projects)
      .where(and(eq(projects.previewLabel, label), isNull(projects.deletedAt)))
      .limit(1);
    if (hit === undefined) return undefined;

    return this.transactions.runInTenantTransaction(hit.orgId, async (tx) => {
      const project = await tx.query.projects.findFirst({
        where: and(eq(projects.previewLabel, label), isNull(projects.deletedAt)),
      });
      if (project === undefined) return undefined;
      const sandbox = await tx.query.sandboxes.findFirst({
        where: and(eq(sandboxes.orgId, hit.orgId), eq(sandboxes.projectId, project.id)),
      });
      return { project, sandbox };
    });
  }
}
