import { z } from 'zod';

import { DURABLE_RUN_EVENT_TYPES, runEventSchema, runResponseSchema } from './run';

/**
 * The run event stream (spec 009, contracts/http.md): `GET …/runs/:runId/stream` is SSE whose
 * frames carry the 008 envelope verbatim. `id:` on a frame is the durable `seq`, so a browser's
 * `Last-Event-ID` is a `seq` — never a Redis entry id — and the handler parses it with
 * {@link lastEventIdSchema}.
 */

/** The `retry:` hint the stream opens with. */
export const STREAM_RETRY_MS = 2_000;

/** The comment frame written when nothing else has been for `heartbeatMs`. */
export const STREAM_HEARTBEAT = ':heartbeat';

/** The header; bounds (`≤ lastSeq`) are the handler's. */
export const lastEventIdSchema = z.coerce.number().int().min(0);

const DURABLE = new Set<string>(DURABLE_RUN_EVENT_TYPES);

/** The 008 durable variants: what the store holds and a `stream.reset` snapshot carries. */
export const durableRunEventSchema = runEventSchema.refine((event) => DURABLE.has(event.type), {
  message: 'A snapshot carries durable events only.',
});

/**
 * Sent once when the requested `seq` has aged out of the stream: the run as `GET …/runs/:runId`
 * answers it and every durable event after the requested `seq`, from Postgres. `seq` and the
 * frame's `id` are the snapshot's last `seq` (or the requested one when it is empty).
 */
export const streamResetEventSchema = z.strictObject({
  at: z.iso.datetime(),
  data: z.strictObject({
    events: z.array(durableRunEventSchema),
    run: runResponseSchema,
  }),
  run: z.uuid(),
  seq: z.number().int().min(0),
  type: z.literal('stream.reset'),
});

export type StreamResetEvent = z.output<typeof streamResetEventSchema>;

/** Everything a frame's `data` can be: one schema for a client to parse every frame with. */
export const streamEventSchema = z.union([runEventSchema, streamResetEventSchema]);

export type StreamEvent = z.output<typeof streamEventSchema>;

/**
 * Every `event:` name a frame is written under (`run-stream-reader.ts`): a real `EventSource`
 * delivers a named frame only to a listener registered for that name, never to `onmessage`.
 */
export const STREAM_EVENT_TYPES: readonly StreamEvent['type'][] = [
  ...runEventSchema.options.map((option) => option.shape.type.value),
  'stream.reset',
];
