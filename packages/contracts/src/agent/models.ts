import { z } from 'zod';

import { llmProviderSchema } from '../byok/provider-key';

/**
 * The model catalogue (spec 011, research R11; per organisation since 020): `GET
 * /orgs/:orgId/models` and the id `createRun` accepts. The static half — id, names, provider —
 * lives here; `credentialMode` and `available` are the organisation's keys speaking (020 § 2).
 */

export const catalogueModelSchema = z.strictObject({
  /** False only for a BYOK provider whose key is `needs_reauth`. */
  available: z.boolean(),
  /** What `credential: 'organisation'` would use instead of a limited subscription (spec 032). */
  alternativeMode: z.enum(['PLATFORM', 'BYOK']).optional(),
  /** What a run on this model would be recorded as, for the caller (BYOS since spec 032). */
  credentialMode: z.enum(['PLATFORM', 'BYOK', 'BYOS']),
  description: z.string().min(1),
  id: z.string().min(1),
  /** A BYOS entry while the caller's subscription is limited (spec 032, research R11). */
  limitedUntil: z.iso.datetime().optional(),
  name: z.string().min(1),
  provider: llmProviderSchema,
  shortName: z.string().min(1),
  /** Only when `!available`: whose credential needs reconnecting (spec 032). */
  unavailableReason: z.enum(['key-needs-reauth', 'subscription-needs-reauth']).optional(),
});

export type CatalogueModel = z.output<typeof catalogueModelSchema>;

export const modelCatalogueResponseSchema = z.strictObject({
  default: z.string().min(1),
  models: z.array(catalogueModelSchema).min(1),
});

export type ModelCatalogueResponse = z.output<typeof modelCatalogueResponseSchema>;

/** A catalogue entry before an organisation's keys stamp `credentialMode` and `available`. */
export type CatalogueEntry = Omit<
  CatalogueModel,
  'alternativeMode' | 'available' | 'credentialMode' | 'limitedUntil' | 'unavailableReason'
>;

// The OpenAI ids are research R3's curated pair, verified against `models.list()` at T048.
export const MODEL_CATALOGUE: readonly CatalogueEntry[] = [
  {
    description: 'Most capable · uses credits faster',
    id: 'claude-opus-5',
    name: 'Claude Opus 5',
    provider: 'anthropic',
    shortName: 'Opus 5',
  },
  {
    description: 'Balanced — best default for building',
    id: 'claude-sonnet-5',
    name: 'Claude Sonnet 5',
    provider: 'anthropic',
    shortName: 'Sonnet 5',
  },
  {
    description: 'Fastest · good for small edits',
    id: 'claude-haiku-4-5',
    name: 'Claude Haiku 4.5',
    provider: 'anthropic',
    shortName: 'Haiku 4.5',
  },
  {
    description: "Balanced — OpenAI's default for building",
    id: 'gpt-5.2',
    name: 'GPT-5.2',
    provider: 'openai',
    shortName: 'GPT-5.2',
  },
  {
    description: 'Fastest · good for small edits',
    id: 'gpt-5-mini',
    name: 'GPT-5 mini',
    provider: 'openai',
    shortName: 'GPT-5 mini',
  },
];

export const MODEL_IDS: ReadonlySet<string> = new Set(MODEL_CATALOGUE.map((model) => model.id));

export function isCatalogueModel(id: string): boolean {
  return MODEL_IDS.has(id);
}

/** The provider a model id belongs to; `undefined` for an id the catalogue does not carry. */
export function providerOf(id: string): CatalogueEntry['provider'] | undefined {
  return MODEL_CATALOGUE.find((model) => model.id === id)?.provider;
}
