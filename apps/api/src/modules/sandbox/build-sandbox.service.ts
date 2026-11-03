import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ProjectTemplate } from '@repo/contracts';
import { posix } from 'node:path';

import type { Environment } from '../../config/environment';
import { DaytonaAdapter, type ExecuteOutcome } from './daytona.adapter';
import { SANDBOX_TIMINGS, type SandboxTimings } from './sandbox.constants';
import { DaytonaError } from './sandbox.errors';
import { TemplateVersions } from './template-versions';

/** The injection token `deploy` asks for (spec 027 R2); bound with `useExisting` in the module. */
export const BUILD_SANDBOX = Symbol('forge.sandbox.build-sandbox');

/** A started build sandbox: its Daytona id, the snapshot it came from, and its work dir. */
export interface BuildSandboxHandle {
  readonly id: string;
  readonly snapshot: string;
  readonly workDir: string;
}

/**
 * `not-published`: the template has no ready, current version to build from. `not-started`: the
 * sandbox errored or did not answer `started` within `readyBudgetMs` (it has been removed).
 * `too-large`: `get` found the file over the caller's cap.
 */
export type BuildSandboxErrorKind = 'not-published' | 'not-started' | 'too-large';

export class BuildSandboxError extends Error {
  constructor(
    readonly kind: BuildSandboxErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'BuildSandboxError';
  }
}

/** What `deploy` sees of a build sandbox: five calls and no Daytona type beyond the outcome. */
export interface BuildSandbox {
  create(template: ProjectTemplate, deploymentId: string): Promise<BuildSandboxHandle>;
  run(handle: BuildSandboxHandle, command: string, timeoutMs: number): Promise<ExecuteOutcome>;
  put(handle: BuildSandboxHandle, path: string, body: Buffer): Promise<void>;
  get(handle: BuildSandboxHandle, path: string, capBytes: number): Promise<Buffer>;
  remove(handle: BuildSandboxHandle): Promise<void>;
}

/** Terminal states a creating sandbox never leaves for `started`. */
const DEAD_STATES: ReadonlySet<string> = new Set([
  'build_failed',
  'destroyed',
  'destroying',
  'error',
]);

/**
 * A row-less build sandbox for a deployment (spec 027, research R2), the `TemplatePublisher`
 * precedent: created straight from the template's current snapshot through `DaytonaAdapter`,
 * labelled `forge.kind: build` so the reconciler reaps an orphan after `orphanGraceMs +
 * buildTimeoutMs` with no new code, and never a `sandboxes` row — which would take the project's
 * one working slot. It is created through the adapter, not the ops consumer, so it receives no
 * callback token and no dev supervisor (FR-022) and nothing but the adapter's `LC_ALL` reaches its
 * environment (SC-012). The commands `run` executes are fixed strings the deploy worker composes,
 * never agent input, so the port's allowlist and shell-operator guard do not apply: the sandbox is
 * the control. Paths are resolved against the work dir; an absolute path is taken as given.
 */
@Injectable()
export class BuildSandboxService implements BuildSandbox {
  private readonly logger = new Logger(BuildSandboxService.name);
  private readonly owner: string;

  constructor(
    private readonly daytona: DaytonaAdapter,
    private readonly versions: TemplateVersions,
    @Inject(SANDBOX_TIMINGS) private readonly timings: SandboxTimings,
    config: ConfigService<Environment, true>,
  ) {
    this.owner = config.get('SANDBOX_OWNER', { infer: true });
  }

  async create(template: ProjectTemplate, deploymentId: string): Promise<BuildSandboxHandle> {
    const version = await this.versions.current(template);
    if (version === null) {
      throw new BuildSandboxError('not-published', `template ${template} has no current version`);
    }

    const dto = await this.daytona.create({
      labels: {
        'forge.deployment': deploymentId,
        'forge.kind': 'build',
        'forge.owner': this.owner,
        'forge.template': template,
      },
      snapshot: version.snapshot,
    });

    try {
      await this.awaitStarted(dto.id);
      const workDir = await this.daytona.workDir(dto.id);
      return { id: dto.id, snapshot: version.snapshot, workDir };
    } catch (error) {
      await this.removeQuietly(dto.id);
      throw error;
    }
  }

  /** A timeout is the outcome (`timedOut: true`), not a throw; the daemon takes whole seconds. */
  run(handle: BuildSandboxHandle, command: string, timeoutMs: number): Promise<ExecuteOutcome> {
    return this.daytona.execute(handle.id, {
      command,
      cwd: handle.workDir,
      timeoutSeconds: Math.max(1, Math.ceil(timeoutMs / 1000)),
    });
  }

  put(handle: BuildSandboxHandle, path: string, body: Buffer): Promise<void> {
    return this.daytona.upload(handle.id, posix.resolve(handle.workDir, path), body);
  }

  /** Stat first so an oversized file is never fetched; the length is re-checked after. */
  async get(handle: BuildSandboxHandle, path: string, capBytes: number): Promise<Buffer> {
    const absPath = posix.resolve(handle.workDir, path);
    const { size } = await this.daytona.info(handle.id, absPath);
    if (size > capBytes) throw this.tooLarge(size, capBytes);

    const bytes = await this.daytona.download(handle.id, absPath);
    if (bytes.length > capBytes) throw this.tooLarge(bytes.length, capBytes);
    return bytes;
  }

  /** Already gone is success; any other failure is the caller's to log (the reconciler backs it). */
  async remove(handle: BuildSandboxHandle): Promise<void> {
    try {
      await this.daytona.remove(handle.id);
    } catch (error) {
      if (error instanceof DaytonaError && error.kind === 'sandbox-not-found') return;
      throw error;
    }
  }

  private async awaitStarted(id: string): Promise<void> {
    const deadline = Date.now() + this.timings.readyBudgetMs;
    for (;;) {
      const { state } = await this.daytona.describe(id);
      if (state === 'started') return;
      if (DEAD_STATES.has(state)) {
        throw new BuildSandboxError('not-started', `build sandbox ${id} is ${state}`);
      }
      if (Date.now() >= deadline) {
        throw new BuildSandboxError('not-started', `build sandbox ${id} did not start in time`);
      }
      await new Promise((resolve) => setTimeout(resolve, this.timings.readyPollMs));
    }
  }

  private tooLarge(size: number, capBytes: number): BuildSandboxError {
    return new BuildSandboxError(
      'too-large',
      `${String(size)} bytes is over the ${String(capBytes)}-byte cap`,
    );
  }

  private async removeQuietly(id: string): Promise<void> {
    try {
      await this.remove({ id, snapshot: '', workDir: '' });
    } catch (error) {
      this.logger.warn(
        `build sandbox ${id} not removed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
