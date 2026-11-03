import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';

import { tempDir, waitFor } from '../test/helpers.ts';
import { scrub, scrubTokens } from './log.ts';
import {
  killAllChildrenSync,
  quoteForCmd,
  resolveBinary,
  spawnBinary,
  StderrTail,
  waitForExit,
  withoutBaiosVars,
} from './process.ts';
import { redactPaths } from './util.ts';

describe('resolveBinary', () => {
  it('prefers a real .exe anywhere on PATH over a .cmd shim (Windows rules)', () => {
    const root = tempDir();
    const shims = join(root, 'npm');
    const native = join(root, 'bin');
    mkdirSync(shims);
    mkdirSync(native);
    writeFileSync(join(shims, 'claude.cmd'), '');
    writeFileSync(join(native, 'claude.exe'), '');
    const env = {
      PATH: [shims, native].join(process.platform === 'win32' ? ';' : ':'),
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
    };
    expect(resolveBinary('claude', undefined, env, 'win32')?.path).toBe(join(native, 'claude.exe'));
    const shimOnly = resolveBinary('claude', undefined, { ...env, PATH: shims }, 'win32');
    expect(shimOnly).toMatchObject({ path: join(shims, 'claude.cmd'), viaCmd: true });
    expect(resolveBinary('gemini', undefined, env, 'win32')).toBeNull();
  });

  it('runs a .mjs override with this node, and rejects a missing override', () => {
    const script = join(tempDir(), 'fake.mjs');
    writeFileSync(script, '');
    expect(resolveBinary('claude', script)).toMatchObject({
      command: process.execPath,
      prefixArgs: [script],
    });
    expect(resolveBinary('claude', `${script}.missing`)).toBeNull();
  });
});

describe('spawnBinary environment', () => {
  it('passes no BAIOS_* variable to a CLI (L1)', async () => {
    const script = join(tempDir(), 'env.mjs');
    writeFileSync(
      script,
      'process.stdout.write(JSON.stringify(Object.keys(process.env).filter((k) => /^(baios_|keep_me)/i.test(k))));',
    );
    const binary = resolveBinary('claude', script);
    if (!binary) throw new Error('no binary');
    const env = {
      ...process.env,
      BAIOS_ALLOW_INSECURE_HTTP: '1',
      BAIOS_SERVER_URL: 'https://baios.example',
      BAIOS_TOKEN_FILE: '/run/token',
      baios_lower: 'x',
      KEEP_ME: 'yes',
    };
    expect(withoutBaiosVars(env)).not.toHaveProperty('BAIOS_TOKEN_FILE');
    const child = spawnBinary(binary, [], { env });
    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString()));
    await waitForExit(child, 5_000);
    await waitFor(() => out.length > 0);
    expect(JSON.parse(out)).toEqual(['KEEP_ME']);
  });
});

describe('quoteForCmd', () => {
  it('quotes, keeps metacharacters inside quotes, and refuses what cmd would expand', () => {
    expect(quoteForCmd('C:\\Program Files (x86)\\a&b')).toBe('"C:\\Program Files (x86)\\a&b"');
    expect(quoteForCmd('dir\\')).toBe('"dir\\\\"');
    for (const bad of ['a"b', '%PATH%', 'a!b', 'a\nb']) expect(() => quoteForCmd(bad)).toThrow();
  });
});

describe('scrubbing', () => {
  it('removes tokens, keys, emails and long opaque strings', () => {
    const text = scrub(
      `Authorization: Bearer abc.def bld_${'x'.repeat(43)} sk-ant-api03-zzzzzzzzzz someone@example.com token=hunter2 ${'Q'.repeat(48)}`,
    );
    expect(text).not.toMatch(/abc\.def|xxxx|zzzz|someone|hunter2|QQQQ/);
  });

  it('keeps a scrubbed, ANSI-free tail of stderr', () => {
    const tail = new StderrTail(2);
    tail.push('\u001b[31mone\u001b[0m\ntwo\nthree key=sk-ant-1234567890abc\npart');
    expect(tail.text()).toBe('three key=sk-[redacted]\npart');
  });
});

describe('redactPaths', () => {
  it('rewrites the home directory to ~ at any depth and truncates long strings', () => {
    const redact = redactPaths(50);
    const out = redact({
      cmd: `ls ${join(homedir(), 'src')}`,
      list: [`${homedir()}-x`],
      long: 'y'.repeat(80),
    });
    expect(out.cmd).toBe(`ls ~${sep}src`);
    // A sibling is not the home directory.
    expect(out.list[0]).toBe(`${homedir()}-x`);
    expect(out.long).toBe(`${'y'.repeat(49)}…`);
  });
});

describe('scrubTokens (agent output sent to BAIOS)', () => {
  it('removes credential-shaped strings and leaves ordinary code and prose intact', () => {
    const key = [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'b3BlbnNzaA==',
      '-----END OPENSSH PRIVATE KEY-----',
    ];
    const secrets = [
      key.join('\n'),
      `sk-ant-api03-${'a'.repeat(30)}`,
      `ghp_${'b'.repeat(36)}`,
      'AKIAABCDEFGHIJKLMNOP',
      `Authorization: Bearer ${'c'.repeat(32)}`,
      `bld_${'d'.repeat(43)}`,
    ];
    const out = scrubTokens(secrets.join('\n'));
    expect(out).not.toMatch(/b3BlbnNzaA|aaaaaaaaaa|bbbbbbbbbb|AKIAABCD|cccccccccc|dddddddddd/);
    const code =
      'const token = getToken(); // see someone@example.com\nexport const hash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";\nawait fetch(url, { headers: { authorization: `Bearer ${token}` } });';
    expect(scrubTokens(code)).toBe(code);
  });

  it('applies to everything redactPaths prepares', () => {
    expect(redactPaths()({ out: `key sk-proj-${'z'.repeat(40)}` }).out).toBe('key sk-[redacted]');
  });
});

describe('killAllChildrenSync', () => {
  it('kills every CLI process the runner started', async () => {
    const script = join(tempDir(), 'sleep.mjs');
    writeFileSync(script, 'setInterval(() => {}, 1000);');
    const child = spawnBinary(resolveBinary('node', script) ?? fail(), []);
    await new Promise((resolve) => child.once('spawn', resolve));
    killAllChildrenSync();
    expect(await waitForExit(child, 5_000)).toBe(true);
  });
});

function fail(): never {
  throw new Error('unresolved');
}
