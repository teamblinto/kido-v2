import { z } from 'zod';

import { FILE_PATH_MAX_LENGTH } from './files';

/** Presence (spec 031, contracts/presence.md). */

/**
 * The open file's path, bounded as the files routes bound it. The files routes leave the jail to
 * the port; presence has no port behind it and is echoed to other people, so it refuses an
 * absolute path and any `..` segment here.
 */
const presencePathSchema = z
  .string()
  .max(FILE_PATH_MAX_LENGTH)
  .refine((path) => !path.startsWith('/') && !path.split('/').includes('..'), {
    error: 'Use a path inside the project.',
  });

export const presenceLocationSchema = z.discriminatedUnion('view', [
  z.strictObject({ view: z.literal('preview') }),
  z.strictObject({ path: presencePathSchema.optional(), view: z.literal('code') }),
  z.strictObject({ view: z.literal('history') }),
  z.strictObject({ runId: z.uuid(), view: z.literal('run') }),
]);

export type PresenceLocation = z.output<typeof presenceLocationSchema>;

/** `PUT …/presence`: a last-write-wins upsert of the caller's own field. */
export const presenceHeartbeatRequestSchema = z.strictObject({ location: presenceLocationSchema });

export type PresenceHeartbeatRequest = z.output<typeof presenceHeartbeatRequestSchema>;

/** Everyone but the caller seen recently; `available: false` when Redis is unreachable. */
export const presenceResponseSchema = z.strictObject({
  available: z.boolean(),
  people: z.array(
    z.strictObject({
      email: z.email(),
      location: presenceLocationSchema,
      seenAt: z.iso.datetime(),
      userId: z.uuid(),
    }),
  ),
});

export type PresenceResponse = z.output<typeof presenceResponseSchema>;
