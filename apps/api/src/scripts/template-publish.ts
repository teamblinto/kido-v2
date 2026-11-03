import 'reflect-metadata';

import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PROJECT_TEMPLATES, type ProjectTemplate } from '@repo/contracts';

import { DaytonaAdapter } from '../modules/sandbox/daytona.adapter';
import {
  type CatalogueTemplate,
  SYSTEM_TEMPLATES,
  TemplateCatalogue,
} from '../modules/sandbox/template-catalogue';
import { type PublishOutcome, TemplatePublisher } from '../modules/sandbox/template-publisher';
import { TemplateVersions } from '../modules/sandbox/template-versions';

/**
 * The catalogue's operator command (spec 015 contract § 4, research R6): `publish [all|<template>]`
 * builds what is missing through `TemplatePublisher`, one template at a time, printing a line as
 * each finishes; `show` prints one line per template with the current digest and whether the
 * provider still has it (FR-016). Boots with `RUN_PROFILES=api` like `sandbox-pool.ts`.
 */
const USAGE =
  'usage: pnpm --filter @repo/api build && pnpm --filter @repo/api template:publish -- [all | <template>]\n' +
  '       pnpm --filter @repo/api template:show';

export type PublishArgs =
  | { readonly command: 'publish'; readonly templates: 'all' | readonly CatalogueTemplate[] }
  | { readonly command: 'show' };

/** A project template, or a system one (spec 041's `agent-home`); `all` stays the projects'. */
const isTemplate = (name: string): name is CatalogueTemplate =>
  ([...PROJECT_TEMPLATES, ...SYSTEM_TEMPLATES] as readonly string[]).includes(name);

export function parseArgs(raw: readonly string[]): PublishArgs {
  // pnpm passes the documented `template:publish -- <template>` separator through to the script.
  const argv = raw.filter((arg) => arg !== '--');
  const [command, target] = argv;
  if (command === 'show' && argv.length === 1) return { command };
  if (command !== 'publish' || argv.length > 2) throw new Error(USAGE);
  if (target === undefined || target === 'all') return { command, templates: 'all' };
  if (!isTemplate(target)) throw new Error(`unknown template ${target}\n${USAGE}`);
  return { command, templates: [target] };
}

/** `template digest[0:12] outcome [reason]`. */
export function formatPublishLine(
  template: string,
  digest: string,
  outcome: PublishOutcome,
): string {
  const line = `${template} ${digest.slice(0, 12)} ${outcome.kind}`;
  return outcome.kind === 'failed' ? `${line} ${outcome.reason}` : line;
}

export interface ShowRow {
  readonly building: string | null;
  readonly current: string | null;
  readonly failed: string | null;
  readonly readyAt: Date | null;
  readonly retired: number;
  readonly template: string;
  /** Why the current version cannot be created from right now, or null when it can. */
  readonly unavailable: string | null;
}

const short = (digest: string | null): string => digest?.slice(0, 12) ?? '-';

/** `template current|- ready-at|- building|- failed|- retired-count [unavailable: <reason>]`. */
export function formatShowRow(row: ShowRow): string {
  const line = [
    row.template,
    short(row.current),
    row.readyAt?.toISOString() ?? '-',
    short(row.building),
    short(row.failed),
    row.retired,
  ].join(' ');
  return row.unavailable === null ? line : `${line} unavailable: ${row.unavailable}`;
}

async function showRow(
  versions: TemplateVersions,
  daytona: DaytonaAdapter,
  template: ProjectTemplate,
): Promise<ShowRow> {
  const rows = await versions.list(template);
  const current = rows.find((row) => row.current && row.state === 'ready') ?? null;
  const first = (state: string) => rows.find((row) => row.state === state)?.digest ?? null;
  let unavailable: string | null = null;
  if (current !== null) {
    // FR-016: the truth is at the provider — a snapshot deleted by hand, or Daytona's own
    // two-week `inactive`, reads `unavailable` here; the remedy is the same republish.
    const snapshot = await daytona.describeSnapshot(current.snapshot);
    if (snapshot === null) unavailable = 'snapshot not found at the provider';
    else if (snapshot.state !== 'active') unavailable = `snapshot is ${snapshot.state}`;
  }
  return {
    building: first('building'),
    current: current?.digest ?? null,
    failed: first('failed'),
    readyAt: current?.readyAt ?? null,
    retired: rows.filter((row) => row.state === 'retired').length,
    template,
    unavailable,
  };
}

/**
 * The command against a booted application context. Exported so the e2e drives it in-process;
 * `main` boots and calls it. Exit `1` when any publish outcome is `failed`.
 */
export async function run(app: INestApplicationContext, args: PublishArgs): Promise<number> {
  if (args.command === 'show') {
    const versions = app.get(TemplateVersions, { strict: false });
    const daytona = app.get(DaytonaAdapter, { strict: false });
    for (const template of PROJECT_TEMPLATES) {
      console.log(formatShowRow(await showRow(versions, daytona, template)));
    }
    return 0;
  }

  const catalogue = app.get(TemplateCatalogue, { strict: false });
  const publisher = app.get(TemplatePublisher, { strict: false });
  let failed = false;
  for (const template of args.templates === 'all' ? PROJECT_TEMPLATES : args.templates) {
    const outcome = await publisher.publish(template);
    failed ||= outcome.kind === 'failed';
    console.log(formatPublishLine(template, catalogue.get(template).digest, outcome));
  }
  return failed ? 1 : 0;
}

async function main(): Promise<number> {
  let args: PublishArgs;
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
if (process.argv[1] && /template-publish\.[cm]?js$/.test(process.argv[1])) {
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
