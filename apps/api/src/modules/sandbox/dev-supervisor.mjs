/**
 * The dev-server supervisor (spec 023, contracts/dev-supervisor.md).
 *
 * This file does not run here. It is uploaded verbatim to `/tmp/forge-devserver.mjs` inside a
 * tenant sandbox on every claim and resume (contracts §1) and launched there with one
 * `node /tmp/forge-devserver.mjs`. That is the whole reason for its shape:
 *
 * - **No dependencies.** `node:` builtins and the global `fetch`, nothing else. There is no install
 *   step inside a sandbox and adding one would be an ask-first change to code running next to a
 *   tenant's files. A `node:` import is the only import this file may ever grow.
 * - **Everything that touches the world is injected.** `supervise` takes its `spawn`, its
 *   `connect`, its `report`, its `timings` and its `signal`, so the unit suite next door proves
 *   every branch of the budget arithmetic in milliseconds against fakes (research R11). The entry
 *   point at the bottom is the only place that builds the real ones.
 * - **Every wait goes through the global `setTimeout`.** `sleep` below rather than
 *   `node:timers/promises`, because fake timers replace the global and do not replace that
 *   module's export — and a suite that waited 31 real seconds on the backoff ladder is a suite
 *   nobody runs.
 *
 * What it does, end to end: claim the sandbox's pidfile (contracts §3), then loop — spawn the dev
 * command, report `starting`, probe the port until it answers or the child dies, report `listening`
 * the first time it answers, and on the child's exit back off `1, 2, 4, 8, 16 s` for five attempts
 * before reporting `failed` and dropping to a five-minute cold retry (data-model §4, research R5).
 * A child that survives `stableResetMs` earns its budget back.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { openSync, readFileSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * @typedef {'starting' | 'listening' | 'failed'} DevServerState
 *
 * @typedef {object} DevServerTimings
 * @property {number} backoffBaseMs
 * @property {number} coldRetryMs
 * @property {number} logCapBytes
 * @property {number} probeIntervalMs
 * @property {number} stableResetMs
 * @property {number} startAttempts
 *
 * @typedef {object} SuperviseOptions
 * @property {string} command The template's `devCommand`, run through a shell.
 * @property {number} port The template's `devPort`, probed on `127.0.0.1`.
 * @property {string} cwd The sandbox's workspace root.
 * @property {DevServerTimings} timings
 * @property {(state: DevServerState) => Promise<void>} report
 * @property {typeof import('node:child_process').spawn} spawn
 * @property {(port: number) => Promise<boolean>} connect
 * @property {AbortSignal} [signal]
 */

/** Where the control plane leaves the token, the URL and the dev settings (contracts §1). */
const CALLBACK_ENV_PATH = '/tmp/forge-callback.env';

/**
 * The project's connector values (spec 030, contracts/preview-env.md § 1): written whole by the
 * control plane at create, claim and resume, and handed to the dev server child only — read again
 * at each (re)launch, so a value removed by an unbind is gone at the next start.
 */
const PROJECT_ENV_PATH = '/tmp/forge-project.env';

/** The child's merged stdout and stderr, and the detached supervisor's own (research R7). */
const LOG_PATH = '/tmp/forge-devserver.log';

/** The running supervisor's own pid. A live pid here refuses a second start (contracts §3). */
const PID_PATH = '/tmp/forge-devserver.pid';

/**
 * The guard that tells the two copies of this file apart. The first copy — the one the launching
 * `execute` runs — re-spawns itself detached and exits 0; the second sees this marker in its
 * inherited env and supervises instead (contracts §2). An env marker rather than an argv flag so
 * that nothing about the command line changes between the two, and so a human running
 * `node /tmp/forge-devserver.mjs` by hand gets the same relaunch the platform gets.
 */
const DETACHED_MARKER = 'FORGE_DEVSERVER_DETACHED';

/** A TCP connect attempt is given one probe interval before it counts as a refusal. */
const CONNECT_TIMEOUT_FACTOR = 2;

