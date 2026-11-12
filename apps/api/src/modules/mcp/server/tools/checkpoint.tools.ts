import { cursorSchema, PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX } from '@repo/contracts';
import { z } from 'zod';

import { toResponse } from '../../../checkpoints/controllers/checkpoints.controller';
import type { McpToolKit } from '../tool-kit';
import { idempotencyKey, projectId } from './inputs';

const checkpointId = z.uuid().describe('The checkpoint id, from list_checkpoints.');

/** Checkpoints: the project's history, one per agent turn or file write, and the way back. */
export function registerCheckpointTools(kit: McpToolKit): void {
  kit.tool(
    'list_checkpoints',
    {
      description:
        'The project’s checkpoints, newest first: one per agent turn or file change, with a label and the files it touched. Use it to find a known-good point before restore_checkpoint, or a checkpointId to deploy with deploy_project. Pass nextCursor back as cursor for the next page.',
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
      title: 'List checkpoints',
    },
    async ({ cursor, limit, projectId: id }, call) =>
      call.inProject(id, 'project:read', async (tx, ref) => {
        const page = await call.platform.checkpoints.list(tx, ref, {
          ...(cursor === undefined ? {} : { cursor }),
          limit: limit ?? PAGE_SIZE_DEFAULT,
        });

        return { items: page.items.map(toResponse), nextCursor: page.nextCursor };
      }),
  );

  kit.tool(
    'get_checkpoint_diff',
    {
      description:
        'The code change one checkpoint made, as a diff against its parent. Use it to see what an agent turn changed, or to choose which checkpoint to restore. If the workspace is waking up it fails with a retry hint: wait a few seconds and call again.',
      input: z.object({ checkpointId, projectId }),
      scope: 'projects:read',
      title: 'Get checkpoint diff',
    },
    async ({ checkpointId: target, projectId: id }, call) =>
      call.inProject(id, 'project:read', (tx, ref) =>
        call.platform.checkpoints.diff(tx, ref, target),
      ),
  );

  kit.tool(
    'restore_checkpoint',
    {
      description:
        'Put the project’s files back to how they were at a checkpoint. Nothing is lost: the restore is recorded as a new checkpoint, so it can itself be undone by restoring an earlier one. Refused while an agent run is active, or if the workspace is already at that checkpoint. Only do this when the person asked to undo or roll back; afterwards check the preview with get_project.',
      destructive: true,
      input: z.object({
        checkpointId,
        // Required, as on the HTTP route: a keyless retry would move the workspace twice.
        idempotencyKey: idempotencyKey
          .unwrap()
          .describe(
            'Any unique string (8–100 of A-Z a-z 0-9 . _ ~ -). Retrying with the same key returns the first restore instead of restoring twice.',
          ),
        projectId,
      }),
      scope: 'projects:write',
      title: 'Restore checkpoint',
    },
    async (args, call) =>
      call.once(args.idempotencyKey, args, () =>
        call.inProject(args.projectId, 'project:files.write', async (tx, ref) => ({
          checkpoint: toResponse(
            await call.platform.checkpoints.revert(
              ref,
              call.principal.userId,
              args.checkpointId,
              tx,
            ),
          ),
        })),
      ),
  );
}
