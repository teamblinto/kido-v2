import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, readdir, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type CompanionCommand,
  type CompanionPolicy,
  type CompanionFailureClass,
  LOCAL_AGENT_PERMISSION_MODES,
  type LocalAgentAuthMethod,
  type LocalAgentPermissionMode,
  type LocalAgentPolicy,
  type LocalAgentProvider,
} from '@repo/contracts';

import { type CompanionConfig, companionHome, isProviderEnabled } from './config.ts';
import { log } from './log.ts';
import type { ProviderRegistry } from './providers/registry.ts';
import type { RunHandle } from './providers/types.ts';
import type { Uplink } from './uplink.ts';
import { sleep } from './util.ts';

/**
 * Turns run commands into CLI runs (spec 040 § 3 decisions 5, 6, 10): the workspace must be one
 * registered here, the mode is clamped to the local ceiling, and the provider must be enabled here
 * and allowed by the server's policy for the auth method the CLI is signed in with *now*.
 */

export const PROBE_MAX_AGE_MS = 60_000;

const PROVIDER_NAMES: Record<LocalAgentProvider, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
};
const METHOD_NAMES: Record<LocalAgentAuthMethod, string> = {
  api_key: 'an API key',
  cloud_provider: 'a cloud provider',
  subscription: 'a subscription plan',
  unknown: 'an unrecognised method',
};

/** The lower of the requested mode and the local ceiling (modes are ordered least → most). */
export function clampPermissionMode(
  requested: LocalAgentPermissionMode,
  ceiling: LocalAgentPermissionMode,
): LocalAgentPermissionMode {
  const rank = (mode: LocalAgentPermissionMode) => LOCAL_AGENT_PERMISSION_MODES.indexOf(mode);
  return rank(requested) <= rank(ceiling) ? requested : ceiling;
}

/** The companion's own check of the server's policy against the current sign-in (decision 10). */
export function policyVerdict(
  policy: CompanionPolicy | null,
  provider: LocalAgentProvider,
  method: LocalAgentAuthMethod | null,
): LocalAgentPolicy {
  const name = PROVIDER_NAMES[provider];
  if (!policy) return { allowed: false, reason: 'BAIOS has not sent its policy yet.' };
  const allowed = policy[provider]?.allowedAuthMethods ?? [];
  if (allowed.length === 0) {
    return { allowed: false, reason: `This BAIOS deployment does not allow ${name}.` };
  }
  if (!method || !allowed.includes(method)) {
    const how = method ? METHOD_NAMES[method] : 'an unknown method';
    return {
      allowed: false,
      reason: `${name} is signed in with ${how}, which this BAIOS deployment does not allow.`,
    };
  }
  return { allowed: true, reason: null };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * Where sandbox cwds live: per user and outside companionHome(), which holds credentials.json.
 * Windows' and macOS's temp folders are per user; elsewhere /tmp is shared, so the XDG cache.
 */
export function sandboxRoot(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32' || platform === 'darwin') return join(tmpdir(), 'baios-sandbox-cwd');
  // An empty value means unset, hence `||`.
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
  return join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'baios', 'sandbox-cwd');
}

/**
 * A sandbox run's cwd: empty and private (0700), and the same for every turn of a conversation,
 * because Claude files sessions by cwd. Nothing is ever written into it; anything found there is
 * cleared rather than shown to the CLI. It does not isolate sessions (`--resume` finds one from
 * any cwd): the session ledger below does.
 */
export async function sandboxCwd(key: string): Promise<string> {
  const root = sandboxRoot();
  const dir = join(root, sha256(key).slice(0, 32));
  const entries = await readdir(dir).catch(() => []);
  if (entries.length > 0) await rm(dir, { force: true, recursive: true });
  await mkdir(dir, { mode: 0o700, recursive: true });
  if (process.platform !== 'win32') await chmod(root, 0o700);
  return dir;
}

/** Session ids kept per conversation. */
export const SESSIONS_KEPT = 50;

/**
 * The companion's own record of the session ids each sandbox conversation's CLI reported in
 * `system/init`, kept outside the (wiped) cwd: hosted, in the container home; else in
 * companionHome().
 */
export function sessionsDir(hosted = false): string {
  return hosted ? join(homedir(), '.baios-runner', 'sessions') : join(companionHome(), 'sessions');
}

