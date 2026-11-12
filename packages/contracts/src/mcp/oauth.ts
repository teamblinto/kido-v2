import { z } from 'zod';

/**
 * The OAuth 2.1 authorization server that guards the MCP endpoint (spec 046). Wire names that RFC
 * 6749, 7591 and 7636 fix are kept in snake_case, because a client sends exactly those; the
 * product's own JSON (consent, grants) is camelCase like every other contract.
 */

/**
 * What a client may be granted. Coarse on purpose: the person's own RBAC role still decides every
 * call, so a scope can only narrow what the role allows, never widen it. Three, because those are
 * the three kinds of consequence a person weighs: reading, changing the project, and publishing it.
 */
export const MCP_SCOPES = ['projects:read', 'projects:write', 'projects:deploy'] as const;

export const mcpScopeSchema = z.enum(MCP_SCOPES);

export type McpScope = z.output<typeof mcpScopeSchema>;

/** The sentence the consent screen shows for each scope. */
export const MCP_SCOPE_DESCRIPTIONS: Readonly<Record<McpScope, string>> = {
  'projects:deploy': 'Deploy your projects and publish them to connected hosts',
  'projects:read': 'See your projects, files, conversations, previews and deployments',
  'projects:write':
    'Build and change your projects: run the agent, edit files, restore checkpoints, sync GitHub and manage integrations',
};

/** Every token starts with its kind, so a leaked one is recognisable in a scanner or a log. */
export const MCP_ACCESS_TOKEN_PREFIX = 'mcp_at_';
export const MCP_REFRESH_TOKEN_PREFIX = 'mcp_rt_';

/** Prefix and 32 random bytes, base64url and unpadded; stored server-side only as its SHA-256. */
export const mcpAccessTokenSchema = z
  .string()
  .regex(new RegExp(`^${MCP_ACCESS_TOKEN_PREFIX}[A-Za-z0-9_-]{43}$`));
export const mcpRefreshTokenSchema = z
  .string()
  .regex(new RegExp(`^${MCP_REFRESH_TOKEN_PREFIX}[A-Za-z0-9_-]{43}$`));

/** RFC 7636 §4.1: 43–128 unreserved characters; S256 of one is always 43. */
const pkceValueSchema = z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/);

/**
 * The authorization request as the consent page relays it from its own query string. The
 * authorization endpoint the metadata advertises is the web page itself, so these are the RFC 6749
 * §4.1.1 parameters, camel-cased by the page.
 */
export const mcpAuthorizationRequestSchema = z.strictObject({
  clientId: z.uuid(),
  codeChallenge: pkceValueSchema,
  // OAuth 2.1 removes `plain`; S256 is the only method the metadata advertises.
  codeChallengeMethod: z.literal('S256'),
  redirectUri: z.url().max(2_000),
  resource: z.url().max(2_000).optional(),
  responseType: z.literal('code'),
  scope: z.string().max(200).optional(),
  state: z.string().max(1_000).optional(),
});

export type McpAuthorizationRequest = z.output<typeof mcpAuthorizationRequestSchema>;

/** What the consent page shows before the person decides. */
export const mcpAuthorizationPreviewSchema = z.strictObject({
  clientName: z.string(),
  clientUri: z.string().nullable(),
  /** The host the code goes to — what a person can actually check against the client they use. */
  redirectHost: z.string(),
  scopes: z.array(mcpScopeSchema),
});

export type McpAuthorizationPreview = z.output<typeof mcpAuthorizationPreviewSchema>;

export const mcpAuthorizationDecisionSchema = z.strictObject({
  decision: z.enum(['allow', 'deny']),
  /** The one organisation the client may act in. Required to allow; ignored on deny. */
  orgId: z.uuid().optional(),
  request: mcpAuthorizationRequestSchema,
});

export type McpAuthorizationDecision = z.output<typeof mcpAuthorizationDecisionSchema>;

/** Where the browser goes next: the client's redirect URI, carrying `code` or `error`. */
export const mcpAuthorizationRedirectSchema = z.strictObject({ redirectUrl: z.url() });

export type McpAuthorizationRedirect = z.output<typeof mcpAuthorizationRedirectSchema>;

/** RFC 7591 §2, the subset a public MCP client sends. Unknown metadata is ignored, as §2 allows. */
export const mcpClientRegistrationRequestSchema = z.object({
  client_name: z.string().trim().min(1).max(100).optional(),
  client_uri: z.url().max(2_000).optional(),
  grant_types: z.array(z.string()).max(5).optional(),
  redirect_uris: z.array(z.url().max(2_000)).min(1).max(10),
  response_types: z.array(z.string()).max(5).optional(),
  scope: z.string().max(200).optional(),
  token_endpoint_auth_method: z.string().optional(),
});

export type McpClientRegistrationRequest = z.output<typeof mcpClientRegistrationRequestSchema>;

/** RFC 6749 §4.1.3 and §6, as the form-encoded token request carries them. */
export const mcpTokenRequestSchema = z.discriminatedUnion('grant_type', [
  z.object({
    client_id: z.uuid(),
    code: z.string().min(1).max(200),
    code_verifier: pkceValueSchema,
    grant_type: z.literal('authorization_code'),
    redirect_uri: z.url().max(2_000),
    resource: z.url().max(2_000).optional(),
  }),
  z.object({
    client_id: z.uuid(),
    grant_type: z.literal('refresh_token'),
    refresh_token: z.string().min(1).max(200),
    resource: z.url().max(2_000).optional(),
    scope: z.string().max(200).optional(),
  }),
]);

export type McpTokenRequest = z.output<typeof mcpTokenRequestSchema>;

/** One client a person has let into an organisation, as the settings page lists it. */
export const mcpGrantSchema = z.strictObject({
  clientName: z.string(),
  clientUri: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  id: z.uuid(),
  lastUsedAt: z.iso.datetime({ offset: true }).nullable(),
  scopes: z.array(mcpScopeSchema),
});

export type McpGrant = z.output<typeof mcpGrantSchema>;

export const mcpGrantListSchema = z.strictObject({ items: z.array(mcpGrantSchema) });

export type McpGrantList = z.output<typeof mcpGrantListSchema>;
