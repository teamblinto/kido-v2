import { index, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { timestamps } from './columns';
import { users } from './identity';
import { orgs } from './tenancy';

/**
 * An MCP client that registered itself through RFC 7591 dynamic registration (spec 046). A root
 * table (ADR 015): a registration belongs to no person and no tenant, it only names where codes may
 * be sent. Every client is public (`token_endpoint_auth_method = none`), so there is no secret to
 * store; PKCE is what binds a code to the client that asked for it.
 */
export const mcpClients = pgTable('mcp_clients', {
  clientName: text('client_name').notNull(),
  clientUri: text('client_uri'),
  id: uuid('id').primaryKey().defaultRandom(),
  redirectUris: text('redirect_uris').array().notNull(),
  ...timestamps,
});

/**
 * One person's consent for one MCP client to act in one organisation (spec 046). Tenant-owned, so
 * the settings page, the audit trail and revocation all run under the org's RLS like every other
 * grant; the bearer lookup reads it through `forge_bypass` because no tenant is known until the
 * token is. The access and refresh tokens are 256-bit random values, stored as hex SHA-256 like
 * the `bld_` device token. `previous_refresh_hash` is the token the last rotation retired: seeing
 * it again means a refresh token was replayed, and the whole grant is revoked (OAuth 2.1 §4.3.1).
 */
export const mcpGrants = pgTable(
  'mcp_grants',
  {
    accessExpiresAt: timestamp('access_expires_at', { withTimezone: true }).notNull(),
    accessTokenHash: text('access_token_hash').notNull(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => mcpClients.id, { onDelete: 'cascade' }),
    id: uuid('id').primaryKey().defaultRandom(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    previousRefreshHash: text('previous_refresh_hash'),
    refreshExpiresAt: timestamp('refresh_expires_at', { withTimezone: true }).notNull(),
    refreshTokenHash: text('refresh_token_hash').notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    scopes: text('scopes').array().notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ...timestamps,
  },
  (table) => [
    unique('mcp_grants_org_id_id_key').on(table.orgId, table.id),
    uniqueIndex('mcp_grants_access_token_hash_key').on(table.accessTokenHash),
    uniqueIndex('mcp_grants_refresh_token_hash_key').on(table.refreshTokenHash),
    index('mcp_grants_previous_refresh_hash_idx').on(table.previousRefreshHash),
    index('mcp_grants_org_id_user_id_idx').on(table.orgId, table.userId),
  ],
);

export type McpClientRow = typeof mcpClients.$inferSelect;
export type McpGrantRow = typeof mcpGrants.$inferSelect;
