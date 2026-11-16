import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { DeploymentFailureReason, ProjectTemplate } from '@repo/contracts';

import { CLOCK, type ClockPort } from '../../common/clock/clock.port';
import { TenantTransactionRunner } from '../../database/tenant-transaction';
import { RepoBundler } from '../checkpoints/repo-bundler';
import { RetryableFailure } from '../outbox/consumer';
import {
  BUILD_SANDBOX,
  type BuildSandbox,
  BuildSandboxError,
  type BuildSandboxHandle,
} from '../sandbox/build-sandbox.service';
import {
  isBuildPublicKey,
  PREVIEW_ENV_SOURCE,
  type PreviewEnvSource,
} from '../sandbox/sandbox.constants';
import type { MutationContext } from '../sandbox/sandbox.port';
import { TemplateCatalogue } from '../sandbox/template-catalogue';
import {
  BUILD_TIMEOUT_MS,
  OUTPUT_MAX_BYTES,
  OUTPUT_MAX_FILES,
  TAR_DOWNLOAD_MAX_BYTES,
} from './deploy.constants';
import { LogBuffer } from './log-tail';
import { readTar, type TarFile, TarRefused } from './tar-reader';

/** Where the bundle lands in the build sandbox: under `.git/`, so no checkout ever sees it (R3). */
export const BUILD_BUNDLE_PATH = '.git/forge-deploy.bundle';

/** The one file the worker downloads (R5). */
export const BUILD_ARCHIVE_PATH = '/tmp/forge-out.tar';

export interface BuildInput {
  readonly orgId: string;
  readonly projectId: string;
  readonly deploymentId: string;
  readonly template: ProjectTemplate;
  /** The checkpoint's commit. */
  readonly gitSha: string;
  /**
   * Spec 047: a run profile's build and install, which replace the template's `build` and `npm ci`.
   * The template still names the build image, whose Node and Python every profile runs on.
   */
  readonly profile?: {
    readonly build: { command: string; output: string };
    readonly install: string | null;
  };
}

/** The failures a build settles on its own; `not-authorised` is go-live's, not the runner's. */
export type BuildFailureReason = Exclude<DeploymentFailureReason, 'not-authorised'>;

/** `log` is the tail for `deployments.log_tail`: scrubbed and within `LOG_TAIL_MAX_BYTES` (`logTail`). */
export type BuildOutcome =
  | {
      readonly kind: 'built';
      readonly files: TarFile[];
      readonly totalBytes: number;
      readonly dropped: number;
      readonly log: string;
    }
  | { readonly kind: 'failed'; readonly reason: BuildFailureReason; readonly log: string };

const SHA = /^[0-9a-f]{40}$/;
/** `build.output` goes into a command string: letters, digits and `._/-` only, no `..`. */
const PLAIN_PATH = /^[\w.][\w./-]*$/;

/** A step's own failure: settle with `reason`, nothing thrown further. */
class StepFailed extends Error {
  constructor(readonly reason: BuildFailureReason) {
    super(reason);
  }
}

/**
 * Bundle → build sandbox → git → npm → tar → download → strict read (spec 027 R3, R5, R15).
 *
 * Every command is a fixed string composed here from validated parts — the checkpoint's sha, the
 * template's manifest `build` (whose `command` the catalogue already refused shell operators in) —
 * never agent input. The whole run is held to `BUILD_TIMEOUT_MS` from its start, and each command
 * gets what is left of it as its exec timeout (FR-010, FR-013). The checkout is forced and cleaned
 * (`-x`) because the snapshot's work dir already holds the template's files and `node_modules`:
 * what is built is the checkpoint's commit and nothing else (FR-008).
 *
 * The outcome is a user-facing failure (`install-failed`, `build-failed`, `no-output`,
 * `output-too-large`, `timeout`) or `platform`; a transient fault is thrown for the consumer to
 * retry — a sandbox that never started becomes a `RetryableFailure`, a Daytona error is thrown as
 * it is. The build sandbox is removed in `finally` on every path; a failed remove is logged and
 * left to the reconciler (`forge.kind: build`), and never replaces the outcome or the error.
 */
@Injectable()
export class BuildRunner {
  private readonly logger = new Logger(BuildRunner.name);

  constructor(
    @Inject(BUILD_SANDBOX) private readonly sandbox: BuildSandbox,
    @Inject(RepoBundler) private readonly bundler: RepoBundler,
    @Inject(TenantTransactionRunner) private readonly transactions: TenantTransactionRunner,
    @Inject(TemplateCatalogue) private readonly catalogue: TemplateCatalogue,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Optional()
    @Inject(PREVIEW_ENV_SOURCE)
    private readonly previewEnv?: PreviewEnvSource,
  ) {}

