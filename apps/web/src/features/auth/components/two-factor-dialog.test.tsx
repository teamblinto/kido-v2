import { type RenderResult, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';

import { aUser, problemResponse, renderScreen } from '@/test/render';
import { API, server } from '@/test/server';
import { TwoFactorDialog } from './two-factor-dialog';

const SECRET = 'JBSWY3DPEHPK3PXP';
const OTPAUTH_URI = `otpauth://totp/Forge:rakibul%40blinto.co?secret=${SECRET}&issuer=Forge`;

const RECOVERY_CODES = [
  'a1b2c-d3e4f',
  'g5h6i-j7k8l',
  'm9n0o-p1q2r',
  's3t4u-v5w6x',
  'y7z8a-b9c0d',
  'e1f2g-h3i4j',
  'k5l6m-n7o8p',
  'q9r0s-t1u2v',
  'w3x4y-z5a6b',
  'c7d8e-f9g0h',
];

interface Scenario {
  /** What `POST /auth/mfa/totp` answers. */
  readonly begin?: 'ok' | 'conflict';
  /** What `POST /auth/mfa/totp/confirm` answers. */
  readonly confirm?: 'ok' | 'wrong' | 'conflict';
  /**
   * What `DELETE /auth/mfa/totp` answers: `ok` outright, `step-up` until a step-up has been
   * accepted (which is how `StepUpGuard` behaves), or `conflict`.
   */
  readonly remove?: 'ok' | 'step-up' | 'conflict';
  /** What `POST /auth/mfa/step-up` answers. */
  readonly stepUp?: 'ok' | 'wrong';
  readonly onOpenChange?: (open: boolean) => void;
  readonly open?: boolean;
  /** Who `GET /auth/me` names on first paint. */
  readonly user?: typeof aUser;
}

/**
 * Render the dialog and describe the server it talks to.
 *
 * The `GET /auth/me` handler is registered *after* `renderScreen`, which registers its own: msw
 * gives the most recently registered handler precedence, and this one has to win the refetch so
 * the answer can change once an enrolment is confirmed. The assertions in this file are mostly
 * counts — how many times each route was hit is what proves "nothing durable before confirm" and
 * "re-read after".
 */
function openDialog(
  scenario: Scenario = {},
): RenderResult & { calls: Record<string, number>; stepUpBodies: readonly unknown[] } {
  const {
    begin = 'ok',
    confirm = 'ok',
    onOpenChange = () => undefined,
    open = true,
    remove = 'ok',
    stepUp = 'ok',
    user = aUser,
  } = scenario;
  const calls = { begin: 0, confirm: 0, me: 0, remove: 0, stepUp: 0 };
  let steppedUp = false;
  let removed = false;
  const stepUpBodies: unknown[] = [];

  // Counted at the request layer rather than in a handler, because the first `GET /auth/me` is
  // dispatched during `renderScreen` and answered by the handler it registers; only the refetch
  // reaches the one below.
  server.events.removeAllListeners('request:start');
  server.events.on('request:start', ({ request }) => {
    if (new URL(request.url).pathname === `${API}/auth/me`) {
      calls.me += 1;
    }
  });

  const view = renderScreen(<TwoFactorDialog open={open} onOpenChange={onOpenChange} />, { user });

  server.use(
    http.get(`${API}/auth/me`, () => {
      // The refetch. A confirmed enrolment turns the factor on and a completed removal turns it
      // off; a `conflict` on begin means it was on all along, and on remove that it was off.
      const mfaEnabled =
        ((confirm === 'ok' && calls.confirm > 0) || begin === 'conflict' || user.mfaEnabled) &&
        !removed &&
        remove !== 'conflict';

      return HttpResponse.json({ user: { ...user, mfaEnabled } });
    }),
    http.delete(`${API}/auth/mfa/totp`, () => {
      calls.remove += 1;

      if (remove === 'conflict') {
        return problemResponse('conflict', 409);
      }

      if (remove === 'step-up' && !steppedUp) {
        return problemResponse('step-up-required', 403);
      }

      removed = true;

      return HttpResponse.json({ status: 'mfa-disabled' });
    }),
    http.post(`${API}/auth/mfa/step-up`, async ({ request }) => {
      calls.stepUp += 1;
      stepUpBodies.push(await request.json());

      if (stepUp === 'wrong') {
        return problemResponse('mfa-code-incorrect', 403);
      }

      steppedUp = true;

      return HttpResponse.json({ status: 'stepped-up' });
    }),
    http.post(`${API}/auth/mfa/totp`, () => {
      calls.begin += 1;

      return begin === 'conflict'
        ? problemResponse('conflict', 409)
        : HttpResponse.json({ otpauthUri: OTPAUTH_URI });
    }),
    http.post(`${API}/auth/mfa/totp/confirm`, () => {
      calls.confirm += 1;

      if (confirm === 'wrong') {
        return problemResponse('mfa-code-incorrect', 403);
      }

      if (confirm === 'conflict') {
        return problemResponse('conflict', 409);
      }

      return HttpResponse.json({ recoveryCodes: RECOVERY_CODES });
    }),
  );

  return { ...view, calls, stepUpBodies };
}

async function enrolUpToTheCode(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole('button', { name: 'Set up authenticator app' }));
  await user.type(await screen.findByLabelText('Confirmation code'), '123456');
  await user.click(screen.getByRole('button', { name: 'Turn on' }));
}

