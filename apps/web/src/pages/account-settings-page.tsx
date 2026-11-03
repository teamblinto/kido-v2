import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

import { ChangePasswordSection } from '@/features/settings/change-password-section';
import { ConnectedAccountsSection } from '@/features/settings/connected-accounts-section';
import { SubscriptionCard } from '@/features/settings/subscription/subscription-card';

/** The person's own settings (spec 032 US2); not `SettingsNav`, which is organisation-only. */
export function AccountSettingsPage(): React.JSX.Element {
  const { hash } = useLocation();

  // A client-side navigation to `#claude-subscription` does not scroll by itself; a full load does.
  useEffect(() => {
    if (hash.length > 1) document.getElementById(hash.slice(1))?.scrollIntoView();
  }, [hash]);

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="text-heading-lg font-semibold">Connected accounts</h1>
      <p className="text-body-sm text-subdued mt-1">
        Use your own Claude or OpenAI subscription for your runs. Only the account name is shown
        here; nothing that grants access ever leaves the server.
      </p>
      <ConnectedAccountsSection />
      <SubscriptionCard />
      <ChangePasswordSection />
    </main>
  );
}
