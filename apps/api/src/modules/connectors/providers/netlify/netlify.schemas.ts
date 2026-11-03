import { z } from 'zod';

/** `GET /user` — only what the connect records. */
export const netlifyUserSchema = z.object({
  email: z.string().nullish(),
  full_name: z.string().nullish(),
  id: z.string(),
});

/** `GET /accounts`. */
export const netlifyAccountsSchema = z.array(
  z.object({ id: z.string(), name: z.string().nullish(), slug: z.string().min(1) }),
);

/** A site as the bind form and the publish read it. */
export const netlifySiteSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  ssl_url: z.string().nullish(),
  url: z.string().min(1),
});

export const netlifySitesSchema = z.array(netlifySiteSchema);

/** A deploy: `required` is the digests Netlify does not hold yet (R11). */
export const netlifyDeploySchema = z.object({
  id: z.string().min(1),
  required: z.array(z.string()).nullish(),
  state: z.string().min(1),
  title: z.string().nullish(),
});

export const netlifyDeploysSchema = z.array(netlifyDeploySchema);

/** `PUT /deploys/{id}/files/{path}` answers the file; nothing of it is used. */
export const netlifyUploadSchema = z.unknown();
