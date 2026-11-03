import { execFile, execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

/**
 * GitHub's REST API in memory, for the connector suites: the endpoints `github-app.client.ts`
 * calls, answered from maps a spec fills and reads back. It is not a mock of the client — the real
 * client is pointed at `url` through `GITHUB_API_URL` — so what a suite proves is the wire.
 *
 * Seam for later suites: `route(method, pattern, handler)` adds an endpoint. With `git: true`
 * the same server answers `/{owner}/{repo}.git/*` through `git http-backend` as a CGI over bare
 * repositories under `gitRoot` — the push/pull suites' remote, reached only with a minted
 * installation token in a Basic `Authorization` header (`x-access-token:<token>`), as GitHub is.
 */
export interface FixtureAccount {
  readonly id: number;
  readonly login: string;
  readonly type: 'Organization' | 'User';
}

export interface FixtureInstallation {
  readonly account: FixtureAccount;
  readonly id: number;
}

export interface FixtureRepository {
  /** Branch name → head sha, for `GET /repos/{owner}/{repo}/branches/{branch}`. */
  readonly branches: Record<string, string>;
  readonly default_branch: string;
  readonly full_name: string;
  readonly id: number;
  readonly name: string;
  readonly owner: { readonly login: string };
  readonly private: boolean;
  /** Spec 026 R6: KiB, as GitHub's repository payload reports it. Absent reads as 0. */
  readonly size?: number;
  /**
   * Spec 026 R3: the root entry names at each branch head, for `GET …/git/trees/{sha}`, and the
   * root files' text for `GET …/contents/{path}`. A repository seeded through
   * {@link GithubFixture.seedRepo} gets both from the tree it was seeded with.
   */
  readonly root?: Record<string, string>;
}

export interface FixtureToken {
  readonly installationId: number;
  readonly permissions: Record<string, string>;
  readonly repositoryIds: readonly number[] | undefined;
}

export interface RecordedRequest {
  readonly authorization: string | undefined;
  readonly body: unknown;
  readonly method: string;
  readonly path: string;
}

/** One-shot knobs a spec sets before a call; the next request consumes them. */
export interface FixtureOverride {
  /** Never answer — for the timeout case. */
  hang?: boolean;
  /** Answer with this status (and a JSON body) instead of routing. */
  status?: number;
}

export type RouteHandler = (
  params: Record<string, string>,
  request: RecordedRequest,
  url: URL,
) => { status: number; body?: unknown };

export interface GithubFixture {
  readonly url: string;
  readonly installations: Map<number, FixtureInstallation>;
  readonly repositories: Map<number, FixtureRepository>;
  /** Minted installation tokens by value. */
  readonly tokens: Map<string, FixtureToken>;
  /** Every request answered, in order, body parsed when JSON. */
  readonly requests: RecordedRequest[];
  readonly override: FixtureOverride;
  route(method: string, pattern: string, handler: RouteHandler): void;
  /** `git: true` only: the directory http-backend serves; `<owner>/<name>.git` is a repository. */
  readonly gitRoot: string | undefined;
  /** `git: true` only: an empty bare repository for a fixture repository (a previous one is replaced). */
  initRepo(repository: Pick<FixtureRepository, 'full_name'>): Promise<string>;
  /**
   * `git: true` only (spec 026 T028): a bare repository holding one commit of `files` on `branch`,
   * with the same files registered as the repository's root for the tree and contents endpoints.
   * Returns the commit's sha — what an import clones and what its baseline checkpoint records.
   */
  seedRepo(
    repository: FixtureRepository,
    files: Record<string, string>,
    branch?: string,
  ): Promise<string>;
  close(): Promise<void>;
}

interface Route {
  readonly handler: RouteHandler;
  readonly keys: string[];
  readonly method: string;
  readonly regex: RegExp;
}

function bearer(request: RecordedRequest): string | undefined {
  return request.authorization?.replace(/^Bearer /i, '');
}

function isJwt(value: string | undefined): boolean {
  return value?.split('.').length === 3;
}

function readBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];

    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');

      try {
        resolve(text === '' ? undefined : JSON.parse(text));
      } catch {
        resolve(text);
      }
    });
  });
}

function send(response: ServerResponse, status: number, body?: unknown): void {
  const payload = body === undefined ? '' : JSON.stringify(body);

  response.writeHead(status, {
    'Content-Length': Buffer.byteLength(payload),
    'Content-Type': 'application/json',
  });
  response.end(payload);
}

