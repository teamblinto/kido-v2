import type { TemplateCatalogueResponse } from '@repo/contracts';
import { type UseQueryResult, useQuery } from '@tanstack/react-query';

import { listTemplates } from '../api';

export const TEMPLATES_QUERY_KEY = ['templates'] as const;

/**
 * The project templates this deployment can scaffold from (spec 015).
 *
 * Deployment-wide and tenant-blind, so the key carries no organisation — and nothing about it
 * changes while a page is open, so it is fetched once per session and never refetched. That
 * `staleTime` is the whole reason this is a hook rather than a `useQuery` at the call site: the
 * catalogue is the *only* source of template ids on the web, and every screen that needs one must
 * read the same cached answer instead of shipping its own list.
 */
export function useTemplates(): UseQueryResult<TemplateCatalogueResponse> {
  return useQuery({
    queryFn: ({ signal }) => listTemplates(signal),
    queryKey: TEMPLATES_QUERY_KEY,
    staleTime: Number.POSITIVE_INFINITY,
  });
}
