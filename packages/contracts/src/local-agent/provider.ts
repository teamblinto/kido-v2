import { z } from 'zod';

/**
 * The local agent bridge (spec 040 § 4): what a person's own, self-authenticated CLI reports about
 * itself, and how a run names it. Nothing here carries an email, an account id, a token or a
 * filesystem path — login state is read through the CLI's own status command and a workspace is an
 * opaque id the companion registered locally (ADR decisions 5 and 8).
 */

/** Gemini CLI is refused (spec 040 § 2), so it is not in the vocabulary at all. */
export const LOCAL_AGENT_PROVIDERS = ['claude', 'codex'] as const;

export const localAgentProviderSchema = z.enum(LOCAL_AGENT_PROVIDERS);

export type LocalAgentProvider = z.output<typeof localAgentProviderSchema>;

/**
 * The modes the server may request, least to most permissive, so a ceiling check is an index
 * comparison. `bypassPermissions` is deliberately absent: only the person can set it, locally
 * (ADR decision 6), so it never crosses the wire.
 */
export const LOCAL_AGENT_PERMISSION_MODES = ['plan', 'default', 'acceptEdits'] as const;

export const localAgentPermissionModeSchema = z.enum(LOCAL_AGENT_PERMISSION_MODES);

export type LocalAgentPermissionMode = z.output<typeof localAgentPermissionModeSchema>;

export const LOCAL_AGENT_AUTH_METHODS = [
  'subscription',
  'api_key',
  'cloud_provider',
  'unknown',
] as const;

export const localAgentAuthMethodSchema = z.enum(LOCAL_AGENT_AUTH_METHODS);

export type LocalAgentAuthMethod = z.output<typeof localAgentAuthMethodSchema>;

/** Timings shared by the API, the companion and the web (spec 040 § 3, § 5, § 6). */
export const LOCAL_AGENT_HEARTBEAT_SECONDS = 15;
export const LOCAL_AGENT_PRESENCE_TTL_SECONDS = 45;
export const LOCAL_AGENT_RUN_IDLE_TIMEOUT_SECONDS = 120;
export const LOCAL_AGENT_APPROVAL_TIMEOUT_SECONDS = 600;
export const LOCAL_AGENT_PAIRING_TTL_SECONDS = 600;
export const LOCAL_AGENT_PAIRING_POLL_INTERVAL_SECONDS = 5;

/** Every device token starts with this, so a leaked one is recognisable in a scanner or a log. */
export const LOCAL_AGENT_DEVICE_TOKEN_PREFIX = 'bld_';

/**
 * A provider's session/thread id. It ends up in the CLI's argv (`claude --resume=<id>`), so it is a
 * plain token: it never starts with `-` and never carries whitespace, quotes or shell characters.
 */
export const localAgentProviderSessionIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);

/**
 * A model id or alias as the CLI takes it (`sonnet`, `claude-opus-5-5[1m]`, `gpt-5.1-codex`,
 * `openai/gpt-oss`). Also argv-bound, so the same rule: no leading `-`, no whitespace or quoting.
 */
export const localAgentModelSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,199}$/);

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

/** One CLI on one device, as its official status command reported it. */
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

/** Minted by the companion at `workspace add`; the server only ever echoes it back. */
export const localAgentWorkspaceIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/** A registered workspace: an opaque id and a label. Never a path (ADR decision 5). */
export const localAgentWorkspaceSchema = z.strictObject({
  id: localAgentWorkspaceIdSchema,
  label: z.string().trim().min(1).max(100),
});

export type LocalAgentWorkspace = z.output<typeof localAgentWorkspaceSchema>;

/**
 * Where a local run's tools act (spec 041, sandbox tool bridge). `workspace`: the CLI's own tools
 * on a folder the companion registered. `sandbox`: the CLI's file and shell tools are off and it
 * calls the project's sandbox tools, which the server runs as it does for the cloud agent.
 */
export const LOCAL_AGENT_TOOL_MODES = ['workspace', 'sandbox'] as const;

export const localAgentToolModeSchema = z.enum(LOCAL_AGENT_TOOL_MODES);

export type LocalAgentToolMode = z.output<typeof localAgentToolModeSchema>;

/**
 * The `localAgent` target on `createRunRequestSchema`: which device and CLI run it, and — for the
 * `workspace` tool mode — on which registered workspace. No `workspaceId` is the `sandbox` mode.
 */
export const localAgentRunTargetSchema = z.strictObject({
  deviceId: z.uuid(),
  /** Requested, not granted: the companion clamps it to its local ceiling. */
  permissionMode: localAgentPermissionModeSchema.optional(),
  provider: localAgentProviderSchema,
  workspaceId: localAgentWorkspaceIdSchema.optional(),
});

export type LocalAgentRunTarget = z.output<typeof localAgentRunTargetSchema>;