const NOT_FOUND = { body: { message: 'Not Found' }, status: 404 };
const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git(\/.*)$/;

/** `git http-backend` as a CGI: the request on stdin, `Status:` and the headers off stdout. */
function gitBackend(root: string, incoming: IncomingMessage, response: ServerResponse): void {
  const url = new URL(incoming.url ?? '/', 'http://fixture');
  const header = (name: string): string => {
    const value = incoming.headers[name];

    return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
  };
  const child = spawn('git', ['http-backend'], {
    env: {
      ...process.env,
      CONTENT_LENGTH: header('content-length'),
      CONTENT_TYPE: header('content-type'),
      GIT_HTTP_EXPORT_ALL: '1',
      GIT_PROJECT_ROOT: root,
      HTTP_CONTENT_ENCODING: header('content-encoding'),
      PATH_INFO: url.pathname,
      QUERY_STRING: url.search.slice(1),
      // Set: http-backend accepts receive-pack only for an authenticated user.
      REMOTE_USER: 'x-access-token',
      REQUEST_METHOD: incoming.method ?? 'GET',
    },
  });
  const chunks: Buffer[] = [];

  incoming.pipe(child.stdin);
  child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
  child.on('close', () => {
    const output = Buffer.concat(chunks);
    const split = output.indexOf('\r\n\r\n');
    const headers: Record<string, string> = {};
    let status = 200;

    for (const line of output.subarray(0, split).toString('latin1').split('\r\n')) {
      const [name, ...rest] = line.split(': ');

      if (name === 'Status') status = Number(rest.join(': ').split(' ')[0]);
      else if (name !== undefined && name !== '') headers[name] = rest.join(': ');
    }

    response.writeHead(status, headers);
    response.end(output.subarray(split + 4));
  });
}

