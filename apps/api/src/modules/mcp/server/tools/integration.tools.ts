import {
  BIND_REQUEST_SCHEMAS,
  BINDING_PROVIDERS,
  type BindingProvider,
  cursorSchema,
  MIGRATION_DIRECTORIES,
  MIGRATION_PROVIDERS,
  migrationSchema,
} from '@repo/contracts';
import { z } from 'zod';

import { type McpToolKit, ToolError } from '../tool-kit';
import { projectId } from './inputs';

const provider = z
  .enum(BINDING_PROVIDERS)
  .describe('netlify (hosting), supabase or neon (database), resend (email).');

const databaseProvider = z
  .enum(MIGRATION_PROVIDERS)
  .describe('The bound database: neon or supabase.');

/** Accounts are connected by the person in the browser; a provider token never passes the model. */
const CONNECT_PATH = '/settings/connectors';

const CONNECT_HINT = `Connecting an account is done by the person in the web app, at ${CONNECT_PATH} (Settings → Connectors). Never ask for or accept an API token in the chat.`;

/** What each provider's `options` take, and where the ids come from. */
const BIND_OPTIONS: Readonly<Record<BindingProvider, string>> = {
  neon: '{ projectId, parentBranchId, databaseName, roleName } — all from list_provider_resources neon',
  netlify:
    '{ siteId } from list_provider_resources netlify, or { createSite: { name } } with a new lowercase site name',
  resend: '{ domainId } from list_provider_resources resend',
  supabase: '{ projectRef } — the ref from list_provider_resources supabase',
};