/**
 * How long a single report may take before it is abandoned.
 *
 * A report is fire-and-forget by contract (FR-018) — but "forget" still has to happen, and a POST
 * to a broker that has stopped answering would otherwise park the supervisor between the child's
 * exit and its restart. Ten seconds is long enough that a slow network is not mistaken for an
 * outage and short enough that a restart is never visibly delayed by one.
 */
const REPORT_TIMEOUT_MS = 10_000;

/**
 * Supervise the dev server for the life of this sandbox.
 *
 * Returns only when another supervisor already owns the sandbox (contracts §3) or when `signal`
 * aborts — a supervisor that is told to stop stops, and it does not leave its child behind
 * (FR-013). Every other path loops forever, because that is what "keeps running until the sandbox
 * stops" means (FR-006).
 *
 * @param {SuperviseOptions} options
 * @returns {Promise<void>}
 */
export async function supervise(options) {
  const { command, connect, cwd, port, report, signal, spawn, timings } = options;

  // Contracts §3: a live pid in the pidfile means another supervisor owns this sandbox. Return
  // before anything is spawned and before anything is reported — a second supervisor must be
  // indistinguishable from no second supervisor at all.
  if (!claimPidfile()) return;

  /** Spawns charged against the fast budget. Reset by a child that survives `stableResetMs`. */
  let attempt = 0;

  /**
   * Truncate the log if it has outgrown its cap, then report. Both belong to a transition and to
   * nothing else: the log is checked here rather than on a timer because a transition is the only
   * moment this loop is awake and not waiting on something (research R7), and the report is
   * emitted here rather than per probe because `starting` said twice says nothing (FR-019).
   *
   * @param {DevServerState} state
   * @returns {Promise<void>}
   */
  const transition = async (state) => {
    capLog(timings.logCapBytes);
    await sendReport(report, state);
  };

  while (!signal?.aborted) {
    const startedAt = Date.now();

    const child = spawn(command, {
      cwd,
      // `devCommand` is a template's own field — reviewed in this repository, never tenant input —
      // and it is a command line (`npm run dev`), not a binary plus argv. A shell is what runs it.
      shell: true,
      // The detached copy's own stdout and stderr are already the log file (see `relaunchDetached`),
      // so inheriting is what merges the child's output into it. No pipe is created, which is also
      // what keeps the supervisor from having to drain one.
      stdio: 'inherit',
      // Spec 030 contracts/preview-env.md § 4: the project's values on top of this process's own
      // environment, and no `FORGE_*` key from either — the callback token is the supervisor's.
      env: childEnvironment(),
    });

    // Attached before the first `await` below, so a child that dies in the same tick it was
    // spawned — the crash loop this whole budget exists for — is still seen to have died.
    const { isRunning, stopped } = watchChild(child, signal);

    await transition('starting');

    // Probe until the port answers, the child dies, or the sandbox goes away. A refusal proves
    // nothing: a dev server does not bind its port in the tick after it is spawned.
    while (isRunning() && !signal?.aborted) {
      if (await connect(port)) {
        // The first connect of *this* child, and only the first: `break` leaves the loop, so a
        // port that goes on answering is never reported again (FR-014, FR-019).
        await transition('listening');
        break;
      }

      await sleep(timings.probeIntervalMs, signal);
    }

    // Either the child is listening and this waits for it to exit, or it is already gone and this
    // resolves at once. `backoff` is deliberately invisible on the wire, so nothing is reported
    // between here and the next `starting` (data-model §4).
    await stopped;

    if (signal?.aborted) {
      // `kill` on an exited child is a no-op, so this is safe on both paths out of the loop above.
      child.kill();
      return;
    }

    // FR-010: a dev server that ran for a minute is not flapping, whatever it did before that. Its
    // start plainly succeeded, so it is charged nothing and the next five short lives are a whole
    // fresh budget rather than whatever was left of the old one.
    attempt = Date.now() - startedAt >= timings.stableResetMs ? 0 : attempt + 1;

    // 1, 2, 4, 8, 16 s across the five attempts (research R5). A child that had been up for a
    // minute restarts at the base delay rather than at half of it.
    await sleep(timings.backoffBaseMs * 2 ** Math.max(attempt - 1, 0), signal);
    if (signal?.aborted) return;

    if (attempt >= timings.startAttempts) {
      // The fast budget is spent: say so once, then drop to the cold retry, which is the same code
      // path on a five-minute timer and costs no CPU in between (research R5). The budget is
      // handed back so the retry gets a full set of fast attempts of its own.
      await transition('failed');
      await sleep(timings.coldRetryMs, signal);
      attempt = 0;
    }
  }
}

