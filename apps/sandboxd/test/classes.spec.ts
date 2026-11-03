import { describe, expect, it } from 'vitest';

import { classOf, containerSpec } from '../src/classes.ts';
import type { Config } from '../src/config.ts';

const cfg = (storageQuota: boolean) =>
  ({
    runtimeProject: 'runsc',
    egressListen: { host: '172.30.0.1', port: 3988 },
    storageQuota,
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
    const s = containerSpec(cfg(false), 'a1', 'img', 'agent', { baios: 'agent-home' }, ['X=1']);
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
        'X=1',
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
    const s = containerSpec(cfg(true), 'p1', 'img', 'project', {}, []);
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
    const s = containerSpec(cfg(true), 'b1', 'img', 'build', {}, []);
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
    const on = hc(containerSpec(cfg(true), 'x', 'img', cls, {}, []));
    const off = hc(containerSpec(cfg(false), 'x', 'img', cls, {}, []));
    for (const h of [on, off]) {
      expect(h).toMatchObject({
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        Privileged: false,
        Init: true,
        Ulimits: [{ Name: 'nofile', Soft: 4096, Hard: 4096 }],
      });
      expect(h).not.toHaveProperty('Binds');
    }
    expect(containerSpec(cfg(true), 'x', 'img', cls, {}, []).user).toBe('1000:1000');
    expect(on).toHaveProperty('StorageOpt');
    expect(off).not.toHaveProperty('StorageOpt');
  });
});
