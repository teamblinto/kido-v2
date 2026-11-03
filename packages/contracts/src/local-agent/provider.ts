import { z } from 'zod';

/**
 * The runner's vocabulary (spec 041): what the Claude Code CLI in a person's cloud agent home
 * reports about itself. Nothing here carries an email, an account id or a token — login state is
 * read through the CLI's own status command. The `local-agent` names are the wire's, from spec 040.
 */

/** Hosted ChatGPT-plan auth is not permitted (041 design § Compliance), so Claude only. */
export const LOCAL_AGENT_PROVIDERS = ['claude'] as const;

export const localAgentProviderSchema = z.enum(LOCAL_AGENT_PROVIDERS);

export type LocalAgentProvider = z.output<typeof localAgentProviderSchema>;

export const LOCAL_AGENT_AUTH_METHODS = [
  'subscription',
  'api_key',
  'cloud_provider',
  'unknown',
] as const;

export const localAgentAuthMethodSchema = z.enum(LOCAL_AGENT_AUTH_METHODS);

export type LocalAgentAuthMethod = z.output<typeof localAgentAuthMethodSchema>;

/** Timings shared by the API and the runner (spec 040 § 3, § 6). */
export const LOCAL_AGENT_HEARTBEAT_SECONDS = 15;
export const LOCAL_AGENT_PRESENCE_TTL_SECONDS = 45;
export const LOCAL_AGENT_RUN_IDLE_TIMEOUT_SECONDS = 120;

/** Every device token starts with this, so a leaked one is recognisable in a scanner or a log. */
export const LOCAL_AGENT_DEVICE_TOKEN_PREFIX = 'bld_';

/** `bld_` and 32 random bytes, base64url and unpadded; stored server-side only as its SHA-256. */
export const localAgentDeviceTokenSchema = z
  .string()
  .regex(new RegExp(`^${LOCAL_AGENT_DEVICE_TOKEN_PREFIX}[A-Za-z0-9_-]{43}$`));

/**
 * A provider's session id. It ends up in the CLI's argv (`claude --resume=<id>`), so it is a plain
 * token: it never starts with `-` and never carries whitespace, quotes or shell characters.
 */
export const localAgentProviderSessionIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);

/**
 * A model id or alias as the CLI takes it (`sonnet`, `claude-opus-5-5[1m]`). Also argv-bound, so
 * the same rule: no leading `-`, no whitespace or quoting.
 */
export const localAgentModelSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,199}$/);

/**
 * `workspace` is no longer sent (the runner has no local workspaces); it stays so run events
 * written by the retired local-agent feature (spec 040) still parse.
 */
export const COMPANION_FAILURE_CLASSES = [
  'auth',
  'usage_limit',
  'provider',
  'transport',
  'crash',
  'policy',
  'workspace',
] as const;

export const companionFailureClassSchema = z.enum(COMPANION_FAILURE_CLASSES);

export type CompanionFailureClass = z.output<typeof companionFailureClassSchema>;

/** Whether the server lets a provider run, and why not (ADR decision 10). */
export const localAgentPolicySchema = z.strictObject({
  allowed: z.boolean(),
  reason: z.string().max(500).nullable(),
});

export type LocalAgentPolicy = z.output<typeof localAgentPolicySchema>;

const shortText = z.string().trim().min(1).max(200);

/** The CLI in an agent home, as its official status command reported it. */
export const localAgentProviderStatusSchema = z.strictObject({
  auth: z.strictObject({
    method: localAgentAuthMethodSchema.nullable(),
    /** The plan's display name when the CLI states one; never an account identifier. */
    plan: z.string().max(100).nullable(),
    status: z.enum(['authenticated', 'unauthenticated', 'unknown']),
  }),
  checkedAt: z.iso.datetime(),
  installed: z.boolean(),
  message: z.string().max(500).nullable(),
  models: z.array(z.strictObject({ id: shortText, label: shortText })).max(100),
  /** Recomputed by the server from config and `auth.method`; a reported value is never trusted. */
  policy: localAgentPolicySchema,
  provider: localAgentProviderSchema,
  version: z.string().max(100).nullable(),
});

export type LocalAgentProviderStatus = z.output<typeof localAgentProviderStatusSchema>;
