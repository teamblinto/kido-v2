import { Inject, Injectable } from '@nestjs/common';
import type { ProjectTemplate } from '@repo/contracts';
import { sandboxPool, type TemplateVersion, templateVersions } from '@repo/db';
import { and, desc, eq, lt, not, notExists, sql } from 'drizzle-orm';

import { APP_DATABASE } from '../../database/database.constants';
import type { ForgeDatabase, TenantTransaction } from '../../database/database.types';
import type { CatalogueTemplate } from './template-catalogue';

/** What a definition contributes to its version row: the identity and the provider name. */
export interface VersionKey {
  readonly digest: string;
  readonly id: CatalogueTemplate;
  readonly snapshot: string;
}

/** A definition (`id`) or a version row (`template`): both name one `(template, digest)`. */
type VersionRef =
  | { readonly digest: string; readonly id: CatalogueTemplate }
  | { readonly digest: string; readonly template: string };

export type BeginOutcome = 'reserved' | 'already-current' | 'made-current' | 'building-elsewhere';

/**
 * The `template_versions` table behind the publisher, the refill and the claim (spec 015,
 * contract § 2, data-model.md § State transitions). Platform table: no tenant transaction.
 * `begin` is the whole publish lock — a reservation is an insert that answers nothing when it
 * loses, and a takeover is a conditional `update … returning` that answers nothing when someone
 * else took the row first; neither needs a lock of its own. The flip (`ready`, `made-current`)
 * is one transaction whose second statement the partial unique index refuses to run twice.
 */
@Injectable()
export class TemplateVersions {
  constructor(@Inject(APP_DATABASE) private readonly db: ForgeDatabase) {}

  /** The row the pool creates from: `ready` and `current`, or null when nothing is published. */
  async current(template: CatalogueTemplate): Promise<TemplateVersion | null> {
    const [row] = await this.db
      .select()
      .from(templateVersions)
      .where(
        and(
          eq(templateVersions.template, template),
          eq(templateVersions.current, true),
          eq(templateVersions.state, 'ready'),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** The templates with a ready, current version — one query for the catalogue's `ready`. */
  async currentTemplates(): Promise<ProjectTemplate[]> {
    const rows = await this.db
      .select({ template: templateVersions.template })
      .from(templateVersions)
      .where(and(eq(templateVersions.current, true), eq(templateVersions.state, 'ready')));
    return rows.map((r) => r.template as ProjectTemplate);
  }

  /** Every version of a template, newest reservation first. */
  list(template: CatalogueTemplate): Promise<TemplateVersion[]> {
    return this.db
      .select()
      .from(templateVersions)
      .where(eq(templateVersions.template, template))
      .orderBy(desc(templateVersions.createdAt));
  }

  /**
   * The five rows of contract § 2: no row → insert `building` (`reserved`; a lost race answers
   * `building-elsewhere`); `ready` + current → `already-current`; `ready` → flip
   * (`made-current`); `building` younger than `staleBefore` → `building-elsewhere`; a stale
   * `building`, `failed` or `retired` row → takeover by conditional update (`reserved`, or
   * `building-elsewhere` when the update matched nothing because another publish got there first).
   */
  async begin(def: VersionKey, now: Date, staleBefore: Date): Promise<BeginOutcome> {
    const [row] = await this.db.select().from(templateVersions).where(this.keyOf(def)).limit(1);

    if (!row) {
      const inserted = await this.db
        .insert(templateVersions)
        .values({
          createdAt: now,
          digest: def.digest,
          snapshot: def.snapshot,
          state: 'building',
          template: def.id,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .returning({ digest: templateVersions.digest });
      return inserted.length > 0 ? 'reserved' : 'building-elsewhere';
    }

    if (row.state === 'ready') {
      if (row.current) return 'already-current';
      await this.db.transaction((tx) => this.flip(tx, def, now));
      return 'made-current';
    }
    if (row.state === 'building' && row.createdAt >= staleBefore) return 'building-elsewhere';

    const taken = await this.db
      .update(templateVersions)
      .set({
        createdAt: now,
        failureReason: null,
        readyAt: null,
        retiredAt: null,
        state: 'building',
        updatedAt: now,
      })
      .where(
        and(
          this.keyOf(def),
          eq(templateVersions.state, row.state),
          row.state === 'building' ? lt(templateVersions.createdAt, staleBefore) : undefined,
        ),
      )
      .returning({ digest: templateVersions.digest });
    return taken.length > 0 ? 'reserved' : 'building-elsewhere';
  }

  /** `building → ready` and the flip to current, one transaction. */
  async ready(def: VersionKey, now: Date): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(templateVersions)
        .set({ failureReason: null, readyAt: now, state: 'ready', updatedAt: now })
        .where(this.keyOf(def));
      await this.flip(tx, def, now);
    });
  }

  /** `building → failed` with the reason; `current` is never touched (a building row is not). */
  async fail(def: VersionKey, reason: string, now: Date): Promise<void> {
    await this.db
      .update(templateVersions)
      .set({ failedAt: now, failureReason: reason, state: 'failed', updatedAt: now })
      .where(this.keyOf(def));
  }

  /** `ready`, not current, and no `sandbox_pool` row (any state) still names its snapshot. */
  retirable(template: CatalogueTemplate): Promise<TemplateVersion[]> {
    return this.db
      .select()
      .from(templateVersions)
      .where(
        and(
          eq(templateVersions.template, template),
          eq(templateVersions.state, 'ready'),
          not(templateVersions.current),
          notExists(
            this.db
              .select({ one: sql`1` })
              .from(sandboxPool)
              .where(eq(sandboxPool.snapshot, templateVersions.snapshot)),
          ),
        ),
      );
  }

  /** `ready → retired`, after the caller removed the provider snapshot; never a current row. */
  async retire(ref: VersionRef, now: Date): Promise<void> {
    await this.db
      .update(templateVersions)
      .set({ retiredAt: now, state: 'retired', updatedAt: now })
      .where(
        and(this.keyOf(ref), eq(templateVersions.state, 'ready'), not(templateVersions.current)),
      );
  }

  /** Clear the template's current flag, then set it on this ready row — in the caller's tx. */
  private async flip(tx: TenantTransaction, def: VersionKey, now: Date): Promise<void> {
    await tx
      .update(templateVersions)
      .set({ current: false, updatedAt: now })
      .where(and(eq(templateVersions.template, def.id), eq(templateVersions.current, true)));
    await tx
      .update(templateVersions)
      .set({ current: true, updatedAt: now })
      .where(and(this.keyOf(def), eq(templateVersions.state, 'ready')));
  }

  private keyOf(ref: VersionRef) {
    const template = 'id' in ref ? ref.id : ref.template;
    return and(eq(templateVersions.template, template), eq(templateVersions.digest, ref.digest));
  }
}
