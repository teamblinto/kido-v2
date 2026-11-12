import { Inject, Injectable } from '@nestjs/common';
import { McpServer, requireScopes, ResourceTemplate } from '@modelcontextprotocol/server';
import { z } from 'zod';

import type { McpPrincipal } from '../oauth/mcp-oauth.service';
import { McpPlatform } from './mcp-platform';
import { McpToolKit, ToolCall } from './tool-kit';
import { registerCheckpointTools } from './tools/checkpoint.tools';
import { registerDeployTools } from './tools/deploy.tools';
import { inWorkspace, registerFileTools } from './tools/file.tools';
import { registerGithubTools } from './tools/github.tools';
import { registerIntegrationTools } from './tools/integration.tools';
import { registerPreviewTools } from './tools/preview.tools';
import { registerProjectTools } from './tools/project.tools';
import { registerRunTools } from './tools/run.tools';

export const MCP_SERVER_NAME = 'baios';
export const MCP_SERVER_VERSION = '1.0.0';

/**
 * Read by the client's model before it calls anything: the shape of the platform and the workflow
 * that works, so it does not have to discover it tool by tool.
 */
export const MCP_SERVER_INSTRUCTIONS = `You are connected to an AI app builder. Each project is a full web app (React/Vite and other templates) in a cloud workspace with a live preview, a build agent, checkpoints, one-click deploys and integrations (Supabase, Neon, Netlify, Resend, GitHub).

How to work:
1. Find or create the project: list_projects, or create_project (pass a prompt to start building right away).
2. Build and change apps through the platform's build agent: start_agent_run with a clear, complete instruction. It edits code, installs packages, runs the app and fixes its own errors. Follow it with get_agent_run (waitSeconds up to 50, repeat until settled; pass lastSeq as sinceSeq). If it asks a question (awaiting_input), answer with reply_to_agent_run.
3. Inspect: get_preview for the live URL and dev-server state; list_files / read_file / search_files to read code; run_command for checks such as "npm run build" or "npx tsc --noEmit".
4. Small precise edits: read_file then write_file with its baseCheckpointId. Undo with list_checkpoints + restore_checkpoint.
5. Integrations: list_integrations shows what is connected and the environment variable names the app receives (values are never exposed). Accounts are connected by the person in the web app; you can bind a connected account's resource to the project and apply database migrations they approved.
6. Ship: deploy_project (waitSeconds to follow the build); on failure read the log it returns and fix the cause via the build agent, then deploy again. sync_github pushes to the linked repository.

Rules: only one agent run is active per project at a time; write_file and run_command are refused while one runs. Ask the person before destructive actions (archive_project, restore_checkpoint, unbind_integration, apply_database_migrations, taking a site offline). Pass an idempotencyKey to create/deploy calls you might retry.`;

/**
 * Builds the MCP server for one HTTP request and one verified principal (stateless Streamable
 * HTTP: no session outlives the request). Tools are registered per request so each closes over
 * exactly one person's grant — there is no shared server holding a "current user".
 */
@Injectable()
export class McpServerFactory {
  constructor(@Inject(McpPlatform) private readonly platform: McpPlatform) {}

  build(principal: McpPrincipal): McpServer {
    const server = new McpServer(
      { name: MCP_SERVER_NAME, title: 'BAIOS app builder', version: MCP_SERVER_VERSION },
      { instructions: MCP_SERVER_INSTRUCTIONS },
    );
    const kit = new McpToolKit(server, principal, this.platform);

    registerProjectTools(kit);
    registerRunTools(kit);
    registerFileTools(kit);
    registerPreviewTools(kit);
    registerCheckpointTools(kit);
    registerDeployTools(kit);
    registerGithubTools(kit);
    registerIntegrationTools(kit);
    registerResources(kit);
    registerPrompts(server);

    return server;
  }
}

/** A project file as a resource, for clients that attach context by URI rather than by tool. */
function registerResources(kit: McpToolKit): void {
  kit.server.registerResource(
    'project-file',
    new ResourceTemplate('baios://projects/{projectId}/files/{+path}', { list: undefined }),
    {
      description: 'A file in a project, e.g. baios://projects/<projectId>/files/src/App.tsx',
      mimeType: 'text/plain',
      scopeChallenge: requireScopes('projects:read'),
      title: 'Project file',
    },
    async (uri, variables, ctx) => {
      const projectId = z.uuid().parse(variables.projectId);
      const path = z.string().min(1).parse(variables.path);
      const call = new ToolCall(kit, ctx, 'resource:project-file');
      const file = await inWorkspace(call, projectId, 'project:read', (tx, ref) =>
        call.platform.files.read(tx, ref, path),
      );

      return {
        contents: [
          {
            text: file.renderable ? file.content : `(${file.reason}: ${String(file.bytes)} bytes)`,
            uri: uri.href,
          },
        ],
      };
    },
  );
}

/** Ready-made starting points a client can offer the person as slash commands. */
function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'build_app',
    {
      argsSchema: z.object({
        description: z
          .string()
          .describe('What the app should do, for whom, and how it should look.'),
        name: z.string().describe('Project name.'),
      }),
      description:
        'Create a new project and have the build agent build it, then report the preview.',
      title: 'Build a new app',
    },
    ({ description, name }) => ({
      messages: [
        {
          content: {
            text: `Create a new project named "${name}" with create_project, passing this as the prompt so the build agent starts immediately:\n\n${description}\n\nFollow the run with get_agent_run (waitSeconds 50, pass lastSeq as sinceSeq) until it settles, answering any question it asks with reply_to_agent_run. When it succeeds, call get_preview and give me the URL and a short summary of what was built.`,
            type: 'text',
          },
          role: 'user',
        },
      ],
    }),
  );

  server.registerPrompt(
    'fix_errors',
    {
      argsSchema: z.object({ projectId: z.string().describe('The project to fix.') }),
      description: 'Diagnose and fix build, type and runtime errors in a project.',
      title: 'Fix errors',
    },
    ({ projectId }) => ({
      messages: [
        {
          content: {
            text: `Fix the errors in project ${projectId}. First gather evidence: get_preview (is the dev server failed?), run_command "npm run build" and, for TypeScript projects, "npx tsc --noEmit". Then start_agent_run with the exact error output and ask it to fix the root cause and verify the build passes. Follow the run to completion, re-run the checks, and report what was wrong and what changed.`,
            type: 'text',
          },
          role: 'user',
        },
      ],
    }),
  );

  server.registerPrompt(
    'deploy_app',
    {
      argsSchema: z.object({ projectId: z.string().describe('The project to deploy.') }),
      description: 'Deploy a project, fixing build failures until it is live.',
      title: 'Deploy',
    },
    ({ projectId }) => ({
      messages: [
        {
          content: {
            text: `Deploy project ${projectId}: call deploy_project with waitSeconds 50 and an idempotencyKey, and keep following it with get_deployment until it finishes. If the build fails, read the log tail it returns, have the build agent fix the cause (start_agent_run with the log), then deploy again. Report the live URL.`,
            type: 'text',
          },
          role: 'user',
        },
      ],
    }),
  );
}
