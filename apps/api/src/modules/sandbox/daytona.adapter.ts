import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { posix } from 'node:path';
import type { ZodType } from 'zod';

import { CLOCK, type ClockPort } from '../../common/clock/clock.port';
import type { Environment } from '../../config/environment';
import {
  executeResultSchema,
  type FileInfo,
  fileInfoSchema,
  fileListSchema,
  type FindMatch,
  findMatchesSchema,
  type DaytonaSandboxDto,
  type DaytonaSnapshotDto,
  type PreviewOrigin,
  previewOriginSchema,
  type SandboxLookup,
  sandboxListSchema,
  sandboxLookupSchema,
  searchFilesSchema,
  snapshotSchema,
  workDirSchema,
} from './daytona.schemas';
import { DAYTONA_TIMINGS, type DaytonaTimings } from './sandbox.constants';
import {
  DaytonaError,
  type DaytonaErrorKind,
  SandboxGuardError,
  type SandboxGuardKind,
} from './sandbox.errors';
import type { MutationContext } from './sandbox.port';

/** #11 — what `POST {api}/sandbox` needs from the caller; the two intervals are the adapter's. */
export interface CreateSandboxInput {
  /** Minutes stopped before Daytona archives it; 0 (the default) leaves it to the platform. */
  readonly autoArchiveInterval?: number;
  readonly labels: Readonly<Record<string, string>>;
  readonly snapshot: string;
}

export type ExecuteOutcome =
  | { readonly timedOut: true }
  | { readonly timedOut: false; readonly exitCode: number; readonly result: string };

/** One toolbox call: the route under `{toolboxProxyUrl}/{id}/`, and how its answer is read. */
interface Call {
  readonly body?: FormData | string;
  readonly ctx?: MutationContext | undefined;
  /** Daemon statuses that are the caller's answer — a guard result — rather than a wire failure. */
  readonly daemon?: Readonly<Partial<Record<number, SandboxGuardKind>>>;
  readonly method: 'DELETE' | 'GET' | 'POST' | 'PUT';
  /** `process/execute` answers a timeout as `408` with no body; nothing else may. */
  readonly ok408?: boolean;
  readonly query?: Readonly<Record<string, string>>;
  readonly route: string;
  /** `requestTimeoutMs` unless set; `process/execute` sets the wall clock plus its margin. */
  readonly timeoutMs?: number;
}

const MESSAGES: Readonly<Record<DaytonaErrorKind, string>> = {
  malformed: 'Daytona answered with a body this version does not understand.',
  'not-configured': 'DAYTONA_API_URL is not set; no sandbox can be reached.',
  'sandbox-not-found': 'Daytona has no sandbox with that id.',
  'sandbox-not-running': 'The Daytona sandbox is not running.',
  'snapshot-busy': 'The Daytona snapshot is in use or already being removed.',
  'snapshot-forbidden':
    'Daytona refused to delete the snapshot: the API key lacks the delete:snapshots permission.',
  unauthorised: 'Daytona refused the API key.',
  unreachable: 'Daytona did not answer.',
  upstream: 'Daytona failed to answer the request.',
};

const GUARD_MESSAGES: Readonly<Partial<Record<SandboxGuardKind, string>>> = {
  'not-a-file': 'The path is not the kind of entry this operation takes.',
  'path-not-found': 'No such path in the sandbox.',
};

/** Bash single quoting, so a path is one word whatever it contains. */
const quote = (argument: string): string => `'${argument.replaceAll("'", String.raw`'\''`)}'`;

/**
 * Daytona v0.190.0 over the platform `fetch` (spec 010, research R1–R3, contracts/daytona-http.md):
 * one `GET {api}/sandbox/{id}` for the state and the proxy base, cached for `lookupTtlMs`, then
 * every daemon call through `{toolboxProxyUrl}/{id}/…` — never the deprecated `/api/toolbox/`.
 * The only file that knows a Daytona URL, header or dto.
 *
 * Every failure is one of the seven `DaytonaError` classes and one `warn` line of fields — the
 * status and the class, never the key, a URL carrying it, a body, file bytes or command output
 * (the mailer's rule: nothing the vendor says comes back out). A daemon `4xx` that answers the
 * caller's question — a missing path, a directory where a file was asked for — is a
 * `SandboxGuardError` and is not logged: it is an outcome, not a failure.
 */
