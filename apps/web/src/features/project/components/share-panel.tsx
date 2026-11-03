import { Loader2, Trash2Icon, UserPlusIcon } from 'lucide-react';
import { useId, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { messageFor } from '@/lib/api/problem';
import {
  type ProjectRole,
  useChangeProjectRole,
  useInviteToProject,
  useProjectAccess,
  useRemoveFromProject,
  useWithdrawInvitation,
} from '../hooks/use-project-access';

/** The one confirmation an invite gets, whatever the address (FR-020, SC-007). */
export const INVITE_SENT_COPY = 'Invitation sent. They will get an email with a link to join.';

const ROLES: readonly { label: string; value: ProjectRole }[] = [
  { label: 'Owner', value: 'owner' },
  { label: 'Editor', value: 'editor' },
  { label: 'Commenter', value: 'commenter' },
  { label: 'Viewer', value: 'viewer' },
];

const SELECT_CLASS =
  'border-line bg-raised text-body-sm h-8 rounded-md border px-2 focus-visible:outline-none';

interface SharePanelProps {
  readonly orgId: string | undefined;
  readonly projectId: string | undefined;
}

/**
 * Who has this project (spec 031 US2, contracts/sharing.md § 8): every grant with a role select
 * and a remove button, every open invitation with withdraw, and an invite form. Org members with no
 * grant are not listed — they have no access here (FR-023, R8). Refusals are the server's sentence;
 * the `last-owner` one comes from T011's reason map.
 */
export function SharePanel({ orgId, projectId }: SharePanelProps): React.JSX.Element {
  const project = { orgId, projectId };
  const access = useProjectAccess(project);
  const invite = useInviteToProject(project);
  const withdraw = useWithdrawInvitation(project);
  const changeRole = useChangeProjectRole(project);
  const remove = useRemoveFromProject(project);

  const [email, setEmail] = useState('');
  const [role, setRole] = useState<ProjectRole>('viewer');
  const emailId = useId();
  const roleId = useId();

  const failure = [changeRole.error, remove.error, withdraw.error].find((error) => error !== null);

  return (
    <div className="flex flex-col gap-5 p-5">
      <div>
        <h2 className="text-heading-sm font-semibold">Share this project</h2>
        <p className="text-body-sm text-subdued mt-1">
          People you invite see this project only — not the rest of the organisation.
        </p>
      </div>

      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          invite.mutate(
            { email: email.trim(), role },
            {
              onSuccess: () => {
                setEmail('');
              },
            },
          );
        }}
      >
        <Label htmlFor={emailId}>Email address</Label>
        <div className="flex gap-2">
          <Input
            id={emailId}
            type="email"
            autoComplete="off"
            placeholder="name@example.com"
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
          />
          <select
            id={roleId}
            aria-label="Role for the invitation"
            className={SELECT_CLASS}
            value={role}
            onChange={(event) => {
              setRole(event.target.value as ProjectRole);
            }}
          >
            {ROLES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <Button type="submit" size="sm" disabled={invite.isPending || email.trim() === ''}>
            {invite.isPending ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <UserPlusIcon className="size-3.5" aria-hidden="true" />
            )}
            Invite
          </Button>
        </div>
        {invite.isSuccess ? (
          <p className="text-caption text-subdued" role="status">
            {INVITE_SENT_COPY}
          </p>
        ) : null}
        {invite.isError ? (
          <p className="text-caption text-danger" role="alert">
            {messageFor(invite.error, 'The invitation could not be sent.')}
          </p>
        ) : null}
      </form>

      {failure === undefined ? null : (
        <Alert variant="danger" role="alert">
          {messageFor(failure, 'That change could not be made.')}
        </Alert>
      )}

      {access.isPending ? (
        <p className="text-body-sm text-subdued" role="status">
          Loading who has access…
        </p>
      ) : access.isError ? (
        <Alert variant="danger">{messageFor(access.error, 'Access could not be loaded.')}</Alert>
      ) : (
        <>
          <section aria-label="People with access">
            <h3 className="text-label-sm text-subdued mb-2 font-medium">People with access</h3>
            <ul className="flex flex-col gap-1.5">
              {access.data.grants.map((grant) => (
                <li key={grant.userId} className="flex items-center gap-2">
                  <span className="text-body-sm min-w-0 flex-1 truncate">{grant.email}</span>
                  <select
                    aria-label={`Role for ${grant.email}`}
                    className={SELECT_CLASS}
                    value={grant.role}
                    onChange={(event) => {
                      changeRole.mutate({
                        role: event.target.value as ProjectRole,
                        userId: grant.userId,
                      });
                    }}
                  >
                    {ROLES.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove ${grant.email}`}
                    onClick={() => {
                      remove.mutate(grant.userId);
                    }}
                  >
                    <Trash2Icon className="size-3.5" aria-hidden="true" />
                  </Button>
                </li>
              ))}
            </ul>
          </section>

          {access.data.invitations.length === 0 ? null : (
            <section aria-label="Waiting to accept">
              <h3 className="text-label-sm text-subdued mb-2 font-medium">Waiting to accept</h3>
              <ul className="flex flex-col gap-1.5">
                {access.data.invitations.map((invitation) => (
                  <li key={invitation.id} className="flex items-center gap-2">
                    <span className="text-body-sm min-w-0 flex-1 truncate">{invitation.email}</span>
                    <span className="text-caption text-subdued capitalize">{invitation.role}</span>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        withdraw.mutate(invitation.id);
                      }}
                    >
                      Withdraw
                      <span className="sr-only"> the invitation to {invitation.email}</span>
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
