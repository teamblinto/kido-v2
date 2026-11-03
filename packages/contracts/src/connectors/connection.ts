import { z } from 'zod';

import { cursorSchema } from '../common/cursor';

/**
 * Organisation connections (spec 018, contracts § 1): a stored credential, sealed in `secrets` and
 * never in any response — `credentialFingerprint` is the only derivative that leaves (architecture
 * §05). One connection per organisation per provider. Spec 030 (research R2) widens this file on
 * purpose: five more providers, and `connectionSchema` a union on `provider` whose `github` arm is
 * spec 018's object unchanged.
 */

export const CONNECTOR_PROVIDERS = [
  'github',
  'netlify',
  'supabase',
  'neon',
  'resend',
  'cloudflare',
] as const;

export const connectorProviderSchema = z.enum(CONNECTOR_PROVIDERS);

export type ConnectorProvider = z.output<typeof connectorProviderSchema>;

export const CONNECTOR_HEALTH = ['healthy', 'needs_reauth', 'unavailable'] as const;

export const connectorHealthSchema = z.enum(CONNECTOR_HEALTH);

export type ConnectorHealth = z.output<typeof connectorHealthSchema>;

/** Who did it, as every 018 record names its actor. */
export const actorSchema = z.strictObject({ id: z.uuid(), name: z.string().min(1) });

/** Spec 018's connection, a GitHub App installation — byte-for-byte what 018 published. */
export const githubConnectionSchema = z.strictObject({
  account: z.strictObject({
    id: z.int().positive(),
    login: z.string().min(1),
    type: z.enum(['organization', 'user']),
  }),
  canCreateRepositories: z.boolean(),
  circuitOpenUntil: z.iso.datetime().nullable(),
  connectedAt: z.iso.datetime(),
  connectedBy: actorSchema,
  credentialFingerprint: z.string().nullable(),
  health: connectorHealthSchema,
  id: z.uuid(),
  lastVerifiedAt: z.iso.datetime().nullable(),
  provider: z.literal('github'),
});

export type GithubConnection = z.output<typeof githubConnectionSchema>;

/** The providers connected by an OAuth grant (Supabase) or a pasted token (the rest) — spec 030. */
export const PROVIDER_CONNECTORS = ['netlify', 'supabase', 'neon', 'resend', 'cloudflare'] as const;

export const providerConnectorSchema = z.enum(PROVIDER_CONNECTORS);

export type ProviderConnector = z.output<typeof providerConnectorSchema>;

/** Spec 030 contracts/bindings.md § 1: the arm for the five non-GitHub providers. */
export const providerConnectionSchema = z.strictObject({
  account: z.strictObject({ name: z.string().min(1), ref: z.string().min(1) }),
  authType: z.enum(['oauth', 'token']),
  connectedAt: z.iso.datetime(),
  connectedBy: actorSchema,
  credentialFingerprint: z.string().nullable(),
  /** Resources a removal could not release, shown until a reconnect clears them. */
  failedResources: z.array(z.strictObject({ kind: z.string().min(1), name: z.string().min(1) })),
  health: connectorHealthSchema,
  id: z.uuid(),
  lastVerifiedAt: z.iso.datetime().nullable(),
  provider: providerConnectorSchema,
  /** Set while `connection_remove` runs; the connection takes no new work meanwhile. */
  removalRequestedAt: z.iso.datetime().nullable(),
  scopes: z.array(z.string().min(1)),
});

export type ProviderConnection = z.output<typeof providerConnectionSchema>;

export const connectionSchema = z.discriminatedUnion('provider', [
  githubConnectionSchema,
  providerConnectionSchema,
]);

export type Connection = z.output<typeof connectionSchema>;

/** `GET /orgs/:orgId/connectors`. */
export const connectionListSchema = z.strictObject({ connections: z.array(connectionSchema) });

export type ConnectionList = z.output<typeof connectionListSchema>;

/** `POST /orgs/:orgId/connectors/github/install`. */
export const installResponseSchema = z.strictObject({ installUrl: z.url() });

export type InstallResponse = z.output<typeof installResponseSchema>;

/** `POST /orgs/:orgId/connectors/github/complete`: what GitHub's redirect carried back. */
export const completeInstallRequestSchema = z.strictObject({
  installationId: z.int().positive(),
  state: z.string().min(1),
});

export type CompleteInstallRequest = z.output<typeof completeInstallRequestSchema>;

export const repositorySchema = z.strictObject({
  defaultBranch: z.string().min(1),
  fullName: z.string().min(1),
  id: z.int().positive(),
  name: z.string().min(1),
  owner: z.string().min(1),
  private: z.boolean(),
});

export type Repository = z.output<typeof repositorySchema>;

/** `GET /orgs/:orgId/connectors/:connectionId/repositories` — 50 a page, filtered by name. */
export const repositoryPageSchema = z.strictObject({
  nextCursor: cursorSchema.optional(),
  repositories: z.array(repositorySchema),
});

export type RepositoryPage = z.output<typeof repositoryPageSchema>;

export const repositoryQuerySchema = z.strictObject({
  cursor: cursorSchema.optional(),
  query: z.string().max(100).optional(),
});

export type RepositoryQuery = z.output<typeof repositoryQuerySchema>;
