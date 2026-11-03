import { execFile } from 'node:child_process';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Config } from './config.ts';
import type { DockerPort, NetworkOpts } from './docker.ts';
import { log } from './log.ts';

const script = join(dirname(fileURLToPath(import.meta.url)), '../../../infra/sandboxd/firewall.sh');

// The control bridge compose creates (compose.yaml `sbx-ctl`); sandboxes are never attached.
const CTL_BRIDGE = 'sbx-ctl0';
const CTL_GATEWAY = '172.30.2.1';

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

/** Single source of truth for firewall.sh: the same constants the networks are created from. */
export function firewallEnv(
  cfg: Pick<Config, 'egressListen' | 'listen' | 'previewListen' | 'dns'>,
  ifaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): Record<string, string> {
  const [agent, proj] = [NETWORKS[0]![1], NETWORKS[1]![1]];
  const host = cfg.listen.host;
  const ctlIf =
    host === CTL_GATEWAY
      ? CTL_BRIDGE
      : (Object.entries(ifaces).find(
          ([, a]) => host !== '0.0.0.0' && a?.some((x) => x.address === host),
        )?.[0] ?? '');
  return {
    SBX_EGRESS_PORT: String(cfg.egressListen.port),
    SBX_AGENT_GW: cfg.egressListen.host,
    // /tmp: the compose service has a read-only root filesystem with only /tmp writable.
    SBX_SNAPSHOT: '/tmp/sbx-firewall.snapshot',
    SBX_ALL: '172.30.0.0/23',
    SBX_AGENT_NET: agent.subnet!,
    SBX_PROJ_NET: proj.subnet!,
    SBX_AGENT_IF: agent.bridgeName!,
    SBX_PROJ_IF: proj.bridgeName!,
    // The listeners' address is pinned to the interface that owns it: the sbx-ctl bridge on a
    // single host (it may not exist yet at boot, so by name), the WireGuard interface on the
    // staging mesh. No owner (wildcard, interface not up): no pin.
    SBX_CTL_IF: ctlIf,
    SBX_CTL_IP: ctlIf ? cfg.listen.host : '',
    SBX_CTL_PORTS: `${cfg.listen.port},${cfg.previewListen.port}`,
    SBX_DNS: cfg.dns.join(','),
  };
}

type Run = (sub: 'apply' | 'check') => Promise<boolean>;

export function realRunner(
  cfg: Pick<Config, 'egressListen' | 'listen' | 'previewListen' | 'dns'>,
): Run {
  return (sub) =>
    new Promise((resolve) => {
      execFile(
        'bash',
        [script, sub],
        { timeout: 10_000, env: { ...process.env, ...firewallEnv(cfg) } },
        (e, _out, stderr) => {
          if (e && sub === 'apply')
            log('error', 'firewall.sh apply failed', { stderr: stderr.trim() });
          resolve(!e);
        },
      );
    });
}

export async function applyFirewall(
  cfg: Pick<Config, 'egressListen' | 'listen' | 'previewListen' | 'dns'>,
): Promise<void> {
  if (!(await realRunner(cfg)('apply'))) throw new Error('firewall.sh apply failed');
}

/**
 * Every 30 s verify the rules and re-apply after an external flush; never overlaps. `status()`
 * serves /healthz from a <=5 s cache so unauthenticated hits don't spawn iptables.
 */
export function startFirewallGuard(run: Run, onError: (msg: string) => void) {
  let cached: { at: number; ok: boolean } | undefined;
  let inflight: Promise<boolean> | undefined;
  let busy = false;
  const check = (): Promise<boolean> =>
    (inflight ??= run('check')
      .then((ok) => {
        cached = { at: Date.now(), ok };
        return ok;
      })
      .finally(() => (inflight = undefined)));
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void (async () => {
      if (await check()) return;
      onError('firewall rules missing or altered, re-applying');
      await run('apply');
      await check();
    })()
      .catch((e: unknown) => onError(`firewall guard failed: ${String(e)}`))
      .finally(() => (busy = false));
  }, 30_000);
  return {
    status: async () => (cached && Date.now() - cached.at < 5000 ? cached.ok : check()),
    stop: () => clearInterval(timer),
  };
}
