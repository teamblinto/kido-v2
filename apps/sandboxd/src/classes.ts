import { readFileSync, renameSync, writeFileSync } from 'node:fs';

import type { Config } from './config.ts';
import type { ContainerSpec } from './docker.ts';

export type SandboxClass = 'project' | 'agent' | 'build';

const GiB = 1024 ** 3;

export function classOf(labels: Record<string, string>): SandboxClass {
  if (labels.baios === 'agent-home') return 'agent';
  if (labels['forge.kind'] === 'build') return 'build';
  return 'project';
}

/**
 * gVisor's netstack cannot reach Docker's embedded resolver (127.0.0.11) on a user-defined bridge,
 * and `--dns` does not help (Docker still points resolv.conf at 127.0.0.11), so gVisor sandboxes
 * get this file instead. Written at boot; left alone when unchanged, because a running sandbox's
 * bind mount pins the old inode.
 */
export function writeResolvConf(cfg: Pick<Config, 'dataDir' | 'dns'>): string {
  // Not path.join: the path is handed to dockerd as a Linux bind source.
  const file = `${cfg.dataDir}/resolv.sandbox.conf`;
  const body = `${cfg.dns.map((a) => `nameserver ${a}\n`).join('')}options timeout:2 attempts:2\n`;
  let current: string | undefined;
  try {
    current = readFileSync(file, 'utf8');
  } catch {
    /* first boot */
  }
  if (current !== body) {
    writeFileSync(`${file}.tmp`, body, { mode: 0o644 });
    renameSync(`${file}.tmp`, file);
  }
  return file;
}

export function containerSpec(
  cfg: Config,
  id: string,
  image: string,
  cls: SandboxClass,
  labels: Record<string, string>,
): ContainerSpec {
  const limits = {
    project: { memory: 1.5 * GiB, swap: 2 * GiB, pids: 512, cpus: 1e9, disk: '5G' },
    agent: { memory: 768 * 1024 ** 2, swap: 768 * 1024 ** 2, pids: 128, cpus: 5e8, disk: '2G' },
    build: { memory: 2 * GiB, swap: 2 * GiB, pids: 1024, cpus: 2e9, disk: '10G' },
  }[cls];
  const proxy = `http://${cfg.egressListen.host}:${cfg.egressListen.port}`;
  const runtime = cls === 'agent' ? 'runc' : cfg.runtimeProject;
  const env =
    cls === 'agent'
      ? [`HTTP_PROXY=${proxy}`, `HTTPS_PROXY=${proxy}`, 'NO_PROXY=', 'NODE_USE_ENV_PROXY=1']
      : [];
  return {
    name: `sbx-${id}`,
    image,
    labels: { ...labels, 'sandboxd.id': id, 'sandboxd.owner': '1' },
    env,
    user: '1000:1000',
    network: cls === 'agent' ? 'sbx-agent' : 'sbx-proj',
    hostConfig: {
      Runtime: runtime,
      Init: true,
      Memory: limits.memory,
      MemorySwap: limits.swap,
      PidsLimit: limits.pids,
      NanoCpus: limits.cpus,
      ...(cfg.storageQuota && { StorageOpt: { size: limits.disk } }),
      Ulimits: [{ Name: 'nofile', Soft: 4096, Hard: 4096 }],
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      Privileged: false,
      // Design §12: under memory pressure the kernel kills a sandbox before the platform.
      OomScoreAdj: 500,
      // The only host mount a sandbox ever gets (see writeResolvConf). dockerd resolves the source
      // on the host, so dataDir must be the same path on the host and in sandboxd's container
      // (compose mounts /var/lib/sandboxd at /var/lib/sandboxd). runc keeps Docker's DNS.
      ...(runtime === 'runsc' && {
        Binds: [`${cfg.dataDir}/resolv.sandbox.conf:/etc/resolv.conf:ro`],
      }),
    },
  };
}
