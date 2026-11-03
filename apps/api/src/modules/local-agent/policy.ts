import type {
  CompanionPolicy,
  CompanionStatusReport,
  LocalAgentPolicy,
  LocalAgentProviderStatus,
} from '@repo/contracts';

/**
 * Which sign-ins the runner's CLI may run on (spec 040 § 2, ADR decision 10), sent in `hello` and
 * re-checked on every turn: Claude Code on any of its own sign-ins.
 */
export const COMPANION_POLICY: CompanionPolicy = Object.freeze({
  claude: { allowedAuthMethods: ['subscription', 'api_key', 'cloud_provider'] },
});

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

  return allowed.includes(method)
    ? { allowed: true, reason: null }
    : {
        allowed: false,
        reason: `This deployment does not run ${status.provider} signed in with ${method}.`,
      };
}

/** The report as stored: every provider's policy recomputed here. */
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
