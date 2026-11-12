import { z } from 'zod';

import { MAX_WAIT_SECONDS } from '../tool-kit';

/** Input fragments every tool group shares, so one field reads the same everywhere. */

export const projectId = z.uuid().describe('The project id, from list_projects or create_project.');

export const idempotencyKey = z
  .string()
  .regex(/^[A-Za-z0-9._~-]{8,100}$/)
  .optional()
  .describe(
    'Optional. Any unique string (8–100 of A-Z a-z 0-9 . _ ~ -). Retrying with the same key and arguments returns the first result instead of doing the work twice.',
  );

export const waitSeconds = z
  .number()
  .int()
  .min(0)
  .max(MAX_WAIT_SECONDS)
  .optional()
  .describe(
    `Optional. Wait up to this many seconds (max ${String(MAX_WAIT_SECONDS)}) for the work to finish before answering, with progress updates. 0 or absent answers at once. If it is still running when the wait ends, call again.`,
  );

/** The prompt and the model choice a run starts with, matching `createRunRequestSchema`. */
export const startRunInput = z.object({
  model: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe('Optional model id. Leave it out to use the person’s default.'),
  prompt: z
    .string()
    .trim()
    .min(1)
    .max(32_000)
    .describe(
      'What the build agent should do, in plain language — features, pages, data, style. It edits the code, runs it and fixes errors itself.',
    ),
  useClaudeSubscription: z
    .boolean()
    .optional()
    .describe(
      'Optional. true runs on the person’s connected Claude subscription; false or absent uses their default (the organization’s API key when no subscription is chosen).',
    ),
});
