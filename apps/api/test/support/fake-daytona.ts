import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { posix as path } from 'node:path';

/**
 * A Daytona v0.190.0 that fits in one process (spec 010, research R8): the API on `/api/*` and the
 * toolbox proxy on `/toolbox/:id/*`, both served from one `node:http` listener on a loopback port.
 * The sandbox dto it answers carries `toolboxProxyUrl` pointing back at itself, so the adapter's
 * lookup → proxy hop is the real code path over the real `fetch`, real multipart and real URLs.
 *
 * The filesystem is a `Map` of absolute paths, links included; `realpath -e -- <p>` is interpreted
 * against it inside `process/execute` so the path jail's re-check (R4) is exercised for real.
 * Every other command is scripted per test through `onExecute`. Every request — including the
 * deprecated `/api/toolbox/*` prefix, which answers `599` so a wrong adapter fails loudly — lands
 * in `requests` for the specs to assert on.
 */
export interface FakeRequest {
  readonly body: string;
  readonly headers: IncomingHttpHeaders;
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  /** The raw request target, path and query string as sent — for asserting an encoding. */
  readonly url: string;
}

/**
 * The control-plane routes of 014 (contracts/sandbox-lifecycle.md § 5) and the three snapshot
 * routes of 015 (contracts/template-catalogue.md § 6) a test can refuse once.
 */
export type ControlRoute =
  | 'create'
  | 'describe'
  | 'describe-snapshot'
  | 'labels'
  | 'list'
  | 'remove'
  | 'remove-snapshot'
  | 'snapshot'
  | 'start'
  | 'stop';

/** A snapshot as `GET /api/snapshots/{name}` answers it: `errorReason` is `null`, never absent. */
export interface FakeSnapshot {
  errorReason: string | null;
  readonly name: string;
  state: string;
}

export interface FakeSandbox {
  readonly createdAt: string;
  readonly id: string;
  labels: Record<string, string>;
  state: string;
}

export interface SeedSandbox {
  readonly createdAt?: string;
  readonly id?: string;
  readonly labels?: Readonly<Record<string, string>>;
  /** `started` unless given. */
  readonly state?: string;
}

/** The list route pages this many at a time, so a suite of three proves the cursor is followed. */
export const FAKE_LIST_PAGE_SIZE = 2;

export type WorkspaceEntry =
  | { readonly kind: 'dir' }
  | { readonly kind: 'file'; readonly content: Buffer }
  | { readonly kind: 'link'; readonly target: string };

export interface ExecuteRequest {
  readonly command: string;
  readonly cwd?: string;
  readonly envs?: Readonly<Record<string, string>>;
  readonly timeout?: number;
}

export type ExecuteHandler = (
  request: ExecuteRequest,
) => { exitCode: number; result: string } | { status: number };

/**
 * Spec 027 (T041): the deploy worker's steps, as the build runner composes them — `git init`,
 * `git fetch <bundle> <sha>`, `git checkout -f --detach <sha>`, `git clean -fdx`, `npm ci`, the
 * template's build command (anything not matched otherwise) and `tar -cf … -C <output> .`.
 */
export type BuildStep =
  'build' | 'git-checkout' | 'git-clean' | 'git-fetch' | 'git-init' | 'npm-ci' | 'tar';

/** What a build step answers: an exit and its output, or a bare status (`408` is a timeout). */
export type BuildStepAnswer = { exitCode: number; result: string } | { status: number };

/** A deploy build sandbox (labelled `forge.deployment`) as the fake saw it, removed or not. */
export interface FakeBuildSandbox {
  readonly id: string;
  readonly labels: Readonly<Record<string, string>>;
  /** Every command it executed, in order. */
  readonly commands: string[];
  removed: boolean;
}

/** Where the runner's `tar` writes and its download reads (`build-runner.ts` `BUILD_ARCHIVE_PATH`). */
export const FAKE_BUILD_ARCHIVE_PATH = '/tmp/forge-out.tar';

