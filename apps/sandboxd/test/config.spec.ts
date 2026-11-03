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
    expect(loadConfig({ ...env, SANDBOXD_API_HOST: 'a.test' }).real).toBe(true);
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
      egressAgentDefault: [
        'api.anthropic.com',
        'claude.ai',
        'console.anthropic.com',
        'statsig.anthropic.com',
      ],
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
      SANDBOXD_PUBLIC_URL: 'http://sbx:1',
    });
    expect(c).toMatchObject({
      imageAllow: ['a', 'b'],
      storageQuota: true,
      publicUrl: 'http://sbx:1',
    });
  });
});
