import { Loader2 } from 'lucide-react';

import { McpConnectGuide } from '@/features/settings/mcp/mcp-connect-guide';
import { McpGrantsSection } from '@/features/settings/mcp/mcp-grants-section';
import { SettingsNav } from '@/features/settings/settings-nav';
import { useOrgs } from '@/features/workspace/hooks/use-orgs';

/** Connect external AI agents over MCP, and revoke the ones already connected (spec 046). */
export function McpSettingsPage(): React.JSX.Element {
  const { activeOrg, isLoading } = useOrgs();

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <SettingsNav />
      <h1 className="text-heading-lg font-semibold">AI agents (MCP)</h1>
      <p className="text-body-sm text-subdued mt-1">
        Let Claude, ChatGPT, Cursor or VS Code build and deploy your projects through the Model
        Context Protocol.
      </p>

      <McpConnectGuide />

      {isLoading ? (
        <div className="mt-6 flex items-center gap-2.5" role="status" aria-live="polite">
          <Loader2 className="text-subdued size-[18px] animate-spin" aria-hidden="true" />
          <span className="text-body-sm text-subdued">Loading…</span>
        </div>
      ) : null}

      {activeOrg === undefined ? null : <McpGrantsSection orgId={activeOrg.id} />}
    </main>
  );
}
