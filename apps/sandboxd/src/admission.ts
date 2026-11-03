import { readFileSync } from 'node:fs';

import type { Config } from './config.ts';
import type { DockerPort } from './docker.ts';
import { log } from './log.ts';
import type { Store } from './store.ts';

const MAX_START_ATTEMPTS = 3;
let warned = false;

/** Bytes of MemAvailable; treated as plentiful where /proc/meminfo is unreadable (non-Linux dev). */
export function procMemAvailable(): number {
  try {
    const m = /^MemAvailable:\s+(\d+) kB/m.exec(readFileSync('/proc/meminfo', 'utf8'));
    if (m) return Number(m[1]) * 1024;
  } catch {
    // fall through
  }
  if (!warned) {
    warned = true;
    log('warn', 'cannot read /proc/meminfo; treating memory as available');
  }
  return Number.MAX_SAFE_INTEGER;
}

/** `p`, or a rejection after `ms`, so a hung Docker call cannot freeze the drain. */
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, no) => {
    t = setTimeout(() => no(new Error(`${what} timed out after ${String(ms)} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

export class Admission {
  private queue: string[] = [];
  private chain: Promise<void> = Promise.resolve();
  // shortcut: failure state lives in memory; a restart retries via recover().
  private readonly attempts = new Map<string, number>();
  private readonly failed = new Set<string>();

  private readonly deps: {
    cfg: Pick<Config, 'maxRunning' | 'minMemAvailableBytes'>;
    store: Store;
    docker: DockerPort;
    memAvailable?: () => number;
    /** Cap on each Docker call the drain makes; default 60 s. */
    controlTimeoutMs?: number;
  };

  constructor(deps: Admission['deps']) {
    this.deps = deps;
  }

  private call<T>(p: Promise<T>, what: string): Promise<T> {
    return within(p, this.deps.controlTimeoutMs ?? 60_000, what);
  }

  /** Queue the sandbox for the next `tick`; one already running just becomes `started`. */
  async request(id: string): Promise<void> {
    const { store, docker } = this.deps;
    const cid = store.get(id)?.containerId;
    if (cid === undefined) return;
    this.failed.delete(id);
    this.attempts.delete(id);
    // Written before the inspect: a /stop or delete landing meanwhile overwrites it, and below
    // nothing is written unless the row is still the `queued` this call put there.
    store.setState(id, 'queued');
    if (!this.queue.includes(id)) this.queue.push(id);
    const c = cid ? await docker.inspect(cid) : null;
    if (
      (c?.status === 'running' || c?.status === 'restarting') &&
      store.get(id)?.desired === 'queued'
    ) {
      this.cancel(id);
      store.setState(id, 'started');
    }
  }

  /** True once starting it failed MAX_START_ATTEMPTS times; cleared by the next `request`. */
  hasFailed(id: string): boolean {
    return this.failed.has(id);
  }

  cancel(id: string): void {
    this.queue = this.queue.filter((q) => q !== id);
  }

  size(): number {
    return this.queue.length;
  }

  /**
   * On boot: re-queue wanted-running sandboxes whose container is not running, oldest first, and
   * settle `queued` rows whose container already runs (a crash between docker start and the write).
   */
  async recover(): Promise<void> {
    const { store, docker } = this.deps;
    for (const r of store.all()) {
      if (r.desired === 'stopped' || r.containerId === null) continue;
      const c = await docker.inspect(r.containerId);
      if (c && (c.status !== 'running' || r.desired === 'queued')) await this.request(r.id);
    }
  }

  /** Serialised: concurrent calls run one after another so a sandbox is never started twice. */
  tick(): Promise<void> {
    this.chain = this.chain
      .then(() => this.drain())
      .catch((err: unknown) => {
        log('error', 'admission tick failed', {
          err: err instanceof Error ? err.message : String(err),
        });
      });
    return this.chain;
  }

  /** Containers Docker reports running (or restarting), whatever their row wants. */
  async runningCount(): Promise<number> {
    const { store, docker } = this.deps;
    let n = 0;
    for (const r of store.all()) {
      if (r.containerId === null) continue;
      const c = await this.call(docker.inspect(r.containerId), 'docker inspect');
      if (c && (c.status === 'running' || c.status === 'restarting')) n++;
    }
    return n;
  }

  private async drain(): Promise<void> {
    const { cfg, store, docker, memAvailable = procMemAvailable } = this.deps;
    if (this.queue.length === 0) return;
    let running = await this.runningCount();
    while (this.queue.length > 0 && running < cfg.maxRunning) {
      if (memAvailable() < cfg.minMemAvailableBytes) return;
      const id = this.queue.shift()!;
      const row = store.get(id);
      if (row?.containerId == null || row.desired !== 'queued') continue;
      try {
        await this.call(docker.start(row.containerId), 'docker start');
      } catch (err) {
        const n = (this.attempts.get(id) ?? 0) + 1;
        this.attempts.set(id, n);
        if (n < MAX_START_ATTEMPTS) this.queue.push(id);
        else this.failed.add(id);
        log('error', 'sandbox start failed', {
          'sandboxd.id': id,
          attempt: n,
          err: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      // A stop or delete may have landed while the start was in flight.
      const now = store.get(id);
      if (now?.desired === 'queued' || now?.desired === 'started') {
        store.setState(id, 'started');
        running++;
      } else if (now) {
        await this.call(docker.stop(row.containerId, 10), 'docker stop');
      } else {
        await this.call(docker.remove(row.containerId), 'docker remove');
      }
    }
  }
}
