import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';

import { tempDir } from '../test/helpers.ts';
import {
  addWorkspace,
  companionHome,
  ConfigStore,
  removeWorkspace,
  setConfigValue,
} from './config.ts';

describe('companionHome', () => {
  it('follows each platform convention, and the env override wins', () => {
    expect(companionHome({ APPDATA: 'C:\\AppData' }, 'win32')).toBe(
      join('C:\\AppData', 'BAIOS', 'companion'),
    );
    expect(companionHome({}, 'darwin')).toBe(
      join(homedir(), 'Library', 'Application Support', 'BAIOS', 'companion'),
    );
    expect(companionHome({ XDG_CONFIG_HOME: '/x' }, 'linux')).toBe(
      join('/x', 'baios', 'companion'),
    );
    expect(companionHome({ XDG_CONFIG_HOME: '' }, 'linux')).toBe(
      join(homedir(), '.config', 'baios', 'companion'),
    );
    expect(companionHome({ BAIOS_COMPANION_HOME: '/tmp/c' }, 'linux')).toMatch(/c$/);
  });
});

describe('ConfigStore', () => {
  it('defaults, round-trips, and keeps the token out of config.json', () => {
    const store = new ConfigStore(join(tempDir(), 'home'));
    const config = store.load();
    expect(config).toMatchObject({ maxPermissionMode: 'default', server: null, workspaces: [] });
    config.server = 'https://baios.example';
    store.save(config);
    store.saveToken(`bld_${'b'.repeat(43)}`);
    expect(store.load().server).toBe('https://baios.example');
    expect(store.loadToken()).toBe(`bld_${'b'.repeat(43)}`);
    expect(readFileSync(store.configPath, 'utf8')).not.toContain('bld_');
    expect(readdirSync(store.home).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    store.clearToken();
    expect(store.loadToken()).toBeNull();
  });

  it.skipIf(process.platform === 'win32')(
    'writes 0600 files in a 0700 folder (POSIX only: Windows has no mode bits, its ACLs follow the profile folder)',
    () => {
      const store = new ConfigStore(join(tempDir(), 'home'));
      store.saveToken(`bld_${'c'.repeat(43)}`);
      store.save(store.load());
      expect(statSync(store.home).mode & 0o777).toBe(0o700);
      expect(statSync(store.credentialsPath).mode & 0o777).toBe(0o600);
      expect(statSync(store.configPath).mode & 0o777).toBe(0o600);
    },
  );
});

describe('credentials on Windows', () => {
  it.runIf(process.platform === 'win32')(
    'restrict the token file to this account, with no inherited access (L4)',
    () => {
      const store = new ConfigStore(join(tempDir(), 'home'));
      store.saveToken(`bld_${'e'.repeat(43)}`);
      const acl = spawnSync('icacls', [store.credentialsPath], { encoding: 'utf8' }).stdout;
      const entries = acl.split(/\r?\n/).filter((line) => line.includes(':('));
      expect(entries).toHaveLength(1);
      expect(entries[0]).toContain(`${userInfo().username}:(F)`);
      expect(acl).not.toContain('(I)');
    },
  );
});

describe('workspaces and settings', () => {
  it('registers a real directory once under an opaque id, and removes it', () => {
    const store = new ConfigStore(join(tempDir(), 'home'));
    const config = store.load();
    const dir = join(tempDir(), 'project');
    mkdirSync(dir);
    const entry = addWorkspace(config, dir, 'My project');
    expect(entry.id).toMatch(/^ws_[A-Za-z0-9_-]{16}$/);
    expect(entry.id).not.toContain('project');
    expect(addWorkspace(config, join(dir, '.'))).toBe(entry);
    expect(() => addWorkspace(config, join(dir, 'missing'))).toThrow();
    expect(removeWorkspace(config, entry.id)).toBe(true);
    expect(config.workspaces).toEqual([]);
  });

  it('sets only known keys with valid values', () => {
    const config = new ConfigStore(join(tempDir(), 'home')).load();
    setConfigValue(config, 'maxPermissionMode', 'plan');
    setConfigValue(config, 'codex.enabled', 'false');
    expect(config.maxPermissionMode).toBe('plan');
    expect(config.providers.codex.enabled).toBe(false);
    expect(() => setConfigValue(config, 'maxPermissionMode', 'bypassPermissions')).toThrow();
    expect(() => setConfigValue(config, 'gemini.enabled', 'true')).toThrow();
    expect(() => setConfigValue(config, 'codex.settingSources', 'user')).toThrow();
    expect(config.maxConcurrentRuns).toBe(2);
    setConfigValue(config, 'maxConcurrentRuns', '3');
    expect(config.maxConcurrentRuns).toBe(3);
    for (const bad of ['0', '1.5', 'two', '17']) {
      expect(() => setConfigValue(config, 'maxConcurrentRuns', bad)).toThrow();
    }
    expect(config.sandboxRuns).toBe(false);
    setConfigValue(config, 'sandboxRuns', 'true');
    expect(config.sandboxRuns).toBe(true);
    expect(() => setConfigValue(config, 'sandboxRuns', 'yes')).toThrow();
  });
});
