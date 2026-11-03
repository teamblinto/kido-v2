import { mkdtempSync, writeFileSync } from 'node:fs';
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
