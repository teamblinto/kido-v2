import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseArgs } from './cli.ts';
import { COMPANION_VERSION } from './version.ts';

const main = fileURLToPath(new URL('main.ts', import.meta.url));

describe('baios-companion', () => {
  it('prints its usage', () => {
    const result = spawnSync(process.execPath, [main], { encoding: 'utf8' });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: baios-companion');
  });

  it('exits 2 with usage on an unknown command or option', () => {
    const result = spawnSync(process.execPath, [main, 'start', '--bogus'], { encoding: 'utf8' });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Unknown option --bogus');
  });

  it('reports the package version', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    expect(COMPANION_VERSION).toBe(pkg.version);
  });

  it('parses flags with spaces or =, and booleans', () => {
    expect(parseArgs(['pair', '--server=https://a', '--name', 'My PC', '--verbose'])).toEqual({
      flags: new Map<string, string | true>([
        ['server', 'https://a'],
        ['name', 'My PC'],
        ['verbose', true],
      ]),
      positionals: ['pair'],
    });
    expect(() => parseArgs(['pair', '--server'])).toThrow('needs a value');
  });
});
