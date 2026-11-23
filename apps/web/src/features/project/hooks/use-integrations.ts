import {
  type ApplyMigrationsResponse,
  applyMigrationsResponseSchema,
  type Binding,
  type BindingList,
  bindingListSchema,
  bindingSchema,
  type ConnectionList,
  connectionListSchema,
  MIGRATION_DIRECTORIES,
  type MigrationProvider,
  type MigrationStatus,
  migrationStatusSchema,
  type NeonBindRequest,
  type NeonProjectPage,
  neonProjectPageSchema,
  type NetlifyBindRequest,
  type NetlifySitePage,
  netlifySitePageSchema,
  type Operation,
  type OperationPage,
  operationPageSchema,
  operationSchema,
  type ResendBindRequest,
  type ResendDomainPage,
  resendDomainPageSchema,
  type SupabaseBindRequest,
  supabaseInstallResponseSchema,
  type SupabaseProjectPage,
  supabaseProjectPageSchema,
} from '@repo/contracts';
import {
  type UseInfiniteQueryResult,
  type UseMutationResult,
  type UseQueryResult,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';

import type { z } from 'zod';

import { apiRequest } from '@/lib/api/client';
import { projectPath } from '@/lib/routes';
import { readFile } from '../api';

/** How often the bindings are re-read while a branch or key is on its way. */
export const BINDING_POLL_MS = 2000;

const SETTLING_RESOURCE = new Set(['provisioning', 'releasing']);
const SETTLING_OPERATION = new Set(['queued', 'running']);

/** 2 s while any binding's resource or latest operation is settling; off otherwise. */
export function bindingPollInterval(items: readonly Binding[] | undefined): number | false {
  const settling = (items ?? []).some(
    (binding) =>
      binding.resources.some((resource) => SETTLING_RESOURCE.has(resource.state)) ||
      (binding.latestOperation !== null && SETTLING_OPERATION.has(binding.latestOperation.state)),
  );

  return settling ? BINDING_POLL_MS : false;
}

function org(orgId: string): string {
  return `/orgs/${encodeURIComponent(orgId)}`;
}

function bindingsPath(orgId: string, projectId: string): string {
  return `${org(orgId)}/projects/${encodeURIComponent(projectId)}/connectors`;
}

const bindingsKey = (orgId: string, projectId: string) => ['bindings', orgId, projectId] as const;

/** The organisation's connections: which providers there is anything to bind through. */
export function useOrgConnections(orgId: string): UseQueryResult<ConnectionList, Error> {
  return useQuery({
    queryFn: ({ signal }) =>
      apiRequest('GET', `${org(orgId)}/connectors`, { schema: connectionListSchema, signal }),
    queryKey: ['connectors', orgId],
  });
}

/** Spec 030 contracts/bindings.md § 2: the project's bindings, polled while one settles. */
export function useBindings(orgId: string, projectId: string): UseQueryResult<BindingList, Error> {
  return useQuery({
    queryFn: ({ signal }) =>
      apiRequest('GET', bindingsPath(orgId, projectId), { schema: bindingListSchema, signal }),
    queryKey: bindingsKey(orgId, projectId),
    refetchInterval: (q) => bindingPollInterval(q.state.data?.items),
  });
}

interface ListingPage<T> {
  items: T[];
  nextCursor?: string | undefined;
}

/** A bind form's listing, a page at a time: `nextCursor` is the next page's `?cursor=`. */
function useListing<T>(
  key: string,
  orgId: string,
  connectionId: string | undefined,
  path: string,
  schema: z.ZodType<ListingPage<T>>,
): UseInfiniteQueryResult<T[], Error> {
  return useInfiniteQuery<ListingPage<T>, Error, T[], readonly unknown[], string | undefined>({
    enabled: connectionId !== undefined,
    getNextPageParam: (last) => last.nextCursor,
    initialPageParam: undefined,
    queryFn: ({ pageParam, signal }) =>
      apiRequest(
        'GET',
        `${org(orgId)}/connectors/${encodeURIComponent(connectionId ?? '')}/${path}${
          pageParam === undefined ? '' : `?cursor=${encodeURIComponent(pageParam)}`
        }`,
        { schema, signal },
      ),
    queryKey: [key, orgId, connectionId],
    select: (data) => data.pages.flatMap((row) => row.items),
  });
}

export function useNeonProjects(
  orgId: string,
  connectionId: string | undefined,
): UseInfiniteQueryResult<NeonProjectPage['items'], Error> {
  return useListing('neon-projects', orgId, connectionId, 'neon/projects', neonProjectPageSchema);
}

export function useSupabaseProjects(
  orgId: string,
  connectionId: string | undefined,
): UseInfiniteQueryResult<SupabaseProjectPage['items'], Error> {
  return useListing(
    'supabase-projects',
    orgId,
    connectionId,
    'supabase/projects',
    supabaseProjectPageSchema,
  );
}

export function useNetlifySites(
  orgId: string,
  connectionId: string | undefined,
): UseInfiniteQueryResult<NetlifySitePage['items'], Error> {
  return useListing('netlify-sites', orgId, connectionId, 'netlify/sites', netlifySitePageSchema);
}

/** Spec 030 US5: the Resend domains to bind — never the platform's own (FR-021). */
export function useResendDomains(
  orgId: string,
  connectionId: string | undefined,
): UseInfiniteQueryResult<ResendDomainPage['items'], Error> {
  return useListing(
    'resend-domains',
    orgId,
    connectionId,
    'resend/domains',
    resendDomainPageSchema,
  );
}

/** Where a Supabase connect begun in the integrations panel comes back to, read by its callback. */
export const SUPABASE_RETURN_KEY = 'supabase-return-to';

/** The project with the integrations panel open. */
export function integrationsPanelPath(projectId: string): string {
  return `${projectPath(projectId)}?panel=integrations`;
}

/** `POST connectors/supabase/install` from the panel: off to Supabase, and back to this project. */
export function useSupabaseConnect(
  orgId: string,
  projectId: string,
): UseMutationResult<string, Error, void> {
  return useMutation({
    mutationFn: async () =>
      (
        await apiRequest('POST', `${org(orgId)}/connectors/supabase/install`, {
          schema: supabaseInstallResponseSchema,
        })
      ).url,
    onSuccess: (url) => {
      window.sessionStorage.setItem(SUPABASE_RETURN_KEY, integrationsPanelPath(projectId));
      window.location.assign(url);
    },
  });
}

const migrationsKey = (orgId: string, projectId: string, provider: MigrationProvider) =>
  ['migrations', orgId, projectId, provider] as const;

/** `GET …/connectors/:provider/migrations`: the versions the database says it has applied. */
export function useMigrationStatus(
  orgId: string,
  projectId: string,
  provider: MigrationProvider,
): UseQueryResult<MigrationStatus, Error> {
  return useQuery({
    queryFn: ({ signal }) =>
      apiRequest('GET', `${bindingsPath(orgId, projectId)}/${provider}/migrations`, {
        schema: migrationStatusSchema,
        signal,
      }),
    queryKey: migrationsKey(orgId, projectId, provider),
  });
}

/** One pending file, as the directory listing names it. */
export interface PendingMigration {
  readonly fileName: string;
  readonly name: string;
  readonly version: string;
}

/**
 * Read each pending file, then `POST …/migrations` with them in the order given (ascending
 * version). The run stops at the database's first refusal, which the answer names.
 */
export function useApplyMigrations(
  orgId: string,
  projectId: string,
  provider: MigrationProvider,
): UseMutationResult<ApplyMigrationsResponse, Error, readonly PendingMigration[]> {
  const client = useQueryClient();
  const directory = MIGRATION_DIRECTORIES[provider];

  return useMutation({
    mutationFn: async (pending) => {
      const migrations = await Promise.all(
        pending.map(async ({ fileName, name, version }) => {
          const file = await readFile(orgId, projectId, `${directory}/${fileName}`);

          if (!file.renderable) throw new Error(`${fileName} is too large or not text.`);

          return { name, sql: file.content, version };
        }),
      );

      return apiRequest('POST', `${bindingsPath(orgId, projectId)}/${provider}/migrations`, {
        body: { migrations },
        schema: applyMigrationsResponseSchema,
      });
    },
    // A partial run applied something, so the status is re-read whatever the answer was.
    onSettled: () =>
      client.invalidateQueries({ queryKey: migrationsKey(orgId, projectId, provider) }),
    retry: false,
  });
}

interface BindBody {
  neon: NeonBindRequest;
  netlify: NetlifyBindRequest;
  resend: ResendBindRequest;
  supabase: SupabaseBindRequest;
}

/** `PUT …/connectors/:provider`: the binding answers at once; its branch or key follows. */
export function useBind<P extends keyof BindBody>(
  orgId: string,
  projectId: string,
  provider: P,
): UseMutationResult<Binding, Error, BindBody[P]> {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (body: BindBody[P]) =>
      apiRequest('PUT', `${bindingsPath(orgId, projectId)}/${provider}`, {
        body,
        schema: bindingSchema,
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: bindingsKey(orgId, projectId) }),
  });
}

