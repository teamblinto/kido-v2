import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import { posix } from 'node:path';

import { CLOCK, type ClockPort } from '../../common/clock/clock.port';
import { QUEUE_REDIS } from '../../common/redis/redis.constants';
import type { Environment } from '../../config/environment';
import { DaytonaAdapter } from './daytona.adapter';
import { poolFrontKey, SANDBOX_TIMINGS, type SandboxTimings } from './sandbox.constants';
import {
  type CatalogueTemplate,
  TemplateCatalogue,
  type TemplateDefinition,
} from './template-catalogue';
import { type BeginOutcome, TemplateVersions } from './template-versions';

export type PublishOutcome =
  | { readonly kind: BeginOutcome | 'built' | 'adopted' }
  | { readonly kind: 'failed'; readonly reason: string };

/** A build failure with a reason fit for `failure_reason`; anything else is a fault and propagates. */
class BuildFailure extends Error {}

/** The last 2 KB of an install's output is the failure reason (contract § 3, step 3.3). */
const REASON_TAIL_BYTES = 2048;

/**
 * One template published: reserve → adopt or build → settle (spec 015, research R1/R6, contract
 * § 3). A version is *captured* from a sandbox created from the manifest's base, with the
 * definition's files uploaded and its install run — not built from a Dockerfile, because Daytona's
 * declarative builder is container-only and the public fleet is VM class (ADR 037). It runs
 * synchronously in the operator's command rather than as a queued op: the command is the retry,
 * and `versions.begin` — a primary-key insert plus a conditional update — is the whole lock, so
 * two operators on one digest cost one build. A failed build marks its row and returns; it never
 * touches `current`. The build sandbox is removed on every path.
 *
 * ponytail: `publish` builds one template at a time; the command loops the four sequentially.
 * Four builds in parallel when four × minutes is felt — it is an operator command.
 */
@Injectable()
export class TemplatePublisher {
  private readonly logger = new Logger(TemplatePublisher.name);
  private readonly owner: string;

  constructor(
    private readonly catalogue: TemplateCatalogue,
    private readonly versions: TemplateVersions,
    private readonly daytona: DaytonaAdapter,
    @Inject(QUEUE_REDIS) private readonly queue: Redis,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(SANDBOX_TIMINGS) private readonly timings: SandboxTimings,
    config: ConfigService<Environment, true>,
  ) {
    this.owner = config.get('SANDBOX_OWNER', { infer: true });
  }

  /** `timeout after 15m` at the production bound; seconds below a whole minute (the suites). */
  static timeoutReason(buildTimeoutMs: number): string {
    return buildTimeoutMs % 60_000 === 0
      ? `timeout after ${String(buildTimeoutMs / 60_000)}m`
      : `timeout after ${String(buildTimeoutMs / 1000)}s`;
  }

  /** Never throws for a build failure — the outcome carries the reason. */
  async publish(id: CatalogueTemplate): Promise<PublishOutcome> {
    const def = this.catalogue.get(id);
    const now = this.clock.now();
    const staleBefore = new Date(now.getTime() - this.timings.buildTimeoutMs);

    const begun = await this.versions.begin(def, now, staleBefore);
    if (begun !== 'reserved') {
      if (begun === 'made-current') await this.queue.del(poolFrontKey(id));
      return { kind: begun };
    }

    // FR-009: an image of this name already at the provider is adopted, not rebuilt. A throw here
    // (provider down) is a failure of this publish, not "not found".
    if ((await this.daytona.describeSnapshot(def.snapshot))?.state === 'active') {
      await this.versions.ready(def, now);
      await this.queue.del(poolFrontKey(id));
      return { kind: 'adopted' };
    }

    const signal = AbortSignal.timeout(this.timings.buildTimeoutMs);
    let buildId: string | undefined;
    try {
      await race(
        signal,
        this.build(def, signal, (created) => (buildId = created)),
      );
    } catch (error) {
      const reason = this.reasonOf(error, signal);
      if (reason === undefined) throw error;
      await this.versions.fail(def, reason, now);
      return { kind: 'failed', reason };
    } finally {
      if (buildId !== undefined) await this.removeQuietly(buildId);
    }

    await this.versions.ready(def, now);
    await this.queue.del(poolFrontKey(id));
    return { kind: 'built' };
  }

