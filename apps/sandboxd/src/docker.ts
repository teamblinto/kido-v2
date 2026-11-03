import { randomBytes } from 'node:crypto';
import { PassThrough } from 'node:stream';

import Docker from 'dockerode';

export type ContainerStatus =
  | 'created'
  | 'running'
  | 'paused'
  | 'restarting'
  | 'removing'
  | 'exited'
  | 'dead';

export interface ContainerSpec {
  name: string;
  image: string;
  labels: Record<string, string>;
  env: string[];
  hostConfig: object;
  network: 'sbx-agent' | 'sbx-proj';
}

export interface ExecOpts {
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: Buffer;
  timeoutMs: number;
  maxOutputBytes: number;
  /** Default '1000:1000'. */
  user?: string;
}

export type ExecOutcome =
  | { timedOut: false; exitCode: number; output: Buffer; truncated: boolean }
  | { timedOut: true };

export interface DockerEvent {
  action: string;
  cid: string;
  labels: Record<string, string>;
}

export interface DockerPort {
  create(spec: ContainerSpec): Promise<string>;
  start(cid: string): Promise<void>;
  stop(cid: string, timeoutS: number): Promise<void>;
  remove(cid: string): Promise<void>;
  inspect(
    cid: string,
  ): Promise<{ status: ContainerStatus; ip: string | null; startedAt: string } | null>;
  commit(cid: string, repoTag: string): Promise<void>;
  imageExists(ref: string): Promise<boolean>;
  removeImage(ref: string): Promise<'removed' | 'missing' | 'in-use'>;
  exec(cid: string, opts: ExecOpts): Promise<ExecOutcome>;
  execDetached(cid: string, opts: Omit<ExecOpts, 'stdin' | 'timeoutMs'>): Promise<void>;
  ensureNetwork(name: string, opts: { internal: boolean }): Promise<void>;
  events(onEvent: (e: DockerEvent) => void): () => void;
  ping(): Promise<boolean>;
}

const envList = (env?: Record<string, string>) =>
  Object.entries(env ?? {}).map(([k, v]) => `${k}=${v}`);

/** Run `fn`, mapping the given HTTP status codes to a value instead of throwing. */
async function tolerate<T>(fn: () => Promise<T>, map: Record<number, T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const s = (e as { statusCode?: number }).statusCode;
    if (s !== undefined && s in map) return map[s] as T;
    throw e;
  }
}

export class DockerodePort implements DockerPort {
  // No socketPath: dockerode honours DOCKER_HOST and the platform default.
  private readonly docker = new Docker();

  async create(spec: ContainerSpec): Promise<string> {
    const c = await this.docker.createContainer({
      name: spec.name,
      Image: spec.image,
      Labels: spec.labels,
      Env: spec.env,
      HostConfig: { ...spec.hostConfig, NetworkMode: spec.network },
    });
    return c.id;
  }

  async start(cid: string): Promise<void> {
    await tolerate(async () => void (await this.docker.getContainer(cid).start()), {
      304: undefined,
    });
  }

  async stop(cid: string, timeoutS: number): Promise<void> {
    await tolerate(async () => void (await this.docker.getContainer(cid).stop({ t: timeoutS })), {
      304: undefined,
      404: undefined,
    });
  }

  async remove(cid: string): Promise<void> {
    await tolerate(
      async () => void (await this.docker.getContainer(cid).remove({ force: true, v: true })),
      { 404: undefined },
    );
  }

  async inspect(cid: string) {
    const i = await tolerate(() => this.docker.getContainer(cid).inspect(), {
      404: null as never,
    });
    if (!i) return null;
    const nets = Object.values(i.NetworkSettings.Networks ?? {});
    return {
      status: i.State.Status as ContainerStatus,
      ip: nets.find((n) => n.IPAddress)?.IPAddress ?? null,
      startedAt: i.State.StartedAt,
    };
  }

  async commit(cid: string, repoTag: string): Promise<void> {
    const i = repoTag.lastIndexOf(':');
    const hasTag = i > repoTag.lastIndexOf('/');
    await this.docker.getContainer(cid).commit({
      repo: hasTag ? repoTag.slice(0, i) : repoTag,
      tag: hasTag ? repoTag.slice(i + 1) : 'latest',
    });
  }

  async imageExists(ref: string): Promise<boolean> {
    return tolerate(async () => (await this.docker.getImage(ref).inspect(), true), { 404: false });
  }