  async run(input: BuildInput): Promise<BuildOutcome> {
    const deadline = this.clock.now().getTime() + BUILD_TIMEOUT_MS;
    const log = new LogBuffer();

    const build = input.profile?.build ?? this.catalogue.get(input.template).manifest.build;
    if (build === undefined) {
      return failed('platform', log.note(`template ${input.template} declares no build`));
    }
    if (!PLAIN_PATH.test(build.output) || build.output.split('/').includes('..')) {
      return failed('platform', log.note(`refused build output ${JSON.stringify(build.output)}`));
    }
    if (!SHA.test(input.gitSha)) {
      return failed('platform', log.note(`refused git sha ${JSON.stringify(input.gitSha)}`));
    }

    const { orgId, projectId } = input;
    const ctx: MutationContext = { leaseEpoch: 0, operationId: `deploy/${input.deploymentId}` };
    const bundle = await this.transactions.runInTenantScope({ orgId, userId: null }, (tx) =>
      this.bundler.current(tx, { orgId, projectId }, ctx),
    );
    const publicEnv = await this.publicEnv(orgId, projectId);

    let handle: BuildSandboxHandle;
    try {
      handle = await this.sandbox.create(input.template, input.deploymentId);
    } catch (error) {
      if (error instanceof BuildSandboxError && error.kind === 'not-published') {
        return failed('platform', log.note(error.message));
      }
      if (error instanceof BuildSandboxError && error.kind === 'not-started') {
        throw new RetryableFailure('timeout', error);
      }
      throw error;
    }

    try {
      const sha = input.gitSha;
      await this.sandbox.put(handle, BUILD_BUNDLE_PATH, bundle.body);

      // A sha missing from the `--all` bundle is ours, not the user's (R3): every git step is `platform`.
      await this.step(handle, 'git init -q', 'platform', deadline, log);
      await this.step(
        handle,
        `git fetch -q ${BUILD_BUNDLE_PATH} ${sha}`,
        'platform',
        deadline,
        log,
      );
      await this.step(handle, `git checkout -q -f --detach ${sha}`, 'platform', deadline, log);
      await this.step(handle, 'git clean -q -f -d -x', 'platform', deadline, log);
      // A run profile installs its own way (pnpm, yarn, bun…); none means nothing to install.
      const install = input.profile === undefined ? 'npm ci' : input.profile.install;
      if (install !== null) await this.step(handle, install, 'install-failed', deadline, log);
      await this.step(handle, build.command, 'build-failed', deadline, log, publicEnv);
      // A missing output directory makes tar exit non-zero: that is `no-output` (R5).
      await this.step(
        handle,
        `tar -cf ${BUILD_ARCHIVE_PATH} -C ${build.output} .`,
        'no-output',
        deadline,
        log,
      );

      const archive = await this.download(handle, log);
      const contents = readTar(archive, { maxBytes: OUTPUT_MAX_BYTES, maxFiles: OUTPUT_MAX_FILES });
      log.note(
        `read ${String(contents.files.length)} files, ${String(contents.totalBytes)} bytes; ` +
          `dropped ${String(contents.dropped)} links, devices or other non-regular entries`,
      );
      return { ...contents, kind: 'built', log: log.text() };
    } catch (error) {
      if (error instanceof StepFailed) return failed(error.reason, log.text());
      if (error instanceof TarRefused) {
        log.note(`output refused: ${error.message}`);
        return failed(error.reason === 'malformed' ? 'platform' : error.reason, log.text());
      }
      throw error;
    } finally {
      await this.removeQuietly(handle);
    }
  }

  /** One command under what is left of the budget; any failure settles as `reason`. */
  private async step(
    handle: BuildSandboxHandle,
    command: string,
    reason: BuildFailureReason,
    deadline: number,
    log: LogBuffer,
    env?: Readonly<Record<string, string>>,
  ): Promise<void> {
    const remaining = deadline - this.clock.now().getTime();
    if (remaining <= 0) {
      log.note(`build budget spent before \`${command}\``);
      throw new StepFailed('timeout');
    }

    log.note(`$ ${command}`);
    const outcome = await this.sandbox.run(handle, command, remaining, env);
    if (outcome.timedOut) {
      log.note(`\`${command}\` timed out`);
      throw new StepFailed('timeout');
    }
    log.append(outcome.result);
    if (outcome.exitCode !== 0) {
      log.note(`exit ${String(outcome.exitCode)}`);
      throw new StepFailed(reason);
    }
  }

  /**
   * The connector values a bundler inlines into the shipped files (`VITE_*`, `NEXT_PUBLIC_*`: the
   * Supabase URL and publishable key), so a deployed app reaches the same project its preview does.
   * Server secrets never enter a build (SC-012 holds for them); the source never throws.
   */
  private async publicEnv(orgId: string, projectId: string): Promise<Record<string, string>> {
    if (this.previewEnv === undefined) return {};
    const values = await this.transactions.runInTenantTransaction(orgId, (tx) =>
      this.previewEnv!(tx, orgId, projectId),
    );

    return Object.fromEntries(Object.entries(values).filter(([key]) => isBuildPublicKey(key)));
  }

  private async download(handle: BuildSandboxHandle, log: LogBuffer): Promise<Buffer> {
    try {
      return await this.sandbox.get(handle, BUILD_ARCHIVE_PATH, TAR_DOWNLOAD_MAX_BYTES);
    } catch (error) {
      if (error instanceof BuildSandboxError && error.kind === 'too-large') {
        log.note(`output archive refused: ${error.message}`);
        throw new StepFailed('output-too-large');
      }
      throw error;
    }
  }

  private async removeQuietly(handle: BuildSandboxHandle): Promise<void> {
    try {
      await this.sandbox.remove(handle);
    } catch (error) {
      this.logger.warn(
        `build sandbox ${handle.id} not removed, left to the reconciler: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

function failed(reason: BuildFailureReason, log: string): BuildOutcome {
  return { kind: 'failed', log, reason };
}