  /** Steps 3.1–3.5 of contract § 3: create, upload, install, stop, capture. */
  private async build(
    def: TemplateDefinition,
    signal: AbortSignal,
    onCreated: (id: string) => void,
  ): Promise<void> {
    const dto = await this.daytona.create({
      labels: { 'forge.kind': 'build', 'forge.owner': this.owner, 'forge.template': def.id },
      snapshot: def.manifest.base,
    });
    onCreated(dto.id);
    await this.awaitSandbox(dto.id, 'started', signal);

    const root = await this.daytona.workDir(dto.id);
    for (const file of def.files) {
      signal.throwIfAborted();
      await this.daytona.upload(dto.id, posix.join(root, file.path), file.content);
    }

    const install = def.manifest.installInSession
      ? await this.installInSession(dto.id, root, def.manifest.install, signal)
      : await this.daytona.execute(dto.id, {
          command: def.manifest.install,
          cwd: root,
          timeoutSeconds: Math.ceil(this.timings.buildTimeoutMs / 1000),
        });
    if (install.timedOut) throw new BuildFailure('install timed out');
    if (install.exitCode !== 0) throw new BuildFailure(install.result.slice(-REASON_TAIL_BYTES));

    // Stopped first so the captured filesystem is quiescent (Daytona accepts `started` too, R1).
    await this.daytona.stop(dto.id);
    await this.awaitSandbox(dto.id, 'stopped', signal);

    await this.daytona.snapshotSandbox(dto.id, def.snapshot);
    for (;;) {
      await sleep(this.timings.snapshotPollMs, signal);
      // `null` right after the POST is the not-yet window (research R1), so it is polled through.
      const snapshot = await this.daytona.describeSnapshot(def.snapshot);
      if (snapshot?.state === 'active') return;
      if (snapshot?.state === 'error' || snapshot?.state === 'build_failed') {
        throw new BuildFailure(snapshot.errorReason ?? `snapshot ${snapshot.state}`);
      }
    }
  }

  /**
   * Spec 041: an install longer than one HTTP exchange can stay open (Node's fetch gives up on
   * headers after 300 s) runs detached in a daemon session, and is polled for the exit code it
   * leaves behind. The bound is still `signal` (`buildTimeoutMs`).
   */
  private async installInSession(
    id: string,
    root: string,
    command: string,
    signal: AbortSignal,
  ): Promise<{ timedOut: false; exitCode: number; result: string }> {
    const exitFile = '/tmp/forge-install.exit';
    const logFile = '/tmp/forge-install.log';
    await this.daytona.startSession(
      id,
      'forge-install',
      `cd ${root} && (${command}) > ${logFile} 2>&1; echo $? > ${exitFile}`,
    );
    for (;;) {
      await sleep(this.timings.snapshotPollMs, signal);
      const done = await this.daytona.execute(id, {
        command: `test -f ${exitFile} && cat ${exitFile} && tail -c ${String(REASON_TAIL_BYTES)} ${logFile}`,
        cwd: root,
        timeoutSeconds: 30,
      });
      if (done.timedOut || done.exitCode !== 0) continue;
      const newline = done.result.indexOf('\n');
      return {
        exitCode: Number(done.result.slice(0, newline)),
        result: done.result.slice(newline + 1),
        timedOut: false,
      };
    }
  }

  private async awaitSandbox(id: string, state: string, signal: AbortSignal): Promise<void> {
    while ((await this.daytona.describe(id)).state !== state) {
      await sleep(this.timings.readyPollMs, signal);
    }
  }

  /** A `BuildFailure` or the bound's abort is a reason; anything else is not ours to swallow. */
  private reasonOf(error: unknown, signal: AbortSignal): string | undefined {
    if (signal.aborted) return TemplatePublisher.timeoutReason(this.timings.buildTimeoutMs);
    return error instanceof BuildFailure ? error.message : undefined;
  }

  /** Step 3.6: the build sandbox goes on every path; a failure to remove it is logged, not thrown. */
  private async removeQuietly(id: string): Promise<void> {
    try {
      await this.daytona.remove(id);
    } catch (error) {
      this.logger.warn(
        `build sandbox ${id} not removed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/** The bound over the whole sequence: whichever settles first, the build or the abort. */
function race<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true });
    }),
  ]);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason as Error);
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}
