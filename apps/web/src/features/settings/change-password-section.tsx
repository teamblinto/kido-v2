import { passwordSchema } from '@repo/contracts';
import { useMutation } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import { useState } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { changePassword } from '@/features/auth/api';
import { PasswordField } from '@/features/auth/components/password-field';
import { PasswordStrengthMeter } from '@/features/auth/components/password-strength-meter';
import { MINIMUM_PASSWORD_LENGTH, assessPassword } from '@/features/auth/lib/password';
import { ApiProblem, messageFor } from '@/lib/api/problem';

/**
 * `POST /auth/password/change`. No step-up: the current password is the proof. The API revokes
 * every *other* session and keeps this one, so the person stays signed in here.
 */
export function ChangePasswordSection(): React.JSX.Element {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const change = useMutation({
    mutationFn: changePassword,
    onSuccess: () => {
      setCurrentPassword('');
      setNewPassword('');
      setConfirmation('');
    },
  });

  const assessment = assessPassword(newPassword);
  const fieldErrors = change.error instanceof ApiProblem ? change.error.fieldErrors() : {};
  const newPasswordError = fieldErrors.newPassword;

  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();

    if (!passwordSchema.safeParse(newPassword).success) {
      setLocalError(`Choose a password of at least ${String(MINIMUM_PASSWORD_LENGTH)} characters.`);

      return;
    }

    if (newPassword !== confirmation) {
      setLocalError('Both passwords need to match.');

      return;
    }

    setLocalError(null);
    change.mutate({ currentPassword, newPassword });
  }

  return (
    <section className="mt-10" aria-labelledby="change-password-heading">
      <h2 id="change-password-heading" className="text-heading-md font-semibold">
        Password
      </h2>
      <p className="text-body-sm text-subdued mt-1">
        Changing it signs you out on every other device. You stay signed in here.
      </p>

      {change.isSuccess ? (
        <Alert variant="success" className="mt-4" role="status">
          <CheckCircle2 />
          <AlertTitle>Password changed</AlertTitle>
          <AlertDescription>
            You have been signed out on every other device. Use the new password there.
          </AlertDescription>
        </Alert>
      ) : null}

      {change.isError && newPasswordError === undefined ? (
        <Alert variant="danger" className="mt-4">
          <AlertTriangle />
          <AlertTitle>{messageFor(change.error, 'That password could not be changed')}</AlertTitle>
          <AlertDescription>Your password has not changed.</AlertDescription>
        </Alert>
      ) : null}

      <form onSubmit={handleSubmit} className="mt-4 grid gap-4" noValidate>
        <PasswordField
          label="Current password"
          name="current-password"
          autoComplete="current-password"
          value={currentPassword}
          required
          onChange={(event) => {
            setCurrentPassword(event.target.value);
          }}
        />

        <PasswordField
          label="New password"
          name="new-password"
          autoComplete="new-password"
          placeholder={`At least ${String(MINIMUM_PASSWORD_LENGTH)} characters`}
          value={newPassword}
          required
          aria-invalid={assessment.isBreached || newPasswordError !== undefined}
          onChange={(event) => {
            setNewPassword(event.target.value);
          }}
          message={
            newPassword.length > 0 || newPasswordError !== undefined ? (
              <>
                {newPassword.length > 0 ? (
                  <PasswordStrengthMeter score={assessment.score} message={assessment.message} />
                ) : null}
                {newPasswordError === undefined ? null : (
                  <p className="text-caption text-danger mt-[7px]" role="alert">
                    {newPasswordError}
                  </p>
                )}
              </>
            ) : null
          }
        />

        <PasswordField
          label="Confirm new password"
          name="confirm-password"
          autoComplete="new-password"
          value={confirmation}
          required
          aria-invalid={localError !== null}
          onChange={(event) => {
            setConfirmation(event.target.value);
          }}
          message={
            localError === null ? null : (
              <p className="text-caption text-danger" role="alert">
                {localError}
              </p>
            )
          }
        />

        <Button
          type="submit"
          className="justify-self-start"
          disabled={change.isPending || currentPassword.length === 0}
        >
          {change.isPending ? (
            <>
              <Loader2 className="animate-spin" aria-hidden="true" />
              Changing password
            </>
          ) : (
            'Change password'
          )}
        </Button>
      </form>
    </section>
  );
}