/**
 * The dev server's environment: this process's own plus `/tmp/forge-project.env`, with every
 * `FORGE_*` key dropped from both. A missing or unreadable file is no extra environment.
 *
 * @returns {Record<string, string | undefined>}
 */
function childEnvironment() {
  /** @type {Record<string, string>} */
  let project = {};

  try {
    project = parseEnvFile(readFileSync(PROJECT_ENV_PATH, 'utf8'));
  } catch {
    // No project file: a sandbox with no bindings, or one delivered before spec 030.
  }

  return Object.fromEntries(
    Object.entries({ ...process.env, ...project }).filter(([key]) => !key.startsWith('FORGE_')),
  );
}

/**
 * Claim `/tmp/forge-devserver.pid` for this process (contracts §3).
 *
 * A missing file, an unparseable one, or one naming a dead pid means take ownership and overwrite.
 * A live pid means another supervisor is already on this sandbox. Hibernation destroys the
 * container, so a pidfile that survived into a snapshot always names a dead pid.
 *
 * @returns {boolean} `true` when this process now owns the sandbox.
 */
function claimPidfile() {
  const owner = readPid();
  if (owner !== undefined && isAlive(owner)) return false;

  writeFileSync(PID_PATH, `${process.pid}\n`, 'utf8');

  return true;
}

/**
 * @returns {number | undefined} The pid the file names, or `undefined` if it names none.
 */
