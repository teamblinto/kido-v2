import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseArgs } from './cli.ts';
import { COMPANION_VERSION } from './version.ts';

const main = fileURLToPath(new URL('main.ts', import.meta.url));
const run = (...args: string[]) =>
  spawnSync(process.execPath, [main, ...args], { encoding: 'utf8' });

// Each case spawns Node synchronously, several times; under a parallel `turbo test` that outlasts 5 s.
describe('runner CLI', { timeout: 30_000 }, () => {
  it('prints its usage', () => {
    const result = run();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('start --hosted');
  });

  it('exits 2 with usage on an unknown command or option', () => {
    expect(run('start', '--hosted', '--bogus')).toMatchObject({ status: 2 });
    expect(run('start', '--hosted', '--bogus').stderr).toContain('Unknown option --bogus');
    for (const command of ['pair', 'login', 'workspace', 'status']) {
      expect(run(command).stderr).toContain(`Unknown command ${command}`);
    }
  });

  it('refuses a plain `start`: it runs only inside an agent home', () => {
    const result = run('start');

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('use `start --hosted`');
  });

  it('reports the package version', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    expect(COMPANION_VERSION).toBe(pkg.version);
    expect(run('version').stdout.trim()).toBe(COMPANION_VERSION);
  });

  it('parses boolean flags, and nothing else', () => {
    expect(parseArgs(['start', '--hosted', '--verbose'])).toEqual({
      flags: new Set(['hosted', 'verbose']),
      positionals: ['start'],
    });
    expect(() => parseArgs(['start', '--hosted=1'])).toThrow('Unknown option');
  });
});
