import { posix } from 'node:path';

import type { Config } from './config.ts';
import type { DockerPort, ExecOutcome } from './docker.ts';
import {
  absPath,
  guarded,
  MAX_UPLOAD,
  NOT_FOUND,
  readJson,
  readUpload,
  sessionId,
  WRONG_KIND,
} from './exec.ts';
import { HttpError, type Handler, type router, sendJson } from './http.ts';
import { log } from './log.ts';
import type { Store } from './store.ts';

const WORK_DIR = '/home/daytona';
interface Ctx {
  id: string;
  cid: string;
  p: Record<string, string>;
  url: URL;
}

const SMALL = 1 << 20;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const EXCLUDES = ['node_modules', '.git'];

interface Deps {
  cfg: Config;
  store: Store;
  docker: DockerPort;
}

/** On boot: sessions of sandboxes whose container is not running are dead processes. */
export async function clearStaleSessions(store: Store, docker: DockerPort): Promise<void> {
  for (const r of store.all()) {
    const c = r.containerId ? await docker.inspect(r.containerId) : null;
    if (c?.status !== 'running') store.removeSessionsFor(r.id);
  }
}

export function registerToolboxRoutes(api: ReturnType<typeof router>, d: Deps): void {
  const { store, docker } = d;

  /** Toolbox route for a running sandbox; anything else is 404 so the adapter re-looks it up. */
  const tool =
    (
      fn: (a: Parameters<Handler>[0], res: Parameters<Handler>[1], ctx: Ctx) => Promise<void>,
    ): Handler =>
    async (req, res, p, url) => {
      const id = p.id!;
      const row = store.get(id);
      const c = row?.containerId ? await docker.inspect(row.containerId) : null;
      if (!row?.containerId || c?.status !== 'running')
        throw new HttpError(404, 'Sandbox not found');
      log('info', 'toolbox', {
        'sandboxd.id': id,
        route: `${req.method ?? ''} ${url.pathname.split('/').slice(3).join('/')}`,
        'x-forge-operation-id': req.headers['x-forge-operation-id'],
        'x-forge-lease-epoch': req.headers['x-forge-lease-epoch'],
      });
      await fn(req, res, { id, cid: row.containerId, p, url });
    };

  const run = (
    cid: string,
    argv: string[],
    o: { stdin?: Buffer; max?: number; timeoutMs?: number } = {},
  ) =>
    docker.exec(cid, {
      argv,
      cwd: WORK_DIR,
      stdin: o.stdin,
      timeoutMs: o.timeoutMs ?? 60_000,
      maxOutputBytes: o.max ?? SMALL,
    });

  /** Output of a successful exec, or the HTTP error its exit code stands for. */
  function ok(r: ExecOutcome, what: string): Buffer {
    if (r.timedOut) throw new HttpError(504, `${what} timed out`);
    if (r.exitCode === NOT_FOUND) throw new HttpError(404, 'no such file or directory');
    if (r.exitCode === WRONG_KIND) throw new HttpError(400, 'wrong kind of path');
    if (r.exitCode !== 0) throw new HttpError(500, `${what} failed`);
    if (r.truncated) throw new HttpError(413, `${what} output too large`);
    return r.output;
  }

  const empty = (res: Parameters<Handler>[1]) => sendJson(res, 200, {});
  const queryPath = (url: URL) => absPath(url.searchParams.get('path'));

  api.route(
    'GET',
    '/toolbox/:id/work-dir',
    tool((_q, res) => Promise.resolve(sendJson(res, 200, { dir: WORK_DIR }))),
  );

  api.route(
    'GET',
    '/toolbox/:id/files',
    tool(async (_q, res, { cid, url }) => {
      const p = queryPath(url);
      const out = ok(
        await run(
          cid,
          guarded('-d', p, [
            'find',
            '-H',
            p,
            '-mindepth',
            '1',
            '-maxdepth',
            '1',
            '-printf',
            '%Y\\t%s\\t%f\\0',
          ]),
        ),
        'list',
      );
      const items = out
        .toString('utf8')
        .split('\0')
        .filter(Boolean)
        .flatMap((rec) => {
          const [kind, size, ...name] = rec.split('\t');
          // %Y is N/L/? for dangling or looping links: not statable, so not listed.
          if (!kind || 'NL?'.includes(kind)) return [];
          return [{ name: name.join('\t'), isDir: kind === 'd', size: Number(size) }];
        });
      sendJson(res, 200, items);
    }),
  );

  api.route(
    'GET',
    '/toolbox/:id/files/info',
    tool(async (_q, res, { cid, url }) => {
      const p = queryPath(url);
      const r = await run(cid, ['stat', '-L', '--printf', '%F\\t%s\\n', '--', p]);
      // stat has no guard script: any failure to stat is "not found".
      if (!r.timedOut && r.exitCode !== 0) throw new HttpError(404, 'no such file or directory');
      const [kind, size] = ok(r, 'stat').toString('utf8').trim().split('\t');
      sendJson(res, 200, {
        name: posix.basename(p),
        isDir: kind === 'directory',
        size: Number(size),
      });
    }),
  );

  api.route(
    'GET',
    '/toolbox/:id/files/download',
    tool(async (_q, res, { cid, url }) => {
      const p = queryPath(url);
      const out = ok(
        await run(cid, guarded('-f', p, ['cat', '--', p]), { max: MAX_UPLOAD, timeoutMs: 120_000 }),
        'download',
      );
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': out.length,
      });
      res.end(out);
    }),
  );

  api.route(
    'POST',
    '/toolbox/:id/files/upload',
    tool(async (req, res, { cid, url }) => {
      const p = queryPath(url);
      const stdin = await readUpload(req);
      ok(
        // Builtins only until `cat` (no dirname subshell, mkdir only when missing): every
        // process costs 100+ ms under gVisor.
        await run(
          cid,
          [
            'sh',
            '-c',
            'd=${1%/*}; [ -d "${d:-/}" ] || mkdir -p -- "$d" || exit 1; exec cat > "$1"',
            'sh',
            p,
          ],
          {
            stdin,
            max: 64 << 10,
            timeoutMs: 120_000,
          },
        ),
        'upload',
      );
      empty(res);
    }),
  );

  api.route(
    'GET',
    '/toolbox/:id/files/find',
    tool(async (_q, res, { cid, url }) => {
      const p = queryPath(url);
      const pattern = url.searchParams.get('pattern') ?? '';
      const r = await run(
        cid,
        guarded('-e', p, [
          'rg',
          '--json',
          '--fixed-strings',
          '--no-ignore',
          '--hidden',
          '--max-count',
          '50',
          '--max-filesize',
          '1M',
          ...EXCLUDES.flatMap((e) => ['-g', `!${e}`]),
          '--',
          pattern,
          p,
        ]),
        { max: 4 << 20 },
      );
      // rg exits 1 for "no matches" and 2 when some entry was unreadable; both keep the matches.
      if (r.timedOut || r.exitCode === NOT_FOUND || r.exitCode > 2) ok(r, 'find');
      const matches: { file: string; line: number; content: string }[] = [];
      for (const line of r.timedOut ? [] : r.output.toString('utf8').split('\n')) {
        try {
          const e = JSON.parse(line) as {
            type: string;
            data: { path: { text?: string }; lines: { text?: string }; line_number: number };
          };
          if (
            e.type === 'match' &&
            e.data.path.text !== undefined &&
            e.data.lines.text !== undefined
          ) {
            matches.push({
              file: e.data.path.text,
              line: e.data.line_number,
              content: e.data.lines.text.replace(/\r?\n$/, ''),
            });
          }
        } catch {
          // blank line, or a line cut by the output cap
        }
      }
      sendJson(res, 200, matches);
    }),
  );

  api.route(
    'GET',
    '/toolbox/:id/files/search',
    tool(async (_q, res, { cid, url }) => {
      const p = queryPath(url);
      const pattern = url.searchParams.get('pattern') ?? '*';
      const r = await run(
        cid,
        guarded('-e', p, [
          'find',
          p,
          '(',
          ...EXCLUDES.flatMap((e, i) => [...(i ? ['-o'] : []), '-name', e]),
          ')',
          '-prune', // never descends into them (-not -path still walked every node_modules file)
          '-o',
          '-type',
          'f',
          '-name',
          pattern,
          '-print0',
        ]),
        { max: 4 << 20 },
      );
      // find exits 1 when some entry was unreadable; like rg's 2 above, the matches still count.
      const partial = !r.timedOut && r.exitCode === 1 && r.output.length > 0 && !r.truncated;
      const out = partial ? r.output : ok(r, 'search');
      sendJson(res, 200, { files: out.toString('utf8').split('\0').filter(Boolean) });
    }),
  );

  api.route(
    'POST',
    '/toolbox/:id/process/execute',
    tool(async (req, res, { cid }) => {
      const b = await readJson(req);
      if (typeof b.command !== 'string' || !b.command)
        throw new HttpError(400, 'command is required');
      const timeout = b.timeout ?? 60;
      if (
        typeof timeout !== 'number' ||
        !Number.isInteger(timeout) ||
        timeout < 1 ||
        timeout > 3600
      ) {
        throw new HttpError(400, 'timeout must be 1-3600 seconds (template builds ask for 900)');
      }
      const cwd = b.cwd === undefined || b.cwd === '' ? WORK_DIR : absPath(b.cwd as string);
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries((b.envs ?? {}) as Record<string, unknown>)) {
        if (!ENV_KEY.test(k) || typeof v !== 'string') throw new HttpError(400, 'invalid envs');
        env[k] = v;
      }
      const r = await docker.exec(cid, {
        argv: ['sh', '-c', b.command],
        cwd,
        env,
        timeoutMs: timeout * 1000,
        maxOutputBytes: SMALL,
      });
      if (r.timedOut) return sendJson(res, 408, {});
      sendJson(res, 200, {
        exitCode: r.exitCode,
        result: r.output.subarray(0, SMALL).toString('utf8'),
      });
    }),
  );

  api.route(
    'POST',
    '/toolbox/:id/process/session',
    tool(async (req, res, { id }) => {
      store.addSession(id, sessionId((await readJson(req)).sessionId as string | undefined));
      empty(res);
    }),
  );

  api.route(
    'POST',
    '/toolbox/:id/process/session/:sid/exec',
    tool(async (req, res, { id, cid, p }) => {
      const sid = sessionId(p.sid);
      const { command } = await readJson(req);
      if (typeof command !== 'string' || !command) throw new HttpError(400, 'command is required');
      if (!store.hasSession(id, sid)) throw new HttpError(404, 'session not found');
      await docker.execDetached(cid, {
        argv: [
          'setsid',
          'sh',
          '-c',
          `echo $$ > /tmp/.sbx-session-${sid}; exec sh -c "$1"`,
          'sh',
          command,
        ],
        cwd: WORK_DIR,
        maxOutputBytes: SMALL,
      });
      empty(res);
    }),
  );

  api.route(
    'DELETE',
    '/toolbox/:id/process/session/:sid',
    tool(async (_q, res, { id, cid, p }) => {
      const sid = sessionId(p.sid);
      if (!store.hasSession(id, sid)) throw new HttpError(404, 'session not found');
      await run(cid, [
        'sh',
        '-c',
        'kill -TERM -$(cat /tmp/.sbx-session-$1) 2>/dev/null; rm -f /tmp/.sbx-session-$1',
        'sh',
        sid,
      ]);
      store.removeSession(id, sid);
      empty(res);
    }),
  );
}
