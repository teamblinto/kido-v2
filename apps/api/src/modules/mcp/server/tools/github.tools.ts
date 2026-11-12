import {
  cursorSchema,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  type SyncOperation,
  type SyncState,
} from '@repo/contracts';
import { z } from 'zod';

import type { McpToolKit, ToolCall } from '../tool-kit';
import { idempotencyKey, projectId, waitSeconds } from './inputs';

const operationId = z
  .uuid()
  .describe('The sync operation id, from sync_github or list_github_syncs.');

/** Linking is the person's: it authorizes GitHub in the browser, which a model must never do. */
const LINK_HINT =
  'The person links a repository in the web app: open the project, then GitHub, and choose or create a repository. Then call get_github_link again.';

const NEXT_STEP: Readonly<Record<SyncState, string>> = {
  failed:
    'The sync failed; `reason` says why. remote-ahead or diverged: pull first, then push. needs-reauth or not-linked: the person must reconnect or link GitHub in the web app. nothing-to-push: already up to date.',
  queued: 'Waiting to run. Call get_github_sync with waitSeconds to follow it.',
  running: 'Running. Call get_github_sync with waitSeconds to follow it.',
  succeeded: 'Done. toSha is the commit the project and the branch now share.',
};

/** GitHub: the project's linked repository, and pushing to or pulling from its branch. */
export function registerGithubTools(kit: McpToolKit): void {
  kit.tool(
    'get_github_link',
    {
      description:
        'The GitHub repository and branch the project is linked to, and how the project stands against it (ahead, behind, in sync). Call this before sync_github. If there is no link, the person has to create one in the web app.',
      input: z.object({ projectId }),
      scope: 'projects:read',
      title: 'Get GitHub link',
    },
    async ({ projectId: id }, call) => {
      const link = await call.inProject(id, 'project:read', (tx, ref) =>
        call.platform.repoLinks.read(tx, ref),
      );

      return link === null ? { link: null, next: LINK_HINT } : { link };
    },
  );

  kit.tool(
    'sync_github',
    {
      description:
        'Push the project’s latest checkpoint to its linked GitHub branch, or pull the branch’s commits into the project. Needs a linked repository (get_github_link). Pass waitSeconds to wait for it to finish; if the push is refused because the remote is ahead, pull first and push again.',
      input: z.object({
        direction: z
          .enum(['pull', 'push'])
          .describe(
            '"push" sends the project to GitHub; "pull" brings GitHub’s commits into the project.',
          ),
        idempotencyKey,
        projectId,
        waitSeconds,
      }),
      openWorld: true,
      scope: 'projects:write',
      title: 'Sync with GitHub',
    },
    async (args, call) => {
      // Only the request is replayed; the wait reads the operation afresh on every call.
      const { operation } = await call.once(args.idempotencyKey, args, async () => ({
        operation: await call.inProject(args.projectId, 'project:files.write', (tx, ref) =>
          call.platform.syncs.request(tx, ref, call.principal.userId, args.direction),
        ),
      }));

      return settle(call, args.projectId, operation, args.waitSeconds ?? 0);
    },
  );

  kit.tool(
    'get_github_sync',
    {
      description:
        'One push or pull: queued, running, succeeded or failed, with the failure reason. Pass waitSeconds to wait for it to finish.',
      input: z.object({ operationId, projectId, waitSeconds }),
      scope: 'projects:read',
      title: 'Get GitHub sync',
    },
    async (args, call) => {
      const operation = await call.inProject(args.projectId, 'project:read', (tx, ref) =>
        call.platform.syncs.byId(tx, ref, args.operationId),
      );

      return settle(call, args.projectId, operation, args.waitSeconds ?? 0);
    },
  );

  kit.tool(
    'list_github_syncs',
    {
      description:
        'The project’s pushes, pulls and imports, newest first, including the automatic per-turn pushes. Pass nextCursor back as cursor for the next page.',
      input: z.object({
        cursor: cursorSchema.optional().describe('Optional. nextCursor from the previous page.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(PAGE_SIZE_MAX)
          .optional()
          .describe(`Optional. Page size, default ${String(PAGE_SIZE_DEFAULT)}.`),
        projectId,
      }),
      scope: 'projects:read',
      title: 'List GitHub syncs',
    },
    async ({ cursor, limit, projectId: id }, call) =>
      call.inProject(id, 'project:read', async (tx, ref) => {
        const page = await call.platform.syncs.list(tx, ref, {
          ...(cursor === undefined ? {} : { cursor }),
          limit: limit ?? PAGE_SIZE_DEFAULT,
        });

        return {
          nextCursor: page.nextCursor,
          operations: page.items.map((row) => call.platform.syncs.toContract(row)),
        };
      }),
  );
}

/** Wait up to `seconds` for a sync to finish, one transaction per poll, never one across a sleep. */
async function settle(
  call: ToolCall,
  id: string,
  operation: SyncOperation,
  seconds: number,
): Promise<object> {
  const read = (): Promise<SyncOperation> =>
    call.inProject(id, 'project:read', (tx, ref) =>
      call.platform.syncs.byId(tx, ref, operation.id),
    );
  const settled =
    seconds === 0 || operation.state === 'failed' || operation.state === 'succeeded'
      ? operation
      : ((await call.waitFor<SyncOperation>(seconds, async (elapsed) => {
          const now = await read();

          return now.state === 'failed' || now.state === 'succeeded'
            ? { done: true, value: now }
            : { done: false, note: `GitHub ${now.kind} ${now.state} (${String(elapsed)}s)` };
        })) ?? (await read()));

  return { next: NEXT_STEP[settled.state], operation: settled };
}
