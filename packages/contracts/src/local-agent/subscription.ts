import { z } from 'zod';

/**
 * The cloud subscription agent (spec 041): a person's own Claude Code, signed in by them through
 * Anthropic's flow, running in a private per-person sandbox ("agent home") as a hosted companion.
 * This file is the person-facing status, the run target, and the runner's sign-in wire.
 */

/** Hosted ChatGPT-plan auth is not permitted (design.md § Compliance), so Claude only. */
export const SUBSCRIPTION_PROVIDERS = ['claude'] as const;

export const subscriptionProviderSchema = z.enum(SUBSCRIPTION_PROVIDERS);

export type SubscriptionProvider = z.output<typeof subscriptionProviderSchema>;

/** What a `local_agent_devices` row is: a person's own computer, or the runner in an agent home. */
export const LOCAL_AGENT_DEVICE_KINDS = ['local', 'cloud'] as const;

export const localAgentDeviceKindSchema = z.enum(LOCAL_AGENT_DEVICE_KINDS);

export type LocalAgentDeviceKind = z.output<typeof localAgentDeviceKindSchema>;

/** How long a sign-in URL stays offered, and how long the runner keeps `claude auth login` alive. */
export const SUBSCRIPTION_SIGN_IN_TTL_SECONDS = 600;

/** Hosts Anthropic's sign-in page lives on; the URL is shown to the person verbatim. */
export const SUBSCRIPTION_SIGN_IN_HOSTS = ['claude.com', 'claude.ai', 'platform.claude.com'];

/** An `https:` URL on one of {@link SUBSCRIPTION_SIGN_IN_HOSTS}, no credentials, no port. */
export const subscriptionSignInUrlSchema = z
  .url()
  .max(2_048)
  .refine(
    (raw) => {
      // Zod 4 runs a refine after a failed `url()` check, so non-URL text must fail, not throw.
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        return false;
      }
      return (
        url.protocol === 'https:' &&
        url.port === '' &&
        url.username === '' &&
        url.password === '' &&
        SUBSCRIPTION_SIGN_IN_HOSTS.includes(url.hostname)
      );
    },
    { error: 'The sign-in URL must be an https URL on claude.com or claude.ai.' },
  );

/**
 * The one-time code the person pastes back; transits BAIOS in memory only, never logged. It is
 * written to the CLI's stdin, so only the characters a code is made of: no control characters
 * (an ESC or a newline would be keystrokes), no whitespace.
 */
export const subscriptionCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_\-#.]{1,512}$/, { error: 'Paste the code exactly as Claude shows it.' });

export const SUBSCRIPTION_STATES = [
  'disconnected',
  'provisioning',
  'starting',
  'awaiting-sign-in',
  'verifying',
  'connected',
  'signed-out',
  'error',
] as const;

export const subscriptionStateSchema = z.enum(SUBSCRIPTION_STATES);

export type SubscriptionState = z.output<typeof subscriptionStateSchema>;

/** `GET /me/subscriptions`' entry, and the answer to `connect`. */
export const subscriptionStatusSchema = z.strictObject({
  message: z.string().max(500).nullable(),
  /** The plan's display name when the CLI states one; never an account identifier. */
  plan: z.string().max(100).nullable(),
  provider: subscriptionProviderSchema,
  signIn: z
    .strictObject({ expiresAt: z.iso.datetime(), url: subscriptionSignInUrlSchema })
    .nullable(),
  state: subscriptionStateSchema,
  updatedAt: z.iso.datetime(),
});

export type SubscriptionStatus = z.output<typeof subscriptionStatusSchema>;

export const subscriptionListSchema = z.strictObject({ claude: subscriptionStatusSchema });

export type SubscriptionList = z.output<typeof subscriptionListSchema>;

/** `POST /me/subscriptions/claude/code`. */
export const subscriptionCodeRequestSchema = z.strictObject({ code: subscriptionCodeSchema });

export type SubscriptionCodeRequest = z.output<typeof subscriptionCodeRequestSchema>;

/** The `subscription` target on `createRunRequestSchema`: run on the person's agent home. */
export const subscriptionRunTargetSchema = z.strictObject({ provider: subscriptionProviderSchema });

export type SubscriptionRunTarget = z.output<typeof subscriptionRunTargetSchema>;

/**
 * The SSE `event:` name the sign-in commands travel under on `GET /local-agent/connect`. They
 * carry no `id:` (they are not part of the durable command stream and are never replayed).
 */
export const COMPANION_AUTH_SSE_EVENT = 'auth';

/**
 * Downlink, ephemeral: delivered live over the SSE connection and never persisted, so a code that
 * reaches a disconnected runner is lost (the person pastes it again) rather than stored.
 */
export const companionAuthCommandSchema = z.discriminatedUnion('type', [
  z.strictObject({ provider: subscriptionProviderSchema, type: z.literal('auth.login.start') }),
  z.strictObject({
    code: subscriptionCodeSchema,
    provider: subscriptionProviderSchema,
    type: z.literal('auth.login.code'),
  }),
  z.strictObject({ provider: subscriptionProviderSchema, type: z.literal('auth.login.cancel') }),
  z.strictObject({ provider: subscriptionProviderSchema, type: z.literal('auth.logout') }),
]);

export type CompanionAuthCommand = z.output<typeof companionAuthCommandSchema>;

/** Uplink, `POST /local-agent/auth` (cloud devices only); a status report follows a result. */
export const companionAuthEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    provider: subscriptionProviderSchema,
    type: z.literal('auth.login.url'),
    url: subscriptionSignInUrlSchema,
  }),
  z.strictObject({
    message: z.string().max(500).nullable(),
    ok: z.boolean(),
    provider: subscriptionProviderSchema,
    type: z.literal('auth.login.result'),
  }),
]);

export type CompanionAuthEvent = z.output<typeof companionAuthEventSchema>;
