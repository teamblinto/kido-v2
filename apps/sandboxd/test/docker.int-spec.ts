import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { containerSpec } from '../src/classes.ts';
import type { Config } from '../src/config.ts';
import { DockerodePort } from '../src/docker.ts';

const docker = new DockerodePort();
const up = await docker.ping();
if (!up) console.error('SANDBOXD-DOCKER-SKIP: docker not reachable, skipping integration tests');

describe.skipIf(!up)('DockerodePort', () => {
  const cfg = {
    runtimeProject: 'runc',
    egressListen: { host: '172.30.0.1', port: 3988 },
    storageQuota: false,
  } as Config;
  const tag = `sandboxd-int:${randomBytes(4).toString('hex')}`;
  let cid = '';

  beforeAll(async () => {
    await docker.ensureNetwork('sbx-proj', { internal: false });
    const id = `int-${randomBytes(4).toString('hex')}`;
    cid = await docker.create(containerSpec(cfg, id, 'forge/sandbox-base:1', 'project', {}, []));
    await docker.start(cid);
  }, 60_000);

  afterAll(async () => {
    if (cid) await docker.remove(cid);
    await docker.removeImage(tag);
  });

  const run = (argv: string[], extra: { stdin?: Buffer; timeoutMs?: number } = {}) =>
    docker.exec(cid, {
      argv,
      timeoutMs: extra.timeoutMs ?? 10_000,
      maxOutputBytes: 1 << 20,
      ...extra,
    });

  it('runs as uid 1000', async () => {
    const r = await run(['id', '-u']);
    expect(r.timedOut).toBe(false);
    if (!r.timedOut) expect(r.output.toString().trim()).toBe('1000');
  });

  it('main process runs as uid 1000', async () => {
    const r = await run(['ps', '-o', 'uid=', '-p', '1']);
    expect(r.timedOut).toBe(false);
    if (!r.timedOut) expect(r.output.toString().trim()).toBe('1000');
  });

  it('round-trips 200 KiB binary stdin', async () => {
    const data = randomBytes(200 * 1024);
    const r = await run(['cat'], { stdin: data });
    expect(r.timedOut).toBe(false);
    if (!r.timedOut) expect(r.output.equals(data)).toBe(true);
  });

  it('kills the process group on timeout', async () => {
    const r = await run(['sleep', '30'], { timeoutMs: 500 });
    expect(r).toEqual({ timedOut: true });
    const ps = await run(['ps', '-eo', 'args']);
    if (ps.timedOut) throw new Error('ps timed out');
    expect(ps.output.toString()).not.toMatch(/sleep 30/);
  });

  it('on timeout also kills children that left the process group, and leaves nothing in /tmp', async () => {
    const before = await run(['ls', '-A', '/tmp']);
    const r = await run(['sh', '-c', 'setsid sleep 31 & sleep 30'], { timeoutMs: 1000 });
    expect(r).toEqual({ timedOut: true });
    const ps = await run(['ps', '-eo', 'args']);
    if (ps.timedOut || before.timedOut) throw new Error('timed out');
    expect(ps.output.toString()).not.toMatch(/sleep 3[01]/);
    const after = await run(['ls', '-A', '/tmp']);
    if (after.timedOut) throw new Error('ls timed out');
    expect(after.output.toString()).toBe(before.output.toString());
  });

  it('commits, then removes', async () => {
    await docker.commit(cid, tag);
    expect(await docker.imageExists(tag)).toBe(true);
    await docker.remove(cid);
    expect(await docker.inspect(cid)).toBeNull();
    cid = '';
  });
});
