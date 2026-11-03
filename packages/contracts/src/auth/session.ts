import { z } from 'zod';

/**
 * Criterion 6's two endpoints: the list of devices signed in to an account, and the revocation of
 * one of them.
 *
 * The listing is the only response in the API that enumerates sessions, which makes it the one
 * place a session token — or the SHA-256 the store keys a session by — could plausibly be added by
 * somebody wiring up a "sign out this device" button and reaching for the identifier the server
 * already had. Both schemas are `strictObject` so that addition fails to parse in a test rather
 * than arriving in a client log, and the id below is a value of its own for the same reason.
 */

/**
 * One signed-in device, as its owner sees it.
 *
 * `id` is a uuid minted with the session, *not* the hash the session is stored under. Those could
 * have been the same value and deliberately are not: the hash names a Redis key, and a client
 * holding it is a client some later handler is tempted to look a session up by directly, without
 * the "and is it this caller's?" the revoke path turns on. The uuid means nothing outside the
 * caller's own list, which is exactly the authority a client needs to point at a row.
 *
 * The device is three fields rather than a marketing string: what the request said it was, where it
 * came from, and the digest of the pair that lets a client group two rows as one machine.
 * `device-fingerprint.ts` fills all three in for every session, answering `unknown` rather than
 * nothing, which is why none of them is optional.
 */
export const sessionSummarySchema = z.strictObject({
  createdAt: z.iso.datetime().meta({ description: 'When this device signed in.' }),
  fingerprint: z
    .string()
    .min(1)
    .meta({ description: 'A digest of the address and agent, stable for one device.' }),
  id: z.uuid().meta({ description: 'This session, as the caller may name it. Never its key.' }),
  ip: z.string().min(1),
  lastSeenAt: z.iso.datetime().meta({ description: 'The last request this session made.' }),
  userAgent: z.string().min(1),
});

export type SessionSummary = z.output<typeof sessionSummarySchema>;

/**
 * `GET /api/v1/auth/sessions`.
 *
 * No `total` and no `userId`. Whose sessions these are is settled by the cookie the request
 * arrived on and is never a parameter, so echoing the account back would only invite a client to
 * send one — and a list that took a user id is one route away from being a list that reads
 * somebody else's.
 */
export const sessionListResponseSchema = z.strictObject({
  sessions: z.array(sessionSummarySchema),
});

export type SessionListResponse = z.output<typeof sessionListResponseSchema>;

/** The only thing a successful revocation says. */
export const SESSION_REVOKED = 'session-revoked';

/**
 * `DELETE /api/v1/auth/sessions/:id`.
 *
 * A constant, with no count and no echo of the id. A body that reported how many sessions were
 * removed would answer "does this id exist?" for an id that is not the caller's — which is the
 * cross-user oracle the 404 exists to close, arriving through the success body instead of the
 * status line.
 */
export const revokeSessionResponseSchema = z.strictObject({
  status: z.literal(SESSION_REVOKED),
});

export type RevokeSessionResponse = z.output<typeof revokeSessionResponseSchema>;
