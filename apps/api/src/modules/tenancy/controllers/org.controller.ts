import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { OrgListResponse, OrgResponse } from '@repo/contracts';

import { ResourceOrg } from '../../rbac/resource-org.resolver';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { CurrentUser } from '../../identity/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../identity/services/session.service';
import { CreateOrgDto } from '../dto/create-org.dto';
import { OrgService } from '../services/org.service';

/**
 * The two organisation routes that name no organisation: creating one (ADR 007's "explicit,
 * authenticated action"), and listing the ones the caller is already in.
 *
 * Its own controller, separate from {@link OrgReadController}, because the routes differ in the one
 * respect that matters here: neither has a `@ResourceOrg()` and neither can have one. §11 derives
 * the tenant from the resource being touched — the resource `POST` touches does not exist until it
 * runs, and the resources `GET` returns are the answer rather than the input. Putting them on one
 * controller with `GET /orgs/:orgId` would mean a class-level `@ResourceOrg()` silently applying
 * here and resolving `:orgId` out of a path that has no such segment.
 *
 * Neither carries a `@RequirePermission()` either, and that is not an omission. A permission set is
 * resolved per `(user, org)`, and there is no organisation in scope to resolve one in — so the only
 * precondition is a session, which `SessionGuard` has already established, and the only data either
 * route can reach is the caller's own. `OrgService.create` opens a tenant scope itself once it has
 * minted an id; `OrgService.listForUser` opens a user-scoped one, which is the only place in the
 * application that reads across tenants at all.
 */
@ApiTags('tenancy')
@Controller({ path: 'orgs', version: '1' })
export class OrgController {
  constructor(private readonly orgs: OrgService) {}

  /**
   * `GET /api/v1/orgs` — the organisations the caller belongs to, and the role they hold in each.
   *
   * The route a client calls to find out which `:orgId` to put in every other URL, which is why it
   * takes none of its own. Whose organisations these are is settled by the session cookie: a
   * `userId` query parameter here would be a way to ask after somebody else's, and no permission
   * check could sensibly gate it because the caller holds no role in an organisation they are not
   * in.
   *
   * `200` with an empty array for an account in no organisation, not a `404`. "Which organisations
   * am I in?" has an answer even when it is "none" — it is what a just-registered user's client
   * renders the create-an-organisation screen from, and a `404` would make that client look broken.
   */
  @Get()
  @ApiOperation({ summary: 'List the organisations the caller is a member of' })
  async list(@CurrentUser() actor: AuthenticatedUser): Promise<OrgListResponse> {
    return { orgs: await this.orgs.listForUser(actor.userId) };
  }

  /**
   * `POST /api/v1/orgs`.
   *
   * `201`, because a resource was created and the response is it. The slug collision is a `409`
   * from the service rather than a validated-away `422`: the body was perfectly well formed, and
   * the only thing wrong with it is a fact about the world at the moment it arrived.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create an organisation, owned by the caller' })
  async create(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() body: CreateOrgDto,
  ): Promise<OrgResponse> {
    return { org: await this.orgs.create(actor.userId, body) };
  }
}

/**
 * Reading one organisation.
 *
 * `@ResourceOrg()` at the class, which is what tells `ResourceOrgResolver` that `:orgId` names the
 * resource this request is for — and therefore which tenant the transaction runs in and which
 * permission set the guard checks against. Without it every route here would be refused, which is
 * the fail-closed behaviour T26 is built around.
 */
@ApiTags('tenancy')
@ResourceOrg()
@Controller({ path: 'orgs/:orgId', version: '1' })
export class OrgReadController {
  constructor(private readonly orgs: OrgService) {}

  /**
   * `GET /api/v1/orgs/:orgId`.
   *
   * `org:read` — the permission §11's org row gives every member, including `billing`. A guest holds
   * no membership at all, so their resolved set never enters the org scope and this is a `403` for
   * them: "no visibility into the organisation", as the guard sees it (T30 carries the rest).
   */
  @Get()
  @RequirePermission('org:read')
  @ApiOperation({ summary: 'Read the organisation' })
  async read(): Promise<OrgResponse> {
    return { org: await this.orgs.read() };
  }
}
