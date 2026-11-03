import type { ModelCatalogueResponse, SubscriptionList } from '@repo/contracts';
import { type UseQueryResult, useQuery } from '@tanstack/react-query';
import { useCallback, useState } from 'react';

import { useSubscriptions } from '@/features/settings/subscription/subscription-api';
import { ApiProblem } from '@/lib/api/problem';
import { fetchModelCatalogue } from '../api';
import {
  type ModelChoice,
  noWayToPay,
  readChoice,
  resolveChoice,
  writeChoice,
} from '../lib/model-choice';

export interface ModelChoiceState {
  /** The two reads the picker shows, each with its own loading and error. */
  readonly catalogue: UseQueryResult<ModelCatalogueResponse>;
  /** What the next message runs on; `undefined` while nothing is known that could pay. */
  readonly choice: ModelChoice | undefined;
  /** Both reads answered and nothing can pay: offer to connect instead of sending. */
  readonly needsConnection: boolean;
  readonly setChoice: (choice: ModelChoice) => void;
  readonly subscriptions: UseQueryResult<SubscriptionList>;
}

/**
 * The model picker's state: the subscription and the catalogue, and the person's choice — kept per
 * project when `projectId` is given (it applies to the next message), held in memory otherwise.
 * `orgId` undefined, or a guest's organisation, reads no catalogue.
 */
export function useModelChoice({
  enabled = true,
  orgId,
  projectId,
}: {
  readonly enabled?: boolean;
  readonly orgId: string | undefined;
  readonly projectId?: string | undefined;
}): ModelChoiceState {
  const subscriptions = useSubscriptions();
  const catalogue = useQuery({
    enabled: enabled && orgId !== undefined,
    queryFn: ({ signal }) => fetchModelCatalogue(orgId ?? '', signal),
    queryKey: ['models', orgId],
    retry: (failureCount, error) => !ApiProblem.is(error, 'permission-denied') && failureCount < 1,
  });
  const [stored, setStored] = useState(() => ({ choice: readChoice(projectId), projectId }));
  // Another project on the same mounted page reads its own remembered choice.
  const remembered = stored.projectId === projectId ? stored.choice : readChoice(projectId);
  const sources = { catalogue: catalogue.data, subscriptions: subscriptions.data };

  const setChoice = useCallback(
    (next: ModelChoice) => {
      setStored({ choice: next, projectId });
      writeChoice(projectId, next);
    },
    [projectId],
  );

  return {
    catalogue,
    choice: resolveChoice(remembered, sources),
    needsConnection: noWayToPay(sources),
    setChoice,
    subscriptions,
  };
}
