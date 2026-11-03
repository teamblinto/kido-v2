import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureNetworks, firewallMode } from '../src/network.ts';
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
  it.skipIf(!root)('apply is idempotent', () => {
    const count = () =>
      execFileSync('iptables', ['-w', '-S', 'SBX-FWD']).toString().split('\n').length;
    try {
      execFileSync('bash', [script, 'apply']);
      const n = count();
      execFileSync('bash', [script, 'apply']);
      expect(count()).toBe(n);
      execFileSync('bash', [script, 'check']);
    } finally {
      execFileSync('bash', [script, 'remove']);
    }
  });
});
