import 'reflect-metadata';

import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { LLM_PROVIDERS } from '@repo/contracts';

import { APP_DATABASE } from '../database/database.constants';
import type { ForgeDatabase } from '../database/database.types';
import { ByosProviders } from '../modules/agent/byos/byos-providers';
import { LinkedAccountRepository } from '../modules/agent/byos/linked-account.repository';
import type { LlmProviderName } from '../modules/agent/llm-provider.port';
import { OutboxWriter } from '../modules/outbox/outbox-writer';

/**
 * The BYOS provider switch (spec 032 T018, research R12): `in-force` records the given reference
 * and the time it was switched on; `withdrawn` also appends, in the same transaction, one
 * `mail.byos` per linked account for that provider. Every write goes through `ByosProviders` and
 * `OutboxWriter`; there is no SQL here. Exit codes: 0 done, 2 usage.
 */
const USAGE =
  'usage: pnpm --filter @repo/api build && pnpm --filter @repo/api byos:provider -- ' +
  '<anthropic|openai> <in-force|withdrawn> [--record <path>]';

export type ProviderArgs =
  | { readonly provider: LlmProviderName; readonly status: 'in-force'; readonly record: string }
  | { readonly provider: LlmProviderName; readonly status: 'withdrawn' };

export class UsageError extends Error {}

export function parseArgs(argv: readonly string[]): ProviderArgs {
  const [provider, status, ...flags] = argv;
  if (!(LLM_PROVIDERS as readonly (string | undefined)[]).includes(provider)) {
    throw new UsageError(USAGE);
  }
  const name = provider as LlmProviderName;
  if (status === 'withdrawn' && flags.length === 0) return { provider: name, status };
  if (status === 'in-force') {
    if (flags.length === 2 && flags[0] === '--record' && flags[1]) {
      return { provider: name, record: flags[1], status };
    }
    throw new UsageError(`in-force requires --record <path>\n${USAGE}`);
  }
  throw new UsageError(USAGE);
}

export interface ProviderCommandDeps {
  readonly database: Pick<ForgeDatabase, 'transaction'>;
  readonly providers: ByosProviders;
  readonly accounts: LinkedAccountRepository;
  readonly outbox: OutboxWriter;
  readonly now?: () => Date;
  readonly out?: (line: string) => void;
}

/** The command against its collaborators; exported so the spec can drive it in-process. */
export async function runCommand(deps: ProviderCommandDeps, args: ProviderArgs): Promise<number> {
  const out = deps.out ?? console.log;
  const now = deps.now ?? (() => new Date());

  if (args.status === 'in-force') {
    const at = now();
    await deps.database.transaction((tx) =>
      deps.providers.setStatus(tx, args.provider, {
        record: args.record,
        signedOffAt: at,
        status: 'in_force',
      }),
    );
    out(`${args.provider} in force (${at.toISOString()})`);
    return 0;
  }

  const mailed = await deps.database.transaction(async (tx) => {
    const existed = await deps.providers.setStatus(tx, args.provider, {
      at: now(),
      status: 'withdrawn',
    });
    if (!existed) return 0;
    const linked = await deps.accounts.byProviderForWithdrawal(tx, args.provider);
    for (const account of linked) {
      await deps.outbox.append(tx, {
        aggregateId: account.id,
        payload: {
          kind: 'provider-withdrawn',
          provider: args.provider,
          recipientUserId: account.userId,
        },
        type: 'mail.byos',
      });
    }
    return linked.length;
  });
  out(`${args.provider} withdrawn (${mailed} linked account(s) told)`);
  return 0;
}

export function run(app: INestApplicationContext, args: ProviderArgs): Promise<number> {
  return runCommand(
    {
      accounts: app.get(LinkedAccountRepository),
      database: app.get<ForgeDatabase>(APP_DATABASE),
      outbox: app.get(OutboxWriter),
      providers: app.get(ByosProviders),
    },
    args,
  );
}

async function main(): Promise<number> {
  let args: ProviderArgs;
  try {
    args = parseArgs(process.argv.slice(2).filter((arg) => arg !== '--'));
  } catch (error) {
    console.error((error as Error).message);
    return 2;
  }

  // Before `AppModule` loads: `ConfigModule.forRoot` reads (and validates) the environment then.
  process.env.RUN_PROFILES = 'api';
  const { AppModule } = await import('../app.module.js');
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });

  try {
    return await run(app, args);
  } finally {
    await app.close();
  }
}

if (process.argv[1] && /byos-provider\.[cm]?js$/.test(process.argv[1])) {
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
