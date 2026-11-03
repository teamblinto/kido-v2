import {
  LOCAL_AGENT_PROVIDERS,
  type LocalAgentProvider,
  localAgentProviderSchema,
} from '@repo/contracts';

import {
  addWorkspace,
  ConfigStore,
  hostedConfig,
  isProviderEnabled,
  removeWorkspace,
  setConfigValue,
} from './config.ts';
import { loadHostedEnv } from './hosted.ts';
import { REVOKED_MESSAGE } from './http.ts';
import { log, setLogLevel } from './log.ts';
import { pair } from './pairing.ts';
import { killAllChildrenSync, resolveBinary, spawnBinary } from './process.ts';
import { runMcpApprovalServer } from './providers/claude/mcp-approval.ts';
import { ProviderRegistry } from './providers/registry.ts';
import { createService, type Service } from './service.ts';
import { COMPANION_VERSION } from './version.ts';

/** Spec 040 § 3, residual risks: what the local limits do not cover. */
export const TRUST_NOTE = `Run the companion only while you trust your BAIOS organisation, and register only the
folders you want agents to work in. Agents can read files outside those folders: Codex runs
read-only commands (cat, rg, …) anywhere without asking, and Claude Code may ask to.`;

export const USAGE = `Usage: baios-companion <command>

Commands:
  pair --server <url> [--name <name>]   Pair this computer with your BAIOS account
  start [--verbose]                     Connect and run agent work for BAIOS
  start --hosted                        BAIOS's own cloud runner (env: BAIOS_SERVER_URL,
                                        BAIOS_TOKEN_FILE, BAIOS_ALLOW_INSECURE_HTTP=1)
  status                                Show the pairing, CLIs and workspaces
  login <claude|codex> [--device-auth]  Sign in to a CLI with its own login command
  workspace add <path> [--label <label>]
  workspace remove <id>
  workspace list
  config set <key> <value>              maxPermissionMode <plan|default|acceptEdits>,
                                        maxConcurrentRuns <1-16>, sandboxRuns <true|false>,
                                        <claude|codex>.enabled <true|false>,
                                        <claude|codex>.binary <path>, claude.settingSources <list>
  unpair                                Forget this computer's pairing
  version                               Print the companion version

The companion only dials out to BAIOS; it never listens on the network. Your CLI's own
sign-in stays with the CLI. Set BAIOS_COMPANION_HOME to use a different config folder.

${TRUST_NOTE}
`;

class UsageError extends Error {}

interface Parsed {
  flags: Map<string, string | true>;
  positionals: string[];
}

const VALUE_FLAGS = new Set(['label', 'name', 'server']);
const BOOLEAN_FLAGS = new Set(['device-auth', 'help', 'hosted', 'verbose']);

export function parseArgs(argv: string[]): Parsed {
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '-h') {
      flags.set('help', true);
    } else if (arg.startsWith('--')) {
      const [name = '', inline] = arg.slice(2).split(/=(.*)/s, 2);
      if (VALUE_FLAGS.has(name)) {
        const value = inline ?? argv[++i];
        if (value === undefined || value === '') throw new UsageError(`--${name} needs a value.`);
        flags.set(name, value);
      } else if (BOOLEAN_FLAGS.has(name) && inline === undefined) {
        flags.set(name, true);
      } else {
        throw new UsageError(`Unknown option --${name}.`);
      }
    } else {
      positionals.push(arg);
    }
  }
  return { flags, positionals };
}

const flag = (parsed: Parsed, name: string) => {
  const value = parsed.flags.get(name);
  return typeof value === 'string' ? value : undefined;
};

const print = (text: string) => process.stdout.write(`${text}\n`);

function parseProvider(value: string | undefined): LocalAgentProvider {
  const parsed = localAgentProviderSchema.safeParse(value);
  if (!parsed.success)
    throw new UsageError(`Expected one of: ${LOCAL_AGENT_PROVIDERS.join(', ')}.`);
  return parsed.data;
}

async function status(store: ConfigStore, selfScript: string): Promise<number> {
  const config = store.load();
  const paired = Boolean(config.server && store.loadToken());
  print(`BAIOS companion ${COMPANION_VERSION}`);
  print(`Config folder:       ${store.home}`);
  print(`Server:              ${config.server ?? '(not paired)'}`);
  print(
    `Device:              ${paired ? config.deviceId : '(not paired — run `baios-companion pair --server <url>`)'}`,
  );
  print(`Max permission mode: ${config.maxPermissionMode}`);
  print(`Max concurrent runs: ${config.maxConcurrentRuns}`);
  print('Workspaces:');
  if (config.workspaces.length === 0)
    print('  (none — run `baios-companion workspace add <path>`)');
  for (const workspace of config.workspaces) {
    print(`  ${workspace.id}  ${workspace.label}  ${workspace.path}`);
  }
  print('CLIs:');
  const statuses = await new ProviderRegistry(config, selfScript).probeAll();
  for (const found of statuses) {
    const parts = [
      found.installed ? `installed ${found.version ?? '(version unknown)'}` : 'not installed',
    ];
    if (found.installed) {
      const { method, plan, status: state } = found.auth;
      const how = [method, plan].filter(Boolean).join(', ');
      parts.push(
        state === 'authenticated'
          ? `signed in${how ? ` (${how})` : ''}`
          : state === 'unauthenticated'
            ? 'not signed in'
            : 'sign-in unknown',
      );
    }
    if (!isProviderEnabled(config, found.provider)) parts.push('turned off here');
    print(`  ${found.provider.padEnd(7)} ${parts.join(', ')}`);
    if (found.message) print(`          ${found.message}`);
  }
  print(`\n${TRUST_NOTE}`);
  return 0;
}

