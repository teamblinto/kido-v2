import { describe, expect, it } from 'vitest';

import { AUDIT_ACTIONS, type AuditAction } from './audit-actions';

/**
 * A slug names a domain and something that happened to it, past tense: `workspace.created`, not
 * `workspace.create`. The trail records events, and an imperative slug reads as a permission — which
 * is a different catalogue (`@RequirePermission`, T24) with a different vocabulary, and the two
 * being confusable is how `org:members.invite` ends up in an audit row.
 */
const SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

const slugs = Object.keys(AUDIT_ACTIONS) as AuditAction[];

describe('AUDIT_ACTIONS', () => {
  /**
   * The compile-time closure is the criterion T10 actually states, and it is the one this file
   * cannot express as a runtime assertion: there is nothing to observe at runtime about a call that
   * never compiled. `@ts-expect-error` inverts that — `pnpm typecheck` fails if the line below
   * turns out to be *legal*, so the guarantee is checked by the same command that checks everything
   * else rather than asserted in a comment.
   */
  it('is closed: an unlisted action does not typecheck', () => {
    // @ts-expect-error an action absent from the catalogue is not an AuditAction
    const unlisted: AuditAction = 'workspace.exfiltrated';

    // Nothing to assert about the value; the assertion is that the line above needed suppressing.
    expect(unlisted).toBe('workspace.exfiltrated');
  });

  it('is frozen, so a slug cannot be added at runtime', () => {
    expect(Object.isFrozen(AUDIT_ACTIONS)).toBe(true);
  });

  it('names every action as domain.event, past tense', () => {
    const malformed = slugs.filter((slug) => !SLUG.test(slug));

    expect(malformed).toEqual([]);
  });

  /**
   * Sorted, because the catalogue is append-mostly and read by humans deciding whether the slug
   * they need already exists. An unsorted list is how `member.removed` and `membership.removed`
   * both get added by two people who each searched the wrong end of the file.
   */
  it('lists slugs in sorted order', () => {
    expect(slugs).toEqual([...slugs].sort());
  });

  it('names every spec 030 connector action', () => {
    expect(slugs).toEqual(
      expect.arrayContaining([
        'connector.bound',
        'connector.database-reset',
        'connector.dns-written',
        'connector.published',
        'connector.resource-created',
        'connector.resource-released',
        'connector.unbound',
      ]),
    );
  });

  it('names every spec 017 action: the grant exchange, rotation, visibility and the callback refusal', () => {
    expect(slugs).toEqual(
      expect.arrayContaining([
        'preview-grant.issued',
        'preview-grant.refused',
        'preview.label-rotated',
        'preview.visibility-changed',
        'sandbox-callback.refused',
      ]),
    );
  });

  it('names every spec 018 action: the connection lifecycle, its health and the repo link', () => {
    expect(slugs).toEqual(
      expect.arrayContaining([
        'connector.connected',
        'connector.health-changed',
        'connector.reconnected',
        'connector.removed',
        'repo-link.created',
        'repo-link.removed',
      ]),
    );
  });

  it('names every spec 020 action: the provider-key lifecycle and its health', () => {
    expect(slugs).toEqual(
      expect.arrayContaining([
        'provider-key.added',
        'provider-key.health-changed',
        'provider-key.removed',
        'provider-key.replaced',
      ]),
    );
  });

  it('names every spec 027 action: the deployment lifecycle, release and offline', () => {
    expect(slugs).toEqual(
      expect.arrayContaining([
        'deploy.failed',
        'deploy.requested',
        'deploy.succeeded',
        'site.offline',
        'site.released',
      ]),
    );
  });

  it('names every spec 028 action: the custom-domain lifecycle, from add to removed', () => {
    expect(slugs).toEqual(
      expect.arrayContaining([
        'domain.activated',
        'domain.added',
        'domain.drifted',
        'domain.failed',
        'domain.ownership-verified',
        'domain.recovered',
        'domain.removal-requested',
        'domain.removed',
        'domain.retried',
      ]),
    );
  });

  it('names every spec 031 action: project invitations and grant role changes', () => {
    expect(slugs).toEqual(
      expect.arrayContaining([
        'project-grant.role-changed',
        'project-invitation.accepted',
        'project-invitation.created',
        'project-invitation.revoked',
      ]),
    );
  });

  it('gives every slug a summary a reviewer can read', () => {
    const undocumented = slugs.filter((slug) => AUDIT_ACTIONS[slug].trim() === '');

    expect(undocumented).toEqual([]);
  });
});
