import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { AUTHENTICATED_USER, type AuthenticatedUser } from '../identity/services/session.service';
import { RESOURCE_ORG, ResourceOrg, ResourceOrgResolver } from './resource-org.resolver';

const ORG = randomUUID();
const OTHER_ORG = randomUUID();
const USER = randomUUID();

class ProjectController {
  @ResourceOrg()
  deploy(this: void): string {
    return 'deployed';
  }

  /** A route that never registered one. It must resolve to no tenant at all. */
  unregistered(this: void): string {
    return 'unregistered';
  }
}

@ResourceOrg('organisation')
class ReportController {
  export(this: void): string {
    return 'exported';
  }
}

interface RequestShape {
  readonly body?: Record<string, unknown>;
  readonly headers?: Record<string, string>;
  readonly params?: Record<string, string>;
  readonly query?: Record<string, string>;
  [AUTHENTICATED_USER]?: AuthenticatedUser;
}

function principal(): AuthenticatedUser {
  return {
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    pendingMfa: false,
    sessionId: 'a-hash',
    steppedUpAt: null,
    userId: USER,
  };
}

function contextFor(handler: (this: void) => string, request: RequestShape): ExecutionContext {
  return {
    getClass: () => ProjectController,
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('ResourceOrgResolver', () => {
  const resolver = new ResourceOrgResolver(new Reflector());

  it('derives the organisation from the resource the route names', () => {
    const scope = resolver.resolve(
      contextFor(ProjectController.prototype.deploy, {
        params: { orgId: ORG, projectId: randomUUID() },
        [AUTHENTICATED_USER]: principal(),
      }),
    );

    expect(scope).toEqual({ orgId: ORG, userId: USER });
  });

  it('reads whichever parameter the route registered', () => {
    const context = {
      getClass: () => ReportController,
      getHandler: () => ReportController.prototype.export,
      switchToHttp: () => ({ getRequest: () => ({ params: { organisation: ORG } }) }),
    } as unknown as ExecutionContext;

    expect(resolver.resolve(context)).toEqual({ orgId: ORG, userId: null });
  });

  /**
   * **The property the whole design exists to guarantee** (§11: "never from a header or a body
   * field"), asserted at the one place that could break it.
   *
   * Every shape a client could use to name an organisation is present and every one names a
   * *different* organisation than the route does. The answer is the route's. There is no precedence
   * rule being tested here and no fallback being preferred — this resolver reads `params` and
   * nothing else, and this test is what keeps that true when somebody later adds "convenience".
   */
  it('ignores a forged header, body field or query parameter naming another organisation', () => {
    const scope = resolver.resolve(
      contextFor(ProjectController.prototype.deploy, {
        body: { orgId: OTHER_ORG, organizationId: OTHER_ORG },
        headers: { 'x-org-id': OTHER_ORG, 'x-organization-id': OTHER_ORG },
        params: { orgId: ORG },
        query: { orgId: OTHER_ORG },
        [AUTHENTICATED_USER]: principal(),
      }),
    );

    expect(scope).toEqual({ orgId: ORG, userId: USER });
  });

  /**
   * A forged header on a route that registered *nothing* is the other half, and the dangerous one:
   * if a missing registration fell back to whatever the client supplied, the header would be the
   * whole answer rather than an ignored one.
   */
  it('answers no tenant for a route with no registered resolver, forged header or not', () => {
    const scope = resolver.resolve(
      contextFor(ProjectController.prototype.unregistered, {
        headers: { 'x-org-id': OTHER_ORG },
        params: { orgId: ORG },
        [AUTHENTICATED_USER]: principal(),
      }),
    );

    expect(scope).toBeNull();
  });

  /**
   * `runInTenantTransaction` refuses a non-uuid with `InvalidTenantIdError`, which would reach the
   * caller as a 500 naming the value. Declining here makes it the ordinary "no tenant" answer, and
   * the guard turns that into the same 403 every other denial gets.
   */
  it('answers no tenant when the parameter is absent or is not a uuid', () => {
    const missing = resolver.resolve(
      contextFor(ProjectController.prototype.deploy, { params: {} }),
    );
    const malformed = resolver.resolve(
      contextFor(ProjectController.prototype.deploy, { params: { orgId: 'not-a-uuid' } }),
    );

    expect(missing).toBeNull();
    expect(malformed).toBeNull();
  });

  it('answers no tenant when the request carries no params at all', () => {
    expect(resolver.resolve(contextFor(ProjectController.prototype.deploy, {}))).toBeNull();
  });

  /**
   * `TenantScope.userId` is nullable for exactly this: a `@Public()` route inside a tenant. The
   * audit row it writes then records "no user" rather than a user somebody guessed at.
   */
  it('carries no user when nobody is signed in', () => {
    const scope = resolver.resolve(
      contextFor(ProjectController.prototype.deploy, { params: { orgId: ORG } }),
    );

    expect(scope).toEqual({ orgId: ORG, userId: null });
  });

  it('exposes the metadata key the decorator writes', () => {
    expect(new Reflector().get(RESOURCE_ORG, ProjectController.prototype.deploy)).toEqual({
      param: 'orgId',
    });
  });
});
