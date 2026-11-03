import type { Config } from './config.ts';
import type { ContainerSpec } from './docker.ts';

export type SandboxClass = 'project' | 'agent' | 'build';

const GiB = 1024 ** 3;

export function classOf(labels: Record<string, string>): SandboxClass {
  if (labels.baios === 'agent-home') return 'agent';
  if (labels['forge.kind'] === 'build') return 'build';
  return 'project';
}

export function containerSpec(
  cfg: Config,
  id: string,
  image: string,
  cls: SandboxClass,
  labels: Record<string, string>,
  proxyEnv: string[],
): ContainerSpec {
  const limits = {
    project: { memory: 1.5 * GiB, swap: 2 * GiB, pids: 512, cpus: 1e9, disk: '5G' },
    agent: { memory: 768 * 1024 ** 2, swap: 768 * 1024 ** 2, pids: 128, cpus: 5e8, disk: '2G' },
    build: { memory: 2 * GiB, swap: 2 * GiB, pids: 1024, cpus: 2e9, disk: '10G' },
  }[cls];
  const proxy = `http://${cfg.egressListen.host}:${cfg.egressListen.port}`;
  const env = [...proxyEnv];
  if (cls === 'agent') {
    env.push(`HTTP_PROXY=${proxy}`, `HTTPS_PROXY=${proxy}`, 'NO_PROXY=', 'NODE_USE_ENV_PROXY=1');
  }
  return {
    name: `sbx-${id}`,
    image,
    labels: { ...labels, 'sandboxd.id': id, 'sandboxd.owner': '1' },
    env,
    user: '1000:1000',
    network: cls === 'agent' ? 'sbx-agent' : 'sbx-proj',
    hostConfig: {
      Runtime: cls === 'agent' ? 'runc' : cfg.runtimeProject,
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
    },
  };
}
