import { MFA_CODE_MAX_LENGTH } from '@repo/contracts';
import { useMutation } from '@tanstack/react-query';
import { AlertTriangleIcon, Loader2Icon } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { useState } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiProblem, messageFor } from '@/lib/api/problem';
import { beginTotpEnrolment, confirmTotpEnrolment, disableMfa, stepUp } from '../api';
import { useSession } from '../session/session-context';

const codeLength = 6;

interface TwoFactorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Where the flow is, and the one secret each step is allowed to hold.
 *
 * `enrolling` holds the provisioning URI and `codes` holds the recovery codes, and neither is ever
 * copied anywhere else: not into a query cache (every call below is a mutation), not into storage,
 * not into a log. The state lives in `TwoFactorFlow`, which is mounted inside `DialogContent` and
 * so unmounts when the dialog closes — closing *is* the cleanup, and there is no second copy to
 * forget to clear.
 */
type View =
  | { readonly kind: 'idle' }
  | { readonly kind: 'enrolling'; readonly otpauthUri: string }
  | { readonly kind: 'codes'; readonly recoveryCodes: readonly string[] }
  | { readonly kind: 'stepUp' };

/**
 * Spec 003, as a screen: turn an authenticator app on, see the recovery codes once, turn it off.
 *
 * Modelled on `SessionsDialog`, with one difference the shape of the data forces. That dialog
 * lists things the caller can re-read at will; this one shows two things the API will never show
 * again — the QR code and the recovery codes — so the state that holds them sits *inside* the
 * content that unmounts on close, and the recovery-code view refuses to close until the user has
 * said they kept them.
 */
export function TwoFactorDialog({ onOpenChange, open }: TwoFactorDialogProps): React.JSX.Element {
  const [dismissible, setDismissible] = useState(true);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Escape, the overlay and the close button all arrive here. While the recovery codes are
        // on screen every one of them is ignored — the only way out is the acknowledgement.
        if (next || dismissible) {
          onOpenChange(next);
        }
      }}
    >
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Two-factor authentication</DialogTitle>
          <DialogDescription>
            A code from an authenticator app, asked for every time you sign in.
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <TwoFactorFlow onDismissibleChange={setDismissible} onDone={() => onOpenChange(false)} />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

interface TwoFactorFlowProps {
  onDismissibleChange: (dismissible: boolean) => void;
  onDone: () => void;
}

