import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { PROBLEM_TYPE_BASE_URI } from '@repo/contracts';

import { ApiProblem } from '@/lib/api/problem';
import { renderScreen } from '@/test/render';
import { AsleepPane } from './asleep-pane';

describe('AsleepPane', () => {
  it('offers one Wake button while nothing is in flight', async () => {
    const onWake = vi.fn();

    renderScreen(<AsleepPane because={null} onWake={onWake} />);

    expect(screen.getByText('This project is asleep')).toBeInTheDocument();

    const wake = screen.getByRole('button', { name: 'Wake' });

    expect(wake).toBeEnabled();
    await userEvent.click(wake);
    expect(onWake).toHaveBeenCalledTimes(1);
  });

  it('disables the button and announces the wait while `because` is set', () => {
    renderScreen(<AsleepPane because="resuming" onWake={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Waking…' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Waking…');
  });

  it('shows the shared sentence for the slug a refusal carried', () => {
    const error = new ApiProblem(403, {
      detail: 'nope',
      instance: '/orgs/o/projects/p/files/wake',
      requestId: 'req_asleep_pane',
      status: 403,
      title: 'Permission denied',
      type: `${PROBLEM_TYPE_BASE_URI}permission-denied`,
    });

    renderScreen(<AsleepPane because={null} error={error} onWake={vi.fn()} />);

    expect(
      screen.getByText('You do not have permission to do this. Ask an administrator for access.'),
    ).toBeInTheDocument();
  });
});
