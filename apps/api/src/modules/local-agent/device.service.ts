import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  type CompanionPolicy,
  type CompanionRunEvent,
  type CompanionRunEventBatch,
  type CompanionStatusReport,
  localAgentDeviceTokenSchema,
} from '@repo/contracts';
import type { LocalAgentDeviceRow } from '@repo/db';

import { CLOCK, type ClockPort } from '../../common/clock/clock.port';
import { ConflictError, DomainError, NotFoundError } from '../../common/errors/domain-error';
import { LAST_SEEN_EVERY_MS } from './local-agent.constants';
import { LIVE_RUN_STATUSES, LocalAgentRepository } from './local-agent.repository';
import { LocalAgentStore } from './local-agent.store';
import { COMPANION_POLICY, withPolicy } from './policy';
import { sha256 } from './secrets';

/** One refusal for an unknown, malformed or revoked token: the runner stops. */
export function revoked(): DomainError {
  return new DomainError(
    'local-agent-revoked',
    'This runner’s token is not recognised, or was revoked.',
  );
}

/**
 * The runner's devices (spec 040 § 5, spec 041): the device token's check and what the hosted
 * runner in an agent home posts up. Only `cloud` devices authenticate: a person's own paired
 * computer (`local`, spec 040) is retired, so its token is refused as a revoked one. Every refused
 * token goes to the structured log (§05) — never a token, only the device id.
 */
@Injectable()
export class DeviceService {
  private readonly logger = new Logger(DeviceService.name);
  readonly policy: CompanionPolicy = COMPANION_POLICY;

  constructor(
    @Inject(LocalAgentRepository) private readonly repository: LocalAgentRepository,
    @Inject(LocalAgentStore) private readonly store: LocalAgentStore,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  /** The command stream's per-heartbeat check: the device still exists, is a runner, not revoked. */
  async isLive(deviceId: string): Promise<boolean> {
    const row = await this.repository.byId(deviceId);

    return row?.revokedAt === null && row.kind === 'cloud';
  }

  /** `DeviceTokenGuard`'s check: by digest, a live `cloud` runner; `last_seen_at` once a minute. */
  async authenticate(token: string | undefined): Promise<LocalAgentDeviceRow> {
    if (token === undefined || !localAgentDeviceTokenSchema.safeParse(token).success) {
      throw revoked();
    }

    const row = await this.repository.byTokenHash(sha256(token));

    // A retired `local` device is refused like a revoked one, whatever its row says.
    if (row?.revokedAt !== null || row.kind !== 'cloud') {
      this.logger.warn(`local agent token refused: device=${row?.id ?? 'unknown'}`);
      throw revoked();
    }

    const now = this.clock.now();

    if (row.lastSeenAt === null || now.getTime() - row.lastSeenAt.getTime() >= LAST_SEEN_EVERY_MS) {
      await this.repository.touch(row.id, now);
    }

    return row;
  }

  async reportStatus(device: LocalAgentDeviceRow, report: CompanionStatusReport): Promise<void> {
    await this.store.saveStatus(device.id, withPolicy(report, this.policy));

    // Spec 041: an agent home's verdict is kept past the report's own TTL (a stopped home still
    // admits runs), and an `authenticated` one is what ends a sign-in — not the runner's flag.
    const claude = report.providers.find((each) => each.provider === 'claude');

    if (claude !== undefined) {
      await this.store.saveHomeAuth(device.id, {
        // When this server heard it, not the runner's clock: compared with the home's own times.
        checkedAt: this.clock.now().toISOString(),
        plan: claude.auth.plan,
        status: claude.auth.status,
      });
      if (claude.auth.status === 'authenticated') await this.store.clearSignIn(device.id);
    }

    if (report.companionVersion !== device.companionVersion) {
      await this.repository.setCompanionVersion(device.id, report.companionVersion);
    }
  }

  /**
   * A batch for a run this device executes, appended to its turn's stream once per `seq` — only
   * while a worker holds the run and the batch's turn is the one it is running (`409` otherwise),
   * and within the turn's byte budget (`413`, and the run is aborted). The provider's session id
   * is recorded with the run, the resume reference of its next turn.
   */
  async ingest(
    device: LocalAgentDeviceRow,
    runId: string,
    batch: CompanionRunEventBatch,
  ): Promise<number> {
    const run = await this.repository.runForDevice(runId, device.id);

    if (run === undefined) {
      throw new NotFoundError('No such run on this device.');
    }

    if (!(LIVE_RUN_STATUSES as readonly string[]).includes(run.status)) {
      throw new ConflictError(`Run is ${run.status}; it takes no events now.`);
    }

    const appended = await this.store.appendRunEvents(runId, batch.turn, batch.events);

    if (appended.kind === 'not-active') {
      throw new ConflictError('That turn of the run is not the one running.');
    }

    if (appended.kind === 'over-budget') {
      await this.store.abortRun(runId, 'over-budget');
      this.logger.warn(`local run over its event budget: run=${runId} device=${device.id}`);
      throw new DomainError(
        'payload-too-large',
        'This turn has sent more output than this deployment accepts; the run is being stopped.',
      );
    }

    const { accepted } = appended;
    const session = batch.events
      .filter((event): event is Extract<CompanionRunEvent, { type: 'session' }> => {
        return event.type === 'session';
      })
      .at(-1);

    if (session !== undefined && session.data.providerSessionId !== run.providerSessionId) {
      await this.repository.setProviderSession(run.orgId, runId, session.data.providerSessionId);
    }

    return accepted;
  }
}