function TwoFactorFlow({ onDismissibleChange, onDone }: TwoFactorFlowProps): React.JSX.Element {
  const { isResolving, refresh, user } = useSession();
  const [view, setViewState] = useState<View>({ kind: 'idle' });
  const [code, setCode] = useState('');
  const [usingRecoveryCode, setUsingRecoveryCode] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  function setView(next: View): void {
    setViewState(next);
    setCode('');
    onDismissibleChange(next.kind !== 'codes');
  }

  /**
   * A `conflict` on any of these routes means the account is not in the state this screen believed
   * it was in — enrolled already, or nothing to remove. The remedy is the truth, not a message:
   * re-read the account and render whatever it says.
   */
  async function resync(): Promise<void> {
    await refresh();
    setView({ kind: 'idle' });
  }

  const begin = useMutation({
    mutationFn: beginTotpEnrolment,
    onError: async (error) => {
      if (ApiProblem.is(error, 'conflict')) {
        await resync();
      }
    },
    onSuccess: ({ otpauthUri }) => {
      setView({ kind: 'enrolling', otpauthUri });
    },
  });

  const confirm = useMutation({
    mutationFn: confirmTotpEnrolment,
    onError: async (error) => {
      if (ApiProblem.is(error, 'conflict')) {
        await resync();
      }
      // `mfa-code-incorrect` is left alone on purpose: the server kept the pending seed, so the
      // QR code stays and the user retypes rather than rescans.
    },
    onSuccess: async ({ recoveryCodes }) => {
      setView({ kind: 'codes', recoveryCodes });
      await refresh();
    },
  });

  const remove = useMutation({
    mutationFn: disableMfa,
    onError: async (error) => {
      if (ApiProblem.is(error, 'step-up-required')) {
        setView({ kind: 'stepUp' });

        return;
      }

      if (ApiProblem.is(error, 'conflict')) {
        await resync();
      }
    },
    onSuccess: async () => {
      await resync();
    },
  });

  const prove = useMutation({
    mutationFn: stepUp,
    onSuccess: () => {
      // One retry, not a loop: a second `step-up-required` after a successful step-up renders as
      // the error it is rather than as another prompt.
      remove.mutate();
    },
  });

  const busy = begin.isPending || confirm.isPending || remove.isPending || prove.isPending;

  function submitCode(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();

    const trimmed = code.trim();

    if (trimmed.length === 0 || trimmed.length > MFA_CODE_MAX_LENGTH) {
      return;
    }

    if (view.kind === 'enrolling') {
      confirm.mutate({ code: trimmed });
    } else if (view.kind === 'stepUp') {
      prove.mutate({ code: trimmed });
    }
  }

  if (isResolving || user === undefined) {
    return (
      <div className="flex items-center gap-2.5 py-6" role="status" aria-live="polite">
        <Loader2Icon className="text-subdued size-[18px] animate-spin" aria-hidden="true" />
        <span className="text-body-sm text-subdued">Loading your account…</span>
      </div>
    );
  }

  if (view.kind === 'codes') {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-body-sm text-foreground">
          Two-factor authentication is on. Keep these recovery codes somewhere safe — each one signs
          you in once if you lose your device.{' '}
          <strong className="font-medium">These codes will not be shown again.</strong>
        </p>
        <ol className="border-line-subtle grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-lg border p-4 font-mono text-sm select-all">
          {view.recoveryCodes.map((recoveryCode) => (
            <li key={recoveryCode}>{recoveryCode}</li>
          ))}
        </ol>
        {copyFailed ? (
          <p className="text-caption text-danger" role="alert">
            Copy failed — select the codes and copy them by hand.
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              navigator.clipboard.writeText(view.recoveryCodes.join('\n')).then(
                () => {
                  setCopyFailed(false);
                },
                () => {
                  setCopyFailed(true);
                },
              );
            }}
          >
            Copy codes
          </Button>
          <Button type="button" onClick={onDone}>
            I have saved my codes
          </Button>
        </div>
      </div>
    );
  }

  // Latest step first: a wrong step-up code must show even though the removal that prompted for
  // it is still sitting in its own error state.
  const failure = prove.error ?? remove.error ?? confirm.error ?? begin.error;
  // `step-up-required` is the prompt itself, and `conflict` was answered by re-reading the
  // account; neither is a failure to report beside the view it produced.
  const showFailure =
    failure !== null &&
    !ApiProblem.is(failure, 'step-up-required') &&
    !ApiProblem.is(failure, 'conflict');

  if (view.kind === 'enrolling' || view.kind === 'stepUp') {
    return (
      <form onSubmit={submitCode} className="flex flex-col gap-4">
        {view.kind === 'enrolling' ? (
          <>
            <p className="text-body-sm text-subdued">
              Scan this with your authenticator app, then enter the {String(codeLength)}-digit code
              it shows. Nothing changes until the code is accepted.
            </p>
            <div className="flex justify-center">
              <QRCodeSVG
                value={view.otpauthUri}
                size={192}
                role="img"
                aria-label="Scan this with your authenticator app"
                className="bg-white p-2"
              />
            </div>
          </>
        ) : (
          <p className="text-body-sm text-subdued">
            Removing the authenticator app needs a recent second factor. Enter the code from your
            app to continue.
          </p>
        )}

        {showFailure ? (
          <Alert variant="danger">
            <AlertTriangleIcon />
            <AlertTitle>{messageFor(failure, 'That code was not accepted')}</AlertTitle>
            {usingRecoveryCode ? null : (
              <AlertDescription>
                Codes change every 30 seconds — check your app for the current one.
              </AlertDescription>
            )}
          </Alert>
        ) : null}

        {usingRecoveryCode ? (
          <div className="flex flex-col gap-2">
            <Label htmlFor="two-factor-recovery-code">Recovery code</Label>
            <Input
              id="two-factor-recovery-code"
              name="recovery-code"
              autoComplete="one-time-code"
              autoFocus
              maxLength={MFA_CODE_MAX_LENGTH}
              placeholder="One of your saved codes"
              value={code}
              onChange={(event) => {
                setCode(event.target.value);
              }}
            />
          </div>
        ) : (
          <InputOTP
            maxLength={codeLength}
            value={code}
            onChange={setCode}
            autoFocus
            aria-label="Confirmation code"
            containerClassName="w-full"
          >
            <InputOTPGroup>
              {Array.from({ length: codeLength }, (_, index) => (
                <InputOTPSlot key={index} index={index} />
              ))}
            </InputOTPGroup>
          </InputOTP>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3">
          {view.kind === 'stepUp' ? (
            <button
              type="button"
              className="text-brand text-body-sm font-medium underline-offset-4 hover:underline"
              onClick={() => {
                // `mfaCodeSchema` takes either; only the input shape differs.
                setUsingRecoveryCode((current) => !current);
                setCode('');
                prove.reset();
              }}
            >
              {usingRecoveryCode ? 'Enter a 6-digit code' : 'Use a recovery code'}
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => {
                begin.reset();
                confirm.reset();
                remove.reset();
                prove.reset();
                setUsingRecoveryCode(false);
                setView({ kind: 'idle' });
              }}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                busy || (usingRecoveryCode ? code.trim().length === 0 : code.length !== codeLength)
              }
            >
              {busy ? (
                <>
                  <Loader2Icon className="animate-spin" aria-hidden="true" />
                  Verifying
                </>
              ) : view.kind === 'enrolling' ? (
                'Turn on'
              ) : (
                'Confirm and remove'
              )}
            </Button>
          </div>
        </div>
      </form>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {showFailure ? (
        <Alert variant="danger">
          <AlertTriangleIcon />
          <AlertTitle>{messageFor(failure, 'That did not work')}</AlertTitle>
        </Alert>
      ) : null}

      <div className="border-line-subtle flex items-center gap-3 rounded-lg border p-3">
        <div className="min-w-0 flex-1">
          <p className="text-label-sm text-foreground font-medium">
            {user.mfaEnabled ? 'On' : 'Off'}
          </p>
          <p className="text-caption text-faint mt-0.5">
            {user.mfaEnabled
              ? 'Your account asks for a code from your authenticator app when you sign in.'
              : 'Your password alone signs you in.'}
          </p>
        </div>
        {user.mfaEnabled ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => {
              remove.mutate();
            }}
          >
            Remove authenticator app
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() => {
              begin.mutate();
            }}
          >
            Set up authenticator app
          </Button>
        )}
      </div>
    </div>
  );
}

