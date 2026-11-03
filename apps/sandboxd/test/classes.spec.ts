import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { classOf, containerSpec, writeResolvConf } from '../src/classes.ts';
import type { Config } from '../src/config.ts';

const cfg = (storageQuota: boolean, runtimeProject = 'runsc') =>
  ({
    runtimeProject,
    egressListen: { host: '172.30.0.1', port: 3988 },
    storageQuota,
    dataDir: '/var/lib/sandboxd',
    dns: ['1.1.1.1', '9.9.9.9'],
  }) as Config;

describe('classOf', () => {
  it('maps labels to classes', () => {
    expect(classOf({ baios: 'agent-home' })).toBe('agent');
    expect(classOf({ 'forge.kind': 'build' })).toBe('build');
    expect(classOf({ 'forge.kind': 'project' })).toBe('project');
    expect(classOf({ 'forge.kind': 'pool' })).toBe('project');
    expect(classOf({ whatever: 'x' })).toBe('project');
  });
});

describe('containerSpec', () => {
  const hc = (s: ReturnType<typeof containerSpec>) => s.hostConfig as Record<string, unknown>;

  it('agent', () => {
    const s = containerSpec(cfg(false), 'a1', 'img', 'agent', { baios: 'agent-home' });
    expect(hc(s)).toMatchObject({
      Runtime: 'runc',
      Memory: 805306368,
      MemorySwap: 805306368,
      PidsLimit: 128,
      NanoCpus: 5e8,
      OomScoreAdj: 500,
    });
    expect(s.network).toBe('sbx-agent');
    expect(s.env).toEqual(
      expect.arrayContaining([
        'HTTP_PROXY=http://172.30.0.1:3988',
        'HTTPS_PROXY=http://172.30.0.1:3988',
        'NO_PROXY=',
        'NODE_USE_ENV_PROXY=1',
      ]),
    );
    expect(s.labels).toMatchObject({
      'sandboxd.id': 'a1',
      'sandboxd.owner': '1',
      baios: 'agent-home',
    });
  });

  it('project', () => {
    const s = containerSpec(cfg(true), 'p1', 'img', 'project', {});
    expect(hc(s)).toMatchObject({
      Runtime: 'runsc',
      Memory: 1610612736,
      MemorySwap: 2147483648,
      PidsLimit: 512,
      StorageOpt: { size: '5G' },
    });
    expect(s.network).toBe('sbx-proj');
    expect(s.env).toEqual([]);
  });

  it('build', () => {
    const s = containerSpec(cfg(true), 'b1', 'img', 'build', {});
    expect(hc(s)).toMatchObject({
      Memory: 2147483648,
      MemorySwap: 2147483648,
      NanoCpus: 2e9,
      PidsLimit: 1024,
      StorageOpt: { size: '10G' },
    });
    expect(s.network).toBe('sbx-proj');
  });

  it.each(['project', 'agent', 'build'] as const)('%s hardening, StorageOpt gated', (cls) => {
    const on = hc(containerSpec(cfg(true), 'x', 'img', cls, {}));
    const off = hc(containerSpec(cfg(false), 'x', 'img', cls, {}));
    for (const h of [on, off]) {
      expect(h).toMatchObject({
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        Privileged: false,
        Init: true,
        Ulimits: [{ Name: 'nofile', Soft: 4096, Hard: 4096 }],
      });
      // The one host mount there is: gVisor classes get sandboxd's resolv.conf, read-only.
      if (cls === 'agent') expect(h).not.toHaveProperty('Binds');
      else expect(h.Binds).toEqual(['/var/lib/sandboxd/resolv.sandbox.conf:/etc/resolv.conf:ro']);
    }
    expect(containerSpec(cfg(true), 'x', 'img', cls, {}).user).toBe('1000:1000');
    expect(on).toHaveProperty('StorageOpt');
    expect(off).not.toHaveProperty('StorageOpt');
  });

  it('runc project sandboxes keep Docker DNS: no host mount at all', () => {
    for (const cls of ['project', 'build'] as const)
      expect(hc(containerSpec(cfg(true, 'runc'), 'x', 'img', cls, {}))).not.toHaveProperty('Binds');
  });
});

describe('writeResolvConf', () => {
  it('writes the resolvers world-readable, and leaves an unchanged file (and inode) alone', () => {
    const d = mkdtempSync(join(tmpdir(), 'sbxd-'));
    const f = writeResolvConf({ dataDir: d, dns: ['1.1.1.1', '9.9.9.9'] });
    expect(f).toBe(`${d}/resolv.sandbox.conf`);
    expect(readFileSync(f, 'utf8')).toBe(
      'nameserver 1.1.1.1\nnameserver 9.9.9.9\noptions timeout:2 attempts:2\n',
    );
    if (process.platform !== 'win32') expect(statSync(f).mode & 0o777).toBe(0o644);
    const ino = statSync(f).ino;
    writeResolvConf({ dataDir: d, dns: ['1.1.1.1', '9.9.9.9'] });
    expect(statSync(f).ino).toBe(ino);
    writeResolvConf({ dataDir: d, dns: ['8.8.8.8'] });
    expect(readFileSync(f, 'utf8')).toBe('nameserver 8.8.8.8\noptions timeout:2 attempts:2\n');
  });
});
