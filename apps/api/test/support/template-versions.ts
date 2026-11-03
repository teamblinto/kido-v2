import { templateVersions } from '@repo/db';
import { eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';

import type { ForgeDatabase } from '../../src/database/database.types';
import type { CatalogueTemplate } from '../../src/modules/sandbox/template-catalogue';

/**
 * A published version without a build (spec 015, research R8): one `ready` row named `snapshot`,
 * current unless told otherwise, with a digest derived from the name so two fakes never collide
 * on the `(template, digest)` key. The 014 suites seed the pool's source through this instead of
 * the retired `sandbox_pool_settings.snapshot`; `template-catalogue.e2e-spec.ts` publishes for real.
 */
export async function publishFakeVersion(
  db: ForgeDatabase,
  template: CatalogueTemplate,
  snapshot: string,
  { current = true }: { readonly current?: boolean } = {},
): Promise<void> {
  const now = new Date();
  const digest = createHash('sha256').update(snapshot).digest('hex');
  await db.transaction(async (tx) => {
    if (current) {
      await tx
        .update(templateVersions)
        .set({ current: false, updatedAt: now })
        .where(eq(templateVersions.template, template));
    }
    await tx
      .insert(templateVersions)
      .values({
        createdAt: now,
        current,
        digest,
        readyAt: now,
        snapshot,
        state: 'ready',
        template,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        set: { current, failureReason: null, readyAt: now, state: 'ready', updatedAt: now },
        target: [templateVersions.template, templateVersions.digest],
      });
  });
}

/** Undo `publishFakeVersion`: every version row of the template (the suites own their templates). */
export async function dropFakeVersions(
  db: ForgeDatabase,
  template: CatalogueTemplate,
): Promise<void> {
  await db.delete(templateVersions).where(eq(templateVersions.template, template));
}
