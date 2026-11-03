import type {
  CompanionPolicy,
  CompanionStatusReport,
  LocalAgentPolicy,
  LocalAgentProviderStatus,
} from '@repo/contracts';

/**
 * Which sign-ins each CLI may run on here (spec 040 § 2, ADR decision 10). Claude Code on any of
 * its own sign-ins; Codex on an API key or a cloud provider, and on a ChatGPT plan only where the
 * operator set `LOCAL_AGENT_CODEX_CHATGPT_AUTH=allow`.
 */
export function companionPolicy(codexChatgptAllowed: boolean): CompanionPolicy {
  return {
    claude: { allowedAuthMethods: ['subscription', 'api_key', 'cloud_provider'] },
    codex: {
      allowedAuthMethods: codexChatgptAllowed
        ? ['api_key', 'cloud_provider', 'subscription']
        : ['api_key', 'cloud_provider'],
    },
  };
}

/** The server's verdict on one reported CLI; a reported `policy` is never trusted. */
export function providerPolicy(
  status: Pick<LocalAgentProviderStatus, 'auth' | 'provider'>,
  policy: CompanionPolicy,
): LocalAgentPolicy {
  const { method } = status.auth;

  if (method === null || method === 'unknown') {
    return { allowed: false, reason: 'Sign the CLI in so its sign-in method can be checked.' };
  }

  // Read as partial: a provider the policy does not name is blocked, whatever the record's shape.
  const allowed = policy[status.provider]?.allowedAuthMethods ?? [];

  if (allowed.includes(method)) {
    return { allowed: true, reason: null };
  }

  return {
    allowed: false,
    reason:
      status.provider === 'codex' && method === 'subscription'
        ? 'This deployment does not run Codex on a ChatGPT plan. Sign the Codex CLI in with an API key.'
        : `This deployment does not run ${status.provider} signed in with ${method}.`,
  };
}

/** The report as stored and shown: every provider's policy recomputed here. */
export function withPolicy(
  report: CompanionStatusReport,
  policy: CompanionPolicy,
): CompanionStatusReport {
  return {
    ...report,
    providers: report.providers.map((status) => ({
      ...status,
      policy: providerPolicy(status, policy),
    })),
  };
}

/** What a run needs from its CLI: installed, signed in, and on a sign-in this deployment allows. */
export function runnable(status: LocalAgentProviderStatus, policy: CompanionPolicy): boolean {
  return (
    status.installed &&
    status.auth.status === 'authenticated' &&
    providerPolicy(status, policy).allowed
  );
}
