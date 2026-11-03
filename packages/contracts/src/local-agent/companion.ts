import { z } from 'zod';

import {
  companionFailureClassSchema,
  localAgentAuthMethodSchema,
  localAgentModelSchema,
  localAgentProviderSchema,
  localAgentProviderSessionIdSchema,
  localAgentProviderStatusSchema,
} from './provider';

// Defined beside the provider vocabulary (run.ts reads them), and re-exported so the wire's names stay where the companion looks for them.
export {
  COMPANION_FAILURE_CLASSES,
  type CompanionFailureClass,
  companionFailureClassSchema,
  localAgentModelSchema,
  localAgentProviderSessionIdSchema,
} from './provider';

/**
 * The runner's wire (spec 040 § 4, spec 041): the companion in hosted mode, inside a person's cloud
 * agent home, takes commands down an SSE stream whose `id:` is the stream seq (so
 * `Last-Event-ID` resumes it), and sends status and run events up over HTTPS POST. Both
 * directions are validated on receipt: the runner trusts the server no more than the reverse.
 */

const runId = z.uuid();
/**
 * Which turn of a run a command or an event belongs to: 1 for the prompt, +1 per answer. A
 * follow-up turn reuses the run id, so the companion dedupes `run.start` on (run, turn) and the
 * server files each turn's events apart, so a late retry of turn 1 cannot land in turn 2.
 */
const turn = z.number().int().min(1);
const toolId = z.string().min(1).max(128);

/** The longest heartbeat interval `hello` may set; the companion's watchdog is three of them. */
export const LOCAL_AGENT_MAX_HEARTBEAT_SECONDS = 300;

/**
 * The largest downlink event, in characters of its SSE `data:`. The biggest legitimate commands are
 * a `run.start` with a 32 000-character prompt and its toolset, and a `tool.result` with a
 * 48 000-character output; both fit even fully `\uXXXX`-escaped. The companion skips a larger
 * event (advancing `Last-Event-ID` past it) rather than reconnecting into it.
 */
export const LOCAL_AGENT_MAX_COMMAND_CHARS = 327_680;

/**
 * The sandbox tool bridge (spec 041): the CLI's own file and shell tools are off, and it calls these — the cloud agent's tools, by wire name — through a tool
 * server the companion runs, which relays each call to the server as a `tool.call` run event and
 * answers the CLI with the `tool.result` command. The companion names that server
 * {@link LOCAL_AGENT_SANDBOX_TOOL_SERVER}, so the CLI reports the tools as `mcp__baios__<name>`.
 */
export const LOCAL_AGENT_SANDBOX_TOOLS = [
  'fs_read',
  'fs_list',
  'fs_edit',
  'exec',
  'search',
  'find',
  'preview_status',
] as const;

export const localAgentSandboxToolSchema = z.enum(LOCAL_AGENT_SANDBOX_TOOLS);

export type LocalAgentSandboxTool = z.output<typeof localAgentSandboxToolSchema>;

export const LOCAL_AGENT_SANDBOX_TOOL_SERVER = 'baios';

/** The bridged tool a CLI's own tool name stands for (`mcp__baios__fs_edit` → `fs_edit`), if any. */
export function sandboxToolOf(cliToolName: string): LocalAgentSandboxTool | undefined {
  const prefix = `mcp__${LOCAL_AGENT_SANDBOX_TOOL_SERVER}__`;
  if (!cliToolName.startsWith(prefix)) return undefined;
  const parsed = localAgentSandboxToolSchema.safeParse(cliToolName.slice(prefix.length));
  return parsed.success ? parsed.data : undefined;
}

/** A `tool.call`'s input, in JSON characters: under the uplink's 1 MB body even as 3-byte UTF-8. */
export const LOCAL_AGENT_MAX_TOOL_INPUT_CHARS = 262_144;

/**
 * A `tool.result`'s output, in characters. Under 50 000 on purpose: Claude Code moves a longer
 * tool result into a local file, which a CLI with its file tools off cannot read back.
 */
