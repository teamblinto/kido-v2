import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  COMPANION_AUTH_SSE_EVENT,
  type CompanionCommand,
  type LocalAgentDeviceKind,
  STREAM_HEARTBEAT,
} from '@repo/contracts';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';

import { CLOCK, type ClockPort } from '../../common/clock/clock.port';
import { DeviceService } from './device.service';
import { keys, LOCAL_AGENT_TIMINGS, type LocalAgentTimings } from './local-agent.constants';
import { LocalAgentStore } from './local-agent.store';

export interface CommandStreamRequest {
  readonly deviceId: string;
  /** Spec 041: a `cloud` device (an agent home's runner) also receives the sign-in commands. */
  readonly kind: LocalAgentDeviceKind;
  /** `Last-Event-ID`, already checked to be a stream id; `undefined` starts after the newest entry. */
  readonly from: string | undefined;
  /** Headers already written. */
  readonly res: ServerResponse;
  readonly signal: AbortSignal;
}

/**
 * The downlink (spec 040 § 3 decision 2): `hello`, then the device's command stream from its
 * `Last-Event-ID`, each frame's `id:` the stream entry id; `:heartbeat` every heartbeat, which
 * also refreshes presence. One connection per device: each holds the presence key under its own
 * id, and one that finds a newer id there has been replaced and closes. `device.revoked` is the
 * last frame a revoked device receives — published on revocation, and written by the heartbeat
 * itself when it finds the device revoked or gone (a missed publish, an account deletion).
 * Detached from the request, as the run stream reader is.
 *
 * Spec 041: a cloud device's connection also subscribes to its sign-in channel and writes each
 * message as an `event: auth` frame with no `id:` — live only, never in the command stream, so
 * the one-time code is neither stored nor replayed.
 */
@Injectable()
export class CommandStream {
  private readonly logger = new Logger(CommandStream.name);

  constructor(
    @Inject(LocalAgentStore) private readonly store: LocalAgentStore,
    @Inject(DeviceService) private readonly devices: DeviceService,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(LOCAL_AGENT_TIMINGS) private readonly timings: LocalAgentTimings,
  ) {}

  async serve(request: CommandStreamRequest): Promise<void> {
    const { deviceId, res, signal } = request;
    const connection = randomUUID();
    // ponytail: one duplicated connection per device — `XREAD BLOCK` monopolises it, as for viewers.
    const client = this.store.duplicate();
    let auth: Redis | undefined;
    const onAbort = () => {
      client.disconnect();
      auth?.disconnect();
    };
    const write = (chunk: string) => {
      if (!signal.aborted) res.write(chunk);
    };

    signal.addEventListener('abort', onAbort, { once: true });

    try {
      // Subscribed before presence is claimed, so a command sent the moment the runner shows
      // online is never published to nobody.
      if (request.kind === 'cloud') {
        auth = this.store.duplicate();
        auth.on('message', (_channel: string, message: string) => {
          write(`event: ${COMPANION_AUTH_SSE_EVENT}
data: ${message}

`);
        });
        await auth.subscribe(keys.auth(deviceId));
      }
      await this.store.claimPresence(deviceId, connection);
      const hello: CompanionCommand = {
        deviceId,
        heartbeatSeconds: Math.round(this.timings.heartbeatMs / 1_000),
        policy: this.devices.policy,
        type: 'hello',
      };
      write(`event: hello\ndata: ${JSON.stringify(hello)}\n\n`);

      let position = request.from ?? (await this.store.lastCommandId(deviceId));
      let beat = this.clock.now().getTime();

      while (!signal.aborted) {
        const reply = await client.xread(
          'COUNT',
          100,
          'BLOCK',
          this.timings.heartbeatMs,
          'STREAMS',
          keys.commands(deviceId),
          position,
        );

        for (const [id, fields] of reply?.[0]?.[1] ?? []) {
          const json = fields[1] ?? '{}';
          const { type } = JSON.parse(json) as CompanionCommand;

          write(`id: ${id}\nevent: ${type}\ndata: ${json}\n\n`);
          position = id;

          if (type === 'device.revoked') return;
        }

        if (this.clock.now().getTime() - beat >= this.timings.heartbeatMs || reply === null) {
          beat = this.clock.now().getTime();
          write(`${STREAM_HEARTBEAT}\n\n`);

          if (!(await this.store.refreshPresence(deviceId, connection))) return;

          // Revoked (or its owner deleted) since this connection opened: say so, and close.
          if (!(await this.devices.isLive(deviceId))) {
            write(`event: device.revoked\ndata: ${JSON.stringify({ type: 'device.revoked' })}\n\n`);
            return;
          }
        }
      }
    } catch (error) {
      if (!signal.aborted) {
        this.logger.debug(
          `command stream for device ${deviceId} ended: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
      client.disconnect();
      auth?.disconnect();
      await this.store.releasePresence(deviceId, connection).catch(() => undefined);
      res.end();
    }
  }
}
