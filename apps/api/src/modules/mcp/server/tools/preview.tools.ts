import { z } from 'zod';

import type { McpToolKit } from '../tool-kit';
import { projectId } from './inputs';

/** The running app: where to look at it and whether it is up. */
export function registerPreviewTools(kit: McpToolKit): void {
  kit.tool(
    'get_preview',
    {
      description:
        'The project\'s live development preview: its URL, whether the dev server is up (`stage`: ready, starting, failed…) and who may open it. Pass wake: true to start a sleeping workspace. When stage is failed, read the error with run_command (e.g. "npm run build") or ask the build agent to fix it.',
      input: z.object({
        projectId,
        wake: z.boolean().optional().describe('Start the workspace if it is asleep.'),
      }),
      scope: 'projects:read',
      title: 'Get preview',
    },
    async (args, call) =>
      call.inProject(args.projectId, 'project:read', async (tx, ref) => {
        const workspace = args.wake === true ? await call.platform.files.wake(tx, ref) : undefined;

        return {
          preview: await call.platform.previews.read(tx, ref.orgId, ref.projectId),
          ...(workspace === undefined ? {} : { workspace }),
        };
      }),
  );
}
