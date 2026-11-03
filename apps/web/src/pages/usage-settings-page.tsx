import { Loader2 } from 'lucide-react';

import { SettingsNav } from '@/features/settings/settings-nav';
import { RunHistory } from '@/features/settings/usage/run-history';
import { SubscriptionLimits } from '@/features/settings/usage/subscription-limits';
import { useOrgs } from '@/features/workspace/hooks/use-orgs';

/** What the caller's runs used: their Claude plan's limits, and each run's tokens and cost. */
export function UsageSettingsPage(): React.JSX.Element {
  const { activeOrg, isLoading } = useOrgs();

  return (
    <main className="mx-auto max-w-4xl px-4 py-10">
      <SettingsNav />
      <h1 className="text-heading-lg font-semibold">Usage</h1>
      <p className="text-body-sm text-subdued mt-1">
        Runs on your Claude subscription count against its limits below. Runs on an organisation API
        key are billed by that key&apos;s provider.
      </p>

      <SubscriptionLimits />

      {isLoading ? (
        <div className="mt-6 flex items-center gap-2.5" role="status" aria-live="polite">
          <Loader2 className="text-subdued size-[18px] animate-spin" aria-hidden="true" />
          <span className="text-body-sm text-subdued">Loading…</span>
        </div>
      ) : null}

      {activeOrg === undefined ? null : <RunHistory orgId={activeOrg.id} />}
    </main>
  );
}
