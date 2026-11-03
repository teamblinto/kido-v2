import { z } from 'zod';

import { cursorPageQuerySchema, cursorSchema } from '../common/cursor';
import { companionFailureClassSchema, localAgentModelSchema } from '../local-agent/provider';
import { subscriptionRunTargetSchema } from '../local-agent/subscription';

/**
 * The agent run as a durable job (spec 008, contracts/http.md) — what the wire says about a run.
 *
 * Statuses and failure classes match the `run_status` / `run_failure_class` enums. What the row
 * carries and the wire does not: `lease_*`, `next_seq` (exposed as `lastSeq`), `credential_mode`,
 * `cost_micros`. A lease is the worker's business; a cost is 010's.
 */

export const RUN_STATUSES = [
  'queued',
  'starting',
  'running',
  'awaiting_input',
  'tool_error',
  'paused',
  'cancelled',
  'failed',
  'succeeded',
] as const;

export const runStatusSchema = z.enum(RUN_STATUSES);

export type RunStatus = z.output<typeof runStatusSchema>;

export const RUN_FAILURE_CLASSES = [
  'executor',
  'tool_error',
  'stalled',
  'cancelled_by_system',
  'internal',
  /** 020: a BYOK key the provider refused, or rate-limited past the budget. */
  'credential',
] as const;

export const runFailureClassSchema = z.enum(RUN_FAILURE_CLASSES);

export type RunFailureClass = z.output<typeof runFailureClassSchema>;

/** A prompt or an input: trimmed, non-empty, and bounded so a message never becomes a document. */
const runText = z.string().trim().min(1).max(32_000);

/** `POST /api/v1/orgs/:orgId/projects/:projectId/runs`, behind `project:agent.run`. */
export const createRunRequestSchema = z
  .strictObject({
    /** Use the organisation's credential while the caller's subscription is limited (spec 032 A3). */
    credential: z.literal('organisation').optional(),
    model: z.string().trim().min(1).optional(),
    prompt: runText,
    /** 041: run on the caller's own Claude subscription, in their cloud agent home. */
    subscription: subscriptionRunTargetSchema.optional(),
  })
  .refine((body) => body.credential === undefined || body.subscription === undefined, {
    error: 'A subscription run uses its own sign-in; send credential or subscription, not both.',
    path: ['credential'],
  })
  // The model reaches the CLI's argv, so a subscription run's is a plain token (040 § 3).
  .refine(
    (body) =>
      body.subscription === undefined ||
      body.model === undefined ||
      localAgentModelSchema.safeParse(body.model).success,
    { error: 'A subscription model is a plain model id or alias.', path: ['model'] },
  );

export type CreateRunRequest = z.output<typeof createRunRequestSchema>;

/**
 * `POST …/runs/:runId/input`, behind `project:agent.run`; the run must be `awaiting_input`.
 * `model` switches the model from this answer on; absent, the run keeps the one it had.
 */
export const runInputRequestSchema = z.strictObject({
  message: runText,
  model: localAgentModelSchema.optional(),
});

export type RunInputRequest = z.output<typeof runInputRequestSchema>;

/**
 * 040 (retired): what a person's own device asked permission for, and the two answers. Nothing
 * emits approvals now; the vocabulary stays so approval events already stored still parse.
 */
export const RUN_APPROVAL_KINDS = ['command', 'file_change', 'tool'] as const;

export const runApprovalKindSchema = z.enum(RUN_APPROVAL_KINDS);

export type RunApprovalKind = z.output<typeof runApprovalKindSchema>;

export const RUN_APPROVAL_DECISIONS = ['allow', 'deny'] as const;

export const runApprovalDecisionSchema = z.enum(RUN_APPROVAL_DECISIONS);

export type RunApprovalDecision = z.output<typeof runApprovalDecisionSchema>;

/**
 * The event envelope (data-model.md § envelope): `seq` is contiguous per run, `run` is the run
 * id, `at` is the worker's clock. One strict object per type, discriminated on `type`, so a
 * consumer switching over it is exhaustive and an undeclared field is refused rather than stored.
 *
 * `stepId` is `run_id/step_index` (§04 `operation_id`); `duplicateOf` on a `usage` event names the
 * step a resumed attempt re-executed (FR-019). The three non-durable types — `token`, `thought`,
 * `tool.delta` — are in the union because 009 streams them; the store never holds them.
 */
/**
 * Why a run moved state, for the two run-line transitions (spec 031, FR-034). Additive: the
 * `reason` stays optional, and a failure's free-text reason written before this still parses.
 */
export const runStateReasonSchema = z.enum(['cancelled-waiting', 'access-lost']);

export type RunStateReason = z.output<typeof runStateReasonSchema>;

const envelope = { at: z.iso.datetime(), run: z.uuid(), seq: z.number().int().min(1) };

