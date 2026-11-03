import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  type CompanionPolicy,
  type CompanionRunEvent,
  type CompanionRunEventBatch,
  type CompanionStatusReport,
  type LocalAgentDeviceList,
  type LocalAgentPlatform,
  localAgentDeviceTokenSchema,
} from '@repo/contracts';
import type { LocalAgentDeviceRow } from '@repo/db';

import { CLOCK, type ClockPort } from '../../common/clock/clock.port';
import { ConflictError, DomainError, NotFoundError } from '../../common/errors/domain-error';
import type { Environment } from '../../config/environment';
import { OutboxWriter } from '../outbox/outbox-writer';
import { LAST_SEEN_EVERY_MS } from './local-agent.constants';
import { LIVE_RUN_STATUSES, LocalAgentRepository } from './local-agent.repository';
import { LocalAgentStore } from './local-agent.store';
import { companionPolicy, withPolicy } from './policy';
import { mintDeviceToken, sha256 } from './secrets';

/** One refusal for an unknown, malformed or revoked token: the companion's remedy is to re-pair. */
export function revoked(): DomainError {
  return new DomainError(
    'local-agent-revoked',
    'This device is not paired, or its pairing was revoked. Pair it again with baios-companion pair.',
  );
}

/**
 * Paired devices (spec 040 § 3 decision 3, § 5): the person's list and revocation, the device
 * token's check, and what the companion posts up. Pairing, revocation and every refused token are
 * account-scope events, so they go to the structured log (§05): the audit trail needs an org.
 * Never a token in a log line — only device and person ids.
 */
@Injectable()
export class DeviceService {
  private readonly logger = new Logger(DeviceService.name);
  readonly policy: CompanionPolicy;

  constructor(
    @Inject(LocalAgentRepository) private readonly repository: LocalAgentRepository,
    @Inject(LocalAgentStore) private readonly store: LocalAgentStore,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(OutboxWriter) private readonly outbox: OutboxWriter,
    @Inject(ConfigService) config: ConfigService<Environment, true>,
  ) {
    this.policy = companionPolicy(
      config.get('LOCAL_AGENT_CODEX_CHATGPT_AUTH', { infer: true }) === 'allow',
    );
  }

  /**
   * Mints the token the companion is handed once; only its digest is kept. The person is mailed
   * that a device was paired, from the insert's transaction (the outbox), so a pairing they did
   * not start does not go unnoticed.
   */
  async create(
    userId: string,
    device: { name: string; platform: LocalAgentPlatform; companionVersion: string },
  ): Promise<{ deviceId: string; deviceToken: string }> {
    const deviceToken = mintDeviceToken();
    const row = await this.repository.create(
      { ...device, tokenHash: sha256(deviceToken), userId },
      (tx, created) =>
        this.outbox
          .append(tx, {
            aggregateId: created.id,
            payload: { deviceId: created.id, recipientUserId: userId },
            type: 'mail.local-agent-paired',
          })
          .then(() => undefined),
    );

    this.logger.log(`local agent paired: user=${userId} device=${row.id}`);

    return { deviceId: row.id, deviceToken };
  }

  async list(userId: string): Promise<LocalAgentDeviceList> {
    const rows = await this.repository.listForUser(userId);
    const devices = await Promise.all(
      rows.map(async (row) => {
        const [online, status] = await Promise.all([
          this.store.online(row.id),
          this.store.status(row.id),
        ]);
        // Recomputed on read too, so a policy change shows before the next report.
        const report = status === undefined ? undefined : withPolicy(status, this.policy);

        return {
          companionVersion: row.companionVersion,
          createdAt: row.createdAt.toISOString(),
          id: row.id,
          lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
          name: row.name,
          online,
          platform: row.platform,
          providers: report?.providers ?? [],
          workspaces: report?.workspaces ?? [],
        };
      }),
    );

    return { devices };
  }

  /**
   * The person's own device only. The open connection is told and closes; every run the device
   * may be executing is aborted through its control stream, so it fails now rather than idling out.
   */
  async revoke(userId: string, deviceId: string): Promise<void> {
    const row = await this.repository.revoke(userId, deviceId, this.clock.now());

    if (row === undefined) {
      throw new NotFoundError('No such device among yours.');
    }

    await this.store.publish(deviceId, { type: 'device.revoked' });
    await this.store.forget(deviceId);

    for (const run of await this.repository.liveRunsOf(deviceId)) {
      await this.store.abortRun(run.runId, 'revoked');
    }

    this.logger.log(`local agent revoked: user=${userId} device=${deviceId}`);
  }

  /** The command stream's per-heartbeat check: the device still exists and is not revoked. */
  async isLive(deviceId: string): Promise<boolean> {
    return (await this.repository.byId(deviceId))?.revokedAt === null;
  }

  /** `DeviceTokenGuard`'s check: by digest, live, and `last_seen_at` at most once a minute. */
  async authenticate(token: string | undefined): Promise<LocalAgentDeviceRow> {
    if (token === undefined || !localAgentDeviceTokenSchema.safeParse(token).success) {
      throw revoked();
    }

    const row = await this.repository.byTokenHash(sha256(token));

    if (row?.revokedAt !== null) {
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

    if (device.kind === 'cloud' && claude !== undefined) {
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
