/**
 * The closed vocabulary of things the audit trail can say happened.
 *
 * Closed the way `common/errors/problem-types.ts` is closed, and for the same reason: a frozen
 * literal, `as const satisfies` so the shape is checked, and {@link AuditAction} derived from the
 * keys rather than declared beside them. `AuditService.record()` takes that union, so an action this
 * file does not list is a compile error at the call site instead of a new string that reaches
 * production and quietly becomes a second spelling of an existing event. `audit-actions.spec.ts`
 * holds that guarantee down with a `@ts-expect-error`, so `pnpm typecheck` fails if it ever stops
 * being true.
 *
 * **Every slug here is organisation-scoped, and that is a constraint rather than an accident.**
 * `audit_log.org_id` is `not null` (T05), so an account-scope security event that belongs to no
 * organisation — a login, a failed login, a password reset, an MFA enrolment — cannot be recorded
 * in this table at all. Those go to the structured application log (§05). A later task looking for
 * `user.logged-in` should not add it: it would need an `org_id` it does not have, and inventing one
 * is worse than the omission. `packages/db/src/schema/audit.ts` explains why a nullable `org_id`
 * was rejected as the alternative.
 *
 * Slugs are `domain.event`, past tense. Permissions (`org:members.invite`, T24) are a different
 * vocabulary in the imperative, and keeping the two visibly different is what stops one being
 * pasted where the other belongs.
 *
 * The value is a one-line summary. It is read by whoever is deciding whether the slug they need
 * already exists, which is the moment a catalogue like this is either useful or quietly forked into
 * two names for one event.
 */