export const runEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...envelope,
    data: z.strictObject({
      from: runStatusSchema.nullable(),
      reason: z.union([runStateReasonSchema, z.string()]).optional(),
      /**
       * Set when a subscription run's CLI failed, so the web picks its remedy from the class
       * rather than the reason's words.
       */
      localAgentFailure: z
        .strictObject({
          class: companionFailureClassSchema,
          /**
           * Always `subscription` now. `device`, an absent origin, and provider `codex` appear only
           * on events written by the retired local-agent feature (spec 040), kept so they parse.
           */
          origin: z.enum(['device', 'subscription']).optional(),
          provider: z.enum(['claude', 'codex']),
        })
        .optional(),
      /** Set with a `subscription-limited` failure (spec 032, FR-022). */
      resetsAt: z.iso.datetime().optional(),
      to: runStatusSchema,
    }),
    type: z.literal('state'),
  }),
  z.strictObject({
    ...envelope,
    data: z.strictObject({ input: z.unknown(), stepId: z.string(), tool: z.string() }),
    type: z.literal('tool.start'),
  }),
  z.strictObject({
    ...envelope,
    data: z.strictObject({
      error: z.string().optional(),
      ok: z.boolean(),
      output: z.unknown().optional(),
      stepId: z.string(),
    }),
    type: z.literal('tool.end'),
  }),
  z.strictObject({
    ...envelope,
    data: z.strictObject({ diff: z.string(), path: z.string() }),
    type: z.literal('file.patch'),
  }),
  z.strictObject({
    ...envelope,
    data: z.strictObject({ checkpointId: z.string(), label: z.string().optional() }),
    type: z.literal('checkpoint'),
  }),
  z.strictObject({
    ...envelope,
    data: z.strictObject({ url: z.string() }),
    type: z.literal('preview.ready'),
  }),
  z.strictObject({
    ...envelope,
    data: z.strictObject({
      cacheReadTokens: z.number().int().min(0).optional(),
      cacheWriteTokens: z.number().int().min(0).optional(),
      costMicros: z.number().int().min(0),
      duplicateOf: z.string().optional(),
      inputTokens: z.number().int().min(0),
      outputTokens: z.number().int().min(0),
      /** 021: absent = the model call; `summary` = the running-summary call. */
      source: z.enum(['summary']).optional(),
    }),
    type: z.literal('usage'),
  }),
  // 014 (FR-006): the run is in `starting` while its sandbox is created or resumed; emitted once
  // by the executor when the wait begins, so a console can say so.
  z.strictObject({
    ...envelope,
    data: z.strictObject({
      transition: z.enum(['creating', 'resuming', 'hibernating', 'releasing']),
    }),
    type: z.literal('sandbox.preparing'),
  }),
  // 040 (retired): a person's own device waited on their decision. Never emitted now; kept so the
  // approval events already stored still parse and a transcript can show them as history.
  z.strictObject({
    ...envelope,
    data: z.strictObject({
      detail: z.string(),
      kind: runApprovalKindSchema,
      requestId: z.string().min(1),
      title: z.string(),
    }),
    type: z.literal('approval.request'),
  }),
  z.strictObject({
    ...envelope,
    data: z.strictObject({
      by: z.enum(['user', 'timeout', 'run-ended']),
      decision: runApprovalDecisionSchema,
      requestId: z.string().min(1),
    }),
    type: z.literal('approval.resolved'),
  }),
  // token, thought, tool.delta (009): `seq` is the durable seq the event follows, not its own —
  // the store never allocates one for them, and the stream files them under that seq.
  z.strictObject({
    ...envelope,
    data: z.strictObject({ text: z.string() }),
    type: z.literal('token'),
  }),
  z.strictObject({
    ...envelope,
    data: z.strictObject({ text: z.string() }),
    type: z.literal('thought'),
  }),
  z.strictObject({
    ...envelope,
    data: z.strictObject({ chunk: z.string(), stepId: z.string() }),
    type: z.literal('tool.delta'),
  }),
]);

export type RunEvent = z.output<typeof runEventSchema>;

export type RunEventType = RunEvent['type'];

/** The types the store keeps; everything else is a stream-only event (009). */
export const DURABLE_RUN_EVENT_TYPES = [
  'state',
  'tool.start',
  'tool.end',
  'file.patch',
  'checkpoint',
  'preview.ready',
  'usage',
  'sandbox.preparing',
  'approval.request',
  'approval.resolved',
] as const satisfies readonly RunEventType[];

export type DurableRunEventType = (typeof DURABLE_RUN_EVENT_TYPES)[number];

export type DurableRunEvent = Extract<RunEvent, { type: DurableRunEventType }>;

export const runResponseSchema = z.strictObject({
  cacheReadTokens: z.number().int().min(0),
  cacheWriteTokens: z.number().int().min(0),
  cancelRequestedAt: z.iso.datetime().nullable(),
  /** 021: turns whose running summary was skipped, and why. */
  contextSkips: z.array(
    z.strictObject({ kind: z.enum(['summary']), reason: z.string(), turn: z.number().int() }),
  ),
  createdAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  failureClass: runFailureClassSchema.nullable(),
  id: z.uuid(),
  inputTokens: z.number().int(),
  /** `next_seq - 1`: the last event a reader can page up to. */
  lastSeq: z.number().int(),
  model: z.string(),
  outputTokens: z.number().int(),
  projectId: z.uuid(),
  /** 022: the first line of the run's prompt, trimmed and cut at 120, for a run-list row. */
  promptExcerpt: z.string().max(120),
  startedAt: z.iso.datetime().nullable(),
  status: runStatusSchema,
  userId: z.uuid(),
});

export type RunResponse = z.output<typeof runResponseSchema>;

/** `GET …/runs`, newest first, cursor-paged (022). */
export const runListResponseSchema = z.strictObject({
  nextCursor: cursorSchema.nullable(),
  runs: z.array(runResponseSchema),
});

export type RunListResponse = z.output<typeof runListResponseSchema>;

/** `GET …/runs/:runId/events`: `seq > after`, ascending, at most `limit`. */
export const runEventsResponseSchema = z.strictObject({
  events: z.array(runEventSchema),
  lastSeq: z.number().int(),
});

export type RunEventsResponse = z.output<typeof runEventsResponseSchema>;

export const runEventsQuerySchema = z.strictObject({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export type RunEventsQuery = z.output<typeof runEventsQuerySchema>;

/** 022: the shared cursor page, nothing else (contracts § 2). */
export const runListQuerySchema = cursorPageQuerySchema;

export type RunListQuery = z.output<typeof runListQuerySchema>;
