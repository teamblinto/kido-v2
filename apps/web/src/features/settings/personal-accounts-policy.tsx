import type { OrgRoleName } from '@repo/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId } from 'react';

import { messageFor } from '@/lib/api/problem';
import {
  getPersonalAccountsPolicy,
  putPersonalAccountsPolicy,
} from './personal-accounts-policy-api';

interface PersonalAccountsPolicyProps {
  readonly orgId: string;
  readonly role: OrgRoleName;
}

export const PERSONAL_ACCOUNTS_LABEL =
  'Let members run on their own Claude or OpenAI subscriptions';

/**
 * Spec 032 T053: the organisation's switch for members' personal subscriptions. Editable by owner
 * or admin (`org:settings.update`), read-only for everyone else.
 */
export function PersonalAccountsPolicySwitch({
  orgId,
  role,
}: PersonalAccountsPolicyProps): React.JSX.Element {
  const canEdit = role === 'owner' || role === 'admin';
  const id = useId();
  const client = useQueryClient();
  const queryKey = ['personal-accounts-policy', orgId];
  const policy = useQuery({
    queryFn: ({ signal }) => getPersonalAccountsPolicy(orgId, signal),
    queryKey,
  });
  const change = useMutation({
    mutationFn: (allowed: boolean) => putPersonalAccountsPolicy(orgId, allowed),
    onSuccess: (next) => client.setQueryData(queryKey, next),
  });

  const allowed = policy.data?.allowed ?? false;

  return (
    <div className="border-line mt-6 rounded-lg border p-4">
      <div className="flex items-center justify-between gap-4">
        <label htmlFor={id} className="text-body-md font-medium">
          {PERSONAL_ACCOUNTS_LABEL}
        </label>
        <input
          id={id}
          type="checkbox"
          role="switch"
          className="size-5 accent-current"
          checked={allowed}
          aria-checked={allowed}
          disabled={!canEdit || policy.data === undefined || change.isPending}
          onChange={(event) => change.mutate(event.target.checked)}
        />
      </div>
      {canEdit ? null : (
        <p className="text-body-sm text-subdued mt-2">Only an owner or admin can change this.</p>
      )}
      {policy.isError ? (
        <p className="text-body-sm text-danger mt-2" role="status">
          {messageFor(policy.error)}
        </p>
      ) : null}
      {change.isError ? (
        <p className="text-body-sm text-danger mt-2" role="status">
          {messageFor(change.error)}
        </p>
      ) : null}
    </div>
  );
}
