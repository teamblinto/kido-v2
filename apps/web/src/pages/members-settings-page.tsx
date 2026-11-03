import { ORG_ROLES, type OrgRoleName } from '@repo/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, UserPlusIcon } from 'lucide-react';
import { useId, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MembersList } from '@/features/settings/members/members-list';
import { SettingsNav } from '@/features/settings/settings-nav';
import { inviteMember } from '@/features/workspace/api';
import { useOrgs } from '@/features/workspace/hooks/use-orgs';
import { messageFor } from '@/lib/api/problem';

/** The one confirmation an invite gets, whatever the address (criterion 10: no account oracle). */
export const ORG_INVITE_SENT_COPY = 'Invitation sent. They will get an email with a link to join.';

const SELECT_CLASS =
  'border-line bg-raised text-body-sm h-8 rounded-md border px-2 capitalize focus-visible:outline-none';

/** The organisation's members and the invite form (spec 033). */
export function MembersSettingsPage(): React.JSX.Element {
  const { activeOrg, isLoading } = useOrgs();

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <SettingsNav />
      <h1 className="text-heading-lg font-semibold">Members</h1>
      <p className="text-body-sm text-subdued mt-1">
        Invite people to the organisation. They join once they accept the emailed link.
      </p>

      {isLoading ? (
        <div className="mt-6 flex items-center gap-2.5" role="status" aria-live="polite">
          <Loader2 className="text-subdued size-[18px] animate-spin" aria-hidden="true" />
          <span className="text-body-sm text-subdued">Loading…</span>
        </div>
      ) : null}

      {activeOrg === undefined ? null : (
        <MembersSection orgId={activeOrg.id} role={activeOrg.role} />
      )}
    </main>
  );
}

function MembersSection({
  orgId,
  role: callerRole,
}: {
  readonly orgId: string;
  readonly role: OrgRoleName | null;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const invite = useMutation({
    mutationFn: (body: { email: string; role: OrgRoleName }) => inviteMember(orgId, body),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['members', orgId] }),
  });

  const [email, setEmail] = useState('');
  const [role, setRole] = useState<OrgRoleName>('member');
  const emailId = useId();

  return (
    <div className="mt-6 flex flex-col gap-6">
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
        <Label htmlFor={emailId}>Invite member</Label>
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
            aria-label="Role for the invitation"
            className={SELECT_CLASS}
            value={role}
            onChange={(event) => {
              setRole(event.target.value as OrgRoleName);
            }}
          >
            {ORG_ROLES.map((value) => (
              <option key={value} value={value}>
                {value}
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
            {ORG_INVITE_SENT_COPY}
          </p>
        ) : null}
        {invite.isError ? (
          <p className="text-caption text-danger" role="alert">
            {messageFor(invite.error, 'The invitation could not be sent.')}
          </p>
        ) : null}
      </form>

      <MembersList orgId={orgId} role={callerRole} />
    </div>
  );
}
