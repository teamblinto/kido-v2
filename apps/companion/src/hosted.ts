import type { ChildProcess } from 'node:child_process';
import { readFileSync, rmSync, statSync } from 'node:fs';

import {
  type CompanionAuthEvent,
  companionAuthCommandSchema,
  localAgentDeviceTokenSchema,
  SUBSCRIPTION_SIGN_IN_TTL_SECONDS,
  subscriptionSignInUrlSchema,
} from '@repo/contracts';

import { isLoopbackHost, normalizeServerUrl } from './http.ts';
import { log } from './log.ts';
import { killTree, resolveBinary, runCapture, spawnBinary } from './process.ts';
import { isRecord } from './util.ts';

/**
 * Hosted mode (spec 041 design § Architecture, § Runner sign-in protocol): the runner inside a
 * person's agent home. Configured by environment alone, and signs Claude Code in through its own
 * `claude auth login`, relaying the URL up and the person's one-time code down. The code lives in
 * memory only: it is never logged, echoed, or put in a message.
 */

export interface HostedEnv {
  allowInsecureHttp: boolean;
  server: string;
  token: string;
}

export function loadHostedEnv(env: NodeJS.ProcessEnv = process.env): HostedEnv {
  const server = env.BAIOS_SERVER_URL;
  const tokenFile = env.BAIOS_TOKEN_FILE;
  if (!server || !tokenFile) {
    const missing = [!server && 'BAIOS_SERVER_URL', !tokenFile && 'BAIOS_TOKEN_FILE'].filter(
      Boolean,
    );
    throw new Error(`Hosted mode needs ${missing.join(' and ')} in the environment.`);
  }
  const allowInsecureHttp = env.BAIOS_ALLOW_INSECURE_HTTP === '1';
  const normalized = normalizeServerUrl(server, allowInsecureHttp);
  const url = new URL(normalized);
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    log.warn(
      `INSECURE: BAIOS_ALLOW_INSECURE_HTTP=1 sends the device token and sign-in codes unencrypted to ${url.host}. Use it only on a private local stack.`,
    );
  }
  let text: string;
  try {
    text = readFileSync(tokenFile, 'utf8');
    if (process.platform !== 'win32' && (statSync(tokenFile).mode & 0o077) !== 0) {
      log.warn('BAIOS_TOKEN_FILE is readable by other accounts; it should be 0600.');
    }
  } catch {
    throw new Error(`Could not read BAIOS_TOKEN_FILE (${tokenFile}).`);
  }
  // The platform mints a fresh token file per restart; nothing else should find this one.
  try {
    rmSync(tokenFile);
  } catch {
    log.warn('Could not delete BAIOS_TOKEN_FILE after reading it.');
  }
  const token = localAgentDeviceTokenSchema.safeParse(text.trim());
  if (!token.success) throw new Error('BAIOS_TOKEN_FILE does not hold a valid device token.');
  return { allowInsecureHttp, server: normalized, token: token.data };
}

export const SIGN_IN_TIMEOUT_MS = SUBSCRIPTION_SIGN_IN_TTL_SECONDS * 1_000;
const INVALID_CODE = 'Invalid code. Please make sure the full code was copied.';
const FAILED = 'Claude Code could not sign in with that code. Start the sign-in again.';
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** The URL on the CLI's "If the browser didn't open, visit: <url>" line. */
export function findSignInUrl(line: string): string | null {
  return /visit:\s*(https:\/\/\S+)/i.exec(line)?.[1] ?? null;
}

/** Only Anthropic's own sign-in pages are ever shown to the person. */
export function isAllowedSignInUrl(raw: string): boolean {
  try {
    return subscriptionSignInUrlSchema.safeParse(raw).success;
  } catch {
    return false; // the schema's host check can throw on text that is not a URL at all
  }
}

interface Login {
  /** The last result was posted for the last code (or no code has been sent yet). */
  answered: boolean;
  child: ChildProcess;
  /** A code went to stdin: from then on no output line is logged (the CLI may echo it). */
  codeSent: boolean;
  partial: string;
  timer: NodeJS.Timeout;
  urlSent: boolean;
}

export interface SignInDeps {
  /** Config override for the CLI binary. */
  binary?: string;
  post: (event: CompanionAuthEvent) => Promise<void>;
  /** A status report from a fresh `claude auth status`. */
  refreshStatus: () => Promise<void>;
  timeoutMs?: number;
}

/** One `claude auth login` at a time; a new start replaces one in progress. */
export class ClaudeSignIn {
  private readonly deps: SignInDeps;
  private login: Login | null = null;

  constructor(deps: SignInDeps) {
    this.deps = deps;
  }