export const AUDIT_ACTIONS = Object.freeze({
  'agent-run.cancel-requested': 'A user asked for a running agent run to stop.',
  'agent-run.created': 'A user started an agent run in a project.',
  'agent-run.input': 'A user answered an agent run that was waiting for input.',
  'checkpoint.edited': 'A member saved a file by hand in the web editor.',
  'checkpoint.reverted': "A member restored a project's workspace to an earlier checkpoint.",
  // Spec 030: the connector actions carry `provider` in their metadata; the seven below are its own.
  'connector.bound': 'A project was bound to a provider resource (a site, a database, a domain).',
  'connector.connected':
    'A provider connection (an App installation, a grant or a token) was added.',
  'connector.database-reset': "A project's Neon preview branch was deleted and created afresh.",
  'connector.dns-written': "A domain's records were written into the tenant's Cloudflare zone.",
  'connector.health-changed':
    "A connection's health moved between healthy, unavailable and needs-reauth.",
  'connector.published': "A project's release was published to its bound Netlify site.",
  'connector.reconnected': 'A connection in needs-reauth was reinstalled and its token re-minted.',
  'connector.removed': 'A connection was removed, with its sealed token and repo links.',
  'connector.resource-created':
    'The platform created a resource in a provider account (a branch, a key, a record).',
  'connector.resource-released': 'A resource the platform created in a provider was released.',
  'connector.unbound': "A project's binding to a provider resource was removed.",
  'deploy.failed': 'A deployment failed, with the reason from the failure vocabulary.',
  'deploy.requested': "A member asked for a project's checkpoint to be built and deployed.",
  'deploy.succeeded': "A deployment went live and became the project's current site.",
  'domain.activated': 'A custom domain was verified and its certificate went live.',
  'domain.added': 'A member added a custom domain to a project; it is pending verification.',
  'domain.drifted': "An active custom domain's DNS stopped pointing at the platform.",
  'domain.failed': 'A custom domain could not be verified, with the reason from its vocabulary.',
  'domain.ownership-verified': "A custom domain's ownership TXT record was found and matched.",
  'domain.recovered': "A drifted custom domain's DNS pointed back at the platform.",
  'domain.removal-requested': 'A custom domain was sent to removal, by a member, archive or sweep.',
  'domain.removed': 'A custom domain was deregistered at the edge and stopped serving.',
  'domain.retried': 'A member retried a failed custom domain, opening a new verification window.',
  'impersonation.ended': 'A support impersonation session ended or expired.',
  'impersonation.started': 'Support began a time-boxed impersonation, with a reason string.',
  'import.failed': 'A GitHub repository import failed; its project was withdrawn.',
  'import.requested': 'A GitHub repository import was requested into a new project.',
  'import.succeeded': 'A GitHub repository import finished; the project is linked and level.',
  'invitation.accepted': 'An invited address accepted and became a member.',
  'invitation.created': 'A member was invited to the organisation.',
  'invitation.revoked': 'A pending invitation was withdrawn before it was used.',
  'membership.created': 'A user was added to the organisation.',
  'membership.removed': "A user's membership of the organisation was ended.",
  'membership.role-changed': "A member's organisation role was changed.",
  'org-data-key.created': 'The organisation was issued its first data-encryption key.',
  'org-data-key.rewrapped': 'An organisation data key was rewrapped under a new KEK.',
  'org.created': 'An organisation was created.',
  'org.deleted': 'An organisation was deleted.',
  'org.personal-accounts-changed':
    "An owner or admin allowed or forbade members' personal model accounts in the organisation.",
  'org.updated': "An organisation's settings were changed.",
  'preview-grant.issued':
    'A member redeemed a preview authorisation code for a grant on one preview host.',
  'preview-grant.refused':
    'A preview authorisation was refused: not a member, wrong host, spent code or rotated label.',
  'preview.label-rotated':
    "A project's preview label was rotated, so the old preview URL stopped resolving.",
  'preview.visibility-changed': "Who may reach a project's preview was changed.",
  'project-grant.granted': 'A guest was granted access to a single project.',
  'project-grant.revoked': "A guest's access to a project was withdrawn.",
  'project-grant.role-changed': "A user's role on a single project was changed.",
  'project-invitation.accepted': 'An invited address accepted and was granted access to a project.',
  'project-invitation.created': 'Someone was invited by email to a single project.',
  'project-invitation.revoked': 'A pending project invitation was withdrawn before it was used.',
  'project.created': 'A project was created.',
  'project.deleted': 'A project was deleted.',
  'project.updated': "A project's settings were changed.",
  'provider-key.added': "The organisation's first LLM provider key for a provider was stored.",
  'provider-key.health-changed':
    "A provider key's health moved between healthy and needs-reauth, at run time or on a check.",
  'provider-key.removed': 'An admin removed a provider key and its sealed secret.',
  'provider-key.replaced': 'A provider key replaced another for the same provider.',
  'repo-link.created': 'A project was linked to a repository on a connection.',
  'repo-link.removed': "A project's repository link was removed.",
  'repo-link.updated': "A project's repository link changed branch or auto-sync.",
  'sandbox-callback.refused':
    'A sandbox callback was refused: unknown sandbox, bad token or a stale lease.',
  'sandbox.claimed': 'A project took a sandbox from the warm pool, or had one created for it.',
  'sandbox.lost': "The reconciler found the provider no longer has a project's sandbox.",
  'sandbox.registered': 'An operator registered a hand-created sandbox against a project.',
  'sandbox.released': "A project's sandbox was deleted at the provider and its record removed.",
  'secret.created': 'A tenant secret was sealed and stored.',
  'secret.deleted': 'A tenant secret was deleted.',
  'secret.updated': 'A tenant secret was resealed with a new value.',
  'site.offline': "A project's site was taken offline, so its address stopped serving.",
  'site.released':
    "An earlier succeeded deployment was made the project's current site (rollback or forward).",
  'webhook.endpoint-created': 'A member created a webhook endpoint and was shown its secret once.',
  'webhook.endpoint-deleted': 'A webhook endpoint was deleted, with its delivery log.',
  'webhook.endpoint-paused': 'A webhook endpoint was paused after 24 hours of failed deliveries.',
  'webhook.endpoint-secret-rotated': "A webhook endpoint's signing secret was rotated.",
  'webhook.endpoint-updated': "A webhook endpoint's URL, events, scope or state was changed.",
  'webhook.send-replayed': 'A member replayed one webhook delivery to its endpoint.',
  'workspace.created': 'A workspace was created.',
  'workspace.deleted': 'A workspace was deleted.',
  'workspace.updated': "A workspace's settings were changed.",
} as const satisfies Readonly<Record<string, string>>);

/**
 * Every action the trail may record. Derived from {@link AUDIT_ACTIONS}, never written out
 * separately — a union maintained by hand beside the catalogue is a union that drifts from it.
 */
export type AuditAction = keyof typeof AUDIT_ACTIONS;