export const LOCAL_AGENT_MAX_TOOL_OUTPUT_CHARS = 48_000;

/**
 * The output as sent: whole when it fits, else its head and a marker saying how much was cut, at
 * most {@link LOCAL_AGENT_MAX_TOOL_OUTPUT_CHARS} in all. Never splits a surrogate pair.
 */
export function truncateToolOutput(output: string): string {
  if (output.length <= LOCAL_AGENT_MAX_TOOL_OUTPUT_CHARS) return output;
  const marker = (kept: number) =>
    `\n[output truncated: the first ${String(kept)} of ${String(output.length)} characters are shown]`;
  let kept = LOCAL_AGENT_MAX_TOOL_OUTPUT_CHARS - marker(LOCAL_AGENT_MAX_TOOL_OUTPUT_CHARS).length;
  const last = output.charCodeAt(kept - 1);
  if (last >= 0xd800 && last <= 0xdbff) kept -= 1;
  return `${output.slice(0, kept)}${marker(kept)}`;
}

/** One bridged tool as `run.start` offers it: a JSON Schema whose root is an object (MCP's rule). */
export const companionToolDefinitionSchema = z.strictObject({
  description: z.string().min(1).max(2_000),
  inputSchema: z.looseObject({ type: z.literal('object') }),
  name: localAgentSandboxToolSchema,
});

export type CompanionToolDefinition = z.output<typeof companionToolDefinitionSchema>;

/**
 * Opaque and stable per BAIOS project (the server derives it; the companion only keys on it): the
 * companion runs the CLI in one empty directory per key, so the CLI's
 * resume finds the sessions it saved there.
 */
export const localAgentConversationKeySchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

const callId = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/);

/**
 * What `hello` hands the companion for its own pre-spawn check (ADR decision 10): per provider,
 * the auth methods this deployment lets it run with. Empty or left out means blocked. A method
 * list rather than a yes/no because the companion re-checks against the CLI's *current* sign-in,
 * which may have changed since the server last saw a status report.
 */
export const companionPolicySchema = z.partialRecord(
  localAgentProviderSchema,
  z.strictObject({ allowedAuthMethods: z.array(localAgentAuthMethodSchema) }),
);

export type CompanionPolicy = z.output<typeof companionPolicySchema>;

/** Downlink: one strict object per command, discriminated on `type`. */
export const companionCommandSchema = z.discriminatedUnion('type', [
  z.strictObject({
    deviceId: z.uuid(),
    heartbeatSeconds: z.number().int().min(1).max(LOCAL_AGENT_MAX_HEARTBEAT_SECONDS),
    policy: companionPolicySchema,
    type: z.literal('hello'),
  }),
  z.strictObject({ type: z.literal('status.refresh') }),
  z.strictObject({
    /** Stable per project (see the schema). */
    conversationKey: localAgentConversationKeySchema,
    /** `null` leaves the choice to the CLI's own default. */
    model: localAgentModelSchema.nullable(),
    prompt: z.string().min(1).max(32_000),
    provider: localAgentProviderSchema,
    /** The provider's own session id from an earlier run, as an opaque reference. */
    resume: z.strictObject({ providerSessionId: localAgentProviderSessionIdSchema }).nullable(),
    runId,
    /** The tools to offer the CLI, and only these. */
    toolset: z.array(companionToolDefinitionSchema).min(1).max(LOCAL_AGENT_SANDBOX_TOOLS.length),
    turn,
    type: z.literal('run.start'),
  }),
  z.strictObject({
    message: z.string().min(1).max(32_000),
    runId,
    type: z.literal('run.input'),
  }),
  z.strictObject({ runId, turn, type: z.literal('run.interrupt') }),
  z.strictObject({ type: z.literal('device.revoked') }),
  z.strictObject({
    callId,
    /** Set with `ok: false`, so it maps straight onto the tool server's own error flag. */
    isError: z.boolean().optional(),
    /** False when the call failed: refused input, a sandbox refusal, or a run taking no calls. */
    ok: z.boolean(),
    /** What the model reads: the tool's answer, or `kind: <kind>\n<detail>` on a failure. */
    output: z.string().max(LOCAL_AGENT_MAX_TOOL_OUTPUT_CHARS),
    runId,
    turn,
    type: z.literal('tool.result'),
  }),
]);