function readPid() {
  /** @type {string} */
  let contents;

  try {
    contents = readFileSync(PID_PATH, 'utf8');
  } catch {
    // No pidfile: nobody has owned this sandbox yet, which is the ordinary first start.
    return undefined;
  }

  const pid = Number.parseInt(contents.trim(), 10);

  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * @param {number} pid
 * @returns {boolean}
 */
function isAlive(pid) {
  try {
    // Signal 0 sends nothing; it only asks whether the process exists and is signallable.
    process.kill(pid, 0);

    return true;
  } catch (error) {
    // `ESRCH` is the dead pid this function exists to find. `EPERM` means the process is there and
    // belongs to somebody else — which should not happen inside a sandbox, and is still alive.
    return errorCode(error) === 'EPERM';
  }
}

/**
 * Truncate the log to zero if it has grown past its cap (FR-011, research R7).
 *
 * Truncate rather than rotate: nothing reads this file. `logs.read` is still where spec 010
 * deferred it, and a rotation scheme exists to serve a reader that does not exist. The child holds
 * the fd in append mode, so its next write lands at the new end.
 *
 * @param {number} capBytes
 * @returns {void}
 */
function capLog(capBytes) {
  try {
    if (statSync(LOG_PATH).size > capBytes) truncateSync(LOG_PATH, 0);
  } catch {
    // The log does not exist yet, or went away underneath us. Neither is worth a word — this runs
    // on every transition, and a supervisor that fell over its own log file would be the fault.
  }
}

/**
 * Emit one report, and swallow whatever it does (FR-018).
 *
 * A report that does not arrive changes nothing: it is never retried, it never backs the loop off,
 * and it never stops the child. The real reporter logs its own failures inside the sandbox (see
 * `createReporter`); this is what guarantees the same for any other.
 *
 * @param {(state: DevServerState) => Promise<void>} report
 * @param {DevServerState} state
 * @returns {Promise<void>}
 */
async function sendReport(report, state) {
  try {
    await report(state);
  } catch {
    // Deliberately empty: see above. The dev server outlives its own telemetry.
  }
}

/**
 * Watch a child for its exit, and the sandbox for its disappearance.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {AbortSignal} [signal]
 * @returns {{ isRunning: () => boolean, stopped: Promise<void> }}
 */
function watchChild(child, signal) {
  let running = true;

  // The cast is the JSDoc way to say `new Promise<void>`: with nothing to infer the parameter from
  // — `resolve` is only ever called with no argument — the constructor lands on `Promise<any>`.
  const stopped = /** @type {Promise<void>} */ (
    new Promise((resolve) => {
      const settle = () => {
        child.off('exit', onExit);
        signal?.removeEventListener('abort', settle);
        resolve();
      };
      const onExit = () => {
        running = false;
        settle();
      };

      child.once('exit', onExit);
      signal?.addEventListener('abort', settle, { once: true });
    })
  );

  return { isRunning: () => running, stopped };
}

/**
 * Wait, and stop waiting early when `signal` aborts.
 *
 * Resolves on an abort rather than rejecting: every caller above treats an abort as the ordinary
 * way to end, and a rejection would make each of them say so twice.
 *
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();

      return;
    }

    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);

    signal?.addEventListener('abort', finish, { once: true });
  });
}

/**
 * @param {unknown} error
 * @returns {unknown} The error's `code`, if it has one.
 */
function errorCode(error) {
  return typeof error === 'object' && error !== null && 'code' in error
    ? /** @type {{ code: unknown }} */ (error).code
    : undefined;
}

/**
 * The real `connect`: one TCP connect to `127.0.0.1:<port>`, resolved to a plain boolean.
 *
 * `listening` means listening and nothing more (research R12) — no request is sent, no response is
 * read, and the socket is destroyed the moment it is up. Loopback only: the port is the sandbox's
 * own, and a connect to any other host would be a different assertion entirely.
 *
 * @param {number} port
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
export function tcpConnect(port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    /** @param {boolean} answered */
    const settle = (answered) => {
      socket.destroy();
      resolve(answered);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      settle(true);
    });
    socket.once('timeout', () => {
      settle(false);
    });
    socket.once('error', () => {
      settle(false);
    });
  });
}

/**
 * The real `report`: one POST to the callback URL, carrying 017's unchanged request body
 * (contracts §4).
 *
 * Every failure ends here. A non-2xx, a network error and a timeout are all written to the
 * supervisor's own stderr — which, in the detached copy, is the log file — and dropped. Nothing is
 * retried and nothing is thrown, because the next transition carries the next report and the dev
 * server is not the broker's to stop (FR-018).
 *
 * @param {string} url
 * @param {string} token
 * @param {number} port
 * @param {number} timeoutMs
 * @returns {(state: DevServerState) => Promise<void>}
 */
