import { loadHostedEnv } from './hosted.ts';
import { log, setLogLevel } from './log.ts';
import { killAllChildrenSync } from './process.ts';
import { runMcpToolServer } from './providers/claude/mcp-tools.ts';
import { createService } from './service.ts';
import { COMPANION_VERSION } from './version.ts';

export const USAGE = `Usage: node runner.mjs <command>

Commands:
  start --hosted [--verbose]   Run inside a BAIOS agent home (env: BAIOS_SERVER_URL,
                               BAIOS_TOKEN_FILE, BAIOS_ALLOW_INSECURE_HTTP=1)
  version                      Print the runner version

BAIOS uploads and starts this runner in each person's private cloud agent home; it is not meant
to be run anywhere else. It only dials out to BAIOS and never listens on the network.
`;

class UsageError extends Error {}

const BOOLEAN_FLAGS = new Set(['help', 'hosted', 'verbose']);

export interface Parsed {
  flags: Set<string>;
  positionals: string[];
}

export function parseArgs(argv: string[]): Parsed {
  const flags = new Set<string>();
  const positionals: string[] = [];
  for (const arg of argv) {
    if (arg === '-h') flags.add('help');
    else if (arg.startsWith('--')) {
      const name = arg.slice(2);
      if (!BOOLEAN_FLAGS.has(name)) throw new UsageError(`Unknown option ${arg}.`);
      flags.add(name);
    } else positionals.push(arg);
  }
  return { flags, positionals };
}

const print = (text: string) => process.stdout.write(`${text}\n`);

/** Spec 041: the runner in a person's agent home. Env only; nothing read from or saved to disk. */
async function start(parsed: Parsed, selfScript: string): Promise<number> {
  // Required so a stray `start` on some other machine never dials BAIOS by accident.
  if (!parsed.flags.has('hosted')) {
    throw new UsageError('start runs only inside a BAIOS agent home: use `start --hosted`.');
  }
  if (parsed.flags.has('verbose')) setLogLevel('debug');
  const env = loadHostedEnv();
  const service = createService({
    allowInsecureHttp: env.allowInsecureHttp,
    selfScript,
    server: env.server,
    token: env.token,
  });
  let signals = 0;
  const onSignal = () => {
    signals += 1;
    if (signals > 1) process.exit(130); // `exit` below kills the CLIs
    log.info('Stopping: interrupting runs and flushing events.');
    service.supervisor.stop();
  };
  // However the runner ends, no CLI it started may outlive it.
  process.on('exit', killAllChildrenSync);
  process.on('uncaughtException', (error) => {
    log.error(`Unexpected error: ${error.stack ?? error.message}`);
    process.exit(1);
  });
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  log.info(`BAIOS runner ${COMPANION_VERSION} connecting to ${env.server}`);
  try {
    if ((await service.run()) === 'stopped') return 0;
    // The platform restarts the runner with a freshly minted token.
    log.error('BAIOS no longer accepts this runner’s device token; exiting.');
    return 1;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

export async function runCli(argv: string[], selfScript: string): Promise<number> {
  if (argv[0] === 'mcp-tools') {
    await runMcpToolServer();
    return 0;
  }
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
      case 'start':
        return await start(parsed, selfScript);
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
