import { useSearchParams } from 'react-router-dom';

import { DeviceList } from '@/features/settings/local-agents/device-list';
import { PairForm } from '@/features/settings/local-agents/pair-form';
import { SetupSteps } from '@/features/settings/local-agents/setup-steps';

/**
 * The person's own computers (spec 040). The companion prints this page's address with `?code=`,
 * so following its link lands on the pairing form already filled in.
 */
export function LocalAgentsSettingsPage(): React.JSX.Element {
  const [searchParams] = useSearchParams();

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="text-heading-lg font-semibold">Local agents</h1>
      <p className="text-body-sm text-subdued mt-1">
        Run agents on your own computer with the Claude Code or Codex subscription you already have.
      </p>
      <SetupSteps />
      <PairForm initialCode={searchParams.get('code') ?? ''} />
      <DeviceList />
    </main>
  );
}
