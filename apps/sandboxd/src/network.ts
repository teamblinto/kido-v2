import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DockerPort, NetworkOpts } from './docker.ts';

const script = join(dirname(fileURLToPath(import.meta.url)), '../../../infra/sandboxd/firewall.sh');

const NETWORKS: [string, NetworkOpts][] = [
  [
    'sbx-agent',
    {
      internal: true,
      icc: false,
      subnet: '172.30.0.0/24',
      gateway: '172.30.0.1',
      bridgeName: 'sbx-agent0',
    },
  ],
  [
    'sbx-proj',
    {
      internal: false,
      icc: false,
      subnet: '172.30.1.0/24',
      gateway: '172.30.1.1',
      bridgeName: 'sbx-proj0',
    },
  ],
];

export async function ensureNetworks(docker: DockerPort): Promise<void> {
  for (const [name, opts] of NETWORKS) await docker.ensureNetwork(name, opts);
}

/** 'skipped' = local dev only (config refuses SANDBOXD_FIREWALL=off when SANDBOXD_REAL=1). */
export function firewallMode(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): 'on' | 'skipped' {
  return platform !== 'linux' || env.SANDBOXD_FIREWALL === 'off' ? 'skipped' : 'on';
}

const run = (sub: 'apply' | 'check') =>
  new Promise<{ ok: boolean; err: string }>((resolve) => {
    execFile('bash', [script, sub], (e, _out, stderr) => resolve({ ok: !e, err: stderr.trim() }));
  });

export async function applyFirewall(): Promise<void> {
  const r = await run('apply');
  if (!r.ok) throw new Error(`firewall.sh apply failed: ${r.err}`);
}

export async function checkFirewall(): Promise<boolean> {
  return (await run('check')).ok;
}
