import { foreignKey, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';

import { timestamps } from './columns';
import { projects } from './tenancy';

/**
 * One row per project: the tree state the repository map was built from (spec 021,
 * data-model.md § project_context). Keyed by the project rather than an id of its own — there is
 * never a second row — so the primary key `(org_id, project_id)` is the tenant-first key
 * `schema.spec.ts` expects, and the composite FK deletes the map with the project. `head_sha` is
 * `null` until the first build (research R2); `dirty_digest` is the sha-256 of the sorted
 * `status --porcelain` output the map was built against (R3). Written only by the executor, under
 * the run's fence-holding dispatch.
 */
export const projectContext = pgTable(
  'project_context',
  {
    dirtyDigest: text('dirty_digest').notNull().default(''),
    headSha: text('head_sha'),
    orgId: uuid('org_id').notNull(),
    projectId: uuid('project_id').notNull(),
    repoMap: text('repo_map').notNull().default(''),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.projectId], name: 'project_context_pkey' }),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.id],
      name: 'project_context_org_id_project_id_fk',
    }).onDelete('cascade'),
  ],
);

export type ProjectContext = typeof projectContext.$inferSelect;
export type NewProjectContext = typeof projectContext.$inferInsert;
