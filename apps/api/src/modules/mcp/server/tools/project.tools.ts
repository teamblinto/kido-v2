import { PROJECT_TEMPLATES, type ProjectTemplate } from '@repo/contracts';
import { projects } from '@repo/db';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';

import { NotFoundError } from '../../../../common/errors/domain-error';
import type { TenantTransaction } from '../../../../database/database.types';
import { scoped } from '../../../rbac/permissions';
import { type McpToolKit, type ToolCall, ToolError } from '../tool-kit';
import { projectId, startRunInput } from './inputs';
import { startRun } from './run.tools';

/** Account, organization and project management: the starting point of every session. */
export function registerProjectTools(kit: McpToolKit): void {
  kit.tool(
    'get_account',
    {
      description:
        'Who you are acting as: the organization this connection is authorized for, the scopes it was granted, and what the person may do there. Call this first if you are unsure what is possible.',
      input: z.object({}),
      scope: 'projects:read',
      title: 'Get account',
    },
    async (_args, call) => {
      const org = await call.inOrg(null, () => call.platform.orgs.read());

      return {
        canManageIntegrations: await call.holds('org:connectors.manage'),
        grantedScopes: call.principal.scopes,
        organization: org,
        userId: call.principal.userId,
      };
    },
  );

  kit.tool(
    'list_projects',
    {
      description:
        'List the projects the person can see in this organization, newest first, with their ids. Use a project id from here in every other project tool.',
      input: z.object({}),
      scope: 'projects:read',
      title: 'List projects',
    },
    async (_args, call) => {
      const { orgId, userId } = call.principal;
      const projects = await call.inOrg(null, () => call.platform.projects.list(orgId, userId));

      return { projects };
    },
  );

  kit.tool(
    'get_project',
    {
      description:
        'One project: its name, template and workspace, plus its live preview URL and whether the preview is running.',
      input: z.object({ projectId }),
      scope: 'projects:read',
      title: 'Get project',
    },
    async ({ projectId: id }, call) =>
      call.inProject(id, 'project:read', async (tx, ref) => ({
        preview: await call.platform.previews.read(tx, ref.orgId, ref.projectId),
        project: await call.platform.projects.read(ref.orgId, ref.projectId, call.principal.userId),
      })),
  );

  kit.tool(
    'list_templates',
    {
      description:
        'The starter templates a new project can be created from (framework, language, what it includes).',
      input: z.object({}),
      scope: 'projects:read',
      title: 'List templates',
    },
    async (_args, call) => {
      // The answer `GET /templates` gives: `ready` is whether a new project can start from it now.
      const ready = new Set(await call.platform.templateVersions.currentTemplates());

      return {
        default: 'vite-react',
        templates: call.platform.templates.all().map((template) => ({
          description: template.manifest.description,
          id: template.id,
          name: template.manifest.name,
          ready: ready.has(template.id),
        })),
      };
    },
  );

  kit.tool(
    'create_project',
    {
      description:
        'Create a new project from a template and, if you pass `prompt`, immediately start the build agent on it — e.g. prompt "Build a SaaS landing page with sign-up and pricing". Returns the project and, with a prompt, the agent run to follow with get_agent_run.',
      idempotent: true,
      input: z.object({
        idempotencyKey: z
          .string()
          .regex(/^[A-Za-z0-9._~-]{8,100}$/)
          .optional()
          .describe(
            'Any unique string; retrying with the same key returns the first result instead of a second project.',
          ),
        name: z.string().trim().min(1).max(100).describe('The project name shown in the app.'),
        prompt: startRunInput.shape.prompt
          .optional()
          .describe('What to build. Starts the agent right away.'),
        template: z
          .enum(PROJECT_TEMPLATES as unknown as [ProjectTemplate, ...ProjectTemplate[]])
          .optional()
          .describe('Starter template id from list_templates; defaults to vite-react.'),
        workspaceId: z
          .uuid()
          .optional()
          .describe(
            'Workspace to create it in; defaults to the first one you can create projects in.',
          ),
      }),
      scope: 'projects:write',
      title: 'Create project',
    },
    async (args, call) =>
      call.once(args.idempotencyKey, args, async () => {
        const { orgId, userId } = call.principal;
        const project = await call.inOrg(null, async () => {
          const workspaceId = args.workspaceId ?? (await defaultWorkspace(call));

          return call.platform.projects.create({
            actorId: userId,
            name: args.name,
            orgId,
            ownerId: userId,
            ...(args.template === undefined ? {} : { template: args.template }),
            workspaceId,
          });
        });

        if (args.prompt === undefined) return { project };

        return { project, run: await startRun(call, project.id, { prompt: args.prompt }) };
      }),
  );

  kit.tool(
    'rename_project',
    {
      description: 'Rename a project.',
      idempotent: true,
      input: z.object({ name: z.string().trim().min(1).max(100), projectId }),
      scope: 'projects:write',
      title: 'Rename project',
    },
    async ({ name, projectId: id }, call) => {
      const { orgId, userId } = call.principal;

      return call.inProject(id, 'project:read', async (tx) => {
        await call.platform.projects.rename({
          actorId: userId,
          name,
          orgId,
          projectId: id,
          workspaceId: await workspaceOf(tx, orgId, id),
        });

        return { project: await call.platform.projects.read(orgId, id, userId) };
      });
    },
  );

  kit.tool(
    'archive_project',
    {
      description:
        'Archive a project: it disappears from the project list, its preview stops and its integrations are released. Only do this when the person explicitly asked to delete or archive the project.',
      destructive: true,
      input: z.object({ projectId }),
      scope: 'projects:write',
      title: 'Archive project',
    },
    async ({ projectId: id }, call) => {
      const { orgId, userId } = call.principal;

      await call.inProject(id, 'project:read', async (tx) => {
        await call.platform.projects.archive({
          actorId: userId,
          orgId,
          projectId: id,
          workspaceId: await workspaceOf(tx, orgId, id),
        });
      });

      return { archived: true, projectId: id };
    },
  );
}

/**
 * The workspace a project lives in, which rename and archive are keyed by (their routes carry it in
 * the path). A schema read under the caller's tenant transaction, as `PreviewReader` reads the row:
 * `ProjectSummary` deliberately carries no workspace. The services themselves check
 * `workspace:projects.*` against it.
 */
async function workspaceOf(tx: TenantTransaction, orgId: string, id: string): Promise<string> {
  const row = await tx.query.projects.findFirst({
    columns: { workspaceId: true },
    where: and(eq(projects.orgId, orgId), eq(projects.id, id), isNull(projects.deletedAt)),
  });

  if (row === undefined) throw new NotFoundError('No such project.');

  return row.workspaceId;
}

/** The first workspace the person may create projects in; the services re-check on create. */
async function defaultWorkspace(call: ToolCall): Promise<string> {
  const { orgId, userId } = call.principal;
  const held = await call.platform.permissions.for(orgId, userId);
  const workspaces = await call.platform.workspaces.list(orgId, userId);
  const usable = workspaces.find((one) => held.has(scoped('workspace:projects.create', one.id)));

  if (usable === undefined) {
    throw new ToolError(
      'There is no workspace in this organization where you can create projects.',
      'Ask an organization admin for the editor role on a workspace, or pass workspaceId explicitly.',
      'permission-denied',
    );
  }

  return usable.id;
}