  /** An `event: auth` frame's data. */
  handle(data: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      raw = undefined;
    }
    const parsed = companionAuthCommandSchema.safeParse(raw);
    if (!parsed.success) {
      // The contract fixes a code's shape before it can reach stdin; the code is never echoed.
      if (isRecord(raw) && raw.type === 'auth.login.code') {
        return this.result(false, 'Invalid code format');
      }
      log.warn('Ignoring an unrecognised sign-in command.');
      return;
    }
    const command = parsed.data;
    log.debug(`sign-in command ${command.type}`);
    switch (command.type) {
      case 'auth.login.start':
        return this.start();
      case 'auth.login.code':
        return this.submit(command.code);
      case 'auth.login.cancel':
        return this.stop();
      case 'auth.logout':
        void this.logout();
        return;
    }
  }

  /** Kills a sign-in in progress, if any, without reporting. */
  stop(): void {
    const login = this.login;
    if (!login) return;
    this.login = null;
    clearTimeout(login.timer);
    void killTree(login.child);
  }

  private start(): void {
    this.stop();
    const binary = resolveBinary('claude', this.deps.binary);
    if (!binary) return this.result(false, 'Claude Code is not installed here.');
    let child: ChildProcess;
    try {
      // BROWSER is a no-op: nobody is at this machine; the URL goes to the person instead.
      child = spawnBinary(binary, ['auth', 'login'], { env: { ...process.env, BROWSER: 'true' } });
    } catch {
      return this.result(false, 'Could not start the Claude Code sign-in.');
    }
    const login: Login = {
      answered: true,
      child,
      codeSent: false,
      partial: '',
      timer: setTimeout(
        () => this.finish(login, false, 'Sign-in timed out'),
        this.deps.timeoutMs ?? SIGN_IN_TIMEOUT_MS,
      ),
      urlSent: false,
    };
    this.login = login;
    for (const stream of [child.stdout, child.stderr]) {
      stream?.setEncoding('utf8');
      stream?.on('data', (chunk: string) => this.output(login, chunk));
    }
    child.stdin?.on('error', () => undefined); // EPIPE once it has exited
    child.once('error', () =>
      this.finish(login, false, 'Could not start the Claude Code sign-in.'),
    );
    child.once('close', (code) => {
      if (login.partial) this.line(login, login.partial);
      if (code === 0) return this.finish(login, true, null);
      this.finish(
        login,
        false,
        login.codeSent ? FAILED : 'The Claude Code sign-in ended before it finished.',
      );
    });
  }

  /** `code` already matched the contract's code shape (trimmed, no whitespace or controls). */
  private submit(code: string): void {
    const login = this.login;
    if (!login?.urlSent) {
      return this.result(false, 'No sign-in is waiting for a code. Start the sign-in again.');
    }
    login.codeSent = true;
    login.answered = false;
    login.child.stdin?.write(`${code}\n`);
  }

  private async logout(): Promise<void> {
    this.stop();
    const binary = resolveBinary('claude', this.deps.binary);
    if (binary) {
      try {
        await runCapture(binary, ['auth', 'logout']);
      } catch (error) {
        log.warn(`claude auth logout failed: ${String(error)}`);
      }
    }
    await this.deps.refreshStatus();
  }

  private output(login: Login, chunk: string): void {
    const lines = (login.partial + chunk).replace(ANSI, '').split(/\r\n|\r|\n/);
    login.partial = (lines.pop() ?? '').slice(-4_000);
    for (const line of lines) this.line(login, line);
  }

  private line(login: Login, line: string): void {
    if (this.login !== login) return;
    if (!login.codeSent) log.debug(`claude auth login: ${line}`);
    if (!login.urlSent) {
      const url = findSignInUrl(line);
      if (url === null) return;
      if (!isAllowedSignInUrl(url)) {
        return this.finish(login, false, 'Claude Code offered an unexpected sign-in address.');
      }
      login.urlSent = true;
      void this.post({ provider: 'claude', type: 'auth.login.url', url });
      return;
    }
    if (login.answered) return;
    if (/Invalid code/i.test(line)) {
      login.answered = true;
      this.result(false, INVALID_CODE);
    } else if (/Login failed/i.test(line)) {
      this.finish(login, false, FAILED);
    }
  }

  /** Ends this login (if it is still the current one) and reports how. */
  private finish(login: Login, ok: boolean, message: string | null): void {
    if (this.login !== login) return;
    this.stop();
    this.result(ok, message);
  }

  private result(ok: boolean, message: string | null): void {
    const sent = this.post({ message, ok, provider: 'claude', type: 'auth.login.result' });
    if (ok) void sent.then(() => this.deps.refreshStatus());
  }

  private post(event: CompanionAuthEvent): Promise<void> {
    return this.deps.post(event).catch((error: unknown) => {
      log.warn(
        `Could not send a sign-in update: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }
}
