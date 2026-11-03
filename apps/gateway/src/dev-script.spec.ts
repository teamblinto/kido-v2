import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/** The node flags `pnpm dev` starts the gateway with, minus the watcher and the entry point. */
function devFlags(): string[] {
  const { scripts } = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { scripts: { dev: string } };
  const [node, ...args] = scripts.dev.split(' ');
  expect(node).toBe('node');
  return args.filter((arg) => arg !== '--watch' && arg !== 'src/main.ts');
}

/** What `process.env.PROBE` reads under the dev flags, run from `cwd`. */
function probe(cwd: string): string {
  return execFileSync(process.execPath, [...devFlags(), '-p', 'String(process.env.PROBE)'], {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
  }).trim();
}

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

describe('the dev script', () => {
  it("loads the gateway's .env", () => {
    const dir = mkdtempSync(join(tmpdir(), 'gateway-dev-'));
    dirs.push(dir);
    writeFileSync(join(dir, '.env'), 'PROBE=from-dotenv\n');

    expect(probe(dir)).toBe('from-dotenv');
  });

  it('still starts without a .env', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gateway-dev-'));
    dirs.push(dir);

    expect(probe(dir)).toBe('undefined');
  });
});
