import { z } from 'zod';

/** `POST /v1/oauth/token`. */
export const supabaseTokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1),
});

/** `GET /v1/profile`. */
export const supabaseProfileSchema = z.object({ gotrue_id: z.string() }).loose();

/** `GET /v1/organizations`. */
export const supabaseOrganizationsSchema = z.array(
  z.object({ id: z.string().min(1), name: z.string() }),
);

/**
 * What `connector:supabase:oauth-grant` seals (research R10): the access and refresh tokens as one
 * JSON secret, so a refresh replaces both in one write.
 */
export const supabaseGrantSchema = z.strictObject({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
});

export type SupabaseSealedGrant = z.infer<typeof supabaseGrantSchema>;

/** `GET /v1/projects`: the project's ref is its `id`. */
export const supabaseProjectsSchema = z.array(
  z
    .object({ id: z.string().min(1), name: z.string(), region: z.string(), status: z.string() })
    .loose(),
);

/** `GET /v1/projects/{ref}/api-keys` without `reveal`: a secret key's value comes back masked. */
export const supabaseApiKeysSchema = z.array(
  z.object({ api_key: z.string().nullish(), name: z.string(), type: z.string().nullish() }).loose(),
);
