import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureNetworks, firewallEnv, firewallMode, startFirewallGuard } from '../src/network.ts';
import { FakeDocker } from './fake-docker.ts';

const script = join(dirname(fileURLToPath(import.meta.url)), '../../../infra/sandboxd/firewall.sh');
const has = (cmd: string) => spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0;
const root = process.platform === 'linux' && process.getuid?.() === 0 && has('iptables');

describe('ensureNetworks', () => {
  it('creates both bridges with exact options', async () => {
    const f = new FakeDocker();
    await ensureNetworks(f);
    expect(f.calls.map((c) => c.args)).toEqual([
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
    ]);
  });
});

describe('firewallEnv', () => {
  it('derives port and gateway from the egress listen address', () => {
    expect(firewallEnv({ egressListen: { host: '172.30.0.9', port: 4000 } })).toMatchObject({
      SBX_EGRESS_PORT: '4000',
      SBX_AGENT_GW: '172.30.0.9',
      SBX_SNAPSHOT: '/tmp/sbx-firewall.snapshot',
      SBX_ALL: '172.30.0.0/23',
      SBX_AGENT_NET: '172.30.0.0/24',
      SBX_PROJ_NET: '172.30.1.0/24',
      SBX_AGENT_IF: 'sbx-agent0',
      SBX_PROJ_IF: 'sbx-proj0',
    });
  });
});

describe('startFirewallGuard', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('re-applies when check fails, never overlaps, and caches status', async () => {
    let ok = false;
    const run = vi.fn(async (sub: 'apply' | 'check') => {
      await new Promise((r) => setTimeout(r, 40_000)); // slower than the interval
      if (sub === 'apply') ok = true;
      return sub === 'check' ? ok : true;
    });
    const g = startFirewallGuard(run, vi.fn());
    await vi.advanceTimersByTimeAsync(30_000); // tick 1 starts check
    await vi.advanceTimersByTimeAsync(30_000); // tick 2 skipped: still busy
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run.mock.calls.map((c) => c[0]).slice(0, 3)).toEqual(['check', 'apply', 'check']);
    g.stop();
  });

  it('serves status from a 5 s cache', async () => {
    const run = vi.fn(() => Promise.resolve(true));
    const g = startFirewallGuard(run, vi.fn());
    expect(await g.status()).toBe(true);
    expect(await g.status()).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6000);
    await g.status();
    expect(run).toHaveBeenCalledTimes(2);
    g.stop();
  });
});

describe('firewallMode', () => {
  it('skips only off-mode or non-Linux', () => {
    expect(firewallMode({ SANDBOXD_FIREWALL: 'off' }, 'linux')).toBe('skipped');
    expect(firewallMode({}, 'win32')).toBe('skipped');
    expect(firewallMode({}, 'linux')).toBe('on');
  });
});

describe('firewall.sh', () => {
  it('parses with bash -n', () => {
    execFileSync('bash', ['-n', script]);
  });
  it.skipIf(!has('shellcheck'))('passes shellcheck', () => {
    execFileSync('shellcheck', [script]);
  });
  it.skipIf(!root)('apply is idempotent, check detects flush and remove', () => {
    const out = (...a: string[]) => execFileSync('iptables', ['-w', ...a]).toString();
    const sh = (sub: string) => execFileSync('bash', [script, sub]);
    const fails = (sub: string) => spawnSync('bash', [script, sub]).status !== 0;
    const jumps = () => out('-S', 'DOCKER-USER') + out('-S', 'INPUT');
    const NL = String.fromCharCode(10);
    const count = (t: string) => t.split('SBX-').length;
    try {
      sh('apply');
      const n = out('-S', 'SBX-FWD').split(NL).length;
      const j = count(jumps());
      sh('apply');
      expect(out('-S', 'SBX-FWD').split(NL).length).toBe(n);
      expect(count(jumps())).toBe(j);
      sh('check');
      out('-F', 'SBX-FWD');
      expect(fails('check')).toBe(true);
      sh('apply');
      sh('check');
    } finally {
      sh('remove');
    }
    expect(fails('check')).toBe(true);
  });
});
