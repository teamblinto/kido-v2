import { z } from 'zod';

/** `GET /domains`. */
export const resendDomainsSchema = z.object({
  data: z.array(z.object({ id: z.string(), name: z.string(), status: z.string() })),
  has_more: z.boolean().optional(),
});

/** `GET /domains/{id}`. */
export const resendDomainSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
});

/** `POST /api-keys`: the token is returned here and never again. */
export const resendCreatedKeySchema = z.object({ id: z.string(), token: z.string() });

/** `GET /api-keys`. */
export const resendKeysSchema = z.object({
  data: z.array(z.object({ id: z.string(), name: z.string() })),
});

/** Resend's error body: the `name` decides the category (research R5). */
export const resendErrorSchema = z.object({ name: z.string() });
