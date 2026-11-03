import { z } from 'zod';

import { actorSchema, connectorHealthSchema } from '../connectors/connection';

/**
 * Organisation provider keys (spec 020, contracts § 1): an LLM API key sealed in `secrets` and
 * never in any response — `lastFour` and `fingerprint` are the only derivatives that leave
 * (architecture §05). One key per organisation per provider.
 */

export const LLM_PROVIDERS = ['anthropic', 'openai'] as const;

export const llmProviderSchema = z.enum(LLM_PROVIDERS);

export type LlmProvider = z.output<typeof llmProviderSchema>;

export const providerKeySchema = z.strictObject({
  addedAt: z.iso.datetime(),
  addedBy: actorSchema.nullable(),
  fingerprint: z.string().min(1),
  health: connectorHealthSchema,
  id: z.uuid(),
  lastFour: z.string().min(1),
  lastVerifiedAt: z.iso.datetime(),
  provider: llmProviderSchema,
});

export type ProviderKey = z.output<typeof providerKeySchema>;

/** `GET /orgs/:orgId/provider-keys`. */
export const providerKeyListSchema = z.strictObject({ keys: z.array(providerKeySchema) });

export type ProviderKeyList = z.output<typeof providerKeyListSchema>;

/** `PUT /orgs/:orgId/provider-keys/:provider`; the provider's prefix is the service's check. */
export const putProviderKeyRequestSchema = z.strictObject({
  apiKey: z.string().trim().min(20).max(512),
});

export type PutProviderKeyRequest = z.output<typeof putProviderKeyRequestSchema>;

/** The `reason` a refusal carries — no new problem slug (research R11). */
export const BYOK_REFUSAL_REASONS = [
  'wrong-shape',
  'key-rejected',
  'could-not-verify',
  'needs-reauth',
] as const;

export type ByokRefusalReason = (typeof BYOK_REFUSAL_REASONS)[number];