export type CompanionCommand = z.output<typeof companionCommandSchema>;

export type CompanionCommandType = CompanionCommand['type'];

/** Uplink, `POST /local-agent/status`: what the companion found on its last probe. */
export const companionStatusReportSchema = z.strictObject({
  companionVersion: z.string().trim().min(1).max(64),
  providers: z.array(localAgentProviderStatusSchema).max(10),
});

export type CompanionStatusReport = z.output<typeof companionStatusReportSchema>;

const chunk = z.string().max(65_536);

/**
 * `seq` is per run and strictly increasing from 1; the server drops any `seq` it already holds,
 * which is what makes a retried batch idempotent after a reconnect.
 */
const seq = z.number().int().min(1);

export const companionRunEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    data: z.strictObject({ providerSessionId: localAgentProviderSessionIdSchema }),
    seq,
    type: z.literal('session'),
  }),
  z.strictObject({ data: z.strictObject({ text: chunk }), seq, type: z.literal('text.delta') }),
  z.strictObject({
    data: z.strictObject({ text: chunk }),
    seq,
    type: z.literal('reasoning.delta'),
  }),
  z.strictObject({
    data: z.strictObject({
      input: z.unknown(),
      name: z.string().min(1).max(200),
      toolId,
    }),
    seq,
    type: z.literal('tool.start'),
  }),
  z.strictObject({
    data: z.strictObject({ chunk, toolId }),
    seq,
    type: z.literal('tool.output'),
  }),
  z.strictObject({
    data: z.strictObject({ ok: z.boolean(), summary: chunk.nullable(), toolId }),
    seq,
    type: z.literal('tool.end'),
  }),
  z.strictObject({
    data: z.strictObject({
      callId,
      /**
       * A JSON object (it arrives as JSON), at most {@link LOCAL_AGENT_MAX_TOOL_INPUT_CHARS} as JSON.
       * Values are `unknown`, not `z.json()`: a recursive schema has no OpenAPI rendering, and the
       * tool's own schema checks them on the server.
       */
      input: z
        .record(z.string(), z.unknown())
        .refine((input) => JSON.stringify(input).length <= LOCAL_AGENT_MAX_TOOL_INPUT_CHARS, {
          error: 'The tool input is too large.',
        }),
      name: localAgentSandboxToolSchema,
    }),
    seq,
    /** The CLI called a bridged tool; the server answers with `tool.result`. */
    type: z.literal('tool.call'),
  }),
  z.strictObject({
    data: z.strictObject({
      inputTokens: z.number().int().min(0),
      outputTokens: z.number().int().min(0),
    }),
    seq,
    type: z.literal('usage'),
  }),
  z.strictObject({
    data: z
      .strictObject({
        failure: z
          .strictObject({
            class: companionFailureClassSchema,
            message: z.string().max(4_000),
            /** Set with `usage_limit` when the CLI said when the limit lifts. */
            resetsAt: z.iso.datetime().optional(),
          })
          .optional(),
        status: z.enum(['completed', 'interrupted', 'failed']),
      })
      .refine((data) => (data.status === 'failed') === (data.failure !== undefined), {
        error: 'A failure is sent with status failed, and only then.',
        path: ['failure'],
      }),
    seq,
    type: z.literal('terminal'),
  }),
]);

export type CompanionRunEvent = z.output<typeof companionRunEventSchema>;

export type CompanionRunEventType = CompanionRunEvent['type'];

/** Uplink, `POST /local-agent/runs/:runId/events`. */
export const companionRunEventBatchSchema = z.strictObject({
  events: z.array(companionRunEventSchema).min(1).max(500),
  /** The `turn` of the `run.start` these events answer; the server refuses any other. */
  turn,
});

export type CompanionRunEventBatch = z.output<typeof companionRunEventBatchSchema>;
