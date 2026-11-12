import type { RunEvent, RunResponse, RunStatus } from '@repo/contracts';
import { z } from 'zod';

import type { McpToolKit, ToolCall } from '../tool-kit';
import { idempotencyKey, projectId, startRunInput, waitSeconds } from './inputs';

const runId = z.uuid().describe('The agent run id, from start_agent_run or list_agent_runs.');

/** A run has stopped doing work: finished, or waiting on a person. */
const SETTLED: readonly RunStatus[] = [
  'awaiting_input',
  'cancelled',
  'failed',
  'paused',
  'succeeded',
];

/** What to do next, by status: the agent reads this instead of guessing the state machine. */
const NEXT_STEP: Readonly<Record<RunStatus, string>> = {
  awaiting_input:
    'The build agent asked a question (see lastAssistantMessage). Answer it with reply_to_agent_run.',
  cancelled: 'The run was cancelled. Start a new one with start_agent_run if more work is needed.',
  failed:
    'The run failed (see failureClass and errors). Fix the cause — e.g. connect a Claude subscription or an API key in Settings if it is a credential failure — and start a new run, or describe the error in a new prompt.',
  paused: 'The run is paused by the platform and will resume on its own; check again shortly.',
  queued: 'Waiting for its turn. Call get_agent_run with waitSeconds to follow it.',
  running: 'Still working. Call get_agent_run with waitSeconds (and sinceSeq) to follow it.',
  starting:
    'Preparing the workspace. Call get_agent_run with waitSeconds (and sinceSeq) to follow it.',
  succeeded:
    'Done. Check the result with get_preview (open the URL), read files, or deploy with deploy_project.',
  tool_error: 'A tool failed; the agent is recovering. Keep following with get_agent_run.',
};

/** The build agent: the platform's own AI developer, which edits, runs and fixes the project. */
export function registerRunTools(kit: McpToolKit): void {
  kit.tool(
    'start_agent_run',
    {
      description:
        "Hand a task to the platform's build agent, which writes the code, installs packages, runs the app and fixes its own errors in the project's workspace. This is how to build or change an app end to end — 'add a dashboard with subscription management', 'fix the errors in the console'. One run at a time per project; while one is active, a new one queues behind it. Returns the run; follow it with get_agent_run.",
      input: startRunInput.extend({ idempotencyKey, projectId, waitSeconds }),
      scope: 'projects:write',
      title: 'Start agent run',
    },
    async (args, call) => {
      const run = await call.once(args.idempotencyKey, args, async () =>
        startRun(call, args.projectId, args),
      );

      return watch(call, args.projectId, run.id, args.waitSeconds ?? 0, 0);
    },
  );

  kit.tool(
    'get_agent_run',
    {
      description:
        "A build agent run's status, what it did since `sinceSeq` (files changed, tools run, checkpoints, errors), its latest reply, and the next step. Pass waitSeconds to wait for it to finish, with progress updates; pass the returned `lastSeq` as sinceSeq on the next call to see only new activity.",
      input: z.object({
        projectId,
        runId,
        sinceSeq: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            'Only report activity after this event sequence number (from a previous lastSeq).',
          ),
        waitSeconds,
      }),
      scope: 'projects:read',
      title: 'Get agent run',
    },
    async (args, call) =>
      watch(call, args.projectId, args.runId, args.waitSeconds ?? 0, args.sinceSeq ?? 0),
  );

  kit.tool(
    'reply_to_agent_run',
    {
      description:
        'Answer a build agent run that is waiting for input (status awaiting_input), or give it a follow-up instruction. The run continues with your message.',
      input: z.object({
        message: startRunInput.shape.prompt.describe('Your answer or follow-up instruction.'),
        model: startRunInput.shape.model,
        projectId,
        runId,
        waitSeconds,
      }),
      scope: 'projects:write',
      title: 'Reply to agent run',
    },
    async (args, call) => {
      const { orgId, userId } = call.principal;
      const before = await call.inProject(args.projectId, 'project:agent.run', async () => {
        const current = await call.platform.runs.read(orgId, args.projectId, args.runId);
        await call.platform.runs.input(
          orgId,
          args.projectId,
          args.runId,
          userId,
          args.message,
          args.model,
        );

        return current.lastSeq;
      });

      return watch(call, args.projectId, args.runId, args.waitSeconds ?? 0, before);
    },
  );

  kit.tool(
    'cancel_agent_run',
    {
      description:
        'Stop a build agent run. Work it already finished stays (each turn is checkpointed); use restore_checkpoint to undo it.',
      destructive: true,
      idempotent: true,
      input: z.object({ projectId, runId }),
      scope: 'projects:write',
      title: 'Cancel agent run',
    },
    async (args, call) => {
      const { orgId, userId } = call.principal;

      return call.inProject(args.projectId, 'project:agent.run', async () => {
        await call.platform.runs.cancel(orgId, args.projectId, args.runId, userId);

        return {
          cancelRequested: true,
          run: await call.platform.runs.read(orgId, args.projectId, args.runId),
        };
      });
    },
  );

  kit.tool(
    'list_agent_runs',
    {
      description: "The project's build agent runs, newest first, with status and prompt excerpt.",
      input: z.object({
        cursor: z.string().max(500).optional().describe('nextCursor from a previous page.'),
        limit: z.number().int().min(1).max(50).optional(),
        projectId,
      }),
      scope: 'projects:read',
      title: 'List agent runs',
    },
    async (args, call) =>
      call.inProject(args.projectId, 'project:read', () =>
        call.platform.runs.list(call.principal.orgId, args.projectId, {
          ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
          limit: args.limit ?? 20,
        }),
      ),
  );

  kit.tool(
    'get_conversation',
    {
      description:
        "The project's conversation with the build agent — what was asked and what it answered — newest first. Read it to understand what was already built before asking for changes.",
      input: z.object({
        cursor: z.string().max(500).optional().describe('nextCursor from a previous page.'),
        limit: z.number().int().min(1).max(50).optional(),
        projectId,
      }),
      scope: 'projects:read',
      title: 'Get conversation',
    },
    async (args, call) =>
      call.inProject(args.projectId, 'project:read', () =>
        call.platform.runs.messages(call.principal.orgId, args.projectId, {
          ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
          limit: args.limit ?? 20,
        }),
      ),
  );
}

