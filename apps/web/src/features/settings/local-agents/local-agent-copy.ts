import type {
  LocalAgentAuthMethod,
  LocalAgentPlatform,
  LocalAgentProvider,
  LocalAgentProviderStatus,
} from '@repo/contracts';

/** Plain-text product names only (spec 040 § 2): no marks, no logos. */
export const PROVIDER_NAME: Record<LocalAgentProvider, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

export const PLATFORM_NAME: Record<LocalAgentPlatform, string> = {
  linux: 'Linux',
  macos: 'macOS',
  windows: 'Windows',
};

export const AUTH_METHOD_NAME: Record<LocalAgentAuthMethod, string> = {
  api_key: 'API key',
  cloud_provider: 'cloud provider',
  subscription: 'subscription',
  unknown: 'unknown method',
};

/**
 * How the companion is run until it ships as an installer (spec 040 § 8). One constant, so the
 * day it becomes `npx baios-companion` is a one-line change.
 */
export const COMPANION_PAIR_COMMAND = (origin: string): string =>
  `pnpm --filter @repo/companion build && node apps/companion/dist/main.js pair --server ${origin}`;

export const START_COMMAND = 'baios-companion start';

export const WORKSPACE_ADD_COMMAND = 'baios-companion workspace add <path>';

export function loginCommand(provider: LocalAgentProvider): string {
  return `baios-companion login ${provider}`;
}

/** What to do about a CLI that cannot run yet, as the one command that fixes it. */
export function providerFix(
  status: LocalAgentProviderStatus,
): { readonly command: string; readonly hint: string } | undefined {
  const name = PROVIDER_NAME[status.provider];

  if (!status.installed) {
    return {
      command: 'baios-companion status',
      hint: `Install ${name} on this computer, then run`,
    };
  }

  if (status.auth.status !== 'authenticated') {
    return { command: loginCommand(status.provider), hint: `Sign in to ${name} with` };
  }

  return undefined;
}

/**
 * A typed pairing code, forgiven its case, spaces and dash: `bcdf ghjk` → `BCDF-GHJK`. What the
 * contract's schema then checks; anything else is returned trimmed and upper-cased for display.
 */
export function normaliseUserCode(input: string): string {
  const letters = input.toUpperCase().replace(/[^A-Z]/gu, '');

  return letters.length === 8 ? `${letters.slice(0, 4)}-${letters.slice(4)}` : input.trim();
}

/** `m:ss` until an instant, floored at zero. */
export function formatCountdown(untilIso: string, now: number): string {
  const seconds = Math.max(0, Math.floor((Date.parse(untilIso) - now) / 1000));

  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, '0')}`;
}
