import { z } from 'zod';

import { runStatusSchema } from './run';

/**
 * The run line (spec 031, contracts/run-line.md): one started run holds a project, and later
 * starts wait behind it in creation order, at most {@link RUN_LINE_LIMIT} of them.
 */

/** The most runs that may wait behind a project's holder (research R3); a fixed number, not a dial. */
export const RUN_LINE_LIMIT = 5;

const startedBySchema = z.strictObject({ email: z.email(), userId: z.uuid() });

export const runLineEntrySchema = z.strictObject({
  createdAt: z.iso.datetime(),
  position: z.number().int().min(1), // 1 for the head of the line
  runId: z.uuid(),
  startedBy: startedBySchema,
});

export type RunLineEntry = z.output<typeof runLineEntrySchema>;

/** `GET …/runs/line`. `holder` is null when no started run holds the project. */
export const runLineResponseSchema = z.strictObject({
  holder: z
    .strictObject({ runId: z.uuid(), startedBy: startedBySchema, status: runStatusSchema })
    .nullable(),
  waiting: z.array(runLineEntrySchema).max(RUN_LINE_LIMIT),
});

export type RunLineResponse = z.output<typeof runLineResponseSchema>;

/** `POST …/runs` refuses with `409`, `reason: 'queue-full'`, when the line is full. */
export const runLineConflictReasonSchema = z.enum(['queue-full']);

export type RunLineConflictReason = z.output<typeof runLineConflictReasonSchema>;