/** Start a run exactly as `POST …/runs` does, with the web app's model-choice mapping. */
export async function startRun(
  call: ToolCall,
  project: string,
  input: {
    model?: string | undefined;
    prompt: string;
    useClaudeSubscription?: boolean | undefined;
  },
): Promise<RunResponse> {
  const { orgId, userId } = call.principal;

  return call.inProject(project, 'project:agent.run', () =>
    call.platform.runs.create(
      orgId,
      project,
      userId,
      input.prompt,
      input.model,
      undefined,
      input.useClaudeSubscription === true ? { provider: 'claude' } : undefined,
    ),
  );
}

/** The run now, or once it settles within `seconds`, and what happened after `sinceSeq`. */
async function watch(
  call: ToolCall,
  project: string,
  run: string,
  seconds: number,
  sinceSeq: number,
): Promise<object> {
  const read = (): Promise<RunResponse> =>
    call.inProject(project, 'project:read', () =>
      call.platform.runs.read(call.principal.orgId, project, run),
    );

  const settled = await call.waitFor(seconds, async (elapsed) => {
    const now = await read();

    return SETTLED.includes(now.status)
      ? { done: true as const, value: now }
      : { done: false as const, note: `Agent run ${now.status} (${String(elapsed)}s)` };
  });

  return describe(call, project, settled ?? (await read()), sinceSeq);
}

async function describe(
  call: ToolCall,
  project: string,
  run: RunResponse,
  sinceSeq: number,
): Promise<object> {
  const { orgId } = call.principal;
  const { events, messages } = await call.inProject(project, 'project:read', async () => ({
    events: await call.platform.runs.events(orgId, project, run.id, sinceSeq, 500),
    messages: await call.platform.runs.messages(orgId, project, { limit: 10 }),
  }));
  const reply = messages.messages.find((one) => one.runId === run.id && one.role === 'assistant');

  return {
    activity: summarise(events.events),
    lastAssistantMessage: reply?.content ?? null,
    lastSeq: events.lastSeq,
    nextStep: NEXT_STEP[run.status],
    run: {
      createdAt: run.createdAt,
      endedAt: run.endedAt,
      failureClass: run.failureClass,
      id: run.id,
      model: run.model,
      prompt: run.promptExcerpt,
      status: run.status,
    },
  };
}

/**
 * The durable events, reduced to what an agent reasons about: which files moved, which tools ran
 * and failed, which checkpoints were cut, where the preview is. Diffs and tool inputs stay out —
 * they are the bulk of the log and the agent can read any file it needs.
 */
function summarise(events: readonly RunEvent[]): object {
  const files = new Set<string>();
  const checkpoints: string[] = [];
  const errors: string[] = [];
  const tools: string[] = [];
  let previewUrl: string | null = null;

  for (const event of events) {
    switch (event.type) {
      case 'file.patch':
        files.add(event.data.path);
        break;
      case 'checkpoint':
        checkpoints.push(event.data.checkpointId);
        break;
      case 'tool.start':
        tools.push(event.data.tool);
        break;
      case 'tool.end':
        if (!event.data.ok && event.data.error !== undefined)
          errors.push(event.data.error.slice(0, 500));
        break;
      case 'preview.ready':
        previewUrl = event.data.url;
        break;
      default:
        break;
    }
  }

  return {
    checkpoints,
    errors: errors.slice(-10),
    filesChanged: [...files],
    previewUrl,
    toolCalls: tools.length,
    recentTools: tools.slice(-15),
  };
}
