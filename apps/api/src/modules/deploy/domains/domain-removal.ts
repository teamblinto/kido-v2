import type { TenantTransaction } from '../../../database/database.types';
import type { AuditService } from '../../audit/audit.service';
import type { OutboxWriter } from '../../outbox/outbox-writer';
import type { Domain } from './domain.repository';

/**
 * The trail of one `→ removing` (research R10, FR-027), on the transaction that moved the row with
 * `DomainRepository.markRemoving`: a `domain.removal-requested` audit row and a `domain.removing`
 * event, which `DomainCheckConsumer` takes to deregister at once. `actorId` is the member who
 * removed it, or null for archive and the org-deletion sweep (data-model § Audit actions).
 * `reason` is the row's `failure_reason`: null for a removal, set when a failure heads for `failed`.
 */
export async function recordRemovalRequested(
  tx: TenantTransaction,
  trail: { readonly audit: AuditService; readonly outbox: OutboxWriter },
  domain: Domain,
  actorId: string | null,
): Promise<void> {
  const { failureReason: reason, hostname, id: domainId, orgId, projectId } = domain;

  await trail.audit.record(tx, {
    action: 'domain.removal-requested',
    actorId,
    metadata: reason === null ? { hostname, projectId } : { hostname, projectId, reason },
    orgId,
    target: domainId,
  });
  await trail.outbox.append(tx, {
    aggregateId: domainId,
    orgId,
    payload: { domainId, orgId, projectId, reason },
    type: 'domain.removing',
  });
}
