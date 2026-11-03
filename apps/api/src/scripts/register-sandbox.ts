import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { ConflictError, NotFoundError } from '../common/errors/domain-error';
import { TenantTransactionRunner } from '../database/tenant-transaction';
import { DaytonaError } from '../modules/sandbox/sandbox.errors';
import { SandboxService } from '../modules/sandbox/sandbox.service';

/**
 * Registers a hand-created Daytona sandbox against a project (spec 010 US3): one `sandboxes` row
 * and one audit row, in one tenant transaction, after Daytona has confirmed the sandbox is running.
 * Reads `apps/api/.env` like the API does; the API stack (Postgres, Redis) must be up.
 */
const USAGE =
  'usage: pnpm --filter @repo/api build && ' +
  'pnpm --filter @repo/api sandbox:register <orgId> <projectId> <daytonaId>';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main(): Promise<number> {
  const [orgId, projectId, daytonaId] = process.argv.slice(2);

  if (!orgId || !UUID.test(orgId) || !projectId || !UUID.test(projectId) || !daytonaId) {
    console.error(USAGE);
    return 1;
  }

  // Before `AppModule` loads: `ConfigModule.forRoot` reads the environment at import time. A
  // one-shot context that drains nothing is the request-serving side's code path with no listener.
  process.env.RUN_PROFILES = 'api';
  const { AppModule } = await import('../app.module.js');
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });

  try {
    const transactions = app.get(TenantTransactionRunner);
    const service = app.get(SandboxService);
    const { id, node, workspaceRoot } = await transactions.runInTenantScope(
      { orgId, userId: null },
      (tx) => service.register(tx, { daytonaId, orgId, projectId }),
    );

    console.log(
      `registered sandbox ${id} for project ${projectId} (root ${workspaceRoot}, node ${node ?? 'unknown'})`,
    );
    return 0;
  } catch (error) {
    if (error instanceof ConflictError || error instanceof NotFoundError) {
      console.error(`${error.type}: ${error.detail}`);
      return 1;
    }
    if (error instanceof DaytonaError) {
      console.error(`${error.kind}: ${error.message}`);
      return 1;
    }
    throw error;
  } finally {
    await app.close();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  },
);
