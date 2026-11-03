import {
  type Binding,
  type BindingList,
  bindingListSchema,
  bindingSchema,
  type ConnectionList,
  connectionListSchema,
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
  type SupabaseProjectPage,
  supabaseProjectPageSchema,
} from '@repo/contracts';
import {
  type UseMutationResult,
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';

import { apiRequest } from '@/lib/api/client';

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

export function useNeonProjects(
  orgId: string,
  connectionId: string | undefined,
): UseQueryResult<NeonProjectPage, Error> {
  return useQuery({
    enabled: connectionId !== undefined,
    queryFn: ({ signal }) =>
      apiRequest(
        'GET',
        `${org(orgId)}/connectors/${encodeURIComponent(connectionId ?? '')}/neon/projects`,
        { schema: neonProjectPageSchema, signal },
      ),
    queryKey: ['neon-projects', orgId, connectionId],
  });
}

export function useSupabaseProjects(
  orgId: string,
  connectionId: string | undefined,
): UseQueryResult<SupabaseProjectPage, Error> {
  return useQuery({
    enabled: connectionId !== undefined,
    queryFn: ({ signal }) =>
      apiRequest(
        'GET',
        `${org(orgId)}/connectors/${encodeURIComponent(connectionId ?? '')}/supabase/projects`,
        { schema: supabaseProjectPageSchema, signal },
      ),
    queryKey: ['supabase-projects', orgId, connectionId],
  });
}

export function useNetlifySites(
  orgId: string,
  connectionId: string | undefined,
): UseQueryResult<NetlifySitePage, Error> {
  return useQuery({
    enabled: connectionId !== undefined,
    queryFn: ({ signal }) =>
      apiRequest(
        'GET',
        `${org(orgId)}/connectors/${encodeURIComponent(connectionId ?? '')}/netlify/sites`,
        { schema: netlifySitePageSchema, signal },
      ),
    queryKey: ['netlify-sites', orgId, connectionId],
  });
}

/** Spec 030 US5: the Resend domains to bind — never the platform's own (FR-021). */
export function useResendDomains(
  orgId: string,
  connectionId: string | undefined,
): UseQueryResult<ResendDomainPage, Error> {
  return useQuery({
    enabled: connectionId !== undefined,
    queryFn: ({ signal }) =>
      apiRequest(
        'GET',
        `${org(orgId)}/connectors/${encodeURIComponent(connectionId ?? '')}/resend/domains`,
        { schema: resendDomainPageSchema, signal },
      ),
    queryKey: ['resend-domains', orgId, connectionId],
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

/** `POST …/connectors/netlify/publish`: `202` with the operation; its states follow. */
export function useNetlifyPublish(
  orgId: string,
  projectId: string,
): UseMutationResult<Operation, Error, string> {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (deploymentId: string) =>
      apiRequest('POST', `${bindingsPath(orgId, projectId)}/netlify/publish`, {
        body: { deploymentId },
        schema: operationSchema,
      }),
    onSettled: () => client.invalidateQueries({ queryKey: publishesKey(orgId, projectId) }),
  });
}
