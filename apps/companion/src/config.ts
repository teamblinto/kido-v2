import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';

import {
  LOCAL_AGENT_PROVIDERS,
  type LocalAgentProvider,
  localAgentDeviceTokenSchema,
  localAgentPermissionModeSchema,
  localAgentWorkspaceIdSchema,
} from '@repo/contracts';

import { log } from './log.ts';

/**
 * Local state (spec 040 § 7): `config.json` (server, device id, workspaces, permission ceiling,
 * provider overrides) and `credentials.json` (the device token alone). Paths live here and never
 * leave the machine; the server only ever sees a workspace's opaque id and label.
 */

export function companionHome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (env.BAIOS_COMPANION_HOME) return resolve(env.BAIOS_COMPANION_HOME);
  if (platform === 'win32') {
    return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'BAIOS', 'companion');
  }
  if (platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'BAIOS', 'companion');
  }
  // XDG: an empty value means unset, hence `||`.
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'baios', 'companion');
}

const providerSettingsSchema = z.object({
  /** Absolute path to the CLI, instead of a PATH lookup. */
  binary: z.string().min(1).optional(),
  /** `false` turns the provider off on this computer whatever the server allows. */
  enabled: z.boolean().optional(),
  /** Claude only: `--setting-sources`; unset keeps the person's normal settings. */
  settingSources: z.string().min(1).optional(),
});

export type ProviderSettings = z.output<typeof providerSettingsSchema>;

const workspaceEntrySchema = z.object({
  id: localAgentWorkspaceIdSchema,
  label: z.string().trim().min(1).max(100),
  path: z.string().min(1),
});

export type WorkspaceEntry = z.output<typeof workspaceEntrySchema>;

const configSchema = z.object({
  deviceId: z.string().nullable().default(null),
  /** Runs at once; a further `run.start` is refused rather than queued. */
  maxConcurrentRuns: z.number().int().min(1).max(16).default(2),
  maxPermissionMode: localAgentPermissionModeSchema.default('default'),
  /** Accept sandbox tool mode runs (no workspace) on this computer; off unless turned on here. */
  sandboxRuns: z.boolean().default(false),
  providers: z
    .object({
      claude: providerSettingsSchema.prefault({}),
      codex: providerSettingsSchema.prefault({}),
    })
    .prefault({}),
  server: z.string().nullable().default(null),
  workspaces: z.array(workspaceEntrySchema).default([]),
});

export type CompanionConfig = z.output<typeof configSchema>;

const credentialsSchema = z.object({ deviceToken: localAgentDeviceTokenSchema });

const PRIVATE_FILE = 0o600;
const PRIVATE_DIR = 0o700;

export class ConfigStore {
  readonly home: string;

  constructor(home: string = companionHome()) {
    this.home = home;
  }

  get configPath(): string {
    return join(this.home, 'config.json');
  }

  get credentialsPath(): string {
    return join(this.home, 'credentials.json');
  }

  load(): CompanionConfig {
    const raw = this.readJson(this.configPath);
    const parsed = configSchema.safeParse(raw ?? {});
    if (!parsed.success) {
      throw new Error(`${this.configPath} is not valid (${parsed.error.issues[0]?.message}).`);
    }
    return parsed.data;
  }

  save(config: CompanionConfig): void {
    this.writePrivate(this.configPath, config);
  }

  loadToken(): string | null {
    const parsed = credentialsSchema.safeParse(this.readJson(this.credentialsPath));
    return parsed.success ? parsed.data.deviceToken : null;
  }

  saveToken(deviceToken: string): void {
    const outside = relative(homedir(), this.home);
    if (outside === '..' || outside.startsWith(`..${sep}`) || isAbsolute(outside)) {
      log.warn(
        `The device token is stored outside your user profile (${this.home}); other accounts on this computer may be able to read it.`,
      );
    }
    this.writePrivate(this.credentialsPath, { deviceToken }, true);
  }

  clearToken(): void {
    rmSync(this.credentialsPath, { force: true });
  }

