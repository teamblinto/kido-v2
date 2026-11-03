import 'reflect-metadata';

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { OBJECT_STORE, type ObjectStorePort } from '../common/object-store/object-store.port';
import { TenantTransactionRunner } from '../database/tenant-transaction';
import { CheckpointRepository } from '../modules/checkpoints/checkpoint.repository';
import { mirrorKey } from '../modules/checkpoints/repo-mirror.consumer';
import { OutboxWriter } from '../modules/outbox/outbox-writer';

/**
 * The mirror's operator command (spec 016 contract § 8, research R12, FR-020): `repo:verify
 * <orgId> <projectId>` reads the head checkpoint, `head`s the project's object, downloads the
 * bundle to a temp dir and runs `git bundle verify` + `git ls-remote <bundle> HEAD` on this
 * machine — the bundle's HEAD equal to the labelled sha is the restore rehearsal (equal sha ⇒
 * identical tree). Exit 0 only when current and verified. `--mirror-now` appends
 * `checkpoint.created` for the head row instead and exits 0. Boots with `RUN_PROFILES=api` like
 * `template-publish.ts`.
 */
const USAGE =
  'usage: pnpm --filter @repo/api build && pnpm --filter @repo/api repo:verify -- <orgId> <projectId> [--mirror-now]';

export interface VerifyArgs {
  readonly mirrorNow: boolean;
  readonly orgId: string;
  readonly projectId: string;
}

export function parseArgs(argv: readonly string[]): VerifyArgs {
  const [orgId, projectId, flag] = argv;
  if (orgId === undefined || projectId === undefined || argv.length > 3) throw new Error(USAGE);
  if (flag !== undefined && flag !== '--mirror-now') throw new Error(USAGE);
  return { mirrorNow: flag !== undefined, orgId, projectId };
}

export type BundleState = 'verified' | 'missing' | 'corrupt';

export interface VerifyRow {
  readonly bundle: BundleState;
  /** The head checkpoint's sha, null when the project has no checkpoint. */
  readonly head: string | null;
  /** The sha the object is labelled with, null when there is no object. */
  readonly mirror: string | null;
}

const isCurrent = (row: VerifyRow): boolean => row.head !== null && row.head === row.mirror;

/** Four lines: `head checkpoint`, `mirror head`, `current: yes|no`, `bundle: <state>`. */
export function formatRow(row: VerifyRow): string {
  return [
    `head checkpoint: ${row.head ?? '-'}`,
    `mirror head: ${row.mirror ?? '-'}`,
    `current: ${isCurrent(row) ? 'yes' : 'no'}`,
    `bundle: ${row.bundle}`,
  ].join('\n');
}

export const exitCode = (row: VerifyRow): number =>
  isCurrent(row) && row.bundle === 'verified' ? 0 : 1;

/** `git` on the operator's machine; `ok` is exit 0. Injected so the spec never spawns one. */
export type Exec = (
  file: string,
  args: readonly string[],
) => Promise<{ ok: boolean; stdout: string }>;

const git: Exec = (file, args) =>
  new Promise((resolve) => {
    execFile(file, [...args], (error, stdout) => {
      resolve({ ok: error === null, stdout });
    });
  });

/** `git bundle verify` then `git ls-remote <bundle> HEAD`; the HEAD must be the labelled sha. */
export async function verifyBundle(
  body: Buffer,
  expectedHead: string,
  exec: Exec = git,
): Promise<BundleState> {
  const dir = await mkdtemp(join(tmpdir(), 'repo-verify-'));
  const bundle = join(dir, 'mirror.bundle');
  try {
    await writeFile(bundle, body);
    const verify = await exec('git', ['bundle', 'verify', bundle]);
    if (!verify.ok) return 'corrupt';
    const head = await exec('git', ['ls-remote', bundle, 'HEAD']);
    return head.ok && head.stdout.split(/\s+/)[0] === expectedHead ? 'verified' : 'corrupt';
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

/** The command against a booted application context; `main` boots and calls it. */
export async function run(app: INestApplicationContext, args: VerifyArgs): Promise<number> {
  const transactions = app.get(TenantTransactionRunner, { strict: false });
  const repository = app.get(CheckpointRepository, { strict: false });
  const { orgId, projectId } = args;

  const head = await transactions.runInTenantTransaction(orgId, (tx) =>
    repository.head(tx, orgId, projectId),
  );

  if (args.mirrorNow) {
    if (head === null) {
      console.error(`project ${projectId} has no checkpoint to mirror`);
      return 1;
    }
    const outbox = app.get(OutboxWriter, { strict: false });
    await transactions.runInTenantTransaction(orgId, (tx) =>
      outbox.append(tx, {
        aggregateId: head.id,
        orgId,
        payload: { checkpointId: head.id, orgId, projectId },
        type: 'checkpoint.created',
      }),
    );
    console.log(`mirror enqueued for checkpoint ${head.id} (${head.gitSha})`);
    return 0;
  }

  const store = app.get<ObjectStorePort>(OBJECT_STORE, { strict: false });
  const object = await store.get(mirrorKey(orgId, projectId));
  const mirror = object?.meta.head ?? null;
  const bundle =
    object === null || mirror === null ? 'missing' : await verifyBundle(object.body, mirror);
  const row: VerifyRow = { bundle, head: head?.gitSha ?? null, mirror };
  console.log(formatRow(row));
  return exitCode(row);
}

async function main(): Promise<number> {
  let args: VerifyArgs;
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
if (process.argv[1] && /repo-verify\.[cm]?js$/.test(process.argv[1])) {
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
