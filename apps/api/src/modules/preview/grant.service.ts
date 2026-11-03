import { Inject, Injectable, Logger } from '@nestjs/common';
import { memberships } from '@repo/db';
import { and, eq, isNotNull } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

import { SESSION_REDIS } from '../../common/redis/redis.constants';
import { TenantTransactionRunner } from '../../database/tenant-transaction';
import { AuditService } from '../audit/audit.service';
import { PermissionResolutionService } from '../rbac/permission-resolution.service';
import { scoped } from '../rbac/permissions';
import { PREVIEW_DOMAIN, revokedLabelKey, ROUTE_SIGNER } from './preview.constants';
import { RouteBrokerService } from './route-broker.service';
import type { RouteSigner } from './route-signer';

/** FR-024: a code lives for no more than a minute. */
export const CODE_TTL_SECONDS = 60;

/** `pv:code:<sha256>`: the digest is the key, exactly as `sessionKey` hashes a session token (data-model). */
export const codeKey = (code: string): string =>
  `pv:code:${createHash('sha256').update(code).digest('hex')}`;

/** What one code stands for (data-model § Redis keys), plus the ids the audit row needs. */
const codeRecordSchema = z.strictObject({
  label: z.string(),
  nonce: z.string(),
  org: z.uuid(),
  project: z.uuid(),
  returnHost: z.string(),
  userId: z.uuid(),
});

const CODE = /^([0-9a-f]{32})\.([0-9a-f]{32})$/;

/** A corrupt record is a refusal, never a throw the listener turns into a 500. */
function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

const escape = (literal: string) => literal.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

/**
 * The authorisation-code exchange (spec 017 US2, research R6). `issueCode` runs on the product
 * origin behind the session and answers a code only to a member of the label's organisation — for
 * a `private` preview, one holding `project:read` on that project — for a return host that is
 * that label's own preview host; `redeem` runs for the broker and turns the
 * code into a grant JWS once. Every refusal is `undefined` — the callers each have exactly one
 * body for all of them (contract § 2/§ 3), so a reason here would be a reason leaked there.
 *
 * The code is `<id>.<nonce>`: the record is keyed by the id's digest and holds the nonce, so a
 * code that names a real record but does not carry its nonce is refused — and spent, as a wrong
 * host spends it, because `GETDEL` is the read (FR-024).
 */
@Injectable()
export class GrantService {
  private readonly logger = new Logger(GrantService.name);
  private readonly hostGrammar: RegExp;

  constructor(
    @Inject(SESSION_REDIS) private readonly redis: Redis,
    @Inject(TenantTransactionRunner) private readonly transactions: TenantTransactionRunner,
    @Inject(RouteBrokerService) private readonly routes: RouteBrokerService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PermissionResolutionService) private readonly permissions: PermissionResolutionService,
    @Inject(ROUTE_SIGNER) private readonly signer: RouteSigner,
    @Inject(PREVIEW_DOMAIN) domain: string,
  ) {
    // Contract § 4's host grammar under this deployment's domain: `<label>-<port>.<domain>`.
    this.hostGrammar = new RegExp(String.raw`^([0-9a-f]{20,64})-(\d{4,5})\.${escape(domain)}$`);
  }

  /** `returnHost` is the authority the gateway bounced with: `<label>-<port>.<domain>[:port]`. */
  async issueCode(input: {
    label: string;
    returnHost: string;
    userId: string;
  }): Promise<string | undefined> {
    const { label, userId } = input;
    // The gateway forwards its full `Host` authority so a local port round-trips; the hostname is
    // what the grammar, the record and the grant's `aud` all use, and it is checked before any
    // read, so a bad host is not a probe of whether a label exists.
    const returnHost = input.returnHost.split(':', 1)[0] ?? '';
    const host = this.hostGrammar.exec(returnHost);
    const port = Number(host?.[2]);
    if (host?.[1] !== label || port < 1024 || port > 65_535) {
      return undefined;
    }

    const located = await this.routes.locate(label);
    if (located === undefined) return undefined;
    const { id: project, orgId: org, previewVisibility } = located.project;

    // FR-021 as amended: `org` admits any accepted member; `private` admits only a holder of
    // `project:read` on this project, read from the same resolved set `RequirePermissionGuard`
    // consults, so a guest of another project is refused exactly as a stranger is.
    const entitled =
      previewVisibility !== 'private' ||
      (await this.permissions.for(org, userId)).has(scoped('project:read', project));

    const member = await this.transactions.runInTenantTransaction(org, async (tx) => {
      const [row] = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .where(
          and(
            eq(memberships.orgId, org),
            eq(memberships.userId, userId),
            isNotNull(memberships.acceptedAt),
          ),
        )
        .limit(1);
      if (row !== undefined && entitled) return true;
      await this.audit.record(tx, {
        action: 'preview-grant.refused',
        actorId: userId,
        metadata: { because: row === undefined ? 'not-a-member' : 'no-project-access' },
        orgId: org,
        target: project,
      });
      return false;
    });
    if (!member) return undefined;

    const id = randomBytes(16).toString('hex');
    const nonce = randomBytes(16).toString('hex');
    const record: z.input<typeof codeRecordSchema> = {
      label,
      nonce,
      org,
      project,
      returnHost,
      userId,
    };
    await this.redis.set(codeKey(id), JSON.stringify(record), 'EX', CODE_TTL_SECONDS);
    return `${id}.${nonce}`;
  }

  async redeem(code: string, host: string): Promise<string | undefined> {
    const parts = CODE.exec(code);
    if (parts === null) return undefined;
    const [, id, nonce] = parts as unknown as [string, string, string];

    const raw = await this.redis.getdel(codeKey(id));
    if (raw === null) return undefined; // spent or expired: the same silence as never issued
    const parsed = codeRecordSchema.safeParse(parseJson(raw));
    if (!parsed.success) {
      this.logger.warn(`grant code record unreadable [key=${codeKey(id)}]`);
      return undefined;
    }
    const record = parsed.data;

    const because = !timingSafeEqual(Buffer.from(nonce), Buffer.from(record.nonce))
      ? 'nonce-mismatch'
      : record.returnHost !== host
        ? 'host-mismatch'
        : (await this.redis.exists(revokedLabelKey(record.label))) === 1
          ? 'label-revoked'
          : undefined;

    const grant =
      because === undefined
        ? await this.signer.signGrant({ aud: host, sub: record.userId })
        : undefined;

    await this.transactions.runInTenantTransaction(record.org, (tx) =>
      this.audit.record(tx, {
        action: because === undefined ? 'preview-grant.issued' : 'preview-grant.refused',
        actorId: record.userId,
        metadata: because === undefined ? { host } : { because, host },
        orgId: record.org,
        target: record.project,
      }),
    );
    return grant;
  }
}
