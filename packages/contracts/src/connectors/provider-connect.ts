import { z } from 'zod';

/**
 * Connecting the five spec 030 providers (contracts/bindings.md § 1): a pasted token for Netlify,
 * Neon, Resend and Cloudflare; an OAuth authorization code with PKCE for Supabase (research R1).
 */

export const PASTE_TOKEN_PROVIDERS = ['netlify', 'neon', 'resend', 'cloudflare'] as const;

export const pasteTokenProviderSchema = z.enum(PASTE_TOKEN_PROVIDERS);

export type PasteTokenProvider = z.output<typeof pasteTokenProviderSchema>;

/**
 * `POST /orgs/:orgId/connectors/:provider/token`. Refused before any provider call when empty,
 * longer than 512, or with whitespace inside (surrounding whitespace is trimmed off a paste).
 */
export const pasteTokenRequestSchema = z.strictObject({
  token: z
    .string()
    .trim()
    .min(1)
    .max(512)
    .regex(/^\S+$/u, { message: 'must not contain whitespace' }),
});

export type PasteTokenRequest = z.output<typeof pasteTokenRequestSchema>;

/** `POST /orgs/:orgId/connectors/supabase/install` → the authorize URL (state, S256 challenge). */
export const supabaseInstallResponseSchema = z.strictObject({ url: z.url() });

export type SupabaseInstallResponse = z.output<typeof supabaseInstallResponseSchema>;

/** `POST /orgs/:orgId/connectors/supabase/complete`: what Supabase's redirect carried back. */
export const supabaseCompleteRequestSchema = z.strictObject({
  code: z.string().min(1).max(2048),
  state: z.string().min(1).max(512),
});

export type SupabaseCompleteRequest = z.output<typeof supabaseCompleteRequestSchema>;
