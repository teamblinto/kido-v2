import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sandboxes } from '@repo/db';
import { and, eq } from 'drizzle-orm';
import { Redis } from 'ioredis';

import { ForbiddenError, RateLimitedError } from '../../common/errors/domain-error';
import { SESSION_REDIS } from '../../common/redis/redis.constants';
import type { Environment, PreviewJwks } from '../../config/environment';
import { TenantTransactionRunner } from '../../database/tenant-transaction';
import { AuditService } from '../audit/audit.service';
import { callbackRateKey } from './preview.constants';
import { type SandboxCallbackClaims, verifySandboxCallbackToken } from './sandbox-callback.token';

/** Where the guard leaves the verified claims for the controller (`request[SANDBOX_CALLBACK]`). */
export const SANDBOX_CALLBACK = Symbol('forge.preview.sandboxCallback');

/** FR-038: calls per sandbox per window. */
export const CALLBACK_RATE_LIMIT = 60;
export const CALLBACK_RATE_WINDOW_SECONDS = 60;

/**
 * The row's current lease epoch. `sandboxes` keeps no `lease_epoch` column today (spec
 * § Assumptions: the provider id is the per-sandbox identity), so the current epoch is the floor.
 * ponytail: when a lease counter lands on the row, select it in `canActivate` and this constant goes.
 */
export const SANDBOX_LEASE_EPOCH = 0;

/** One body for every refusal here and in the controller: the reason is in the audit row and the log. */
export const CALLBACK_REJECTION = 'A valid sandbox callback token is required for this request.';

/**
 * `SandboxCallbackGuard` (contract § 6, research R11): verifies the token's signature and
 * audience, then **re-reads the `sandboxes` row on every call** — a `lostAt`, a `daytonaId` that
 * no longer matches, or an epoch below the row's current one is refused and audited. That per-call
 * re-check is the sandbox-side epoch check `tool-broker.ts` names 017 as the owner of. The rate
 * counter lives in `SESSION_REDIS` (`pv:cb:<daytonaId>`), moves before the row is re-read, and
 * fails **closed**: a Redis error is a refusal, not a pass, because a limiter that opens under
 * load is no limiter.
 */
@Injectable()
export class SandboxCallbackGuard implements CanActivate {
  private readonly logger = new Logger(SandboxCallbackGuard.name);
  private readonly jwks: PreviewJwks;

  constructor(
    @Inject(SESSION_REDIS) private readonly redis: Redis,
    @Inject(TenantTransactionRunner) private readonly transactions: TenantTransactionRunner,
    @Inject(AuditService) private readonly audit: AuditService,
    config: ConfigService<Environment, true>,
  ) {
    this.jwks = config.get('PREVIEW_PUBLIC_JWKS', { infer: true });
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | string[] | undefined> }>();
    const authorization = request.headers.authorization;
    const jws =
      typeof authorization === 'string' ? /^Bearer (.+)$/i.exec(authorization)?.[1] : undefined;
    if (jws === undefined) throw new ForbiddenError(CALLBACK_REJECTION);

    let claims: SandboxCallbackClaims;
    try {
      claims = await verifySandboxCallbackToken(jws, this.jwks);
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : 'unknown';
      this.logger.warn(`sandbox callback token did not verify [code=${code}]`);
      throw new ForbiddenError(CALLBACK_REJECTION);
    }

    // The counter moves before the row is re-read: the signature already proves the caller is a
    // sandbox this platform minted for, and a flood from it must not be a flood on the database.
    // A fixed window: `EXPIRE` only when this `INCR` opened it (reply 1), so retries above the
    // limit cannot slide the window and lock a sandbox out for good.
    let count = Number.NaN;
    try {
      const key = callbackRateKey(claims.sandbox);
      count = await this.redis.incr(key);
      if (count === 1) await this.redis.expire(key, CALLBACK_RATE_WINDOW_SECONDS);
    } catch (error) {
      this.logger.error(`sandbox callback limiter unavailable: ${String(error)}`);
    }
    if (!(count <= CALLBACK_RATE_LIMIT)) {
      throw new RateLimitedError(
        'Too many sandbox callbacks in the last minute.',
        CALLBACK_RATE_WINDOW_SECONDS,
        { sandbox: claims.sandbox },
      );
    }

    const because = await this.transactions.runInTenantTransaction(claims.org, async (tx) => {
      const [row] = await tx
        .select({ daytonaId: sandboxes.daytonaId, lostAt: sandboxes.lostAt })
        .from(sandboxes)
        .where(and(eq(sandboxes.orgId, claims.org), eq(sandboxes.projectId, claims.project)))
        .limit(1);
      const reason =
        row?.daytonaId !== claims.sandbox
          ? 'sandbox-mismatch'
          : row.lostAt !== null
            ? 'sandbox-lost'
            : claims.leaseEpoch < SANDBOX_LEASE_EPOCH
              ? 'stale-epoch'
              : undefined;
      if (reason !== undefined) {
        this.logger.warn(`sandbox callback refused [because=${reason} sandbox=${claims.sandbox}]`);
        await this.audit.record(tx, {
          action: 'sandbox-callback.refused',
          actorId: null,
          metadata: { because: reason, sandbox: claims.sandbox },
          orgId: claims.org,
          target: claims.project,
        });
      }
      return reason;
    });
    // One body for every refusal: the reason is in the audit row and the log, never the response.
    if (because !== undefined) throw new ForbiddenError(CALLBACK_REJECTION);

    (request as Record<PropertyKey, unknown>)[SANDBOX_CALLBACK] = claims;
    return true;
  }
}
