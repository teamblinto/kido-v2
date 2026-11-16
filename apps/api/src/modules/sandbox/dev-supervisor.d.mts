/**
 * The supervisor's contract, for the TypeScript side of the wall (spec 023,
 * contracts/dev-supervisor.md §5).
 *
 * `dev-supervisor.mjs` is plain Node on purpose — it runs inside a tenant sandbox where nothing
 * compiles it — so this workspace's `allowJs: false` leaves its shape undeclared to the suite that
 * imports it. These are the types the contract already specifies, written once here rather than
 * asserted with a cast in every test.
 */

import type { spawn } from 'node:child_process';

export type DevServerState = 'installing' | 'starting' | 'listening' | 'failed';

/** Spec 047: a run profile's install, run before the dev server when its inputs changed. */
export interface InstallStep {
  readonly command: string;
  readonly cwd: string;
  readonly needed: () => boolean;
  readonly done: () => void;
}

/** The six numbers of data-model §5, delivered as the env file's `FORGE_DEV_TIMINGS` line. */
export interface DevServerTimings {
  readonly backoffBaseMs: number;
  readonly coldRetryMs: number;
  readonly logCapBytes: number;
  readonly probeIntervalMs: number;
  readonly stableResetMs: number;
  readonly startAttempts: number;
}

export interface SuperviseOptions {
  readonly command: string;
  readonly connect: (port: number) => Promise<boolean>;
  readonly cwd: string;
  /** Spec 047: set on the child and the install unless the project's own file sets it. */
  readonly env?: Readonly<Record<string, string>>;
  readonly install?: InstallStep;
  readonly port: number;
  readonly report: (state: DevServerState) => Promise<void>;
  readonly signal?: AbortSignal;
  readonly spawn: typeof spawn;
  readonly timings: DevServerTimings;
}

/**
 * Claim the sandbox's pidfile, then spawn, probe, report and restart the dev server for as long as
 * the sandbox lasts (data-model §4).
 *
 * Resolves only when another supervisor already owns the pidfile, or when `signal` aborts — in
 * which case the child is killed on the way out. Every other path loops indefinitely, dropping to
 * a `coldRetryMs` retry once the fast budget is spent.
 *
 * Each spawn reads `/tmp/forge-project.env` afresh and runs the dev server with
 * `{ ...process.env, ...projectEnv }`, every `FORGE_*` key dropped (spec 030,
 * contracts/preview-env.md § 4). The callback file is never forwarded to the child.
 */
export declare function supervise(options: SuperviseOptions): Promise<void>;

/** Spec 047: the files whose bytes decide whether dependencies must be installed again. */
export declare const INSTALL_INPUTS: readonly string[];

/** Spec 047: the install command and every input file's name and bytes, hashed in a fixed order. */
export declare function installFingerprint(
  command: string,
  dirs: readonly string[],
  read: (path: string) => Buffer | undefined,
): string;

/** Spec 047: a run profile's runtime defaults — port, bind address, toolchain PATH. */
export declare function runtimeEnvironment(
  port: number,
  root: string,
  base: Readonly<Record<string, string | undefined>>,
): Record<string, string>;

/** Spec 047: dependency directories in `.git/info/exclude`, so they reach no commit. */
export declare function ensureGitExclude(root: string): void;

/** One TCP connect to `127.0.0.1:<port>`, resolved to a plain boolean. */
export declare function tcpConnect(port: number, timeoutMs: number): Promise<boolean>;

/**
 * The real `report`: `POST <url>` with a bearer token and 017's unchanged `preview.status` body.
 * Never throws and never retries — a failure is written to the log and dropped (FR-018).
 */
export declare function createReporter(
  url: string,
  token: string,
  port: number,
  timeoutMs: number,
): (state: DevServerState) => Promise<void>;

/** `KEY=value` per line, first `=` wins, no unquoting and no interpolation. */
export declare function parseEnvFile(contents: string): Record<string, string>;

/** Reads the env file and either relaunches this file detached or supervises. */
export declare function main(): Promise<void>;