/** `DELETE …/connectors/:provider`: `202` with the release; the binding goes when it completes. */
export function useUnbind(
  orgId: string,
  projectId: string,
  provider: keyof BindBody,
): UseMutationResult<Operation, Error, void> {
  const client = useQueryClient();

  return useMutation({
    mutationFn: () =>
      apiRequest('DELETE', `${bindingsPath(orgId, projectId)}/${provider}`, {
        schema: operationSchema,
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: bindingsKey(orgId, projectId) }),
  });
}

/** `POST …/connectors/neon/reset`: a fresh preview branch, used at the preview's next start. */
export function useNeonReset(
  orgId: string,
  projectId: string,
): UseMutationResult<Operation, Error, void> {
  const client = useQueryClient();

  return useMutation({
    mutationFn: () =>
      apiRequest('POST', `${bindingsPath(orgId, projectId)}/neon/reset`, {
        schema: operationSchema,
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: bindingsKey(orgId, projectId) }),
  });
}

const publishesKey = (orgId: string, projectId: string) =>
  ['netlify-publishes', orgId, projectId] as const;

/**
 * Spec 030 US4 (FR-017): the project's Netlify publishes, newest first, with Netlify's own state —
 * polled while one is queued or running.
 */
export function useNetlifyPublishes(
  orgId: string,
  projectId: string,
  enabled: boolean,
): UseQueryResult<OperationPage, Error> {
  return useQuery({
    enabled,
    queryFn: ({ signal }) =>
      apiRequest('GET', `${bindingsPath(orgId, projectId)}/operations?kind=netlify_publish`, {
        schema: operationPageSchema,
        signal,
      }),
    queryKey: publishesKey(orgId, projectId),
    refetchInterval: (q) =>
      (q.state.data?.items ?? []).some((row) => SETTLING_OPERATION.has(row.state))
        ? BINDING_POLL_MS
        : false,
  });
}

/**
 * `POST …/connectors/netlify/publish`: `202` with the operation; its states follow. Without a
 * release the API builds the head first, so the deploy history is re-read too.
 */
export function useNetlifyPublish(
  orgId: string,
  projectId: string,
): UseMutationResult<Operation, Error, string | undefined> {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (deploymentId: string | undefined) =>
      apiRequest('POST', `${bindingsPath(orgId, projectId)}/netlify/publish`, {
        body: deploymentId === undefined ? {} : { deploymentId },
        schema: operationSchema,
      }),
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: publishesKey(orgId, projectId) }),
        client.invalidateQueries({ queryKey: ['deployments', orgId, projectId] }),
      ]),
  });
}
