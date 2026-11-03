import {
  type CloudflareOffer,
  cloudflareOfferSchema,
  type Operation,
  operationSchema,
} from '@repo/contracts';
import type {
  Domain,
  DomainListResponse,
  DomainResponse,
  DomainState,
  RemoveDomainResponse,
} from '@repo/contracts';
import {
  type UseMutationResult,
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useRef } from 'react';

import { apiRequest } from '@/lib/api/client';

import { addDomain, checkDomain, listDomains, removeDomain, retryDomain } from '../api';

interface ProjectRef {
  readonly orgId: string | undefined;
  readonly projectId: string | undefined;
}

/** How often the list is re-read while a row is settling: inside the spec's 5 s (US5 #1). */
export const DOMAIN_POLL_MS = 2000;

/** States the platform moves on its own, quickly enough for a viewer to be waiting on. */
const SETTLING: ReadonlySet<DomainState> = new Set(['pending', 'removing']);

/**
 * The list's `refetchInterval`: 2 s while any row is `pending` or `removing`, and off otherwise.
 * `active`, `drifted` and `failed` change on the schedule's hourly scale, which a poll would not
 * serve; a mutation invalidates the list instead.
 */
export function domainPollInterval(
  items: readonly Pick<Domain, 'state'>[] | undefined,
): number | false {
  return (items ?? []).some((domain) => SETTLING.has(domain.state)) ? DOMAIN_POLL_MS : false;
}

function ready({ orgId, projectId }: ProjectRef): boolean {
  return orgId !== undefined && orgId.length > 0 && projectId !== undefined && projectId.length > 0;
}

function domainsKey({ orgId, projectId }: ProjectRef): readonly unknown[] {
  return ['domains', orgId, projectId];
}

/**
 * The project's domains and whether the caller may manage them. Polled as `useDeployments` is,
 * and for the same reason (027 research R17): a short poll that stops by itself keeps "the new
 * state within 5 s" without a stream.
 */
export function useDomains(project: ProjectRef): UseQueryResult<DomainListResponse, Error> {
  const { orgId, projectId } = project;

  return useQuery({
    enabled: ready(project),
    queryFn: ({ signal }) => listDomains(orgId ?? '', projectId ?? '', signal),
    queryKey: domainsKey(project),
    refetchInterval: (q) => domainPollInterval(q.state.data?.items),
  });
}

/**
 * Add a hostname. The idempotency key follows `useDeploy`: minted once per intent — per hostname,
 * as the API will normalise it — and held until that intent succeeds, so "try again" after a
 * dropped connection is answered with the first attempt's domain rather than a refusal.
 */
export function useAddDomain(
  project: ProjectRef,
): UseMutationResult<DomainResponse, Error, string, unknown> {
  const { orgId, projectId } = project;
  const queryClient = useQueryClient();
  const keys = useRef(new Map<string, string>());

  const intentOf = (hostname: string): string => hostname.trim().toLowerCase();

  return useMutation({
    mutationFn: (hostname: string) => {
      const intent = intentOf(hostname);
      let key = keys.current.get(intent);

      if (key === undefined) {
        key = crypto.randomUUID();
        keys.current.set(intent, key);
      }

      return addDomain(orgId ?? '', projectId ?? '', { hostname }, key);
    },
    onSuccess: async (_response, hostname) => {
      keys.current.delete(intentOf(hostname));
      await queryClient.invalidateQueries({ queryKey: domainsKey(project) });
    },
  });
}

/** Ask for a check now. A `429` carries when it may be asked again. */
export function useCheckDomain(
  project: ProjectRef,
): UseMutationResult<DomainResponse, Error, string, unknown> {
  const { orgId, projectId } = project;
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (domainId: string) => checkDomain(orgId ?? '', projectId ?? '', domainId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: domainsKey(project) });
    },
  });
}

/** Retry a failed domain, keyed per domain until the retry is accepted, as `useAddDomain` is. */
export function useRetryDomain(
  project: ProjectRef,
): UseMutationResult<DomainResponse, Error, string, unknown> {
  const { orgId, projectId } = project;
  const queryClient = useQueryClient();
  const keys = useRef(new Map<string, string>());

  return useMutation({
    mutationFn: (domainId: string) => {
      let key = keys.current.get(domainId);

      if (key === undefined) {
        key = crypto.randomUUID();
        keys.current.set(domainId, key);
      }

      return retryDomain(orgId ?? '', projectId ?? '', domainId, key);
    },
    onSuccess: async (_response, domainId) => {
      keys.current.delete(domainId);
      await queryClient.invalidateQueries({ queryKey: domainsKey(project) });
    },
  });
}

/** Remove a domain; the answer lists the records the member may now delete. */
export function useRemoveDomain(
  project: ProjectRef,
): UseMutationResult<RemoveDomainResponse, Error, string, unknown> {
  const { orgId, projectId } = project;
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (domainId: string) => removeDomain(orgId ?? '', projectId ?? '', domainId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: domainsKey(project) });
    },
  });
}

function cloudflarePath(orgId: string, domainId: string): string {
  return `/orgs/${encodeURIComponent(orgId)}/domains/${encodeURIComponent(domainId)}/cloudflare`;
}

function cloudflareKey(orgId: string | undefined, domainId: string): readonly unknown[] {
  return ['domains', orgId, 'cloudflare', domainId];
}

/**
 * Spec 030 US2: whether the organisation's Cloudflare connection can write a pending domain's
 * records (contracts/bindings.md § 3). Asked only where it can be acted on — a `pending` domain,
 * a caller holding `org:domains.manage` — and re-read every 2 s while a write is on its way.
 */
export function useCloudflareOffer(
  orgId: string | undefined,
  domainId: string,
  { enabled, writing }: { readonly enabled: boolean; readonly writing: boolean },
): UseQueryResult<CloudflareOffer, Error> {
  return useQuery({
    enabled: enabled && orgId !== undefined && orgId.length > 0,
    queryFn: ({ signal }) =>
      apiRequest('GET', cloudflarePath(orgId ?? '', domainId), {
        schema: cloudflareOfferSchema,
        signal,
      }),
    queryKey: cloudflareKey(orgId, domainId),
    refetchInterval: (q) =>
      writing && q.state.data?.status !== 'written' ? DOMAIN_POLL_MS : false,
  });
}

/** "Write with Cloudflare": `202` with the queued `dns_write`; step-up is the caller's to answer. */
export function useWriteWithCloudflare(
  orgId: string | undefined,
  domainId: string,
): UseMutationResult<Operation, Error, void, unknown> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () =>
      apiRequest('POST', `${cloudflarePath(orgId ?? '', domainId)}/write`, {
        schema: operationSchema,
      }),
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: cloudflareKey(orgId, domainId) });
    },
  });
}