describe('TwoFactorDialog', () => {
  describe('enrolling', () => {
    it('shows two-factor authentication as off, and one way to set it up', async () => {
      openDialog();

      const dialog = await screen.findByRole('dialog');

      expect(await within(dialog).findByText('Off')).toBeInTheDocument();
      expect(within(dialog).getAllByRole('button', { name: /set up|remove/i })).toHaveLength(1);
      expect(
        within(dialog).getByRole('button', { name: 'Set up authenticator app' }),
      ).toBeVisible();
    });

    it('renders the provisioning URI as a QR code and never as text', async () => {
      const user = userEvent.setup();
      const { calls } = openDialog();

      await user.click(await screen.findByRole('button', { name: 'Set up authenticator app' }));

      const dialog = await screen.findByRole('dialog');

      await within(dialog).findByRole('img', { name: /scan this/i });
      expect(dialog.querySelector('svg')).not.toBeNull();
      expect(dialog).not.toHaveTextContent('otpauth://');
      expect(dialog).not.toHaveTextContent(SECRET);
      expect(calls.begin).toBe(1);
      expect(calls.confirm).toBe(0);
    });

    it('keeps the QR code on a wrong confirmation code', async () => {
      const user = userEvent.setup();
      const { calls } = openDialog({ confirm: 'wrong' });

      await user.click(await screen.findByRole('button', { name: 'Set up authenticator app' }));
      await user.type(await screen.findByLabelText('Confirmation code'), '000000');
      await user.click(screen.getByRole('button', { name: 'Turn on' }));

      const alert = await screen.findByRole('alert');

      expect(alert).toHaveTextContent(/incorrect/i);
      expect(screen.getByRole('dialog').querySelector('svg')).not.toBeNull();
      expect(calls.begin).toBe(1);
      expect(calls.confirm).toBe(1);
    });

    it('shows the ten recovery codes once, and only closes after they are acknowledged', async () => {
      const user = userEvent.setup();
      let closedWith: boolean | undefined;
      const { calls } = openDialog({
        onOpenChange: (open) => {
          closedWith = open;
        },
      });

      await enrolUpToTheCode(user);

      const dialog = screen.getByRole('dialog');

      for (const code of RECOVERY_CODES) {
        expect(await within(dialog).findByText(code)).toBeInTheDocument();
      }

      // Neither Escape nor the close button may dismiss the only view these codes ever appear in.
      await user.keyboard('{Escape}');
      expect(closedWith).toBeUndefined();
      await user.click(within(dialog).getByRole('button', { name: 'Close' }));
      expect(closedWith).toBeUndefined();

      await user.click(within(dialog).getByRole('button', { name: 'I have saved my codes' }));
      expect(closedWith).toBe(false);

      // The account state was re-read after the confirmation, not only on open.
      await waitFor(() => {
        expect(calls.me).toBeGreaterThanOrEqual(2);
      });
    });

    it('leaves nothing of the codes behind once the dialog is closed', async () => {
      const user = userEvent.setup();
      const { rerender } = openDialog();

      await enrolUpToTheCode(user);
      await screen.findByText(RECOVERY_CODES[0]!);

      rerender(<TwoFactorDialog open={false} onOpenChange={() => undefined} />);

      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });
      expect(document.body).not.toHaveTextContent(RECOVERY_CODES[0]!);
      expect(document.body).not.toHaveTextContent(RECOVERY_CODES[9]!);
    });

    it('copies the recovery codes', async () => {
      const user = userEvent.setup();

      openDialog();

      await enrolUpToTheCode(user);
      await user.click(await screen.findByRole('button', { name: 'Copy codes' }));

      await expect(navigator.clipboard.readText()).resolves.toBe(RECOVERY_CODES.join('\n'));
    });

    it('returns to the account state when enrolment was already done elsewhere', async () => {
      const user = userEvent.setup();
      const { calls } = openDialog({ begin: 'conflict' });

      await user.click(await screen.findByRole('button', { name: 'Set up authenticator app' }));

      const dialog = screen.getByRole('dialog');

      expect(await within(dialog).findByText('On')).toBeInTheDocument();
      expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
      expect(calls.me).toBeGreaterThanOrEqual(2);
    });
  });

  describe('the account state', () => {
    const enrolled = { ...aUser, mfaEnabled: true };

    it('shows two-factor authentication as on, and one way to remove it', async () => {
      const { calls } = openDialog({ user: enrolled });

      const dialog = await screen.findByRole('dialog');

      expect(await within(dialog).findByText('On')).toBeInTheDocument();
      expect(within(dialog).getAllByRole('button', { name: /set up|remove/i })).toHaveLength(1);
      expect(
        within(dialog).getByRole('button', { name: 'Remove authenticator app' }),
      ).toBeVisible();
      expect(calls.begin).toBe(0);
    });

    it('asks for nothing while it is closed', async () => {
      const { calls } = openDialog({ open: false });

      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(calls.begin).toBe(0);
      expect(calls.confirm).toBe(0);
    });

    it('offers no action until the account state is known', async () => {
      openDialog({ user: enrolled });

      const dialog = await screen.findByRole('dialog');

      // `GET /auth/me` has not answered yet on the first paint; a button here would be a guess.
      expect(within(dialog).queryByRole('button', { name: /set up|remove/i })).toBeNull();
      expect(
        await within(dialog).findByRole('button', { name: 'Remove authenticator app' }),
      ).toBeVisible();
    });
  });

  describe('removing', () => {
    const enrolled = { ...aUser, mfaEnabled: true };

    it('removes without a prompt when the session recently stepped up', async () => {
      const user = userEvent.setup();
      const { calls } = openDialog({ user: enrolled });

      await user.click(await screen.findByRole('button', { name: 'Remove authenticator app' }));

      const dialog = screen.getByRole('dialog');

      expect(await within(dialog).findByText('Off')).toBeInTheDocument();
      expect(within(dialog).queryByLabelText('Confirmation code')).toBeNull();
      expect(calls.remove).toBe(1);
      expect(calls.stepUp).toBe(0);
      expect(calls.me).toBeGreaterThanOrEqual(2);
    });

    it('asks for a code when the server requires a recent second factor, then retries', async () => {
      const user = userEvent.setup();
      const { calls } = openDialog({ remove: 'step-up', user: enrolled });

      await user.click(await screen.findByRole('button', { name: 'Remove authenticator app' }));

      const dialog = screen.getByRole('dialog');

      // A prompt, not an error: nothing about the account changed and the session is fine.
      expect(within(dialog).queryByRole('alert')).toBeNull();
      await user.type(await within(dialog).findByLabelText('Confirmation code'), '123456');
      await user.click(within(dialog).getByRole('button', { name: 'Confirm and remove' }));

      expect(await within(dialog).findByText('Off')).toBeInTheDocument();
      expect(calls.stepUp).toBe(1);
      expect(calls.remove).toBe(2);
      expect(calls.me).toBeGreaterThanOrEqual(2);
    });

    it('keeps the prompt open on a wrong step-up code', async () => {
      const user = userEvent.setup();
      const { calls } = openDialog({ remove: 'step-up', stepUp: 'wrong', user: enrolled });

      await user.click(await screen.findByRole('button', { name: 'Remove authenticator app' }));

      const dialog = screen.getByRole('dialog');

      await user.type(await within(dialog).findByLabelText('Confirmation code'), '000000');
      await user.click(within(dialog).getByRole('button', { name: 'Confirm and remove' }));

      expect(await within(dialog).findByRole('alert')).toHaveTextContent(/incorrect/i);
      expect(within(dialog).getByLabelText('Confirmation code')).toBeInTheDocument();
      expect(calls.remove).toBe(1);
      expect(calls.me).toBe(1);
    });

    it('accepts a recovery code at the step-up prompt', async () => {
      const user = userEvent.setup();
      const { stepUpBodies } = openDialog({ remove: 'step-up', user: enrolled });

      await user.click(await screen.findByRole('button', { name: 'Remove authenticator app' }));

      const dialog = screen.getByRole('dialog');

      await user.click(await within(dialog).findByRole('button', { name: 'Use a recovery code' }));
      await user.type(within(dialog).getByLabelText('Recovery code'), 'abcd-efgh');
      await user.click(within(dialog).getByRole('button', { name: 'Confirm and remove' }));

      expect(await within(dialog).findByText('Off')).toBeInTheDocument();
      expect(stepUpBodies).toEqual([{ code: 'abcd-efgh' }]);
    });

    it('returns to the account state when there was nothing to remove', async () => {
      const user = userEvent.setup();
      const { calls } = openDialog({ remove: 'conflict', user: enrolled });

      await user.click(await screen.findByRole('button', { name: 'Remove authenticator app' }));

      const dialog = screen.getByRole('dialog');

      expect(await within(dialog).findByText('Off')).toBeInTheDocument();
      expect(within(dialog).queryByRole('alert')).toBeNull();
      expect(calls.me).toBeGreaterThanOrEqual(2);
    });
  });
});
