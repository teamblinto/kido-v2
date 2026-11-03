import { ORG_ROLES, type OrgRoleName } from '@repo/contracts';
import { Trash2Icon } from 'lucide-react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ApiProblem, messageFor } from '@/lib/api/problem';
import { useChangeMemberRole, useMembers, useRemoveMember } from './use-members';

/** The membership service's ranks: nobody confers, or touches, a role above their own. */
const RANK: Readonly<Record<OrgRoleName, number>> = { admin: 2, billing: 1, member: 1, owner: 3 };

const SELECT_CLASS =
  'border-line bg-raised text-body-sm h-8 rounded-md border px-2 capitalize focus-visible:outline-none';

/**
 * The 403 ("above your own") and 409 ("last owner") refusals carry a sentence written for a person,
 * and the slug table's generic one would hide which of the two it was.
 */
function refusal(error: Error): string {
  return ApiProblem.is(error, 'conflict') || ApiProblem.is(error, 'forbidden')
    ? error.message
    : messageFor(error, 'That change could not be made.');
}

interface MembersListProps {
  readonly orgId: string;
  /** The caller's own role — `org:members.role-change` and `.remove` are owner and admin only. */
  readonly role: OrgRoleName | null;
}

/** The organisation's members, with a role select and a remove button for those who may use them. */
export function MembersList({ orgId, role }: MembersListProps): React.JSX.Element {
  const members = useMembers(orgId);
  const changeRole = useChangeMemberRole(orgId);
  const remove = useRemoveMember(orgId);

  const mine = role === null ? 0 : RANK[role];
  const canManage = role === 'owner' || role === 'admin';
  const offered = ORG_ROLES.filter((option) => RANK[option] <= mine);
  const failure = changeRole.error ?? remove.error;

  if (members.isPending) {
    return (
      <p className="text-body-sm text-subdued" role="status">
        Loading members…
      </p>
    );
  }

  if (members.isError) {
    return (
      <Alert variant="danger">{messageFor(members.error, 'Members could not be loaded.')}</Alert>
    );
  }

  return (
    <section aria-label="Members" className="flex flex-col gap-3">
      {failure === null ? null : (
        <Alert variant="danger" role="alert">
          {refusal(failure)}
        </Alert>
      )}
      <ul className="flex flex-col gap-1.5">
        {members.data.members.map((member) => {
          const editable = canManage && RANK[member.role] <= mine;

          return (
            <li key={member.userId} className="flex items-center gap-2">
              <span className="text-body-sm min-w-0 flex-1 truncate">{member.email}</span>
              {member.acceptedAt === null ? (
                <span className="text-caption text-subdued">Invited</span>
              ) : null}
              {editable ? (
                <>
                  <select
                    aria-label={`Role for ${member.email}`}
                    className={SELECT_CLASS}
                    value={member.role}
                    disabled={changeRole.isPending}
                    onChange={(event) => {
                      changeRole.mutate({
                        role: event.target.value as OrgRoleName,
                        userId: member.userId,
                      });
                    }}
                  >
                    {offered.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove ${member.email}`}
                    disabled={remove.isPending}
                    onClick={() => {
                      if (
                        window.confirm(
                          `Remove ${member.email}? They are signed out everywhere and lose access to this organisation.`,
                        )
                      ) {
                        remove.mutate(member.userId);
                      }
                    }}
                  >
                    <Trash2Icon className="size-3.5" aria-hidden="true" />
                  </Button>
                </>
              ) : (
                <span className="text-caption text-subdued capitalize">{member.role}</span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
