import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig } from '../src/config.ts';

const dir = () => mkdtempSync(join(tmpdir(), 'sbxd-'));

describe('loadConfig', () => {
  it('throws when both key sources are set', () => {
    expect(() =>
      loadConfig({ SANDBOXD_API_KEY: 'a', SANDBOXD_API_KEY_FILE: '/x', SANDBOXD_DATA_DIR: dir() }),
    ).toThrow();
  });
  it('throws when neither key source is set', () => {
    expect(() => loadConfig({ SANDBOXD_DATA_DIR: dir() })).toThrow();
  });
  it('reads and trims the key file', () => {
    const d = dir();
    writeFileSync(join(d, 'k'), '  secret\n');
    expect(loadConfig({ SANDBOXD_API_KEY_FILE: join(d, 'k'), SANDBOXD_DATA_DIR: d }).apiKey).toBe(
      'secret',
    );
  });
  it('requires previewPublicUrl to be an absolute http(s) URL', () => {
    const env = { SANDBOXD_API_KEY: 'k', SANDBOXD_DATA_DIR: dir() };
    for (const bad of ['pv.example.com', 'ftp://x.test', '/rel'])
      expect(() => loadConfig({ ...env, SANDBOXD_PREVIEW_PUBLIC_URL: bad })).toThrow(
        /SANDBOXD_PREVIEW_PUBLIC_URL/,
      );
    expect(
      loadConfig({ ...env, SANDBOXD_PREVIEW_PUBLIC_URL: 'https://pv.example.com' })
        .previewPublicUrl,
    ).toBe('https://pv.example.com');
  });
  it('SANDBOXD_REAL refuses firewall=off and requires the API host', () => {
    const env = { SANDBOXD_API_KEY: 'k', SANDBOXD_DATA_DIR: dir(), SANDBOXD_REAL: '1' };
    expect(() =>
      loadConfig({ ...env, SANDBOXD_API_HOST: 'a.test', SANDBOXD_FIREWALL: 'off' }),
    ).toThrow(/FIREWALL/);
    expect(() => loadConfig(env)).toThrow(/SANDBOXD_API_HOST/);
    expect(loadConfig({ ...env, SANDBOXD_API_HOST: 'a.test' }).apiHost).toBe('a.test');
  });
  it('numbers: positive integers, ports 1-65535', () => {
    const env = { SANDBOXD_API_KEY: 'k', SANDBOXD_DATA_DIR: dir() };
    for (const bad of ['0', '-1', '1.5', 'abc', '', ' '])
      for (const k of ['SANDBOXD_MAX_RUNNING', 'SANDBOXD_MIN_MEM_AVAILABLE_MB'])
        expect(() => loadConfig({ ...env, [k]: bad })).toThrow(new RegExp(k));
    expect(
      loadConfig({ ...env, SANDBOXD_MAX_RUNNING: '2', SANDBOXD_MIN_MEM_AVAILABLE_MB: '64' }),
    ).toMatchObject({ maxRunning: 2, minMemAvailableBytes: 64 * 1024 * 1024 });
    for (const k of ['SANDBOXD_LISTEN', 'SANDBOXD_PREVIEW_LISTEN', 'SANDBOXD_EGRESS_LISTEN'])
      for (const bad of ['h:0', 'h:65536', 'h:-1', 'h:1.5', 'h:', ':80', 'h'])
        expect(() => loadConfig({ ...env, [k]: bad })).toThrow(/host:port/);
    expect(loadConfig({ ...env, SANDBOXD_LISTEN: '10.0.0.1:65535' }).listen).toEqual({
      host: '10.0.0.1',
      port: 65535,
    });
  });
  it('SANDBOXD_DNS refuses private and non-public resolvers', () => {
    const env = { SANDBOXD_API_KEY: 'k', SANDBOXD_DATA_DIR: dir() };
    for (const bad of [
      '10.0.0.2',
      '192.168.1.1',
      '127.0.0.53',
      '172.17.0.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '1.1.1.1,10.0.0.2',
    ])
      expect(() => loadConfig({ ...env, SANDBOXD_DNS: bad })).toThrow(/SANDBOXD_DNS/);
  });
  it('SANDBOXD_DNS: IPv4 literals only, default 1.1.1.1 and 9.9.9.9', () => {
    const env = { SANDBOXD_API_KEY: 'k', SANDBOXD_DATA_DIR: dir() };
    expect(loadConfig(env).dns).toEqual(['1.1.1.1', '9.9.9.9']);
    expect(loadConfig({ ...env, SANDBOXD_DNS: ' 8.8.8.8 , 8.8.4.4' }).dns).toEqual([
      '8.8.8.8',
      '8.8.4.4',
    ]);
    for (const bad of ['', 'dns.google', '1.1.1', '256.1.1.1', '::1', '1.1.1.1 -j ACCEPT'])
      expect(() => loadConfig({ ...env, SANDBOXD_DNS: bad })).toThrow(/SANDBOXD_DNS/);
  });
  it('applies defaults and generates the preview secret once', () => {
    const d = dir();
    const env = { SANDBOXD_API_KEY: 'k', SANDBOXD_DATA_DIR: d };
    const c = loadConfig(env);
    expect(c).toMatchObject({
      nodeId: 'n1',
      listen: { host: '127.0.0.1', port: 3986 },
      previewListen: { host: '127.0.0.1', port: 3987 },
      previewPublicUrl: 'http://127.0.0.1:3987',
      publicUrl: 'http://127.0.0.1:3986',
      egressListen: { host: '172.30.0.1', port: 3988 },
      runtimeProject: 'runsc',
      maxRunning: 22,
      minMemAvailableBytes: 1024 * 1024 * 1024,
      storageQuota: false,
      imageAllow: [],
      egressAgentDefault: ['api.anthropic.com', 'claude.ai', 'platform.claude.com'],
    });
    expect(c.previewSecret.length).toBeGreaterThanOrEqual(32);
    expect(loadConfig(env).previewSecret.equals(c.previewSecret)).toBe(true);
  });
  describe('preview secret file', () => {
    const env = (d: string, f: string) => ({
      SANDBOXD_API_KEY: 'k',
      SANDBOXD_DATA_DIR: d,
      SANDBOXD_PREVIEW_SECRET_FILE: f,
    });
    it('generates on ENOENT', () => {
      const d = dir();
      const f = join(d, 'new');
      const c = loadConfig(env(d, f));
      expect(readFileSync(f).equals(c.previewSecret)).toBe(true);
    });
    it('throws on empty file', () => {
      const d = dir();
      writeFileSync(join(d, 's'), '');
      expect(() => loadConfig(env(d, join(d, 's')))).toThrow(/32 bytes/);
    });
    it('throws on short file', () => {
      const d = dir();
      writeFileSync(join(d, 's'), 'short');
      expect(() => loadConfig(env(d, join(d, 's')))).toThrow(/32 bytes/);
    });
    it('reads a valid file unchanged', () => {
      const d = dir();
      const b = Buffer.alloc(40, 7);
      writeFileSync(join(d, 's'), b);
      expect(loadConfig(env(d, join(d, 's'))).previewSecret.equals(b)).toBe(true);
    });
    it('rethrows non-ENOENT errors without overwriting', () => {
      const d = dir();
      expect(() => loadConfig(env(d, d))).toThrow(/EISDIR/);
    });
  });
  it('parses overrides', () => {
    const c = loadConfig({
      SANDBOXD_API_KEY: 'k',
      SANDBOXD_DATA_DIR: dir(),
      SANDBOXD_IMAGE_ALLOW: 'a, b',
      SANDBOXD_STORAGE_QUOTA: '1',
      SANDBOXD_DOCKER_ROOT: '/var/lib/docker-sbx',
      SANDBOXD_PUBLIC_URL: 'http://sbx:1',
    });
    expect(c).toMatchObject({
      imageAllow: ['a', 'b'],
      storageQuota: true,
      dockerRoot: '/var/lib/docker-sbx',
      publicUrl: 'http://sbx:1',
    });
  });
});
