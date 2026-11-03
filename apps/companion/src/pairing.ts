import { spawn } from 'node:child_process';
import { hostname } from 'node:os';

import {
  type LocalAgentPlatform,
  pairingTokenResponseSchema,
  startPairingResponseSchema,
} from '@repo/contracts';

import type { ConfigStore } from './config.ts';
import { ApiClient, HttpError, normalizeServerUrl } from './http.ts';
import { sleep, truncate } from './util.ts';
import { COMPANION_VERSION } from './version.ts';

/**
 * `pair` (spec 040 § 3 decision 3, RFC 8628): introduce this computer, show the person the user
 * code and where to approve it, poll until BAIOS answers, and keep the device token locally.
 */

export function platformName(platform: NodeJS.Platform = process.platform): LocalAgentPlatform {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  return 'linux';
}

/** Best effort, no shell: the URL is also printed, so a failure here costs nothing. */
export function openBrowser(url: string): void {
  const [command, args]: [string, string[]] =
    process.platform === 'win32'
      ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, {
      detached: true,
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // printed instead
  }
}

export interface PairOptions {
  name?: string;
  open?: (url: string) => void;
  print: (line: string) => void;
  server: string;
  store: ConfigStore;
}

export async function pair(options: PairOptions): Promise<{ deviceId: string }> {
  const server = normalizeServerUrl(options.server);
  const api = new ApiClient(server, null);
  const name = truncate((options.name ?? hostname()).trim() || 'My computer', 100);
  const started = await api.post(
    '/local-agent/pairings',
    { companionVersion: COMPANION_VERSION, name, platform: platformName() },
    startPairingResponseSchema,
  );
  const verification = new URL(started.verificationUri);
  options.print(
    `To pair "${name}" with BAIOS, open\n\n  ${verification.href}\n\nand confirm this code:\n\n  ${started.userCode}\n\nWaiting for approval…`,
  );
  if (verification.protocol === 'https:' || verification.protocol === 'http:') {
    (options.open ?? openBrowser)(verification.href);
  }

  let intervalMs = started.intervalSeconds * 1_000;
  const deadline = Date.parse(started.expiresAt);
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    let answer;
    try {
      answer = await api.post(
        '/local-agent/pairings/token',
        { deviceCode: started.deviceCode },
        pairingTokenResponseSchema,
      );
    } catch (error) {
      // Network blips and 5xx: keep polling until the code expires; 429: poll slower.
      if (error instanceof HttpError && !error.retryable) throw error;
      if (error instanceof HttpError && error.status === 429) intervalMs += 5_000;
      continue;
    }
    if (answer.status === 'pending') continue;
    if (answer.status === 'denied') throw new Error('Pairing was denied in BAIOS.');
    if (answer.status !== 'approved') break;
    const config = options.store.load();
    options.store.saveToken(answer.deviceToken);
    config.server = server;
    config.deviceId = answer.deviceId;
    options.store.save(config);
    return { deviceId: answer.deviceId };
  }
  throw new Error('The pairing code expired. Run `baios-companion pair` again.');
}
