import { z } from 'zod';

import { type LlmProvider, llmProviderSchema } from '../byok/provider-key';

/**
 * Linked subscription accounts (spec 032, contracts/byos.md § 1, § 4, § 5). Per person: no
 * `:orgId`, and nothing of the grant ever crosses the wire — only the provider's display label.
 */

/** A person's linked account, as its owner sees it (contracts § 1). */
export const linkedAccountSchema = z.strictObject({
  /** The provider's display identifier (e.g. an email); nothing of the grant. */
  accountLabel: z.string().min(1),
  health: z.enum(['healthy', 'needs_reauth']),
  lastCheckedAt: z.iso.datetime(),
  /** Set only when the provider gave a usage-limit reset time. */
  limitedUntil: z.iso.datetime().nullable(),
  linkedAt: z.iso.datetime(),
  provider: llmProviderSchema,
});

export type LinkedAccount = z.output<typeof linkedAccountSchema>;

/** `GET /me/linked-accounts`: `offered` drives what the page shows at all (research R12). */
export const linkedAccountListSchema = z.strictObject({
  accounts: z.array(linkedAccountSchema),
  offered: z.array(llmProviderSchema),
});

export type LinkedAccountList = z.output<typeof linkedAccountListSchema>;

/** 43 base64url characters: 32 random bytes, unpadded. */
const linkStateSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** `POST /me/linked-accounts/:provider/begin`: a redirect flow or a device flow. */
export const beginLinkResponseSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('redirect'), url: z.url() }),
  z.strictObject({
    expiresAt: z.iso.datetime(),
    kind: z.literal('device'),
    state: linkStateSchema,
    userCode: z.string().min(1),
    verificationUri: z.url(),
  }),
]);

export type BeginLinkResponse = z.output<typeof beginLinkResponseSchema>;

/**
 * `POST /me/linked-accounts/:provider/complete`. `code` for the redirect flow, `error` when the
 * provider sent one back, neither for a device-flow poll — never both.
 */
export const completeLinkRequestSchema = z
  .strictObject({
    code: z.string().min(1).max(2048).optional(),
    error: z.enum(['access_denied', 'other']).optional(),
    state: linkStateSchema,
  })
  .refine((body) => body.code === undefined || body.error === undefined, {
    error: 'Send either code or error, not both.',
    path: ['error'],
  });

export type CompleteLinkRequest = z.output<typeof completeLinkRequestSchema>;

/** 202 from `complete` while a device flow is still waiting on the person. */
export const completeLinkPendingSchema = z.strictObject({
  pending: z.literal(true),
  retryAfterSeconds: z.number().int().min(1),
});

export type CompleteLinkPending = z.output<typeof completeLinkPendingSchema>;

/** The `reason` on a BYOS refusal (contracts § 1, § 4); no new slug (research R14). */
export const BYOS_REFUSAL_REASONS = [
  'denied',
  'exchange-refused',
  'provider-unavailable',
  'subscription-needs-reauth',
  'subscription-limited',
] as const;

export type ByosRefusalReason = (typeof BYOS_REFUSAL_REASONS)[number];

/** The catalogue ids a subscription serves, per provider (research R8). */
export const SUBSCRIPTION_MODELS: Readonly<Record<LlmProvider, readonly string[]>> = {
  anthropic: [
    // Every Anthropic catalogue id for now; narrowed from the provider's documentation at T056.
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-haiku-4-5',
  ],
  openai: [
    // Every OpenAI catalogue id for now; narrowed from the provider's documentation at T056.
    'gpt-5.2',
    'gpt-5-mini',
  ],
};
