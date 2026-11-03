import { Body, Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AcceptInvitationResponse, InvitationAcceptedResponse } from '@repo/contracts';

import { CurrentUser } from '../../identity/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../identity/services/session.service';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { ResourceOrg } from '../../rbac/resource-org.resolver';
import { AcceptInvitationDto } from '../dto/accept-invitation.dto';
import { InviteMemberDto } from '../dto/invite-member.dto';
import { InvitationService } from '../services/invitation.service';

/**
 * Invitations (T29, success criterion 10) — the two halves of joining an organisation.
 *
 * Both permissions are checked against the organisation named by `:orgId`, because `@ResourceOrg()`
 * at the class says that is the resource and nothing reads a header (§11). The tenant transaction is
 * opened on the same value, so the guard's answer and the rows the handler sees cannot disagree.
 *
 * Neither route mentions `Idempotency-Key`. It is not per-route opt-in: `IdempotencyInterceptor`
 * (T28) is registered as an `APP_INTERCEPTOR`, so every unsafe route accepts the header by existing.
 * A decorator would fail silently in the direction that matters — the endpoint that forgot it is the
 * one that invites twice, and nothing about it looks wrong in review.
 */
@ApiTags('tenancy')
@ResourceOrg()
@Controller({ path: 'orgs/:orgId/invitations', version: '1' })
export class InvitationController {
  constructor(private readonly invitations: InvitationService) {}

  /**
   * `POST /api/v1/orgs/:orgId/invitations`.
   *
   * `202`, not `201`: the mail goes out after the transaction commits, so when this answers the
   * invitation exists but the thing the recipient needs has not happened yet.
   *
   * The guard answers "may this caller invite here at all". The service answers "but not to a role
   * above their own" — §11's second layer, for the part a route decorator cannot express because it
   * depends on a membership row nobody has loaded yet.
   */
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission('org:members.invite')
  @ApiOperation({ summary: 'Invite a member to the organisation' })
  async invite(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Body() body: InviteMemberDto,
  ): Promise<InvitationAcceptedResponse> {
    return this.invitations.invite({
      actorId: actor.userId,
      email: body.email,
      orgId,
      role: body.role,
    });
  }

  /**
   * `POST /api/v1/orgs/:orgId/invitations/accept`.
   *
   * Deliberately behind no `@RequirePermission`. The caller is not a member yet, so their permission
   * set for this organisation is empty by construction — any requirement here would refuse every
   * legitimate acceptance. The session guard still applies: the token proves which invitation, and
   * the session proves who is accepting it, and `InvitationService` refuses unless the two agree.
   */
  @Post('accept')
  @ApiOperation({ summary: 'Accept an invitation and become a member' })
  async accept(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Body() body: AcceptInvitationDto,
  ): Promise<AcceptInvitationResponse> {
    return this.invitations.accept({ actorId: actor.userId, orgId, token: body.token });
  }
}