export function createReporter(url, token, port, timeoutMs) {
  return async (state) => {
    try {
      const response = await fetch(url, {
        body: JSON.stringify({ action: 'preview.status', port, state }),
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        method: 'POST',
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        console.error(`[forge-devserver] ${state} report refused with ${response.status}`);
      }
    } catch (error) {
      console.error(`[forge-devserver] ${state} report failed`, error);
    }
  };
}

/**
 * Parse the dotenv file the control plane wrote. Deliberately not a dotenv library and deliberately
 * not clever: the file is written by one method in `sandbox-ops.consumer.ts`, whole, every time,
 * with values that may not contain a newline (contracts §1). `KEY=value`, first `=` wins, no
 * unquoting, no interpolation, no multi-line.
 *
 * @param {string} contents
 * @returns {Record<string, string>}
 */
export function parseEnvFile(contents) {
  /** @type {Record<string, string>} */
  const parsed = {};

  for (const line of contents.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;

    parsed[trimmed.slice(0, separator)] = trimmed.slice(separator + 1);
  }

  return parsed;
}

/**
 * The six numbers of data-model §5, read off the env file's one-line `FORGE_DEV_TIMINGS`.
 *
 * Every field is taken through `Number` with the documented default behind it. The file is written
 * whole by one method on the control plane and is not tenant input, so this is not validation — it
 * is the fact that a supervisor which divided a probe interval by `undefined` would spin a tenant's
 * CPU forever, against defaults the spec has already committed to.
 *
 * @param {unknown} raw
 * @returns {DevServerTimings}
 */
function toTimings(raw) {
  /** @type {Record<string, unknown>} */
  const fields = typeof raw === 'object' && raw !== null ? raw : {};

  /**
   * @param {string} name
   * @param {number} fallback
   * @returns {number}
   */
  const positive = (name, fallback) => {
    const value = Number(fields[name]);

    return Number.isFinite(value) && value > 0 ? value : fallback;
  };

  return {
    backoffBaseMs: positive('backoffBaseMs', 1_000),
    coldRetryMs: positive('coldRetryMs', 300_000),
    logCapBytes: positive('logCapBytes', 1_048_576),
    probeIntervalMs: positive('probeIntervalMs', 500),
    stableResetMs: positive('stableResetMs', 60_000),
    startAttempts: positive('startAttempts', 5),
  };
}

/**
 * The first copy's whole job: put a detached copy of this same file in its own session, with its
 * output pointed at the log, and get out of the way (contracts §2, research R1).
 *
 * The launching `DaytonaAdapter.execute` returns as soon as this exits, against a process that has
 * no inherited pipe and is in no process group the daemon's timeout will kill. Exit 0 here means
 * *launched* — never *listening*, which only a report ever asserts.
 *
 * @returns {void}
 */
function relaunchDetached() {
  // Appended to, never truncated on open: a restart mid-life should not lose what the last child
  // wrote. `capLog` is the cap that keeps it from growing without bound.
  const logFd = openSync(LOG_PATH, 'a');

  const child = nodeSpawn(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: process.cwd(),
    detached: true,
    env: { ...process.env, [DETACHED_MARKER]: '1' },
    stdio: ['ignore', logFd, logFd],
  });

  child.unref();
}

/**
 * The entry point. Reads the env file, decides which of the two copies it is, and either relaunches
 * or supervises.
 *
 * @returns {Promise<void>}
 */
export async function main() {
  const env = parseEnvFile(readFileSync(CALLBACK_ENV_PATH, 'utf8'));

  const command = env.FORGE_DEV_COMMAND;
  const port = Number(env.FORGE_DEV_PORT);
  const url = env.FORGE_CALLBACK_URL;
  const token = env.FORGE_CALLBACK_TOKEN;
  // A template that declares no dev server has no business running a supervisor, and neither has
  // one with nowhere to report to. The control plane does not launch either; belt and braces,
  // because the cost of being wrong here is a process spinning inside a tenant sandbox forever.
  if (command === undefined || command === '' || !Number.isInteger(port)) return;
  if (url === undefined || url === '' || token === undefined || token === '') return;

  if (process.env[DETACHED_MARKER] !== '1') {
    relaunchDetached();
    return;
  }

  /** @type {unknown} */
  const rawTimings = JSON.parse(env.FORGE_DEV_TIMINGS ?? '{}');
  const timings = toTimings(rawTimings);

  await supervise({
    command,
    connect: (probed) => tcpConnect(probed, timings.probeIntervalMs * CONNECT_TIMEOUT_FACTOR),
    cwd: process.cwd(),
    port,
    report: createReporter(url, token, port, REPORT_TIMEOUT_MS),
    spawn: nodeSpawn,
    timings,
  });
}

// Only when this file *is* the process, never when the suite next door imports it.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
  process.exit(0);
}