interface StepUpDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What the second factor is for, in one sentence. */
  description: string;
  /** Called once the step-up is accepted; the caller retries what was refused. */
  onSteppedUp: () => void;
}

/**
 * The answer to a `step-up-required` refusal from anywhere but the MFA settings above (spec 030
 * R14: a connector removal). The same code form as the removal step-up in {@link TwoFactorDialog} —
 * a 6-digit code or a recovery code — and on success the caller retries once.
 */
export function StepUpDialog({
  description,
  onOpenChange,
  onSteppedUp,
  open,
}: StepUpDialogProps): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Confirm it is you</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <StepUpForm
            onCancel={() => onOpenChange(false)}
            onSteppedUp={() => {
              onOpenChange(false);
              onSteppedUp();
            }}
          />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function StepUpForm({
  onCancel,
  onSteppedUp,
}: {
  onCancel: () => void;
  onSteppedUp: () => void;
}): React.JSX.Element {
  const [code, setCode] = useState('');
  const [usingRecoveryCode, setUsingRecoveryCode] = useState(false);
  const prove = useMutation({ mutationFn: stepUp, onSuccess: onSteppedUp });

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = code.trim();

        if (trimmed.length > 0 && trimmed.length <= MFA_CODE_MAX_LENGTH) {
          prove.mutate({ code: trimmed });
        }
      }}
    >
      {prove.error !== null ? (
        <Alert variant="danger">
          <AlertTriangleIcon />
          <AlertTitle>{messageFor(prove.error, 'That code was not accepted')}</AlertTitle>
        </Alert>
      ) : null}

      {usingRecoveryCode ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor="step-up-recovery-code">Recovery code</Label>
          <Input
            id="step-up-recovery-code"
            autoComplete="one-time-code"
            autoFocus
            maxLength={MFA_CODE_MAX_LENGTH}
            value={code}
            onChange={(event) => {
              setCode(event.target.value);
            }}
          />
        </div>
      ) : (
        <InputOTP
          maxLength={codeLength}
          value={code}
          onChange={setCode}
          autoFocus
          aria-label="Authenticator code"
          containerClassName="w-full"
        >
          <InputOTPGroup>
            {Array.from({ length: codeLength }, (_, index) => (
              <InputOTPSlot key={index} index={index} />
            ))}
          </InputOTPGroup>
        </InputOTP>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          className="text-brand text-body-sm font-medium underline-offset-4 hover:underline"
          onClick={() => {
            setUsingRecoveryCode((current) => !current);
            setCode('');
            prove.reset();
          }}
        >
          {usingRecoveryCode ? 'Enter a 6-digit code' : 'Use a recovery code'}
        </button>
        <div className="flex gap-2">
          <Button type="button" variant="outline" disabled={prove.isPending} onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={
              prove.isPending ||
              (usingRecoveryCode ? code.trim().length === 0 : code.length !== codeLength)
            }
          >
            {prove.isPending ? (
              <>
                <Loader2Icon className="animate-spin" aria-hidden="true" />
                Verifying
              </>
            ) : (
              'Confirm'
            )}
          </Button>
        </div>
      </div>
    </form>
  );
}
