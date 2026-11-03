import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PROJECT_TEMPLATES, type ProjectTemplate } from '@repo/contracts';
import { sandboxPoolSettings } from '@repo/db';
import { eq } from 'drizzle-orm';

import { CLOCK, type ClockPort } from '../../common/clock/clock.port';
import type { Environment } from '../../config/environment';
import { APP_DATABASE } from '../../database/database.constants';
import type { ForgeDatabase } from '../../database/database.types';

/**
 * A template's pool dial (spec 014, data-model.md § sandbox_pool_settings): the target depth.
 * An absent row answers the environment default (`DEPLOY_ENV = local ? 1 : 4`, research R10).
 * The snapshot the refill creates from is the template's current version (spec 015, FR-011),
 * not a setting. Written only by the `sandbox:pool` command through `upsert` (research R11).
 */
export interface PoolSettings {
  readonly targetDepth: number;
  readonly template: ProjectTemplate;
}

export const MIN_DEPTH = 0;
export const MAX_DEPTH = 64;

@Injectable()
export class PoolSettingsService {
  private readonly defaultDepth: number;

  constructor(
    @Inject(APP_DATABASE) private readonly db: ForgeDatabase,
    config: ConfigService<Environment, true>,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {
    this.defaultDepth = config.get('DEPLOY_ENV', { infer: true }) === 'local' ? 1 : 4;
  }

  /** The row, or the default when there is none. Platform table: no tenant transaction. */
  async read(template: ProjectTemplate): Promise<PoolSettings> {
    const [row] = await this.db
      .select()
      .from(sandboxPoolSettings)
      .where(eq(sandboxPoolSettings.template, template))
      .limit(1);
    return { targetDepth: row?.targetDepth ?? this.defaultDepth, template };
  }

  /**
   * The dial (FR-019): `depth` is an integer in `0..64` and `template` one of
   * `PROJECT_TEMPLATES`, each refused with a message naming the rule. Answers the row as `read`
   * would.
   */
  async upsert(template: string, input: { readonly depth: number }): Promise<PoolSettings> {
    if (!(PROJECT_TEMPLATES as readonly string[]).includes(template)) {
      throw new Error(
        `unknown template "${template}"; expected one of ${PROJECT_TEMPLATES.join(', ')}`,
      );
    }
    if (!Number.isInteger(input.depth) || input.depth < MIN_DEPTH || input.depth > MAX_DEPTH) {
      throw new RangeError(
        `depth must be an integer in ${MIN_DEPTH}..${MAX_DEPTH}, got ${input.depth}`,
      );
    }

    const values = { targetDepth: input.depth, updatedAt: this.clock.now() };
    const [row] = await this.db
      .insert(sandboxPoolSettings)
      .values({ template, ...values })
      .onConflictDoUpdate({ set: values, target: sandboxPoolSettings.template })
      .returning();
    return { targetDepth: row!.targetDepth, template: template as ProjectTemplate };
  }
}