/** Connected services: hosting, database and email accounts bound to a project. */
export function registerIntegrationTools(kit: McpToolKit): void {
  kit.tool(
    'list_integrations',
    {
      description:
        'What the project is connected to: the organization’s connected accounts (Netlify, Supabase, Neon, Resend, GitHub), the project’s bindings to them with their latest operation, and the NAMES of the environment variables those bindings give the app (never their values — use them by name in code, e.g. process.env.DATABASE_URL). Providers not yet connected come with where the person connects them.',
      input: z.object({ projectId }),
      scope: 'projects:read',
      title: 'List integrations',
    },
    async ({ projectId: id }, call) => {
      const { orgId } = call.principal;
      const project = await call.inProject(id, 'project:read', async (tx, ref) => ({
        bindings: await call.platform.bindings.list(tx, ref),
        // Names only: the values are credentials and must never reach the model.
        environmentVariables: Object.keys(await call.platform.previewEnv(tx, ref.orgId, id)),
      }));

      if (!(await call.holds('org:connectors.read'))) {
        return {
          ...project,
          connections: null,
          note: 'Your role cannot see the organization’s connected accounts.',
        };
      }

      const connections = await call.inOrg('org:connectors.read', async (tx) =>
        (await call.platform.connections.list(tx, orgId)).map((row) =>
          call.platform.connections.toContract(row),
        ),
      );
      const notConnected = BINDING_PROVIDERS.filter(
        (one) => !connections.some((connection) => connection.provider === one),
      ).map((one) => ({ connectUrl: CONNECT_PATH, provider: one }));

      return {
        ...project,
        connections,
        ...(notConnected.length === 0 ? {} : { connectHint: CONNECT_HINT, notConnected }),
      };
    },
  );

  kit.tool(
    'list_provider_resources',
    {
      description:
        'What the organization’s connected account at a provider can see, to choose what to bind with bind_integration: Netlify sites, Neon projects (with branches, databases and roles), Supabase projects, Resend domains. Fails if the provider is not connected; the person connects it in the web app.',
      input: z.object({
        cursor: cursorSchema
          .optional()
          .describe('Optional. nextCursor from the previous page (Netlify).'),
        provider,
        query: z
          .string()
          .trim()
          .max(100)
          .optional()
          .describe('Optional. Filter by name (Netlify and Neon).'),
      }),
      openWorld: true,
      scope: 'projects:read',
      title: 'List provider resources',
    },
    async ({ cursor, provider: which, query }, call) => {
      const { orgId } = call.principal;

      return call.inOrg('org:connectors.read', async (tx) => {
        const { id } = await call.platform.connections.ensureUsable(tx, orgId, which);
        const listings = call.platform.listings;

        switch (which) {
          case 'neon':
            return listings.neonProjects(tx, orgId, id, query);
          case 'netlify':
            return listings.netlifySites(tx, orgId, id, query, cursor);
          case 'resend':
            return listings.resendDomains(tx, orgId, id);
          case 'supabase':
            return listings.supabaseProjects(tx, orgId, id);
        }
      });
    },
  );

  kit.tool(
    'bind_integration',
    {
      description: `Bind the project to a resource in a connected account, so the app gets its environment variables (database URL, keys) in the preview and the build. The organization must already have the provider connected (list_integrations). options per provider: netlify ${BIND_OPTIONS.netlify}; neon ${BIND_OPTIONS.neon}; supabase ${BIND_OPTIONS.supabase}; resend ${BIND_OPTIONS.resend}. Rebinding replaces the current binding.`,
      idempotent: true,
      input: z.object({
        options: z
          .record(z.string(), z.unknown())
          .describe('The provider’s bind options, as listed in this tool’s description.'),
        projectId,
        provider,
      }),
      openWorld: true,
      scope: 'projects:write',
      title: 'Bind integration',
    },
    async ({ options, projectId: id, provider: which }, call) => {
      const parsed = BIND_REQUEST_SCHEMAS[which].safeParse(options);

      if (!parsed.success) {
        throw new ToolError(
          `Invalid options for ${which}: ${parsed.error.issues
            .map((issue) => `${issue.path.join('.') || '(options)'}: ${issue.message}`)
            .join('; ')}`,
          `${which} takes ${BIND_OPTIONS[which]}.`,
          'validation-failed',
        );
      }

      await call.requireProject(id, 'project:read');

      return call.inOrg('org:connectors.manage', async (tx) => ({
        binding: await call.platform.bindings.bind(
          tx,
          { orgId: call.principal.orgId, projectId: id },
          call.principal.userId,
          which,
          parsed.data,
        ),
      }));
    },
  );

  kit.tool(
    'unbind_integration',
    {
      description:
        'Remove the project’s binding to a provider. What the platform created there for it (a Neon branch, a key) is released and the app loses those environment variables. Only when the person asked for it.',
      destructive: true,
      input: z.object({ projectId, provider }),
      openWorld: true,
      scope: 'projects:write',
      title: 'Unbind integration',
    },
    async ({ projectId: id, provider: which }, call) => {
      await call.requireProject(id, 'project:read');

      return call.inOrg('org:connectors.manage', async (tx) => ({
        operation: await call.platform.bindings.unbind(
          tx,
          { orgId: call.principal.orgId, projectId: id },
          call.principal.userId,
          which,
        ),
      }));
    },
  );

  kit.tool(
    'get_database_migrations',
    {
      description: `Which SQL migration versions the project’s bound Neon or Supabase database has applied, and the workspace directory migrations live in (${MIGRATION_DIRECTORIES.neon} for Neon, ${MIGRATION_DIRECTORIES.supabase} for Supabase, files named <version>_<name>.sql). Compare with the files there to find the pending ones before apply_database_migrations.`,
      input: z.object({ projectId, provider: databaseProvider }),
      openWorld: true,
      scope: 'projects:read',
      title: 'Get database migrations',
    },
    async ({ projectId: id, provider: which }, call) =>
      call.inProject(id, 'project:read', (tx, ref) =>
        call.platform.migrations.status(tx, ref, which),
      ),
  );

  kit.tool(
    'apply_database_migrations',
    {
      description:
        'Run SQL migrations on the project’s bound Neon or Supabase database — possibly its production data. Call get_database_migrations first and pass only the pending ones, and ONLY after the person has seen and approved these exact migrations. They run in version order, each in its own transaction, stopping at the first failure (`failed` carries the database’s error: fix the SQL and apply again).',
      destructive: true,
      input: z.object({
        migrations: z
          .array(migrationSchema)
          .min(1)
          .max(100)
          .describe(
            'The pending migrations: { version, name, sql } from each <version>_<name>.sql file.',
          ),
        projectId,
        provider: databaseProvider,
      }),
      openWorld: true,
      scope: 'projects:write',
      title: 'Apply database migrations',
    },
    async ({ migrations, projectId: id, provider: which }, call) => {
      await call.requireProject(id, 'project:read');

      return call.inOrg('org:connectors.manage', (tx) =>
        call.platform.migrations.apply(
          tx,
          { orgId: call.principal.orgId, projectId: id },
          call.principal.userId,
          which,
          migrations,
        ),
      );
    },
  );
}