export interface FakeDaytona {
  /** `DAYTONA_API_URL` for the adapter: `http://127.0.0.1:<port>/api`. */
  readonly apiUrl: string;
  readonly apiKey: string;
  readonly requests: FakeRequest[];
  readonly sandboxId: string;
  readonly runnerId: string;
  readonly workDir: string;
  /** Absolute path → entry. Seed files, dirs and links here; uploads land here. */
  readonly workspace: Map<string, WorkspaceEntry>;
  /** Every sandbox the fake knows, by id — read a state or a label map back after a call. */
  readonly sandboxes: Map<string, FakeSandbox>;
  /** Every snapshot captured through `POST /api/sandbox/{id}/snapshot`, by name. Seed one here. */
  readonly snapshots: Map<string, FakeSnapshot>;
  /** The state the default sandbox reports; anything but `started` is `sandbox-not-running`. */
  sandboxState(state: string): void;
  /** A further id the lookup and the proxy accept — a second sandbox, for registration conflicts. */
  addSandbox(id: string): void;
  /**
   * A sandbox in a given state with given labels and `createdAt` — an unlabelled stranger, an
   * orphan older than the grace. Returns the id (`sandbox-fake-<n>` unless given).
   */
  seedSandbox(seed?: SeedSandbox): string;
  /**
   * Daytona's runner catching up: `creating` → `started`, `stopping` → `stopped`. Any other
   * state stays. `start` lands in `started` at once, as the real thing did (research R1).
   */
  settle(id: string): void;
  /** The snapshot job finishing: `pending` → `active`. Unknown names are ignored. */
  settleSnapshot(name: string): void;
  /** The snapshot job failing: `build_failed` with `errorReason`. Unknown names are ignored. */
  failSnapshot(name: string, reason: string): void;
  /**
   * The next `process/execute` that is not the jail's `realpath` — the publisher's install
   * command — answers a non-zero exit with this output, once. Wins over `onExecute`.
   */
  failInstall(result: string, exitCode?: number): void;
  /** The next request on that control route answers this status, with an empty body, once per call. */
  refuseNext(route: ControlRoute, status: number): void;
  /** The next request, whatever it is, answers this status (and body) instead. */
  failNext(failure: { status: number; body?: string }): void;
  /** Every request from now on is accepted and never answered. `close()` releases them. */
  hang(): void;
  /** The next request answers `200 {}`, which fits none of the adapter's schemas. */
  malformed(): void;
  /** Scripts every `process/execute` that is not the jail's `realpath`. */
  onExecute(handler: ExecuteHandler): void;
  /**
   * Spec 027: every deploy build sandbox created (labelled `forge.deployment`), oldest first. Such a
   * sandbox starts on its first describe, and its commands are answered by the build script below
   * rather than `onExecute` — every step exits 0 with empty output unless overridden.
   */
  readonly builds: FakeBuildSandbox[];
  /** Overrides one build step's answer for every later build, until `resetBuild()`. */
  scriptBuild(step: BuildStep, answer: BuildStepAnswer): void;
  /**
   * The archive a successful `tar` step leaves at `/tmp/forge-out.tar` for the download — build it
   * in the test. `undefined` (the default) leaves nothing there, so the download answers 404.
   */
  buildArchive(archive: Buffer | undefined): void;
  /**
   * Spec 041: every daemon session command started (`process/session/{sid}/exec`), oldest first,
   * and every session deleted. The suite plays the runner a session command would have started.
   */
  readonly sessions: { sandboxId: string; sessionId: string; command: string }[];
  readonly deletedSessions: { sandboxId: string; sessionId: string }[];
  /** Spec 041: every `POST /api/sandbox/{id}/network-settings` body, by sandbox id. */
  readonly networkSettings: Map<string, unknown>;
  /** Clears the step overrides, the archive and the `builds` record. */
  resetBuild(): void;
  close(): Promise<void>;
}

export interface FakeDaytonaOptions {
  readonly apiKey?: string;
  /** A fixed port, for a suite that must name the URL before the fake can be started. */
  readonly port?: number;
  readonly sandboxId?: string;
  /**
   * `POST /api/sandbox` answers `400` for a `snapshot` the fake has not captured — the "image
   * deleted by hand" edge case (015). Off by default so the 014 suites' arbitrary names still work.
   */
  readonly strictSnapshots?: boolean;
}

const DEFAULT_WORK_DIR = '/home/daytona';
const MAX_LINK_HOPS = 40;

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function text(response: ServerResponse, status: number, body = ''): void {
  response.writeHead(status, { 'content-type': 'text/plain' });
  response.end(body);
}

/** Undo the single-quote shell quoting the adapter applies to every path it hands `realpath`. */
function unquote(argumentList: string): string[] {
  return [...argumentList.matchAll(/'((?:[^']|'\\'')*)'|(\S+)/g)].map((match) =>
    match[1] === undefined ? match[2]! : match[1].replaceAll(String.raw`'\''`, "'"),
  );
}