  private readJson(path: string): unknown {
    if (!existsSync(path)) return undefined;
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as unknown;
    } catch {
      throw new Error(`${path} is not valid JSON; fix or delete it.`);
    }
  }

  /**
   * Temp file + rename so a crash never leaves half a file; 0600 file, 0700 dir on POSIX. A secret
   * on Windows gets an owner-only ACL before the rename (a same-volume rename keeps it).
   */
  private writePrivate(path: string, value: unknown, secret = false): void {
    mkdirSync(this.home, { mode: PRIVATE_DIR, recursive: true });
    if (process.platform !== 'win32') chmodSync(this.home, PRIVATE_DIR);
    const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, {
        flag: 'wx',
        mode: PRIVATE_FILE,
      });
      if (secret && process.platform === 'win32') restrictToOwner(temp);
      renameSync(temp, path);
    } finally {
      rmSync(temp, { force: true });
    }
  }
}

/** Windows: drop inherited ACEs and grant only this user. Best effort, no shell. */
function restrictToOwner(path: string): void {
  const result = spawnSync(
    'icacls',
    [path, '/inheritance:r', '/grant:r', `${userInfo().username}:F`],
    { shell: false, stdio: 'ignore', windowsHide: true },
  );
  if (result.error || result.status !== 0) {
    log.warn(
      `Could not restrict access to ${basename(path)} to your account (icacls failed); it keeps the folder's permissions.`,
    );
  }
}

/** Hosted mode (spec 041): in memory only, nothing read or written; Claude alone, no workspaces. */
export function hostedConfig(server: string): CompanionConfig {
  return configSchema.parse({ providers: { codex: { enabled: false } }, server });
}

export function isProviderEnabled(config: CompanionConfig, provider: LocalAgentProvider): boolean {
  return config.providers[provider].enabled !== false;
}

/** Registers a directory and returns its entry; the same directory twice keeps its first id. */
export function addWorkspace(
  config: CompanionConfig,
  path: string,
  label?: string,
): WorkspaceEntry {
  const real = realpathSync(resolve(path));
  if (!statSync(real).isDirectory()) throw new Error(`${real} is not a directory.`);
  const existing = config.workspaces.find((workspace) => workspace.path === real);
  if (existing) return existing;
  const entry = workspaceEntrySchema.parse({
    id: `ws_${randomBytes(12).toString('base64url')}`,
    label: (label ?? basename(real)) || real,
    path: real,
  });
  config.workspaces.push(entry);
  return entry;
}

export function removeWorkspace(config: CompanionConfig, id: string): boolean {
  const before = config.workspaces.length;
  config.workspaces = config.workspaces.filter((workspace) => workspace.id !== id);
  return config.workspaces.length !== before;
}

const SETTABLE_KEYS = [
  'maxPermissionMode',
  'maxConcurrentRuns',
  'sandboxRuns',
  ...LOCAL_AGENT_PROVIDERS.flatMap((provider) => [`${provider}.enabled`, `${provider}.binary`]),
  'claude.settingSources',
] as const;

/** `config set <key> <value>`; an empty value clears an optional setting. */
export function setConfigValue(config: CompanionConfig, key: string, value: string): void {
  if (key === 'maxPermissionMode') {
    const mode = localAgentPermissionModeSchema.safeParse(value);
    if (!mode.success) throw new Error('maxPermissionMode must be plan, default or acceptEdits.');
    config.maxPermissionMode = mode.data;
    return;
  }
  if (key === 'sandboxRuns') {
    if (value !== 'true' && value !== 'false')
      throw new Error('sandboxRuns must be true or false.');
    config.sandboxRuns = value === 'true';
    return;
  }
  if (key === 'maxConcurrentRuns') {
    const count = Number(value);
    if (!Number.isInteger(count) || count < 1 || count > 16) {
      throw new Error('maxConcurrentRuns must be a whole number from 1 to 16.');
    }
    config.maxConcurrentRuns = count;
    return;
  }
  const [provider, setting] = key.split('.') as [string, string | undefined];
  const settings = (config.providers as Record<string, ProviderSettings | undefined>)[provider];
  if (!settings || !(SETTABLE_KEYS as readonly string[]).includes(key)) {
    throw new Error(`Unknown setting ${key}. Settable: ${SETTABLE_KEYS.join(', ')}.`);
  }
  if (setting === 'enabled') {
    if (value !== 'true' && value !== 'false') throw new Error(`${key} must be true or false.`);
    settings.enabled = value === 'true';
  } else if (setting === 'binary') {
    settings.binary = value ? resolve(value) : undefined;
  } else if (setting === 'settingSources') {
    settings.settingSources = value || undefined;
  }
}