async function login(parsed: Parsed, store: ConfigStore): Promise<number> {
  const provider = parseProvider(parsed.positionals[1]);
  const binary = resolveBinary(provider, store.load().providers[provider].binary);
  if (!binary) {
    print(`${provider} is not installed (or not on PATH).`);
    return 1;
  }
  const headless =
    process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
  const args =
    provider === 'claude'
      ? ['auth', 'login']
      : ['login', ...(parsed.flags.has('device-auth') || headless ? ['--device-auth'] : [])];
  // The official login, in this terminal: BAIOS never sees what is typed or returned.
  const child = spawnBinary(binary, args, { group: false, stdio: 'inherit' });
  return new Promise((resolve) => {
    child.once('error', (error) => {
      print(`Could not start ${provider}: ${error.message}`);
      resolve(1);
    });
    child.once('exit', (code) => resolve(code ?? 1));
  });
}

function workspace(parsed: Parsed, store: ConfigStore): number {
  const [, action, target] = parsed.positionals;
  const config = store.load();
  if (action === 'list') {
    if (config.workspaces.length === 0) print('No workspaces registered.');
    for (const entry of config.workspaces) print(`${entry.id}  ${entry.label}  ${entry.path}`);
    return 0;
  }
  if (action === 'add' && target) {
    const entry = addWorkspace(config, target, flag(parsed, 'label'));
    store.save(config);
    print(`Workspace ${entry.id} "${entry.label}" → ${entry.path}`);
    return 0;
  }
  if (action === 'remove' && target) {
    if (!removeWorkspace(config, target)) {
      print(`No workspace with id ${target}.`);
      return 1;
    }
    store.save(config);
    print(`Removed workspace ${target}.`);
    return 0;
  }
  throw new UsageError('workspace add <path> [--label <label>] | remove <id> | list');
}

/** Spec 041: the runner in a person's agent home. Env only; nothing read from or saved to disk. */
function hostedService(selfScript: string): { server: string; service: Service } {
  const env = loadHostedEnv();
  const service = createService({
    allowInsecureHttp: env.allowInsecureHttp,
    config: hostedConfig(env.server),
    hosted: true,
    selfScript,
    token: env.token,
  });
  return { server: env.server, service };
}

async function start(parsed: Parsed, store: ConfigStore, selfScript: string): Promise<number> {
  if (parsed.flags.has('verbose')) setLogLevel('debug');
  const hosted = parsed.flags.has('hosted');
  let service: Service;
  let server: string;
  if (hosted) {
    ({ server, service } = hostedService(selfScript));
  } else {
    const config = store.load();
    const token = store.loadToken();
    if (!config.server || !token) {
      print('This computer is not paired. Run `baios-companion pair --server <url>` first.');
      return 1;
    }
    if (config.workspaces.length === 0) {
      log.warn(
        'No workspaces registered; runs will be refused. Add one with `workspace add <path>`.',
      );
    }
    server = config.server;
    service = createService({ config, selfScript, token });
  }
  let signals = 0;
  const onSignal = () => {
    signals += 1;
    if (signals > 1) process.exit(130); // `exit` below kills the CLIs
    log.info('Stopping: interrupting runs and flushing events (Ctrl+C again to quit now).');
    service.supervisor.stop();
  };
  // However the companion ends, no CLI it started may outlive it.
  process.on('exit', killAllChildrenSync);
  process.on('uncaughtException', (error) => {
    log.error(`Unexpected error: ${error.stack ?? error.message}`);
    process.exit(1);
  });
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  log.info(`BAIOS companion ${COMPANION_VERSION} connecting to ${server}`);
  try {
    const outcome = await service.run();
    if (outcome === 'stopped') return 0;
    if (hosted) {
      // The platform restarts the runner with a freshly minted token.
      log.error('BAIOS no longer accepts this runner’s device token; exiting.');
      return 1;
    }
    if (outcome === 'revoked') {
      store.clearToken();
      store.save({ ...store.load(), deviceId: null });
    }
    log.error(REVOKED_MESSAGE);
    return 1;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

export async function runCli(argv: string[], selfScript: string): Promise<number> {
  if (argv[0] === 'mcp-approval') {
    await runMcpApprovalServer();
    return 0;
  }
  const store = new ConfigStore();
  try {
    const parsed = parseArgs(argv);
    const command = parsed.positionals[0];
    if (!command || command === 'help' || parsed.flags.has('help')) {
      print(USAGE);
      return 0;
    }
    switch (command) {
      case 'version':
        print(COMPANION_VERSION);
        return 0;
      case 'pair': {
        const server = flag(parsed, 'server');
        if (!server) throw new UsageError('pair needs --server <url>.');
        await pair({ name: flag(parsed, 'name'), print, server, store });
        print('Paired. Run `baios-companion start` to connect.');
        return 0;
      }
      case 'start':
        return await start(parsed, store, selfScript);
      case 'status':
        return await status(store, selfScript);
      case 'login':
        return await login(parsed, store);
      case 'workspace':
        return workspace(parsed, store);
      case 'config': {
        const [, action, key, value] = parsed.positionals;
        if (action !== 'set' || !key || value === undefined) {
          throw new UsageError('config set <key> <value>');
        }
        const config = store.load();
        setConfigValue(config, key, value);
        store.save(config);
        print(`${key} updated.`);
        return 0;
      }
      case 'unpair': {
        const config = store.load();
        store.clearToken();
        store.save({ ...config, deviceId: null, server: null });
        print('Unpaired. Also remove this computer under Settings → Local agents in BAIOS.');
        return 0;
      }
      default:
        throw new UsageError(`Unknown command ${command}.`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    log.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
