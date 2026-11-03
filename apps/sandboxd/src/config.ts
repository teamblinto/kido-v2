import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface HostPort {
  host: string;
  port: number;
}

export interface Config {
  nodeId: string;
  apiKey: string;
  listen: HostPort;
  previewListen: HostPort;
  previewPublicUrl: string;
  /** Base URL the API uses to reach sandboxd; the toolbox URL is `${publicUrl}/toolbox`. */
  publicUrl: string;
  previewSecret: Buffer;
  egressListen: HostPort;
  dataDir: string;
  runtimeProject: string;
  maxRunning: number;
  minMemAvailableBytes: number;
  imageAllow: string[];
  /** BAIOS API/callback host allowed through the proxy and firewall. */
  apiHost: string;
  egressAgentDefault: string[];
  storageQuota: boolean;
}

const list = (v: string | undefined, dflt: string[] = []): string[] =>
  v === undefined
    ? dflt
    : v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

function hostPort(v: string): HostPort {
  const i = v.lastIndexOf(':');
  const port = Number(v.slice(i + 1));
  if (i < 1 || !Number.isInteger(port)) throw new Error(`invalid host:port "${v}"`);
  return { host: v.slice(0, i), port };
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const { SANDBOXD_API_KEY: inline, SANDBOXD_API_KEY_FILE: file } = env;
  if (Boolean(inline) === Boolean(file)) {
    throw new Error('set exactly one of SANDBOXD_API_KEY or SANDBOXD_API_KEY_FILE');
  }
  const apiKey = (inline ?? readFileSync(file!, 'utf8')).trim();
  if (!apiKey) throw new Error('sandboxd API key is empty');

  const dataDir = env.SANDBOXD_DATA_DIR ?? '/var/lib/sandboxd';
  mkdirSync(dataDir, { recursive: true });
  const secretFile = env.SANDBOXD_PREVIEW_SECRET_FILE ?? join(dataDir, 'preview-secret');
  let previewSecret: Buffer;
  try {
    previewSecret = readFileSync(secretFile);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    previewSecret = randomBytes(32);
    writeFileSync(secretFile, previewSecret, { mode: 0o600 });
  }
  if (previewSecret.length < 32) {
    throw new Error(`preview secret file ${secretFile} must hold at least 32 bytes`);
  }

  const publicUrl = env.SANDBOXD_PREVIEW_PUBLIC_URL;
  if (publicUrl !== undefined) {
    let proto: string | undefined;
    try {
      proto = new URL(publicUrl).protocol;
    } catch {
      /* falls through to the error */
    }
    if (proto !== 'http:' && proto !== 'https:') {
      throw new Error(
        `SANDBOXD_PREVIEW_PUBLIC_URL must be an absolute http(s) URL, got "${publicUrl}"`,
      );
    }
  }
  const listen = hostPort(env.SANDBOXD_LISTEN ?? '127.0.0.1:3986');
  const previewListen = hostPort(env.SANDBOXD_PREVIEW_LISTEN ?? '127.0.0.1:3987');
  return {
    nodeId: env.SANDBOXD_NODE_ID ?? 'n1',
    apiKey,
    listen,
    previewListen,
    previewPublicUrl:
      env.SANDBOXD_PREVIEW_PUBLIC_URL ?? `http://${previewListen.host}:${previewListen.port}`,
    publicUrl: env.SANDBOXD_PUBLIC_URL ?? `http://${listen.host}:${listen.port}`,
    previewSecret,
    egressListen: hostPort(env.SANDBOXD_EGRESS_LISTEN ?? '172.30.0.1:3988'),
    dataDir,
    runtimeProject: env.SANDBOXD_RUNTIME_PROJECT ?? 'runsc',
    maxRunning: Number(env.SANDBOXD_MAX_RUNNING ?? 22),
    minMemAvailableBytes: Number(env.SANDBOXD_MIN_MEM_AVAILABLE_MB ?? 1024) * 1024 * 1024,
    imageAllow: list(env.SANDBOXD_IMAGE_ALLOW),
    apiHost: env.SANDBOXD_API_HOST ?? '',
    egressAgentDefault: list(env.SANDBOXD_EGRESS_AGENT_DEFAULT, [
      'api.anthropic.com',
      'claude.ai',
      'console.anthropic.com',
      'statsig.anthropic.com',
    ]),
    storageQuota: env.SANDBOXD_STORAGE_QUOTA === '1',
  };
}
