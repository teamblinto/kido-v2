import { z } from 'zod';

/** `GET /zones` result. */
export const cloudflareZonesSchema = z.array(
  z.object({
    account: z.object({ id: z.string(), name: z.string().nullish() }).nullish(),
    id: z.string().min(1),
    name: z.string(),
    status: z.string(),
  }),
);

/** `GET /zones/{id}/dns_records` result. */
export const cloudflareDnsRecordSchema = z.object({
  comment: z.string().nullish(),
  content: z.string(),
  id: z.string(),
  name: z.string(),
  type: z.string(),
});

export const cloudflareDnsRecordsSchema = z.array(cloudflareDnsRecordSchema);

/** `DELETE /zones/{id}/dns_records/{rid}` result. */
export const cloudflareDeletedSchema = z.object({ id: z.string() }).nullish();
