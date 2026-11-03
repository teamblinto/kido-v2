import { Global, Module } from '@nestjs/common';

import { AuditService } from './audit.service';

/**
 * The append-only security trail (§09, T10).
 *
 * `@Global` for the reason `CryptoModule` gives. Spec 001's last code-style rule is that "every
 * write that a security team would ask about calls `AuditService` in the same transaction as the
 * state change", which makes the importer list every feature module that mutates anything —
 * identity, tenancy, invitations, rbac, secrets. Restating the import in each of them buys nothing,
 * and forgetting it has no silent fallback: injection fails and the module does not build.
 *
 * It matters more than tidiness here. Those modules are being written in parallel lanes against
 * this one interface, and a global provider means none of them has to edit its own module metadata
 * to reach it — one fewer file each lane touches, in the file most likely to conflict.
 *
 * There is no repository and no read side. `audit_log` is written through the caller's transaction
 * and read by operators through the bypass role; a query surface for it is a later task with its
 * own permission model, not something to leave lying around now.
 */
@Global()
@Module({
  exports: [AuditService],
  providers: [AuditService],
})
export class AuditModule {}