@Injectable()
export class DaytonaAdapter {
  private readonly api: { readonly key: string; readonly url: string } | undefined;
  private readonly cache = new Map<string, { dto: SandboxLookup; expiresAt: number }>();
  private readonly logger = new Logger(DaytonaAdapter.name);

  constructor(
    config: ConfigService<Environment, true>,
    @Inject(DAYTONA_TIMINGS) private readonly timings: DaytonaTimings,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {
    const url = config.get('DAYTONA_API_URL', { infer: true });
    const key = config.get('DAYTONA_API_KEY', { infer: true });

    // The env schema makes these both-or-neither; `not-configured` is the neither.
    this.api = url && key ? { key, url: url.replace(/\/$/, '') } : undefined;
  }

  /** #1 — the dto, from the cache while it is fresh; `state !== 'started'` is refused every time. */
  async lookup(daytonaId: string): Promise<SandboxLookup> {
    const now = this.clock.now().getTime();
    const cached = this.cache.get(daytonaId);
    if (cached !== undefined && cached.expiresAt > now) return cached.dto;

    const dto = await this.describe(daytonaId);
    if (dto.state !== 'started') throw this.fail(daytonaId, 'sandbox-not-running');

    this.cache.set(daytonaId, { dto, expiresAt: now + this.timings.lookupTtlMs });
    return dto;
  }

  /** #10 — the dto in whatever state it is: `creating`, `stopping`, `destroying`… (014 R1). */
  async describe(daytonaId: string): Promise<DaytonaSandboxDto> {
    const response = await this.control(daytonaId, `/sandbox/${encodeURIComponent(daytonaId)}`, {
      method: 'GET',
      route: 'describe',
    });
    return this.parse(daytonaId, response, sandboxLookupSchema);
  }

  /**
   * #11 — answers at once with the dto in `creating`; the caller polls `describe`. Both intervals
   * zero so Daytona's own policy never moves a sandbox the platform accounts for (014 R1; the
   * archive echo is not asserted — Daytona answers `0` with the org maximum).
   */
  async create(input: CreateSandboxInput): Promise<DaytonaSandboxDto> {
    const response = await this.control('new', '/sandbox', {
      body: JSON.stringify({
        autoArchiveInterval: input.autoArchiveInterval ?? 0,
        autoStopInterval: 0,
        labels: input.labels,
        snapshot: input.snapshot,
      }),
      method: 'POST',
      route: 'create',
    });
    return this.parse('new', response, sandboxLookupSchema);
  }

  /** #12 — status only; the dto in the body is not read. */
  async start(daytonaId: string): Promise<void> {
    await this.control(daytonaId, `/sandbox/${encodeURIComponent(daytonaId)}/start`, {
      method: 'POST',
      route: 'start',
    });
    this.cache.delete(daytonaId);
  }

  /** #13 — status only. */
  async stop(daytonaId: string): Promise<void> {
    await this.control(daytonaId, `/sandbox/${encodeURIComponent(daytonaId)}/stop`, {
      method: 'POST',
      route: 'stop',
    });
    this.cache.delete(daytonaId);
  }

  /**
   * #14 — `404` is success (already gone). A `409` ("state change in progress") falls through
   * `kindOf` to `upstream`, which is retryable: the caller polls `describe` until `404`.
   */
  async remove(daytonaId: string): Promise<void> {
    await this.control(
      daytonaId,
      `/sandbox/${encodeURIComponent(daytonaId)}`,
      { method: 'DELETE', query: { force: 'true' }, route: 'remove' },
      [404],
    );
    this.cache.delete(daytonaId);
  }

  /** #15 — a replace, not a merge: send the whole map (014 R2). */
  async setLabels(daytonaId: string, labels: Readonly<Record<string, string>>): Promise<void> {
    await this.control(daytonaId, `/sandbox/${encodeURIComponent(daytonaId)}/labels`, {
      body: JSON.stringify({ labels }),
      method: 'PUT',
      route: 'labels',
    });
    this.cache.delete(daytonaId);
  }

  /** #16 — Daytona filters server-side; every page is followed through `nextCursor` (014 R2). */
  async listByLabels(labels: Readonly<Record<string, string>>): Promise<DaytonaSandboxDto[]> {
    const items: DaytonaSandboxDto[] = [];
    let cursor: string | undefined;
    do {
      const response = await this.control('list', '/sandbox', {
        method: 'GET',
        query: { labels: JSON.stringify(labels), ...(cursor === undefined ? {} : { cursor }) },
        route: 'list',
      });
      const page = await this.parse('list', response, sandboxListSchema);
      items.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return items;
  }

  /**
   * #17 (spec 015, contract § 6) — `POST {api}/sandbox/{id}/snapshot { name }`. Daytona answers the
   * *sandbox* dto in `snapshotting`, not the snapshot's, so the body is ignored; the sandbox may be
   * `started` or `stopped` (research R1 "Landed as").
   */
  async snapshotSandbox(daytonaId: string, name: string): Promise<void> {
    await this.control(daytonaId, `/sandbox/${encodeURIComponent(daytonaId)}/snapshot`, {
      body: JSON.stringify({ name }),
      method: 'POST',
      route: 'snapshot',
    });
    this.cache.delete(daytonaId);
  }

  /**
   * #18 — `GET {api}/snapshots/{name}`; `null` on `404`. On the real stack the snapshot does not
   * exist for ~3 s after `snapshotSandbox` answers `200` (research R1 "Landed as"), so a `null`
   * right after the POST means "not yet", not "gone": the caller (the publisher's poll) tolerates
   * that window before treating `null` as missing. This method does not.
   */
  async describeSnapshot(name: string): Promise<DaytonaSnapshotDto | null> {
    const response = await this.control(
      name,
      `/snapshots/${encodeURIComponent(name)}`,
      { method: 'GET', route: 'snapshot' },
      [404],
    );
    if (response.status === 404) return null;
    return this.parse(name, response, snapshotSchema);
  }

  /**
   * #19 — `DELETE {api}/snapshots/{name}`. `404` is success (already gone); `409` (in use or
   * removing) is `snapshot-busy`, retryable on the next pass; `403` is the key lacking
   * `delete:snapshots` (`infra/daytona/bootstrap.mjs` mints it) — a configuration error, surfaced
   * as `snapshot-forbidden`, never swallowed.
   */
  async removeSnapshot(name: string): Promise<void> {
    await this.control(
      name,
      `/snapshots/${encodeURIComponent(name)}`,
      { method: 'DELETE', route: 'snapshot' },
      [404],
      { 403: 'snapshot-forbidden', 409: 'snapshot-busy' },
    );
  }

  /**
   * #20 (spec 017, contract § 7) — `GET {api}/sandbox/{id}/ports/{port}/signed-preview-url`: the
   * origin the gateway dials for one port and the token it sends with every proxied request. Signed
   * and short-lived (`ttlSeconds` is the route TTL, so a token never outlives the route that carries
   * it), never the sandbox `authToken`. Read-only: no cache, nothing revoked from here.
   */
  async previewOrigin(daytonaId: string, port: number, ttlSeconds: number): Promise<PreviewOrigin> {
    const response = await this.control(
      daytonaId,
      `/sandbox/${encodeURIComponent(daytonaId)}/ports/${String(port)}/signed-preview-url`,
      { method: 'GET', query: { expiresInSeconds: String(ttlSeconds) }, route: 'preview-origin' },
    );
    return this.parse(daytonaId, response, previewOriginSchema);
  }

  /**
   * #21 (spec 041) — Daytona's egress control: `networkAllowList` is comma-separated CIDRs (at
   * most 10, Daytona's rule); `blockAll` cuts every destination.
   */
  async setNetwork(
    daytonaId: string,
    settings: { readonly blockAll: boolean; readonly allowList: readonly string[] },
  ): Promise<void> {
    await this.control(daytonaId, `/sandbox/${encodeURIComponent(daytonaId)}/network-settings`, {
      body: JSON.stringify({
        networkAllowList: settings.allowList.join(','),
        networkBlockAll: settings.blockAll,
      }),
      method: 'POST',
      route: 'network-settings',
    });
  }

  /**
   * #22 (spec 041) — a long-lived process through the daemon's session API: the session is
   * dropped first (which kills whatever it ran; a missing one is fine), re-created, and the command
   * started in it asynchronously. Never the command's output: it is not read back.
   */
  async startSession(daytonaId: string, sessionId: string, command: string): Promise<void> {
    await this.stopSession(daytonaId, sessionId);
    await this.send(daytonaId, {
      body: JSON.stringify({ sessionId }),
      method: 'POST',
      route: 'process/session',
    });
    await this.send(daytonaId, {
      body: JSON.stringify({ command, runAsync: true }),
      method: 'POST',
      route: `process/session/${encodeURIComponent(sessionId)}/exec`,
    });
  }

  /** #23 (spec 041) — deletes the session and kills its processes; already gone is success. */
  async stopSession(daytonaId: string, sessionId: string): Promise<void> {
    try {
      await this.send(daytonaId, {
        daemon: { 404: 'path-not-found' },
        method: 'DELETE',
        route: `process/session/${encodeURIComponent(sessionId)}`,
      });
    } catch (error) {
      if (!(error instanceof SandboxGuardError)) throw error;
    }
  }

  /** #2 */
  async workDir(daytonaId: string, ctx?: MutationContext): Promise<string> {
    const response = await this.send(daytonaId, { ctx, method: 'GET', route: 'work-dir' });
    return (await this.parse(daytonaId, response, workDirSchema)).dir;
  }

  /** #3 — direct children, `stat`ed through links (research R2), so no link flag. */
  async list(daytonaId: string, absPath: string, ctx?: MutationContext): Promise<FileInfo[]> {
    const response = await this.send(daytonaId, {
      ctx,
      daemon: { 400: 'not-a-file', 404: 'path-not-found' },
      method: 'GET',
      query: { path: absPath },
      route: 'files',
    });
    return this.parse(daytonaId, response, fileListSchema);
  }

  /** #4 */
  async info(daytonaId: string, absPath: string, ctx?: MutationContext): Promise<FileInfo> {
    const response = await this.send(daytonaId, {
      ctx,
      daemon: { 404: 'path-not-found' },
      method: 'GET',
      query: { path: absPath },
      route: 'files/info',
    });
    return this.parse(daytonaId, response, fileInfoSchema);
  }

  /** #5 — the bytes. */
  async download(daytonaId: string, absPath: string, ctx?: MutationContext): Promise<Buffer> {
    const response = await this.send(daytonaId, {
      ctx,
      daemon: { 400: 'not-a-file', 404: 'path-not-found' },
      method: 'GET',
      query: { path: absPath },
      route: 'files/download',
    });
    return Buffer.from(await response.arrayBuffer());
  }

  /** #6 — multipart field `file`; Node's `fetch` writes the boundary and the content type. */
  async upload(
    daytonaId: string,
    absPath: string,
    content: Buffer,
    ctx?: MutationContext,
  ): Promise<void> {
    const body = new FormData();
    body.set('file', new Blob([new Uint8Array(content)]), posix.basename(absPath));
    await this.send(daytonaId, {
      body,
      ctx,
      method: 'POST',
      query: { path: absPath },
      route: 'files/upload',
    });
  }

  /** #7 — Daytona's `find` is a substring *content* search (research R2). */
  async find(
    daytonaId: string,
    absPath: string,
    pattern: string,
    ctx?: MutationContext,
  ): Promise<FindMatch[]> {
    const response = await this.send(daytonaId, {
      ctx,
      daemon: { 404: 'path-not-found' },
      method: 'GET',
      query: { path: absPath, pattern },
      route: 'files/find',
    });
    return this.parse(daytonaId, response, findMatchesSchema);
  }

  /** #8 — Daytona's `search` is a base-name glob. */
  async search(
    daytonaId: string,
    absPath: string,
    glob: string,
    ctx?: MutationContext,
  ): Promise<string[]> {
    const response = await this.send(daytonaId, {
      ctx,
      daemon: { 404: 'path-not-found' },
      method: 'GET',
      query: { path: absPath, pattern: glob },
      route: 'files/search',
    });
    return (await this.parse(daytonaId, response, searchFilesSchema)).files;
  }

  /**
   * #9 — bash reads the command from stdin, stdout and stderr come back as one `result`, and the
   * daemon's own `timeout` kills the process group and answers `408` with nothing (research R5).
   * The fetch abort sits `execAbortMarginMs` past that, so a dead proxy cannot hold the caller.
   */
  async execute(
    daytonaId: string,
    request: { readonly command: string; readonly cwd: string; readonly timeoutSeconds: number },
    ctx?: MutationContext,
  ): Promise<ExecuteOutcome> {
    const response = await this.send(daytonaId, {
      body: JSON.stringify({
        command: request.command,
        cwd: request.cwd,
        envs: { LC_ALL: 'C' },
        timeout: request.timeoutSeconds,
      }),
      ctx,
      method: 'POST',
      ok408: true,
      route: 'process/execute',
      timeoutMs: request.timeoutSeconds * 1000 + this.timings.execAbortMarginMs,
    });
    if (response.status === 408) return { timedOut: true };

    const { exitCode, result } = await this.parse(daytonaId, response, executeResultSchema);
    return { exitCode, result, timedOut: false };
  }

  /**
   * The path jail's re-check (research R4): `realpath -e` through the daemon is the only way to see
   * through a link on a remote filesystem. `undefined` when the path does not exist. The adapter's
   * own command, not subject to the allowlist, carried with the caller's context when there is one.
   */
  async realpath(
    daytonaId: string,
    absPath: string,
    ctx?: MutationContext,
  ): Promise<string | undefined> {
    const outcome = await this.resolve(daytonaId, `realpath -e -- ${quote(absPath)}`, ctx);
    return outcome.exitCode === 0 ? outcome.result.trim() : undefined;
  }

  /**
   * One `realpath -m` for a whole listing, so `list` costs two requests however long the directory
   * is. `-m` answers one line per argument and no error — a dangling link resolves to where it
   * points — which is what keeps the lines positional. ponytail: the arguments ride in one bash
   * command line; a directory of tens of thousands of entries would need batching.
   */
  async realpaths(
    daytonaId: string,
    absPaths: readonly string[],
    ctx?: MutationContext,
  ): Promise<string[]> {
    if (absPaths.length === 0) return [];

    const outcome = await this.resolve(
      daytonaId,
      `realpath -m -- ${absPaths.map(quote).join(' ')}`,
      ctx,
    );
    const lines = outcome.result.split('\n').filter((line) => line !== '');
    if (outcome.exitCode !== 0 || lines.length !== absPaths.length) {
      throw this.fail(daytonaId, 'malformed', undefined, ctx);
    }
    return lines;
  }

  private async resolve(
    daytonaId: string,
    command: string,
    ctx: MutationContext | undefined,
  ): Promise<{ exitCode: number; result: string }> {
    const outcome = await this.execute(
      daytonaId,
      { command, cwd: '/', timeoutSeconds: this.timings.requestTimeoutMs / 1000 },
      ctx,
    );
    // A sandbox that cannot resolve a path in ten seconds is not one to keep talking to.
    if (outcome.timedOut) throw this.fail(daytonaId, 'upstream', 408, ctx);
    return outcome;
  }

  /**
   * A toolbox call through the proxy. A `401`/`404` from the proxy is first read as a stale cached
   * base — the lookup is dropped and the call made once more — and only then as the class it names.
   * A route's own `daemon` statuses win over that: a `404` from `files/info` is a missing path, and
   * a sandbox that vanished mid-call surfaces on the next call without a mapping.
   */
  private async send(daytonaId: string, call: Call, retried = false): Promise<Response> {
    const lookup = await this.lookup(daytonaId);
    const url = new URL(`${lookup.toolboxProxyUrl}/${encodeURIComponent(daytonaId)}/${call.route}`);
    for (const [key, value] of Object.entries(call.query ?? {})) url.searchParams.set(key, value);

    const response = await this.fetch(daytonaId, url, call);
    if (response.ok || (call.ok408 === true && response.status === 408)) return response;

    const guard = call.daemon?.[response.status];
    if (guard !== undefined) {
      throw new SandboxGuardError(guard, GUARD_MESSAGES[guard] ?? MESSAGES.upstream);
    }
    if (!retried && (response.status === 401 || response.status === 404)) {
      this.cache.delete(daytonaId);
      return this.send(daytonaId, call, true);
    }

    throw this.fail(daytonaId, kindOf(response.status), response.status, call.ctx);
  }

  /**
   * A control-plane call under `{api}`: no proxy, no cache, no daemon mapping. `okStatuses` names a
   * non-2xx that is the caller's answer (`remove`'s `404`); `kinds` names a status whose class is
   * the route's own rather than `kindOf`'s; every other failure is its class.
   */
  private async control(
    daytonaId: string,
    path: string,
    call: Call,
    okStatuses: readonly number[] = [],
    kinds: Readonly<Partial<Record<number, DaytonaErrorKind>>> = {},
  ): Promise<Response> {
    if (this.api === undefined) throw this.fail(daytonaId, 'not-configured');

    const url = new URL(`${this.api.url}${path}`);
    for (const [key, value] of Object.entries(call.query ?? {})) url.searchParams.set(key, value);

    const response = await this.fetch(daytonaId, url, call);
    if (response.ok || okStatuses.includes(response.status)) return response;
    throw this.fail(daytonaId, kinds[response.status] ?? kindOf(response.status), response.status);
  }

  /** The one place a request is built: the headers, the abort, and the transport-failure arm. */
  private async fetch(daytonaId: string, url: URL, call: Call): Promise<Response> {
    const headers: Record<string, string> = {
      // A bearer credential in a query string is written to every proxy access log in between.
      authorization: `Bearer ${this.api!.key}`,
    };
    if (call.route !== 'files/download') headers.accept = 'application/json';
    if (typeof call.body === 'string') headers['content-type'] = 'application/json';
    if (call.ctx !== undefined) {
      headers['x-forge-operation-id'] = call.ctx.operationId;
      headers['x-forge-lease-epoch'] = String(call.ctx.leaseEpoch);
    }

    try {
      return await globalThis.fetch(url, {
        body: call.body,
        headers,
        method: call.method,
        signal: AbortSignal.timeout(call.timeoutMs ?? this.timings.requestTimeoutMs),
      });
    } catch {
      // Not inspected and not re-stated: a `fetch` rejection quotes the URL and the resolved address.
      throw this.fail(daytonaId, 'unreachable', undefined, call.ctx);
    }
  }

  private async parse<T>(
    daytonaId: string,
    response: Response,
    schema: ZodType<T>,
    ctx?: MutationContext,
  ): Promise<T> {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw this.fail(daytonaId, 'malformed', response.status, ctx);
    }

    const parsed = schema.safeParse(body);
    if (!parsed.success) throw this.fail(daytonaId, 'malformed', response.status, ctx);
    return parsed.data;
  }

  /** One `warn` of fields per failure, then the typed error. Built from fields, never from a body. */
  private fail(
    daytonaId: string,
    kind: DaytonaErrorKind,
    status?: number,
    ctx?: MutationContext,
  ): DaytonaError {
    this.logger.warn(
      `daytona call failed: daytonaId=${daytonaId} operationId=${ctx?.operationId ?? 'none'} ` +
        `leaseEpoch=${ctx === undefined ? 'none' : String(ctx.leaseEpoch)} ` +
        `status=${status === undefined ? 'none' : String(status)} kind=${kind}`,
    );

    return new DaytonaError(kind, MESSAGES[kind], status);
  }
}

/**
 * Status → class (research R3). Anything not named — a `400` from a route with no daemon mapping,
 * a `429` — is `upstream`: an answer this version cannot act on, from the other side.
 */
function kindOf(status: number): DaytonaErrorKind {
  if (status === 401 || status === 403) return 'unauthorised';
  if (status === 404) return 'sandbox-not-found';
  return 'upstream';
}
