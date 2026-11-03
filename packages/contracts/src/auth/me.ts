import type { z } from 'zod';

import { signedInResponseSchema } from './login';

/**
 * `GET /api/v1/auth/me` — who the session cookie resolves to.
 *
 * The route a single-page app calls on first paint, before it knows whether the cookie the browser
 * kept is still a session. It takes no parameters and reads no body: the only input is the cookie,
 * which is also the only input that could be trusted with the question.
 *
 * ## It is `signedInResponseSchema`, deliberately, and not a copy of it
 *
 * `login.ts` already argues that "the two ways to finish signing in produce one success shape, so a
 * client has one branch to write" — `POST /auth/login` on the arm with no second factor, and
 * `POST /auth/mfa/challenge` on the arm with one. Resuming a session is the third way to arrive at
 * exactly the same fact, and a client that had to branch on *how* it learned who it was would hold
 * two spellings of the current user and eventually render the wrong one.
 *
 * So this is an alias rather than a schema. A parallel definition would be identical on the day it
 * was written and would drift the first time either endpoint gained a field; an alias cannot. It is
 * named separately because the endpoint deserves a name in the contract — `SignedInResponse` is a
 * statement about a sign-in that just happened, and this one is about a sign-in that happened at
 * some point in the last fortnight.
 *
 * What it inherits matters as much as what it says. The shape is a `strictObject` around a
 * `strictObject`, so the session token stays where criterion 3 puts it — in the
 * `__Host-forge_session` cookie — and a `token`, `sessionId` or `expiresAt` added here by somebody
 * building a "you were signed out" banner fails to parse in a test rather than reaching a client.
 * `emailVerified` comes with it because §11 makes an unverified account usable but unable to create
 * sandboxes, and the app has to be able to say so on first paint without a second round trip.
 *
 * Note what is *not* here: no organisation. Which organisations the caller belongs to is
 * `GET /api/v1/orgs`, a separate read of a separate table with a separate failure mode — folding it
 * in would make "who am I" depend on the tenancy schema and would answer a question a client that
 * only wants to render an avatar never asked.
 */
export const currentUserResponseSchema = signedInResponseSchema;

export type CurrentUserResponse = z.output<typeof currentUserResponseSchema>;
