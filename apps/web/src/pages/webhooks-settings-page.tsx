import { Loader2 } from 'lucide-react';

import { SettingsNav } from '@/features/settings/settings-nav';
import { EndpointsSection } from '@/features/settings/webhooks/endpoints-section';
import { ReceiverGuidance } from '@/features/settings/webhooks/receiver-guidance';
import { useOrgs } from '@/features/workspace/hooks/use-orgs';

/** The organisation's outbound webhooks (spec 029 US1). */
export function WebhooksSettingsPage(): React.JSX.Element {
  const { activeOrg, isLoading } = useOrgs();

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <SettingsNav />
      <h1 className="text-heading-lg font-semibold">Webhooks</h1>
      <p className="text-body-sm text-subdued mt-1">
        Send signed events to your own systems. Each endpoint gets a secret, shown once.
      </p>

      {isLoading ? (
        <div className="mt-6 flex items-center gap-2.5" role="status" aria-live="polite">
          <Loader2 className="text-subdued size-[18px] animate-spin" aria-hidden="true" />
          <span className="text-body-sm text-subdued">Loading…</span>
        </div>
      ) : null}

      {activeOrg === undefined ? null : <EndpointsSection orgId={activeOrg.id} />}

      <ReceiverGuidance />
    </main>
  );
}
