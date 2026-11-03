import { z } from 'zod';

import { cursorSchema } from '../common/cursor';
import { runStatusSchema } from './run';

/**
 * Settings → Usage: the caller's own runs in an organisation, newest first, with what each one
 * spent. `GET /api/v1/orgs/:orgId/usage/runs` (`cursorPageQuerySchema`), behind `org:read`.
 *
 * `paidWith` maps `credential_mode`: BYOS → `subscription`, BYOK → `api-key`, and the retired
 * PLATFORM → `platform-credits`, so runs paid with credits before they were retired stay readable.
 */
export const USAGE_PAID_WITH = ['subscription', 'api-key', 'platform-credits'] as const;

export const usagePaidWithSchema = z.enum(USAGE_PAID_WITH);

export type UsagePaidWith = z.output<typeof usagePaidWithSchema>;

export const usageRunSchema = z.strictObject({
  cacheReadTokens: z.number().int().min(0),
  cacheWriteTokens: z.number().int().min(0),
  /** Null when nothing priced the run (an API key's provider states tokens, not cost). */
  costMicros: z.number().int().min(0).nullable(),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  id: z.uuid(),
  inputTokens: z.number().int().min(0),
  model: z.string().nullable(),
  outputTokens: z.number().int().min(0),
  paidWith: usagePaidWithSchema,
  projectId: z.uuid(),
  projectName: z.string(),
  status: runStatusSchema,
});

export type UsageRun = z.output<typeof usageRunSchema>;

export const usageRunListResponseSchema = z.strictObject({
  nextCursor: cursorSchema.nullable(),
  runs: z.array(usageRunSchema),
});

export type UsageRunListResponse = z.output<typeof usageRunListResponseSchema>;
