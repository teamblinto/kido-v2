import { Controller, Delete, Get, HttpCode, HttpStatus, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  SESSION_REVOKED,
  type RevokeSessionResponse,
  type SessionListResponse,
} from '@repo/contracts';

import { NotFoundError } from '../../../common/errors/domain-error';
import { CurrentUser } from '../decorators/current-user.decorator';
import { SessionService, type AuthenticatedUser } from '../services/session.service';

/**
 * One answer for both ways of not finding a session, and it names neither the id nor the reason.
 *
 * "That session is not yours" and "there is no such session" have to be the same response — not
 * merely the same status. A difference in detail, in shape or in which member is present is an
 * oracle in its own right, and the endpoint would still be answering "does this id exist?" for
 * anybody who bothered to compare two bodies.
 */
const NOT_FOUND = 'No such session.';

/**
 * The device list and remote sign-out (T18, criterion 6).
 *
 * Both routes are guarded — no `@Public()` — so `SessionGuard` has resolved the caller before
 * either method runs, and `@CurrentUser()` is present rather than optional. That resolution is also
 * the whole of the authorisation, in the same way `MfaController` argues: neither handler takes an
 * account from the request, so a signed-in caller can only ever read and revoke *their own*
 * sessions. A `userId` parameter here would be a way to sign somebody else's devices out.
 *
 * There is no `@Res` either. Revoking a session is not the same act as ending the one making the
 * request: a caller who revokes their current device is answered normally and simply finds their
 * cookie dead on the next request, and `POST /auth/logout` remains the route that clears it.
 */
@ApiTags('auth')
@Controller({ path: 'auth/sessions', version: '1' })
export class SessionController {
  constructor(private readonly sessions: SessionService) {}

  /**
   * `GET /auth/sessions`. The devices signed in to the caller's account: what they are, where they
   * were, when they arrived and when they were last seen.
   *
   * Never the session token and never the hash it is stored under — the summary carries a uuid of
   * its own, and `sessionListResponseSchema` is strict so the day somebody reaches for the
   * identifier the server already had is the day a contract test fails.
   *
   * An account with nothing to list is answered with an empty list rather than a `404`. The
   * question "which devices am I signed in on?" has an answer even when it is "none", and a `404`
   * would make a client that is merely up to date look like one that is broken.
   */
  @Get()
  @ApiOperation({ summary: 'List the devices this account is signed in on' })
  async list(@CurrentUser() user: AuthenticatedUser): Promise<SessionListResponse> {
    return { sessions: await this.sessions.list(user.userId) };
  }

  /**
   * `DELETE /auth/sessions/:id` — criterion 6's "revoking one invalidates it within one request".
   *
   * The id is taken as a plain string and is not validated against a uuid shape, deliberately. A
   * malformed id is not a body to report field errors about; it is an id that is not one of the
   * caller's, and it earns exactly the answer every other such id earns. Validating it would add a
   * second, distinguishable failure — a `422` — that tells a caller their id was *well-formed but
   * not theirs*, which is the oracle this route is shaped to avoid.
   *
   * `404` rather than `403`, and that is the point of the route. `403` is a claim that the thing
   * exists and is refused; repeated across guessed ids by anybody with an account, that claim
   * enumerates other people's sessions. `SessionService.revokeById` never looks outside the
   * caller's own index, so there is no branch here that could answer `403` even if it wanted to.
   */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke one of this account’s sessions, effective immediately' })
  async revoke(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<RevokeSessionResponse> {
    if (!(await this.sessions.revokeById(user.userId, id))) {
      throw new NotFoundError(NOT_FOUND);
    }

    return { status: SESSION_REVOKED };
  }
}