export async function startFakeDaytona(options: FakeDaytonaOptions = {}): Promise<FakeDaytona> {
  const apiKey = options.apiKey ?? 'dtn_fake_key';
  const sandboxId = options.sandboxId ?? 'sandbox-fake-0001';
  const runnerId = 'runner-fake';
  const requests: FakeRequest[] = [];
  const sandboxes = new Map<string, FakeSandbox>();
  const snapshots = new Map<string, FakeSnapshot>();
  let seeded = 0;
  const seedSandbox = (seed: SeedSandbox = {}): string => {
    let id = seed.id;
    // A generated id never overwrites one already seeded — the default `sandbox-fake-0001` included.
    if (id === undefined) {
      do id = `sandbox-fake-${String(++seeded).padStart(4, '0')}`;
      while (sandboxes.has(id));
    }
    sandboxes.set(id, {
      createdAt: seed.createdAt ?? new Date().toISOString(),
      id,
      labels: { ...seed.labels },
      state: seed.state ?? 'started',
    });
    return id;
  };
  seedSandbox({ id: sandboxId });
  /** Per route, the statuses still to answer, oldest first: one `refuseNext` call is one refusal. */
  const refusals = new Map<ControlRoute, number[]>();
  const workspace = new Map<string, WorkspaceEntry>([
    [DEFAULT_WORK_DIR, { kind: 'dir' }],
    // Exists in every image; the seed an escaping link needs a target for (R4).
    ['/etc', { kind: 'dir' }],
    ['/etc/hostname', { kind: 'file', content: Buffer.from('fake-daytona\n') }],
  ]);

  let failure: { status: number; body?: string } | undefined;
  let malformedNext = false;
  let hanging = false;
  const sessions: { sandboxId: string; sessionId: string; command: string }[] = [];
  const deletedSessions: { sandboxId: string; sessionId: string }[] = [];
  const liveSessions = new Set<string>();
  const networkSettings = new Map<string, unknown>();
  let installFailure: { exitCode: number; result: string } | undefined;
  const builds: FakeBuildSandbox[] = [];
  const buildScript = new Map<BuildStep, BuildStepAnswer>();
  let archiveFixture: Buffer | undefined;
  const buildOf = (id: string): FakeBuildSandbox | undefined =>
    builds.find((build) => build.id === id && !build.removed);
  const BUILD_STEPS: readonly (readonly [RegExp, BuildStep])[] = [
    [/^git init\b/, 'git-init'],
    [/^git fetch\b/, 'git-fetch'],
    [/^git checkout\b/, 'git-checkout'],
    [/^git clean\b/, 'git-clean'],
    [/^npm ci\b/, 'npm-ci'],
    [/^tar -cf\b/, 'tar'],
  ];
  /** A deploy build's command: its step's scripted answer, and the archive after a good `tar`. */
  const buildExecute = (
    build: FakeBuildSandbox,
    command: string,
  ): { exitCode: number; result: string } | { status: number } => {
    build.commands.push(command);
    const step = BUILD_STEPS.find(([pattern]) => pattern.test(command))?.[1] ?? 'build';
    const answer = buildScript.get(step) ?? { exitCode: 0, result: '' };
    if (step === 'tar' && 'exitCode' in answer && answer.exitCode === 0) {
      if (archiveFixture === undefined) workspace.delete(FAKE_BUILD_ARCHIVE_PATH);
      else workspace.set(FAKE_BUILD_ARCHIVE_PATH, { kind: 'file', content: archiveFixture });
    }
    return answer;
  };

  let executeHandler: ExecuteHandler = () => ({
    exitCode: 127,
    result: 'fake daytona: no onExecute handler scripted\n',
  });

  const absolute = (p: string): string => path.resolve(DEFAULT_WORK_DIR, p);

  /** A path nobody seeded but something lives under is a directory, so seeds need not spell out parents. */
  const entryAt = (p: string): WorkspaceEntry | undefined =>
    workspace.get(p) ??
    ([...workspace.keys()].some((key) => key.startsWith(`${p}/`)) ? { kind: 'dir' } : undefined);

  /** Walk every component through the map, following links; `undefined` when something is missing. */
  const resolve = (input: string): string | undefined => {
    let current = '/';
    const pending = absolute(input).split('/').filter(Boolean);
    let hops = 0;

    while (pending.length > 0) {
      const next = path.join(current, pending.shift()!);
      const entry = entryAt(next);
      if (entry === undefined) return undefined;
      if (entry.kind === 'link') {
        if (++hops > MAX_LINK_HOPS) return undefined;
        const target = path.resolve(path.dirname(next), entry.target);
        pending.unshift(...target.split('/').filter(Boolean));
        current = '/';
        continue;
      }
      current = next;
    }

    return current;
  };

  /** `os.Stat` semantics: through the link, so a link has its target's size and kind. */
  const stat = (input: string): { isDir: boolean; size: number } | undefined => {
    const resolved = resolve(input);
    const entry = resolved === undefined ? undefined : entryAt(resolved);
    if (entry === undefined || entry.kind === 'link') return undefined;
    return entry.kind === 'dir'
      ? { isDir: true, size: 4096 }
      : { isDir: false, size: entry.content.length };
  };

  /** Direct children, implicit directories included, so a seed of `a/b/c` lists `a` at the root. */
  const childrenOf = (dir: string): string[] => {
    const prefix = dir === '/' ? '/' : `${dir}/`;
    const names = [...workspace.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length).split('/')[0]!);
    return [...new Set(names)].sort().map((name) => path.join(dir, name));
  };

  /** Every regular file under `dir`, links resolved, as `[absolutePath, content]`. */
  const walkFiles = (dir: string): [string, Buffer][] => {
    const out: [string, Buffer][] = [];
    for (const child of childrenOf(dir)) {
      const resolved = resolve(child);
      const entry = resolved === undefined ? undefined : entryAt(resolved);
      if (entry === undefined) continue;
      if (entry.kind === 'dir') out.push(...walkFiles(child));
      else if (entry.kind === 'file') out.push([child, entry.content]);
    }
    return out;
  };

  /**
   * `-e`: every argument must exist. `-m`: resolve as far as the map allows and finish lexically,
   * one line per argument and never an error — what the adapter's batched `list` relies on.
   */
  const realpath = (flag: string, argumentList: string): { exitCode: number; result: string } => {
    let exitCode = 0;
    const lines = unquote(argumentList).map((argument) => {
      const resolved = resolve(argument);
      if (resolved !== undefined) return resolved;
      if (flag === '-m') {
        const entry = workspace.get(absolute(argument));
        return entry?.kind === 'link'
          ? path.resolve(path.dirname(absolute(argument)), entry.target)
          : absolute(argument);
      }
      exitCode = 1;
      return `realpath: ${argument}: No such file or directory`;
    });
    return { exitCode, result: `${lines.join('\n')}\n` };
  };

  const toolbox = async (
    sandboxIdOfCall: string,
    route: string,
    request: IncomingMessage,
    query: Record<string, string>,
    body: Buffer,
    response: ServerResponse,
  ): Promise<void> => {
    const method = request.method ?? 'GET';
    const target = absolute(query.path ?? '.');

    switch (`${method} ${route}`) {
      case 'GET work-dir':
        return json(response, 200, { dir: DEFAULT_WORK_DIR });

      case 'GET files': {
        const info = stat(target);
        if (info === undefined) return text(response, 404, 'no such file or directory');
        if (!info.isDir) return text(response, 400, 'path must be a directory');
        const dir = resolve(target)!;
        const entries = childrenOf(dir).flatMap((child) => {
          const childInfo = stat(child);
          return childInfo === undefined ? [] : [{ name: path.basename(child), ...childInfo }];
        });
        return json(response, 200, entries);
      }

      case 'GET files/info': {
        const info = stat(target);
        if (info === undefined) return text(response, 404, 'no such file or directory');
        return json(response, 200, { name: path.basename(target), ...info });
      }

      case 'GET files/download': {
        const resolved = resolve(target);
        const entry = resolved === undefined ? undefined : entryAt(resolved);
        if (entry === undefined || entry.kind === 'link')
          return text(response, 404, 'no such file');
        if (entry.kind === 'dir') return text(response, 400, 'path must be a file');
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        response.end(entry.content);
        return;
      }

      case 'POST files/upload': {
        const form = await new Response(new Uint8Array(body), {
          headers: { 'content-type': request.headers['content-type'] ?? '' },
        }).formData();
        const file = form.get('file');
        if (!(file instanceof Blob)) return text(response, 400, 'missing form field: file');
        const resolvedTarget = resolve(target) ?? target;
        let parent = path.dirname(resolvedTarget);
        while (!workspace.has(parent) && parent !== '/') {
          workspace.set(parent, { kind: 'dir' });
          parent = path.dirname(parent);
        }
        workspace.set(resolvedTarget, {
          kind: 'file',
          content: Buffer.from(await file.arrayBuffer()),
        });
        return text(response, 200);
      }

      case 'GET files/find': {
        const pattern = query.pattern ?? '';
        const matches = walkFiles(resolve(target) ?? target).flatMap(([file, content]) => {
          if (content.subarray(0, 512).includes(0)) return [];
          return content
            .toString('utf8')
            .split('\n')
            .flatMap((line, index) =>
              line.includes(pattern) ? [{ content: line, file, line: index + 1 }] : [],
            );
        });
        return json(response, 200, matches);
      }

      case 'GET files/search': {
        const pattern = query.pattern ?? '*';
        const files = walkFiles(resolve(target) ?? target)
          .map(([file]) => file)
          .filter((file) => path.matchesGlob(path.basename(file), pattern));
        return json(response, 200, { files });
      }

      case 'POST process/execute': {
        const execute = JSON.parse(body.toString('utf8')) as ExecuteRequest;
        const jail = /^realpath (-e|-m) -- (.+)$/s.exec(execute.command);
        let outcome;
        const build = buildOf(sandboxIdOfCall);
        if (jail) outcome = realpath(jail[1]!, jail[2]!);
        else if (build !== undefined) outcome = buildExecute(build, execute.command);
        else if (installFailure !== undefined) {
          outcome = installFailure;
          installFailure = undefined;
        } else outcome = executeHandler(execute);
        if ('status' in outcome) return text(response, outcome.status, 'REQUEST_TIMEOUT');
        return json(response, 200, outcome);
      }

      default: {
        // Spec 041: the daemon's session API, as the agent home's runner start uses it.
        if (method === 'POST' && route === 'process/session') {
          const { sessionId } = JSON.parse(body.toString('utf8')) as { sessionId: string };
          liveSessions.add(`${sandboxIdOfCall}/${sessionId}`);
          return text(response, 201);
        }
        const session = /^process\/session\/([^/]+)(\/exec)?$/.exec(route);
        if (session !== null) {
          const sessionId = decodeURIComponent(session[1]!);
          const key = `${sandboxIdOfCall}/${sessionId}`;
          if (method === 'DELETE' && session[2] === undefined) {
            if (!liveSessions.delete(key)) return text(response, 404, 'session not found');
            deletedSessions.push({ sandboxId: sandboxIdOfCall, sessionId });
            return text(response, 204);
          }
          if (method === 'POST' && session[2] !== undefined) {
            if (!liveSessions.has(key)) return text(response, 404, 'session not found');
            const { command } = JSON.parse(body.toString('utf8')) as { command: string };
            sessions.push({ command, sandboxId: sandboxIdOfCall, sessionId });
            return json(response, 200, { cmdId: `cmd-${String(sessions.length)}` });
          }
        }
        return text(response, 404, `fake daytona: no toolbox route ${method} ${route}`);
      }
    }
  };

  let previewTokens = 1;
  const sockets = new Set<Socket>();

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const body = await readBody(request);
    const query = Object.fromEntries(url.searchParams);
    requests.push({
      body: body.toString('utf8'),
      headers: request.headers,
      method: request.method ?? 'GET',
      path: url.pathname,
      query,
      url: request.url ?? '/',
    });

    if (hanging) return; // never answered; `close()` destroys the socket

    if (failure !== undefined) {
      const { status, body: failureBody } = failure;
      failure = undefined;
      return text(response, status, failureBody ?? '');
    }

    if (malformedNext) {
      malformedNext = false;
      return json(response, 200, {});
    }

    if (url.pathname.startsWith('/api/toolbox/')) {
      return text(response, 599, 'fake daytona: the deprecated /api/toolbox route was called');
    }

    if (request.headers.authorization !== `Bearer ${apiKey}`) {
      return json(response, 401, { message: 'Unauthorized' });
    }

    const port = (server.address() as AddressInfo).port;
    const toolboxProxyUrl = `http://127.0.0.1:${port}/toolbox`;

    const method = request.method ?? 'GET';
    const dto = (sandbox: FakeSandbox) => ({
      autoArchiveInterval: 43200,
      autoStopInterval: 0,
      createdAt: sandbox.createdAt,
      id: sandbox.id,
      labels: sandbox.labels,
      runnerId,
      state: sandbox.state,
      target: 'local',
      toolboxProxyUrl,
      user: 'daytona',
    });
    /** `refuseNext` for this route: answers the status once and says so. */
    const refuse = (route: ControlRoute): boolean => {
      const status = refusals.get(route)?.shift();
      if (status === undefined) return false;
      text(response, status);
      return true;
    };

    if (url.pathname === '/api/sandbox' && method === 'POST') {
      if (refuse('create')) return;
      const input = JSON.parse(body.toString('utf8')) as {
        labels?: Record<string, string>;
        snapshot?: string;
      };
      if (options.strictSnapshots === true && !snapshots.has(input.snapshot ?? '')) {
        return json(response, 400, { message: `Snapshot ${input.snapshot ?? ''} not found` });
      }
      const id = seedSandbox({ labels: input.labels, state: 'creating' });
      if (input.labels?.['forge.deployment'] !== undefined) {
        builds.push({ commands: [], id, labels: { ...input.labels }, removed: false });
      }
      return json(response, 200, dto(sandboxes.get(id)!));
    }

    if (url.pathname === '/api/sandbox' && method === 'GET') {
      if (refuse('list')) return;
      let wanted: Record<string, string> = {};
      if (query.labels !== undefined) {
        try {
          wanted = JSON.parse(query.labels) as Record<string, string>;
        } catch {
          return json(response, 400, { message: 'Invalid labels JSON format' });
        }
      }
      const matching = [...sandboxes.values()].filter((sandbox) =>
        Object.entries(wanted).every(([key, value]) => sandbox.labels[key] === value),
      );
      const from = Number(query.cursor ?? '0');
      const to = from + FAKE_LIST_PAGE_SIZE;
      return json(response, 200, {
        items: matching.slice(from, to).map(dto),
        nextCursor: to < matching.length ? String(to) : null,
      });
    }

    const snapshot = /^\/api\/snapshots\/([^/]+)$/.exec(url.pathname);
    if (snapshot) {
      const name = decodeURIComponent(snapshot[1]!);
      const route: ControlRoute | undefined =
        method === 'GET'
          ? 'describe-snapshot'
          : method === 'DELETE'
            ? 'remove-snapshot'
            : undefined;
      if (route !== undefined && refuse(route)) return;
      const known = snapshots.get(name);
      // The real thing's 404 body, so a poll sees exactly what the stack answered (research R1).
      if (known === undefined) {
        return json(response, 404, {
          error: 'Not Found',
          message: `Snapshot with name ${name} not found`,
          statusCode: 404,
        });
      }
      if (method === 'GET') return json(response, 200, known);
      if (method === 'DELETE') {
        snapshots.delete(name);
        return json(response, 200, { ...known, state: 'removing' });
      }
      return text(response, 404, `fake daytona: no route ${method} ${url.pathname}`);
    }

    // Spec 017 contract § 7: the signed, per-port preview origin. The token is fresh per call and
    // the url is the proxy's `{port}-{token}.{domain}` shape; the sandbox `authToken` never appears.
    const preview = /^\/api\/sandbox\/([^/]+)\/ports\/(\d+)\/signed-preview-url$/.exec(
      url.pathname,
    );
    if (preview && method === 'GET') {
      const sandbox = sandboxes.get(preview[1]!);
      if (sandbox === undefined) return json(response, 404, { message: 'Sandbox not found' });
      const token = `preview-${preview[2]!}-${String(previewTokens++)}`;
      return json(response, 200, {
        port: Number(preview[2]),
        sandboxId: sandbox.id,
        token,
        url: `http://${preview[2]!}-${token}.proxy.localhost:4000`,
      });
    }

    const control =
      /^\/api\/sandbox\/([^/]+)(?:\/(toolbox-proxy-url|start|stop|labels|snapshot|network-settings))?$/.exec(
        url.pathname,
      );
    if (control) {
      const sandbox = sandboxes.get(control[1]!);
      const action = `${method} ${control[2] ?? ''}`;
      const routes: Readonly<Record<string, ControlRoute>> = {
        'DELETE ': 'remove',
        'GET ': 'describe',
        'POST snapshot': 'snapshot',
        'POST start': 'start',
        'POST stop': 'stop',
        'PUT labels': 'labels',
      };
      const route = routes[action];
      if (route !== undefined && refuse(route)) return;
      if (sandbox === undefined) return json(response, 404, { message: 'Sandbox not found' });

      switch (action) {
        case 'GET toolbox-proxy-url':
          return json(response, 200, { url: toolboxProxyUrl });
        case 'GET ':
          // A deploy build sandbox starts as soon as it is asked about: no test settles it.
          if (buildOf(sandbox.id) !== undefined && sandbox.state === 'creating') {
            sandbox.state = 'started';
          }
          return json(response, 200, dto(sandbox));
        case 'DELETE ': {
          const build = buildOf(sandbox.id);
          if (build !== undefined) build.removed = true;
          sandboxes.delete(sandbox.id);
          return json(response, 200, { ...dto(sandbox), state: 'destroying' });
        }
        case 'POST start':
          sandbox.state = 'started';
          return json(response, 200, dto(sandbox));
        case 'POST stop':
          sandbox.state = 'stopping';
          return json(response, 200, dto(sandbox));
        case 'POST snapshot': {
          // The sandbox dto comes back in `snapshotting`, not the snapshot's (research R1).
          if (sandbox.state === 'destroying') {
            return json(response, 409, { message: 'Sandbox is being destroyed' });
          }
          const input = JSON.parse(body.toString('utf8')) as { name: string };
          snapshots.set(input.name, { errorReason: null, name: input.name, state: 'pending' });
          return json(response, 200, { ...dto(sandbox), state: 'snapshotting' });
        }
        case 'POST network-settings':
          networkSettings.set(sandbox.id, JSON.parse(body.toString('utf8')));
          return json(response, 200, dto(sandbox));
        case 'PUT labels': {
          const input = JSON.parse(body.toString('utf8')) as { labels: Record<string, string> };
          sandbox.labels = { ...input.labels };
          return json(response, 200, dto(sandbox));
        }
        default:
          return text(response, 404, `fake daytona: no route ${method} ${url.pathname}`);
      }
    }

    const proxied = /^\/toolbox\/([^/]+)\/(.+)$/.exec(url.pathname);
    if (proxied) {
      if (!sandboxes.has(proxied[1]!)) return json(response, 404, { message: 'Sandbox not found' });
      return toolbox(proxied[1]!, proxied[2]!, request, query, body, response);
    }

    return text(response, 404, `fake daytona: no route ${request.method} ${url.pathname}`);
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    addSandbox: (id) => {
      seedSandbox({ id });
    },
    apiKey,
    buildArchive: (archive) => {
      archiveFixture = archive;
    },
    builds,
    apiUrl: `http://127.0.0.1:${port}/api`,
    // Idempotent: a suite that closes the fake mid-test to prove `unreachable` still gets an
    // `afterEach` that can close it again.
    close: () =>
      new Promise<void>((resolve, reject) => {
        if (!server.listening) return resolve();
        for (const socket of sockets) socket.destroy();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
    failInstall: (result, exitCode = 1) => {
      installFailure = { exitCode, result };
    },
    failNext: (next) => {
      failure = next;
    },
    failSnapshot: (name, reason) => {
      const known = snapshots.get(name);
      if (known !== undefined) {
        known.state = 'build_failed';
        known.errorReason = reason;
      }
    },
    hang: () => {
      hanging = true;
    },
    malformed: () => {
      malformedNext = true;
    },
    onExecute: (handler) => {
      executeHandler = handler;
    },
    refuseNext: (route, status) => {
      refusals.set(route, [...(refusals.get(route) ?? []), status]);
    },
    deletedSessions,
    networkSettings,
    requests,
    sessions,
    resetBuild: () => {
      buildScript.clear();
      archiveFixture = undefined;
      builds.length = 0;
    },
    runnerId,
    sandboxId,
    sandboxState: (next) => {
      sandboxes.get(sandboxId)!.state = next;
    },
    sandboxes,
    scriptBuild: (step, answer) => {
      buildScript.set(step, answer);
    },
    seedSandbox,
    settle: (id) => {
      const sandbox = sandboxes.get(id);
      if (sandbox?.state === 'creating') sandbox.state = 'started';
      else if (sandbox?.state === 'stopping') sandbox.state = 'stopped';
    },
    settleSnapshot: (name) => {
      const known = snapshots.get(name);
      if (known?.state === 'pending') known.state = 'active';
    },
    snapshots,
    workDir: DEFAULT_WORK_DIR,
    workspace,
  };
}