/** `port`: for a suite whose `AppModule` read `GITHUB_API_URL` at import time; `0` (ephemeral) otherwise. */
export async function startGithubFixture(
  options: { git?: boolean; port?: number } = {},
): Promise<GithubFixture> {
  const gitRoot =
    options.git === true ? await mkdtemp(join(tmpdir(), 'forge-fixture-git-')) : undefined;
  const installations = new Map<number, FixtureInstallation>();
  const repositories = new Map<number, FixtureRepository>();
  const tokens = new Map<string, FixtureToken>();
  const requests: RecordedRequest[] = [];
  const override: FixtureOverride = {};
  const routes: Route[] = [];

  const route: GithubFixture['route'] = (method, pattern, handler) => {
    const keys: string[] = [];
    const source = pattern.replaceAll(/\{(\w+)\}/g, (_, key: string) => {
      keys.push(key);

      return '([^/]+)';
    });

    routes.push({ handler, keys, method, regex: new RegExp(`^${source}$`) });
  };

  const withToken =
    (
      handler: (token: FixtureToken, ...rest: Parameters<RouteHandler>) => ReturnType<RouteHandler>,
    ): RouteHandler =>
    (params, request, url) => {
      const token = tokens.get(bearer(request) ?? '');

      return token === undefined
        ? { body: { message: 'Bad credentials' }, status: 401 }
        : handler(token, params, request, url);
    };

  const withJwt =
    (handler: RouteHandler): RouteHandler =>
    (params, request, url) =>
      isJwt(bearer(request))
        ? handler(params, request, url)
        : { body: { message: 'A JSON web token could not be decoded' }, status: 401 };

  route(
    'GET',
    '/app/installations/{id}',
    withJwt(({ id }) => {
      const installation = installations.get(Number(id));

      return installation === undefined ? NOT_FOUND : { body: installation, status: 200 };
    }),
  );

  route(
    'POST',
    '/app/installations/{id}/access_tokens',
    withJwt(({ id }, request) => {
      const installationId = Number(id);

      if (!installations.has(installationId)) {
        return NOT_FOUND;
      }

      const body = (request.body ?? {}) as {
        permissions?: Record<string, string>;
        repository_ids?: number[];
      };
      const token = `ghs_${randomBytes(20).toString('hex')}`;

      tokens.set(token, {
        installationId,
        permissions: body.permissions ?? {},
        repositoryIds: body.repository_ids,
      });

      return {
        body: {
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          permissions: body.permissions ?? {},
          token,
        },
        status: 201,
      };
    }),
  );

  route(
    'DELETE',
    '/app/installations/{id}',
    withJwt(({ id }) => (installations.delete(Number(id)) ? { status: 204 } : NOT_FOUND)),
  );

  route(
    'GET',
    '/installation/repositories',
    withToken((token, _params, _request, url) => {
      const page = Number(url.searchParams.get('page') ?? '1');
      const perPage = Number(url.searchParams.get('per_page') ?? '30');
      const owned = [...repositories.values()].filter(
        (repository) =>
          token.repositoryIds === undefined || token.repositoryIds.includes(repository.id),
      );

      return {
        body: {
          repositories: owned.slice((page - 1) * perPage, page * perPage),
          total_count: owned.length,
        },
        status: 200,
      };
    }),
  );

  route(
    'POST',
    '/orgs/{org}/repos',
    withToken((_token, { org }, request) => {
      const body = request.body as { name: string; private?: boolean };
      const fullName = `${org ?? ''}/${body.name}`;

      if ([...repositories.values()].some((repository) => repository.full_name === fullName)) {
        return { body: { message: 'Repository creation failed.' }, status: 422 };
      }

      const repository: FixtureRepository = {
        branches: {},
        default_branch: 'main',
        full_name: fullName,
        id: 1000 + repositories.size,
        name: body.name,
        owner: { login: org ?? '' },
        private: body.private ?? false,
      };

      repositories.set(repository.id, repository);

      return { body: repository, status: 201 };
    }),
  );

  route(
    'GET',
    '/repositories/{id}',
    withToken((_token, { id }) => {
      const repository = repositories.get(Number(id));

      return repository === undefined ? NOT_FOUND : { body: repository, status: 200 };
    }),
  );

  /** Spec 026 R3: the root of a tree, non-recursive — the names a repository's `root` declares. */
  route(
    'GET',
    '/repositories/{id}/git/trees/{sha}',
    withToken((_token, { id, sha }) => {
      const repository = repositories.get(Number(id));

      return repository === undefined
        ? NOT_FOUND
        : {
            body: {
              sha,
              tree: Object.keys(repository.root ?? {})
                .sort()
                .map((path) => ({ path, type: 'blob' })),
              truncated: false,
            },
            status: 200,
          };
    }),
  );

  /** Spec 026 R3: one root file's text, base64 as GitHub serves it. */
  route(
    'GET',
    '/repositories/{id}/contents/{path}',
    withToken((_token, { id, path }) => {
      const body = repositories.get(Number(id))?.root?.[decodeURIComponent(path ?? '')];

      return body === undefined
        ? NOT_FOUND
        : {
            body: {
              content: Buffer.from(body, 'utf8').toString('base64'),
              encoding: 'base64',
              path,
            },
            status: 200,
          };
    }),
  );

  /** With `git: true`, a branch that a push landed on the bare repository answers its head, as GitHub would. */
  const bareHead = (fullName: string, branch: string): string | undefined => {
    if (gitRoot === undefined) return undefined;
    try {
      return execFileSync('git', ['rev-parse', '--verify', `refs/heads/${branch}`], {
        cwd: join(gitRoot, `${fullName}.git`),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return undefined;
    }
  };

  route(
    'GET',
    '/repos/{owner}/{repo}/branches/{branch}',
    withToken((_token, { owner, repo, branch }) => {
      const repository = [...repositories.values()].find(
        (candidate) => candidate.full_name === `${owner ?? ''}/${repo ?? ''}`,
      );
      const sha =
        repository?.branches[branch ?? ''] ??
        (repository === undefined ? undefined : bareHead(repository.full_name, branch ?? ''));

      return sha === undefined
        ? { body: { message: 'Branch not found' }, status: 404 }
        : { body: { commit: { sha }, name: branch }, status: 200 };
    }),
  );

  /** The git request's credential must be a minted token scoped to the repository it names. */
  const gitAuthorised = (authorization: string | undefined, fullName: string): boolean => {
    const basic = authorization?.replace(/^Basic /i, '') ?? '';
    const [user, value] = Buffer.from(basic, 'base64').toString('utf8').split(':');
    const token = tokens.get(value ?? '');
    const repository = [...repositories.values()].find((entry) => entry.full_name === fullName);

    return (
      user === 'x-access-token' &&
      token !== undefined &&
      repository !== undefined &&
      (token.repositoryIds === undefined || token.repositoryIds.includes(repository.id))
    );
  };

  const server: Server = createServer((incoming, response) => {
    void (async () => {
      const url = new URL(incoming.url ?? '/', 'http://fixture');
      const git = gitRoot === undefined ? null : GIT_PATH.exec(url.pathname);

      if (git !== null) {
        requests.push({
          authorization: incoming.headers.authorization,
          body: undefined,
          method: incoming.method ?? 'GET',
          path: url.pathname,
        });
        if (gitAuthorised(incoming.headers.authorization, `${git[1] ?? ''}/${git[2] ?? ''}`)) {
          gitBackend(gitRoot!, incoming, response);
        } else {
          incoming.resume();
          send(response, 401, { message: 'Bad credentials' });
        }

        return;
      }

      const request: RecordedRequest = {
        authorization: incoming.headers.authorization,
        body: await readBody(incoming),
        method: incoming.method ?? 'GET',
        path: url.pathname,
      };

      requests.push(request);

      if (override.hang === true) {
        delete override.hang;

        return;
      }

      if (override.status !== undefined) {
        const { status } = override;

        delete override.status;
        send(response, status, { message: 'forced by the fixture' });

        return;
      }

      for (const candidate of routes) {
        const match =
          candidate.method === request.method ? candidate.regex.exec(url.pathname) : null;

        if (match !== null) {
          const params = Object.fromEntries(
            candidate.keys.map((key, index) => [key, match[index + 1] ?? '']),
          );
          const answer = candidate.handler(params, request, url);

          send(response, answer.status, answer.body);

          return;
        }
      }

      send(response, 404, NOT_FOUND.body);
    })();
  });

  await new Promise<void>((resolve) => {
    server.listen(options.port ?? 0, '127.0.0.1', resolve);
  });

  const { port } = server.address() as AddressInfo;

  return {
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      });
      if (gitRoot !== undefined) await rm(gitRoot, { force: true, recursive: true });
    },
    gitRoot,
    initRepo: async ({ full_name }) => {
      if (gitRoot === undefined) throw new Error('The fixture was started without `git: true`.');
      const dir = join(gitRoot, `${full_name}.git`);

      await rm(dir, { force: true, recursive: true });

      // `-b main` rather than the host's `init.defaultBranch`: every suite pushes `HEAD:main`,
      // and a bare HEAD left on an unpushed `master` (git's own default; Git for Windows sets
      // `main` system-wide, which is why this only showed on the Linux runner) makes a clone
      // check out an unborn branch, so the "someone else pushes" commit becomes a root commit
      // and its push is refused as non-fast-forward.
      await promisify(execFile)('git', ['init', '--quiet', '--bare', '-b', 'main', dir]);

      return dir;
    },
    installations,
    seedRepo: async (repository, files, branch = repository.default_branch) => {
      if (gitRoot === undefined) throw new Error('The fixture was started without `git: true`.');
      const bare = join(gitRoot, `${repository.full_name}.git`);

      await rm(bare, { force: true, recursive: true });
      await promisify(execFile)('git', ['init', '--quiet', '--bare', '-b', branch, bare]);

      const work = await mkdtemp(join(gitRoot, 'seed-'));
      const run = async (...args: string[]): Promise<string> =>
        (
          await promisify(execFile)('git', args, {
            cwd: work,
            env: {
              ...process.env,
              GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
              GIT_AUTHOR_EMAIL: 'seed@forge.test',
              GIT_AUTHOR_NAME: 'seed',
              GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
              GIT_COMMITTER_EMAIL: 'seed@forge.test',
              GIT_COMMITTER_NAME: 'seed',
            },
          })
        ).stdout.trim();

      await run('init', '--quiet', `--initial-branch=${branch}`);
      for (const [path, content] of Object.entries(files)) {
        await mkdir(join(work, path, '..'), { recursive: true });
        await writeFile(join(work, path), content);
      }
      await run('add', '-A');
      await run('commit', '--quiet', '-m', 'seed');
      const sha = await run('rev-parse', 'HEAD');
      await run('push', '--quiet', bare, `HEAD:refs/heads/${branch}`);
      await rm(work, { force: true, recursive: true });

      // The API half of the same repository: the branch head, and the root the inspector reads.
      const root = Object.fromEntries(
        Object.entries(files).filter(([path]) => !path.includes('/')),
      );

      repositories.set(repository.id, {
        ...repository,
        branches: { ...repository.branches, [branch]: sha },
        root,
      });

      return sha;
    },
    override,
    repositories,
    requests,
    route,
    tokens,
    url: `http://127.0.0.1:${String(port)}`,
  };
}
