import { randomUUID } from 'node:crypto';

import type {
  ContainerSpec,
  ContainerStatus,
  DockerEvent,
  DockerPort,
  ExecOpts,
  ExecOutcome,
} from '../src/docker.ts';

type ExecHandler = (cid: string, opts: ExecOpts) => ExecOutcome | Promise<ExecOutcome>;

/** In-memory DockerPort for unit tests; records every call in `calls`. */
export class FakeDocker implements DockerPort {
  calls: { method: string; args: unknown[] }[] = [];
  containers = new Map<string, { spec: ContainerSpec; status: ContainerStatus }>();
  images = new Set<string>();
  networks = new Map<string, { internal: boolean; icc?: boolean }>();
  execHandler: ExecHandler = () => ({
    timedOut: false,
    exitCode: 0,
    output: Buffer.alloc(0),
    truncated: false,
  });
  alive = true;
  private listeners = new Set<(e: DockerEvent) => void>();

  private rec(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }

  emit(e: DockerEvent): void {
    this.listeners.forEach((l) => l(e));
  }

  create(spec: ContainerSpec) {
    this.rec('create', spec);
    const id = randomUUID();
    this.containers.set(id, { spec, status: 'created' });
    return Promise.resolve(id);
  }
  start(cid: string) {
    this.rec('start', cid);
    const c = this.containers.get(cid);
    if (c) c.status = 'running';
    return Promise.resolve();
  }
  stop(cid: string, timeoutS: number) {
    this.rec('stop', cid, timeoutS);
    const c = this.containers.get(cid);
    if (c) c.status = 'exited';
    return Promise.resolve();
  }
  remove(cid: string) {
    this.rec('remove', cid);
    this.containers.delete(cid);
    return Promise.resolve();
  }
  inspect(cid: string) {
    this.rec('inspect', cid);
    const c = this.containers.get(cid);
    return Promise.resolve(
      c ? { status: c.status, ip: '172.31.0.2', startedAt: new Date(0).toISOString() } : null,
    );
  }
  commit(cid: string, repoTag: string) {
    this.rec('commit', cid, repoTag);
    this.images.add(repoTag);
    return Promise.resolve();
  }
  imageExists(ref: string) {
    this.rec('imageExists', ref);
    return Promise.resolve(this.images.has(ref));
  }
  removeImage(ref: string) {
    this.rec('removeImage', ref);
    return Promise.resolve(this.images.delete(ref) ? ('removed' as const) : ('missing' as const));
  }
  async exec(cid: string, opts: ExecOpts) {
    this.rec('exec', cid, opts);
    return this.execHandler(cid, opts);
  }
  execDetached(cid: string, opts: Omit<ExecOpts, 'stdin' | 'timeoutMs'>) {
    this.rec('execDetached', cid, opts);
    return Promise.resolve();
  }
  ensureNetwork(name: string, opts: { internal: boolean; icc?: boolean }) {
    this.rec('ensureNetwork', name, opts);
    const have = this.networks.get(name);
    if (have && have.internal !== opts.internal) {
      return Promise.reject(new Error(`network ${name} exists with internal=${have.internal}`));
    }
    this.networks.set(name, opts);
    return Promise.resolve();
  }
  events(onEvent: (e: DockerEvent) => void) {
    this.listeners.add(onEvent);
    return () => void this.listeners.delete(onEvent);
  }
  ping() {
    return Promise.resolve(this.alive);
  }
}
