import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { scrubSecrets } from '../../../../common/telemetry/scrubber';
import type { TenantTransaction } from '../../../../database/database.types';
import { toResponse } from '../../../checkpoints/controllers/checkpoints.controller';
import { type McpToolKit, type ProjectRef, type ToolCall, ToolError } from '../tool-kit';
import { projectId } from './inputs';

const path = z
  .string()
  .max(1_000)
  .describe('Path relative to the project root, e.g. "src/App.tsx". Empty for the root.');

/** How long a file tool waits for a hibernated workspace to come back before asking for a retry. */
const WAKE_WAIT_SECONDS = 25;

/**
 * Direct access to the project's working tree, for reading the code and for small precise edits.
 * Larger changes go to the build agent (start_agent_run), which also runs and verifies them.
 */
export function registerFileTools(kit: McpToolKit): void {
  kit.tool(
    'list_files',
    {
      description:
        'List one directory of the project (names, kinds, sizes). Start at the root ("") and walk down. Wakes a sleeping workspace first.',
      input: z.object({ path: path.default(''), projectId }),
      scope: 'projects:read',
      title: 'List files',
    },
    async (args, call) =>
      inWorkspace(call, args.projectId, 'project:read', (_tx, ref) =>
        call.platform.files.list(ref, args.path),
      ),
  );

  kit.tool(
    'read_file',
    {
      description:
        'Read one file. The answer carries `baseCheckpointId`; pass it to write_file so your write is refused if the project changed in between. Binary and very large files are described, not returned.',
      input: z.object({ path: path.min(1), projectId }),
      scope: 'projects:read',
      title: 'Read file',
    },
    async (args, call) =>
      inWorkspace(call, args.projectId, 'project:read', (tx, ref) =>
        call.platform.files.read(tx, ref, args.path),
      ),
  );

  kit.tool(
    'write_file',
    {
      description:
        'Create or overwrite one file with the full new content; recorded as a checkpoint you can restore. For anything beyond a small, precise edit prefer start_agent_run, which also runs and checks the app. Refused while a build agent run is active in the project.',
      input: z.object({
        baseCheckpointId: z
          .uuid()
          .optional()
          .describe('From read_file. Omit only for a new file; the current head is used.'),
        content: z
          .string()
          .max(2 * 1024 * 1024)
          .describe('The complete file content.'),
        path: path.min(1),
        projectId,
      }),
      scope: 'projects:write',
      title: 'Write file',
    },
    async (args, call) =>
      inWorkspace(call, args.projectId, 'project:files.write', async (tx, ref) => {
        const base = args.baseCheckpointId ?? (await call.platform.checkpoints.head(tx, ref))?.id;

        if (base === undefined) {
          throw new ToolError(
            'The project has no checkpoint yet, so there is nothing to save on top of.',
            'Start the build agent once (start_agent_run) to initialise the project, then retry.',
          );
        }

        const result = await call.platform.checkpoints.save(
          ref,
          call.principal.userId,
          { baseCheckpointId: base, content: args.content, path: args.path },
          tx,
        );

        return { checkpoint: toResponse(result.checkpoint), saved: result.saved };
      }),
  );

  kit.tool(
    'search_files',
    {
      description:
        'Find text in the project’s files (substring, case-sensitive; dependencies and build output excluded). Returns path, line and the matching line.',
      input: z.object({
        path: path.optional(),
        projectId,
        text: z.string().min(1).max(200).describe('The text to find.'),
      }),
      scope: 'projects:read',
      title: 'Search files',
    },
    async (args, call) =>
      inWorkspace(call, args.projectId, 'project:read', async (_tx, ref) => ({
        matches: await call.platform.sandbox.search(ref, {
          text: args.text,
          ...(args.path === undefined ? {} : { path: args.path }),
        }),
      })),
  );

  kit.tool(
    'find_files',
    {
      description: 'Find files by name glob, e.g. "*.tsx" or "package.json".',
      input: z.object({
        glob: z.string().min(1).max(200),
        path: path.optional(),
        projectId,
      }),
      scope: 'projects:read',
      title: 'Find files',
    },
    async (args, call) =>
      inWorkspace(call, args.projectId, 'project:read', async (_tx, ref) => ({
        paths: await call.platform.sandbox.find(ref, {
          glob: args.glob,
          ...(args.path === undefined ? {} : { path: args.path }),
        }),
      })),
  );

  kit.tool(
    'run_command',
    {
      description:
        'Run one command in the project workspace and get its output — for checks like "npm run build", "npx tsc --noEmit", "npm run lint", or "npm install <pkg>", and small file operations (mv, rm, mkdir). One program, no shell operators (no |, &&, ;, >, $()); allowed programs include npm, npx, pnpm, node, git, ls, cat, grep, rg, sed, rm, mv, cp, mkdir. 120 s limit; long output is cut in the middle. Refused while a build agent run is active. Changes it makes are saved with the next checkpoint (the next write_file or agent run).',
      input: z.object({
        command: z.string().trim().min(1).max(2_000),
        projectId,
      }),
      scope: 'projects:write',
      title: 'Run command',
    },
    async (args, call) =>
      inWorkspace(call, args.projectId, 'project:files.write', async (tx, ref) => {
        if (await call.platform.checkpoints.activeRunExists(tx, ref)) {
          throw new ToolError(
            'A build agent run is active in this project; commands would race with it.',
            'Wait for it with get_agent_run (waitSeconds), or cancel it with cancel_agent_run.',
            'conflict',
          );
        }

        const result = await call.platform.sandbox.exec(ref, args.command, {
          leaseEpoch: 0,
          operationId: `mcp/${randomUUID()}`,
        });

        return result.timedOut
          ? { output: '', timedOut: true }
          : {
              exitCode: result.exitCode,
              // The same scrub the build agent's own `exec` gets: env values must not reach a model.
              output: scrubSecrets(result.output),
              timedOut: false,
              truncated: result.truncated,
            };
      }),
  );
}

/**
 * Wake the project's workspace (a hibernated sandbox resumes in seconds) and run `fn` against it.
 * Each poll takes its own short transaction: a resume is never waited on inside one.
 */
export async function inWorkspace<T>(
  call: ToolCall,
  project: string,
  permission: 'project:files.write' | 'project:read',
  fn: (tx: TenantTransaction, ref: ProjectRef) => Promise<T>,
): Promise<T> {
  const ready = await call.waitFor(WAKE_WAIT_SECONDS, async (elapsed) => {
    const wake = await call.inProject(project, permission, (tx, ref) =>
      call.platform.files.wake(tx, ref),
    );

    return wake.ready
      ? { done: true as const, value: true }
      : {
          done: false as const,
          note: `Workspace ${wake.because ?? 'starting'} (${String(elapsed)}s)`,
        };
  });

  if (ready === undefined) {
    throw new ToolError(
      'The project workspace is still starting.',
      'Retry this call in about 15 seconds.',
      'workspace-starting',
    );
  }

  return call.inProject(project, permission, fn);
}