  async removeImage(ref: string): Promise<'removed' | 'missing' | 'in-use'> {
    return tolerate<'removed' | 'missing' | 'in-use'>(
      async () => (await this.docker.getImage(ref).remove(), 'removed'),
      { 404: 'missing', 409: 'in-use' },
    );
  }

  async exec(cid: string, opts: ExecOpts): Promise<ExecOutcome> {
    const pidFile = `/tmp/.sbx-exec-${randomBytes(8).toString('hex')}`;
    const user = opts.user ?? '1000:1000';
    const exec = await this.docker.getContainer(cid).exec({
      // setsid makes the shell a group leader so a timeout can kill the whole tree.
      Cmd: [
        'setsid',
        'sh',
        '-c',
        `echo $$ > ${pidFile}; "$@"; rc=$?; rm -f ${pidFile}; exit $rc`,
        'sh',
        ...opts.argv,
      ],
      AttachStdout: true,
      AttachStderr: true,
      AttachStdin: !!opts.stdin,
      WorkingDir: opts.cwd,
      Env: envList(opts.env),
      User: user,
    });
    const stream = await exec.start({ hijack: true, stdin: !!opts.stdin });
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    const sink = new PassThrough();
    sink.on('data', (b: Buffer) => {
      const room = opts.maxOutputBytes - size;
      if (b.length > room) truncated = true;
      if (room > 0) {
        chunks.push(b.subarray(0, room));
        size += Math.min(b.length, room);
      }
    });
    this.docker.modem.demuxStream(stream, sink, sink);
    if (opts.stdin) stream.end(opts.stdin);

    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      new Promise<'done'>((resolve, reject) => {
        stream.on('end', () => resolve('done'));
        stream.on('error', reject);
      }),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), opts.timeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));

    if (outcome === 'timeout') {
      stream.destroy();
      await this.runQuiet(
        cid,
        ['sh', '-c', `kill -KILL -$(cat ${pidFile}) 2>/dev/null; rm -f ${pidFile}`],
        user,
      );
      return { timedOut: true };
    }
    const { ExitCode } = await exec.inspect();
    return { timedOut: false, exitCode: ExitCode ?? -1, output: Buffer.concat(chunks), truncated };
  }

  private async runQuiet(cid: string, cmd: string[], user: string): Promise<void> {
    const e = await this.docker.getContainer(cid).exec({ Cmd: cmd, User: user });
    (await e.start({ hijack: true })).resume();
    for (let i = 0; i < 50 && (await e.inspect()).Running; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async execDetached(cid: string, opts: Omit<ExecOpts, 'stdin' | 'timeoutMs'>): Promise<void> {
    const exec = await this.docker.getContainer(cid).exec({
      Cmd: opts.argv,
      WorkingDir: opts.cwd,
      Env: envList(opts.env),
      User: opts.user ?? '1000:1000',
    });
    await exec.start({ Detach: true });
  }

  async ensureNetwork(name: string, opts: { internal: boolean }): Promise<void> {
    const found = await this.docker.listNetworks({ filters: { name: [name] } });
    if (found.some((n) => n.Name === name)) return;
    await this.docker.createNetwork({ Name: name, Driver: 'bridge', Internal: opts.internal });
  }

  events(onEvent: (e: DockerEvent) => void): () => void {
    let stopped = false;
    let current: { destroy(): void } | undefined;
    const retry = (): void => {
      if (!stopped) setTimeout(() => void connect(), 1000).unref();
    };
    const connect = async (): Promise<void> => {
      try {
        const s = await this.docker.getEvents({
          filters: { type: ['container'], label: ['sandboxd.owner=1'] },
        });
        current = s as unknown as { destroy(): void };
        if (stopped) return current.destroy();
        let buf = '';
        s.on('data', (d: Buffer) => {
          buf += d.toString();
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines.filter(Boolean)) {
            const ev = JSON.parse(line) as {
              Action: string;
              Actor: { ID: string; Attributes?: Record<string, string> };
            };
            onEvent({ action: ev.Action, cid: ev.Actor.ID, labels: ev.Actor.Attributes ?? {} });
          }
        });
        s.on('close', retry);
        s.on('error', retry);
      } catch {
        retry();
      }
    };
    void connect();
    return () => {
      stopped = true;
      current?.destroy();
    };
  }

  async ping(): Promise<boolean> {
    try {
      await this.docker.ping();
      return true;
    } catch {
      return false;
    }
  }
}
