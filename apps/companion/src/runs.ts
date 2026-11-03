import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, readdir, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  CompanionCommand,
  CompanionFailureClass,
  CompanionPolicy,
  LocalAgentAuthMethod,
  LocalAgentPolicy,
  LocalAgentProvider,
} from '@repo/contracts';

import { log } from './log.ts';
import type { ProviderRegistry } from './providers/registry.ts';
import type { RunHandle } from './providers/types.ts';
import type { Uplink } from './uplink.ts';
import { sleep } from './util.ts';

/**
 * Turns run commands into CLI runs (spec 041, sandbox tool mode): each conversation gets its own
 * empty cwd, a resume must name a session that conversation's CLI reported, and the provider must
 * be allowed by the server's policy for the auth method the CLI is signed in with *now*.
 */

export const PROBE_MAX_AGE_MS = 60_000;

const PROVIDER_NAMES: Record<LocalAgentProvider, string> = {
  claude: 'Claude Code',
};
const METHOD_NAMES: Record<LocalAgentAuthMethod, string> = {
  api_key: 'an API key',
  cloud_provider: 'a cloud provider',
  subscription: 'a subscription plan',
  unknown: 'an unrecognised method',
};

/** The runner's own check of the server's policy against the current sign-in (decision 10). */
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

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * Where sandbox cwds live: per user. Windows' and macOS's temp folders are per user; elsewhere
 * /tmp is shared, so the XDG cache.
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
 * A run's cwd: empty and private (0700), and the same for every turn of a conversation, because
 * Claude files sessions by cwd. Nothing is ever written into it; anything found there is cleared
 * rather than shown to the CLI. It does not isolate sessions (`--resume` finds one from any cwd):
 * the session ledger below does.
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
 * The runner's own record of the session ids each conversation's CLI reported in `system/init`,
 * kept outside the (wiped) cwd, in the agent home's home directory.
 */
export function sessionsDir(): string {
  return join(homedir(), '.baios-runner', 'sessions');
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
  /** Runs at once; a further `run.start` is refused rather than queued. */
  maxConcurrentRuns: number;
  policy: () => CompanionPolicy | null;
  providers: ProviderRegistry;
  /** `sessionsDir()` unless given. */
  sessionsDir?: string;
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
          // Not running here (e.g. the runner restarted): end it now rather than let it idle out.
          this.remember(turnKey(runId, turn));
          this.deps.uplink.push(runId, turn, { data: { status: 'interrupted' }, type: 'terminal' });
        }
        return;
      }
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
    const limit = this.deps.maxConcurrentRuns;
    if (this.active.size >= limit) {
      return this.fail(
        runId,
        turn,
        'provider',
        `This agent home is already running ${limit} agent run${limit === 1 ? '' : 's'}, its limit. Try again when one finishes.`,
      );
    }
    const run: ActiveRun = { done: Promise.resolve(), handle: null, interrupted: false, turn };
    this.active.set(runId, run);
    run.done = this.execute(command, run)
      .catch((error: unknown) => {
        log.error(`Run ${runId} failed inside the runner: ${String(error)}`);
        this.fail(runId, turn, 'crash', 'The runner hit an internal error running this.');
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
    const { providers, uplink } = this.deps;
    const { conversationKey, provider, runId, turn } = command;
    const name = PROVIDER_NAMES[provider];

    const sessions = this.deps.sessionsDir ?? sessionsDir();
    const resume = command.resume?.providerSessionId ?? null;
    // `--resume` finds a session from any cwd: only one this conversation was given may continue.
    if (resume !== null && !knownSessions(sessions, conversationKey).includes(resume)) {
      return this.fail(runId, turn, 'provider', 'Unknown conversation session');
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
        status.message ?? `${name} is not signed in. Sign in again from BAIOS.`,
      );
    }
    const verdict = policyVerdict(this.deps.policy(), provider, status.auth.method);
    if (!verdict.allowed) return this.fail(runId, turn, 'policy', verdict.reason ?? 'Not allowed.');

    log.info(`Run ${runId}: starting ${name}.`);
    const handle = providers.adapters[provider].startRun({
      cwd: await sandboxCwd(conversationKey),
      model: command.model,
      prompt: command.prompt,
      resume,
      toolset: command.toolset,
    });
    run.handle = handle;
    if (run.interrupted) handle.interrupt();

    let ended = false;
    try {
      for await (const event of handle.events) {
        if (event.type === 'session') {
          try {
            recordSession(sessions, conversationKey, event.data.providerSessionId);
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