/** Unreadable or missing means none, so a resume is refused rather than trusted. */
export function knownSessions(dir: string, key: string): string[] {
  try {
    const ids: unknown = JSON.parse(readFileSync(join(dir, `${sha256(key)}.json`), 'utf8'));
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export function recordSession(dir: string, key: string, id: string): void {
  const ids = [...knownSessions(dir, key).filter((known) => known !== id), id];
  mkdirSync(dir, { mode: 0o700, recursive: true });
  if (process.platform !== 'win32') chmodSync(dir, 0o700);
  writeFileSync(join(dir, `${sha256(key)}.json`), JSON.stringify(ids.slice(-SESSIONS_KEPT)), {
    mode: 0o600,
  });
}

type RunStart = Extract<CompanionCommand, { type: 'run.start' }>;

const turnKey = (runId: string, turn: number) => `${runId}:${String(turn)}`;

interface ActiveRun {
  done: Promise<void>;
  handle: RunHandle | null;
  interrupted: boolean;
  turn: number;
}

export interface RunManagerDeps {
  config: CompanionConfig;
  /** Hosted runner (spec 041): sandbox tool mode only. */
  hosted?: boolean;
  policy: () => CompanionPolicy | null;
  providers: ProviderRegistry;
  uplink: Uplink;
}

const RECENT_LIMIT = 1_000;

export class RunManager {
  private readonly active = new Map<string, ActiveRun>();
  private readonly deps: RunManagerDeps;
  /** Started `runId:turn` keys, so a replayed `run.start` never runs a turn twice. */
  private readonly recent = new Set<string>();

  constructor(deps: RunManagerDeps) {
    this.deps = deps;
  }

  get activeCount(): number {
    return this.active.size;
  }

  handle(command: CompanionCommand): void {
    switch (command.type) {
      case 'run.start':
        return this.start(command);
      case 'run.input':
        this.active.get(command.runId)?.handle?.input(command.message);
        return;
      case 'run.interrupt': {
        const { runId, turn } = command;
        const run = this.active.get(runId);
        if (run) {
          // An interrupt for an earlier turn is stale and must not stop the one now running.
          if (run.turn > turn) return;
          run.interrupted = true;
          run.handle?.interrupt();
        } else if (!this.recent.has(turnKey(runId, turn))) {
          // Not running here (e.g. the companion restarted): end it now rather than let it idle out.
          this.remember(turnKey(runId, turn));
          this.deps.uplink.push(runId, turn, { data: { status: 'interrupted' }, type: 'terminal' });
        }
        return;
      }
      case 'approval.respond':
        this.active
          .get(command.runId)
          ?.handle?.respondApproval(command.requestId, command.decision, command.message);
        return;
      case 'tool.result': {
        const run = this.active.get(command.runId);
        // A result for another turn answers a call that turn's handle no longer holds.
        if (run?.turn !== command.turn) return;
        run.handle?.resolveToolCall(command.callId, {
          isError: !command.ok || command.isError === true,
          output: command.output,
        });
        return;
      }
      default:
        return;
    }
  }

  private start(command: RunStart): void {
    const { runId, turn } = command;
    const key = turnKey(runId, turn);
    if (this.recent.has(key)) {
      log.debug(`Ignoring a repeated run.start for ${runId} turn ${turn}.`);
      return;
    }
    this.remember(key);
    const previous = this.active.get(runId);
    if (previous) {
      // The last turn reported its end and is still shutting its CLI down: this one follows it.
      void previous.done.then(() => this.begin(command));
      return;
    }
    this.begin(command);
  }

  private begin(command: RunStart): void {
    const { runId, turn } = command;
    const limit = this.deps.config.maxConcurrentRuns;
    if (this.active.size >= limit) {
      return this.fail(
        runId,
        turn,
        'provider',
        `This computer is already running ${limit} agent run${limit === 1 ? '' : 's'}, its limit. Try again when one finishes (or raise it with \`baios-companion config set maxConcurrentRuns <n>\`).`,
      );
    }
    const run: ActiveRun = { done: Promise.resolve(), handle: null, interrupted: false, turn };
    this.active.set(runId, run);
    run.done = this.execute(command, run)
      .catch((error: unknown) => {
        log.error(`Run ${runId} failed inside the companion: ${String(error)}`);
        this.fail(runId, turn, 'crash', 'The companion hit an internal error running this.');
      })
      .finally(() => {
        if (this.active.get(runId) === run) this.active.delete(runId);
      });
  }

  private remember(key: string): void {
    this.recent.add(key);
    if (this.recent.size > RECENT_LIMIT) {
      const oldest = this.recent.values().next().value;
      if (oldest !== undefined) this.recent.delete(oldest);
    }
  }

  private fail(
    runId: string,
    turn: number,
    failureClass: CompanionFailureClass,
    message: string,
  ): void {
    log.warn(`Run ${runId} refused (${failureClass}): ${message}`);
    this.deps.uplink.push(runId, turn, {
      data: { failure: { class: failureClass, message }, status: 'failed' },
      type: 'terminal',
    });
  }

  private async execute(command: RunStart, run: ActiveRun): Promise<void> {
    const { config, providers, uplink } = this.deps;
    const { provider, runId, turn } = command;
    const name = PROVIDER_NAMES[provider];

    const sandbox = command.toolMode === 'sandbox';
    if (this.deps.hosted && !sandbox) {
      return this.fail(
        runId,
        turn,
        'workspace',
        'This cloud agent runs only in sandbox tool mode; it has no local workspaces.',
      );
    }
    if (sandbox && !this.deps.hosted && !config.sandboxRuns) {
      return this.fail(
        runId,
        turn,
        'workspace',
        'Sandbox runs are turned off on this computer. Turn them on with `baios-companion config set sandboxRuns true`.',
      );
    }
    // shortcut: without a conversationKey the run id keys the cwd, so a resume across runs misses.
    const conversation = command.conversationKey ?? runId;
    const sessions = sandbox ? sessionsDir(this.deps.hosted) : null;
    const resume = command.resume?.providerSessionId ?? null;
    // `--resume` finds a session from any cwd: only one this conversation was given may continue.
    if (sessions && resume !== null && !knownSessions(sessions, conversation).includes(resume)) {
      return this.fail(runId, turn, 'provider', 'Unknown conversation session');
    }
    const workspace = config.workspaces.find((entry) => entry.id === command.workspaceId);
    if (!sandbox && !workspace) {
      return this.fail(
        runId,
        turn,
        'workspace',
        'That workspace is not registered on this computer (see `baios-companion workspace list`).',
      );
    }
    if (workspace && !isDirectory(workspace.path)) {
      return this.fail(
        runId,
        turn,
        'workspace',
        `The folder for workspace "${workspace.label}" is gone.`,
      );
    }
    if (!isProviderEnabled(config, provider)) {
      return this.fail(runId, turn, 'policy', `${name} is turned off on this computer.`);
    }

    // Re-check the sign-in before every spawn: it may have changed since the last report.
    const status = await providers.probe(provider, PROBE_MAX_AGE_MS);
    if (run.interrupted) {
      uplink.push(runId, turn, { data: { status: 'interrupted' }, type: 'terminal' });
      return;
    }
    if (!status.installed) {
      return this.fail(runId, turn, 'provider', status.message ?? `${name} is not installed.`);
    }
    if (status.auth.status !== 'authenticated') {
      return this.fail(
        runId,
        turn,
        'auth',
        status.message ?? `${name} is not signed in. Run \`baios-companion login ${provider}\`.`,
      );
    }
    const verdict = policyVerdict(this.deps.policy(), provider, status.auth.method);
    if (!verdict.allowed) return this.fail(runId, turn, 'policy', verdict.reason ?? 'Not allowed.');

    const permissionMode = clampPermissionMode(command.permissionMode, config.maxPermissionMode);
    if (permissionMode !== command.permissionMode) {
      log.info(
        `Run ${runId}: ${command.permissionMode} lowered to ${permissionMode} (local ceiling).`,
      );
    }
    const where = workspace ? `"${workspace.label}"` : 'sandbox tool mode';
    log.info(`Run ${runId}: starting ${name} in ${where} (${permissionMode}).`);
    const sandboxDir = sandbox ? await sandboxCwd(conversation) : null;
    const handle = providers.adapters[provider].startRun({
      cwd: sandboxDir ?? workspace?.path ?? '',
      model: command.model,
      permissionMode,
      prompt: command.prompt,
      resume,
      toolset: sandbox ? (command.toolset ?? []) : null,
    });
    run.handle = handle;
    if (run.interrupted) handle.interrupt();

    let ended = false;
    try {
      for await (const event of handle.events) {
        if (sessions && event.type === 'session') {
          try {
            recordSession(sessions, conversation, event.data.providerSessionId);
          } catch (error) {
            // The run goes on; only a later resume of this session is refused.
            log.warn(`Run ${runId}: could not record its session: ${String(error)}`);
          }
        }
        uplink.push(runId, turn, event);
        if (event.type === 'terminal') {
          ended = true;
          log.info(
            `Run ${runId}: ${event.data.status}${event.data.failure ? ` (${event.data.failure.class})` : ''}.`,
          );
        }
      }
    } finally {
      await handle.dispose();
    }
    if (!ended) this.fail(runId, turn, 'crash', `${name} stopped without reporting an outcome.`);
  }

  /** Interrupts every run and waits (up to `timeoutMs`) for them to end. */
  async interruptAll(timeoutMs: number): Promise<void> {
    const runs = [...this.active.values()];
    for (const run of runs) {
      run.interrupted = true;
      run.handle?.interrupt();
    }
    await Promise.race([Promise.all(runs.map((run) => run.done)), sleep(timeoutMs)]);
  }
}
