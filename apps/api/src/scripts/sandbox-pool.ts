import 'reflect-metadata';

import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PROJECT_TEMPLATES, type ProjectTemplate } from '@repo/contracts';
import { sandboxPool } from '@repo/db';
import { count, eq, max } from 'drizzle-orm';

import { APP_DATABASE } from '../database/database.constants';
import type { ForgeDatabase } from '../database/database.types';
import { PoolSettingsService } from '../modules/sandbox/pool-settings';

/**
 * The pool dial (spec 014 contract § 6, research R11): `show` prints one line per template,
 * `set` upserts `sandbox_pool_settings` and prints the row. Reads `apps/api/.env` like the API
 * does; the API stack must be up. Boots with `RUN_PROFILES=api` like `register-sandbox.ts`.
 * The snapshot is not a dial since spec 015: the pool creates from the template's current
 * version (`template:publish`), so `--snapshot` is refused with the usage.
 */
const USAGE =
  'usage: pnpm --filter @repo/api build && pnpm --filter @repo/api sandbox:pool -- show\n' +
  '       pnpm --filter @repo/api sandbox:pool -- set <template> --depth <0..64>';

export type PoolArgs =
  | { readonly command: 'show' }
  | { readonly command: 'set'; readonly depth: number; readonly template: string };

export function parseArgs(argv: readonly string[]): PoolArgs {
  const [command, template, ...flags] = argv;
  if (command === 'show' && argv.length === 1) return { command };
  if (command !== 'set' || !template || template.startsWith('--')) throw new Error(USAGE);

  const opts: Record<string, string | undefined> = {};
  for (let i = 0; i < flags.length; i += 2) opts[flags[i]!] = flags[i + 1];
  if (Object.keys(opts).some((flag) => flag !== '--depth')) throw new Error(USAGE);

  const raw = opts['--depth'];
  if (raw === undefined) throw new Error(`--depth is required\n${USAGE}`);
  const depth = Number(raw);
  if (!Number.isInteger(depth)) throw new Error(`--depth must be an integer, got "${raw}"`);

  return { command, depth, template };
}

export interface PoolRow {
  readonly creating: number;
  readonly lastReadyAt: Date | null;
  readonly ready: number;
  readonly releasing: number;
  readonly target: number;
  readonly template: string;
}

/** `template target ready creating releasing last-ready-at`, `-` for a null. */
export function formatRow(row: PoolRow): string {
  return [
    row.template,
    row.target,
    row.ready,
    row.creating,
    row.releasing,
    row.lastReadyAt?.toISOString() ?? '-',
  ].join(' ');
}

async function poolRow(
  db: ForgeDatabase,
  settings: PoolSettingsService,
  template: ProjectTemplate,
): Promise<PoolRow> {
  const { targetDepth } = await settings.read(template);
  const counts = await db
    .select({ lastReadyAt: max(sandboxPool.readyAt), n: count(), state: sandboxPool.state })
    .from(sandboxPool)
    .where(eq(sandboxPool.template, template))
    .groupBy(sandboxPool.state);
  const by = (state: string) => counts.find((c) => c.state === state)?.n ?? 0;
  return {
    creating: by('creating'),
    lastReadyAt: counts.find((c) => c.state === 'ready')?.lastReadyAt ?? null,
    ready: by('ready'),
    releasing: by('releasing'),
    target: targetDepth,
    template,
  };
}

/**
 * The command against a booted application context: `set` upserts and prints the row, `show`
 * prints every template. Exported so the e2e can drive it in-process; `main` boots and calls it.
 */
export async function run(app: INestApplicationContext, args: PoolArgs): Promise<number> {
  const db = app.get<ForgeDatabase>(APP_DATABASE);
  const settings = app.get(PoolSettingsService);

  if (args.command === 'set') {
    const { depth, template } = args;
    try {
      await settings.upsert(template, { depth });
    } catch (error) {
      // The service's two refusals (range, template) name the rule; anything else is a fault.
      if (error instanceof RangeError || (error as Error).message.startsWith('unknown template')) {
        console.error((error as Error).message);
        return 1;
      }
      throw error;
    }
    console.log(formatRow(await poolRow(db, settings, template as ProjectTemplate)));
    return 0;
  }

  for (const template of PROJECT_TEMPLATES) {
    console.log(formatRow(await poolRow(db, settings, template)));
  }
  return 0;
}

async function main(): Promise<number> {
  let args: PoolArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }

  // Before `AppModule` loads: `ConfigModule.forRoot` reads the environment at import time.
  process.env.RUN_PROFILES = 'api';
  const { AppModule } = await import('../app.module.js');
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });

  try {
    return await run(app, args);
  } finally {
    await app.close();
  }
}

// Vitest imports this module for its pure exports; the command runs only as the process entry.
if (process.argv[1] && /sandbox-pool\.[cm]?js$/.test(process.argv[1])) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
