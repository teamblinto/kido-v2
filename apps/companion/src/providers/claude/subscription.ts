import type { ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import {
  localAgentModelSchema,
  type SUBSCRIPTION_USAGE_WINDOWS,
  type SubscriptionUsage,
} from '@repo/contracts';

import { log } from '../../log.ts';
import { killTree, type ResolvedBinary, spawnBinary } from '../../process.ts';
import { isRecord, str, truncate } from '../../util.ts';
import type { SubscriptionDetails } from '../types.ts';

/**
 * What the signed-in CLI itself says its subscription offers: the models from its `initialize`
 * control request and the plan's limits from `get_usage` (verified against Claude Code 2.1.317).
 * Neither sends a model request, so asking costs the person nothing; no prompt is ever written.
 */

export const DETAILS_TIMEOUT_MS = 15_000;

const REQUESTS = ['initialize', 'get_usage'] as const;
type Request = (typeof REQUESTS)[number];

/** `get_usage`'s `rate_limits` keys this contract names; every other key is skipped. */
const WINDOWS: Record<string, (typeof SUBSCRIPTION_USAGE_WINDOWS)[number]> = {
  five_hour: 'session',
  seven_day: 'weekly',
  seven_day_opus: 'weekly-opus',
  seven_day_sonnet: 'weekly-sonnet',
};

/** `max` → `Max`: the CLI's plan id as a display name. */
export function planLabel(raw: string | undefined): string | null {
  return raw ? truncate(raw.charAt(0).toUpperCase() + raw.slice(1), 100) : null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text.trim()) as unknown;
  } catch {
    return undefined;
  }
}

/** `initialize`'s `models`, as the run's `--model` takes them; one that could not reach argv is dropped. */
export function claudeModels(response: unknown): SubscriptionDetails['models'] {
  const listed = isRecord(response) && Array.isArray(response.models) ? response.models : [];
  const models: SubscriptionDetails['models'] = [];
  const seen = new Set<string>();
  for (const entry of listed as unknown[]) {
    if (!isRecord(entry)) continue;
    const id = str(entry.value);
    if (!id || seen.has(id) || !localAgentModelSchema.safeParse(id).success) continue;
    seen.add(id);
    const description = str(entry.description)?.trim();
    const label = str(entry.displayName)?.trim() ?? '';
    models.push({
      description: description ? truncate(description, 200) : null,
      id,
      label: truncate(label.length > 0 ? label : id, 200),
    });
    if (models.length === 100) break;
  }
  return models;
}

/** `get_usage`'s windows, utilization clamped to 0–100; null when the CLI cannot state limits. */
export function claudeUsage(response: unknown, checkedAt: string): SubscriptionUsage | null {
  if (!isRecord(response) || response.rate_limits_available === false) return null;
  const limits = response.rate_limits;
  if (!isRecord(limits)) return null;
  const windows: SubscriptionUsage['windows'] = [];
  for (const [key, kind] of Object.entries(WINDOWS)) {
    const window = limits[key];
    if (!isRecord(window) || typeof window.utilization !== 'number') continue;
    if (!Number.isFinite(window.utilization)) continue;
    const resets = typeof window.resets_at === 'string' ? Date.parse(window.resets_at) : NaN;
    windows.push({
      kind,
      resetsAt: Number.isNaN(resets) ? null : new Date(resets).toISOString(),
      utilization: Math.min(100, Math.max(0, window.utilization)),
    });
  }
  return { checkedAt, windows };
}

/**
 * Starts the CLI in stream-json mode, asks both control requests, and kills it once both are
 * answered, it exits, or `timeoutMs` passes — whichever is first. Answers what it got; never throws.
 */
function ask(
  binary: ResolvedBinary,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  timeoutMs: number,
): Promise<Partial<Record<Request, unknown>>> {
  return new Promise((resolve) => {
    const answers: Partial<Record<Request, unknown>> = {};
    const pending = new Set<string>(REQUESTS);
    let child: ChildProcess;
    try {
      child = spawnBinary(binary, args, { cwd, env });
    } catch (error) {
      log.debug(`claude details probe did not start: ${String(error)}`);
      resolve(answers);
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // Killed before the answer is used, so the cwd it holds can be removed after.
      void killTree(child).finally(() => resolve(answers));
    };
    const timer = setTimeout(finish, timeoutMs);
    child.once('error', finish);
    child.once('exit', finish);
    child.stdin?.on('error', () => undefined);
    child.stderr?.resume();
    if (child.stdout) {
      createInterface({ crlfDelay: Infinity, input: child.stdout }).on('line', (line) => {
        const message = parseJson(line);
        if (done || !isRecord(message) || message.type !== 'control_response') return;
        const response = isRecord(message.response) ? message.response : {};
        const id = str(response.request_id);
        if (!id || !pending.delete(id)) return;
        if (response.subtype === 'success') answers[id as Request] = response.response;
        if (pending.size === 0) finish();
      });
    }
    for (const subtype of REQUESTS) {
      child.stdin?.write(
        `${JSON.stringify({ request: { subtype }, request_id: subtype, type: 'control_request' })}\n`,
      );
    }
  });
}

export interface DetailsOptions {
  /** The CLI's flags; the caller passes the same sandbox flags a run gets. */
  args: string[];
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/** The models and limits the signed-in CLI reports, or null when it answered neither. */
export async function claudeDetails(
  binary: ResolvedBinary,
  options: DetailsOptions,
): Promise<SubscriptionDetails | null> {
  let cwd: string | null = null;
  try {
    // An empty private cwd, as a run's: nothing in it for the CLI to read.
    cwd = await mkdtemp(join(tmpdir(), 'baios-probe-'));
    const answers = await ask(
      binary,
      options.args,
      options.env,
      cwd,
      options.timeoutMs ?? DETAILS_TIMEOUT_MS,
    );
    if (answers.initialize === undefined && answers.get_usage === undefined) return null;
    return {
      models: claudeModels(answers.initialize),
      plan: planLabel(
        isRecord(answers.get_usage) ? str(answers.get_usage.subscription_type) : undefined,
      ),
      usage: claudeUsage(answers.get_usage, new Date().toISOString()),
    };
  } catch (error) {
    log.debug(`claude details probe failed: ${String(error)}`);
    return null;
  } finally {
    if (cwd) await rm(cwd, { force: true, recursive: true }).catch(() => undefined);
  }
}
